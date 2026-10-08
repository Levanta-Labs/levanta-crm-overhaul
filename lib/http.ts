//=============================================================================================================
//#region <import statements>

import { optionalEnv } from "./env.js"; //read an env variable, null if missing
import { errorMessage } from "./json.js"; //readable message from any error

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//The prefix on a cron request's authorization header.
const BEARER = "Bearer "; //text before the secret

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read requests and send responses>

//#region <json bodies>
//---------------------------------------------------------------------------------------------------------
//Base function. Builds a JSON HTTP response.
//Input: data - what to send back; status - the HTTP status code (default 200).
//Output: the Response.
//Workflow: every route's reply - the four interested webhooks and the four cron syncs - plus serverError.
//---------------------------------------------------------------------------------------------------------
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status }); //data as json with that status
}

//---------------------------------------------------------------------------------------------------------
//Base function. Reads an incoming request's body as JSON.
//Input: request - the incoming HTTP request.
//Output: the parsed body. Throws if it is not valid JSON.
//Workflow: the four interested webhook routes - reads the webhook payload after the auth check.
//---------------------------------------------------------------------------------------------------------
export async function requestJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown; //parse the body
  } catch {
    throw new Error("Request body must be valid JSON"); //bad body: clear message
  }
}
//#endregion

//#region <errors>
//---------------------------------------------------------------------------------------------------------
//Logs an error and turns it into a 500 response.
//Input: label - log prefix naming the route; error - whatever was thrown.
//Output: a 500 response carrying { error: message }.
//Uses: json (this file); errorMessage (lib/json.ts).
//Workflow: the final catch of every route - the four interested webhooks and the four cron syncs.
//
//[DEBUG] Logs the raw error, returns only its message to the caller.
//---------------------------------------------------------------------------------------------------------
export function serverError(label: string, error: unknown): Response {
  console.error(label, error); //full error to the logs
  return json({ error: errorMessage(error) }, 500); //only the message to the caller
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
//---------------------------------------------------------------------------------------------------------
//Base function. Reads the standard Retry-After header.
//Input: response - a refused (usually 429) response.
//Output: milliseconds to wait, or null when there is no usable header.
//Workflow: attioFetch (lib/attio.ts) and rateLimitWaitMs - the first wait hint tried after a 429.
//
//Accepts seconds or an HTTP date; anything else is ignored.
//---------------------------------------------------------------------------------------------------------
export function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after"); //the header text, if sent
  if (!header) return null; //no hint given
  const seconds = Number(header); //try it as a number of seconds
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000; //seconds -> milliseconds
  const date = Date.parse(header); //else try it as a date
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null; //time until that date, or null
}

//---------------------------------------------------------------------------------------------------------
//Decides how long to wait before the next try after a 429.
//Input: response - the refused response; attempt - which try just failed (1, 2, ...); baseMs - first backoff
//wait; maxMs - the longest wait allowed; hintMs - the provider's own reset reading, or null.
//Output: milliseconds to wait, between 0 and maxMs.
//Uses: retryAfterMs (this file).
//Workflow: aircallFetch (lib/aircall.ts) and heyreachFetch (lib/heyreach.ts) - the wait between 429 retries.
//
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
  const stated = retryAfterMs(response) ?? hintMs; //what the provider said, if anything
  const wait = stated ?? baseMs * 2 ** (attempt - 1); //else double the wait each attempt
  return Math.min(Math.max(0, wait), maxMs); //keep it between 0 and maxMs
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
//Checks a cron request carries "Bearer <CRON_SECRET>".
//Input: request - the incoming cron request.
//Output: true if authorized; false (with a logged reason) otherwise.
//Uses: verifySecret (this file); optionalEnv (lib/env.ts).
//Workflow: every cron sync route's auth check (aircall, instantly, heyreach, outfound) - called first in every
//GET, before any external request.
//
//[SECURITY] Each branch is distinct because the four failures need different fixes, and a bare 401 names none
//of them.
//[DEBUG] Rejections log the reason and how the two values diverge - never either value.
//---------------------------------------------------------------------------------------------------------
export function isAuthorizedCron(request: Request): boolean {
  const secret = optionalEnv("CRON_SECRET"); //the configured secret, or null
  if (secret === null) { //nothing to compare against
    console.warn( //explain how to configure it
      "[auth] cron: rejected - CRON_SECRET is not configured on this deployment, so no request can be verified. Vercel only attaches the authorization header once CRON_SECRET exists in the project's environment variables, and a redeploy is required after adding it.",
    );
    return false; //reject
  }
  const header = request.headers.get("authorization"); //the request's auth header
  if (header === null) { //request sent no header
    console.warn( //say the header is missing
      `[auth] cron: rejected - the request carried no authorization header, though CRON_SECRET is configured (${secret.length} chars). A non-Vercel caller must send it explicitly.`,
    );
    return false; //reject
  }
  if (!header.startsWith(BEARER)) { //wrong format
    console.warn( //say the format is wrong
      `[auth] cron: rejected - the authorization header is not in "Bearer <secret>" form, which is how Vercel sends CRON_SECRET`,
    );
    return false; //reject
  }
  return verifySecret("cron", "CRON_SECRET", "the authorization header", header.slice(BEARER.length), secret); //compare the part after "Bearer "
}

