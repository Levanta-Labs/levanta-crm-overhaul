import { expect, setDefaultTimeout, test } from "bun:test";
import { companyCounterSlug, LISTS, personCounterSlug } from "../../lib/attio.js";
import { attributionOptionIds } from "../../lib/providers.js";
import type { Provider } from "../../lib/providers.js";
import {
  AIRCALL_BASE,
  aircallAuthHeader,
  ATTIO_BASE,
  attioHeaders,
  HEYREACH_BASE,
  heyreachHeaders,
  INSTANTLY_BASE,
  instantlyAuthHeader,
  supabaseBaseUrl,
  supabaseHeaders,
} from "../../lib/endpoints.js";
import { optionalEnv } from "../../lib/env.js";
import {
  companyValuesFor,
  dealValuesFor,
  interestedLead,
  personValuesFor,
  toArrBucket,
  toEmployeeRange,
} from "../../lib/interested.js";
import { arrayValue, isJsonObject, responseJson, stringValue } from "../../lib/json.js";
import { OUTFOUND_BASE, outfoundAuthHeader } from "../../lib/endpoints.js";
import { outfoundNaiveUtc } from "../../lib/outfound.js";

const liveTest = process.env.RUN_LIVE_TESTS === "1" ? test : test.skip;

//---------------------------------------------------------------------------------------------------------
//[PERF] EVERY test in this file is a real network round trip, and Bun's default allowance is 5s. Two of them
//sit right on that line - HeyReach's GetConversationsV3 answers in about 4.7s for a single-item page, and
//Attio's note listing in about 5.0s - so they passed when run alone and failed inside a full run. That is the
//worst way for a smoke test to behave: a safety net that cries wolf stops being read, and this suite is what
//stands between a renamed attribute or a stale option ID and records that go silently unwritten.
//
//Set once for the file rather than per test. Doing it per test is what produced the flake in the first place:
//the HeyReach case was fixed on its own and the Attio one, identical in cause, was simply next in line.
//These are diagnostics on a human's terminal, not a CI gate, so a generous ceiling costs nothing - it only
//decides how long a genuinely hung request waits before it is called hung.
//---------------------------------------------------------------------------------------------------------
setDefaultTimeout(20_000);

const PROVIDERS: readonly Provider[] = ["aircall", "instantly", "heyreach", "outfound"];

