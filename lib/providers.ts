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

//=============================================================================================================
//#region <import statements>

import { blockInstantlyLead, emailDomain, FREE_EMAIL_DOMAINS } from "./instantly.js"; //block an email or domain in instantly
import { //pull a lead out of heyreach campaigns and blacklist them
  blacklistHeyReachCompany,
  blacklistHeyReachLead,
  stopLeadInActiveCampaigns,
} from "./heyreach.js";
import { fetchOutfoundLead, markOutfoundThreadDnc } from "./outfound.js"; //find and mark outfound threads

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//Every provider key: "aircall" | "instantly" | "heyreach" | "outfound".
//Derived from SOURCES, so appending an entry there is what adds a provider - there is no second list.
export type Provider = keyof typeof SOURCES; //the keys of SOURCES, as a type

//The source words these workflows can produce. The full option lists are longer; these are ours.
type SourceCategory = "COLD_EMAIL" | "COLD_CALL" | "LI_OUTBOUND"; //which kind of outreach
//Whose platform sent the outreach.
type SubSourceParty = "LEVANTA" | "SAS"; //levanta's own or the sas platform

//One Attio object's attribution attributes and the option ID for each word.
interface AttributionSchema {
  readonly sourceSlug: string; //the source attribute's slug
  readonly subSourceSlug: string; //the sub-source attribute's slug
  readonly source: Readonly<Record<SourceCategory, string>>; //option ID per source word
  readonly subSource: Readonly<Record<SubSourceParty, string>>; //option ID per party word
}

//Which object's attribution attributes to write. Only these two carry any.
export type AttributedObject = "people" | "deals"; //person or deal records

//One attribute's option IDs, for the live test that checks they still exist.
export interface AttributionOptionCheck {
  readonly object: AttributedObject; //people or deals
  readonly slug: string; //the attribute's slug
  readonly optionIds: readonly string[]; //every option ID written to it
}

//Everything any suppression channel might need to identify a lead on its own platform.
export interface SuppressionTargets {
  readonly personId: string; //attio person record id
  readonly personName: string; //person's name, for logs
  readonly email: string | null; //lead's email, if known
  //A LinkedIn profile URL, whichever provider happened to supply it.
  readonly profileUrl: string | null; //linkedin profile url, if known
  readonly companyName: string | null; //lead's company name, if known
}

//What one suppression channel reports back: done, or nothing to do.
export type SuppressionChannelResult =
  //`detail` is folded into the summary log line - a count, an identifier, whatever the platform reports back.
  | { readonly status: "suppressed"; readonly detail?: string } //lead was stopped, optional detail
  //Not a failure: the lead simply is not present on this platform to suppress, usually for want of the one
  //identifier it works by. `reason` says which.
  | { readonly status: "skipped"; readonly reason: string }; //nothing to stop, and why

