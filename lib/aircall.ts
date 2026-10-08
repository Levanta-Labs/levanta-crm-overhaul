//========================================================================================
//#region <import statements>
import { AIRCALL_BASE, aircallAuthHeader, credentialHint } from "./endpoints.js";
import { rateLimitWaitMs } from "./http.js";
//Aircall spells a number for display ("+1 949-735-4000"); Attio matches E.164. One shared normaliser, because
//a lookup keyed on the wrong spelling misses and creates a duplicate Person - see lib/phone.ts.
import { toE164 } from "./phone.js";
import {
  arrayValue,
  isJsonObject,
  numberValue,
  objectValue,
  responseJson,
  stringValue,
} from "./json.js";

//#endregion
//==========================================================================================

//=====================================================================================================
//#region <Interfaces>

export interface AircallTag {
  readonly name: string;
}

export interface AircallContact {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  //Every number on the address-book entry, E.164. The dialled raw_digits is only one of them, and the others
  //are as much this person's numbers as that one is.
  readonly phoneNumbers: readonly string[];
  //Aircall's free-text notes field on a contact. Whatever an agent wrote there about who this person is.
  readonly information: string | null;
}

export interface AircallCall {
  readonly id: number;
  readonly status: string;
  readonly direction: string | null;
  readonly rawDigits: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly duration: number;
  readonly tags: readonly AircallTag[];
  readonly contact: AircallContact | null;
}

//A contact as a campaign holds it. Richer than AircallCall.contact, which is only set when the dialled
//number is already in Aircall's address book - usually not, for a cold campaign.
export interface AircallCampaignContact {
  readonly phoneNumber: string | null; //E.164, normalised from Aircall's bare digits
  readonly firstName: string | null; //contact's first name
  readonly lastName: string | null; //contact's last name
  readonly email: string | null; //contact's email
  readonly companyName: string | null; //contact's company
  readonly note: string | null; //free text supplied with the contact
}

//#endregion
//================================================================

//====================================================================================================
//#region <Parcer Functions>

function parseTag(value: unknown): AircallTag | null {
  if (!isJsonObject(value)) return null;
  const name = stringValue(value.name);
  return name ? { name } : null;
}

function parseContact(value: unknown): AircallContact | null {
  if (!isJsonObject(value)) return null;
  return {
    firstName: stringValue(value.first_name),
    lastName: stringValue(value.last_name),
    companyName: stringValue(value.company_name),
    email: contactEmail(value),
    phoneNumbers: contactPhoneNumbers(value),
    information: stringValue(value.information),
  };
}

export function parseAircallCall(value: unknown): AircallCall {
  if (!isJsonObject(value)) throw new Error("Aircall returned an invalid call");
  const id = numberValue(value.id);
  const startedAt = numberValue(value.started_at);
  //id and started_at are the two fields the cursor and the window depend on; absent either, the call is unusable.
  if (id === null || startedAt === null) {
    throw new Error("Aircall call is missing id or started_at");
  }
  return {
    id,
    status: stringValue(value.status) ?? "unknown",
    direction: stringValue(value.direction),
    rawDigits: stringValue(value.raw_digits),
    startedAt,
    endedAt: numberValue(value.ended_at),
    duration: numberValue(value.duration) ?? 0,
    tags: arrayValue(value, "tags")
      .map(parseTag)
      .filter((tag): tag is AircallTag => tag !== null),
    contact: parseContact(value.contact),
  };
}

//Turns one raw campaign contact into an AircallCampaignContact. Null when it is not an object.
function parseCampaignContact(value: unknown): AircallCampaignContact | null {
  if (!isJsonObject(value)) return null; //nothing readable, no contact
  return {
    phoneNumber: toE164(stringValue(value.phone_number)), //"12158888732" -> "+12158888732"
    firstName: stringValue(value.first_name), //null when blank
    lastName: stringValue(value.last_name), //null when blank
    email: stringValue(value.email), //null when blank
    companyName: stringValue(value.company_name), //null when blank
    note: stringValue(value.note), //null when blank
  };
}
//#endregion
//========================================================================================================


