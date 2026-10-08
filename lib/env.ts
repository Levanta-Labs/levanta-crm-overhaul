//Environment access. Every read is reported to the console once per process so a misconfigured deployment is
//diagnosable from the Vercel logs. Secret VALUES are never logged - only whether they are set, how long they
//are, and whether the stored value carried surrounding whitespace.

//=============================================================================================================
//#region <types and globals>

//Keys already logged this process, so each is logged once.
const reported = new Set<string>(); //keys already reported

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <read environment variables>

//#region <values>
//---------------------------------------------------------------------------------------------------------
//Reads an environment variable, trimmed, or null when it is missing or blank.
//Input: name - the variable's name.
//Output: the trimmed value, or null.
//Uses: reportEnv (this file).
//Workflow: every environment read - requiredEnv and tunableEnv build on it, and the cron/webhook secret checks
//(lib/http.ts) and the Supabase key choice (lib/endpoints.ts) call it directly.
//---------------------------------------------------------------------------------------------------------
export function optionalEnv(name: string): string | null {
  const raw = process.env[name]; //the value as stored, maybe undefined
  reportEnv(name, raw); //log whether it is set, once
  const value = raw?.trim(); //drop surrounding spaces, if it exists
  return value ? value : null; //blank counts as missing
}

//---------------------------------------------------------------------------------------------------------
//Reads an optional TUNING variable, where absent is the normal case and the code has a default to fall back on.
//Input: name - the variable's name; defaultDescription - what is used instead, for the log line.
//Output: the trimmed value, or null when unset or blank (the caller then uses its default).
//Uses: reportOnce, optionalEnv (this file).
//Workflow: the per-sync run budget (budgetMs, lib/run-budget.ts) and the interested duplicate window
//(duplicateWindowMs, lib/interested.ts).
//
//Reported at [config] as the default in force rather than warned about: every other variable this codebase
//reads is required, so reportEnv's "NOT SET on this deployment" is a genuine misconfiguration signal. Spending
//that warning on a knob which is meant to be unset would teach a reader to skip past the whole class of it.
//Use optionalEnv instead wherever absence is a problem the operator should see.
//---------------------------------------------------------------------------------------------------------
export function tunableEnv(name: string, defaultDescription: string): string | null {
  if (process.env[name] === undefined) { //not set at all, the normal case
    reportOnce(name, () => { //log the default in force, once
      console.log(`[config] ${name} not set - ${defaultDescription}`); //say which default applies
    });
    return null; //caller falls back to its default
  }
  //Present, though possibly blank or padded: the normal path reports both of those and returns null for a blank,
  //which is the same fall-back-to-default outcome. A value stored with stray whitespace is still worth flagging.
  return optionalEnv(name); //read it the normal way
}

//---------------------------------------------------------------------------------------------------------
//Reads an environment variable that must be set.
//Input: name - the variable's name.
//Output: the trimmed value. Throws if it is missing or blank.
//Uses: optionalEnv (this file).
//Workflow: every API key and auth header (lib/endpoints.ts), SUPABASE_URL, and the Attio counter slugs and
//deal owner (lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export function requiredEnv(name: string): string {
  const value = optionalEnv(name); //read it, null if missing
  if (!value) { //missing or blank
    throw new Error(`Missing required environment variable: ${name}`); //cannot run without it
  }
  return value; //the value
}

//---------------------------------------------------------------------------------------------------------
//Reads a required comma-separated variable as a list.
//Input: name - the variable's name.
//Output: the non-empty, trimmed items. Throws if the variable is missing or holds no items.
//Uses: requiredEnv, reportOnce (this file).
//Workflow: none in production - only the unit tests call it now.
//---------------------------------------------------------------------------------------------------------
export function requiredCsvEnv(name: string): readonly string[] {
  const values = requiredEnv(name) //read it, throw if missing
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) { //only commas and spaces
    throw new Error(`Environment variable ${name} must contain at least one value`); //cannot run without one
  }
  reportOnce(`${name}:csv`, () => { //log the list, once
    console.log(`[config] ${name} = ${values.length} value(s): ${JSON.stringify(values)}`); //count and items
  });
  return values; //the list
}
//#endregion

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <report configuration to the logs>

