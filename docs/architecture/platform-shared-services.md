# Platform Shared Services (2026-07)

As-built reference for the cross-cutting platform services added in the 2026-07-15/16
gap-list build and round2. These are **not apps** — they are framework-governed capabilities
every app rides on. Each is auth-gated (`requiresAuth`) and caller-scoped by `user_sub`, with
operator (`OSHAL_OPERATOR_SUBS`/`OSHAL_OPERATOR_EMAILS`) able to see across scopes where noted.

Proof of deploy: `docs/evidence/gap-list-build-2026-07-15.md` and
`docs/evidence/gap-list-round2-2026-07-16.md`. Deferred follow-ups (with done-when criteria)
live in [BACKLOG.md](../BACKLOG.md) under "Gap-list build leftovers".

Decisions with their own ADRs: [ADR-104](../adr/104-cost-governance-budgets-and-runaway-kill-switch.md)
(cost governance), [ADR-105](../adr/105-connector-write-actions-tier.md) (connector write-actions),
[ADR-106](../adr/106-shared-llm-judge-service.md) (shared LLM-judge),
[ADR-107](../adr/107-run-trace-read-model-observability.md) (run-trace). The remaining services below
(global-search, notifications, data-lifecycle, DLQ, persona-evals, bot-node-auth) follow existing
patterns and are documented here as-built rather than in separate ADRs.

## Services

### Spend budgets + runaway kill switch — `src/features/cost-governance`
Daily USD caps per `user` / `app` / `ticket` scope (`oshal_budgets`), enforced pre-dispatch in
the queue manager and on the interactive execute path. **Fail-open** with a WARN on any infra
gap (missing table, DB down) — never bricks dispatch; **fail-closed** (block + `oshal_budget_events`
audit row + operator notification) only when a HARD cap or the runaway threshold is definitively
exceeded; soft caps only warn. Runaway detector counts recent executions per ticket
(`OSHAL_BUDGET_RUNAWAY_MAX`=25, `OSHAL_BUDGET_RUNAWAY_WINDOW_MIN`=30). Spend sums
`chat_tasks`/`oshal_cost_events` using the same joins as the cost rollups so the numbers agree.
Routes: `/api/budgets`. **No budget rows = no enforcement.** Distinct from the older env-only
`BudgetService` in `src/features/llm-provider/governance`.

### Write-capable connector actions — connector runtime + `connector_action_audit`
Optional `actions[]` on `connector.schema.json` (`{name, method, urlTemplate, paramsSchema,
riskLevel, approvalRequired}`) turn the GET-only catalog into an actor. The action executor
validates params, resolves the caller's per-user broker token (never raw secrets), routes
`riskLevel≥medium`/`approvalRequired` through the tool-approval + risky-write guards, executes the
real HTTP call, and writes every attempt to `connector_action_audit`. Route:
`POST /api/connectors/:id/actions/:action`.

### Global search — `src/features/global-search`
One caller-scoped search over the user's own data via a pluggable `SearchSource` adapter interface
(tickets, chat history, personal-data, RAG collections, storage index). RLS/GUC-correct; never
returns cross-user rows. Route: `GET /api/search`. Surface: `tool-global-search`.

### Shared LLM-judge — `src/features/quality-judge` + the `quality-judge` concierge bot
Grading is LLM work, so it runs on a bot, not the controller. `JudgeService.grade({task, output,
rubric, reference?})` routes to the **quality-judge concierge** (inline on `oshal-api`, claude-code,
registered in **both** bot registries) and returns one strict JSON verdict `{score, dimensions,
rationale}`. A deterministic **lexical fallback** (`mode: 'lexical-fallback'`) runs under
`FORCE_LLM_PROVIDER=noop` or when the bot is unavailable, so tests run free. Route: `/api/judge`.
Consumed by Token Chase step 4, persona-evals, and the LinkedIn assistant.

### Persona regression evals — `src/features/persona-evals`
Golden-task suites (`ai-lab/persona-evals/*.yaml`) with **tiered assertions**: structural
(mechanically checkable now) and semantic (graded via the quality-judge when an LLM lane is
available). Runner: `scripts/persona-eval.ts`; routes `/api/persona-evals/*` (operator-gated).
⚠ The **noop lane exits 1 by design** — semantic assertions cannot pass without an LLM; do **not**
wire the noop lane as a CI gate.

