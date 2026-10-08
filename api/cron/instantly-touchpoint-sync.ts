//=============================================================================================================
//#region <import statements>

import { //attio lookups, writes and throttle guard
  beforeAnyWrite,
  companyCounterSlug,
  createNote,
  findPersonByEmail,
  incrementCounter,
  isPersonInList,
  LISTS,
  personCompanyId,
  personCounterSlug,
  personDisplayName,
  personLabel,
  ThrottledBeforeWrite,
} from "../../lib/attio.js";
import { //saved high-water mark helpers
  advanceCursor,
  advanceCursorTo,
  CURSOR_GRACE_MS,
  getSyncCursor,
  isAfterCursor,
  saveSyncCursor,
  type CursorEvent,
  type SyncCursor,
} from "../../lib/cursors.js";
import { isAuthorizedCron, json, serverError } from "../../lib/http.js"; //auth check and responses
import { //instantly reads and email shape
  fetchInstantlyEmailWindow,
  INSTANTLY_SYNC_PAGE_LIMIT,
  type InstantlyEmail,
} from "../../lib/instantly.js";
import { errorMessage } from "../../lib/json.js"; //any error to readable text
import { budgetSeconds, startRunBudget } from "../../lib/run-budget.js"; //run time limit helpers
import { cursorState, runOutcome } from "../../lib/run-summary.js"; //summary line wording

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//The name this sync's cursor is saved under.
const SYNC_KEY = "instantly-touchpoints"; //cursor row name in supabase

//What happened to one email: written, skipped, or person not on TAM.
type ProcessingOutcome = "processed" | "skipped" | "not_tam"; //the three possible results

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <RUN>

