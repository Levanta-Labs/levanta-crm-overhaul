//imports======================================================================================================

import { reportConfigEmail, reportConfigValue, requiredEnv } from "./env.js";
import type { Provider } from "./providers.js";
import { ATTIO_BASE, attioHeaders, credentialHint } from "./endpoints.js";
import { retryAfterMs } from "./http.js";
import {
  arrayValue,
  errorMessage,
  isJsonObject,
  numberValue,
  objectValue,
  responseJson,
  stringValue,
  type JsonObject,
} from "./json.js";

//=============================================================================================================

//types and globals============================================================================================

export type AttioObject = "people" | "companies" | "deals";

export interface AttioRecordReference {
  readonly target_object?: string;
  readonly target_record_id: string;
}

/** Attribute values on their way INTO Attio, keyed by slug. Built by the mappers in lib/interested.ts. */
export type AttioValues = Readonly<Record<string, unknown>>;

//---------------------------------------------------------------------------------------------------------
//Any Attio record, of any object, in the two forms the codebase needs: the attribute values as Attio returned
//them, and the set of slugs currently holding anything at all.
//populatedAttributes is type-agnostic on purpose. Attio wraps every attribute in an array whatever its type, so
//a non-empty array is the only "has a value" test that works across text, references, selects, and counters
//alike. updateAttioAttributes (lib/interested.ts) is built on it, and is what stops a write overwriting.
//---------------------------------------------------------------------------------------------------------
export interface AttioRecord {
  readonly id: {
    readonly record_id: string;
  };
  //As Attio returned them: each attribute an array of value objects whose shape follows its type - `{ value }`
  //for text, `{ email_address }` for an address, `{ option: { title } }` for a select. Read these through the
  //extractors in lib/interested.ts rather than reaching in directly.
  readonly rawValues: JsonObject;
  readonly populatedAttributes: ReadonlySet<string>;
}

/** A person, with the three attributes the interested and touchpoint workflows navigate by parsed out. */
export interface AttioPerson extends AttioRecord {
  readonly values: {
    readonly associated_deals: readonly AttioRecordReference[];
    readonly company: readonly AttioRecordReference[];
    readonly name: readonly { readonly full_name: string | null }[];
  };
}

export interface PersonNameInput {
  readonly first_name: string;
  readonly last_name: string;
  readonly full_name: string;
}

/** One note as the duplicate check needs it: what it is called and when it landed. Content is never read. */
export interface AttioNote {
  readonly id: string;
  readonly title: string;
  readonly createdAtMs: number;
}

export interface AttioNoteListing {
  readonly notes: readonly AttioNote[];
  /**
   * False when MAX_NOTE_PAGES was spent with more still unread. The caller then knows only that it did not
   * SEE a given note, not that none exists, which is the difference between declining to write and failing
   * open - see recentlyNoted (lib/interested.ts).
   */
  readonly complete: boolean;
}

export const LISTS = {
  MASTER_TAM: "master_tam_list",
  DNC: "dnc",
} as const;

export class AttioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AttioApiError";
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
const RETRY_ON_ANY_METHOD = new Set([429]);
const RETRY_ON_GET_ONLY = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
//Doubles per attempt: 0.5s, 1s, 2s. Total added latency is under four seconds, which one call can afford inside
//the sync's run budget - and a run that spends its budget waiting now stops cleanly rather than being killed.
const RETRY_BASE_MS = 500;

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

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
  constructor(readonly reason: unknown) {
    super(errorMessage(reason));
    this.name = "ThrottledBeforeWrite";
  }
}

//Attio caps `limit` at 50, and the listing documents no sort order - so absence can only be concluded by
//reading every page, and a record with a long note history has to be bounded somewhere. Four pages covers
//200 notes, which is far past what an interested lead accumulates; past that the caller fails open.
const NOTE_PAGE_LIMIT = 50;
const MAX_NOTE_PAGES = 4;

//=============================================================================================================

//parse attio records==========================================================================================

//parce functions, turns raw pull from attio (json) into usable data

