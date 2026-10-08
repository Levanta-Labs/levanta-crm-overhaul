//=============================================================================================================
//#region <import statements>

import { findPersonByEmail, findPersonByLinkedIn } from "../lib/attio.js"; //attio person lookups
import { //heyreach conversation reader and its types
  fetchHeyReachConversations,
  HeyReachRateLimitError,
  type HeyReachConversation,
  type HeyReachMessage,
  type HeyReachProfile,
} from "../lib/heyreach.js";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js"; //auth check and response helpers
import { //the shared interested workflow
  interestedLead,
  recordInterestedLead,
  type InterestedLead,
} from "../lib/interested.js";
import { describeShape, errorMessage, isJsonObject, stringValue, type JsonObject } from "../lib/json.js"; //safe readers for unknown json

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//The lead's fields as read off the webhook body.
export interface HeyReachInterestedFields {
  readonly profileUrl: string | null; //the lead's LinkedIn profile URL
  readonly email: string | null; //the lead's email
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly companyName: string | null; //lead's company
  readonly campaignName: string | null; //the HeyReach campaign it came from
}

//The relay's payload shape is not under our control and it differs by event type: a reply event nests the lead
//under `lead`, while the auto-tag events (lead auto tagged positive and its siblings) arrive flat, with the
//container name folded into every key - `leadProfileUrl` rather than `lead.profileUrl`. So keys are compared on
//their letters and digits alone, which makes `profileUrl`, `profile_url`, and `ProfileURL` one name, and every name
//below is accepted with a `lead` prefix as well.
//
//Only the lead is ever read, never the sending LinkedIn account that a HeyReach body also carries: matching on that
//URL would attach the touchpoint to the wrong person, or invent a Person record for our own sender. A container
//whose name mentions the sending side is skipped along with everything nested beneath it.

//The key names each lead field may arrive under.
const PROFILE_URL_NAMES = ["profileUrl", "linkedInUrl", "linkedInProfileUrl", "publicProfileUrl", "linkedIn"] as const; //names for the profile URL
const EMAIL_NAMES = ["email", "emailAddress", "workEmail", "businessEmail"] as const; //names for the email
const FIRST_NAME_NAMES = ["firstName", "givenName"] as const; //names for the first name
const LAST_NAME_NAMES = ["lastName", "surname", "familyName"] as const; //names for the last name
const COMPANY_NAMES = ["companyName", "company", "organization", "organizationName", "currentCompany"] as const; //names for the company
const CAMPAIGN_NAMES = ["campaignName", "campaign", "sequenceName"] as const; //names for the campaign

//[DEBUG] Not used to decide anything - the route acts on every authenticated delivery carrying a lead, and
//that is deliberate (see the POST below). These exist so the log can NAME the event, which is what tells a
//repeat apart from a genuinely separate one. Deliberately excludes a bare `type`, which is too common a key
//to read off an unknown payload without risking some unrelated field; an event spelled that way falls to the
//shape dump instead, which is where an unmapped name is supposed to show up.
const EVENT_NAMES = ["eventType", "event", "eventName", "webhookEvent", "notificationType"] as const; //names for the event type

//Keys whose object is likely to hold the lead, searched before anything else.
const LEAD_CONTAINER_NAMES = [ //names of likely lead containers
  "lead",
  "leadProfile",
  "data",
  "body",
  "payload",
  "profile",
  "correspondentProfile",
  "contact",
  "person",
  "prospect",
] as const;

//Words that mark a key as belonging to our own sending account.
const SENDING_ACCOUNT_HINTS = ["account", "sender", "mailbox", "owner", "user", "seat", "member"] as const; //skip keys containing these

