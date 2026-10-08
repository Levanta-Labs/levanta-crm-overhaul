//Outfound is not a sequencer. It sits on top of one - it ingests from Smartlead, Instantly, EmailBison,
//HeyReach and AgentMail and warehouses every send, reply, bounce and category update. So the emails this module
//reads were sent by some other platform; Outfound is the place they can all be read from at once.
//
//Two consequences shape everything below:
//  - THE WAREHOUSE LAGS. Outfound refreshes on roughly a three-minute cadence, so an email that has happened is
//    not necessarily an email that can be read back yet. See OUTFOUND_CURSOR_GRACE_MS (lib/cursors.ts).
//  - THE INBOX IS THREADED. There is no endpoint listing individual emails in a time window: threads are listed,
//    and each thread's messages are fetched separately. fetchOutfoundThreadEmails is the second half of every
//    read, and the reason the touchpoint sync costs one request per thread rather than one per page.
//
//The API is private and has no public documentation. It is written against the spec the deployment serves
//itself, at https://api.outfound.io/openapi-client.json.

//imports======================================================================================================

import { credentialHint, OUTFOUND_BASE, outfoundAuthHeader } from "./endpoints.js";
import {
  arrayValue,
  errorMessage,
  isJsonObject,
  objectValue,
  responseJson,
  stringValue,
} from "./json.js";

//=============================================================================================================

//types and globals============================================================================================

/** Outfound's own vocabulary. Only Sent and Received are traffic that happened; the rest have not, or failed. */
export type OutfoundEmailType = "Sent" | "Received" | "Scheduled" | "PendingSend" | "Failed" | "unknown";

/** One message inside a thread. `id` is Outfound's own, and stable, so the cursor needs no synthesised key. */
export interface OutfoundEmail {
  readonly id: string;
  readonly threadHash: string;
  readonly emailType: OutfoundEmailType;
  readonly sender: string;
  readonly recipient: string;
  readonly subject: string | null;
  readonly bodyText: string | null;
  /** When the message was sent. This is what the cursor keys on - see fetchOutfoundThreads. */
  readonly sentAt: string;
}

/** A thread as the inbox lists it. Carries no message bodies - those cost a second request per thread. */
export interface OutfoundThread {
  readonly threadHash: string;
  readonly leadEmail: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly campaignName: string | null;
  readonly lastEmailAt: string | null;
  readonly leadCategoryName: string | null;
  readonly leadCategorySentiment: string | null;
}

