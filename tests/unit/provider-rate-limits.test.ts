import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET as aircallSync } from "../../api/cron/aircall-touchpoint-sync.js";
import { POST as heyReachInterested } from "../../api/heyreach-interested.js";
import { GET as heyReachSync } from "../../api/cron/heyreach-touchpoint-sync.js";
import {
  AircallRateLimitError,
  fetchAircallCallWindow,
  fetchAircallCalls,
} from "../../lib/aircall.js";
import {
  fetchHeyReachConversationWindow,
  fetchHeyReachConversations,
  HeyReachRateLimitError,
  stopLeadInActiveCampaigns,
} from "../../lib/heyreach.js";
import { installFetchMock, jsonResponse, type FetchCall } from "./test-utils.js";

//=============================================================================================================
//HeyReach and Aircall carried the bug that killed the Instantly sync for five days: a 429 was an ordinary
//Error, so it escaped the window fetch - which runs BEFORE the event loop and before saveSyncCursor - and
//abandoned the run with its cursor untouched. The next run then re-read the same window and failed the same
//way, forever.
//
//Neither had tripped it, because their allowances are far higher than Instantly's 20 a minute: Aircall gives
//120 a minute per COMPANY, and HeyReach shares one pool across every endpoint. Higher is not the same as
//unreachable, and HeyReach in particular re-reads every conversation touched since UTC midnight on every run.
//
//The invariant is the same as Instantly's: a run that is throttled still SAVES ITS CURSOR.
//=============================================================================================================

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "AIRCALL_API_ID",
  "AIRCALL_API_TOKEN",
  "HEYREACH_API_KEY",
  "HEYREACH_WEBHOOK_SECRET",
  "CRON_SECRET",
  "ATTIO_API_KEY",
  "ATTIO_DEFAULT_DEAL_OWNER",
  "ATTIO_PERSON_AIRCALL_COUNTER_SLUG",
  "ATTIO_PERSON_HEYREACH_COUNTER_SLUG",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.AIRCALL_API_ID = "aircall-id";
  process.env.AIRCALL_API_TOKEN = "aircall-token";
  process.env.HEYREACH_API_KEY = "heyreach-key";
  process.env.HEYREACH_WEBHOOK_SECRET = "hook-secret";
  process.env.CRON_SECRET = "cron-secret";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.ATTIO_PERSON_AIRCALL_COUNTER_SLUG = "aircall_touchpoints";
  process.env.ATTIO_PERSON_HEYREACH_COUNTER_SLUG = "heyreach_touchpoints";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const TOO_MANY = { error: "Too Many Requests" };

function cronRequest(path: string): Request {
  return new Request(`https://example.com/api/cron/${path}`, {
    headers: { authorization: "Bearer cron-secret" },
  });
}

function cursorSaves(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter((call) => call.input.includes("supabase.co") && call.init?.method === "POST");
}

//-------------------------------------------------------------------------------------------------------
//A 429 with no Retry-After, which is what both providers were observed to send: probed live, each answered
//200 carrying no rate-limit header at all, so the transports cannot count on one arriving with the refusal
//either and must fall back to their own backoff.
//-------------------------------------------------------------------------------------------------------
const refused = () => jsonResponse(TOO_MANY, 429);

