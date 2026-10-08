//The register of third-party platforms. Adding a fourth is meant to be an APPEND here plus its own extractor,
//and nothing else - no edit to the shared interested workflow, the Attio mapping, or the write path.
//
//Two registers, because a platform sits on two independent axes and a given one may be on either, both, or
//only one:
//
//  SOURCES      - platforms that can report a lead as interested. Aircall, Instantly, HeyReach and Outfound
//                 all do.
//  SUPPRESSION  - outbound platforms that must stop contacting a lead once any source reports interest.
//                 Instantly, HeyReach and Outfound are here; Aircall is NOT, because it is a phone system with
//                 no campaign or blocklist API and nothing to call.
//
//A new platform is added to whichever registers apply. Everything downstream is derived.

//imports======================================================================================================

import { blockInstantlyLead } from "./instantly.js";
import { stopLeadInActiveCampaigns } from "./heyreach.js";
import { fetchOutfoundLead, markOutfoundThreadDnc } from "./outfound.js";

//=============================================================================================================

//types and globals============================================================================================

/** Derived from SOURCES, so appending an entry there is what adds a provider - there is no second list. */
export type Provider = keyof typeof SOURCES;

/** The source words these workflows can produce. The full option lists are longer; these are ours. */
type SourceCategory = "COLD_EMAIL" | "COLD_CALL" | "LI_OUTBOUND";
type SubSourceParty = "LEVANTA" | "SAS";

interface AttributionSchema {
  readonly sourceSlug: string;
  readonly subSourceSlug: string;
  readonly source: Readonly<Record<SourceCategory, string>>;
  readonly subSource: Readonly<Record<SubSourceParty, string>>;
}

/** Which object's attribution attributes to write. Only these two carry any. */
export type AttributedObject = "people" | "deals";

export interface AttributionOptionCheck {
  readonly object: AttributedObject;
  readonly slug: string;
  readonly optionIds: readonly string[];
}

/** Everything any suppression channel might need to identify a lead on its own platform. */
export interface SuppressionTargets {
  readonly personId: string;
  readonly personName: string;
  readonly email: string | null;
  /** A LinkedIn profile URL, whichever provider happened to supply it. */
  readonly profileUrl: string | null;
}

export type SuppressionChannelResult =
  //`detail` is folded into the summary log line - a count, an identifier, whatever the platform reports back.
  | { readonly status: "suppressed"; readonly detail?: string }
  //Not a failure: the lead simply is not present on this platform to suppress, usually for want of the one
  //identifier it works by. `reason` says which.
  | { readonly status: "skipped"; readonly reason: string };

export interface SuppressionChannel {
  /** Named in logs and in the failure list a route returns, so keep it recognisable. */
  readonly platform: string;
  readonly suppress: (targets: SuppressionTargets) => Promise<SuppressionChannelResult>;
}

//---------------------------------------------------------------------------------------------------------
//Every platform that can report interest. `displayName` is the only thing a new entry has to decide, and it is
//load-bearing: the source strings written into Attio and the note titles are derived from it, so it must be
//spelled exactly as the business wants to read it in a report. Changing one afterwards changes what new
//records say without changing what old ones already say.
//
//The provider KEY is used for two other things, both by derivation and neither needing an edit here:
//  - the counter-slug environment variables, ATTIO_PERSON_<KEY>_COUNTER_SLUG and ATTIO_COMPANY_<KEY>_COUNTER_SLUG
//    (see counterSlug in attio.ts), which a new provider must have added to the deployment before it can run;
//  - the Supabase cursor key its sync uses, if it polls.
//---------------------------------------------------------------------------------------------------------
//[LOGIC] The register itself. Appending one line here is what adds a provider.
const SOURCES = {
  aircall: { displayName: "Aircall" },
  instantly: { displayName: "Instantly" },
  heyreach: { displayName: "HeyReach" },
  //Outfound is a warehouse over other sequencers rather than a sender of its own, so the emails it reports were
  //sent elsewhere. It is a source in its own right here because the mail it carries is mail no other configured
  //provider reads - see lib/outfound.ts.
  outfound: { displayName: "Outfound" },
} as const;