//The names above, normalised and with the `lead` prefix, ready to match keys against.
const PROFILE_URL_KEYS = keySet(PROFILE_URL_NAMES); //accepted profile URL keys
const EMAIL_KEYS = keySet(EMAIL_NAMES); //accepted email keys
const FIRST_NAME_KEYS = keySet(FIRST_NAME_NAMES); //accepted first name keys
const LAST_NAME_KEYS = keySet(LAST_NAME_NAMES); //accepted last name keys
const COMPANY_KEYS = keySet(COMPANY_NAMES); //accepted company keys
const CAMPAIGN_KEYS = keySet(CAMPAIGN_NAMES); //accepted campaign keys
const EVENT_KEYS = keySet(EVENT_NAMES); //accepted event-type keys
const LEAD_CONTAINER_KEYS: ReadonlySet<string> = new Set(LEAD_CONTAINER_NAMES.map(normalizeKey)); //container keys, normalised, no prefix

//A bound on the walk below, so a payload that arrives deeply nested or self-referential cannot spin.
const MAX_CANDIDATES = 32; //most objects the walk will collect

//[LOGIC] Said plainly rather than reusing formatHeyReachThread's empty-thread text, which would claim there is
//no history when the truth is that it could not be read - a difference that matters to whoever opens the note
//looking for the reply.
const HISTORY_UNAVAILABLE = //note text when HeyReach throttled the read
  "The message history could not be read from HeyReach when this lead was recorded, because the API rate limit had been reached. It is not lost - the conversation is still in HeyReach.";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <RUN>

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. The relay posts here when a lead replies or is auto-tagged positive.
//Input: request - the incoming HTTP request from the HeyReach relay.
//Output: 401 if the secret is wrong; 200 with the person, deal, company and suppression results; 500 on any
//failure.
//Uses: parseHeyReachInterestedWebhook, heyReachEventName, readHeyReachConversations, heyReachLead,
//formatHeyReachThread (this file); findPersonByLinkedIn, findPersonByEmail (lib/attio.ts); hasWebhookSecret,
//json, requestJson, serverError (lib/http.ts); recordInterestedLead (lib/interested.ts); describeShape
//(lib/json.ts).
//Workflow: heyreach-interested webhook - the entry point. Steps 1-4 are marked inline; step 4 hands off to
//recordInterestedLead.
//
//The conversation read (step 3) also yields the correspondent profile the mapping enriches from. It is keyed on
//the profile URL only; an email-only lead gets neither.
//recordInterestedLead declines the event outright if this Person already carries a HeyReach note from inside
//the duplicate window - which is what stops one webhook registered against ALL campaigns leaving a note per
//campaign the lead is enrolled in.
//
//[SECURITY] Step 1 precedes the body read, so an unauthenticated caller never reaches the parser.
//[STABILITY] Step 4 is a series of calls with no transaction. A throw partway leaves earlier writes
//committed and returns 500. A relay's retry no longer duplicates the notes as a matter of course - the repeat
//check in recordInterestedLead declines an event whose note is already on the Person from inside
//INTERESTED_DUPLICATE_WINDOW_MS - but a retry landing after that window, or one arriving while the note
//listing cannot be read, is still recorded a second time. The check narrows this; it does not remove it.
//Ending HeyReach sequencing is no longer done here: it is one channel of suppressInterestedLead, which runs
//for every interested lead whatever platform reported it. Its known gap - a lead with no profile URL cannot be
//stopped, because StopLeadInCampaign is driven by leadUrl - now reports itself as a skipped channel.
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "HEYREACH_WEBHOOK_SECRET")) { //step 1: wrong or missing secret
    return json({ error: "Unauthorized" }, 401); //reject the caller
  }
  try {
    const payload = await requestJson(request); //read the body as json
    const fields = parseHeyReachInterestedWebhook(payload); //step 2: find the lead in it
    //[DEBUG] Every field here is either a name HeyReach chose or an identifier already in the CRM - no message
    //text, no address. describeShape reports keys and types only, and is spent solely when no event key was
    //found, which is the one case where the payload's own key names are the missing information.
    const event = heyReachEventName(payload); //event name, for the log only
    console.log( //log who, which event, which campaign
      `[route] heyreach-interested: handling ${fields.profileUrl ?? fields.email ?? "a lead with no identifier"}` +
        ` - event ${event ? JSON.stringify(event) : `unnamed, payload shape was ${describeShape(payload)}`}` +
        `, campaign ${fields.campaignName ? JSON.stringify(fields.campaignName) : "unnamed"}`,
    );

    //Fetched before the workflow rather than inside it, because the profile it carries feeds the mapping and
    //the mapping is the workflow's input. One request either way.
    const { conversations, throttled } = await readHeyReachConversations(fields.profileUrl); //step 3: read the thread
    const messages = conversations.flatMap((conversation) => conversation.messages); //all messages in one list
    //Any conversation for this lead carries the same correspondent; the first is as good as any.
    const profile = conversations[0]?.profile ?? null; //the lead's HeyReach profile, if any

    const outcome = await recordInterestedLead({ //step 4: the shared interested workflow
      lead: heyReachLead(fields, profile, Date.now()), //the lead to record
      subject: "heyreach-interested", //names this run in the logs
      //URL first: it is the identifier HeyReach always carries and the one Attio stores for LinkedIn.
      findPerson: async () => //how to find the existing person
        (await findPersonByLinkedIn(fields.profileUrl)) ?? (await findPersonByEmail(fields.email)),
      history: async () => (throttled ? HISTORY_UNAVAILABLE : formatHeyReachThread(messages)), //the note body
    });

    console.log( //log how the run ended
      outcome.duplicate
        ? `[route] heyreach-interested: declined as a repeat, ${messages.length} message(s) fetched but not written`
        : `[route] heyreach-interested: ${throttled ? "no message history - HeyReach throttled the read" : `${messages.length} message(s) summarised`}, ${outcome.suppression.failures.length} platform(s) failed to suppress`,
    );
    return json({ //reply 200 with what was written
      success: true, //the run finished
      duplicate: outcome.duplicate, //true if declined as a repeat
      personId: outcome.personId, //the Attio person
      dealId: outcome.dealId, //the Attio deal
      companyId: outcome.companyId, //the Attio company
      suppression: outcome.suppression.outcomes, //per-platform suppression results
      ...(outcome.suppression.failures.length > 0 ? { suppressionErrors: outcome.suppression.failures } : {}), //failures, only if any
    });
  } catch (error) {
    return serverError("HeyReach interested webhook error", error); //log it and reply 500
  }
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read the webhook>

