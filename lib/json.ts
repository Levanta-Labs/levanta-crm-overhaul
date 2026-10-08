/*
script purpose




*/

//=============================================================================================================
//#region <types and globals>

export type JsonObject = Record<string, unknown>; //an object with string keys, unknown value type
//type any //do whatever you want, disables type constraints
//ype unknown //type checking is enabled but type is unknown, is one from set of all possible values in ts, can check type using logic for operations
//type 

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read unknown json values>

//#region <type guards>
//---------------------------------------------------------------------------------------------------------
//Base function. Checks whether a value is a plain JSON object (not null, not an array).
//Input: value - anything.
//Output: true if it is an object; TypeScript then treats it as a JsonObject.
//Workflow: every JSON read in the codebase - provider responses and webhook bodies are checked with it first.
//---------------------------------------------------------------------------------------------------------
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value); //object, not null, not a list
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads a value as text.
//Input: value - anything.
//Output: the string, or null if it is not a string or is empty.
//Workflow: every text field read from a provider response or webhook body.
//---------------------------------------------------------------------------------------------------------
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null; //non-empty text, else null
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads a value as a number.
//Input: value - anything.
//Output: the number, or null if it is not a real, finite number.
//Workflow: numeric fields from Aircall, Attio and HeyReach responses (ids, timestamps, durations, counts).
//---------------------------------------------------------------------------------------------------------
export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null; //real number, else null
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads a value as true/false.
//Input: value - anything.
//Output: the boolean, or null if it is not one.
//Workflow: HeyReach paging (lib/heyreach.ts) - reads hasNextPage.
//---------------------------------------------------------------------------------------------------------
export function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null; //true/false, else null
}

//---------------------------------------------------------------------------------------------------------
//Reads a child object from a parent object.
//Input: parent - a JSON object; key - the field name.
//Output: the child object, or null if the field is missing or not an object.
//Uses: isJsonObject (this file).
//Workflow: nested objects in provider responses and webhook bodies, e.g. Aircall's paging "meta".
//---------------------------------------------------------------------------------------------------------
export function objectValue(parent: JsonObject, key: string): JsonObject | null {
  const value = parent[key]; //the field's value
  return isJsonObject(value) ? value : null; //object, else null
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads a list from a parent object.
//Input: parent - a JSON object; key - the field name.
//Output: the list, or an empty list if the field is missing or not a list.
//Workflow: every list read from a provider response - calls, contacts, records, pages.
//---------------------------------------------------------------------------------------------------------
export function arrayValue(parent: JsonObject, key: string): readonly unknown[] {
  const value = parent[key]; //the field's value
  return Array.isArray(value) ? value : []; //list, else empty list
}
//#endregion

//#region <describe a payload shape>
//---------------------------------------------------------------------------------------------------------
//Describes the key structure of an unknown payload, with types but no values.
//Input: value - the payload; depth - object levels to show (default 2); budget - total steps allowed (default 8).
//Output: text like "{ event: string, lead: { email: string } }".
//Uses: isJsonObject, describeShape (this file - it calls itself for each child).
//Workflow: the HeyReach and Outfound interested routes - logs an unrecognised webhook's shape.
//
//So an unrecognised webhook shape can be mapped from a log line without recording anybody's name, address, or
//message text.
//---------------------------------------------------------------------------------------------------------
export function describeShape(value: unknown, depth = 2, budget = 8): string {
  //An array is a container rather than a level of nesting, so it does not spend `depth` - a payload that wraps the
  //interesting object in a list should still show that object's keys. `budget` always decrements, which bounds the
  //recursion for untrusted input however it is nested.
  if (budget <= 0) return "..."; //out of steps, stop here
  if (Array.isArray(value)) { //a list
    return value.length === 0 ? "[]" : `[${describeShape(value[0], depth, budget - 1)}]`; //describe its first item only
  }
  if (isJsonObject(value)) { //an object
    const keys = Object.keys(value); //its field names
    if (keys.length === 0) return "{}"; //empty object
    if (depth <= 0) return `{${keys.length} key(s)}`; //too deep: just count the keys
    return `{ ${keys.map((key) => `${key}: ${describeShape(value[key], depth - 1, budget - 1)}`).join(", ")} }`; //each key with its child's shape
  }
  if (value === null) return "null"; //null gets its own label
  return typeof value; //"string", "number", etc.
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read responses and errors>

//#region <error messages>
//---------------------------------------------------------------------------------------------------------
//Base function. Gets a readable message from anything that was thrown.
//Input: error - whatever a catch received.
//Output: the error's message, or "Unknown error" if it is not an Error.
//Workflow: every catch that logs or returns a failure - routes, cron syncs, serverError, suppression.
//---------------------------------------------------------------------------------------------------------
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"; //message if it is an Error
}
//#endregion

//#region <response bodies>
//---------------------------------------------------------------------------------------------------------
//Base function. Reads an HTTP response body as JSON.
//Input: response - a fetch response.
//Output: the parsed body, or null when it is empty. Throws if the body is not JSON.
//Workflow: every Attio, Aircall, Instantly, HeyReach, Outfound and Supabase request reads its reply here.
//---------------------------------------------------------------------------------------------------------
export async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text(); //the raw body text
  if (!text) return null; //empty body, nothing to parse
  try {
    return JSON.parse(text) as unknown; //parse it as json
  } catch {
    throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`); //not json: show its start
  }
}
//#endregion

//#endregion
//=============================================================================================================