//#region <parse attio records: whole records>
//---------------------------------------------------------------------------------------------------------
//Turns one raw Attio record of any object into the shape the rest of the codebase uses.
//FLOW: 1. require id.record_id and values. 2. keep the values verbatim. 3. record which slugs hold anything.
//Step 3 is the whole basis of never-overwrite: see AttioRecord.populatedAttributes.
//---------------------------------------------------------------------------------------------------------
export function parseAttioRecord(value: unknown): AttioRecord {
  if (!isJsonObject(value)) throw new Error("Attio returned an invalid record");
  const id = objectValue(value, "id");
  const values = objectValue(value, "values");
  const recordId = id ? stringValue(id.record_id) : null;
  if (!recordId || !values) throw new Error("Attio record is missing id or values");

  const populatedAttributes = new Set(
    Object.keys(values).filter((slug) => arrayValue(values, slug).length > 0),
  );
  return { id: { record_id: recordId }, rawValues: values, populatedAttributes };
}

//---------------------------------------------------------------------------------------------------------
//Turns one raw Attio person record into the shape the rest of the codebase uses.
//FLOW: 1. parseAttioRecord for the generic half. 2. read the linked deals and company as references, and the
//names, because those three are what the workflows navigate by rather than merely write.
//---------------------------------------------------------------------------------------------------------
export function parseAttioPerson(value: unknown): AttioPerson {
  const record = parseAttioRecord(value);
  const values = record.rawValues;

  const names = arrayValue(values, "name")
    .map((name) => {
      if (!isJsonObject(name)) return null;
      return { full_name: stringValue(name.full_name) };
    })
    .filter((name): name is { readonly full_name: string | null } => name !== null);

  return {
    ...record,
    values: {
      associated_deals: parseReferences(values, "associated_deals"),
      company: parseReferences(values, "company"),
      name: names,
    },
  };
}
//#endregion

//#region <parse attio records: references>
function parseRecordReference(value: unknown): AttioRecordReference | null {
  if (!isJsonObject(value)) return null;
  const recordId = stringValue(value.target_record_id);
  if (!recordId) return null;
  const targetObject = stringValue(value.target_object);
  return targetObject
    ? { target_object: targetObject, target_record_id: recordId }
    : { target_record_id: recordId };
}

function parseReferences(values: JsonObject, key: string): readonly AttioRecordReference[] {
  //Unreadable entries are dropped rather than throwing: one malformed reference should not void the record.
  return arrayValue(values, key)
    .map(parseRecordReference)
    .filter((value): value is AttioRecordReference => value !== null);
}
//#endregion

//#region <parse attio records: names and links>
/**
 * The name on a record we have already fetched. Attio spells the attribute two ways - a person's name is
 * structured (`full_name`), a company's is a plain text `value` - and either may be absent. Returns null rather
 * than throwing on any shape it does not recognise: a log line is not worth failing a write over.
 */
export function recordDisplayName(record: AttioRecord): string | null {
  const first = arrayValue(record.rawValues, "name")[0];
  if (!isJsonObject(first)) return null;
  return stringValue(first.full_name) ?? stringValue(first.value);
}

export function personDisplayName(person: AttioPerson): string | null {
  return person.values.name[0]?.full_name ?? null;
}

/** What a person is called in the logs: their name, or their record id when Attio holds no name for them. */
export function personLabel(person: AttioPerson): string {
  return personDisplayName(person) ?? person.id.record_id;
}

export function personCompanyId(person: AttioPerson): string | null {
  return person.values.company[0]?.target_record_id ?? null;
}
//#endregion

//=============================================================================================================

//look up people and companies=================================================================================

//          Match Data From Thrid Party Records To Record ID In Attio

