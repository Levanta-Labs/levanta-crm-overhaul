import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchAircallCalls, formatCallDuration, parseAircallCall } from "../../lib/aircall.js";
import { toE164 } from "../../lib/phone.js";
import {
  fetchHeyReachConversations,
  heyReachMessageId,
  parseHeyReachConversation,
  stopLeadInActiveCampaigns,
} from "../../lib/heyreach.js";
import { fetchInstantlyEmails, parseInstantlyEmail } from "../../lib/instantly.js";
import {
  fetchOutfoundLead,
  outfoundNaiveUtc,
  fetchOutfoundThreadEmails,
  fetchOutfoundThreads,
  parseOutfoundEmail,
  parseOutfoundLead,
} from "../../lib/outfound.js";
import { attributionOptionIds, attributionValues, PROVIDERS } from "../../lib/providers.js";
import { dealValuesFor, interestedLead, personValuesFor } from "../../lib/interested.js";
import { installFetchMock, jsonResponse } from "./test-utils.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.AIRCALL_API_ID = "id";
  process.env.AIRCALL_API_TOKEN = "token";
  process.env.INSTANTLY_API_KEY = "instantly";
  process.env.HEYREACH_API_KEY = "heyreach";
  process.env.OUTFOUND_API_KEY = "outfound";
});

afterEach(() => {
  for (const name of ["AIRCALL_API_ID", "AIRCALL_API_TOKEN", "INSTANTLY_API_KEY", "HEYREACH_API_KEY", "OUTFOUND_API_KEY"]) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const aircallCall = {
  id: 42,
  status: "done",
  direction: "outbound",
  raw_digits: "+15555550123",
  started_at: 1_700_000_000,
  ended_at: 1_700_000_120,
  duration: 120,
  tags: [{ name: "Interested" }],
  contact: {
    first_name: "Ada",
    last_name: "Lovelace",
    company_name: "Analytical Engines",
    emails: [{ value: "ada@example.com" }],
  },
};

const instantlyEmail = {
  id: "email-1",
  timestamp_created: "2026-08-19T11:54:36.149Z",
  timestamp_email: "2026-08-19T11:53:36.149Z",
  ue_type: 2,
  is_auto_reply: 0,
  lead: "ada@example.com",
  subject: "Re: Hello",
  body: { text: "Interested", html: "<p>Interested</p>" },
  thread_id: "thread-1",
};

//Instantly composes its own outbound mail as HTML and sends no plain-text alternative - `body` really does
//carry `html` and nothing else. Copied from a live /emails response.
const instantlySentEmail = {
  id: "email-2",
  timestamp_created: "2026-09-11T14:31:04.000Z",
  timestamp_email: "2026-09-11T14:31:04.000Z",
  ue_type: 1,
  is_auto_reply: 0,
  lead: "roshen.mathew@sscgmedia.com",
  subject: "Re: a bottle of Macallan?",
  body: {
    html:
      "<div>Hi Roshen,</div><div><br /></div>" +
      "<div>Up to 2–3× delivery capacity in &lt;3 months.</div><div><br /></div>" +
      '<div>Cheers,<br /><br /></div><div><div>Victor Vargatu<br style="caret-color:rgb(0, 0, 0)" />CEO @ Levanta Labs Inc</div></div>',
  },
  thread_id: "thread-2",
};

const heyReachConversation = {
  id: "conversation-1",
  linkedInAccountId: 12,
  lastMessageAt: "2026-08-19T12:00:00.000Z",
  correspondentProfile: {
    linkedin_id: "linkedin-1",
    profileUrl: "https://linkedin.com/in/ada",
    firstName: "Ada",
    lastName: "Lovelace",
    companyName: "Analytical Engines",
  },
  messages: [
    { createdAt: "2026-08-19T12:00:00.000Z", body: "Hello", subject: null, sender: "LEAD" },
  ],
};

describe("Aircall client", () => {
  test("parses the documented call fields", () => {
    const call = parseAircallCall(aircallCall);
    expect(call.rawDigits).toBe("+15555550123");
    expect(call.contact?.email).toBe("ada@example.com");
    expect(call.tags).toEqual([{ name: "Interested" }]);
  });

  test("normalises the punctuated raw_digits Aircall sends into the E.164 Attio matches on", () => {
    //Every shape seen across a 300-call sample, US and international.
    expect(toE164("+1 949-735-4000")).toBe("+19497354000");
    expect(toE164("+44 7812 661348")).toBe("+447812661348");
    expect(toE164("+353 87 258 4998")).toBe("+353872584998");
    expect(toE164("+19497354000")).toBe("+19497354000");
    expect(toE164(null)).toBeNull();
    expect(toE164("")).toBeNull();
    //A "+" anywhere but the front is discarded with the rest of the punctuation, never carried into the result.
    expect(toE164("555+1234567")).toBe("+5551234567");
    //Too short to dial and too long to be a number: a fragment, not something to write into the CRM.
    expect(toE164("555-0123")).toBeNull();
    expect(toE164("+1234567890123456")).toBeNull();
  });

  test("reports a call's length in seconds, so a short call is not rendered as no call", () => {
    //The whole point of the format: Aircall's duration counts ringing as well as talking and a dialled call
    //runs a median ~18s, so whole minutes rounded almost every real call to "0 min".
    expect(formatCallDuration(18)).toBe("18s");
    expect(formatCallDuration(29)).toBe("29s");
    expect(formatCallDuration(66)).toBe("1m 6s");
    expect(formatCallDuration(120)).toBe("2m");
    expect(formatCallDuration(310)).toBe("5m 10s");
    //No length to report is said outright rather than printed as a zero-length call.
    expect(formatCallDuration(0)).toBe("unknown");
    expect(formatCallDuration(-1)).toBe("unknown");
  });

  test("follows Aircall next_page_link pagination", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ calls: [aircallCall], meta: { next_page_link: "https://api.aircall.io/v1/calls?page=2" } })
        : jsonResponse({ calls: [], meta: { next_page_link: null } }),
    );
    try {
      expect(await fetchAircallCalls(1_699_999_000_000, 1_700_001_000_000)).toHaveLength(1);
      expect(mock.calls).toHaveLength(2);
      expect(new Headers(mock.calls[0]?.init?.headers).get("authorization")).toBe("Basic aWQ6dG9rZW4=");
    } finally {
      mock.restore();
    }
  });
});

