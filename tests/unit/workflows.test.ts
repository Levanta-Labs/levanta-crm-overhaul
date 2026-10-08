import { describe, expect, test } from "bun:test";
import {
  buildCallHistorySummary,
  extractAircallFields,
  isInterestedOutcome,
  parseAircallOutcomeWebhook,
} from "../../api/aircall-interested.js";
import { aircallCursorEvent } from "../../api/cron/aircall-touchpoint-sync.js";
import { heyReachTouchpointEvents } from "../../api/cron/heyreach-touchpoint-sync.js";
import { instantlyCursorEvent } from "../../api/cron/instantly-touchpoint-sync.js";
import {
  formatHeyReachThread,
  parseHeyReachInterestedWebhook,
} from "../../api/heyreach-interested.js";
import {
  formatInstantlyThread,
  parseInstantlyInterestedWebhook,
} from "../../api/instantly-interested.js";
import { parseAircallCall } from "../../lib/aircall.js";
import { parseHeyReachConversation } from "../../lib/heyreach.js";
import { parseInstantlyEmail } from "../../lib/instantly.js";

describe("interested workflows", () => {
  test("extracts and formats an Aircall interaction deterministically", () => {
    const call = parseAircallCall({
      id: 1,
      status: "done",
      direction: "outbound",
      raw_digits: "+1 555-555-0123",
      started_at: 1_700_000_000,
      ended_at: 1_700_000_120,
      duration: 120,
      contact: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
    });
    const fields = extractAircallFields(call, null, "Booked");
    //With no campaign contact, the call's own address-book contact fills in.
    expect(fields).toMatchObject({ email: "ada@example.com", firstName: "Ada", phones: ["+15555550123"] });
    //The call's completion, not its start, dates the interaction.
    expect(fields.occurredAt).toBe(1_700_000_120);
    expect(buildCallHistorySummary(fields)).toContain("Duration: 2m");
    expect(buildCallHistorySummary(fields)).toContain("Outcome: Booked");
  });

  test("prefers the campaign contact over the call's own contact", () => {
    const call = parseAircallCall({
      id: 1,
      status: "done",
      raw_digits: "+1 555-555-0123",
      started_at: 1_700_000_000,
      ended_at: 1_700_000_120,
      duration: 120,
      contact: { first_name: "Old", company_name: "Address Book Inc" },
    });
    const contact = {
      phoneNumber: "+15555550123",
      firstName: "Ada",
      lastName: "Lovelace",
      email: null,
      companyName: "Analytical Engines",
      note: "Warm lead",
    };
    const fields = extractAircallFields(call, contact, null);
    expect(fields).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Analytical Engines",
      note: "Warm lead",
      //The same number from the call and the contact appears once, not twice.
      phones: ["+15555550123"],
    });
    //No outcome label, no Outcome line.
    expect(buildCallHistorySummary(fields)).not.toContain("Outcome:");
  });

  test("parses the outcome_recorded webhook exactly as Aircall delivered it", () => {
    //Captured from a real delivery on 2026-10-08, token replaced.
    const webhook = parseAircallOutcomeWebhook({
      resource: "outbound_campaign",
      event: "outbound_campaign.outcome_recorded",
      timestamp: 1791472316,
      token: "xxx",
      data: {
        id: "095acafa-5e40-4fc6-82d1-018ece35f281",
        company_id: 635553,
        call_id: 4223079424,
        number_id: 1339018,
        campaign_id: "019ffb76-4aaa-762f-85e0-056e3a13729c",
        attempt_id: "095acafa-5e40-4fc6-82d1-018ece35f281",
        outcome_id: "019fd21c-5b09-70fc-9356-cfd01be98477",
        outcome_label: "Connected",
        attempt_number: 2,
        max_attempts: 3,
      },
    });
    expect(webhook).toEqual({
      token: "xxx",
      event: "outbound_campaign.outcome_recorded",
      outcome: {
        callId: 4223079424,
        campaignId: "019ffb76-4aaa-762f-85e0-056e3a13729c",
        outcomeId: "019fd21c-5b09-70fc-9356-cfd01be98477",
        outcomeLabel: "Connected",
      },
    });
    //A payload missing what the workflow needs parses to no outcome rather than throwing.
    expect(parseAircallOutcomeWebhook({ event: "outbound_campaign.outcome_recorded", token: "xxx", data: {} }).outcome).toBeNull();
  });

  test("counts Booked, Connected and Referral as interested, and nothing else", () => {
    expect(isInterestedOutcome("019fd21c-357f-7c2a-b061-3b8b04a0146e")).toBe(true); //Booked
    expect(isInterestedOutcome("019fd21c-5b09-70fc-9356-cfd01be98477")).toBe(true); //Connected
    expect(isInterestedOutcome("019fd77c-37b0-7a87-9565-47e77576c25b")).toBe(true); //Referral
    expect(isInterestedOutcome("019fd21b-f18f-7216-9926-7322e3b36f14")).toBe(false); //No Answer
    expect(isInterestedOutcome("019fd21d-1933-75d6-b20c-fb27dcd3caaf")).toBe(false); //Not Interested
  });

  test("parses the documented Instantly interested event", () => {
    const fields = parseInstantlyInterestedWebhook({
      event_type: "lead_interested",
      lead_email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Analytical Engines",
      campaign_name: "Outbound",
    });
    expect(fields).toMatchObject({ eventType: "lead_interested", email: "ada@example.com" });
  });

  test("formats Instantly email history in chronological order", () => {
    const newer = parseInstantlyEmail({
      id: "2",
      timestamp_created: "2026-08-19T12:00:00Z",
      timestamp_email: "2026-08-19T12:00:00Z",
      ue_type: 2,
      lead: "ada@example.com",
      subject: "Re: Hello",
      body: { text: "Reply" },
    });
    const older = parseInstantlyEmail({
      id: "1",
      timestamp_created: "2026-08-19T11:00:00Z",
      timestamp_email: "2026-08-19T11:00:00Z",
      ue_type: 1,
      lead: "ada@example.com",
      subject: "Hello",
      body: { text: "Opening" },
    });
    expect(formatInstantlyThread([newer, older], "Campaign").indexOf("Opening")).toBeLessThan(
      formatInstantlyThread([newer, older], "Campaign").indexOf("Reply"),
    );
  });

  test("accepts both top-level and nested HeyReach webhook payloads", () => {
    expect(parseHeyReachInterestedWebhook({ lead: { profileUrl: "https://linkedin.com/in/ada" } }).profileUrl)
      .toBe("https://linkedin.com/in/ada");
    expect(parseHeyReachInterestedWebhook({ linkedInUrl: "https://linkedin.com/in/grace" }).profileUrl)
      .toBe("https://linkedin.com/in/grace");
  });

  test("formats HeyReach history", () => {
    expect(formatHeyReachThread([
      { createdAt: "2026-08-19T12:00:00Z", body: "Hello", subject: null, sender: "ME" },
    ])).toContain("Hello");
  });
});