//#region <look up people and companies: people>
//---------------------------------------------------------------------------------------------------------
//One filtered person query. The three exported wrappers below differ only in the attribute searched.
//FLOW: 1. no value -> no query. 2. POST the filter, limit 1. 3. no hit -> null. 4. hit -> parseAttioPerson.
//[DEBUG] Every branch logs, including the misses. A lookup that quietly returns null is the usual cause of a
//touchpoint vanishing, so the searched attribute and value are named in the log line.
//NOTE: those log lines carry the business identifier - an address, number, or profile URL. Not credentials,
//but personal data in a retained log.
//---------------------------------------------------------------------------------------------------------
async function findPerson(attribute: string, value: string | null): Promise<AttioPerson | null> {
  if (!value) {
    console.log(`[lookup] person by ${attribute}: skipped - no value to search for`);
    return null;
  }
  const response = await attioFetch("/objects/people/records/query", {
    method: "POST",
    body: JSON.stringify({ filter: { [attribute]: value }, limit: 1 }),
  });
  const data = responseData(response);
  if (!Array.isArray(data)) throw new Error("Attio person query returned invalid data");
  if (data[0] === undefined) {
    console.log(`[lookup] person by ${attribute} ${JSON.stringify(value)}: no match`);
    return null;
  }
  const person = parseAttioPerson(data[0]);
  console.log(`[lookup] person by ${attribute} ${JSON.stringify(value)}: matched ${personLabel(person)}`);
  return person;
}

export function findPersonByEmail(email: string | null): Promise<AttioPerson | null> {
  return findPerson("email_addresses", email);
}

export function findPersonByPhone(phone: string | null): Promise<AttioPerson | null> {
  //Callers must pass E.164: Attio matches on the stored form, not on a punctuated display number.
  return findPerson("phone_numbers", phone);
}

export function findPersonByLinkedIn(profileUrl: string | null): Promise<AttioPerson | null> {
  return findPerson("linkedin", profileUrl);
}
//#endregion

//#region <look up people and companies: companies>
//Companies. Before this existed no interested workflow resolved one, so a deal opened for a brand-new lead
//carried no company and the touchpoint crons had nothing to hang a company note or counter on.

/** One filtered company query. Domain is the strong identifier; name is the fallback and matches exactly. */
async function findCompany(attribute: string, value: string | null): Promise<AttioRecord | null> {
  if (!value) {
    console.log(`[lookup] company by ${attribute}: skipped - no value to search for`);
    return null;
  }
  const response = await attioFetch("/objects/companies/records/query", {
    method: "POST",
    body: JSON.stringify({ filter: { [attribute]: value }, limit: 1 }),
  });
  const data = responseData(response);
  if (!Array.isArray(data)) throw new Error("Attio company query returned invalid data");
  if (data[0] === undefined) {
    console.log(`[lookup] company by ${attribute} ${JSON.stringify(value)}: no match`);
    return null;
  }
  const company = parseAttioRecord(data[0]);
  console.log(
    `[lookup] company by ${attribute} ${JSON.stringify(value)}: matched ${recordDisplayName(company) ?? company.id.record_id}`,
  );
  return company;
}

export function findCompanyByDomain(domain: string | null): Promise<AttioRecord | null> {
  return findCompany("domains", domain);
}

export function findCompanyByName(name: string | null): Promise<AttioRecord | null> {
  return findCompany("name", name);
}
//#endregion

//#region <look up people and companies: whole records>
/** Reads one record whole, so a caller can see what it already holds before deciding what to write. */
export async function fetchRecord(object: AttioObject, recordId: string): Promise<AttioRecord> {
  const response = await attioFetch(`/objects/${object}/records/${recordId}`);
  return parseAttioRecord(responseData(response));
}
//#endregion

//=============================================================================================================

//write to attio===============================================================================================

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

//#region <write to attio: create records>
/** Creates a person and returns it parsed, so the caller has both the new ID and its populated-attribute set. */
export async function createPerson(values: AttioValues): Promise<AttioPerson> {
  //Not withAction: the log line needs the created record's name, which only exists after the response parses.
  try {
    const response = await attioFetch("/objects/people/records", {
      method: "POST",
      body: JSON.stringify({ data: { values } }),
    });
    const person = parseAttioPerson(responseData(response));
    console.log(`[action] person created: ${personLabel(person)}`);
    return person;
  } catch (error) {
    console.error(`[action] FAILED - person could not be created: ${errorMessage(error)}`);
    throw error;
  }
}

/** Creates a company and returns it parsed, so the caller has the new ID and its populated-attribute set. */
export async function createCompany(values: AttioValues): Promise<AttioRecord> {
  try {
    const response = await attioFetch("/objects/companies/records", {
      method: "POST",
      body: JSON.stringify({ data: { values } }),
    });
    const company = parseAttioRecord(responseData(response));
    console.log(`[action] company created: ${recordDisplayName(company) ?? company.id.record_id}`);
    return company;
  } catch (error) {
    console.error(`[action] FAILED - company could not be created: ${errorMessage(error)}`);
    throw error;
  }
}
//#endregion