describe("Instantly client", () => {
  test("parses the current v2 email schema", () => {
    expect(parseInstantlyEmail(instantlyEmail)).toMatchObject({
      id: "email-1",
      emailType: "received",
      leadEmail: "ada@example.com",
      bodyText: "Interested",
    });
  });

  //[STABILITY] Not cosmetic. Instantly sends `body: { html }` with no `text` key for its own outbound mail, so
  //reading `text` alone made every sent touchpoint a note reading "(no content)". Regression guard for that.
  test("reads a sent email's body from the HTML, which is the only body Instantly gives it", () => {
    expect(parseInstantlyEmail(instantlySentEmail).bodyText).toBe(
      "Hi Roshen,\n\nUp to 2\u20133\u00d7 delivery capacity in <3 months.\n\nCheers,\n\nVictor Vargatu\nCEO @ Levanta Labs Inc",
    );
  });

  test("prefers the plain-text body when the sender's client supplied one", () => {
    const withBoth = { ...instantlyEmail, body: { text: "Interested", html: "<div>something else</div>" } };
    expect(parseInstantlyEmail(withBoth).bodyText).toBe("Interested");
  });

  test("reads a body holding only markup as no body at all, rather than as an empty note", () => {
    expect(parseInstantlyEmail({ ...instantlyEmail, body: { html: "<div><br></div>" } }).bodyText).toBeNull();
    expect(parseInstantlyEmail({ ...instantlyEmail, body: {} }).bodyText).toBeNull();
  });

  //A <head> is machine text: unstripped, Outlook's charset <meta> would head every reply note.
  test("drops head, style and script contents instead of unwrapping them into the note", () => {
    const html = '<html><head><meta charset="us-ascii"></head><style>p{color:red}</style><body>Hello&nbsp;there</body></html>';
    expect(parseInstantlyEmail({ ...instantlyEmail, body: { html } }).bodyText).toBe("Hello there");
  });

  test("decodes entities after stripping tags, so escaped markup survives as text", () => {
    const html = "<div>Use &lt;div&gt; &amp; &quot;quotes&quot; &#39;here&#39; &#x2014; fine</div>";
    expect(parseInstantlyEmail({ ...instantlyEmail, body: { html } }).bodyText).toBe(
      "Use <div> & \"quotes\" 'here' \u2014 fine",
    );
  });

  test("uses documented timestamp, lead, ordering, and cursor parameters", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ items: [instantlyEmail], next_starting_after: "next" })
        : jsonResponse({ items: [], next_starting_after: null }),
    );
    try {
      const emails = await fetchInstantlyEmails({
        fromMs: Date.parse("2026-08-19T00:00:00.000Z"),
        toMs: Date.parse("2026-08-20T00:00:00.000Z"),
        leadEmail: "ada@example.com",
      });
      expect(emails).toHaveLength(1);
      const firstUrl = new URL(mock.calls[0]?.input ?? "");
      expect(firstUrl.searchParams.get("lead")).toBe("ada@example.com");
      expect(firstUrl.searchParams.get("sort_order")).toBe("asc");
      expect(firstUrl.searchParams.has("min_timestamp_created")).toBe(true);
      expect(new URL(mock.calls[1]?.input ?? "").searchParams.get("starting_after")).toBe("next");
    } finally {
      mock.restore();
    }
  });
});

