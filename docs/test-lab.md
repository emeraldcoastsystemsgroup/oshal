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

---

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
