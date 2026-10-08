//=============================================================================================================
//#region <import statements>

import { optionalEnv } from "./env.js";
import { errorMessage } from "./json.js";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

const BEARER = "Bearer ";

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read requests and send responses>

//#region <json bodies>
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function requestJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}
//#endregion

//#region <errors>
/** [DEBUG] Terminal catch for every route. Logs the raw error, returns only its message to the caller. */
export function serverError(label: string, error: unknown): Response {
  console.error(label, error);
  return json({ error: errorMessage(error) }, 500);
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <wait out rate limits>

//Waiting out a rate limit, shared by every provider transport.
//
//WHY IT LIVES HERE. Attio, Instantly, HeyReach and Aircall all answer 429 and all have to decide how long to
//wait. Four copies of the same header parsing would drift - the codebase has been bitten by exactly that
//before, when isTransientAttioError was written for all four syncs and wired into one. One implementation,
//four callers, so a fix to the parsing reaches all of them.
//
//NEITHER HEYREACH NOR AIRCALL SENDS ANY RATE-LIMIT HEADER ON A SUCCESSFUL RESPONSE - both were probed live and
//answered 200 with nothing matching rate/limit/remaining/reset/retry. So there is no allowance to read ahead
//of time and no way to pace proactively; a transport can only react to the refusal when it arrives. That is
//why these two get a retry rather than a self-imposed cap like INSTANTLY_SYNC_PAGE_LIMIT, which exists only
//because Instantly's 20-per-minute ceiling is documented as a hard number.

//#region <wait times>
/** A `Retry-After` in ms, when one is sent. Seconds or an HTTP date; anything else is ignored. */
export function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

//---------------------------------------------------------------------------------------------------------
//How long to wait before attempt `attempt` + 1, given what the response said.
//`hintMs` is a provider-specific reading of its own reset header, tried after Retry-After and before the
//backoff. Doubling per attempt: baseMs, 2x, 4x.
//[STABILITY] Capped at `maxMs`. A provider that answers with a reset a full minute out would otherwise park a
//run for the whole of it, and a sync that spends its budget asleep has done nothing - stopping and resuming
//next run is strictly better than waiting, because the next run starts with a fresh allowance either way.
//---------------------------------------------------------------------------------------------------------
export function rateLimitWaitMs(
  response: Response,
  attempt: number,
  baseMs: number,
  maxMs: number,
  hintMs: number | null = null,
): number {
  const stated = retryAfterMs(response) ?? hintMs;
  const wait = stated ?? baseMs * 2 ** (attempt - 1);
  return Math.min(Math.max(0, wait), maxMs);
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <verify shared secrets>

//Shared-secret verification. Both sides of the comparison are in this process, so a rejection can say exactly
//why it failed. The secrets themselves are never logged - only their length and how the two values diverge.

//#region <route gates>
//---------------------------------------------------------------------------------------------------------
//[SECURITY] Gate on all three cron routes. Called first in every GET, before any external request.
//FLOW: 1. no CRON_SECRET configured -> reject; nothing can be verified. 2. no authorization header -> reject.
//3. not "Bearer <secret>" -> reject. 4. otherwise compare against the configured value.
//Each branch is distinct because the four failures need different fixes, and a bare 401 names none of them.
//[DEBUG] Rejections log the reason and how the two values diverge - never either value.
//---------------------------------------------------------------------------------------------------------
export function isAuthorizedCron(request: Request): boolean {
  const secret = optionalEnv("CRON_SECRET");
  if (secret === null) {
    console.warn(
      "[auth] cron: rejected - CRON_SECRET is not configured on this deployment, so no request can be verified. Vercel only attaches the authorization header once CRON_SECRET exists in the project's environment variables, and a redeploy is required after adding it.",
    );
    return false;
  }
  const header = request.headers.get("authorization");
  if (header === null) {
    console.warn(
      `[auth] cron: rejected - the request carried no authorization header, though CRON_SECRET is configured (${secret.length} chars). A non-Vercel caller must send it explicitly.`,
    );
    return false;
  }
  if (!header.startsWith(BEARER)) {
    console.warn(
      `[auth] cron: rejected - the authorization header is not in "Bearer <secret>" form, which is how Vercel sends CRON_SECRET`,
    );
    return false;
  }
  return verifySecret("cron", "CRON_SECRET", "the authorization header", header.slice(BEARER.length), secret);
}

/**
 * [SECURITY] Gate on the Instantly and HeyReach webhook routes. Both providers send a shared value in a custom
 * x-webhook-secret header. Called before the request body is read, so an unauthenticated caller never reaches
 * a parser. Same three rejection branches as isAuthorizedCron, for the same diagnostic reason.
 */
export function hasWebhookSecret(request: Request, envName: string): boolean {
  const secret = optionalEnv(envName);
  if (secret === null) {
    console.warn(
      `[auth] ${envName}: rejected - ${envName} is not configured on this deployment, so no webhook can be verified. Add it in Vercel and configure the sender to send the same value.`,
    );
    return false;
  }
  const header = request.headers.get("x-webhook-secret");
  if (header === null) {
    console.warn(
      `[auth] ${envName}: rejected - the request carried no x-webhook-secret header, though ${envName} is configured (${secret.length} chars). Check the sender's custom-header configuration.`,
    );
    return false;
  }
  return verifySecret(envName, envName, "the x-webhook-secret header", header, secret);
}

/**
 * [SECURITY] Gate on webhooks that carry their secret inside the JSON body rather than a header - Aircall puts
 * it in a `token` field. Same rejection branches as hasWebhookSecret, for the same diagnostic reason.
 */
export function hasBodyToken(presented: string | null, envName: string): boolean {
  const secret = optionalEnv(envName); //the configured token, or null
  if (secret === null) {
    console.warn(
      `[auth] ${envName}: rejected - ${envName} is not configured on this deployment, so no webhook can be verified.`,
    ); //nothing to compare against
    return false;
  }
  if (presented === null) {
    console.warn(
      `[auth] ${envName}: rejected - the body carried no token field, though ${envName} is configured (${secret.length} chars).`,
    ); //request had no token
    return false;
  }
  return verifySecret(envName, envName, "the body's token field", presented, secret); //compare, log the result
}
//#endregion

//#region <compare values>
function describeMismatch(presented: string, expected: string): string {
  if (presented.trim() === expected.trim()) return "they differ only by surrounding whitespace";
  if (presented.toLowerCase() === expected.toLowerCase()) return "they differ only by letter case";
  if (presented.length !== expected.length) {
    return `the request sent ${presented.length} chars, the variable holds ${expected.length}`;
  }
  return `both are ${expected.length} chars but the contents differ`;
}

/** Compares an already-extracted credential against a configured secret, logging the precise reason on failure. */
function verifySecret(
  label: string,
  envName: string,
  headerName: string,
  presented: string,
  expected: string,
): boolean {
  if (presented === expected) {
    console.log(`[auth] ${label}: authorized`);
    return true;
  }
  console.warn(
    `[auth] ${label}: rejected - ${headerName} did not match ${envName} (${describeMismatch(presented, expected)})`,
  );
  return false;
}
//#endregion

//#endregion
//=============================================================================================================