//---------------------------------------------------------------------------------------------------------
//Checks a webhook's x-webhook-secret header matches the configured secret.
//Input: request - the incoming webhook; envName - the env variable holding the expected secret.
//Output: true if authorized; false (with a logged reason) otherwise.
//Uses: verifySecret (this file); optionalEnv (lib/env.ts).
//Workflow: the Instantly, HeyReach and Outfound interested routes' auth check.
//
//[SECURITY] Both providers send a shared value in a custom x-webhook-secret header. Called before the request
//body is read, so an unauthenticated caller never reaches a parser. Same three rejection branches as
//isAuthorizedCron, for the same diagnostic reason.
//---------------------------------------------------------------------------------------------------------
export function hasWebhookSecret(request: Request, envName: string): boolean {
  const secret = optionalEnv(envName); //the configured secret, or null
  if (secret === null) { //nothing to compare against
    console.warn( //explain how to configure it
      `[auth] ${envName}: rejected - ${envName} is not configured on this deployment, so no webhook can be verified. Add it in Vercel and configure the sender to send the same value.`,
    );
    return false; //reject
  }
  const header = request.headers.get("x-webhook-secret"); //the secret the sender sent
  if (header === null) { //sender sent no header
    console.warn( //say the header is missing
      `[auth] ${envName}: rejected - the request carried no x-webhook-secret header, though ${envName} is configured (${secret.length} chars). Check the sender's custom-header configuration.`,
    );
    return false; //reject
  }
  return verifySecret(envName, envName, "the x-webhook-secret header", header, secret); //compare, log the result
}

//---------------------------------------------------------------------------------------------------------
//Checks a token taken from a webhook's JSON body matches the configured secret.
//Input: presented - the token from the body, or null; envName - the env variable holding the expected token.
//Output: true if authorized; false (with a logged reason) otherwise.
//Uses: verifySecret (this file); optionalEnv (lib/env.ts).
//Workflow: the Aircall interested route's auth check - Aircall puts the secret in a `token` field.
//
//[SECURITY] For webhooks that carry their secret inside the JSON body rather than a header. Same rejection
//branches as hasWebhookSecret, for the same diagnostic reason.
//---------------------------------------------------------------------------------------------------------
export function hasBodyToken(presented: string | null, envName: string): boolean {
  const secret = optionalEnv(envName); //the configured token, or null
  if (secret === null) { //nothing to compare against
    console.warn( //explain it is not configured
      `[auth] ${envName}: rejected - ${envName} is not configured on this deployment, so no webhook can be verified.`,
    ); //nothing to compare against
    return false; //reject
  }
  if (presented === null) { //body had no token
    console.warn( //say the token is missing
      `[auth] ${envName}: rejected - the body carried no token field, though ${envName} is configured (${secret.length} chars).`,
    ); //request had no token
    return false; //reject
  }
  return verifySecret(envName, envName, "the body's token field", presented, secret); //compare, log the result
}
//#endregion

//#region <compare values>
//---------------------------------------------------------------------------------------------------------
//Base function. Says how two non-matching secrets differ, without revealing either.
//Input: presented - what the request sent; expected - the configured value.
//Output: a short reason, e.g. "they differ only by letter case".
//Workflow: verifySecret - the reason in a rejection log line.
//---------------------------------------------------------------------------------------------------------
function describeMismatch(presented: string, expected: string): string {
  if (presented.trim() === expected.trim()) return "they differ only by surrounding whitespace"; //only spaces differ
  if (presented.toLowerCase() === expected.toLowerCase()) return "they differ only by letter case"; //only case differs
  if (presented.length !== expected.length) { //different lengths
    return `the request sent ${presented.length} chars, the variable holds ${expected.length}`; //give both lengths
  }
  return `both are ${expected.length} chars but the contents differ`; //same length, different content
}

//---------------------------------------------------------------------------------------------------------
//Compares an already-extracted credential against a configured secret, logging the result.
//Input: label - log prefix; envName - the variable's name; headerName - where the credential came from;
//presented - what the request sent; expected - the configured secret.
//Output: true if they match exactly, else false.
//Uses: describeMismatch (this file).
//Workflow: the last step of isAuthorizedCron, hasWebhookSecret and hasBodyToken.
//
//Logs the precise reason on failure.
//---------------------------------------------------------------------------------------------------------
function verifySecret(
  label: string,
  envName: string,
  headerName: string,
  presented: string,
  expected: string,
): boolean {
  if (presented === expected) { //exact match
    console.log(`[auth] ${label}: authorized`); //log the pass
    return true; //let it through
  }
  console.warn( //log the rejection and why
    `[auth] ${label}: rejected - ${headerName} did not match ${envName} (${describeMismatch(presented, expected)})`,
  );
  return false; //reject
}
//#endregion

//#endregion
//=============================================================================================================