//==================================================================================
//#region <functions for extracting contact identifiers for attio match>

/** Every number on a contact, normalised. Aircall lists them as objects; a stray string is accepted too. */
function contactPhoneNumbers(contact: Record<string, unknown>): readonly string[] {
  const numbers: string[] = [];
  for (const candidate of arrayValue(contact, "phone_numbers")) {
    const raw = typeof candidate === "string" ? candidate : isJsonObject(candidate) ? stringValue(candidate.value) : null;
    const e164 = toE164(raw);
    if (e164 && !numbers.includes(e164)) numbers.push(e164);
  }
  return numbers;
}

//returns contact email address if there is one
function contactEmail(contact: Record<string, unknown>): string | null {
  //Aircall spells a contact address two ways: a scalar `email`, or an `emails` list of strings or of objects.
  const direct = stringValue(contact.email);
  if (direct) return direct;
  for (const candidate of arrayValue(contact, "emails")) {
    if (typeof candidate === "string" && candidate) return candidate;
    if (isJsonObject(candidate)) {
      const value = stringValue(candidate.value) ?? stringValue(candidate.email);
      if (value) return value;
    }
  }
  return null;
}

//#endregion
//=======================================================================================


//---------------------------------------------------------------------------------------------------------
//Reads every completed call in a window. The touchpoint cron is the only caller.
//FLOW: 1. build page one from fromMs/toMs. 2. follow meta.next_page_link until null. 3. parse each entry with
//parseAircallCall. 4. drop anything not finished.
//WINDOW SEMANTICS - the reason the caller over-reaches: Aircall documents from/to as filters on a call's
//CREATION date, and the Call object carries no created_at at all (only started_at, answered_at, ended_at), so
//the filter is effectively on call START. Callers key their cursor on ended_at, so fromMs must be pulled back
//by at least the longest call expected or a long call is filtered out here (not yet "done") on the run that
//covers its start and is out of range by the run that covers its end. See MAX_CALL_DURATION_MS in the cron.
//Sorting cannot substitute for this: `order` only walks created_at, and a call outside the filter is absent
//from the result set entirely, not merely out of order. No v1 endpoint filters or sorts on ended_at.
//USES: aircallAuthHeader, credentialHint (lib/endpoints.ts); responseJson, arrayValue, objectValue (lib/json.ts).
//---------------------------------------------------------------------------------------------------------
//=============================================================================================================
//Rate limiting.
//
//Aircall allows 120 requests a minute PER COMPANY, not per key - so every integration the workspace runs draws
//on the same allowance, and this sync's share of it is not something this codebase can know.
//
//[STABILITY] WHY A RETRY AND NOT A SELF-IMPOSED CAP. Aircall was probed live and answers 200 with no
//rate-limit header at all; its X-AircallApi-Limit/Remaining/Reset trio is documented as arriving only once the
//limit IS reached. So there is no allowance to read ahead of time and nothing honest to pace against, and the
//transport can only react to the refusal. Contrast Instantly, which gets a page cap because its
//20-per-minute ceiling is a documented hard figure.
//A refused request was not processed, so repeating it cannot apply anything twice.
//=============================================================================================================

export class AircallRateLimitError extends Error {
  constructor(detail: string) {
    super(`Aircall rate limit reached: ${detail}`);
    this.name = "AircallRateLimitError";
  }
}

const RATE_LIMIT_ATTEMPTS = 3;
//Matches attioFetch's RETRY_BASE_MS, so the one backoff shape in this codebase stays one shape.
const RATE_LIMIT_BASE_MS = 500;
//[PERF] A run that spends its budget asleep has done nothing. Past this, stopping and resuming next run beats
//waiting - the next run starts with a fresh allowance either way. See rateLimitWaitMs (lib/http.ts).
const RATE_LIMIT_MAX_WAIT_MS = 5_000;

