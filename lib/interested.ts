//What the three interested workflows have in common.
//
//Aircall, Instantly, and HeyReach reach Attio by three different routes - a poll and two webhooks of different
//shapes - and each knows different things about a lead. What happens once the lead IS known is the same in all
//three, and this module is that part: one normalised lead shape, one mapping onto Attio attributes, one write
//path that cannot overwrite, one company resolution, one deal naming rule, and one suppression across every
//outbound platform. The provider modules keep only what is genuinely theirs - parsing their own payload, and
//rendering their own message history into a note.

//=============================================================================================================
//#region <import statements>

import { //attio record readers and writers
  addPersonToList,
  AttioApiError,
  createCompany,
  createNote,
  createPerson,
  defaultDealOwner,
  ensureInterestedDeal,
  fetchRecord,
  findCompanyByDomain,
  findCompanyByName,
  LISTS,
  listNotes,
  patchRecord,
  personCompanyId,
  personLabel,
  recordDisplayName,
  type AttioObject,
  type AttioPerson,
  type AttioRecord,
  type AttioValues,
} from "./attio.js";
import { reportConfigValue, tunableEnv } from "./env.js"; //read and report tunable settings
import { arrayValue, errorMessage, isJsonObject, stringValue } from "./json.js"; //safe readers for unknown json
import { //per-provider labels and suppression channels
  attributionSlugs,
  attributionValues,
  leadSourceLabel,
  THIRD_PARTY_SUPPRESSION_CHANNELS,
  type Provider,
  type SuppressionChannel,
  type SuppressionTargets,
} from "./providers.js";
//debug note in attio=
import { runLogApplied, runLogRecord, withRunLog } from "./run-log.js"; //the tool that writes down what this run did

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//---------------------------------------------------------------------------------------------------------
//Every field any provider can supply about an interested lead. A provider that cannot supply one passes null,
//and null never reaches Attio - see updateAttioAttributes.
//No provider fills all of it. Aircall fills the least by far: a phone number, plus a name and company only when
//that number was already in its address book.
//---------------------------------------------------------------------------------------------------------
export interface InterestedLead {
  readonly provider: Provider; //which platform reported the lead
  //Plural because Attio's equivalents are multiselect and providers do carry several - HeyReach alone has three
  //address fields. Order is significance, not preference: the first is what single-valued Deal attributes take.
  readonly emails: readonly string[]; //every known email, most significant first
  //E.164 already. Normalising at the edge rather than here is what lets one string both match Attio and be
  //written back to it.
  readonly phones: readonly string[]; //every known phone number, E.164
  readonly firstName: string | null; //lead's first name
  readonly lastName: string | null; //lead's last name
  readonly linkedin: string | null; //linkedin profile url
  readonly jobTitle: string | null; //lead's job title
  readonly description: string | null; //free-text about the lead
  readonly location: string | null; //where the lead is, free text
  readonly companyName: string | null; //the lead's company name
  readonly companyDomain: string | null; //the company's web domain
  //A postal address as one string, parsed by parsePostalAddress below. Attio's location attribute is structured,
  //so an address that will not parse is dropped rather than guessed at.
  readonly companyAddress: string | null; //company postal address, one string
  //Both verbatim as the provider spelled them, because the Deal attributes are free text. The bucketed Company
  //selects are derived from them by toEmployeeRange and toArrBucket.
  readonly employeeCount: string | null; //headcount as the provider wrote it
  readonly annualRevenue: string | null; //revenue as the provider wrote it
  readonly industry: string | null; //company's industry
  readonly website: string | null; //company website url
  readonly campaignName: string | null; //outbound campaign that reached them
  //When the lead became interested, epoch milliseconds. Feeds Person Date Added and Deal Moved to Interested At.
  readonly occurredAtMs: number | null; //when they became interested
}

//Every key an Attio location value carries. Sent whole, because a partial location is rejected.
export interface AttioLocation {
  readonly line_1: string | null; //street address
  readonly line_2: string | null; //extra address line, unused
  readonly line_3: string | null; //extra address line, unused
  readonly line_4: string | null; //extra address line, unused
  readonly locality: string | null; //city
  readonly region: string | null; //state or province
  readonly postcode: string | null; //postal or zip code
  readonly country_code: string | null; //two-letter country code, e.g. "US"
  readonly latitude: string | null; //map coordinate, unused
  readonly longitude: string | null; //map coordinate, unused
}

//---------------------------------------------------------------------------------------------------------
//Reading a scalar back OUT of a value Attio returned. Needed only for the multiselect attributes below, where
//a write has to include what is already there. Each attribute type spells its scalar differently.
//---------------------------------------------------------------------------------------------------------
type ScalarReader = (value: Record<string, unknown>) => string | null; //function: attio value in, text out

//What an attribute write did: which slugs stuck and which were dropped.
export interface AttributeWriteResult {
  /** The slugs Attio accepted. */
  readonly written: readonly string[]; //attributes that were saved
  /** The slugs Attio rejected, which the event continued without. */
  readonly dropped: readonly string[]; //attributes attio refused
}

//The company a lead was matched to or created as.
export interface ResolvedCompany {
  readonly id: string; //attio record id of the company
  /** The name Attio holds, which is what the deal is named after - not what the provider called it. */
  readonly name: string | null; //company name as attio has it
}

//How suppressing the lead went on one platform.
export interface SuppressionOutcome {
  readonly platform: string; //which platform this is about
  readonly status: "suppressed" | "skipped" | "failed"; //what happened there
  readonly detail: string | null; //extra info or error message
}

//How suppressing the lead went across every platform.
export interface SuppressionResult {
  readonly outcomes: readonly SuppressionOutcome[]; //one result per platform
  /** One entry per platform that could not be suppressed. Empty means the lead is suppressed everywhere. */
  readonly failures: readonly string[]; //platforms that failed, with reasons
}

//Everything a provider hands the shared workflow: the lead plus its own lookups.
export interface InterestedWorkflow {
  readonly lead: InterestedLead; //the normalised lead
  /**
   * How this provider identifies the person in Attio, in its own order of confidence - HeyReach leads with a
   * profile URL, Instantly and Aircall with an address. Returning null means no such person exists yet and one
   * is created from the lead.
   */
  readonly findPerson: () => Promise<AttioPerson | null>; //finds the existing person, or null
  /**
   * This provider's own message history, already rendered for the note. A thunk rather than a string because
   * fetching a thread costs a request, and it should not be paid until the lead is known to be recordable.
   */
  readonly history: () => Promise<string>; //builds the note text when asked
  /** What this event is called in the logs - "aircall call 4821", "heyreach-interested". */
  readonly subject: string; //name of this event in logs
}

//What recording an interested lead produced.
export interface InterestedOutcome {
  readonly personId: string; //attio id of the person
  readonly personName: string; //the person's display name
  readonly dealId: string; //attio id of the deal
  readonly companyId: string | null; //attio id of the company, if any
  readonly suppression: SuppressionResult; //how suppression went per platform
  /**
   * True when this event repeated one already recorded and the workflow declined to write anything. The ids
   * are the existing records' - see recentlyNoted. Routes report it so a suppressed repeat reads as a
   * decision in the response, not as a silent success.
   */
  readonly duplicate: boolean; //true if this was a skipped repeat
}

//A magnitude suffix on a number: 4.3M is 4,300,000. Providers abbreviate revenue and headcount this way, and
//reading "4.3M" as the digits 43 would be wrong by six orders of magnitude - silently, and permanently.
const MAGNITUDES: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000, b: 1_000_000_000, t: 1_000_000_000_000 }; //suffix letter to multiplier

