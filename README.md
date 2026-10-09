<br />
<p align="center">
  <img src="assets/logo.svg" alt="Levanta Labs logo">
</p>
<br />

# Levanta RevOps Infrastructure

Levanta RevOps infrastructure keeps Attio aligned with interested-lead and sales-touchpoint activity from Aircall, Instantly, HeyReach, and Outfound.

## Quickstart

Install the Bun dependencies and run the strict compiler plus unit suite:

```sh
bun install
bun run check
```

The project runs on Bun `1.x`; `packageManager` pins `1.3.13` for local installs, and `vercel.json` selects the
`1.x` runtime (Vercel accepts only `1.x` or `1.4.x` there, so the exact patch cannot be pinned in both places).
Configure local integrations by copying `.env.example` to `.env.local` and supplying the required credentials before invoking a webhook or cron route.

## How CRM activity is synchronized

The Vercel functions handle two workflows:

1. Interested events resolve an Attio Person, resolve or create their Company, ensure an Interested Deal exists,
   write source-history notes, fill blank attributes on all three records, and suppress the lead on every
   outbound platform.
2. Cron jobs poll each provider for new touchpoints - Instantly, HeyReach and Outfound every five minutes, Aircall every ten. They process only People on the Master TAM list, increment the configured counters, mirror notes to associated Companies, and persist cursor progress in Supabase.

The four syncs do not write the same records, by design:

| Sync | Person note | Person counter | Company note | Company counter |
| --- | --- | --- | --- | --- |
| Instantly | yes | yes | yes | yes |
| HeyReach | yes | yes | yes | yes |
| Outfound | yes | yes | yes | yes |
| Aircall | **no** | yes | yes | yes |

An Aircall touchpoint deliberately writes no Person note, because the call and its recording already live in Aircall
and the Person only needs the count. The note exists on the Company as the roll-up view. A consequence worth knowing:
an Aircall touchpoint for a Person with no associated Company records only the counter increment.

### The interested workflow is shared, and cannot overwrite

All three providers converge on `recordInterestedLead` in `lib/interested.ts`. Each provider contributes only
three things - how it parses its own payload, how it looks a Person up in Attio, and how it renders its own
message history into a note. Everything after that is one code path:

