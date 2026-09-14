# marketing suite — end-to-end application spec

> **Status: SPEC (partly built), 2026-09-13.** The campaign engine, its consent gates, the scorecard
> and budget proposals exist (store package `marketing-engine` 0.4.x); everything this document marks
> **missing** is not built. Each "exists" row was checked against code on 2026-09-13 and cites where.
> External prices come from the [market scan](../business/marketing-suite-market-research.md) (read
> 2026-09-13, planning bands ±30%, re-check at adoption). Work items with done-when criteria live in
> the package backlog: [`marketing-engine/BACKLOG.md`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/marketing-engine/BACKLOG.md).
> Earlier design: [marketing engine spec](../business/marketing-engine-spec.md) (ADR-131/132/133).
>
> **P0 landed in the repos on 2026-09-14, not yet on the box** — store `4b8984e5` and core
> `477f3a0b` (both on open PRs): marketing-engine 0.5.0 with three readiness probes and its route
> module split (all 20 routes unchanged), the `marketing-suite` ADR-141 group front door, the
> compose passthrough for the four marketing env names, and a store write-class ledger that now
> follows a route's package-local import closure. Installing it on the running stack and the two
> operator steps are the rest of P0; both are items in the package backlog.

## 1. Outcome

Take a product from *built* to *launched and growing* inside the swarm, end to end:

**position → plan → budget (a finance project) → produce → publish (social, email, SMS) → capture
sign-ups → nurture → measure → reallocate → retro.**

It serves two owners with the same code, because every table is owner-scoped (`user_sub`, FORCE
RLS): the operator marketing oshal products (the two motions in the marketing engine spec), and any
user who installs the suite to market their own product with their own accounts.

**Rules that do not bend** (operator directives + CLAUDE.md):
- Anything that acts outward on someone's behalf is **opt-in, default OFF**; an opt-in gate reads its
  own row with **no fallback** (automation opt-in directive, 2026-07-24).
- A human approves every outward action unless that human has explicitly armed a bounded standing
  authorization (caps + kill switch) for that exact thing.
- Numbers are never invented: a missing source is **NO DATA**, not zero.
- Connector credentials never reach a model; exact server operations do the I/O (ADR-036, ADR-133).
- Application code ships from the store repo; core changes are framework dependencies listed in §9
  and need operator approval (CLAUDE.md Rule 0c/0d).

## 2. What exists today (checked 2026-09-13)