//Hosts that are never a company's own domain. A provider that puts a LinkedIn or Facebook page where a website
//belongs - which they do - would otherwise write "linkedin.com" into Attio's Domains attribute, and Domains is
//UNIQUE: the first company to claim it takes the slot, and every company after that fails to match or to save.
//One bad value here does lasting damage to records it never touched, so the list errs on the side of refusing.
const NEVER_A_COMPANY_DOMAIN: ReadonlySet<string> = new Set([ //hosts never saved as a company domain
  "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com", "tiktok.com",
  "crunchbase.com", "angel.co", "wellfound.com", "github.com", "medium.com", "substack.com",
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "aol.com",
  "sites.google.com", "wixsite.com", "squarespace.com", "wordpress.com", "godaddysites.com",
]);

//A country name to its ISO 3166-1 alpha-2 code, because Attio's location attribute stores the code.
//Deliberately short: it covers the countries this workspace's lead data actually contains, and an address whose
//country is not listed simply gets no structured location. Extend it as new markets appear.
const COUNTRY_CODES: Readonly<Record<string, string>> = { //country name to two-letter code
  "united states": "US", //united states
  "united states of america": "US", //united states, long form
  usa: "US", //united states, short form
  us: "US", //united states, shortest form
  canada: "CA", //canada
  "united kingdom": "GB", //united kingdom
  uk: "GB", //united kingdom, short form
  "great britain": "GB", //united kingdom, other name
  england: "GB", //part of the uk
  scotland: "GB", //part of the uk
  wales: "GB", //part of the uk
  ireland: "IE", //ireland
  australia: "AU", //australia
  "new zealand": "NZ", //new zealand
  germany: "DE", //germany
  france: "FR", //france
  spain: "ES", //spain
  italy: "IT", //italy
  netherlands: "NL", //netherlands
  belgium: "BE", //belgium
  switzerland: "CH", //switzerland
  austria: "AT", //austria
  sweden: "SE", //sweden
  norway: "NO", //norway
  denmark: "DK", //denmark
  finland: "FI", //finland
  poland: "PL", //poland
  portugal: "PT", //portugal
  mexico: "MX", //mexico
  brazil: "BR", //brazil
  india: "IN", //india
  singapore: "SG", //singapore
  japan: "JP", //japan
  israel: "IL", //israel
  "south africa": "ZA", //south africa
  "united arab emirates": "AE", //united arab emirates
};

//The multiselect attributes these workflows write. A PATCH REPLACES an attribute rather than appending to it,
//so for these the existing entries are read and sent back alongside the new one. Every other attribute is left
//strictly alone once populated; these are the exception because a lead's second address or number is additive
//information, and skipping the write outright is what silently dropped it before.
const MULTISELECT_READERS: Readonly<Record<string, ScalarReader>> = { //list attribute slug to its value reader
  email_addresses: (value) => stringValue(value.email_address) ?? stringValue(value.original_email_address), //reads one saved email
  phone_numbers: (value) => stringValue(value.original_phone_number) ?? stringValue(value.phone_number), //reads one saved phone number
  domains: (value) => stringValue(value.domain) ?? stringValue(value.root_domain), //reads one saved domain
};

//---------------------------------------------------------------------------------------------------------
//The slugs that OVERWRITE rather than fill. The standing rule below is that Attio's own data always wins; this
//set is the deliberate exception to it, so the exception is one named list rather than a special case buried in
//the loop.
//
//WHY ATTRIBUTION IS ON IT. Every other attribute here is a fact about the person - a job title, a location -
//that a human may have corrected in the CRM and that a provider has no standing to contradict. A source is not
//a fact about the person; it is a statement about THIS run: the channel that just produced the interested
//signal. Filling it only when blank meant a person first seen on one platform kept that platform's label
//forever, and a later interested event on another channel was recorded everywhere except the field reporting
//reads. The value the run carries is by definition the most recent truth, so it replaces what is there.
//
//It matters twice over on the Deal, because a deal is REUSED when the person already has one (see
//ensureInterestedDeal): a lead first seen on Instantly and later replying on HeyReach keeps ONE deal, which
//without this would still read Cold Email months after the LinkedIn reply. Latest touch wins was the explicit
//call.
//
//COST: a record worked across channels no longer preserves the FIRST source, only the latest. The full history
//is still recoverable - every interested event writes a note titled with its own leadSourceLabel, so the
//sequence lives on the person's and the deal's notes even though the attributes hold only the newest.
//
//All four slugs come from attributionSlugs(), so they are declared once. Companies receive none of them.
//---------------------------------------------------------------------------------------------------------
const ALWAYS_OVERWRITE: ReadonlySet<string> = new Set(attributionSlugs()); //source slugs that always get replaced

//The Attio DNC list, prepended to the third-party channels. It lives here rather than in the register because
//it is the only channel that touches Attio, and keeping it here is what lets lib/providers.ts stay free of any
//Attio import. It is also the channel that governs Aircall dialling, which has no API of its own to call.
//[LOGIC] USES: addPersonToList, LISTS (lib/attio.ts).
const ATTIO_DNC_CHANNEL: SuppressionChannel = { //the attio do-not-contact channel
  platform: "attio DNC list", //name shown in logs
  suppress: async (targets) => { //adds the person to the DNC list
    await addPersonToList(targets.personId, LISTS.DNC, targets.personName); //put them on the list
    return { status: "suppressed" }; //report success
  },
};

//Long enough to cover a provider's retry and a fan-out across campaigns, short enough that a lead who replies
//again days later still earns a fresh note. Overridable per deployment without a redeploy.
export const DEFAULT_DUPLICATE_WINDOW_MS = 15 * 60 * 1_000; //15 minutes

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <build the normalised lead>

