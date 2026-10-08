//=============================================================================================================
//#region <import statements>

import { AIRCALL_BASE, aircallAuthHeader, credentialHint } from "./endpoints.js"; //aircall url and login helpers
import { rateLimitWaitMs } from "./http.js"; //how long to wait after a 429
//Aircall spells a number for display ("+1 949-735-4000"); Attio matches E.164. One shared normaliser, because
//a lookup keyed on the wrong spelling misses and creates a duplicate Person - see lib/phone.ts.
import { toE164 } from "./phone.js"; //phone number to "+15551234567" form
import { //safe readers for unknown json
  arrayValue,
  isJsonObject,
  numberValue,
  objectValue,
  responseJson,
  stringValue,
} from "./json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//One tag on a call, e.g. "Outbound Campaign".
export interface AircallTag {
  readonly name: string; //the tag's text
}

//The address-book contact attached to a call, when there is one.
export interface AircallContact {
  readonly firstName: string | null; //contact's first name
  readonly lastName: string | null; //contact's last name
  readonly companyName: string | null; //contact's company
  readonly email: string | null; //first email found on the contact
  //Every number on the address-book entry, E.164. The dialled raw_digits is only one of them, and the others
  //are as much this person's numbers as that one is.
  readonly phoneNumbers: readonly string[]; //all the contact's numbers, E.164
  //Aircall's free-text notes field on a contact. Whatever an agent wrote there about who this person is.
  readonly information: string | null; //agent's free-text notes
}

