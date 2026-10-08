//=============================================================================================================
//#region <import statements>

import { credentialHint, supabaseBaseUrl, supabaseHeaders } from "./endpoints.js"; //supabase address, login and error hints
import { //safe readers for unknown json
  arrayValue,
  isJsonObject,
  responseJson,
  stringValue,
} from "./json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//A sync's saved progress mark: the newest time handled, and the events handled at exactly that time.
export interface SyncCursor {
  readonly syncKey: string; //which sync this mark belongs to
  readonly timestampMs: number; //newest handled time, epoch ms
  readonly eventIdsAtTimestamp: ReadonlySet<string>; //ids already handled at that exact time
}

//One event placed on the cursor timeline: an id and a time.
export interface CursorEvent {
  readonly id: string; //the event's unique id
  readonly timestampMs: number; //when it happened, epoch ms
}

//One stored cursor row, as read from Supabase.
interface CursorRow {
  readonly syncKey: string; //the sync_key column
  readonly cursorValue: string | null; //the boundary ids, as JSON text
  readonly cursorTimestamp: string; //the mark's time, as text
}

const CURSOR_TABLE = "Attio_Integrations_Touchpoint_Cursors"; //supabase table holding every sync's mark
const DEFAULT_LOOKBACK_MS = 10 * 60 * 1_000; //first run looks back ten minutes

//[STABILITY] Margin subtracted before a sync parks its cursor at "now". Provider timestamps are generated on the
//provider's clock and become readable through its API some time later; parking at the local Date.now() skips
//anything that lands in that gap. Re-reading the margin is free because isAfterCursor rejects the overlap, and the
//eventIdsAtTimestamp set is retained whenever the last processed event is newer than the parked value.
export const CURSOR_GRACE_MS = 2 * 60 * 1_000; //park two minutes short of now

//[STABILITY] Outfound's margin, which has to be wider than everyone else's. The other providers publish an event
//as they record it, so two minutes covers the gap between their clock and their API. Outfound does not: it is an
//OLAP warehouse fed by a queue, refreshed on a cadence of about three minutes, so an email that has already
//happened is routinely not yet readable. Parking at the shared two minutes would leave the mark ahead of emails
//still in flight, and isAfterCursor would then reject them forever when they did land - a silent, permanent loss.
//Five minutes is that cadence with room over it. Re-reading the margin is free; parking past it is not.
export const OUTFOUND_CURSOR_GRACE_MS = 5 * 60 * 1_000; //outfound parks five minutes short of now

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <move cursors>

//#region <start and check>
//---------------------------------------------------------------------------------------------------------
//Base function. Makes the starting cursor for a sync that has never saved one.
//Input: syncKey - which sync; nowMs - the current time, epoch ms (defaults to now).
//Output: a cursor ten minutes before nowMs, with no handled ids.
//Workflow: getSyncCursor - the first run for a sync key, when Supabase has no row yet. Also used by the unit tests.
//---------------------------------------------------------------------------------------------------------
export function initialCursor(syncKey: string, nowMs = Date.now()): SyncCursor {
  return {
    syncKey, //same as syncKey: syncKey
    timestampMs: nowMs - DEFAULT_LOOKBACK_MS, //ten minutes ago
    eventIdsAtTimestamp: new Set(), //nothing handled yet
  };
}

//---------------------------------------------------------------------------------------------------------
//Base function. Checks whether an event is newer than the mark, i.e. not handled yet.
//Input: cursor - the sync's current mark; event - the event to check.
//Output: true if the event still needs handling, false if an earlier run already handled it.
//Workflow: all four touchpoint syncs (aircall, heyreach, instantly, outfound), step 5 (6 on Instantly) - skip
//events at or below the mark.
//
//The ID set exists because several events can share one timestamp; a timestamp comparison alone would either
//replay all of them or drop all but the first.
//---------------------------------------------------------------------------------------------------------
export function isAfterCursor(cursor: SyncCursor, event: CursorEvent): boolean {
  return ( //newer than mark, or on it and unseen
    event.timestampMs > cursor.timestampMs ||
    (event.timestampMs === cursor.timestampMs && !cursor.eventIdsAtTimestamp.has(event.id))
  );
}
//#endregion