//#region <write to attio: update records>
//---------------------------------------------------------------------------------------------------------
//The one write path for attributes on any record. Deliberately dumb: it writes exactly what it is handed.
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
  const slugs = Object.keys(values);
  if (slugs.length === 0) {
    console.log(`[action] ${object} ${recordName} not updated - no attributes needed writing`);
    return;
  }
  await withAction(`${object} ${recordName} updated: ${slugs.join(", ")}`, () =>
    attioFetch(`/objects/${object}/records/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values } }),
    }),
  );
}
//#endregion

//#region <write to attio: deals>
//---------------------------------------------------------------------------------------------------------
//Returns the deal to attach interested history to, creating one only when the person has none.
//FLOW: 1. person already linked to a deal -> fetch and return it. 2. otherwise create at stage Interested,
//owned by ownerEmail, linked to the person and to the company the caller resolved.
//Step 1 is deliberately stage-blind: any existing deal is reused whatever phase it sits in, so an interested
//signal updates the live deal rather than opening a second one alongside it.
//KNOWN GAP: a person linked to SEVERAL deals gets the first Attio returned, and that order is not specified -
//so which deal receives the note is arbitrary. Closing it needs a rule for which deal wins (newest? furthest
//along?); until there is one, the log names the count so the arbitrariness is at least visible.
//The deal is fetched whole rather than returned as a bare id, because the caller's next act is to fill its
//blank attributes and it cannot know which are blank without reading it. On the create path the POST response
//already carries them, so neither path costs a request the caller was not going to make anyway.
//companyId comes from the caller, not from `person`, so a company resolved for a person who had none is still
//linked. Passing null omits the association, as before.
//USES: attioFetch, parseAttioRecord, fetchRecord (this module); ownerEmail comes from defaultDealOwner below.
//---------------------------------------------------------------------------------------------------------
export async function ensureInterestedDeal(
  person: AttioPerson,
  dealName: string,
  ownerEmail: string,
  companyId: string | null,
): Promise<AttioRecord> {
  const associated = person.values.associated_deals;
  const existing = associated[0]?.target_record_id;
  //[DEBUG] Logged in BOTH directions, like every other lookup here. A line only on the hit would leave "checked,
  //found none, so created one" and "never checked" reading identically in the log, and the second is a bug the
  //first is not. The count is named because more than one associated deal means the choice below is arbitrary.
  console.log(
    existing
      ? `[lookup] deal for person ${personLabel(person)}: ${associated.length} already associated, reusing ${existing}${associated.length > 1 ? " - the first Attio returned, which is an arbitrary choice among them" : ""}`
      : `[lookup] deal for person ${personLabel(person)}: none associated, so a new one is created`,
  );
  if (existing) {
    //Its name is left exactly as it stands. A deal already in the pipeline has been named by whoever is working
    //it, and the strict naming convention below governs deals this codebase opens, not deals it finds.
    return fetchRecord("deals", existing);
  }

  try {
    const response = await attioFetch("/objects/deals/records", {
      method: "POST",
      body: JSON.stringify({
        data: {
          values: {
            name: dealName,
            stage: "Interested",
            owner: ownerEmail,
            associated_people: [
              { target_object: "people", target_record_id: person.id.record_id },
            ],
            ...(companyId
              ? {
                  associated_company: {
                    target_object: "companies",
                    target_record_id: companyId,
                  },
                }
              : {}),
          },
        },
      }),
    });
    const deal = parseAttioRecord(responseData(response));
    console.log(
      `[action] deal created: ${JSON.stringify(dealName)} for person ${personLabel(person)}${companyId ? ` and company ${companyId}` : " with no associated company"}`,
    );
    return deal;
  } catch (error) {
    console.error(
      `[action] FAILED - deal could not be created for person ${personLabel(person)}: ${errorMessage(error)}`,
    );
    throw error;
  }
}
//#endregion

//#region <write to attio: action logging>
/** [DEBUG] Wraps one write so the log says whether it happened. Re-throws unchanged; changes no control flow. */
async function withAction<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    console.log(`[action] ${action}`);
    return result;
  } catch (error) {
    console.error(`[action] FAILED, did not happen - ${action}: ${errorMessage(error)}`);
    throw error;
  }
}
//#endregion

//=============================================================================================================

//manage lists=================================================================================================

//#region <manage lists: check membership>
//---------------------------------------------------------------------------------------------------------
//List-membership test. The three touchpoint crons gate every write on this returning true for Master TAM.
//FLOW: 1. read the person's list entries. 2. match the slug in either spelling Attio uses for it.
//[PERF] One request per person per event, uncached.
//---------------------------------------------------------------------------------------------------------
export async function isPersonInList(
  personId: string,
  listSlug: string,
  personName: string = personId,
): Promise<boolean> {
  const response = await attioFetch(`/objects/people/records/${personId}/entries`);
  const data = responseData(response);
  if (!Array.isArray(data)) throw new Error("Attio list entries response is invalid");
  //Attio returns the slug as list_id.slug on some entries and list_api_slug on others; accept both.
  const member = data.some((entry) => {
    if (!isJsonObject(entry)) return false;
    const listId = objectValue(entry, "list_id");
    return stringValue(listId?.slug) === listSlug || stringValue(entry.list_api_slug) === listSlug;
  });
  console.log(`[lookup] person ${personName} ${member ? "is" : "is NOT"} on list ${listSlug}`);
  return member;
}
//#endregion

//#region <manage lists: add to a list>
/** PUT asserts the entry, so re-adding an already-listed person is a no-op rather than a duplicate. */
export async function addPersonToList(
  personId: string,
  listSlug: string,
  personName: string = personId,
): Promise<void> {
  await withAction(`person ${personName} added to list ${listSlug}`, () =>
    attioFetch(`/lists/${listSlug}/entries`, {
      method: "PUT",
      body: JSON.stringify({
        data: { parent_record_id: personId, parent_object: "people", entry_values: {} },
      }),
    }),
  );
}
//#endregion

//=============================================================================================================

//manage notes=================================================================================================

//#region <manage notes: read notes>
//---------------------------------------------------------------------------------------------------------
//Every note on one record, up to the page bound.
//FLOW: 1. page through /notes filtered to this parent. 2. stop on a short page, on the bound, or on a page
//that parses to nothing. 3. report whether the listing was exhausted.
//[STABILITY] GET only, so attioFetch retries a 429 or a 5xx for free - see RETRY_ON_GET_ONLY.
//[PERF] One request for any record holding fewer than 50 notes, which is the ordinary case.
//USES: attioFetch, responseData, parseAttioNote (this module).
//---------------------------------------------------------------------------------------------------------
export async function listNotes(
  parentObject: AttioObject,
  parentRecordId: string,
): Promise<AttioNoteListing> {
  const notes: AttioNote[] = [];
  for (let page = 0; page < MAX_NOTE_PAGES; page += 1) {
    const query = new URLSearchParams({
      parent_object: parentObject,
      parent_record_id: parentRecordId,
      limit: String(NOTE_PAGE_LIMIT),
      offset: String(page * NOTE_PAGE_LIMIT),
    });
    const response = await attioFetch(`/notes?${query.toString()}`);
    const items = responseData(response);
    if (!Array.isArray(items)) throw new Error("Attio notes response is missing a data array");
    for (const item of items) {
      const note = parseAttioNote(item);
      if (note) notes.push(note);
    }
    //A short page is the last page. Attio returns exactly `limit` while more remain.
    if (items.length < NOTE_PAGE_LIMIT) return { notes, complete: true };
  }
  return { notes, complete: false };
}

function parseAttioNote(value: unknown): AttioNote | null {
  if (!isJsonObject(value)) return null;
  const id = objectValue(value, "id");
  const noteId = id ? stringValue(id.note_id) : null;
  const createdAt = stringValue(value.created_at);
  if (!noteId || !createdAt) return null;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  //An untitled note is legal in Attio and simply matches no title the workflows write.
  return { id: noteId, title: stringValue(value.title) ?? "", createdAtMs };
}
//#endregion

//#region <manage notes: write notes>
/** Appends a note. Attio has no upsert for notes, so calling twice produces two notes. */
export async function createNote(
  parentObject: AttioObject,
  parentRecordId: string,
  title: string,
  content: string,
  parentName: string = parentRecordId,
): Promise<void> {
  await withAction(`note added to ${parentObject} ${parentName} (${JSON.stringify(title)})`, () =>
    attioFetch("/notes", {
      method: "POST",
      body: JSON.stringify({
        data: {
          parent_object: parentObject,
          parent_record_id: parentRecordId,
          title,
          format: "markdown",
          content,
        },
      }),
    }),
  );
}
//#endregion

//=============================================================================================================

//count touchpoints============================================================================================

//#region <count touchpoints: increment a counter>
//---------------------------------------------------------------------------------------------------------
//Raises a counter attribute by one. Read-then-write, because Attio exposes no atomic increment.
//FLOW: 1. GET the record. 2. take its name off that response for the log. 3. parseCounterValue. 4. PATCH
//current+1. 5. on failure, name the slug when the status suggests the attribute itself is wrong.
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
  let label = recordName;
  try {
    const record = await fetchRecord(objectType, recordId);
    label = recordDisplayName(record) ?? recordName;
    const current = counterValue(record, attributeSlug);
    await attioFetch(`/objects/${objectType}/records/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values: { [attributeSlug]: current + 1 } } }),
    });
    console.log(
      `[action] counter ${attributeSlug} on ${objectType} ${label}: ${current} -> ${current + 1}`,
    );
  } catch (error) {
    console.error(
      `[action] FAILED - counter ${attributeSlug} on ${objectType} ${label}: ${errorMessage(error)}`,
    );
    if (error instanceof AttioApiError && (error.status === 400 || error.status === 404)) {
      console.warn(
        `[slug] Attio returned ${error.status} while incrementing ${JSON.stringify(attributeSlug)} on ${objectType} - either that record is gone or no such attribute exists on the ${objectType} object. Counter slugs come from the ATTIO_PERSON_* and ATTIO_COMPANY_*_COUNTER_SLUG values logged above.`,
      );
    }
    throw error;
  }
}