//One call, as this codebase uses it. Times are epoch SECONDS.
export interface AircallCall {
  readonly id: number; //aircall's call id
  readonly status: string; //"done" once the call has finished
  readonly direction: string | null; //"inbound" or "outbound"
  readonly rawDigits: string | null; //the other party's number, display format
  readonly startedAt: number; //when the call started
  readonly endedAt: number | null; //when it ended; null while in progress
  readonly duration: number; //length in seconds, ring time included
  readonly tags: readonly AircallTag[]; //tags applied to the call
  readonly contact: AircallContact | null; //address-book contact, usually none
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

//What one window read returns: the calls, and whether it was cut short.
export interface AircallCallWindow {
  readonly calls: readonly AircallCall[]; //finished calls in the window
  /** Set when pagination stopped short of the end of the window; null means it was read to the end. */
  readonly stoppedBy: "throttled" | null; //why reading stopped early, if it did
  readonly pagesRead: number; //how many pages were read
}

//Thrown when Aircall keeps answering 429, so callers can tell it from other errors.
export class AircallRateLimitError extends Error {
  constructor(detail: string) { //detail says what was refused
    super(`Aircall rate limit reached: ${detail}`); //the error message
    this.name = "AircallRateLimitError"; //name shown in logs
  }
}

const RATE_LIMIT_ATTEMPTS = 3; //tries before giving up on a 429
//Matches attioFetch's RETRY_BASE_MS, so the one backoff shape in this codebase stays one shape.
const RATE_LIMIT_BASE_MS = 500; //first wait after a 429
//[PERF] A run that spends its budget asleep has done nothing. Past this, stopping and resuming next run beats
//waiting - the next run starts with a fresh allowance either way. See rateLimitWaitMs (lib/http.ts).
const RATE_LIMIT_MAX_WAIT_MS = 5_000; //longest single wait allowed

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <parse aircall responses>

//#region <calls>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads one raw tag into an AircallTag.
//Input: value - one entry of a call's "tags" array, unknown shape.
//Output: { name }, or null if it has no name.
//Workflow: parseAircallCall - turns each tag on a call.
//---------------------------------------------------------------------------------------------------------
function parseTag(value: unknown): AircallTag | null {
  if (!isJsonObject(value)) return null; //not an object, not a tag
  const name = stringValue(value.name); //the tag's text, or null
  return name ? { name } : null; //no name means no tag
}

//---------------------------------------------------------------------------------------------------------
//Reads a call's raw address-book contact into an AircallContact.
//Input: value - the call's "contact" field, unknown shape.
//Output: the contact, or null if there is none.
//Uses: contactEmail, contactPhoneNumbers (this file).
//Workflow: parseAircallCall - fills the call's contact.
//---------------------------------------------------------------------------------------------------------
function parseContact(value: unknown): AircallContact | null {
  if (!isJsonObject(value)) return null; //no contact on this call
  return {
    firstName: stringValue(value.first_name), //null when blank
    lastName: stringValue(value.last_name), //null when blank
    companyName: stringValue(value.company_name), //null when blank
    email: contactEmail(value), //first email in either spelling
    phoneNumbers: contactPhoneNumbers(value), //every number, E.164
    information: stringValue(value.information), //agent's notes
  };
}

//---------------------------------------------------------------------------------------------------------
//Reads one raw call from the Aircall API into an AircallCall.
//Input: value - one call object from Aircall, unknown shape.
//Output: the call. Throws if it has no id or started_at.
//Uses: parseTag, parseContact (this file).
//Workflow: fetchAircallCallWindow and fetchAircallCall - every call read goes through here.
//---------------------------------------------------------------------------------------------------------
export function parseAircallCall(value: unknown): AircallCall {
  if (!isJsonObject(value)) throw new Error("Aircall returned an invalid call"); //not a call at all
  const id = numberValue(value.id); //the call's id
  const startedAt = numberValue(value.started_at); //when it started
  //id and started_at are the two fields the cursor and the window depend on; absent either, the call is unusable.
  if (id === null || startedAt === null) { //either one missing
    throw new Error("Aircall call is missing id or started_at"); //unusable call
  }
  return {
    id, //same as id: id
    status: stringValue(value.status) ?? "unknown", //"done", "ringing", etc.
    direction: stringValue(value.direction), //inbound or outbound
    rawDigits: stringValue(value.raw_digits), //the other party's number
    startedAt, //same as startedAt: startedAt
    endedAt: numberValue(value.ended_at), //null while still in progress
    duration: numberValue(value.duration) ?? 0, //missing length becomes 0
    tags: arrayValue(value, "tags") //every tag on the call
      .map(parseTag)
      .filter((tag): tag is AircallTag => tag !== null),
    contact: parseContact(value.contact), //address-book contact, if any
  };
}
//#endregion

//#region <contact fields>
//---------------------------------------------------------------------------------------------------------
//Collects every phone number on a contact, normalised and without duplicates.
//Input: contact - a raw contact object.
//Output: list of E.164 numbers, possibly empty.
//Uses: toE164 (lib/phone.ts).
//Workflow: parseContact - fills phoneNumbers.
//Aircall lists numbers as objects; a stray string is accepted too.
//---------------------------------------------------------------------------------------------------------
function contactPhoneNumbers(contact: Record<string, unknown>): readonly string[] {
  const numbers: string[] = []; //collected numbers
  for (const candidate of arrayValue(contact, "phone_numbers")) { //each listed number
    const raw = typeof candidate === "string" ? candidate : isJsonObject(candidate) ? stringValue(candidate.value) : null; //string or {value}
    const e164 = toE164(raw); //normalise, null if not a number
    if (e164 && !numbers.includes(e164)) numbers.push(e164); //keep new valid numbers only
  }
  return numbers; //all distinct numbers
}

//---------------------------------------------------------------------------------------------------------
//Base function. Finds the contact's email address, whichever way Aircall spelled it.
//Input: contact - a raw contact object.
//Output: the first email found, or null.
//Workflow: parseContact - fills email.
//---------------------------------------------------------------------------------------------------------
function contactEmail(contact: Record<string, unknown>): string | null {
  //Aircall spells a contact address two ways: a scalar `email`, or an `emails` list of strings or of objects.
  const direct = stringValue(contact.email); //the single "email" field
  if (direct) return direct; //found it, done
  for (const candidate of arrayValue(contact, "emails")) { //each entry in "emails"
    if (typeof candidate === "string" && candidate) return candidate; //plain string entry
    if (isJsonObject(candidate)) { //object entry
      const value = stringValue(candidate.value) ?? stringValue(candidate.email); //either key name
      if (value) return value; //found it, done
    }
  }
  return null; //no email anywhere
}
//#endregion

//#region <campaign contacts>
//---------------------------------------------------------------------------------------------------------
//Reads one raw campaign contact into an AircallCampaignContact.
//Input: value - one entry of the "contacts" array, unknown shape.
//Output: the contact, or null when it is not an object.
//Uses: toE164 (lib/phone.ts).
//Workflow: fetchCampaignContact - turns the lookup's result.
//---------------------------------------------------------------------------------------------------------
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

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <aircall transport>

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

//#region <rate limiting>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads Aircall's own "try again at" header.
//Input: response - a 429 response from Aircall.
//Output: milliseconds to wait, or null if the header is missing or unbelievable.
//Workflow: aircallFetch - the wait hint passed to rateLimitWaitMs.
//
//[LOGIC] Documented only as "timestamp when the counter will be reset" with no unit, so both readings are
//accepted: a value that looks like epoch SECONDS is treated as one, and anything else is tried as a date. A
//reading that lands in the past or absurdly far ahead is discarded rather than trusted, and the caller falls
//back to its backoff.
//---------------------------------------------------------------------------------------------------------
function aircallResetMs(response: Response): number | null {
  const header = response.headers.get("x-aircallapi-reset"); //the reset time, as text
  if (!header) return null; //no hint given
  const numeric = Number(header); //try it as a number
  const epochMs = Number.isFinite(numeric) //number: seconds or milliseconds; else a date
    ? (numeric > 1e11 ? numeric : numeric * 1_000)
    : Date.parse(header);
  if (!Number.isFinite(epochMs)) return null; //unreadable, ignore it
  const waitMs = epochMs - Date.now(); //time left until the reset
  //A whole minute is the widest a per-minute window can legitimately be.
  return waitMs > 0 && waitMs <= 60_000 ? waitMs : null; //only trust 0-60 seconds
}
//#endregion

//#region <requests>
//---------------------------------------------------------------------------------------------------------
//Sends one GET to Aircall, retrying on 429. The only place this file calls fetch.
//Input: url - the full Aircall url to read.
//Output: the parsed JSON body. Throws AircallRateLimitError after 3 refusals, Error on any other failure.
//Uses: aircallAuthHeader, credentialHint (lib/endpoints.ts); rateLimitWaitMs (lib/http.ts); responseJson
//(lib/json.ts); aircallResetMs (this file).
//Workflow: every Aircall read - fetchAircallCallWindow, fetchAircallCall, fetchCampaignContact.
//
//[SECURITY] Basic credentials are rebuilt per request from env and never held in module state.
//[DEBUG] credentialHint names AIRCALL_API_ID / AIRCALL_API_TOKEN on a 401/403.
//---------------------------------------------------------------------------------------------------------
async function aircallFetch(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) { //loop until success or give up
    const response = await fetch(url, { headers: { Authorization: aircallAuthHeader() } }); //send the request
    const body = await responseJson(response); //read the body as json
    if (response.ok) return body; //success, hand it back

    if (response.status === 429) { //aircall says slow down
      if (attempt >= RATE_LIMIT_ATTEMPTS) { //out of tries
        throw new AircallRateLimitError( //give up, distinctly
          `refused after ${RATE_LIMIT_ATTEMPTS} attempt(s). The 120-per-minute allowance is per COMPANY, so every integration on this workspace spends it, not only this sync.`,
        );
      }
      const waitMs = rateLimitWaitMs( //decide how long to wait
        response,
        attempt,
        RATE_LIMIT_BASE_MS,
        RATE_LIMIT_MAX_WAIT_MS,
        aircallResetMs(response),
      );
      console.warn( //log the retry
        `[aircall] 429 (attempt ${attempt} of ${RATE_LIMIT_ATTEMPTS}) - waiting ${waitMs}ms and retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs)); //sleep for waitMs
      continue; //try again
    }
    throw new Error( //any other failure: stop
      `Aircall API error ${response.status}: ${JSON.stringify(body)}${credentialHint("aircall", response.status)}`,
    );
  }
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read calls and contacts>

//#region <call windows>
//---------------------------------------------------------------------------------------------------------
//Reads every finished call in a time window, page by page.
//Input: fromMs, toMs - the window, epoch milliseconds (Aircall filters on call START).
//Output: { calls, stoppedBy, pagesRead }. stoppedBy is "throttled" if Aircall refused partway.
//Uses: aircallFetch, parseAircallCall (this file).
//Workflow: aircall touchpoint sync step 4 - the calls the run will count.
//
//WINDOW SEMANTICS - the reason the caller over-reaches: Aircall documents from/to as filters on a call's
//CREATION date, and the Call object carries no created_at at all (only started_at, answered_at, ended_at), so
//the filter is effectively on call START. Callers key their cursor on ended_at, so fromMs must be pulled back
//by at least the longest call expected or a long call is filtered out here (not yet "done") on the run that
//covers its start and is out of range by the run that covers its end. See MAX_CALL_DURATION_MS in the cron.
//Sorting cannot substitute for this: `order` only walks created_at, and a call outside the filter is absent
//from the result set entirely, not merely out of order. No v1 endpoint filters or sorts on ended_at.
//
//[STABILITY] A 429 RETURNS WHAT IT HAS rather than throwing it away, once aircallFetch has exhausted its
//retries. Discarding it is what wedged the Instantly sync for five days: the throw came from the fetch,
//before the loop, so the run abandoned before saving its cursor and every later run repeated it exactly.
//Any other failure still throws - a 500 says nothing about how much of the window exists, and treating the
//part already read as the whole of it would step over the rest for good.
//---------------------------------------------------------------------------------------------------------
export async function fetchAircallCallWindow(fromMs: number, toMs: number): Promise<AircallCallWindow> {
  const calls: AircallCall[] = []; //every call read so far
  //Aircall takes whole seconds. Floor both bounds so the window can only widen, never clip an edge call.
  const first = new URL(`${AIRCALL_BASE}/calls`); //GET /v1/calls
  first.searchParams.set("from", String(Math.floor(fromMs / 1_000))); //window start, seconds
  first.searchParams.set("to", String(Math.floor(toMs / 1_000))); //window end, seconds
  first.searchParams.set("per_page", "50"); //largest page aircall allows
  let nextUrl: string | null = first.toString(); //page to read next
  let pagesRead = 0; //pages read so far
  let stoppedBy: "throttled" | null = null; //set if aircall refuses partway

  //[PERF] Page cost scales with the width of the window, so widening fromMs is not free - see the cron constant.
  while (nextUrl) { //until there are no more pages
    let body: unknown; //this page's response
    try {
      body = await aircallFetch(nextUrl); //read the page
    } catch (error) {
      if (error instanceof AircallRateLimitError) { //refused after retries
        console.warn( //log what was kept
          `[aircall] throttled after ${pagesRead} page(s) and ${calls.length} call(s) - ${error.message}. What was read is kept and returned; the rest of the window is left for the next run.`,
        );
        stoppedBy = "throttled"; //mark the read as partial
        break; //stop paging, keep what we have
      }
      throw error; //any other error: fail the read
    }
    pagesRead += 1; //one more page done
    if (!isJsonObject(body)) throw new Error("Aircall calls response is invalid"); //unexpected shape
    calls.push(...arrayValue(body, "calls").map(parseAircallCall)); //add this page's calls
    //Aircall hands back an absolute URL for the next page; null ends the walk.
    const meta = objectValue(body, "meta"); //paging info
    nextUrl = stringValue(meta?.next_page_link); //next page, or null when done
  }
  //A call still ringing or in progress has no completion time, so it cannot be placed on the cursor timeline.
  //It is simply omitted; a later run reads it once Aircall marks it done.
  return {
    calls: calls.filter((call) => call.status === "done" && call.endedAt !== null), //finished calls only
    stoppedBy, //same as stoppedBy: stoppedBy
    pagesRead, //same as pagesRead: pagesRead
  };
}
//#endregion

//#region <single records>
//---------------------------------------------------------------------------------------------------------
//Reads one call by its id.
//Input: callId - Aircall's call id (from the outcome webhook).
//Output: the call. Throws if Aircall refuses or returns something unreadable.
//Uses: aircallFetch, parseAircallCall (this file).
//Workflow: aircall-interested background job step 1 - who was dialled, and when.
//---------------------------------------------------------------------------------------------------------
export async function fetchAircallCall(callId: number): Promise<AircallCall> {
  const body = await aircallFetch(`${AIRCALL_BASE}/calls/${callId}`); //GET /v1/calls/{id}
  if (!isJsonObject(body)) throw new Error("Aircall call response is invalid"); //not an object
  return parseAircallCall(body.call); //the call sits under "call"
}

//---------------------------------------------------------------------------------------------------------
//Reads the one contact a campaign holds for a phone number.
//Input: campaignId - the campaign's UUID; phone - the dialled number, E.164.
//Output: the contact, or null when the campaign has none for that number.
//Uses: aircallFetch, parseCampaignContact (this file).
//Workflow: aircall-interested background job step 2 - the lead's name, email and company.
//---------------------------------------------------------------------------------------------------------
export async function fetchCampaignContact(campaignId: string, phone: string): Promise<AircallCampaignContact | null> {
  const url = new URL(`${AIRCALL_BASE}/campaigns/${campaignId}/contacts`); //GET /v1/campaigns/{id}/contacts
  url.searchParams.set("phone_number", phone); //filter to this number; "+" is encoded for us
  const body = await aircallFetch(url.toString()); //throws on any non-2xx
  if (!isJsonObject(body)) throw new Error("Aircall campaign contacts response is invalid"); //not an object
  return parseCampaignContact(arrayValue(body, "contacts")[0]); //at most one; missing becomes null
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <format for notes>

//#region <duration>
//---------------------------------------------------------------------------------------------------------
//Base function. Writes a call's length for a note, e.g. "1m 35s".
//Input: seconds - the call's duration.
//Output: "18s", "2m", "1m 35s", or "unknown" when there is no length.
//Workflow: the Aircall touchpoint note and the interested call summary.
//
//Whole minutes are the wrong unit for this data: `duration` counts ring time as well as talk time, and on a
//dialled campaign a median call runs about 18 seconds, so rounding to minutes printed "0 min" on roughly seven
//of every eight calls and lost the only length information the note carried. Seconds are always shown, and
//minutes only once there are any.
//---------------------------------------------------------------------------------------------------------
export function formatCallDuration(seconds: number): string {
  //Aircall has been seen to omit duration, and parseAircallCall floors that to 0; a negative value is nonsense
  //from the same direction. Either way there is no length to report, so say so rather than printing "0s".
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown"; //no real length
  const whole = Math.round(seconds); //round to whole seconds
  const minutes = Math.floor(whole / 60); //full minutes
  const remainder = whole % 60; //seconds left over
  if (minutes === 0) return `${remainder}s`; //under a minute: "18s"
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`; //"2m" or "1m 35s"
}
//#endregion

//#endregion
//=============================================================================================================