//#region <find the lead>
//---------------------------------------------------------------------------------------------------------
//Extracts the lead from a payload whose shape is not under our control.
//Input: value - the parsed JSON body, unknown shape.
//Output: the lead's fields from the first object carrying a profile URL or an email. Throws if not an
//object, or if no object carries either.
//Uses: leadCandidates, readFields (this file); describeShape (lib/json.ts).
//Workflow: heyreach-interested webhook step 2 - finds the lead. Also called by unit tests.
//
//All five fields come from the SAME object, so a name is never read off one record and pinned to another.
//---------------------------------------------------------------------------------------------------------
export function parseHeyReachInterestedWebhook(value: unknown): HeyReachInterestedFields {
  if (!isJsonObject(value)) throw new Error("HeyReach webhook payload must be an object"); //not a webhook at all
  for (const candidate of leadCandidates(value)) { //each object, best first
    const fields = readFields(candidate); //read every field off this one object
    if (fields.profileUrl || fields.email) return fields; //has an identifier: this is the lead
  }
  //[DEBUG][SECURITY] describeShape reports keys and types only, never values, so an unmapped payload can be
  //diagnosed from the log without recording anybody's name, address, or message text.
  const shape = describeShape(value); //keys and types, no values
  console.error( //log what was searched for
    `[route] heyreach-interested: rejected - no lead identifier found. Looked for ${PROFILE_URL_NAMES.join(", ")} and ${EMAIL_NAMES.join(", ")} - each also accepted with a lead prefix, in any casing - on every object except the sending account. Payload shape was ${shape}`,
  );
  throw new Error( //no lead, fail the request
    `HeyReach webhook payload is missing profileUrl and email. Payload shape was ${shape}`,
  );
}