/**
 * [LOGIC] Reads one counter attribute off an already-parsed record. An absent attribute means zero - a record
 * that has never been counted starts at nothing. Present but non-numeric is a configuration error, not a zero:
 * it means the slug names some other kind of attribute, and counting from zero would overwrite it.
 */
function counterValue(record: AttioRecord, attributeSlug: string): number {
  const first = arrayValue(record.rawValues, attributeSlug)[0];
  if (first === undefined) return 0;
  if (!isJsonObject(first)) throw new Error(`Attio counter ${attributeSlug} is invalid`);
  const counter = numberValue(first.value);
  if (counter === null) throw new Error(`Attio counter ${attributeSlug} is not numeric`);
  return counter;
}
//#endregion

//=============================================================================================================

//read attio settings==========================================================================================

//#region <read attio settings: counter slugs>
//Counter attribute slugs. Both scopes are configured rather than hardcoded: the Attio attribute names have already
//diverged once (the Company HeyReach counter is not the same slug as the Person one), and renaming an attribute in
//Attio should not require a redeploy. A missing value throws rather than defaulting, because a wrong slug would
//silently write a counter nobody reads.

function counterSlug(scope: "PERSON" | "COMPANY", provider: Provider): string {
  const envName = `ATTIO_${scope}_${provider.toUpperCase()}_COUNTER_SLUG`;
  const slug = requiredEnv(envName);
  //[DEBUG] Not a secret, so the resolved slug is printed in full once per process to make a typo visible.
  reportConfigValue(envName, slug);
  return slug;
}

