//=============================================================================================================
//#region <import statements>

import { credentialHint, INSTANTLY_BASE, instantlyAuthHeader } from "./endpoints.js"; //instantly url and login helpers
import { //safe readers for unknown json
  arrayValue,
  errorMessage,
  isJsonObject,
  objectValue,
  responseJson,
  stringValue,
  type JsonObject,
} from "./json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//Which way an email went, in words instead of Instantly's number codes.
export type InstantlyEmailType = "received" | "sent" | "scheduled" | "unknown";

//One email, as this codebase uses it.
export interface InstantlyEmail {
  readonly id: string; //instantly's email id
  readonly timestampCreated: string; //when instantly recorded it, ISO text
  readonly timestampEmail: string; //when it was sent or received
  readonly emailType: InstantlyEmailType; //sent, received, scheduled or unknown
  readonly leadEmail: string | null; //the lead's address
  readonly isAutoReply: boolean; //true for an out-of-office style reply
  readonly subject: string | null; //subject line
  readonly bodyText: string | null; //body as plain text
  readonly threadId: string | null; //which thread it belongs to
}

//What to search emails by: a time window, a lead, or both.
export interface InstantlyEmailQuery {
  readonly fromMs?: number; //window start, epoch milliseconds
  readonly toMs?: number; //window end, epoch milliseconds
  readonly leadEmail?: string; //only this lead's emails
}

//Why pagination stopped short of the end of the window, if it did. null means it was read to the end.
export type InstantlyPageStop = "throttled" | "page-limit";

//What one window read returns: the emails, and whether it was cut short.
export interface InstantlyEmailWindow {
  readonly emails: readonly InstantlyEmail[]; //emails read
  readonly stoppedBy: InstantlyPageStop | null; //why reading stopped early, if it did
  readonly pagesRead: number; //how many pages were read
}

//One Instantly lead record, flattened to the fields Attio is enriched with.
export interface InstantlyLead {
  readonly email: string; //the lead's address
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly jobTitle: string | null; //lead's job title
  readonly phone: string | null; //lead's phone number
  readonly companyName: string | null; //lead's company
  readonly companyDomain: string | null; //company's web domain
  readonly website: string | null; //company website
  readonly linkedin: string | null; //linkedin profile url
  readonly location: string | null; //where the lead is
  readonly companyAddress: string | null; //company's street address
  readonly industry: string | null; //company's industry
  readonly employeeCount: string | null; //company headcount, as typed
  readonly annualRevenue: string | null; //company revenue, as typed
}

//---------------------------------------------------------------------------------------------------------
//Raised on a 429, so a caller can tell "slow down" apart from "this request was wrong". Mirrors
//OutfoundRateLimitError (lib/outfound.ts) - see fetchInstantlyEmailWindow for why the distinction matters
//more here than the shared shape suggests.
//
//WHAT THIS COST BEFORE IT EXISTED. Instantly allows 20 requests per minute and fetchInstantlyEmails pages a
//hundred emails at a time with no pause between pages, so a backlog reaches the ceiling in seconds. A 429 was
//an ordinary Error, which abandoned the whole run - and the sync saves its cursor AFTER the loop, so the mark
//never moved. The next run re-read the same window from the same mark, hit the same ceiling at the same page,
//and discarded the same work. Production sat in that loop for five days: the Instantly cursor stuck at
//2026-09-17T14:12:55Z while every run for five days logged "ABANDONED ... cursor NOT saved".
//---------------------------------------------------------------------------------------------------------
export class InstantlyRateLimitError extends Error {
  constructor(detail: string) { //detail says what was refused
    super(`Instantly rate limit reached: ${detail}`); //the error message
    this.name = "InstantlyRateLimitError"; //name shown in logs
  }
}

