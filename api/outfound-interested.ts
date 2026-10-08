//=============================================================================================================
//#region <import statements>

import { findPersonByEmail, findPersonByLinkedIn } from "../lib/attio.js"; //attio person lookups
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js"; //auth check and response helpers
import { //the shared interested workflow
  interestedLead,
  recordInterestedLead,
  type InterestedLead,
} from "../lib/interested.js";
import { //outfound lead reader and its types
  fetchOutfoundLead,
  type OutfoundConversation,
  type OutfoundLead,
} from "../lib/outfound.js";
import { describeShape, errorMessage, isJsonObject, stringValue } from "../lib/json.js"; //safe readers for unknown json

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//The fields this route reads off Outfound's webhook body.
export interface OutfoundInterestedFields {
  //The lead category that fired the relay, verbatim - "Interested", "Meeting Booked", "Refer Request".
  readonly eventType: string | null; //the lead category, for the log
  readonly email: string; //the lead's email
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly companyName: string | null; //lead's company
  readonly companyDomain: string | null; //company's web domain
  readonly jobTitle: string | null; //lead's job title
  readonly linkedin: string | null; //lead's LinkedIn URL
  readonly website: string | null; //company website
  readonly industry: string | null; //company's industry
  readonly campaignName: string | null; //the Outfound campaign it came from
  //ISO 8601, as Outfound timed the event. Preferred over the receiving clock - see outfoundOccurredAtMs.
  readonly timestamp: string | null; //when the event happened
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <RUN>

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. Outfound's Webhook Relay posts here when a lead is categorized.
//Input: request - the incoming HTTP request from the Outfound relay.
//Output: 401 if the secret is wrong; 200 with the person, deal, company and suppression results; 500 on any
//failure.
//Uses: parseOutfoundInterestedWebhook, enrichFromOutfound, outfoundLead, outfoundOccurredAtMs,
//formatOutfoundThread (this file); findPersonByEmail, findPersonByLinkedIn (lib/attio.ts); hasWebhookSecret,
//json, requestJson, serverError (lib/http.ts); recordInterestedLead (lib/interested.ts).
//Workflow: outfound-interested webhook - the entry point. Steps 1-4 are marked inline; step 4 hands off to
//recordInterestedLead.
//
//Step 3 reads the lead record back for the fields the webhook does not carry, AND for the thread the note is
//rendered from - one request answers both.
//
//NO EVENT FILTER. Unlike the Instantly route, which drops anything that is not `lead_interested`, every
//authenticated body that parses is recorded here - see parseOutfoundInterestedWebhook for why.
//
//[SECURITY] Step 1 precedes the body read, so an unauthenticated caller never reaches the parser.
//[STABILITY] Step 4 is a series of Attio calls with no transaction. A throw partway leaves earlier writes
//committed and returns 500. An Outfound retry no longer duplicates the notes as a matter of course - the
//repeat check in recordInterestedLead declines an event whose note is already on the Person from inside
//INTERESTED_DUPLICATE_WINDOW_MS - but a retry landing after that window, or one arriving while the note
//listing cannot be read, is still recorded a second time. The check narrows this; it does not remove it.
//[DEBUG] `historyCount` is assigned inside the history thunk because only that closure sees the thread. The
//thunk is awaited inside recordInterestedLead before this function reads it back, so the count is settled.
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "OUTFOUND_WEBHOOK_SECRET")) { //step 1: wrong or missing secret
    return json({ error: "Unauthorized" }, 401); //reject the caller
  }
  try {
    const fields = parseOutfoundInterestedWebhook(await requestJson(request)); //step 2: read the body
    //[DEBUG] The category is named here and nowhere else. It is not written to Attio - every category that
    //reaches this route is treated identically - but without it in the log there is no way to tell which tag
    //fired a given run, and the tags are edited on Outfound's side without a deploy to mark the change.
    //
    //[STABILITY] THIS LINE MUST STAY ABOVE recordInterestedLead. The run transcript (lib/run-log.ts) mirrors
    //console output into a note on the Person, Company and Deal, but only while a run scope is open - and
    //recordInterestedLead is what opens one. Printing the category here keeps it in the Vercel log and out of
    //Attio, which is the requirement. Moved below, or printed again inside the workflow, and the category name
    //silently starts appearing on three CRM records. tests/unit/interested-handlers.test.ts asserts it does not.
    console.log( //log the category and the lead
      `[route] outfound-interested: handling ${JSON.stringify(fields.eventType ?? "an uncategorised event")} for ${fields.email}`,
    );

    const enriched = await enrichFromOutfound(fields.email); //step 3: lead record and thread, or null
    let historyCount = 0; //conversations in the thread, for the log

    const outcome = await recordInterestedLead({ //step 4: the shared interested workflow
      lead: outfoundLead(fields, enriched, outfoundOccurredAtMs(fields.timestamp, Date.now())), //the lead to record
      subject: "outfound-interested", //names this run in the logs
      //Address first: it is the identifier Outfound always carries, and lead_email is required of the payload.
      //The LinkedIn URL is a fallback for a person Attio holds under a profile but not under this address.
      findPerson: async () => //how to find the existing person
        (await findPersonByEmail(fields.email)) ??
        (await findPersonByLinkedIn(fields.linkedin ?? enriched?.linkedin ?? null)),
      history: async () => { //the note body
        //Already fetched at step 3 - the lookup returns the conversations alongside the enrichment, so the
        //thread costs no request of its own here.
        const conversations = enriched?.conversations ?? []; //the thread, or empty
        historyCount = conversations.length; //remember the count for the log
        return formatOutfoundThread(conversations, fields.campaignName); //the thread as note text
      },
    });

    console.log( //log how the run ended
      outcome.duplicate
        ? `[route] outfound-interested: declined as a repeat, ${historyCount} conversation(s) fetched but not written`
        : `[route] outfound-interested: ${historyCount} conversation(s) summarised, ${outcome.suppression.failures.length} platform(s) failed to suppress`,
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
    return serverError("Outfound interested webhook error", error); //log it and reply 500
  }
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read the webhook>

//#region <parse the body>
//---------------------------------------------------------------------------------------------------------
//Reads Outfound's flat webhook body. Only lead_email is required of it here.
//Input: value - the parsed JSON body, unknown shape.
//Output: the fields. Throws if it is not an object or has no lead_email.
//Uses: describeShape (lib/json.ts).
//Workflow: outfound-interested webhook step 2 - reads the body.
//
//NO CATEGORY IS FILTERED ON, deliberately. Which lead categories fire the relay is configured on Outfound's
//side, under the Webhook Relay's own category checkboxes, and only positive-sentiment categories are forwarded
//at all. Restating that list here would mean two places to edit and a redeploy to change one of them, so
//everything that arrives authenticated and parseable is recorded. The category is logged, never written.
//
//`event_type` is therefore read for the log alone, and its absence is not an error: the relay carries the
//category name in it, but a body without one is still a lead worth recording.
//---------------------------------------------------------------------------------------------------------
export function parseOutfoundInterestedWebhook(value: unknown): OutfoundInterestedFields {
  if (!isJsonObject(value)) throw new Error("Outfound webhook payload must be an object"); //not a webhook at all
  const email = stringValue(value.lead_email); //the lead's email
  if (!email) { //no email, nothing to record
    //[DEBUG][SECURITY] describeShape reports keys and types only, never values, so a payload that does not match
    //what the spec described can be diagnosed from the log without recording anybody's name or message text.
    //Worth the lines on this provider in particular: the API is private, the relay's payload is not versioned,
    //and a silent shape change would otherwise surface only as a bare "missing lead_email" with nothing to act on.
    const shape = describeShape(value); //keys and types, no values
    console.error( //log the rejected shape
      `[route] outfound-interested: rejected - no lead_email on the payload, which is the one field there is nothing to record without. Payload shape was ${shape}`,
    );
    throw new Error(`Outfound webhook is missing lead_email. Payload shape was ${shape}`); //fail the request
  }
  return {
    //category_name and event_type carry the same string; event_type is the documented one, so it leads.
    eventType: stringValue(value.event_type) ?? stringValue(value.category_name), //either spelling
    email, //same as email: email
    firstName: stringValue(value.first_name), //null when blank
    lastName: stringValue(value.last_name), //null when blank
    companyName: stringValue(value.company_name), //null when blank
    companyDomain: stringValue(value.company_domain), //null when blank
    jobTitle: stringValue(value.job_title), //null when blank
    linkedin: stringValue(value.linkedin), //null when blank
    website: stringValue(value.website), //null when blank
    industry: stringValue(value.industry), //null when blank
    campaignName: stringValue(value.campaign_name), //null when blank
    timestamp: stringValue(value.timestamp), //null when blank
  };
}
//#endregion

//#region <event time>
//---------------------------------------------------------------------------------------------------------
//Base function. Works out when the event happened, by Outfound's clock rather than ours.
//Input: timestamp - Outfound's ISO 8601 time, or null; nowMs - the current time, epoch milliseconds.
//Output: the event time in epoch milliseconds; nowMs when timestamp is missing or unreadable.
//Workflow: outfound-interested webhook step 4 - the lead's occurredAtMs.
//
//[LOGIC] The warehouse lags by minutes, so the receiving clock would date an interested lead by when the relay
//got through rather than when they replied. An unparseable or absent timestamp falls back to `nowMs` - a
//slightly late date beats no date at all.
//---------------------------------------------------------------------------------------------------------
export function outfoundOccurredAtMs(timestamp: string | null, nowMs: number): number {
  if (!timestamp) return nowMs; //no timestamp, use now
  const parsed = Date.parse(timestamp); //text to milliseconds, NaN if unreadable
  return Number.isFinite(parsed) ? parsed : nowMs; //parsed time, else now
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record the interested lead>

//#region <read the lead record>
//---------------------------------------------------------------------------------------------------------
//Reads the Outfound lead record (with its conversations) for an email, without ever failing.
//Input: email - the lead's email.
//Output: the lead record, or null if the lookup failed.
//Uses: fetchOutfoundLead (lib/outfound.ts); errorMessage (lib/json.ts).
//Workflow: outfound-interested webhook step 3 - the extra fields and the thread for the note.
//
//[DEBUG] Enrichment must never fail the event: the webhook alone is enough to record the lead, so a lookup
//failure is logged and swallowed rather than raised. It also supplies the note's history, which is why a
//failure here costs the thread as well as the extra fields - formatOutfoundThread then renders the empty case.
//---------------------------------------------------------------------------------------------------------
async function enrichFromOutfound(email: string): Promise<OutfoundLead | null> {
  try {
    return await fetchOutfoundLead(email); //the lead record and its thread
  } catch (error) {
    console.warn( //log and carry on
      `[route] outfound-interested: lead lookup for ${email} failed, so only the webhook's own fields are used and the note carries no history - ${errorMessage(error)}`,
    );
    return null; //record the lead without it
  }
}
//#endregion

//#region <shape for attio>
//---------------------------------------------------------------------------------------------------------
//Turns the webhook fields, plus whatever the lead record adds, into the lead the workflow records.
//Input: fields - from the webhook; enriched - the lead record, or null; occurredAtMs - when it happened.
//Output: the InterestedLead, tagged as from "outfound".
//Uses: interestedLead (lib/interested.ts).
//Workflow: outfound-interested webhook step 4 - the lead handed to recordInterestedLead.
//
//Outfound's webhook is the richest of the three - it already carries the name, company, domain, job title,
//LinkedIn URL, website and industry, where Instantly's carries an address and little else. The lookup is still
//worth its request: seniority, the company's headcount, revenue and country come only from there.
//Webhook values win where both carry the same field: the webhook describes the event that just happened, the
//record describes the row as the warehouse holds it.
//
//No phone. Outfound's enrichment has no phone number anywhere in it, so nothing is mapped to Attio's - which is
//why this route, unlike Instantly's, needs no toE164 (lib/phone.ts).
//---------------------------------------------------------------------------------------------------------
export function outfoundLead(
  fields: OutfoundInterestedFields,
  enriched: OutfoundLead | null,
  occurredAtMs: number,
): InterestedLead {
  return interestedLead("outfound", { //build the lead, source "outfound"
    emails: [fields.email], //list of one
    firstName: fields.firstName ?? enriched?.firstName ?? null, //webhook first, then record
    lastName: fields.lastName ?? enriched?.lastName ?? null, //webhook first, then record
    linkedin: fields.linkedin ?? enriched?.linkedin ?? null, //webhook first, then record
    jobTitle: fields.jobTitle ?? enriched?.jobTitle ?? null, //webhook first, then record
    //Outfound's location is an ISO 3166-1 alpha-2 country code on the COMPANY, not a place on the person, and
    //companyAddress is left null for the same reason: parsePostalAddress (lib/interested.ts) needs an address,
    //and "US" is not one. The country still reads correctly as a Person location, which is where it goes.
    location: enriched?.location ?? null, //company's country code
    companyName: fields.companyName ?? enriched?.companyName ?? null, //webhook first, then record
    companyDomain: fields.companyDomain ?? enriched?.companyDomain ?? null, //webhook first, then record
    employeeCount: enriched?.headcount ?? null, //record only
    annualRevenue: enriched?.revenue ?? null, //record only
    industry: fields.industry ?? enriched?.industry ?? null, //webhook first, then record
    website: fields.website ?? null, //webhook only
    campaignName: fields.campaignName, //the Outfound campaign
    occurredAtMs, //same as occurredAtMs: occurredAtMs
  });
}
//#endregion

//#region <format the email thread>
//---------------------------------------------------------------------------------------------------------
//Base function. Writes the email thread as note text.
//Input: conversations - every email with the lead; campaignName - the campaign, or null.
//Output: the emails oldest first, each with date, type, subject and body; or a "none found" line.
//Workflow: outfound-interested webhook step 4 - the history note recordInterestedLead writes (its step 4).
//
//Oldest first so the note reads top to bottom. Sorted on the email timestamp.
//---------------------------------------------------------------------------------------------------------
export function formatOutfoundThread(
  conversations: readonly OutfoundConversation[],
  campaignName: string | null,
): string {
  if (conversations.length === 0) { //empty thread
    return campaignName //say so, with the campaign if known
      ? `No email history found. Campaign: ${campaignName}`
      : "No email history found.";
  }
  return [...conversations] //copy, sort oldest first, render, join
    .sort((left, right) => Date.parse(left.timestampEmail) - Date.parse(right.timestampEmail))
    .map(
      (conversation) =>
        `**${conversation.timestampEmail}** (${conversation.conversationType})\n${conversation.subject ?? ""}\n\n${conversation.body ?? ""}`,
    )
    .join("\n\n---\n\n");
}
//#endregion

//#endregion
//=============================================================================================================