| Step | What it does |
| --- | --- |
| 0. Repeat check | An event repeating one already recorded for this Person is declined before anything is written - see [Repeated events are declined, not re-recorded](#repeated-events-are-declined-not-re-recorded) |
| 1. Person | The provider's own lookup order, creating a Person from the lead when there is no match |
| 2. Company | The Company already linked to the Person if there is one, else found by domain then by exact name, else created - but only when a name or domain exists to create it from |
| 3. Deal | Any Deal already linked to the Person is reused whatever its stage; a new one is opened only when there is none, named strictly `<company>` - the deal carries no marker of how it was opened, because `deal_source_discrete` already does |
| 4. Notes | The provider's rendered history, on the Person and on the Deal |
| 5. Attributes | `updateAttioAttributes` on the Person and the Deal |
| 6. Suppression | The Attio DNC list plus every registered outbound platform |
| 7. Transcript | The whole run written back to the Person, the Company and the Deal as a note - see below |

### Repeated events are declined, not re-recorded

Providers deliver the same interest more than once, and Attio gives us nothing to make that harmless: there is
no idempotency key and no upsert for notes, so `createNote` appends. Every repeat therefore left a second
identical note on the Person and on the Deal, plus a second run transcript on all three records. Nothing else
in the workflow accumulates - the Person, Company and Deal are all find-or-create, and `updateAttioAttributes`
only fills blanks - so the note is the whole of the damage, and the only place worth catching it.

**HeyReach is where this shows up.** Its webhook is registered per event type, against *All campaigns*, so one
registration fans out: a lead enrolled in several campaigns produces a delivery apiece, and a lead auto-tagged
positive again on a later inbound message produces another. Each is a true event by HeyReach's reckoning and
indistinguishable from the last by ours. Instantly does not do this, for two reasons that are both worth
knowing: `lead_interested` is a single status transition per lead rather than a per-message event, and
`/api/instantly-interested` additionally drops anything that is not that event type, because Instantly posts
opens and replies to the same URL.

Before writing, `recordInterestedLead` lists the Person's notes and declines the event if one already carries
the title this run would write - the provider's `leadSourceLabel` - from inside `INTERESTED_DUPLICATE_WINDOW_MS`
(fifteen minutes by default). A declined repeat writes *nothing*: no note, no transcript, no attribute patch,
no suppression. It returns the existing record ids with `duplicate: true` in the response body and one
`[dedupe]` line in the log.

The window is what makes this safe. Title alone would silence a lead who re-engages weeks later, which is a
real second event that deserves its own note; the window catches a burst and lets a return through. Setting
`INTERESTED_DUPLICATE_WINDOW_MS` to `0` turns the check off entirely and costs no request.

**It fails open, deliberately.** A listing that errors, or one too long to read to the end (Attio caps `limit`
at 50 and documents no sort order, so the walk reads four pages and stops), answers "not a repeat" and the
event is recorded. The two mistakes do not cost the same: a wrong "yes" silently discards a real interested
lead, which is the event this codebase exists to capture, while a wrong "no" writes a duplicate note - the
status quo, and visible. Both outcomes log.

**It narrows the race, it does not close it.** The check is a read and the write is a separate request with no
transaction between them, so two deliveries landing in different Vercel instances within the same few hundred
milliseconds can both read "no note" and both write. Production shows deliveries seconds apart, which this
catches. The same gap already allowed two simultaneous events to create two Person records; that predates this
check and is not addressed by it.

### Every interested run leaves a transcript on the records it touched

Step 7 posts one further note to the Person, to the Company, and to the Deal, all titled
`run logs for automated integration (<Platform> marked as interested)`. Each carries whether *that* record
existed before the run, what it held then, every line the run printed, and what it held after. The question
asked after the fact is never "what happened in invocation `dpl_xyz`" but "why does *this* record look like
this", and that is a question about a record - so the answer lives on the record rather than expiring with the
Vercel log. The transcript is identical in all three, because it is one run; only the two states differ.

It is most useful on a Deal that already existed. An interested event on a deal mid-pipeline restates its lead
source to this run's channel but leaves its stage and its original `moved_to_interested_at` alone, and the two
states put that side by side:

```
Previous state                          State after run (as this run left it)
stage: Negotiation                      stage: Negotiation
lead source discrete: LI Outbound…      lead source discrete: Cold Email
moved to interested at: 2026-06-14      moved to interested at: 2026-06-14T09:31:00.000Z
```

Nothing had to be instrumented to produce the log. `lib/run-log.ts` mirrors `console` for the duration of one
run, so the existing log lines are the single source and cannot drift from the transcript. Capture is scoped
per lead, which is what keeps concurrent interested runs apart, and what keeps the
touchpoint crons - which share `lib/attio.ts` but never open a scope - out of it entirely.

**The after state is derived, not re-read.** `patchRecord` has three call sites, all inside
`writeSalvagingRejections`, which only `updateAttioAttributes` calls - so an attribute on any of these records
can only change through a create whose response is already in hand, or through a write that reports what it
wrote. Composing the two gives the state the run left behind without asking Attio for it, which is why three
records cost three requests rather than six. What it cannot see is Attio's own hand: a value normalised on
write, a derived attribute, an automation reacting to the write, or a human editing mid-run. The heading says
`(as this run left it)` rather than claiming to be a reading of Attio, because that is what it is.

The whole feature is `lib/run-log.ts`, its test, and the blocks marked `//debug note in attio=` in
`lib/interested.ts`; deleting those removes it and changes nothing else. It builds each transcript as a file in
memory - a name, a type, and bytes - so emailing or posting them later is the same call, not a rewrite. It
costs three Attio requests per interested lead, one note per record, and never throws into a run: each note is
written independently and a transcript that cannot be posted is logged and abandoned, because it is
diagnostics attached to an event Attio has already committed.

**A note on what it contains.** The transcript reproduces the run's log lines verbatim, and those carry the
business identifiers a lookup searched on - an address, a number, a profile URL. That is personal data, and it
now sits on the Company and the Deal as well as the Person, so anyone with access to any of the three can read
it.

**Nothing overwrites.** `updateAttioAttributes` reads what a record already holds and writes only the
attributes that are blank, so third-party data fills gaps and never contradicts the CRM. Someone who corrected
a job title in Attio will not find it replaced by whatever the provider still believes.

**Lead Source is the deliberate exception.** It is not a fact about the person that a human might have
corrected - it is a statement about the run: the channel that just produced the interested signal. So it is
written on every interested event whatever Attio already held, on the Person and on the Deal alike, and both
carry the same string: `<Name> Cold Outreach - Automated`. The suffix marks a record these workflows produced
without a human, which is as true of the Person as of the Deal. A person first seen on one platform therefore no longer keeps that
platform's label forever. The cost is that the *first* source is not preserved in the attribute; the full
sequence is still on record, because every interested event writes a note titled with its own source string. The
list of slugs that behave this way is `ALWAYS_OVERWRITE` in `lib/interested.ts`.

The other exception is the multiselect attributes - `email_addresses`, `phone_numbers`, `domains`. A PATCH replaces
an attribute wholesale rather than appending to it, so for these the existing entries are read and sent back
alongside the new one. A second address for a lead is additive information, and skipping the write outright is
what previously dropped it. If any existing entry cannot be read back in full, the attribute is declined
outright rather than risking a write that would delete real data.

Values that will not fit an Attio attribute are dropped rather than guessed at: a headcount or revenue figure
that does not parse, a "website" that is not really a domain, a postal address whose country does not resolve to
an ISO code. A blank attribute is recoverable; a confidently wrong value in a CRM that nothing will ever
overwrite is not.

**A rejected attribute cannot fail the event.** Attributes are written as one PATCH, which is the only request
usually made. If Attio rejects that write on its *content* - a `400` or `422`, meaning some value it will not
accept - the attributes are retried one at a time so that one bad value costs only itself, and whatever is still
rejected is dropped. A rejection that is not about content (`401`, `404`, a `5xx`, a transport failure) is not
retried, because no single attribute caused it and N further attempts would fail identically.

Either way the step does not raise. By the time attributes are written the Person, Company, Deal, and notes are
already committed, and losing all of that because one provider value would not fit an Attio attribute is a far
worse outcome than a blank field. What was dropped is logged under `[attio]` - an attribute silently missing with
no record of why is undiagnosable. The one part that still raises is the *read*: without knowing what a record
already holds there is no way to write to it without risking an overwrite.

### How a lead and its deal are attributed

Four discrete select fields carry attribution — two on the **Person**, two on the **Deal**. All are written by
**option ID, not title**, so renaming an option in the Attio UI cannot silently break the write; a title write
would start failing from that moment with nothing in the code to say why.

| Provider | Source | Sub-source |
| --- | --- | --- |
| Instantly | Cold Email | Levanta |
| Outfound | Cold Email | **SAS** — the one provider whose mail is not sent from Levanta's own tooling |
| HeyReach | LI Outbound | Levanta |
| Aircall | Cold Call | Levanta |

| Object | Source slug | Sub-source slug |
| --- | --- | --- |
| `people` | `lead_source_discrete` | `lead_outbound_sub_source_discrete` |
| `deals` | `deal_source_discrete` | `outbound_sub_source_discrete` |

**The two objects spell the same words with entirely different option IDs.** "Cold Email" on a Person is
`4dca8bb3-…`; on a Deal it is `6cae752e-…`. They are separate attributes that merely read alike. Writing one
object's ID to the other is not reported as a mismatch — Attio rejects the option as unknown,
`updateAttioAttributes` logs it and carries on, and the record ends up unattributed while the run reports
success.

So the mapping is split in two. A provider maps to a **category**, which is a word; each object then has its own
table turning that word into that object's ID. `PROVIDER_ATTRIBUTION` cannot name an ID at all, and
`attributionValues(object, provider)` returns slugs and values together — the only way to get an ID out is to
ask for the object it belongs to. A cross-object mix-up is not discouraged, it is unwriteable.

The map is typed against `Provider`, so a fifth provider will not compile until it is attributed — a new channel
silently writing no source is the failure that guards against.

**Latest touch wins.** All four slugs are in `ALWAYS_OVERWRITE`. A deal is *reused* when the person already has
one (see `ensureInterestedDeal`), so a lead first seen on Instantly and later replying on HeyReach keeps a single
deal; without the overwrite it would still read Cold Email months later.

**The IDs are checked in two places, because neither is enough alone.** `tests/unit/providers.test.ts` pins which
ID each provider sends on each object, and asserts the two objects share none — that catches a wrong or swapped
one. `tests/live/read-only.test.ts` checks every ID against Attio's live schema for its own object — that catches
one deleted and recreated in Attio, which mints a new ID while the old one keeps parsing as a valid UUID. A stale
ID costs every interested record its attribution *silently*, since `updateAttioAttributes` salvages what it can
and logs the rest rather than failing the event.

**`lead_source` is deprecated on both objects and is no longer written at all.** The discrete pair replaced it.
On `deals` the attribute was removed from Attio outright, which the live schema test caught - writing it cost
every deal an extra round trip and a warning, because `writeSalvagingRejections` sends one PATCH with
everything, Attio rejected the whole batch over the single unknown slug, and each remaining attribute was then
retried one at a time. On `people` the attribute still exists but nothing reads it, so writing it was churn on
a dead field - and churn that *overwrote*, since it used to sit in `ALWAYS_OVERWRITE`.

Values already on existing records are left exactly as found. Nothing writes the slug now, so nothing can clear
it either; clearing them is a decision for Attio, not for this codebase.

`leadSourceLabel` survives and is unchanged. It is not an attribute value - it titles every note the workflow
writes, and it is what the repeat check matches on, so changing its spelling would stop a run recognising the
notes earlier runs left and bring duplicates back. `automatedSourceLabel`, which existed only to produce the
`lead_source` string, is gone.

**Not written:** the `notes` text attribute. Appending to it would mean reading the current value and
concatenating, which races against anything else writing the same field; it was dropped deliberately rather than
risk clobbering. The provider is already named in the note title and in `lead_source`.

### Interest on one platform means suppression on all of them

Interest is a fact about the person, not about the channel that noticed it. A lead who answers the phone must
stop receiving the cold email sequence too, and the reverse - suppressing only the channel that happened to
report first is how a lead ends up pitched twice. So every interested event, whatever found it, runs the same
`suppressInterestedLead`:

| Channel | Action | Needs |
| --- | --- | --- |
| Attio | Add the Person to the DNC list | the Person |
| Instantly | Add the address to the workspace blocklist | an email address |
| Outfound | Mark the address do-not-contact, which Outfound then syncs down to the sending platform | an email address Outfound holds a thread for |
| HeyReach | Stop the lead in every campaign still able to message them, then add the lead and their company to the workspace blacklist | a LinkedIn profile URL or an email address; the company name for the company entry |

Outfound is keyed on a thread rather than an address, because it has no "block this address" endpoint - only
"mark this thread DNC", with the entry then applying to the address across every thread. So the channel looks
the lead up first, and an address Outfound holds no thread for reports itself as skipped. It marks the address,
never the domain: a domain-wide block would suppress every colleague of the person who just showed interest.

HeyReach is the one deliberate exception. Its channel blacklists the lead's company by name as well, so no
colleague is pitched over LinkedIn once someone there has shown interest. The campaigns are stopped before the
blacklist is written, because a full blacklist (1,000 leads and 1,000 companies per workspace by default)
throws, and that must not leave the lead in a live sequence. The error says which list is full or why HeyReach
rejected the entry. Whether HeyReach found the person behind a lead entry is not known at write time - it
resolves in the background and shows as `NotFound` on its blacklist page if it never does.

Aircall is absent by design: it needs no suppression of its own. Aircall dialling is governed by the Attio DNC
list, which is why that is the first channel and the one that matters most.

Each channel is independent and a failure in one does not stop the others: half the platforms suppressed is
strictly better than one suppressed and the rest untouched because the first threw. Failures are returned in the
route's response body rather than raised, so an unreachable platform cannot fail an event Attio already
recorded. A channel reporting `skipped` is not a failure - it means the lead is not present on that platform,
usually for want of the one identifier it works by.

### Adding another platform

Provider support is a register, not a set of branches. Adding one is an append plus its own extractor:

Outfound was the fourth, and went in exactly this way - one `SOURCES` entry, one module, one route, one cron.

1. **`lib/providers.ts`** - add an entry to `SOURCES` with its `displayName`. That single entry widens the
   `Provider` type and derives both the note title (`<Name> Cold Outreach`) and the source string written to
   the Person and the Deal (`<Name> Cold Outreach - Automated`). If the platform also sends outbound and must be silenced, append a
   `SuppressionChannel` to `THIRD_PARTY_SUPPRESSION_CHANNELS`; from that moment it is suppressed for every
   provider, with no change to any route.
2. **A provider module** - parse its payload and return an `InterestedLead` via `interestedLead()`, naming only
   the fields it actually has. Everything it cannot supply stays null and simply is not written.
3. **A route or cron** - call `recordInterestedLead` with the lead, a `findPerson` lookup, and a `history`
   renderer.
4. **Two environment variables** - `ATTIO_PERSON_<KEY>_COUNTER_SLUG` and `ATTIO_COMPANY_<KEY>_COUNTER_SLUG`,
   derived from the provider key. These throw on first use if absent, so a missing one fails loudly rather than
   writing a counter nobody reads.

Nothing in the Attio mapping, the write path, the company resolution, or the deal naming needs to change.

### What each platform contributes

Only fields that exist on both sides are mapped. The providers are not equally rich:

| Attio target | Aircall | Instantly | HeyReach | Outfound |
| --- | --- | --- | --- | --- |
| Person `name`, `email_addresses` | yes | yes | yes | yes |
| Person `phone_numbers` | yes | yes | - | - |
| Person `linkedin` | - | yes | yes | yes |
| Person `job_title` | - | yes | yes | yes |
| Person `description` | yes | - | yes | - |
| Person `location` | - | yes | yes | country only |
| Person `campaign_name`, `date_added`, `company` | yes | yes | yes | yes |
| Person `lead_source_discrete`, `lead_outbound_sub_source_discrete` | yes | yes | yes | yes |
| Company `name` | yes | yes | yes | yes |
| Company `domains`, `employee_range`, `estimated_arr_usd` | - | yes | - | yes |
| Company `primary_location` | - | yes | - | - |
| Deal `campaign_name`, `email`, `moved_to_interested_at` | yes | yes | yes | yes |
| Deal `deal_source_discrete`, `outbound_sub_source_discrete` | yes | yes | yes | yes |
| Deal `phone_number_7` | yes | yes | - | - |
| Deal `linkedin` | - | yes | yes | yes |
| Deal `website`, `industry`, `employees`, `revenue` | - | yes | - | yes |

Aircall is the thinnest by a wide margin: no LinkedIn URL, job title, industry, headcount, or revenue exists
anywhere in its API. The name, company, email and note come from the **campaign contact** - the row the campaign
was loaded with - read by the dialled number (`GET /campaigns/{id}/contacts?phone_number=`). The call's own
`contact` is only set when the number is in Aircall's address book, which for a cold campaign it usually is not,
so it is the fallback rather than the source. Campaign contacts in this workspace usually carry a name and a
company but no email, so the lead is normally matched in Attio by phone. A contact with no company creates no
Company at all, because a company record named after a phone number is worse than no company.

Instantly is the richest, but almost none of it is on the webhook. `/api/instantly-interested` reads the lead
record back (`POST /leads/list`) for the job title, LinkedIn URL, phone, industry, headcount, revenue, location,
and company address, which live under the campaign's custom variables. That lookup is best-effort: if it fails,
the event is still recorded from the webhook body alone.

HeyReach's enrichment is free. The route already fetches the conversation for the note, and every entry carries
the correspondent's position, headline, location, company, and all three of HeyReach's email fields.

Outfound is nearly as rich as Instantly and asks less to get there. Its webhook already carries the name, company,
domain, job title, LinkedIn URL, website and industry, where Instantly's carries an address and little else; one
lookup (`GET /prospects/lookup/conversations`) then adds seniority, headcount, revenue and the company's country
*and* returns the correspondence the note is rendered from, so a single request does what Instantly needs two for.
Two gaps: Outfound holds no phone number anywhere, and its only location is the company's country as an ISO
alpha-2 code - which reads correctly as a Person location but is not a postal address, so no Company
`primary_location` is written from it.

## Webhook and cron routes

| Route | Source | Expected request |
| --- | --- | --- |
| `/api/instantly-interested` | Instantly | A `lead_interested` webhook using current top-level v2 fields; the route reads the lead record back for enrichment |
| `/api/outfound-interested` | Outfound | A Webhook Relay prospect payload carrying `lead_email`. **No event type is filtered on** - which lead categories fire the relay is configured on Outfound's side, so everything authenticated is recorded |
| `/api/aircall-interested` | Aircall | An `outbound_campaign.outcome_recorded` webhook, authenticated by the `token` field in its body. Fires for **every** outcome on **every** campaign; the route acts only on Booked, Follow Up and More Info, by outcome ID, and acknowledges the rest with a `200` |
| `/api/heyreach-interested` | HeyReach | A HeyReach webhook carrying a lead object, nested or top-level, containing `profileUrl`/`linkedInUrl` or `email`. **No event type is filtered on** - which events fire is configured per webhook in HeyReach and is edited there without a deploy, so the route records everything authenticated and *names* the event in the log instead |
| `/api/cron/aircall-touchpoint-sync` | Vercel Cron | Authorized GET every ten minutes (`*/10 * * * *`). Touchpoints only - interested leads arrive at `/api/aircall-interested` |
| `/api/cron/instantly-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/outfound-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/heyreach-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |

### Aircall interested leads arrive by webhook, as outcomes

"Interested" in Aircall is a campaign **outcome** - the disposition an agent picks after the call - not a tag on
the call. An earlier version polled call tags for it, behind a lookback window to cover the lag between a call
ending and the tag being applied, and never matched: the only tag campaign calls carry is `Outbound Campaign`,
and outcomes never appear among the tags.

Aircall sends `outbound_campaign.outcome_recorded` when an outcome is recorded, so Aircall now works like the other
three providers: one webhook route, `api/aircall-interested.ts`, calling `recordInterestedLead`.

**It fires for every outcome, on every campaign.** Aircall offers no filter, so No Answer and Voicemail arrive as
well as Booked - about 90 deliveries a day at October 2026 volume. The route filters them itself, before any
network call, against `INTERESTED_OUTCOME_IDS`: Booked, Follow Up and More Info. They are matched by **ID**, not by
name, so renaming an outcome in Aircall cannot break the match - the same reasoning as the attribution option IDs.
Adding an outcome means adding its ID to that set; the IDs are listed by `GET /v1/campaign_outcomes`.

**The payload carries IDs and nothing about the person**, so the background job makes two reads:
`GET /calls/{call_id}` for the dialled number, then `GET /campaigns/{campaign_id}/contacts?phone_number=` for the
name, email, company and note. The contact read is best-effort: if it fails, the lead is recorded from the call's
number alone.

**The route replies first and does the work afterwards.** Aircall waits five seconds for a `2xx`, counts anything
else as a failure, retries a failed event up to 50 times, and then disables the webhook. An interested run makes
far more sequential requests than fit in five seconds, so the route makes only local checks - the token, the event
type, the outcome - replies `200`, and runs the workflow under `waitUntil` (`@vercel/functions`), which keeps the
function alive after the response until the job finishes. What that costs:

- **A failure after the reply is not resent**, because Aircall has already been told it succeeded. It is logged as
  `FAILED after Aircall was told OK`, naming the call; the outcome can be found again in
  `GET /v1/campaigns/{id}/call_outcomes` and replayed.
- **The response body carries no record ids**, only `accepted: true` and the call id, because the work has not
  happened yet when it is sent. The ids are in the log.
- **Everything ignored is a `200`, never a `4xx`** - another event type, an outcome that is not interested, or an
  outcome event missing its fields. A resend of any of those would be identical, and would count towards
  disabling the webhook.

Aircall delivers at least once and an agent can change an outcome after setting it, so the same lead can arrive
twice; the repeat check in `recordInterestedLead` declines the second, as it does for HeyReach.

### The run budget

**All four syncs share this**, in `lib/run-budget.ts`. Each one is a sequential per-event loop that saves its cursor
once, after the loop. A single touchpoint costs up to eight Attio requests, so throughput is roughly one event every
three or four seconds - finite, and a backlog can exceed it. Left unguarded the run is killed by Vercel at
`maxDuration`, and the kill lands *before* `saveSyncCursor`, so the run records **no progress at all**: the next run
re-reads the same backlog, re-increments every counter it already incremented, and is killed again. A 504 on a sync
route means exactly that loop, and inflated counter values are its symptom.

`DEFAULT_RUN_BUDGET_MS` (240s, under the 300s `maxDuration`) makes the loop stop of its own accord instead. On a
budget stop:

- The cursor is saved where the loop actually reached, so the next run resumes rather than restarts.
- The park at `now - CURSOR_GRACE_MS` is **skipped**, because the events the loop never reached have not been dealt
  with and must stay above the mark.
- The response carries `truncated: true` and a count of what is left (`callsRemaining` / `emailsRemaining` /
  `messagesRemaining` / `threadsRemaining`), and the run logs a `[run] ... STOPPED` warning. The HTTP status stays 200 - a partial run is
  a success, not a failure. All four syncs also report `stopReason`, because all four can stop for more than one
  reason - `"budget"` or `"throttled"` - and they want different responses: a budget stop is a throughput problem,
  a throttle is a rate-limit one. Instantly, HeyReach and Aircall add `"window-throttled"` - and Instantly also
  `"window-truncated"` - which are the *fetch* stopping short rather than the loop, meaning the window itself was
  incomplete and the records beyond it were never seen. See
  [Instantly's window cannot always be read in one go](#instantlys-window-cannot-always-be-read-in-one-go) and
  [Every provider handles its own 429 now](#every-provider-handles-its-own-429-now).

Aircall reached the limit first, on volume; the others have the identical shape and so the identical risk. HeyReach
is the most exposed on steady state - see the `[PERF]` note on its handler, where cost grows through the UTC day
because every run re-reads every conversation touched since midnight.

**Outfound budgets one step earlier than the others.** Everywhere else the provider fetch is a bounded number of
pages and only the write loop needs guarding. Outfound's inbox lists threads *without* message bodies, so expanding
a window into emails costs one request per thread - and a wide window (a first run, or a deliberately backfilled
cursor) can spend the whole of `maxDuration` in that expansion alone, before a single event is written. So its
budget opens before the expansion and stops that too. A run ending there reports `threadsExpanded` short of
`threadsScanned` plus a `threadsRemaining` count, and - critically - still refuses to park the cursor: the threads
it never opened hold emails it never saw, and parking would claim otherwise and skip them permanently.

**Outfound stops on an Outfound throttle too**, not just an Attio one - the same `stopReason: "throttled"`, raised
one step earlier, while it is still expanding threads. This matters more here
than the raw request count suggests, because **the dashboard's headline rate limit is not the one that applies**.
The Integrations screen labels the client key `100K/hr`; that is the *organization* ceiling. `GET /rate-limit`
reports what the key itself gets, and the key in use is on the `standard` tier: **9/second, 3,000/hour**. Against a
five-minute cadence that is roughly 250 threads per run before Outfound starts refusing, which a backlog reaches
easily. A throttled thread wrote nothing and the cursor never passed it, so the run stops and defers rather than
marching through the remaining backlog collecting one refusal per thread. Repeated `stopReason: "throttled"` means
the key needs a higher tier, not a longer budget.

### Instantly's window cannot always be read in one go

**Instantly allows 20 requests per minute across the whole key**, and the touchpoint sync pages a hundred emails at
a time with no pause between pages. Any real backlog reaches that ceiling within seconds.

This wedged production for five days. A 429 was an ordinary thrown `Error`, which abandoned the run — and every sync
saves its cursor *after* its loop, so the mark never moved. The next run re-read the same window from the same mark,
hit the same ceiling at the same page, and discarded the same work. The cursor sat at `2026-09-17T14:12:55Z` while
every run for five days logged `ABANDONED ... cursor NOT saved`. It could not recover on its own: each run needed to
get further than the last, and none ever did.

Two things changed.

`fetchInstantlyEmailWindow` **returns the pages it read** when Instantly refuses the next one, instead of throwing
them away, and tells the caller the window is short. The sync processes what arrived and parks its cursor after it,
so every run makes progress and the backlog drains a slice at a time. Anything that is *not* a 429 still raises: a
500 says nothing about how much of the window exists, and treating the part already read as the whole of it would
park the cursor past emails that were never seen.

The sync also **stops itself at `INSTANTLY_SYNC_PAGE_LIMIT` (15 pages, 1,500 emails)** rather than bursting until
refused. A rejected request as part of normal operation is both rude to the API and indistinguishable in the log
from the real problem. Fifteen leaves five requests of headroom for the interested webhook, which shares the same
key and fires on a lead's schedule rather than ours.

The two show up differently, because they want different responses:

| `stopReason` | Meaning | What to do |
| --- | --- | --- |
| `"window-truncated"` | The read stopped at the page cap | Nothing. This is a backlog draining as designed; expect it on consecutive runs until the cursor catches up |
| `"window-throttled"` | Instantly refused a page before the cap | Nothing for a run or two. Persisting means something else is spending the key's allowance and the cap is too high |

**The page cap is not the throughput limit and is not meant to be.** One touchpoint is several Attio writes, so
`INSTANTLY_SYNC_BUDGET_MS` runs out long before 1,500 emails are processed — the run stops on budget, parks its
cursor, and the next one resumes. The cap only bounds what is *fetched*, so a deep backlog cannot spend a whole run
on pages it will never reach.

**The interested route degrades rather than failing.** While a backlog drains the sync is spending up to fifteen of
the twenty requests, so an interested webhook can be refused through no fault of its own. Raising there would 500
the webhook and lose the lead until Instantly retried it, to save a note body — so a throttled thread read is
caught, the lead is recorded, and the note says the history could not be *read*, which is not the same as there
being none.

### Every provider handles its own 429 now

The four transports had drifted apart and only two were ever hardened, which is how the Instantly wedge went
unnoticed. They are all covered now, but not identically — the right answer depends on the allowance:

| Provider | Allowance | Handling |
| --- | --- | --- |
| Attio | Per second, plus a query-complexity limit | Retries with backoff, honours `Retry-After` |
| Instantly | **20/minute**, documented | Self-imposed 15-page cap, then partial return |
| HeyReach | One pool shared across every endpoint | Retries 3x, then partial return |
| Aircall | **120/minute per company** | Retries 3x honouring `X-AircallApi-Reset`, then partial return |
| Outfound | Per key, `standard` tier at 9/s and 3,000/hr | `OutfoundRateLimitError` stops the thread expansion |

**Why Instantly gets a cap and the other two get retries.** Instantly's 20/minute is documented as a hard number,
so the sync can pace itself against it and avoid the refusal entirely. HeyReach and Aircall were both **probed
live and answered 200 with no rate-limit header of any kind** — no limit, no remaining, no reset — so there is no
allowance to read ahead of time and nothing honest to pace against. A transport can only react to the refusal when
it arrives. Aircall documents its `X-AircallApi-Limit`/`Remaining`/`Reset` trio as arriving *once the limit is
reached*, so `aircallResetMs` reads it when present and falls back to backoff when it is not.

Waiting is also worth less at these ceilings than it looks. A run that spends its budget asleep has done nothing,
so both cap the wait at five seconds and then stop — the next run starts with a fresh allowance either way.

**In all three cases the invariant is the same and it is the only one that matters:** a run that gets throttled
still *saves its cursor*. That is what makes the next run different from this one, and its absence is the whole of
what kept the Instantly sync dead for five days. A throttled window fetch reports `stopReason: "window-throttled"`
and the run is still a 200.

**HeyReach's retry covers writes.** `StopLeadInCampaign` and the blacklist's `AddLeads` and `AddCompanies` are
HeyReach writes, and they are retried on a 429 for the same reason Attio retries POSTs: a refused request was not
processed, so repeating it cannot withdraw a lead twice or add an entry twice.

**The all-or-nothing forms are kept for the interested routes.** `fetchInstantlyEmails` and `fetchHeyReachConversations`
still raise rather than returning a partial read, because their caller writes one note once
and has no cursor to resume from — half a thread rendered as though it were the whole is a misleading note, not
deferred work.

**Both interested routes then degrade rather than failing.** `/api/instantly-interested` and
`/api/heyreach-interested` each catch their own provider's rate limit around the thread read, record the lead from
the webhook alone, and write a note saying the history could not be *read* — which is not the same as there being
none, and matters to whoever opens the note looking for the reply. Raising instead would 500 the webhook and lose
the lead until the provider retried it, to save a note body. Anything that is not a rate limit still raises: an
unreachable API is not a reason to record a lead with half its detail and no sign anything went wrong. The two
routes are kept deliberately symmetrical, because one degrading while its twin 500s is a difference nobody finds
until the day it matters.

A single truncated run is normal while a backlog drains. Truncation run after run means events arrive faster than
they are processed. Each sync takes its own override - `AIRCALL_SYNC_BUDGET_MS`, `INSTANTLY_SYNC_BUDGET_MS`,
`HEYREACH_SYNC_BUDGET_MS`, `OUTFOUND_SYNC_BUDGET_MS` - for retuning against a live backlog without a redeploy; a malformed value falls back to
the default rather than failing the run.

> **The cadence must exceed the budget.** A run may legitimately take the whole 240s, and nothing guards against two
> invocations of one sync running at once - they would read the same cursor and double-count every event between
> them. The current cadences (`*/10` for Aircall, `*/5` for the other three) leave headroom; `*/5` against a 240s
> budget leaves only one minute of it. Shortening a cadence towards the budget means lowering that sync's budget
> with it.


### Attio rate limits, and the one failure worth retrying

Attio rate-limits on request rate **and** on *query complexity* - the filtered record lookups this codebase performs
to match a phone number or email to a Person. The touchpoint sync opens every call with one, so a busy run is exactly
what trips the complexity limiter.

`attioFetch`, the single Attio transport, now retries. Deliberately narrowly:

| Status | Retried? | Why |
| - | - | - |
| 429 | Any method | A refused request was never processed, so repeating it cannot apply anything twice. |
| 5xx | `GET` only | A 5xx is ambiguous - Attio may have applied the change and then failed to answer. On a `GET` there is nothing to apply. On a `POST` there is: a retried `POST /notes` duplicates the note, and Attio offers no idempotency key to prevent it. |
| other 4xx | No | Deterministic. The same request fails the same way. |

Four attempts, `Retry-After` honoured when Attio sends one and 0.5s/1s/2s backoff otherwise. Bounded, because a
permanently throttled account has to surface rather than absorb the whole run budget in sleeps - and if it does
absorb it, the budget stop above handles that cleanly.

**Beyond the retries, a transient failure before the first write no longer loses the event.** Every sync's standing
policy is to count a failed event and pass it over, never retrying, because its earlier writes are already committed
and a retry would duplicate them. That reasoning only holds once something *has* been written. A touchpoint's first
two Attio requests - the filtered person lookup and the Master TAM list read - write nothing, so a transient failure
there was being discarded for no reason: the counter and note were lost and the cursor advanced past the event
regardless.

A transient failure in that pre-write region now raises `ThrottledBeforeWrite` (`lib/attio.ts`, via `beforeAnyWrite`),
and the run stops with the cursor still **below** that event. The next run starts on it. Nothing is lost and nothing
can double, because nothing was written. The response reports `stopReason: "throttled"` and the run is still a
success with `failed: 0` - the work is deferred, not failed.

**All four syncs do this.** It started on Aircall, where 429s on query complexity made it the common failure, and was
extended to the other three after production logs showed the Instantly sync dropping touchpoints on bare Attio 500s -
the same loss, a different status code. The class and its wrapper live in `lib/attio.ts` rather than in any one
handler, because four `instanceof` checks against four separately-declared classes would silently stop matching.

Two things stay on the old pass-over path, both deliberately:

- **A deterministic failure** (a 404, a bad attribute slug) anywhere. It will fail identically on every future run,
  so stopping the run on it would wedge the sync on one unprocessable event.
- **A transient failure from the first write onward.** `incrementCounter` opens with a read but its `PATCH` is inside
  the same call, so a failure there cannot be told apart from one after it. Retrying would risk double-counting a
  Person, which is the worse outcome. This is a KNOWN GAP: a 429 or 500 landing between the Person counter and the
  Company note still loses the note and the Company counter, and says so in the log. Recovering those needs a
  dead-letter record for manual replay, which does not exist today.

### Why the Aircall window reaches back two hours

Aircall's `/calls` endpoint filters on a call's **creation** time. This sync places calls on its timeline by
**completion** time, because that is when a call becomes a countable touchpoint. The two
do not coincide, and the gap between them is the call's duration.

A call is therefore visible to the query from the moment it starts, but `fetchAircallCallWindow` discards it until it is
`done`. With a window only as wide as the completion window, a call lasting longer than that window was filtered out
as unfinished on every run covering its start, then fell out of range before it ever looked finished - lost
entirely. Longer cron intervals do not fix this; they only move the boundary.

So the request reaches back `MAX_CALL_DURATION_MS` (two hours) below the cursor. The extra calls the margin pulls
in were counted on earlier runs, and `isAfterCursor` rejects them.

**This sets a hard ceiling on call length.** A call is caught while its duration stays under roughly this value -
about 2h02m at the current setting, since the cursor trails the completion by up to `CURSOR_GRACE_MS`. Anything
longer is dropped in full, and dropped *silently*: it never reaches the fetch, so no
counter, log line, or failure entry records that it existed. Widening the constant costs pagination and nothing
else. Narrowing it below the longest call the account actually makes reintroduces exactly the loss it was added
to fix.

Aircall reports a number as `raw_digits`, punctuated for display (`+1 949-735-4000`), while Attio stores and matches
E.164 (`+19497354000`), so every lookup keyed on the raw value missed. `toE164` normalises it, and both Aircall paths
apply it: the interested route inside `extractAircallFields`, so the number written back to Attio is normalised
too, and the touchpoint sync before its own person lookup.

Every interested webhook is configured directly in the provider, pointed at the production host
`https://levanta-crm-overhaul.vercel.app`. Instantly, HeyReach and Outfound authenticate with an `x-webhook-secret`
custom header whose value must match the corresponding environment variable. Aircall cannot send a custom header;
it puts a per-webhook `token` in the JSON body instead, which must match `AIRCALL_WEBHOOK_TOKEN`. Each Aircall
webhook has its own token, so replacing the webhook means updating the variable. Subscribe it to
`outbound_campaign.outcome_recorded` only. Point providers at the production hostname, never at a
deployment-specific URL, which is pinned to a single deployment.

Outfound is a private API with no public documentation; the integration is written against the OpenAPI spec the
deployment serves itself, at `https://api.outfound.io/openapi-client.json` (rendered at `/scalar/client?org=sas`).
Its reads are slower than the other providers', and erratically so - the DNC list has been measured at 2.2s, 2.5s
and 14.7s on three consecutive calls at `page_size=1` - so the Outfound smoke tests carry longer timeouts than the
suite default.

**Its thread listing 500s on a timezone-aware date.** `GET /email-inbox/threads` answers
`{"detail":"An unexpected error occurred while listing email threads."}` for any `email_start_date` or
`email_end_date` carrying a designator - both the `Z` that `Date#toISOString` appends and an explicit `+00:00` do
it, on either bound, with or without the other. A naive datetime is accepted:

| Sent | |
| --- | --- |
| `2026-09-02T13:58:30Z` | **500** |
| `2026-09-02T13:58:30+00:00` | **500** |
| `2026-09-02T13:58:30` | 200 |
| `2026-09-02T13:58:30.198` | 200 |

That is the signature of a timezone-aware value being compared against a naive database column, so the column is
UTC and `outfoundNaiveUtc` sends UTC with the designator dropped - a workaround for an upstream bug, not a
formatting preference. Remove it only once Outfound accepts an offset, and re-check both bounds when doing so.

This shipped broken and reached production, because the smoke test read `?limit=1` with no window while the sync
reads a bounded one. There is now a live test that calls the listing the way the cron actually calls it.

`limit` is also capped server-side: the endpoint answers `"limit": 50` however much is asked for, so
`THREAD_PAGE_LIMIT` is 50 to match what is served rather than what would be preferred.
Its webhook auth header is one *we* configure - the Webhook Relay lets arbitrary headers be set per endpoint - so
`x-webhook-secret` is set there by hand rather than being a name Outfound chose.

The HeyReach integration uses `GetConversationsV3` cursor pagination, the current `GetCampaignsForLead` and `StopLeadInCampaign` endpoints, and the blacklist's `AddLeads` and `AddCompanies`.

HeyReach applies its `from`/`to` filter with **day** granularity, so a five-minute run receives every conversation
touched since UTC midnight, each with its full message list, and hashes every message before the per-message cursor
check rejects it. Cost therefore grows through the day. Pre-filtering out conversations with no activity past the
cursor would avoid most of that work; it is deliberately not done, so the per-message check absorbs the whole load.

Instantly uses the current v2 email schema (`timestamp_created`, numeric `ue_type`, nullable `lead`, and nested `body`) and its documented timestamp filters. Scheduled and automatic-reply emails are not counted as touchpoints.

## Configuration

Keep credentials in `.env.local` for local development and configure the same values in Vercel for deployment.

| Variable | Purpose |
| --- | --- |
| `ATTIO_API_KEY` | Attio API token with record, list-entry, and note permissions on People, Companies, and Deals |
| `ATTIO_DEFAULT_DEAL_OWNER` | Workspace member email used when creating a Deal |
| `ATTIO_PERSON_AIRCALL_COUNTER_SLUG` | Person counter slug for Aircall calls |
| `ATTIO_PERSON_INSTANTLY_COUNTER_SLUG` | Person counter slug for Instantly emails |
| `ATTIO_PERSON_HEYREACH_COUNTER_SLUG` | Person counter slug for HeyReach DMs |
| `ATTIO_COMPANY_AIRCALL_COUNTER_SLUG` | Company counter slug for Aircall calls |
| `ATTIO_COMPANY_INSTANTLY_COUNTER_SLUG` | Company counter slug for Instantly emails |
| `ATTIO_COMPANY_HEYREACH_COUNTER_SLUG` | Company counter slug for HeyReach DMs |
| `ATTIO_PERSON_OUTFOUND_COUNTER_SLUG` | Person counter slug for Outfound emails. Set to the same slug as the Instantly one: both count email touchpoints, on different mail |
| `ATTIO_COMPANY_OUTFOUND_COUNTER_SLUG` | Company counter slug for Outfound emails, likewise |
| `AIRCALL_API_ID` / `AIRCALL_API_TOKEN` | Aircall Basic Auth credentials, for the touchpoint sync and the interested route's call and contact reads |
| `AIRCALL_WEBHOOK_TOKEN` | The `token` Aircall puts in the body of every delivery from the `outcome_recorded` webhook. Unique per webhook |
| `AIRCALL_SYNC_BUDGET_MS` / `INSTANTLY_SYNC_BUDGET_MS` / `HEYREACH_SYNC_BUDGET_MS` / `OUTFOUND_SYNC_BUDGET_MS` | Optional, one per sync. Milliseconds that sync's loop may run before it stops and saves its place; each defaults to 240000. See [The run budget](#the-run-budget) |
| `INTERESTED_DUPLICATE_WINDOW_MS` | Optional. Milliseconds within which a second interested event for the same Person, from the same provider, is declined instead of recorded; defaults to 900000 (fifteen minutes), and `0` turns the check off. See [Repeated events are declined, not re-recorded](#repeated-events-are-declined-not-re-recorded) |
| `INSTANTLY_API_KEY` | Instantly v2 API key; needs to read emails and leads, and to write blocklist entries |
| `INSTANTLY_WEBHOOK_SECRET` | Secret configured as the Instantly `x-webhook-secret` custom header |
| `HEYREACH_API_KEY` | HeyReach API key; needs to read conversations, to stop leads in campaigns, and to add leads and companies to the blacklist |
| `HEYREACH_WEBHOOK_SECRET` | Secret configured on the HeyReach webhook as the `x-webhook-secret` custom header |
| `OUTFOUND_API_KEY` | Outfound client API key, prefix included; needs to read the inbox and prospects, and to write DNC entries |
| `OUTFOUND_WEBHOOK_SECRET` | Secret configured on the Outfound Webhook Relay as the `x-webhook-secret` custom header |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-side Supabase secret key; never expose it to a client |
| `CRON_SECRET` | Vercel Cron authorization secret |

Legacy Supabase JWT projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

A further provider adds two more counter-slug variables, named from its provider key - see
[Adding another platform](#adding-another-platform).

## Cursor persistence

All four syncs use `Attio_Integrations_Touchpoint_Cursors` instead of process memory. Rows are upserted with these stable keys:

- `aircall-touchpoints`
- `instantly-touchpoints`
- `heyreach-touchpoints`
- `outfound-touchpoints`

`cursor_timestamp` is the completed high-water mark. `cursor_value` contains a JSON array of event IDs at that exact timestamp, preventing events with identical timestamps from being lost or replayed. A missing row starts with a ten-minute lookback and is created automatically. `last_updated_at` is refreshed on every upsert.

At the end of a run the mark is parked at `now - CURSOR_GRACE_MS` (two minutes), not at `now`. Provider timestamps
are generated on the provider's clock and become readable through its API some time later; parking at the function's
own `Date.now()` silently skipped anything landing in that gap. Re-reading two minutes costs nothing, because
`isAfterCursor` rejects the overlap - and when the newest handled event is more recent than the parked value the
cursor is left untouched, so its boundary ID set survives and that event is not replayed.

**Outfound parks five minutes back instead of two** (`OUTFOUND_CURSOR_GRACE_MS`). The other providers publish an
event as they record it, so two minutes covers the gap between their clock and their API. Outfound does not: it is
an OLAP warehouse fed by a queue and refreshed on a cadence of about three minutes, so an email that has already
happened is routinely not yet readable. Parking at the shared two minutes would leave the mark ahead of emails
still in flight, and `isAfterCursor` would then reject them for good when they did land - a silent, permanent loss.

### A touchpoint that fails partway through

One touchpoint is three or four separate Attio writes, and Attio offers neither a transaction nor an atomic
increment, so a failure can leave some of them committed. The cursor advances past a failed event anyway, and the run
carries on with the rest of the window.

That is deliberate. Retrying the event would replay the writes that already succeeded, duplicating a note and
double-counting a counter, and an event that fails for a permanent reason would block every later touchpoint on every
future run. Passing over it costs one attempt.

The trade-off is that a failed touchpoint is recorded partially or not at all, and nothing will pick it up later. Each
one is reported so it can be reconciled by hand:

- an `[event] ... FAILED and passed over` line naming the event and the error
- a count in the `[run]` summary
- `failed` and `errors` in the response body, and a `500` status for the run

The Supabase server key must have `SELECT`, `INSERT`, and `UPDATE` access to the table. Keep it in Vercel server-side environment variables only.

## How the code is annotated

Comment tags mark what a block is *for*, so the diagnostic scaffolding can be told from the rules at a glance:

| Tag | Meaning |
| --- | --- |
| `[LOGIC]` | A business rule. Changing it changes what ends up in the CRM |
| `[DEBUG]` | Diagnostic only - a log line, or a branch that exists to make a failure legible. Removing it would change no record |
| `[SECURITY]` | A guard against writing the wrong data, exposing a secret, or acting on an unauthenticated request |
| `[STABILITY]` | What happens when something fails partway - what is already committed, what is retried, what is not |
| `[PERF]` | A cost worth knowing about: requests per event, how a window widens work |

Functions carry a `FLOW:` list of numbered steps in plain English, and a `USES:` line naming what they depend
on and where it lives, so a reader can follow a call without searching for its imports.

## Reading a run from the logs

Every environment read and every write is reported to the console, so a misconfigured deployment can be identified,
and a completed run replayed action by action, from the Vercel runtime logs without redeploying instrumented code.
Secret values are never logged.

| Prefix | Meaning |
| --- | --- |
| `[env]` | Whether a variable is set, its length in characters, and whether stored surrounding whitespace had to be trimmed |
| `[config]` | The full value of a non-secret identifier: attribute slugs, `SUPABASE_URL`, and which Supabase key variable was used. `ATTIO_DEFAULT_DEAL_OWNER` is reported by domain only |
| `[auth]` | Why a cron or webhook request was accepted or rejected, distinguishing an unconfigured secret from an absent header, a missing `Bearer` prefix, and a value that differs by case, whitespace, or length |
| `[credential]` | A provider answered `401`/`403`, naming the variables that hold that provider's key |
| `[slug]` | Attio rejected a counter attribute, naming the slug so the matching `ATTIO_PERSON_*` or `ATTIO_COMPANY_*_COUNTER_SLUG` can be checked |
| `[route]` | The decision a webhook made before touching Attio: that an Instantly event was not `lead_interested`, or which Aircall outcome was ignored or handed to the background job, which HeyReach lead is being handled - the HeyReach line also names the event HeyReach called the delivery and the campaign it came from, which is what tells one cause of a repeated delivery from another, and falls back to a keys-and-types shape dump when the payload names no event at all. Ends with a line counting the history entries summarised and the platforms that failed to suppress, or saying the event was declined as a repeat. Aircall's background job ends with a `completed` line, or with `FAILED after Aircall was told OK` naming the call |
| `[dedupe]` | The repeat check: that this Person already carried this run's note from inside the window and the event was declined, or that the note listing could not be read or could not be read to the end - in which case the event is recorded anyway, because dropping a real interested lead costs more than a duplicate note |
| `[interested]` | The shared interested workflow's own verdict, for every provider: completed with the person, deal and company it finished with, or declined as a repeat of an event already recorded |
| `[lookup]` | Each person, company, and deal search and its result, naming the attribute searched and the record matched, plus whether that person is on the Master TAM list. A company line also says when the person was already linked to one, or when neither Attio nor the provider names one and the deal will be named for an unknown company. An Instantly lead lookup names which enrichment fields arrived, by field name only. The deal line reports both outcomes - how many deals the person already had and which is being reused, or that they had none and one is being created - because "checked and found none" and "never checked" must not read alike |
| `[action]` | Each write and its outcome: person or company created, a record updated with the attribute list, a record left untouched because every target attribute was already populated, deal created, deal reused, note added, blocklist entry added, counter moved from one value to the next. A failure is reported as `[action] FAILED` naming the action and record before the error propagates |
| `[suppress]` | One line per outbound platform - suppressed, skipped with the identifier it lacked, or `FAILED` with the reason - then a summary naming every platform and its outcome. A failure here is reported, not raised: the Attio record was already written. The HeyReach line carries two figures, how many campaigns the lead is in and how many of those still live ones they were withdrawn from, because no campaign is ever halted and a single count read as though one had been, followed by the lead and company blacklist results |
| `[attio]` | An attribute was not written and the event continued anyway: a multiselect left alone because its existing entries could not all be read back, so a replacing write would have risked deleting real data; or a value Attio rejected, named individually, with a count of what was written and what was dropped |
| `[event]` | Why one polled touchpoint was skipped: no phone or lead email on the record, no Attio person matched, or the person is not on the Master TAM list. |
| `[run]` | One summary per sync: how many records were in the window, how many were processed, skipped, off-TAM, or failed and passed over, and the new cursor. Aircall's `fetched` count includes the two-hour reach-back, so most of it is normally before the cursor. Every sync also states how many records in its window came from before the cursor and were passed over as already counted, so the line accounts for the whole window rather than leaving the shortfall to be inferred; the response bodies carry it as `beforeCursor`. On HeyReach that figure is normally most of the window, because its fetch is day-granular - see the `[PERF]` note in the sync |

A `401` from a cron route means the guard rejected the request, not that the function failed. The `[auth]` line
states which case applied. Note that Vercel only attaches the `authorization` header once `CRON_SECRET` exists in
the project's environment variables, and adding it requires a redeploy before it reaches a running deployment.

Secret confidentiality is enforced by a test: no `[env]`, `[auth]`, or `[credential]` path may print a configured
secret. Note that `[lookup]` and `[event]` lines do carry the business identifier being matched - an email address,
a phone number, or a LinkedIn URL - because a miss is not actionable without it. Those are not credentials, but they
are personal data in a retained log.

## Verification

**Every test in `tests/live` is a real network round trip**, so the file sets a 20s default with
`setDefaultTimeout`. Bun's own default is 5s, and two calls sit right on that line - HeyReach's
`GetConversationsV3` answers in about 4.7s and Attio's note listing in about 5.0s - so they passed alone and
failed inside a full run. A smoke test that only fails under load is worse than no smoke test: this suite is
what stands between a renamed attribute or a stale option ID and records that go silently unwritten, and one
that cries wolf stops being read. The Outfound tests keep their own longer overrides, which are about that API
being erratically slow rather than about the baseline.

Run the compiler and isolated unit suite:

```sh
bun run check
```

The unit suite mocks every external write and covers provider response validation, pagination, handlers, touchpoint
event identity, Attio helpers, and Supabase cursor persistence. The shared interested workflow is covered
separately in `tests/unit/interested.test.ts`: the attribute transforms at each bucket boundary, the never-overwrite
rule and the Lead Source exception to it, the multiselect merge and the cases where it declines to write, the strict deal naming, and suppression
continuing across platforms after one of them fails, and HeyReach blacklisting an email-only lead and naming a
full or refused blacklist.

Run opt-in, read-only smoke tests against configured live accounts:

```sh
bun run test:live
```

`bun test` sets `NODE_ENV=test`, and Bun skips `.env.local` in that environment, so the script passes
`--env-file=.env.local` explicitly. Without it every live test fails on a missing variable rather than on anything
it was meant to check.

Live tests do not create, update, stop, or delete anything, and they do not print returned account data. They cover
two kinds of failure:

- **Credentials.** One small page is read from Supabase, Attio, Aircall, Instantly, HeyReach, and Outfound, which
  proves each key is accepted. The Outfound checks also read its DNC list, so the suppression channel is known to
  have somewhere to write, and its `/rate-limit` endpoint, which reports the tier the touchpoint sync is spending
  one request per thread against. The HeyReach check also reads its lead and company blacklists and prints how
  many entries each holds, since a full list (1,000 by default) makes suppression fail.
- **Schema and configuration.** All eight counter slugs are checked against the live Attio attribute list for the
  people and companies objects, both list slugs against the workspace's lists, and `ATTIO_DEFAULT_DEAL_OWNER`
  against the workspace members. A wrong slug or a renamed list is caught here rather than on the first touchpoint
  that happens to reach it in production. `CRON_SECRET` and the three webhook secrets are checked for presence,
  which is all that can be verified without a caller.

## Deployment

`vercel.json` selects Vercel's Bun `1.x` runtime and schedules the Instantly, HeyReach and Outfound syncs every five minutes and the Aircall sync every ten (`*/10 * * * *`). Vercel also detects `bun.lock`, so dependency installation uses Bun rather than npm.

Every function under `api/` is given `maxDuration: 300`. One touchpoint is up to eight sequential Attio requests and
the work is unbounded by design, so at the platform default a busy window could be cut off mid-event, leaving a note
written and its counter not. Three hundred seconds is the Pro ceiling; the project already exceeds Hobby's cron
limits, so it cannot be running there.

`maxDuration` is a backstop, not a plan. All four syncs stop themselves at `DEFAULT_RUN_BUDGET_MS` (240s) and save
their cursor, because being killed at `maxDuration` discards the run entirely - see [The run budget](#the-run-budget).
Raise `maxDuration` before raising that budget, never the other way round.

Attio counter updates remain read-then-write because Attio does not expose an atomic increment operation. The sync
handlers process events sequentially, and a failed event is passed over rather than retried, as described under
[A touchpoint that fails partway through](#a-touchpoint-that-fails-partway-through). Nothing guards against two
invocations of the same sync running at once, so avoid overlapping manual runs.