async function expectOk(label: string, response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} read-only smoke test failed with HTTP ${response.status}`);
  }
  expect(response.ok).toBe(true);
}

/** Collects one string field from every element of an Attio `data` array. `option_id` is read from `id`. */
async function valuesFrom(path: string, response: Response, field: string): Promise<ReadonlySet<string>> {
  await expectOk(`Attio ${path}`, response);
  const body = await responseJson(response);
  if (!isJsonObject(body)) throw new Error(`Attio ${path} returned no object`);
  const values = new Set<string>();
  for (const entry of arrayValue(body, "data")) {
    if (!isJsonObject(entry)) continue;
    //Attio puts a record's own identifiers one level down, under `id` - option_id and attribute_id live there
    //while title and api_slug sit at the top. Checking both is what lets one helper read either.
    const nested = isJsonObject(entry.id) ? stringValue(entry.id[field]) : null;
    const value = stringValue(entry[field]) ?? nested;
    if (value) values.add(value);
  }
  if (values.size === 0) throw new Error(`Attio ${path} returned no ${field} values`);
  return values;
}

async function attioValues(path: string, field: string): Promise<ReadonlySet<string>> {
  return valuesFrom(path, await fetch(`${ATTIO_BASE}${path}`, { headers: attioHeaders() }), field);
}

//=============================================================================================================
//Credentials. Each provider is asked for the smallest page it will serve, which proves the key is accepted.
//=============================================================================================================

liveTest("reads the Supabase cursor table", async () => {
  const url = new URL("/rest/v1/Attio_Integrations_Touchpoint_Cursors", supabaseBaseUrl());
  url.searchParams.set("select", "sync_key,cursor_timestamp");
  url.searchParams.set("limit", "1");
  await expectOk("Supabase", await fetch(url, { headers: supabaseHeaders() }));
});

liveTest("identifies the Attio token", async () => {
  await expectOk("Attio", await fetch(`${ATTIO_BASE}/self`, { headers: attioHeaders() }));
});

liveTest("reads one Aircall calls page", async () => {
  await expectOk(
    "Aircall",
    await fetch(`${AIRCALL_BASE}/calls?per_page=1&order=desc`, {
      headers: { Authorization: aircallAuthHeader() },
    }),
  );
});

liveTest("reads one Instantly email preview", async () => {
  await expectOk(
    "Instantly",
    await fetch(`${INSTANTLY_BASE}/emails?limit=1&preview_only=true`, {
      headers: { Authorization: instantlyAuthHeader() },
    }),
  );
});

liveTest("reads one HeyReach conversation page", async () => {
  await expectOk(
    "HeyReach",
    await fetch(`${HEYREACH_BASE}/inbox/GetConversationsV3`, {
      method: "POST",
      headers: heyreachHeaders(),
      body: JSON.stringify({ limit: 1, cursor: null, filters: {} }),
    }),
  );
});

//=============================================================================================================
//Schema. Every configured slug is checked against the live Attio schema, so a wrong counter slug or a renamed
//list is caught here instead of on the first touchpoint that happens to reach it in production.
//=============================================================================================================

liveTest("every configured Person counter slug exists on the people object", async () => {
  const slugs = await attioValues("/objects/people/attributes", "api_slug");
  for (const provider of PROVIDERS) {
    const configured = personCounterSlug(provider);
    if (!slugs.has(configured)) {
      throw new Error(
        `ATTIO_PERSON_${provider.toUpperCase()}_COUNTER_SLUG is "${configured}", which is not an attribute on the Attio people object`,
      );
    }
    expect(slugs.has(configured)).toBe(true);
  }
});

liveTest("every configured Company counter slug exists on the companies object", async () => {
  const slugs = await attioValues("/objects/companies/attributes", "api_slug");
  for (const provider of PROVIDERS) {
    const configured = companyCounterSlug(provider);
    if (!slugs.has(configured)) {
      throw new Error(
        `ATTIO_COMPANY_${provider.toUpperCase()}_COUNTER_SLUG is "${configured}", which is not an attribute on the Attio companies object`,
      );
    }
    expect(slugs.has(configured)).toBe(true);
  }
});

liveTest("the Master TAM and DNC lists exist", async () => {
  const slugs = await attioValues("/lists", "api_slug");
  for (const listSlug of [LISTS.MASTER_TAM, LISTS.DNC]) {
    if (!slugs.has(listSlug)) {
      throw new Error(`Attio has no list with api_slug "${listSlug}"`);
    }
    expect(slugs.has(listSlug)).toBe(true);
  }
});

liveTest("the token can list notes, which the duplicate check reads before every write", async () => {
  //recentlyNoted (lib/interested.ts) lists a Person's notes to decide whether an event repeats one already
  //recorded. It FAILS OPEN - a refused listing is logged and the event is recorded anyway - so a token
  //without note:read does not break the workflow, it silently stops deduplicating and the duplicate notes
  //this check exists to prevent come back. Nothing else in the codebase reads /notes, so nothing else would
  //notice. That is precisely the kind of failure a smoke test is for.
  const response = await fetch(`${ATTIO_BASE}/notes?limit=1`, { headers: attioHeaders() });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `The Attio token cannot list notes (HTTP ${response.status}). Grant it note:read. Until then the repeat check in lib/interested.ts fails open on every interested lead - look for "[dedupe] ... could not be read" in the logs - and duplicate notes are written as they were before it existed.`,
    );
  }
  await expectOk("Attio /notes", response);

  //The shape listNotes parses, not merely a 200: a listing that answered with an object rather than an array
  //would make every check fail open just as surely as a 403, and just as quietly.
  const body = await responseJson(response);
  if (!isJsonObject(body) || !Array.isArray(body.data)) {
    throw new Error("Attio /notes did not return a data array, which is the shape listNotes (lib/attio.ts) parses");
  }
  expect(Array.isArray(body.data)).toBe(true);
});

liveTest("every attribution option ID still exists on its own object's attribute", async () => {
  //dealValuesFor writes deal_source_discrete and outbound_sub_source_discrete by OPTION ID rather than title,
  //so a rename in the Attio UI cannot break them. The cost of that choice is that the IDs are opaque: nothing
  //about "6cae752e-..." says "Cold Email", and an option DELETED or recreated in Attio gets a new ID while the
  //old one keeps parsing as a perfectly valid UUID. The unit tests pin which ID we send; only this can tell
  //whether Attio still has it.
  //
  //Attio rejects a write naming an unknown option, so a stale ID here means every interested deal loses its
  //attribution - silently, since updateAttioAttributes salvages what it can and logs the rest rather than
  //failing the event.
  for (const { object, slug, optionIds } of attributionOptionIds()) {
    const live = await attioValues(`/objects/${object}/attributes/${slug}/options`, "option_id");
    for (const id of optionIds) {
      if (!live.has(id)) {
        throw new Error(
          `lib/providers.ts writes option ${id} to the Attio ${object} attribute ${slug}, and no such option exists there any more. Either it was deleted and recreated in Attio - which mints a new ID - or the ID belongs to the other object: people and deals spell the same source words with entirely different IDs. Every interested ${object === "people" ? "person" : "deal"} is losing its attribution until this matches.`,
        );
      }
      expect(live.has(id)).toBe(true);
    }
  }
});

liveTest("the configured deal owner is a workspace member", async () => {
  const owner = optionalEnv("ATTIO_DEFAULT_DEAL_OWNER");
  if (!owner) throw new Error("ATTIO_DEFAULT_DEAL_OWNER is not configured");

  const response = await fetch(`${ATTIO_BASE}/workspace_members`, { headers: attioHeaders() });
  if (response.status === 403) {
    //Distinguish "cannot check" from "checked and wrong". A 403 here says nothing about the configured value.
    throw new Error(
      "Cannot verify ATTIO_DEFAULT_DEAL_OWNER: the Attio token is not permitted to read workspace members. Grant it that scope or confirm the owner by hand. This is a token permission problem, not evidence that the owner is wrong.",
    );
  }
  const emails = await valuesFrom("/workspace_members", response, "email_address");
  const match = [...emails].some((email) => email.toLowerCase() === owner.toLowerCase());
  if (!match) {
    throw new Error(
      "ATTIO_DEFAULT_DEAL_OWNER does not match any Attio workspace member, so deal creation will be rejected",
    );
  }
  expect(match).toBe(true);
});

//=============================================================================================================
//The interested workflow's own schema. The counter slugs above are configured, so a typo in an environment
//variable is what could break them. These are hardcoded in lib/interested.ts instead, so what breaks them is
//somebody RENAMING an attribute in Attio - which nothing in this repo would notice until a live lead hit it.
//
//The slugs are not listed by hand here. A lead carrying every field a provider could ever supply is run through
//the real mappers, and whatever keys they produce are what the workflow would genuinely write. A slug added to
//a mapper is therefore covered by these tests the moment it is added, with no second list to keep in step.
//=============================================================================================================

/** A lead with every field populated, so the mappers emit every slug they are capable of emitting. */
const MAXIMAL_LEAD = interestedLead("instantly", {
  emails: ["ada@example.com"],
  phones: ["+15555550123"],
  firstName: "Ada",
  lastName: "Lovelace",
  linkedin: "https://www.linkedin.com/in/ada",
  jobTitle: "Head of Engineering",
  description: "A headline",
  location: "Bristol",
  companyName: "Engines Ltd",
  companyDomain: "engines.example",
  companyAddress: "12 Dock Rd, Bristol, Avon, United Kingdom, BS1 6XX",
  employeeCount: "84",
  annualRevenue: "4318000",
  industry: "information technology & services",
  website: "https://engines.example",
  campaignName: "Q3 Founders",
  occurredAtMs: Date.now(),
});

async function expectSlugsExist(object: string, slugs: readonly string[]): Promise<void> {
  const live = await attioValues(`/objects/${object}/attributes`, "api_slug");
  const missing = slugs.filter((slug) => !live.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `The interested workflow writes ${missing.join(", ")} on the Attio ${object} object, and no such attribute exists there. Either it was renamed in Attio or the mapping in lib/interested.ts is wrong.`,
    );
  }
  expect(missing).toEqual([]);
}

liveTest("every Person attribute the workflow writes exists on the people object", async () => {
  //`company` is a relationship written as a record reference; it is an attribute like any other here.
  await expectSlugsExist("people", Object.keys(personValuesFor(MAXIMAL_LEAD, "00000000-0000-0000-0000-000000000000")));
});

liveTest("every Company attribute the workflow writes exists on the companies object", async () => {
  await expectSlugsExist("companies", Object.keys(companyValuesFor(MAXIMAL_LEAD)));
});

liveTest("every Deal attribute the workflow writes exists on the deals object", async () => {
  //name, stage, owner, and the two associations are written by ensureInterestedDeal rather than the mapper,
  //so they are named here explicitly - a create fails outright if any of them is missing.
  const created = ["name", "stage", "owner", "associated_people", "associated_company"];
  await expectSlugsExist("deals", [...created, ...Object.keys(dealValuesFor(MAXIMAL_LEAD))]);
});

//---------------------------------------------------------------------------------------------------------
//Select attributes reject any value that is not one of their options, so the bucket labels in lib/interested.ts
//have to match Attio's option titles exactly - a renamed option is a rejected write, not a wrong one.
//Every bucket is generated from a value that lands in it, so the check covers the whole range rather than a
//sample of it.
//---------------------------------------------------------------------------------------------------------
liveTest("every Employee range bucket the workflow can produce is a real option", async () => {
  const options = await attioValues("/objects/companies/attributes/employee_range/options", "title");
  const produced = ["5", "25", "84", "500", "2500", "7500", "25000", "75000", "250000"]
    .map((count) => toEmployeeRange(count))
    .filter((bucket): bucket is string => bucket !== null);
  expect(produced).toHaveLength(9);
  const missing = produced.filter((bucket) => !options.has(bucket));
  if (missing.length > 0) {
    throw new Error(`toEmployeeRange produces ${missing.join(", ")}, which Attio's Employee range no longer offers`);
  }
  expect(missing).toEqual([]);
});