//---------------------------------------------------------------------------------------------------------
//Lists every object worth searching for the lead, best candidate first.
//Input: payload - the webhook body.
//Output: recognised lead containers, then the payload itself, then every other nested object.
//Uses: namesSendingAccount, normalizeKey (this file).
//Workflow: parseHeyReachInterestedWebhook - the order the lead is searched in.
//
//The payload itself sits after the containers and before the rest because a flat body keeps the lead's fields
//at the top level.
//[SECURITY] Any key naming the sending side is skipped along with everything beneath it, so the walk cannot
//return our own LinkedIn sender and cause a Person record to be created for it.
//[STABILITY] `seen` plus MAX_CANDIDATES bound the walk; a self-referential or deeply nested body cannot spin.
//---------------------------------------------------------------------------------------------------------
function leadCandidates(payload: JsonObject): readonly JsonObject[] {
  const containers: JsonObject[] = []; //objects under a lead-container key
  const others: JsonObject[] = []; //every other nested object
  const queue: JsonObject[] = [payload]; //objects still to look inside
  const seen = new Set<JsonObject>([payload]); //objects already queued

  while (queue.length > 0 && containers.length + others.length < MAX_CANDIDATES) { //walk until done or full
    const current = queue.shift(); //take the oldest queued object
    if (!current) break; //queue empty, stop
    for (const [key, value] of Object.entries(current)) { //each key and value in it
      if (namesSendingAccount(key)) continue; //skip our own sender's side
      //Arrays are containers, not a level of nesting: search their entries directly.
      for (const child of Array.isArray(value) ? value : [value]) { //each array entry, or the value
        if (!isJsonObject(child) || seen.has(child)) continue; //not an object, or already queued
        seen.add(child); //remember it
        queue.push(child); //look inside it later
        if (LEAD_CONTAINER_KEYS.has(normalizeKey(key))) containers.push(child); //likely lead holder
        else others.push(child); //anything else
      }
    }
  }
  return [...containers, payload, ...others]; //best candidates first
}

//---------------------------------------------------------------------------------------------------------
//Reads every lead field off one object.
//Input: source - one candidate object.
//Output: the lead's fields; any not found are null.
//Uses: firstOf (this file).
//Workflow: parseHeyReachInterestedWebhook - reads each candidate.
//---------------------------------------------------------------------------------------------------------
function readFields(source: JsonObject): HeyReachInterestedFields {
  return {
    profileUrl: firstOf(source, PROFILE_URL_KEYS), //LinkedIn profile URL
    email: firstOf(source, EMAIL_KEYS), //email address
    firstName: firstOf(source, FIRST_NAME_KEYS), //first name
    lastName: firstOf(source, LAST_NAME_KEYS), //last name
    companyName: firstOf(source, COMPANY_KEYS), //company
    campaignName: firstOf(source, CAMPAIGN_KEYS), //campaign
  };
}

//---------------------------------------------------------------------------------------------------------
//Finds the first non-empty text value whose key is one of the accepted spellings.
//Input: source - the object to read; keys - accepted key spellings, normalised.
//Output: the text, or null if no matching key has one.
//Uses: normalizeKey (this file).
//Workflow: readFields and heyReachEventName - reads one field.
//---------------------------------------------------------------------------------------------------------
function firstOf(source: JsonObject, keys: ReadonlySet<string>): string | null {
  for (const [key, value] of Object.entries(source)) { //each key and value
    if (!keys.has(normalizeKey(key))) continue; //not an accepted spelling
    const text = stringValue(value); //the value as text, or null
    if (text) return text; //found it, done
  }
  return null; //no match
}
//#endregion

//#region <match key names>
//---------------------------------------------------------------------------------------------------------
//Base function. Keeps only the lowercase letters and digits of a key.
//Input: key - a key name as spelled in the payload or in a names list.
//Output: e.g. "profile_url" -> "profileurl".
//Workflow: every key comparison in this file - keySet, firstOf, leadCandidates, namesSendingAccount.
//
//So one entry covers every casing and separator a relay might spell it with.
//---------------------------------------------------------------------------------------------------------
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, ""); //lowercase, drop everything else
}

