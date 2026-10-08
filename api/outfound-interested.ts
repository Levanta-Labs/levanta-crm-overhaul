//=============================================================================================================
//#region <import statements>

import { findPersonByEmail, findPersonByLinkedIn } from "../lib/attio.js";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js";
import {
  interestedLead,
  recordInterestedLead,
  type InterestedLead,
} from "../lib/interested.js";
import {
  fetchOutfoundLead,
  type OutfoundConversation,
  type OutfoundLead,
} from "../lib/outfound.js";
import { describeShape, errorMessage, isJsonObject, stringValue } from "../lib/json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

export interface OutfoundInterestedFields {
  /** The lead category that fired the relay, verbatim - "Interested", "Meeting Booked", "Refer Request". */
  readonly eventType: string | null;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly companyDomain: string | null;
  readonly jobTitle: string | null;
  readonly linkedin: string | null;
  readonly website: string | null;
  readonly industry: string | null;
  readonly campaignName: string | null;
  /** ISO 8601, as Outfound timed the event. Preferred over the receiving clock - see outfoundOccurredAtMs. */
  readonly timestamp: string | null;
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <RUN>

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. Outfound's Webhook Relay posts here when a lead is categorized.
//
//FLOW:
// 1. hasWebhookSecret (lib/http.ts) - compare the x-webhook-secret header against OUTFOUND_WEBHOOK_SECRET.
// 2. parseOutfoundInterestedWebhook - require lead_email, and nothing else.
// 3. Read the lead record back for the fields the webhook does not carry, AND for the thread the note is
//    rendered from - one request answers both. Best-effort; see enrichFromOutfound.
// 4. recordInterestedLead (lib/interested.ts) - the sequence every provider shares. Outfound contributes the
//    person lookup (by address, then by LinkedIn URL) and the thread note.
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
//USES: hasWebhookSecret, json, requestJson, serverError (lib/http.ts); findPersonByEmail, findPersonByLinkedIn
//(lib/attio.ts); fetchOutfoundLead (lib/outfound.ts); recordInterestedLead (lib/interested.ts).
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "OUTFOUND_WEBHOOK_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const fields = parseOutfoundInterestedWebhook(await requestJson(request));
    //[DEBUG] The category is named here and nowhere else. It is not written to Attio - every category that
    //reaches this route is treated identically - but without it in the log there is no way to tell which tag
    //fired a given run, and the tags are edited on Outfound's side without a deploy to mark the change.
    //
    //[STABILITY] THIS LINE MUST STAY ABOVE recordInterestedLead. The run transcript (lib/run-log.ts) mirrors
    //console output into a note on the Person, Company and Deal, but only while a run scope is open - and
    //recordInterestedLead is what opens one. Printing the category here keeps it in the Vercel log and out of
    //Attio, which is the requirement. Moved below, or printed again inside the workflow, and the category name
    //silently starts appearing on three CRM records. tests/unit/interested-handlers.test.ts asserts it does not.
    console.log(
      `[route] outfound-interested: handling ${JSON.stringify(fields.eventType ?? "an uncategorised event")} for ${fields.email}`,
    );

    const enriched = await enrichFromOutfound(fields.email);
    let historyCount = 0;

    const outcome = await recordInterestedLead({
      lead: outfoundLead(fields, enriched, outfoundOccurredAtMs(fields.timestamp, Date.now())),
      subject: "outfound-interested",
      //Address first: it is the identifier Outfound always carries, and lead_email is required of the payload.
      //The LinkedIn URL is a fallback for a person Attio holds under a profile but not under this address.
      findPerson: async () =>
        (await findPersonByEmail(fields.email)) ??
        (await findPersonByLinkedIn(fields.linkedin ?? enriched?.linkedin ?? null)),
      history: async () => {
        //Already fetched at step 3 - the lookup returns the conversations alongside the enrichment, so the
        //thread costs no request of its own here.
        const conversations = enriched?.conversations ?? [];
        historyCount = conversations.length;
        return formatOutfoundThread(conversations, fields.campaignName);
      },
    });