export interface OutfoundThreadQuery {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface OutfoundConversation {
  readonly id: string;
  readonly threadHash: string;
  readonly conversationType: OutfoundEmailType;
  readonly subject: string | null;
  readonly body: string | null;
  readonly campaignName: string | null;
  readonly timestampEmail: string;
}

export interface OutfoundLead {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly jobTitle: string | null;
  readonly seniority: string | null;
  readonly linkedin: string | null;
  readonly companyName: string | null;
  readonly companyDomain: string | null;
  readonly companyLinkedin: string | null;
  //An ISO 3166-1 alpha-2 country code, not a free-text place. parsePostalAddress (lib/interested.ts) is not
  //given this: a bare country code is not an address, and Attio's location attribute is structured.
  readonly location: string | null;
  readonly industry: string | null;
  readonly headcount: string | null;
  readonly revenue: string | null;
  /** Every thread this lead appears in, across clients. Rendered into the interested note, and keyed on for DNC. */
  readonly conversations: readonly OutfoundConversation[];
}

//---------------------------------------------------------------------------------------------------------
//Raised on a 429, so a caller can tell "slow down" apart from "this request was wrong".
//WHY IT MATTERS HERE more than on the other providers: the touchpoint sync spends one request PER THREAD, and
//the client key is rate-limited per key, not per organization. The dashboard shows the ORGANIZATION ceiling
//(100K/hr on enterprise); `GET /rate-limit` reports what the key itself gets, which is a different and much
//smaller number - the key in use is on the `standard` tier at 9/second and 3,000/hour. Across twelve runs an
//hour that is roughly 250 threads per run before throttling, which a backlog reaches easily.
//---------------------------------------------------------------------------------------------------------
export class OutfoundRateLimitError extends Error {
  constructor(detail: string) {
    super(`Outfound rate limit reached: ${detail}`);
    this.name = "OutfoundRateLimitError";
  }
}

//The API's own maximum. Asking for more is not an error and not honoured either - it answers with `limit: 50`
//whatever is requested - so the number here matches what is actually served rather than what we would prefer.
const THREAD_PAGE_LIMIT = 50;
//A bound on pagination, so a cursor the API never terminates cannot spin a run until Vercel kills it. At the
//page size above this is 20,000 threads, far past anything a five-minute window produces; reaching it means
//something is wrong with the cursor rather than that the window is genuinely that wide.
const MAX_THREAD_PAGES = 200;

//=============================================================================================================

//parse outfound responses=====================================================================================

//#region <parse outfound responses: emails and threads>
function parseEmailType(value: unknown): OutfoundEmailType {
  const text = stringValue(value);
  switch (text) {
    case "Sent":
    case "Received":
    case "Scheduled":
    case "PendingSend":
    case "Failed":
      return text;
    default:
      return "unknown";
  }
}

export function parseOutfoundEmail(value: unknown, threadHash: string): OutfoundEmail {
  if (!isJsonObject(value)) throw new Error("Outfound returned an invalid email");
  const id = stringValue(value.id);
  const sentAt = stringValue(value.sent_at) ?? stringValue(value.created_at);
  if (!id || !sentAt) throw new Error("Outfound email is missing id or timestamp");
  if (!Number.isFinite(Date.parse(sentAt))) {
    throw new Error("Outfound email has an invalid timestamp");
  }
  return {
    id,
    threadHash,
    emailType: parseEmailType(value.type),
    sender: stringValue(value.sender) ?? "",
    recipient: stringValue(value.recipient) ?? "",
    subject: stringValue(value.subject),
    //body_plain is the rendered text. body_html is deliberately ignored: a note is read as prose, and the
    //markup would be written into it verbatim.
    bodyText: stringValue(value.body_plain),
    sentAt,
  };
}

export function parseOutfoundThread(value: unknown): OutfoundThread {
  if (!isJsonObject(value)) throw new Error("Outfound returned an invalid thread");
  const threadHash = stringValue(value.thread_hash);
  if (!threadHash) throw new Error("Outfound thread is missing thread_hash");
  return {
    threadHash,
    leadEmail: stringValue(value.prospect_lead_email),
    firstName: stringValue(value.prospect_first_name),
    lastName: stringValue(value.prospect_last_name),
    campaignName: stringValue(value.campaign_name),
    lastEmailAt: stringValue(value.last_email_timestamp),
    leadCategoryName: stringValue(value.lead_category_name),
    leadCategorySentiment: stringValue(value.lead_category_sentiment),
  };
}
//#endregion

//=============================================================================================================

//outfound transport===========================================================================================

//#region <outfound transport: requests>
//---------------------------------------------------------------------------------------------------------
//Single transport for every Outfound call. Nothing else in this module calls fetch.
//FLOW: 1. prefix with OUTFOUND_BASE. 2. attach the bearer under any caller override. 3. parse the body.
//4. non-2xx -> throw, with credentialHint naming OUTFOUND_API_KEY on a 401/403.
//[SECURITY] The key is read from env per request by outfoundAuthHeader and never cached in module state.
//---------------------------------------------------------------------------------------------------------
async function outfoundFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${OUTFOUND_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: outfoundAuthHeader(),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await responseJson(response);
  //[STABILITY] A 429 is not a bad request and must not be treated as one: the caller stops the run on it rather
  //than passing the thread over, because passing over would march through the rest of the backlog collecting one
  //throttled failure per thread and finish no work at all. See OutfoundRateLimitError.
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new OutfoundRateLimitError(
      `${path.split("?")[0]}${retryAfter ? `, retry after ${retryAfter}s` : ""}. GET /rate-limit reports the key's own tier, which is lower than the organization ceiling shown in the dashboard.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Outfound API error ${response.status}: ${JSON.stringify(body)}${credentialHint("outfound", response.status)}`,
    );
  }
  return body;
}
//#endregion

//=============================================================================================================

//read threads and emails======================================================================================