//#region <default every field>
//---------------------------------------------------------------------------------------------------------
//Base function. Builds a full InterestedLead from only the fields a provider has.
//Input: provider - which platform; fields - whichever lead fields it knows.
//Output: the lead, with every missing field set to null or an empty list.
//Workflow: each provider's interested route (aircall, heyreach, instantly, outfound) - builds the lead that
//recordInterestedLead (steps 0-7) then records.
//
//[LOGIC] Defaults every field, so a provider's extractor names only what it actually has. Absent means null,
//and null never reaches Attio - see updateAttioAttributes.
//---------------------------------------------------------------------------------------------------------
export function interestedLead(
  provider: Provider,
  fields: Partial<Omit<InterestedLead, "provider">>,
): InterestedLead {
  return {
    provider, //same as provider: provider
    emails: fields.emails ?? [], //missing becomes empty list
    phones: fields.phones ?? [], //missing becomes empty list
    firstName: fields.firstName ?? null, //missing becomes null
    lastName: fields.lastName ?? null, //missing becomes null
    linkedin: fields.linkedin ?? null, //missing becomes null
    jobTitle: fields.jobTitle ?? null, //missing becomes null
    description: fields.description ?? null, //missing becomes null
    location: fields.location ?? null, //missing becomes null
    companyName: fields.companyName ?? null, //missing becomes null
    companyDomain: fields.companyDomain ?? null, //missing becomes null
    companyAddress: fields.companyAddress ?? null, //missing becomes null
    employeeCount: fields.employeeCount ?? null, //missing becomes null
    annualRevenue: fields.annualRevenue ?? null, //missing becomes null
    industry: fields.industry ?? null, //missing becomes null
    website: fields.website ?? null, //missing becomes null
    campaignName: fields.campaignName ?? null, //missing becomes null
    occurredAtMs: fields.occurredAtMs ?? null, //missing becomes null
  };
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <format values for attio>

//---------------------------------------------------------------------------------------------------------
//[LOGIC] Provider values into the exact shape one Attio attribute type accepts.
//Every one returns null rather than a best guess when the input does not fit. A blank attribute is
//recoverable; a confidently wrong value is not, because nothing downstream will ever overwrite it.
//---------------------------------------------------------------------------------------------------------

//#region <counts and buckets>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads a count out of a number written any way a provider might write it.
//Input: value - text like "4.3M", "$1,200", "50-100", "84 employees".
//Output: the whole number, or null if there is no leading number.
//Workflow: interested workflow (recordInterestedLead) step 2 - toEmployeeRange and toArrBucket bucket the company.
//
//[LOGIC] A range keeps its lower bound rather than a midpoint because it is a value the provider actually
//stated, not one derived from it. Reading stops at the first non-numeric character, so "84 employees" reads
//as 84.
//---------------------------------------------------------------------------------------------------------
function toCount(value: string | null): number | null {
  if (!value) return null; //nothing to read
  //Currency symbols and separators carry no quantity; stripping them first leaves a bare number to read.
  const cleaned = value.replace(/[,\s$£€]/g, ""); //drop commas, spaces, currency signs
  //A range states two numbers. Only the first is kept - see above.
  const lowerBound = cleaned.split(/[-–—]/)[0] ?? ""; //keep the part before any dash
  const match = /^(\d+(?:\.\d+)?)([kmbt])?/i.exec(lowerBound); //leading number plus optional suffix
  if (!match?.[1]) return null; //no number at the start
  const amount = Number.parseFloat(match[1]); //the number as a decimal
  if (!Number.isFinite(amount)) return null; //not a real number
  const magnitude = match[2] ? (MAGNITUDES[match[2].toLowerCase()] ?? 1) : 1; //multiplier for k/m/b/t, else 1
  return Math.round(amount * magnitude); //the full whole number
}

//---------------------------------------------------------------------------------------------------------
//Turns a headcount into one of Attio's nine Employee range options.
//Input: value - headcount text as the provider wrote it.
//Output: a range label like "51-250", or null if unreadable or not positive.
//Uses: toCount (this file).
//Workflow: interested workflow (recordInterestedLead) step 2 - the company's Employee range, via companyValuesFor.
//
//[LOGIC] Boundaries follow the labels exactly.
//---------------------------------------------------------------------------------------------------------
export function toEmployeeRange(value: string | null): string | null {
  const count = toCount(value); //headcount as a number
  if (count === null || count <= 0) return null; //no usable headcount
  if (count <= 10) return "1-10"; //tiny company
  if (count <= 50) return "11-50"; //next bucket up
  if (count <= 250) return "51-250"; //next bucket up
  if (count <= 1_000) return "251-1K"; //next bucket up
  if (count <= 5_000) return "1K-5K"; //next bucket up
  if (count <= 10_000) return "5K-10K"; //next bucket up
  if (count <= 50_000) return "10K-50K"; //next bucket up
  if (count <= 100_000) return "50K-100K"; //next bucket up
  return "100K+"; //biggest bucket
}

//---------------------------------------------------------------------------------------------------------
//Turns a revenue figure in dollars into one of Attio's nine Estimated ARR options.
//Input: value - revenue text as the provider wrote it.
//Output: a bucket label like "$1M-$10M", or null if unreadable or not positive.
//Uses: toCount (this file).
//Workflow: interested workflow (recordInterestedLead) step 2 - the company's Estimated ARR, via companyValuesFor.
//---------------------------------------------------------------------------------------------------------
export function toArrBucket(value: string | null): string | null {
  const amount = toCount(value); //revenue as a number
  if (amount === null || amount <= 0) return null; //no usable revenue
  if (amount < 1_000_000) return "$0-$1M"; //under a million
  if (amount < 10_000_000) return "$1M-$10M"; //next bucket up
  if (amount < 50_000_000) return "$10M-$50M"; //next bucket up
  if (amount < 100_000_000) return "$50M-$100M"; //next bucket up
  if (amount < 250_000_000) return "$100M-$250M"; //next bucket up
  if (amount < 500_000_000) return "$250M-$500M"; //next bucket up
  if (amount < 1_000_000_000) return "$500M-$1B"; //next bucket up
  if (amount < 10_000_000_000) return "$1B-$10B"; //next bucket up
  return "$10B+"; //biggest bucket
}
//#endregion

//#region <domains>
//---------------------------------------------------------------------------------------------------------
//Base function. Gets a clean hostname from whatever a provider called a website.
//Input: value - a url, bare hostname, or anything else the provider sent.
//Output: e.g. "acme.com", or null if it is not this company's own domain.
//Workflow: interested workflow (recordInterestedLead) step 2 - the domain used to find or create the company.
//
//[LOGIC] A scheme is added when there is none, because a bare hostname will not parse as a URL without one.
//Parsing as a URL is what stops a path, port, or query surviving.
//Rejecting a known non-company host is the important part - see NEVER_A_COMPANY_DOMAIN. Attio's Domains
//attribute is unique, so a wrong value is not merely wrong on this record; it takes a slot no other company
//can then claim.
//---------------------------------------------------------------------------------------------------------
export function toDomain(value: string | null): string | null {
  if (!value) return null; //nothing given
  const trimmed = value.trim(); //remove surrounding spaces
  if (!trimmed) return null; //only spaces, nothing given
  let host: string; //the hostname, once parsed
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname; //parse as url, keep host only
  } catch {
    return null; //not parseable as a url
  }
  const domain = host.toLowerCase().replace(/^www\./, ""); //lowercase, drop leading "www."
  //A domain has a dot and no whitespace. Rejects "localhost" and a company name that arrived here by mistake.
  if (!domain.includes(".") || /\s/.test(domain)) return null; //does not look like a domain
  if (NEVER_A_COMPANY_DOMAIN.has(domain)) { //social, code, or mailbox host
    console.warn( //log why it was refused
      `[attio] ${JSON.stringify(domain)} was not written as a company domain: it is a social, code, or mailbox host, and Domains is unique in Attio - claiming it would block every other company that shares it`,
    );
    return null; //refuse it
  }
  return domain; //the clean domain
}
//#endregion

//#region <postal addresses>
//---------------------------------------------------------------------------------------------------------
//Base function. Turns a comma-separated postal address into Attio's structured location.
//Input: value - the address as one string.
//Output: an AttioLocation, or null unless the country resolves to an ISO code.
//Workflow: interested workflow (recordInterestedLead) step 2 - the company's primary location, via companyValuesFor.
//
//Providers send "<street>, <city>, <region>, <country>, <postcode>" - country second to last, postcode last -
//so the address is read from the RIGHT, where the fields are positional, and whatever remains on the left
//becomes the street line.
//Without a country code Attio has no location to store, and a guessed country is worse than none: it would
//place the company on the wrong continent in every filter.
//---------------------------------------------------------------------------------------------------------
export function parsePostalAddress(value: string | null): AttioLocation | null {
  if (!value) return null; //no address given
  const parts = value //split into trimmed, non-empty pieces
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return null; //too few pieces to be an address

  //A trailing field carrying a digit is a postcode, not a country. Dropping it first leaves the country last
  //whether or not a postcode was present.
  let postcode: string | null = null; //postcode, if one is found
  const tail = parts[parts.length - 1]; //the last piece
  if (tail !== undefined && /\d/.test(tail) && parts.length > 3) { //last piece has a digit
    postcode = tail; //it is the postcode
    parts.pop(); //remove it from the list
  }

  const country = parts.pop(); //country is now the last piece
  const countryCode = country ? COUNTRY_CODES[country.toLowerCase()] : undefined; //look up its two-letter code
  if (!countryCode) return null; //unknown country, no location

  const region = parts.pop() ?? null; //state or province
  const locality = parts.pop() ?? null; //city
  //Anything still to the left is street address, rejoined as it arrived.
  const line1 = parts.length > 0 ? parts.join(", ") : null; //street, or null if none left

  return {
    line_1: line1, //street address
    line_2: null, //unused
    line_3: null, //unused
    line_4: null, //unused
    locality, //same as locality: locality
    region, //same as region: region
    postcode, //same as postcode: postcode
    country_code: countryCode, //two-letter country code
    latitude: null, //unknown
    longitude: null, //unknown
  };
}
//#endregion