### Notification preference center — `src/features/notifications`
Per-user `topic → channel` routing (`user_notification_prefs`) over the existing transports
(the user's own Gmail via `sendGmail`, their Twilio SMS, Telegram) with quiet hours
(America/Chicago). `NotificationRouter.notify(userSub, topic, {...})` resolves prefs, respects
quiet hours, and dispatches through a transport registry; sends/skips are logged and never throw
into callers. Routes: `/api/notify/*`. The career digest consults it while keeping its own once/day
cursor + opt-out.

### Per-user data export/delete — `src/features/data-lifecycle`
An exporter registry (`{store, exportRows, deleteRows}`) covering the Postgres stores.
`GET /api/me/export` streams a per-store JSON bundle + manifest (connection **metadata only** —
tokens are never exported). Delete is two-step: `POST /api/me/delete-request` issues a short-lived
signed token, `POST /api/me/delete-confirm` executes via the registry and writes a retained
`data_lifecycle_audit` row; operator subs are refused. Known gaps (Chroma/Arango) are disclosed
in-product via `KNOWN_EXPORT_GAPS`.

### Queue dead-letter / poison-ticket — `DeadLetterService`
After `QM_MAX_ATTEMPTS` (default 3) failed/aborted dispatch cycles a ticket moves to a terminal
`dead_letter` state (extends the existing status model — not a parallel one) with the reason
captured, and the operator is notified (topic `queue-dlq`). Routes: `GET /api/queue/dlq`,
`POST /api/queue/dlq/:ticketId/requeue` (operator).

### Bot-node execute auth — `src/app/bot-node-server.ts`
`/api/swarm-execute` (and siblings) require `X-Service-Secret` matching `SWARM_SERVICE_SECRET`.
Posture: **fail-closed** (401) when the secret is configured; **loud WARN, allow** when it is not
(local-dev compatibility) — so a stock local boot works and the secure posture is one env var away.
`BotNodeClient` sends the header on every call.

### Run tracing — `src/features/run-trace`
A **read-model** (no new instrumentation) that assembles one ticket's waterfall — ticket → phase
spans (`ticket_status_history`) → bot executions (`ticket_task_links` ⋈ `chat_tasks`) → per-LLM-call
cost (`oshal_cost_events`) — sorted by time. `totals.costUsd` sums the ledger so it equals the budget
number. Authorization is on `owner_sub` **before** any child read; a ticket the caller can't see
returns the same not-found as a missing one (no existence leak). Routes: `/api/trace/:ticketId`
(JSON), `/api/trace/:ticketId.html` (rendered), `/api/trace/app`. Surface: `tool-run-trace`.
Per-call token/duration on llm-call spans is deferred (the ledger has no per-event split) — see BACKLOG.

## Token Chase step 4 / 4b
The step-4 **LLM-judge assessor** grades baseline vs variant replay outputs via `JudgeService`
(persisting `{judgeScore, dimensions, mode}` into the corpus, Jaccard retained as a fallback +
comparison), and the step-4b **judged savings report** produces the headline per-lane cost/quality
table. The report **separates llm-judged from lexical-fallback frames** and never blends them into
one "verified" number. Extends `/api/token-chase`. See [ADR-046](../adr/046-token-chase-checkpoint-replay-optimization.md).

### A2A gateway (2026-07-18) — `src/features/a2a-gateway` + outbound `a2a` harnessType
External, non-OSHAL agents can join and be joined over the A2A protocol — distinct from the
operator's-own-devices `remote-client` rail. Default-off (`A2A_GATEWAY_ENABLED`) agent card curated
by the ADR-087 access-role denylist; per-agent hashed credentials + capability scopes (never a
global secret); inbound `message/send` files a real ticket under a synthetic `a2a:<agentId>` sub so
budgets/DLQ/run-trace all apply; outbound `a2a` harnessType dispatches to an external agent as a
first-class target (an ADR-033 harness sibling); cost lands real-or-honestly-flagged, never a
silent `$0`. Mesh stays internal — this is the only path external agents ride. See
[ADR-109](../adr/109-a2a-gateway-external-agents-join-the-swarm.md) for the full decision, the three
adversarially-found vulnerabilities closed pre-ship, and the deploy-gate follow-ups tracked in
[BACKLOG.md](../BACKLOG.md) ("Plan F").

## App-layer additions (not shared services, listed for completeness)
- **Outlook/M365** — `scripts/oshal-outlook.js` + a `microsoft-outlook` connector added to the email
  swarm (ADR-037 "a provider = a connector + a CLI" pattern). Needs an Azure app registration.
- **LinkedIn AI Content Assistant** — `swarm-apps/social.yaml` `ticketType: linkedin-content`,
  `workerBot: social-writer`; draft → quality-judge score → one refine → pending-approval →
  scheduled → publish (human-gated, via the caller's LinkedIn broker token; clean skip when
  unconnected). Surface `/api/linkedin-assistant/panel`.
