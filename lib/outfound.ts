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

//=============================================================================================================
//#region <import statements>

import { credentialHint, OUTFOUND_BASE, outfoundAuthHeader } from "./endpoints.js"; //outfound url and login helpers
import { //safe readers for unknown json
  arrayValue,
  errorMessage,
  isJsonObject,
  objectValue,
  responseJson,
  stringValue,
} from "./json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//Outfound's own vocabulary. Only Sent and Received are traffic that happened; the rest have not, or failed.
export type OutfoundEmailType = "Sent" | "Received" | "Scheduled" | "PendingSend" | "Failed" | "unknown";

//One message inside a thread. `id` is Outfound's own, and stable, so the cursor needs no synthesised key.
export interface OutfoundEmail {
  readonly id: string; //outfound's email id
  readonly threadHash: string; //the thread it belongs to
  readonly emailType: OutfoundEmailType; //sent, received, etc.
  readonly sender: string; //from address, "" if missing
  readonly recipient: string; //to address, "" if missing
  readonly subject: string | null; //subject line
  readonly bodyText: string | null; //body as plain text
  /** When the message was sent. This is what the cursor keys on - see fetchOutfoundThreads. */
  readonly sentAt: string; //send time, ISO text
}

//A thread as the inbox lists it. Carries no message bodies - those cost a second request per thread.
export interface OutfoundThread {
  readonly threadHash: string; //outfound's thread id
  readonly leadEmail: string | null; //the lead's address
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly campaignName: string | null; //campaign the thread came from
  readonly lastEmailAt: string | null; //time of the newest email
  readonly leadCategoryName: string | null; //lead category, e.g. "Interested"
  readonly leadCategorySentiment: string | null; //that category's sentiment
}

//The time window to list threads for.
export interface OutfoundThreadQuery {
  readonly fromMs: number; //window start, epoch milliseconds
  readonly toMs: number; //window end, epoch milliseconds
}

//One recent message from a lead lookup, as the interested note uses it.
export interface OutfoundConversation {
  readonly id: string; //outfound's message id
  readonly threadHash: string; //the thread it belongs to
  readonly conversationType: OutfoundEmailType; //sent, received, etc.
  readonly subject: string | null; //subject line
  readonly body: string | null; //message text, cut at 3000 characters
  readonly campaignName: string | null; //campaign it came from
  readonly timestampEmail: string; //when it was sent
}

//One Outfound lead, flattened: enrichment fields plus every conversation with them.
export interface OutfoundLead {
  readonly email: string; //the lead's address
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly jobTitle: string | null; //lead's job title
  readonly seniority: string | null; //lead's seniority level
  readonly linkedin: string | null; //lead's linkedin profile url
  readonly companyName: string | null; //lead's company
  readonly companyDomain: string | null; //company's web domain
  readonly companyLinkedin: string | null; //company's linkedin page
  //An ISO 3166-1 alpha-2 country code, not a free-text place. parsePostalAddress (lib/interested.ts) is not
  //given this: a bare country code is not an address, and Attio's location attribute is structured.
  readonly location: string | null; //country code, e.g. "US"
  readonly industry: string | null; //company's industry
  readonly headcount: string | null; //company headcount, as text
  readonly revenue: string | null; //company revenue, as text
  /** Every thread this lead appears in, across clients. Rendered into the interested note, and keyed on for DNC. */
  readonly conversations: readonly OutfoundConversation[]; //every conversation, across clients
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
  constructor(detail: string) { //detail says what was refused
    super(`Outfound rate limit reached: ${detail}`); //the error message
    this.name = "OutfoundRateLimitError"; //name shown in logs
  }
}

//The API's own maximum. Asking for more is not an error and not honoured either - it answers with `limit: 50`
//whatever is requested - so the number here matches what is actually served rather than what we would prefer.
const THREAD_PAGE_LIMIT = 50; //threads per page
//A bound on pagination, so a cursor the API never terminates cannot spin a run until Vercel kills it. At the
//page size above this is 20,000 threads, far past anything a five-minute window produces; reaching it means
//something is wrong with the cursor rather than that the window is genuinely that wide.
const MAX_THREAD_PAGES = 200; //most pages one thread listing reads

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <parse outfound responses>

