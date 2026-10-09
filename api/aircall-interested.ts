//=============================================================================================================
//#region <import statements>

import { waitUntil } from "@vercel/functions"; //keeps the function alive for background work
import { //aircall readers and the call-length formatter
  fetchAircallCall,
  fetchCampaignContact,
  formatCallDuration,
  type AircallCall,
  type AircallCampaignContact,
} from "../lib/aircall.js";
import { findPersonByEmail, findPersonByPhone } from "../lib/attio.js"; //attio person lookups
import { hasBodyToken, json, requestJson, serverError } from "../lib/http.js"; //auth check and response helpers
import { interestedLead, recordInterestedLead, type InterestedLead } from "../lib/interested.js"; //the shared interested workflow
import { errorMessage, isJsonObject, numberValue, objectValue, stringValue } from "../lib/json.js"; //safe readers for unknown json
import { toE164 } from "../lib/phone.js"; //phone number to "+15551234567" form

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//The one Aircall event this route acts on. Any other event is acknowledged and ignored.
const OUTCOME_EVENT = "outbound_campaign.outcome_recorded"; //the event name to act on

//Outcomes that count as interested, matched by ID so a rename in Aircall cannot break the match.
//Names as of 2026-10-09, from GET /v1/campaign_outcomes.
const INTERESTED_OUTCOME_IDS: ReadonlySet<string> = new Set([ //ids of the interested outcomes
  "019fd21c-357f-7c2a-b061-3b8b04a0146e", //Booked
  "019fd21c-9a1a-7fa9-b785-918b7da1d00e", //Follow Up
  "01a12122-77f5-7f67-b736-82b693ff6d22", //More Info
]);

//The parts of an outcome_recorded webhook the workflow needs.
export interface AircallOutcomeEvent {
  readonly callId: number; //the call the outcome was recorded on
  readonly campaignId: string; //UUID of the call's campaign
  readonly outcomeId: string; //UUID of a custom outcome, or a predefined code
  readonly outcomeLabel: string | null; //the outcome's name when it was recorded
}

//The whole webhook body as this route reads it. outcome is null when the data is incomplete.
export interface AircallOutcomeWebhook {
  readonly token: string | null; //Aircall's per-webhook secret
  readonly event: string | null; //e.g. "outbound_campaign.outcome_recorded"
  readonly outcome: AircallOutcomeEvent | null; //null if any required field is missing
}

