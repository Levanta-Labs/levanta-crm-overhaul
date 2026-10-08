//A transcript of one interested run, written back to every record it touched.
//
//WHY THIS EXISTS. Everything these workflows decide is already logged, but the log lives in Vercel, keyed by
//invocation, and expires. The question actually asked afterwards is never "what happened in invocation
//dpl_xyz" - it is "why does THIS record look like this". That is a question about a record, so the answer
//belongs on the record: what Attio held before the run, every line the run printed, and what it held after.
//
//The Person, the Company, and the Deal each get their own note. The transcript in all three is identical - it
//is one run - and only the two states differ, each record reporting itself.
//
//SELF-CONTAINED BY DESIGN. This module is additive. It imports from the codebase; nothing in the codebase
//imports from it except the marked one-line calls in lib/interested.ts. Deleting this file, its test, and
//every block marked `//debug note in attio=` removes the feature completely and changes nothing else.
//
//INTERESTED RUNS ONLY, without any of the shared modules having to know. Capture is scoped to an open run -
//see withRunLog - and lib/attio.ts is equally the touchpoint crons' code. Those crons never open a scope, so
//their prints pass straight through and are never collected. Nothing needed splitting to achieve that.
//
//[STABILITY] NOTHING HERE MAY THROW INTO A RUN. This is diagnostics attached to an event Attio has already
//committed; losing the transcript is a nuisance, losing the event is a data problem. Every entry point either
//no-ops outside a scope or swallows its own failure onto console.

//=============================================================================================================
//#region <import statements>

import { AsyncLocalStorage } from "node:async_hooks"; //per-run storage that follows async calls
import { createNote, type AttioObject, type AttioRecord } from "./attio.js"; //post notes, attio record types
import { arrayValue, errorMessage, isJsonObject, numberValue, stringValue, type JsonObject } from "./json.js"; //safe readers for unknown json
import { attributionOptionTitle, providerDisplayName, type Provider } from "./providers.js"; //provider names and option titles

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//---------------------------------------------------------------------------------------------------------
//One record the run touched, and what it did to it.
//
//THE AFTER STATE IS DERIVED, NOT RE-READ. `baseline` is the record as the run first saw it and `applied` is
//what the run then wrote to it, so the two compose into the state the run left behind - which is what a
//read-back would have cost three further Attio requests to ask. It is exact for everything this codebase
//does: patchRecord has three call sites, all inside writeSalvagingRejections, which only updateAttioAttributes
//calls - so an attribute here can only change through a create whose response is `baseline`, or through a
//write reported to runLogApplied. What it cannot see is Attio's own hand: a value normalised on write, a
//derived attribute, an automation reacting to the write, or a human editing the record mid-run. The note says
//"as this run left it" rather than claiming to be a reading of Attio, because that is what it is.
//---------------------------------------------------------------------------------------------------------
interface RunLogRecord {
  readonly id: string; //attio record id
  readonly name: string; //readable name for the note
  //Values as Attio returned them before the run. Null when the run created the record.
  readonly before: JsonObject | null; //state before the run
  //The record as first seen - the same values as `before`, or the create response for a new one.
  readonly baseline: JsonObject; //starting point for the after state
  //Slug to the value this run wrote, for the slugs Attio accepted. Layered onto `baseline`.
  readonly applied: Record<string, unknown>; //values this run wrote
}

//Everything one open run has collected so far.
interface RunLogState {
  readonly provider: Provider; //which platform the lead came from
  readonly startedAtMs: number; //when the run started, epoch ms
  readonly lines: string[]; //the printed lines, in order
  readonly records: Map<AttioObject, RunLogRecord>; //touched person, company, deal
}

//One finished transcript file, ready to post to one record.
export interface RunLogArtifact {
  readonly object: AttioObject; //people, companies or deals
  readonly recordId: string; //record the note goes on
  readonly filename: string; //a name for the file
  readonly contentType: string; //file type, plain text
  readonly body: string; //the note's full text
}

type MirroredMethod = "log" | "warn" | "error"; //console methods that get copied
type ConsolePrinter = (...parts: unknown[]) => void; //shape of a console print function

//Holds each run's state so overlapping runs stay apart.
const RUN_LOG = new AsyncLocalStorage<RunLogState>(); //the current run's state, per async chain