liveTest("every Estimated ARR bucket the workflow can produce is a real option", async () => {
  const options = await attioValues("/objects/companies/attributes/estimated_arr_usd/options", "title");
  const produced = ["500000", "4318000", "25000000", "75000000", "150000000", "300000000", "750000000", "5000000000", "50000000000"]
    .map((amount) => toArrBucket(amount))
    .filter((bucket): bucket is string => bucket !== null);
  expect(produced).toHaveLength(9);
  const missing = produced.filter((bucket) => !options.has(bucket));
  if (missing.length > 0) {
    throw new Error(`toArrBucket produces ${missing.join(", ")}, which Attio's Estimated ARR no longer offers`);
  }
  expect(missing).toEqual([]);
});

liveTest("the Interested deal stage exists", async () => {
  const statuses = await attioValues("/objects/deals/attributes/stage/statuses", "title");
  if (!statuses.has("Interested")) {
    throw new Error(
      'Attio\'s deal pipeline has no "Interested" stage, so every deal these workflows open would be rejected',
    );
  }
  expect(statuses.has("Interested")).toBe(true);
});

//---------------------------------------------------------------------------------------------------------
//Suppression reaches two provider endpoints that nothing else in the codebase touches, so a key scoped only
//for reading campaigns and emails passes every check above and still cannot suppress anybody.
//Reads only. Whether a WRITE is permitted cannot be proven without making one, and a blocklist entry is not
//something a smoke test should leave behind.
//---------------------------------------------------------------------------------------------------------
//[PERF] Outfound's reads are slower than the other providers' - see the DNC note below - so every Outfound
//smoke test that can be slow is given this rather than the 5s default.
//Left explicit rather than folded into the default above: these are about Outfound being erratically slow -
//2.2s, 2.5s and 14.7s on three consecutive calls at page_size=1 - not about the suite's baseline.
const OUTFOUND_TIMEOUT_MS = 20_000;