//#region <read threads and emails: thread windows>
//---------------------------------------------------------------------------------------------------------
//Every thread with activity in a window, paginated. Bodies are NOT included - see fetchOutfoundThreadEmails.
//FLOW: 1. GET a page bounded by email_start_date/email_end_date. 2. parse items. 3. follow next_cursor until
//absent or MAX_THREAD_PAGES.
//[PERF] Threads, not emails. A thread is returned when ANY of its emails falls in the window, and the messages
//fetched for it are then the WHOLE thread, including messages long outside it. Deduplication is the caller's
//per-email cursor check, not this filter - the same arrangement the HeyReach sync runs under.
//[STABILITY] No platform filter is applied. Outfound carries every sequencer the workspace has connected, and
//narrowing to a named one here would silently drop a platform added later. If this sync ever needs to exclude
//a platform the CRM already reads directly, that is a `platform` query parameter on this call.
//[STABILITY] The bound is on the email timestamp, which is what the cursor keys on too, so window and cursor
//agree. Which of sent_at/created_at the filter reads is not documented; the grace margin absorbs the
//difference either way, because it is wider than the gap between them can plausibly be.
//[STABILITY] Both bounds are sent as naive UTC. A timezone designator makes this endpoint answer 500 - see
//outfoundNaiveUtc, which is a workaround for an upstream bug and not a formatting preference.
//USES: outfoundFetch (this module); arrayValue, stringValue (lib/json.ts).
//---------------------------------------------------------------------------------------------------------
export async function fetchOutfoundThreads(
  query: OutfoundThreadQuery,
): Promise<readonly OutfoundThread[]> {
  const threads: OutfoundThread[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      limit: String(THREAD_PAGE_LIMIT),
      //Minus one millisecond: the bound is treated as exclusive, and an email sitting exactly on the cursor
      //timestamp must still be returned. The caller's isAfterCursor check discards it if it was already handled.
      email_start_date: outfoundNaiveUtc(Math.max(0, query.fromMs - 1)),
      email_end_date: outfoundNaiveUtc(query.toMs),
    });
    if (cursor) params.set("cursor", cursor);

    const body = await outfoundFetch(`/email-inbox/threads?${params}`);
    if (!isJsonObject(body)) throw new Error("Outfound threads response is invalid");
    threads.push(...arrayValue(body, "items").map(parseOutfoundThread));
    cursor = stringValue(body.next_cursor);
    pages += 1;
    if (pages >= MAX_THREAD_PAGES && cursor) {
      console.warn(
        `[lookup] outfound threads: stopped paginating at ${pages} pages with a cursor still open - ${threads.length} thread(s) read. The window is being truncated, so some activity in it will not be seen this run.`,
      );
      break;
    }
  } while (cursor);

  return threads;
}

//---------------------------------------------------------------------------------------------------------
//[LOGIC] A UTC timestamp with NO timezone designator, which is the only form the thread filter accepts.
//
//[STABILITY] WORKING AROUND AN UPSTREAM 500. Outfound's thread listing rejects any timezone-AWARE datetime with
//an HTTP 500 and `{"detail":"An unexpected error occurred while listing email threads."}` - both the `Z` that
//Date#toISOString appends and an explicit `+00:00` offset do it, on either bound, with or without the other.
//A naive datetime is accepted. That is the signature of a timezone-aware value being compared against a naive
//database column, so the column is UTC and this sends UTC; only the designator is dropped.
//
//Verified by hand against the live API:
//    2026-09-02T13:58:30Z       -> 500        2026-09-02T13:58:30        -> 200
//    2026-09-02T13:58:30+00:00  -> 500        2026-09-02T13:58:30.198    -> 200
//
//Remove this ONLY once Outfound accepts an offset, and re-check both bounds when doing so. Sending a bare local
//time here instead of UTC would silently shift every window by the server's offset, which is why the value is
//built from toISOString rather than from any local-time formatter.
//USES: nothing. Pure.
//---------------------------------------------------------------------------------------------------------
export function outfoundNaiveUtc(ms: number): string {
  //toISOString is always UTC and always ends in "Z"; dropping that last character is the whole conversion.
  return new Date(ms).toISOString().slice(0, -1);
}
//#endregion

