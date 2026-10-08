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

//imports======================================================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { createNote, type AttioObject, type AttioRecord } from "./attio.js";
import { arrayValue, errorMessage, isJsonObject, numberValue, stringValue, type JsonObject } from "./json.js";
import { attributionOptionTitle, providerDisplayName, type Provider } from "./providers.js";

//=============================================================================================================

//types and globals============================================================================================

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
  readonly id: string;
  readonly name: string;
  /** Values as Attio returned them before the run. Null when the run created the record. */
  readonly before: JsonObject | null;
  /** The record as first seen - the same values as `before`, or the create response for a new one. */
  readonly baseline: JsonObject;
  /** Slug to the value this run wrote, for the slugs Attio accepted. Layered onto `baseline`. */
  readonly applied: Record<string, unknown>;
}

interface RunLogState {
  readonly provider: Provider;
  readonly startedAtMs: number;
  readonly lines: string[];
  readonly records: Map<AttioObject, RunLogRecord>;
}

export interface RunLogArtifact {
  readonly object: AttioObject;
  readonly recordId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly body: string;
}

type MirroredMethod = "log" | "warn" | "error";
type ConsolePrinter = (...parts: unknown[]) => void;

const RUN_LOG = new AsyncLocalStorage<RunLogState>();

//[PERF] Caps, so a pathological run cannot post a note large enough for Attio to reject. Both are far above a
//normal run, which prints on the order of thirty lines.
const MAX_LINES = 500;
const MAX_VALUE_CHARS = 200;

//The order the notes are written in, which is also the order the records were resolved.
const OBJECT_ORDER: readonly AttioObject[] = ["people", "companies", "deals"];

const MIRRORED_METHODS: readonly MirroredMethod[] = ["log", "warn", "error"];
//The prefix a mirrored line carries. console.log is the ordinary case and says nothing; the other two do.
const METHOD_PREFIX: Readonly<Record<MirroredMethod, string>> = { log: "", warn: "WARN ", error: "ERROR " };

let originalPrinters: Record<MirroredMethod, ConsolePrinter> | null = null;
let openScopes = 0;

//=============================================================================================================

//mirror the console===========================================================================================

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

//#region <mirror the console: install and restore>
function installConsoleMirror(): void {
  openScopes += 1;
  if (originalPrinters) return;

  const originals = {} as Record<MirroredMethod, ConsolePrinter>;
  for (const method of MIRRORED_METHODS) {
    const original: ConsolePrinter = console[method];
    originals[method] = original;
    console[method] = (...parts: unknown[]): void => {
      original.apply(console, parts);
      record(method, parts);
    };
  }
  originalPrinters = originals;
}

function restoreConsoleMirror(): void {
  openScopes = Math.max(0, openScopes - 1);
  if (openScopes > 0 || !originalPrinters) return;
  for (const method of MIRRORED_METHODS) console[method] = originalPrinters[method];
  originalPrinters = null;
}
//#endregion

//#region <mirror the console: copy a line into the transcript>
/** [LOGIC] Wall-clock time of day to the millisecond. The date is in the note's own timestamp already. */
function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function record(method: MirroredMethod, parts: readonly unknown[]): void {
  const state = RUN_LOG.getStore();
  if (!state || state.lines.length > MAX_LINES) return;
  if (state.lines.length === MAX_LINES) {
    state.lines.push(`[${stamp()}] ... transcript truncated at ${MAX_LINES} lines`);
    return;
  }
  const text = parts.map((part) => (part instanceof Error ? part.message : String(part))).join(" ");
  state.lines.push(`[${stamp()}] ${METHOD_PREFIX[method]}${text}`);
}
//#endregion

//=============================================================================================================

//record the run===============================================================================================

//#region <record the run: open a run>
//---------------------------------------------------------------------------------------------------------
//Opens a transcript for ONE interested lead and runs the workflow inside it.
//Scoped per lead rather than per invocation on purpose: the Aircall sync records several interested calls in a
//single invocation, and each is a separate set of records owed its own notes.
//The notes are written in the finally, so a run that throws still leaves its transcript on whatever it had
//already resolved - which is the run whose transcript is worth the most.
//USES: installConsoleMirror, restoreConsoleMirror, writeRunLogNotes (this module).
//---------------------------------------------------------------------------------------------------------
export async function withRunLog<T>(provider: Provider, run: () => Promise<T>): Promise<T> {
  const state: RunLogState = { provider, startedAtMs: Date.now(), lines: [], records: new Map() };
  installConsoleMirror();
  try {
    return await RUN_LOG.run(state, async () => {
      try {
        return await run();
      } finally {
        await writeRunLogNotes(state);
      }
    });
  } finally {
    restoreConsoleMirror();
  }
}
//#endregion