//Tags whose close ends a line of prose. Everything else (<span>, <a>, <b>) is inline and leaves no break.
const BLOCK_CLOSE = /<\/(?:p|div|tr|li|h[1-6]|table|blockquote|ul|ol|section|article|header|footer|pre)\s*>/gi; //closing block tags
const LINE_BREAK = /<(?:br|hr)\b[^>]*>/gi; //<br> and <hr> tags
//A <head>, <style> or <script> holds machine text, never prose, so each is dropped whole rather than stripped
//to its contents - Outlook's charset <meta> alone would otherwise leave a stray line at the top of the note.
const NON_PROSE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi; //whole script, style and head elements

//Named html entities and the characters they stand for.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", //&amp;
  apos: "'", //&apos;
  gt: ">", //&gt;
  lt: "<", //&lt;
  nbsp: " ", //&nbsp; becomes a plain space
  quot: '"', //&quot;
};

//---------------------------------------------------------------------------------------------------------
//Pages the sync stops itself at, short of the 20-per-minute ceiling.
//
//WHY A CAP AND NOT JUST THE 429. Bursting until Instantly refuses would make a rejected request part of normal
//operation on every run with a backlog, which is both rude to the API and indistinguishable in the log from
//the real problem. Fifteen pages is 1,500 emails, and leaves five requests of headroom for the interested
//route - which shares this key's allowance and fires on a lead's schedule, not ours.
//
//[PERF] The cap is not the binding constraint on throughput and is not meant to be. One touchpoint is several
//Attio writes, so INSTANTLY_SYNC_BUDGET_MS runs out long before 1,500 emails are processed; the run stops on
//budget, parks its cursor, and the next run picks up from there. The cap only bounds what is FETCHED, so a
//deep backlog cannot spend the whole run on pages it will never reach.
//---------------------------------------------------------------------------------------------------------
export const INSTANTLY_SYNC_PAGE_LIMIT = 15; //most pages one sync run reads

//Email providers shared by strangers. Blocking one of these as a domain would block every lead who uses it, so
//an address here is blocked on its own instead. Extend it when a new free provider turns up in the lead data.
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([ //domains never blocked whole
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com",
]);

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <parse instantly responses>

//#region <emails>
//---------------------------------------------------------------------------------------------------------
//Base function. Turns Instantly's number code for an email's direction into words.
//Input: value - the email's "ue_type" field, unknown shape.
//Output: "sent", "received", "scheduled", or "unknown".
//Workflow: parseInstantlyEmail - fills emailType.
//---------------------------------------------------------------------------------------------------------
function parseEmailType(value: unknown): InstantlyEmailType {
  if (value === 1 || value === 3) return "sent"; //we sent it
  if (value === 2) return "received"; //the lead sent it
  if (value === 4) return "scheduled"; //not sent yet
  return "unknown"; //any other code
}