//One flat view of the call and its contact, ready to map to a lead.
export interface AircallInterestedFields {
  readonly email: string | null; //campaign contact's email, else the call contact's
  readonly phones: readonly string[]; //the dialled number first, then any others. All E.164
  readonly firstName: string | null; //contact's first name
  readonly lastName: string | null; //contact's last name
  readonly companyName: string | null; //contact's company
  readonly note: string | null; //free text supplied with the contact
  readonly direction: string | null; //inbound or outbound
  readonly duration: number; //call length in seconds
  readonly outcomeLabel: string | null; //what the agent picked, e.g. "Booked"
  readonly occurredAt: number; //epoch SECONDS, when the call ended
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <RUN>

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. Aircall POSTs here for every outcome recorded on any campaign.
//Input: request - the incoming HTTP request from Aircall.
//Output: 401 if the token is wrong; 200 for ignored or accepted events; 500 if the body is not a JSON object.
//Uses: parseAircallOutcomeWebhook, isInterestedOutcome, handleInterestedOutcome (this file); hasBodyToken,
//json, requestJson, serverError (lib/http.ts).
//Workflow: aircall-interested webhook - the entry point. Steps 1-6 are marked inline; step 6 starts the
//background job that records the lead.
//
//The token is inside the body, so the body has to be read before it can be checked.
//[STABILITY] Steps 1-5 make no network call, so the reply is always inside Aircall's 5-second limit. A reply
//outside it counts as a failure; enough of them and Aircall disables the webhook.
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  try {
    const webhook = parseAircallOutcomeWebhook(await requestJson(request)); //step 1: read the body; the token is inside
    if (!hasBodyToken(webhook.token, "AIRCALL_WEBHOOK_TOKEN")) return json({ error: "Unauthorized" }, 401); //step 2: not ours

    if (webhook.event !== OUTCOME_EVENT) { //step 3: not an outcome event
      console.log(`[route] aircall-interested: ignored ${JSON.stringify(webhook.event)} - only ${OUTCOME_EVENT} is handled`); //wrong event
      return json({ ignored: true, reason: "not an outcome event" }); //200, so Aircall does not resend
    }

    const outcome = webhook.outcome; //null when fields were missing
    if (!outcome) { //step 4: required fields missing
      console.error(`[route] aircall-interested: rejected - an outcome event without call_id, campaign_id or outcome_id`); //payload changed?
      return json({ ignored: true, reason: "outcome event missing call_id, campaign_id or outcome_id" }); //200: a resend would be identical
    }

    if (!isInterestedOutcome(outcome.outcomeId)) { //step 5: not Booked, Follow Up or More Info
      console.log(`[route] aircall-interested: ignored ${JSON.stringify(outcome.outcomeLabel)} on call ${outcome.callId}`); //e.g. "No Answer"
      return json({ ignored: true, reason: "not an interested outcome" }); //most events end here
    }

    console.log(`[route] aircall-interested: handling ${JSON.stringify(outcome.outcomeLabel)} on call ${outcome.callId} in the background`); //before the reply
    waitUntil(handleInterestedOutcome(outcome)); //step 6: start the work, keep the function alive
    return json({ accepted: true, callId: outcome.callId }); //reply immediately
  } catch (error) {
    return serverError("Aircall interested webhook error", error); //body was not JSON, or not an object
  }
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read the webhook>

//#region <parse and filter>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads the webhook body into the fields this route needs.
//Input: value - the parsed JSON body, unknown shape.
//Output: { token, event, outcome }; anything missing becomes null. Throws only when it is not an object.
//Workflow: aircall-interested webhook step 1 - reads the body, including the token. Also called by unit tests.
//---------------------------------------------------------------------------------------------------------
export function parseAircallOutcomeWebhook(value: unknown): AircallOutcomeWebhook {
  if (!isJsonObject(value)) throw new Error("Aircall webhook payload must be an object"); //not a webhook at all
  const token = stringValue(value.token); //Aircall's secret for this webhook
  const event = stringValue(value.event); //which event fired
  const data = objectValue(value, "data"); //the event's own fields
  const callId = numberValue(data?.call_id); //the call the outcome is on
  const campaignId = stringValue(data?.campaign_id); //the call's campaign
  const outcomeId = stringValue(data?.outcome_id); //which outcome was picked
  if (callId === null || campaignId === null || outcomeId === null) { //any required field missing
    return { token, event, outcome: null }; //not a usable outcome
  }
  const outcomeLabel = stringValue(data?.outcome_label); //e.g. "Booked"
  return { token, event, outcome: { callId, campaignId, outcomeId, outcomeLabel } }; //everything the workflow needs
}

//---------------------------------------------------------------------------------------------------------
//Base function. Says whether an outcome counts as interested.
//Input: outcomeId - the outcome's UUID from the webhook.
//Output: true for Booked, Follow Up or More Info; false otherwise.
//Workflow: aircall-interested webhook step 5 - drops every non-interested outcome. Also called by unit tests.
//---------------------------------------------------------------------------------------------------------
export function isInterestedOutcome(outcomeId: string): boolean {
  return INTERESTED_OUTCOME_IDS.has(outcomeId); //true for Booked, Follow Up, More Info
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record the interested lead>

//#region <background job>
//---------------------------------------------------------------------------------------------------------
//Records one interested outcome in Attio, in the background after the reply.
//Input: outcome - the parsed outcome event (call, campaign, outcome).
//Output: nothing. Never throws; every failure is logged instead.
//Uses: readCampaignContact, extractAircallFields, aircallLead, buildCallHistorySummary (this file);
//fetchAircallCall (lib/aircall.ts); findPersonByEmail, findPersonByPhone (lib/attio.ts); recordInterestedLead
//(lib/interested.ts); errorMessage (lib/json.ts); toE164 (lib/phone.ts).
//Workflow: aircall-interested webhook step 6 - the background job. Its own steps 1-5 are marked inline.
//
//Runs AFTER the reply (see waitUntil in POST), so it must never throw - there is no caller left to catch it.
//---------------------------------------------------------------------------------------------------------
async function handleInterestedOutcome(outcome: AircallOutcomeEvent): Promise<void> {
  const label = `[route] aircall-interested: call ${outcome.callId}`; //prefix for every log line
  try {
    const call = await fetchAircallCall(outcome.callId); //step 1: who was dialled, and when
    const contact = await readCampaignContact(outcome.campaignId, toE164(call.rawDigits)); //step 2: name, email, company
    const fields = extractAircallFields(call, contact, outcome.outcomeLabel); //step 3: one flat view of both
    const phone = fields.phones[0] ?? null; //the dialled number leads
    if (!fields.email && !phone) { //step 4: nothing to identify the person
      console.warn(`${label}: rejected - neither an email nor a phone number, so no person can be matched or created`); //nothing to match on
      return; //write nothing
    }

    const result = await recordInterestedLead({ //step 5: the shared interested workflow
      lead: aircallLead(fields), //the lead to record
      subject: `aircall call ${call.id}`, //names this run in the logs
      //Email first, as the stronger identifier; the dialled number is the fallback.
      findPerson: async () => (await findPersonByEmail(fields.email)) ?? (await findPersonByPhone(phone)), //how to find the existing person
      //The history is the call itself - nothing more to fetch.
      history: async () => buildCallHistorySummary(fields), //the note body
    });
    if (result.duplicate) { //already recorded recently
      console.log(`${label}: declined as a repeat of an event already recorded`); //dedupe caught it
      return; //nothing written
    }
    console.log( //the success line to look for in Vercel logs
      `${label}: completed - person ${result.personId}, deal ${result.dealId}, ${result.suppression.failures.length} platform(s) failed to suppress`,
    );
  } catch (error) {
    console.error( //the one place a lost lead shows up
      `${label}: FAILED after Aircall was told OK, so it will not be resent. Recover it from GET /v1/campaigns/${outcome.campaignId}/call_outcomes if needed - ${errorMessage(error)}`,
    );
  }
}
//#endregion

//#region <gather call details>
//---------------------------------------------------------------------------------------------------------
//Reads the campaign contact for the dialled number, without ever failing.
//Input: campaignId - the campaign's UUID; phone - the dialled number, E.164, or null.
//Output: the contact, or null when there is no number, no such contact, or the lookup failed.
//Uses: fetchCampaignContact (lib/aircall.ts); errorMessage (lib/json.ts).
//Workflow: aircall-interested background job step 2 - the lead's name, email and company.
//
//Never throws: the call alone is enough to record the lead.
//---------------------------------------------------------------------------------------------------------
async function readCampaignContact(campaignId: string, phone: string | null): Promise<AircallCampaignContact | null> {
  if (!phone) return null; //no number, nothing to look up
  try {
    return await fetchCampaignContact(campaignId, phone); //null when the campaign has no such contact
  } catch (error) {
    console.warn( //log and carry on
      `[route] aircall-interested: campaign contact lookup for ${phone} failed, so only the call's own fields are used - ${errorMessage(error)}`,
    );
    return null; //record the lead without it
  }
}

//---------------------------------------------------------------------------------------------------------
//Flattens the call and its campaign contact into one set of fields.
//Input: call - the Aircall call; contact - its campaign contact, or null; outcomeLabel - the outcome's name.
//Output: the flat AircallInterestedFields.
//Uses: toE164 (lib/phone.ts).
//Workflow: aircall-interested background job step 3 - one flat view of both sources. Also called by unit tests.
//
//The campaign contact wins; the call's own address-book contact is the fallback.
//---------------------------------------------------------------------------------------------------------
export function extractAircallFields(
  call: AircallCall,
  contact: AircallCampaignContact | null,
  outcomeLabel: string | null,
): AircallInterestedFields {
  const dialled = toE164(call.rawDigits); //the number the agent dialled
  const allPhones = [dialled, contact?.phoneNumber ?? null, ...(call.contact?.phoneNumbers ?? [])]; //dialled first
  const phones = allPhones.filter((phone): phone is string => phone !== null); //drop the missing ones
  return {
    email: contact?.email ?? call.contact?.email ?? null, //campaign first, then address book
    phones: [...new Set(phones)], //remove duplicates, keep order
    firstName: contact?.firstName ?? call.contact?.firstName ?? null, //campaign first
    lastName: contact?.lastName ?? call.contact?.lastName ?? null, //campaign first
    companyName: contact?.companyName ?? call.contact?.companyName ?? null, //campaign first
    note: contact?.note ?? call.contact?.information ?? null, //campaign first
    direction: call.direction, //inbound or outbound
    duration: call.duration, //seconds
    outcomeLabel, //same as outcomeLabel: outcomeLabel
    occurredAt: call.endedAt ?? call.startedAt, //when the call finished
  };
}
//#endregion

//#region <shape for attio>
//---------------------------------------------------------------------------------------------------------
//Turns the flat call fields into the lead the shared workflow records.
//Input: fields - the flattened call and contact.
//Output: the InterestedLead, tagged as from "aircall".
//Uses: interestedLead (lib/interested.ts).
//Workflow: aircall-interested background job step 5 - the lead handed to recordInterestedLead.
//
//Aircall has no LinkedIn, job title, industry, headcount or revenue, so those stay null and are simply not
//written.
//---------------------------------------------------------------------------------------------------------
export function aircallLead(fields: AircallInterestedFields): InterestedLead {
  return interestedLead("aircall", { //build the lead, source "aircall"
    emails: fields.email ? [fields.email] : [], //list of one, or empty
    phones: fields.phones, //all known numbers
    firstName: fields.firstName, //contact's first name
    lastName: fields.lastName, //contact's last name
    companyName: fields.companyName, //contact's company
    description: fields.note, //the contact's note becomes the description
    occurredAtMs: fields.occurredAt * 1_000, //seconds to milliseconds
  });
}

//---------------------------------------------------------------------------------------------------------
//Writes the note for the Person and the Deal: what the call was and how it ended.
//Input: fields - the flattened call and contact.
//Output: the note text, one line per detail.
//Uses: formatCallDuration (lib/aircall.ts).
//Workflow: aircall-interested background job step 5 - the history note recordInterestedLead writes (its
//step 4). Also called by unit tests.
//---------------------------------------------------------------------------------------------------------
export function buildCallHistorySummary(fields: AircallInterestedFields): string {
  return [ //list the lines, then join them
    `**Aircall interaction — ${new Date(fields.occurredAt * 1_000).toISOString()}**`, //heading with the call time
    `- Direction: ${fields.direction ?? "unknown"}`, //inbound or outbound
    `- Duration: ${formatCallDuration(fields.duration)}`, //e.g. "1m 35s"
    fields.outcomeLabel ? `- Outcome: ${fields.outcomeLabel}` : null, //only when known
  ]
    .filter((line): line is string => line !== null) //drop the missing line
    .join("\n"); //one line each
}
//#endregion

//#endregion
//=============================================================================================================
