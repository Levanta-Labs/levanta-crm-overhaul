//=============================================================================================================
//#region <import statements>

import { credentialHint, HEYREACH_BASE, heyreachHeaders } from "./endpoints.js"; //heyreach url and login helpers
import { rateLimitWaitMs } from "./http.js"; //how long to wait after a 429
import { //safe readers for unknown json
  arrayValue,
  booleanValue,
  isJsonObject,
  numberValue,
  responseJson,
  stringValue,
} from "./json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//One LinkedIn message inside a conversation.
export interface HeyReachMessage {
  readonly createdAt: string; //when it was sent, ISO date text
  readonly body: string; //the message text, "" if empty
  readonly subject: string | null; //subject line, if any
  readonly sender: string | null; //who sent it
}

//The lead on the other side of a conversation.
export interface HeyReachProfile {
  readonly linkedInId: string | null; //linkedin's own id for the lead
  readonly profileUrl: string; //the lead's linkedin profile url
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly companyName: string | null; //lead's company
  //Everything below is enrichment the interested workflow maps onto Attio. It arrives on the correspondent
  //profile of a conversation the route already fetches for the note, so reading it costs no extra request.
  readonly position: string | null; //job title
  readonly headline: string | null; //linkedin headline
  readonly about: string | null; //linkedin "about" text
  readonly location: string | null; //where the lead is
  //HeyReach spells an address three ways and any one of them may be the only one set: what the workspace
  //entered by hand, what HeyReach enriched, and what the profile itself carried.
  readonly emailAddress: string | null; //email from the profile
  readonly enrichedEmailAddress: string | null; //email heyreach looked up
  readonly customEmailAddress: string | null; //email typed in by hand
}

//One conversation thread, with all its messages.
export interface HeyReachConversation {
  readonly id: string; //heyreach's conversation id
  readonly linkedInAccountId: number; //our linkedin account that sent it
  readonly lastMessageAt: string; //time of the newest message
  readonly profile: HeyReachProfile; //the lead in the thread
  readonly messages: readonly HeyReachMessage[]; //every message in the thread
}

//What to search conversations by: a time window, a profile, or both.
export interface HeyReachConversationQuery {
  readonly fromMs?: number; //window start, epoch milliseconds
  readonly toMs?: number; //window end, epoch milliseconds
  readonly profileUrl?: string; //only this lead's conversations
}

//What one window read returns: the conversations, and whether it was cut short.
export interface HeyReachConversationWindow {
  readonly conversations: readonly HeyReachConversation[]; //conversations read
  /** Set when pagination stopped short of the end of the window; null means it was read to the end. */
  readonly stoppedBy: "throttled" | null; //why reading stopped early, if it did
  readonly pagesRead: number; //how many pages were read
}

//---------------------------------------------------------------------------------------------------------
//What one suppression did, in the two numbers that differ. `inCampaigns` is every campaign HeyReach lists this
//lead in, live or spent; `removedFrom` is the live subset the lead was actually withdrawn from. Neither counts
//campaigns halted - a campaign is never stopped here, it carries on running for everyone else in it.
//Both are reported because they answer different questions: `inCampaigns` at zero means HeyReach has never had
//this lead, while `inCampaigns` high with `removedFrom` at zero means it had them and they had already run out.
//---------------------------------------------------------------------------------------------------------
export interface CampaignStopResult {
  readonly inCampaigns: number; //campaigns that list the lead
  readonly removedFrom: number; //live campaigns the lead was withdrawn from
}

//One campaign a lead is in, and where they stand in it.
interface HeyReachCampaign {
  readonly campaignId: number; //heyreach's campaign id
  readonly campaignStatus: string; //e.g. "IN_PROGRESS", "PAUSED"
  readonly leadStatus: string; //e.g. "InSequence", "Finished"
}

//Thrown when HeyReach keeps answering 429, so callers can tell it from other errors.
export class HeyReachRateLimitError extends Error {
  constructor(detail: string) { //detail says what was refused
    super(`HeyReach rate limit reached: ${detail}`); //the error message
    this.name = "HeyReachRateLimitError"; //name shown in logs
  }
}

const RATE_LIMIT_ATTEMPTS = 3; //tries before giving up on a 429
//Matches attioFetch's RETRY_BASE_MS, so the one backoff shape in this codebase stays one shape.
const RATE_LIMIT_BASE_MS = 500; //first wait after a 429
//[PERF] A run that spends its budget asleep has done nothing. Past this, stopping and resuming next run beats
//waiting, because the next run starts with a fresh allowance either way - see rateLimitWaitMs (lib/http.ts).
const RATE_LIMIT_MAX_WAIT_MS = 5_000; //longest single wait allowed

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <parse heyreach responses>

