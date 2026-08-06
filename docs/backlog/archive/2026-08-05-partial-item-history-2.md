# Additional completed sub-items removed from partial backlog entries — 2026-08-05

These snapshots preserve mixed implementation narratives removed from the active queue.
Only `docs/BACKLOG.md` is authoritative for current work.

---

## Codex live-credential precedence and seed liveness

### Codex auth: no keepalive, and the seed copy of the credential is dead (for @codex-session)
- **Context:** found while wiring the image provider. Two separate things, both real:
  1. **`config-seed/secrets.json`'s codex blob is a never-rotated SEED.** It carried no `last_refresh`
     at all, while the live `~/.codex/auth.json` (which the harness reads, and — since the
     token-stranding fix `f556b4db` — writes the rotated token back to) had refreshed the day before.
     **Any consumer resolving the swarm's OpenAI credential from `secrets.json` holds a dead token
     forever even while codex auth is perfectly healthy.** Fixed on the read side in
     `swarm-credentials.ts` (`ac343436`) — `resolveCodexAuthSourcePath()` mirrors the harness and
     prefers the live source, warning on seed fallback. Anything *else* reading the seed for OpenAI
     auth has the same latent bug.
  2. **There is no codex token keepalive.** A `OSHAL Claude token keepalive` scheduled task exists;
     codex has none. Its access token only refreshes when codex actually runs.
- **Done when:** (a) an audit confirms nothing else resolves OpenAI auth from the seed copy (or those
  call sites are moved onto `getSwarmApiKey`), and (b) either a codex keepalive exists (mirroring the
  Claude one) or a deliberate note records that on-demand refresh is sufficient and why.

**Verified 2026-07-19:** PARTIAL — main resolver reads the live `~/.codex/auth.json` first; `cline-runtime-config-sync-service.ts` `buildCredentialBag` still reads the dead seed blob; on-demand refresh replaces keepalive by design.

---

## CI Playwright origin fixes and cleared quarantine history

### CI Playwright e2e suite normalization (~132 specs)
- **Context (2026-07-05/06):** the CI Test job's `npm test` e2e was fully red. Fixed so it
  BOOTS and CONNECTS: `FORCE_LLM_PROVIDER=noop` (server booted claude-code and crashed keyless),
  Postgres+Redis service containers + `RUN_MIGRATIONS`, and `PLAYWRIGHT_PORT=3456` (18 specs
  hardcode `http://localhost:3456` but the mock webServer defaulted to 4458 → mass
  `ERR_CONNECTION_REFUSED`; a local repro looped 6h on retries). The deterministic gates
  (lint/typecheck/secret-scan/quickstart-smoke + the 869-test unit step) are all green.
- **Reason still open:** even with a DB + aligned port, individual e2e specs fail on real
  assertions, and base-URL conventions are inconsistent across the suite (some hardcode 3456,
  one hardcodes 35457, others read `PLAYWRIGHT_PORT`/`baseURL`). This is an unmaintained e2e
  suite, not a single bug — a spec-by-spec normalization + triage pass.
- **Done when:** all e2e specs derive their origin from the Playwright config `baseURL`
  (relative `page.goto('/…')`) — no hardcoded ports; the suite runs green (or its genuine
  failures are quarantined with `test.fixme` + a reason) in the CI Test job. Interim: consider
  making the e2e step non-required (the deterministic gates remain the merge signal) until it's
  normalized.

**Verified 2026-07-19:** OPEN — 32 hardcoded localhost:3456/35457 origins across 16 specs; the green-ratchet list is still the 07-06 snapshot.

**Verified 2026-07-19 (completion-day):** the origins-normalization clause is LARGELY RESOLVED — `816f13ab` added the shared `tests/helpers/test-origins.ts` helper and parameterized the hardcoded `localhost:3456/35457` origins on `PLAYWRIGHT_PORT` across the e2e suite, dropping the count from 32-across-16-specs to **5 lines in 2 files** (`session-140-runtime-usability.spec.ts` + the `oshal-chat-config-migration` unit spec). The broader done-when (every e2e derives from `baseURL` and the suite runs green) still has the spec-by-spec triage tail — but the "base-URL conventions are inconsistent" reason is now mostly closed via the shared helper.

