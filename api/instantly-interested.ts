//imports======================================================================================================

import { findPersonByEmail } from "../lib/attio.js";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js";
import {
  interestedLead,
  recordInterestedLead,
  type InterestedLead,
} from "../lib/interested.js";
import {
  fetchInstantlyEmails,
  fetchInstantlyLead,
  InstantlyRateLimitError,
  type InstantlyEmail,
  type InstantlyLead,
} from "../lib/instantly.js";
import { errorMessage, isJsonObject, stringValue } from "../lib/json.js";
import { toE164 } from "../lib/phone.js";

//=============================================================================================================

//types and globals============================================================================================

export interface InstantlyInterestedFields {
  readonly eventType: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly campaignName: string | null;
}

//=============================================================================================================

// ---------- RUN ----------

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. Instantly posts here when a lead is marked interested.
//
//FLOW:
// 1. hasWebhookSecret (lib/http.ts) - compare the x-webhook-secret header against INSTANTLY_WEBHOOK_SECRET.
// 2. parseInstantlyInterestedWebhook - require event_type and lead_email.
// 3. Ignore anything that is not lead_interested; Instantly sends opens and replies to the same URL.
// 4. Read the lead record back for the fields the webhook does not carry. Best-effort - see enrichFromInstantly.
// 5. recordInterestedLead (lib/interested.ts) - the sequence every provider shares. Instantly contributes the
//    person lookup (by address) and the thread note.
//
//[SECURITY] Step 1 precedes the body read, so an unauthenticated caller never reaches the parser.
//[STABILITY] Step 5 is a series of Attio calls with no transaction. A throw partway leaves earlier writes
//committed and returns 500. Instantly's retry no longer duplicates the notes as a matter of course - the repeat
//check in recordInterestedLead declines an event whose note is already on the Person from inside
//INTERESTED_DUPLICATE_WINDOW_MS - but a retry landing after that window, or one arriving while the note
//listing cannot be read, is still recorded a second time. The check narrows this; it does not remove it.
//[DEBUG] `emailCount` is assigned inside the history thunk because only that closure sees the thread. The
//thunk is awaited inside recordInterestedLead before this function reads it back, so the count is settled.
//USES: hasWebhookSecret, json, requestJson, serverError (lib/http.ts); findPersonByEmail (lib/attio.ts);
//fetchInstantlyEmails (lib/instantly.ts); recordInterestedLead (lib/interested.ts).
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "INSTANTLY_WEBHOOK_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const fields = parseInstantlyInterestedWebhook(await requestJson(request));
    //[DEBUG] Named rather than silent, so an untracked event type is visible as a decision in the log.
    if (fields.eventType !== "lead_interested") {
      console.log(
        `[route] instantly-interested: skipped - event ${JSON.stringify(fields.eventType)} is not "lead_interested"`,
      );
      return json({ skipped: true, reason: "event not tracked" });
    }
    console.log(`[route] instantly-interested: handling lead_interested for ${fields.email}`);

    const enriched = await enrichFromInstantly(fields.email);
    let emailCount = 0;

    const outcome = await recordInterestedLead({
      lead: instantlyLead(fields, enriched, Date.now()),
      subject: "instantly-interested",
      findPerson: () => findPersonByEmail(fields.email),
      history: async () => {
        //[STABILITY] A throttled thread read costs the history, never the lead. Instantly's allowance is 20
        //requests a minute across the whole key, and the touchpoint sync spends up to fifteen of them a run
        //while a backlog drains - so an interested webhook arriving mid-drain can be refused through no fault
        //of its own. Raising here would 500 the webhook and lose the lead until Instantly retried it, to save
        //a note body. The lead is the part worth keeping; the thread stays readable in Instantly.
        try {
          //Unbounded by time - the whole thread for this lead, paginated. Bounded in practice by one lead's volume.
          const emails = await fetchInstantlyEmails({ leadEmail: fields.email });
          emailCount = emails.length;
          return formatInstantlyThread(emails, fields.campaignName);
        } catch (error) {
          if (!(error instanceof InstantlyRateLimitError)) throw error;
          console.warn(
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

    console.log(
      outcome.duplicate
        ? `[route] instantly-interested: declined as a repeat, ${emailCount} email(s) fetched but not written`
        : `[route] instantly-interested: ${emailCount} email(s) summarised, ${outcome.suppression.failures.length} platform(s) failed to suppress`,
    );
    return json({
      success: true,
      duplicate: outcome.duplicate,
      personId: outcome.personId,
      dealId: outcome.dealId,
      companyId: outcome.companyId,
      suppression: outcome.suppression.outcomes,
      ...(outcome.suppression.failures.length > 0 ? { suppressionErrors: outcome.suppression.failures } : {}),
    });
  } catch (error) {
    return serverError("Instantly interested webhook error", error);
  }
}

// ---------------------------

//read the webhook=============================================================================================

//#region <read the webhook: parse the body>
/** Instantly sends a flat v2 body. event_type and lead_email are required; the rest is best-effort enrichment. */
export function parseInstantlyInterestedWebhook(value: unknown): InstantlyInterestedFields {
  if (!isJsonObject(value)) throw new Error("Instantly webhook payload must be an object");
  const eventType = stringValue(value.event_type);
  const email = stringValue(value.lead_email);
  if (!eventType || !email) throw new Error("Instantly webhook is missing event_type or lead_email");
  return {
    eventType,
    email,
    firstName: stringValue(value.firstName),
    lastName: stringValue(value.lastName),
    companyName: stringValue(value.companyName),
    campaignName: stringValue(value.campaign_name),
  };
}
//#endregion

//=============================================================================================================

//record the interested lead===================================================================================

//#region <record the interested lead: read the lead record>
/**
 * [DEBUG] Enrichment must never fail the event: the webhook alone is enough to record the lead, so a lookup
 * failure is logged and swallowed rather than raised.
 * USES: fetchInstantlyLead (lib/instantly.ts), errorMessage (lib/json.ts).
 */
async function enrichFromInstantly(email: string): Promise<InstantlyLead | null> {
  try {
    return await fetchInstantlyLead(email);
  } catch (error) {
    console.warn(
      `[route] instantly-interested: lead lookup for ${email} failed, so only the webhook's own fields are used - ${errorMessage(error)}`,
    );
    return null;
  }
}
//#endregion

//#region <record the interested lead: shape for attio>
//---------------------------------------------------------------------------------------------------------
//The lead as the shared workflow sees it: the webhook body, plus whatever the lead record adds.
//The webhook is thin - an event type, an address, sometimes a name and a campaign. Everything else Instantly
//knows about this person (job title, LinkedIn URL, phone, industry, headcount, revenue, location, the company's
//postal address) lives on the lead record under the campaign's custom variables, which is why the route reads
//it back before mapping. Webhook values win where both carry the same field: the webhook describes the event
//that just happened, the record describes the row as uploaded.
//USES: interestedLead (lib/interested.ts), toE164 (lib/phone.ts). Pure.
//---------------------------------------------------------------------------------------------------------
export function instantlyLead(
  fields: InstantlyInterestedFields,
  enriched: InstantlyLead | null,
  occurredAtMs: number,
): InterestedLead {
  return interestedLead("instantly", {
    emails: [fields.email],
    //Instantly stores a phone as it was uploaded, punctuated or not; toE164 drops anything that is not a
    //dialable number rather than writing a fragment into the CRM.
    phones: [toE164(enriched?.phone ?? null)].filter((phone): phone is string => phone !== null),
    firstName: fields.firstName ?? enriched?.firstName ?? null,
    lastName: fields.lastName ?? enriched?.lastName ?? null,
    linkedin: enriched?.linkedin ?? null,
    jobTitle: enriched?.jobTitle ?? null,
    location: enriched?.location ?? null,
    companyName: fields.companyName ?? enriched?.companyName ?? null,
    companyDomain: enriched?.companyDomain ?? null,
    companyAddress: enriched?.companyAddress ?? null,
    employeeCount: enriched?.employeeCount ?? null,
    annualRevenue: enriched?.annualRevenue ?? null,
    industry: enriched?.industry ?? null,
    website: enriched?.website ?? null,
    campaignName: fields.campaignName,
    occurredAtMs,
  });
}
//#endregion

//#region <record the interested lead: format the email thread>
/** Renders the thread oldest-first so the note reads top to bottom. Sorted on timestampEmail, not creation order. */
export function formatInstantlyThread(
  emails: readonly InstantlyEmail[],
  campaignName: string | null,
): string {
  if (emails.length === 0) {
    return campaignName
      ? `No email history found. Campaign: ${campaignName}`
      : "No email history found.";
  }
  return [...emails]
    .sort((left, right) => Date.parse(left.timestampEmail) - Date.parse(right.timestampEmail))
    .map(
      (email) =>
        `**${email.timestampEmail}** (${email.emailType})\n${email.subject ?? ""}\n\n${email.bodyText ?? ""}`,
    )
    .join("\n\n---\n\n");
}
//#endregion

//=============================================================================================================
