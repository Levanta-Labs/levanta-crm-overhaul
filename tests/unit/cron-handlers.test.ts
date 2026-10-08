import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET as aircallSync } from "../../api/cron/aircall-touchpoint-sync.js";
import { GET as heyReachSync } from "../../api/cron/heyreach-touchpoint-sync.js";
import { GET as instantlySync } from "../../api/cron/instantly-touchpoint-sync.js";
import { GET as outfoundSync } from "../../api/cron/outfound-touchpoint-sync.js";
import { installFetchMock, jsonResponse, noteWrites, notesResponse } from "./test-utils.js";

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "AIRCALL_API_ID",
  "AIRCALL_API_TOKEN",
  "ATTIO_DEFAULT_DEAL_OWNER",
  "INSTANTLY_API_KEY",
  "HEYREACH_API_KEY",
  "CRON_SECRET",
  "ATTIO_API_KEY",
  "ATTIO_PERSON_AIRCALL_COUNTER_SLUG",
  "ATTIO_PERSON_INSTANTLY_COUNTER_SLUG",
  "ATTIO_PERSON_HEYREACH_COUNTER_SLUG",
  "ATTIO_COMPANY_AIRCALL_COUNTER_SLUG",
  "AIRCALL_SYNC_BUDGET_MS",
  "INSTANTLY_SYNC_BUDGET_MS",
  "HEYREACH_SYNC_BUDGET_MS",
  "OUTFOUND_API_KEY",
  "ATTIO_PERSON_OUTFOUND_COUNTER_SLUG",
  "ATTIO_COMPANY_OUTFOUND_COUNTER_SLUG",
  "OUTFOUND_SYNC_BUDGET_MS",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.AIRCALL_API_ID = "aircall-id";
  process.env.AIRCALL_API_TOKEN = "aircall-token";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.HEYREACH_API_KEY = "heyreach-key";
  process.env.CRON_SECRET = "cron-secret";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_PERSON_AIRCALL_COUNTER_SLUG = "number_of_calls";
  process.env.ATTIO_PERSON_INSTANTLY_COUNTER_SLUG = "number_of_emails";
  process.env.ATTIO_PERSON_HEYREACH_COUNTER_SLUG = "number_of_dms";
  process.env.ATTIO_COMPANY_AIRCALL_COUNTER_SLUG = "number_of_calls";
  process.env.OUTFOUND_API_KEY = "outfound-key";
  //Outfound reuses the Instantly email counters: both are email touchpoints, on different mail.
  process.env.ATTIO_PERSON_OUTFOUND_COUNTER_SLUG = "number_of_emails";
  process.env.ATTIO_COMPANY_OUTFOUND_COUNTER_SLUG = "number_of_emails";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function cronRequest(): Request {
  return new Request("https://example.com/api/cron/sync", {
    headers: { Authorization: "Bearer cron-secret" },
  });
}