//[PERF] The DNC list is slower again, and erratically so - measured at 2.2s, 2.5s and 14.7s on three
//consecutive calls at page_size=1, and it has timed out past 20s. That reads like a cold start rather than a
//large list. Given its own ceiling because an intermittently failing smoke test teaches people to ignore the
//whole suite, which costs more than the seconds this occasionally spends.
//Production never reads this endpoint - suppression writes through mark-as-dnc - so the latency is a nuisance
//here rather than a risk there. Worth knowing anyway, since the write shares the subsystem.
const OUTFOUND_DNC_TIMEOUT_MS = 60_000;

liveTest("reads one Outfound inbox page", async () => {
  await expectOk(
    "Outfound",
    await fetch(`${OUTFOUND_BASE}/email-inbox/threads?limit=1`, {
      headers: { Authorization: outfoundAuthHeader() },
    }),
  );
});

//The DNC list is the read half of Outfound's suppression channel. As with Instantly's blocklist below, whether
//the WRITE is permitted cannot be proven without making one, and a DNC entry is not something a smoke test
//should leave behind on a real prospect.
//[PERF] Given a longer timeout than the default. This endpoint answers in about two seconds even at page_size=1,
//which is close enough to the 5s default to flake - and a smoke test that fails intermittently teaches people to
//ignore it, which is worse than not having it.
liveTest(
  "the Outfound DNC list is readable, so suppression has somewhere to write",
  async () => {
    await expectOk(
      "Outfound DNC",
      await fetch(`${OUTFOUND_BASE}/dnc?page_size=1`, {
        headers: { Authorization: outfoundAuthHeader() },
      }),
    );
  },
  OUTFOUND_DNC_TIMEOUT_MS,
);