//#region <read threads and emails: thread messages>
//---------------------------------------------------------------------------------------------------------
//Every message in one thread. The second half of every read: the inbox listing carries no bodies.
//[PERF] One request per thread, which is what makes the touchpoint sync's cost scale with threads rather than
//with pages. The run budget is what keeps that bounded - see lib/run-budget.ts.
//USES: outfoundFetch, parseOutfoundEmail (this module); arrayValue (lib/json.ts).
//---------------------------------------------------------------------------------------------------------
export async function fetchOutfoundThreadEmails(
  threadHash: string,
): Promise<readonly OutfoundEmail[]> {
  const body = await outfoundFetch(`/email-inbox/threads/${encodeURIComponent(threadHash)}/emails`);
  if (!isJsonObject(body)) throw new Error("Outfound thread emails response is invalid");
  return arrayValue(body, "items").map((item) => parseOutfoundEmail(item, threadHash));
}
//#endregion

//=============================================================================================================

//read and suppress leads======================================================================================

//The lead record, and the DNC list.
//
//One endpoint answers both of the interested route's questions at once. /prospects/lookup/conversations returns
//the enrichment (title, seniority, LinkedIn, and the company's domain, industry, headcount and revenue) AND the
//recent conversations the note is rendered from - so the route pays one request where the Instantly route pays
//two, and gets a richer record for it.

//#region <read and suppress leads: parse lead records>
function parseConversation(value: unknown): OutfoundConversation | null {
  if (!isJsonObject(value)) return null;
  const id = stringValue(value.id);
  const threadHash = stringValue(value.thread_hash);
  const timestampEmail = stringValue(value.timestamp_email);
  if (!id || !threadHash || !timestampEmail) return null;
  return {
    id,
    threadHash,
    conversationType: parseEmailType(value.conversation_type),
    subject: stringValue(value.subject),
    //Outfound truncates this to 3000 characters at source; the note carries whatever it sent.
    body: stringValue(value.body),
    campaignName: stringValue(value.campaign_name),
    timestampEmail,
  };
}

//---------------------------------------------------------------------------------------------------------
//One lead, flattened out of a response nested three deep: enrichment sits at the root, while conversations are
//grouped per client, each client holding its own prospects and recent_conversations.
//Conversations are flattened ACROSS clients. A lead worked by two clients has two groups, and the note is the
//whole correspondence with that person rather than one client's slice of it.
//USES: parseConversation (this module); isJsonObject, objectValue, arrayValue, stringValue (lib/json.ts).
//---------------------------------------------------------------------------------------------------------
export function parseOutfoundLead(value: unknown): OutfoundLead {
  if (!isJsonObject(value)) throw new Error("Outfound returned an invalid lead");
  const email = stringValue(value.lead_email);
  if (!email) throw new Error("Outfound lead is missing an email address");

  const enrichment = objectValue(value, "enrichment");
  const company = enrichment ? objectValue(enrichment, "company") : null;

  const conversations: OutfoundConversation[] = [];
  for (const client of arrayValue(value, "clients")) {
    if (!isJsonObject(client)) continue;
    for (const entry of arrayValue(client, "recent_conversations")) {
      const conversation = parseConversation(entry);
      if (conversation) conversations.push(conversation);
    }
  }

  return {
    email,
    firstName: stringValue(enrichment?.first_name),
    lastName: stringValue(enrichment?.last_name),
    jobTitle: stringValue(enrichment?.title),
    seniority: stringValue(enrichment?.seniority),
    linkedin: stringValue(enrichment?.person_linkedin),
    companyName: stringValue(company?.company_name),
    companyDomain: stringValue(company?.company_domain),
    companyLinkedin: stringValue(company?.company_linkedin),
    location: stringValue(company?.location),
    industry: stringValue(company?.industry),
    headcount: stringValue(company?.headcount),
    revenue: stringValue(company?.revenue),
    conversations,
  };
}
//#endregion