describe("cron handlers", () => {
  test("rejects an invalid Vercel cron secret before external calls", async () => {
    const response = await aircallSync(new Request("https://example.com", { headers: { Authorization: "Bearer wrong" } }));
    expect(response.status).toBe(401);
  });

  test("Aircall completes an empty read window and persists its high-water mark", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ calls: [], meta: { next_page_link: null } });
    });
    try {
      const response = await aircallSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, callsFound: 0 });
      expect(mock.calls.some((call) => call.input.includes("api.aircall.io"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("Aircall touchpoint sync increments counters and notes only the company, not the person", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("objects/people/records/person-1/entries")) {
        return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({
          data: [
            {
              id: { record_id: "person-1" },
              values: {
                associated_deals: [],
                company: [{ target_record_id: "company-1" }],
                name: [{ full_name: "Ada Lovelace" }],
              },
            },
          ],
        });
      }
      if (url.includes("objects/people/records/person-1")) {
        return init?.method === "PATCH" ? jsonResponse({}) : jsonResponse({ data: { id: { record_id: "record-1" }, values: { number_of_calls: [] } } });
      }
      if (url.includes("objects/companies/records/company-1")) {
        return init?.method === "PATCH" ? jsonResponse({}) : jsonResponse({ data: { id: { record_id: "record-1" }, values: { number_of_calls: [] } } });
      }
      if (url.includes("/notes")) return notesResponse(init);
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+15555550123",
              started_at: Math.floor(Date.now() / 1000) - 120,
              ended_at: Math.floor(Date.now() / 1000) - 60,
              duration: 42,
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, callsFound: 1, processed: 1 });

      const noteCalls = noteWrites(mock.calls);
      expect(noteCalls).toHaveLength(1);
      expect(String(noteCalls[0]?.init?.body)).toContain('"parent_object":"companies"');

      const personPatchCalls = mock.calls.filter(
        (call) => call.input.includes("objects/people/records/person-1") && call.init?.method === "PATCH",
      );
      expect(personPatchCalls).toHaveLength(1);
      const companyPatchCalls = mock.calls.filter(
        (call) => call.input.includes("objects/companies/records/company-1") && call.init?.method === "PATCH",
      );
      expect(companyPatchCalls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("Aircall reaches back past the longest call, because the API filters on creation time", async () => {
    //Regression: /calls filters on when a call was CREATED, but this sync places calls by when they ENDED. A
    //call lasting longer than the completion window used to be filtered out as "not done" on every run that
    //covered its start, then fell out of range before it ever looked finished - lost entirely. The requested
    //`from` must therefore sit a full call-duration margin below the cursor.
    let requestedFromMs = 0;
    const startedAt = Math.floor(Date.now() / 1000) - 95 * 60; //began 95 minutes ago
    const endedAt = Math.floor(Date.now() / 1000) - 60; //ended one minute ago
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("objects/people/records/person-1/entries")) {
        return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: { associated_deals: [] } }] });
      }
      if (url.includes("objects/people/records/person-1")) {
        //Serves the counter's read-then-write.
        return init?.method === "PATCH" ? jsonResponse({}) : jsonResponse({ data: { id: { record_id: "record-1" }, values: { number_of_calls: [] } } });
      }
      if (url.includes("/notes")) return notesResponse(init);
      if (url.includes("api.aircall.io")) {
        requestedFromMs = Number(new URL(url).searchParams.get("from")) * 1000;
        //Only returned because the window reaches back far enough to cover the call's start.
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0123",
              started_at: startedAt,
              ended_at: endedAt,
              duration: endedAt - startedAt,
              contact: { id: 77, first_name: "Ada", last_name: "Lovelace", emails: [{ value: "ada@example.com" }] },
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await aircallSync(cronRequest())).json();
      //A 95-minute call that ended a minute ago is still counted.
      expect(body).toMatchObject({ callsFound: 1, processed: 1 });
      expect(requestedFromMs).toBeLessThan(startedAt * 1000);
    } finally {
      mock.restore();
    }
  });

  test("Aircall ignores a call that ended before the cursor, despite the wider fetch", async () => {
    //The margin above drags in old calls purely for reach. The cursor must reject them, or every run would
    //re-count the last two hours of calls.
    const endedAt = Math.floor(Date.now() / 1000) - 3 * 60 * 60; //finished three hours ago
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0123",
              started_at: endedAt - 60,
              ended_at: endedAt,
              duration: 60,
              contact: { id: 77, first_name: "Ada", last_name: "Lovelace", emails: [{ value: "ada@example.com" }] },
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await aircallSync(cronRequest())).json();
      //Fetched for reach, but behind the cursor, so nothing acts and the summary says so.
      expect(body).toMatchObject({ callsFound: 1, beforeCursor: 1, processed: 0, failed: 0 });
      //No Attio call of any kind: an old call must not be re-recorded just because the fetch reached it.
      expect(mock.calls.some((call) => call.input.includes("api.attio.com"))).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("every sync parks its cursor short of now, so late-published events are not skipped", async () => {
    const saved: number[] = [];
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") {
        saved.push(Date.parse(JSON.parse(String(init.body)).cursor_timestamp));
        return new Response(null, { status: 204 });
      }
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.aircall.io")) return jsonResponse({ calls: [], meta: { next_page_link: null } });
      if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
      return jsonResponse({ items: [], totalCount: 0, hasNextPage: false, nextCursor: null });
    });
    try {
      const before = Date.now();
      await aircallSync(cronRequest());
      await instantlySync(cronRequest());
      await heyReachSync(cronRequest());
      expect(saved).toHaveLength(3);
      //CURSOR_GRACE_MS is two minutes; each mark must land at least a minute behind the run's own clock.
      for (const mark of saved) expect(mark).toBeLessThanOrEqual(before - 60_000);
    } finally {
      mock.restore();
    }
  });

  test("Aircall stops on the run budget and leaves the cursor where the loop reached, not at now", async () => {
    //A 2ms budget against an Aircall read deliberately made to take 20ms: the budget is spent before the loop
    //starts, so it breaks on its very first call. Nothing is processed, and - the part that matters - the cursor
    //must NOT be parked near now. Parking would claim the untouched calls had been dealt with and skip them
    //forever, which is exactly the silent loss the budget exists to avoid. Vercel killing the function at
    //maxDuration saved nothing at all; this saves the old mark, so the next run resumes from it.
    process.env.AIRCALL_SYNC_BUDGET_MS = "2";
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const endedAt = Math.floor(Date.now() / 1000) - 300;
    const mock = installFetchMock(async (url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "aircall-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("api.aircall.io")) {
        //Real elapsed time, because the budget is wall-clock and every other mock here answers instantly.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return jsonResponse({
          calls: [1, 2, 3].map((id) => ({
            id,
            status: "done",
            direction: "outbound",
            raw_digits: `+1 555-555-000${id}`,
            started_at: endedAt - 60,
            ended_at: endedAt + id,
            duration: 60,
          })),
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallSync(cronRequest());
      //A truncated run is not a failure: it wrote everything it reached and recorded where that was.
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        truncated: true,
        callsFound: 3,
        callsRemaining: 3,
        processed: 0,
      });
      //No Attio work was attempted, so there is nothing to double-count next run.
      expect(mock.calls.some((call) => call.input.includes("attio"))).toBe(false);
      const write = mock.calls.find((call) => call.input.includes("supabase.co") && call.init?.method === "POST");
      const saved = JSON.parse(String(write?.init?.body)) as { cursor_timestamp: string };
      expect(Date.parse(saved.cursor_timestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("Aircall parks its cursor at now only when the loop actually finished", async () => {
    //The mirror of the test above, and the reason `truncated` is reported rather than inferred: with the budget
    //left alone the same three calls are all handled, so parking short of now is correct and the flag is false.
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const endedAt = Math.floor(Date.now() / 1000) - 300;
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "aircall-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      //No Attio person matches, so each call is skipped without any write - the loop is what is under test here.
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [1, 2, 3].map((id) => ({
            id,
            status: "done",
            direction: "outbound",
            raw_digits: `+1 555-555-000${id}`,
            started_at: endedAt - 60,
            ended_at: endedAt + id,
            duration: 60,
            tags: [{ name: "Outbound Campaign" }],
          })),
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await aircallSync(cronRequest())).json();
      expect(body).toMatchObject({ truncated: false, callsFound: 3, skipped: 3 });
      expect(body).not.toHaveProperty("callsRemaining");
      //Parked short of now, well past the half-hour-old mark it started from.
      expect(Date.parse(body.cursorTimestamp)).toBeGreaterThan(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("Aircall stops on an Attio throttle before any write, leaving the call above the cursor", async () => {
    //The reported failure: Attio 429s the filtered person lookup on "query complexity". That is the FIRST Attio
    //request a touchpoint makes, so nothing has been written, and the old behaviour - log it, pass the call
    //over, advance the cursor anyway - discarded that call's counter and note for good. The run must instead
    //stop with the cursor still BELOW the throttled call, so the next run starts on it.
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const endedAt = Math.floor(Date.now() / 1000) - 300;
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "aircall-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      //Retry-After 0 so attioFetch exhausts its four attempts without slowing the test down.
      if (url.includes("objects/people/records/query")) {
        return new Response(JSON.stringify({ type: "rate_limit_error", message: "Query complexity" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [1, 2].map((id) => ({
            id,
            status: "done",
            direction: "outbound",
            raw_digits: `+1 555-555-000${id}`,
            started_at: endedAt - 60,
            ended_at: endedAt + id,
            duration: 60,
            tags: [{ name: "Outbound Campaign" }],
          })),
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await aircallSync(cronRequest())).json();
      //Deferred, not failed: nothing was lost, so the run is still a success and failed stays at zero.
      expect(body).toMatchObject({
        success: true,
        truncated: true,
        stopReason: "throttled",
        failed: 0,
        processed: 0,
        callsRemaining: 2,
      });
      //The cursor did NOT move past the throttled call, and was not parked at now either.
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
      //It stopped on the first call rather than throttling its way through both.
      const queries = mock.calls.filter((call) => call.input.includes("objects/people/records/query"));
      expect(queries).toHaveLength(4);
    } finally {
      mock.restore();
    }
  });

  //=========================================================================================================
  //The same stop, on the other three syncs. Ported from Aircall after production logs showed the Instantly
  //sync dropping touchpoints outright: Attio answered the opening lookup with a bare 500, the loop logged
  //"FAILED and passed over", and the cursor advanced anyway - so the note and counter were lost for good and
  //nothing recorded that the email had ever existed. A 500 is used here rather than a 429 because that is
  //what Attio actually sent.
  //=========================================================================================================

  test("Instantly stops on an Attio 500 before any write, leaving the email above the cursor", async () => {
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "instantly-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ status_code: 500, type: "api_error", message: "An internal server error occurred." }, 500);
      }
      return jsonResponse({
        items: [1, 2].map((id) => ({
          id: `email-${id}`,
          timestamp_created: createdAt,
          ue_type: 1,
          is_auto_reply: false,
          lead: `lead${id}@example.com`,
        })),
        next_starting_after: null,
      });
    });
    try {
      const body = await (await instantlySync(cronRequest())).json();
      //Deferred, not failed: nothing was written, so the run is still a success and failed stays at zero.
      expect(body).toMatchObject({
        success: true,
        truncated: true,
        stopReason: "throttled",
        failed: 0,
        processed: 0,
        emailsRemaining: 2,
      });
      //The cursor did NOT move past the 500'd email, and was not parked at now either.
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("Instantly still passes over a deterministic lookup failure rather than stopping forever", async () => {
    //The other half of the distinction, as on Aircall. A 404 fails identically every run, so deferring it
    //would wedge the sync on one unprocessable email.
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "instantly-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("objects/people/records/query")) return jsonResponse({ error: "gone" }, 404);
      return jsonResponse({
        items: [{ id: "email-1", timestamp_created: createdAt, ue_type: 1, is_auto_reply: false, lead: "lead1@example.com" }],
        next_starting_after: null,
      });
    });
    try {
      const response = await instantlySync(cronRequest());
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({ truncated: false, failed: 1 });
      expect(body).not.toHaveProperty("stopReason");
      //Passed over means the cursor moved past it, and the run then parked short of now.
      expect(Date.parse(body.cursorTimestamp)).toBeGreaterThan(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("HeyReach stops on an Attio 500 before any write, leaving the message above the cursor", async () => {
    const sentAt = new Date(Date.now() - 60 * 1000).toISOString();
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "heyreach-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ status_code: 500, type: "api_error", message: "An internal server error occurred." }, 500);
      }
      return jsonResponse({
        items: [
          {
            id: "conversation-1",
            linkedInAccountId: 7,
            lastMessageAt: sentAt,
            correspondentProfile: { linkedin_id: "ada", profileUrl: "https://linkedin.com/in/ada" },
            messages: [1, 2].map((id) => ({ id: `message-${id}`, sender: "user", body: `hello ${id}`, createdAt: sentAt })),
          },
        ],
        totalCount: 1,
        hasNextPage: false,
        nextCursor: null,
      });
    });
    try {
      const body = await (await heyReachSync(cronRequest())).json();
      expect(body).toMatchObject({
        success: true,
        truncated: true,
        stopReason: "throttled",
        failed: 0,
        processed: 0,
      });
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("Outfound stops on an Attio 500 before any write, leaving the email above the cursor", async () => {
    //Distinct from the OutfoundRateLimitError stop above: that one is Outfound refusing to hand over a thread,
    //this one is Attio refusing the person lookup once the thread has already been read.
    const sentAt = new Date(Date.now() - 60 * 1000).toISOString();
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "outfound-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ status_code: 500, type: "api_error", message: "An internal server error occurred." }, 500);
      }
      if (url.includes("/emails")) {
        return jsonResponse({
          items: [
            { id: "email-1", sender: "rep@x.com", recipient: "ada@example.com", subject: "Hi", body_plain: "one", sent_at: sentAt, type: "Sent" },
          ],
        });
      }
      if (url.includes("/email-inbox/threads")) {
        return jsonResponse({
          items: [{ thread_hash: "thread-1", prospect_lead_email: "ada@example.com", last_email_timestamp: sentAt }],
          next_cursor: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await outfoundSync(cronRequest())).json();
      expect(body).toMatchObject({
        success: true,
        truncated: true,
        stopReason: "throttled",
        failed: 0,
        processed: 0,
      });
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("Aircall still passes over a deterministic lookup failure rather than stopping forever", async () => {
    //The other half of the distinction. A 404 will fail identically on every future run, so stopping the run on
    //it would wedge the sync on one unprocessable call. Only a transient status defers; this one is passed over
    //and the cursor advances, exactly as before.
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const endedAt = Math.floor(Date.now() / 1000) - 300;
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "aircall-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("objects/people/records/query")) return jsonResponse({ error: "gone" }, 404);
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0001",
              started_at: endedAt - 60,
              ended_at: endedAt,
              duration: 60,
              tags: [{ name: "Outbound Campaign" }],
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallSync(cronRequest());
      //A genuine failure, so it is counted and returned - and the run reports 500 as it always has.
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({ truncated: false, failed: 1 });
      expect(body).not.toHaveProperty("stopReason");
      //Passed over means the cursor moved on past it, and the run then parked short of now.
      expect(Date.parse(body.cursorTimestamp)).toBeGreaterThan(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("Aircall falls back to the default budget when AIRCALL_SYNC_BUDGET_MS is malformed", async () => {
    //A bad override must not take the run down with it - it is a tuning knob, not a dependency.
    process.env.AIRCALL_SYNC_BUDGET_MS = "not-a-number";
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.aircall.io")) return jsonResponse({ calls: [], meta: { next_page_link: null } });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ truncated: false });
    } finally {
      mock.restore();
    }
  });

  test("Instantly completes an empty read window and persists its high-water mark", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ items: [], next_starting_after: null });
    });
    try {
      const response = await instantlySync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, emailsFound: 0 });
    } finally {
      mock.restore();
    }
  });

  test("HeyReach completes an empty read window and persists its high-water mark", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ items: [], totalCount: 0, hasNextPage: false, nextCursor: null });
    });
    try {
      const response = await heyReachSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, messagesFound: 0 });
    } finally {
      mock.restore();
    }
  });

  test("Instantly stops on the run budget and leaves the cursor where the loop reached", async () => {
    //The same failure the Aircall sync hit: saveSyncCursor runs after the loop, so a run killed at maxDuration
    //records nothing and the next one redoes it, re-incrementing every counter. These two syncs have lower
    //volume, not a different shape, so they get the same stop.
    process.env.INSTANTLY_SYNC_BUDGET_MS = "2";
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const mock = installFetchMock(async (url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "instantly-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      //Real elapsed time, because the budget is wall-clock and every other mock here answers instantly.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({
        items: [1, 2].map((id) => ({
          id: `email-${id}`,
          timestamp_created: createdAt,
          ue_type: 1,
          is_auto_reply: false,
          lead: `lead${id}@example.com`,
        })),
        next_starting_after: null,
      });
    });
    try {
      const response = await instantlySync(cronRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ success: true, truncated: true, processed: 0, emailsRemaining: 2 });
      //Not parked at now: the emails the loop never reached must stay above the mark.
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  //---------------------------------------------------------------------------------------------------------
  //[STABILITY] The claim the budget stop rests on: what a stopped run did not reach is picked up by the next
  //run, not skipped and not counted twice. The test above proves only that the cursor is not parked at now.
  //This one runs the handler TWICE against one persisted cursor and one Instantly window, and checks the pair:
  //every email is noted exactly once across the two runs, and the second run re-reads and rejects the boundary
  //email rather than re-noting it.
  //---------------------------------------------------------------------------------------------------------
  test("Instantly resumes a budget-stopped window on the next run, noting every email exactly once", async () => {
    //Each email costs one deliberately slow Attio person lookup, so a budget of a few of those stops the first
    //run part-way through rather than before it starts. How far it gets is left to the clock: the assertions
    //below are on the invariant (nothing lost, nothing doubled), not on a particular stopping point.
    const PER_EMAIL_MS = 120;
    process.env.INSTANTLY_SYNC_BUDGET_MS = "200";

    const emails = [4, 3, 2, 1].map((minutesAgo) => ({
      id: `email-${5 - minutesAgo}`,
      timestamp_created: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      timestamp_email: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      ue_type: 1,
      is_auto_reply: 0,
      lead: "ada@example.com",
      subject: `Message ${5 - minutesAgo}`,
      body: { html: `<div>Body ${5 - minutesAgo}</div>` },
    }));

    //The one row both runs share. The POST handler below writes it exactly as Supabase would, so the second
    //run reads back what the first one actually saved rather than anything this test made up.
    let saved = { cursor_timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(), cursor_value: null as string | null };

    const respond = async (url: string, init: RequestInit | undefined): Promise<Response> => {
      if (url.includes("supabase.co") && init?.method === "POST") {
        saved = JSON.parse(String(init.body)) as typeof saved;
        return new Response(null, { status: 204 });
      }
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "instantly-touchpoints", ...saved }]);
      }
      if (url.includes("api.instantly.ai")) {
        //Instantly filters the window server-side, so the second run does NOT see the emails the first one
        //passed the cursor over - except the one sitting exactly on the mark, which the -1ms bound returns and
        //isAfterCursor is left to reject. Mocking that faithfully is the point: it is where a duplicate would
        //come from if the cursor's boundary handling were wrong.
        const minTimestamp = Date.parse(new URL(url).searchParams.get("min_timestamp_created") ?? "");
        return jsonResponse({
          items: emails.filter((email) => Date.parse(email.timestamp_created) >= minTimestamp),
          next_starting_after: null,
        });
      }
      if (url.includes("objects/people/records/person-1/entries")) {
        return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
      }
      if (url.includes("objects/people/records/query")) {
        await new Promise((resolve) => setTimeout(resolve, PER_EMAIL_MS));
        return jsonResponse({
          data: [{ id: { record_id: "person-1" }, values: { company: [], name: [{ full_name: "Ada Lovelace" }] } }],
        });
      }
      if (url.includes("objects/people/records/person-1")) {
        return init?.method === "PATCH"
          ? jsonResponse({})
          : jsonResponse({ data: { id: { record_id: "person-1" }, values: { number_of_emails: [] } } });
      }
      if (url.includes("/notes")) return notesResponse(init);
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const mock = installFetchMock(respond);
    try {
      const first = await (await instantlySync(cronRequest())).json();
      expect(first.truncated).toBe(true);
      //Part-way, which is what makes this a resume rather than a repeat of the "stopped before it started" test.
      expect(first.processed).toBeGreaterThanOrEqual(1);
      expect(first.processed).toBeLessThan(emails.length);
      //The mark sits on the last email it handled - not at now, and not back where it started.
      const lastHandled = emails[first.processed - 1];
      expect(Date.parse(saved.cursor_timestamp)).toBe(Date.parse(lastHandled!.timestamp_created));
      expect(JSON.parse(String(saved.cursor_value))).toEqual([lastHandled!.id]);

      //Second run, with the budget out of the way, starting from exactly what the first one persisted.
      delete process.env.INSTANTLY_SYNC_BUDGET_MS;
      const second = await (await instantlySync(cronRequest())).json();
      expect(second.truncated).toBe(false);
      //The boundary email comes back down the wire and is refused by the cursor, not by luck of the window.
      expect(second.beforeCursor).toBe(1);
      expect(second.emailsFound).toBe(emails.length - first.processed + 1);
      //Everything the first run left behind, and nothing else.
      expect(second.processed).toBe(emails.length - first.processed);

      //The claim itself: one note per email across both runs. A lost email is a missing subject here, and a
      //replayed one is a repeated subject - the two failures the cursor exists to prevent.
      const titles = mock.calls
        .filter((call) => call.input.includes("/notes") && call.init?.method === "POST")
        .map((call) => (JSON.parse(String(call.init?.body)) as { data: { title: string } }).data.title);
      expect(titles).toHaveLength(emails.length);
      expect(new Set(titles).size).toBe(emails.length);
      for (const email of emails) {
        expect(titles.some((title) => title.startsWith(`${email.subject} — `))).toBe(true);
      }
      //And the counter moved once per email, since a double count is the damage a replay actually does.
      const patches = mock.calls.filter(
        (call) => call.input.includes("objects/people/records/person-1") && call.init?.method === "PATCH",
      );
      expect(patches).toHaveLength(emails.length);
    } finally {
      mock.restore();
    }
  });

  //---------------------------------------------------------------------------------------------------------
  //[DEBUG] Every sync's summary line used to be printed after saveSyncCursor and inside the try, so any throw -
  //and Supabase 504s on both the cursor read and the cursor write often enough to see it in a day's logs - left
  //the run reporting nothing. A log filtered on "[run] <provider> sync:" then had holes in it that looked
  //exactly like runs that never fired. These pin the line to every exit, and to saying which exit it was.
  //---------------------------------------------------------------------------------------------------------
  function captureRunLog(): { lines: string[]; restore(): void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => { console.log = original; } };
  }

  //Every sync, by the name its summary line carries. Kept as a table so a fifth provider cannot be added with
  //the summary guarantee quietly missing from it.
  const syncs = [
    { name: "aircall", handler: aircallSync },
    { name: "instantly", handler: instantlySync },
    { name: "heyreach", handler: heyReachSync },
    { name: "outfound", handler: outfoundSync },
  ] as const;

  for (const { name, handler } of syncs) {
    test(`${name} still reports a run that failed at the cursor read`, async () => {
      const log = captureRunLog();
      const mock = installFetchMock((url) => {
        if (url.includes("supabase.co")) return jsonResponse({ message: "Gateway Timeout" }, 504);
        throw new Error(`Unexpected fetch: ${url}`);
      });
      try {
        expect((await handler(cronRequest())).status).toBe(500);
      } finally {
        log.restore();
        mock.restore();
      }
      const summary = log.lines.filter((line) => line.startsWith(`[run] ${name} sync:`));
      //Exactly one, so the line stays countable: one per invocation, never two and never none.
      expect(summary).toHaveLength(1);
      //The headline figure comes first on every sync, a failed run included. Anchored to the start of the
      //line rather than merely present in it, because "in front" is the requirement. Zero here on purpose:
      //this run died at the cursor read, so the count it leads with is the one it truly wrote.
      expect(summary[0]).toStartWith(`[run] ${name} sync: 0 touchpoint(s) logged, `);
      expect(summary[0]).toContain("ABANDONED on an error");
      expect(summary[0]).toContain("Supabase cursor read failed (504)");
      //Nothing was read, so there is no mark to report and the line says that rather than inventing one.
      expect(summary[0]).toContain("no cursor was ever read");
    });
  }

  test("Instantly reports a run that wrote to Attio and then failed to save its cursor", async () => {
    //The dangerous shape, and the reason the line names the cursor's fate rather than just printing a
    //timestamp: the touchpoint is committed in Attio, the mark is not, so the next run notes it a second time.
    const log = captureRunLog();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") {
        return jsonResponse({ message: "Gateway Timeout" }, 504);
      }
      if (url.includes("supabase.co")) {
        return jsonResponse([
          {
            sync_key: "instantly-touchpoints",
            cursor_value: null,
            cursor_timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          },
        ]);
      }
      if (url.includes("api.instantly.ai")) {
        return jsonResponse({
          items: [
            {
              id: "email-1",
              timestamp_created: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
              ue_type: 1,
              is_auto_reply: 0,
              lead: "ada@example.com",
              subject: "Hello",
              body: { html: "<div>Hello</div>" },
            },
          ],
          next_starting_after: null,
        });
      }
      if (url.includes("objects/people/records/person-1/entries")) {
        return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({
          data: [{ id: { record_id: "person-1" }, values: { company: [], name: [{ full_name: "Ada Lovelace" }] } }],
        });
      }
      if (url.includes("objects/people/records/person-1")) {
        return init?.method === "PATCH"
          ? jsonResponse({})
          : jsonResponse({ data: { id: { record_id: "person-1" }, values: { number_of_emails: [] } } });
      }
      if (url.includes("/notes")) return notesResponse(init);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      expect((await instantlySync(cronRequest())).status).toBe(500);
    } finally {
      log.restore();
      mock.restore();
    }
    const summary = log.lines.filter((line) => line.startsWith("[run] instantly sync:"));
    expect(summary).toHaveLength(1);
    //The work it did is reported in full, which is the whole point - this is the run that most needs reading.
    //The headline count is the touchpoint it actually wrote, not a figure that is only ever zero.
    expect(summary[0]).toStartWith("[run] instantly sync: 1 touchpoint(s) logged, ");
    expect(summary[0]).toContain("1 email(s) in window");
    expect(summary[0]).toContain("1 processed");
    expect(summary[0]).toContain("cursor NOT saved");
    expect(summary[0]).toContain("re-read next run");
  });

  test("Instantly reports a completed run the same way, with the mark it saved", async () => {
    const log = captureRunLog();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ items: [], next_starting_after: null });
    });
    try {
      expect((await instantlySync(cronRequest())).status).toBe(200);
    } finally {
      log.restore();
      mock.restore();
    }
    const summary = log.lines.filter((line) => line.startsWith("[run] instantly sync:"));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toStartWith("[run] instantly sync: 0 touchpoint(s) logged, ");
    expect(summary[0]).toContain("0 email(s) in window");
    expect(summary[0]).toContain("complete");
    expect(summary[0]).toMatch(/cursor now \d{4}-\d{2}-\d{2}T/);
  });

  test("Outfound completes an empty read window and persists its high-water mark", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ items: [], next_cursor: null });
    });
    try {
      const response = await outfoundSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, threadsScanned: 0, emailsFound: 0 });
    } finally {
      mock.restore();
    }
  });

  //The inbox lists threads without bodies, so every thread costs a second request. This is that expansion.
  test("Outfound expands each thread into its own emails and counts them individually", async () => {
    const sentAt = new Date(Date.now() - 60 * 1000).toISOString();
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "outfound-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("/emails")) {
        return jsonResponse({
          items: [
            { id: "email-1", sender: "rep@x.com", recipient: "ada@example.com", subject: "Hi", body_plain: "one", sent_at: sentAt, type: "Sent" },
            { id: "email-2", sender: "ada@example.com", recipient: "rep@x.com", subject: "Re: Hi", body_plain: "two", sent_at: sentAt, type: "Received" },
            //Neither of these has happened, so neither is a touchpoint.
            { id: "email-3", sender: "rep@x.com", recipient: "ada@example.com", subject: "Later", body_plain: "three", sent_at: sentAt, type: "Scheduled" },
            { id: "email-4", sender: "rep@x.com", recipient: "ada@example.com", subject: "Nope", body_plain: "four", sent_at: sentAt, type: "Failed" },
          ],
        });
      }
      if (url.includes("/email-inbox/threads")) {
        return jsonResponse({
          items: [{ thread_hash: "thread-1", prospect_lead_email: "ada@example.com", last_email_timestamp: sentAt }],
          next_cursor: null,
        });
      }
      //No Attio person has the address, so the run reaches the counting gate and stops there.
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await outfoundSync(cronRequest());
      expect(response.status).toBe(200);
      //Two of the four: Scheduled and Failed are not traffic that happened.
      expect(await response.json()).toMatchObject({ success: true, threadsScanned: 1, emailsFound: 2, skipped: 2 });
    } finally {
      mock.restore();
    }
  });

  //[STABILITY] A thread that cannot be read is reported but must not cost the window, and the cursor never
  //passed it, so it is retried next run - unlike a failed EMAIL, which is passed over for good.
  test("Outfound passes over a thread whose messages cannot be read", async () => {
    const sentAt = new Date(Date.now() - 60 * 1000).toISOString();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("/emails")) return jsonResponse({ detail: "boom" }, 500);
      if (url.includes("/email-inbox/threads")) {
        return jsonResponse({
          items: [{ thread_hash: "thread-1", prospect_lead_email: "ada@example.com", last_email_timestamp: sentAt }],
          next_cursor: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await outfoundSync(cronRequest());
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({ success: false, threadsScanned: 1, emailsFound: 0, failed: 1 });
      expect(String(body.errors[0])).toContain("thread-1");
    } finally {
      mock.restore();
    }
  });

  //[STABILITY] Unique to this sync: the expansion is one request per thread, so the budget has to stop it too.
  //A run killed inside an unbudgeted expansion would save no cursor at all and redo the same window forever.
  test("Outfound stops inside the thread expansion and refuses to park the cursor", async () => {
    process.env.OUTFOUND_SYNC_BUDGET_MS = "2";
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const sentAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const mock = installFetchMock(async (url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "outfound-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      //Real elapsed time, because the budget is wall-clock and every other mock here answers instantly.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({
        items: [{ thread_hash: "thread-1", prospect_lead_email: "ada@example.com", last_email_timestamp: sentAt }],
        next_cursor: null,
      });
    });
    try {
      const response = await outfoundSync(cronRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      //Nothing was expanded, so nothing was even seen - and the cursor must not claim otherwise.
      expect(body).toMatchObject({ success: true, truncated: true, stopReason: "budget", threadsScanned: 1, threadsExpanded: 0, threadsRemaining: 1 });
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  //[STABILITY] The Outfound client key is rate-limited per key, not per organization - the dashboard's headline
  //number is the org ceiling. Throttling is therefore a normal condition on a backlog, and the run must stop on
  //it rather than spend the rest of the window on requests that will also be refused.
  test("Outfound stops when throttled instead of marching through the rest of the backlog", async () => {
    const sentAt = new Date(Date.now() - 60 * 1000).toISOString();
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    let threadReads = 0;
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "outfound-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("/emails")) {
        threadReads += 1;
        return jsonResponse({ detail: "rate limit exceeded" }, 429);
      }
      if (url.includes("/email-inbox/threads")) {
        return jsonResponse({
          items: [1, 2, 3, 4, 5].map((id) => ({
            thread_hash: `thread-${id}`,
            prospect_lead_email: `lead${id}@example.com`,
            last_email_timestamp: sentAt,
          })),
          next_cursor: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await outfoundSync(cronRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ success: true, truncated: true, stopReason: "throttled", threadsRemaining: 5 });
      //The whole point: it gave up after the FIRST refusal rather than trying all five.
      expect(threadReads).toBe(1);
      //A throttled thread wrote nothing, so it is not a failure - it is work deferred.
      expect(body.failed).toBe(0);
      //And the cursor must not be parked, or the four unopened threads would be skipped for good.
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });

  test("Outfound stops on the run budget and leaves the cursor where the loop reached", async () => {
    process.env.OUTFOUND_SYNC_BUDGET_MS = "30";
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const sentAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const mock = installFetchMock(async (url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "outfound-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      //The reads are instant, so the expansion finishes inside the budget and the LOOP is what overruns.
      if (url.includes("/emails")) {
        return jsonResponse({
          items: [1, 2].map((id) => ({
            id: `email-${id}`,
            sender: "rep@x.com",
            recipient: "ada@example.com",
            subject: "Hi",
            body_plain: "body",
            sent_at: sentAt,
            type: "Sent",
          })),
        });
      }
      if (url.includes("/email-inbox/threads")) {
        return jsonResponse({
          items: [{ thread_hash: "thread-1", prospect_lead_email: "ada@example.com", last_email_timestamp: sentAt }],
          next_cursor: null,
        });
      }
      //Real elapsed time, spent per event, so the budget expires partway through the loop.
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await outfoundSync(cronRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      //Both threads expanded, but the loop only got through one of the two emails.
      expect(body).toMatchObject({ success: true, truncated: true, stopReason: "budget", threadsExpanded: 1, emailsFound: 2, emailsRemaining: 1 });
      //Left where the loop reached - past the email it handled, so that one is not replayed - and NOT parked at
      //now, so the email it never reached stays above the mark and is picked up next run.
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(sentAt));
      expect(Date.parse(body.cursorTimestamp)).toBeGreaterThan(Date.parse(cursorSavedAt));
      expect(Date.parse(body.cursorTimestamp)).toBeLessThan(Date.now() - 60 * 1000);
    } finally {
      mock.restore();
    }
  });

  test("HeyReach stops on the run budget and leaves the cursor where the loop reached", async () => {
    //HeyReach is the likeliest of the three to need this: it re-reads every conversation touched since UTC
    //midnight on every run, so its cost grows through the day.
    process.env.HEYREACH_SYNC_BUDGET_MS = "2";
    const cursorSavedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const sentAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const mock = installFetchMock(async (url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "heyreach-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({
        items: [
          {
            id: "conversation-1",
            linkedInAccountId: 7,
            lastMessageAt: sentAt,
            correspondentProfile: { linkedin_id: "ada", profileUrl: "https://linkedin.com/in/ada" },
            messages: [1, 2].map((id) => ({
              id: `message-${id}`,
              sender: "user",
              body: `hello ${id}`,
              createdAt: sentAt,
            })),
          },
        ],
        totalCount: 1,
      });
    });
    try {
      const response = await heyReachSync(cronRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ success: true, truncated: true, processed: 0 });
      expect(Date.parse(body.cursorTimestamp)).toBe(Date.parse(cursorSavedAt));
    } finally {
      mock.restore();
    }
  });
});