//#region <record the run: track touched records>
//---------------------------------------------------------------------------------------------------------
//Registers a record the run touched, and takes its "before" picture.
//
//MUST BE CALLED BEFORE THE RECORD IS WRITTEN TO, because `record` is both the previous state and the baseline
//the writes are layered onto. `existed` is what separates the two: a record the run created has no previous
//state to report, but its create response is still the baseline.
//Registering twice is ignored - the first call is the one that saw the record untouched.
//Outside a run this does nothing, which is what keeps the touchpoint crons out of the feature.
//---------------------------------------------------------------------------------------------------------
export function runLogRecord(object: AttioObject, source: AttioRecord, existed: boolean, name: string): void {
  const state = RUN_LOG.getStore();
  if (!state || state.records.has(object)) return;
  state.records.set(object, {
    id: source.id.record_id,
    name,
    before: existed ? source.rawValues : null,
    baseline: source.rawValues,
    applied: {},
  });
}

/**
 * [LOGIC] What a write actually changed. `candidate` is every value offered and `written` the slugs Attio
 * accepted, so the two together are what the record now holds that it did not before - which is precisely what
 * makes a read-back unnecessary. A write to a record nobody registered, or one for a different record, is
 * ignored rather than guessed at.
 */
export function runLogApplied(
  object: AttioObject,
  recordId: string,
  candidate: Readonly<Record<string, unknown>>,
  written: readonly string[],
): void {
  const target = RUN_LOG.getStore()?.records.get(object);
  if (!target || target.id !== recordId) return;
  for (const slug of written) {
    if (slug in candidate) target.applied[slug] = candidate[slug];
  }
}
//#endregion

//=============================================================================================================

//write the transcript=========================================================================================

//#region <write the transcript: post the notes>
//---------------------------------------------------------------------------------------------------------
//Posts the transcript to every record the run touched. Called once, by withRunLog.
//
//[STABILITY] Each note is written independently and swallows its own failure. They are the last writes of an
//event Attio has already committed, so one refused note may not cost the others, and none of them may reach
//the caller. A failure is reported to the log and nothing more.
//[DEBUG] A run that ends before any record is resolved says so rather than passing silently - a missing note
//is otherwise indistinguishable from a run that never happened.
//USES: createNote (lib/attio.ts); runLogArtifacts (this module); providerDisplayName (lib/providers.ts).
//---------------------------------------------------------------------------------------------------------
async function writeRunLogNotes(state: RunLogState): Promise<void> {
  const artifacts = runLogArtifacts();
  if (artifacts.length === 0) {
    console.warn(
      `[run-log] ${state.provider}: no transcript written - the run ended before any record was resolved, so there is nothing to attach it to`,
    );
    return;
  }

  const title = `run logs for automated integration (${providerDisplayName(state.provider)} marked as interested)`;
  for (const artifact of artifacts) {
    try {
      const name = state.records.get(artifact.object)?.name ?? artifact.recordId;
      await createNote(artifact.object, artifact.recordId, title, artifact.body, name);
    } catch (error) {
      console.error(
        `[run-log] ${state.provider}: the ${artifact.object} transcript could not be posted - ${errorMessage(error)}`,
      );
    }
  }
}
//#endregion

