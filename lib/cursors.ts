//imports======================================================================================================

import { credentialHint, supabaseBaseUrl, supabaseHeaders } from "./endpoints.js";
import {
  arrayValue,
  isJsonObject,
  responseJson,
  stringValue,
} from "./json.js";

//=============================================================================================================

//types and globals============================================================================================

export interface SyncCursor {
  readonly syncKey: string;
  readonly timestampMs: number;
  readonly eventIdsAtTimestamp: ReadonlySet<string>;
}

export interface CursorEvent {
  readonly id: string;
  readonly timestampMs: number;
}

interface CursorRow {
  readonly syncKey: string;
  readonly cursorValue: string | null;
  readonly cursorTimestamp: string;
}

const CURSOR_TABLE = "Attio_Integrations_Touchpoint_Cursors";
const DEFAULT_LOOKBACK_MS = 10 * 60 * 1_000;

//[STABILITY] Margin subtracted before a sync parks its cursor at "now". Provider timestamps are generated on the
//provider's clock and become readable through its API some time later; parking at the local Date.now() skips
//anything that lands in that gap. Re-reading the margin is free because isAfterCursor rejects the overlap, and the
//eventIdsAtTimestamp set is retained whenever the last processed event is newer than the parked value.
export const CURSOR_GRACE_MS = 2 * 60 * 1_000;

//[STABILITY] Outfound's margin, which has to be wider than everyone else's. The other providers publish an event
//as they record it, so two minutes covers the gap between their clock and their API. Outfound does not: it is an
//OLAP warehouse fed by a queue, refreshed on a cadence of about three minutes, so an email that has already
//happened is routinely not yet readable. Parking at the shared two minutes would leave the mark ahead of emails
//still in flight, and isAfterCursor would then reject them forever when they did land - a silent, permanent loss.
//Five minutes is that cadence with room over it. Re-reading the margin is free; parking past it is not.
export const OUTFOUND_CURSOR_GRACE_MS = 5 * 60 * 1_000;

//=============================================================================================================

//move cursors=================================================================================================

//#region <move cursors: start and check>
export function initialCursor(syncKey: string, nowMs = Date.now()): SyncCursor {
  return {
    syncKey,
    timestampMs: nowMs - DEFAULT_LOOKBACK_MS,
    eventIdsAtTimestamp: new Set(),
  };
}

//---------------------------------------------------------------------------------------------------------
//Duplicate-suppression predicate. True means the event has not been handled yet.
//FLOW: 1. newer than the mark -> unhandled. 2. exactly on the mark -> unhandled only if its ID is absent from
//the boundary set. 3. older -> already handled.
//The ID set exists because several events can share one timestamp; a timestamp comparison alone would either
//replay all of them or drop all but the first.
//---------------------------------------------------------------------------------------------------------
export function isAfterCursor(cursor: SyncCursor, event: CursorEvent): boolean {
  return (
    event.timestampMs > cursor.timestampMs ||
    (event.timestampMs === cursor.timestampMs && !cursor.eventIdsAtTimestamp.has(event.id))
  );
}
//#endregion

//#region <move cursors: advance>
//---------------------------------------------------------------------------------------------------------
//Moves the mark past one handled event. Returns a new cursor; never mutates.
//FLOW: 1. older than the mark -> unchanged. 2. newer -> mark moves, boundary set resets to this ID alone.
//3. equal -> mark holds, this ID joins the boundary set.
//---------------------------------------------------------------------------------------------------------
export function advanceCursor(cursor: SyncCursor, event: CursorEvent): SyncCursor {
  //An out-of-order event that predates the mark cannot move it backwards.
  if (event.timestampMs < cursor.timestampMs) return cursor;
  //A newer event makes every previously recorded boundary ID unreachable, so the set starts over.
  if (event.timestampMs > cursor.timestampMs) {
    return {
      syncKey: cursor.syncKey,
      timestampMs: event.timestampMs,
      eventIdsAtTimestamp: new Set([event.id]),
    };
  }
  //Same millisecond as the mark: keep the mark, record this ID so it is not replayed.
  return {
    syncKey: cursor.syncKey,
    timestampMs: cursor.timestampMs,
    eventIdsAtTimestamp: new Set([...cursor.eventIdsAtTimestamp, event.id]),
  };
}

//---------------------------------------------------------------------------------------------------------
//Parks the mark at the end of a run so a quiet window is not re-read forever.
//[PERF] Without this the fetch window grows without bound whenever no events arrive.
//[STABILITY] Callers pass (upperBound - CURSOR_GRACE_MS), not upperBound. The guard below is what makes that
//safe: if the last handled event is newer than the parked value the cursor is returned untouched, so its
//boundary ID set survives and that event is not replayed on the next run.
//---------------------------------------------------------------------------------------------------------
export function advanceCursorTo(cursor: SyncCursor, timestampMs: number): SyncCursor {
  if (timestampMs <= cursor.timestampMs) return cursor;
  //Nothing is known to have occurred at the parked instant, so the boundary set starts empty.
  return { syncKey: cursor.syncKey, timestampMs, eventIdsAtTimestamp: new Set() };
}
//#endregion

