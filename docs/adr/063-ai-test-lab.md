# ADR-063 — AI Test Lab: black-box end-to-end scenario runner across the app swarm

- **Status:** Accepted — BUILT 2026-06-21 (route + scenario registry + cookie-forwarding runner +
  per-tool smoke tests + two coupled multi-app scenarios + a Jarvis-routing pass + surface).
  Extended 2026-06-21 with the **nightly golden loop**: real tickets through the swarm queue, graded
  vs a fixed expected output, re-run on failure, propose-you-approve, a morning report committed by a
  host-side runner. Extended again 2026-06-21 with the **Eval Wall** (`§eval-wall`): every run
  persisted to `eval_runs` and rolled up on a green-wall dashboard (success rate, cost, latency,
  retries, quality, live security posture, success-rate trend). See [docs/test-lab.md](../test-lab.md).
- **Date:** 2026-06-21
- **Related:** [ADR-032 (Process Lab — non-invasive trace runs)](032-process-lab-non-invasive-trace-runs.md),
  [ADR-050 (Unified Assistant / Jarvis)](050-unified-assistant-route-orchestrator.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md)

## Context

The swarm now has ~30 apps, each with its own surface and API. We had no single place to answer
"does each tool still work, and do the apps **compose** into the real cross-app workflows a user
would actually ask for?" — e.g. *"build a deck of my top job opportunities, save it to Dropbox, and
email me a copy,"* or *"add Jason's birthday to my calendar and buy him a Lego gift."*

Two realities from investigating Jarvis (ADR-050) and the app APIs shape the design:

1. **Jarvis does not chain apps.** One `/api/jarvis/ask` turn = one logical action: Jarvis answers
   inline or emits a single handoff directive (simple → background worker; complex → PM/swarm
   ticket). It never pipes app A's output into app B in one ask; `routed`/`handoffs` are always
   empty. So a coupled workflow is **multiple steps**, not one Jarvis call.
2. **Some steps have no API yet** (e.g. email *send* — the email routes are read-only), and some
   need a connected account (Dropbox, Walmart, Gmail) or fall back to local/mock. An honest harness
   must **detect and report** these gaps rather than fake a green.

ADR-032's Process Lab traces a single *ticket* through the lifecycle; it is not a multi-app,
multi-scenario API driver. So the Test Lab is a sibling, not a fork of it.

## Decision

Build an **AI Test Lab**: a black-box end-to-end driver that runs **scenarios** — ordered steps,
each a real HTTP call to a sibling app endpoint (or a Jarvis ask) — and reports per-step and
per-scenario pass/fail with the captured request/response.

### 1. The runner — real endpoints, forwarded session

The lab calls the **real** app routes over loopback (`http://localhost:$PORT/api/...`) and
**forwards the caller's session cookie**, so every step runs exactly as the signed-in user would,
through the same auth + per-user scoping. No logic is re-implemented or mocked by the lab itself.

### 2. Scenarios — three kinds

- **Tool smoke tests** (one step each) — hit each app's primary action and assert a sane response.
  "Run the process for an individual tool" and "run all."
- **Coupled scenarios** (multi-step, the lab is the orchestrator since Jarvis can't chain) — each
  step may consume a prior step's `output` (job list → deck sections → saved file). Seeded:
  - **Job-pack → deck → save → email**: career-hunter top-N recent jobs → generate a resume →
    build a `.pptx` → save to the storage target → *email a copy*. The email step is a **detected
    gap** (no send endpoint) — reported, not faked.
  - **Birthday + gift**: add the birthday to the calendar → search a Lego set → build the
    purchase checkout deep-link handoff.
- **Jarvis routing** — fire each command at `/api/jarvis/ask` and assert Jarvis accepts + answers
  or dispatches. This tests *routing/understanding*, not chaining (which Jarvis doesn't do).

### 3. Honest result states

`pass` (asserted ok), `degraded` (endpoint alive but needs a connected account / returned a
fallback / async-dispatched), `gap` (no capability exists — actionable finding), `fail` (error).
The lab's value is as much in surfacing `degraded`/`gap` as in green checks.

### 4. Shape — a direct-mounted lab, like Process Lab

Mounted at `/api/test-lab` in `server.ts` (not a swarm-app manifest/bot — it orchestrates the
others, it isn't a domain bot). Surface served at `/api/test-lab/app`, reachable from a cockpit
"Lab" entry. Scenarios are declared in the route module; adding one is a small data edit.

### 5. Eval Wall (green wall) — `§eval-wall`

Every golden run is also persisted to an `eval_runs` table and surfaced on a read-only **Eval Wall**
(cockpit → Optimization → Eval Wall since the 2026-07-07 sidebar regroup; originally Cloud & Ops),
so the lab is more than "0/1 passed today" — it is a history
with a real success rate. The wall shows the six axes a buyer expects — **success rate, cost,
latency, retries, quality score, security posture** — plus a per-day success-rate trend.

- **Cost is read, never re-instrumented.** `captureTicketCost` reads the framework's central cost
  ledger (`chat_tasks` joined to the ticket via `ticket_task_links`) — the same place every LLM call
  already records — so cost works for any ticket, not just the lab.
- **Security posture is the live system's**, read from the Security Center's own findings
  (`oshal_security_findings`) for the viewer, not a per-run field.
- **Honest-null:** any axis a run could not measure is stored and shown as null, never a fabricated 0.
- **Pass semantics (honest, corrected after diagnosis):** a run passes only when it scored
  `≥ passScore`, produced a real deliverable, **and actually reached `complete`**. Diagnosing the
  golden tickets showed escalation is the *dominant* outcome (the swarm auto-escalates from
  `in_process_build`, with no reason recorded), so an escalated-but-well-scored run is surfaced as
  `degraded` — **not** counted as green. Counting escalations as passes would manufacture green over
  a real, systemic swarm gap; the wall stays honest and that gap stays visible for fixing.
- API: `GET /api/eval-wall/summary` (rollup + trend + live posture), `/runs`, `/app` (`requiresAuth`).

## Consequences

- One click answers "is the platform healthy and do the apps still compose?" — per-tool and
  end-to-end — with a real, auth-respecting trace.
- It documents, in running code, exactly where cross-app composition breaks today (email send,
  Jarvis-can't-chain) so those become prioritised work, not surprises in a demo.
- Because it drives the real endpoints, it doubles as a living integration test and a demo script.

**Risks / sharp edges:**
1. **Side effects** — coupled scenarios create real rows (a calendar event, a generated deck). Kept
   clearly labelled ("Test Lab smoke") and minimal; destructive cleanup is out of scope for v1.
2. **Async steps** (resume generation returns 202) are scored `degraded` (dispatched), not awaited
   to completion in v1.
3. **Loopback + cookie forwarding** assumes the lab and the apps share one process/origin (they do).

## Deferred

- A real email-send capability (would turn the email step from `gap` to `pass`).
- Awaiting async work items (resume/deck generation) to completion + asserting the artifact.
- ~~Scheduled/CI runs + historical pass/fail trend storage.~~ DONE — nightly Windows task +
  `eval_runs` history with a success-rate trend on the Eval Wall (`§eval-wall`).
- An optional AI analyst that reads a run and summarises what broke (reason-only bot).