export function personCounterSlug(provider: Provider): string {
  return counterSlug("PERSON", provider);
}

export function companyCounterSlug(provider: Provider): string {
  return counterSlug("COMPANY", provider);
}
//#endregion

//#region <read attio settings: deal owner>
/** Single accessor for the deal owner so the configured address is reported once, by domain only. */
export function defaultDealOwner(): string {
  const owner = requiredEnv("ATTIO_DEFAULT_DEAL_OWNER");
  //[SECURITY] Domain only. Enough to spot the wrong workspace without publishing a mailbox to the logs.
  reportConfigEmail("ATTIO_DEFAULT_DEAL_OWNER", owner);
  return owner;
}
//#endregion

//=============================================================================================================

//detect throttled events======================================================================================

//#region <detect throttled events: before any write>
//---------------------------------------------------------------------------------------------------------
//Wraps a touchpoint step that has not yet written anything. A TRANSIENT failure there becomes
//ThrottledBeforeWrite; a deterministic one (a 400 or 404, a bad slug, a malformed record) is re-raised
//untouched, because retrying it on every future run would block the sync on an event that can never succeed.
//---------------------------------------------------------------------------------------------------------
export async function beforeAnyWrite<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (isTransientAttioError(error)) throw new ThrottledBeforeWrite(error);
    throw error;
  }
}

