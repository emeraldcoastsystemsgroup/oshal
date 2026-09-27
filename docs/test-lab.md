# AI Test Lab (ADR-063)

> Open work: [backlog/test-lab.md](./backlog/test-lab.md)

A black-box harness that answers two questions on demand or on a nightly schedule:

1. **Does each tool still work, and do the apps compose** into the real cross-app workflows a user
   would actually ask for? (the interactive Test Lab surface)
2. **Does the swarm still produce the right answers** to complicated requests — graded against a
   fixed expected output, with a morning report? (the nightly golden loop)

See [ADR-063](adr/063-ai-test-lab.md) for the decision record.

---

## Part 1 — Interactive Test Lab (manual)

A surface that drives the **real** app endpoints with your session cookie forwarded, so every step
runs exactly as you would in the browser. Open it at **cockpit → Optimization → AI Test Lab**
(the sidebar's former "Cloud & Ops" group was split into Connections / Security / Optimization,
2026-07-07).

Three kinds of scenario:

- **Individual tools** — one-click smoke test per app (career, presentations, storage, calendar,
  Shop, travel, email).
- **Coupled multi-app workflows** — run as real chained steps; the lab is the orchestrator because
  Jarvis does not chain apps (it answers/dispatches one action per ask). Seeded:
  - *Job pack → deck → save → email* — top jobs → generate a resume → build a `.pptx` → save to
    storage → email a copy.
  - *Birthday + gift* — add the birthday to the calendar → find a Lego set → build the checkout
    handoff.
- **Jarvis routing** — fire each command at Jarvis and confirm it understands + dispatches.

Each step reports an honest state: **pass** / **degraded** (alive but needs a connected account,
fell back to demo/local, or async) / **gap** (capability missing — a finding) / **fail**.

### How to run it

1. Sign in to the cockpit (the runner uses *your* session, so results reflect your connections).
2. Open **AI Test Lab**, click **Run all** (or **Run** on one scenario).
3. Read the per-step badges; expand a card for the detail.

> "Run all" is synchronous and can take ~2 minutes (mostly Jarvis polling). It creates a few real,
> clearly-labelled rows (a calendar event, a generated deck). The `email me a copy` step needs the
> Google account you're signed in as to have the `gmail.send` scope (reconnect Google at
> /utilities once — the connector now requests it).

API: `GET /api/test-lab/catalog`, `POST /api/test-lab/run` (both `requiresAuth`).

### Artifact exchange and Jarvis registrations

The existing catalog includes **Artifact picker and tool metadata** (`artifact-discovery`, Tools)
and **Jarvis artifact target and confirmation** (`jarvis-artifact-handoff`, Jarvis). Each card's
**Regression suites** section identifies its unit, integration and browser test files. The paths
remain in the existing Vitest tree so the normal local test run continues to discover them.

The discovery scenario reads the active source/destination catalogs and validates the real YAML
tool load. The Jarvis scenario mints a short-lived handle over a Test Lab sample visual, checks the
actual model's named email target and ambiguous request in separate Lab chat sessions, and checks
that an unconfirmed email request returns 428. It never dispatches the proposed destination.
It creates Lab chat turns and consumes model usage when run; unavailable prerequisites remain
visible as degraded/gap rather than passing. Browser selection and replay behavior are covered by
the linked browser suites, not claimed by these server-side probes.

Run the associated isolated regression suites locally with `npm run test:artifacts`. Registration,
HTTP assertions and negative cases are themselves covered by
`tests/unit/test-lab-artifact-registration.spec.ts`. Registration in source does not claim that the
updated catalog or its live-model scenarios have already run on the deployed instance.

### Social signal subscriptions

**Social signals — your watches reach only your bot** (`social-signal-subscriptions`, Tools) runs
four steps over the signed-in caller's own `/api/content/subscriptions` routes:

- a watch naming a bot this swarm does not run is refused (`400 unknown_bot`) before anything is
  stored;
- the caller's watches are listed;
- the delivery audit of a subscription the caller does not own answers `404`;
- the caller's first watch returns its delivery audit (message id, bot lane, correlation id,
  claimed/published times). With no watch yet this step is degraded, not failed.