//---------------------------------------------------------------------------------------------------------
//The listing AS THE CRON ACTUALLY CALLS IT - bounded by a time window, which the test above is not.
//This exists because the unbounded read passed while the real one was returning HTTP 500 in production: a
//timezone-aware bound makes this endpoint fail, and nothing that only reads `?limit=1` would ever notice.
//Any regression in outfoundNaiveUtc, or a change of mind upstream, fails here rather than in a cron run.
//---------------------------------------------------------------------------------------------------------
liveTest(
  "reads an Outfound inbox page bounded by a time window, the way the sync does",
  async () => {
    const nowMs = Date.now();
    const params = new URLSearchParams({
      limit: "1",
      email_start_date: outfoundNaiveUtc(nowMs - 10 * 60 * 1_000),
      email_end_date: outfoundNaiveUtc(nowMs),
    });
    await expectOk(
      "Outfound windowed inbox",
      await fetch(`${OUTFOUND_BASE}/email-inbox/threads?${params}`, {
        headers: { Authorization: outfoundAuthHeader() },
      }),
    );
  },
  OUTFOUND_TIMEOUT_MS,
);

//---------------------------------------------------------------------------------------------------------
//The second half of every touchpoint read, and a DIFFERENT endpoint from the listing above. The inbox lists
//threads without message bodies, so the sync fetches each thread's messages separately - a key scoped to list
//the inbox but not to open a thread would pass the test above and still sync nothing at all.
//Chained rather than given a fixed hash, because a thread hash is workspace data and cannot be hardcoded. A
//workspace with no threads at all has nothing to prove here, so the read is skipped rather than failed.
//---------------------------------------------------------------------------------------------------------
liveTest(
  "reads the messages inside an Outfound thread, which the touchpoint sync depends on",
  async () => {
    const listing = await fetch(`${OUTFOUND_BASE}/email-inbox/threads?limit=1`, {
      headers: { Authorization: outfoundAuthHeader() },
    });
    await expectOk("Outfound", listing);
    const body = await responseJson(listing);
    const first = isJsonObject(body) ? arrayValue(body, "items")[0] : null;
    const threadHash = isJsonObject(first) ? stringValue(first.thread_hash) : null;
    if (!threadHash) {
      console.log("[live] Outfound holds no threads, so there is none to open - nothing to verify here");
      return;
    }
    await expectOk(
      "Outfound thread emails",
      await fetch(`${OUTFOUND_BASE}/email-inbox/threads/${encodeURIComponent(threadHash)}/emails`, {
        headers: { Authorization: outfoundAuthHeader() },
      }),
    );
  },
  OUTFOUND_TIMEOUT_MS,
);