describe("HeyReach client", () => {
  test("parses the GetConversationsV3 schema and creates stable message IDs", async () => {
    const conversation = parseHeyReachConversation(heyReachConversation);
    const message = conversation.messages[0];
    expect(message).toBeDefined();
    const first = await heyReachMessageId(conversation, message!);
    const second = await heyReachMessageId(conversation, message!);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  test("uses V3 cursor pagination and date filters", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ items: [heyReachConversation], totalCount: 1, hasNextPage: true, nextCursor: "cursor-2" })
        : jsonResponse({ items: [], totalCount: 1, hasNextPage: false, nextCursor: null }),
    );
    try {
      expect(await fetchHeyReachConversations({ fromMs: 1_700_000_000_000, toMs: 1_700_001_000_000 })).toHaveLength(1);
      const firstBody = JSON.parse(String(mock.calls[0]?.init?.body));
      const secondBody = JSON.parse(String(mock.calls[1]?.init?.body));
      expect(firstBody).toMatchObject({ limit: 100, cursor: null });
      expect(secondBody.cursor).toBe("cursor-2");
    } finally {
      mock.restore();
    }
  });

  test("mocks destructive campaign stops, only targets active leads, and reports both counts", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({
            items: [
              { campaignId: 10, campaignStatus: "IN_PROGRESS", leadStatus: "InSequence" },
              { campaignId: 11, campaignStatus: "FINISHED", leadStatus: "Finished" },
            ],
          })
        : new Response(null, { status: 200 }),
    );
    try {
      //Two campaigns list the lead, one of them still live: the pair the suppression line reports.
      expect(
        await stopLeadInActiveCampaigns("https://linkedin.com/in/ada", "ada@example.com"),
      ).toEqual({ inCampaigns: 2, removedFrom: 1 });
      expect(mock.calls).toHaveLength(2);
      expect(mock.calls[0]?.input).toEndWith("/campaign/GetCampaignsForLead");
      expect(mock.calls[1]?.input).toEndWith("/campaign/StopLeadInCampaign");
      expect(JSON.parse(String(mock.calls[1]?.init?.body))).toEqual({
        campaignId: 10,
        leadMemberId: null,
        leadUrl: "https://linkedin.com/in/ada",
      });
    } finally {
      mock.restore();
    }
  });
});

//=============================================================================================================
//Outfound. The shapes below are taken from the deployment's own OpenAPI spec
//(https://api.outfound.io/openapi-client.json), not invented.
//=============================================================================================================

const outfoundThread = {
  thread_hash: "thread-1",
  prospect_lead_email: "ada@example.com",
  prospect_first_name: "Ada",
  prospect_last_name: "Lovelace",
  campaign_name: "Q3 Outbound",
  last_email_timestamp: "2026-08-19T11:54:36.149Z",
  lead_category_name: "Interested",
  lead_category_sentiment: "positive",
};