A passing run registers, publishes and disables nothing. If the bot refusal ever regresses, the
step disables the watch it accidentally created and reports fail. The card does not register a
watch or wait for the 15-minute poll, so it does not observe a live stream event.

Run the linked suites locally with `npm run test:social-signals`. The real-boundary suite
(`tests/unit/social-signal-subscriptions-postgres.spec.ts`) starts its own PostgreSQL and Redis.
Against the non-superuser enforcing role, under deny-by-default identity, it proves that one
subscription produces exactly one event on its owner's bot lane with a matching delivery audit
row, and that another user cannot read the subscription, the captured post, the delivery row or
the stream event. That is local evidence. Registration in source does not mean the card has run
on the deployed instance, and nothing here claims a live provider capture or a bot consuming the
lane.

### LinkedIn content queue

**LinkedIn content queue — ticket to confirmed publish** (`linkedin-content-queue`, Tools) runs
three read-only steps over the signed-in caller's own `/api/linkedin-assistant` routes:

- a publish without explicit confirmation answers `428`. It is probed on draft id 0, which a SERIAL key
  never issues, so even a regressed gate finds nothing to post;
- the caller's queue-created drafts name their source ticket and carry a citation list. Published
  ones are counted with the params hash that joins their connector audit rows. With no queue draft
  yet this step is degraded, not failed;
- an unknown draft id answers `404`, exactly as another owner's does.

A run drafts, approves and publishes nothing. Run the linked suites locally with
`npm run test:linkedin-content`. The real-boundary suite
(`tests/unit/linkedin-content-queue-postgres.spec.ts`) starts its own PostgreSQL and a local LinkedIn
protocol double. It takes one queue ticket through the real dispatcher to a confirmed publish on the
caller's brokered token, and proves the audit join, the ticket write-back and the denial paths. That is
local evidence. It does not show that a deployed Social package ran a ticket, or that a real LinkedIn
post was made.

### Messaging channels

**Messaging channels — what can reach your swarm** (`channel-inbound-bindings`, Tools) reads the
caller's own `GET /api/channels` and fails unless the surface reports a wired/not-wired state for
Telegram, SMS, WhatsApp and Discord plus the caller's linked identities. It is read-only.

**Messaging channels — one message in, one answer out, strangers refused**
(`channel-inbound-round-trip`, Tools) has one step per provider (Telegram, Discord, SMS, WhatsApp).
Each step runs as the signed-in caller through the real identity store, the provider's real inbound
processor and the real refusal ledger. It mints a code, links a lab-prefixed synthetic identity (a
fictional 555-01xx number for SMS and WhatsApp), sends one message twice with the same occurrence
id, and sends one from a never-linked identity. It passes only when exactly one bot turn ran for the
caller under the caller's non-operator identity carrying the caller's verified issuer, the answer came back, the duplicate was refused, and
the stranger was refused with a committed refusal-ledger row. The bot turn and the provider send are
doubled, so a run spends nothing and messages no real account. The lab link is removed afterwards;
the occurrence claims and the refusal row stay as permanent receipts (the runtime role can only
insert them). Without a signed-in caller and the app database each step is degraded.

**Messaging channels — is the Discord bot set up and connected** (`channel-operator-setup`, Tools)
reads `GET /api/channels/admin/discord` as the caller. The route is operator-only, so a non-operator
and a missing session degrade rather than fail. For an operator it passes when no bot is configured
(naming the cockpit card that enables one) or when the bot is configured and the Gateway is
connected, and fails with the exact fix when the state names a problem: Discord rejected the saved
token, or the Message Content intent is off in the Developer Portal. It is read-only.

Run the linked suites locally with `npm run test:channels`. The real-boundary suites
(`tests/unit/chat-channel-inbound-postgres.spec.ts`, `tests/unit/chat-channel-denial-audit.spec.ts`,
`tests/unit/chat-channel-principal-issuer.spec.ts`, `tests/unit/sms-inbound-dispatch.spec.ts`,
`tests/unit/chat-channel-admin-postgres.spec.ts`) start their own PostgreSQL. The admin suite also
runs a local HTTP server speaking Discord's identity reads and a local Gateway, and
`tests/unit/chat-channel-setup-card-browser.spec.ts` drives the cockpit card in headless Chromium. The principal-issuer suite sends each linked message through the real
controller delegation client and verifies the signed token names the owner and the issuer. Against the non-superuser
enforcing role under forced RLS they drive the real Telegram webhook over HTTP, the real Discord
Gateway client over a local WebSocket server, and the real signed Twilio webhook for SMS and
WhatsApp. That is local evidence: registration in source does not mean the card has run on the
deployed instance, and nothing here is a real Telegram, Discord or WhatsApp message.

