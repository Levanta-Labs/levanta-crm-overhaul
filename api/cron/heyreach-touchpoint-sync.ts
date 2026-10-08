//imports======================================================================================================

import {
  beforeAnyWrite,
  companyCounterSlug,
  createNote,
  findPersonByLinkedIn,
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
import {
  fetchHeyReachConversationWindow,
  heyReachMessageId,
  type HeyReachConversation,
  type HeyReachMessage,
} from "../../lib/heyreach.js";
import { isAuthorizedCron, json, serverError } from "../../lib/http.js";
import { errorMessage } from "../../lib/json.js";
import { budgetSeconds, startRunBudget } from "../../lib/run-budget.js";
import { cursorState, runOutcome } from "../../lib/run-summary.js";

//=============================================================================================================

//types and globals============================================================================================

const SYNC_KEY = "heyreach-touchpoints";

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

export interface HeyReachTouchpointEvent {
  readonly conversation: HeyReachConversation;
  readonly message: HeyReachMessage;
  readonly cursor: CursorEvent;
}

//=============================================================================================================

// ---------- RUN ----------

//---------------------------------------------------------------------------------------------------------
//Vercel Cron entry point, every five minutes.
//FLOW: 1. isAuthorizedCron (lib/http.ts). 2. getSyncCursor (lib/cursors.ts). 3. fetchHeyReachConversations
//(lib/heyreach.ts). 4. heyReachTouchpointEvents flattens them to a chronological message stream. 5. per
//message, skip anything at or below the mark, else processHeyReachTouchpoint. 6. advance the mark.
//6a. stop at the run budget if still going, or if a message was throttled before writing anything. 7. park at
//(now - CURSOR_GRACE_MS) and persist - the park is SKIPPED on either stop, since the messages the loop never
//reached must stay above the mark.
//[PERF] HeyReach applies from/to with DAY granularity, so a five-minute run receives every conversation
//touched since UTC midnight, each with its full message list, and hashes every message before the cursor
//rejects it. Cost grows through the day. Skipping conversations with no activity past the mark would avoid
//most of it; deliberately not done, so the per-message check in step 5 absorbs the whole load.
//[STABILITY] A failed message is counted and passed over, never retried - its earlier writes are committed.
//THE EXCEPTION is a transient failure before the first write, which is safe to attempt again precisely because
//nothing is committed yet; that stops the run instead - see ThrottledBeforeWrite (lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  //[SECURITY] Runs before any external call, so an unauthorized request costs nothing.
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401);
  const upperBoundMs = Date.now();
  //[DEBUG] Every figure the closing summary reports lives out here rather than inside the try, so the finally
  //can print that line on ANY exit - including one where a read or saveSyncCursor threw. See lib/run-summary.ts.
  let cursor: SyncCursor | null = null;
  let conversationCount = 0;
  let messageCount = 0;
  const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
  const failures: string[] = [];
  //Messages the loop reached before it stopped, so a partial run can report what it left behind.
  let examinedCount = 0;
  //[DEBUG] Of those, the ones the cursor rejected as handled on an earlier run. On this sync that is most of
  //them by design - see the [PERF] note above, where a day-granular fetch re-reads every conversation touched
  //since UTC midnight - so the summary states it rather than leaving the shortfall to be inferred.
  let beforeCursorCount = 0;
  //Why the loop stopped early, if it did. Both reasons share one consequence - the cursor must NOT be parked
  //at now - so they are one value rather than two flags that could disagree.
  //Why this run covered less than the whole window, if it did. Every reason shares one consequence - the
  //cursor must NOT be parked at now - so they are one value rather than flags that could disagree.
  //"window-throttled" is the FETCH stopping partway, which means the window itself is short and the records
  //beyond it were never seen; the others are the loop stopping partway through a window it read in full.
  let stopReason: "budget" | "throttled" | "window-throttled" | null = null;
  let cursorSaved = false;
  let fatal: string | null = null;

  try {
    cursor = await getSyncCursor(SYNC_KEY, upperBoundMs);
    //[STABILITY] A short read is a partial run, not a failed one. A 429 used to abandon the run before
    //saveSyncCursor, leaving the mark where it was so the next run re-read the same window and failed the same
    //way - the loop the Instantly sync sat in for five days. Whatever was read is now processed and the cursor
    //parked after it, so every run makes progress.
    const window = await fetchHeyReachConversationWindow({
      fromMs: cursor.timestampMs,
      toMs: upperBoundMs,
    });
    if (window.stoppedBy) stopReason = "window-throttled";
    const conversations = window.conversations;
    conversationCount = conversations.length;
    const events = await heyReachTouchpointEvents(conversations);
    messageCount = events.length;
    //[STABILITY] See lib/run-budget.ts. Without this, an overrun is killed by Vercel before saveSyncCursor and
    //the run's whole progress is discarded, so the next run redoes it and re-increments every counter. The
    //[PERF] note above makes this sync the likeliest to need it: its cost grows through the UTC day.
    const budget = startRunBudget(upperBoundMs, "HEYREACH_SYNC_BUDGET_MS");

    for (const event of events) {
      //Checked before the message rather than after, so the budget is what remains for a whole one. Stopping
      //here leaves `cursor` where the last handled message put it; everything past stays above the mark.
      if (budget.expired()) {
        stopReason ??= "budget";
        break;
      }
      examinedCount += 1;
      //Everything at or below the mark was handled on an earlier run - this is the authoritative guard.
      if (!isAfterCursor(cursor, event.cursor)) {
        beforeCursorCount += 1;
        continue;
      }
      try {
        const outcome = await processHeyReachTouchpoint(event);
        results[outcome] += 1;
      } catch (error) {
        //[STABILITY] Throttled or 500'd before writing anything: the one failure that is safe to attempt
        //again. The cursor is left BELOW this message and the run stops here, so the next run starts on it.
        //Deliberately not counted as a failure - nothing was lost, the work is deferred. See
        //ThrottledBeforeWrite (lib/attio.ts).
        if (error instanceof ThrottledBeforeWrite) {
          console.warn(
            `[event] heyreach message ${event.cursor.id}: throttled before writing anything - ${error.message}. The run stops here and the next one starts on this message, so nothing is lost and nothing is double-counted.`,
          );
          stopReason ??= "throttled";
          //Examined but not handled, so it counts towards what is left rather than what was done.
          examinedCount -= 1;
          break;
        }
        failures.push(`Message ${event.cursor.id}: ${errorMessage(error)}`);
        console.error(
          `[event] heyreach message ${event.cursor.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs. The one exception broke out
      //above, before reaching this line.
      cursor = advanceCursor(cursor, event.cursor);
    }

    const messagesRemaining = messageCount - examinedCount;
    if (stopReason) {
      //[STABILITY] Do NOT park at now. Parking claims everything up to that moment was dealt with, and the
      //messages the loop never reached were not - they would be skipped forever. Leaving the cursor where the
      //loop stopped is what makes the next run resume instead of restart.
      console.warn(
        stopReason === "budget"
          ? `[run] heyreach sync: stopped after ${budgetSeconds(budget)}s of a ${messageCount}-message stream with ${messagesRemaining} still to do, cursor left at ${new Date(cursor.timestampMs).toISOString()} to resume from.${messagesRemaining > examinedCount ? " More is left than was done - if that repeats, messages are arriving faster than they are processed." : ""}`
          : stopReason === "throttled"
            ? `[run] heyreach sync: stopped by Attio throttling with ${messagesRemaining} of ${messageCount} message(s) still to do, cursor left at ${new Date(cursor.timestampMs).toISOString()} to resume from. Nothing was lost; the next run starts on the message that was throttled. Repeated throttling means this sync is querying Attio faster than the account allows.`
            : `[run] heyreach sync: HeyReach throttled the window read, so this run saw only part of it and there are conversations beyond what it fetched. What was read is processed and the cursor is left at ${new Date(cursor.timestampMs).toISOString()} to resume from; nothing is lost. Persisting past a few runs means the workspace is spending its HeyReach allowance faster than this sync can read a window.`,
      );
    } else {
      //[STABILITY] Park short of now. A message HeyReach has not yet published is picked up next run, not skipped.
      cursor = advanceCursorTo(cursor, upperBoundMs - CURSOR_GRACE_MS);
    }
    await saveSyncCursor(cursor);
    cursorSaved = true;
    const body = {
      success: failures.length === 0,
      conversationsScanned: conversationCount,
      messagesFound: messageCount,
      //Part of messagesFound rather than extra to it: the slice an earlier run had already dealt with.
      beforeCursor: beforeCursorCount,
      ...results,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      //[DEBUG] A stopped run is a success - it wrote everything it reached and saved its place.
      truncated: stopReason !== null,
      //[DEBUG] stopReason separates "ran out of time" from "Attio throttled us", which want different
      //responses: the first is a throughput problem, the second is a rate-limit one.
      ...(stopReason ? { stopReason, messagesRemaining } : {}),
      //[DEBUG] Errors are returned as well as logged, so a manual run reports failures without a log search.
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    //Held for the summary below, which runs after this response is prepared and before it is sent.
    fatal = errorMessage(error);
    return serverError("HeyReach touchpoint sync error", error);
  } finally {
    //[DEBUG] Exactly one of these per invocation, whatever happened - see lib/run-summary.ts. It leads with
    //the touchpoints actually written, because that is the figure anyone reading a run wants first; the
    //breakdown that follows says how the rest of the window was accounted for.
    console.log(
      `[run] heyreach sync: ${results.processed} touchpoint(s) logged, ${conversationCount} conversation(s) and ${messageCount} message(s) returned, ${beforeCursorCount} from before the cursor and already counted, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, ${runOutcome(fatal, stopReason, messageCount - examinedCount)}, ${cursorState(cursor, cursorSaved)}`,
    );
  }
}

// ---------------------------

//record message touchpoints===================================================================================

//#region <record message touchpoints: build message stream>
//---------------------------------------------------------------------------------------------------------
//Flattens conversations into one chronological message stream with a stable ID per message.
//HeyReach gives messages no ID of their own, so heyReachMessageId (lib/heyreach.ts) hashes the conversation
//ID, timestamp, sender, subject, and body into one. Identical content in the same conversation at the same
//instant collapses to one event, which is the correct outcome.
//[PERF] Hashing is per message and the fetch returns whole days, so callers skip spent conversations first.
//---------------------------------------------------------------------------------------------------------
export async function heyReachTouchpointEvents(
  conversations: readonly HeyReachConversation[],
): Promise<readonly HeyReachTouchpointEvent[]> {
  const events: HeyReachTouchpointEvent[] = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      events.push({
        conversation,
        message,
        cursor: {
          id: await heyReachMessageId(conversation, message),
          timestampMs: Date.parse(message.createdAt),
        },
      });
    }
  }
  return events.sort((left, right) => left.cursor.timestampMs - right.cursor.timestampMs);
}
//#endregion

//#region <record message touchpoints: write to attio>
//---------------------------------------------------------------------------------------------------------
//Records one LinkedIn message as a touchpoint on the Person and, when linked, the Company.
//FLOW: 1. match a Person on the correspondent's profile URL. 2. require Master TAM membership. 3. note plus
//counter on the Person. 4. note plus counter on the Company when one is linked.
//USES: findPersonByLinkedIn, isPersonInList, createNote, incrementCounter, personCompanyId, personCounterSlug,
//companyCounterSlug (lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function processHeyReachTouchpoint(
  event: HeyReachTouchpointEvent,
): Promise<ProcessingOutcome> {
  //The correspondent is the lead. The sending LinkedIn account is never matched on - that would attach the
  //touchpoint to our own sender.
  //[STABILITY] The filtered lookup, and the list read after it, are the whole pre-write region - see
  //beforeAnyWrite (lib/attio.ts). incrementCounter below opens with a read too, but its PATCH is inside the
  //same call, so a failure there cannot be told apart from a failure after it and stays on the pass-over path.
  const person = await beforeAnyWrite(() => findPersonByLinkedIn(event.conversation.profile.profileUrl));
  if (!person) {
    console.log(
      `[event] heyreach message ${event.cursor.id}: skipped - no Attio person has ${event.conversation.profile.profileUrl}`,
    );
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  //Master TAM is the gate on counting anything: off-list people are read but never written to.
  if (!(await beforeAnyWrite(() => isPersonInList(personId, LISTS.MASTER_TAM, personName)))) {
    console.log(
      `[event] heyreach message ${event.cursor.id}: skipped - person ${personName} is not on the Master TAM list`,
    );
    return "not_tam";
  }

  const profile = event.conversation.profile;
  const leadName = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || "HeyReach conversation";
  const title = `${event.message.subject ?? leadName} — ${event.message.createdAt}`;
  const body = event.message.body || "(no message content)";
  await createNote("people", personId, title, body, personName);
  await incrementCounter("people", personId, personCounterSlug("heyreach"), personName);

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `HeyReach message with ${personDisplayName(person) ?? leadName}:\n\n${body}`,
    );
    await incrementCounter("companies", companyId, companyCounterSlug("heyreach"));
  }
  return "processed";
}
//#endregion

//=============================================================================================================