//[PERF] Caps, so a pathological run cannot post a note large enough for Attio to reject. Both are far above a
//normal run, which prints on the order of thirty lines.
const MAX_LINES = 500; //most lines kept per transcript
const MAX_VALUE_CHARS = 200; //longest value printed before cutting

//The order the notes are written in, which is also the order the records were resolved.
const OBJECT_ORDER: readonly AttioObject[] = ["people", "companies", "deals"]; //person, then company, then deal

const MIRRORED_METHODS: readonly MirroredMethod[] = ["log", "warn", "error"]; //the console methods to wrap
//The prefix a mirrored line carries. console.log is the ordinary case and says nothing; the other two do.
const METHOD_PREFIX: Readonly<Record<MirroredMethod, string>> = { log: "", warn: "WARN ", error: "ERROR " }; //label per method

let originalPrinters: Record<MirroredMethod, ConsolePrinter> | null = null; //real console functions while wrapped
let openScopes = 0; //how many runs are open now

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <mirror the console>

//---------------------------------------------------------------------------------------------------------
//Every console print made while a run is open is copied into that run's transcript.
//
//WHY MIRROR RATHER THAN CALL A RECORDER AT EACH SITE. The interested path prints from about sixty places
//across six modules. A recorder beside each one duplicates the message string sixty times, and two copies of a
//sentence drift the moment one is edited - a transcript that disagrees with the log is worse than no
//transcript. This way the existing prints are the single source, and neither can be edited without the other.
//
//Vercel's own output is untouched: the original is called first, with the same arguments, every time.
//
//[STABILITY] Installed on a refcount rather than per scope, because runs can overlap - the Aircall sync
//processes interested calls one after another inside a single invocation, and Vercel may run concurrent
//invocations in one instance. The refcount means the last scope to close is what restores the console, and
//AsyncLocalStorage is what keeps overlapping runs' lines apart. The exact original reference is restored, so a
//caller that swapped console.log itself - the unit tests do - gets its own function back rather than a wrapper.
//---------------------------------------------------------------------------------------------------------

//#region <install and restore>
//---------------------------------------------------------------------------------------------------------
//Wraps console.log/warn/error so each print is also copied into the open run's transcript.
//Input: none.
//Output: nothing.
//Uses: record (this file).
//Workflow: withRunLog - start copying prints when an interested run opens.
//---------------------------------------------------------------------------------------------------------
function installConsoleMirror(): void {
  openScopes += 1; //one more run open
  if (originalPrinters) return; //already wrapped by another run

  const originals = {} as Record<MirroredMethod, ConsolePrinter>; //empty holder for the real functions
  for (const method of MIRRORED_METHODS) { //log, warn, error
    const original: ConsolePrinter = console[method]; //the real print function
    originals[method] = original; //remember it for restoring
    console[method] = (...parts: unknown[]): void => { //replace it with a wrapper
      original.apply(console, parts); //print normally first
      record(method, parts); //then copy into the transcript
    };
  }
  originalPrinters = originals; //mark the console as wrapped
}

//---------------------------------------------------------------------------------------------------------
//Base function. Puts the real console functions back once the last open run closes.
//Input: none.
//Output: nothing.
//Workflow: withRunLog - stop copying prints when an interested run closes.
//---------------------------------------------------------------------------------------------------------
function restoreConsoleMirror(): void {
  openScopes = Math.max(0, openScopes - 1); //one fewer run open, never below 0
  if (openScopes > 0 || !originalPrinters) return; //others still open, or nothing wrapped
  for (const method of MIRRORED_METHODS) console[method] = originalPrinters[method]; //put each original back
  originalPrinters = null; //mark the console as unwrapped
}
//#endregion

//#region <copy a line into the transcript>
//---------------------------------------------------------------------------------------------------------
//Base function. Gives the current time of day for a transcript line, e.g. "14:03:22.517".
//Input: none.
//Output: the time, to the millisecond.
//Workflow: record - the time on each transcript line.
//
//[LOGIC] Wall-clock time of day to the millisecond. The date is in the note's own timestamp already.
//---------------------------------------------------------------------------------------------------------
function stamp(): string {
  return new Date().toISOString().slice(11, 23); //cut the time out of the full date
}