**Quarantined 2026-07-19 (6 mis-categorized greens, NOT a regression):** the closing completion-day nightly reproduced 6 deterministic e2e-green failures that were ALSO red in every pre-completion-day baseline (573d6fd7 / a9995e51 / 9d70cd11) — i.e. standing CI-env reds wrongly left in the 07-06 local-Windows ratchet, red-and-ignored for weeks (the exact `agent-profile-persistence` situation). Moved to the quarantine block in `tests/e2e-green-suite.txt` so the gate is honest-green again and a NEW red is actionable. The 6 + root-cause notes:
**Update 2026-07-19 (verification pass — 2 of 6 CLEARED, a real product bug found under the other 3):**
- ✅ **CLEARED** `provider-runtime-selection.spec.ts:46` — env, confirmed: `resolveRuntimeProviderName()` hard-overrides to `FORCE_LLM_PROVIDER` BEFORE any plan/act selection, so under noop the stub is the only possible outcome and there is no product endpoint that introspects the send-message selection independent of the force-override. Fixed spec-only: `test.skip` when `FORCE_LLM_PROVIDER==='noop'` with a clear reason. Verified green (skips cleanly) 3×; re-added to the ratchet. (Real plan-vs-act selection coverage still wants a real-provider-gated env — follow-up.)
- ✅ **CLEARED** `cockpit-calendar-agent-visibility.spec.ts` (:22 + :39) — env empty-DB, confirmed. Both cases now self-seed a ticket `assignedAgentId=code-developer` (a registered swarm agent, so its label always appears in `#calBotFilter`), and the browser case opens the calendar via the framework ribbon + `__cockpit.switchView` (bare `/cockpit/` lands on the heavy Jarvis surface whose load churn blocks clicks). :39 no longer skips — it is now a real guard. Verified green 3×; re-added.
- ✅ **RESOLVED 2026-07-19 (same day):** the `timeAgo` import was added to `ticket-view-detail-renderer.js` L16 (the pane-wide render crash is fixed) and `ticket-activity-rollup.spec.ts`'s `resolveWorkspaceRoot` now mirrors the server's `/app/workspace` branch — chosen over the `SHARED_WORKSPACE_ROOT` harness line precisely because that line would shadow the three green `CLINE_WORKSPACE_ROOT` specs. Both files un-quarantined; verified 3 CI-mirror runs, final 5/5 clean zero retries. Original finding kept below for the record.
- ~~STILL QUARANTINED — real product bug, mis-diagnosed as env/wait~~ `ticket-activity-rollup.spec.ts` (:141) and `ticket-cost-rollup-by-bot.spec.ts:134`: clicking a ticket row throws `ReferenceError: timeAgo is not defined` — `src/pages/cockpit/js/views/ticket-view-detail-renderer.js` calls `timeAgo()` at L149/150/413 but never imports it (`TicketView.js` imports it from `../utils/formatters.js`; the detail renderer's import at L16 omits it). So `buildDetailMarkup` throws and `#tvDetailPane` is stuck on "Loading..." on EVERY ticket-detail render — the pane is universally broken, not a race. Confirmed at committed HEAD (files unmodified vs HEAD; no `window.timeAgo` fallback). **Fix = add `timeAgo` to the L16 import of ticket-view-detail-renderer.js** (one line, product code). Once fixed, `ticket-activity-rollup.spec.ts` also needs `SHARED_WORKSPACE_ROOT` set in `ci-local.sh` `gate_e2e` so the server and the spec agree on one workspace root (`:112` fails because `/app/workspace` exists on the CI host and the server resolves there while the spec seeds `workspace-shared`) — verified :81/:99/:112 pass with a shared root; note that env line must not shadow the three green specs that set their own `CLINE_WORKSPACE_ROOT` (`SHARED_WORKSPACE_ROOT` wins the precedence), so add it with those verified.
- ⏸️ **DEFERRED** `calendar-app-queue-browser.spec.ts:54` — carve-touched; fix depends on the post-carve ribbon fixture. Leave quarantined until after the carve lane completes.
- **Done when (adds to the parent's):** the `timeAgo` import bug is fixed and `ticket-activity-rollup.spec.ts` + `ticket-cost-rollup-by-bot.spec.ts` are un-quarantined (with the `SHARED_WORKSPACE_ROOT` harness line), and `calendar-app-queue-browser.spec.ts` is re-root-caused post-carve — never left quarantined as a silent coverage hole. Today's completion-day HEAD added ZERO new e2e failures and net-fixed the chroma/RAG family (transformers cache pre-seed + the BM25 `/get` mock gap).

---

## A2A gateway implementation and isolated-agent proof

### Plan F — A2A gateway deployment and interoperability
The gateway itself is built, adversarially reviewed, and live-proven against a real standalone
(non-OSHAL) A2A agent —
see [ADR-109](../../adr/109-a2a-gateway-external-agents-join-the-swarm.md) for the full decision record.
It ships **default-OFF**: with `A2A_GATEWAY_ENABLED` unset the routes stay structurally 404
(deliberate — deploy precedes enable), so "shipped" here means the code path, not a reachable
deployment. The three residual done-whens below are open, which is why this entry is not ✅ DONE.
Agent card + curated discovery, per-agent hashed credentials + scopes (no global secret), inbound
`message/send` → real ticket under a synthetic `a2a:<agentId>` sub, outbound `a2a` harnessType,
real-or-flagged cost attribution, mesh stays internal. Three vulnerabilities found by adversarial
review were fixed pre-ship (RLS identity leak on inbound writes, cost double-count/zero-bill on
outbound, ADR-087 role-gate bypass on A2A-sourced call-outs) — see the ADR's Consequences.
Remaining work, tracked here rather than reopening the ADR:
- **Done when:** migration `089-a2a-gateway.sql` is applied (met as of 2026-07-19 — see stamp) and `A2A_GATEWAY_ENABLED` (+
  `A2A_PUBLIC_BASE_URL`, `A2A_MAX_INBOUND_PER_HOUR`) are set on a real deployment, so the gateway is
  reachable outside a test harness (today it stays structurally 404 everywhere).
- **Done when:** the inbound path is proven to a completed ticket (not just filed + state-mapped) —
  the 2026-07-18 proof deliberately used an isolated DB so the live paid api could never dispatch a
  security-proof ticket; a deployed-stack run closes that gap without that constraint.
- **Done when:** a real third-party A2A implementation (a different vendor's agent, not a
  hand-built standalone one) completes the same message/send → tasks/get round trip.

**Verified 2026-07-19:** residuals OPEN — migration 089 IS applied, but the gateway env vars are unset in compose/.env.example (still structurally 404), there is no deployed inbound→completed-ticket proof, and no non-first-party vendor round-trip.

---

## Workflow Studio pack-output implementation and vision ledger

### Workflow Studio — bot-driven; the canvas is a *view* of a conversation, not a hand editor
- **Design:** [ADR-039 — bot-driven workflow authoring](../../adr/039-bot-driven-workflow-authoring.md)
  (the spec contract + the 5-slice build order; packer = the one-shot option of this same flow).
- **Operator's live-build vision (2026-06-15, refines ADR-039):** chat with codex-packer in the
  STANDARD cockpit screen (packer bot rendered larger but same look; a bot filter to show only the
  packer). As you talk, a **workflow explorer on the LEFT** builds the graph LIVE — you watch it
  "searching for tools → identifying existing bots → generating new bots → assembling the process,"
  bots appearing as they're created. The operator wants this BUILD experience, not (yet) the deploy
  step. **Gap this exposes:** codex-packer keeps waiting on a non-existent "workflow-studio tool" to
  populate the canvas, so it falls back to chat-only design + writing the graph to the sandbox `/tmp`
  (NOT the accessible `packs/` dir) → the pack never reaches the Packs panel. Two fixes: (a) short-term,
  make the persona ALWAYS emit the pack to `packs/<name>/` via bash even with no studio tool —
  ✅ **DONE (2026-06-15):** codex-packer Phase 2 now unconditionally `mkdir -p`s and writes every
  artifact to `packs/$UKEY/<SLUG>/` (per-user key) with no studio-tool dependency; (b) the
  real feature — a streaming "build the workflow" tool the bot calls that emits node/bot/tool events
  the left explorer renders live — still roadmap.
- **Vision:** the Studio is modified **only by a builder bot you talk to**; the canvas
  **represents what you discuss**. Flow: talk to the bot → it shows **available bots** to
  click → pick **stages** → it renders the **process flow** → then it **creates** either a
  **packed single-shot bot** (no approval steps) **or** a **new ticket type with approval gates**.
- **Done when:** a builder-bot conversation produces the graph + emits one artifact —
  a packed `swarm-apps/*.yaml` (no reviewer) OR a ticket-type workflow (`reviewerBot` +
  `maxRevisions`) — registered live. The canvas is read-only output of the discussion.

---

## Trading platform key activation, charts, and percent-return implementation

## Trading platform — vision vs built (operator walkthrough 2026-06-23, ADR-052/053/054; re-baselined 2026-07-19)

**Re-baseline 2026-07-19:** the "no keys / screen dark" framing below is HISTORY — broker keys are
configured, the screen is live, and the **live book runs on Schwab** (Alpaca serves the paper book +
market data; see the "LIVE book sizes off Alpaca's IEX feed" entry below). Of the UI-polish list,
candlesticks (`/api/trading-charts/bars` + renderer) and the **% return** tile shipped. Still open
from this entry: the **asset/sector-mix** panel, the **active stops / take-profit** panel, the
**default-full-universe** scan, and the engine items (sleeves / futures / multi-market universe),
which stay with the trading-engine lane.

Operator wanted a real trading-platform screen: graphs/trend-lines/intraday candlesticks, snapshots,
sell indicators, stop positions, total invested + **% gained**, **asset mix**, **buy/sell reasons**, and
**allocation by sleeve** (futures / intraday / long). State as walked through 2026-06-23:

- **#1 UNLOCK — ~~no Alpaca keys~~ ✅ RESOLVED (keys configured; live book on Schwab).**
  `src/api/trading.html` ALREADY renders equity/cash/buying-power/
  unrealized-P&L, a positions table, market-analysis + ranked buy/sell **recommendations across the
  universe**, an **algo scoreboard** (momentum/gravity/donchian/mean-rev + hit-rate), signal capture, and
  a **trade journal with full buy/sell rationale**. It was all DARK because every data source (`/account`,
  `/positions`, `/scan`, `/recommendations`, price bars) returned `broker_not_configured` without the keys.
  The "few stocks" = the scan box defaulting to 5 tickers.
- **UI polish over existing data (`trading.html` is clean, no collision):**
  ✅ **% return** stat (shipped); ⬜ **asset/sector-mix** panel (engine has the
  sector map in `portfolio.ts`); ⬜ **active stops / take-profit** panel (exits exist in `portfolio.ts` +
  journal, no dedicated view); ⬜ default the scan/recommendations at the **full ~100-name universe**
  instead of 5 tickers; ✅ **price charts + intraday candlesticks** (shipped via
  `/api/trading-charts/bars` + a light chart renderer).
- **ENGINE features — NOT built; trading-engine is another agent's active lane (don't fork):**
  ⬜ **futures markets** (equities only today — live at Schwab, paper via Alpaca); ⬜ **allocation
  sleeves** (futures / intraday / long — the Strategy Library, ADR-095, since added per-strategy
  sleeve *shares*, but the futures/intraday/long split of this entry remains unbuilt); ⬜ **200-stock
  multi-market universe** (today: ~100 sector-diversified US equities, `DEFAULT_UNIVERSE` in
  `multi-timeframe.ts`).
- *Done when:* ~~keys in → screen live~~ (met); the remaining UI-polish items shipped; and the engine
  sleeves/futures/200-multi-market are designed with the trading-engine owner (ADR-052/053/054
  extension), not forked.

**Verified 2026-07-19:** MOSTLY STALE — supersedes the "no keys / screen dark" framing above: keys are configured and the book is LIVE on Schwab; candlesticks (`/api/trading-charts/bars`) + the %-return tile shipped. Residual: sector-mix + active-stops panels + the default-full-universe scan.

---

## Social feed capture and presentation implementation

### Social bot as the swarm's social-sensing service (HIGH-VALUE vision — 2026-06-15)
- **DEFERRED (2026-06-16) — the mesh/selector-routed "subscribing bots" part is for LATER (stock-trading
  triggers).** The abstract piece (a bot declares a `selector_descriptor` in its YAML, the ingest
  publishes matched signals to `oshal:mesh:agent.{bot}` so subscribers get triggered) is the
  STOCK-TRADING use case: watch signals → "consider a trade" trigger. NOT today's goal. Today's goal
  is just **a good social feed: captured (✅ table) → the comms bot organizes it → displayed.** No
  mesh/selector needed for that — the controller reads `oshal_inbox_messages` (category=social) and
  feeds the comms bot (ADR-036 data-access→reasoning). Build the mesh selector + publish only when
  the trading-trigger feature is on the table.
- **Vision (operator):** the social-media bot isn't only for writing posts — it's a
  **sensing/monitoring service other bots subscribe to.** Example: the **stock-trading bot**
  asks the social bot *"notify me if @realDonaldTrump tweets something market-moving."* The
  social bot watches its sensors (X timeline, news feeds), and pushes a signal over the Redis
  mesh (`oshal:mesh:agent.{tradingBot}`) when a watched event fires. So it follows a LOT of
  accounts/topics even when irrelevant to content writing.
- **Already possible TODAY (free, no X):** the news/RSS stream ([scripts/oshal-research.js](../../../scripts/oshal-research.js))
  is a market/topic sensor now — e.g. Yahoo Finance single-ticker stock items. An inter-bot
  "watch + notify" layer over the news stream needs no paywall.
- **The inbox IS the social feed (operator solve, 2026-06-16 — the pragmatic sensing pipe):**
  social platforms don't expose a consumption feed via API (X paywalls timeline reads; FB &
  LinkedIn deprecated the personal-feed read entirely), so a bot CAN'T pull "what people I follow
  posted." But every platform sends **free email notifications** (mentions, replies, new
  followers, trends). Tell users to enable/forward those to their connected inbox; the
  **Intelligent Communication bot** reads them, assesses relevance, and surfaces the signal into
  the social app — no paid API. A user-facing note is now in the Composer. **Ingest pipe BUILT
  (2026-06-16):** a configurable cron (`startInboxIngestCron`, default 15 min) pulls ALL new Gmail
  messages since a per-user cursor (PAGINATED — no 25-cap), stores them timestamped + category-tagged
  + deduped in `oshal_inbox_messages` ([inbox-ingest.ts](../../../src/app/routes/inbox-ingest.ts)) — nothing
  missed on a busy day. `GET /api/social/signals` reads the stored `category='social'` notifications
  (complete + fast, never a live grab). **Remaining:** a Signals panel UI in the social app + a
  bot-assessment pass (cluster/prioritize stored signals) + mesh-notify for subscribing bots; the
  digest/email read should migrate to read this store too. X-paid path stays an optional upgrade.