//#region <advance>
//---------------------------------------------------------------------------------------------------------
//Base function. Moves the mark past one handled event. Returns a new cursor; never changes the old one.
//Input: cursor - the current mark; event - the event just handled.
//Output: the updated cursor (the same one if the event is older than the mark).
//Workflow: all four touchpoint syncs, step 6 (7 on Instantly) - move the mark past each handled event,
//whether or not its writes succeeded.
//---------------------------------------------------------------------------------------------------------
export function advanceCursor(cursor: SyncCursor, event: CursorEvent): SyncCursor {
  //An out-of-order event that predates the mark cannot move it backwards.
  if (event.timestampMs < cursor.timestampMs) return cursor; //older event, mark unchanged
  //A newer event makes every previously recorded boundary ID unreachable, so the set starts over.
  if (event.timestampMs > cursor.timestampMs) { //newer event
    return { //new mark at this event
      syncKey: cursor.syncKey, //same sync
      timestampMs: event.timestampMs, //mark moves to this event's time
      eventIdsAtTimestamp: new Set([event.id]), //only this event at the new time
    };
  }
  //Same millisecond as the mark: keep the mark, record this ID so it is not replayed.
  return { //same mark, one more id
    syncKey: cursor.syncKey, //same sync
    timestampMs: cursor.timestampMs, //mark stays put
    eventIdsAtTimestamp: new Set([...cursor.eventIdsAtTimestamp, event.id]), //old ids plus this one
  };
}

//---------------------------------------------------------------------------------------------------------
//Base function. Parks the mark at a set time at the end of a run so a quiet window is not re-read forever.
//Input: cursor - the current mark; timestampMs - the time to park at, epoch ms.
//Output: the parked cursor, or the same cursor if it is already at or past that time.
//Workflow: all four touchpoint syncs, step 7 (8 on Instantly) - park at now minus the grace margin, skipped
//when the run stopped early.
//
//[PERF] Without this the fetch window grows without bound whenever no events arrive.
//[STABILITY] Callers pass (upperBound - CURSOR_GRACE_MS), not upperBound. The guard below is what makes that
//safe: if the last handled event is newer than the parked value the cursor is returned untouched, so its
//boundary ID set survives and that event is not replayed on the next run.
//---------------------------------------------------------------------------------------------------------
export function advanceCursorTo(cursor: SyncCursor, timestampMs: number): SyncCursor {
  if (timestampMs <= cursor.timestampMs) return cursor; //already past it, keep as is
  //Nothing is known to have occurred at the parked instant, so the boundary set starts empty.
  return { syncKey: cursor.syncKey, timestampMs, eventIdsAtTimestamp: new Set() }; //parked mark, no ids
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <store cursors in supabase>

//#region <read and save>
//---------------------------------------------------------------------------------------------------------
//Reads one sync's saved mark from Supabase (PostgREST).
//Input: syncKey - which sync; nowMs - the current time, epoch ms (defaults to now), used on a first run.
//Output: the sync's cursor; a ten-minute lookback when none is saved. Throws if the read fails or the row is bad.
//Uses: cursorEndpoint, initialCursor, parseCursorRow, parseCursorTimestamp, parseBoundaryIds (this file);
//supabaseHeaders, credentialHint (lib/endpoints.ts); responseJson (lib/json.ts).
//Workflow: all four touchpoint syncs, step 2 - where the run starts from.
//
//[STABILITY] An unreadable or malformed row throws rather than defaulting, because a silently reset mark would
//replay or skip an unbounded stretch of history.
//---------------------------------------------------------------------------------------------------------
export async function getSyncCursor(syncKey: string, nowMs = Date.now()): Promise<SyncCursor> {
  //One row, keyed by sync_key, with only the three columns this module reads.
  const url = cursorEndpoint(); //the cursor table's url
  url.searchParams.set("sync_key", `eq.${syncKey}`); //only this sync's row
  url.searchParams.set("select", "sync_key,cursor_value,cursor_timestamp"); //only the needed columns
  url.searchParams.set("limit", "1"); //one row at most

  const response = await fetch(url, { headers: supabaseHeaders() }); //send the read
  const body = await responseJson(response); //read the body as json
  //[DEBUG] credentialHint turns a 401/403 into the name of the env var that has to change.
  if (!response.ok) { //supabase refused or failed
    throw new Error(`Supabase cursor read failed (${response.status}): ${JSON.stringify(body)}${credentialHint("supabase", response.status)}`); //stop the run
  }
  if (!isJsonObject(body) && !Array.isArray(body)) { //neither object nor list
    throw new Error("Supabase returned an invalid cursor response"); //unexpected shape
  }
  const rows = Array.isArray(body) ? body : arrayValue(body, "data"); //the rows, either shape
  //First run for this sync key: start a ten-minute lookback and let saveSyncCursor create the row.
  if (rows.length === 0) return initialCursor(syncKey, nowMs); //no row yet, start fresh

  const row = parseCursorRow(rows[0]); //check and read the row
  const timestampMs = parseCursorTimestamp(row.cursorTimestamp); //mark's time as epoch ms
  if (!Number.isFinite(timestampMs)) throw new Error("Supabase cursor timestamp is invalid"); //unreadable time
  return {
    syncKey: row.syncKey, //which sync
    timestampMs, //same as timestampMs: timestampMs
    eventIdsAtTimestamp: parseBoundaryIds(row.cursorValue), //ids handled at the mark
  };
}

//---------------------------------------------------------------------------------------------------------
//Saves the mark to Supabase. Upsert on sync_key, so the first run creates the row and later runs overwrite it.
//Input: cursor - the mark to save.
//Output: nothing. Throws if Supabase refuses the write.
//Uses: cursorEndpoint (this file); supabaseHeaders, credentialHint (lib/endpoints.ts).
//Workflow: all four touchpoint syncs, step 7 (8 on Instantly) - persist where the run got to.
//
//[STABILITY] Called once per run, after the event loop. A throw here fails the run and leaves the previous
//mark in place, so the window is re-read next time rather than skipped.
//---------------------------------------------------------------------------------------------------------
export async function saveSyncCursor(cursor: SyncCursor): Promise<void> {
  const url = cursorEndpoint(); //the cursor table's url
  url.searchParams.set("on_conflict", "sync_key"); //match existing rows by sync_key
  const now = new Date().toISOString(); //time of this save
  const response = await fetch(url, { //send the write
    method: "POST", //POST creates or updates
    headers: { //request headers
      ...supabaseHeaders(), //copy in the login headers
      //resolution=merge-duplicates makes this an upsert; return=minimal suppresses the echoed row.
      Prefer: "resolution=merge-duplicates,return=minimal", //update if exists, no echo
    },
    body: JSON.stringify({ //the row, as JSON text
      sync_key: cursor.syncKey, //which sync
      //Sorted so an unchanged set serialises identically and the stored value stays diffable.
      cursor_value: JSON.stringify([...cursor.eventIdsAtTimestamp].sort()), //boundary ids as a sorted list
      cursor_timestamp: new Date(cursor.timestampMs).toISOString(), //the mark's time
      last_updated_at: now, //when it was saved
    }),
  });
  if (!response.ok) { //supabase refused the write
    throw new Error(`Supabase cursor write failed (${response.status}): ${await response.text()}${credentialHint("supabase", response.status)}`); //fail the run
  }
}
//#endregion

//#region <parse stored rows>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads the stored boundary ids back into a set.
//Input: cursorValue - the cursor_value column, JSON list text or one bare id, or null.
//Output: the set of ids, possibly empty.
//Workflow: getSyncCursor - fills eventIdsAtTimestamp.
//---------------------------------------------------------------------------------------------------------
function parseBoundaryIds(cursorValue: string | null): ReadonlySet<string> {
  if (!cursorValue) return new Set(); //nothing stored, empty set
  try {
    const parsed: unknown = JSON.parse(cursorValue); //read the JSON text
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) { //a list of text ids
      return new Set(parsed); //the ids as a set
    }
  } catch {
    //[STABILITY] Pre-migration rows hold one bare event ID rather than a JSON array.
  }
  return new Set([cursorValue]); //old format: one bare id
}