//---------------------------------------------------------------------------------------------------------
//Syncs new Instantly emails into Attio as touchpoints, resuming from the saved cursor.
//Input: request - the incoming HTTP request from Vercel Cron.
//Output: JSON summary response (200, or 500 if any email failed); 401 if unauthorized; 500 on a fatal error.
//Uses: instantlyCursorEvent, processInstantlyTouchpoint (this file); fetchInstantlyEmailWindow
//(lib/instantly.ts); ThrottledBeforeWrite (lib/attio.ts); getSyncCursor, isAfterCursor, advanceCursor,
//advanceCursorTo, saveSyncCursor (lib/cursors.ts); errorMessage (lib/json.ts); isAuthorizedCron, json,
//serverError (lib/http.ts); startRunBudget, budgetSeconds (lib/run-budget.ts); runOutcome, cursorState
//(lib/run-summary.ts).
//Workflow: entry point of the instantly touchpoint sync. Vercel Cron, every five minutes. Steps:
// 1. isAuthorizedCron (lib/http.ts). 2. getSyncCursor (lib/cursors.ts). 3. fetchInstantlyEmailWindow
// (lib/instantly.ts) over cursor..now, bounded to INSTANTLY_SYNC_PAGE_LIMIT pages and keeping what it read even
// if Instantly refused the rest. 4. keep only real sent/received traffic. 5. sort by creation time.
// 6. per email, skip anything at or below the mark, else processInstantlyTouchpoint. 7. advance the mark past
// each handled email. 7a. stop at the run budget if still going, or if an email was throttled before writing
// anything, leaving the cursor at the last email actually handled. 8. park at (now - CURSOR_GRACE_MS) and
// persist - the park is SKIPPED on any stop, INCLUDING a short read at step 3, since neither the emails the
// loop never reached nor the ones the fetch never saw may be left below the mark. See lib/run-budget.ts. 9. report, on every exit - see the finally.
//
//[STABILITY] A failed email is counted and passed over, never retried: its earlier writes are committed, so a
//retry would duplicate them, and a permanently failing one would block the sync forever. THE EXCEPTION is a
//transient failure before the first write, which is safe to attempt again precisely because nothing is
//committed yet; that stops the run instead, and the next one starts on the email - see ThrottledBeforeWrite
//(lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  //[SECURITY] Runs before any external call, so an unauthorized request costs nothing.
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401); //reject callers without the secret
  const upperBoundMs = Date.now(); //this run's "now", the window end
  //[DEBUG] Every figure the closing summary reports lives out here rather than inside the try, so the finally
  //can print that line on ANY exit. It used to sit after saveSyncCursor, which meant a throw anywhere - and
  //Supabase answers a cursor read or write with a 504 often enough to matter - left the run with no summary at
  //all. A run reporting nothing is indistinguishable in the log from a run that never fired, and the case that
  //most needs reading is exactly the one that threw: it may have written to Attio and then lost its cursor.
  let cursor: SyncCursor | null = null; //saved mark, once read
  let emailCount = 0; //emails left after filtering
  const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 }; //tally per outcome
  const failures: string[] = []; //one message per failed email
  //Emails the loop reached before it stopped, so a partial run can report what it left behind.
  let examinedCount = 0; //emails the loop reached
  //[DEBUG] Of those, the ones the cursor rejected as handled on an earlier run. Counted so the summary's
  //figures account for the whole window: without it a run that fetched forty and processed three reads as
  //though it silently dropped thirty-seven, when they were re-read on purpose and correctly passed over.
  let beforeCursorCount = 0; //emails already counted earlier
  //Why this run covered less than the whole window, if it did. Every reason shares one consequence - the
  //cursor must NOT be parked at now - so they are one value rather than flags that could disagree.
  //"budget" and "throttled" are the loop stopping partway; "window-truncated" and "window-throttled" are the
  //FETCH stopping partway, which means the window itself is short and the emails beyond it were never seen.
  let stopReason: "budget" | "throttled" | "window-truncated" | "window-throttled" | null = null; //why the run stopped early
  let cursorSaved = false; //true once the cursor is stored
  let fatal: string | null = null; //error that ended the run, if any

  try {
    cursor = await getSyncCursor(SYNC_KEY, upperBoundMs); //read the saved mark
    //[STABILITY] A short read is a partial run, not a failed one. Instantly allows 20 requests a minute and
    //this pages a hundred emails at a time, so a backlog cannot be read in one go - and it used to THROW on
    //the 429, which abandoned the run before saveSyncCursor and left the mark where it was. The next run then
    //re-read the same window and failed identically; production sat in that loop for five days. Whatever was
    //read is now processed and the cursor parked after it, so every run makes progress.
    const window = await fetchInstantlyEmailWindow( //read emails from mark to now, capped
      { fromMs: cursor.timestampMs, toMs: upperBoundMs },
      INSTANTLY_SYNC_PAGE_LIMIT,
    );
    if (window.stoppedBy) { //the read stopped short
      stopReason = window.stoppedBy === "throttled" ? "window-throttled" : "window-truncated"; //record which way
    }
    const emails = [...window.emails] //copy, keep real mail, order by time
      //Scheduled mail has not happened yet and an auto-reply is not a human touchpoint; neither is counted.
      .filter(
        (email) =>
          (email.emailType === "sent" || email.emailType === "received") && !email.isAutoReply,
      )
      .sort(
        (left, right) =>
          instantlyCursorEvent(left).timestampMs - instantlyCursorEvent(right).timestampMs,
      );
    emailCount = emails.length; //how many emails to walk
    //[STABILITY] See lib/run-budget.ts. Without this, an overrun is killed by Vercel before saveSyncCursor and
    //the run's whole progress is discarded, so the next run redoes it and re-increments every counter.
    const budget = startRunBudget(upperBoundMs, "INSTANTLY_SYNC_BUDGET_MS"); //start the run's time limit

    for (const email of emails) { //each email, oldest first
      //Checked before the email rather than after, so the budget is what remains for a whole one. Stopping here
      //leaves `cursor` where the last handled email put it; everything past this point stays above the mark.
      if (budget.expired()) { //out of time
        //[LOGIC] A budget stop does not overwrite a short read. Both park the cursor identically, and the
        //fetch's reason is the one worth reporting: "we never saw the whole window" explains a backlog that
        //persists, where "we ran out of time" reads as ordinary throughput.
        stopReason ??= "budget"; //record why, unless already set
        break; //stop the loop
      }
      examinedCount += 1; //one more email reached
      const event = instantlyCursorEvent(email); //the email's place on the timeline
      //Everything at or below the mark was handled on an earlier run - this is the sole duplicate guard.
      if (!isAfterCursor(cursor, event)) { //already handled before
        beforeCursorCount += 1; //count it as old
        continue; //skip to the next email
      }
      try {
        const outcome = await processInstantlyTouchpoint(email); //write the touchpoint to attio
        results[outcome] += 1; //tally the result
      } catch (error) {
        //[STABILITY] Throttled or 500'd before writing anything: the one failure that is safe to attempt
        //again. The cursor is left BELOW this email and the run stops here, so the next run starts on it.
        //Deliberately not counted as a failure - nothing was lost, the work is deferred. See
        //ThrottledBeforeWrite (lib/attio.ts).
        if (error instanceof ThrottledBeforeWrite) { //attio throttled before any write
          console.warn( //log the clean stop
            `[event] instantly email ${email.id}: throttled before writing anything - ${error.message}. The run stops here and the next one starts on this email, so nothing is lost and nothing is double-counted.`,
          );
          stopReason ??= "throttled"; //record why, unless already set
          //Examined but not handled, so it counts towards what is left rather than what was done.
          examinedCount -= 1; //undo the count for this email
          break; //stop the loop, cursor stays below it
        }
        failures.push(`Email ${email.id}: ${errorMessage(error)}`); //remember the failure
        console.error( //log the failure
          `[event] instantly email ${email.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs. The one exception broke out
      //above, before reaching this line.
      cursor = advanceCursor(cursor, event); //move the mark past this email
    }

    const emailsRemaining = emailCount - examinedCount; //emails the loop never reached
    if (stopReason) { //run stopped early
      //[STABILITY] Do NOT park at now. Parking claims everything up to that moment was dealt with, and the
      //emails the loop never reached were not - they would be skipped forever. Leaving the cursor where the
      //loop stopped is what makes the next run resume instead of restart.
      const resumeAt = new Date(cursor.timestampMs).toISOString(); //mark as text, for the log
      //[DEBUG] Four stops, four different things to do about them, so each says which it was in its own words
      //rather than sharing a sentence that would be true of all of them and useful for none.
      console.warn( //explain why it stopped
        stopReason === "budget"
          ? `[run] instantly sync: stopped after ${budgetSeconds(budget)}s of a ${emailCount}-email window with ${emailsRemaining} still to do, cursor left at ${resumeAt} to resume from.${emailsRemaining > examinedCount ? " More is left than was done - if that repeats, email is arriving faster than it is processed." : ""}`
          : stopReason === "throttled"
            ? `[run] instantly sync: stopped by Attio throttling with ${emailsRemaining} of ${emailCount} email(s) still to do, cursor left at ${resumeAt} to resume from. Nothing was lost; the next run starts on the email that was throttled. Repeated throttling means this sync is querying Attio faster than the account allows.`
            : stopReason === "window-throttled"
              ? `[run] instantly sync: Instantly throttled the window read, so this run saw only the first ${emailCount} email(s) of it and there are more beyond them. What was read is processed and the cursor is left at ${resumeAt} to resume from; nothing is lost. Persisting past a few runs means the page cap of ${INSTANTLY_SYNC_PAGE_LIMIT} is too high for what else is spending this key's 20 requests a minute.`
              : `[run] instantly sync: the window read stopped at the ${INSTANTLY_SYNC_PAGE_LIMIT}-page cap, so this run saw only the first ${emailCount} email(s) of it and there are more beyond them. What was read is processed and the cursor is left at ${resumeAt} to resume from. This is how a backlog drains - expect it on consecutive runs until the cursor catches up.`,
      );
    } else {
      //[STABILITY] Park short of now. An email Instantly has not yet published is picked up next run, not skipped.
      cursor = advanceCursorTo(cursor, upperBoundMs - CURSOR_GRACE_MS); //move mark to just before now
    }
    await saveSyncCursor(cursor); //store the mark for next run
    cursorSaved = true; //note that it was saved
    const body = { //the response summary
      success: failures.length === 0, //true when nothing failed
      emailsFound: emailCount, //emails left after filtering
      //Part of emailsFound rather than extra to it: the slice an earlier run had already dealt with.
      beforeCursor: beforeCursorCount, //emails already counted earlier
      ...results, //processed, skipped, not_tam counts
      failed: failures.length, //how many emails failed
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(), //where the mark now sits
      //[DEBUG] A stopped run is a success - it wrote everything it reached and saved its place.
      truncated: stopReason !== null, //true if the run stopped early
      //[DEBUG] stopReason separates "ran out of time" from "Attio throttled us", which want different
      //responses: the first is a throughput problem, the second is a rate-limit one.
      ...(stopReason ? { stopReason, emailsRemaining } : {}), //why and how many left, if stopped
      //[DEBUG] Errors are returned as well as logged, so a manual run reports failures without a log search.
      ...(failures.length > 0 ? { errors: failures } : {}), //failure messages, if any
    };
    return json(body, failures.length > 0 ? 500 : 200); //send the summary
  } catch (error) {
    //Held for the summary below, which runs after this response is prepared and before it is sent.
    fatal = errorMessage(error); //keep the error text
    return serverError("Instantly touchpoint sync error", error); //send a 500
  } finally {
    //[DEBUG] Exactly one of these per invocation, whatever happened. A log filtered on "[run] instantly sync:"
    //is then a complete record of the runs, and a gap in it means a run that produced no output at all - a
    //Vercel kill at maxDuration, rather than any failure this handler was alive to see.
    //It leads with the touchpoints actually written, because that is the figure anyone reading a run wants
    //first; the breakdown that follows says how the rest of the window was accounted for.
    console.log( //print the one summary line
      `[run] instantly sync: ${results.processed} touchpoint(s) logged, ${emailCount} email(s) in window, ${beforeCursorCount} from before the cursor and already counted, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, ${runOutcome(fatal, stopReason, emailCount - examinedCount)}, ${cursorState(cursor, cursorSaved)}`,
    );
  }
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record email touchpoints>

//#region <order emails>
//---------------------------------------------------------------------------------------------------------
//Base function. Places an email on the cursor timeline by when it was created.
//Input: email - one Instantly email.
//Output: { id, timestampMs } - the email id and its creation time in milliseconds.
//Workflow: instantly touchpoint sync steps 5-7 - sorts the emails and positions each against the cursor.
//
//Keyed on timestamp_created, which is also what the API filters on, so window and cursor agree.
//---------------------------------------------------------------------------------------------------------
export function instantlyCursorEvent(email: InstantlyEmail): CursorEvent {
  return { id: email.id, timestampMs: Date.parse(email.timestampCreated) }; //creation time in milliseconds
}
//#endregion

//#region <write to attio>
//---------------------------------------------------------------------------------------------------------
//Records one email as a touchpoint on the Person and, when linked, the Company.
//Input: email - one sent or received Instantly email above the cursor.
//Output: "processed", "skipped" (no lead address or no Person) or "not_tam". Throws ThrottledBeforeWrite if
//Attio throttles before any write, or any other error from a failed write.
//Uses: beforeAnyWrite, findPersonByEmail, personLabel, isPersonInList, createNote, incrementCounter,
//personCounterSlug, personCompanyId, personDisplayName, companyCounterSlug (lib/attio.ts).
//Workflow: instantly touchpoint sync step 6 - the work done for each new email.
//---------------------------------------------------------------------------------------------------------
export async function processInstantlyTouchpoint(email: InstantlyEmail): Promise<ProcessingOutcome> {
  const leadEmail = email.leadEmail; //the lead's address
  if (!leadEmail) { //no lead address
    console.log(`[event] instantly email ${email.id}: skipped - no lead email on the record`); //log the skip
    return "skipped"; //nothing to match on
  }
  //[STABILITY] The filtered lookup, and the list read after it, are the whole pre-write region - see
  //beforeAnyWrite (lib/attio.ts). incrementCounter below opens with a read too, but its PATCH is inside the
  //same call, so a failure there cannot be told apart from a failure after it and stays on the pass-over path.
  const person = await beforeAnyWrite(() => findPersonByEmail(leadEmail)); //find the person with this email
  if (!person) { //no match in attio
    console.log(`[event] instantly email ${email.id}: skipped - no Attio person has ${leadEmail}`); //log the skip
    return "skipped"; //nobody to credit
  }
  const personId = person.id.record_id; //the person's attio id
  const personName = personLabel(person); //name for log lines
  //Master TAM is the gate on counting anything: off-list people are read but never written to.
  if (!(await beforeAnyWrite(() => isPersonInList(personId, LISTS.MASTER_TAM, personName)))) { //not on the tam list
    console.log(`[event] instantly email ${email.id}: skipped - person ${personName} is not on the Master TAM list`); //log the skip
    return "not_tam"; //off-list, write nothing
  }

  const subject = email.subject ?? "(no subject)"; //subject, or a placeholder
  const body = email.bodyText ?? "(no content)"; //email text, or a placeholder
  const title = `${subject} — ${email.timestampEmail}`; //note title
  await createNote("people", personId, title, body, personName); //add the note to the person
  await incrementCounter("people", personId, personCounterSlug("instantly"), personName); //bump the person's email count

  const companyId = personCompanyId(person); //the person's company, if any
  if (companyId) { //has a company
    await createNote( //add the note to the company
      "companies",
      companyId,
      title,
      `Instantly email with ${personDisplayName(person) ?? leadEmail}:\n\n${body}`,
    );
    await incrementCounter("companies", companyId, companyCounterSlug("instantly")); //bump the company's email count
  }
  return "processed"; //touchpoint recorded
}
//#endregion

//#endregion
//=============================================================================================================