//---------------------------------------------------------------------------------------------------------
//Whether a failure is worth attempting again on a LATER run, as against one that will fail the same way every
//time. 429 and 5xx are the transient set; anything else Attio returns is deterministic.
//This is NOT about an immediate retry - attioFetch has already exhausted those by the time a caller sees an
//error. It is for a caller deciding between "throttled, come back to this" and "this is unprocessable, move
//on": every touchpoint sync uses it, through beforeAnyWrite below, to avoid advancing its cursor past an
//event it was merely rate-limited or 500'd out of before it had written anything.
//Not exported - beforeAnyWrite below is the only caller, and is the form every sync actually wants.
//---------------------------------------------------------------------------------------------------------
function isTransientAttioError(error: unknown): boolean {
  return error instanceof AttioApiError && TRANSIENT_STATUSES.has(error.status);
}
//#endregion

//=============================================================================================================

//attio transport==============================================================================================

//#region <attio transport: requests>
//---------------------------------------------------------------------------------------------------------
//Single transport for every Attio call in the codebase. Nothing else calls fetch against Attio.
//FLOW: 1. prefix the path with ATTIO_BASE. 2. merge attioHeaders (lib/endpoints.ts) under any caller override.
//3. parse the body with responseJson (lib/json.ts). 4. a retryable status with attempts left -> wait and repeat.
//5. any other non-2xx, or the last attempt -> throw AttioApiError carrying status and body.
//[SECURITY] The bearer token is read from env per request by attioHeaders and never cached in module state.
//[DEBUG] credentialHint appends the env var name to a 401/403; the typed status lets incrementCounter tell a
//bad attribute slug (400/404) apart from a transport failure. Every retry logs, so a run that is being
//throttled says so rather than merely appearing slow.
//NOTE: a filtered lookup is POST /objects/*/records/query, which reads rather than writes but is still a POST,
//so it gets the 429 retry and not the 5xx one. That is the conservative side of the line, not an oversight.
//---------------------------------------------------------------------------------------------------------
export async function attioFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${ATTIO_BASE}${path}`, {
      ...options,
      headers: { ...attioHeaders(), ...options.headers },
    });
    const body = await responseJson(response);
    if (response.ok) return body;

    if (attempt >= MAX_ATTEMPTS || !isRetryable(response.status, options)) {
      throw new AttioApiError(
        `Attio API error ${response.status}: ${JSON.stringify(body)}${credentialHint("attio", response.status)}`,
        response.status,
        body,
      );
    }
    //Attio's own figure wins when it sends one; it knows when the window resets and the backoff is a guess.
    const waitMs = retryAfterMs(response) ?? RETRY_BASE_MS * 2 ** (attempt - 1);
    console.warn(
      `[attio] ${response.status} on ${path} (attempt ${attempt} of ${MAX_ATTEMPTS}) - waiting ${waitMs}ms and retrying`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function responseData(value: unknown): unknown {
  if (!isJsonObject(value) || !("data" in value)) {
    throw new Error("Attio response is missing data");
  }
  return value.data;
}
//#endregion

//#region <attio transport: retry rules>
/** GET is the default when a caller passes no method, matching fetch. */
function isReadOnly(options: RequestInit): boolean {
  return (options.method ?? "GET").toUpperCase() === "GET";
}

function isRetryable(status: number, options: RequestInit): boolean {
  if (RETRY_ON_ANY_METHOD.has(status)) return true;
  return isReadOnly(options) && RETRY_ON_GET_ONLY.has(status);
}
//#endregion

//=============================================================================================================