- **X sensor is built but paywalled:** [scripts/oshal-x-read.js](../../../scripts/oshal-x-read.js) reads
  the connected account's home timeline + following. TESTED → X **free tier returns HTTP 402
  CreditsDepleted** on reads; needs **Basic (~$100/mo)**. Identity works free; reads don't.
- **Done when:** (1) a bot can register a watch (account/keyword/topic) with the social bot;
  (2) the social bot polls its sensors and XADDs a signal to the requesting bot's mesh stream
  on a match; (3) news-stream sensor works free; X sensor lights up when Basic is enabled.
  Likely an ADR — this is a new inter-bot capability, distinct from the content/branding surface.

**Verified 2026-07-19:** the "Remaining" list above is partly stale — the Signals panel UI (`GET /signals/ui`, social-signals.html) and the bot-assessment pass (`POST /signals/organize`, comms-bot grouped briefing) both shipped and are now STORE-owned after the social carve (`d9f45cc0`); mesh-notify for subscribing bots (the watch/XADD trigger layer, the done-when above) remains unbuilt.

---

## Operations connector builds, incident finalizer, and Trivy implementation history

### Operations & SecOps swarms — normalize ITSM/observability + rebuild ops (ADR-069) ⬜ NOT STARTED
- **Why:** the operator CLI toolchain (vault/terraform/kubectl/helm/argocd/aws/gcloud/az/ansible) and 46
  app connectors are built, but operations/observability never moved onto the connector runtime.
  ServiceNow + Splunk are ad-hoc **per-bot MCP servers** ([servicenow-mcp-server.ts](../../../src/mcp-servers/servicenow-mcp-server.ts),
  [splunk-mcp-server.ts](../../../src/mcp-servers/splunk-mcp-server.ts)) configured by global env vars, not
  per-user brokered tokens; there is **no** Dynatrace/Datadog connector. The operations intake engine (inherited from the retired monitoring platform) is dormant
  (OpenSearch push-intake, archived
  dashboard). ADR-069 records the decision: normalize onto ADR-065, keep the RCA/topology bots, drop
  the legacy branding, and stand operations + a **full SecOps bundle** up as bundled-by-type swarms.
- **Phase 1 — Dynatrace connector** 🟨 BUILT (audited + wire-tested), NOT LIVE-CREDENTIALED (2026-06-22).
  `swarm-apps/connectors/dynatrace.yaml` (Environment API v2 — problems/problem/entities/metrics/
  metric-query/events; `Api-Token` header auth, cursor pagination on problems). **Passes
  `auditConnectorCatalog` 0/0** and a mock-fetch wire test proved URL+auth+pagination. Added
  `${env:NAME:-default}` interpolation to the spec loader (`src/app/connectors/runtime/spec.ts`) so the
  per-tenant base URL (Dynatrace env-id) resolves from `DYNATRACE_BASE_URL`. Marketplace category + bot
  capability groups wired. *Done when:* a live credentialed read returns real Dynatrace problems.
  *Operator gate:* set the `*_BASE_URL` + `CONNECTOR_*_TOKEN` env vars (see `.env.example`).
- **Phase 2 — normalize ITSM + observability fast-followers** 🟨 BUILT (audited + wire-tested), NOT
  LIVE-CREDENTIALED (2026-06-22). `servicenow.yaml` (Table API — incidents/changes/ci/table-query/record,
  per-user OAuth2; supersedes the env-global servicenow MCP), `datadog.yaml` (monitors/monitor/incidents/
  events/metric-search; DD-API-KEY per-user + DD-APPLICATION-KEY operator env header), `newrelic.yaml`
  (REST v2 — applications/application/alerts-violations/alerts-incidents; X-Api-Key). All pass
  `auditConnectorCatalog` 0/0; mock-fetch wire test confirmed URL/auth/encoding (incl. Datadog dual-key).
  **Splunk stays MCP** — its search is a stateful job (POST `/services/search/jobs`, `exec_mode=oneshot`)
  with SPL passed form-encoded; the declarative runtime sends JSON and doesn't URL-encode body templates,
  so SPL with spaces/pipes won't serialize. Documented in ADR-069. *Done when:* a
  user connects ServiceNow/Datadog/New Relic at `/utilities` and the ops bot reads through the broker;
  then retire the ServiceNow MCP. *Follow-ups:* Datadog/New Relic NerdGraph (GraphQL/POST); a Splunk
  connector only if the runtime grows form-encoded-body support.