//Attribution: which discrete source each provider represents, on the Person and on the Deal.
//
//THE TWO OBJECTS HAVE DIFFERENT OPTION IDS FOR THE SAME WORDS. "Cold Email" on a Person is
//4dca8bb3-... and on a Deal it is 6cae752e-...; they are separate select attributes that merely happen to be
//spelled alike. Writing a Deal's ID to a Person is not an error Attio reports as a mismatch - it rejects the
//option as unknown, updateAttioAttributes logs it and carries on, and the record ends up with no attribution
//while the run still reports success.
//
//So the mapping is split in two. A provider maps to a CATEGORY, which is a word; each object then has its own
//table turning that word into that object's ID. The provider table cannot name an ID at all, which is what
//makes a cross-object mix-up impossible to write rather than merely discouraged.
//
//WHY OPTION IDS AND NOT TITLES. Attio accepts either for a select - `[{ option: "Cold Email" }]` works just as
//well as `[{ option: "6cae752e-..." }]`. The ID is used because it survives a rename: someone relabelling
//"Cold Email" in the Attio UI keeps the same option_id, where a title write would start failing silently from
//that moment on with nothing in the code to say why.
//The trade is that these are unreadable, so each carries its title in a comment and a live smoke test asserts
//every one of them still exists on its own object's attribute - see tests/live/read-only.test.ts.
//
//SUB-SOURCE IS ABOUT WHOSE PLATFORM SENT IT, not which tool. Instantly, HeyReach and Aircall are Levanta's own;
//Outfound is the SAS platform.

//[LOGIC] One entry per provider, checked against Provider so adding a fifth will not compile until it is
//attributed. That is deliberate: a new provider silently writing no source is the failure this prevents.
//Names words, never IDs - see the note above.
const PROVIDER_ATTRIBUTION: Readonly<Record<Provider, { readonly category: SourceCategory; readonly party: SubSourceParty }>> = {
  //George's dialler. Levanta's own.
  aircall: { category: "COLD_CALL", party: "LEVANTA" },
  //Levanta's own cold email.
  instantly: { category: "COLD_EMAIL", party: "LEVANTA" },
  //LinkedIn outbound, Levanta's own.
  heyreach: { category: "LI_OUTBOUND", party: "LEVANTA" },
  //Cold email arriving through the SAS platform rather than ours.
  outfound: { category: "COLD_EMAIL", party: "SAS" },
};

//[LOGIC] What each word is called in Attio. Display only - nothing is written from these, so a rename in the
//Attio UI makes a transcript read slightly stale rather than breaking a write. That is the whole point of
//writing IDs; see the note above. Kept beside the IDs so the tables read as words rather than as UUIDs.
const SOURCE_TITLES: Readonly<Record<SourceCategory, string>> = {
  COLD_EMAIL: "Cold Email",
  COLD_CALL: "Cold Call",
  LI_OUTBOUND: "LI Outbound",
};

const PARTY_TITLES: Readonly<Record<SubSourceParty, string>> = {
  LEVANTA: "Levanta",
  SAS: "SAS",
};

/** The `deals` object's attribution attributes and their option IDs. */
const DEAL_SCHEMA: AttributionSchema = {
  sourceSlug: "deal_source_discrete",
  subSourceSlug: "outbound_sub_source_discrete",
  source: {
    COLD_EMAIL: "6cae752e-6395-478a-83aa-eb934479d7dd",
    COLD_CALL: "0696a0fc-425c-4ba5-9afb-2897b61ca3aa",
    LI_OUTBOUND: "9686ed43-60ba-454d-b5d4-70c0840f227f",
  },
  subSource: {
    LEVANTA: "4763981c-5793-48dc-b878-c02e0231df13",
    SAS: "2cbbadd4-dca8-47cd-a6fb-6af4ae0eddee",
  },
};

