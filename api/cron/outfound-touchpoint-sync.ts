//=============================================================================================================
//#region <import statements>

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
  getSyncCursor,
  isAfterCursor,
  OUTFOUND_CURSOR_GRACE_MS,
  saveSyncCursor,
  type CursorEvent,
  type SyncCursor,
} from "../../lib/cursors.js";
import { isAuthorizedCron, json, serverError } from "../../lib/http.js";
import { errorMessage } from "../../lib/json.js";
import {
  fetchOutfoundThreadEmails,
  fetchOutfoundThreads,
  OutfoundRateLimitError,
  type OutfoundEmail,
  type OutfoundThread,
} from "../../lib/outfound.js";
import { budgetSeconds, startRunBudget, type RunBudget } from "../../lib/run-budget.js";
import { cursorState, runOutcome } from "../../lib/run-summary.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

const SYNC_KEY = "outfound-touchpoints";

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

export interface OutfoundTouchpointEvent {
  readonly thread: OutfoundThread;
  readonly email: OutfoundEmail;
  readonly cursor: CursorEvent;
}

export interface OutfoundExpansion {
  readonly events: readonly OutfoundTouchpointEvent[];
  /** Threads whose messages were actually read, so a partial expansion can report what it left behind. */
  readonly threadsExpanded: number;
  /**
   * [STABILITY] Set when the expansion gave up with threads still unopened - because the budget ran out, or
   * because Outfound throttled us. The caller MUST treat either exactly as it treats a budget stop in its own
   * loop and refuse to park the cursor: the emails inside those threads were never seen, and parking would
   * claim they had been dealt with, skipping them for good. Null means every thread was opened.
   */
  readonly stoppedBy: "budget" | "throttled" | null;
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <RUN>

//---------------------------------------------------------------------------------------------------------
//Vercel Cron entry point, every five minutes.
//FLOW: 1. isAuthorizedCron (lib/http.ts). 2. getSyncCursor (lib/cursors.ts). 3. fetchOutfoundThreads
//(lib/outfound.ts) over cursor..now. 4. outfoundTouchpointEvents expands them to a chronological email stream.
//5. per email, skip anything at or below the mark, else processOutfoundTouchpoint. 6. advance the mark past
//each handled email. 6a. stop at the run budget if still going, or if an email was throttled before writing
//anything. 7. park at (now - OUTFOUND_CURSOR_GRACE_MS) and persist - the park is SKIPPED on either stop, since
//the emails the loop never reached must stay above the mark. See lib/run-budget.ts.
//
//[PERF] The expansion at step 4 spends one request per thread and happens BEFORE the budget loop opens, so a
//very wide window can spend real time there before the first email is ever written. The budget is measured from
//upperBoundMs for exactly that reason - it covers the fetch, not just the loop.
//[STABILITY] The park at step 7 subtracts OUTFOUND_CURSOR_GRACE_MS, not the shared CURSOR_GRACE_MS. Outfound's
//warehouse refreshes on a cadence rather than publishing on write, so its margin is wider than every other
//sync's. See lib/cursors.ts.
//[STABILITY] A failed email is counted and passed over, never retried: its earlier writes are committed, so a
//retry would duplicate them, and a permanently failing one would block the sync forever. A failed THREAD is
//different - nothing was written and the mark never passed it, so it is retried next run. So is an email that
//Attio threw on BEFORE its first write; that stops the run rather than being passed over, on the same
//reasoning as the thread - see ThrottledBeforeWrite (lib/attio.ts).
//KNOWN GAP: Outfound exposes no per-message auto-reply flag, so an out-of-office is counted as a touchpoint
//where the Instantly sync would discard it. Outfound does categorise replies as human or automatic, but only
//per THREAD, and applying a thread's verdict to every message in it would discard real replies alongside the
//bots. Closing this needs a per-message signal that the API does not currently carry.
//---------------------------------------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  //[SECURITY] Runs before any external call, so an unauthorized request costs nothing.
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401);
  const upperBoundMs = Date.now();
  //[DEBUG] Every figure the closing summary reports lives out here rather than inside the try, so the finally
  //can print that line on ANY exit - including one where a read or saveSyncCursor threw. See lib/run-summary.ts.
  let cursor: SyncCursor | null = null;
  let threadCount = 0;
  let threadsExpanded = 0;
  let emailCount = 0;
  const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
  const failures: string[] = [];
  //Emails the loop reached before it stopped, so a partial run can report what it left behind.
  let examinedCount = 0;
  //[DEBUG] Of those, the ones the cursor rejected as handled on an earlier run. On this sync that is most of
  //them by design - a thread yields its whole history however narrow the window - so the summary states it
  //rather than leaving the shortfall to be inferred.
  let beforeCursorCount = 0;
  //[STABILITY] An expansion that gave up counts as a stop for the purpose of parking, whichever reason it
  //gave. The threads it never opened hold emails this run has not seen, and parking would claim otherwise.
  let stopReason: "budget" | "throttled" | null = null;
  let cursorSaved = false;
  let fatal: string | null = null;

  try {
    cursor = await getSyncCursor(SYNC_KEY, upperBoundMs);
    //[STABILITY] See lib/run-budget.ts. Without this, an overrun is killed by Vercel before saveSyncCursor and
    //the run's whole progress is discarded, so the next run redoes it and re-increments every counter. Opened
    //BEFORE the expansion, not after it: on this sync the expansion is itself one request per thread and can
    //exhaust the whole run on its own, so it has to be inside the budget rather than ahead of it.
    const budget = startRunBudget(upperBoundMs, "OUTFOUND_SYNC_BUDGET_MS");
    const threads = await fetchOutfoundThreads({ fromMs: cursor.timestampMs, toMs: upperBoundMs });
    threadCount = threads.length;
    const expansion = await outfoundTouchpointEvents(threads, budget, (threadHash, message) => {
      failures.push(`Thread ${threadHash}: ${message}`);
    });
    threadsExpanded = expansion.threadsExpanded;
    const events = expansion.events;
    emailCount = events.length;
    stopReason = expansion.stoppedBy;

    for (const event of events) {
      //Checked before the email rather than after, so the budget is what remains for a whole one. Stopping here
      //leaves `cursor` where the last handled email put it; everything past this point stays above the mark.
      if (budget.expired()) {
        stopReason = "budget";
        break;
      }
      examinedCount += 1;
      //Everything at or below the mark was handled on an earlier run - this is the sole duplicate guard.
      if (!isAfterCursor(cursor, event.cursor)) {
        beforeCursorCount += 1;
        continue;
      }
      try {
        const outcome = await processOutfoundTouchpoint(event);
        results[outcome] += 1;
      } catch (error) {
        //[STABILITY] Throttled or 500'd by ATTIO before writing anything: the one failure that is safe to
        //attempt again. The cursor is left BELOW this email and the run stops here, so the next run starts on
        //it. Deliberately not counted as a failure - nothing was lost, the work is deferred. Distinct from the
        //OutfoundRateLimitError stop in the expansion above, which is the same idea applied to reading
        //threads. See ThrottledBeforeWrite (lib/attio.ts).
        if (error instanceof ThrottledBeforeWrite) {
          console.warn(
            `[event] outfound email ${event.email.id}: throttled before writing anything - ${error.message}. The run stops here and the next one starts on this email, so nothing is lost and nothing is double-counted.`,
          );
          stopReason = "throttled";
          //Examined but not handled, so it counts towards what is left rather than what was done.
          examinedCount -= 1;
          break;
        }
        failures.push(`Email ${event.email.id}: ${errorMessage(error)}`);
        console.error(
          `[event] outfound email ${event.email.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs. The one exception broke out
      //above, before reaching this line.
      cursor = advanceCursor(cursor, event.cursor);
    }

    const emailsRemaining = emailCount - examinedCount;
    const threadsRemaining = threadCount - threadsExpanded;
    if (stopReason) {
      //[STABILITY] Do NOT park at now. Parking claims everything up to that moment was dealt with, and the
      //emails the loop never reached were not - they would be skipped forever. Leaving the cursor where the
      //loop stopped is what makes the next run resume instead of restart.
      console.warn(
        `[run] outfound sync: stopped (${stopReason}) after ${budgetSeconds(budget)}s with ${emailsRemaining} of ${emailCount} expanded email(s) and ${threadsRemaining} of ${threadCount} thread(s) still to do, cursor left at ${new Date(cursor.timestampMs).toISOString()} to resume from.${threadsRemaining > 0 ? " The run ended inside the expansion, so the unexpanded threads were never read at all." : ""}${emailsRemaining > examinedCount ? " More is left than was done - if that repeats, email is arriving faster than it is processed." : ""}`,
      );
    } else {
      //[STABILITY] Park short of now, by Outfound's own wider margin - see OUTFOUND_CURSOR_GRACE_MS. An email
      //the warehouse has not yet refreshed into view is picked up next run, not skipped.
      cursor = advanceCursorTo(cursor, upperBoundMs - OUTFOUND_CURSOR_GRACE_MS);
    }
    await saveSyncCursor(cursor);
    cursorSaved = true;
    const body = {
      success: failures.length === 0,
      threadsScanned: threadCount,
      threadsExpanded,
      emailsFound: emailCount,
      //Part of emailsFound rather than extra to it: the slice an earlier run had already dealt with.
      beforeCursor: beforeCursorCount,
      ...results,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      //[DEBUG] A stopped run is a success - it wrote everything it reached and saved its place.
      truncated: stopReason !== null,
      //[DEBUG] stopReason separates "ran out of time" from "Outfound throttled us", which want different
      //responses: the first is a backlog draining, the second is the key's own rate tier being too low.
      ...(stopReason ? { stopReason, emailsRemaining, threadsRemaining } : {}),
      //[DEBUG] Errors are returned as well as logged, so a manual run reports failures without a log search.
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    //Held for the summary below, which runs after this response is prepared and before it is sent.
    fatal = errorMessage(error);
    return serverError("Outfound touchpoint sync error", error);
  } finally {
    //[DEBUG] Exactly one of these per invocation, whatever happened - see lib/run-summary.ts. It leads with
    //the touchpoints actually written, because that is the figure anyone reading a run wants first; the
    //breakdown that follows says how the rest of the window was accounted for.
    console.log(
      `[run] outfound sync: ${results.processed} touchpoint(s) logged, ${threadCount} thread(s) listed, ${threadsExpanded} expanded, ${emailCount} email(s) returned, ${beforeCursorCount} from before the cursor and already counted, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, ${runOutcome(fatal, stopReason, emailCount - examinedCount)}, ${cursorState(cursor, cursorSaved)}`,
    );
  }
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <build email stream>

//#region <expand threads>
//---------------------------------------------------------------------------------------------------------
//Expands threads into one chronological email stream.
//FLOW: 1. per thread, fetch its messages. 2. keep only real sent/received traffic. 3. pair each with its cursor
//event. 4. sort the lot by time.
//[PERF] ONE REQUEST PER THREAD. The inbox listing carries no message bodies, so this is the second half of
//every read and the dominant cost of the sync. A thread is listed when ANY of its emails falls in the window
//and then yields its WHOLE history, so most of what comes back is older than the mark; the per-email cursor
//check in the handler is what discards it, exactly as on the HeyReach sync.
//[STABILITY] THE EXPANSION IS BUDGETED, which no other sync needs. Everywhere else the provider fetch is a
//bounded number of pages and the budget only has to guard the write loop. Here the fetch is one request PER
//THREAD, so a wide window - a first run, or a backfilled cursor - can spend the whole of maxDuration in this
//function alone. Vercel would then kill the run before saveSyncCursor, the next run would redo the same window,
//and the sync would never make progress: exactly the permanent loop lib/run-budget.ts exists to prevent.
//Stopping here is safe because the cursor has not moved - but ONLY if the caller then refuses to park it. See
//OutfoundExpansion.truncated.
//[STABILITY] A thread whose messages cannot be read is logged and passed over rather than failing the run. One
//unreadable thread must not cost the whole window, and the cursor never advanced past it, so it is retried next
//run - unlike a failed EMAIL, which is passed over permanently once its writes may have landed.
//USES: fetchOutfoundThreadEmails (lib/outfound.ts); errorMessage (lib/json.ts).
//---------------------------------------------------------------------------------------------------------
export async function outfoundTouchpointEvents(
  threads: readonly OutfoundThread[],
  budget: RunBudget,
  onThreadFailure: (threadHash: string, message: string) => void,
): Promise<OutfoundExpansion> {
  const events: OutfoundTouchpointEvent[] = [];
  let threadsExpanded = 0;
  for (const thread of threads) {
    //Checked before the thread rather than after, so what remains is enough for a whole one.
    if (budget.expired()) {
      console.warn(
        `[run] outfound sync: stopped expanding at ${threadsExpanded} of ${threads.length} thread(s) - the rest are left for the next run, and the cursor is not parked.`,
      );
      return { events: sortByTime(events), threadsExpanded, stoppedBy: "budget" };
    }
    threadsExpanded += 1;
    let emails: readonly OutfoundEmail[];
    try {
      emails = await fetchOutfoundThreadEmails(thread.threadHash);
    } catch (error) {
      //[STABILITY] Throttling stops the expansion instead of passing the thread over. Every remaining thread
      //would be throttled too, so carrying on would march through the whole backlog collecting one failure per
      //thread and finish no work at all. Nothing was written and the cursor has not moved, so the threads left
      //behind are simply read next run. This mirrors the Aircall sync's ThrottledBeforeWrite stop.
      if (error instanceof OutfoundRateLimitError) {
        console.warn(
          `[run] outfound sync: throttled at ${threadsExpanded} of ${threads.length} thread(s) - ${error.message}. The run stops here rather than spending the rest of the window on requests that will also be refused; nothing is lost and the cursor is not parked.`,
        );
        return { events: sortByTime(events), threadsExpanded: threadsExpanded - 1, stoppedBy: "throttled" };
      }
      const message = errorMessage(error);
      console.error(
        `[event] outfound thread ${thread.threadHash}: FAILED to read and passed over - ${message}. The cursor never moved past it, so it is attempted again next run.`,
      );
      onThreadFailure(thread.threadHash, message);
      continue;
    }
    for (const email of emails) {
      if (!isOutfoundTouchpoint(email)) continue;
      events.push({ thread, email, cursor: outfoundCursorEvent(email) });
    }
  }
  return { events: sortByTime(events), threadsExpanded, stoppedBy: null };
}

function sortByTime(events: readonly OutfoundTouchpointEvent[]): readonly OutfoundTouchpointEvent[] {
  return [...events].sort((left, right) => left.cursor.timestampMs - right.cursor.timestampMs);
}
//#endregion

//#region <filter and order emails>
/** Keyed on sent_at, which is also what the thread filter bounds on, so window and cursor agree. */
export function outfoundCursorEvent(email: OutfoundEmail): CursorEvent {
  return { id: email.id, timestampMs: Date.parse(email.sentAt) };
}

/**
 * [LOGIC] Traffic that actually happened. Scheduled and PendingSend have not been sent yet, Failed never was,
 * and `unknown` is a type this codebase does not recognise and will not count as a human touchpoint.
 * USES: nothing. Pure.
 */
export function isOutfoundTouchpoint(email: OutfoundEmail): boolean {
  return email.emailType === "Sent" || email.emailType === "Received";
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record email touchpoints>

//#region <write to attio>
//---------------------------------------------------------------------------------------------------------
//Records one email as a touchpoint on the Person and, when linked, the Company.
//FLOW: 1. require a lead address. 2. match a Person on it. 3. require Master TAM membership. 4. note plus
//counter on the Person. 5. note plus counter on the Company when one is linked.
//The address comes from the THREAD rather than the email, because an email's own sender and recipient are
//whichever way round that message went; the thread names the prospect once, for both directions.
//USES: findPersonByEmail, isPersonInList, createNote, incrementCounter, personCompanyId, personCounterSlug,
//companyCounterSlug (lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function processOutfoundTouchpoint(
  event: OutfoundTouchpointEvent,
): Promise<ProcessingOutcome> {
  const leadEmail = event.thread.leadEmail;
  if (!leadEmail) {
    console.log(`[event] outfound email ${event.email.id}: skipped - no lead email on the thread`);
    return "skipped";
  }
  //[STABILITY] The filtered lookup, and the list read after it, are the whole pre-write region - see
  //beforeAnyWrite (lib/attio.ts). incrementCounter below opens with a read too, but its PATCH is inside the
  //same call, so a failure there cannot be told apart from a failure after it and stays on the pass-over path.
  const person = await beforeAnyWrite(() => findPersonByEmail(leadEmail));
  if (!person) {
    console.log(`[event] outfound email ${event.email.id}: skipped - no Attio person has ${leadEmail}`);
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  //Master TAM is the gate on counting anything: off-list people are read but never written to.
  if (!(await beforeAnyWrite(() => isPersonInList(personId, LISTS.MASTER_TAM, personName)))) {
    console.log(
      `[event] outfound email ${event.email.id}: skipped - person ${personName} is not on the Master TAM list`,
    );
    return "not_tam";
  }

  const subject = event.email.subject ?? "(no subject)";
  const body = event.email.bodyText ?? "(no content)";
  const title = `${subject} — ${event.email.sentAt}`;
  await createNote("people", personId, title, body, personName);
  await incrementCounter("people", personId, personCounterSlug("outfound"), personName);

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `Outfound email with ${personDisplayName(person) ?? leadEmail}:\n\n${body}`,
    );
    await incrementCounter("companies", companyId, companyCounterSlug("outfound"));
  }
  return "processed";
}
//#endregion

//#endregion
//=============================================================================================================