describe("HeyReach under a rate limit", () => {
  test("retries a 429 before giving up on it", async () => {
    let attempts = 0;
    const mock = installFetchMock(() => {
      attempts += 1;
      if (attempts < 3) return jsonResponse(TOO_MANY, 429);
      return jsonResponse({ items: [], hasNextPage: false });
    });
    try {
      const window = await fetchHeyReachConversationWindow({ fromMs: 0, toMs: Date.now() });
      //Cleared on the third attempt, so the caller never sees the refusal at all.
      expect(attempts).toBe(3);
      expect(window.stoppedBy).toBeNull();
    } finally {
      mock.restore();
    }
  });

  test("keeps the pages it read once the retries are spent", async () => {
    let page = 0;
    const mock = installFetchMock(() => {
      if (page >= 1) return jsonResponse(TOO_MANY, 429);
      page += 1;
      return jsonResponse({
        items: [
          //parseHeyReachConversation requires all of these - including a correspondentProfile carrying a
          //profileUrl. Without them the page throws and the test exercises the parser, not the rate limit.
          {
            id: "c1",
            linkedInAccountId: 7,
            lastMessageAt: "2026-09-20T10:00:00Z",
            correspondentProfile: { profileUrl: "https://linkedin.com/in/ada" },
            messages: [],
          },
        ],
        hasNextPage: true,
        nextCursor: "next",
      });
    });
    try {
      const window = await fetchHeyReachConversationWindow({ fromMs: 0, toMs: Date.now() });
      expect(window.conversations).toHaveLength(1);
      expect(window.stoppedBy).toBe("throttled");
    } finally {
      mock.restore();
    }
  });

  test("still raises anything that is not a rate limit", async () => {
    //A 500 says nothing about how much of the window exists; parking past it would lose the rest for good.
    const mock = installFetchMock(() => jsonResponse({ error: "boom" }, 500));
    try {
      await expect(fetchHeyReachConversationWindow({ fromMs: 0, toMs: Date.now() })).rejects.toThrow("500");
    } finally {
      mock.restore();
    }
  });

  test("refuses to hand a half-read thread to the interested note", async () => {
    let page = 0;
    const mock = installFetchMock(() => {
      if (page >= 1) return jsonResponse(TOO_MANY, 429);
      page += 1;
      return jsonResponse({ items: [], hasNextPage: true, nextCursor: "next" });
    });
    try {
      await expect(
        fetchHeyReachConversations({ profileUrl: "https://linkedin.com/in/ada" }),
      ).rejects.toBeInstanceOf(HeyReachRateLimitError);
    } finally {
      mock.restore();
    }
  });

  test("retries the suppression write too, because a refused request was never processed", async () => {
    //StopLeadInCampaign is the only write on this transport. A 429 means it did not happen, so repeating it
    //cannot withdraw a lead twice - the same reasoning that lets attioFetch retry a 429 on any method.
    let stopAttempts = 0;
    const mock = installFetchMock((url) => {
      if (url.includes("GetCampaignsForLead")) {
        return jsonResponse({
          items: [{ campaignId: 1, campaignStatus: "IN_PROGRESS", leadStatus: "InSequence" }],
        });
      }
      stopAttempts += 1;
      if (stopAttempts < 2) return jsonResponse(TOO_MANY, 429);
      return jsonResponse({});
    });
    try {
      const result = await stopLeadInActiveCampaigns("https://linkedin.com/in/ada", null);
      expect(stopAttempts).toBe(2);
      expect(result.removedFrom).toBe(1);
    } finally {
      mock.restore();
    }
  });
});

describe("Aircall under a rate limit", () => {
  test("keeps the pages it read once the retries are spent", async () => {
    let page = 0;
    const mock = installFetchMock(() => {
      if (page >= 1) return jsonResponse(TOO_MANY, 429);
      page += 1;
      return jsonResponse({
        calls: [
          {
            id: 1,
            status: "done",
            direction: "outbound",
            raw_digits: "+1 555-555-0123",
            started_at: 1_700_000_000,
            ended_at: 1_700_000_060,
            duration: 60,
            tags: [],
            contact: null,
          },
        ],
        meta: { next_page_link: "https://api.aircall.io/v1/calls?page=2" },
      });
    });
    try {
      const window = await fetchAircallCallWindow(0, Date.now());
      expect(window.calls).toHaveLength(1);
      expect(window.stoppedBy).toBe("throttled");
    } finally {
      mock.restore();
    }
  });

  test("waits the reset header out when Aircall sends one", async () => {
    //Documented only as "timestamp when the counter will be reset", with no unit - so epoch seconds is tried
    //first and a value that lands in the past or more than a minute out is discarded for the backoff instead.
    let attempts = 0;
    const mock = installFetchMock(() => {
      attempts += 1;
      if (attempts < 2) {
        return new Response(JSON.stringify(TOO_MANY), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-aircallapi-reset": String(Math.floor(Date.now() / 1_000) + 1),
          },
        });
      }
      return jsonResponse({ calls: [], meta: { next_page_link: null } });
    });
    try {
      const window = await fetchAircallCallWindow(0, Date.now());
      expect(attempts).toBe(2);
      expect(window.stoppedBy).toBeNull();
    } finally {
      mock.restore();
    }
  });

  test("the all-or-nothing form still raises, for callers with no cursor to resume from", async () => {
    const mock = installFetchMock(refused);
    try {
      await expect(fetchAircallCalls(0, Date.now())).rejects.toBeInstanceOf(AircallRateLimitError);
    } finally {
      mock.restore();
    }
  });
});

