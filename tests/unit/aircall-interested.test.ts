import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST as aircallInterested } from "../../api/aircall-interested.js";
import { historyNoteCalls, installFetchMock, jsonResponse, notesResponse } from "./test-utils.js";

const envNames = [
  "AIRCALL_API_ID",
  "AIRCALL_API_TOKEN",
  "AIRCALL_WEBHOOK_TOKEN",
  "ATTIO_API_KEY",
  "ATTIO_DEFAULT_DEAL_OWNER",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

//Where @vercel/functions looks for the platform's request context. Outside Vercel it finds nothing and
//waitUntil does nothing, so the tests install a fake one that captures the background job instead.
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
let backgroundJobs: Promise<unknown>[] = [];

beforeEach(() => {
  process.env.AIRCALL_API_ID = "aircall-id";
  process.env.AIRCALL_API_TOKEN = "aircall-token";
  process.env.AIRCALL_WEBHOOK_TOKEN = "hook-token";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  backgroundJobs = [];
  (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
    get: () => ({ waitUntil: (job: Promise<unknown>) => void backgroundJobs.push(job) }),
  };
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
});

const CONNECTED = "019fd21c-5b09-70fc-9356-cfd01be98477";
const NO_ANSWER = "019fd21b-f18f-7216-9926-7322e3b36f14";
const CAMPAIGN = "019ffb76-4aaa-762f-85e0-056e3a13729c";

/** An outcome_recorded body shaped exactly like a real delivery, with the outcome and token overridable. */
function outcomeWebhook(outcomeId: string, outcomeLabel: string, token = "hook-token") {
  return {
    resource: "outbound_campaign",
    event: "outbound_campaign.outcome_recorded",
    timestamp: 1791472316,
    token,
    data: { call_id: 4223079424, campaign_id: CAMPAIGN, outcome_id: outcomeId, outcome_label: outcomeLabel },
  };
}

function webhookRequest(body: unknown): Request {
  return new Request("https://example.com/api/aircall-interested", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

//---------------------------------------------------------------------------------------------------------
//Mocks Aircall's two reads and everything the shared workflow asks of Attio. The call has no address-book
//contact, as a dialled campaign call usually does not; the campaign contact supplies the name and company.
//No email anywhere, so the email-keyed suppression channels skip and only the Attio DNC list is written.
//---------------------------------------------------------------------------------------------------------
function mockAircallAndAttio() {
  return installFetchMock((url, init) => {
    if (url.includes("api.aircall.io/v1/calls/4223079424")) {
      return jsonResponse({
        call: {
          id: 4223079424,
          status: "done",
          direction: "outbound",
          raw_digits: "+1 215-888-8732",
          started_at: 1791472200,
          ended_at: 1791472290,
          duration: 90,
          contact: null,
        },
      });
    }
    if (url.includes(`api.aircall.io/v1/campaigns/${CAMPAIGN}/contacts`)) {
      return jsonResponse({
        contacts: [
          { phone_number: "12158888732", first_name: "Ada", last_name: "Lovelace", email: null, company_name: "Engines Ltd", note: null },
        ],
      });
    }
    if (url.includes("objects/people/records/query")) {
      return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: { associated_deals: [] } }] });
    }
    if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
    if (url.includes("objects/") && init?.method === "PATCH") return jsonResponse({ data: {} });
    if (url.includes("objects/people/records/person-1")) return jsonResponse({ data: {} });
    if (url.includes("objects/companies/records")) {
      return jsonResponse({ data: { id: { record_id: "company-1" }, values: { name: [{ value: "Engines Ltd" }] } } });
    }
    if (url.includes("objects/deals/records")) return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
    if (url.includes("/notes")) return notesResponse(init);
    if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("aircall-interested route", () => {
  test("rejects a webhook whose token does not match, before any external call", async () => {
    const mock = installFetchMock((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallInterested(webhookRequest(outcomeWebhook(CONNECTED, "Connected", "wrong")));
      expect(response.status).toBe(401);
      expect(mock.calls).toHaveLength(0);
      expect(backgroundJobs).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("acknowledges an uninteresting outcome with a 200 and does nothing else", async () => {
    //Most deliveries are these. A 200 matters: anything else, Aircall resends and eventually disables the webhook.
    const mock = installFetchMock((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallInterested(webhookRequest(outcomeWebhook(NO_ANSWER, "No Answer")));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ignored: true, reason: "not an interested outcome" });
      expect(mock.calls).toHaveLength(0);
      expect(backgroundJobs).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("acknowledges another event type and an outcome event missing its fields, both with a 200", async () => {
    const mock = installFetchMock((url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const other = await aircallInterested(
        webhookRequest({ event: "outbound_campaign.status_changed", token: "hook-token", data: {} }),
      );
      expect(other.status).toBe(200);
      expect(await other.json()).toMatchObject({ ignored: true, reason: "not an outcome event" });

      const incomplete = await aircallInterested(
        webhookRequest({ event: "outbound_campaign.outcome_recorded", token: "hook-token", data: { outcome_id: CONNECTED } }),
      );
      expect(incomplete.status).toBe(200);
      expect(await incomplete.json()).toMatchObject({ ignored: true });
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("replies before the work, then records the lead in the background", async () => {
    const mock = mockAircallAndAttio();
    try {
      const response = await aircallInterested(webhookRequest(outcomeWebhook(CONNECTED, "Connected")));
      //The reply is ready before any request has gone out - that is the whole point of waitUntil.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true, callId: 4223079424 });
      expect(backgroundJobs).toHaveLength(1);

      await Promise.all(backgroundJobs);
      //The call is read for the dialled number, and the campaign contact is looked up by it, in E.164.
      expect(mock.calls[0]?.input).toContain("/v1/calls/4223079424");
      expect(mock.calls[1]?.input).toContain(`/v1/campaigns/${CAMPAIGN}/contacts?phone_number=%2B12158888732`);
      //Then the shared workflow: a deal, the history note on the Person and on the Deal, the DNC listing.
      expect(mock.calls.some((call) => call.input.includes("objects/deals/records"))).toBe(true);
      const notes = historyNoteCalls(mock.calls);
      expect(notes).toHaveLength(2);
      expect(String(notes[0]?.init?.body)).toContain("Outcome: Connected");
      expect(mock.calls.some((call) => call.input.includes("/lists/dnc/entries"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("a background failure is logged and never escapes, since Aircall has already been told OK", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    const mock = installFetchMock(() => jsonResponse({ message: "boom" }, 500));
    try {
      const response = await aircallInterested(webhookRequest(outcomeWebhook(CONNECTED, "Connected")));
      expect(response.status).toBe(200);
      //Resolves rather than rejects: an error escaping a background job would have nothing left to catch it.
      await expect(Promise.all(backgroundJobs)).resolves.toBeDefined();
      expect(errors.some((line) => line.includes("call 4223079424: FAILED after Aircall was told OK"))).toBe(true);
    } finally {
      console.error = original;
      mock.restore();
    }
  });
});
