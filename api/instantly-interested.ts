//=============================================================================================================
//#region <import statements>

import { findPersonByEmail } from "../lib/attio.js"; //attio person lookup by email
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js"; //auth check and response helpers
import { //the shared interested workflow
  interestedLead,
  recordInterestedLead,
  type InterestedLead,
} from "../lib/interested.js";
import { //instantly readers and their types
  fetchInstantlyEmails,
  fetchInstantlyLead,
  InstantlyRateLimitError,
  type InstantlyEmail,
  type InstantlyLead,
} from "../lib/instantly.js";
import { errorMessage, isJsonObject, stringValue } from "../lib/json.js"; //safe readers for unknown json
import { toE164 } from "../lib/phone.js"; //phone number to "+15551234567" form

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//The fields this route reads off Instantly's webhook body.
export interface InstantlyInterestedFields {
  readonly eventType: string; //e.g. "lead_interested"
  readonly email: string; //the lead's email
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly companyName: string | null; //lead's company
  readonly campaignName: string | null; //the Instantly campaign it came from
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <RUN>

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. Instantly posts here when a lead is marked interested.
//Input: request - the incoming HTTP request from Instantly.
//Output: 401 if the secret is wrong; 200 "skipped" for other events; 200 with the person, deal, company and
//suppression results; 500 on any failure.
//Uses: parseInstantlyInterestedWebhook, enrichFromInstantly, instantlyLead, formatInstantlyThread (this file);
//findPersonByEmail (lib/attio.ts); hasWebhookSecret, json, requestJson, serverError (lib/http.ts);
//recordInterestedLead (lib/interested.ts); fetchInstantlyEmails (lib/instantly.ts); errorMessage (lib/json.ts).
//Workflow: instantly-interested webhook - the entry point. Steps 1-5 are marked inline; step 5 hands off to
//recordInterestedLead.
//
//Step 3 exists because Instantly sends opens and replies to the same URL.
//
//[SECURITY] Step 1 precedes the body read, so an unauthenticated caller never reaches the parser.
//[STABILITY] Step 5 is a series of Attio calls with no transaction. A throw partway leaves earlier writes
//committed and returns 500. Instantly's retry no longer duplicates the notes as a matter of course - the repeat
//check in recordInterestedLead declines an event whose note is already on the Person from inside
//INTERESTED_DUPLICATE_WINDOW_MS - but a retry landing after that window, or one arriving while the note
//listing cannot be read, is still recorded a second time. The check narrows this; it does not remove it.
//[DEBUG] `emailCount` is assigned inside the history thunk because only that closure sees the thread. The
//thunk is awaited inside recordInterestedLead before this function reads it back, so the count is settled.
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "INSTANTLY_WEBHOOK_SECRET")) { //step 1: wrong or missing secret
    return json({ error: "Unauthorized" }, 401); //reject the caller
  }
  try {
    const fields = parseInstantlyInterestedWebhook(await requestJson(request)); //step 2: read the body
    //[DEBUG] Named rather than silent, so an untracked event type is visible as a decision in the log.
    if (fields.eventType !== "lead_interested") { //step 3: not an interested event
      console.log( //log the skipped event
        `[route] instantly-interested: skipped - event ${JSON.stringify(fields.eventType)} is not "lead_interested"`,
      );
      return json({ skipped: true, reason: "event not tracked" }); //200, so Instantly does not resend
    }
    console.log(`[route] instantly-interested: handling lead_interested for ${fields.email}`); //log the lead being handled

    const enriched = await enrichFromInstantly(fields.email); //step 4: the lead record, or null
    let emailCount = 0; //emails in the thread, for the log

    const outcome = await recordInterestedLead({ //step 5: the shared interested workflow
      lead: instantlyLead(fields, enriched, Date.now()), //the lead to record
      subject: "instantly-interested", //names this run in the logs
      findPerson: () => findPersonByEmail(fields.email), //how to find the existing person
      history: async () => { //the note body
        //[STABILITY] A throttled thread read costs the history, never the lead. Instantly's allowance is 20
        //requests a minute across the whole key, and the touchpoint sync spends up to fifteen of them a run
        //while a backlog drains - so an interested webhook arriving mid-drain can be refused through no fault
        //of its own. Raising here would 500 the webhook and lose the lead until Instantly retried it, to save
        //a note body. The lead is the part worth keeping; the thread stays readable in Instantly.
        try {
          //Unbounded by time - the whole thread for this lead, paginated. Bounded in practice by one lead's volume.
          const emails = await fetchInstantlyEmails({ leadEmail: fields.email }); //every email with this lead
          emailCount = emails.length; //remember the count for the log
          return formatInstantlyThread(emails, fields.campaignName); //the thread as note text
        } catch (error) {
          if (!(error instanceof InstantlyRateLimitError)) throw error; //real failures still fail
          console.warn( //log the lost history
            `[route] instantly-interested: the thread for ${fields.email} could not be read - ${errorMessage(error)}. The lead is recorded without it.`,
          );
          //Said plainly rather than reusing formatInstantlyThread's empty-thread text, which would claim there
          //is no history when the truth is that it could not be read - a difference that matters to whoever
          //opens the note looking for the reply.
          return `The email history could not be read from Instantly when this lead was recorded, because the API rate limit had been reached. It is not lost - the thread is still in Instantly.${fields.campaignName ? `

Campaign: ${fields.campaignName}` : ""}`;
        }
      },
    });

    console.log( //log how the run ended
      outcome.duplicate
        ? `[route] instantly-interested: declined as a repeat, ${emailCount} email(s) fetched but not written`
        : `[route] instantly-interested: ${emailCount} email(s) summarised, ${outcome.suppression.failures.length} platform(s) failed to suppress`,
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
    return serverError("Instantly interested webhook error", error); //log it and reply 500
  }
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read the webhook>

//#region <parse the body>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads Instantly's flat v2 webhook body.
//Input: value - the parsed JSON body, unknown shape.
//Output: the fields. Throws if it is not an object or lacks event_type or lead_email.
//Workflow: instantly-interested webhook step 2 - reads the body. Also called by unit tests.
//
//event_type and lead_email are required; the rest is best-effort enrichment.
//---------------------------------------------------------------------------------------------------------
export function parseInstantlyInterestedWebhook(value: unknown): InstantlyInterestedFields {
  if (!isJsonObject(value)) throw new Error("Instantly webhook payload must be an object"); //not a webhook at all
  const eventType = stringValue(value.event_type); //which event fired
  const email = stringValue(value.lead_email); //the lead's email
  if (!eventType || !email) throw new Error("Instantly webhook is missing event_type or lead_email"); //both are required
  return {
    eventType, //same as eventType: eventType
    email, //same as email: email
    firstName: stringValue(value.firstName), //null when blank
    lastName: stringValue(value.lastName), //null when blank
    companyName: stringValue(value.companyName), //null when blank
    campaignName: stringValue(value.campaign_name), //null when blank
  };
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record the interested lead>

//#region <read the lead record>
//---------------------------------------------------------------------------------------------------------
//Reads the Instantly lead record for an email, without ever failing.
//Input: email - the lead's email.
//Output: the lead record, or null if the lookup failed.
//Uses: fetchInstantlyLead (lib/instantly.ts); errorMessage (lib/json.ts).
//Workflow: instantly-interested webhook step 4 - the fields the webhook does not carry.
//
//[DEBUG] Enrichment must never fail the event: the webhook alone is enough to record the lead, so a lookup
//failure is logged and swallowed rather than raised.
//---------------------------------------------------------------------------------------------------------
async function enrichFromInstantly(email: string): Promise<InstantlyLead | null> {
  try {
    return await fetchInstantlyLead(email); //the lead record
  } catch (error) {
    console.warn( //log and carry on
      `[route] instantly-interested: lead lookup for ${email} failed, so only the webhook's own fields are used - ${errorMessage(error)}`,
    );
    return null; //record the lead without it
  }
}
//#endregion

//#region <shape for attio>
//---------------------------------------------------------------------------------------------------------
//Turns the webhook fields, plus whatever the lead record adds, into the lead the workflow records.
//Input: fields - from the webhook; enriched - the lead record, or null; occurredAtMs - when it happened.
//Output: the InterestedLead, tagged as from "instantly".
//Uses: interestedLead (lib/interested.ts); toE164 (lib/phone.ts).
//Workflow: instantly-interested webhook step 5 - the lead handed to recordInterestedLead.
//
//The webhook is thin - an event type, an address, sometimes a name and a campaign. Everything else Instantly
//knows about this person (job title, LinkedIn URL, phone, industry, headcount, revenue, location, the company's
//postal address) lives on the lead record under the campaign's custom variables, which is why the route reads
//it back before mapping. Webhook values win where both carry the same field: the webhook describes the event
//that just happened, the record describes the row as uploaded.
//---------------------------------------------------------------------------------------------------------
export function instantlyLead(
  fields: InstantlyInterestedFields,
  enriched: InstantlyLead | null,
  occurredAtMs: number,
): InterestedLead {
  return interestedLead("instantly", { //build the lead, source "instantly"
    emails: [fields.email], //list of one
    //Instantly stores a phone as it was uploaded, punctuated or not; toE164 drops anything that is not a
    //dialable number rather than writing a fragment into the CRM.
    phones: [toE164(enriched?.phone ?? null)].filter((phone): phone is string => phone !== null), //one valid number, or none
    firstName: fields.firstName ?? enriched?.firstName ?? null, //webhook first, then record
    lastName: fields.lastName ?? enriched?.lastName ?? null, //webhook first, then record
    linkedin: enriched?.linkedin ?? null, //record only
    jobTitle: enriched?.jobTitle ?? null, //record only
    location: enriched?.location ?? null, //record only
    companyName: fields.companyName ?? enriched?.companyName ?? null, //webhook first, then record
    companyDomain: enriched?.companyDomain ?? null, //record only
    companyAddress: enriched?.companyAddress ?? null, //record only
    employeeCount: enriched?.employeeCount ?? null, //record only
    annualRevenue: enriched?.annualRevenue ?? null, //record only
    industry: enriched?.industry ?? null, //record only
    website: enriched?.website ?? null, //record only
    campaignName: fields.campaignName, //the Instantly campaign
    occurredAtMs, //same as occurredAtMs: occurredAtMs
  });
}
//#endregion

//#region <format the email thread>
//---------------------------------------------------------------------------------------------------------
//Base function. Writes the email thread as note text.
//Input: emails - every email with the lead; campaignName - the campaign, or null.
//Output: the emails oldest first, each with date, type, subject and body; or a "none found" line.
//Workflow: instantly-interested webhook step 5 - the history note recordInterestedLead writes (its step 4).
//Also called by unit tests.
//
//Oldest first so the note reads top to bottom. Sorted on timestampEmail, not creation order.
//---------------------------------------------------------------------------------------------------------
export function formatInstantlyThread(
  emails: readonly InstantlyEmail[],
  campaignName: string | null,
): string {
  if (emails.length === 0) { //empty thread
    return campaignName //say so, with the campaign if known
      ? `No email history found. Campaign: ${campaignName}`
      : "No email history found.";
  }
  return [...emails] //copy, sort oldest first, render, join
    .sort((left, right) => Date.parse(left.timestampEmail) - Date.parse(right.timestampEmail))
    .map(
      (email) =>
        `**${email.timestampEmail}** (${email.emailType})\n${email.subject ?? ""}\n\n${email.bodyText ?? ""}`,
    )
    .join("\n\n---\n\n");
}
//#endregion

//#endregion
//=============================================================================================================