//#region <conversations>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads one raw message into a HeyReachMessage.
//Input: value - one entry of a conversation's "messages" array, unknown shape.
//Output: the message. Throws if it is not an object or has no valid createdAt.
//Workflow: parseHeyReachConversation - turns each message in a thread.
//---------------------------------------------------------------------------------------------------------
function parseMessage(value: unknown): HeyReachMessage {
  if (!isJsonObject(value)) throw new Error("HeyReach returned an invalid message"); //not a message at all
  const createdAt = stringValue(value.createdAt); //when it was sent
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) { //missing or not a real date
    throw new Error("HeyReach message is missing a valid createdAt timestamp"); //unusable message
  }
  return {
    createdAt, //same as createdAt: createdAt
    body: stringValue(value.body) ?? "", //missing text becomes ""
    subject: stringValue(value.subject), //null when blank
    sender: stringValue(value.sender), //null when blank
  };
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads a conversation's raw correspondent profile into a HeyReachProfile.
//Input: value - the conversation's "correspondentProfile" field, unknown shape.
//Output: the profile. Throws if it is missing or has no profileUrl.
//Workflow: parseHeyReachConversation - fills the conversation's profile.
//---------------------------------------------------------------------------------------------------------
function parseProfile(value: unknown): HeyReachProfile {
  if (!isJsonObject(value)) throw new Error("HeyReach conversation is missing correspondentProfile"); //no profile
  const profileUrl = stringValue(value.profileUrl); //the lead's profile url
  if (!profileUrl) throw new Error("HeyReach correspondent profile is missing profileUrl"); //no url, unusable
  return {
    linkedInId: stringValue(value.linkedin_id), //null when blank
    profileUrl, //same as profileUrl: profileUrl
    firstName: stringValue(value.firstName), //null when blank
    lastName: stringValue(value.lastName), //null when blank
    companyName: stringValue(value.companyName), //null when blank
    position: stringValue(value.position), //null when blank
    headline: stringValue(value.headline), //null when blank
    about: stringValue(value.about), //null when blank
    location: stringValue(value.location), //null when blank
    emailAddress: stringValue(value.emailAddress), //null when blank
    enrichedEmailAddress: stringValue(value.enrichedEmailAddress), //null when blank
    customEmailAddress: stringValue(value.customEmailAddress), //null when blank
  };
}

//---------------------------------------------------------------------------------------------------------
//Reads one raw conversation from the HeyReach API into a HeyReachConversation.
//Input: value - one conversation object from HeyReach, unknown shape.
//Output: the conversation. Throws if it has no id, account or lastMessageAt, or a part fails to parse.
//Uses: parseProfile, parseMessage (this file).
//Workflow: fetchHeyReachConversationWindow - every conversation read goes through here.
//---------------------------------------------------------------------------------------------------------
export function parseHeyReachConversation(value: unknown): HeyReachConversation {
  if (!isJsonObject(value)) throw new Error("HeyReach returned an invalid conversation"); //not a conversation
  const id = stringValue(value.id); //the conversation's id
  const linkedInAccountId = numberValue(value.linkedInAccountId); //our sending account
  const lastMessageAt = stringValue(value.lastMessageAt); //newest message time
  if (!id || linkedInAccountId === null || !lastMessageAt) { //any of the three missing
    throw new Error("HeyReach conversation is missing id, account, or timestamp"); //unusable conversation
  }
  return {
    id, //same as id: id
    linkedInAccountId, //same as linkedInAccountId: linkedInAccountId
    lastMessageAt, //same as lastMessageAt: lastMessageAt
    profile: parseProfile(value.correspondentProfile), //the lead in the thread
    messages: arrayValue(value, "messages").map(parseMessage), //every message in the thread
  };
}
//#endregion