//#region <emails and threads>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads Outfound's email type text, keeping only the values this code knows.
//Input: value - an email's "type" or a conversation's "conversation_type", unknown shape.
//Output: the type, or "unknown" for anything else.
//Workflow: parseOutfoundEmail and parseConversation - fill the email's type.
//---------------------------------------------------------------------------------------------------------
function parseEmailType(value: unknown): OutfoundEmailType {
  const text = stringValue(value); //the type as text, or null
  switch (text) { //check it against the known types
    case "Sent": //we sent it
    case "Received": //the lead sent it
    case "Scheduled": //queued for later
    case "PendingSend": //about to send
    case "Failed": //sending failed
      return text; //a known type, keep it
    default: //anything else
      return "unknown"; //not a type we know
  }
}

//---------------------------------------------------------------------------------------------------------
//Reads one raw message from a thread into an OutfoundEmail.
//Input: value - one message object from Outfound, unknown shape; threadHash - the thread it came from.
//Output: the email. Throws if it has no id, no timestamp, or an unreadable timestamp.
//Uses: parseEmailType (this file).
//Workflow: fetchOutfoundThreadEmails - every thread message read goes through here.
//---------------------------------------------------------------------------------------------------------
export function parseOutfoundEmail(value: unknown, threadHash: string): OutfoundEmail {
  if (!isJsonObject(value)) throw new Error("Outfound returned an invalid email"); //not an email at all
  const id = stringValue(value.id); //the email's id
  const sentAt = stringValue(value.sent_at) ?? stringValue(value.created_at); //send time, else creation time
  if (!id || !sentAt) throw new Error("Outfound email is missing id or timestamp"); //unusable email
  if (!Number.isFinite(Date.parse(sentAt))) { //not a real date
    throw new Error("Outfound email has an invalid timestamp"); //unusable email
  }
  return {
    id, //same as id: id
    threadHash, //same as threadHash: threadHash
    emailType: parseEmailType(value.type), //sent, received, etc.
    sender: stringValue(value.sender) ?? "", //missing sender becomes ""
    recipient: stringValue(value.recipient) ?? "", //missing recipient becomes ""
    subject: stringValue(value.subject), //null when blank
    //body_plain is the rendered text. body_html is deliberately ignored: a note is read as prose, and the
    //markup would be written into it verbatim.
    bodyText: stringValue(value.body_plain), //the plain text body
    sentAt, //same as sentAt: sentAt
  };
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads one raw thread from the inbox listing into an OutfoundThread.
//Input: value - one thread object from Outfound, unknown shape.
//Output: the thread. Throws if it is not an object or has no thread_hash.
//Workflow: fetchOutfoundThreads - turns each listed thread.
//---------------------------------------------------------------------------------------------------------
export function parseOutfoundThread(value: unknown): OutfoundThread {
  if (!isJsonObject(value)) throw new Error("Outfound returned an invalid thread"); //not a thread at all
  const threadHash = stringValue(value.thread_hash); //the thread's id
  if (!threadHash) throw new Error("Outfound thread is missing thread_hash"); //no id, unusable
  return {
    threadHash, //same as threadHash: threadHash
    leadEmail: stringValue(value.prospect_lead_email), //null when blank
    firstName: stringValue(value.prospect_first_name), //null when blank
    lastName: stringValue(value.prospect_last_name), //null when blank
    campaignName: stringValue(value.campaign_name), //null when blank
    lastEmailAt: stringValue(value.last_email_timestamp), //null when blank
    leadCategoryName: stringValue(value.lead_category_name), //null when blank
    leadCategorySentiment: stringValue(value.lead_category_sentiment), //null when blank
  };
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <outfound transport>

//#region <requests>
//---------------------------------------------------------------------------------------------------------
//Sends one request to Outfound. The only place this file calls fetch.
//Input: path - the endpoint after OUTFOUND_BASE, query included; options - fetch options (method, body).
//Output: the parsed JSON body. Throws OutfoundRateLimitError on a 429, Error on any other failure.
//Uses: outfoundAuthHeader, credentialHint (lib/endpoints.ts); responseJson (lib/json.ts).
//Workflow: every Outfound request - fetchOutfoundThreads, fetchOutfoundThreadEmails, fetchOutfoundLead,
//markOutfoundThreadDnc.
//
//[SECURITY] The key is read from env per request by outfoundAuthHeader and never cached in module state.
//[DEBUG] credentialHint names OUTFOUND_API_KEY on a 401/403.
//---------------------------------------------------------------------------------------------------------
async function outfoundFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${OUTFOUND_BASE}${path}`, { //send the request
    ...options, //the caller's method and body
    headers: { //request headers
      Authorization: outfoundAuthHeader(), //the api key
      "Content-Type": "application/json", //body is json
      ...options.headers, //caller's headers win
    },
  });
  const body = await responseJson(response); //read the body as json
  //[STABILITY] A 429 is not a bad request and must not be treated as one: the caller stops the run on it rather
  //than passing the thread over, because passing over would march through the rest of the backlog collecting one
  //throttled failure per thread and finish no work at all. See OutfoundRateLimitError.
  if (response.status === 429) { //outfound says slow down
    const retryAfter = response.headers.get("retry-after"); //seconds to wait, if given
    throw new OutfoundRateLimitError( //fail distinctly, no retry
      `${path.split("?")[0]}${retryAfter ? `, retry after ${retryAfter}s` : ""}. GET /rate-limit reports the key's own tier, which is lower than the organization ceiling shown in the dashboard.`,
    );
  }
  if (!response.ok) { //any other failure
    throw new Error( //stop with the details
      `Outfound API error ${response.status}: ${JSON.stringify(body)}${credentialHint("outfound", response.status)}`,
    );
  }
  return body; //success, hand it back
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read threads and emails>