//---------------------------------------------------------------------------------------------------------
//The interested route's single enrichment call, and the one endpoint whose failure is INVISIBLE in production:
//enrichFromOutfound swallows a failure by design, so a key that cannot read prospects still records every
//interested lead - just stripped of job title, headcount and revenue, and with an empty history note. Nothing
//in the response says so. This is the check that catches it.
//A deliverable-looking address that matches nobody is the point: what is being proven is that the endpoint
//answers, not that any particular lead exists.
//---------------------------------------------------------------------------------------------------------
liveTest("the Outfound prospect lookup is readable, so an interested lead can be enriched", async () => {
  await expectOk(
    "Outfound prospects",
    await fetch(
      `${OUTFOUND_BASE}/prospects/lookup/conversations?email=${encodeURIComponent("nobody@example.invalid")}`,
      { headers: { Authorization: outfoundAuthHeader() } },
    ),
  );
});

//[PERF] The key's rate-limit tier, which the touchpoint sync spends one request per thread against. A read of
//this costs one request itself, and is the one call that says how much headroom the sync actually has.
liveTest("reports the Outfound rate-limit tier the sync is running under", async () => {
  await expectOk(
    "Outfound rate limit",
    await fetch(`${OUTFOUND_BASE}/rate-limit`, {
      headers: { Authorization: outfoundAuthHeader() },
    }),
  );
});

liveTest("the Instantly blocklist is readable, so suppression has somewhere to write", async () => {
  await expectOk(
    "Instantly blocklist",
    await fetch(`${INSTANTLY_BASE}/block-lists-entries?limit=1`, {
      headers: { Authorization: instantlyAuthHeader() },
    }),
  );
});

//The read half of HeyReach's blacklist, which suppression writes the lead and their company to. As with the
//blocklists above, whether the WRITE is permitted cannot be proven without making one.
//Each list holds 1,000 entries by default, and a full one fails suppression, so the counts are printed - counts
//only, never the entries - to show how close the workspace is before it gets there.
liveTest("the HeyReach blacklist is readable, so suppression has somewhere to write", async () => {
  const counts: string[] = [];
  for (const list of ["Leads", "Companies"]) {
    const response = await fetch(`${HEYREACH_BASE}/blacklist/Get${list}`, {
      method: "POST",
      headers: heyreachHeaders(),
      body: JSON.stringify({ offset: 0, limit: 1 }),
    });
    await expectOk(`HeyReach blacklist ${list}`, response);
    const body = await responseJson(response);
    if (!isJsonObject(body)) throw new Error(`HeyReach blacklist ${list} returned no object`);
    counts.push(`${list.toLowerCase()} ${String(body.totalCount)}`);
  }
  console.log(`[live] HeyReach blacklist entries: ${counts.join(", ")} (default limit 1,000 each)`);
});

liveTest("the Instantly lead record is readable, so an interested lead can be enriched", async () => {
  await expectOk(
    "Instantly leads",
    await fetch(`${INSTANTLY_BASE}/leads/list`, {
      method: "POST",
      headers: { Authorization: instantlyAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    }),
  );
});

//=============================================================================================================
//Secrets that no external call can validate. Presence is all this can check, but a blank value here is the
//difference between a working route and a permanent 401.
//=============================================================================================================

liveTest("the request-verification secrets are configured", () => {
  const missing = ["CRON_SECRET", "INSTANTLY_WEBHOOK_SECRET", "HEYREACH_WEBHOOK_SECRET", "OUTFOUND_WEBHOOK_SECRET"]
    .filter((name) => optionalEnv(name) === null);
  if (missing.length > 0) {
    throw new Error(`Not configured, so the matching routes will reject every request: ${missing.join(", ")}`);
  }
  expect(missing).toEqual([]);
});
