# ADR-069 — Operations & SecOps connectors: normalize the ITSM/observability integrations onto the connector runtime and rebuild operations as a bundled swarm

- **Status:** Accepted — substantially implemented (reconciled 2026-07-31): the ITSM/observability integrations are declarative connectors on the ADR-065 runtime (`swarm-apps/connectors/` — servicenow, datadog, dynatrace, pagerduty, snyk, grafana, jira, …), the operations bundle ships as `swarm-apps/intelligent-operations.yaml`, and the §2b dispositions are live rails per ADR-119. Originally Proposed 2026-06-22; direction agreed after an audit of the operations/observability
  tooling: the framework has a rich operator CLI toolchain and 46 declarative connectors, but its
  ITSM/observability integrations (ServiceNow, Splunk) are ad-hoc per-bot MCP servers, there is **no**
  observability connector (Dynatrace/Datadog), and the operations
  intake engine (inherited from the retired monitoring platform) is dormant. This ADR records the decision to normalize all of it onto the
  ADR-065 connector runtime and stand operations + SecOps up as bundled-by-type swarms.
- **Date:** 2026-06-22
- **Related:**
  [ADR-065 (connector runtime + spec)](065-connector-runtime-and-spec.md),
  [ADR-067 (connector marketplace + dynamic tool loading)](067-connector-marketplace-and-dynamic-tool-loading.md),
  [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-045 (graph extension)](045-two-tier-graph-database-and-connector.md),
  [ADR-040 (devops/Vault swarm)](040-devops-vault-swarm.md),
  [ADR-047 (edge bot-node + privileged-runtime security review)](047-smart-home-edge-agent.md),
  [ADR-049 (aggregation-platform thesis)](049-oshal-as-aggregation-platform.md)

## Context

OSHAL's operator DNA is real and intact. The full DevOps image
([Dockerfile](../../Dockerfile)) bakes in `vault`, `terraform`, `kubectl`, `helm`, `argocd`, `aws`,
`gcloud`, `az`, `ansible`, `gh`, `glab`, `yq`, `jq`, `docker` — the "super-operator who knows vault,
yq, etc." that any-bot started as. Personas formally scope these tools
([vault-bot.yaml](../../ai-lab/bot-personas/vault-bot.yaml),
[devops-bot.yaml](../../ai-lab/bot-personas/devops-bot.yaml),
[gcp-cli-bot.yaml](../../ai-lab/bot-personas/gcp-cli-bot.yaml)). On the application side, ADR-065/067
established a clean connector runtime: 46 declarative `connector.yaml` specs, per-user brokered
tokens, a marketplace, and capability-scoped tool exposure — **without** per-bot MCP bloat.

The operations/observability tooling never made it onto that runtime. The audit found three problems:

**1. ITSM/observability is ad-hoc per-bot MCP, not normalized.** ServiceNow
([servicenow-mcp-server.ts](../../src/mcp-servers/servicenow-mcp-server.ts), tools `sn_get_incidents`,
`sn_get_changes`, `sn_get_ci`, `sn_get_record`) and Splunk
([splunk-mcp-server.ts](../../src/mcp-servers/splunk-mcp-server.ts), tools `splunk_search`,
`splunk_recent_events`) are MCP servers spawned per-bot inside the Cline/Claude harness, configured by
**process-global env vars** (`SERVICENOW_URL`, `SPLUNK_TOKEN`, …) rather than per-user brokered
credentials. This is exactly the per-bot MCP footprint ADR-067 moved everything else off of, and it
means ITSM/SIEM access is single-credential and global, not per-user. They predate the runtime; they
were never ported. ADR-065's "Phase 4+" mentions porting "the remaining ~19 connectors" generically
but names neither of these, and there is no entry for them in BACKLOG/ROADMAP.

**2. There is no observability connector.** Dynatrace appears only as
a log-index naming convention in [.env.example](../../.env.example) (`…_dynatrace_alarms`); there is no
Dynatrace, Datadog, or New Relic connector anywhere.