/** The `people` object's, which spell the same words with entirely different IDs. */
const PERSON_SCHEMA: AttributionSchema = {
  sourceSlug: "lead_source_discrete",
  subSourceSlug: "lead_outbound_sub_source_discrete",
  source: {
    COLD_EMAIL: "4dca8bb3-413a-4d13-984b-e391b6f71852",
    COLD_CALL: "56188ba9-821a-4878-99a2-333d338247a8",
    LI_OUTBOUND: "f853ad2b-0681-4f0a-8c66-73358406dab1",
  },
  subSource: {
    LEVANTA: "667ebae3-b820-4fc3-a12e-ebbfa4ce3cfb",
    SAS: "cba7bd62-52ea-41d3-a494-4fce947b8780",
  },
};

const SCHEMAS: Readonly<Record<AttributedObject, AttributionSchema>> = {
  people: PERSON_SCHEMA,
  deals: DEAL_SCHEMA,
};

export const PROVIDERS: readonly Provider[] = Object.keys(SOURCES) as Provider[];

//---------------------------------------------------------------------------------------------------------
//The outbound platforms silenced when any source reports interest. Order is priority: the channel most costly
//to leave running goes first, because each runs independently and a run may be cut short by a timeout.
//
//The Attio DNC list is NOT here. It is prepended by suppressInterestedLead (lib/interested.ts), which keeps
//this file free of any Attio import and this register purely about third parties.
//
//A new outbound platform is appended here with a function that suppresses one lead. It needs no other change:
//it is called for every interested lead whatever platform reported the interest, which is the point - interest
//is a fact about the person, not about the channel that noticed it first.
//[LOGIC] Each `suppress` may throw; suppressInterestedLead (lib/interested.ts) catches and records it, so a
//channel here never has to defend itself against its own failure.
//USES: blockInstantlyLead (lib/instantly.ts), stopLeadInActiveCampaigns (lib/heyreach.ts).
//---------------------------------------------------------------------------------------------------------
export const THIRD_PARTY_SUPPRESSION_CHANNELS: readonly SuppressionChannel[] = [
  {
    platform: "instantly blocklist",
    suppress: async (targets) => {
      if (!targets.email) {
        return { status: "skipped", reason: "the lead carried no email address to block" };
      }
      await blockInstantlyLead(targets.email);
      return { status: "suppressed" };
    },
  },
  {
    platform: "outfound DNC",
    suppress: async (targets) => {
      if (!targets.email) {
        return { status: "skipped", reason: "the lead carried no email address to suppress" };
      }
      //Outfound has no "add this address to DNC" call - only "mark this thread DNC" - so a thread has to be
      //found before anything can be suppressed. The lookup is keyed on the address and returns every thread the
      //lead appears in; marking one with dnc_type "email" suppresses the address across all of them.
      const lead = await fetchOutfoundLead(targets.email);
      const threadHash = lead?.conversations[0]?.threadHash;
      if (!threadHash) {
        return { status: "skipped", reason: "Outfound holds no thread for this address to mark" };
      }
      await markOutfoundThreadDnc(threadHash, targets.email);
      return { status: "suppressed", detail: `via thread ${threadHash}` };
    },
  },
  {
    platform: "heyreach campaigns",
    suppress: async (targets) => {
      if (!targets.profileUrl) {
        //StopLeadInCampaign is driven by leadUrl, so an email-only lead cannot be stopped even though the
        //campaign lookup would accept the address. Closing this needs the leadMemberId - see lib/heyreach.ts.
        return { status: "skipped", reason: "the lead carried no LinkedIn profile URL to stop" };
      }
      const { inCampaigns, removedFrom } = await stopLeadInActiveCampaigns(
        targets.profileUrl,
        targets.email,
      );
      //Both numbers, because either alone misreads. "0 campaign(s) stopped" sounded like a campaign had been
      //left running, when nothing here ever halts a campaign: it withdraws one lead from the ones still live.
      return {
        status: "suppressed",
        detail: `lead is in ${inCampaigns} campaign(s), removed from ${removedFrom}`,
      };
    },
  },
];