//#region <once per process>
//---------------------------------------------------------------------------------------------------------
//Base function. Runs a log function the first time a key is seen, and never again.
//Input: key - what is being reported; log - the function that writes the log line.
//Output: nothing.
//Workflow: every [env] and [config] log line in this file, so each prints once per process.
//---------------------------------------------------------------------------------------------------------
function reportOnce(key: string, log: () => void): void {
  if (reported.has(key)) return; //already logged, skip
  reported.add(key); //remember it
  log(); //write the log line
}

//---------------------------------------------------------------------------------------------------------
//Logs whether a variable is set, blank, or padded - never its value.
//Input: name - the variable's name; raw - its value as stored, or undefined.
//Output: nothing.
//Uses: reportOnce (this file).
//Workflow: optionalEnv - the first read of each variable.
//---------------------------------------------------------------------------------------------------------
function reportEnv(name: string, raw: string | undefined): void {
  reportOnce(name, () => { //once per variable
    if (raw === undefined) { //not set at all
      console.warn(`[env] ${name}: NOT SET on this deployment`); //warn: missing
      return; //done
    }
    const trimmed = raw.trim(); //value without surrounding spaces
    if (!trimmed) { //only whitespace
      console.warn(`[env] ${name}: SET BUT BLANK (${raw.length} whitespace char(s))`); //warn: blank
      return; //done
    }
    const stripped = raw.length - trimmed.length; //how many spaces were trimmed
    if (stripped > 0) { //had stray whitespace
      console.warn( //warn: fix the stored value
        `[env] ${name}: set, ${trimmed.length} chars, but ${stripped} surrounding whitespace char(s) had to be trimmed - correct the stored value, because senders that sign or compare the raw string will not match`,
      );
      return; //done
    }
    console.log(`[env] ${name}: set, ${trimmed.length} chars`); //all good, length only
  });
}

//---------------------------------------------------------------------------------------------------------
//Base function. Forgets which variables were reported.
//Input: none.
//Output: nothing.
//Workflow: tests only - lets a test suite observe first-read reporting again.
//---------------------------------------------------------------------------------------------------------
export function resetEnvReporting(): void {
  reported.clear(); //empty the set
}
//#endregion

//#region <config values>
//---------------------------------------------------------------------------------------------------------
//Prints a non-secret configuration value in full, once.
//Input: name - a label for the value; value - the value itself.
//Output: nothing.
//Uses: reportOnce (this file).
//Workflow: SUPABASE_URL and key source (lib/endpoints.ts), Attio counter slugs (lib/attio.ts), and the tuning
//overrides (lib/run-budget.ts, lib/interested.ts).
//
//Only for identifiers whose exact content is needed to spot a mistake and whose exposure is harmless: attribute
//slugs and service URLs. Never pass a key, token, or secret.
//---------------------------------------------------------------------------------------------------------
export function reportConfigValue(name: string, value: string): void {
  reportOnce(`${name}:value`, () => { //once per name
    console.log(`[config] ${name} = ${JSON.stringify(value)}`); //print it in quotes
  });
}

//---------------------------------------------------------------------------------------------------------
//Prints only the domain of a configured email address, once.
//Input: name - the variable's name; value - the email address.
//Output: nothing.
//Uses: reportOnce (this file).
//Workflow: defaultDealOwner (lib/attio.ts) - the deal owner address.
//
//Enough to spot a wrong workspace without publishing a mailbox.
//---------------------------------------------------------------------------------------------------------
export function reportConfigEmail(name: string, value: string): void {
  reportOnce(`${name}:email`, () => { //once per name
    const at = value.lastIndexOf("@"); //where the domain starts
    const shape = at > 0 ? `…${value.slice(at)}` : "no @ - not an email address"; //"…@domain.com" or a warning
    console.log(`[config] ${name} = ${shape}`); //print the domain only
  });
}
//#endregion

//#endregion
//=============================================================================================================