//---------------------------------------------------------------------------------------------------------
//Base function. Turns the stored timestamp text into epoch milliseconds.
//Input: value - the cursor_timestamp column.
//Output: epoch ms, or NaN if it cannot be read.
//Workflow: getSyncCursor - the mark's time.
//---------------------------------------------------------------------------------------------------------
function parseCursorTimestamp(value: string): number {
  //Postgres may return the timestamp without a zone suffix; absent one, read it as UTC rather than local time.
  const includesTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value); //ends in Z or +hh:mm
  return Date.parse(includesTimezone ? value : `${value}Z`); //add Z if missing, then parse
}

//---------------------------------------------------------------------------------------------------------
//Base function. Checks one raw Supabase row and reads it into a CursorRow.
//Input: value - the first row Supabase returned, unknown shape.
//Output: the row. Throws if it is not an object or a required field is missing.
//Workflow: getSyncCursor - the stored row before it becomes a cursor.
//---------------------------------------------------------------------------------------------------------
function parseCursorRow(value: unknown): CursorRow {
  if (!isJsonObject(value)) throw new Error("Supabase returned an invalid cursor row"); //not an object
  const syncKey = stringValue(value.sync_key); //which sync, or null
  const cursorTimestamp = stringValue(value.cursor_timestamp); //mark's time text, or null
  const cursorValue = value.cursor_value === null ? null : stringValue(value.cursor_value); //boundary ids text, or null
  if (!syncKey || !cursorTimestamp || (value.cursor_value !== null && !cursorValue)) { //a required field is missing
    throw new Error("Supabase cursor row is missing required fields"); //unusable row
  }
  return { syncKey, cursorValue, cursorTimestamp }; //the checked row
}
//#endregion

//#region <table address>
//---------------------------------------------------------------------------------------------------------
//Builds the url of the cursor table.
//Input: none.
//Output: the table's PostgREST url.
//Uses: supabaseBaseUrl (lib/endpoints.ts).
//Workflow: getSyncCursor and saveSyncCursor - every cursor read and write.
//---------------------------------------------------------------------------------------------------------
function cursorEndpoint(): URL {
  return new URL(`/rest/v1/${CURSOR_TABLE}`, supabaseBaseUrl()); //base url plus table path
}
//#endregion

//#endregion
//=============================================================================================================
