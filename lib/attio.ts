//=============================================================================================================
//#region <import statements>

import { reportConfigEmail, reportConfigValue, requiredEnv } from "./env.js"; //read and log env settings
import type { Provider } from "./providers.js"; //"aircall", "heyreach", etc.
import { ATTIO_BASE, attioHeaders, credentialHint } from "./endpoints.js"; //attio url, login headers, error hints
import { retryAfterMs } from "./http.js"; //reads a 429's "retry after" wait
import { //safe readers for unknown json
  arrayValue,
  errorMessage,
  isJsonObject,
  numberValue,
  objectValue,
  responseJson,
  stringValue,
  type JsonObject,
} from "./json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

export type AttioObject = "people" | "companies" | "deals"; //the three attio record kinds used here

//A link from one record to another, as Attio stores it.
export interface AttioRecordReference {
  readonly target_object?: string; //kind of record linked to, if given
  readonly target_record_id: string; //id of the linked record
}

//Attribute values on their way INTO Attio, keyed by slug. Built by the mappers in lib/interested.ts.
export type AttioValues = Readonly<Record<string, unknown>>; //slug to value to write

//---------------------------------------------------------------------------------------------------------
//Any Attio record, of any object, in the two forms the codebase needs: the attribute values as Attio returned
//them, and the set of slugs currently holding anything at all.
//populatedAttributes is type-agnostic on purpose. Attio wraps every attribute in an array whatever its type, so
//a non-empty array is the only "has a value" test that works across text, references, selects, and counters
//alike. updateAttioAttributes (lib/interested.ts) is built on it, and is what stops a write overwriting.
//---------------------------------------------------------------------------------------------------------
export interface AttioRecord {
  readonly id: { //attio's id object
    readonly record_id: string; //the record's id
  };
  //As Attio returned them: each attribute an array of value objects whose shape follows its type - `{ value }`
  //for text, `{ email_address }` for an address, `{ option: { title } }` for a select. Read these through the
  //extractors in lib/interested.ts rather than reaching in directly.
  readonly rawValues: JsonObject; //every attribute, as returned
  readonly populatedAttributes: ReadonlySet<string>; //slugs that hold a value
}

//A person, with the three attributes the interested and touchpoint workflows navigate by parsed out.
export interface AttioPerson extends AttioRecord {
  readonly values: { //the parsed-out attributes
    readonly associated_deals: readonly AttioRecordReference[]; //linked deals
    readonly company: readonly AttioRecordReference[]; //linked company
    readonly name: readonly { readonly full_name: string | null }[]; //the person's names
  };
}

//One note as the duplicate check needs it: what it is called and when it landed. Content is never read.
export interface AttioNote {
  readonly id: string; //the note's id
  readonly title: string; //the note's title
  readonly createdAtMs: number; //when it was posted, epoch ms
}

//What listNotes returns: the notes, and whether every page was read.
export interface AttioNoteListing {
  readonly notes: readonly AttioNote[]; //notes read
  //False when MAX_NOTE_PAGES was spent with more still unread. The caller then knows only that it did not
  //SEE a given note, not that none exists, which is the difference between declining to write and failing
  //open - see recentlyNoted (lib/interested.ts).
  readonly complete: boolean; //true if every page was read
}

//Slugs of the Attio lists this codebase uses.
export const LISTS = {
  MASTER_TAM: "master_tam_list", //people we count touchpoints for
  DNC: "dnc", //do-not-contact list
} as const;

//Thrown when Attio answers with an error status; carries the status and body.
export class AttioApiError extends Error {
  constructor( //build from message, status and body
    message: string, //the error message
    readonly status: number, //http status code, kept on the error
    readonly body: unknown, //attio's response body, kept on the error
  ) {
    super(message); //set the message
    this.name = "AttioApiError"; //name shown in logs
  }
}

//[STABILITY] Attio rate-limits on request rate AND on "query complexity" - the filtered record queries every
//lookup here performs. A 429 is transient by definition, so the transport waits and tries again rather than
//surfacing it. Without this a single 429 failed one touchpoint outright: the cron logs the failure, passes the
//call over, and advances its cursor regardless, so the counter and note were lost with no way back.
//
//WHAT IS RETRIED, AND WHY IT IS THIS NARROW:
// - 429, on any method. A refused request was not processed, so repeating it cannot apply anything twice.
// - 5xx, on GET only. A 5xx is ambiguous: Attio may have applied the change and then failed to answer. On a
//   GET there is nothing to apply, so a retry is free. On a POST it is not - a retried POST /notes duplicates
//   the note, and a retried record create duplicates the record. Attio offers no idempotency key, so there is
//   no way to make those safe, and a duplicate write is worse than a surfaced error. They are raised at once.
// - Nothing else. A 4xx other than 429 is deterministic; the same request will fail the same way.
const RETRY_ON_ANY_METHOD = new Set([429]); //always retried
const RETRY_ON_GET_ONLY = new Set([500, 502, 503, 504]); //retried only on reads
const MAX_ATTEMPTS = 4; //tries before giving up
//Doubles per attempt: 0.5s, 1s, 2s. Total added latency is under four seconds, which one call can afford inside
//the sync's run budget - and a run that spends its budget waiting now stops cleanly rather than being killed.
const RETRY_BASE_MS = 500; //first wait before a retry

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]); //statuses worth trying on a later run

//---------------------------------------------------------------------------------------------------------
//Raised when a touchpoint was throttled or hit a server error BEFORE it had written anything to Attio.
//
//WHY THE DISTINCTION EXISTS. Every sync's standing policy is to count a failed event and pass it over, never
//retrying, because its earlier writes are already committed and a retry would duplicate them. That reasoning
//holds only once something HAS been written. A 429 or a 500 on the opening lookup wrote nothing, so passing
//the event over threw it away for no reason: the note and counter were lost and the cursor moved past it
//regardless. Attio rate-limits on "query complexity" - the filtered lookup at the top of every touchpoint is
//exactly what trips it - and answers with a bare 500 often enough to see several in a day, so this is the
//common failure rather than an edge case.
//
//An event raising this is left ALONE: the cursor does not advance past it and the run stops, so the next run
//retries it from the beginning. Nothing was written, so nothing can double.
//
//Lives here rather than in one handler because all four syncs catch it. Two `instanceof` checks against two
//separately-declared classes would silently stop matching, which is exactly the bug this guards against.
//---------------------------------------------------------------------------------------------------------
export class ThrottledBeforeWrite extends Error {
  constructor(readonly reason: unknown) { //reason is the original error, kept
    super(errorMessage(reason)); //reuse the original's message
    this.name = "ThrottledBeforeWrite"; //name shown in logs
  }
}