describe("sync event identities", () => {
  test("uses the source Aircall ID and completion timestamp", () => {
    const call = parseAircallCall({ id: 42, status: "done", started_at: 100, ended_at: 150 });
    expect(aircallCursorEvent(call)).toEqual({ id: "42", timestampMs: 150_000 });
  });

  test("uses Instantly's source email ID and creation timestamp", () => {
    const email = parseInstantlyEmail({
      id: "email-1",
      timestamp_created: "2026-08-19T12:00:00Z",
      timestamp_email: "2026-08-19T11:59:00Z",
      ue_type: 3,
      lead: "ada@example.com",
      body: {},
    });
    expect(instantlyCursorEvent(email)).toEqual({
      id: "email-1",
      timestampMs: Date.parse("2026-08-19T12:00:00Z"),
    });
  });

  test("creates deterministic HeyReach events for messages without source IDs", async () => {
    const conversation = parseHeyReachConversation({
      id: "conversation-1",
      linkedInAccountId: 1,
      lastMessageAt: "2026-08-19T12:00:00Z",
      correspondentProfile: { profileUrl: "https://linkedin.com/in/ada" },
      messages: [{ createdAt: "2026-08-19T12:00:00Z", body: "Hello", sender: "ME" }],
    });
    const events = await heyReachTouchpointEvents([conversation]);
    expect(events).toHaveLength(1);
    expect(events[0]?.cursor.id).toHaveLength(64);
  });
});