//#region <thread windows>
//---------------------------------------------------------------------------------------------------------
//Lists every thread with activity in a window, page by page. Bodies are NOT included - see
//fetchOutfoundThreadEmails.
//Input: query - the window, fromMs and toMs, epoch milliseconds.
//Output: the threads. Throws on any failed page, including a 429.
//Uses: outfoundFetch, outfoundNaiveUtc, parseOutfoundThread (this file).
//Workflow: outfound touchpoint sync step 3 - the threads whose emails the run will process.
//
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
//---------------------------------------------------------------------------------------------------------
export async function fetchOutfoundThreads(
  query: OutfoundThreadQuery,
): Promise<readonly OutfoundThread[]> {
  const threads: OutfoundThread[] = []; //every thread read so far
  let cursor: string | null = null; //next page's cursor; null for the first
  let pages = 0; //pages read so far

  do { //read pages until no cursor is left
    const params = new URLSearchParams({ //this page's query
      limit: String(THREAD_PAGE_LIMIT), //threads per page
      //Minus one millisecond: the bound is treated as exclusive, and an email sitting exactly on the cursor
      //timestamp must still be returned. The caller's isAfterCursor check discards it if it was already handled.
      email_start_date: outfoundNaiveUtc(Math.max(0, query.fromMs - 1)), //window start, minus 1ms
      email_end_date: outfoundNaiveUtc(query.toMs), //window end
    });
    if (cursor) params.set("cursor", cursor); //continue after the last page

    const body = await outfoundFetch(`/email-inbox/threads?${params}`); //read the page
    if (!isJsonObject(body)) throw new Error("Outfound threads response is invalid"); //unexpected shape
    threads.push(...arrayValue(body, "items").map(parseOutfoundThread)); //add this page's threads
    cursor = stringValue(body.next_cursor); //next page's cursor, or null when done
    pages += 1; //one more page done
    if (pages >= MAX_THREAD_PAGES && cursor) { //page cap hit with more left
      console.warn( //log that the window was cut short
        `[lookup] outfound threads: stopped paginating at ${pages} pages with a cursor still open - ${threads.length} thread(s) read. The window is being truncated, so some activity in it will not be seen this run.`,
      );
      break; //stop paging, keep what we have
    }
  } while (cursor); //stop when there is no next page

  return threads; //every thread read
}

//---------------------------------------------------------------------------------------------------------
//Base function. Writes a time as UTC with NO timezone designator, the only form the thread filter accepts.
//Input: ms - the time, epoch milliseconds.
//Output: text like "2026-09-02T13:58:30.198".
//Workflow: fetchOutfoundThreads - both window bounds.
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
//---------------------------------------------------------------------------------------------------------
export function outfoundNaiveUtc(ms: number): string {
  //toISOString is always UTC and always ends in "Z"; dropping that last character is the whole conversion.
  return new Date(ms).toISOString().slice(0, -1); //UTC time without the "Z"
}
//#endregion