---

## Application-installed smoke cases

Active applications register their manifest `smoke:` declarations and optional
[versioned suite catalog](testing/package-test-catalog.md) through the application
loader. Reload and update replace that app's cases; deactivation and uninstall retract them. A fresh
controller rebuilds the inventory through normal app loading. Each case carries its owning app,
installed version, source/content revision, level and execution prerequisites. The catalog also identifies
apps without declarations and groups whose coverage belongs to their members.

The Lab displays only apps available to the caller and checks access again before each execution.
Eligible GET/HEAD cases run through the existing installation smoke verifier. Service-authenticated
checks require an operator; PAT checks require the caller's PAT. AI and mutating cases remain
registered but pending a suitable approved runner. Registration itself does not execute tests.

The **Installed application test registration** card (`installed-app-tests`) checks catalog identity
and prerequisites without running application smokes. **Connector sign-in callback boundary**
(`connector-oauth-boundary`) probes anonymous refusal paths without connecting a provider.
**Multi-store discovery** (`multi-store-discovery`) reads registry status and qualified package
identities without installing packages or changing trust. Their linked local suites run using
`npm run test:platform-readiness`.

Eligible offline package Node suites now use a disposable runner with Run/Cancel controls and
durable versioned history. See [package test execution](testing/package-test-execution.md) for
supported prerequisites, current-user authorization, isolation and local regression commands.
Unsupported runners remain pending; further runner fixtures and remaining package adoption are in
the [application registration backlog](backlog/app-test-lab-registration.md).
Source registration and fixture tests do not establish deployed provider or production results.

The autonomous-run cards also register isolated nightly regressions, manifest bot initialization,
first-run setup, specialist facts and Jarvis briefing preferences. Access administration includes
principal inventory, Users, root protection and scoped audit history. Each card's linked source suites
have a matching command in [tests/README.md](../tests/README.md); browser probes only perform their
documented read steps and never execute arbitrary host commands.

## Part 2 — Nightly golden loop

Submits "golden" complicated requests as **real tickets**, lets them flow through the **same swarm
queue**, polls each to a terminal state, reads the produced result, and **grades it against a fixed
expected output**. Failing scenarios are **re-run** (the swarm is non-deterministic — keep the best
attempt); a scenario still failing gets a **drafted suggested fix** written into the report.

### Propose-you-approve (the safety model)

The loop runs unattended overnight, so it is deliberately bounded:

- It **measures, re-runs, and proposes**. It **never edits framework prompts/code** and never
  auto-applies a fix.
- It auto-commits **only** the report + the score baseline (`docs/test-lab-reports/`).
- Any suggested fix lands in the morning report as a proposal. You approve one, then it gets applied
  + committed (by you / by a follow-up task) — nothing that could break the platform ships while you
  sleep.

### How grading works

Per golden scenario (`src/app/routes/test-lab-golden.ts` → `GOLDEN[]`), the expected output is:

- `mustComplete` — the swarm must reach `complete` for the run to count as a **pass** (see below).
- `requiredKeywords` — all must appear in the produced result.
- `requiredArtifacts` — at least N files in the ticket's workspace deliverables.
- `rubric` — what a correct result looks like, scored 0-100 by an LLM judge.

Heuristic score (terminal status + artifacts + keywords + test-construct credit) is blended with the
judge score; `passScore` is the threshold. A run **passes** only when `score ≥ passScore`, a real
deliverable was produced, **and** the swarm actually reached `complete`. A run that produced a good
deliverable but **escalated** instead of completing is surfaced as `degraded` (not pass, not
hard-fail) — escalation is currently the *dominant* golden outcome (the swarm auto-escalates from
`in_process_build`), so we keep that visible rather than counting it as green. Each run is persisted
to `test_lab_golden_runs` **and** to `eval_runs` (the Eval Wall — Part 3), with cost (read from the
central ledger), latency, and retries captured.