//#region <write the transcript: build one file per record>
//---------------------------------------------------------------------------------------------------------
//The transcript as one file per record touched, built in memory.
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
//USES: renderState, afterValues, referenceNames (this module).
//---------------------------------------------------------------------------------------------------------
export function runLogArtifacts(): readonly RunLogArtifact[] {
  const state = RUN_LOG.getStore();
  if (!state) return [];

  const names = referenceNames(state);
  const transcript = state.lines.length > 0 ? state.lines.join("\n") : "none";
  const startedAt = new Date(state.startedAtMs).toISOString().replace(/[:.]/g, "-");

  const artifacts: RunLogArtifact[] = [];
  for (const object of OBJECT_ORDER) {
    const target = state.records.get(object);
    if (!target) continue;
    artifacts.push({
      object,
      recordId: target.id,
      filename: `run-log-${state.provider}-${object}-${target.id}-${startedAt}.txt`,
      contentType: "text/plain; charset=utf-8",
      body: [
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
  return artifacts;
}

/** [LOGIC] Every record the run touched, so a reference between them prints as a name rather than an id. */
function referenceNames(state: RunLogState): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const target of state.records.values()) names.set(target.id, target.name);
  return names;
}
//#endregion

//=============================================================================================================

//describe record values=======================================================================================

//#region <describe record values: whole record>
//---------------------------------------------------------------------------------------------------------
//Every attribute the record actually holds, one per line, in the order Attio returned them.
//Attributes holding nothing are omitted rather than printed empty: the point of the two states is what
//CHANGED, and a hundred blank slugs on either side buries it.
//USES: arrayValue (lib/json.ts); describeAttioValue, humanizeSlug (this module).
//---------------------------------------------------------------------------------------------------------
function renderState(values: JsonObject | null, names: ReadonlyMap<string, string>): string {
  if (!values) return "none";
  const lines: string[] = [];
  for (const slug of Object.keys(values)) {
    const entries = arrayValue(values, slug);
    const rendered = entries
      .map((entry) => describeAttioValue(entry, names))
      .filter((value): value is string => value !== null && value.length > 0);
    if (rendered.length > 0) lines.push(`${humanizeSlug(slug)}: ${rendered.join(", ")}`);
  }
  return lines.length > 0 ? lines.join("\n") : "none";
}

/**
 * [LOGIC] The state the run left behind: what the record held when first seen, with everything the run wrote
 * laid over the top. A written value arrives in the shape it was SENT - a bare string, an object, or an
 * already-merged array - so a lone value is wrapped to match the array Attio would have returned it in.
 */
function afterValues(target: RunLogRecord): JsonObject {
  const after: JsonObject = { ...target.baseline };
  for (const [slug, value] of Object.entries(target.applied)) {
    after[slug] = Array.isArray(value) ? value : [value];
  }
  return after;
}
//#endregion

//#region <describe record values: single values>
//---------------------------------------------------------------------------------------------------------
//One Attio value as a human would read it.
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
//USES: stringValue, numberValue, isJsonObject (lib/json.ts); optionTitle, describeLocation, truncate (this module).
//---------------------------------------------------------------------------------------------------------
function describeAttioValue(entry: unknown, names: ReadonlyMap<string, string>): string | null {
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") return truncate(String(entry));
  if (!isJsonObject(entry)) return null;

  const named =
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
  if (named) return truncate(named);

  const location = describeLocation(entry);
  if (location) return truncate(location);

  const currency = numberValue(entry.currency_value);
  if (currency !== null) {
    const code = stringValue(entry.currency_code);
    return code ? `${currency} ${code}` : String(currency);
  }

  const reference = stringValue(entry.target_record_id) ?? stringValue(entry.referenced_actor_id);
  if (reference) return names.get(reference) ?? reference;

  const scalar = entry.value;
  if (typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean") {
    return truncate(String(scalar));
  }
  return truncate(JSON.stringify(entry));
}

//---------------------------------------------------------------------------------------------------------
//[LOGIC] The readable half of a select or status.
//Two shapes reach here, because the transcript renders both sides of a change. A value Attio RETURNED nests
//its title one level down - `{ option: { id, title } }` - while a value this run WROTE names the option
//directly, and names it by ID: `{ option: "4dca8bb3-..." }`. Rendering only the first left the "after" half of
//an attribution line as a raw JSON blob beside the "before" half's plain English.
//A written option that is not one of ours is printed as sent, which is the title for any select written by
//title elsewhere.
//USES: attributionOptionTitle (lib/providers.ts); isJsonObject, stringValue (lib/json.ts). Pure.
//---------------------------------------------------------------------------------------------------------
function optionTitle(value: unknown): string | null {
  if (isJsonObject(value)) return stringValue(value.title);
  const written = stringValue(value);
  if (!written) return null;
  return attributionOptionTitle(written) ?? written;
}

/** [LOGIC] A structured location, in the order it would be written on an envelope. Null unless something is set. */
function describeLocation(value: Record<string, unknown>): string | null {
  const parts = ["line_1", "locality", "region", "postcode", "country_code"]
    .map((key) => stringValue(value[key]))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}
//#endregion

//#region <describe record values: text helpers>
/** [LOGIC] `phone_numbers` reads as "phone numbers". Attio's slug is already the label, bar the underscores. */
function humanizeSlug(slug: string): string {
  return slug.replace(/_/g, " ");
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}...` : value;
}
//#endregion

//=============================================================================================================
