//=============================================================================================================
//#region <import statements>

import { optionalEnv, reportConfigValue, requiredEnv } from "./env.js"; //env readers and config logging

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

export const ATTIO_BASE = "https://api.attio.com/v2"; //attio api root
export const AIRCALL_BASE = "https://api.aircall.io/v1"; //aircall api root
export const INSTANTLY_BASE = "https://api.instantly.ai/api/v2"; //instantly api root
export const HEYREACH_BASE = "https://api.heyreach.io/api/public"; //heyreach api root
//Outfound is a private, undocumented-in-public API. The spec it is written against is served by the deployment
//itself, at https://api.outfound.io/openapi-client.json (rendered at /scalar/client?org=sas).
export const OUTFOUND_BASE = "https://api.outfound.io"; //outfound api root

//Which env variables hold each service's credentials, named in the hint when a key is rejected.
const CREDENTIAL_ENV_NAMES = { //service -> its credential variable names
  attio: ["ATTIO_API_KEY"], //attio's key
  aircall: ["AIRCALL_API_ID", "AIRCALL_API_TOKEN"], //aircall's id and token
  instantly: ["INSTANTLY_API_KEY"], //instantly's key
  heyreach: ["HEYREACH_API_KEY"], //heyreach's key
  outfound: ["OUTFOUND_API_KEY"], //outfound's key
  supabase: ["SUPABASE_URL", "SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY)"], //supabase url and key
} as const;

//One service name from CREDENTIAL_ENV_NAMES, e.g. "aircall".
export type CredentialScope = keyof typeof CREDENTIAL_ENV_NAMES; //the keys, as a type

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <find service urls>

//#region <supabase>
//---------------------------------------------------------------------------------------------------------
//Reads the Supabase project URL from env.
//Input: none.
//Output: the URL. Throws if SUPABASE_URL is not set.
//Uses: requiredEnv, reportConfigValue (lib/env.ts).
//Workflow: cursorEndpoint (lib/cursors.ts) - every sync cursor read and save.
//---------------------------------------------------------------------------------------------------------
export function supabaseBaseUrl(): string {
  const url = requiredEnv("SUPABASE_URL"); //the project url
  reportConfigValue("SUPABASE_URL", url); //log it once, not secret
  return url; //the url
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <build request headers>

//#region <keys read from env at call time, never hardcoded>
//---------------------------------------------------------------------------------------------------------
//Builds the headers for an Attio request.
//Input: none.
//Output: the auth and content-type headers. Throws if ATTIO_API_KEY is not set.
//Uses: requiredEnv (lib/env.ts).
//Workflow: attioFetch (lib/attio.ts) - every Attio request.
//---------------------------------------------------------------------------------------------------------
export function attioHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${requiredEnv("ATTIO_API_KEY")}`, //the api key
    "Content-Type": "application/json", //we send json
  };
}

//---------------------------------------------------------------------------------------------------------
//Builds Aircall's Basic auth header value.
//Input: none.
//Output: "Basic <base64 of id:token>". Throws if either env variable is not set.
//Uses: requiredEnv (lib/env.ts).
//Workflow: aircallFetch (lib/aircall.ts) - every Aircall request.
//---------------------------------------------------------------------------------------------------------
export function aircallAuthHeader(): string {
  const credentials = `${requiredEnv("AIRCALL_API_ID")}:${requiredEnv("AIRCALL_API_TOKEN")}`; //"id:token"
  return `Basic ${Buffer.from(credentials).toString("base64")}`; //base64-encode it, add "Basic "
}

//---------------------------------------------------------------------------------------------------------
//Builds Instantly's Bearer auth header value.
//Input: none.
//Output: "Bearer <key>". Throws if INSTANTLY_API_KEY is not set.
//Uses: requiredEnv (lib/env.ts).
//Workflow: instantlyFetch (lib/instantly.ts) - every Instantly request.
//---------------------------------------------------------------------------------------------------------
export function instantlyAuthHeader(): string {
  return `Bearer ${requiredEnv("INSTANTLY_API_KEY")}`; //the api key
}

//---------------------------------------------------------------------------------------------------------
//Builds Outfound's Bearer auth header value.
//Input: none.
//Output: "Bearer <key>". Throws if OUTFOUND_API_KEY is not set.
//Uses: requiredEnv (lib/env.ts).
//Workflow: outfoundFetch (lib/outfound.ts) - every Outfound request.
//---------------------------------------------------------------------------------------------------------
export function outfoundAuthHeader(): string {
  return `Bearer ${requiredEnv("OUTFOUND_API_KEY")}`; //the api key
}

//---------------------------------------------------------------------------------------------------------
//Builds the headers for a HeyReach request.
//Input: none.
//Output: the api-key, content-type and accept headers. Throws if HEYREACH_API_KEY is not set.
//Uses: requiredEnv (lib/env.ts).
//Workflow: heyreachFetch (lib/heyreach.ts) - every HeyReach request.
//---------------------------------------------------------------------------------------------------------
export function heyreachHeaders(): HeadersInit {
  return {
    "X-API-KEY": requiredEnv("HEYREACH_API_KEY"), //the api key
    "Content-Type": "application/json", //we send json
    Accept: "application/json", //we want json back
  };
}

//---------------------------------------------------------------------------------------------------------
//Builds the headers for a Supabase request, using the new secret key or the legacy one.
//Input: none.
//Output: the apikey and content-type headers, plus Authorization for a legacy key. Throws if neither key is set.
//Uses: optionalEnv, requiredEnv, reportConfigValue (lib/env.ts).
//Workflow: getSyncCursor and saveSyncCursor (lib/cursors.ts) - every sync cursor read and save.
//---------------------------------------------------------------------------------------------------------
export function supabaseHeaders(): HeadersInit {
  const modern = optionalEnv("SUPABASE_SECRET_KEY"); //the new-style key, if set
  const key = modern ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY"); //else the legacy key, required
  reportConfigValue( //log which key is in use, once
    "SUPABASE key source",
    modern ? "SUPABASE_SECRET_KEY" : "SUPABASE_SERVICE_ROLE_KEY (legacy)",
  );
  const headers: Record<string, string> = { //headers every request sends
    apikey: key, //the chosen key
    "Content-Type": "application/json", //we send json
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`; //legacy JWT key also goes as Bearer
  return headers; //the finished headers
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <explain rejected credentials>

//A provider can only tell us a key is wrong by rejecting the request, so translate its 401/403 into the name of
//the environment variable that has to change. Anything else is a data or permission problem, not a credential.

//#region <env variable hints>
//---------------------------------------------------------------------------------------------------------
//Base function. Names the env variables to check when a service rejects our credentials.
//Input: scope - which service; status - the HTTP status it answered.
//Output: " - <service> rejected the credential, check <names>" on a 401/403, else "". Logs a warning on 401/403.
//Workflow: every Attio, Aircall, Instantly, HeyReach, Outfound and Supabase request's error message.
//
//Returns "" for statuses that are not about credentials, so it can be appended to any error message
//unconditionally.
//---------------------------------------------------------------------------------------------------------
export function credentialHint(scope: CredentialScope, status: number): string {
  if (status !== 401 && status !== 403) return ""; //not a credential problem
  const names = CREDENTIAL_ENV_NAMES[scope].join(" and "); //this service's variable names
  console.warn( //log which variables to check
    `[credential] ${scope} rejected our request with ${status} - the key is missing, wrong, or lacks scope. Check ${names}.`,
  );
  return ` - ${scope} rejected the credential, check ${names}`; //text to append to the error
}
//#endregion

//#endregion
//=============================================================================================================