//=============================================================================================================

//store cursors in supabase====================================================================================

//#region <store cursors in supabase: read and save>
//---------------------------------------------------------------------------------------------------------
//Reads one sync's persisted mark from Supabase (PostgREST).
//FLOW: 1. build a filtered single-row GET. 2. send with supabaseHeaders (lib/endpoints.ts). 3. throw on non-2xx,
//appending credentialHint (lib/endpoints.ts). 4. no row -> initialCursor, a ten-minute lookback. 5. row -> parse
//via parseCursorRow / parseCursorTimestamp / parseBoundaryIds.
//[STABILITY] An unreadable or malformed row throws rather than defaulting, because a silently reset mark would
//replay or skip an unbounded stretch of history.
//---------------------------------------------------------------------------------------------------------
export async function getSyncCursor(syncKey: string, nowMs = Date.now()): Promise<SyncCursor> {
  //One row, keyed by sync_key, with only the three columns this module reads.
  const url = cursorEndpoint();
  url.searchParams.set("sync_key", `eq.${syncKey}`);
  url.searchParams.set("select", "sync_key,cursor_value,cursor_timestamp");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, { headers: supabaseHeaders() });
  const body = await responseJson(response);
  //[DEBUG] credentialHint turns a 401/403 into the name of the env var that has to change.
  if (!response.ok) {
    throw new Error(`Supabase cursor read failed (${response.status}): ${JSON.stringify(body)}${credentialHint("supabase", response.status)}`);
  }
  if (!isJsonObject(body) && !Array.isArray(body)) {
    throw new Error("Supabase returned an invalid cursor response");
  }
  const rows = Array.isArray(body) ? body : arrayValue(body, "data");
  //First run for this sync key: start a ten-minute lookback and let saveSyncCursor create the row.
  if (rows.length === 0) return initialCursor(syncKey, nowMs);

  const row = parseCursorRow(rows[0]);
  const timestampMs = parseCursorTimestamp(row.cursorTimestamp);
  if (!Number.isFinite(timestampMs)) throw new Error("Supabase cursor timestamp is invalid");
  return {
    syncKey: row.syncKey,
    timestampMs,
    eventIdsAtTimestamp: parseBoundaryIds(row.cursorValue),
  };
}

//---------------------------------------------------------------------------------------------------------
//Persists the mark. Upsert on sync_key, so the first run creates the row and later runs overwrite it.
//FLOW: 1. build the endpoint with on_conflict=sync_key. 2. POST with merge-duplicates so PostgREST updates
//instead of erroring on the unique key. 3. throw on non-2xx.
//[STABILITY] Called once per run, after the event loop. A throw here fails the run and leaves the previous
//mark in place, so the window is re-read next time rather than skipped.
//---------------------------------------------------------------------------------------------------------
export async function saveSyncCursor(cursor: SyncCursor): Promise<void> {
  const url = cursorEndpoint();
  url.searchParams.set("on_conflict", "sync_key");
  const now = new Date().toISOString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      //resolution=merge-duplicates makes this an upsert; return=minimal suppresses the echoed row.
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      sync_key: cursor.syncKey,
      //Sorted so an unchanged set serialises identically and the stored value stays diffable.
      cursor_value: JSON.stringify([...cursor.eventIdsAtTimestamp].sort()),
      cursor_timestamp: new Date(cursor.timestampMs).toISOString(),
      last_updated_at: now,
    }),
  });
  if (!response.ok) {
    throw new Error(`Supabase cursor write failed (${response.status}): ${await response.text()}${credentialHint("supabase", response.status)}`);
  }
}
//#endregion

//#region <store cursors in supabase: parse stored rows>
function parseBoundaryIds(cursorValue: string | null): ReadonlySet<string> {
  if (!cursorValue) return new Set();
  try {
    const parsed: unknown = JSON.parse(cursorValue);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return new Set(parsed);
    }
  } catch {
    //[STABILITY] Pre-migration rows hold one bare event ID rather than a JSON array.
  }
  return new Set([cursorValue]);
}

function parseCursorTimestamp(value: string): number {
  //Postgres may return the timestamp without a zone suffix; absent one, read it as UTC rather than local time.
  const includesTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return Date.parse(includesTimezone ? value : `${value}Z`);
}

function parseCursorRow(value: unknown): CursorRow {
  if (!isJsonObject(value)) throw new Error("Supabase returned an invalid cursor row");
  const syncKey = stringValue(value.sync_key);
  const cursorTimestamp = stringValue(value.cursor_timestamp);
  const cursorValue = value.cursor_value === null ? null : stringValue(value.cursor_value);
  if (!syncKey || !cursorTimestamp || (value.cursor_value !== null && !cursorValue)) {
    throw new Error("Supabase cursor row is missing required fields");
  }
  return { syncKey, cursorValue, cursorTimestamp };
}
//#endregion

//#region <store cursors in supabase: table address>
function cursorEndpoint(): URL {
  return new URL(`/rest/v1/${CURSOR_TABLE}`, supabaseBaseUrl());
}
//#endregion

//=============================================================================================================