//One outbound platform that can be told to stop contacting a lead.
export interface SuppressionChannel {
  //Named in logs and in the failure list a route returns, so keep it recognisable.
  readonly platform: string; //platform name for logs
  readonly suppress: (targets: SuppressionTargets) => Promise<SuppressionChannelResult>; //stops one lead
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
const SOURCES = { //provider key -> its display name
  aircall: { displayName: "Aircall" }, //aircall phone calls
  instantly: { displayName: "Instantly" }, //instantly cold email
  heyreach: { displayName: "HeyReach" }, //heyreach linkedin outreach
  //Outfound is a warehouse over other sequencers rather than a sender of its own, so the emails it reports were
  //sent elsewhere. It is a source in its own right here because the mail it carries is mail no other configured
  //provider reads - see lib/outfound.ts.
  outfound: { displayName: "Outfound" }, //outfound email warehouse
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
const PROVIDER_ATTRIBUTION: Readonly<Record<Provider, { readonly category: SourceCategory; readonly party: SubSourceParty }>> = { //provider -> source word and party
  //George's dialler. Levanta's own.
  aircall: { category: "COLD_CALL", party: "LEVANTA" }, //cold call, levanta
  //Levanta's own cold email.
  instantly: { category: "COLD_EMAIL", party: "LEVANTA" }, //cold email, levanta
  //LinkedIn outbound, Levanta's own.
  heyreach: { category: "LI_OUTBOUND", party: "LEVANTA" }, //linkedin outbound, levanta
  //Cold email arriving through the SAS platform rather than ours.
  outfound: { category: "COLD_EMAIL", party: "SAS" }, //cold email, sas
};

//[LOGIC] What each word is called in Attio. Display only - nothing is written from these, so a rename in the
//Attio UI makes a transcript read slightly stale rather than breaking a write. That is the whole point of
//writing IDs; see the note above. Kept beside the IDs so the tables read as words rather than as UUIDs.
const SOURCE_TITLES: Readonly<Record<SourceCategory, string>> = { //source word -> attio title
  COLD_EMAIL: "Cold Email", //title for COLD_EMAIL
  COLD_CALL: "Cold Call", //title for COLD_CALL
  LI_OUTBOUND: "LI Outbound", //title for LI_OUTBOUND
};

//What each party word is called in Attio. Display only, like SOURCE_TITLES.
const PARTY_TITLES: Readonly<Record<SubSourceParty, string>> = { //party word -> attio title
  LEVANTA: "Levanta", //title for LEVANTA
  SAS: "SAS", //title for SAS
};

//The `deals` object's attribution attributes and their option IDs.
const DEAL_SCHEMA: AttributionSchema = { //deal slugs and option IDs
  sourceSlug: "deal_source_discrete", //deal source attribute
  subSourceSlug: "outbound_sub_source_discrete", //deal sub-source attribute
  source: { //deal source option IDs
    COLD_EMAIL: "6cae752e-6395-478a-83aa-eb934479d7dd", //"Cold Email"
    COLD_CALL: "0696a0fc-425c-4ba5-9afb-2897b61ca3aa", //"Cold Call"
    LI_OUTBOUND: "9686ed43-60ba-454d-b5d4-70c0840f227f", //"LI Outbound"
  },
  subSource: { //deal sub-source option IDs
    LEVANTA: "4763981c-5793-48dc-b878-c02e0231df13", //"Levanta"
    SAS: "2cbbadd4-dca8-47cd-a6fb-6af4ae0eddee", //"SAS"
  },
};

//The `people` object's, which spell the same words with entirely different IDs.
const PERSON_SCHEMA: AttributionSchema = { //person slugs and option IDs
  sourceSlug: "lead_source_discrete", //person source attribute
  subSourceSlug: "lead_outbound_sub_source_discrete", //person sub-source attribute
  source: { //person source option IDs
    COLD_EMAIL: "4dca8bb3-413a-4d13-984b-e391b6f71852", //"Cold Email"
    COLD_CALL: "56188ba9-821a-4878-99a2-333d338247a8", //"Cold Call"
    LI_OUTBOUND: "f853ad2b-0681-4f0a-8c66-73358406dab1", //"LI Outbound"
  },
  subSource: { //person sub-source option IDs
    LEVANTA: "667ebae3-b820-4fc3-a12e-ebbfa4ce3cfb", //"Levanta"
    SAS: "cba7bd62-52ea-41d3-a494-4fce947b8780", //"SAS"
  },
};

//Looks up the right schema by object name.
const SCHEMAS: Readonly<Record<AttributedObject, AttributionSchema>> = { //object name -> its schema
  people: PERSON_SCHEMA, //person attribution
  deals: DEAL_SCHEMA, //deal attribution
};

//Every provider key as a list. Only the tests read it.
export const PROVIDERS: readonly Provider[] = Object.keys(SOURCES) as Provider[]; //all provider keys

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
//---------------------------------------------------------------------------------------------------------
export const THIRD_PARTY_SUPPRESSION_CHANNELS: readonly SuppressionChannel[] = [ //the outbound platforms, in priority order
  {
    platform: "instantly blocklist", //name for logs
    suppress: async (targets) => { //blocks the lead's company domain in instantly
      if (!targets.email) { //no email to block
        return { status: "skipped", reason: "the lead carried no email address to block" }; //skip, say why
      }
      //The whole domain, so no colleague at the same company is emailed either. A free provider such as
      //gmail.com is shared by strangers, so for those - and for an address with no readable domain - only the
      //address itself is blocked.
      const domain = emailDomain(targets.email); //the part after the @
      if (!domain || FREE_EMAIL_DOMAINS.has(domain)) { //no company domain to block
        await blockInstantlyLead(targets.email); //add just the address to the blocklist
        return { status: "suppressed", detail: `blocked the address ${targets.email}` }; //done, say what
      }
      await blockInstantlyLead(domain); //add the whole domain to the blocklist
      return { status: "suppressed", detail: `blocked the domain ${domain}` }; //done, say what
    },
  },
  {
    platform: "outfound DNC", //name for logs
    suppress: async (targets) => { //marks the lead do-not-contact in outfound
      if (!targets.email) { //no email to look up
        return { status: "skipped", reason: "the lead carried no email address to suppress" }; //skip, say why
      }
      //Outfound has no "add this address to DNC" call - only "mark this thread DNC" - so a thread has to be
      //found before anything can be suppressed. The lookup is keyed on the address and returns every thread the
      //lead appears in; marking one with dnc_type "email" suppresses the address across all of them.
      const lead = await fetchOutfoundLead(targets.email); //find the lead's threads
      const threadHash = lead?.conversations[0]?.threadHash; //first thread's id, if any
      if (!threadHash) { //no thread to mark
        return { status: "skipped", reason: "Outfound holds no thread for this address to mark" }; //skip, say why
      }
      await markOutfoundThreadDnc(threadHash, targets.email); //mark the address do-not-contact
      return { status: "suppressed", detail: `via thread ${threadHash}` }; //done, name the thread
    },
  },
  {
    platform: "heyreach campaigns + blacklist", //name for logs
    suppress: async (targets) => { //stops the lead in heyreach and blacklists them and their company
      if (!targets.profileUrl && !targets.email) { //nothing to identify the lead by
        return { status: "skipped", reason: "the lead carried no LinkedIn profile URL or email address" }; //skip, say why
      }
      //Campaigns first: a full blacklist throws, and that must not stop the live sequences being withdrawn.
      //An email-only lead gets zeroes here, because StopLeadInCampaign needs the URL; the blacklist covers them.
      const { inCampaigns, removedFrom } = await stopLeadInActiveCampaigns( //remove from every live campaign
        targets.profileUrl,
        targets.email,
      );
      await blacklistHeyReachLead(targets.profileUrl, targets.email); //block the lead workspace-wide
      //The whole company, so no colleague is pitched over LinkedIn either. By name only - see lib/heyreach.ts.
      if (targets.companyName) { //company known
        await blacklistHeyReachCompany(targets.companyName); //block the company workspace-wide
      }
      //Both campaign numbers, because either alone misreads. "0 campaign(s) stopped" sounded like a campaign had
      //been left running, when nothing here ever halts a campaign: it withdraws one lead from the ones still live.
      //"still matching" because HeyReach finds the person behind a blacklist entry in the background.
      const companyDetail = targets.companyName ? `company "${targets.companyName}" blacklisted` : "no company to blacklist"; //company part of the log
      return { //done, with every part
        status: "suppressed", //lead was stopped
        detail: `lead is in ${inCampaigns} campaign(s), removed from ${removedFrom}; lead blacklisted (still matching); ${companyDetail}`, //for the log
      };
    },
  },
];

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <name providers>

//#region <display names and labels>
//---------------------------------------------------------------------------------------------------------
//Base function. Gives a provider's name as people read it, e.g. "HeyReach".
//Input: provider - the provider key.
//Output: its display name.
//Workflow: leadSourceLabel (the interested note title) and writeRunLogNotes (lib/run-log.ts) - the run-log
//note title.
//---------------------------------------------------------------------------------------------------------
export function providerDisplayName(provider: Provider): string {
  return SOURCES[provider].displayName; //look it up in the register
}

//---------------------------------------------------------------------------------------------------------
//Builds the interested note title, "<Name> Cold Outreach".
//Input: provider - the provider key.
//Output: the title text.
//Uses: providerDisplayName (this file).
//Workflow: interested workflow (runInterestedLead, lib/interested.ts) step 4 - the note title, also what step 0's
//repeat check looks for.
//
//[LOGIC] One derivation for every provider, so a fourth inherits the convention rather than adding a fourth
//hand-written string that could disagree with the other three. This is the note TITLE, and nothing writes it to
//an attribute. It is also what the repeat check keys on - see recentlyNoted (lib/interested.ts) - so changing it
//changes which notes count as duplicates of each other, and a run under the old spelling will not recognise a
//note written under the new one.
//---------------------------------------------------------------------------------------------------------
export function leadSourceLabel(provider: Provider): string {
  return `${providerDisplayName(provider)} Cold Outreach`; //e.g. "Aircall Cold Outreach"
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <attribute leads to their source>

//#region <values to write>
//---------------------------------------------------------------------------------------------------------
//Base function. Builds the source and sub-source values for one provider on one object.
//Input: object - "people" or "deals"; provider - the provider key.
//Output: { <source slug>: [{ option: id }], <sub-source slug>: [{ option: id }] }, ready to merge into values.
//Workflow: interested workflow step 5 - personValuesFor and dealValuesFor (lib/interested.ts) add these to the
//Person and Deal writes.
//
//Returns the slugs and values together so a caller cannot pair one object's slug with another's ID: the only
//way to get an ID out of here is to ask for the object it belongs to.
//---------------------------------------------------------------------------------------------------------
export function attributionValues(
  object: AttributedObject,
  provider: Provider,
): Readonly<Record<string, readonly { readonly option: string }[]>> {
  const { category, party } = PROVIDER_ATTRIBUTION[provider]; //this provider's two words
  const schema = SCHEMAS[object]; //this object's slugs and IDs
  return {
    [schema.sourceSlug]: [{ option: schema.source[category] }], //source attribute -> its option ID
    [schema.subSourceSlug]: [{ option: schema.subSource[party] }], //sub-source attribute -> its option ID
  };
}

//---------------------------------------------------------------------------------------------------------
//Base function. Lists every attribution slug, people and deals.
//Input: none.
//Output: the four slugs.
//Workflow: ALWAYS_OVERWRITE (lib/interested.ts) - the attributes interested step 5 restates every time.
//
//[LOGIC] So ALWAYS_OVERWRITE can name them without repeating the strings.
//---------------------------------------------------------------------------------------------------------
export function attributionSlugs(): readonly string[] {
  return Object.values(SCHEMAS).flatMap((schema) => [schema.sourceSlug, schema.subSourceSlug]); //both slugs of each schema, one list
}
//#endregion

//#region <option id lookups>
//---------------------------------------------------------------------------------------------------------
//Base function. Finds the word an option ID stands for.
//Input: optionId - an Attio select option ID.
//Output: its title, e.g. "Cold Email", or null if it is not one this codebase writes.
//Workflow: optionTitle (lib/run-log.ts) - makes written attribution readable in the run-log transcript.
//
//WHY THE RUN LOG NEEDS THIS. Attio RETURNS a select as `{ option: { id, title } }` but ACCEPTS it as
//`{ option: "<id>" }`, and the transcript renders both: the "before" picture comes from a read and the "after"
//from what was written. Without a way back from the ID, a transcript line read
//`lead source discrete: Cold Email -> {"option":"4dca8bb3-..."}` - the same fact twice, once as a word and
//once as a blob. See optionTitle (lib/run-log.ts).
//---------------------------------------------------------------------------------------------------------
export function attributionOptionTitle(optionId: string): string | null {
  for (const schema of Object.values(SCHEMAS)) { //each object's schema
    for (const [category, id] of Object.entries(schema.source)) { //each source word and ID
      if (id === optionId) return SOURCE_TITLES[category as SourceCategory]; //match: return its title
    }
    for (const [party, id] of Object.entries(schema.subSource)) { //each party word and ID
      if (id === optionId) return PARTY_TITLES[party as SubSourceParty]; //match: return its title
    }
  }
  return null; //not one of ours
}

//---------------------------------------------------------------------------------------------------------
//Base function. Lists every option ID this codebase writes, with its object and attribute.
//Input: none.
//Output: one { object, slug, optionIds } per attribute, four in all.
//Workflow: tests only - the live smoke test checks each ID still exists in Attio.
//---------------------------------------------------------------------------------------------------------
export function attributionOptionIds(): readonly AttributionOptionCheck[] {
  return (Object.keys(SCHEMAS) as AttributedObject[]).flatMap((object) => { //for each object, two entries
    const schema = SCHEMAS[object]; //this object's schema
    return [
      { object, slug: schema.sourceSlug, optionIds: Object.values(schema.source) }, //the source attribute's IDs
      { object, slug: schema.subSourceSlug, optionIds: Object.values(schema.subSource) }, //the sub-source attribute's IDs
    ];
  });
}
//#endregion

//#endregion
//=============================================================================================================
