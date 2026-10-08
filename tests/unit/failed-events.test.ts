import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET as aircallSync } from "../../api/cron/aircall-touchpoint-sync.js";
import { installFetchMock, jsonResponse, noteWrites, notesResponse, type FetchCall } from "./test-utils.js";

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "AIRCALL_API_ID",
  "AIRCALL_API_TOKEN",
  "CRON_SECRET",
  "ATTIO_API_KEY",
  "ATTIO_PERSON_AIRCALL_COUNTER_SLUG",
  "ATTIO_COMPANY_AIRCALL_COUNTER_SLUG",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.AIRCALL_API_ID = "aircall-id";
  process.env.AIRCALL_API_TOKEN = "aircall-token";
  process.env.CRON_SECRET = "cron-secret";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_PERSON_AIRCALL_COUNTER_SLUG = "number_of_calls";
  process.env.ATTIO_COMPANY_AIRCALL_COUNTER_SLUG = "number_of_calls";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const DOOMED_PHONE = "+15555550001";
const HEALTHY_PHONE = "+15555550002";

/** Two calls in one window: the first belongs to a company whose counter write is rejected, the second is fine. */
const AIRCALL_PAGE = {
  calls: [
    {
      id: 1,
      status: "done",
      direction: "outbound",
      raw_digits: DOOMED_PHONE,
      started_at: NOW_SECONDS - 400,
      ended_at: NOW_SECONDS - 300,
      duration: 42,
    },
    {
      id: 2,
      status: "done",
      direction: "inbound",
      raw_digits: HEALTHY_PHONE,
      started_at: NOW_SECONDS - 250,
      ended_at: NOW_SECONDS - 200,
      duration: 90,
    },
  ],
  meta: { next_page_link: null },
};

function personPage(recordId: string, companyId: string) {
  return {
    data: [
      {
        id: { record_id: recordId },
        values: {
          associated_deals: [],
          company: [{ target_record_id: companyId }],
          name: [{ full_name: "Ada Lovelace" }],
        },
      },
    ],
  };
}

function aircallMock(cursorRow?: unknown) {
  return installFetchMock((url, init) => {
    if (url.includes("supabase.co")) {
      if (init?.method === "POST") return new Response(null, { status: 204 });
      return jsonResponse(cursorRow === undefined ? [] : [cursorRow]);
    }
    if (url.includes("api.aircall.io")) return jsonResponse(AIRCALL_PAGE);

    if (url.includes("objects/people/records/query")) {
      const body = String(init?.body);
      return jsonResponse(
        body.includes(DOOMED_PHONE) ? personPage("person-1", "company-1") : personPage("person-2", "company-2"),
      );
    }
    if (url.includes("/entries")) return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
    if (url.includes("objects/people/records/")) {
      return init?.method === "PATCH"
        ? jsonResponse({})
        : jsonResponse({ data: { id: { record_id: "record-1" }, values: { number_of_calls: [] } } });
    }
    if (url.includes("objects/companies/records/company-1")) {
      // The write that fails, and keeps failing, for call 1.
      return init?.method === "PATCH"
        ? jsonResponse({ error: "attio rejected this record" }, 500)
        : jsonResponse({ data: { id: { record_id: "record-1" }, values: { number_of_calls: [{ value: 3 }] } } });
    }
    if (url.includes("objects/companies/records/company-2")) {
      return init?.method === "PATCH"
        ? jsonResponse({})
        : jsonResponse({ data: { id: { record_id: "record-1" }, values: { number_of_calls: [{ value: 5 }] } } });
    }
    if (url.includes("/notes")) return notesResponse(init);
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const cronRequest = (): Request =>
  new Request("https://example.com/api/cron/aircall-touchpoint-sync", {
    headers: { Authorization: "Bearer cron-secret" },
  });

const savedCursor = (calls: readonly FetchCall[]): Record<string, unknown> => {
  const writes = calls.filter((call) => call.input.includes("supabase.co") && call.init?.method === "POST");
  return JSON.parse(String(writes[writes.length - 1]?.init?.body)) as Record<string, unknown>;
};

describe("a touchpoint that fails mid-flight", () => {
  test("does not stop the run, and the later events in the same window still land", async () => {
    const mock = aircallMock();
    try {
      const response = await aircallSync(cronRequest());
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        callsFound: 2,
        processed: 1,
        failed: 1,
      });

      // Call 2 was reached and completed even though call 1 blew up first.
      const company2Patches = mock.calls.filter(
        (call) => call.input.includes("objects/companies/records/company-2") && call.init?.method === "PATCH",
      );
      expect(company2Patches).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("advances the cursor past itself so it is never attempted again", async () => {
    const mock = aircallMock();
    try {
      await aircallSync(cronRequest());
      const cursor = savedCursor(mock.calls);
      const savedMs = Date.parse(String(cursor.cursor_timestamp));

      // Past the failed call, and past the healthy one after it.
      expect(savedMs).toBeGreaterThan((NOW_SECONDS - 300) * 1000);
      expect(savedMs).toBeGreaterThan((NOW_SECONDS - 200) * 1000);
    } finally {
      mock.restore();
    }
  });

  test("is not retried on the next run, which begins after it", async () => {
    const first = aircallMock();
    let carriedCursor: Record<string, unknown>;
    try {
      await aircallSync(cronRequest());
      carriedCursor = savedCursor(first.calls);
    } finally {
      first.restore();
    }

    const second = aircallMock({
      sync_key: "aircall-touchpoints",
      cursor_value: carriedCursor.cursor_value,
      cursor_timestamp: carriedCursor.cursor_timestamp,
    });
    try {
      const response = await aircallSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, processed: 0, failed: 0 });

      // The doomed call is behind the cursor, so nothing was written for it a second time.
      const retried = second.calls.filter((call) => call.input.includes("objects/companies/records/company-1"));
      expect(retried).toHaveLength(0);
      expect(noteWrites(second.calls)).toHaveLength(0);
    } finally {
      second.restore();
    }
  });

  test("reports which events were passed over so they can be reconciled by hand", async () => {
    const mock = aircallMock();
    try {
      const response = await aircallSync(cronRequest());
      const body = (await response.json()) as { errors?: readonly string[] };
      expect(body.errors).toHaveLength(1);
      expect(body.errors?.[0]).toContain("Call 1");
    } finally {
      mock.restore();
    }
  });
});