//---------------------------------------------------------------------------------------------------------
//Builds the accepted spellings of a list of names: each on its own, and with a `lead` prefix.
//Input: names - the field's possible key names.
//Output: a set of normalised keys.
//Uses: normalizeKey (this file).
//Workflow: module load - builds the *_KEYS constants at the top of this file.
//
//The `lead` prefix is what a flattened payload adds.
//---------------------------------------------------------------------------------------------------------
function keySet(names: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>(); //collected spellings
  for (const name of names) { //each name in the list
    const normalized = normalizeKey(name); //letters and digits only
    keys.add(normalized); //plain spelling
    keys.add(`lead${normalized}`); //flattened "lead..." spelling
  }
  return keys; //all accepted spellings
}

//---------------------------------------------------------------------------------------------------------
//Says whether a key belongs to our own sending account rather than the lead.
//Input: key - a key name from the payload.
//Output: true if it contains any of SENDING_ACCOUNT_HINTS.
//Uses: normalizeKey (this file).
//Workflow: leadCandidates - skips the sender's side of the payload.
//---------------------------------------------------------------------------------------------------------
function namesSendingAccount(key: string): boolean {
  const normalized = normalizeKey(key); //letters and digits only
  return SENDING_ACCOUNT_HINTS.some((hint) => normalized.includes(hint)); //any hint word inside it
}
//#endregion