/**
 * [LOGIC] Aircall's own reset header, in ms from now. Documented only as "timestamp when the counter will be
 * reset" with no unit, so both readings are accepted: a value that looks like epoch SECONDS is treated as one,
 * and anything else is tried as a date. A reading that lands in the past or absurdly far ahead is discarded
 * rather than trusted, and the caller falls back to its backoff.
 */
function aircallResetMs(response: Response): number | null {
  const header = response.headers.get("x-aircallapi-reset");
  if (!header) return null;
  const numeric = Number(header);
  const epochMs = Number.isFinite(numeric)
    ? (numeric > 1e11 ? numeric : numeric * 1_000)
    : Date.parse(header);
  if (!Number.isFinite(epochMs)) return null;
  const waitMs = epochMs - Date.now();
  //A whole minute is the widest a per-minute window can legitimately be.
  return waitMs > 0 && waitMs <= 60_000 ? waitMs : null;
}

//---------------------------------------------------------------------------------------------------------
//Single transport for every Aircall call. Nothing else in this module calls fetch.
//FLOW: 1. GET the absolute url. 2. 429 with attempts left -> wait and repeat. 3. 429 out of attempts ->
//AircallRateLimitError, which a caller can tell from a bad request. 4. other non-2xx -> throw.
//[SECURITY] Basic credentials are rebuilt per request from env and never held in module state.
//[DEBUG] credentialHint names AIRCALL_API_ID / AIRCALL_API_TOKEN on a 401/403.
//USES: aircallAuthHeader, credentialHint (lib/endpoints.ts); rateLimitWaitMs (lib/http.ts); responseJson
//(lib/json.ts).
//---------------------------------------------------------------------------------------------------------
async function aircallFetch(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: aircallAuthHeader() } });
    const body = await responseJson(response);
    if (response.ok) return body;

    if (response.status === 429) {
      if (attempt >= RATE_LIMIT_ATTEMPTS) {
        throw new AircallRateLimitError(
          `refused after ${RATE_LIMIT_ATTEMPTS} attempt(s). The 120-per-minute allowance is per COMPANY, so every integration on this workspace spends it, not only this sync.`,
        );
      }
      const waitMs = rateLimitWaitMs(
        response,
        attempt,
        RATE_LIMIT_BASE_MS,
        RATE_LIMIT_MAX_WAIT_MS,
        aircallResetMs(response),
      );
      console.warn(
        `[aircall] 429 (attempt ${attempt} of ${RATE_LIMIT_ATTEMPTS}) - waiting ${waitMs}ms and retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    throw new Error(
      `Aircall API error ${response.status}: ${JSON.stringify(body)}${credentialHint("aircall", response.status)}`,
    );
  }
}

export interface AircallCallWindow {
  readonly calls: readonly AircallCall[];
  /** Set when pagination stopped short of the end of the window; null means it was read to the end. */
  readonly stoppedBy: "throttled" | null;
  readonly pagesRead: number;
}

//---------------------------------------------------------------------------------------------------------
//The paginating form, which keeps what it read when Aircall refuses the rest.
//
//[STABILITY] A 429 RETURNS WHAT IT HAS rather than throwing it away, once aircallFetch has exhausted its
//retries. Discarding it is what wedged the Instantly sync for five days: the throw came from the fetch,
//before the loop, so the run abandoned before saving its cursor and every later run repeated it exactly.
//Any other failure still throws - a 500 says nothing about how much of the window exists, and treating the
//part already read as the whole of it would step over the rest for good.
//USES: aircallFetch, parseAircallCall (this module).
//---------------------------------------------------------------------------------------------------------
export async function fetchAircallCallWindow(fromMs: number, toMs: number): Promise<AircallCallWindow> {
  const calls: AircallCall[] = [];
  //Aircall takes whole seconds. Floor both bounds so the window can only widen, never clip an edge call.
  const first = new URL(`${AIRCALL_BASE}/calls`);
  first.searchParams.set("from", String(Math.floor(fromMs / 1_000)));
  first.searchParams.set("to", String(Math.floor(toMs / 1_000)));
  first.searchParams.set("per_page", "50");
  let nextUrl: string | null = first.toString();
  let pagesRead = 0;
  let stoppedBy: "throttled" | null = null;

  //[PERF] Page cost scales with the width of the window, so widening fromMs is not free - see the cron constant.
  while (nextUrl) {
    let body: unknown;
    try {
      body = await aircallFetch(nextUrl);
    } catch (error) {
      if (error instanceof AircallRateLimitError) {
        console.warn(
          `[aircall] throttled after ${pagesRead} page(s) and ${calls.length} call(s) - ${error.message}. What was read is kept and returned; the rest of the window is left for the next run.`,
        );
        stoppedBy = "throttled";
        break;
      }
      throw error;
    }
    pagesRead += 1;
    if (!isJsonObject(body)) throw new Error("Aircall calls response is invalid");
    calls.push(...arrayValue(body, "calls").map(parseAircallCall));
    //Aircall hands back an absolute URL for the next page; null ends the walk.
    const meta = objectValue(body, "meta");
    nextUrl = stringValue(meta?.next_page_link);
  }
  //A call still ringing or in progress has no completion time, so it cannot be placed on the cursor timeline.
  //It is simply omitted; a later run reads it once Aircall marks it done.
  return {
    calls: calls.filter((call) => call.status === "done" && call.endedAt !== null),
    stoppedBy,
    pagesRead,
  };
}

/** [LOGIC] The whole window or nothing, for callers with no cursor to resume from. USES: fetchAircallCallWindow. */
export async function fetchAircallCalls(fromMs: number, toMs: number): Promise<readonly AircallCall[]> {
  const { calls, stoppedBy } = await fetchAircallCallWindow(fromMs, toMs);
  if (stoppedBy === "throttled") {
    throw new AircallRateLimitError(`only ${calls.length} call(s) of this window could be read`);
  }
  return calls;
}

//Reads one call by its id. Throws if Aircall refuses or returns something unreadable.
export async function fetchAircallCall(callId: number): Promise<AircallCall> {
  const body = await aircallFetch(`${AIRCALL_BASE}/calls/${callId}`); //GET /v1/calls/{id}
  if (!isJsonObject(body)) throw new Error("Aircall call response is invalid"); //not an object
  return parseAircallCall(body.call); //the call sits under "call"
}

//Reads the one contact a campaign holds for a phone number. Null when the campaign has none.
export async function fetchCampaignContact(campaignId: string, phone: string): Promise<AircallCampaignContact | null> {
  const url = new URL(`${AIRCALL_BASE}/campaigns/${campaignId}/contacts`); //GET /v1/campaigns/{id}/contacts
  url.searchParams.set("phone_number", phone); //filter to this number; "+" is encoded for us
  const body = await aircallFetch(url.toString()); //throws on any non-2xx
  if (!isJsonObject(body)) throw new Error("Aircall campaign contacts response is invalid"); //not an object
  return parseCampaignContact(arrayValue(body, "contacts")[0]); //at most one; missing becomes null
}

//---------------------------------------------------------------------------------------------------------
//A call's length for a note. Whole minutes are the wrong unit for this data: `duration` counts ring time as
//well as talk time, and on a dialled campaign a median call runs about 18 seconds, so rounding to minutes
//printed "0 min" on roughly seven of every eight calls and lost the only length information the note carried.
//Seconds are always shown, and minutes only once there are any.
//USES: nothing. Pure.
//---------------------------------------------------------------------------------------------------------
export function formatCallDuration(seconds: number): string {
  //Aircall has been seen to omit duration, and parseAircallCall floors that to 0; a negative value is nonsense
  //from the same direction. Either way there is no length to report, so say so rather than printing "0s".
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  if (minutes === 0) return `${remainder}s`;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