//#region <campaigns>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads one raw campaign entry into a HeyReachCampaign.
//Input: value - one entry of the "items" array from GetCampaignsForLead, unknown shape.
//Output: the campaign. Throws if it is not an object or lacks id or either status.
//Workflow: stopLeadInActiveCampaigns - turns the lead's campaign list.
//---------------------------------------------------------------------------------------------------------
function parseCampaign(value: unknown): HeyReachCampaign {
  if (!isJsonObject(value)) throw new Error("HeyReach returned an invalid campaign"); //not a campaign
  const campaignId = numberValue(value.campaignId); //the campaign's id
  const campaignStatus = stringValue(value.campaignStatus); //is the campaign running
  const leadStatus = stringValue(value.leadStatus); //where the lead is in it
  if (campaignId === null || !campaignStatus || !leadStatus) { //any of the three missing
    throw new Error("HeyReach campaign is missing required fields"); //unusable campaign
  }
  return { campaignId, campaignStatus, leadStatus }; //shorthand for name: name fields
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <heyreach transport>

//Rate limiting.
//
//HeyReach refuses with 429 once the key's allowance is spent, and the allowance is shared across every
//endpoint rather than being per-route - so the touchpoint sync's pagination, the interested route's
//conversation read and the suppression's campaign calls all draw on the same pool.
//
//[STABILITY] WHY A RETRY AND NOT A SELF-IMPOSED CAP. HeyReach was probed live and answers 200 with no
//rate-limit header of any kind, so there is no allowance to read ahead and no honest number to pace against.
//Instantly gets a page cap because its 20-per-minute ceiling is documented as a hard figure; here the
//transport can only react to the refusal when it arrives. A refused request was not processed, so repeating it
//cannot apply anything twice - which is what makes this safe on StopLeadInCampaign as well as on the reads.

//#region <requests>
//---------------------------------------------------------------------------------------------------------
//Sends one POST to HeyReach, retrying on 429. The only place this file calls fetch.
//Input: path - the endpoint after HEYREACH_BASE; body - the request body, sent as JSON.
//Output: the parsed JSON body. Throws HeyReachRateLimitError after 3 refusals, Error on any other failure.
//Uses: heyreachHeaders, credentialHint (lib/endpoints.ts); rateLimitWaitMs (lib/http.ts); responseJson
//(lib/json.ts).
//Workflow: every HeyReach request - fetchHeyReachConversationWindow, stopLeadInActiveCampaigns.
//
//WHY IT EXISTS AT ALL. There were three raw fetch sites here - conversations, GetCampaignsForLead and
//StopLeadInCampaign - each with its own copy of the status check. A 429 was an ordinary Error at all three,
//which in the touchpoint sync abandoned the run before its cursor was saved; the next run then re-read the
//same window and failed identically. That is not hypothetical: the Instantly sync sat in exactly that loop
//for five days. One chokepoint is what lets the retry, and the typed error below it, apply to all three.
//---------------------------------------------------------------------------------------------------------
async function heyreachFetch(path: string, body: unknown): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) { //loop until success or give up
    const response = await fetch(`${HEYREACH_BASE}${path}`, { //send the request
      method: "POST", //every heyreach call is a POST
      headers: heyreachHeaders(), //api key and json headers
      body: JSON.stringify(body), //body as json text
    });
    const parsed = await responseJson(response); //read the body as json
    if (response.ok) return parsed; //success, hand it back

    if (response.status === 429) { //heyreach says slow down
      if (attempt >= RATE_LIMIT_ATTEMPTS) { //out of tries
        throw new HeyReachRateLimitError( //give up, distinctly
          `${path} refused after ${RATE_LIMIT_ATTEMPTS} attempt(s). The allowance is shared across every HeyReach endpoint, so the touchpoint sync's pagination, the interested route and the suppression all spend it.`,
        );
      }
      const waitMs = rateLimitWaitMs(response, attempt, RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_WAIT_MS); //decide how long to wait
      console.warn( //log the retry
        `[heyreach] 429 on ${path} (attempt ${attempt} of ${RATE_LIMIT_ATTEMPTS}) - waiting ${waitMs}ms and retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs)); //sleep for waitMs
      continue; //try again
    }
    throw new Error( //any other failure: stop
      `HeyReach API error ${response.status}: ${JSON.stringify(parsed)}${credentialHint("heyreach", response.status)}`,
    );
  }
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read conversations>

//#region <conversation windows>
//---------------------------------------------------------------------------------------------------------
//Reads conversations with their full message lists, page by page, keeping what it read if HeyReach refuses.
//Input: query - a time window (fromMs, toMs), a profileUrl, or both.
//Output: { conversations, stoppedBy, pagesRead }. stoppedBy is "throttled" if HeyReach refused partway.
//Throws on any other failure, including a page that says there is more but gives no cursor.
//Uses: heyreachFetch, parseHeyReachConversation (this file).
//Workflow: heyreach touchpoint sync step 3 - the conversations the run will process (time window). Also
//fetchHeyReachConversations, for the interested route (one profile URL).
//
//[PERF] HeyReach applies from/to with DAY granularity, not to the minute: any `from` inside today returns every
//conversation touched since UTC midnight, each with its full message list, however narrow the window asked for.
//A five-minute run therefore routinely receives messages hours or days old, and the volume grows through the
//day. Rounding always goes DOWN to the start of the day, so the result over-includes and no message can slip
//past a window boundary. Deduplication is the per-message cursor check in the sync handler, not this filter.
//
//[STABILITY] A 429 RETURNS WHAT IT HAS rather than throwing it away, once heyreachFetch has exhausted its
//retries. The pages already read are real conversations the caller can process, and discarding them is what
//wedged the Instantly sync for five days: the throw came from the fetch, before the loop, so the run
//abandoned before saving its cursor and every later run repeated it exactly. The caller is told the window is
//incomplete so it knows not to park its cursor at the end of it.
//Any other failure still throws: a 500 or a malformed page says nothing about how much of the window exists,
//and treating the part already read as the whole of it would step over the rest for good.
//---------------------------------------------------------------------------------------------------------
export async function fetchHeyReachConversationWindow(
  query: HeyReachConversationQuery,
): Promise<HeyReachConversationWindow> {
  const conversations: HeyReachConversation[] = []; //every conversation read so far
  let cursor: string | null = null; //next page's cursor; null for the first
  let pagesRead = 0; //pages read so far

  do { //read pages until no cursor is left
    let body: unknown; //this page's response
    try {
      body = await heyreachFetch("/inbox/GetConversationsV3", { //read one page
        limit: 100, //conversations per page
        cursor, //same as cursor: cursor
        ...(query.fromMs !== undefined ? { from: new Date(query.fromMs).toISOString() } : {}), //add "from" only if given
        ...(query.toMs !== undefined ? { to: new Date(query.toMs).toISOString() } : {}), //add "to" only if given
        //Every filter must be present even when unused; the API rejects a partial filters block.
        filters: { //search filters
          linkedInAccountIds: [], //all our accounts
          campaignIds: [], //all campaigns
          searchString: "", //no text search
          leadLinkedInId: null, //no linkedin id filter
          leadProfileUrl: query.profileUrl ?? null, //one lead's profile, or anyone
          tags: [], //no tag filter
          latestAutoTagNames: [], //no auto-tag filter
          seen: null, //read and unread alike
        },
      });
    } catch (error) {
      if (error instanceof HeyReachRateLimitError) { //refused after retries
        console.warn( //log what was kept
          `[heyreach] throttled after ${pagesRead} page(s) and ${conversations.length} conversation(s) - ${error.message}. What was read is kept and returned; the rest of the window is left for the next run.`,
        );
        return { conversations, stoppedBy: "throttled", pagesRead }; //return the partial read
      }
      throw error; //any other error: fail the read
    }
    pagesRead += 1; //one more page done
    if (!isJsonObject(body)) throw new Error("HeyReach conversations response is invalid"); //unexpected shape
    conversations.push(...arrayValue(body, "items").map(parseHeyReachConversation)); //add this page's conversations
    const hasNextPage = booleanValue(body.hasNextPage) ?? false; //is there another page
    cursor = hasNextPage ? stringValue(body.nextCursor) : null; //next page's cursor, or null when done
    if (hasNextPage && !cursor) throw new Error("HeyReach response omitted nextCursor"); //more pages but no way to reach them
  } while (cursor); //stop when there is no next page

  return { conversations, stoppedBy: null, pagesRead }; //the whole window was read
}

//---------------------------------------------------------------------------------------------------------
//Reads a query's conversations whole or fails: no partial results.
//Input: query - a time window, a profileUrl, or both.
//Output: every matching conversation. Throws HeyReachRateLimitError if HeyReach refused partway.
//Uses: fetchHeyReachConversationWindow (this file).
//Workflow: heyreach-interested route step 3 (through readHeyReachConversations) - the lead's thread for the note.
//
//For the interested route, whose note is one lead's thread: half a thread rendered as though it were the
//whole is a misleading note, and unlike the cron there is no cursor to resume from - the note is written once.
//---------------------------------------------------------------------------------------------------------
export async function fetchHeyReachConversations(
  query: HeyReachConversationQuery,
): Promise<readonly HeyReachConversation[]> {
  const { conversations, stoppedBy } = await fetchHeyReachConversationWindow(query); //read the window
  if (stoppedBy === "throttled") { //only part of it came back
    throw new HeyReachRateLimitError( //fail rather than return part
      `only ${conversations.length} conversation(s) could be read, and a partial thread is not written as though it were the whole`,
    );
  }
  return conversations; //the whole result
}
//#endregion

//#region <message ids>
//---------------------------------------------------------------------------------------------------------
//Base function. Builds a stable id for one message, since HeyReach gives messages none.
//Input: conversation - the thread the message is in; message - the message.
//Output: a SHA-256 hash of the message's defining fields, as hex text.
//Workflow: heyreach touchpoint sync step 4 - heyReachTouchpointEvents gives each message its cursor id.
//
//The cursor needs an id to tell events apart at the same timestamp, so the identity is a SHA-256 of the fields
//that define the message. Deterministic across runs, which is what makes it usable as a duplicate key; two
//byte-identical messages in one conversation at one instant collapse to a single event.
//---------------------------------------------------------------------------------------------------------
export async function heyReachMessageId(
  conversation: HeyReachConversation,
  message: HeyReachMessage,
): Promise<string> {
  //NUL-joined so no combination of field values can produce the same input as a different combination.
  const input = [ //the fields that define the message
    conversation.id,
    message.createdAt,
    message.sender ?? "",
    message.subject ?? "",
    message.body,
  ].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)); //hash the text
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); //bytes to hex text
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <stop outreach to a lead>

//#region <active campaigns>
//---------------------------------------------------------------------------------------------------------
//Withdraws a lead who has said yes from every HeyReach campaign still messaging them.
//Input: profileUrl - the lead's LinkedIn profile URL, or null; email - the lead's email, or null.
//Output: { inCampaigns, removedFrom } - see CampaignStopResult. Throws if any request fails.
//Uses: heyreachFetch, parseCampaign (this file).
//Workflow: interested workflow (recordInterestedLead) step 6 - the "heyreach campaigns" channel
//(lib/providers.ts) of suppressInterestedLead (lib/interested.ts).
//
//The only provider-side write in the codebase. Scoped to the one lead: StopLeadInCampaign withdraws them from a
//campaign, it does not halt the campaign.
//[STABILITY] A failed stop throws and is not retried; the caller has already written the CRM record.
//KNOWN GAP: a lead with no profile URL gets zeroes, because StopLeadInCampaign is driven by leadUrl, which an
//email-only lead does not supply. The campaign lookup would accept the email; the stop would not. Such a lead
//stays in sequence. Closing this needs the leadMemberId from the lookup's response, which parseCampaign discards.
//---------------------------------------------------------------------------------------------------------
export async function stopLeadInActiveCampaigns(
  profileUrl: string | null,
  email: string | null,
): Promise<CampaignStopResult> {
  if (!profileUrl) return { inCampaigns: 0, removedFrom: 0 }; //no url, nothing can be stopped
  const body = await heyreachFetch("/campaign/GetCampaignsForLead", { //list the lead's campaigns
    email, //same as email: email
    linkedinId: null, //not looked up by linkedin id
    profileUrl, //same as profileUrl: profileUrl
    offset: 0, //start at the first campaign
    limit: 100, //up to 100 campaigns
  });
  if (!isJsonObject(body)) throw new Error("HeyReach campaigns response is invalid"); //unexpected shape
  //Every campaign that lists the lead, before any liveness filter - the total the caller reports against.
  const listed = arrayValue(body, "items").map(parseCampaign); //all the lead's campaigns
  //Both dimensions must be live. A paused campaign still counts: it can be resumed and would resume messaging.
  //A lead already finished or replied-out of a campaign has nothing left to stop.
  const activeCampaignStatuses = new Set(["IN_PROGRESS", "PAUSED", "STARTING"]); //campaign states that still message
  const activeLeadStatuses = new Set(["Pending", "InSequence", "Paused"]); //lead states still in sequence
  const campaigns = listed //keep only live campaigns with a live lead
    .filter(
      (campaign) =>
        activeCampaignStatuses.has(campaign.campaignStatus) &&
        activeLeadStatuses.has(campaign.leadStatus),
    );

  for (const campaign of campaigns) { //each live campaign
    //[STABILITY] The one WRITE on this transport. Retrying it on a 429 is safe for the same reason it is safe
    //on Attio: a refused request was not processed, so repeating it cannot withdraw a lead twice.
    await heyreachFetch("/campaign/StopLeadInCampaign", { //withdraw the lead from it
      campaignId: campaign.campaignId, //which campaign
      leadMemberId: null, //not used; the url identifies the lead
      leadUrl: profileUrl, //the lead's profile url
    });
  }
  return { inCampaigns: listed.length, removedFrom: campaigns.length }; //both counts
}
//#endregion

//#endregion
//=============================================================================================================