//#region <read and suppress leads: look up a lead>
//---------------------------------------------------------------------------------------------------------
//The lead behind an address, or null when Outfound holds none.
//Unlike the Instantly equivalent this needs no exact-match guard: the endpoint is keyed on the address rather
//than being a fuzzy search, so it cannot return a different person at the same company.
//
//A MISS IS NOT A 404, AND NOT AN EMPTY BODY EITHER. The endpoint ECHOES the address it was asked about, so
//`lead_email` is populated whether or not Outfound has ever seen it. Verified against the live API:
//
//    GET /prospects/lookup/conversations?email=nobody@example.invalid
//    {"lead_email":"nobody@example.invalid","enrichment":null,"clients":[],"total_clients_contacted":0,...}
//
//So the miss is detected on the two fields that carry the substance: no enrichment, and no client has ever
//held a conversation. Either one alone means Outfound knows something worth having.
//[DEBUG] This distinction is diagnostic only - every caller treats null and an all-null lead identically, so
//getting it wrong changed no behaviour, only the log. It is still worth getting right: a line reading "matched"
//for an address nothing matched sends whoever is debugging a missing enrichment to the wrong place entirely.
//[STABILITY] Enrichment plus history. Every caller treats null as "nothing extra to add", never as a failure,
//so a lead Outfound cannot find is still recorded from the webhook body alone.
//USES: outfoundFetch, parseOutfoundLead (this module).
//---------------------------------------------------------------------------------------------------------
export async function fetchOutfoundLead(email: string): Promise<OutfoundLead | null> {
  const params = new URLSearchParams({ email });
  const body = await outfoundFetch(`/prospects/lookup/conversations?${params}`);
  if (!isJsonObject(body)) throw new Error("Outfound lead lookup response is invalid");
  //The echoed lead_email proves nothing, so it is not what is tested - see above.
  const hasEnrichment = objectValue(body, "enrichment") !== null;
  const hasClients = arrayValue(body, "clients").length > 0;
  if (!hasEnrichment && !hasClients) {
    console.log(`[lookup] outfound lead ${email}: no match, so nothing is enriched from Outfound`);
    return null;
  }
  const lead = parseOutfoundLead(body);
  console.log(`[lookup] outfound lead ${email}: matched, ${describeOutfoundLead(lead)}`);
  return lead;
}

/** [DEBUG] Which enrichment fields arrived, by name only - never their values, which are personal data. */
function describeOutfoundLead(lead: OutfoundLead): string {
  const present = Object.entries(lead)
    .filter(([key, value]) => key !== "email" && key !== "conversations" && value !== null)
    .map(([key]) => key);
  const carrying =
    present.length > 0 ? `carrying ${present.join(", ")}` : "carrying nothing beyond the address";
  return `${carrying}, across ${lead.conversations.length} conversation(s)`;
}
//#endregion

//#region <read and suppress leads: do-not-contact list>
//---------------------------------------------------------------------------------------------------------
//Marks an address do-not-contact, so no connected sequencer mails it again.
//Part of the suppression that runs for every interested lead whatever platform reported the interest - see
//suppressInterestedLead (lib/interested.ts).
//
//Keyed on a THREAD, not an address, which is the whole awkwardness of this call: Outfound has no "add this
//email to DNC" endpoint, only "mark this thread DNC", with dnc_type deciding whether the address or its whole
//domain is what gets suppressed. So a lead with no thread cannot be suppressed here, and the caller is the one
//that has to find a thread first - see THIRD_PARTY_SUPPRESSION_CHANNELS (lib/providers.ts).
//
//`email` rather than `domain`: a domain-wide block would suppress every colleague of the person who replied,
//at a company that has just shown interest, which is the opposite of what an interested lead should cause.
//[STABILITY] Outfound propagates the entry down to the sending platform itself ("schedules platform sync"), so
//this stops the sequencer as well as the warehouse's view of it. That propagation is asynchronous and its
//completion is NOT verified here; the call returning is taken as success.
//---------------------------------------------------------------------------------------------------------
export async function markOutfoundThreadDnc(threadHash: string, email: string): Promise<void> {
  try {
    await outfoundFetch(`/email-inbox/threads/${encodeURIComponent(threadHash)}/mark-as-dnc`, {
      method: "PUT",
      body: JSON.stringify({ dnc_type: "email" }),
    });
    console.log(`[action] outfound DNC: added ${email}`);
  } catch (error) {
    console.error(`[action] FAILED - outfound DNC could not add ${email}: ${errorMessage(error)}`);
    throw error;
  }
}
//#endregion

//=============================================================================================================