### Headless wiring (why it can run with no browser)

- The engine is mounted under `serviceSecretOr()` at `POST /api/test-lab/golden/run`, so the
  host-side runner authenticates with `SWARM_SERVICE_SECRET` (no OIDC session). It also sends the
  configured `TEST_LAB_OWNER_SUB` in `X-OSHAL-User-Sub`; the API accepts that binding only after
  validating the secret, then stamps it as a non-operator database identity for the entire batch.
- Tickets are created server-side via `ctx.ticketService` with that same owner sub, so the row owner
  and the RLS connection identity agree. A secret-authenticated request missing the owner binding is
  rejected before any scenario starts instead of receiving cross-tenant operator access.
- Results are read from the bind-mounted `workspace-shared/<ticketId>/deliverables/`.
- The git commit happens on the **host** (the report path `docs/` isn't mounted into the container).

### Setup

```powershell
# 1. (one-time) register the nightly Windows task — runs 04:30 daily, wakes the PC, catches up after sleep
powershell -ExecutionPolicy Bypass -File scripts/register-test-lab-nightly.ps1

# 2. test it right now (creates real tickets; takes as long as the swarm needs)
node scripts/test-lab-nightly.mjs all          # full set + commit the report
node scripts/test-lab-nightly.mjs g-phone-validator --no-commit   # one scenario, no commit
```

Requirements: `SWARM_SERVICE_SECRET` and `TEST_LAB_OWNER_SUB` set in `.env`; the api container
running; the swarm worker bots online (the tickets need them to produce results).

### The morning report

Written to `docs/test-lab-reports/<date>.md` (+ `latest.md`, `baseline.json`) and git-committed:

- a pass/fail table with each scenario's score, the **trend vs last night**, attempts, and ticket
  status;
- per-scenario detail (what the grade was based on);
- any **suggested fix** as a clearly-marked proposal awaiting your approval.

### Tuning

- `TEST_LAB_MAX_ATTEMPTS` (default 2) — re-runs before giving up.
- `TEST_LAB_OWNER_SUB` — required OIDC sub the nightly runner sends as its trusted user binding;
  tickets, evaluation calls, persistence, and batch polling are scoped to this owner.
- `TEST_LAB_API` (host runner) — defaults to `http://127.0.0.1:${OSHAL_API_PORT:-35457}` (the
  api container's 5000 published to the host). The runner waits for this endpoint to be reachable
  before kicking off, so a 04:30 wake where Docker is still starting doesn't lose the night.
- Add/edit golden scenarios in `GOLDEN[]` in `src/app/routes/test-lab-golden.ts` (then rebuild).

### Not yet (deferred)

- Emailing the report (the send endpoint is `requiresAuth`, not service-secret; the report is
  committed + on disk for now).
- Auto-applying an approved fix (today: you approve, then it's applied as a normal change).
- Awaiting async sub-artifacts (resume/deck generation) to full completion before grading.

---

## Part 3 — Eval Wall (the green wall)

Every golden run is also written to `eval_runs` and rolled up on a read-only dashboard, so the lab is
a **history**, not just "0/1 today." Open it at **cockpit → Optimization → Eval Wall**.

It shows the axes a buyer expects, with a per-day success-rate trend sparkline:

- **Success rate** over the window, **cost**, **avg latency**, **avg retries**, **quality** (mean
  final score), and **security posture**.
- **Cost is read from the central ledger**, not re-instrumented: `captureTicketCost` sums the
  ticket's `chat_tasks` cost via `ticket_task_links` (the same place every LLM call records), so it
  works for any ticket.
- **Security posture** is the viewer's live Security Center findings (open critical/high), not a
  per-run number.
- **Honest-null:** anything a run didn't measure shows as a muted dash, never a fabricated 0.

It is self-populating — the nightly golden loop writes each run. Seed history without waiting:
`node scripts/eval-wall-seed.mjs`.

API: `GET /api/eval-wall/summary` (rollup + `trend` + `securityPosture`), `/runs`, `/app`
(`requiresAuth`). Unit tests for the rollup/trend math: `tests/unit/eval-wall-rollup.spec.ts`.