- **Phase 3 — operations swarm: INTEGRATE the retired monitoring platform, DON'T REBUILD** ⬜ NOT STARTED.
  ⚠️ **Reuse the production retired monitoring platform** (separate private out-of-repo project, see ADR-069 §2a) —
  The operator already built the polished pieces; do not reimplement them:
  The engine is a **three-layer design — prep → hardener → orchestrate** — reuse all three:
  - **(a) Prep/extraction scripts** (box in what the engine sees) = `build/codex-rci-worker/readtools/
    kubectl-{describe-pod,logs,events,describe-node,pods-on-node,owner-chain}.sh` + `aws-*.sh`, plus the
    OpenSearch **historical**/burst tools in `build/codex-rci-worker/tools.yaml` (`history`,
    `alert_time_snapshot`, `error_pattern_recurrence`, `historical_rca`, `recent/host_alarms`) and
    `graph_neighbors` (1-hop topology about the node). Output → `deliverables/evidence/pre-fetched/` +
    `INDEX.tsv`.
  - **(b) HARDENER = the box-in** (this is the "hardener" the operator meant) = `.claude/hooks/
    kubectl-safety.{sh,py}` (deny mutating verbs; read-only by default, writes only to an allowlisted context) +
    `build/codex-rci-worker/readtools/_lib.sh` (kube-context allowlist, strict input
    regexes, 64 KB output cap). Codex runs `-s danger-full-access` safely *because* of this box. Reuse verbatim.
  - **(c) Orchestrator + two output paths** = `build/ai-enricher/codex-harness/one-shot-incident.sh` +
    `orchestrator-prompt.txt` (domain-detect → investigate → review → revise ≤2 → handover, [CTX-N] cites).
    Writes **Mode A = resolution** (`scripts/{diagnose,remediate,rollback}.sh` + `REMEDIATION-STEPS.md`) OR
    **Mode B = get-details** (`scripts/collect-evidence.sh` for data not already pre-fetched + decision
    tree) OR Mode C = `ESCALATION.md` — the operator's "path A / path B". Knowledge assets reused as-is:
    `patterns.yaml`, `service-ownership.yaml`, `playbooks/`, indexed runbook corpus. The polished RCA bot
    is **codex-packed**, NOT the simpler claude-code `rca-specialist`.
  - **Topology loaders** = `build/graph/clean_tools/load_{k8s,aws,sism}_topology.py` → ADR-045 graph tier.
    Don't write new k8s pullers.
  - **Alert filter pipeline** = `event-filter → es-proxy(percolate) → event-stasher → grouper`. Consume
    its output; don't re-derive dedup/quality-gate/correlation.
  - **The WORKFLOW / ticket state machine (ADR-069 §2b) — finalizer mapping ✅ BUILT 2026-06-22.**
    Lifecycle: monitoring alert → `backlog` (RCA queue) → operator approves (`PUT /api/tickets/:id/resume`
    → `approved`; QueueManager pulls only `approved`) → `in_process_discovery` (RCA engine = "enhance") →
    disposition. All states already existed; `customer_action` already used by career-hunter +
    parent-assembly. **DONE:** `finalizeIncidentByMode` reads `MODE: A|B|C` from line 1 of RCA-REPORT.md and
    finalizes **A → `customer_action`+`proposed_solution`**, **B → `customer_action`+`human_action_needed`**,
    **C → `escalated`** (`INCIDENT_MODE_DISPOSITION` + `readRcaMode`; no marker → `complete` fallback,
    backward-compatible). Unit-tested (`tests/unit/incident-mode-disposition.spec.ts`), tsc clean.
    **Decision: ticket IS the surface** — the cockpit Tickets queue already renders Customer Action /
    Escalated, so this populates them with NO new UI. Works with the current `rca-specialist` worker today.
  - **Remaining OSHAL-side work:** point the operations `workerBot` at the codex one-shot engine (§2a)
    instead of `rca-specialist`; replace the in-repo legacy-branded OpenSearch push-intake (its env gates) with
    per-user **connector pulls**. (No `?app=operations` board needed — ticket is the surface.)
    *Done when:* the codex RCA engine runs as the operations worker over the reused legacy-platform assets and a finished
    RCA lands in `customer_action`/`escalated` by MODE end-to-end.
  - **⬜ NEEDS OPERATOR (the operator): servers/infra to fix.** The operations bots write remediation (Mode A) /
    evidence-collection (Mode B) scripts but have no live infrastructure to investigate or remediate yet —
    operator to stand up servers/a cluster. *Done when:* a real host/cluster
    exists that an operations bot can run its diagnose/remediate scripts against end-to-end.
  - **Boundary (no duplication):** ADR-069 connectors = per-user PULL product complement; the retired
    monitoring platform = on-cluster enterprise PUSH pipeline + RCA engine. They meet at the graph tier + RCA engine.
- **Phase 4 — full SecOps bundle + SECURITY REVIEW.** 🟡 IN PROGRESS — first SIEM/threat-intel connectors
  built 2026-06-22 (audited + wire-tested 0/0): `sentinel.yaml` (Microsoft Sentinel incidents/incident/
  bookmarks over ARM; Azure AD oauth2; workspace coords bind from `AZURE_SUBSCRIPTION_ID`/
  `SENTINEL_RESOURCE_GROUP`/`SENTINEL_WORKSPACE` into the path) and `virustotal.yaml` (IOC enrichment —
  domain/ip/file/url; x-apikey) and `elastic-security.yaml` (Kibana detection-engine rules + Fleet/endpoint
  reads; `ApiKey ` header + kbn-xsrf), `tenable.yaml` (vuln scanning; two-key X-ApiKeys) and
  `defender-cloud.yaml` (CSPM — assessments/alerts/secure-score/compliance over ARM; Azure AD oauth2).
  **Connector matrix complete** (SIEM ×2 + threat-intel + vuln + CSPM). **Still to build:** the **secops-analyst** bot
  (bot-owns-domain, `user_sub`-keyed encrypted findings store); `?app=secops`. vault-bot (ADR-040) is the
  secrets pillar. **NEEDS SECURITY REVIEW** (per ADR-040/047) of broker scopes for security connectors,
  per-user finding-store isolation, and CSPM/cloud-read least-privilege **before first non-local use** — no
  global-credential shortcuts. *Done when:* a user connects a SIEM/CSPM source, the secops bot produces a
  prioritized findings brief over the broker, and the security review has signed off. *Follow-up:* Azure AD
  client_credentials auto-mint (Sentinel pasted tokens expire).