const outfoundEmail = {
  id: "email-1",
  sender: "rep@levantalabs.com",
  recipient: "ada@example.com",
  subject: "Quick question",
  body_plain: "Are you the right person?",
  body_html: "<p>Are you the right person?</p>",
  sent_at: "2026-08-19T11:54:36.149Z",
  created_at: "2026-08-19T11:54:40.000Z",
  type: "Sent",
};

describe("Outfound client", () => {
  test("reads an email, preferring the plain body and the send time", () => {
    expect(parseOutfoundEmail(outfoundEmail, "thread-1")).toMatchObject({
      id: "email-1",
      threadHash: "thread-1",
      emailType: "Sent",
      subject: "Quick question",
      //body_html is deliberately dropped: a note is read as prose, not markup.
      bodyText: "Are you the right person?",
      //sent_at, not created_at - the warehouse records an email some time after it was sent.
      sentAt: "2026-08-19T11:54:36.149Z",
    });
  });

  test("falls back to created_at when an email carries no send time", () => {
    const { sent_at: _sentAt, ...withoutSentAt } = outfoundEmail;
    expect(parseOutfoundEmail(withoutSentAt, "thread-1").sentAt).toBe("2026-08-19T11:54:40.000Z");
  });

  test("rejects an email with no id, rather than counting it under a blank key", () => {
    expect(() => parseOutfoundEmail({ ...outfoundEmail, id: null }, "thread-1")).toThrow(/missing id/);
  });

  test("reads an unrecognised email type as unknown rather than guessing", () => {
    expect(parseOutfoundEmail({ ...outfoundEmail, type: "Bounced" }, "thread-1").emailType).toBe("unknown");
  });

  //[STABILITY] Not cosmetic. A timezone designator makes the thread listing answer HTTP 500 - see
  //outfoundNaiveUtc. This is the regression guard for that workaround.
  test("formats a window bound as naive UTC, because a designator makes the endpoint 500", () => {
    const ms = Date.parse("2026-09-02T13:58:30.198Z");
    expect(outfoundNaiveUtc(ms)).toBe("2026-09-02T13:58:30.198");
    expect(outfoundNaiveUtc(ms)).not.toContain("Z");
    expect(outfoundNaiveUtc(ms)).not.toContain("+");
    //UTC, not local: a bare local time would shift every window by the runner's offset without erroring.
    expect(Date.parse(`${outfoundNaiveUtc(ms)}Z`)).toBe(ms);
  });

  test("follows the thread cursor and bounds the window on the email timestamp", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ items: [outfoundThread], next_cursor: "next" })
        : jsonResponse({ items: [], next_cursor: null }),
    );
    try {
      const threads = await fetchOutfoundThreads({
        fromMs: Date.parse("2026-08-19T11:00:00.000Z"),
        toMs: Date.parse("2026-08-19T12:00:00.000Z"),
      });
      expect(threads).toHaveLength(1);
      expect(threads[0]?.threadHash).toBe("thread-1");
      expect(mock.calls).toHaveLength(2);
      //One millisecond back, so an email sitting exactly on the cursor is still returned. No trailing Z: a
      //timezone-aware bound makes this endpoint answer 500 - see outfoundNaiveUtc.
      expect(mock.calls[0]?.input).toContain("email_start_date=2026-08-19T10%3A59%3A59.999&");
      expect(mock.calls[0]?.input).toContain("email_end_date=2026-08-19T12%3A00%3A00.000");
      expect(mock.calls[0]?.input).not.toContain("%3A59.999Z");
      expect(mock.calls[1]?.input).toContain("cursor=next");
    } finally {
      mock.restore();
    }
  });

  test("reads a thread's messages, tagging each with the thread it came from", async () => {
    const mock = installFetchMock(() => jsonResponse({ items: [outfoundEmail] }));
    try {
      const emails = await fetchOutfoundThreadEmails("thread-1");
      expect(emails).toHaveLength(1);
      expect(emails[0]?.threadHash).toBe("thread-1");
      expect(mock.calls[0]?.input).toContain("/email-inbox/threads/thread-1/emails");
    } finally {
      mock.restore();
    }
  });

  test("flattens enrichment and conversations across every client the lead was worked by", () => {
    const lead = parseOutfoundLead({
      lead_email: "ada@example.com",
      enrichment: {
        first_name: "Ada",
        title: "CTO",
        seniority: "c_suite",
        person_linkedin: "https://www.linkedin.com/in/ada",
        company: {
          company_name: "Analytical Engines",
          company_domain: "engines.example",
          location: "GB",
          industry: "Software",
          headcount: "51-200",
          revenue: "10M",
        },
      },
      clients: [
        { recent_conversations: [{ id: "c1", thread_hash: "t1", timestamp_email: "2026-08-19T10:00:00Z" }] },
        { recent_conversations: [{ id: "c2", thread_hash: "t2", timestamp_email: "2026-08-19T11:00:00Z" }] },
      ],
    });
    expect(lead).toMatchObject({
      email: "ada@example.com",
      jobTitle: "CTO",
      linkedin: "https://www.linkedin.com/in/ada",
      companyDomain: "engines.example",
      headcount: "51-200",
      revenue: "10M",
    });
    //Both clients' threads, not just the first group's.
    expect(lead.conversations.map((conversation) => conversation.threadHash)).toEqual(["t1", "t2"]);
  });

  //[STABILITY] Enrichment is best-effort everywhere it is used, so "no such lead" must be null, not a throw.
  //The body below is the LIVE response for an address that cannot exist, copied verbatim. Note that lead_email
  //is echoed back regardless - testing that field would report a match for every address ever asked about.
  test("returns null for an address Outfound has never seen, despite it echoing the address back", async () => {
    const mock = installFetchMock(() =>
      jsonResponse({
        lead_email: "nobody@example.invalid",
        enrichment: null,
        clients: [],
        total_clients_contacted: 0,
        has_replies: false,
      }),
    );
    try {
      expect(await fetchOutfoundLead("nobody@example.invalid")).toBeNull();
    } finally {
      mock.restore();
    }
  });

  //Either half alone is something worth having, so neither may be read as a miss.
  test("treats a lead with conversations but no enrichment as a match", async () => {
    const mock = installFetchMock(() =>
      jsonResponse({
        lead_email: "ada@example.com",
        enrichment: null,
        clients: [{ recent_conversations: [{ id: "c1", thread_hash: "t1", timestamp_email: "2026-08-19T10:00:00Z" }] }],
      }),
    );
    try {
      const lead = await fetchOutfoundLead("ada@example.com");
      expect(lead?.conversations).toHaveLength(1);
      //And that thread hash is what the suppression channel keys on, so a miss here would silently stop
      //Outfound ever being suppressed for a lead it does hold.
      expect(lead?.conversations[0]?.threadHash).toBe("t1");
    } finally {
      mock.restore();
    }
  });

  test("treats a lead with enrichment but no conversations as a match", async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ lead_email: "ada@example.com", enrichment: { title: "CTO", company: {} }, clients: [] }),
    );
    try {
      expect((await fetchOutfoundLead("ada@example.com"))?.jobTitle).toBe("CTO");
    } finally {
      mock.restore();
    }
  });

  test("names OUTFOUND_API_KEY when Outfound rejects the credential", async () => {
    const mock = installFetchMock(() => jsonResponse({ detail: "nope" }, 401));
    try {
      await expect(fetchOutfoundThreadEmails("thread-1")).rejects.toThrow(/OUTFOUND_API_KEY/);
    } finally {
      mock.restore();
    }
  });
});



