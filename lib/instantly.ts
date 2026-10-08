//=============================================================================================================
//#region <import statements>

import { credentialHint, INSTANTLY_BASE, instantlyAuthHeader } from "./endpoints.js";
import {
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

export type InstantlyEmailType = "received" | "sent" | "scheduled" | "unknown";

export interface InstantlyEmail {
  readonly id: string;
  readonly timestampCreated: string;
  readonly timestampEmail: string;
  readonly emailType: InstantlyEmailType;
  readonly leadEmail: string | null;
  readonly isAutoReply: boolean;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly threadId: string | null;
}

export interface InstantlyEmailQuery {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly leadEmail?: string;
}

/** Why pagination stopped short of the end of the window, if it did. null means it was read to the end. */
export type InstantlyPageStop = "throttled" | "page-limit";

export interface InstantlyEmailWindow {
  readonly emails: readonly InstantlyEmail[];
  readonly stoppedBy: InstantlyPageStop | null;
  readonly pagesRead: number;
}

export interface InstantlyLead {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly jobTitle: string | null;
  readonly phone: string | null;
  readonly companyName: string | null;
  readonly companyDomain: string | null;
  readonly website: string | null;
  readonly linkedin: string | null;
  readonly location: string | null;
  readonly companyAddress: string | null;
  readonly industry: string | null;
  readonly employeeCount: string | null;
  readonly annualRevenue: string | null;
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
  constructor(detail: string) {
    super(`Instantly rate limit reached: ${detail}`);
    this.name = "InstantlyRateLimitError";
  }
}

//Tags whose close ends a line of prose. Everything else (<span>, <a>, <b>) is inline and leaves no break.
const BLOCK_CLOSE = /<\/(?:p|div|tr|li|h[1-6]|table|blockquote|ul|ol|section|article|header|footer|pre)\s*>/gi;
const LINE_BREAK = /<(?:br|hr)\b[^>]*>/gi;
//A <head>, <style> or <script> holds machine text, never prose, so each is dropped whole rather than stripped
//to its contents - Outlook's charset <meta> alone would otherwise leave a stray line at the top of the note.
const NON_PROSE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
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
export const INSTANTLY_SYNC_PAGE_LIMIT = 15;

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <parse instantly responses>

//#region <emails>
function parseEmailType(value: unknown): InstantlyEmailType {
  if (value === 1 || value === 3) return "sent";
  if (value === 2) return "received";
  if (value === 4) return "scheduled";
  return "unknown";
}

export function parseInstantlyEmail(value: unknown): InstantlyEmail {
  if (!isJsonObject(value)) throw new Error("Instantly returned an invalid email");
  const id = stringValue(value.id);
  const timestampCreated = stringValue(value.timestamp_created);
  const timestampEmail = stringValue(value.timestamp_email) ?? timestampCreated;
  const leadEmail = stringValue(value.lead);
  if (!id || !timestampCreated || !timestampEmail) {
    throw new Error("Instantly email is missing id or timestamp");
  }
  if (!Number.isFinite(Date.parse(timestampCreated)) || !Number.isFinite(Date.parse(timestampEmail))) {
    throw new Error("Instantly email has an invalid timestamp");
  }
  const body = objectValue(value, "body");
  return {
    id,
    timestampCreated,
    timestampEmail,
    emailType: parseEmailType(value.ue_type),
    leadEmail,
    isAutoReply: value.is_auto_reply === 1,
    subject: stringValue(value.subject),
    //Falls back to the HTML body, which is all Instantly sends for its own outbound mail. See htmlToPlainText.
    bodyText: stringValue(body?.text) ?? htmlToPlainText(stringValue(body?.html)),
    threadId: stringValue(value.thread_id),
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
/** The named and numeric entities an email body actually uses. Anything unrecognised is left exactly as it was. */
function decodeEntities(html: string): string {
  return html.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (match: string, decimal?: string, hex?: string, name?: string): string => {
      if (decimal !== undefined || hex !== undefined) {
        const code = Number.parseInt(decimal ?? hex ?? "", decimal !== undefined ? 10 : 16);
        //[STABILITY] Guarded because String.fromCodePoint throws outside the Unicode range, and a malformed
        //entity in a stranger's email must not fail the whole touchpoint.
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? match;
    },
  );
}

//---------------------------------------------------------------------------------------------------------
//[LOGIC] The prose inside an HTML email body, or null when it holds none.
//FLOW: 1. drop the non-prose elements whole. 2. turn <br> and every block close into a line break. 3. strip
//the tags that remain. 4. decode entities - AFTER stripping, so a "&lt;div&gt;" written in the text is never
//mistaken for a tag. 5. trim each line and collapse runs of blank ones, since markup nests and one paragraph
//break is commonly spelled by three or four tags closing together.
//USES: nothing. Pure.
//---------------------------------------------------------------------------------------------------------
export function htmlToPlainText(html: string | null): string | null {
  if (!html) return null;
  const text = decodeEntities(
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
  return text.length > 0 ? text : null;
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <instantly transport>

//#region <requests>
//---------------------------------------------------------------------------------------------------------
//Single transport for every Instantly call. Nothing else in this module calls fetch.
//FLOW: 1. prefix with INSTANTLY_BASE. 2. attach the bearer under any caller override. 3. parse the body.
//4. 429 -> InstantlyRateLimitError. 5. other non-2xx -> throw, with credentialHint naming INSTANTLY_API_KEY
//on a 401/403.
//[SECURITY] The key is read from env per request by instantlyAuthHeader and never cached in module state.
//[STABILITY] A 429 is NOT retried in here, unlike attioFetch. Attio's limit is per second and a short backoff
//clears it; Instantly's is 20 per MINUTE, so waiting it out would spend most of a run's budget sleeping. The
//caller stops and resumes next run instead, which costs nothing and drains the same backlog faster.
//---------------------------------------------------------------------------------------------------------
async function instantlyFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${INSTANTLY_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: instantlyAuthHeader(),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await responseJson(response);
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new InstantlyRateLimitError(
      `${path.split("?")[0]}${retryAfter ? `, retry after ${retryAfter}s` : ""}. The documented allowance is 20 requests per minute across the whole key, which the touchpoint sync's pagination and the interested route's lookups share.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Instantly API error ${response.status}: ${JSON.stringify(body)}${credentialHint("instantly", response.status)}`,
    );
  }
  return body;
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read emails>

//#region <email windows>
//---------------------------------------------------------------------------------------------------------
//Reads emails, paginated, up to `maxPages`.
//FLOW: 1. build a page from whichever query fields are set. 2. GET. 3. parse items. 4. follow
//next_starting_after until absent, until the page cap, or until Instantly refuses.
//Filters are on timestamp_created, which is also what the cron keys its cursor on, so window and cursor agree.
//
//[STABILITY] A 429 RETURNS WHAT IT HAS rather than throwing it away. The pages already read are real emails
//the caller can process, and discarding them is what wedged this sync - see InstantlyRateLimitError. The
//caller is told the window is incomplete so it knows not to park its cursor at the end of it.
//Any other failure still throws: a malformed page or a 500 says nothing about how much of the window exists,
//and guessing that the part already read is the whole of it would skip the rest for good.
//USES: instantlyFetch, parseInstantlyEmail (this module); isJsonObject, arrayValue, stringValue (lib/json.ts).
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyEmailWindow(
  query: InstantlyEmailQuery,
  maxPages: number = Number.POSITIVE_INFINITY,
): Promise<InstantlyEmailWindow> {
  const emails: InstantlyEmail[] = [];
  let startingAfter: string | null = null;
  let pagesRead = 0;

  do {
    if (pagesRead >= maxPages) return { emails, stoppedBy: "page-limit", pagesRead };
    //Ascending, so the caller's cursor advances monotonically as it walks the result.
    const params = new URLSearchParams({ limit: "100", sort_order: "asc" });
    //Minus one millisecond: the bound is treated as exclusive, and an email sitting exactly on the cursor
    //timestamp must still be returned. The caller's isAfterCursor check discards it if it was already handled.
    if (query.fromMs !== undefined) {
      params.set("min_timestamp_created", new Date(Math.max(0, query.fromMs - 1)).toISOString());
    }
    if (query.toMs !== undefined) {
      params.set("max_timestamp_created", new Date(query.toMs).toISOString());
    }
    if (query.leadEmail) params.set("lead", query.leadEmail);
    if (startingAfter) params.set("starting_after", startingAfter);

    let body: unknown;
    try {
      body = await instantlyFetch(`/emails?${params}`);
    } catch (error) {
      if (error instanceof InstantlyRateLimitError) {
        console.warn(
          `[instantly] throttled after ${pagesRead} page(s) and ${emails.length} email(s) - ${error.message}. What was read is kept and returned; the rest of the window is left for the next run.`,
        );
        return { emails, stoppedBy: "throttled", pagesRead };
      }
      throw error;
    }
    pagesRead += 1;
    if (!isJsonObject(body)) throw new Error("Instantly emails response is invalid");
    emails.push(...arrayValue(body, "items").map(parseInstantlyEmail));
    startingAfter = stringValue(body.next_starting_after);
  } while (startingAfter);

  return { emails, stoppedBy: null, pagesRead };
}

//---------------------------------------------------------------------------------------------------------
//The whole of a query's emails, or nothing.
//For the interested route, whose note is one lead's thread: half a thread rendered as though it were the
//whole is a misleading note, and unlike the cron there is no cursor to resume from - the note is written once.
//So a throttled read raises here rather than returning a partial thread. The route's own handling decides
//what a missing history is worth; see api/instantly-interested.ts.
//USES: fetchInstantlyEmailWindow (this module).
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyEmails(
  query: InstantlyEmailQuery,
): Promise<readonly InstantlyEmail[]> {
  const { emails, stoppedBy } = await fetchInstantlyEmailWindow(query);
  if (stoppedBy === "throttled") {
    throw new InstantlyRateLimitError(
      `only ${emails.length} email(s) of this thread could be read, and a partial thread is not written as though it were the whole`,
    );
  }
  return emails;
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
//The payload is a workspace's own custom variables, so its keys are whatever whoever built the campaign typed:
//"# Employees", "Annual Revenue", "Company Address", "linkedIn". Keys are therefore compared on their letters
//and digits alone, which makes "# Employees" and "employees" one name and survives a variable being renamed to
//a different casing or punctuation.
function normalizePayloadKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The first payload value whose key matches any of `names`, compared on letters and digits alone. */
function payloadValue(payload: JsonObject | null, names: readonly string[]): string | null {
  if (!payload) return null;
  const wanted = new Set(names.map(normalizePayloadKey));
  for (const [key, value] of Object.entries(payload)) {
    if (!wanted.has(normalizePayloadKey(key))) continue;
    const text = stringValue(value);
    if (text) return text;
  }
  return null;
}

//---------------------------------------------------------------------------------------------------------
//One lead record, flattened. Top-level fields win over the payload's copies of them: Instantly promotes the
//standard variables up top and keeps the raw uploaded value below, and the promoted one is the one it acts on.
//---------------------------------------------------------------------------------------------------------
export function parseInstantlyLead(value: unknown): InstantlyLead {
  if (!isJsonObject(value)) throw new Error("Instantly returned an invalid lead");
  const email = stringValue(value.email);
  if (!email) throw new Error("Instantly lead is missing an email address");
  const payload = objectValue(value, "payload");
  return {
    email,
    firstName: stringValue(value.first_name) ?? payloadValue(payload, ["firstName"]),
    lastName: stringValue(value.last_name) ?? payloadValue(payload, ["lastName"]),
    jobTitle: stringValue(value.job_title) ?? payloadValue(payload, ["jobTitle", "title"]),
    phone: stringValue(value.phone) ?? payloadValue(payload, ["phone"]),
    companyName: stringValue(value.company_name) ?? payloadValue(payload, ["companyName"]),
    companyDomain: stringValue(value.company_domain),
    website: stringValue(value.website) ?? payloadValue(payload, ["website"]),
    linkedin: payloadValue(payload, ["linkedIn", "linkedInUrl", "linkedinProfile"]),
    location: payloadValue(payload, ["location", "city"]),
    companyAddress: payloadValue(payload, ["companyAddress", "address"]),
    industry: payloadValue(payload, ["industry"]),
    employeeCount: payloadValue(payload, ["# Employees", "employees", "employeeCount", "companySize"]),
    annualRevenue: payloadValue(payload, ["Annual Revenue", "revenue", "annualRevenue"]),
  };
}
//#endregion

//#region <look up a lead>
//---------------------------------------------------------------------------------------------------------
//The lead record behind an address, or null when Instantly holds none.
//FLOW: 1. free-text search on the address. 2. keep only an EXACT case-insensitive match on `email`.
//Step 2 matters: `search` is fuzzy and will happily return a different lead at the same company, whose job
//title and LinkedIn URL would then be written onto the wrong Attio person. A near miss is treated as no match.
//[STABILITY] Enrichment only. Every caller treats null as "nothing extra to add", never as a failure, so a
//lead Instantly cannot find still gets recorded from the webhook body alone.
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyLead(email: string): Promise<InstantlyLead | null> {
  const body = await instantlyFetch("/leads/list", {
    method: "POST",
    body: JSON.stringify({ search: email, limit: 10 }),
  });
  if (!isJsonObject(body)) throw new Error("Instantly leads response is invalid");
  const wanted = email.toLowerCase();
  for (const item of arrayValue(body, "items")) {
    if (!isJsonObject(item)) continue;
    if (stringValue(item.email)?.toLowerCase() !== wanted) continue;
    const lead = parseInstantlyLead(item);
    console.log(`[lookup] instantly lead ${email}: matched, ${describeInstantlyLead(lead)}`);
    return lead;
  }
  console.log(`[lookup] instantly lead ${email}: no exact match, so nothing is enriched from Instantly`);
  return null;
}

/** [DEBUG] Which enrichment fields arrived, by name only - never their values, which are personal data. */
function describeInstantlyLead(lead: InstantlyLead): string {
  const present = Object.entries(lead)
    .filter(([key, value]) => key !== "email" && value !== null)
    .map(([key]) => key);
  return present.length > 0 ? `carrying ${present.join(", ")}` : "carrying nothing beyond the address";
}
//#endregion

//#region <blocklist>
//---------------------------------------------------------------------------------------------------------
//Adds an address to the workspace blocklist, so no campaign can mail it again.
//Part of the suppression that runs for every interested lead whatever platform reported the interest - see
//suppressInterestedLead (lib/interested.ts). A lead who said yes on the phone must stop receiving cold email.
//[STABILITY] The caller does not check whether the address is already blocked, and whether Instantly treats a
//re-block as success or as an error is NOT verified. It does not need to be: suppression collects failures
//rather than raising them, so the worst case is one logged failure on an address that was already suppressed.
//---------------------------------------------------------------------------------------------------------
export async function blockInstantlyLead(value: string): Promise<void> {
  try {
    await instantlyFetch("/block-lists-entries", {
      method: "POST",
      body: JSON.stringify({ bl_value: value }),
    });
    console.log(`[action] instantly blocklist: added ${value}`);
  } catch (error) {
    console.error(`[action] FAILED - instantly blocklist could not add ${value}: ${errorMessage(error)}`);
    throw error;
  }
}
//#endregion

//#endregion
//=============================================================================================================