//Attio caps `limit` at 50, and the listing documents no sort order - so absence can only be concluded by
//reading every page, and a record with a long note history has to be bounded somewhere. Four pages covers
//200 notes, which is far past what an interested lead accumulates; past that the caller fails open.
const NOTE_PAGE_LIMIT = 50; //notes per page, attio's max
const MAX_NOTE_PAGES = 4; //most pages read per record

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <parse attio records>

//parce functions, turns raw pull from attio (json) into usable data

//#region <whole records>
//---------------------------------------------------------------------------------------------------------
//Base function. Turns one raw Attio record of any object into the shape the rest of the codebase uses.
//Input: value - one record from Attio, unknown shape.
//Output: the record. Throws if it has no id or values.
//Workflow: every Attio record read - findCompany, fetchRecord, createCompany, ensureInterestedDeal, and
//parseAttioPerson for people.
//
//Recording which slugs hold anything is the whole basis of never-overwrite: see AttioRecord.populatedAttributes.
//---------------------------------------------------------------------------------------------------------
export function parseAttioRecord(value: unknown): AttioRecord {
  if (!isJsonObject(value)) throw new Error("Attio returned an invalid record"); //not an object at all
  const id = objectValue(value, "id"); //the id object
  const values = objectValue(value, "values"); //every attribute
  const recordId = id ? stringValue(id.record_id) : null; //the record's id, or null
  if (!recordId || !values) throw new Error("Attio record is missing id or values"); //unusable record

  const populatedAttributes = new Set( //slugs whose value list is not empty
    Object.keys(values).filter((slug) => arrayValue(values, slug).length > 0),
  );
  return { id: { record_id: recordId }, rawValues: values, populatedAttributes }; //the parsed record
}

//---------------------------------------------------------------------------------------------------------
//Turns one raw Attio person record into the shape the rest of the codebase uses.
//Input: value - one person record from Attio, unknown shape.
//Output: the person, with linked deals, company and names read out. Throws if it has no id or values.
//Uses: parseAttioRecord, parseReferences (this file).
//Workflow: findPerson and createPerson - every person read.
//
//The linked deals, company and names are read out because those three are what the workflows navigate by
//rather than merely write.
//---------------------------------------------------------------------------------------------------------
export function parseAttioPerson(value: unknown): AttioPerson {
  const record = parseAttioRecord(value); //the generic half
  const values = record.rawValues; //every attribute

  const names = arrayValue(values, "name") //each name entry as { full_name }
    .map((name) => {
      if (!isJsonObject(name)) return null; //unreadable entry
      return { full_name: stringValue(name.full_name) }; //just the full name
    })
    .filter((name): name is { readonly full_name: string | null } => name !== null);

  return {
    ...record, //copy in the generic fields
    values: { //the navigation attributes
      associated_deals: parseReferences(values, "associated_deals"), //linked deals
      company: parseReferences(values, "company"), //linked company
      name: names, //the person's names
    },
  };
}
//#endregion

//#region <references>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads one raw link entry into an AttioRecordReference.
//Input: value - one entry of a reference attribute, unknown shape.
//Output: the reference, or null if it has no target id.
//Workflow: parseReferences - each linked record.
//---------------------------------------------------------------------------------------------------------
function parseRecordReference(value: unknown): AttioRecordReference | null {
  if (!isJsonObject(value)) return null; //not an object, no link
  const recordId = stringValue(value.target_record_id); //the linked record's id
  if (!recordId) return null; //no id, no link
  const targetObject = stringValue(value.target_object); //the linked kind, if given
  return targetObject //include target_object only when known
    ? { target_object: targetObject, target_record_id: recordId }
    : { target_record_id: recordId };
}

//---------------------------------------------------------------------------------------------------------
//Reads every link in one reference attribute.
//Input: values - the record's attributes; key - the attribute's slug.
//Output: the readable links, possibly empty.
//Uses: parseRecordReference (this file).
//Workflow: parseAttioPerson - linked deals and company.
//---------------------------------------------------------------------------------------------------------
function parseReferences(values: JsonObject, key: string): readonly AttioRecordReference[] {
  //Unreadable entries are dropped rather than throwing: one malformed reference should not void the record.
  return arrayValue(values, key) //each entry read, bad ones dropped
    .map(parseRecordReference)
    .filter((value): value is AttioRecordReference => value !== null);
}
//#endregion

//#region <names and links>
//---------------------------------------------------------------------------------------------------------
//Base function. Gives the name on a record we have already fetched.
//Input: record - any parsed record.
//Output: the name, or null if there is none.
//Workflow: log lines for companies and deals - findCompany, createCompany, incrementCounter here; the
//interested workflow steps 2, 3 and 5 (resolveInterestedCompany, the deal's name, updateAttioAttributes).
//
//Attio spells the attribute two ways - a person's name is structured (`full_name`), a company's is a plain
//text `value` - and either may be absent. Returns null rather than throwing on any shape it does not
//recognise: a log line is not worth failing a write over.
//---------------------------------------------------------------------------------------------------------
export function recordDisplayName(record: AttioRecord): string | null {
  const first = arrayValue(record.rawValues, "name")[0]; //first name entry
  if (!isJsonObject(first)) return null; //no readable name
  return stringValue(first.full_name) ?? stringValue(first.value); //person spelling, else company spelling
}

//---------------------------------------------------------------------------------------------------------
//Base function. Gives a person's full name.
//Input: person - a parsed person.
//Output: the full name, or null if Attio holds none.
//Workflow: personLabel; all four touchpoint syncs - the name in the company note.
//---------------------------------------------------------------------------------------------------------
export function personDisplayName(person: AttioPerson): string | null {
  return person.values.name[0]?.full_name ?? null; //first name entry, or null
}