**3. The operations intake engine is dormant.** The retired monitoring platform's surface was a full
incident-operations platform — OpenSearch alarm intake across Prometheus / CloudWatch / **Dynatrace** /
Zabbix indices, topology correlation, and RCA dispatch to specialist bots (`graph-analyst`,
`incident-remediation-bot` in
[swarm-bot-registry-local.ts](../../src/app/extensions/swarm/swarm-bot-registry-local.ts)). It is
**disabled by default** (its intake/preflight/OpenSearch env gates all unset), its legacy graph routes
are archived (replaced by ADR-045's caller-scoped `/api/graph`),
and its dashboard/personas are parked under `archive/`. The intake was **push-based and
OpenSearch-centric**, bypassing the per-user token rail. The RCA bots and topology-correlation logic
are the valuable part and are sound; the OpenSearch-centric intake and the legacy branding are not.

The requirement: operations must be **up and running** as a first-class app for real use, on the same
rails as every other app — per-user brokered tokens, marketplace discovery, capability-scoped tools,
no per-bot MCP bloat, laptop-runnable. And it must include **security operations**, not just IT ops.

## Decision

Treat operations and security-operations as **bundled-by-type swarms** (ADR-038) built on the ADR-065
connector runtime. Three moves:

### 1. Normalize ITSM + observability onto the connector runtime

Graduate ServiceNow and Splunk from per-bot MCP servers to declarative `connector.yaml` specs
([swarm-apps/connectors/](../../swarm-apps/connectors/)), and add the missing observability connectors,
all on the same runtime:

- **ServiceNow** — `connector.yaml` over the Table/Now API; the four `sn_*` reads become connector
  `tool:` resources. Per-user OAuth (ServiceNow supports OAuth2) replaces the global
  `SERVICENOW_USER/PASS` env vars.
- **Splunk** — `connector.yaml` over the Splunk REST/search API; `splunk_search` /
  `splunk_recent_events` become connector tools. Per-user token via the broker.
- **Dynatrace** — new `connector.yaml` over the Dynatrace REST API (problems v2, metrics v2,
  entities). Cleanest of the set — pure REST, API-token auth — and the operations intake already has a
  Dynatrace alarm lane to feed. **Build this one first** as the reference observability connector.
- **Datadog** and **New Relic** — same pattern, fast-followers once Dynatrace proves the shape.

The two MCP server files are retired once their connectors pass the `auditConnectorCatalog` gate and a
live credentialed read is proven; until then they stay as a fallback behind their existing env gates.
No new per-bot MCP servers are added for operations — everything rides the server-side API/CLI
execution paths (ADR-067).

**Use the OpenAPI importer, don't hand-author.** ServiceNow, Splunk, Dynatrace, Datadog, and New Relic
all publish OpenAPI/Swagger specs, so each `connector.yaml` is **drafted by the in-house importer**, not
written from scratch: `npm run connectors:import-openapi --provider <slug> --input <spec.yaml>`
([scripts/connectors/import-openapi.ts](../../scripts/connectors/import-openapi.ts) →
`specFromOpenApi()` in [openapi-import.ts](../../src/app/connectors/runtime/openapi-import.ts)) emits a
draft spec (one resource per operation, auth scheme + params mapped, opaque bodies flagged), then the
auth scopes / pagination / rate limits are hand-tuned and the audit gate run. This is **why we do not
reach for a third-party OpenAPI→MCP generator** (Speakeasy, Stainless, openapi-mcp-server, restish):
those land the integration as a per-bot MCP subprocess — exactly the footprint ADR-067 moved off —
whereas our importer lands it on the shared server-side runtime with per-user broker tokens and
capability scoping.

### 2. Rebuild operations intake on the runtime — keep the RCA bots, drop the legacy branding

The RCA/topology bots and pre-flight context logic are kept and renamed off the legacy prefix into a plain
**operations** swarm. The OpenSearch push-intake is **replaced** by pull-based connectors:

- Alarms/problems/incidents are **pulled** from the normalized connectors (Dynatrace problems,
  ServiceNow incidents, Splunk searches) via per-user brokered tokens, on a schedule (the existing
  Redis scheduler) or on demand — not pushed into a global OpenSearch index.
- Correlation/topology continues on the ADR-045 graph tier (`/api/graph`, per-caller scoped), which
  already replaced the old legacy graph routes.
- An **operations cockpit surface** (ribbon `?app=operations`) is the view over the bot-owned store
  (ADR-036): a unified incident/alarm board, RCA timeline, and "investigate" action that dispatches the
  RCA bot. The dormant archived dashboard is reference, not resurrected as-is.
- The dormant legacy intake env gates and the OpenSearch intake poll are retired once the connector-pull
  path is proven; they are not the long-term intake.

This keeps the proven RCA capability and the bundled-app accountability rails (cost capture, per-user
ownership) while dropping the global-credential, OpenSearch-only, separately-branded surface.

### 2a. Reuse the retired monitoring platform (private, out-of-repo) — DO NOT REBUILD

The retired monitoring platform is **two things**, and only one of them is being replaced:

- The dormant, in-repo, legacy-branded OpenSearch push-intake (the staged-items poll formerly in
  [queue-manager-service.ts](../../src/features/swarm-orchestration/services/queue-manager-service.ts),
  and its env gates) — this is what §2 retires in favour of per-user pull connectors **for the product
  surface**.
- The **separate, production-grade SRE platform (private, out-of-repo)** — a 14-microservice NATS
  alerting chain plus a **polished codex-packed one-shot RCA engine**. This is the proven asset the
  operator built; the operations swarm **integrates it, it does not reimplement it.** The engine is a
  **three-layer design — prep → hardener (box-in) → orchestrate** — reuse all three as-is:

  - **(a) Prep / extraction scripts** — run FIRST to assemble evidence into
    `deliverables/evidence/pre-fetched/` (one `.txt` per source + an `INDEX.tsv` of `[CTX-N]` ids) so the
    engine reasons over data, not live commands. They pull: live + previous pod state
    (`build/codex-rci-worker/readtools/kubectl-{describe-pod,logs,events,describe-node,pods-on-node,
    owner-chain}.sh`, `aws-{describe-instance,iam-get-role}.sh`); **historical references** + co-firing
    bursts via the OpenSearch tools in `build/codex-rci-worker/tools.yaml` (`history`,
    `alert_time_snapshot`, `error_pattern_recurrence`, `historical_rca`, `recent_alarms`, `host_alarms`);
    and **graph/topology about the node** (`graph_neighbors` Cypher, 1-hop K8s/AWS/SISM). Selection is
    cost/shape-gated (`default_enabled`, `cost_class`, `shapes`).
  - **(b) Hardener (the "box-in") — THIS is the hardener the operator means.** It constrains what the
    engine can do: `.claude/hooks/kubectl-safety.{sh,py}` deny mutating verbs
    (`apply|delete|patch|scale|drain|exec|…`) and make `doc` + `garden*` contexts **read-only** (writes
    only to an allowlisted context); `build/codex-rci-worker/readtools/_lib.sh` enforces a kube-context **allowlist**
    (operator-configured), strict input regexes (RFC-1123 names, `i-[0-9a-f]{8,17}` instances — no shell
    injection), and a 64 KB output cap. Codex runs `-s danger-full-access` only *because* this box makes
    the workspace safe. Reuse this guard set verbatim when wiring the engine into OSHAL.
  - **(c) Orchestrator + the two output paths** — `build/ai-enricher/codex-harness/one-shot-incident.sh`
    drives a single codex session through `orchestrator-prompt.txt`: domain-detect → investigate →
    peer-review → revise (≤2) → handover, `[CTX-N]`-cited. The engine classifies the incident and writes
    **one of two paths** (the operator's "path A / path B"): **Mode A = resolution** →
    `scripts/{diagnose,remediate,rollback}.sh` + `REMEDIATION-STEPS.md`; **Mode B = get-details** →
    `scripts/collect-evidence.sh` (only for data NOT already pre-fetched) + a branching decision tree;
    Mode C = `ESCALATION.md`. Knowledge assets reused as-is: `patterns.yaml` (failure→fix),
    `service-ownership.yaml`, `playbooks/`, the indexed runbook corpus. This is "the RCA bots are great,
    use them" — the OSHAL `rca-specialist` persona is the simpler claude-code
    cousin; the **codex one-shot engine is the polished one** and is the target RCA path.
  - **Topology loaders** — `build/graph/clean_tools/load_{k8s,aws,sism}_topology.py` (hourly) feed the
    ADR-045 graph tier `graph_neighbors` reads. Do not write new k8s pullers.
  - **Alert filter pipeline** — `event-filter → es-proxy (percolate) → event-stasher → grouper (graph
    correlation)`. Consume its output; don't re-derive dedup/quality-gate/correlation.
- **Boundary (no duplication):** the ADR-069 **connectors are the per-user, on-demand/scheduled PULL
  product complement** (a signed-in user reads *their* Dynatrace/ServiceNow); the retired monitoring
  platform is the **on-cluster enterprise PUSH pipeline + RCA engine**. They meet at the graph tier and
  the RCA engine, not by both ingesting the same alerts.

### 2b. The operations RCA workflow (ticket state machine) — mostly EXISTS, one gap to wire

The lifecycle the operator described — *monitoring alert → RCA queue → approve → enhance → disposition*
— maps almost entirely onto framework states that **already exist** (`OshalTicketStateSchema` in
[entities/ticket/types.ts](../../src/entities/ticket/types.ts)). The workflow is a definition job, not a
new engine. The state machine:

```
[monitoring alert]                     intake creates the ticket
   │                                   status = backlog   (ticketType = incident/operations,
   ▼                                                       labels = [operations, incident])
[RCA QUEUE]  ─── backlog view, awaiting operator approval
   │  operator APPROVES  (PUT /api/tickets/:id/resume → status = approved)
   ▼                      ── QueueManager pulls ONLY 'approved' → chooseDispatchPath → incident-rca
[ENHANCE]    status = in_process_discovery
   │  the codex one-shot RCA engine runs (§2a: prep → hardener → orchestrate),
   │  emits MODE on line 1 of RCA-REPORT.md + `DONE verdict=… mode=…`
   ▼
[DISPOSITION] ── set by the engine's MODE:
     MODE A (resolution proposed)  → status = customer_action, metadata.disposition = 'proposed_solution'
                                      (remediate.sh / diagnose.sh / rollback.sh attached)
     MODE B (human action needed)  → status = customer_action, metadata.disposition = 'human_action_needed'
                                      (collect-evidence.sh + decision tree attached)
     MODE C (escalate)             → status = escalated,       metadata.disposition = 'escalated'
                                      (ESCALATION.md attached)
```

**What already exists (reuse, don't build):**
- **States.** `backlog`, `approved`, `in_process_discovery`, **`customer_action`** (terminal,
  `requiresCustomerAction: true`), `escalated`, `complete`. `customer_action` is already the "operator
  must act next" terminal — used by career-hunter
  (`career-hunter-routes.ts:621`, now in the oshal-applications store per ADR-085) and parent-assembly
  ([parent-assembly-service.ts:196](../../src/features/swarm-orchestration/services/parent-assembly-service.ts)).
- **Intake → backlog.** Monitoring-fed tickets land in `backlog` (the in-repo legacy intake already did
  this; for the product surface the operations bot creates the ticket from a connector pull).
- **The approval gate.** `backlog → approved` via `PUT /api/tickets/:id/resume`
  ([ticket-routes.ts:312](../../src/app/routes/ticket-routes.ts)); QueueManager pulls only `approved`.
- **The pipeline.** `incident-rca` (`dispatchIncidentTicket`) already runs worker→review→revise and is
  wired by the `intelligent-operations` manifest (`ticketType: incident`).

**The finalizer mapping — ✅ BUILT 2026-06-22.** `dispatchIncidentTicket` previously finalized only to
`complete`/`escalated`. It now reads `MODE: A|B|C` from line 1 of `RCA-REPORT.md` (the RCA personas
already stamp it) and finalizes via `finalizeIncidentByMode`: **A → `customer_action` +
`disposition: proposed_solution`**, **B → `customer_action` + `disposition: human_action_needed`**,
**C → `escalated`** ([queue-manager-service.ts](../../src/features/swarm-orchestration/services/queue-manager-service.ts),
`INCIDENT_MODE_DISPOSITION` + `readRcaMode`). No MODE marker → falls back to `complete`, preserving
prior behavior for non-RCA / no-op workers. `complete` becomes the post-`customer_action` close
(operator marks the proposal applied), matching the career-hunter `customer_action → complete` pattern.
Unit-tested ([tests/unit/incident-mode-disposition.spec.ts](../../tests/unit/incident-mode-disposition.spec.ts)),
tsc clean. **The existing cockpit Tickets queue already renders Customer Action / Escalated** — this is
what populates them; no new UI. The decision is **ticket-is-the-surface** (no `?app=operations` board);
`disposition` distinguishes the two `customer_action` flavours on the ticket detail.

**Still open (Phase 3):** point the operations `workerBot` at the **codex one-shot RCA engine** (§2a)
instead of the simpler `rca-specialist`, and the operations bots can't be exercised end-to-end until the
operator stands up servers/infra for them to investigate and remediate (see BACKLOG — operator-gated). The finalizer above already works with the current `rca-specialist` worker.

### 3. Stand up a full SecOps bundle

Security operations is a bundled-by-type swarm (ADR-038), parallel to the IT-ops bundle, composed of:

- **SIEM / detection** — Splunk (shared with ops, as SIEM), plus Microsoft Sentinel and Elastic
  Security connectors. NL queries over detections, alerts, and hunts.
- **Cloud posture (CSPM)** — read cloud-config posture via the cloud providers already wired
  (`aws`, `gcloud`, `az` CLIs + their connectors): misconfig findings, public exposure, IAM drift.
- **Vulnerability** — a vuln connector (e.g. a scanner's REST API) feeding a findings board the bot
  reasons over and prioritizes.
- **Threat intel** — an enrichment connector for IOC/CVE context.
- **Secrets** — the existing `vault-bot` broker (ADR-040) is the secrets pillar; no new build.

A **secops-analyst** bot owns the domain (bot-owns-domain, ADR-036): it pulls findings via brokered
per-user tokens into a `user_sub`-keyed encrypted store, correlates on the graph tier, and does the
reasoning. A SecOps cockpit surface (`?app=secops`) is the view.

**Security review gate.** SecOps reads sensitive security telemetry and (for CSPM/vuln) touches
privileged cloud-config scope. Consistent with ADR-040 (production Vault) and ADR-047 (privileged
runtime), the SecOps bundle's first non-local use is **gated behind a security review** of: the broker
scopes granted to security connectors, per-user isolation of findings stores, and least-privilege of
the CSPM/cloud read roles. No global-credential shortcuts — every security connector rides the
per-user broker, same as ITSM.

## Consequences

**Positive**
- Operations + SecOps run on the **same rails as every other app**: per-user brokered tokens,
  marketplace discovery, capability-scoped tools, cost capture, no per-bot MCP bloat. ITSM/SIEM access
  becomes per-user instead of single global credential.
- The proven RCA/topology capability is preserved and made accountable, not rebuilt from scratch.
- One reference observability connector (Dynatrace) establishes a pattern that scales to Datadog/New
  Relic as `connector.yaml` PRs — connector additions, not new apps (ADR-038).
- SecOps becomes a real bundle with an explicit security-review gate, rather than an implicit gap.

**Negative / costs**
- Porting ServiceNow/Splunk off MCP means re-implementing their reads as connector specs and proving a
  live credentialed read per connector before the MCP fallback is retired — real work, not a rename.
- Per-user OAuth for ITSM/observability requires partner-app registration per platform
  ([partner-app-registration.md](../partner-app-registration.md)) and operator-supplied credentials —
  these are human-gated (see BACKLOG).
- CSPM/vuln connectors each need operator-supplied test credentials to verify; their code can't be
  proven without them.
- The security-review gate is a real dependency for SecOps go-live; it is a feature, not a delay.

## Phased plan

1. **Phase 1 — observability reference.** ✅ BUILT 2026-06-22 (audited + wire-tested; live read
   pending operator creds). `swarm-apps/connectors/dynatrace.yaml` (Environment API v2 — problems/
   entities/metrics/events, `Api-Token` auth, cursor pagination) on the ADR-065 runtime; passes
   `auditConnectorCatalog` 0/0. Added `${env:NAME:-default}` interpolation to the spec loader for the
   per-tenant base URLs (`DYNATRACE_BASE_URL`). Remaining: a live credentialed read once the operator
   supplies a tenant + token.
2. **Phase 2 — normalize ITSM + observability fast-followers.** ✅ BUILT 2026-06-22 (audited +
   wire-tested; live read pending creds). `servicenow.yaml` (Table API — incidents/changes/ci/
   table-query/record, per-user OAuth2, supersedes the env-global ServiceNow MCP), `datadog.yaml`
   (monitors/incidents/events/metric-search; DD-API-KEY per-user + DD-APPLICATION-KEY via env header),
   `newrelic.yaml` (REST v2 — applications/alerts, X-Api-Key). All pass `auditConnectorCatalog` 0/0.
   **Splunk stays MCP** ([splunk-mcp-server.ts](../../src/mcp-servers/splunk-mcp-server.ts)): its search
   is a stateful job (POST `/services/search/jobs`, `exec_mode=oneshot`) with SPL passed as a
   form-encoded field — the declarative runtime sends JSON and does not URL-encode body templates, so SPL
   with spaces/pipes would not serialize. The ServiceNow
   MCP retires once its connector gets a live credentialed read. Datadog NerdGraph and New Relic NerdGraph
   (GraphQL/POST) are follow-ups to the REST surfaces.
3. **Phase 3 — operations swarm (integrate the retired monitoring platform, don't rebuild — see §2a).** Wire the
   **codex one-shot RCA engine** as the operations RCA path, reusing all three layers: (a) the prep/
   extraction scripts (`codex-rci-worker/readtools/*.sh` + `tools.yaml` historical/graph tools), (b) the
   hardener/box-in (`.claude/hooks/kubectl-safety.*` + `readtools/_lib.sh` allowlist/validation/cap), and
   (c) the orchestrator (`ai-enricher/codex-harness` + `orchestrator-prompt.txt`) with its Mode-A
   (resolution scripts) / Mode-B (collect-evidence) output paths. Reuse the `load_{k8s,aws,sism}_topology.py`
   loaders into the ADR-045 graph tier; consume the alert-filter pipeline's output. Replace only the
   in-repo legacy-branded OpenSearch push-intake with connector pulls for the product surface; ship
   `?app=operations`; retire the legacy intake path.
4. **Phase 4 — SecOps bundle + security review.** 🟡 IN PROGRESS — SIEM/threat-intel connectors built
   (audited + wire-tested 0/0): `sentinel.yaml` (Microsoft Sentinel incidents/bookmarks over ARM; Azure
   AD oauth2; workspace coords bind from env into the path), `virustotal.yaml` (IOC enrichment —
   domain/ip/file/url; x-apikey), and `elastic-security.yaml` (Kibana detection-engine rules + Fleet/
   endpoint reads; `ApiKey ` header + kbn-xsrf), `tenable.yaml` (vuln scanning — scans/assets/workbench
   vulnerabilities; two-key `X-ApiKeys` header), and `defender-cloud.yaml` (CSPM — assessments/alerts/
   secure-score/compliance over ARM Microsoft.Security; Azure AD oauth2, subscription from env). The
   **connector matrix is complete** (SIEM ×2, threat-intel, vuln, CSPM). Note: AWS-SigV4 / Wiz-GraphQL-POST
   CSPM vendors don't fit the GET runtime (like Splunk) — Defender-via-ARM is the clean one. Still to do:
   the **secops-analyst** bot (bot-owns-domain, `user_sub`-keyed findings store), `?app=secops`, and the
   **security review** of broker scopes + finding-store isolation + cloud-read least-privilege before
   first non-local use.
