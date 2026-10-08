//The closing line every touchpoint sync prints, and the two parts of it that were getting lost.
//
//WHY THIS EXISTS. Each sync ends by logging one "[run] <provider> sync: ..." summary. That line used to sit
//after saveSyncCursor and inside the handler's try, so ANY throw skipped it - and the throws are not rare:
//Supabase answers both the cursor read and the cursor write with a 504 often enough to see several in a day.
//A run that failed therefore logged a stack and nothing else, which left the summary line useless as a record
//of what ran: a gap in it could mean a failure, a kill, or a cron that never fired, and the three want
//completely different responses.
//
//Every sync now prints its summary from a `finally`, so there is exactly one line per invocation whatever
//happened. These two helpers are the parts that differ between a clean run and a failed one. They live here
//rather than in each handler because a summary that is only sometimes comparable across the four providers is
//barely better than one that is sometimes absent.

//=============================================================================================================
//#region <import statements>

import type { SyncCursor } from "./cursors.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <build the summary line>

//#region <run outcome and cursor state>
//---------------------------------------------------------------------------------------------------------
//[DEBUG] How the run ended.
//`stopped` is null when the loop ran to the end, and otherwise the reason it stopped - "budget" or
//"throttled". All four syncs can stop either way, so all four name which it was; the two want telling apart
//because a budget stop is a throughput problem and a throttle is a rate-limit one.
//[LOGIC] A fatal outranks a stop. If both happened then the save is what threw, and that is the half worth
//reading - a stop only means "resume from here next run" once its cursor has actually reached Supabase.
//---------------------------------------------------------------------------------------------------------
export function runOutcome(fatal: string | null, stopped: string | null, remaining: number): string {
  if (fatal) return `ABANDONED on an error - ${fatal}`;
  if (!stopped) return "complete";
  return `STOPPED (${stopped}) with ${remaining} left`;
}

//---------------------------------------------------------------------------------------------------------
//[DEBUG] Where the mark ended up, which is the difference between a run whose work will not be repeated and
//one whose work will. An unsaved cursor is named as such rather than printed as a timestamp: a run that noted
//forty touchpoints to Attio and then failed to persist its mark will note all forty again next run, and this
//is the line that has to say so rather than printing a mark that was never stored.
//---------------------------------------------------------------------------------------------------------
export function cursorState(cursor: SyncCursor | null, saved: boolean): string {
  if (!cursor) return "no cursor was ever read, so nothing was processed and nothing was saved";
  const at = new Date(cursor.timestampMs).toISOString();
  if (saved) return `cursor now ${at}`;
  return `cursor NOT saved (it would have been ${at}) - the previous mark stands and this window is re-read next run`;
}
//#endregion

//#endregion
//=============================================================================================================