    console.log(
      outcome.duplicate
        ? `[route] outfound-interested: declined as a repeat, ${historyCount} conversation(s) fetched but not written`
        : `[route] outfound-interested: ${historyCount} conversation(s) summarised, ${outcome.suppression.failures.length} platform(s) failed to suppress`,
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
    return serverError("Outfound interested webhook error", error);
  }
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read the webhook>

//#region <parse the body>
//---------------------------------------------------------------------------------------------------------
//Outfound posts a flat body. Only lead_email is required of it here.
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
  if (!isJsonObject(value)) throw new Error("Outfound webhook payload must be an object");
  const email = stringValue(value.lead_email);
  if (!email) {
    //[DEBUG][SECURITY] describeShape reports keys and types only, never values, so a payload that does not match
    //what the spec described can be diagnosed from the log without recording anybody's name or message text.
    //Worth the lines on this provider in particular: the API is private, the relay's payload is not versioned,
    //and a silent shape change would otherwise surface only as a bare "missing lead_email" with nothing to act on.
    const shape = describeShape(value);
    console.error(
      `[route] outfound-interested: rejected - no lead_email on the payload, which is the one field there is nothing to record without. Payload shape was ${shape}`,
    );
    throw new Error(`Outfound webhook is missing lead_email. Payload shape was ${shape}`);
  }
  return {
    //category_name and event_type carry the same string; event_type is the documented one, so it leads.
    eventType: stringValue(value.event_type) ?? stringValue(value.category_name),
    email,
    firstName: stringValue(value.first_name),
    lastName: stringValue(value.last_name),
    companyName: stringValue(value.company_name),
    companyDomain: stringValue(value.company_domain),
    jobTitle: stringValue(value.job_title),
    linkedin: stringValue(value.linkedin),
    website: stringValue(value.website),
    industry: stringValue(value.industry),
    campaignName: stringValue(value.campaign_name),
    timestamp: stringValue(value.timestamp),
  };
}
//#endregion

//#region <event time>
/**
 * [LOGIC] When the event happened, by Outfound's clock rather than ours. The warehouse lags by minutes, so the
 * receiving clock would date an interested lead by when the relay got through rather than when they replied.
 * An unparseable or absent timestamp falls back to `nowMs` - a slightly late date beats no date at all.
 * USES: nothing. Pure.
 */
export function outfoundOccurredAtMs(timestamp: string | null, nowMs: number): number {
  if (!timestamp) return nowMs;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : nowMs;
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record the interested lead>

//#region <read the lead record>
/**
 * [DEBUG] Enrichment must never fail the event: the webhook alone is enough to record the lead, so a lookup
 * failure is logged and swallowed rather than raised. It also supplies the note's history, which is why a
 * failure here costs the thread as well as the extra fields - formatOutfoundThread then renders the empty case.
 * USES: fetchOutfoundLead (lib/outfound.ts), errorMessage (lib/json.ts).
 */
async function enrichFromOutfound(email: string): Promise<OutfoundLead | null> {
  try {
    return await fetchOutfoundLead(email);
  } catch (error) {
    console.warn(
      `[route] outfound-interested: lead lookup for ${email} failed, so only the webhook's own fields are used and the note carries no history - ${errorMessage(error)}`,
    );
    return null;
  }
}
//#endregion

//#region <shape for attio>
//---------------------------------------------------------------------------------------------------------
//The lead as the shared workflow sees it: the webhook body, plus whatever the lead record adds.
//Outfound's webhook is the richest of the three - it already carries the name, company, domain, job title,
//LinkedIn URL, website and industry, where Instantly's carries an address and little else. The lookup is still
//worth its request: seniority, the company's headcount, revenue and country come only from there.
//Webhook values win where both carry the same field: the webhook describes the event that just happened, the
//record describes the row as the warehouse holds it.
//
//No phone. Outfound's enrichment has no phone number anywhere in it, so nothing is mapped to Attio's - which is
//why this route, unlike Instantly's, needs no toE164 (lib/phone.ts).
//USES: interestedLead (lib/interested.ts). Pure.
//---------------------------------------------------------------------------------------------------------
export function outfoundLead(
  fields: OutfoundInterestedFields,
  enriched: OutfoundLead | null,
  occurredAtMs: number,
): InterestedLead {
  return interestedLead("outfound", {
    emails: [fields.email],
    firstName: fields.firstName ?? enriched?.firstName ?? null,
    lastName: fields.lastName ?? enriched?.lastName ?? null,
    linkedin: fields.linkedin ?? enriched?.linkedin ?? null,
    jobTitle: fields.jobTitle ?? enriched?.jobTitle ?? null,
    //Outfound's location is an ISO 3166-1 alpha-2 country code on the COMPANY, not a place on the person, and
    //companyAddress is left null for the same reason: parsePostalAddress (lib/interested.ts) needs an address,
    //and "US" is not one. The country still reads correctly as a Person location, which is where it goes.
    location: enriched?.location ?? null,
    companyName: fields.companyName ?? enriched?.companyName ?? null,
    companyDomain: fields.companyDomain ?? enriched?.companyDomain ?? null,
    employeeCount: enriched?.headcount ?? null,
    annualRevenue: enriched?.revenue ?? null,
    industry: fields.industry ?? enriched?.industry ?? null,
    website: fields.website ?? null,
    campaignName: fields.campaignName,
    occurredAtMs,
  });
}
//#endregion

//#region <format the email thread>
/** Renders the correspondence oldest-first so the note reads top to bottom. Sorted on the email timestamp. */
export function formatOutfoundThread(
  conversations: readonly OutfoundConversation[],
  campaignName: string | null,
): string {
  if (conversations.length === 0) {
    return campaignName
      ? `No email history found. Campaign: ${campaignName}`
      : "No email history found.";
  }
  return [...conversations]
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