//#region <dates and times>
//---------------------------------------------------------------------------------------------------------
//Base function. Writes an epoch-millisecond instant as an Attio timestamp.
//Input: ms - the instant, or null when the caller had no time to give.
//Output: an ISO timestamp string, or null.
//Workflow: interested workflow (recordInterestedLead) step 5 - the deal's Moved to Interested At, via
//dealValuesFor; also used by toDate.
//---------------------------------------------------------------------------------------------------------
export function toTimestamp(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null; //no usable time
  return new Date(ms).toISOString(); //e.g. "2026-08-28T17:04:05.000Z"
}

//---------------------------------------------------------------------------------------------------------
//Writes the same instant as an Attio date (no time part).
//Input: ms - the instant, or null.
//Output: "YYYY-MM-DD", or null.
//Uses: toTimestamp (this file).
//Workflow: interested workflow (recordInterestedLead) steps 1 and 5 - the person's Date Added, via personValuesFor.
//
//Date-typed attributes reject a full timestamp.
//---------------------------------------------------------------------------------------------------------
export function toDate(ms: number | null): string | null {
  const iso = toTimestamp(ms); //full timestamp first
  return iso ? iso.slice(0, 10) : null; //keep just the date part
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <write attributes to attio>

//#region <merge multiselects>
//---------------------------------------------------------------------------------------------------------
//Reads the scalars a list attribute currently holds on a record.
//Input: record - the Attio record; slug - the attribute; read - how to read one entry.
//Output: the values as strings, or null if ANY entry could not be read.
//Uses: arrayValue, isJsonObject (lib/json.ts).
//Workflow: interested workflow (recordInterestedLead) step 5 - mergeMultiselect's view of what is already there.
//
//[LOGIC] All-or-nothing on purpose: a partial read is what would silently delete the entries it failed to
//see - see mergeMultiselect.
//---------------------------------------------------------------------------------------------------------
function existingScalars(record: AttioRecord, slug: string, read: ScalarReader): string[] | null {
  const scalars: string[] = []; //values read so far
  for (const entry of arrayValue(record.rawValues, slug)) { //each saved entry
    if (!isJsonObject(entry)) return null; //unreadable entry, give up
    const scalar = read(entry); //pull out its text
    if (scalar === null) return null; //unreadable entry, give up
    scalars.push(scalar); //keep it
  }
  return scalars; //every saved value
}

//---------------------------------------------------------------------------------------------------------
//Builds the full new value of a list attribute: existing entries plus whichever candidates are new.
//Input: record - the Attio record; slug - the attribute; candidate - values the provider has.
//Output: the merged list, or null to write nothing at all.
//Uses: existingScalars (this file); arrayValue (lib/json.ts).
//Workflow: interested workflow (recordInterestedLead) step 5 - updateAttioAttributes, for emails, phones, domains.
//
//[SECURITY] The null returns are the important part. This is the only place in the codebase that sends Attio a
//value it did not itself supply, and it does so on a REPLACING write: if the existing entries were read back
//even slightly wrong, the patch would delete a real address or phone number. So an attribute holding anything
//this cannot read in full is declined outright, and an attribute that would gain nothing is left untouched
//rather than rewritten to its own value.
//[DEBUG] The decline on an unreadable existing entry warns, because an attribute quietly not gaining a value
//is undiagnosable.
//---------------------------------------------------------------------------------------------------------
function mergeMultiselect(
  record: AttioRecord,
  slug: string,
  candidate: readonly string[],
): readonly string[] | null {
  const read = MULTISELECT_READERS[slug]; //reader for this attribute
  if (!read) return null; //not a list attribute we handle
  const existing = existingScalars(record, slug, read); //what attio already holds
  if (existing === null) { //could not read it all
    console.warn( //log the skipped attribute
      `[attio] ${slug} was left alone: it already holds ${arrayValue(record.rawValues, slug).length} entr(ies) that could not all be read back, and this attribute can only be written whole. Nothing was risked, but nothing was added either.`,
    );
    return null; //write nothing
  }
  //Case-insensitive, because an address or domain differing only in case is the same one and must not be added
  //twice. Phone numbers are E.164 by the time they arrive, so this costs them nothing.
  const seen = new Set(existing.map((value) => value.toLowerCase())); //values already present, lowercase
  const additions = candidate.filter((value) => { //keep only new values
    const key = value.toLowerCase(); //compare ignoring case
    if (seen.has(key)) return false; //already there, skip
    seen.add(key); //remember it, so no repeats
    return true; //new value, keep
  });
  if (additions.length === 0) return null; //nothing new, write nothing
  return [...existing, ...additions]; //old values then new ones
}
//#endregion

//#region <drop empty values>
//---------------------------------------------------------------------------------------------------------
//Base function. Says whether a value has nothing worth writing.
//Input: value - any candidate attribute value.
//Output: true if absent, blank, or an empty list.
//Workflow: interested workflow (recordInterestedLead) steps 1, 2 and 5 - withoutEmpty and updateAttioAttributes.
//
//[LOGIC] Distinct from a value Attio already holds.
//---------------------------------------------------------------------------------------------------------
function isEmptyCandidate(value: unknown): boolean {
  if (value === undefined || value === null) return true; //absent
  if (typeof value === "string") return value.trim().length === 0; //blank text
  if (Array.isArray(value)) return value.length === 0; //empty list
  return false; //anything else counts as a value
}

//---------------------------------------------------------------------------------------------------------
//Copies a set of attribute values with every empty one removed.
//Input: values - slug-to-value map.
//Output: the same map without empty values.
//Uses: isEmptyCandidate (this file).
//Workflow: interested workflow (recordInterestedLead) steps 1, 2 and 5 - the last step of personValuesFor,
//companyValuesFor and dealValuesFor.
//
//[LOGIC] So a slug the provider knows nothing about is absent rather than present-and-null.
//It matters most on CREATION: createPerson and createCompany send their values to Attio verbatim, with none of
//the filtering updateAttioAttributes does, and a null or an empty array on a create is an instruction to Attio
//about an attribute rather than silence about it.
//---------------------------------------------------------------------------------------------------------
function withoutEmpty(values: Record<string, unknown>): AttioValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmptyCandidate(value))); //keep non-empty pairs only
}
//#endregion

//#region <patch records>
//---------------------------------------------------------------------------------------------------------
//Writes the fillable attributes, salvaging as many as Attio will take.
//Input: object - people, companies or deals; recordId - the record; fillable - slug-to-value map; label - name
//for logs.
//Output: { written, dropped }. Throws only if the empty no-op write fails.
//Uses: patchRecord (lib/attio.ts); errorMessage (lib/json.ts).
//Workflow: interested workflow (recordInterestedLead) steps 2 and 5 - the actual PATCH for updateAttioAttributes.
//
//[LOGIC] One PATCH with all of them is the normal case and the only request usually made. If that is rejected
//on the CONTENT of the write - a 400 or 422 - they are retried one at a time, so one value Attio will not
//accept costs only itself.
//A rejection that is not about content - 401, 403, 404, a 5xx, a transport failure - is not retried: the write
//is unavailable for reasons no single attribute caused, and N further attempts would fail identically.
//NEVER THROWS. Attribute enrichment is the last and least of what an interested event does; the person, the
//company, the deal, and the notes are already committed by the time it runs, and losing all of them because one
//provider value would not fit an Attio attribute is a far worse outcome than a blank field. What was dropped is
//logged, because an attribute silently missing with no record of why is undiagnosable.
//[DEBUG] Everything dropped is named individually and then counted, so a missing attribute has a cause on
//record. patchRecord logs its own FAILED line first; the [attio] line that follows says what was done about it.
//---------------------------------------------------------------------------------------------------------
async function writeSalvagingRejections(
  object: AttioObject,
  recordId: string,
  fillable: Record<string, unknown>,
  label: string,
): Promise<AttributeWriteResult> {
  const slugs = Object.keys(fillable); //names of attributes to write
  if (slugs.length === 0) { //nothing to write
    await patchRecord(object, recordId, {}, label); //empty patch, nothing changes
    return { written: [], dropped: [] }; //nothing written or dropped
  }

  try {
    await patchRecord(object, recordId, fillable, label); //write everything at once
    return { written: slugs, dropped: [] }; //all of it stuck
  } catch (error) {
    //Only a complaint about the content is worth taking apart attribute by attribute.
    const isContentRejection = //attio refused the values themselves
      error instanceof AttioApiError && (error.status === 400 || error.status === 422);
    if (!isContentRejection) { //some other failure
      console.warn( //log that everything was dropped
        `[attio] ${object} ${label}: dropped ${slugs.join(", ")} - the write failed for a reason no single attribute caused (${errorMessage(error)}). The event continues without them.`,
      );
      return { written: [], dropped: slugs }; //give up on all of them
    }
    console.warn( //log the one-at-a-time retry
      `[attio] ${object} ${label}: Attio rejected the write on its content, so the ${slugs.length} attribute(s) are retried one at a time - one value it will not accept should cost only itself`,
    );
  }

  const written: string[] = []; //attributes that stuck
  const dropped: string[] = []; //attributes attio refused
  for (const slug of slugs) { //each attribute on its own
    try {
      await patchRecord(object, recordId, { [slug]: fillable[slug] }, label); //write just this one
      written.push(slug); //it stuck
    } catch (error) {
      dropped.push(slug); //it was refused
      console.warn( //log the dropped attribute
        `[attio] ${object} ${label}: dropped ${slug} - Attio would not accept the value (${errorMessage(error)}). The event continues without it.`,
      );
    }
  }
  if (dropped.length > 0) { //something was refused
    console.warn( //log the totals
      `[attio] ${object} ${label}: wrote ${written.length} attribute(s), dropped ${dropped.length} (${dropped.join(", ")})`,
    );
  }
  return { written, dropped }; //what stuck and what didn't
}