//#region <thread messages>
//---------------------------------------------------------------------------------------------------------
//Reads every message in one thread. The second half of every read: the inbox listing carries no bodies.
//Input: threadHash - the thread's id.
//Output: the thread's emails. Throws if Outfound refuses or returns something unreadable.
//Uses: outfoundFetch, parseOutfoundEmail (this file).
//Workflow: outfound touchpoint sync step 4 (outfoundTouchpointEvents) - each listed thread's emails.
//
//[PERF] One request per thread, which is what makes the touchpoint sync's cost scale with threads rather than
//with pages. The run budget is what keeps that bounded - see lib/run-budget.ts.
//---------------------------------------------------------------------------------------------------------
export async function fetchOutfoundThreadEmails(
  threadHash: string,
): Promise<readonly OutfoundEmail[]> {
  const body = await outfoundFetch(`/email-inbox/threads/${encodeURIComponent(threadHash)}/emails`); //GET the thread's emails
  if (!isJsonObject(body)) throw new Error("Outfound thread emails response is invalid"); //unexpected shape
  return arrayValue(body, "items").map((item) => parseOutfoundEmail(item, threadHash)); //read each email
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read and suppress leads>

//The lead record, and the DNC list.
//
//One endpoint answers both of the interested route's questions at once. /prospects/lookup/conversations returns
//the enrichment (title, seniority, LinkedIn, and the company's domain, industry, headcount and revenue) AND the
//recent conversations the note is rendered from - so the route pays one request where the Instantly route pays
//two, and gets a richer record for it.

//#region <parse lead records>
//---------------------------------------------------------------------------------------------------------
//Reads one raw recent conversation into an OutfoundConversation.
//Input: value - one entry of a client's "recent_conversations" array, unknown shape.
//Output: the conversation, or null if it is not an object or lacks id, thread_hash or timestamp.
//Uses: parseEmailType (this file).
//Workflow: parseOutfoundLead - turns each conversation in the lookup.
//---------------------------------------------------------------------------------------------------------
function parseConversation(value: unknown): OutfoundConversation | null {
  if (!isJsonObject(value)) return null; //not an object, no conversation
  const id = stringValue(value.id); //the message's id
  const threadHash = stringValue(value.thread_hash); //its thread's id
  const timestampEmail = stringValue(value.timestamp_email); //when it was sent
  if (!id || !threadHash || !timestampEmail) return null; //any missing, skip it
  return {
    id, //same as id: id
    threadHash, //same as threadHash: threadHash
    conversationType: parseEmailType(value.conversation_type), //sent, received, etc.
    subject: stringValue(value.subject), //null when blank
    //Outfound truncates this to 3000 characters at source; the note carries whatever it sent.
    body: stringValue(value.body), //the message text
    campaignName: stringValue(value.campaign_name), //null when blank
    timestampEmail, //same as timestampEmail: timestampEmail
  };
}

//---------------------------------------------------------------------------------------------------------
//Reads a lead lookup response into one flat OutfoundLead.
//Input: value - the lookup response body, unknown shape.
//Output: the lead. Throws if it is not an object or has no lead_email.
//Uses: parseConversation (this file).
//Workflow: fetchOutfoundLead - turns a matched lookup.
//
//The response is nested three deep: enrichment sits at the root, while conversations are grouped per client,
//each client holding its own prospects and recent_conversations.
//Conversations are flattened ACROSS clients. A lead worked by two clients has two groups, and the note is the
//whole correspondence with that person rather than one client's slice of it.
//---------------------------------------------------------------------------------------------------------
export function parseOutfoundLead(value: unknown): OutfoundLead {
  if (!isJsonObject(value)) throw new Error("Outfound returned an invalid lead"); //not a lead at all
  const email = stringValue(value.lead_email); //the lead's address
  if (!email) throw new Error("Outfound lead is missing an email address"); //no address, unusable

  const enrichment = objectValue(value, "enrichment"); //person details, or null
  const company = enrichment ? objectValue(enrichment, "company") : null; //company details, or null

  const conversations: OutfoundConversation[] = []; //conversations from every client
  for (const client of arrayValue(value, "clients")) { //each client that worked the lead
    if (!isJsonObject(client)) continue; //not an object, skip
    for (const entry of arrayValue(client, "recent_conversations")) { //each of its conversations
      const conversation = parseConversation(entry); //read it, or null
      if (conversation) conversations.push(conversation); //keep the readable ones
    }
  }

  return {
    email, //same as email: email
    firstName: stringValue(enrichment?.first_name), //null when blank
    lastName: stringValue(enrichment?.last_name), //null when blank
    jobTitle: stringValue(enrichment?.title), //null when blank
    seniority: stringValue(enrichment?.seniority), //null when blank
    linkedin: stringValue(enrichment?.person_linkedin), //null when blank
    companyName: stringValue(company?.company_name), //null when blank
    companyDomain: stringValue(company?.company_domain), //null when blank
    companyLinkedin: stringValue(company?.company_linkedin), //null when blank
    location: stringValue(company?.location), //null when blank
    industry: stringValue(company?.industry), //null when blank
    headcount: stringValue(company?.headcount), //null when blank
    revenue: stringValue(company?.revenue), //null when blank
    conversations, //same as conversations: conversations
  };
}
//#endregion

//#region <look up a lead>
//---------------------------------------------------------------------------------------------------------
//Finds the lead behind an address, with their enrichment and recent conversations.
//Input: email - the lead's address.
//Output: the lead, or null when Outfound holds nothing on them. Throws if the request fails.
//Uses: outfoundFetch, parseOutfoundLead, describeOutfoundLead (this file).
//Workflow: outfound-interested route step 3 (enrichFromOutfound) - enrichment plus the thread for the note.
//Also interested workflow (recordInterestedLead) step 6 - the "outfound DNC" channel (lib/providers.ts) finds
//a thread to mark.
//
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
//---------------------------------------------------------------------------------------------------------
export async function fetchOutfoundLead(email: string): Promise<OutfoundLead | null> {
  const params = new URLSearchParams({ email }); //the address as a query string
  const body = await outfoundFetch(`/prospects/lookup/conversations?${params}`); //look the lead up
  if (!isJsonObject(body)) throw new Error("Outfound lead lookup response is invalid"); //unexpected shape
  //The echoed lead_email proves nothing, so it is not what is tested - see above.
  const hasEnrichment = objectValue(body, "enrichment") !== null; //outfound has details on them
  const hasClients = arrayValue(body, "clients").length > 0; //someone has emailed them
  if (!hasEnrichment && !hasClients) { //neither, so a miss
    console.log(`[lookup] outfound lead ${email}: no match, so nothing is enriched from Outfound`); //log the miss
    return null; //no lead
  }
  const lead = parseOutfoundLead(body); //read the lead
  console.log(`[lookup] outfound lead ${email}: matched, ${describeOutfoundLead(lead)}`); //log which fields came back
  return lead; //the match
}

//---------------------------------------------------------------------------------------------------------
//Base function. Lists which enrichment fields a lead arrived with, and how many conversations, for the log.
//Input: lead - the matched lead.
//Output: text like "carrying jobTitle, industry, across 2 conversation(s)".
//Workflow: fetchOutfoundLead - the match log line.
//
//[DEBUG] Field names only - never their values, which are personal data.
//---------------------------------------------------------------------------------------------------------
function describeOutfoundLead(lead: OutfoundLead): string {
  const present = Object.entries(lead) //names of the filled fields
    .filter(([key, value]) => key !== "email" && key !== "conversations" && value !== null)
    .map(([key]) => key);
  const carrying = //the field list part of the text
    present.length > 0 ? `carrying ${present.join(", ")}` : "carrying nothing beyond the address";
  return `${carrying}, across ${lead.conversations.length} conversation(s)`; //add the conversation count
}
//#endregion

//#region <do-not-contact list>
//---------------------------------------------------------------------------------------------------------
//Marks an address do-not-contact, so no connected sequencer mails it again.
//Input: threadHash - any thread the lead is in; email - the lead's address, for the log.
//Output: nothing. Throws if Outfound refuses.
//Uses: outfoundFetch (this file); errorMessage (lib/json.ts).
//Workflow: interested workflow (recordInterestedLead) step 6 - the "outfound DNC" channel (lib/providers.ts)
//of suppressInterestedLead (lib/interested.ts).
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
    await outfoundFetch(`/email-inbox/threads/${encodeURIComponent(threadHash)}/mark-as-dnc`, { //mark the thread DNC
      method: "PUT", //this call is a PUT
      body: JSON.stringify({ dnc_type: "email" }), //suppress the address, not the domain
    });
    console.log(`[action] outfound DNC: added ${email}`); //log the success
  } catch (error) {
    console.error(`[action] FAILED - outfound DNC could not add ${email}: ${errorMessage(error)}`); //log the failure
    throw error; //let the caller record it
  }
}
//#endregion

//#endregion
//=============================================================================================================
