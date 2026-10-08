//A wall-clock budget for a sync's per-event loop, so the loop stops of its own accord rather than being killed.
//
//WHY THIS EXISTS. Every sync here saves its cursor once, after its loop. Vercel kills a function at the
//maxDuration in vercel.json (300s), and that kill lands BEFORE the save, so an overrunning run records no
//progress at all: the next run re-reads the same backlog, re-increments every counter it already incremented,
//and overruns again. That is a permanent loop, and a 504 on a sync route means exactly that. It was observed on
//the Aircall sync, whose volume reached the limit first; the other syncs share the shape and so share the risk.
//
//A budget converts the overrun into a clean partial run: the cursor is saved where the loop stopped and the
//remainder is picked up next run. Throughput then becomes a question of how fast a backlog drains rather than
//of whether anything is written at all.
//
//[STABILITY] THE CADENCE MUST EXCEED THE BUDGET. A run may legitimately take the whole budget, and nothing
//guards against two invocations of one sync running at once - they would read the same cursor and double-count
//every event between them. The 300s default and the 240s budget suit the cadences in vercel.json; shortening a
//cadence towards the budget requires lowering that sync's budget with it.

//=============================================================================================================
//#region <import statements>

import { reportConfigValue, tunableEnv } from "./env.js"; //read and log optional env settings

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <types and globals>

//[PERF] The margin below maxDuration has to cover the slowest single event still in flight when the budget
//expires (for a touchpoint, up to eight sequential Attio requests) plus the cursor save and the response.
//Raise maxDuration before raising this.
export const DEFAULT_RUN_BUDGET_MS = 240 * 1_000; //default budget: 240 seconds

//A running budget: its length, and a check for whether time is up.
export interface RunBudget {
  //The budget in force, for logging what a stopped run actually spent.
  readonly ms: number; //budget length in milliseconds
  //True once the loop must stop. Check BEFORE an event, so the budget is what remains for a whole one.
  expired(): boolean; //true once time is up
}

//#endregion
//=============================================================================================================

//=============================================================================================================
//#region <run budget>

//#region <read the budget setting>
//---------------------------------------------------------------------------------------------------------
//Reads a sync's budget length from its env variable, or the default.
//Input: envName - the env variable to read, e.g. "AIRCALL_SYNC_BUDGET_MS".
//Output: the budget in milliseconds.
//Uses: tunableEnv, reportConfigValue (lib/env.ts).
//Workflow: startRunBudget - how long this sync's run may take.
//
//Reads an optional per-sync override so a stuck backlog can be retuned without a redeploy.
//[STABILITY] A malformed value falls back rather than throwing. Losing the override is a tuning problem;
//losing the run is a data problem, and the variable is unset in normal operation anyway.
//---------------------------------------------------------------------------------------------------------
function budgetMs(envName: string): number {
  const raw = tunableEnv(envName, `using the ${DEFAULT_RUN_BUDGET_MS / 1_000}s default`); //the setting's text, or null
  if (!raw) return DEFAULT_RUN_BUDGET_MS; //not set, use the default
  const parsed = Number(raw); //text to number
  if (!Number.isFinite(parsed) || parsed <= 0) { //not a positive number
    console.warn( //log the bad setting
      `[config] ${envName} is not a positive number (${JSON.stringify(raw)}) - using the ${DEFAULT_RUN_BUDGET_MS / 1_000}s default`,
    );
    return DEFAULT_RUN_BUDGET_MS; //fall back to the default
  }
  reportConfigValue(envName, raw); //log the override in use
  return parsed; //the custom budget
}
//#endregion

//#region <start and report a budget>
//---------------------------------------------------------------------------------------------------------
//Opens a budget that expires a set time after the run started.
//Input: startedAtMs - when the run started, epoch ms; envName - the env variable that can override the length.
//Output: a RunBudget whose expired() turns true at the deadline.
//Uses: budgetMs (this file).
//Workflow: all four touchpoint syncs (aircall, heyreach, instantly, outfound), before the per-event loop - the
//clock the step 6a stop checks (7a on Instantly). Outfound also passes it into its thread expansion.
//
//Callers pass startedAtMs as the upperBoundMs they read at the top of the handler - so the budget covers the
//provider fetch and any pagination too, not just the loop. A wide backlog spends real time there before the
//first event is ever processed.
//---------------------------------------------------------------------------------------------------------
export function startRunBudget(startedAtMs: number, envName: string): RunBudget {
  const ms = budgetMs(envName); //how long this run may take
  const deadlineMs = startedAtMs + ms; //the moment time runs out
  return { ms, expired: () => Date.now() >= deadlineMs }; //expired is a small function checking the clock
}

//---------------------------------------------------------------------------------------------------------
//Base function. Gives a budget's length in whole seconds.
//Input: budget - the run's budget.
//Output: the length in seconds, rounded.
//Workflow: all four touchpoint syncs - the "stopped after Ns" log line on a budget stop.
//---------------------------------------------------------------------------------------------------------
export function budgetSeconds(budget: RunBudget): number {
  return Math.round(budget.ms / 1_000); //milliseconds to whole seconds
}
//#endregion

//#endregion
//=============================================================================================================