describe("a throttled sync still saves its cursor", () => {
  //THE REGRESSION TESTS. Everything above is mechanism; this is the property that was actually broken.
  test("HeyReach", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.heyreach.io")) return jsonResponse(TOO_MANY, 429);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await heyReachSync(cronRequest("heyreach-touchpoint-sync"));
      const body = (await response.json()) as { success?: boolean; stopReason?: string };
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.stopReason).toBe("window-throttled");
      expect(cursorSaves(mock.calls)).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("Aircall", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.aircall.io")) return jsonResponse(TOO_MANY, 429);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallSync(cronRequest("aircall-touchpoint-sync"));
      const body = (await response.json()) as { success?: boolean; stopReason?: string };
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.stopReason).toBe("window-throttled");
      expect(cursorSaves(mock.calls)).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("and names the provider that refused, not Attio", async () => {
    //The summary used to be a two-branch ternary, so any stop that was not "budget" printed "stopped by Attio
    //throttling" - which would send whoever read it to the wrong dashboard entirely.
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.heyreach.io")) return jsonResponse(TOO_MANY, 429);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      await heyReachSync(cronRequest("heyreach-touchpoint-sync"));
      const summary = lines.find((line) => line.includes("[run] heyreach sync:"));
      expect(summary).toContain("HeyReach throttled the window read");
      expect(summary).not.toContain("Attio throttling");
    } finally {
      console.warn = warn;
      mock.restore();
    }
  });
});

describe("an interested lead arriving while HeyReach is throttling", () => {
  test("is recorded without its thread rather than lost", async () => {
    //The same shape api/instantly-interested.ts already had. One route degrading while its twin 500s is the
    //kind of difference nobody finds until the day it matters.
    const mock = installFetchMock((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("api.heyreach.io")) return jsonResponse(TOO_MANY, 429);
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
      if (url.includes("objects/people/records")) {
        return jsonResponse({
          data: { id: { record_id: "person-1" }, values: { associated_deals: [], company: [], name: [] } },
        });
      }
      if (url.includes("objects/deals/records")) {
        return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
      }
      if (url.includes("/notes")) {
        return method === "GET" ? jsonResponse({ data: [] }) : jsonResponse({ data: {} });
      }
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
      if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await heyReachInterested(
        new Request("https://example.com/api/heyreach-interested", {
          method: "POST",
          headers: { "content-type": "application/json", "x-webhook-secret": "hook-secret" },
          body: JSON.stringify({
            eventType: "LEAD_AUTO_TAGGED_POSITIVE",
            lead: { profileUrl: "https://www.linkedin.com/in/ada", firstName: "Ada", lastName: "Lovelace" },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, personId: "person-1" });

      //The note says the history could not be READ, which is not the same as there being none - the reader is
      //looking for the reply and needs to know it exists somewhere.
      const note = mock.calls.find(
        (call) => call.input.includes("/notes") && call.init?.method === "POST",
      );
      const body = JSON.parse(String(note?.init?.body)) as { data?: { content?: string } };
      expect(body.data?.content).toContain("could not be read");
      expect(body.data?.content).not.toContain("No message history found");
    } finally {
      mock.restore();
    }
  });

  test("still fails on anything that is not a rate limit", async () => {
    //An unreachable API is not a reason to record a lead with half its detail and no sign anything went wrong.
    const mock = installFetchMock((url) => {
      if (url.includes("api.heyreach.io")) return jsonResponse({ error: "boom" }, 500);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await heyReachInterested(
        new Request("https://example.com/api/heyreach-interested", {
          method: "POST",
          headers: { "content-type": "application/json", "x-webhook-secret": "hook-secret" },
          body: JSON.stringify({ lead: { profileUrl: "https://www.linkedin.com/in/ada" } }),
        }),
      );
      expect(response.status).toBe(500);
    } finally {
      mock.restore();
    }
  });
});