//=============================================================================================================
//Attribution. The option IDs are opaque UUIDs, so a wrong one is invisible on inspection - these name the
//title each is supposed to mean. tests/live/read-only.test.ts checks the same IDs against Attio's live schema,
//so between the two a wrong ID fails here and a deleted or renamed-away one fails there.
//
//THE TWO OBJECTS USE DIFFERENT IDS FOR THE SAME WORDS, which is the mistake most worth pinning: a Deal ID
//written to a Person is rejected by Attio as an unknown option, logged, and carried past - leaving the record
//unattributed while the run still reports success.
//=============================================================================================================
const DEAL_COLD_EMAIL = "6cae752e-6395-478a-83aa-eb934479d7dd";
const DEAL_COLD_CALL = "0696a0fc-425c-4ba5-9afb-2897b61ca3aa";
const DEAL_LI_OUTBOUND = "9686ed43-60ba-454d-b5d4-70c0840f227f";
const DEAL_LEVANTA = "4763981c-5793-48dc-b878-c02e0231df13";
const DEAL_SAS = "2cbbadd4-dca8-47cd-a6fb-6af4ae0eddee";

const PERSON_COLD_EMAIL = "4dca8bb3-413a-4d13-984b-e391b6f71852";
const PERSON_COLD_CALL = "56188ba9-821a-4878-99a2-333d338247a8";
const PERSON_LI_OUTBOUND = "f853ad2b-0681-4f0a-8c66-73358406dab1";
const PERSON_LEVANTA = "667ebae3-b820-4fc3-a12e-ebbfa4ce3cfb";
const PERSON_SAS = "cba7bd62-52ea-41d3-a494-4fce947b8780";