//#region <event name for logs>
//---------------------------------------------------------------------------------------------------------
//Reads what HeyReach called this delivery, off the TOP LEVEL only.
//Input: value - the parsed JSON body, unknown shape.
//Output: the event name, or null if there is none or the body is not an object.
//Uses: firstOf (this file).
//Workflow: heyreach-interested webhook, after step 2 - names the event in the log line. Also called by unit
//tests.
//
//[DEBUG] WHY IT IS LOGGED AND NOT ACTED ON. The webhook is configured in HeyReach, one event type per
//registration, and what is registered is edited there without a deploy - so the route cannot assume a name and
//stay correct. The log is where that configuration becomes visible: a burst of deliveries for one lead reads as
//either the same event name repeated (one registration firing per campaign, or a lead auto-tagged again on a
//later message) or as different names (more than one registration pointed here). Those have different fixes, and
//nothing in the payload distinguishes them once the name is discarded.
//Top level only because an event name describes the delivery, not the lead - the nested walk that finds a lead
//would happily read some unrelated `event` off a message or a campaign object.
//---------------------------------------------------------------------------------------------------------
export function heyReachEventName(value: unknown): string | null {
  return isJsonObject(value) ? firstOf(value, EVENT_KEYS) : null; //top-level event name, or null
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record the interested lead>

//#region <message history>
//---------------------------------------------------------------------------------------------------------
//Reads the lead's conversations, or nothing if HeyReach would not hand them over.
//Input: profileUrl - the lead's LinkedIn profile URL, or null.
//Output: { conversations, throttled }. throttled is true when HeyReach's rate limit refused the read. Throws
//on any other failure.
//Uses: fetchHeyReachConversations (lib/heyreach.ts); errorMessage (lib/json.ts).
//Workflow: heyreach-interested webhook step 3 - the thread for the note and the profile for the lead.
//
//[STABILITY] A throttled read costs the history, never the lead. HeyReach's allowance is one pool shared
//across every endpoint, and the touchpoint sync draws on it every five minutes with a window that grows
//through the UTC day - so an interested webhook can be refused through no fault of its own. Raising here would
//500 the webhook and lose the lead until HeyReach retried it, to save a note body and some enrichment. The
//lead is the part worth keeping; the conversation stays readable in HeyReach.
//
//This mirrors what api/instantly-interested.ts does with its own thread read, deliberately: the two routes
//have the same shape and the same failure, and one degrading while the other 500s is the kind of difference
//nobody discovers until the day it matters.
//Anything that is not a rate limit still raises - an unreachable API or a malformed page is not a reason to
//record a lead with half its detail missing and no sign that anything went wrong.
//---------------------------------------------------------------------------------------------------------
export async function readHeyReachConversations(
  profileUrl: string | null,
): Promise<{ readonly conversations: readonly HeyReachConversation[]; readonly throttled: boolean }> {
  if (!profileUrl) return { conversations: [], throttled: false }; //no URL, nothing to look up
  try {
    return { conversations: await fetchHeyReachConversations({ profileUrl }), throttled: false }; //the whole thread
  } catch (error) {
    if (!(error instanceof HeyReachRateLimitError)) throw error; //real failures still fail
    console.warn( //log the lost history
      `[route] heyreach-interested: the conversation for ${profileUrl} could not be read - ${errorMessage(error)}. The lead is recorded without it.`,
    );
    return { conversations: [], throttled: true }; //carry on without the thread
  }
}

//---------------------------------------------------------------------------------------------------------
//Base function. Writes the message thread as note text.
//Input: messages - every message with the lead.
//Output: the messages oldest first, each with its date, separated by rules; or a "none found" line.
//Workflow: heyreach-interested webhook step 4 - the history note recordInterestedLead writes (its step 4).
//Also called by unit tests.
//
//[LOGIC] Oldest first, so the note reads top to bottom.
//---------------------------------------------------------------------------------------------------------
export function formatHeyReachThread(messages: readonly HeyReachMessage[]): string {
  if (messages.length === 0) return "No message history found."; //empty thread
  return [...messages] //copy, sort oldest first, render, join
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((message) => `**${message.createdAt}**\n${message.body}`)
    .join("\n\n---\n\n");
}
//#endregion

//#region <shape for attio>
//---------------------------------------------------------------------------------------------------------
//Turns the webhook fields, plus the conversation's correspondent profile, into the lead the workflow records.
//Input: fields - from the webhook; profile - the HeyReach profile, or null; occurredAtMs - when it happened.
//Output: the InterestedLead, tagged as from "heyreach".
//Uses: interestedLead (lib/interested.ts).
//Workflow: heyreach-interested webhook step 4 - the lead handed to recordInterestedLead.
//
//That profile costs nothing extra. The route already fetches the conversation for the note, and every entry
//carries the lead's position, headline, location, company, and all three of HeyReach's address fields - which
//this route previously discarded by flat-mapping straight to `.messages`.
//Webhook values win where both carry the same field: the webhook describes the event that just happened.
//---------------------------------------------------------------------------------------------------------
export function heyReachLead(
  fields: HeyReachInterestedFields,
  profile: HeyReachProfile | null,
  occurredAtMs: number,
): InterestedLead {
  //HeyReach spells an address three ways and any of them may be the only one set. Order is confidence: what
  //the workspace entered by hand, then what HeyReach enriched, then whatever the profile itself carried.
  const emails = [ //every email found, best first
    fields.email,
    profile?.customEmailAddress ?? null,
    profile?.enrichedEmailAddress ?? null,
    profile?.emailAddress ?? null,
  ].filter((email): email is string => Boolean(email));

  return interestedLead("heyreach", { //build the lead, source "heyreach"
    emails: [...new Set(emails)], //remove duplicates, keep order
    linkedin: fields.profileUrl ?? profile?.profileUrl ?? null, //webhook first, then profile
    firstName: fields.firstName ?? profile?.firstName ?? null, //webhook first, then profile
    lastName: fields.lastName ?? profile?.lastName ?? null, //webhook first, then profile
    jobTitle: profile?.position ?? null, //profile only
    //The headline is what the person says they do; `about` is the longer version. Either beats nothing.
    description: profile?.headline ?? profile?.about ?? null, //headline, else the about text
    location: profile?.location ?? null, //profile only
    companyName: fields.companyName ?? profile?.companyName ?? null, //webhook first, then profile
    campaignName: fields.campaignName, //the HeyReach campaign
    occurredAtMs, //same as occurredAtMs: occurredAtMs
  });
}
//#endregion

//#endregion
//=============================================================================================================
