//=============================================================================================================
//#region <import statements>

import { optionalEnv, reportConfigValue, requiredEnv } from "./env.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

export const ATTIO_BASE = "https://api.attio.com/v2";
export const AIRCALL_BASE = "https://api.aircall.io/v1";
export const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
export const HEYREACH_BASE = "https://api.heyreach.io/api/public";
//Outfound is a private, undocumented-in-public API. The spec it is written against is served by the deployment
//itself, at https://api.outfound.io/openapi-client.json (rendered at /scalar/client?org=sas).
export const OUTFOUND_BASE = "https://api.outfound.io";

const CREDENTIAL_ENV_NAMES = {
  attio: ["ATTIO_API_KEY"],
  aircall: ["AIRCALL_API_ID", "AIRCALL_API_TOKEN"],
  instantly: ["INSTANTLY_API_KEY"],
  heyreach: ["HEYREACH_API_KEY"],
  outfound: ["OUTFOUND_API_KEY"],
  supabase: ["SUPABASE_URL", "SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY)"],
} as const;

export type CredentialScope = keyof typeof CREDENTIAL_ENV_NAMES;

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <find service urls>

//#region <supabase>
export function supabaseBaseUrl(): string {
  const url = requiredEnv("SUPABASE_URL");
  reportConfigValue("SUPABASE_URL", url);
  return url;
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <build request headers>

//#region <keys read from env at call time, never hardcoded>
export function attioHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${requiredEnv("ATTIO_API_KEY")}`,
    "Content-Type": "application/json",
  };
}

export function aircallAuthHeader(): string {
  const credentials = `${requiredEnv("AIRCALL_API_ID")}:${requiredEnv("AIRCALL_API_TOKEN")}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

export function instantlyAuthHeader(): string {
  return `Bearer ${requiredEnv("INSTANTLY_API_KEY")}`;
}

export function outfoundAuthHeader(): string {
  return `Bearer ${requiredEnv("OUTFOUND_API_KEY")}`;
}

export function heyreachHeaders(): HeadersInit {
  return {
    "X-API-KEY": requiredEnv("HEYREACH_API_KEY"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export function supabaseHeaders(): HeadersInit {
  const modern = optionalEnv("SUPABASE_SECRET_KEY");
  const key = modern ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  reportConfigValue(
    "SUPABASE key source",
    modern ? "SUPABASE_SECRET_KEY" : "SUPABASE_SERVICE_ROLE_KEY (legacy)",
  );
  const headers: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <explain rejected credentials>

//A provider can only tell us a key is wrong by rejecting the request, so translate its 401/403 into the name of
//the environment variable that has to change. Anything else is a data or permission problem, not a credential.

//#region <env variable hints>
/**
 * Logs and returns a pointer to the environment variables behind a rejected request. Returns "" for statuses that
 * are not about credentials, so it can be appended to any error message unconditionally.
 */
export function credentialHint(scope: CredentialScope, status: number): string {
  if (status !== 401 && status !== 403) return "";
  const names = CREDENTIAL_ENV_NAMES[scope].join(" and ");
  console.warn(
    `[credential] ${scope} rejected our request with ${status} - the key is missing, wrong, or lacks scope. Check ${names}.`,
  );
  return ` - ${scope} rejected the credential, check ${names}`;
}
//#endregion

//#endregion
//=============================================================================================================