//---------------------------------------------------------------------------------------------------------
//Reads one raw email from the Instantly API into an InstantlyEmail.
//Input: value - one email object from Instantly, unknown shape.
//Output: the email. Throws if it has no id, no timestamp, or an unreadable timestamp.
//Uses: parseEmailType, htmlToPlainText (this file).
//Workflow: fetchInstantlyEmailWindow - every email read goes through here.
//---------------------------------------------------------------------------------------------------------
export function parseInstantlyEmail(value: unknown): InstantlyEmail {
  if (!isJsonObject(value)) throw new Error("Instantly returned an invalid email"); //not an email at all
  const id = stringValue(value.id); //the email's id
  const timestampCreated = stringValue(value.timestamp_created); //when instantly recorded it
  const timestampEmail = stringValue(value.timestamp_email) ?? timestampCreated; //send time, else record time
  const leadEmail = stringValue(value.lead); //the lead's address
  if (!id || !timestampCreated || !timestampEmail) { //id or time missing
    throw new Error("Instantly email is missing id or timestamp"); //unusable email
  }
  if (!Number.isFinite(Date.parse(timestampCreated)) || !Number.isFinite(Date.parse(timestampEmail))) { //not real dates
    throw new Error("Instantly email has an invalid timestamp"); //unusable email
  }
  const body = objectValue(value, "body"); //the body object, or null
  return {
    id, //same as id: id
    timestampCreated, //same as timestampCreated: timestampCreated
    timestampEmail, //same as timestampEmail: timestampEmail
    emailType: parseEmailType(value.ue_type), //number code to words
    leadEmail, //same as leadEmail: leadEmail
    isAutoReply: value.is_auto_reply === 1, //1 means auto-reply
    subject: stringValue(value.subject), //null when blank
    //Falls back to the HTML body, which is all Instantly sends for its own outbound mail. See htmlToPlainText.
    bodyText: stringValue(body?.text) ?? htmlToPlainText(stringValue(body?.html)), //plain text, else text from html
    threadId: stringValue(value.thread_id), //null when blank
  };
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <convert email html to text>

//Email bodies, as prose.
//
//[LOGIC] Instantly sends no plain-text body for the mail it sends itself. A campaign email arrives as
//`body: { html }` with no `text` key at all, and only an inbound reply - carrying whatever the sender's own
//client produced - has both. Reading `text` alone therefore left every outbound touchpoint note reading
//"(no content)", which is most of them. The markup is unwrapped here instead.

//#region <html bodies>
//---------------------------------------------------------------------------------------------------------
//Base function. Turns html entities like "&amp;" and "&#39;" back into the characters they stand for.
//Input: html - text that may contain entities.
//Output: the text with known entities decoded.
//Workflow: htmlToPlainText - decodes entities after the tags are stripped.
//
//Covers the named and numeric entities an email body actually uses. Anything unrecognised is left exactly as it
//was.
//---------------------------------------------------------------------------------------------------------
function decodeEntities(html: string): string {
  return html.replace( //replace every entity found
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (match: string, decimal?: string, hex?: string, name?: string): string => {
      if (decimal !== undefined || hex !== undefined) { //a numeric entity
        const code = Number.parseInt(decimal ?? hex ?? "", decimal !== undefined ? 10 : 16); //its character number
        //[STABILITY] Guarded because String.fromCodePoint throws outside the Unicode range, and a malformed
        //entity in a stranger's email must not fail the whole touchpoint.
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match; //valid: the character; else unchanged
      }
      return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? match; //known name: the character; else unchanged
    },
  );
}

//---------------------------------------------------------------------------------------------------------
//Pulls the readable prose out of an HTML email body.
//Input: html - the email's html body, or null.
//Output: the text, line breaks kept, or null when there is no prose.
//Uses: decodeEntities (this file).
//Workflow: parseInstantlyEmail - the body text of an email Instantly sent with html only.
//
//[LOGIC] Entities are decoded AFTER the tags are stripped, so a "&lt;div&gt;" written in the text is never
//mistaken for a tag. Runs of blank lines are collapsed, since markup nests and one paragraph break is commonly
//spelled by three or four tags closing together.
//---------------------------------------------------------------------------------------------------------
export function htmlToPlainText(html: string | null): string | null {
  if (!html) return null; //no html, no text
  const text = decodeEntities( //strip tags, decode, then tidy lines
    html
      .replace(NON_PROSE, " ")
      .replace(LINE_BREAK, "\n")
      .replace(BLOCK_CLOSE, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    //A non-breaking space reads as a space; left as it is, it reaches Attio as a stray glyph.
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null; //empty result means no prose
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <instantly transport>

//#region <requests>
//---------------------------------------------------------------------------------------------------------
//Sends one request to Instantly. The only place this file calls fetch.
//Input: path - the endpoint after INSTANTLY_BASE, query included; options - fetch options (method, body).
//Output: the parsed JSON body. Throws InstantlyRateLimitError on a 429, Error on any other failure.
//Uses: instantlyAuthHeader, credentialHint (lib/endpoints.ts); responseJson (lib/json.ts).
//Workflow: every Instantly request - fetchInstantlyEmailWindow, fetchInstantlyLead, blockInstantlyLead.
//
//[SECURITY] The key is read from env per request by instantlyAuthHeader and never cached in module state.
//[DEBUG] credentialHint names INSTANTLY_API_KEY on a 401/403.
//[STABILITY] A 429 is NOT retried in here, unlike attioFetch. Attio's limit is per second and a short backoff
//clears it; Instantly's is 20 per MINUTE, so waiting it out would spend most of a run's budget sleeping. The
//caller stops and resumes next run instead, which costs nothing and drains the same backlog faster.
//---------------------------------------------------------------------------------------------------------
async function instantlyFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${INSTANTLY_BASE}${path}`, { //send the request
    ...options, //the caller's method and body
    headers: { //request headers
      Authorization: instantlyAuthHeader(), //the api key
      "Content-Type": "application/json", //body is json
      ...options.headers, //caller's headers win
    },
  });
  const body = await responseJson(response); //read the body as json
  if (response.status === 429) { //instantly says slow down
    const retryAfter = response.headers.get("retry-after"); //seconds to wait, if given
    throw new InstantlyRateLimitError( //fail distinctly, no retry
      `${path.split("?")[0]}${retryAfter ? `, retry after ${retryAfter}s` : ""}. The documented allowance is 20 requests per minute across the whole key, which the touchpoint sync's pagination and the interested route's lookups share.`,
    );
  }
  if (!response.ok) { //any other failure
    throw new Error( //stop with the details
      `Instantly API error ${response.status}: ${JSON.stringify(body)}${credentialHint("instantly", response.status)}`,
    );
  }
  return body; //success, hand it back
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read emails>

//#region <email windows>
//---------------------------------------------------------------------------------------------------------
//Reads emails page by page, up to `maxPages`, keeping what it read if Instantly refuses.
//Input: query - a time window (fromMs, toMs), a leadEmail, or both; maxPages - page cap, no cap by default.
//Output: { emails, stoppedBy, pagesRead }. stoppedBy is "throttled" or "page-limit" if reading stopped early.
//Throws on any other failure.
//Uses: instantlyFetch, parseInstantlyEmail (this file).
//Workflow: instantly touchpoint sync step 3 - the emails the run will process. Also fetchInstantlyEmails, for
//the interested route.
//
//Filters are on timestamp_created, which is also what the cron keys its cursor on, so window and cursor agree.
//
//[STABILITY] A 429 RETURNS WHAT IT HAS rather than throwing it away. The pages already read are real emails
//the caller can process, and discarding them is what wedged this sync - see InstantlyRateLimitError. The
//caller is told the window is incomplete so it knows not to park its cursor at the end of it.
//Any other failure still throws: a malformed page or a 500 says nothing about how much of the window exists,
//and guessing that the part already read is the whole of it would skip the rest for good.
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyEmailWindow(
  query: InstantlyEmailQuery,
  maxPages: number = Number.POSITIVE_INFINITY,
): Promise<InstantlyEmailWindow> {
  const emails: InstantlyEmail[] = []; //every email read so far
  let startingAfter: string | null = null; //next page's cursor; null for the first
  let pagesRead = 0; //pages read so far

  do { //read pages until no cursor is left
    if (pagesRead >= maxPages) return { emails, stoppedBy: "page-limit", pagesRead }; //hit the page cap
    //Ascending, so the caller's cursor advances monotonically as it walks the result.
    const params = new URLSearchParams({ limit: "100", sort_order: "asc" }); //100 per page, oldest first
    //Minus one millisecond: the bound is treated as exclusive, and an email sitting exactly on the cursor
    //timestamp must still be returned. The caller's isAfterCursor check discards it if it was already handled.
    if (query.fromMs !== undefined) { //window start given
      params.set("min_timestamp_created", new Date(Math.max(0, query.fromMs - 1)).toISOString()); //window start, minus 1ms
    }
    if (query.toMs !== undefined) { //window end given
      params.set("max_timestamp_created", new Date(query.toMs).toISOString()); //window end
    }
    if (query.leadEmail) params.set("lead", query.leadEmail); //only this lead's emails
    if (startingAfter) params.set("starting_after", startingAfter); //continue after the last page

    let body: unknown; //this page's response
    try {
      body = await instantlyFetch(`/emails?${params}`); //read the page
    } catch (error) {
      if (error instanceof InstantlyRateLimitError) { //refused by the rate limit
        console.warn( //log what was kept
          `[instantly] throttled after ${pagesRead} page(s) and ${emails.length} email(s) - ${error.message}. What was read is kept and returned; the rest of the window is left for the next run.`,
        );
        return { emails, stoppedBy: "throttled", pagesRead }; //return the partial read
      }
      throw error; //any other error: fail the read
    }
    pagesRead += 1; //one more page done
    if (!isJsonObject(body)) throw new Error("Instantly emails response is invalid"); //unexpected shape
    emails.push(...arrayValue(body, "items").map(parseInstantlyEmail)); //add this page's emails
    startingAfter = stringValue(body.next_starting_after); //next page's cursor, or null when done
  } while (startingAfter); //stop when there is no next page

  return { emails, stoppedBy: null, pagesRead }; //the whole window was read
}

//---------------------------------------------------------------------------------------------------------
//Reads a query's emails whole or fails: no partial results.
//Input: query - a time window, a leadEmail, or both.
//Output: every matching email. Throws InstantlyRateLimitError if Instantly refused partway.
//Uses: fetchInstantlyEmailWindow (this file).
//Workflow: instantly-interested route step 5 - the lead's thread for recordInterestedLead's note.
//
//For the interested route, whose note is one lead's thread: half a thread rendered as though it were the
//whole is a misleading note, and unlike the cron there is no cursor to resume from - the note is written once.
//So a throttled read raises here rather than returning a partial thread. The route's own handling decides
//what a missing history is worth; see api/instantly-interested.ts.
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyEmails(
  query: InstantlyEmailQuery,
): Promise<readonly InstantlyEmail[]> {
  const { emails, stoppedBy } = await fetchInstantlyEmailWindow(query); //read every page
  if (stoppedBy === "throttled") { //only part of it came back
    throw new InstantlyRateLimitError( //fail rather than return part
      `only ${emails.length} email(s) of this thread could be read, and a partial thread is not written as though it were the whole`,
    );
  }
  return emails; //the whole thread
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read and block leads>

//The lead record, and the blocklist.
//
//The lead_interested webhook body is thin - an event type, an address, and sometimes a name. Everything worth
//enriching Attio with (job title, LinkedIn URL, phone, industry, headcount, revenue, location, company address)
//lives on the lead record instead, under the custom-variable payload, so the interested route reads it back.

//#region <parse lead records>
//---------------------------------------------------------------------------------------------------------
//Base function. Reduces a payload key to lowercase letters and digits, e.g. "# Employees" -> "employees".
//Input: key - a payload key, or a name to look for.
//Output: the reduced key.
//Workflow: payloadValue - compares wanted names to payload keys.
//
//The payload is a workspace's own custom variables, so its keys are whatever whoever built the campaign typed:
//"# Employees", "Annual Revenue", "Company Address", "linkedIn". Keys are therefore compared on their letters
//and digits alone, which makes "# Employees" and "employees" one name and survives a variable being renamed to
//a different casing or punctuation.
//---------------------------------------------------------------------------------------------------------
function normalizePayloadKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, ""); //lowercase, drop everything but letters and digits
}

//---------------------------------------------------------------------------------------------------------
//Finds the first payload value whose key matches any of `names`, compared on letters and digits alone.
//Input: payload - the lead's custom-variable payload, or null; names - the key spellings to accept.
//Output: the value as text, or null if none matches.
//Uses: normalizePayloadKey (this file).
//Workflow: parseInstantlyLead - fills each field from the payload.
//---------------------------------------------------------------------------------------------------------
function payloadValue(payload: JsonObject | null, names: readonly string[]): string | null {
  if (!payload) return null; //no payload, nothing to find
  const wanted = new Set(names.map(normalizePayloadKey)); //the names, reduced
  for (const [key, value] of Object.entries(payload)) { //each key and value in the payload
    if (!wanted.has(normalizePayloadKey(key))) continue; //not a wanted key, skip
    const text = stringValue(value); //the value as text
    if (text) return text; //found a real value
  }
  return null; //no match
}

//---------------------------------------------------------------------------------------------------------
//Reads one raw lead record into a flat InstantlyLead.
//Input: value - one lead object from Instantly, unknown shape.
//Output: the lead. Throws if it is not an object or has no email.
//Uses: payloadValue (this file).
//Workflow: fetchInstantlyLead - turns the matched lead.
//
//Top-level fields win over the payload's copies of them: Instantly promotes the standard variables up top and
//keeps the raw uploaded value below, and the promoted one is the one it acts on.
//---------------------------------------------------------------------------------------------------------
export function parseInstantlyLead(value: unknown): InstantlyLead {
  if (!isJsonObject(value)) throw new Error("Instantly returned an invalid lead"); //not a lead at all
  const email = stringValue(value.email); //the lead's address
  if (!email) throw new Error("Instantly lead is missing an email address"); //no address, unusable
  const payload = objectValue(value, "payload"); //custom variables, or null
  return {
    email, //same as email: email
    firstName: stringValue(value.first_name) ?? payloadValue(payload, ["firstName"]), //top level, else payload
    lastName: stringValue(value.last_name) ?? payloadValue(payload, ["lastName"]), //top level, else payload
    jobTitle: stringValue(value.job_title) ?? payloadValue(payload, ["jobTitle", "title"]), //top level, else payload
    phone: stringValue(value.phone) ?? payloadValue(payload, ["phone"]), //top level, else payload
    companyName: stringValue(value.company_name) ?? payloadValue(payload, ["companyName"]), //top level, else payload
    companyDomain: stringValue(value.company_domain), //top level only
    website: stringValue(value.website) ?? payloadValue(payload, ["website"]), //top level, else payload
    linkedin: payloadValue(payload, ["linkedIn", "linkedInUrl", "linkedinProfile"]), //payload only
    location: payloadValue(payload, ["location", "city"]), //payload only
    companyAddress: payloadValue(payload, ["companyAddress", "address"]), //payload only
    industry: payloadValue(payload, ["industry"]), //payload only
    employeeCount: payloadValue(payload, ["# Employees", "employees", "employeeCount", "companySize"]), //payload only
    annualRevenue: payloadValue(payload, ["Annual Revenue", "revenue", "annualRevenue"]), //payload only
  };
}
//#endregion

//#region <look up a lead>
//---------------------------------------------------------------------------------------------------------
//Finds the lead record behind an address.
//Input: email - the lead's address.
//Output: the lead, or null when Instantly holds no exact match. Throws if the request fails.
//Uses: instantlyFetch, parseInstantlyLead, describeInstantlyLead (this file).
//Workflow: instantly-interested route step 4 (enrichFromInstantly) - the fields the webhook does not carry.
//
//Only an EXACT case-insensitive match on `email` is kept: `search` is fuzzy and will happily return a different
//lead at the same company, whose job title and LinkedIn URL would then be written onto the wrong Attio person.
//A near miss is treated as no match.
//[STABILITY] Enrichment only. Every caller treats null as "nothing extra to add", never as a failure, so a
//lead Instantly cannot find still gets recorded from the webhook body alone.
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyLead(email: string): Promise<InstantlyLead | null> {
  const body = await instantlyFetch("/leads/list", { //search leads for the address
    method: "POST", //this search is a POST
    body: JSON.stringify({ search: email, limit: 10 }), //search text, up to 10 results
  });
  if (!isJsonObject(body)) throw new Error("Instantly leads response is invalid"); //unexpected shape
  const wanted = email.toLowerCase(); //compare without case
  for (const item of arrayValue(body, "items")) { //each search result
    if (!isJsonObject(item)) continue; //not a lead, skip
    if (stringValue(item.email)?.toLowerCase() !== wanted) continue; //not the exact address, skip
    const lead = parseInstantlyLead(item); //read the matched lead
    console.log(`[lookup] instantly lead ${email}: matched, ${describeInstantlyLead(lead)}`); //log which fields came back
    return lead; //the match
  }
  console.log(`[lookup] instantly lead ${email}: no exact match, so nothing is enriched from Instantly`); //log the miss
  return null; //no exact match
}

//---------------------------------------------------------------------------------------------------------
//Base function. Lists which enrichment fields a lead arrived with, for the log.
//Input: lead - the matched lead.
//Output: text like "carrying jobTitle, phone".
//Workflow: fetchInstantlyLead - the match log line.
//
//[DEBUG] Field names only - never their values, which are personal data.
//---------------------------------------------------------------------------------------------------------
function describeInstantlyLead(lead: InstantlyLead): string {
  const present = Object.entries(lead) //names of the filled fields
    .filter(([key, value]) => key !== "email" && value !== null)
    .map(([key]) => key);
  return present.length > 0 ? `carrying ${present.join(", ")}` : "carrying nothing beyond the address"; //the summary text
}
//#endregion

//#region <blocklist>
//---------------------------------------------------------------------------------------------------------
//Adds an address or a whole domain to the workspace blocklist, so no campaign can mail it again.
//Input: value - the address ("ada@acme.com") or the domain ("acme.com") to block.
//Output: nothing. Throws if Instantly refuses.
//Uses: instantlyFetch (this file); errorMessage (lib/json.ts).
//Workflow: interested workflow (recordInterestedLead) step 6 - the "instantly blocklist" channel
//(lib/providers.ts) of suppressInterestedLead (lib/interested.ts).
//
//Runs for every interested lead whatever platform reported the interest. A lead who said yes on the phone must
//stop receiving cold email. Instantly's bl_value takes "the email or domain to block"; a domain entry is stored
//with is_domain true and blocks every address at it.
//[STABILITY] The caller does not check whether the address is already blocked, and whether Instantly treats a
//re-block as success or as an error is NOT verified. It does not need to be: suppression collects failures
//rather than raising them, so the worst case is one logged failure on an address that was already suppressed.
//---------------------------------------------------------------------------------------------------------
export async function blockInstantlyLead(value: string): Promise<void> {
  try {
    await instantlyFetch("/block-lists-entries", { //add a blocklist entry
      method: "POST", //create the entry
      body: JSON.stringify({ bl_value: value }), //the address or domain to block
    });
    console.log(`[action] instantly blocklist: added ${value}`); //log the success
  } catch (error) {
    console.error(`[action] FAILED - instantly blocklist could not add ${value}: ${errorMessage(error)}`); //log the failure
    throw error; //let the caller record it
  }
}

//---------------------------------------------------------------------------------------------------------
//Gets the domain from an email address.
//Input: email - an address such as "Ada@Acme.com".
//Output: the domain in lowercase ("acme.com"), or null if the address has no "@" or nothing after it.
//Workflow: the "instantly blocklist" channel (lib/providers.ts), to block the lead's whole company.
//---------------------------------------------------------------------------------------------------------
export function emailDomain(email: string): string | null {
  const atIndex = email.lastIndexOf("@"); //position of the last @
  if (atIndex === -1) return null; //no @, not an address
  const domain = email.slice(atIndex + 1).trim().toLowerCase(); //everything after the @
  if (domain === "") return null; //nothing after the @
  return domain; //the domain
}
//#endregion

//#endregion
//=============================================================================================================