describe("attribution", () => {
  test("maps each provider to the source and sub-source the business asked for, on the deal", () => {
    expect(attributionValues("deals", "instantly")).toEqual({
      deal_source_discrete: [{ option: DEAL_COLD_EMAIL }],
      outbound_sub_source_discrete: [{ option: DEAL_LEVANTA }],
    });
    //Outfound is the SAS platform - the one provider whose mail is not sent from Levanta's own tooling.
    expect(attributionValues("deals", "outfound")).toEqual({
      deal_source_discrete: [{ option: DEAL_COLD_EMAIL }],
      outbound_sub_source_discrete: [{ option: DEAL_SAS }],
    });
    expect(attributionValues("deals", "heyreach")).toEqual({
      deal_source_discrete: [{ option: DEAL_LI_OUTBOUND }],
      outbound_sub_source_discrete: [{ option: DEAL_LEVANTA }],
    });
    expect(attributionValues("deals", "aircall")).toEqual({
      deal_source_discrete: [{ option: DEAL_COLD_CALL }],
      outbound_sub_source_discrete: [{ option: DEAL_LEVANTA }],
    });
  });

  test("uses the person's own slugs and IDs for the same four providers", () => {
    expect(attributionValues("people", "instantly")).toEqual({
      lead_source_discrete: [{ option: PERSON_COLD_EMAIL }],
      lead_outbound_sub_source_discrete: [{ option: PERSON_LEVANTA }],
    });
    expect(attributionValues("people", "outfound")).toEqual({
      lead_source_discrete: [{ option: PERSON_COLD_EMAIL }],
      lead_outbound_sub_source_discrete: [{ option: PERSON_SAS }],
    });
    //Explicitly asked for: HeyReach and Aircall leads carry Levanta too, not just their deals.
    expect(attributionValues("people", "heyreach")).toEqual({
      lead_source_discrete: [{ option: PERSON_LI_OUTBOUND }],
      lead_outbound_sub_source_discrete: [{ option: PERSON_LEVANTA }],
    });
    expect(attributionValues("people", "aircall")).toEqual({
      lead_source_discrete: [{ option: PERSON_COLD_CALL }],
      lead_outbound_sub_source_discrete: [{ option: PERSON_LEVANTA }],
    });
  });

  test("shares no option ID between the two objects, which is the mix-up worth catching", () => {
    const idsFor = (object: "people" | "deals") =>
      new Set(attributionOptionIds().filter((c) => c.object === object).flatMap((c) => c.optionIds));
    const people = idsFor("people");
    for (const id of idsFor("deals")) expect(people.has(id)).toBe(false);
  });

  test("attributes every registered provider on both objects, so a fifth cannot be added unattributed", () => {
    for (const provider of PROVIDERS) {
      for (const object of ["people", "deals"] as const) {
        const values = Object.values(attributionValues(object, provider));
        expect(values).toHaveLength(2);
        for (const value of values) expect(value[0]?.option).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
  });

  test("writes each object's pair into that object's values and nothing of the other's", () => {
    const deal = dealValuesFor(interestedLead("heyreach", { emails: ["ada@example.com"] }));
    expect(deal.deal_source_discrete).toEqual([{ option: DEAL_LI_OUTBOUND }]);
    expect(deal.lead_source_discrete).toBeUndefined();

    const person = personValuesFor(interestedLead("heyreach", { emails: ["ada@example.com"] }));
    expect(person.lead_source_discrete).toEqual([{ option: PERSON_LI_OUTBOUND }]);
    expect(person.lead_outbound_sub_source_discrete).toEqual([{ option: PERSON_LEVANTA }]);
    expect(person.deal_source_discrete).toBeUndefined();
  });
});