//---------------------------------------------------------------------------------------------------------
//Writes a lead's values onto an Attio record, filling blanks without overwriting.
//Input: object - people, companies or deals; target - the record or its id; candidate - values to offer;
//recordName - optional name for logs.
//Output: { written, dropped }. Throws only if reading the record by id fails.
//Uses: fetchRecord, recordDisplayName (lib/attio.ts); runLogApplied (lib/run-log.ts); isEmptyCandidate,
//mergeMultiselect, writeSalvagingRejections (this file).
//Workflow: interested workflow (recordInterestedLead) step 5 - person and deal attributes; also step 2 - fills
//the company's blanks in resolveInterestedCompany.
//
//THE write path for attributes on an interested lead's records. All three interested workflows go through here.
//
//The rule it exists to enforce: third-party data fills gaps in Attio and never contradicts it. Someone who
//corrected a job title in the CRM must not find it replaced by whatever the provider still believes. The ONE
//exception is ALWAYS_OVERWRITE, where the run's own value is the newer truth by definition.
//A record id is read first, because what may be written depends on what is already there.
//
//[PERF] One GET when handed an id, none when handed a record. Callers holding a record they just created or
//queried pass the record, so the common path costs a single PATCH.
//[STABILITY] Does not throw once the record is in hand - see writeSalvagingRejections. A read that fails still
//throws, because without knowing what the record holds there is no way to write without risking an overwrite.
//---------------------------------------------------------------------------------------------------------
export async function updateAttioAttributes(
  object: AttioObject,
  target: AttioRecord | string,
  candidate: AttioValues,
  recordName?: string,
): Promise<AttributeWriteResult> {
  const record = typeof target === "string" ? await fetchRecord(object, target) : target; //read it if given an id
  const label = recordName ?? recordDisplayName(record) ?? record.id.record_id; //name to use in logs

  const fillable: Record<string, unknown> = {}; //attributes we are allowed to write
  for (const [slug, value] of Object.entries(candidate)) { //each offered attribute
    if (isEmptyCandidate(value)) continue; //nothing to write, skip

    if (slug in MULTISELECT_READERS && Array.isArray(value)) { //a list attribute
      const strings = value.filter((entry): entry is string => typeof entry === "string"); //keep text entries only
      const merged = mergeMultiselect(record, slug, strings); //old values plus new ones
      if (merged) fillable[slug] = merged; //write only if something was added
      continue; //done with this attribute
    }
    //Populated means "Attio holds something here". A PATCH would replace the whole attribute rather than merge
    //into it, so anything already present is left strictly alone - unless the slug is one this run is entitled
    //to restate outright. See ALWAYS_OVERWRITE.
    if (!ALWAYS_OVERWRITE.has(slug) && record.populatedAttributes.has(slug)) continue; //already filled, leave it
    fillable[slug] = value; //blank or overwritable, write it
  }

  const result = await writeSalvagingRejections(object, record.id.record_id, fillable, label); //send the write
  //debug note in attio=
  runLogApplied(object, record.id.record_id, fillable, result.written); //write down which changes actually stuck
  //===============
  return result; //what stuck and what didn't
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <map a lead onto attio values>

//---------------------------------------------------------------------------------------------------------
//Which provider field lands on which Attio slug. Pure, so the mapping is testable without a network, and in
//one place so a new provider inherits the whole thing by filling in an InterestedLead.
//A slug absent from these three objects is a slug these workflows never write.
//---------------------------------------------------------------------------------------------------------

//#region <person, company, deal>
//---------------------------------------------------------------------------------------------------------
//Maps a lead onto Person attribute values.
//Input: lead - the normalised lead; companyId - the resolved company's id, or null.
//Output: slug-to-value map with empty values removed.
//Uses: attributionValues (lib/providers.ts); toDate, withoutEmpty (this file).
//Workflow: interested workflow (recordInterestedLead) step 1 - the values a new person is created with; and
//step 5 - the values offered to an existing person.
//---------------------------------------------------------------------------------------------------------
export function personValuesFor(lead: InterestedLead, companyId: string | null = null): AttioValues {
  const values: Record<string, unknown> = { //attio slug to value
    email_addresses: lead.emails, //every email
    phone_numbers: lead.phones, //every phone number
    linkedin: lead.linkedin, //linkedin profile url
    job_title: lead.jobTitle, //job title
    description: lead.description, //free-text about them
    location: lead.location, //where they are
    campaign_name: lead.campaignName, //campaign that reached them
    date_added: toDate(lead.occurredAtMs), //day they became interested
    //NO lead_source. It is deprecated on both objects, replaced by the discrete pair below - so writing it
    //would be churn on a field nothing reads, and churn that OVERWRITES, since it used to sit in
    //ALWAYS_OVERWRITE. Values already on existing records are left exactly as found; nothing writes the slug
    //now, so nothing can clear it either. The deals object has already had the attribute removed outright.
    //The Person's own discrete pair. Same words as the Deal's, entirely different option IDs, which is why
    //the object is named here rather than the ids being reused - see attributionValues (lib/providers.ts).
    ...attributionValues("people", lead.provider), //add the source attributes
  };
  if (lead.firstName || lead.lastName) { //we know at least one name
    const firstName = lead.firstName ?? ""; //blank if unknown
    const lastName = lead.lastName ?? ""; //blank if unknown
    values.name = [ //attio's name shape
      { first_name: firstName, last_name: lastName, full_name: `${firstName} ${lastName}`.trim() },
    ];
  }
  //Offered whenever a company was resolved; updateAttioAttributes drops it if the person already has one.
  if (companyId) { //a company was found or made
    values.company = { target_object: "companies", target_record_id: companyId }; //link the person to it
  }
  return withoutEmpty(values); //drop the empty ones
}

//---------------------------------------------------------------------------------------------------------
//Maps a lead onto Company attribute values.
//Input: lead - the normalised lead.
//Output: slug-to-value map with empty values removed.
//Uses: toDomain, parsePostalAddress, toEmployeeRange, toArrBucket, withoutEmpty (this file).
//Workflow: interested workflow (recordInterestedLead) step 2 - creates or fills the company in
//resolveInterestedCompany.
//---------------------------------------------------------------------------------------------------------
export function companyValuesFor(lead: InterestedLead): AttioValues {
  const domain = toDomain(lead.companyDomain ?? lead.website); //clean domain, or null
  return withoutEmpty({ //drop the empty ones
    //A company found only by domain still needs a name, and the domain is the least wrong one available.
    name: lead.companyName ?? domain, //company name, else its domain
    domains: domain ? [domain] : [], //domain as a list
    primary_location: parsePostalAddress(lead.companyAddress), //structured address
    employee_range: toEmployeeRange(lead.employeeCount), //headcount bucket
    estimated_arr_usd: toArrBucket(lead.annualRevenue), //revenue bucket
  });
}

//---------------------------------------------------------------------------------------------------------
//Maps a lead onto Deal attribute values.
//Input: lead - the normalised lead.
//Output: slug-to-value map with empty values removed.
//Uses: attributionValues (lib/providers.ts); toTimestamp, withoutEmpty (this file).
//Workflow: interested workflow (recordInterestedLead) step 5 - the values offered to the deal.
//---------------------------------------------------------------------------------------------------------
export function dealValuesFor(lead: InterestedLead): AttioValues {
  return withoutEmpty({ //drop the empty ones
    //NO lead_source HERE. The deals object no longer has that attribute at all - it was removed from Attio
    //when deal_source_discrete replaced it. Writing it cost every deal an extra round trip and a warning:
    //writeSalvagingRejections sends one PATCH with everything, Attio rejects the whole batch over the one
    //unknown slug, and each remaining attribute is then retried individually. The live schema test in
    //tests/live/read-only.test.ts is what catches this class of drift.
    //The discrete attribution pair, written by option ID rather than title so a rename in Attio cannot quietly
    //break them. The DEAL's ids, which differ from the Person's for the same words - see attributionValues.
    ...attributionValues("deals", lead.provider), //add the source attributes
    campaign_name: lead.campaignName, //campaign that reached them
    email: lead.emails[0] ?? null, //first email only
    phone_number_7: lead.phones[0] ?? null, //first phone number only
    linkedin: lead.linkedin, //linkedin profile url
    website: lead.website, //company website
    //Free text on the Deal, so these cross over exactly as the provider spelled them. The bucketed equivalents
    //live on the Company.
    industry: lead.industry, //industry, as written
    employees: lead.employeeCount, //headcount, as written
    revenue: lead.annualRevenue, //revenue, as written
    moved_to_interested_at: toTimestamp(lead.occurredAtMs), //when they became interested
  });
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <resolve the company and name the deal>

//#region <company>
//---------------------------------------------------------------------------------------------------------
//Finds or creates the company an interested lead belongs to, and fills its blank attributes in passing.
//Input: lead - the normalised lead; person - the lead's Attio person.
//Output: { id, name } of the company, or null when there is nothing to find or create it from.
//Uses: personCompanyId, fetchRecord, recordDisplayName, findCompanyByDomain, findCompanyByName, createCompany
//(lib/attio.ts); runLogRecord (lib/run-log.ts); toDomain, companyValuesFor, updateAttioAttributes (this file).
//Workflow: interested workflow (recordInterestedLead) step 2 - find or create the company.
//
//A person already linked to a company keeps it, unconditionally and on purpose: a person's company in Attio is
//a human's judgement, and a provider's `companyName` string is not grounds for moving them.
//The guard before creating is what keeps a cold Aircall dial from creating a company: with no contact in
//Aircall's address book there is no name, and a company record named after a phone number is worse than no
//company at all.
//[DEBUG] Each branch logs which one it took, because "no company" and "the company Attio already had" produce
//very different deals and the difference is invisible afterwards.
//---------------------------------------------------------------------------------------------------------
export async function resolveInterestedCompany(
  lead: InterestedLead,
  person: AttioPerson,
): Promise<ResolvedCompany | null> {
  const linkedId = personCompanyId(person); //company already on the person
  if (linkedId) { //person already has a company
    const linked = await fetchRecord("companies", linkedId); //read that company
    console.log( //log which company won
      `[lookup] company: person is already linked to ${recordDisplayName(linked) ?? linkedId}, which the deal will be named after`,
    );
    //debug note in attio=
    runLogRecord("companies", linked, true, recordDisplayName(linked) ?? linkedId); //take a photo of the company before we change it
    //===============
    await updateAttioAttributes("companies", linked, companyValuesFor(lead)); //fill its blanks
    return { id: linkedId, name: recordDisplayName(linked) }; //use the linked company
  }

  const domain = toDomain(lead.companyDomain ?? lead.website); //clean domain, or null
  const found = (await findCompanyByDomain(domain)) ?? (await findCompanyByName(lead.companyName)); //by domain, then by name
  if (found) { //an existing company matched
    //debug note in attio=
    runLogRecord("companies", found, true, recordDisplayName(found) ?? found.id.record_id); //take a photo of the company before we change it
    //===============
    await updateAttioAttributes("companies", found, companyValuesFor(lead)); //fill its blanks
    return { id: found.id.record_id, name: recordDisplayName(found) }; //use the matched company
  }

  if (!lead.companyName && !domain) { //nothing to create one from
    console.log( //log that there is no company
      `[lookup] company: none - neither Attio nor ${lead.provider} has a company for this lead, so none is created and the deal is named for an unknown company`,
    );
    return null; //no company
  }
  const created = await createCompany(companyValuesFor(lead)); //make a new company
  //debug note in attio=
  runLogRecord("companies", created, false, recordDisplayName(created) ?? created.id.record_id); //brand new company, so there is no before photo
  //===============
  return { id: created.id.record_id, name: recordDisplayName(created) }; //use the new company
}
//#endregion

//#region <deal name>
//---------------------------------------------------------------------------------------------------------
//Base function. Names a deal this codebase opens: strictly the company name, with no other form.
//Input: companyName - the company's name, or null.
//Output: the trimmed name, or "Unknown Company".
//Workflow: interested workflow (recordInterestedLead) step 3 - the name a new deal is given.
//
//The convention is strict so a person's name never becomes a deal name: a deal belongs to a company even when
//only one contact there is known.
//"Unknown Company" is used when neither Attio nor the provider names one, which is honest and, more usefully,
//greppable - those are exactly the deals needing a human to say who they are with.
//The name carries no marker of how the deal was opened. It used to read "<company> - Interested", which made
//these deals recognisable as a set from the name alone; that is now carried by `deal_source_discrete`
//instead, which every one of them gets - see attributionValues (lib/providers.ts). Reporting reads the
//attribute, and a human reading the pipeline sees the company they are dealing with rather than a suffix
//repeated down the whole column.
//Deals that already existed are never renamed - see ensureInterestedDeal.
//---------------------------------------------------------------------------------------------------------
export function interestedDealName(companyName: string | null): string {
  const name = companyName?.trim(); //name without outer spaces
  return name ? name : "Unknown Company"; //fallback when there is no name
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <suppress the lead everywhere>

//#region <every channel>
//---------------------------------------------------------------------------------------------------------
//Stops every outbound channel contacting a lead who has already said yes.
//Input: targets - the person's id and name, plus email and profile url where known.
//Output: { outcomes, failures } - one outcome per channel. Never throws for a channel failure.
//Uses: errorMessage (lib/json.ts); each channel's suppress - ATTIO_DNC_CHANNEL (this file),
//THIRD_PARTY_SUPPRESSION_CHANNELS (lib/providers.ts).
//Workflow: interested workflow (recordInterestedLead) step 6 - suppression on every platform.
//
//One function, called by every interested workflow, because interest is a fact about the person and not about
//the channel that found it: a lead who answers the phone must stop receiving the cold email sequence too, and
//the reverse. Suppressing only the channel that happened to report first is how a lead ends up pitched twice.
//
//Which channels exist is not decided here - see THIRD_PARTY_SUPPRESSION_CHANNELS (lib/providers.ts). A new
//outbound platform is appended there and is suppressed by this function from that moment, for every provider,
//with no change to this file or to any route.
//
//[STABILITY] Every channel is independent and a failure in one does not stop the others: half the platforms
//suppressed is strictly better than one suppressed and the rest untouched because the first threw. Failures are
//returned for the caller to report rather than raised, and no channel is retried.
//A channel that reports "skipped" is not a failure - it means the lead is not present on that platform to
//suppress, usually for want of the one identifier it works by.
//[DEBUG] Every channel logs its own result and the summary repeats them together, so a half-suppressed lead is
//readable from one line rather than reconstructed from three.
//---------------------------------------------------------------------------------------------------------
export async function suppressInterestedLead(targets: SuppressionTargets): Promise<SuppressionResult> {
  const channels = [ATTIO_DNC_CHANNEL, ...THIRD_PARTY_SUPPRESSION_CHANNELS]; //attio DNC first, then the rest
  const outcomes: SuppressionOutcome[] = []; //result per channel
  const failures: string[] = []; //channels that threw

  for (const channel of channels) { //each platform in turn
    try {
      const result = await channel.suppress(targets); //suppress the lead there
      if (result.status === "skipped") { //lead not on that platform
        console.log(`[suppress] ${channel.platform}: skipped - ${result.reason}`); //log the skip
        outcomes.push({ platform: channel.platform, status: "skipped", detail: result.reason }); //record the skip
        continue; //next channel
      }
      console.log(`[suppress] ${channel.platform}: suppressed${result.detail ? ` - ${result.detail}` : ""}`); //log the success
      outcomes.push({ platform: channel.platform, status: "suppressed", detail: result.detail ?? null }); //record the success
    } catch (error) {
      const message = errorMessage(error); //error as text
      failures.push(`${channel.platform}: ${message}`); //remember the failure
      console.error(`[suppress] ${channel.platform}: FAILED - ${message}`); //log the failure
      outcomes.push({ platform: channel.platform, status: "failed", detail: message }); //record the failure
    }
  }

  console.log( //one summary line for every channel
    `[suppress] ${targets.personName}: ${outcomes.map((outcome) => `${outcome.platform} ${outcome.status}`).join(", ")}`,
  );
  return { outcomes, failures }; //every result, plus the failures
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <decline repeated events>

//WHY THIS EXISTS. Attio offers no idempotency key and no upsert for notes - createNote (lib/attio.ts) appends,
//so the same event arriving twice leaves two identical notes on the Person and two on the Deal, plus a
//transcript apiece. Every other step of the workflow converges on its own: the person, company and deal are
//all find-or-create, and updateAttioAttributes fills blanks. The note is the one step that accumulates.
//
//Providers repeat events for reasons that are theirs, not ours. HeyReach's webhook is registered against ALL
//campaigns, and a lead enrolled in several, or auto-tagged again on a second inbound message, produces one
//delivery apiece - each a true event by HeyReach's reckoning and indistinguishable from the last by ours. A
//relay retry after a partial failure does the same. Filtering on the event name addresses the first cause
//only; this addresses all of them, for every provider, at the one point where repetition actually costs.
//
//WHAT COUNTS AS A REPEAT: a note already on the Person, carrying the title this run would write - the
//provider's own lead-source label - and created inside the window. Title alone would be wrong: a lead who
//re-engages weeks later is a real second event that deserves its own note. The window is what separates a
//burst from a return.
//
//[STABILITY] THIS NARROWS THE WINDOW, IT DOES NOT CLOSE IT. The check is a read and the write that follows is
//a separate request, with no transaction between them. Two deliveries landing in different Vercel instances
//within the same few hundred milliseconds can both read "no note" and both write. What is observed in
//production is deliveries seconds apart, which this catches; simultaneous ones would need a lock Attio cannot
//give us. The same gap already lets two simultaneous events create two Person records, which predates this
//check and is not addressed by it.

//#region <duplicate window>
//---------------------------------------------------------------------------------------------------------
//Reads how long a repeat counts as a repeat, from INTERESTED_DUPLICATE_WINDOW_MS or the default.
//Input: none.
//Output: the window in milliseconds; 0 means the check is off.
//Uses: tunableEnv, reportConfigValue (lib/env.ts).
//Workflow: interested workflow (recordInterestedLead) step 0 - the window recentlyNoted checks against.
//
//[STABILITY] A malformed value falls back rather than throwing, matching budgetMs (lib/run-budget.ts): losing
//the override is a tuning problem, losing the event is a data problem. Zero is honoured as "off", because
//disabling the check is a legitimate thing to want and a negative number is not.
//---------------------------------------------------------------------------------------------------------
function duplicateWindowMs(): number {
  const raw = tunableEnv( //the setting's raw text, if set
    "INTERESTED_DUPLICATE_WINDOW_MS",
    `using the ${DEFAULT_DUPLICATE_WINDOW_MS / 60_000}-minute default`,
  );
  if (!raw) return DEFAULT_DUPLICATE_WINDOW_MS; //not set, use the default
  const parsed = Number(raw); //text to number
  if (!Number.isFinite(parsed) || parsed < 0) { //not a usable number
    console.warn( //log the bad setting
      `[config] INTERESTED_DUPLICATE_WINDOW_MS is not a non-negative number (${JSON.stringify(raw)}) - using the ${DEFAULT_DUPLICATE_WINDOW_MS / 60_000}-minute default`,
    );
    return DEFAULT_DUPLICATE_WINDOW_MS; //fall back to the default
  }
  reportConfigValue("INTERESTED_DUPLICATE_WINDOW_MS", raw); //log the override in use
  return parsed; //the configured window
}
//#endregion

//#region <repeat check>
//---------------------------------------------------------------------------------------------------------
//Says whether this person already carries a note titled `title` from inside the duplicate window.
//Input: person - the existing Attio person; title - this run's note title; nowMs - the current time.
//Output: true if a matching recent note exists. Never throws.
//Uses: duplicateWindowMs (this file); listNotes (lib/attio.ts); errorMessage (lib/json.ts).
//Workflow: interested workflow (recordInterestedLead) step 0 - the repeat check.
//
//[STABILITY] FAILS OPEN, DELIBERATELY. A read error is swallowed and a truncated listing answers false,
//because the cost of the two outcomes is not symmetric: a wrong "yes" silently discards a real interested
//lead, which is the event this whole codebase exists to capture, while a wrong "no" writes a duplicate note -
//the status quo, and visible. Neither is silent in the log.
//---------------------------------------------------------------------------------------------------------
async function recentlyNoted(person: AttioPerson, title: string, nowMs: number): Promise<boolean> {
  const windowMs = duplicateWindowMs(); //how far back counts
  if (windowMs === 0) return false; //check is switched off

  const personId = person.id.record_id; //the person's attio id
  try {
    const { notes, complete } = await listNotes("people", personId); //read the person's notes
    const floorMs = nowMs - windowMs; //oldest time that still counts
    const match = notes.find((note) => note.title === title && note.createdAtMs >= floorMs); //same title, recent enough
    if (match) { //a repeat
      console.log( //log the matching note
        `[dedupe] people ${personId}: ${JSON.stringify(title)} was already posted at ${new Date(match.createdAtMs).toISOString()}, inside the ${windowMs / 60_000}-minute window`,
      );
      return true; //yes, it repeats
    }
    if (!complete) { //could not read every note
      console.warn( //log that we could not be sure
        `[dedupe] people ${personId}: the note listing could not be read to the end, so no repeat could be ruled out - proceeding, which risks a duplicate note rather than dropping the lead`,
      );
    }
    return false; //not a repeat
  } catch (error) {
    console.warn( //log the failed read
      `[dedupe] people ${personId}: the note listing could not be read, so no repeat could be ruled out - proceeding, which risks a duplicate note rather than dropping the lead. ${errorMessage(error)}`,
    );
    return false; //fail open: treat as new
  }
}

//---------------------------------------------------------------------------------------------------------
//Base function. Builds the outcome a declined repeat returns: the first run's records, nothing written.
//Input: person - the existing Attio person; personName - their display name.
//Output: the outcome with duplicate true, or null when the person carries no deal.
//Workflow: interested workflow (recordInterestedLead) step 0 - what a repeat returns instead of recording.
//
//A person with no deal is not a state a completed run can leave - the deal is created BEFORE the notes - so the
//note this matched cannot have come from one. Answering null there sends the event down the normal path rather
//than inventing a deal id for it.
//[LOGIC] Suppression is reported empty rather than re-run. A repeat is not new information, and the channels
//the first run failed on failed structurally, not transiently - see the KNOWN GAP in stopLeadInActiveCampaigns
//(lib/heyreach.ts). Wanting repeats to retry suppression is a reason to widen this, not the note write.
//---------------------------------------------------------------------------------------------------------
function duplicateOutcome(person: AttioPerson, personName: string): InterestedOutcome | null {
  const dealId = person.values.associated_deals[0]?.target_record_id ?? null; //person's first deal, or null
  if (!dealId) return null; //no deal, not a real repeat
  return {
    personId: person.id.record_id, //the existing person
    personName, //same as personName: personName
    dealId, //same as dealId: dealId
    companyId: person.values.company[0]?.target_record_id ?? null, //their company, if any
    suppression: { outcomes: [], failures: [] }, //suppression not re-run
    duplicate: true, //mark it as a repeat
  };
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record an interested lead>

//#region <shared workflow>
//---------------------------------------------------------------------------------------------------------
//Records an interested lead in Attio, and writes a transcript of the run onto the records it touched.
//Input: workflow - the lead plus the provider's findPerson and history.
//Output: the person, deal, company and suppression results. Throws if a step before suppression fails.
//Uses: withRunLog (lib/run-log.ts); runInterestedLead (this file).
//Workflow: the interested workflow itself - every provider's route or cron ends here (aircall-interested,
//heyreach-interested, instantly-interested, outfound-interested). Steps 0-6 run in runInterestedLead; step 7
//is the transcript this wrapper adds.
//
//This is the whole of what the providers share - so a fourth platform needs an extractor, a lookup, and a note
//renderer, and inherits the rest.
//
//ORDERING is deliberate. The company precedes the deal because it names it. The notes precede the attribute
//writes because a note is the record of what happened and is worth having even if a later write fails. The
//suppression is last because it is the only step that writes outside Attio: if it throws, the CRM record it
//would otherwise have cost is already committed.
//
//[STABILITY] Every step is a separate API call with no transaction. A throw partway leaves the earlier writes
//committed. Callers treat that as a failed event and do not retry; step 0 now catches the retries that arrive
//anyway, but only those inside the window, so not retrying remains the policy rather than a nicety.
//Step 6 is the exception: it collects its own failures instead of raising, so one unreachable platform cannot
//fail an event that Attio already recorded.
//
//The caller supplies findPerson and history; nothing else about a provider is visible from here.
//[DEBUG] Ends with one line naming the person, deal, and company, so an event reads as a single result.
//[RUN LOG] Every block below marked `//debug note in attio=` belongs to the transcript written back to the
//records this touches. Additive and self-contained: see lib/run-log.ts.
//---------------------------------------------------------------------------------------------------------
//debug note in attio=
//To remove the feature: delete this wrapper and rename runInterestedLead back to recordInterestedLead.
export async function recordInterestedLead(workflow: InterestedWorkflow): Promise<InterestedOutcome> {
  return withRunLog(workflow.lead.provider, () => runInterestedLead(workflow)); //start writing down everything this run does
}
//===============

//---------------------------------------------------------------------------------------------------------
//Runs the interested workflow's steps 0-6 for one lead.
//Input: workflow - the lead plus the provider's findPerson and history.
//Output: the person, deal, company and suppression results; the existing records' ids for a declined repeat.
//Throws if any Attio step before suppression fails.
//Uses: leadSourceLabel (lib/providers.ts); personLabel, createPerson, recordDisplayName, ensureInterestedDeal,
//defaultDealOwner, createNote (lib/attio.ts); runLogRecord (lib/run-log.ts); recentlyNoted, duplicateOutcome,
//personValuesFor, resolveInterestedCompany, interestedDealName, dealValuesFor, updateAttioAttributes,
//suppressInterestedLead (this file); workflow.findPerson and workflow.history (the provider).
//Workflow: interested workflow (recordInterestedLead) steps 0-6 - the body recordInterestedLead wraps in a
//transcript (step 7).
//---------------------------------------------------------------------------------------------------------
async function runInterestedLead(workflow: InterestedWorkflow): Promise<InterestedOutcome> {
  const { lead, subject } = workflow; //pull lead and subject out of workflow
  const title = leadSourceLabel(lead.provider); //note title: the provider's lead-source label

  let person = await workflow.findPerson(); //step 1: look the person up
  //debug note in attio=
  const personWasAlreadyThere = person !== null; //did Attio know this person before we started?
  //===============
  //Checked here rather than at the note writes, so a repeat costs one GET instead of a company resolution, a
  //deal, four writes and a suppression pass - and leaves no run transcript either, because nothing has been
  //registered with runLogRecord yet. A person who does not exist cannot carry a previous note, so a
  //first-time lead never pays for the check at all.
  if (person) { //step 0: only an existing person can repeat
    const existingName = personLabel(person); //their display name
    if (await recentlyNoted(person, title, Date.now())) { //same note posted recently
      const outcome = duplicateOutcome(person, existingName); //existing records, nothing written
      if (outcome) { //they have a deal, so it's a true repeat
        console.log( //log the declined repeat
          `[interested] ${subject}: declined - this repeats an event already recorded for ${existingName}, so nothing was written`,
        );
        return outcome; //stop here, write nothing
      }
      console.warn( //log the odd no-deal case
        `[interested] ${subject}: ${existingName} carries a recent ${JSON.stringify(title)} note but no deal, which no completed run leaves behind - recording the event normally`,
      );
    }
  }
  if (!person) person = await createPerson(personValuesFor(lead)); //step 1: create the person if missing
  const personId = person.id.record_id; //the person's attio id
  const personName = personLabel(person); //the person's display name
  //debug note in attio=
  runLogRecord("people", person, personWasAlreadyThere, personName); //take a photo of the person before we change them
  //===============

  const company = await resolveInterestedCompany(lead, person); //step 2: find or create the company
  const deal = await ensureInterestedDeal( //step 3: reuse or create the deal
    person,
    interestedDealName(company?.name ?? null),
    defaultDealOwner(),
    company?.id ?? null,
  );
  const dealId = deal.id.record_id; //the deal's attio id
  //debug note in attio=
  runLogRecord("deals", deal, person.values.associated_deals.length > 0, recordDisplayName(deal) ?? dealId); //take a photo of the deal before we change it
  //===============

  const history = await workflow.history(); //step 4: the provider's rendered history
  await createNote("people", personId, title, history, personName); //step 4: note on the person
  await createNote("deals", dealId, title, history); //step 4: note on the deal

  await updateAttioAttributes("people", person, personValuesFor(lead, company?.id ?? null), personName); //step 5: fill person attributes
  await updateAttioAttributes("deals", deal, dealValuesFor(lead)); //step 5: fill deal attributes

  const suppression = await suppressInterestedLead({ //step 6: stop outreach everywhere
    personId, //same as personId: personId
    personName, //same as personName: personName
    email: lead.emails[0] ?? null, //first email, if any
    profileUrl: lead.linkedin, //linkedin url, if any
    companyName: company?.name ?? null, //company name, if any
  });

  console.log( //one summary line for the event
    `[interested] ${subject}: completed - person ${personName}, deal ${dealId}, company ${company?.name ?? "none"}`,
  );
  return { personId, personName, dealId, companyId: company?.id ?? null, suppression, duplicate: false }; //the result
}
//#endregion

//#endregion
//=============================================================================================================