| Capability | State | Where |
|---|---|---|
| Campaign board, stage gates, experiments, approvals, 4 inline bots (campaign-director, market-analyst, growth-analyst, launch-coordinator) with ADR-083 routing | exists | `marketing-engine/oshal-app.yaml`, `src-routes/marketing-routes.ts` |
| Per-channel owner consent (linkedin, mastodon, bluesky, email), daily caps, 428 confirm, run ledger incl. skips | exists | `marketing-routes.ts`, `migrations/001-marketing-core.sql` |
| Publish to LinkedIn / Mastodon / Bluesky | exists (manual, confirm-gated) | `marketing-routes.ts`, `marketing-bluesky-operation.ts` |
| X / Facebook publishing | exists in Switchboard and social, not in the engine | `switchboard/`, `social/` packages |
| Email send | **partial** — one recipient, one send per content item, plain text; Resend action has no `headers` and no batch | `swarm-apps/connectors/resend.yaml`; `marketing-routes.ts` |
| Gmail / Outlook send | exists, one recipient, text/plain, confirm-gated | `email-summarizer`, `src/app/routes/email-routes.ts` |
| Scheduled social publishing | exists but **off** (`SWITCHBOARD_PUBLISH_EXECUTOR` unset); engine `standing_authorization` is inert | `switchboard/src-routes/switchboard-calendar-routes.ts` |
| Media on social publish | **missing** (HTTP 501 `media_attach_unsupported`) | `switchboard/src-routes/switchboard-compose-routes.ts` |
| Content production (posts, decks, video, graphics, portraits) | exists in sibling apps; hand-off by text brief (`prepare-*` integrations) | `content-routes.ts`, `presentations`, `video`, `vids`, `brand-graphics`, `portrait-studio` |
| Metrics ingest (Search Console, PostHog, GitHub traffic) + weekly review ticket (backlog-gated) | exists; PostHog always `resource_unavailable`; rows carry no `campaign_slug`/`medium` | `marketing-ops-routes.ts` (INSERT omits the attribution columns) |
| UTM link builder | exists | `marketing-routes.ts` |
| Site analytics plumbing | exists, **off** until `SITE_ANALYTICS_PROVIDER` is set | ADR-132, `scripts/lib/product-site/analytics.js` |
| Campaign budget + decision ledger (propose → approve → apply) | exists; `reallocationProposals()` is never called; no spend actuals | `marketing-model.ts`, `marketing-routes.ts` |
| Finance | exists as Plaid read-only aggregation + Stripe pay; **no project or budget entity** (tables: items, data, payments) | `finance/src-routes/finance-routes.ts` |
| SMS | **missing for marketing** — Twilio sends only to the user's own phone; inbound webhook logs only; CLI retired; US A2P 10DLC unregistered | `src/app/routes/twilio-sms-operation.ts`, `sms-inbound-routes.ts`, `docs/channels/twilio.md` |
| Contacts / subscribers / recipient consent / lists / suppression / unsubscribe | **missing** (the only marketing consent table is the owner's per-channel authorization, not recipient consent) | code search, both repos |
| Sign-up forms / waitlist capture | **missing** | BACKLOG "Marketing engine — remaining phases" |
| Paid ads connectors | **missing** | no ads connector specs |
| Suite front door | **missing** — apps appear individually; no group | ADR-141 groups exist (e.g. `intelligent-career`) |

## 3. Capability map — what "end to end" requires

"Common" = present in most products in the [market scan](../business/marketing-suite-market-research.md#what-the-scanned-products-have-in-common).

| # | Capability | Common? | Today | Target | Owner | Phase |
|---|---|---|---|---|---|---|
| C1 | Launch planning: positioning, ICP, launch plan with dated milestones, asset checklist, retro | partly | campaigns + bots | launch plan object tied to calendar and assets | marketing-engine | P3 |
| C2 | **Budget as a finance project**: envelope, channel allocations, commitments, actuals, variance, approvals | top tiers only | per-campaign number | finance `project` linked to the campaign | finance + marketing-engine | P2 |
| C3 | Audience: contacts, recipient consent evidence, lists, segments, suppression, CSV import with attestation | yes | missing | owner-scoped audience store | marketing-engine | P1 |
| C4 | Capture: hosted sign-up form, double opt-in, UTM capture | yes (free tiers) | missing | public form route + confirm email | marketing-engine | P1 |
| C5 | Email broadcasts: HTML + text, one-click unsubscribe, postal footer, suppression, domain-auth preflight, batching under caps, delivery events | yes | single plain send | compliant broadcast pipeline | marketing-engine + core connector spec | P1 |
| C6 | Sequences / drips with per-recipient state | yes (paid tier) | missing | sequence armed once, runs within caps | marketing-engine | P3 |
| C7 | SMS campaigns: express written consent, STOP/HELP, quiet hours, cost ledger | add-on | missing | consented SMS lists over BYO Twilio | marketing-engine | P4 |
| C8 | Social calendar across engine + Switchboard, media attachments, scheduled publish | all-in-ones | split, executor off, 501 on media | one calendar; scheduled publish under standing authorization | switchboard + marketing-engine | P3 |
| C9 | Attribution: UTM → sign-up → conversion; email/SMS delivery + click metrics; per-campaign funnel | yes | ingest without attribution | campaign-level funnel on the scorecard | marketing-engine | P5 |
| C10 | Paid ads: read spend into finance actuals first; budget changes only via proposal → confirm | top tiers | missing | Google/Microsoft/Meta/LinkedIn ads read, then write | core connectors + marketing-engine | P6 |
| C11 | Compliance center: consent evidence export, suppression management, contact deletion, sender identity, quiet hours | implicit | missing | one settings/compliance pane | marketing-engine | P1–P4 |
| C12 | Suite front door: ADR-141 group with a setup dashboard driven by member readiness probes | n/a | missing | `marketing-suite` group | new store package | P0 |

## 4. Architecture

**Packages.** No new platform service. Work lands in existing store packages plus one group:
- `marketing-engine` — the hub: campaigns, audience, forms, broadcasts, sequences, SMS campaigns,
  scorecard, approvals. `marketing-routes.ts` is at 974 code lines (cap 1,000; the 800-line rule
  requires a decomposition plan before adding code), so **P0 splits it** into per-area route modules
  (campaigns, channels/publish, budget, audience, sends) before any new endpoint lands.
- `finance` — owns the new **project** entity (budget, allocations, actuals). Marketing stores only
  `finance_project_id` and reads the project summary through finance's owner-scoped route from the
  surface (same session), so neither package reads the other's tables.
- `switchboard` / `social` — keep social publishing; gain media attachments and the scheduled
  executor behind an explicit opt-in.
- `marketing-suite` (new, `kind: group`, carries no code) — one toolbar borrowing member surfaces and
  a setup dashboard (§6 P0).

**Data (new, all `user_sub`-keyed with owner FORCE RLS like migration 001):**
- `oshal_marketing_contacts` (email, phone, name, timezone, source, created_at)
- `oshal_marketing_consents` (contact, channel `email|sms`, purpose, status `pending|confirmed|revoked`,
  evidence JSON: form text, timestamp, IP, user agent, UTM, confirmation token hash; confirmed_at,
  revoked_at, method)
- `oshal_marketing_lists`, `oshal_marketing_list_members`
- `oshal_marketing_suppressions` (normalized address/number hash, reason `unsubscribe|bounce|complaint|stop|manual`)
- `oshal_marketing_forms` (slug, list, fields, double opt-in flag, confirmation copy)
- `oshal_marketing_messages` (channel, subject, html, text, audience, status `draft|approved|sending|sent|cancelled`)
- `oshal_marketing_deliveries` (message, contact, provider id, status, event timestamps)
- `oshal_marketing_sequences`, `…_sequence_steps`, `…_enrollments`
- finance: `oshal_finance_projects` (name, kind, budget total, currency, period, status),
  `oshal_finance_project_lines` (allocation per channel/category), `oshal_finance_project_actuals`
  (source `manual|plaid|ads|sms|email|invoice`, amount, date, reference, evidence)

**Public routes.** Sign-up, double opt-in confirmation, one-click unsubscribe (RFC 8058 POST) and
provider webhooks must be reachable without a session. Packages may declare `auth: public` routes
(store `AUTH_MODES`; precedent: `vids` mounts one). Each public route: POST-only where RFC allows,
signed single-purpose tokens, per-IP and per-form rate limits, a honeypot field, no data returned
beyond an acknowledgement, and provider signature verification on webhooks (Resend/Svix, Twilio
`X-Twilio-Signature`). Every public route is a reviewed row in `store-route-inventory.json`.

**Reasoning.** Bots draft copy, pick segments, summarize the scorecard and propose reallocations —
inline via `executeBotOrInline`, cost to `chat_tasks`. Bots never send; the routes do, after the gates.

**Send gate chain** (extends today's publish chain; every step writes the run ledger, skips included):
owner channel consent → recipient consent `confirmed` → not suppressed → sender domain verified
(SPF/DKIM via the Resend `domains` read) → compliance lint (postal address, unsubscribe link and
headers, quiet hours for SMS) → daily cap → approval (428 confirm, or an armed standing authorization
for that sequence) → send in batches → delivery events.

## 5. End-to-end flows

1. **Launch a product.** New campaign → market-analyst ICP card → positioning and message map →
   launch-coordinator checklist with dates on the calendar → "Create budget" hands off to finance,
   which creates the project and returns its id → asset briefs go to Content Studio, AI Office, video,
   brand graphics (`prepare-*`) → social, email and SMS items are scheduled → approvals → launch day →
   the weekly review ticket carries the numbers → retro note on the campaign.
2. **Capture and nurture.** Public form → pending consent with evidence → confirmation email →
   `confirmed` → welcome sequence (armed once, runs within caps) → one-click unsubscribe → suppression.
3. **Broadcast email.** campaign-director drafts → preview with the compliance lint result → approve →
   batched send under the cap → delivery, bounce and complaint webhooks update deliveries and
   suppressions → scorecard.
4. **SMS campaign.** Consented SMS list → quiet-hours check in the recipient's time zone → approve →
   send → STOP/HELP handled on the inbound webhook → per-message cost recorded as a finance actual.
5. **Budget loop.** Finance project budget → channel allocations → actuals (manual, tagged Plaid
   transactions, ads spend, SMS/email usage) → variance on the weekly review → `reallocationProposals()`
   drafts moves → approve → apply writes the ledger and updates the finance allocations.

## 6. Roadmap (phases)

Order: make the suite visible and configured → compliant email (highest value, package-local) →
the finance-tied budget → automation → SMS (waits on carrier registration) → attribution → paid ads
(needs a paid product and conversion tracking first).

| Phase | Delivers | Done when |
|---|---|---|
| **P0 Foundation** | operator accounts/config from the runbook; compose passthrough for the variables the api reads (§9); `marketing-routes.ts` split under 800 lines per module; `readiness:` probes in marketing-engine; the `marketing-suite` group with setup steps; the existing weekly ticket proven with one real campaign | the group installs and its setup page reports every step from a member probe; one Monday review ticket has appeared from a real campaign; every marketing route module is under 800 code lines with the existing suites green |
| **P1 Audience + compliant email** | C3, C4, C5, C11 (email part) | a real sign-up completes double opt-in; a broadcast reaches only confirmed, unsuppressed contacts with a DKIM-signed `List-Unsubscribe` + `List-Unsubscribe-Post` pair and a postal footer; a one-click unsubscribe from a real mailbox suppresses the contact within one request; a bounce and a complaint webhook each create a suppression; every refusal path has a guard test |
| **P2 Budget as a finance project** | C2 | a campaign creates a finance project; manual and Plaid-tagged actuals roll into budget vs actual on both surfaces; an approved reallocation updates the finance allocation and the decision ledger in one transaction; another owner cannot read the project (RLS test on the enforcing role) |
| **P3 Automation + social calendar** | C1, C6, C8 | a sequence armed once sends step two only to still-consented contacts inside caps; disarming stops the next step; one calendar shows engine and Switchboard items; a scheduled post publishes only under an explicit standing authorization; media attaches on at least X and LinkedIn |
| **P4 SMS** | C7, C11 (SMS part) | carrier registration approved on the business account; a consented number receives a campaign text inside quiet hours; STOP from a real handset suppresses within one webhook; HELP answers with the program text; message cost lands as a finance actual |
| **P5 Attribution** | C9 | a UTM-tagged link produces a sign-up attributed to its campaign; email and SMS delivery/click counts appear per campaign; the funnel shows NO DATA for any source not connected |
| **P6 Paid ads** | C10 | spend from one ads account reads into finance actuals daily; a budget change on the ads account happens only after an approved proposal; three monthly reallocation cycles are recorded |

## 7. Free and paid options

**Running the suite (vendor costs; bands from the market scan, re-check at adoption).**

| Stack | What it uses | Monthly cost band | Gains | Gives up | Reverse later |
|---|---|---|---|---|---|
| **Free-first** (recommended start) | Resend free (3,000 emails/mo, 100/day); Bluesky, Mastodon, LinkedIn organic; PostHog free (1M events); site analytics via the ADR-132 provider; no SMS | $0 plus domain you already own | proves the whole flow end to end at no cost | 100 emails/day ceiling; no SMS | trivial — upgrade the Resend key's plan |
| **Starter paid** | Resend Pro $20/mo (50k emails); Twilio Low-Volume Standard 10DLC ($4 brand + $15 vetting one-time, $1.50–$10/mo campaign, $1.15/mo number, $0.0083/segment + carrier fees) | ≈ $25–45/mo + SMS usage | real list sizes; SMS | carrier registration takes weeks; business entity needed | cancel plans; registration is sunk cost |
| **Growth** | Resend Pro overage ($0.90/1k) or Postmark; dedicated IP only when volume warrants; ads spend as its own finance budget | usage-driven | deliverability headroom; paid acquisition | cost scales with sends and ad spend | reduce volume; ads budgets are per-proposal |
| Buy instead (reference) | e.g. HubSpot Starter $20/seat/mo (1,000 contacts, ≤10 automation actions); Mailchimp Standard from $20/mo; Kit Creator $39/mo | $20–50/mo entry; campaign budgets at HubSpot Pro $800/mo | features on day one | data and automation at the vendor; budget-to-finance link only at top tiers; no swarm bots or approvals | export contacts; re-implement flows |

**Packaging the suite itself.** The suite is a public store package set; every user brings their own
keys (Resend, Twilio, social, ads) through the connector hub, so there is no platform-paid messaging.
Anything later offered commercially (for example managed deliverability or an ads operator) would be a
separate package in the private repo; this spec does not set prices.

## 8. Compliance requirements (each becomes a guard)

From the [market scan §I](../business/marketing-suite-market-research.md#i-compliance-any-email-or-sms-feature-must-meet):
- **Email:** truthful headers/subject; postal address in every marketing message; unsubscribe that
  works without login, is honored immediately in-product (well inside CAN-SPAM's 10 business days,
  Gmail's 48 hours, Yahoo's 2 days) and keeps working ≥60 days (CASL); RFC 8058 one-click headers
  DKIM-signed; SPF/DKIM aligned and DMARC present before any bulk send; demonstrable consent records
  (GDPR Art. 7); marketing vs transactional kept separate.
- **SMS:** prior express written consent recorded per campaign (TCPA / CTIA evidence fields); opt-in
  confirmation message with program name, HELP, frequency and fees; STOP family keywords in any case;
  one final opt-out confirmation; no sends before 8 a.m. or after 9 p.m. recipient-local; registered
  10DLC or verified toll-free sender.
- **Both:** no rented or purchased lists (CSV import requires an attestation and records source);
  consent export and contact deletion on request.

## 9. Framework (core) dependencies — need operator approval

| Need | Why | Change |
|---|---|---|
| Resend actions: `headers` on send, batch send | RFC 8058 headers and batching are impossible through today's action (`additionalProperties: false`, single recipient) | `swarm-apps/connectors/resend.yaml` |
| ~~Env passthrough~~ — **merged in core `477f3a0b` (PR #431), reaches the container at the next recreate** | the api container receives only the variables compose enumerates; all four marketing names now sit on the api service and are pinned by `tests/unit/compose-env-passthrough.spec.ts` | `docker-compose.oshal-local.yml` + `.env.example` |
| PostHog bounded stats resource | the scorecard's site-traffic row cannot fill without it | `swarm-apps/connectors/posthog.yaml` |
| Ads connectors (P6) | spend read and budget write for Google/Microsoft/Meta/LinkedIn | connector specs + hub provider entries + deterministic provider intents |

Twilio inbound for STOP/HELP is designed as a package public webhook with signature verification, so
it needs no core change; the existing core inbound sink stays as is.

## 10. Decisions for the operator

| Decision | Option | Gains | Gives up | Cost to reverse |
|---|---|---|---|---|
| **Where the audience lives** | **A. oshal tables in marketing-engine (recommended)** | data stays in your database; one consent model for email and SMS; works with any sending rail | unsubscribe, suppression and forms are ours to build (P1) | low — export contacts |
| | B. Resend Audiences/Broadcasts as the list | hosted unsubscribe; less code | list lives at the vendor; 1,000 free contacts; email only | medium — re-import, re-consent evidence may not transfer |
| | C. An external ESP (Kit, MailerLite, Brevo) | full feature set on day one | another vendor; our connectors to them are read-only today | medium |
| **Sign-up capture** | **A. package public form route + double opt-in (recommended)** | own data; UTM captured at the source | a public route to secure and review | low |
| | B. ESP-hosted form | no code | data at the vendor; attribution harder | low |
| **Automation** | **A. per-sequence standing authorization, default OFF, caps + kill switch (recommended)** | sequences run without per-email clicks once armed | the arming decision is yours per sequence | instant — disarm |
| | B. every send approved by hand | maximum control | sequences are impractical | none |
| **SMS timing** | **A. wait for the business-account move, then Low-Volume Standard 10DLC (recommended)** | registration under the business identity once | SMS waits | none |
| | B. Sole Proprietor now | fastest | < 1,000 msgs/day, one number, personal identity | re-register later |

## 11. Test and proof plan

Per CLAUDE.md "Tests accompany new functionality" and the real-boundary corollary: every gate in §4
gets a refusal test; RLS isolation is proven against the enforcing role and real schema; public routes
get rate-limit, token-forgery and signature-forgery tests; each phase registers its suites and a smoke
in the AI Test Lab; live proof (a real mailbox, a real handset, a real ads account) is recorded
separately from local results and is what closes a phase.

## 12. Non-goals

No purchased or rented lists; no bot-posting to Hacker News, Reddit or Product Hunt (humans post,
per the launch-coordinator persona); no platform-paid messaging keys; no credentials in any model
context; no marketing of the personal finance/trading tooling (marketing engine spec §1).