- **Trivy self-scan (Security Center `image` scope) — BUILT 2026-07-10 (air-gap/FIPS-first).** Distinct from
  the `tenable` connector (that's an outbound SaaS vuln API): this scans the platform's OWN tree in one
  offline pass — OS/library CVEs + IaC/Dockerfile/compose misconfig + embedded secrets — as a first-class
  scanner in the Security Center's `runScan()` fan-out (`kind:'image'`, alongside secrets/route-auth/deps).
  Findings upsert into `oshal_security_findings` (dedup + triage) with Trivy-scoped categories
  (`trivy_vuln`/`trivy_misconfig`/`trivy_secret`), and HIGH/CRITICAL findings **auto-report to the
  Security Center queue backlog** as `security-finding` tickets (floor `TRIVY_TICKET_SEVERITY_FLOOR`).
  **IL6/air-gap:** the scanner always runs `--skip-db-update --skip-java-db-update --offline-scan` (no
  scan-time egress, asserted by test), `trivy fs` (no docker socket / no privilege), secret VALUES never
  persisted, fail-closed to `available:false` when the binary/DB is absent. `src/features/security/trivy-scanner.ts`
  + wiring in `index.ts`/`security-routes.ts`; `Dockerfile.oshal` bakes a pinned+overridable (FIPS-swap)
  Trivy; DB provisioned out-of-band per [runbooks/trivy-airgap-security-scanner.md](../../runbooks/trivy-airgap-security-scanner.md).
  Tests: `tests/unit/security-trivy-scanner.spec.ts` (11). *Remaining (deploy/env):* seed the offline DB
  + substitute the FIPS binary in the target enclave, then live-verify a scan files backlog tickets. Also
  fixed in the same pass: `POST /findings/:id/ticket` was dropping finding data into a Zod-stripped `payload`
  field — now carried in `metadata`.
- **Owner:** any engineer (Phases 1–4 are buildable now; Phase-4 go-live is review-gated).

**Verified 2026-07-19:** Phase 3 PARTIAL — the legacy OpenSearch push-intake is ripped out (04265e30) but not replaced with connector pulls nor the legacy RCA engine as worker; Phase 4 OPEN — no secops-analyst bot, no `?app=secops`.

---

## Embedded-provider roster and precedence-aware runtime control

### LLM-access for bots — surface the embedded providers (operator note 2026-06-16)
- **What:** any-bot already has all the LLM/API connectors embedded
  (AnthropicProvider, OpenAIProvider, CodexProvider, GeminiProvider, BedrockProvider, etc.) and
  they run under the **Cline CLI wrapper** / provider registry — **no new harness wrappers
  needed**. Surface a general provider/API-key picker in the Utilities "Bot LLM access" section
  so an operator can enable any embedded provider by pasting a key (remote-friendly).
- **Constraint:** the **ChatGPT/Codex OAuth login** (`openai-codex-oauth`) uses a `localhost:1455`
  callback — works for local dev, but OpenAI's codex OAuth client only whitelists localhost, so it
  won't complete on a remote host (oshal.example.com). API-key access works anywhere; the
  ChatGPT-subscription login stays local-only unless tunneled. Claude Code login already works
  remotely (request-origin callback).
- **Roster BUILT (2026-06-16):** GET /api/providers/access + a "LLM providers" panel in Utilities lists every embedded provider with its auth kind (key/login/local) + configured status + the run-under-Cline note. Keys still set via .env (like connectors). **Remaining:** UI key-entry (paste -> store -> propagate via ADR-034) + per-bot provider selection.
- **Done when:** the Utilities LLM-access panel lists the embedded providers with a key field;
  enabling one makes a bot run on it (via the Cline wrapper / provider registry).

**Verified 2026-07-19:** PARTIAL — key paste/validate/store/propagate is done (byo-llm-routes.ts); the per-bot provider-selection UI remains open.

**DONE 2026-08-01 (wave17-cockpit) — and the build found that the feature this entry asked for is
INERT for every shipped bot.** A "per-bot provider selection UI" implies a per-bot provider you can
select. Measured against the default registry: **all 60 entries declare a non-cline `harnessType`**
(38 `claude-code`, 20 `codex-cli`, 1 `gemini-cli`), and `resolveHarnessForAgent`
(provider-runtime.ts:841) returns that harness *before* `FORCE_LLM_PROVIDER`, global-config.json, or
the per-agent DB record is consulted. So the two write rails that already existed
(`PUT /api/agents/:id/profile` → `agents.api_provider_id`, `PUT /api/agents/:id/runtime` →
`agent_config` + live push-down) cannot change which provider serves ANY bot in a default
deployment. A picker built as this entry described would have been a control that does nothing.

What shipped instead — the honest version of the same request:
- **The rule, extracted once**: `src/shared/llm-runtime/bot-provider-precedence.ts`. It was
  previously only knowable by reading three files (provider-runtime.ts:841,
  claude-code-provider.ts:246 for the in-cline order, bot-node-config-bootstrap.ts:184 for the model
  env mapping). Shared layer so the API and any surface get the same answer — a browser copy is how a
  panel starts lying.
- **`GET /api/agents` now carries the resolved answer**: `effectiveProvider`, `effectiveModel`,
  `providerSource`, `providerOverridable`, `modelOverridable`, `precedenceNote`
  (`enrichProfileWithHarness`). The read model used to hand back `harnessType` and `providerId` side
  by side with no hint that the first outranks the second.
- **FAIL-CLOSED on an unreadable registry**: the controller reaches the registry through an aliased
  `require()`. If that read fails, precedence is *unknown*, not "nothing is pinned" — so the resolver
  answers `providerSource: 'registry-unreadable'` with `providerOverridable: false` rather than
  promoting the DB record and offering an inert control. Not hypothetical: the aliased require does
  not resolve under vitest, which is how the branch was found and is what the guard exercises.
- **The panel** (`src/api/utilities.html`, under the deployment-wide LLM-providers roster): per-bot
  rows showing the effective provider + a tier badge, the API's own reason rendered verbatim, the
  provider `<select>` **disabled** where the registry wins, the MODEL still settable (a DB `modelId`
  does reach a pinned harness via `CODEX_MODEL`/`CLAUDE_CODE_MODEL`), writes through the
  authoritative `PUT /api/agents/:id/runtime` with a 502 reported as *not applied, nothing recorded*,
  and — because today that means every bot — an explicit empty state saying so instead of an
  unexplained empty list.
- **Residual (needs a decision, not code):** the only way to change a bot's provider today is editing
  its registry entry, which is source. Either that is the intended contract (then say so in
  docs/building-a-bot.md) or `harnessType` needs a per-bot override rail of its own — an ADR-level
  call, deliberately not made here.
- Guard: `tests/unit/bot-provider-precedence.spec.ts` — **provider-panel-shows-registry-precedence**,
  12 tests, 15 targeted mutations each proven red (including both fail-open shapes and the
  paraphrase-the-reason shape).

---

## Kernel LinkedIn connector-action migration

### LinkedIn publish should route through the connector write-actions framework
- **Reason:** `linkedin-assistant-routes.ts` publishes via a bespoke `fetch()` to the LinkedIn UGC Posts
  endpoint (mirroring the pre-existing `social-routes` publish), bypassing the connector write-actions tier
  shipped 2026-07-15 (validated params + approval gating + `connector_action_audit`). Not a regression — it
  matches the existing pattern — but the action executor is the sanctioned home for a write.
- **Done when:** LinkedIn publish (and its `social-routes` sibling) execute through the connector action
  executor against a declared `actions[]` entry on the LinkedIn connector def; every publish writes a
  `connector_action_audit` row; the human approval gate and the clean no-connection skip are preserved;
  unit tests cover the audit row + the skip path.
- **Note 2026-07-19:** `social-routes` carved to the store (`d9f45cc0`) — the "social-routes sibling"
  clause now applies to the store package's social routes, not a kernel file.
- **2026-08-01 — DONE (kernel half).** NEW `swarm-apps/connectors/linkedin.yaml` declares the member
  share as a real action (`create-post`, POST /v2/ugcPosts, riskLevel high + approvalRequired, with a
  paramsSchema pinning the author-URN shape); `buildPublisher` calls `runConnectorAction` against it.
  Same brokered caller token and the same clean no-connection / missing-author-id skips, but params
  are validated before any HTTP and the write is FAIL-CLOSED on the audit trail — if the pre-write
  row cannot persist the post is refused rather than made invisibly. The confirm signal is passed
  because the human gate is upstream (publish is only reachable from an approved draft). The store
  package's social-routes sibling is still its own change, in its own repo.
  Guard: `tests/unit/connectors/connector-write-actions.spec.ts` — the executor path is proven the
  only way it can be: make the audit insert fail and assert NO provider call happens (a bespoke fetch
  would post anyway).

---

## Drone sim, MAVLink SITL, fleet mission, show, camera, and retask implementation

### Drone Ops phase 2 — drones as remote swarm nodes + carve to the store (ADR-099)
- **Reason:** phase 1 (2026-07-17, ADR-098) shipped single-drone automation control against the built-in
  deterministic sim (`src/features/drone/`, `?app=drone`) — hardware-free by design. Operator decision
  2026-07-17 ([ADR-099](../../adr/099-drones-as-remote-swarm-nodes.md)): Drone Ops is an **extension, not
  core**, and **each drone is a remote swarm node** — vehicle comms ride the swarm's authenticated
  rails (mesh in-LAN, A2A/edge off-LAN) so drone↔drone coordination is secure by default. Sequencing:
  node rearchitecture in-repo FIRST, carve second (carving the in-process shape would force a re-carve).
- **Done when (drone-node runtime):** a companion **drone-node process** embeds a `DroneProvider` and
  joins the swarm as a registered agent (own agentId, heartbeat `oshal:runtime-agent:{agentId}`,
  commands/telemetry as authenticated envelopes — service-secret/A2A, never a raw drone link);
  `DroneService` becomes the fleet plane (id → node) with per-drone routes
  (`/api/drone/:droneId/...`, back-compat default `alpha`); geofence validation + human-approved
  execute + `drone_command_log` audit unchanged and applied per node; running 3 SIM nodes shows
  3 drones on one surface map; fleet-wide abort works; unit suite covers ≥2 concurrent nodes.
- **✅ DONE 2026-07-17 (MAVLink at the node)** — `MavlinkDroneProvider` (node-mavlink, MAVLink v2 over
  TCP; GUIDED-mode setpoints, node-side mission loop, telemetry/STATUSTEXT decode), selected via
  `DRONE_PROVIDER=mavlink` + `DRONE_MAVLINK_URL`. **Live-proven against ArduPilot SITL**
  (`radarku/ardupilot-sitl`, TCP 5760): real home decoded from the stream → confirm rail 409 without
  `confirm:true` → arm (incl. observing ArduPilot's own ~10s ground auto-disarm) → takeoff hold at
  exactly 15m → 80m guided goto at ~4.5 m/s → 5km goto rejected 422 by the controller fence → RTL to
  touchdown + auto-disarm at 0.3m from home. Physical-airframe flight still requires an operator go +
  the drones' make/model (DJI would need a separate non-MAVLink adapter).
- **✅ DONE 2026-07-17 (fleet missions — ADR-099 decision #2):** one order → many drones → ONE
  approval. `fleet-mission.ts` normalizes {droneId → plan} drafts (idempotent — stored rows
  re-normalize at execute) and enforces deterministic pairwise separation (≥10m vertical band OR
  ≥20m horizontal polyline distance, segment-level so mid-leg crossings are caught; cruise-phase
  only — takeoff/RTL are NOT deconflicted, layer altitudes or stagger launches).
  `DroneService.startFleetMission` is all-or-nothing: every member validated (fence per drone's own
  home, confirm rail, flight-state) BEFORE any drone moves; ground members auto-armed by the
  approved Execute; runtime failure unwinds already-started members. Fleet-wide abort
  (`POST /api/drone/fleet/abort-all`, confirm-exempt — closes the done-when item above), concierge
  `fleetMission` contract + altitude-layering doctrine, surface fleet overlays/Abort ALL,
  `DRONE_EMBEDDED_SIMS` env for hardware-free fleet demos. 37 drone unit specs + live route chain
  (save→execute→abort-all→audit) green.
- **✅ DONE 2026-07-18 (show timelines + failover round):** cue-based show conductor
  (`fleet-show.ts` + `FleetShowRunner`: "at 1:00 this formation" → per-leg speed-solved synchronized
  arrivals; freeze-the-show on member failure), 3D/FPV surface views (self-contained canvas
  renderer), telemetry depth (odometer/flight-time/modeled RPM), node-side LINK-LOSS failsafe
  (airborne + no heartbeat ack ≥`DRONE_LINK_FAILSAFE_S` → self-RTL, decided on the vehicle), runtime
  proximity guard (live pairwise separation during the cues phase → freeze), `DRONE_VIDEO_URL`
  heartbeat passthrough for real camera feeds. 62 drone unit specs.
- **✅ DONE 2026-07-18 (backlog round — camera + retask + guard + CONDITION_YAW):**
  CAMERA equipment v1 on the arrival-action rail (photo/record/stop/aim + gimbal pan/tilt as
  a manual command AND a waypoint/slot arrival action; structured `CameraCapture` records +
  a captures gallery of labeled SYNTHETIC frames; captures ride node heartbeats, sanitized at
  ingest). MID-SHOW LIVE RETASKING (`POST /show/retask` replaces a running show's remainder —
  cues phase only, clock restarts at acceptance, `validateRetask` sweeps carry-forward from
  LIVE positions, roster fixed, hardware needs a fresh confirm; the conductor runs under a
  serialization lock so a tick can't interleave with the swap). Runtime proximity guard now
  covers LAUNCH/RTL with pad-aware geometry (exempt only when both drones are over their own
  pads AND the pads are ≥6m apart) + a STAGED OUTRO (one drone returns at a time, lowest first;
  `validateOutroSeparation` proves it at plan time). MAVLink `setHeading` via
  `MAV_CMD_CONDITION_YAW` — **SITL-proven** (arm → 15m → slew 90°/180° ±3° through the full
  controller→node→MAVLink wire chain vs `radarku/ardupilot-sitl`). `DRONE_EMBEDDED_SIMS`
  compose passthrough (api service). 87 drone unit specs.
- **Drone follow-ups (roadmap — NOT built; keep honest):** drone↔drone mesh coordination /
  self-realignment (ADR-099 decision #2 deep form — today all coordination is controller-hub);
  CAMERA over MAVLink for physical airframes (`DO_DIGICAM_CONTROL` / gimbal manager — the sim
  camera is real, the MAVLink camera honestly rejects); real ESC RPM + live video ingestion
  over MAVLink; an LED payload **driver** at the drone node for physical lights (the LED model
  is sim-only). The captures gallery renders SYNTHETIC frames from shot parameters — real
  image/video ingestion is the MAVLink-video item, not built.
- **Done when (carve, after the node shape is stable):** Drone Ops rides `scripts/oshal-app-backup.sh`
  to an oshal-applications package (surface + persona + routes + drone-node runtime in the package;
  deterministic flight/validation slice evaluated for kernel-skill per the ADR-085 engines-stay-kernel
  rule); live-proven install → activate → `?app=drone` works from the store with zero core-registry edits.

---

## Remote-node physical-coordinate scaling fix

### Remote-node click-coordinate scaling bug ⬜
- **Context:** discovered 2026-07-10 while driving Gabe's PC (render-node-1) remotely.
  `scripts/codex-remote-node.mjs click/move` → `controlInput` in
  `packages/oshal-chat/src/main/system-tools.ts` sends x/y straight to nut.js `mouse.setPosition`
  in real screen pixels, but `captureScreen()`'s screenshot is downscaled to `maxWidth` (default
  1280) for transfer and returns the DOWNSCALED size, not the physical resolution. Nothing
  rescales click coordinates derived from a screenshot back up to real pixels. On that box (real
  1920x1080, screenshot 1280x720) every screenshot-derived coordinate was off by exactly 1.5x —
  clicks silently landed ~50% off-target with no error, burning ~8 failed attempts before
  diagnosis. See [[edge-node-remote-client]] memory for the full incident.
- **Build:** either (a) have `captureScreen`/the `capture` CLI command report the real physical
  resolution (or scaleFactor) alongside the screenshot dimensions so callers can compute the
  ratio themselves, or (b) accept click coordinates in screenshot-space and scale them internally
  in `controlInput`/`nutControl`/`psControl` before calling `mouse.setPosition`/`SetCursorPos`
  (preferred — removes the failure mode entirely instead of documenting around it).
- **Done when:** a click issued using coordinates read directly off a `capture` screenshot lands
  correctly regardless of the target machine's real resolution/DPI scale factor, with no manual
  calibration step required; add a unit/integration check pinning screenshot-size vs. real-size
  reporting so a regression is caught, not rediscovered by trial and error.

**Verified 2026-07-19:** OPEN — `captureScreen` still returns downscaled dims without a scaleFactor; `controlInput` uses raw pixels.

---

## Spaces reconstruction service, guided capture, and sim-drone implementation

## Spaces / spatial mapping (ADR-111) — deferred phases + box-side pipeline ⬜ (2026-07-20)

Phase 1 (`?app=spaces`: upload a walkthrough video → walk the 3DGS scene) is BUILT + verified.
These are the deferred halves, recorded here per the deferred-work rule (they previously lived
only inside [ADR-111](../../adr/111-spatial-mapping-3d-reconstruction.md)):

- **Box-side reconstruction service (`spatial-recon-edge`).** ✅ BUILT 2026-07-20
  ([scripts/spatial-recon-edge/](../../../scripts/spatial-recon-edge/README.md)): stdlib HTTP server +
  ffmpeg→COLMAP→splatfacto→`.splat` pipeline + poses export (dataparser-frame-reconciled) +
  optional `RECON_TOKEN` auth + job-dir reaping; `test_recon.py` green (protocol + converter +
  poses + auth + reaper, stub mode). Increments A (pose persistence) and B (RF overlay) landed
  with it. **Still open (the deploy half of done-when):** stand the service up on the actual GPU
  box, set `RECON_URL` (+`RECON_TOKEN`), and reconstruct one real room video end-to-end from
  `?app=spaces` — that close is operator hardware access, not code.
- **Phase 2 — GoPro/real-media ingest + guided capture.** Captured files land in the owner-scoped
  media store and are selectable as a scan source (closes the Camera Ops bytes gap generally).
  Note: the direct-import lane (`POST /api/spaces/scans/import`, shipped 2026-07-20) already lets
  users bring a pre-built device 3D capture (`.ply`/`.splat`) in as a scan source with no GPU; what
  remains open here is raw-media (GoPro video) ingest that flows the reconstruction pipeline.
  Scope also covers **operator-guided capture**: the `spaces-operator`'s `capturePlan` directing a
  human camera operator ("walk the wall, pan left, tilt down") — the human and the drone are
  interchangeable capture actuators executing the same plan; v1 live guidance is driven by the
  phone's own compass/motion sensors; only the v3 rung (cm-accurate pose/coverage feedback)
  additionally needs recon pose feedback (pose-persistence spec). *Partial 2026-07-20
  (`b1549cb8`, `3eb52a85`):* a deterministic capture plan is presented step-by-step on the surface
  (`generateCapturePlan` + `GET /api/spaces/capture-plan` + the Guided-capture panel), AND **live
  guided capture v1 shipped** — a phone-camera HUD (`src/api/spaces-capture.html`, served at
  `GET /api/spaces/capture`) with two distinct arrow channels (WALK vs PAN) driven by
  compass/deviceorientation + devicemotion, posting sensor telemetry to
  `POST /api/spaces/capture-telemetry` (owner-scoped JSONL). The guidance contract is deliberately
  actuator-agnostic (human phone now, drone later). **Still open for done-when:** GoPro capture
  selectable as a scan source, the plan drafted by the BOT (personalized, vs the deterministic
  default), and the higher rungs of the guidance ladder — v2 live stream (WebRTC) and v3 live
  pose/coverage feedback.
- **Phase 3 — drone scan missions (sim-first, ADR-099).** ✅ Sim-first half BUILT 2026-07-20
  (`b1549cb8`): `droneScanPattern` (orbit rings, FOV+overlap-derived spacing) → validated
  MissionPlan → virtual-clock `SimDroneProvider` flight (one photo capture per waypoint) →
  `POST /api/spaces/drone-scan` registers a `'sim-mission'` scan the Sim engine reconstructs;
  guarded by `tests/unit/spatial-capture-plan.spec.ts`. **Still open:** real drone media
  ingestion (gated on the MAVLink media follow-up) and lawnmower/multi-drone sector patterns.
- **Large-binary storage-target routing.** Scan bytes live on local disk (`OSHAL_SPACES_ROOT`,
  owner-scoped dirs) because no ADR-041 target fits 100MB+ binaries (oshal-local: 250MB quota;
  git target excludes large blobs). **Done when:** a large-binary-capable storage target exists
  and Spaces bytes route through it — or an ADR records keeping local-disk permanently.

---

## ci-local export fixes, dependency scan, IPv4 pin, and image findings

### ci-local --head — run the remaining quiet-box e2e verification

**2026-07-24 resolution:** (1) trivy was already done 07-23 (below). (2) The GATE_SRC-only spec
failure class root-caused to a SECOND `.git` dependence the 07-23 `trackedFiles()` fix missed —
`check-repo-separation.js` crashed resolving coreDir in the `.git`-less export; new
`resolveCoreDir()` falls back to cwd (guard: export-shape fixture case in `repo-separation.spec.ts`);
the CRLF half was already fixed by the `.gitattributes` eol pin (its missing guard now exists in
`ci-local-gate-reliability.spec.ts`). (3) The e2e-green ECONNREFUSED class (258 hits) was the `::1`
wslrelay squatter: playwright BASE_URL + `tests/helpers/test-origins.ts` now pin IPv4 `127.0.0.1`
in lockstep (guard: `test-origins.spec.ts` host-pin assertions). **Residual:** one quiet-box
`test:e2e:green` rerun (~5 min, exclusive datastores) to confirm the 07-23 2-toBeVisible/1-flaky
residue is gone. Landed `e7efebb`.

The first `ci-local.sh --head` run on the trunk failed 4 gates. `repo-separation` (crashed on the
`.git`-less GATE_SRC export) was fixed the same evening — `trackedFiles()` now falls back to a
filesystem walk. The other three remain, each an env-or-image finding, none red in the working
repo:

1. ~~**trivy: two HIGH findings in the built image**~~ **DONE 2026-07-23 (`c931acd`,
   deployed `9926ece` on image `a75ec0e4d01b`).** The findings were sharp 0.32.6
   (GHSA-f88m-g3jw-g9cj, nested under `@xenova/transformers` while the direct dep was already
   safe) and fast-uri 3.1.3 (CVE-2026-16221, inside the bundled cline). Fixed via a tree-wide
   sharp override pinned to the direct dep's range + a Dockerfile in-tree replacement of cline's
   fast-uri with a build-time assertion. Rebuilt image scanned with the gate's exact flags:
   exit 0 at CRITICAL,HIGH. The in-cline patch should retire once upstream cline bumps fast-uri
   — check on the next `CLI_CACHE_BUST` refresh.
2. **`app-immersive-chrome.spec.ts` fails only in the GATE_SRC export** ("does not navigate or
   restore the embedded chat for an immersive profile", assertion at 29ms) while passing in the
   repo — an environment delta, not flake, per the 2026-07-19 doctrine. **Done when:** the delta
   is identified (missing untracked fixture / path resolution / test-order dependency) and the
   spec passes in BOTH the repo and a fresh `git archive` export.
3. **e2e-green: 2 `toBeVisible` failures + 1 flaky** (incl. token-chase determinism UI) against
   the isolated ci-src server while the full swarm + an image build loaded the box. **Done when:**
   the failing specs pass in a quiet-box --head run (rules out load), or get explicit waits that
   survive a loaded box; a red that repros quiet gets fixed as a real bug.

Until then the nightly OSHAL Local CI (now pointed at the trunk) will show these — a known-red
with this entry as its quarantine record, not a silent one.

---

## Futures strategy, parser, calendar, backtester, and continuous-series implementation

## Futures extension layer (ADR-116) — deferred pieces

The foundation shipped 2026-07-24: instrument model, mock+Kibot data source, `market_bars` store
(migration 096), completeness validator + ingest orchestrator, and an in-memory paper futures broker,
all proven end-to-end by `scripts/oshal-futures-ingest.ts` and three unit specs. What was deliberately
deferred (`do what you can, backlog the rest`):

- ~~**The friend's actual strategy rules — the critical input.**~~ **COMPLETE 2026-07-28.** Both
  halves are ported and all five open questions are ANSWERED by the trader. The exit half (three-layer
  stop stack) and entry half (ten graded states, both generations) shipped 2026-07-27; his answers
  landed 2026-07-28 and moved three defaults plus added a third entry generation. Full answer table:
  [docs/apps/trading/futures-stop-engine.md](../../apps/trading/futures-stop-engine.md#dictation-vs-code-divergences--answered-by-the-source-trader-2026-07-28).
  Summary: (a) Strangle gate = **both conditions**, ADX + LagRSI → default `'adx-laguerre'`, with a
  stricter `'adx-all'` shipped for the reading where both SECOND clauses are ANDed; (b) close-breach
  market exit **confirmed**, alongside a resting trailing stop refreshed every bar the close holds —
  our dual mechanism was already right; (c) **DTAM is dead** (see the retirement item below);
  (d) initial stop = lowest low of the most recent **bearish MACD wave** with an **ATR × 3 floor
  minimum** → `initialStopAtrMultiple: 3`, new `initialStopWaveSource: 'macd'`; (e) graded-state stays
  the model of record while he **refactors to the scalar ensemble**, now shipped as
  `generation: 'ensemble'`.
- ~~**DTAM regime scaler + the score-binned multiplier ladder.**~~ **RETIRED 2026-07-28 — do not
  port.** Its author tested it and removed it: "the dynamic trailing stop (DTAM) was removed as it had
  not shown to be helpful." The single optimizer-swept static chandelier multiplier (default 2.0) is
  canonical, and the {1.5, 2, 2.5, 3} family is a sweep over that one field. The never-coded 1.5–4.0
  score-binned ladder is spec-only and superseded. Porting either would revive something its designer
  rejected. Nothing to delete in our tree — the trail stack is entirely config-driven.
- ~~**Scalar ensemble entry model.**~~ **SHIPPED 2026-07-28** — `futures-entry-ensemble.ts` +
  `generation: 'ensemble'`, ported from `ATCEnsembleGen.cs` (which turned out to be real code, not
  spec-only). Nine contributors with a membership-derived maximum (`enabledCount × 2`, never the
  doc's hardcoded ±14), a percentage entry threshold, no mandatory indicator, and the dual-floor
  confirmation exit. Faithful to the three gates his ensemble lacks (up-close test, re-entry latch,
  fixed window) and the one it keeps (the binary Export-style LTF rule). 41 guards, all
  mutation-proven.
- **Optimize the ensemble confirmation-exit percentages — a real finding, not a nicety.** At his
  documented 90 / 93 defaults the dual floor takes ~99% of exits on hourly ES and CL (386/389 and
  390/395), leaving the stop stack almost no role: it costs ~$45K on ES and *saves* ~$96K on CL. His
  own spec gives ranges (85–95 retention, 90–96 drawdown, "this is the key"). **Done when:** the
  staged optimizer sweeps both percentages per market and the exit-mix table is reported beside the
  P&L.
- **Stop-stack remainder.** The %ATR buffer variant the dictation asked for (code ships fixed tick
  buffers). **Done when:** it is a config the intraday backtester can sweep. *(2026-07-31 note: still
  open by choice — it adds an ATR input to the engine's per-bar contract and deserves its own change
  with its own guards; the two data-plumbing lanes below took priority.)*
- ~~**Vacuous guard (pre-existing, reviewer-flagged 2026-07-28): the backtester's doubly-deferred
  Strangle-exit regression test iterates an always-empty array.**~~ **FIXED 2026-07-31.** The old
  test filtered the rally fixture for `exitName === 'Strangle'` and looped over an always-empty
  array. Investigation while fixing it sharpened the diagnosis: after the gate latches, every
  enforcement SYNCS the resting stop to the tracked level, so a level at the stop is always touched
  intrabar first (`low ≤ close ≤ level = stop`) — the close-breach can only fire ON THE LATCH BAR,
  while the level is tracked but not yet placed. (The BACKLOG's original "level inside the prior
  bar's clamp margin" geometry is unreachable for the same reason — the ratchet's scan span always
  contains the current bar, so a proposed level never clears the clamp.) The new fixture in
  `futures-backtester.spec.ts` engineers a LATE latch below an old frozen level (+6/−5 alternating
  climb keeps smoothed LagRSI under the 97 gate threshold while the level ratchets; a fade drops
  price below the frozen level with LagRSI ≈ 0; a monotone creep saturates LagRSI → latch on a
  breach-eligible bar) and ASSERTS ≥ 1 `Strangle` exit, next-bar-open fill, slippage paid, zero
  intrabar `StrangleStop` leakage. Mutation-proven on both sides of the boundary: sabotaging the
  backtester's `marketExitPending` wiring or the engine's breach detection each goes red (2 tests).
- **Six-stage optimization pipeline (his method, our rails).** Entry → StopLoss → Trail → Targets →
  EmergencyExit → Sizing, prior-stage winners locked; stage 1 = entries alone with a fixed-bar exit
  optimizing AvgMFE/AvgMAE (his `ATCMaxAvgMfeMinAvgMae` fitness — a pure function to port); walk-forward
  is documented policy in his repo but NOT implemented tooling — build it here, don't assume it. Multi-market
  overlay equity curves (which NinjaTrader can't render) are the deliverable his workflow is missing.
  **Done when:** the staged sweep runs against the intraday backtester and emits an overlaid equity curve
  across ≥ 3 markets.
- ~~**Historical intraday data — the blocker.**~~ **UNBLOCKED 2026-07-27.** Real Kibot per-contract
  bulk downloads were already on the operator's box (`~/Downloads`): **ES** (daily / minute / tick,
  62 minute contracts, plus two ~3 GB tick archives) and **CL** (daily + 242 minute contracts,
  ~1 GB). `KibotFileDataSource` reads that layout directly. **First clean result: 5 years of
  front-month ES hourly bars (2021-01 → 2025-12, 20 contracts, 29,207 bars, median volume 16,197).**
  Not corn — the corn reference is `C.txt` in `KibotFuturesLists.zip`, a symbol LIST (94 contracts),
  not bars. Remaining: **move the archives into a stable data dir** (they sit in Downloads today) and
  extract the CL/tick sets. GC / 6E / NQ / YM / ZC bars are NOT present — request from the trader if
  his multi-market spot tests need reproducing.
- **Kibot HTTP API credentialing + endpoint verification.** `KibotFuturesDataSource` is written to the
  documented login→history→CSV shape but is credential-gated and unverified against a live account.
  Lower priority now that the file source covers ES/CL. **Done when:** `KIBOT_USER`/`KIBOT_PASSWORD`
  are set, the param/CSV spelling is confirmed, and one contract ingests over HTTP with a passing
  completeness check.
- ~~**Kibot DAILY files use a different format than the minute files**~~ — **SHIPPED in PR #67
  (2026-07-27, "futures real-data closeout") but never struck here — reconciled 2026-07-31.**
  `parseKibotCsv` now infers the row shape PER LINE (comma/semicolon × intraday/daily, incl. the CL
  compact-datetime form), `futures-data-completeness.spec.ts` covers all four formats plus the
  column-shift and trailing-delimiter attack rows, and the file source refuses (loudly, zero bars)
  to serve a daily file at an intraday timeframe.
- **Schwab futures data feed** (operator: "we probably get a feed from Schwab, less granular"). A
  `SchwabFuturesDataSource` reusing the existing per-user Schwab market-data plumbing. **Done when:** a
  futures symbol returns bars through the Schwab connection, with granularity/entitlement documented.
- ~~**Exchange session + holiday calendar.**~~ **SHIPPED 2026-07-31** —
  `futures-session-calendar.ts`: the Globex ~23h week (Sun 18:00 → Fri 17:00 wall, daily 17:00–18:00
  maintenance halt) plus a rule-computed US holiday schedule (full closures vs 13:00 early closes,
  weekend observance, Good Friday via Easter math, Juneteenth from 2022). All three done-when legs
  landed: `expectedBarCount` counts real session buckets (a 5-year hourly ES set stops reading ~6%
  incomplete), the gap detector counts only missing SESSION buckets (the halt stopped being a
  phantom daily gap), and the mock emits the true session shape. 16 hand-pinned calendar guards +
  4 mutations proven red. Honest residue: the holiday table is the RECURRING schedule — per-year
  exchange notices (one-off closures, shortened Good Friday sessions) are not modeled and are
  absorbed by the 0.98 completeness threshold; the expiry/roll date math still approximates business
  days as weekdays.
- ~~**Intraday backtester (F3 remainder).**~~ **SHIPPED 2026-07-27** —
  `futures-backtester.ts` + `futures-fitness.ts` + `scripts/oshal-futures-backtest.ts`: bar-walk
  simulation with NT8 fill semantics (next-bar-open entries priced off the signal bar, intrabar stop
  triggers with gap fills, next-bar market exits), slippage/commission, the stage-1 timed-exit
  harness, all nine of the trader's optimization fitnesses, and the multi-market overlay curve.
  Proven end-to-end on mock bars (3 markets, all exit types firing). See
  [docs/apps/trading/futures-backtester.md](../../apps/trading/futures-backtester.md). **Remaining from
  the original item:** margin modeling (sizing is risk-percent only, contract margin unchecked) and
  the Target-1 partial-exit path.
- **Staged optimizer + walk-forward driver.** The fitnesses and the simulator exist; nothing yet
  runs the trader's six-stage pipeline (Entry → StopLoss → Trail → Targets → EmergencyExit → Sizing
  with prior-stage winners locked) or freezes constants for an out-of-sample re-run. His own repo
  documents walk-forward as policy but never implemented it — do not inherit that gap. **Done when:**
  a staged sweep runs over real bars, each stage scored by its own fitness, and a frozen-constant
  OOS run on unseen periods is reported beside the in-sample result.
- ~~**Continuous / back-adjusted contract construction — NOW A BLOCKER FOR RESULTS, not just
  research.**~~ **SHIPPED in PR #67 (2026-07-27) but never struck here — reconciled 2026-07-31.**
  `futures-continuous.ts` `buildContinuousSeries(root,…)` stitches front-month windows, measures
  every roll seam (overlap-median on identical timestamps via an unclamped basis probe, adjacent-bar
  fallback, 'gap' classification for missing intermediate contracts that is NEVER folded into
  offsets), and panama-adjusts by default; `futures-continuous.spec.ts` verifies across rolls and
  the runner consumes it (`--adjust none` to inspect raw seams). Roll convention: contract windows
  roll a configurable `rollDaysBeforeExpiry` (default 8 calendar days) before expiry; adjustment is
  panama/DIFFERENCE only — ratio adjustment is deliberately not implemented because the source
  trader's NinjaTrader continuous contracts use difference adjustment and parity with his numbers
  is the point.
- ~~**Bar-timestamp convention reconciliation.**~~ **DONE 2026-07-31**, as part of the session
  calendar. The convention is documented on `FuturesBar.t` and in `futures-session-calendar.ts`:
  the UTC fields carry EXCHANGE-LOCAL WALL TIME (the Kibot shape; DST-free session math). The mock
  now emits that convention through the same calendar (Sunday-18:00 opens, no 17:00 hour), so both
  sources mean the same wall-clock hours and the entry window is comparable across them;
  `futures-session-calendar.spec.ts` + the mock guards pin the admissible buckets for known
  sessions, holidays, and early closes.
- **Durable paper futures book + stop-trigger simulation.** The paper broker is in-memory (resets on
  restart) and accepts stop/stop_limit/trailing_stop as working without triggering them. **Done when:**
  the book persists (Postgres) and stop-family orders trigger against subsequent bars.
- **Live futures execution rail (F4 remainder).** `'tradovate'` is declared but not implemented; a live
  rail (Tradovate/IBKR/Schwab-futures) plugs into `broker-provider` behind the existing
  `TRADING_LIVE_ENABLED` gate + fail-closed posture. **Done when:** a live futures adapter places a
  gated, confirmed order and reads positions/account, paper-proven first.
- **Futures risk semantics (F5).** Margin, point value/multiplier, and session/roll calendars in the
  portfolio money-manager (today's risk policies assume equity share sizing). **Done when:** sizing/exposure
  caps/stops are expressed in contracts + margin, not shares.
- **Cockpit futures view.** Extend the `intelligent-trades` surface (or a sibling package) with a futures
  panel over `market_bars` + the paper book. **Done when:** a human can see contracts, coverage/gaps, and
  the paper book from the cockpit.