//=============================================================================================================

//name providers===============================================================================================

//#region <name providers: display names and labels>
/** [LOGIC] USES: SOURCES (this module). Pure. */
export function providerDisplayName(provider: Provider): string {
  return SOURCES[provider].displayName;
}

/**
 * [LOGIC] The bare channel name - "<Name> Cold Outreach". One derivation for every provider, so a fourth
 * inherits the convention rather than adding a fourth hand-written string that could disagree with the other
 * three. This is the note TITLE, and nothing writes it to an attribute. It is also what the repeat check keys
 * on - see recentlyNoted (lib/interested.ts) - so changing it changes which notes count as duplicates of each
 * other, and a run under the old spelling will not recognise a note written under the new one.
 * USES: providerDisplayName (this module). Pure.
 */
export function leadSourceLabel(provider: Provider): string {
  return `${providerDisplayName(provider)} Cold Outreach`;
}
//#endregion

//=============================================================================================================

//attribute leads to their source==============================================================================

//#region <attribute leads to their source: values to write>
//---------------------------------------------------------------------------------------------------------
//The attribution attributes for one provider on one object, ready to merge into that object's values.
//Returns the slugs and values together so a caller cannot pair one object's slug with another's ID: the only
//way to get an ID out of here is to ask for the object it belongs to.
//USES: PROVIDER_ATTRIBUTION, SCHEMAS (this module). Pure.
//---------------------------------------------------------------------------------------------------------
export function attributionValues(
  object: AttributedObject,
  provider: Provider,
): Readonly<Record<string, readonly { readonly option: string }[]>> {
  const { category, party } = PROVIDER_ATTRIBUTION[provider];
  const schema = SCHEMAS[object];
  return {
    [schema.sourceSlug]: [{ option: schema.source[category] }],
    [schema.subSourceSlug]: [{ option: schema.subSource[party] }],
  };
}

/** [LOGIC] Every attribution slug, so ALWAYS_OVERWRITE can name them without repeating the strings. Pure. */
export function attributionSlugs(): readonly string[] {
  return Object.values(SCHEMAS).flatMap((schema) => [schema.sourceSlug, schema.subSourceSlug]);
}
//#endregion

//#region <attribute leads to their source: option id lookups>
//---------------------------------------------------------------------------------------------------------
//The word an option ID stands for, or null if it is not one this codebase writes.
//
//WHY THE RUN LOG NEEDS THIS. Attio RETURNS a select as `{ option: { id, title } }` but ACCEPTS it as
//`{ option: "<id>" }`, and the transcript renders both: the "before" picture comes from a read and the "after"
//from what was written. Without a way back from the ID, a transcript line read
//`lead source discrete: Cold Email -> {"option":"4dca8bb3-..."}` - the same fact twice, once as a word and
//once as a blob. See optionTitle (lib/run-log.ts).
//USES: SCHEMAS, SOURCE_TITLES, PARTY_TITLES (this module). Pure.
//---------------------------------------------------------------------------------------------------------
export function attributionOptionTitle(optionId: string): string | null {
  for (const schema of Object.values(SCHEMAS)) {
    for (const [category, id] of Object.entries(schema.source)) {
      if (id === optionId) return SOURCE_TITLES[category as SourceCategory];
    }
    for (const [party, id] of Object.entries(schema.subSource)) {
      if (id === optionId) return PARTY_TITLES[party as SubSourceParty];
    }
  }
  return null;
}

/** [LOGIC] Every option ID this codebase writes, with the object and attribute it belongs to. Pure. */
export function attributionOptionIds(): readonly AttributionOptionCheck[] {
  return (Object.keys(SCHEMAS) as AttributedObject[]).flatMap((object) => {
    const schema = SCHEMAS[object];
    return [
      { object, slug: schema.sourceSlug, optionIds: Object.values(schema.source) },
      { object, slug: schema.subSourceSlug, optionIds: Object.values(schema.subSource) },
    ];
  });
}
//#endregion

//=============================================================================================================
