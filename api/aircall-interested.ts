//=============================================================================================================
//#region <import statements>

import { waitUntil } from "@vercel/functions";
import {
  fetchAircallCall,
  fetchCampaignContact,
  formatCallDuration,
  type AircallCall,
  type AircallCampaignContact,
} from "../lib/aircall.js";
import { findPersonByEmail, findPersonByPhone } from "../lib/attio.js";
import { hasBodyToken, json, requestJson, serverError } from "../lib/http.js";
import { interestedLead, recordInterestedLead, type InterestedLead } from "../lib/interested.js";
import { errorMessage, isJsonObject, numberValue, objectValue, stringValue } from "../lib/json.js";
import { toE164 } from "../lib/phone.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//The one Aircall event this route acts on. Any other event is acknowledged and ignored.
const OUTCOME_EVENT = "outbound_campaign.outcome_recorded";

//Outcomes that count as interested, matched by ID so a rename in Aircall cannot break the match.
//Names as of 2026-10-07, from GET /v1/campaign_outcomes.
const INTERESTED_OUTCOME_IDS: ReadonlySet<string> = new Set([
  "019fd21c-357f-7c2a-b061-3b8b04a0146e", //Booked
  "019fd21c-5b09-70fc-9356-cfd01be98477", //Connected
  "019fd77c-37b0-7a87-9565-47e77576c25b", //Referral
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
//FLOW:
// 1. parse the body - the token is inside it, so it has to be read before it can be checked.
// 2. hasBodyToken (lib/http.ts) - reject anything not from our webhook.
// 3. ignore any event that is not outcome_recorded.
// 4. ignore an outcome event missing the fields the workflow needs.
// 5. ignore any outcome that is not Booked, Connected or Referral - most events stop here.
// 6. reply 200 at once, and run handleInterestedOutcome in the background with waitUntil.
//[STABILITY] Steps 1-5 make no network call, so the reply is always inside Aircall's 5-second limit. A reply
//outside it counts as a failure; enough of them and Aircall disables the webhook.
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  try {
    const webhook = parseAircallOutcomeWebhook(await requestJson(request)); //read the body; the token is inside
    if (!hasBodyToken(webhook.token, "AIRCALL_WEBHOOK_TOKEN")) return json({ error: "Unauthorized" }, 401); //not ours

    if (webhook.event !== OUTCOME_EVENT) {
      console.log(`[route] aircall-interested: ignored ${JSON.stringify(webhook.event)} - only ${OUTCOME_EVENT} is handled`); //wrong event
      return json({ ignored: true, reason: "not an outcome event" }); //200, so Aircall does not resend
    }

    const outcome = webhook.outcome; //null when fields were missing
    if (!outcome) {
      console.error(`[route] aircall-interested: rejected - an outcome event without call_id, campaign_id or outcome_id`); //payload changed?
      return json({ ignored: true, reason: "outcome event missing call_id, campaign_id or outcome_id" }); //200: a resend would be identical
    }

    if (!isInterestedOutcome(outcome.outcomeId)) {
      console.log(`[route] aircall-interested: ignored ${JSON.stringify(outcome.outcomeLabel)} on call ${outcome.callId}`); //e.g. "No Answer"
      return json({ ignored: true, reason: "not an interested outcome" }); //most events end here
    }

    console.log(`[route] aircall-interested: handling ${JSON.stringify(outcome.outcomeLabel)} on call ${outcome.callId} in the background`); //before the reply
    waitUntil(handleInterestedOutcome(outcome)); //start the work, keep the function alive for it
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
//Reads the webhook body. Throws only when it is not an object; anything missing becomes null.
export function parseAircallOutcomeWebhook(value: unknown): AircallOutcomeWebhook {
  if (!isJsonObject(value)) throw new Error("Aircall webhook payload must be an object"); //not a webhook at all
  const token = stringValue(value.token); //Aircall's secret for this webhook
  const event = stringValue(value.event); //which event fired
  const data = objectValue(value, "data"); //the event's own fields
  const callId = numberValue(data?.call_id); //the call the outcome is on
  const campaignId = stringValue(data?.campaign_id); //the call's campaign
  const outcomeId = stringValue(data?.outcome_id); //which outcome was picked
  if (callId === null || campaignId === null || outcomeId === null) {
    return { token, event, outcome: null }; //not a usable outcome
  }
  const outcomeLabel = stringValue(data?.outcome_label); //e.g. "Booked"
  return { token, event, outcome: { callId, campaignId, outcomeId, outcomeLabel } }; //everything the workflow needs
}

//Whether an outcome counts as interested.
export function isInterestedOutcome(outcomeId: string): boolean {
  return INTERESTED_OUTCOME_IDS.has(outcomeId); //true for Booked, Connected, Referral
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record the interested lead>

//#region <background job>
//---------------------------------------------------------------------------------------------------------
//Records one interested outcome in Attio. Runs AFTER the reply (see waitUntil in POST), so it must never
//throw - there is no caller left to catch it. Every failure is logged instead.
//FLOW: 1. read the call. 2. read its campaign contact (best-effort). 3. flatten both. 4. stop if there is no
//email and no phone. 5. recordInterestedLead (lib/interested.ts), the sequence every provider runs.
//---------------------------------------------------------------------------------------------------------
async function handleInterestedOutcome(outcome: AircallOutcomeEvent): Promise<void> {
  const label = `[route] aircall-interested: call ${outcome.callId}`; //prefix for every log line
  try {
    const call = await fetchAircallCall(outcome.callId); //who was dialled, and when
    const contact = await readCampaignContact(outcome.campaignId, toE164(call.rawDigits)); //name, email, company
    const fields = extractAircallFields(call, contact, outcome.outcomeLabel); //one flat view of both
    const phone = fields.phones[0] ?? null; //the dialled number leads
    if (!fields.email && !phone) {
      console.warn(`${label}: rejected - neither an email nor a phone number, so no person can be matched or created`); //nothing to match on
      return; //write nothing
    }

    const result = await recordInterestedLead({
      lead: aircallLead(fields), //the lead to record
      subject: `aircall call ${call.id}`, //names this run in the logs
      //Email first, as the stronger identifier; the dialled number is the fallback.
      findPerson: async () => (await findPersonByEmail(fields.email)) ?? (await findPersonByPhone(phone)),
      //The history is the call itself - nothing more to fetch.
      history: async () => buildCallHistorySummary(fields),
    });
    if (result.duplicate) {
      console.log(`${label}: declined as a repeat of an event already recorded`); //dedupe caught it
      return; //nothing written
    }
    console.log(
      `${label}: completed - person ${result.personId}, deal ${result.dealId}, ${result.suppression.failures.length} platform(s) failed to suppress`,
    ); //the success line to look for in Vercel logs
  } catch (error) {
    console.error(
      `${label}: FAILED after Aircall was told OK, so it will not be resent. Recover it from GET /v1/campaigns/${outcome.campaignId}/call_outcomes if needed - ${errorMessage(error)}`,
    ); //the one place a lost lead shows up
  }
}
//#endregion

//#region <gather call details>
//Reads the campaign contact for the dialled number. Never throws: the call alone is enough to record the lead.
async function readCampaignContact(campaignId: string, phone: string | null): Promise<AircallCampaignContact | null> {
  if (!phone) return null; //no number, nothing to look up
  try {
    return await fetchCampaignContact(campaignId, phone); //null when the campaign has no such contact
  } catch (error) {
    console.warn(
      `[route] aircall-interested: campaign contact lookup for ${phone} failed, so only the call's own fields are used - ${errorMessage(error)}`,
    ); //log and carry on
    return null; //record the lead without it
  }
}

//Flattens the call and its campaign contact into one set of fields. The campaign contact wins; the call's own
//address-book contact is the fallback.
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
//The lead as the shared workflow sees it. Aircall has no LinkedIn, job title, industry, headcount or revenue,
//so those stay null and are simply not written.
export function aircallLead(fields: AircallInterestedFields): InterestedLead {
  return interestedLead("aircall", {
    emails: fields.email ? [fields.email] : [], //list of one, or empty
    phones: fields.phones, //all known numbers
    firstName: fields.firstName,
    lastName: fields.lastName,
    companyName: fields.companyName,
    description: fields.note, //the contact's note becomes the description
    occurredAtMs: fields.occurredAt * 1_000, //seconds to milliseconds
  });
}

//The note written to the Person and the Deal: what the call was and how it ended.
export function buildCallHistorySummary(fields: AircallInterestedFields): string {
  return [
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
