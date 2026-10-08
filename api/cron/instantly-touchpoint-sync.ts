//imports======================================================================================================

import {
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
import {
  advanceCursor,
  advanceCursorTo,
  CURSOR_GRACE_MS,
  getSyncCursor,
  isAfterCursor,
  saveSyncCursor,
  type CursorEvent,
  type SyncCursor,
} from "../../lib/cursors.js";
import { isAuthorizedCron, json, serverError } from "../../lib/http.js";
import {
  fetchInstantlyEmailWindow,
  INSTANTLY_SYNC_PAGE_LIMIT,
  type InstantlyEmail,
} from "../../lib/instantly.js";
import { errorMessage } from "../../lib/json.js";
import { budgetSeconds, startRunBudget } from "../../lib/run-budget.js";
import { cursorState, runOutcome } from "../../lib/run-summary.js";

//=============================================================================================================

//types and globals============================================================================================

const SYNC_KEY = "instantly-touchpoints";

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

//=============================================================================================================

// ---------- RUN ----------

//---------------------------------------------------------------------------------------------------------
//Vercel Cron entry point, every five minutes.
//FLOW: 1. isAuthorizedCron (lib/http.ts). 2. getSyncCursor (lib/cursors.ts). 3. fetchInstantlyEmailWindow
//(lib/instantly.ts) over cursor..now, bounded to INSTANTLY_SYNC_PAGE_LIMIT pages and keeping what it read even
//if Instantly refused the rest. 4. keep only real sent/received traffic. 5. sort by creation time.
//6. per email, skip anything at or below the mark, else processInstantlyTouchpoint. 7. advance the mark past
//each handled email. 7a. stop at the run budget if still going, or if an email was throttled before writing
//anything, leaving the cursor at the last email actually handled. 8. park at (now - CURSOR_GRACE_MS) and
//persist - the park is SKIPPED on any stop, INCLUDING a short read at step 3, since neither the emails the
//loop never reached nor the ones the fetch never saw may be left below the mark. See lib/run-budget.ts. 9. report, on every exit - see the finally.
//[STABILITY] A failed email is counted and passed over, never retried: its earlier writes are committed, so a
//retry would duplicate them, and a permanently failing one would block the sync forever. THE EXCEPTION is a
//transient failure before the first write, which is safe to attempt again precisely because nothing is
//committed yet; that stops the run instead, and the next one starts on the email - see ThrottledBeforeWrite
//(lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  //[SECURITY] Runs before any external call, so an unauthorized request costs nothing.
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401);
  const upperBoundMs = Date.now();
  //[DEBUG] Every figure the closing summary reports lives out here rather than inside the try, so the finally
  //can print that line on ANY exit. It used to sit after saveSyncCursor, which meant a throw anywhere - and
  //Supabase answers a cursor read or write with a 504 often enough to matter - left the run with no summary at
  //all. A run reporting nothing is indistinguishable in the log from a run that never fired, and the case that
  //most needs reading is exactly the one that threw: it may have written to Attio and then lost its cursor.
  let cursor: SyncCursor | null = null;
  let emailCount = 0;
  const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
  const failures: string[] = [];
  //Emails the loop reached before it stopped, so a partial run can report what it left behind.
  let examinedCount = 0;
  //[DEBUG] Of those, the ones the cursor rejected as handled on an earlier run. Counted so the summary's
  //figures account for the whole window: without it a run that fetched forty and processed three reads as
  //though it silently dropped thirty-seven, when they were re-read on purpose and correctly passed over.
  let beforeCursorCount = 0;
  //Why this run covered less than the whole window, if it did. Every reason shares one consequence - the
  //cursor must NOT be parked at now - so they are one value rather than flags that could disagree.
  //"budget" and "throttled" are the loop stopping partway; "window-truncated" and "window-throttled" are the
  //FETCH stopping partway, which means the window itself is short and the emails beyond it were never seen.
  let stopReason: "budget" | "throttled" | "window-truncated" | "window-throttled" | null = null;
  let cursorSaved = false;
  let fatal: string | null = null;

  try {
    cursor = await getSyncCursor(SYNC_KEY, upperBoundMs);
    //[STABILITY] A short read is a partial run, not a failed one. Instantly allows 20 requests a minute and
    //this pages a hundred emails at a time, so a backlog cannot be read in one go - and it used to THROW on
    //the 429, which abandoned the run before saveSyncCursor and left the mark where it was. The next run then
    //re-read the same window and failed identically; production sat in that loop for five days. Whatever was
    //read is now processed and the cursor parked after it, so every run makes progress.
    const window = await fetchInstantlyEmailWindow(
      { fromMs: cursor.timestampMs, toMs: upperBoundMs },
      INSTANTLY_SYNC_PAGE_LIMIT,
    );
    if (window.stoppedBy) {
      stopReason = window.stoppedBy === "throttled" ? "window-throttled" : "window-truncated";
    }
    const emails = [...window.emails]
      //Scheduled mail has not happened yet and an auto-reply is not a human touchpoint; neither is counted.
      .filter(
        (email) =>
          (email.emailType === "sent" || email.emailType === "received") && !email.isAutoReply,
      )
      .sort(
        (left, right) =>
          instantlyCursorEvent(left).timestampMs - instantlyCursorEvent(right).timestampMs,
      );
    emailCount = emails.length;
    //[STABILITY] See lib/run-budget.ts. Without this, an overrun is killed by Vercel before saveSyncCursor and
    //the run's whole progress is discarded, so the next run redoes it and re-increments every counter.
    const budget = startRunBudget(upperBoundMs, "INSTANTLY_SYNC_BUDGET_MS");

    for (const email of emails) {
      //Checked before the email rather than after, so the budget is what remains for a whole one. Stopping here
      //leaves `cursor` where the last handled email put it; everything past this point stays above the mark.
      if (budget.expired()) {
        //[LOGIC] A budget stop does not overwrite a short read. Both park the cursor identically, and the
        //fetch's reason is the one worth reporting: "we never saw the whole window" explains a backlog that
        //persists, where "we ran out of time" reads as ordinary throughput.
        stopReason ??= "budget";
        break;
      }
      examinedCount += 1;
      const event = instantlyCursorEvent(email);
      //Everything at or below the mark was handled on an earlier run - this is the sole duplicate guard.
      if (!isAfterCursor(cursor, event)) {
        beforeCursorCount += 1;
        continue;
      }
      try {
        const outcome = await processInstantlyTouchpoint(email);
        results[outcome] += 1;
      } catch (error) {
        //[STABILITY] Throttled or 500'd before writing anything: the one failure that is safe to attempt
        //again. The cursor is left BELOW this email and the run stops here, so the next run starts on it.
        //Deliberately not counted as a failure - nothing was lost, the work is deferred. See
        //ThrottledBeforeWrite (lib/attio.ts).
        if (error instanceof ThrottledBeforeWrite) {
          console.warn(
            `[event] instantly email ${email.id}: throttled before writing anything - ${error.message}. The run stops here and the next one starts on this email, so nothing is lost and nothing is double-counted.`,
          );
          stopReason ??= "throttled";
          //Examined but not handled, so it counts towards what is left rather than what was done.
          examinedCount -= 1;
          break;
        }
        failures.push(`Email ${email.id}: ${errorMessage(error)}`);
        console.error(
          `[event] instantly email ${email.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs. The one exception broke out
      //above, before reaching this line.
      cursor = advanceCursor(cursor, event);
    }

    const emailsRemaining = emailCount - examinedCount;
    if (stopReason) {
      //[STABILITY] Do NOT park at now. Parking claims everything up to that moment was dealt with, and the
      //emails the loop never reached were not - they would be skipped forever. Leaving the cursor where the
      //loop stopped is what makes the next run resume instead of restart.
      const resumeAt = new Date(cursor.timestampMs).toISOString();
      //[DEBUG] Four stops, four different things to do about them, so each says which it was in its own words
      //rather than sharing a sentence that would be true of all of them and useful for none.
      console.warn(
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
      cursor = advanceCursorTo(cursor, upperBoundMs - CURSOR_GRACE_MS);
    }
    await saveSyncCursor(cursor);
    cursorSaved = true;
    const body = {
      success: failures.length === 0,
      emailsFound: emailCount,
      //Part of emailsFound rather than extra to it: the slice an earlier run had already dealt with.
      beforeCursor: beforeCursorCount,
      ...results,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      //[DEBUG] A stopped run is a success - it wrote everything it reached and saved its place.
      truncated: stopReason !== null,
      //[DEBUG] stopReason separates "ran out of time" from "Attio throttled us", which want different
      //responses: the first is a throughput problem, the second is a rate-limit one.
      ...(stopReason ? { stopReason, emailsRemaining } : {}),
      //[DEBUG] Errors are returned as well as logged, so a manual run reports failures without a log search.
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    //Held for the summary below, which runs after this response is prepared and before it is sent.
    fatal = errorMessage(error);
    return serverError("Instantly touchpoint sync error", error);
  } finally {
    //[DEBUG] Exactly one of these per invocation, whatever happened. A log filtered on "[run] instantly sync:"
    //is then a complete record of the runs, and a gap in it means a run that produced no output at all - a
    //Vercel kill at maxDuration, rather than any failure this handler was alive to see.
    //It leads with the touchpoints actually written, because that is the figure anyone reading a run wants
    //first; the breakdown that follows says how the rest of the window was accounted for.
    console.log(
      `[run] instantly sync: ${results.processed} touchpoint(s) logged, ${emailCount} email(s) in window, ${beforeCursorCount} from before the cursor and already counted, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, ${runOutcome(fatal, stopReason, emailCount - examinedCount)}, ${cursorState(cursor, cursorSaved)}`,
    );
  }
}

// ---------------------------

//record email touchpoints=====================================================================================

//#region <record email touchpoints: order emails>
/** Keyed on timestamp_created, which is also what the API filters on, so window and cursor agree. */
export function instantlyCursorEvent(email: InstantlyEmail): CursorEvent {
  return { id: email.id, timestampMs: Date.parse(email.timestampCreated) };
}
//#endregion

//#region <record email touchpoints: write to attio>
//---------------------------------------------------------------------------------------------------------
//Records one email as a touchpoint on the Person and, when linked, the Company.
//FLOW: 1. require a lead address. 2. match a Person on it. 3. require Master TAM membership. 4. note plus
//counter on the Person. 5. note plus counter on the Company when one is linked.
//USES: findPersonByEmail, isPersonInList, createNote, incrementCounter, personCompanyId, personCounterSlug,
//companyCounterSlug (lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function processInstantlyTouchpoint(email: InstantlyEmail): Promise<ProcessingOutcome> {
  const leadEmail = email.leadEmail;
  if (!leadEmail) {
    console.log(`[event] instantly email ${email.id}: skipped - no lead email on the record`);
    return "skipped";
  }
  //[STABILITY] The filtered lookup, and the list read after it, are the whole pre-write region - see
  //beforeAnyWrite (lib/attio.ts). incrementCounter below opens with a read too, but its PATCH is inside the
  //same call, so a failure there cannot be told apart from a failure after it and stays on the pass-over path.
  const person = await beforeAnyWrite(() => findPersonByEmail(leadEmail));
  if (!person) {
    console.log(`[event] instantly email ${email.id}: skipped - no Attio person has ${leadEmail}`);
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  //Master TAM is the gate on counting anything: off-list people are read but never written to.
  if (!(await beforeAnyWrite(() => isPersonInList(personId, LISTS.MASTER_TAM, personName)))) {
    console.log(`[event] instantly email ${email.id}: skipped - person ${personName} is not on the Master TAM list`);
    return "not_tam";
  }

  const subject = email.subject ?? "(no subject)";
  const body = email.bodyText ?? "(no content)";
  const title = `${subject} — ${email.timestampEmail}`;
  await createNote("people", personId, title, body, personName);
  await incrementCounter("people", personId, personCounterSlug("instantly"), personName);

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `Instantly email with ${personDisplayName(person) ?? leadEmail}:\n\n${body}`,
    );
    await incrementCounter("companies", companyId, companyCounterSlug("instantly"));
  }
  return "processed";
}
//#endregion

//=============================================================================================================