//---------------------------------------------------------------------------------------------------------
//Adds one printed line to the open run's transcript, up to MAX_LINES.
//Input: method - which console method printed it; parts - what was printed.
//Output: nothing. Does nothing outside a run.
//Uses: stamp (this file).
//Workflow: the console wrappers from installConsoleMirror - every print during an interested run.
//---------------------------------------------------------------------------------------------------------
function record(method: MirroredMethod, parts: readonly unknown[]): void {
  const state = RUN_LOG.getStore(); //this run's state, if a run is open
  if (!state || state.lines.length > MAX_LINES) return; //no run, or already truncated
  if (state.lines.length === MAX_LINES) { //just hit the cap
    state.lines.push(`[${stamp()}] ... transcript truncated at ${MAX_LINES} lines`); //say it was cut
    return; //stop adding lines
  }
  const text = parts.map((part) => (part instanceof Error ? part.message : String(part))).join(" "); //join the parts into text
  state.lines.push(`[${stamp()}] ${METHOD_PREFIX[method]}${text}`); //add the stamped line
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <record the run>

//#region <open a run>
//---------------------------------------------------------------------------------------------------------
//Opens a transcript for ONE interested lead, runs the workflow inside it, then posts the notes.
//Input: provider - the lead's platform; run - the workflow to run.
//Output: whatever run returns. Rethrows whatever run throws.
//Uses: installConsoleMirror, restoreConsoleMirror, writeRunLogNotes (this file).
//Workflow: interested workflow (recordInterestedLead) - wraps the whole run so it is written down.
//
//Scoped per lead rather than per invocation on purpose: the Aircall sync records several interested calls in a
//single invocation, and each is a separate set of records owed its own notes.
//The notes are written in the finally, so a run that throws still leaves its transcript on whatever it had
//already resolved - which is the run whose transcript is worth the most.
//---------------------------------------------------------------------------------------------------------
export async function withRunLog<T>(provider: Provider, run: () => Promise<T>): Promise<T> {
  const state: RunLogState = { provider, startedAtMs: Date.now(), lines: [], records: new Map() }; //fresh empty transcript
  installConsoleMirror(); //start copying prints
  try {
    return await RUN_LOG.run(state, async () => { //run with this state attached
      try {
        return await run(); //the actual workflow
      } finally {
        await writeRunLogNotes(state); //post notes even if it threw
      }
    });
  } finally {
    restoreConsoleMirror(); //stop copying prints
  }
}
//#endregion

//#region <track touched records>
//---------------------------------------------------------------------------------------------------------
//Base function. Registers a record the run touched, and takes its "before" picture.
//Input: object - people, companies or deals; source - the record as read or created; existed - false if the
//run created it; name - readable name for the note.
//Output: nothing. Does nothing outside a run.
//Workflow: interested workflow steps 1-3 - the person, company (resolveInterestedCompany) and deal, each
//before it is written to.
//
//MUST BE CALLED BEFORE THE RECORD IS WRITTEN TO, because `record` is both the previous state and the baseline
//the writes are layered onto. `existed` is what separates the two: a record the run created has no previous
//state to report, but its create response is still the baseline.
//Registering twice is ignored - the first call is the one that saw the record untouched.
//Outside a run this does nothing, which is what keeps the touchpoint crons out of the feature.
//---------------------------------------------------------------------------------------------------------
export function runLogRecord(object: AttioObject, source: AttioRecord, existed: boolean, name: string): void {
  const state = RUN_LOG.getStore(); //this run's state, if a run is open
  if (!state || state.records.has(object)) return; //no run, or already registered
  state.records.set(object, { //store the record's starting picture
    id: source.id.record_id, //attio record id
    name, //same as name: name
    before: existed ? source.rawValues : null, //no before for a new record
    baseline: source.rawValues, //values as first seen
    applied: {}, //nothing written yet
  });
}

//---------------------------------------------------------------------------------------------------------
//Base function. Notes which values a write actually changed on a registered record.
//Input: object - people, companies or deals; recordId - the record written; candidate - every value offered;
//written - the slugs Attio accepted.
//Output: nothing. Ignores records not registered in this run.
//Workflow: interested workflow step 5 (updateAttioAttributes) - what the attribute writes changed.
//
//[LOGIC] What a write actually changed. `candidate` is every value offered and `written` the slugs Attio
//accepted, so the two together are what the record now holds that it did not before - which is precisely what
//makes a read-back unnecessary. A write to a record nobody registered, or one for a different record, is
//ignored rather than guessed at.
//---------------------------------------------------------------------------------------------------------
export function runLogApplied(
  object: AttioObject,
  recordId: string,
  candidate: Readonly<Record<string, unknown>>,
  written: readonly string[],
): void {
  const target = RUN_LOG.getStore()?.records.get(object); //the registered record, if any
  if (!target || target.id !== recordId) return; //not registered, or a different record
  for (const slug of written) { //each accepted attribute
    if (slug in candidate) target.applied[slug] = candidate[slug]; //remember the value written
  }
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <write the transcript>

//#region <post the notes>
//---------------------------------------------------------------------------------------------------------
//Posts the transcript as a note on every record the run touched.
//Input: state - the run's collected lines and records.
//Output: nothing. Never throws; failures are only logged.
//Uses: runLogArtifacts (this file); createNote (lib/attio.ts); providerDisplayName (lib/providers.ts);
//errorMessage (lib/json.ts).
//Workflow: withRunLog's finally - the last write of every interested run. Called once.
//
//[STABILITY] Each note is written independently and swallows its own failure. They are the last writes of an
//event Attio has already committed, so one refused note may not cost the others, and none of them may reach
//the caller. A failure is reported to the log and nothing more.
//[DEBUG] A run that ends before any record is resolved says so rather than passing silently - a missing note
//is otherwise indistinguishable from a run that never happened.
//---------------------------------------------------------------------------------------------------------
async function writeRunLogNotes(state: RunLogState): Promise<void> {
  const artifacts = runLogArtifacts(); //one file per touched record
  if (artifacts.length === 0) { //no record was ever resolved
    console.warn( //say no note was written
      `[run-log] ${state.provider}: no transcript written - the run ended before any record was resolved, so there is nothing to attach it to`,
    );
    return; //nothing to post
  }

  const title = `run logs for automated integration (${providerDisplayName(state.provider)} marked as interested)`; //the note title
  for (const artifact of artifacts) { //each touched record
    try {
      const name = state.records.get(artifact.object)?.name ?? artifact.recordId; //readable name, else the id
      await createNote(artifact.object, artifact.recordId, title, artifact.body, name); //post the note
    } catch (error) {
      console.error( //log the failure, keep going
        `[run-log] ${state.provider}: the ${artifact.object} transcript could not be posted - ${errorMessage(error)}`,
      );
    }
  }
}
//#endregion

//#region <build one file per record>
//---------------------------------------------------------------------------------------------------------
//Builds the transcript as one in-memory file per record touched.
//Input: none (reads the open run's state).
//Output: the files, person then company then deal; empty outside a run.
//Uses: referenceNames, renderState, afterValues (this file).
//Workflow: writeRunLogNotes - the note bodies for the interested run. Also called by the unit tests.
//
//IN MEMORY BECAUSE THERE IS NOWHERE TO PUT IT. A Vercel function's filesystem is read-only bar /tmp, and /tmp
//goes with the instance and is reachable from nothing outside it - a file written there is neither durable nor
//retrievable. A file is a name, a type, and some bytes, and that is what this returns.
//
//It is also what a mail attachment or a Slack upload takes, which is the point of building it as a file at all
//rather than formatting a note directly: the day these are emailed or posted, the same call yields the same
//bytes the notes already carry, and nothing here changes.
//
//The log is rendered from ONE reading of the lines, so all three files carry the same transcript. Rendering
//per record instead would let each note pick up the note before it being written, and three accounts of one
//run that disagree about it are worth less than one.
//---------------------------------------------------------------------------------------------------------
export function runLogArtifacts(): readonly RunLogArtifact[] {
  const state = RUN_LOG.getStore(); //this run's state, if a run is open
  if (!state) return []; //no run, no files

  const names = referenceNames(state); //record id to readable name
  const transcript = state.lines.length > 0 ? state.lines.join("\n") : "none"; //all lines as one text
  const startedAt = new Date(state.startedAtMs).toISOString().replace(/[:.]/g, "-"); //start time, safe for filenames

  const artifacts: RunLogArtifact[] = []; //files built so far
  for (const object of OBJECT_ORDER) { //person, company, deal
    const target = state.records.get(object); //that record, if touched
    if (!target) continue; //not touched, skip
    artifacts.push({ //add this record's file
      object, //same as object: object
      recordId: target.id, //the record it goes on
      filename: `run-log-${state.provider}-${object}-${target.id}-${startedAt}.txt`, //unique file name
      contentType: "text/plain; charset=utf-8", //plain text
      body: [ //the note, section by section
        `Record ${target.before ? "did" : "did not"} exist before run.`,
        "",
        "**Previous state**",
        renderState(target.before, names),
        "",
        "**Run logs**",
        transcript,
        "",
        //Not a claim to have re-read Attio, and labelled so - see RunLogRecord.
        "**State after run** (as this run left it)",
        renderState(afterValues(target), names),
      ].join("\n"),
    });
  }
  return artifacts; //all the files
}

//---------------------------------------------------------------------------------------------------------
//Base function. Maps each touched record's id to its readable name.
//Input: state - the run's state.
//Output: id to name lookup.
//Workflow: runLogArtifacts - so references print as names.
//
//[LOGIC] Every record the run touched, so a reference between them prints as a name rather than an id.
//---------------------------------------------------------------------------------------------------------
function referenceNames(state: RunLogState): ReadonlyMap<string, string> {
  const names = new Map<string, string>(); //empty id-to-name lookup
  for (const target of state.records.values()) names.set(target.id, target.name); //add each touched record
  return names; //the lookup
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <describe record values>

//#region <whole record>
//---------------------------------------------------------------------------------------------------------
//Writes every attribute the record holds, one per line, in the order Attio returned them.
//Input: values - the record's values, or null; names - id-to-name lookup for references.
//Output: the lines as one text, or "none".
//Uses: describeAttioValue, humanizeSlug (this file).
//Workflow: runLogArtifacts - the "Previous state" and "State after run" sections.
//
//Attributes holding nothing are omitted rather than printed empty: the point of the two states is what
//CHANGED, and a hundred blank slugs on either side buries it.
//---------------------------------------------------------------------------------------------------------
function renderState(values: JsonObject | null, names: ReadonlyMap<string, string>): string {
  if (!values) return "none"; //no state to show
  const lines: string[] = []; //one line per attribute
  for (const slug of Object.keys(values)) { //each attribute name
    const entries = arrayValue(values, slug); //its values as a list
    const rendered = entries //each value as readable text, blanks dropped
      .map((entry) => describeAttioValue(entry, names))
      .filter((value): value is string => value !== null && value.length > 0);
    if (rendered.length > 0) lines.push(`${humanizeSlug(slug)}: ${rendered.join(", ")}`); //add "name: values" if any
  }
  return lines.length > 0 ? lines.join("\n") : "none"; //all lines, or "none"
}

//---------------------------------------------------------------------------------------------------------
//Base function. Builds the state the run left behind: first-seen values with the run's writes laid on top.
//Input: target - one touched record.
//Output: the after values.
//Workflow: runLogArtifacts - the "State after run" section.
//
//[LOGIC] The state the run left behind: what the record held when first seen, with everything the run wrote
//laid over the top. A written value arrives in the shape it was SENT - a bare string, an object, or an
//already-merged array - so a lone value is wrapped to match the array Attio would have returned it in.
//---------------------------------------------------------------------------------------------------------
function afterValues(target: RunLogRecord): JsonObject {
  const after: JsonObject = { ...target.baseline }; //copy of the starting values
  for (const [slug, value] of Object.entries(target.applied)) { //each written attribute
    after[slug] = Array.isArray(value) ? value : [value]; //overwrite, wrapped in a list
  }
  return after; //the after state
}
//#endregion

//#region <single values>
//---------------------------------------------------------------------------------------------------------
//Writes one Attio value as a human would read it.
//Input: entry - one value, in Attio's shape or as sent; names - id-to-name lookup for references.
//Output: readable text, or null if it is not a value.
//Uses: truncate, optionTitle, describeLocation (this file).
//Workflow: renderState - each value of each attribute.
//
//Attio spells the scalar differently for every attribute type - `{ value }` for text, `{ email_address }` for
//an address, `{ option: { title } }` for a select, `{ target_record_id }` for a reference - so this walks the
//known spellings in order of how specific they are and falls back to the raw JSON for a type it has not been
//taught. The fallback is deliberate: an unfamiliar attribute printing as JSON is still evidence, whereas
//dropping it silently would misreport the record as not holding it at all.
//
//It also takes bare scalars, because a value this run WROTE is in the shape it was sent in - a plain string
//for a text attribute - rather than the shape Attio returns it in. See afterValues.
//
//`names` is how a reference prints as something readable. It carries the run's own person, company, and deal,
//which is every record it touched; any other reference prints as its record id.
//---------------------------------------------------------------------------------------------------------
function describeAttioValue(entry: unknown, names: ReadonlyMap<string, string>): string | null {
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") return truncate(String(entry)); //bare value, print as is
  if (!isJsonObject(entry)) return null; //not a readable value

  const named = //first known text field that is set
    stringValue(entry.full_name) ??
    stringValue(entry.email_address) ??
    stringValue(entry.original_email_address) ??
    stringValue(entry.original_phone_number) ??
    stringValue(entry.phone_number) ??
    stringValue(entry.domain) ??
    stringValue(entry.root_domain) ??
    optionTitle(entry.option) ??
    optionTitle(entry.status) ??
    stringValue(entry.referenced_actor_name);
  if (named) return truncate(named); //found one, print it

  const location = describeLocation(entry); //try it as an address
  if (location) return truncate(location); //it was one, print it

  const currency = numberValue(entry.currency_value); //try it as money
  if (currency !== null) { //it was money
    const code = stringValue(entry.currency_code); //e.g. "USD"
    return code ? `${currency} ${code}` : String(currency); //amount, with code if known
  }

  const reference = stringValue(entry.target_record_id) ?? stringValue(entry.referenced_actor_id); //try it as a link
  if (reference) return names.get(reference) ?? reference; //name if known, else id

  const scalar = entry.value; //plain { value } shape
  if (typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean") { //a simple value
    return truncate(String(scalar)); //print it
  }
  return truncate(JSON.stringify(entry)); //unknown shape: print raw JSON
}

//---------------------------------------------------------------------------------------------------------
//Gives the readable title of a select or status option.
//Input: value - the option, as Attio returned it or as this run wrote it.
//Output: the title, or null if there is none.
//Uses: attributionOptionTitle (lib/providers.ts).
//Workflow: describeAttioValue - select and status values.
//
//[LOGIC] The readable half of a select or status.
//Two shapes reach here, because the transcript renders both sides of a change. A value Attio RETURNED nests
//its title one level down - `{ option: { id, title } }` - while a value this run WROTE names the option
//directly, and names it by ID: `{ option: "4dca8bb3-..." }`. Rendering only the first left the "after" half of
//an attribution line as a raw JSON blob beside the "before" half's plain English.
//A written option that is not one of ours is printed as sent, which is the title for any select written by
//title elsewhere.
//---------------------------------------------------------------------------------------------------------
function optionTitle(value: unknown): string | null {
  if (isJsonObject(value)) return stringValue(value.title); //attio's shape: read its title
  const written = stringValue(value); //written shape: plain text
  if (!written) return null; //nothing there
  return attributionOptionTitle(written) ?? written; //our option's title, else as sent
}

//---------------------------------------------------------------------------------------------------------
//Base function. Writes a structured location as one line, in the order it would go on an envelope.
//Input: value - a location value object.
//Output: e.g. "1 Main St, Toronto, ON, M5V, CA", or null unless something is set.
//Workflow: describeAttioValue - location values.
//---------------------------------------------------------------------------------------------------------
function describeLocation(value: Record<string, unknown>): string | null {
  const parts = ["line_1", "locality", "region", "postcode", "country_code"] //each address field that is set
    .map((key) => stringValue(value[key]))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null; //comma-joined, or null
}
//#endregion

//#region <text helpers>
//---------------------------------------------------------------------------------------------------------
//Base function. Turns an attribute slug into a label, e.g. "phone_numbers" -> "phone numbers".
//Input: slug - the attribute's slug.
//Output: the slug with spaces for underscores.
//Workflow: renderState - each attribute's label.
//
//[LOGIC] Attio's slug is already the label, bar the underscores.
//---------------------------------------------------------------------------------------------------------
function humanizeSlug(slug: string): string {
  return slug.replace(/_/g, " "); //underscores to spaces
}

//---------------------------------------------------------------------------------------------------------
//Base function. Cuts a long value down to MAX_VALUE_CHARS.
//Input: value - the text.
//Output: the text, cut with "..." if too long.
//Workflow: describeAttioValue - keeps each printed value short.
//---------------------------------------------------------------------------------------------------------
function truncate(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}...` : value; //cut if too long
}
//#endregion

//#endregion
//=============================================================================================================