//---------------------------------------------------------------------------------------------------------
//What a person is called in the logs: their name, or their record id when Attio holds no name for them.
//Input: person - a parsed person.
//Output: the name or the id.
//Uses: personDisplayName (this file).
//Workflow: log lines everywhere a person appears - this file, all four touchpoint syncs, and the interested
//workflow step 1.
//---------------------------------------------------------------------------------------------------------
export function personLabel(person: AttioPerson): string {
  return personDisplayName(person) ?? person.id.record_id; //name, else id
}

//---------------------------------------------------------------------------------------------------------
//Base function. Gives the id of the company linked to a person.
//Input: person - a parsed person.
//Output: the company's id, or null if none is linked.
//Workflow: all four touchpoint syncs - the company to note and count; interested workflow step 2
//(resolveInterestedCompany) - the already-linked company.
//---------------------------------------------------------------------------------------------------------
export function personCompanyId(person: AttioPerson): string | null {
  return person.values.company[0]?.target_record_id ?? null; //first linked company, or null
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <look up people and companies>

//          Match Data From Thrid Party Records To Record ID In Attio

//#region <people>
//---------------------------------------------------------------------------------------------------------
//One filtered person query. The three exported wrappers below differ only in the attribute searched.
//Input: attribute - the slug to search; value - what to search for, or null.
//Output: the first matching person, or null when there is no value or no match.
//Uses: attioFetch, responseData, parseAttioPerson, personLabel (this file).
//Workflow: findPersonByEmail, findPersonByPhone, findPersonByLinkedIn.
//
//[DEBUG] Every branch logs, including the misses. A lookup that quietly returns null is the usual cause of a
//touchpoint vanishing, so the searched attribute and value are named in the log line.
//NOTE: those log lines carry the business identifier - an address, number, or profile URL. Not credentials,
//but personal data in a retained log.
//---------------------------------------------------------------------------------------------------------
async function findPerson(attribute: string, value: string | null): Promise<AttioPerson | null> {
  if (!value) { //nothing to search for
    console.log(`[lookup] person by ${attribute}: skipped - no value to search for`); //log the skip
    return null; //no person
  }
  const response = await attioFetch("/objects/people/records/query", { //send the filtered query
    method: "POST", //attio queries use POST
    body: JSON.stringify({ filter: { [attribute]: value }, limit: 1 }), //match this attribute, one result
  });
  const data = responseData(response); //the result list
  if (!Array.isArray(data)) throw new Error("Attio person query returned invalid data"); //not a list
  if (data[0] === undefined) { //no match
    console.log(`[lookup] person by ${attribute} ${JSON.stringify(value)}: no match`); //log the miss
    return null; //no person
  }
  const person = parseAttioPerson(data[0]); //read the match
  console.log(`[lookup] person by ${attribute} ${JSON.stringify(value)}: matched ${personLabel(person)}`); //log the hit
  return person; //the matched person
}

//---------------------------------------------------------------------------------------------------------
//Finds a person by email address.
//Input: email - the address, or null.
//Output: the person, or null.
//Uses: findPerson (this file).
//Workflow: instantly and outfound touchpoint syncs - match the person; the interested routes (aircall,
//heyreach, instantly, outfound) - interested workflow step 1 lookup.
//---------------------------------------------------------------------------------------------------------
export function findPersonByEmail(email: string | null): Promise<AttioPerson | null> {
  return findPerson("email_addresses", email); //search the email attribute
}

//---------------------------------------------------------------------------------------------------------
//Finds a person by phone number.
//Input: phone - the number in E.164, or null.
//Output: the person, or null.
//Uses: findPerson (this file).
//Workflow: aircall touchpoint sync (processAircallTouchpoint step 2) - match the dialled number; aircall
//interested route - interested workflow step 1, the fallback after email.
//---------------------------------------------------------------------------------------------------------
export function findPersonByPhone(phone: string | null): Promise<AttioPerson | null> {
  //Callers must pass E.164: Attio matches on the stored form, not on a punctuated display number.
  return findPerson("phone_numbers", phone); //search the phone attribute
}

//---------------------------------------------------------------------------------------------------------
//Finds a person by LinkedIn profile URL.
//Input: profileUrl - the profile URL, or null.
//Output: the person, or null.
//Uses: findPerson (this file).
//Workflow: heyreach touchpoint sync (processHeyReachTouchpoint step 1); heyreach and outfound interested
//routes - interested workflow step 1 lookup.
//---------------------------------------------------------------------------------------------------------
export function findPersonByLinkedIn(profileUrl: string | null): Promise<AttioPerson | null> {
  return findPerson("linkedin", profileUrl); //search the linkedin attribute
}
//#endregion

//#region <companies>
//Companies. Before this existed no interested workflow resolved one, so a deal opened for a brand-new lead
//carried no company and the touchpoint crons had nothing to hang a company note or counter on.

//---------------------------------------------------------------------------------------------------------
//One filtered company query.
//Input: attribute - the slug to search; value - what to search for, or null.
//Output: the first matching company, or null when there is no value or no match.
//Uses: attioFetch, responseData, parseAttioRecord, recordDisplayName (this file).
//Workflow: findCompanyByDomain, findCompanyByName.
//
//Domain is the strong identifier; name is the fallback and matches exactly.
//---------------------------------------------------------------------------------------------------------
async function findCompany(attribute: string, value: string | null): Promise<AttioRecord | null> {
  if (!value) { //nothing to search for
    console.log(`[lookup] company by ${attribute}: skipped - no value to search for`); //log the skip
    return null; //no company
  }
  const response = await attioFetch("/objects/companies/records/query", { //send the filtered query
    method: "POST", //attio queries use POST
    body: JSON.stringify({ filter: { [attribute]: value }, limit: 1 }), //match this attribute, one result
  });
  const data = responseData(response); //the result list
  if (!Array.isArray(data)) throw new Error("Attio company query returned invalid data"); //not a list
  if (data[0] === undefined) { //no match
    console.log(`[lookup] company by ${attribute} ${JSON.stringify(value)}: no match`); //log the miss
    return null; //no company
  }
  const company = parseAttioRecord(data[0]); //read the match
  console.log( //log the hit
    `[lookup] company by ${attribute} ${JSON.stringify(value)}: matched ${recordDisplayName(company) ?? company.id.record_id}`,
  );
  return company; //the matched company
}

//---------------------------------------------------------------------------------------------------------
//Finds a company by web domain.
//Input: domain - the domain, or null.
//Output: the company, or null.
//Uses: findCompany (this file).
//Workflow: interested workflow step 2 (resolveInterestedCompany) - the first way to find the company.
//---------------------------------------------------------------------------------------------------------
export function findCompanyByDomain(domain: string | null): Promise<AttioRecord | null> {
  return findCompany("domains", domain); //search the domains attribute
}

//---------------------------------------------------------------------------------------------------------
//Finds a company by exact name.
//Input: name - the company name, or null.
//Output: the company, or null.
//Uses: findCompany (this file).
//Workflow: interested workflow step 2 (resolveInterestedCompany) - the fallback after domain.
//---------------------------------------------------------------------------------------------------------
export function findCompanyByName(name: string | null): Promise<AttioRecord | null> {
  return findCompany("name", name); //search the name attribute
}
//#endregion

//#region <whole records>
//---------------------------------------------------------------------------------------------------------
//Reads one record whole, so a caller can see what it already holds before deciding what to write.
//Input: object - people, companies or deals; recordId - the record's id.
//Output: the record. Throws if Attio refuses or returns something unreadable.
//Uses: attioFetch, responseData, parseAttioRecord (this file).
//Workflow: ensureInterestedDeal (reused deal) and incrementCounter here; interested workflow step 2 (the
//linked company) and step 5 (updateAttioAttributes when handed an id).
//---------------------------------------------------------------------------------------------------------
export async function fetchRecord(object: AttioObject, recordId: string): Promise<AttioRecord> {
  const response = await attioFetch(`/objects/${object}/records/${recordId}`); //GET the record
  return parseAttioRecord(responseData(response)); //read it
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <write to attio>

//push to attio
//
//Every write reports what it did, so a run can be read back action by action from the logs. A failure names the
//action before the error propagates, which is the difference between "the sync broke" and "the note on person X
//could not be created".
//
//A record is logged by the name it carries in Attio, so a run reads as a list of people rather than a list of
//identifiers. Only the name is logged, never the rest of the record's contents. The caller supplies that name,
//because it is the caller that holds the record: the helpers below are handed an id, and a helper that has only
//an id logs the id rather than spending a request to resolve a name for a log line. The exception is
//incrementCounter, which has to read the record anyway and so takes the name off a response already paid for.

//#region <create records>
//---------------------------------------------------------------------------------------------------------
//Creates a person and returns it parsed, so the caller has both the new ID and its populated-attribute set.
//Input: values - the new person's attributes.
//Output: the new person. Throws if Attio refuses.
//Uses: attioFetch, responseData, parseAttioPerson, personLabel (this file); errorMessage (lib/json.ts).
//Workflow: interested workflow step 1 - create the person when no match was found.
//---------------------------------------------------------------------------------------------------------
export async function createPerson(values: AttioValues): Promise<AttioPerson> {
  //Not withAction: the log line needs the created record's name, which only exists after the response parses.
  try {
    const response = await attioFetch("/objects/people/records", { //send the create
      method: "POST", //POST creates a record
      body: JSON.stringify({ data: { values } }), //the new person's values
    });
    const person = parseAttioPerson(responseData(response)); //read the created person
    console.log(`[action] person created: ${personLabel(person)}`); //log the create
    return person; //the new person
  } catch (error) {
    console.error(`[action] FAILED - person could not be created: ${errorMessage(error)}`); //log the failure
    throw error; //pass the error on
  }
}

//---------------------------------------------------------------------------------------------------------
//Creates a company and returns it parsed, so the caller has the new ID and its populated-attribute set.
//Input: values - the new company's attributes.
//Output: the new company. Throws if Attio refuses.
//Uses: attioFetch, responseData, parseAttioRecord, recordDisplayName (this file); errorMessage (lib/json.ts).
//Workflow: interested workflow step 2 (resolveInterestedCompany) - create the company when none was found.
//---------------------------------------------------------------------------------------------------------
export async function createCompany(values: AttioValues): Promise<AttioRecord> {
  try {
    const response = await attioFetch("/objects/companies/records", { //send the create
      method: "POST", //POST creates a record
      body: JSON.stringify({ data: { values } }), //the new company's values
    });
    const company = parseAttioRecord(responseData(response)); //read the created company
    console.log(`[action] company created: ${recordDisplayName(company) ?? company.id.record_id}`); //log the create
    return company; //the new company
  } catch (error) {
    console.error(`[action] FAILED - company could not be created: ${errorMessage(error)}`); //log the failure
    throw error; //pass the error on
  }
}
//#endregion

//#region <update records>
//---------------------------------------------------------------------------------------------------------
//The one write path for attributes on any record. Deliberately dumb: it writes exactly what it is handed.
//Input: object - people, companies or deals; recordId - the record; values - the attributes to write;
//recordName - name for the log (defaults to the id).
//Output: nothing. Throws if Attio refuses.
//Uses: withAction, attioFetch (this file).
//Workflow: interested workflow step 5 - called only through writeSalvagingRejections (updateAttioAttributes).
//
//Deciding WHAT may be written - which is the never-overwrite rule - belongs to updateAttioAttributes
//(lib/interested.ts), which is the only thing that should call this. Every caller goes through there so the
//rule cannot be bypassed by accident.
//An empty patch is a no-op that still logs: "nothing needed writing" is a result, and silence is not.
//---------------------------------------------------------------------------------------------------------
export async function patchRecord(
  object: AttioObject,
  recordId: string,
  values: AttioValues,
  recordName: string = recordId,
): Promise<void> {
  const slugs = Object.keys(values); //attributes to write
  if (slugs.length === 0) { //nothing to write
    console.log(`[action] ${object} ${recordName} not updated - no attributes needed writing`); //log the no-op
    return; //skip the request
  }
  await withAction(`${object} ${recordName} updated: ${slugs.join(", ")}`, () => //send the update, logging the result
    attioFetch(`/objects/${object}/records/${recordId}`, {
      method: "PATCH", //PATCH changes only these attributes
      body: JSON.stringify({ data: { values } }), //the values to write
    }),
  );
}
//#endregion

//#region <deals>
//---------------------------------------------------------------------------------------------------------
//Returns the deal to attach interested history to, creating one only when the person has none.
//Input: person - the lead; dealName - name for a new deal; ownerEmail - owner of a new deal; companyId - the
//company to link a new deal to, or null.
//Output: the existing or new deal. Throws if a read or the create fails.
//Uses: fetchRecord, attioFetch, responseData, parseAttioRecord, personLabel (this file); errorMessage
//(lib/json.ts).
//Workflow: interested workflow step 3 - reuse or create the deal. ownerEmail comes from defaultDealOwner.
//
//Reuse is deliberately stage-blind: any existing deal is reused whatever phase it sits in, so an interested
//signal updates the live deal rather than opening a second one alongside it.
//KNOWN GAP: a person linked to SEVERAL deals gets the first Attio returned, and that order is not specified -
//so which deal receives the note is arbitrary. Closing it needs a rule for which deal wins (newest? furthest
//along?); until there is one, the log names the count so the arbitrariness is at least visible.
//The deal is fetched whole rather than returned as a bare id, because the caller's next act is to fill its
//blank attributes and it cannot know which are blank without reading it. On the create path the POST response
//already carries them, so neither path costs a request the caller was not going to make anyway.
//companyId comes from the caller, not from `person`, so a company resolved for a person who had none is still
//linked. Passing null omits the association, as before.
//---------------------------------------------------------------------------------------------------------
export async function ensureInterestedDeal(
  person: AttioPerson,
  dealName: string,
  ownerEmail: string,
  companyId: string | null,
): Promise<AttioRecord> {
  const associated = person.values.associated_deals; //deals already linked
  const existing = associated[0]?.target_record_id; //first linked deal's id, if any
  //[DEBUG] Logged in BOTH directions, like every other lookup here. A line only on the hit would leave "checked,
  //found none, so created one" and "never checked" reading identically in the log, and the second is a bug the
  //first is not. The count is named because more than one associated deal means the choice below is arbitrary.
  console.log( //log reuse or create
    existing
      ? `[lookup] deal for person ${personLabel(person)}: ${associated.length} already associated, reusing ${existing}${associated.length > 1 ? " - the first Attio returned, which is an arbitrary choice among them" : ""}`
      : `[lookup] deal for person ${personLabel(person)}: none associated, so a new one is created`,
  );
  if (existing) { //a deal is already linked
    //Its name is left exactly as it stands. A deal already in the pipeline has been named by whoever is working
    //it, and the strict naming convention below governs deals this codebase opens, not deals it finds.
    return fetchRecord("deals", existing); //read and reuse it
  }

  try {
    const response = await attioFetch("/objects/deals/records", { //send the create
      method: "POST", //POST creates a record
      body: JSON.stringify({ //the new deal, as JSON text
        data: { //attio wraps values in data
          values: { //the deal's attributes
            name: dealName, //deal name
            stage: "Interested", //starting stage
            owner: ownerEmail, //owner's email
            associated_people: [ //link to the person
              { target_object: "people", target_record_id: person.id.record_id },
            ],
            ...(companyId //add the company link only if there is one
              ? {
                  associated_company: { //link to the company
                    target_object: "companies", //a company record
                    target_record_id: companyId, //which company
                  },
                }
              : {}),
          },
        },
      }),
    });
    const deal = parseAttioRecord(responseData(response)); //read the created deal
    console.log( //log the create
      `[action] deal created: ${JSON.stringify(dealName)} for person ${personLabel(person)}${companyId ? ` and company ${companyId}` : " with no associated company"}`,
    );
    return deal; //the new deal
  } catch (error) {
    console.error( //log the failure
      `[action] FAILED - deal could not be created for person ${personLabel(person)}: ${errorMessage(error)}`,
    );
    throw error; //pass the error on
  }
}
//#endregion

//#region <action logging>
//---------------------------------------------------------------------------------------------------------
//Runs one write and logs whether it happened.
//Input: action - what the write does, for the log; run - the write itself.
//Output: whatever run returns. Re-throws its error unchanged.
//Uses: errorMessage (lib/json.ts).
//Workflow: patchRecord, addPersonToList, createNote - every logged write.
//
//[DEBUG] Wraps one write so the log says whether it happened. Changes no control flow.
//---------------------------------------------------------------------------------------------------------
async function withAction<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run(); //do the write
    console.log(`[action] ${action}`); //log that it happened
    return result; //hand back its result
  } catch (error) {
    console.error(`[action] FAILED, did not happen - ${action}: ${errorMessage(error)}`); //log that it failed
    throw error; //pass the error on
  }
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <manage lists>

//#region <check membership>
//---------------------------------------------------------------------------------------------------------
//Checks whether a person is on an Attio list.
//Input: personId - the person; listSlug - the list; personName - name for the log (defaults to the id).
//Output: true if the person is on the list. Throws if Attio refuses.
//Uses: attioFetch, responseData (this file).
//Workflow: all four touchpoint syncs - the Master TAM gate; nothing is written unless this is true.
//
//[PERF] One request per person per event, uncached.
//---------------------------------------------------------------------------------------------------------
export async function isPersonInList(
  personId: string,
  listSlug: string,
  personName: string = personId,
): Promise<boolean> {
  const response = await attioFetch(`/objects/people/records/${personId}/entries`); //GET the person's list entries
  const data = responseData(response); //the entries
  if (!Array.isArray(data)) throw new Error("Attio list entries response is invalid"); //not a list
  //Attio returns the slug as list_id.slug on some entries and list_api_slug on others; accept both.
  const member = data.some((entry) => { //true if any entry matches
    if (!isJsonObject(entry)) return false; //unreadable entry
    const listId = objectValue(entry, "list_id"); //the list id object
    return stringValue(listId?.slug) === listSlug || stringValue(entry.list_api_slug) === listSlug; //either spelling matches
  });
  console.log(`[lookup] person ${personName} ${member ? "is" : "is NOT"} on list ${listSlug}`); //log the result
  return member; //on the list or not
}
//#endregion

//#region <add to a list>
//---------------------------------------------------------------------------------------------------------
//Adds a person to an Attio list.
//Input: personId - the person; listSlug - the list; personName - name for the log (defaults to the id).
//Output: nothing. Throws if Attio refuses.
//Uses: withAction, attioFetch (this file).
//Workflow: interested workflow step 6 (suppressInterestedLead) - the Attio DNC channel.
//
//PUT asserts the entry, so re-adding an already-listed person is a no-op rather than a duplicate.
//---------------------------------------------------------------------------------------------------------
export async function addPersonToList(
  personId: string,
  listSlug: string,
  personName: string = personId,
): Promise<void> {
  await withAction(`person ${personName} added to list ${listSlug}`, () => //send the add, logging the result
    attioFetch(`/lists/${listSlug}/entries`, {
      method: "PUT", //PUT adds or keeps the entry
      body: JSON.stringify({ //the entry, as JSON text
        data: { parent_record_id: personId, parent_object: "people", entry_values: {} }, //this person, no extra values
      }),
    }),
  );
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <manage notes>

//#region <read notes>
//---------------------------------------------------------------------------------------------------------
//Reads every note on one record, up to the page bound.
//Input: parentObject - people, companies or deals; parentRecordId - the record.
//Output: { notes, complete }. complete is false if the page bound was hit with more left.
//Uses: attioFetch, responseData, parseAttioNote (this file).
//Workflow: interested workflow step 0 (recentlyNoted) - the duplicate check.
//
//[STABILITY] GET only, so attioFetch retries a 429 or a 5xx for free - see RETRY_ON_GET_ONLY.
//[PERF] One request for any record holding fewer than 50 notes, which is the ordinary case.
//---------------------------------------------------------------------------------------------------------
export async function listNotes(
  parentObject: AttioObject,
  parentRecordId: string,
): Promise<AttioNoteListing> {
  const notes: AttioNote[] = []; //notes read so far
  for (let page = 0; page < MAX_NOTE_PAGES; page += 1) { //each page, up to the bound
    const query = new URLSearchParams({ //the url's query string
      parent_object: parentObject, //record kind
      parent_record_id: parentRecordId, //which record
      limit: String(NOTE_PAGE_LIMIT), //notes per page
      offset: String(page * NOTE_PAGE_LIMIT), //skip earlier pages
    });
    const response = await attioFetch(`/notes?${query.toString()}`); //GET this page
    const items = responseData(response); //the page's notes
    if (!Array.isArray(items)) throw new Error("Attio notes response is missing a data array"); //not a list
    for (const item of items) { //each raw note
      const note = parseAttioNote(item); //read it
      if (note) notes.push(note); //keep readable ones
    }
    //A short page is the last page. Attio returns exactly `limit` while more remain.
    if (items.length < NOTE_PAGE_LIMIT) return { notes, complete: true }; //last page, all read
  }
  return { notes, complete: false }; //hit the bound, more may exist
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads one raw note into an AttioNote.
//Input: value - one note from Attio, unknown shape.
//Output: the note, or null if it has no id or creation time.
//Workflow: listNotes - each note on a page.
//---------------------------------------------------------------------------------------------------------
function parseAttioNote(value: unknown): AttioNote | null {
  if (!isJsonObject(value)) return null; //not an object, no note
  const id = objectValue(value, "id"); //the id object
  const noteId = id ? stringValue(id.note_id) : null; //the note's id, or null
  const createdAt = stringValue(value.created_at); //creation time text
  if (!noteId || !createdAt) return null; //missing id or time
  const createdAtMs = Date.parse(createdAt); //time as epoch ms
  if (!Number.isFinite(createdAtMs)) return null; //unreadable time
  //An untitled note is legal in Attio and simply matches no title the workflows write.
  return { id: noteId, title: stringValue(value.title) ?? "", createdAtMs }; //the note, blank title if none
}
//#endregion

//#region <write notes>
//---------------------------------------------------------------------------------------------------------
//Adds a note to a record.
//Input: parentObject - people, companies or deals; parentRecordId - the record; title, content - the note
//(content is markdown); parentName - name for the log (defaults to the id).
//Output: nothing. Throws if Attio refuses.
//Uses: withAction, attioFetch (this file).
//Workflow: the touchpoint syncs - the touchpoint note on the person and company; interested workflow step 4 -
//the note on the person and deal; writeRunLogNotes (lib/run-log.ts) - the run transcript.
//
//Attio has no upsert for notes, so calling twice produces two notes.
//---------------------------------------------------------------------------------------------------------
export async function createNote(
  parentObject: AttioObject,
  parentRecordId: string,
  title: string,
  content: string,
  parentName: string = parentRecordId,
): Promise<void> {
  await withAction(`note added to ${parentObject} ${parentName} (${JSON.stringify(title)})`, () => //send the note, logging the result
    attioFetch("/notes", {
      method: "POST", //POST creates a note
      body: JSON.stringify({ //the note, as JSON text
        data: { //attio wraps fields in data
          parent_object: parentObject, //record kind
          parent_record_id: parentRecordId, //which record
          title, //same as title: title
          format: "markdown", //content is markdown
          content, //same as content: content
        },
      }),
    }),
  );
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <count touchpoints>

//#region <increment a counter>
//---------------------------------------------------------------------------------------------------------
//Raises a counter attribute by one. Read-then-write, because Attio exposes no atomic increment.
//Input: objectType - people or companies; recordId - the record; attributeSlug - the counter's slug;
//recordName - name for the log (defaults to the id).
//Output: nothing. Throws if the read or write fails.
//Uses: fetchRecord, recordDisplayName, counterValue, attioFetch (this file); errorMessage (lib/json.ts).
//Workflow: all four touchpoint syncs - bump the person's and company's touchpoint counters.
//
//[STABILITY] Two concurrent runs against one record would both read the same value and one increment would be
//lost. Nothing guards against overlapping invocations of the same sync.
//[DEBUG] A 400 or 404 here almost always means the ATTIO_*_COUNTER_SLUG env value does not name a real
//attribute on that object, so the log says so explicitly rather than reporting a bare API error.
//---------------------------------------------------------------------------------------------------------
export async function incrementCounter(
  objectType: Exclude<AttioObject, "deals">,
  recordId: string,
  attributeSlug: string,
  recordName: string = recordId,
): Promise<void> {
  //The current value has to be read before it can be raised, and that response carries the record's name. Taking
  //the name from it is what lets a company - whose name no caller here has in hand - be logged by name without a
  //request of its own. Until that read returns, the caller's name is all there is to report a failure by.
  let label = recordName; //name for the log
  try {
    const record = await fetchRecord(objectType, recordId); //read the record
    label = recordDisplayName(record) ?? recordName; //its real name, if it has one
    const current = counterValue(record, attributeSlug); //current count
    await attioFetch(`/objects/${objectType}/records/${recordId}`, { //send the update
      method: "PATCH", //PATCH changes only this attribute
      body: JSON.stringify({ data: { values: { [attributeSlug]: current + 1 } } }), //count plus one
    });
    console.log( //log old and new count
      `[action] counter ${attributeSlug} on ${objectType} ${label}: ${current} -> ${current + 1}`,
    );
  } catch (error) {
    console.error( //log the failure
      `[action] FAILED - counter ${attributeSlug} on ${objectType} ${label}: ${errorMessage(error)}`,
    );
    if (error instanceof AttioApiError && (error.status === 400 || error.status === 404)) { //likely a bad slug
      console.warn( //say the slug may be wrong
        `[slug] Attio returned ${error.status} while incrementing ${JSON.stringify(attributeSlug)} on ${objectType} - either that record is gone or no such attribute exists on the ${objectType} object. Counter slugs come from the ATTIO_PERSON_* and ATTIO_COMPANY_*_COUNTER_SLUG values logged above.`,
      );
    }
    throw error; //pass the error on
  }
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads one counter attribute off an already-parsed record.
//Input: record - the parsed record; attributeSlug - the counter's slug.
//Output: the count; 0 if it has never been set. Throws if the attribute is not a number.
//Workflow: incrementCounter - the value to add one to.
//
//[LOGIC] An absent attribute means zero - a record that has never been counted starts at nothing. Present but
//non-numeric is a configuration error, not a zero: it means the slug names some other kind of attribute, and
//counting from zero would overwrite it.
//---------------------------------------------------------------------------------------------------------
function counterValue(record: AttioRecord, attributeSlug: string): number {
  const first = arrayValue(record.rawValues, attributeSlug)[0]; //the counter's value entry
  if (first === undefined) return 0; //never counted, start at 0
  if (!isJsonObject(first)) throw new Error(`Attio counter ${attributeSlug} is invalid`); //unreadable entry
  const counter = numberValue(first.value); //the number, or null
  if (counter === null) throw new Error(`Attio counter ${attributeSlug} is not numeric`); //wrong kind of attribute
  return counter; //the current count
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read attio settings>

//#region <counter slugs>
//Counter attribute slugs. Both scopes are configured rather than hardcoded: the Attio attribute names have already
//diverged once (the Company HeyReach counter is not the same slug as the Person one), and renaming an attribute in
//Attio should not require a redeploy. A missing value throws rather than defaulting, because a wrong slug would
//silently write a counter nobody reads.

//---------------------------------------------------------------------------------------------------------
//Reads the counter slug for one scope and provider from env.
//Input: scope - PERSON or COMPANY; provider - which platform.
//Output: the slug. Throws if the env variable is missing.
//Uses: requiredEnv, reportConfigValue (lib/env.ts).
//Workflow: personCounterSlug, companyCounterSlug.
//---------------------------------------------------------------------------------------------------------
function counterSlug(scope: "PERSON" | "COMPANY", provider: Provider): string {
  const envName = `ATTIO_${scope}_${provider.toUpperCase()}_COUNTER_SLUG`; //e.g. ATTIO_PERSON_AIRCALL_COUNTER_SLUG
  const slug = requiredEnv(envName); //read it, throw if missing
  //[DEBUG] Not a secret, so the resolved slug is printed in full once per process to make a typo visible.
  reportConfigValue(envName, slug); //log the value once
  return slug; //the slug
}

//---------------------------------------------------------------------------------------------------------
//Gives the person counter slug for a provider.
//Input: provider - which platform.
//Output: the slug. Throws if the env variable is missing.
//Uses: counterSlug (this file).
//Workflow: all four touchpoint syncs - which person counter to bump.
//---------------------------------------------------------------------------------------------------------
export function personCounterSlug(provider: Provider): string {
  return counterSlug("PERSON", provider); //person scope
}

//---------------------------------------------------------------------------------------------------------
//Gives the company counter slug for a provider.
//Input: provider - which platform.
//Output: the slug. Throws if the env variable is missing.
//Uses: counterSlug (this file).
//Workflow: all four touchpoint syncs - which company counter to bump.
//---------------------------------------------------------------------------------------------------------
export function companyCounterSlug(provider: Provider): string {
  return counterSlug("COMPANY", provider); //company scope
}
//#endregion

//#region <deal owner>
//---------------------------------------------------------------------------------------------------------
//Reads the default deal owner's email from env.
//Input: none.
//Output: the owner's email. Throws if ATTIO_DEFAULT_DEAL_OWNER is missing.
//Uses: requiredEnv, reportConfigEmail (lib/env.ts).
//Workflow: interested workflow step 3 - the owner of a new deal.
//
//Single accessor for the deal owner so the configured address is reported once, by domain only.
//---------------------------------------------------------------------------------------------------------
export function defaultDealOwner(): string {
  const owner = requiredEnv("ATTIO_DEFAULT_DEAL_OWNER"); //read it, throw if missing
  //[SECURITY] Domain only. Enough to spot the wrong workspace without publishing a mailbox to the logs.
  reportConfigEmail("ATTIO_DEFAULT_DEAL_OWNER", owner); //log the domain once
  return owner; //the owner's email
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <detect throttled events>

//#region <before any write>
//---------------------------------------------------------------------------------------------------------
//Wraps a touchpoint step that has not yet written anything, turning a TRANSIENT failure into
//ThrottledBeforeWrite.
//Input: step - the read-only step to run.
//Output: whatever step returns. Throws ThrottledBeforeWrite on a 429/5xx, the original error otherwise.
//Uses: isTransientAttioError (this file).
//Workflow: all four touchpoint syncs - wraps the person lookup and the Master TAM check.
//
//A deterministic failure (a 400 or 404, a bad slug, a malformed record) is re-raised untouched, because
//retrying it on every future run would block the sync on an event that can never succeed.
//---------------------------------------------------------------------------------------------------------
export async function beforeAnyWrite<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step(); //run the step
  } catch (error) {
    if (isTransientAttioError(error)) throw new ThrottledBeforeWrite(error); //transient: retry next run
    throw error; //anything else: pass it on
  }
}

//---------------------------------------------------------------------------------------------------------
//Base function. Checks whether a failure is worth attempting again on a LATER run.
//Input: error - whatever was thrown.
//Output: true for an Attio 429 or 5xx, false for anything else.
//Workflow: beforeAnyWrite - deciding "throttled, come back" from "unprocessable, move on".
//
//429 and 5xx are the transient set; anything else Attio returns is deterministic.
//This is NOT about an immediate retry - attioFetch has already exhausted those by the time a caller sees an
//error. It is for a caller deciding between "throttled, come back to this" and "this is unprocessable, move
//on": every touchpoint sync uses it, through beforeAnyWrite below, to avoid advancing its cursor past an
//event it was merely rate-limited or 500'd out of before it had written anything.
//Not exported - beforeAnyWrite below is the only caller, and is the form every sync actually wants.
//---------------------------------------------------------------------------------------------------------
function isTransientAttioError(error: unknown): boolean {
  return error instanceof AttioApiError && TRANSIENT_STATUSES.has(error.status); //attio error with a transient status
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <attio transport>

//#region <requests>
//---------------------------------------------------------------------------------------------------------
//Sends one request to Attio, retrying when allowed. Nothing else calls fetch against Attio.
//Input: path - the API path after ATTIO_BASE; options - fetch options (method, body, extra headers).
//Output: the parsed JSON body. Throws AttioApiError, carrying status and body, on a final failure.
//Uses: attioHeaders, credentialHint (lib/endpoints.ts); retryAfterMs (lib/http.ts); responseJson
//(lib/json.ts); isRetryable (this file).
//Workflow: every Attio request.
//
//[SECURITY] The bearer token is read from env per request by attioHeaders and never cached in module state.
//[DEBUG] credentialHint appends the env var name to a 401/403; the typed status lets incrementCounter tell a
//bad attribute slug (400/404) apart from a transport failure. Every retry logs, so a run that is being
//throttled says so rather than merely appearing slow.
//NOTE: a filtered lookup is POST /objects/*/records/query, which reads rather than writes but is still a POST,
//so it gets the 429 retry and not the 5xx one. That is the conservative side of the line, not an oversight.
//---------------------------------------------------------------------------------------------------------
export async function attioFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) { //loop until success or give up
    const response = await fetch(`${ATTIO_BASE}${path}`, { //send the request
      ...options, //caller's method and body
      headers: { ...attioHeaders(), ...options.headers }, //login headers, caller's win
    });
    const body = await responseJson(response); //read the body as json
    if (response.ok) return body; //success, hand it back

    if (attempt >= MAX_ATTEMPTS || !isRetryable(response.status, options)) { //out of tries, or not retryable
      throw new AttioApiError( //give up with the status
        `Attio API error ${response.status}: ${JSON.stringify(body)}${credentialHint("attio", response.status)}`,
        response.status,
        body,
      );
    }
    //Attio's own figure wins when it sends one; it knows when the window resets and the backoff is a guess.
    const waitMs = retryAfterMs(response) ?? RETRY_BASE_MS * 2 ** (attempt - 1); //attio's wait, else doubling backoff
    console.warn( //log the retry
      `[attio] ${response.status} on ${path} (attempt ${attempt} of ${MAX_ATTEMPTS}) - waiting ${waitMs}ms and retrying`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs)); //sleep for waitMs
  }
}

//---------------------------------------------------------------------------------------------------------
//Base function. Takes the "data" field out of an Attio response.
//Input: value - a parsed Attio response body.
//Output: the data field. Throws if there is none.
//Workflow: every read in this file that needs the result - lookups, creates, fetchRecord, lists, notes.
//---------------------------------------------------------------------------------------------------------
function responseData(value: unknown): unknown {
  if (!isJsonObject(value) || !("data" in value)) { //no data field
    throw new Error("Attio response is missing data"); //unexpected shape
  }
  return value.data; //the payload
}
//#endregion

//#region <retry rules>
//---------------------------------------------------------------------------------------------------------
//Base function. Checks whether a request is a GET.
//Input: options - the request's fetch options.
//Output: true for a GET.
//Workflow: isRetryable - 5xx is only retried on reads.
//
//GET is the default when a caller passes no method, matching fetch.
//---------------------------------------------------------------------------------------------------------
function isReadOnly(options: RequestInit): boolean {
  return (options.method ?? "GET").toUpperCase() === "GET"; //no method means GET
}

//---------------------------------------------------------------------------------------------------------
//Checks whether a failed request may be retried now.
//Input: status - the response status; options - the request's fetch options.
//Output: true for a 429 on any method, or a 5xx on a GET.
//Uses: isReadOnly (this file).
//Workflow: attioFetch - retry or give up.
//---------------------------------------------------------------------------------------------------------
function isRetryable(status: number, options: RequestInit): boolean {
  if (RETRY_ON_ANY_METHOD.has(status)) return true; //429: always retry
  return isReadOnly(options) && RETRY_ON_GET_ONLY.has(status); //5xx: only on a GET
}
//#endregion

//#endregion
//=============================================================================================================
