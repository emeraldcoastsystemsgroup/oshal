# Completed sub-items removed from partial backlog entries — 2026-08-05

These snapshots preserve implementation narratives removed while normalizing the active queue.
Some snapshots include their former residual wording for context; only `docs/BACKLOG.md` is the
authoritative active queue. Tests, ADRs, as-built docs, release notes, and git history remain the
authoritative technical evidence.

---

## Rides: Jarvis geocoding catalog guard

2. **Jarvis cannot use the new geocoding subcommands.** ✅ DONE 2026-08-02
   `src/app/routes/jarvis-tool-catalog.ts` still documents only `estimate` / `ride` for
   `oshal-uber-rides.js`. The CLI now also exposes `geocode "<address>"` and `reverse <lat> <lon>`,
   which are exactly what a "where is X / what's at these coordinates" ask needs, and Jarvis has no
   idea they exist. Left undone only because that file was outside the session's claim.
   **Done when:** the catalog entry lists both subcommands and a Jarvis ask that needs a coordinate
   resolves through the CLI instead of guessing. Small and safe — one usage string.

   Done: the entry now reads `estimate` · `ride` · `geocode "<address>"` (address → lat/lon) ·
   `reverse <lat> <lon>` (coordinates → address). The direction words matter as much as the
   subcommand names — a bare name routes nothing, the assistant has to recognise that "what is at
   these coordinates" maps to `reverse`.

   Guarded by `tests/unit/jarvis-tool-catalog.spec.ts`, deliberately TWO-SIDED: each subcommand is
   asserted present in `buildToolsBlock()`'s output AND implemented as a `case` arm in the CLI, so
   dropping it from either side goes red. Mutation-proved both ways (catalog reverted → 3 red, CLI
   subcommand removed → 1 red, restored → 6 green).

   Worth keeping: the guard's first draft matched the CLI name loosely and picked up the tools
   block's own PREAMBLE ("e.g. an Uber ride → oshal-uber-rides.js") instead of the catalog entry —
   so `ride` passed against the words "an Uber ride" while asserting nothing. It is anchored on the
   entry's `→ node /app/scripts/<script>` suffix now.

---

## Alert triage P1-P4 implementation ledger

## Alert triage & consolidation — intelligent-processing intake (P1–P4 built; A1 drill 2026-08-01, A2 legs 2026-08-02 — one leg still owed)

**Specified 2026-07-28** (operator directive: non-noisy alerts flow to the queue, duplicates get
bundled and consolidated — the analyst + self-healing portion). The functional specification is
[docs/architecture/alert-triage-and-consolidation-spec.md](../../architecture/alert-triage-and-consolidation-spec.md),
mined from the retired SRE platform's pipeline (ADR-069 §2a) including its own postmortem trail —
its proven constants are the spec's defaults and its documented flaws are do-not-repeat
requirements. The end state is [ADR-119](../../adr/119-autonomous-health-ticket-processing.md):
autonomous health ticket processing — the alert stream drives the RCA resolution stream through a
per-rule autonomy ladder. Build lands in four phases, each shipping its named guards in the same
change:

1. **P1 Consolidation** (intake route + ticket-service metadata). **Done when:** 10 identical
   concurrent firing alerts yield exactly ONE active ticket with `updateCount=9` and visible
   first/last-seen; a refire updates the ticket instead of a silent log-line skip; an unclaimed
   alertname increments a queryable noise counter; a higher-severity refire raises ticket priority
   and never lowers it — all proven by guard specs that go red on regression.
   **BUILT 2026-07-31**: `src/features/alert-triage/` (Stage A + Stage C + FR-A3 counters,
   recurrence linking FR-C5, genesis write-once FR-C6) wired into
   `src/app/routes/alertmanager-routes.ts` (+ `GET /api/alerts/intake-stats`, same fail-closed
   bearer guard); named guards in `tests/unit/alert-triage-consolidation.spec.ts`
   (identical-flood-one-ticket, refire-updates-not-duplicates, noise-counter-accuracy,
   severity-never-lowers, incident-key-hygiene, genesis-write-once + recurrence,
   consolidation-ttl-window, refire-never-redispatches, identity-gate).
2. **P2 Bundling + root candidate.** **Done when:** the api-down drill (`SwarmApiUnreachable` +
   `SwarmContainerDown` on the api + one dependent-bot alert inside the correlation window) opens
   ONE ticket with members + attach reasons recorded at attach time and the api as
   `rootCandidate`, and exactly one RCA dispatch occurs for the bundle.
   **BUILT 2026-07-31**: Stage D in `src/features/alert-triage/` (`alert-bundling.ts` +
   `dependency-map.ts` + the attach path in `alert-consolidation.ts`) — arrivals correlate
   against OPEN incidents inside `ALERT_CORRELATION_WINDOW`, never only the arriving batch
   (FR-D1); same-target (FR-D2) + static compose-topology dependency bundling at
   `ALERT_CORRELATION_DEPTH` hops with the ADR-045 graph as an optional `DependencyResolver`
   seam (FR-D3/D6, `ALERT_DEPENDENCY_MAP` override file); the ordered root-candidate policy
   (root filter → deepest dependency → earliest firstSeen) recorded as `rootCandidate` with
   its winning reason (FR-D4 — per-rule root-filter declarations arrive with the P3 claim
   registry); attach-time members carry `attachReason` under the `ALERT_MAX_MEMBERS` cap with
   a visible overflow counter (FR-D5); attach NEVER promotes or re-dispatches — an auto-flow
   member landing on a backlog bundle sets `needs-attention` instead (FR-D7). Named guards in
   `tests/unit/alert-triage-bundling.spec.ts` (api-down-drill-one-bundle, rca-dispatched-once,
   bundling-window-boundary, dependency-depth-limit, attach-never-promotes,
   root-candidate-policy, member-cap, dependency-map-override).
3. **P3 Dispatch gates** (claim registry hardening, RCA budget, flap damping, resolved handling).
   **Done when:** an over-budget auto-flow parks visibly as `analysis-skipped:budget` and a
   promote overrides; 6 refires in 30m defers dispatch with a `flapping` flag; with
   `ALERT_AUTO_RESOLVE=true` a fully-resolved backlog ticket self-closes while an `approved`
   ticket never does; a claim rule containing a time predicate is rejected at load.
   **BUILT 2026-07-31**: Stage B claim registry in `src/features/alert-triage/`
   (`claim-registry.ts` — rules `{match, incidentKey?, intake?, bundleHints?}` from
   `ALERT_CLAIMS_FILE` + `ALERT_APPROVED_NAMES` as a pure-claim shorthand, first match wins
   FR-B4, no registry ⇒ accept-all dev default, `ALERT_UNCLAIMED_POLICY` drop|backlog FR-B2;
   load-time validation rejects time-predicate matchers (FR-B3, guard 9), multi-alertname
   rules without `{alertname}` in the key template, placeholder-less/free-text/timestamp
   templates (FR-C1, guard 10's deferred half); per-rule key templates re-key Stage A and
   per-rule `bundleHints.rootFilter` feeds FR-D4 step 1 via genesis-stamped
   `incident.rootFilter`). Stage E gates: FR-E2 budget park (`rca-budget-gate.ts` over the
   per-event cost-ledger reader `src/app/routes/alertmanager-rca-spend.ts` — NOT a
   chat_tasks updated_at window, per the cost-governance seq-2 lesson; reserve-before-act
   p95 reservations with TTL true-up + release-on-failure; fail-OPEN on unreadable spend),
   FR-E3 flap damping (`flap-damping.ts` — threshold/window/quiet knobs, trips the
   `flapping` flag on the P2 flags[] seam, demotes only a not-yet-dispatched approved
   ticket, quiet-restores only what it parked, operator promote sticks), FR-E4 resolved
   handling (member `resolvedAt` slot filled from Alertmanager `endsAt`, refire clears it;
   backlog-only + opt-in + all-members-resolved + zero-overflow auto-close as
   `self-resolved`; `backlog → complete` added to VALID_TRANSITIONS for exactly this path).
   Named guards in `tests/unit/alert-triage-dispatch.spec.ts`
   (budget-skip-visible-and-promotable, budget-reserve-before-act, budget-fail-open,
   flap-defers-and-surfaces, flap-promote-sticks, flap-in-flight-flag-only,
   resolved-closes-only-backlog, resolved-never-closes-engaged-or-default-off,
   matcher-hygiene, key-hygiene-multi-alertname, claim-registry-routing,
   claim-root-filter-feeds-fr-d4, unclaimed-policy); P1's 11 + P2's 8 guards green
   untouched.
4. **P4 Autonomy ladder ([ADR-119](../../adr/119-autonomous-health-ticket-processing.md))** — structurally
   blocked on P1+P3. **Done when:** with the container-health rules at A1, a live container-kill
   drill flows alert → consolidated ticket → RCA proposal waiting at the approve gate with zero
   human touches before the gate; with `SELF_HEAL_AUTO_APPLY=true` (A2), a whitelisted worker
   restart auto-applies once, verifies the target healthy within its window, and completes the
   ticket — while a second failure of the same incident key inside the consolidation TTL
   escalates to a human instead of re-applying; an alert naming core infra (api/db/redis) NEVER
   auto-applies (guard); with the kill switch off, A2 behaves exactly as A1 (guard); every
   auto-apply is audited on the ticket with its verification result.
   **CODE + GUARDS BUILT 2026-08-01** (the live drill below is the remaining done-when half —
   it needs the running stack + monitoring overlay and is the operator's deploy-time proof):
   - **A1**: the four container-health rules in `ops/monitoring/alert-rules.yml` now carry
     `intake: auto` (per-rule opt-in, removable per rule to walk back to A0);
     `SwarmApiUnreachable` deliberately does not (watchdog territory). Analysis auto-flows
     through the P3 gates; the proposal still parks at the approve-or-close gate.
   - **A2**: `SelfHealAutoApplyEngine` (`src/features/alert-triage/services/auto-apply.ts`),
     consulted by the incident pipeline's Mode-A finalizer (`dispatch-incident-worker.ts`,
     threaded via `QueueManagerService.setAutoApplyGate` — the setBudgetService hook shape).
     Bounds, all mandatory: `SELF_HEAL_AUTO_APPLY` kill switch default FALSE (off = A1
     byte-identical); sanctioned classes = `restart-container` ONLY, declared by the exact
     `REMEDIATION-CLASS:` line-2 marker on RCA-REPORT.md (`readRcaRemediationClass`,
     fail-closed — no marker, no apply; target always from the incident's own alert
     evidence, never from LLM text); core infra NEVER applies (`isCoreInfraTarget` reuses
     the dependency-map name sets, re-checked at the execution boundary); once per incident
     key per `ALERT_CONSOLIDATION_TTL` (in-process ledger + the durable recurrenceOf
     predecessor audit; recurrence → `escalated`, never a restart loop); global
     `SELF_HEAL_APPLY_HOURLY_CAP` (default 3, reservation shape mirroring RcaBudgetGate;
     over cap parks visibly); verification-before-complete (`SELF_HEAL_VERIFY_TIMEOUT`
     default 120s — the ticket completes ONLY on observed health; failed verify/apply →
     `escalated` + `needs-attention`, audited). Execution path: the controller (no docker
     socket, no shell-out) POSTs the app-layer executor
     (`src/app/self-heal-remediation-executor.ts`, `SELF_HEAL_NODE_URL`) → the self-healing
     bot node's NEW deterministic `POST /api/self-heal/apply`
     (`any-bot/server/app-modules/routes-self-heal.js` — fail-CLOSED on
     `SWARM_SERVICE_SECRET`, role-gated to the self-healing node, same `selfHealingTools`
     whitelist as the LLM tool path, no LLM anywhere). Audit rides `incident.autoApply` +
     the `flags[]` seam (`auto-applied`, `auto-apply:verify-failed`,
     `auto-apply-parked:hourly-cap`, `auto-apply-blocked:recurrence`,
     `auto-apply-blocked:core-infra`) mirrored onto labels.
   - **Named guards** (`tests/unit/alert-triage-autonomy.spec.ts`, all call/behavior
     assertions): kill-switch-default-off, A1-analysis-never-remediates (incl. the
     alert-rules config half), core-infra-never-applies, once-per-key-per-ttl,
     hourly-cap-parks, verify-fail-blocks-complete, audit-trail-present,
     remediation-class-marker. P1's 11 + P2's 8 + P3's 13 stay green.
   - **LIVE CONTAINER-KILL DRILL (operator, deploy-time proof — the remaining done-when):**
     1. Deploy this code (`bash scripts/oshal-deploy.sh`) + bring up the monitoring overlay
        (`docker compose -f docker-compose.monitoring.yml up -d`) and the self-healing node
        (`docker compose -f docker-compose.oshal-local.yml --profile incident up -d
        self-healing-bot`). Ensure `.env` has `ALERT_WEBHOOK_TOKEN` (matching
        alertmanager.yml) and `SWARM_SERVICE_SECRET` set.
     2. **A1 leg (kill switch still off):** `docker stop oshal-local-research-bot`. Observe,
        touching nothing: SwarmContainerDown fires (~1–2 min) → ONE intelligent-processing
        ticket, `intake:approved` → incident-rca runs → ticket lands `customer_action` with
        `disposition: proposed_solution` and an RCA-REPORT.md whose line 2 is
        `REMEDIATION-CLASS: restart-container`. Zero human touches before the gate; nothing
        restarted (`docker ps` shows research-bot still down). Then `docker start
        oshal-local-research-bot` and close the ticket by hand.
     3. **A2 leg:** set `SELF_HEAL_AUTO_APPLY=true` on the api service, recreate the api,
        repeat the kill. Observe: same flow, but the ticket reaches `complete` unattended
        with `incident.autoApply.outcome=applied-verified`, label `auto-applied`, and the
        container back up (restarted by the self-healing node — check its logs for
        `[self-heal-apply] restart requested`).
     4. **Recurrence bound:** inside 24h (`ALERT_CONSOLIDATION_TTL`), kill the same
        container again. Observe: the NEW ticket (recurrence-linked) ends `escalated`
        carrying `auto-apply-blocked:recurrence` — no second restart.
     5. **Core-infra bound:** with A2 still on, `docker stop oshal-local-chromadb` (infra,
        non-fatal to the api). Observe: analysis runs, ticket parks at `customer_action`
        with `auto-apply-blocked:core-infra`; the container is NOT auto-restarted — restart
        it by hand. Flip `SELF_HEAL_AUTO_APPLY` back off when the drill is done.

Non-goal recorded deliberately: no accumulate-then-flush delay of the FIRST alert of an incident —
detection latency beats group tidiness in a self-healing loop (spec §10). ADR-119's A3 non-goal
also stands here: no autonomous code-change remediation; Mode B/C always land on a human.

---

## Scheduled Local CI implementation and diagnosis

## Scheduled Local CI — prove the next scheduled run uses and passes current main

**Found 2026-08-02** while checking whether the nightly gate would confirm the brace-expansion
lockfile change. It would not have.

`prepare_head_src()` in `scripts/ci-local.sh` builds the gate's source export with
`git archive HEAD` (line ~156). In `--scheduled` mode that is the OSHAL Local CI task's 23:30 run,
and on this box **HEAD is not main**. Measured at the time of writing:

| | commit | when |
|---|---|---|
| local `HEAD` | `5ddd2da` | 2026-08-02 10:58 |
| `origin/main` | `efa4d6e` | 2026-08-03 00:06 |

Three commits and thirteen hours apart. This is not drift to be tidied up -- it is the **designed
steady state**. Rule 0a has agents commit through a private `GIT_INDEX_FILE` + `commit-tree` +
push-by-SHA precisely so the shared HEAD and index are never moved, so HEAD only advances when
somebody deliberately re-syncs the tree. The nightly gate therefore judges whatever commit the
tree happens to be pinned at, which may be hours or days behind what actually shipped.

Consequences, in order of how bad they are:

1. **Code that landed on main is never gated by the nightly.** Everything merged since the last
   tree re-sync is invisible to it.
2. **A green nightly reads as "main is green" and is not evidence of that.** It is evidence about
   a stale snapshot. Same shape as the other two findings this session -- a check that looks like
   coverage and is not.
3. The `--head` rationale is still right: an unattended gate must not judge a mid-edit tree
   (comment at line 18). Judging `origin/main` satisfies that just as well, and is what the gate
   was morally always trying to do.

**The fix, roughly:** in `--scheduled` mode, `git fetch origin` first and archive `origin/main`
instead of `HEAD`; log the ref AND short sha being judged so the run and any alert email say which
commit was tested; if the fetch fails, judge HEAD but say loudly in the log that it is doing so.
Interactive `--head` runs should keep judging HEAD -- a developer running it locally means "test
what I committed".

**Done when:** a scheduled run's log names the ref and sha it judged, that sha equals
`origin/main` at run time, and a commit merged to main since the last tree re-sync is demonstrably
covered by the next nightly.

**Code completed and executable behavior proved 2026-08-05.** Scheduled mode now fetches
`refs/heads/main` into `refs/remotes/origin/main`, resolves it once to an immutable SHA, and uses
that exact SHA for all three committed-source consumers (node export, secret scan, image build),
the start log, and failure alert. Interactive `--head` remains local HEAD. Fetch failure is an
explicit `DEGRADED_FETCH_FAILED_HEAD_FALLBACK`, never a silent stale-remote pass. The hidden VBS
launcher now waits and propagates the gate exit, fixing the adjacent state where the 2026-08-04
log showed three failed gates while Task Scheduler reported `LastTaskResult=0`.

Guard: `tests/unit/ci-local-scheduled-ref.spec.ts` runs the production resolver against disposable
Git origins for scheduled-main, interactive-HEAD, and fetch-failure cases; pins every archive site
to the same variable; and executes a copied VBS launcher with an exit-37 gate. **Remaining live
stamp only:** confirm the next 23:30 run logs `archive-ref=origin/main`, its SHA equals the fetched
remote ref, and Task Scheduler's result matches the completed gate.

---

## Market remediation and Workflow Studio implementation history

## Market Remediation (2026-06-30 → 07-01 session)

Plan: `archive/market-remediation-swarm-plan-2026-06-29.md`. Assessment:
`archive/competitive-market-reassessment-2026-06-29.md`. Deploy/reboot: `runbooks/market-remediation.md`.
Admin console: `admin-console.md`. Shipped + tested this session (committed to main): append-only
audit (live); broad audit coverage + activity summary; RLS posture full-coverage + auditAppendOnly;
permission-aware RAG (group/tenant ingestion + connector-source ACL sync); A1.2 provisioning + the
`OSHAL_APP_ROLE_BOOTSTRAP` flag; admin console control plane (tenant CRUD + roles + connector toggle);
Workflow Studio template gallery; D4 quality gate; connector curation audit; nightly refresh.
Market score ~7.6 → ~8.0 (est.). Remaining:

### Workflow Studio — test-run, run history, run inspector
- **Update 2026-07-05 (commit 69f153d5): run history + run inspector SHIPPED.** Every 'graph'
  dispatch records `workflow_runs` + per-node `workflow_run_steps` (status, timing, agent,
  REDACTED input/output; one logical run across approval-gate suspend/resume via
  `metadata.workflowRunId`) through the engine's new `onStep` observer +
  `WorkflowRunHistoryStore` (migration 062 + lazy runtime schema + owner RLS). Auth-gated
  `GET /api/workflow-studio/runs(/:runId)`; studio Runs rail panel with a click-through
  step inspector. Unit-proven (`tests/unit/workflow-run-history.spec.ts`); not yet
  live-smoke-tested against the docker stack (needs image rebuild).
- **Remaining:** test-run a DRAFT from the studio. Deliberately not built — a draft test-run
  needs the studio compiler wired to the runtime, and that compile-to-runtime contract is
  roadmap per CLAUDE.md ("do not wire the studio compiler into the queue-manager"). Published
  workflows already exercise the engine + run history end-to-end.
- **Done when (remaining):** a draft test-runs from the studio without publishing, and the run
  lands in the same run history.

**Verified 2026-07-19:** PARTIAL — draft test-run still OPEN (only a `/compile` preview exists); compile-to-runtime + describe→canvas shipped for the simple case; branching/parallel + full agentic authoring open.

**Verified 2026-07-23 (LIVE, docker stack):** publish→execute + run history proven end-to-end
against the running swarm — `POST /api/swarm/apps/publish` (single-shot spec, `workerBot:
general-bot`, `autoStart:true`) compiled to a `pipeline:'graph'` nodeGraph, registered live;
ticket `c9c00a66-d43c-4df4-bee4-a42f2431d50f` walked backlog → approved (autoStart sweep) →
complete in ~2 min; general-bot genuinely executed (1 agentic turn, ~372k tokens, deliverables
written to the ticket workspace); run `5aef0722-6d04-4653-a001-db8889690bff` recorded all three
node steps. The "not yet live-smoke-tested" caveat above is CLOSED for the single-shot path.
Still open: a REPEATABLE live spec (the manual proof used a hand-driven PAT session; graph-mode
branching/parallel remains the least-proven publish branch) and the draft test-run above.

---

## Connector category and description curation

### Connector curation backfill
- **Reason:** measured (`npm run connectors:curation-audit`: 0% categorized/described, 53% icons) but
  not curated (judgment-heavy).
- **Done when:** top ~50 connectors have category + plain-language description + setup lane + verified icon.

**Verified 2026-07-19:** OPEN — audit shows 0% categorized, 0% described, 52% iconed of 307 connectors.

**2026-08-01 — CLOSED for category + description (icons remain).** The measurement was right and the
runtime was hiding it: `inferCategory` in marketplace.ts ended in `return 'General'`, so every
connector had a shelf label whether or not anyone had categorised it, and the 51 specs that DID
declare `metadata.category` were ignored (the entry builder only read `metadata.description`, and
`category` was not even in the `ConnectorSpec` type). One derivation now serves both the runtime
catalog and the backfill CLI (`src/app/connectors/runtime/curation.ts`): category from the spec's own
signals through an ordered rule table with **no catch-all** — undefined when nothing identifies the
provider, which the CLI treats as a build failure and the runtime shelves as the deliberately
wrong-looking `Uncategorized` plus one aggregated ERROR log; description derived from the spec's own
resources, host and auth lane. `npm run connectors:curate` checks, `-- --write` backfills; the audit
now reports full category + description coverage (read it from
`npm run connectors:curation-audit`, never from a number typed here). Rule coverage was checked
independently of the written values — with every declared category ignored, the rules alone still
reach the whole catalog. **Still open:** verified icons (the audit's third measure) and `riskLevel`
in the specs — riskLevel is computed at runtime from write/destructive counts, so declaring it in
YAML would be a second source of truth; decide that before backfilling it.
Guard: `tests/unit/connectors/connector-curation.spec.ts`.

---

## Queue pickup product fix

### Queue pickup / scheduler / backlog-vs-approved truth
- **Found (2026-06-23 02:03 CT):** live Docker logs show `ENABLE_AGENT_SCHEDULER=true`,
  the scheduler runner polling every minute, and due schedules being popped/dispatched.
  QueueManager also polls every ~15s with free slots, but its live log showed
  `approvedTotal:0`, so the observed "not getting picked up" state was not cron down.
- **Live DB snapshot (2026-06-23 02:03 CT):** `tickets` had `0` approved rows waiting,
  `3` backlog rows, and recent smoke/workflow tickets completed. Backlog rows are
  manual-intake/triage rows and are intentionally ignored by the queue manager.
- **Fix (2026-06-23 02:06 CT):** direct Project Manager ticket intake now creates
  `status:'approved'` work again, matching the March 2026 change log and allowing
  QueueManager pickup on the next poll. Operations Queue Health now reports
  `backlog`/`staleBacklog` separately and gives an approval/policy action instead of
  implying scheduler failure.
- **Verified:** `npm run test:unit -- tests/unit/project-manager-ticket-intake.spec.ts
  tests/unit/cockpit-queue-health-route.spec.ts`, `node --check OperationsView.js`,
  and `npm run typecheck` passed on 2026-06-23.

---

## Workflow Studio first-screen polish

### Workflow Studio first-screen builder polish
- **Found (2026-06-23 02:05 CT):** Workflow Studio had the backend talk-to-build path
  and live proof, but the product surface still read like a dense hand editor unless
  the user already knew where to start.
- **Fix (2026-06-23 02:06 CT):** added visible first-screen prompt starters for
  customer onboarding, build pipeline, and incident RCA; changed the primary builder
  CTA to `Generate`; and kept the old duplicate left-rail chat panel hidden.
- **Verified:** `npm run test:unit -- tests/unit/workflow-studio-surface.spec.ts`,
  `node --check workflow-studio-chat.js`, and `npm run typecheck` passed on
  2026-06-23.

---

## Connector marketplace discoverability implementation

### Connector marketplace breadth and discoverability
- **Found (2026-06-23 02:08 CT):** ADR-067 import/enrichment work produced the
  connector breadth, but the Discover surface still needed marketplace-grade narrowing
  and provenance so 1K specs did not feel like an unscannable wall.
- **Fix (2026-06-23 02:08 CT):** Connector Discover now has quick filters for enabled,
  write-capable, high-risk, OAuth, Google, and security connectors, plus catalog
  provenance chips for curated vs imported OpenAPI specs, verified logos, favicon
  fallbacks, and write-capable breadth.
- **Verified:** `npm run test:unit -- tests/unit/connector-discover-surface.spec.ts
  tests/unit/connectors/connector-marketplace-service.spec.ts
  tests/unit/connectors/connector-spec-tools.spec.ts
  tests/unit/connectors/openapi-and-catalog.spec.ts`, `node --check
  ConnectorDiscoverView.js`, and `npm run typecheck` passed on 2026-06-23.
- **2026-06-23 02:25 CT update:** connector breadth on disk is **306 curated**
  specs plus **1,000 imported OpenAPI** specs. The latest icon-enrichment report
  covers all 1,000 generated specs with **621 verified Simple Icons** and **379
  favicon fallbacks**. Marketplace entries now carry first-class onboarding metadata
  (`user-key`, `oauth-app`, `basic-auth`, `no-auth`), Discover renders that setup
  path on every card, filters for API-key/self-serve/OAuth lanes, and the catalog
  cache schema was bumped so old cached entries cannot hide the new fields.
- **Verified:** `npm run test:unit -- tests/unit/connector-discover-surface.spec.ts
  tests/unit/connectors/connector-marketplace-service.spec.ts
  tests/unit/connectors/connector-spec-tools.spec.ts
  tests/unit/connectors/openapi-and-catalog.spec.ts
  tests/unit/connectors/openapi-catalog-import-script.spec.ts`, `node --check
  ConnectorDiscoverView.js`, and `npm run typecheck` passed on 2026-06-23.
- **2026-06-23 02:26 CT update:** connector marketplace audit export is now available
  as JSON or CSV at `/api/connectors/marketplace/audit-export`, and the Discover
  header exposes the CSV download. Export rows include install state, risk, auth,
  onboarding mode, audit result, action counts, and source path.
- **Verified:** `npm run test:unit -- tests/unit/connectors/connector-marketplace-audit-export.spec.ts
  tests/unit/connector-discover-surface.spec.ts
  tests/unit/connectors/connector-marketplace-service.spec.ts`, `node --check
  ConnectorDiscoverView.js`, and `npm run typecheck` passed on 2026-06-23.
- **Still open:** 5+ live credentialed connector reads through brokered per-user
  credentials. OAuth breadth is intentionally gated by
  provider app registration and consent; API-key/PAT connectors remain the mass-import
  self-serve lane.

**Verified 2026-07-19:** OPEN (5+ live credentialed reads) — the 07-18/19 evidence is captured-fetch loopback (no real creds, no external calls).

---

## Token Chase optimizer usability implementation

### Token Chase optimizer usability
- **Found (2026-06-23 02:18 CT):** Token Chase had the right replay and
  bring-your-own-provider comparison APIs, but the inspector opened as giant raw
  system/history/response blocks. Operators could not see the cost/latency/replay
  controls without scrolling through debug payloads.
- **Fix (2026-06-23 02:20 CT):** the inspector now renders summary cards first,
  keeps determinism replay and provider comparison controls above the payload, and
  collapses raw response/system/history content behind details controls.
- **Verified:** `npm run test:unit -- tests/unit/token-chase-surface.spec.ts
  tests/token-chase-determinism-gate.spec.ts`, inline `<script>` syntax extraction,
  and `npm run typecheck` passed on 2026-06-23.
- **2026-06-23 02:38 CT update:** Token Chase now has a read-only no-token demo
  comparison at `/api/token-chase/demo/comparison` and a visible `Demo comparison`
  action in the optimizer UI. The demo uses the same cost resolver and determinism
  math to show estimated baseline cost vs actual variant cost without requiring a
  captured run, a BYO provider, or fresh LLM spend.
- **Verified:** `npm run test:unit -- tests/unit/token-chase-surface.spec.ts`,
  inline `<script>` syntax extraction, `npm run typecheck`, and
  `npx playwright test tests/token-chase-determinism-gate.spec.ts --config playwright.config.ts --workers=1 --reporter=line`
  passed on 2026-06-23.
- **Still open:** the competitive Cost Control score still needs a fresh live
  provider-backed Token Chase proof; this demo closes the no-data usability gap but
  does not pretend to be live provider evidence.

---

## Competitive evidence honesty fix

### Competitive score evidence honesty
- **Found (2026-06-23 02:27 CT):** the generated competitive readiness artifact
  could overclaim closure by trusting any old `Proof-Tier: live` evidence file with
  matching keywords. That made stale or contract-only proof too easy to confuse with
  current live readiness.
- **Fix (2026-06-23 02:30 CT):** the score generator now requires live evidence to
  declare `Proof-Tier: live` and carry a parseable `Generated`, `Validated-At`, or
  `Date` timestamp no older than 48 hours by default. The artifact was regenerated
  and now reports **7 closed / 6 below-market**, with the below-market lanes called
  out instead of hidden.
- **Verified:** `npm run test:unit -- tests/unit/competitive-score-evidence.spec.ts`,
  `npm run typecheck`, and
  `npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/competitive-score-evidence.ts --date 2026-06-23`
  passed on 2026-06-23.

---

## First-run connector bridge

### First-run onboarding connector bridge
- **Found (2026-06-23 02:32 CT):** the welcome flow had provider setup,
  capability selection, and legacy account connection, but it did not explain the
  ADR-067 marketplace connection paths. New users could still miss the difference
  between self-serve API-key connectors, OAuth app registration, no-auth connectors,
  and write-capable guarded connectors.
- **Fix (2026-06-23 02:33 CT):** the `Connect your accounts` step now fetches
  `/api/connectors/marketplace` and renders a compact setup-path summary for catalog
  size, self-serve connectors, OAuth app connectors, no-credential connectors, and
  write-capable guarded connectors before listing legacy connect buttons.
- **Verified:** `npm run test:unit -- tests/unit/first-run-demo-path.spec.ts`,
  `node --check src/pages/welcome/welcome.js`, and `npm run typecheck` passed on
  2026-06-23.

---

## Whole-app surface audit

### Whole-app surface validation sweep - REQUIRED BEFORE "POLISHED SAAS" CLAIM
- **Found (2026-06-22 20:31 CT):** manual operator screenshots showed multiple app
  surfaces render but do not feel usable: Rides, Eats, and Purchasing all exposed
  forms/debug-chat behavior instead of the category-native experience users expect.
- **Problem pattern:** screens can be technically reachable while still failing the
  product promise. Validation must visit every app/view from `swarm-apps/*.yaml`,
  capture console/page errors, detect JSON/debug leakage in visible chat, flag empty
  primary workspaces, and attach screenshots for review.
- **Done when:** an automated app-surface audit runs locally in mock OIDC, produces
  a per-view report, and the critical consumer/operator surfaces pass without hard
  render errors, JSON envelope leakage, or blank primary states.
- **2026-06-23 01:42 CT update:** `tests/app-surface-validation.spec.ts`
  passed across **65/65** manifest/static surfaces when run against the Docker-backed
  local dependencies via `npm run test:surfaces:docker`.
  A prior run against default `localhost:5432/6379` produced false 500s because the
  throwaway Playwright server was pointed at closed host ports, not the running
  compose services.
- **2026-06-23 01:55 CT update:** the same surface audit now includes category-native
  affordance checks for the operator-flagged commerce screens: Rides must expose
  map/location/ride options, Eats must expose address/search/cart/preference history,
  and Shopping must expose shipping/search/price comparison/cart handoff. This keeps
  future "it rendered" passes from hiding old form/debug-chat regressions.
- **2026-06-23 02:01 CT update:** `npm run test:surfaces:docker` passed **65/65**
  with the stricter affordance checks enabled. The first stricter run correctly caught
  Eats labels that existed only as placeholders; `eats-app.html` now shows visible
  Delivery Address and Restaurants/Cravings labels.
- **2026-06-23 02:23 CT update:** `npm run test:surfaces:docker` passed **65/65**
  again after the Token Chase optimizer polish, including `/api/token-chase/ui` and
  `/workflow-studio/`, with the Docker-backed Postgres/Redis ports discovered by the
  validation wrapper.
- **2026-06-23 02:40 CT update:** `npm run test:surfaces:docker` passed **65/65**
  after connector onboarding, audit export, score-evidence, welcome, and Token Chase
  demo changes. This validates static app surfaces still render without hard errors
  or raw bot JSON leaks; it is not a substitute for the six remaining live proof gates.

---

## Twilio transport and fan-out implementation

### Twilio as a pluggable notification transport (SMS / voice / WhatsApp-via-Twilio) 🟨 PARTIAL
- **The distinction that placed this here:** Telegram/Discord adapters are *free, first-party,
  bidirectional* chat with your own bot. Twilio is a *paid pipe* — it delivers a message you already
  wrote through Twilio's cloud, per-message fee, no bot behind it. They are different slots, not
  competitors. Twilio wins where the others can't: it reaches **any phone number with no app install**
  — i.e. the millionaire-alarm "text me / call me" legs — and it is a **sanctioned WhatsApp Business
  API reseller**, so it is the pragmatic WhatsApp path that sidesteps direct Meta Business
  verification.
- **Architecture:** a **pluggable notification/transport harness** (parallel to how LLM providers +
  TTS are pluggable — never hardcode one vendor, per the TTS rule in CLAUDE.md). Transports:
  `notify.telegram` / `notify.discord` (free, first-party) alongside `notify.sms` / `notify.voice` /
  `notify.whatsapp` (Twilio, **BYO-Twilio-account** — never a platform-owned key in a bot's env, per
  building-a-bot BYOK). The automation layer (millionaire-alarm) picks the transport per action.
- **Ownership caveat (why Twilio can't be the ONLY channel):** routing your assistant's messages
  through Twilio is the "act, but through a metered third-party cloud" pattern the competitive doc
  flags (the Zapier shape). Fine as a *chosen* BYO option; wrong as a mandatory dependency. Keep the
  free first-party channels as the default; Twilio is the paid-universal-reach upgrade.
- **Interface + first-party impl BUILT 2026-07-10:** the pluggable harness now exists as an FSD slice
  [src/features/notifications/](../../../src/features/notifications/) — a `NotificationTransport` interface
  (`kind`/`configured()`/`send()`), a registry (`resolveTransport(kind?)` by `NOTIFY_TRANSPORT`, no-op
  fallback), and `notifyOperator(message)` as the ONE call any feature uses (trading watchdog, creative
  studio delivery, failed jobs). The first-party **Telegram** transport is fully implemented
  (sendMessage/sendVideo, 50MB → text+link fallback, no-op when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
  absent, token never surfaced in a result/error). 11 unit tests with injected fetch (no network/creds)
  ([tests/unit/notification-transport.spec.ts](../../../tests/unit/notification-transport.spec.ts)); tsc clean.
  This is the same pluggable-provider discipline as LLM providers + TTS (CLAUDE.md). **≥2 real impls
  DONE 2026-07-10:** the **Twilio SMS** sibling now ships too
  ([twilio-sms-transport.ts](../../../src/features/notifications/services/twilio-sms-transport.ts)) — Messages
  API, Basic auth, BYO-account (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER` + a
  destination), media-URL appended to the SMS body, no-op when unconfigured, auth token never surfaced.
  **THREE real transports now** (text / SMS / call): `telegram`, `twilio-sms`, and **`twilio-voice`**
  ([twilio-voice-transport.ts](../../../src/features/notifications/services/twilio-voice-transport.ts) —
  Calls API, inline TwiML `<Say>`, XML-escaped so the spoken text can't break/inject the TwiML, no-op
  when unconfigured, token never surfaced) — the millionaire-alarm "call me" leg. 20 unit tests total.
  **BYO-Twilio via the per-user broker + connect doc DONE 2026-07-11:** the `twilio` connect card on
  /utilities (pasted Account SID + Auth Token, Jira two-value shape, validated against the Accounts
  API before persisting encrypted), brokered to the communications-bot as `OSHAL_CRED_TWILIO`, and
  consumed by the new [scripts/oshal-twilio.js](../../../scripts/oshal-twilio.js) (reads:
  digest/messages/calls/numbers/account; sends: sms/call, confirm-gated
  `--confirm`/`OSHAL_MESSAGE_SEND_CONFIRM`) — the comms bot now owns email + calendar + social +
  **phone/text**. Connect doc: [docs/channels/twilio.md](../../channels/twilio.md).
  **FOUR real transports now — WhatsApp-via-Twilio DONE 2026-07-11:** `twilio-whatsapp`
  ([twilio-whatsapp-transport.ts](../../../src/features/notifications/services/twilio-whatsapp-transport.ts))
  — the SAME Messages API as SMS with the `whatsapp:` address prefix + native `MediaUrl` (WhatsApp
  carries media inline, so no link fallback), BYO the same Twilio account (`TWILIO_WHATSAPP_FROM` +
  `TWILIO_WHATSAPP_TO`/`NOTIFY_WHATSAPP_TO`), no-op when unconfigured, token never surfaced. Numbers
  accepted with or without the `whatsapp:` prefix. 11 unit tests (injected fetch, no creds); registry +
  barrel wired; `.env.example` documented. **This closes the WhatsApp gap without Meta Business
  verification** (Twilio is a sanctioned WhatsApp reseller) — the "same adapter, different endpoint"
  the done-when calls out.
  **Fan-out primitive DONE 2026-07-11:** `notifyAll(message, {kinds?})` +
  `configuredTransportKinds()` in [notification-service.ts](../../../src/features/notifications/services/notification-service.ts)
  fan one alert across multiple transports concurrently (all configured channels by default, or an
  explicit list; an unconfigured requested channel is `skipped`, never an error; never throws — one
  bad channel doesn't sink the rest). 7 unit tests. This is the "text me AND call me AND WhatsApp me"
  leg of the millionaire-alarm done-when.
  **Remaining:** the millionaire-alarm RULE that maps alert severity → which `notifyAll` kinds fire
  (the primitive is ready; the policy layer isn't); a first-party `email` transport (today email is the
  comms-bot's, not a notification transport); inbound SMS → Jarvis as a true chat channel (Twilio
  webhook route).
- **Done when:** a `TransportAdapter` interface has ≥2 real implementations (a first-party channel +
  Twilio), the millionaire-alarm rule can fan an alert across text+call+email+Telegram, Twilio auth is
  BYO-account via the per-user broker, and a doc shows how to connect a Twilio number. WhatsApp-via-
  Twilio is the same adapter with a different Twilio endpoint — proving it also closes the WhatsApp
  gap above without Meta onboarding.

---

## Roadmap validation table

### Validation of the operator's statements

| # | Statement | Verdict | Evidence |
|---|---|---|---|
| 1 | "For Argo we need a production server; migrate to the gaming PC" | **Wrong — not needed for the proveout** | `docker-desktop` k8s (v1.34.3) is **running now** (control plane `127.0.0.1:58232`, 25d old). `tenant-a`/`tenant-b` namespaces already exist (3d) with ResourceQuotas and running `web` pods. Argo CRDs are absent (0 CRDs) — install them here. |
| 2 | ADR-078's premise: "two-tenant network isolation needs a NetworkPolicy-enforcing CNI we don't have" | **Wrong — it IS enforced locally** | Live test 2026-07-08: `tenant-b` pod → `tenant-a` podIP (no policy) = **200 HTML** (control: pods serve, routing works); `tenant-a` pod → `tenant-b` podIP (`default-deny-ingress`) = **blocked**. Cross-tenant deny is really enforced on Docker Desktop. |
| 3 | "localhost pushes to main and auto-deploys to localhost" | **Correct** | `docker-compose.hotswap.yml` runs the controller via `tsx watch` over bind-mounted source; CLAUDE.md Rule 0 is trunk-based. |
| 4 | "Token Chase is fine; the problem is the free-token router" | **Correct** | Token Chase capture/replay/grade/savings all ship. The free-tier router (ADR-064, `free-tier-rotation.ts` + `free-tier-providers.ts`) is real: 5 sources, live probing, rate-limit backoff. Its *health* is unproven. |
| 5 | "Multi-tenant is infra, not code; provision from YAML; a new DB, or an extra field if not fully isolated" | **Correct — and it matches ADR-078** | `ops/deployment/argo/tenant-namespace.example.yaml` already declares Namespace + ResourceQuota + LimitRange + NetworkPolicies + SA/RBAC + **per-tenant DB secret**. The "extra field" = a `tenant_id` column for the shared-DB tier. The graph tier ALREADY does DB-per-tenant (`getTenantGraph` → isolated ArangoDB database). |
| 6 | "Ollama proven before; we need to add the service" | **Correct** | `ollama`/`lmstudio`/`litellm` are **providers** in `provider-definitions.ts`; there is **no ollama service in any of the 9 docker-compose files**. ADR-078's WorkflowTemplate points at an `ollama.oshal-model.svc` that does not exist. |
| 7 | "Ollama is not a harness, it's an API provider; it runs through the cline harness" | **Correct** | `HarnessType = 'cline' \| 'codex-cli' \| 'claude-code' \| 'gemini-cli' \| 'noop'`. Ollama is absent → provider. Cline is the general harness that routes to any provider. |
| 8 | "Ensure the gemini CLI is installed on every node" | **Already done** | `Dockerfile.oshal` line 98: `npm install -g cline@latest @anthropic-ai/claude-code@latest @openai/codex@latest @google/gemini-cli@latest`. One image → every node. |
| 9 | "We need one-click Gemini login like codex and anthropic have" | **Half wrong** | Codex HAS a full OAuth flow (`openai-codex-oauth-routes.ts`: `/start` `/callback` `/status` `/signout` `/import` + `ui-openai-codex-oauth.mjs`). **Anthropic has NO popup-redirect route** — claude-code auth is a mounted `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`. And free-tier `gemini` is explicitly `oauth: false`: *"Signing in with Google does NOT grant this — paste an AI Studio key."* Google exposes no OpenRouter-style key provisioning. |
| 10 | "A2A gateway — I think this is done" | **Wrong — half is done** | Built: remote-client task queue (`register`/`heartbeat`/`tasks/next`/`complete`/`fail`/`swarm/next`), A2A types with 4 transports, MCP stdio bridge, edge node live-proven on edge-node-1. Missing: the **inbound gateway** — external/third-party agents discovering and joining the swarm. We can drive our own remote workers; a foreign vendor's agent cannot join. |

---

## Argo install, isolation, and batch-entry implementation

### Plan A — Argo locally, then a promotion pipeline 🟡 IN PROGRESS
The gaming PC is for *sustained* workloads and GPU model serving, **not** for proving Argo. Prove it on
the cluster that is already running.

**Done 2026-07-08** (see [078-argo-batch-proveout-status.md](../../architecture/078-argo-batch-proveout-status.md) addendum):
- ✅ `argo-workflows v4.0.7` installed; `workflow-controller` + `argo-server` Running.
- ✅ A real Workflow ran to **Succeeded** on this cluster (`argo runtime ok on this cluster`).
- ✅ `oshal-incident-rca` WorkflowTemplate **accepted by the live Argo CRD** in `tenant-a`
  (server-side apply, not `--dry-run=client`), entrypoint + 5 templates intact.
- ✅ **Cross-tenant isolation proven BOTH directions** — the deny had been one-directional
  (`tenant-b REACHED tenant-a`). Applied the ADR's symmetric deny-all + same-tenant re-grant to both
  namespaces ([tenant-network-policies.yaml](../../../ops/deployment/argo/tenant-network-policies.yaml));
  `bash scripts/governance/verify-tenant-isolation.sh` went 2-pass/5-fail → **7-pass/0-fail**.
- Gotchas recorded: big Argo CRDs need `kubectl apply --server-side` (the `last-applied-configuration`
  annotation blows the 256KB limit); Argo's `argo` SA needs executor RBAC or the main container
  succeeds while the workflow reports `Error` (per-tenant SAs already have it).

Remaining:

1. ~~**Install Argo Workflows**~~ ✅ done. (`argo` CLI still absent — `argo lint` would add
   controller-side semantic checks beyond CRD schema validation.)
2. 🟡 **The one-shot batch entrypoint — BUILT 2026-07-08.** Nothing to salvage from the retired monitoring platform's repo
   (no batch runner, no k8s Job manifests there). Built fresh:
   - Extracted `src/app/bot-node-runtime.ts` out of `bot-node-server.ts`'s unexported `start()` so the
     long-lived server and the batch runner share ONE construction path (server: 767 → 511 lines).
   - `src/app/bot-node-batch.ts` + `scripts/bot-node-batch.sh` run a single phase envelope on the same
     accountable any-bot stack (cost → `chat_tasks`), write `mode.txt` for the DAG, exit 0/1.
   - tsc clean · emits `dist/app/bot-node-batch.js` · 12 new unit tests · **900/900 existing unit tests
     still pass** (behaviour-preserving) · edited template still server-side applies to the live CRD.
   - Bug the tests caught: `EnvelopeExecutionResult` is `{success, output?, error?}` — reading
     `result.response` type-checks under a cast and silently yields `mode=unknown` for every phase.
   - ✅ **`finalize-incident.sh` + `record-cost.sh` also BUILT.** finalize reuses the SAME
     `INCIDENT_MODE_DISPOSITION` table (extracted to `rca-mode.ts`, re-exported by queue-manager so no
     call site changed); record-cost writes a **zero-cost run marker** — the phase pods already billed
     their own calls, and a non-zero marker would double-count every Argo run in every cost report.
     `bot-node-batch` now reads the mode from the canonical source (line 1 of `RCA-REPORT.md` via
     `readRcaMode`), falling back to the response regex only when no report exists.
   - Footgun caught by test: `finalize-incident` fell back to `process.env.MODE` — a generic env var
     (vitest sets `MODE=test`) that would have silently hijacked ticket disposition. Removed + tested.
   - **Remaining:** a real in-cluster run (needs the bot image rebuilt with the new `dist/` and loaded
     into containerd, plus the tenant's `oshal-tenant-db` Secret and `oshal-workflow` SA); and turning
     `QueueManagerService` into a thin **Workflow submitter** — the other half of §1, not started.
3. **Submit `oshal-incident-rca` for real** — one ticket → Workflow → Job pod → a `chat_tasks` cost
   row via the `onExit` handler. That closes ADR-078 Phase 2.
4. **Finish the tenant boundary:** `tenant-a` has **no** NetworkPolicy (only `tenant-b` does) — the
   deny is one-directional. Apply `default-deny` to both, add the missing LimitRange/SA/RBAC/DB-secret
   from `tenant-namespace.example.yaml`, then extend `verify:rls` with a cross-tenant assertion.
   Enforcement is already proven (finding #2), so this is a *completeness* task, not research.
5. **Promotion pipeline** (the operator's flow, made concrete): localhost → `main` (hot-swap, today)
   → `scripts/release/openswarm-sync.sh` gates (tsc + unit + secret scan) → **public repo `dev`** →
   PR → **public repo `main`** → **Argo CD** watches `main` and syncs. Argo CD (§5) is not wired and a
   `dev` branch does not exist in the sync script. Both are new work.
- **Done when:** a real ticket runs as an Argo Workflow on the local cluster and writes its cost row;
  both tenant namespaces deny cross-tenant traffic under an automated assertion; and a merge to public
  `main` triggers an Argo CD sync. Terraform (`**/*.tf` → none) stays deferred.

**Verified 2026-07-19:** OPEN (remaining items) — no in-cluster rca run, QueueManagerService is not a Workflow submitter, no Argo CD; the 07-18 Terraform layer is the ADR-086 base install, not Argo.

---

## Free-token lane proof and observability implementation

### Plan B — fix the free-token router (the real Token Chase blocker) 🟡 IN PROGRESS
Token Chase grades variants fine; it has no cheap lanes to grade because the free sources aren't
verified working. Sources today: **openrouter** (PKCE OAuth), **gemini** (AI Studio key paste),
**groq**, **cerebras**, **mistral**.

1. ✅ **DONE — 5/5 LANES LIVE (2026-07-11)**; done-when clause 1 (≥3) met and exceeded. Operator
   pasted the groq/cerebras/mistral keys; `prove-free-tier-live.ts` shows all five answering with
   real content. Evidence: free-tier-lanes-live-2026-07-11.md.
   Three defects fixed getting there — **working keys, dead lanes**: (a) compose had **no
   passthrough** for `GROQ_API_KEY`/`CEREBRAS_API_KEY`/`MISTRAL_API_KEY`, so a pasted key never
   reached the api or bot nodes; (b) Cerebras retired *every* llama-3.x id (live roster is
   `gpt-oss-120b` / `gemma-4-31b` / `zai-glm-4.7` — and gpt-oss-120b is a REASONING model, so a
   small-`max_tokens` probe returns 200-but-empty, the trap `free-tier-rotation.ts` already learned);
   (c) Gemini read only `GEMINI_API_KEY` while the key sits in `GOOGLE_API_KEY`, and a display path
   re-derived `<PROVIDER>_API_KEY` and printed a live lane as "not configured" — harness lanes now
   carry a `keyEnvs[]` list. Deliberate spec drift: it probes env keys standalone rather than
   Postgres-connected rows via `freeTierToHarnessConfig()`, so it runs on a bare checkout.
2. ✅ largely done via the 07-10/11 hardening (`d4f27a38`, runtime `:free` discovery, probe caches,
   walled→null, operator exemption, hard `:free`-only guard on the platform key).
3. ✅ **Make rotation observable** — surface `markUsed` / `reportRateLimit` / `reportSuccess` state in the
   cockpit so a dead lane is visible instead of silently skipped. (The platform rotation lane's
   in-memory verdict is still surfaced nowhere — that half stays open.) **De-orphaned 2026-07-12:**
   `/free-models` is now linked from the welcome wizard's model step ("connect your own free AI
   tokens"), the cockpit free-shared-model banner ("Get free AI credits"), and Utilities' free-lanes
   card; the OpenRouter OAuth callback lands back on `/free-models?connected=` with a success banner
   (errors return readable on `?connect_error=` instead of a bare 400), and the OpenRouter card
   carries the one-time-$10 → 1,000/day credits tip with a clickable openrouter.ai/credits link.
4. ⬜ Wire Token Chase's variant lanes to the *live-verified* free providers first-class (today a
   free lane is reachable via the `framework:openrouter` coercion below or a BYO save, not offered
   automatically with health).
- **2026-07-11: the real-baseline free-lane grade RAN** — real captured frames (jarvis-summary +
  headless-CLI runs) replayed on a bot node against `openai/gpt-oss-20b:free` and graded by the
  determinism gate ($0, credits untouched): one `deterministic/equivalent`, one `divergent`, one
  handled replay-error. Evidence: token-chase-real-baseline-2026-07-11.md.
  Same session closed a **spend trap**: the optimizer's `framework:openrouter` lane defaulted to
  PAID `anthropic/claude-3.5-sonnet` on the credited platform key, bypassing the `:free`-only
  guard — `optimizer-providers.ts` now coerces that lane to `platformFreeConnection()`'s probed
  `:free` pick and refuses it when quota-walled (`tests/unit/optimizer-platform-key-guard.spec.ts`).
- **Done when:** ~~the harness proves ≥3 free providers answering live~~ ✅ **5/5 live 2026-07-11**;
  the cockpit shows per-lane health (step 3 — **the only clause left**); and ~~one Token Chase run
  grades a real (not demo) baseline against a free lane~~ ✅ done 2026-07-11 (evidence above).
- **Follow-up (small, found by the 5/5 run):** `cerebras` is NOT in the optimizer's OpenAI-compat map
  (`optimizer-providers.ts` COMPAT), so its free `gpt-oss-120b` can't be a Token Chase replay lane
  even though the key now reaches the container. Groq + Mistral already are. Adding it is one map
  entry + a live-probe check.

**Verified 2026-07-19:** PARTIAL — `/free-models` is linked, but per-lane rotation health is still surfaced nowhere (step 3 stays open); the cerebras COMPAT follow-up is DONE (optimizer-providers.ts:47).

**DONE 2026-08-01 (wave17-cockpit) — step 3 closed; this entry's LAST open clause.**
`GET /api/connect/free-tier/rotation` (auth-gated, caller-scoped through
`listFreeTierConnections`) plus the per-lane detail in the Utilities free-lanes card.

- **Per-lane, a dead lane is now visible instead of silently skipped**: `cooldownRemainingMs`
  (when it comes back), `lastStatus` (why it left), and the new `lastUsedAt` → `stale` /
  `neverUsed`. That last one is the signal the entry was really asking for: a lane the rotation has
  quietly stopped picking has no cooldown and no error, so under the old binary
  connected/cooling-down pill it looked **identical to a healthy one**.
- **The shared platform lane is readable at last.** `platformVerdict` / `freeCatalog` /
  `lastLivePlatformModel` were module-level with no accessor, so "the shared lane is walled until
  14:05" was a fact only the logs knew. New `freeTierRuntimeSnapshot()` reads them **without
  probing** — and non-probing is the whole design constraint, because calling
  `platformFreeConnection()` from a polled surface spends up to `MAX_PLATFORM_PROBES` real
  completions of the shared key's daily free-request quota. The surface would have burned the
  resource it reports on. `/resolve` is unusable here for the mirror-image reason: it `markUsed()`s,
  so polling it would make the reading change the reading.
- **Three honest platform states, no guessing**: `live` / `walled` / `unknown`. `unknown` means this
  api process holds no cached verdict; it is rendered as unknown rather than assumed healthy, and
  the row says the verdict is per-process (one in-memory cache per replica).
- No key crosses the boundary — the snapshot returns the model id and the verdict, never the key.
- Guard: `tests/unit/free-lane-rotation-observability.spec.ts` —
  **free-lane-rotation-is-observable-and-read-only**, 9 tests, 10 targeted mutations each proven
  red (including the two that matter most: the read issuing `markUsed`, and the read probing the
  platform lane).

Still open on this entry: step 4 (wiring Token Chase's variant lanes to the live-verified free
providers first-class). Untouched here.

---

## Ollama service implementation and live service proof

### Plan D — add the ollama service (unblocks the all-local profile) 🟡 IN PROGRESS
1. ✅ **DONE 2026-07-08** — `oshal-ollama` + one-shot `oshal-ollama-pull` added to
   `docker-compose.oshal-local.yml` behind the **`local-llm` profile** (default stack unchanged:
   `config --services` shows 0 ollama services without the profile). `OLLAMA_HOST` declared on the
   shared bot env; `oshal_ollama_models` volume caches the pull. Runbook:
   [docs/runbooks/local-llm-profile.md](../../runbooks/local-llm-profile.md).
   **Live-verified:** service healthy → `qwen2.5:0.5b` pulled → host `/api/generate` returned exactly
   `local swarm online` (eval_count 4) → in-network generate from `oshal-local-api` against
   `http://oshal-ollama:11434` succeeded (the hostname bots resolve).
2. ⬜ **Gotcha found:** a container created BEFORE the env declaration keeps its old environment —
   `docker exec oshal-local-api sh -c 'echo $OLLAMA_HOST'` printed nothing. `cline-config-builder.ts`
   then falls back to `http://localhost:11434` (the container itself). Needs
   `up -d --force-recreate --no-deps oshal-api` (deferred: the live stack was mid-work).
3. ⬜ Register a bot with provider `ollama` on the **cline** harness; prove a real ticket answered
   with **zero cloud keys**; benchmark.
4. ⬜ Add an `oshal-model` k8s Service so ADR-078's `model-endpoint` (`ollama.oshal-model.svc`) resolves.
- **Done when:** a swarm answers a real ticket with zero cloud keys, benchmarked — only then does the
  site's "Packaged all-local profile" roadmap line move to Shipped. **Model serving alone is not the
  claim.**

**Verified 2026-07-19:** OPEN (steps 2–4) — no ollama-provider bot + zero-cloud-keys ticket proof; no `oshal-model` k8s Service; the local-boot evidence is a health probe, not a ticket.

---

## CI secret-scan implementation and green-run history

## CI secret scanning — prove the planted-secret failure on a real GitHub runner
- **Resolved (run 29048082693):** the first fully-green CI run (workflow_dispatch on ca89e5e8 — see
  "Re-enable CI" above) executed `secret-scan` and `quickstart-smoke` green on a real GitHub runner,
  closing the "never executed on a runner" concern this entry was filed for. The bullets below are
  kept as history of what was added and why it was deferred at the time.
- **Added (2026-06-21):** `secret-scan` (gitleaks + tuned `.gitleaks.toml`) and `quickstart-smoke`
  (build image → boot `noop`/`MOCK_OIDC` API+datastores → assert `/health`, `/cockpit/`, ticket
  create) jobs in `.github/workflows/ci.yml`, plus a gitleaks entropy gate in
  `scripts/build-public-baseline.sh`.
- **Why deferred (historical, 2026-06-21 — since resolved, above):** all three were validated
  LOCALLY only (gitleaks config → 0 findings on the baseline; the boot smoke run by hand); at the
  time the Actions jobs had never executed on a runner, which was owner-gated.
- **Hardened (2026-06-21):** `quickstart-smoke` now probes IN-CONTAINER
  (`docker compose exec -T oshal-api curl localhost:5000/…`) instead of the host→published-port
  hop, which intermittently timed out (000) in the local Windows/Docker-Desktop sandbox even with
  a healthy container. It also asserts a real `ticketId` and a non-empty `swarm_applications`
  table — so it actually guards the fresh-DB migration regression, not just liveness. The cockpit
  route check accepts either `200` or the expected auth `302` redirect. This exact probe pattern
  was verified by hand against the real container (`/health` 200 + 36 apps); only the Actions
  execution itself is unproven.
- **Done when:** ~~a push shows `secret-scan` and `quickstart-smoke` green in Actions~~ (met — run
  29048082693), and a real planted test secret makes `secret-scan` red (⬜ still open — the only
  live clause in this entry).

**Verified 2026-07-19:** MOSTLY STALE — run 29048082693 went green across all 7 jobs (supersedes "never executed on a runner" above); the planted-secret red proof is still missing.

---

## Build escalation diagnosis, metadata fixes, and prior evidence

## Build-phase escalation — refresh the remaining golden live run

**Verified 2026-07-24 (diagnosis fleet):** the escalation decision point (`dispatchTicket` no-output
guard → `pipeline_work_items_failed`) is CORRECT and live-proven in the running stack's DB: 6 of the
7 most recent build tickets entering `in_process_build` (07-19/07-20) reached `complete` (incl. a
real $0.68 claude-sonnet work-item execution); the single escalation carried full metadata. The
2026-06-22 18/33 wave was a credential outage (keyless env / expired OAuth — every work item failed),
not a logic defect. Half (b) (empty escalation metadata) closed 07-10 via
`buildStatusTransitionMetadata` backstop — 0 of 51 escalations since 07-01 have empty metadata.
Guards: `tests/unit/ticket-status-history-metadata.spec.ts`, `tests/unit/queue-manager-escalation-detail.spec.ts`.
**Residual (live-gated):** trigger one golden scenario (`test-lab-golden.ts` route, PAT auth) to
terminal and refresh `test_lab_golden_runs` — the eval wall still shows the stale pre-fix 06-22 red.
- **Found (2026-06-22, via the AI Test Lab eval-wall):** of the golden test-lab tickets, escalation is
  the **dominant** terminal outcome — 18/33 escalated, only 4 completed. Every escalation is
  `changed_by='system'`, `from_status='in_process_build'`, with **empty metadata (no reason recorded)**.
  So the swarm's build phase is systematically escalating build tickets rather than completing them, and
  the escalation path logs no cause — which makes it hard to debug.
- **How it surfaced:** the eval-wall now (correctly) marks an escalated-but-well-scored run `degraded`,
  not `pass`, so this shows as a low success rate on the wall rather than fake green — ADR-063 §eval-wall,
  [test-lab-golden.ts](../../../src/app/routes/test-lab-golden.ts).
- **Why deferred:** the fix is in core swarm-orchestration build/escalation code (the `in_process_build`
  → escalate path), out of the eval-wall's lane and actively churning under the trunk consolidation.
  Belongs to the build/escalation owner, not the test lab.
- **Done when:** (a) a golden build ticket reaches `complete` for a correct deliverable instead of
  escalating; and (b) every escalation records a reason in `ticket_status_history.metadata` so the cause
  is debuggable.
- **2026-06-22 update:** new queue/dispatch escalation paths now write metadata, and
  `/api/v1/metrics/queue-health` exposes stale approved work, stale in-process work, build escalations,
  and missing escalation metadata. This improves diagnosis but does **not** close the bug until a fresh
  build ticket completes or escalates with useful metadata in the live runtime.
- **(b) CLOSED + audited 2026-07-10.** Traced every `in_process_build → escalated` path: all write a
  reason (`child_ticket_escalated` in `parent-assembly-service`, `pipeline_work_items_failed` +
  `planning_decomposition_failed` in the dispatch path, `dispatch_slot_timeout` /
  `max_dispatch_attempts_exceeded` / `deferred_*_max_attempts_exceeded` / `parent_terminal_state` in the
  poll/sweep/gate paths), and `buildStatusTransitionMetadata` ([ticket-service.ts](../../../src/features/ticketing/services/ticket-service.ts))
  BACKSTOPS any reason-less escalation with `reason:'unspecified_escalation'` + `previousStatus` +
  `source` + `severity` + `nextAction` — so an empty-metadata escalation is now structurally impossible.
  No store-bypass path exists (the only metadata-less `ticket_status_history` INSERT is ticket *creation*,
  not escalation). Regression-locked by [ticket-status-history-metadata.spec.ts](../../../tests/unit/ticket-status-history-metadata.spec.ts)
  (the `from_status='in_process_build'`, no-reason case → `unspecified_escalation` + `previousStatus`).
  **Depth fix (the real "why"):** `pipeline_work_items_failed` recorded only a COUNT — you saw "N items
  failed" but not the cause. It now embeds per-item detail (`failedWorkItems[]` = title + assigned agent
  + the extracted agent/CLI error) via `summarizeFailedWorkItems`/`extractWorkItemError`
  ([queue-manager-service.ts](../../../src/features/swarm-orchestration/services/queue-manager-service.ts)),
  bounded (≤5 items, ≤300-char errors, only known string error fields — never dumps raw output/prompts).
  Tested: [queue-manager-escalation-detail.spec.ts](../../../tests/unit/queue-manager-escalation-detail.spec.ts).
- **(a) STILL OPEN — live/LLM-gated, not a code bug.** Root cause of the systematic escalation: a child
  build ticket escalates on `pipeline_work_items_failed` when its LLM execution produces no output
  (keyless / Cline exit 1 / the Claude-token-401 escalation item), and the parent then propagates
  `child_ticket_escalated`. A build reaching `complete` therefore needs a live swarm with a WORKING LLM —
  it's the build-path owner's + the token-keepalive fix's territory, and forcing it means a real
  end-to-end run, not a unit change. The new `failedWorkItems[].error` is exactly the trace to diagnose
  it: parent (`child_ticket_escalated`) → child (`pipeline_work_items_failed` → `failedWorkItems`).
- **Owner:** swarm-orchestration (build pipeline / `in_process_build` → escalate path) — for (a).

**Verified 2026-07-19:** PARTIAL — (b) closed 07-10; (a) remains live/LLM-gated: the 07-19 loopback evidence proves the complete-vs-escalate logic sound, but is not a live e2e run.

---

## Inline-bot execution implementation history

## Inline-bot execution — run the remaining identity-leg live smoke

**Verified 2026-07-24 (diagnosis fleet):** fixed through the `executeBotOrInline` chokepoint —
`CONTROLLER_INLINE_CONTAINERS` in `bot-node-client.ts` makes the resolver return null for inline
bots so dispatch runs in-process instead of 401ing against the OIDC catch-all. All five routes
(carved to the store per ADR-085) use it; four of five bots have real cost rows in `chat_tasks`.
Guard: `tests/unit/inline-bot-execution.spec.ts`. **Residual (live-gated):** one PAT-authenticated
identity-leg smoke (`GET /api/identity/advice` → 200 + new `chat_tasks` row) to close the done-when.
- **Found:** 2026-06-17 Jarvis access test. The controller (`oshal-api`, `server.ts`) does NOT host
  `/api/swarm-execute` (only bot-node-server.ts does); `BotNodeClient.execute` is HTTP-only and
  resolves inline bots to `http://oshal-api:5000/api/swarm-execute` → OIDC catch-all **401**. So the
  inline reason-only apps that call `BotNodeClient.execute` — `finance-routes.ts`
  (`runAnalyst`), the store-side Identity Hub route (`runAdvisor`),
  youtube-kids, bot-presentation, social — never actually executed end-to-end.
- **Fix (proven in jarvis-routes):** run inline bots via `ctx.orchestrator.processMessage(agentId,…)`
  in-process (the cockpit-chat path) instead of `BotNodeClient.execute`. Dedicated-container bots
  (email-bot/home-bot/cloud-ops-bot) keep `BotNodeClient`. Jarvis encodes the split in `NODE_AGENTS`.
- **2026-06-22 update:** source fixed through `executeBotOrInline()`: signed-in app routes use real
  bot-node execution only when `BotNodeClient.hasEndpoint(agentId)` is true; otherwise they run through
  the orchestrator in-process. Unit coverage: `tests/unit/inline-bot-execution.spec.ts`.
- **Done when:** `GET /api/finance/brief` (and identity `/advice`, youtube-kids brief) returns real
  bot text for a logged-in user, not a 401/empty, with cost in chat_tasks under the bot's agent_id.

**Verified 2026-07-19:** FIXED-pending-live-verify — `executeBotOrInline` is used by 17 routes + a unit spec; finance is now a real bot-node. The live done-when smoke is the remaining gap.

---

## Graph operational/domain adoption closure

## Graph adoption — swarm operational graph + domain carve-outs (ADR-045) ⬜

ADR-045 built the engine-agnostic graph connector + per-person/per-tenant tiers (ArangoDB
Community), live-verified against a real instance (`scripts/graph-smoke.ts`). The infra exists; what
remains is *using* it. Each item below is **domain ingestion + NL queries over the same `/api/graph`
connector — no new database, no new service** (see ADR-045 "Adoption").

- **What (in priority order):**
  1. **Jobs carve-out (`career-hunter`) — do first.** Ingest jobs ↔ companies ↔ recruiters ↔ skills
     ↔ applications ↔ profile (the migrated 807k postings + 192 recruiters are a graph in waiting).
     Add NL graph queries: recruiter-placement paths, skill-overlap ranking, "jobs two hops from
     companies I've interviewed at," application funnel.
  2. **Swarm operational graph (general, tenant tier).** Ingest swarm events (agent ↔ ticket ↔
     work-item ↔ phase ↔ artifact ↔ cost) into the shared tenant graph so any bot can trace
     dependencies / blast radius / cost-by-subgraph / routing over real history.
  3. **Capture carve-out (`federal-capture` / `capture-crm`).** opportunities ↔ agencies ↔ incumbents
     ↔ teaming ↔ NAICS ↔ vehicles for partner/prime discovery.
- **Explicitly NOT:** presentations, storage, education, youtube-kids, finance, smart-home — relational/
  document fits; don't force graph there.
- **Done when:** the jobs carve-out ingests its domain and `career-advisor`/`career-hunter` answers a
  real graph question (e.g. "recruiters who place at companies needing my top skill") through
  `/api/graph`; the swarm operational graph populates from live ticket events.

**Verified 2026-07-19:** PARTIAL — /api/graph query/upsert + the Arango adapter are built (engine-gated); the jobs / ticket-event / capture ingestions are all unwired.

**Verified 2026-07-19 (completion-day):** two of the three domain ingestions are now WIRED by `85931d2a` — supersedes the "all unwired" clause. Item 2 (swarm operational graph) ingests ticket-lifecycle events into the tenant graph via `src/shared/ticket-events.ts` + `ticket-service.ts` hooks through the new `graph-ingestion.ts` (engine-gated — no-op without `ARANGO_URL`); item 3 (capture carve-out) ingests the opportunities/agencies/incumbents flow via `gov-contracting-cron.ts`. Guard `tests/unit/graph-ingestion.spec.ts`. Item 1 (the jobs carve-out) shipped **store-side** at the career-hunter package (`14e084e`, oshal-applications) since Career Hunter is now a store app. Done-when is satisfied for the ticket-events + capture halves; the jobs NL-graph queries live store-side.

---

## Smart-home app package and gate implementation

### Smart-home swarm
- **What:** `swarm-apps/home.yaml` (Smart Home). Connectors + CLIs for SmartThings,
  Google Nest, (later Home Assistant / Hubitat / Alexa). The home-bot controls devices by chat.
- **Status (2026-06-16):** app loads active, home-bot registered, persona + `oshal-smartthings.js`
  exist — but it is correctly **grayed/coming-soon** because it is NOT wired end-to-end:
  1. `oshal-smartthings.js` was **excluded from the image** (`.dockerignore` allowlist gap) so
     the bot had no device tool in-container. FIXED — added to the allowlist (needs rebuild).
  2. The SmartThings connector is **OAuth** (`api.smartthings.com/oauth/authorize`) but
     `SMARTTHINGS_CLIENT_ID`/`SECRET` are **EMPTY**, so the authorize redirect errors on
     SmartThings' side ("unexpected error / Reference ID"). A stale code comment still claims
     token-paste. **Decision needed:** (a) register a SmartThings SmartApp OAuth client under
     `maintainer@emeraldcoastsystemsgroup.com` + set client_id/secret (durable; matches partner-app rule),
     or (b) revert the connector to the originally-documented token-paste PAT flow (simpler, but
     SmartThings is deprecating PATs). Until one is done, do NOT add `home` to the apps WORKING list.
- **Done when:** a user connects one hub and the bot can read device state + run a scene.

**Verified 2026-07-19:** DONE for this entry's gate — SmartThings OAuth-In is wired with live creds (supersedes the EMPTY-client-id line above).

**CARVED 2026-07-19 (`1cc38e92`, ADR-085 Wave 2):** the Smart Home surface (home.html + home-routes.ts + swarm-apps/home.yaml + its queue-classification entry) is ripped from the kernel and now lives in the store package — surface follow-ups belong there; the home-bot container/registries and the SmartThings/Nest connectors stay core.

---

## Per-user file and storage implementation

### Per-user file space + storage connectors (Dropbox / GitHub / Databricks) — 2026-06-15
- **Why:** swarms now GENERATE files (codex-packer packs, the html5 games, drafts) but there's
  no per-user "home" for them. Users need a place to keep their stuff, and the platform should
  connect to the storage they already own rather than hoard everyone's files.
- **Two parts:**
  1. **Per-user local scratch** — a `user_sub`-keyed store with a quota (~250 MB) for
     OSHAL-generated artifacts (packs, drafts, exports). Same isolation model as the connector
     tokens. **Fixes a current leak:** `packs/` is shared today (any logged-in user can list /
     download / deploy any pack) — packs should move under the user's space.
     - ✅ **Packs leak FIXED (2026-06-15):** `swarm-pack-routes.ts` now scopes EVERY route
       (list/descriptor/download/workflow/deploy) to `packs/<userKey>/` where
       `userKey = sha256(OIDC sub)[:32]`; 401 when unauthenticated. The packer side gets the
       same key via a `.oshal-user-key` workspace file + `OSHAL_USER_KEY` env, written by
       `applyUserScoping` (TS `base-cli-harness-adapter.ts` + JS `user-scoping.js`); codex-packer
       persona writes to `packs/$UKEY/<slug>/`. Key formula verified identical across all 3 sites.
     - ⬜ **Still open:** the GENERAL quota'd file space (250 MB enforcement, upload/download UI,
       drafts/exports beyond packs). The packs subtree now establishes the per-user layout to build on.
  2. **Storage connectors** (reuse the connectors hub: OAuth, AES-GCM per-user tokens, the
     PROVIDERS registry):
     - ✅ **GitHub (DONE 2026-06-15):** live in the hub; OAuth App creds in `.env`, api recreated.
       A code-generating swarm can push output to the user's repo.
     - ✅ **Dropbox (DONE 2026-06-15, awaits creds):** added to `PROVIDERS` — standard OAuth code
       flow with `token_access_type=offline` (refresh token; Dropbox access tokens are ~4h),
       scopes `account_info.read`+`files.metadata/content read/write`, account via
       `/2/users/get_current_account`. Auto-appears in `/list` once `DROPBOX_CLIENT_ID/SECRET`
       (Dropbox App key/secret) are in `.env`. This is the file-space backend per the design principle.
     - **Databricks (later):** fits the enterprise data domain but heavier + niche; defer
       until a specific data-swarm needs it.
- **Design principle:** prefer connecting to the user's OWN storage (Dropbox/GitHub) over storing
  files in OSHAL; keep the local 250 MB only for OSHAL-generated scratch.
- **Crypto isolation (the real security fix — do alongside):** today `oshal_connections` is one
  shared table encrypted with a SINGLE key `SHA256(SESSION_SECRET)` → one key decrypts EVERY
  user's tokens (leak `SESSION_SECRET` = total compromise). Fix = **envelope encryption with a
  per-user DEK**: each user's tokens encrypted with their own random data key; DEKs wrapped by a
  master KEK. No single key decrypts all; scales in the shared DB. Per-user **SQLite vault files**
  (`users/<sub>/vault.db`) are the stronger-isolation option for self-hosted/local. AVOID per-user
  **Postgres DBs** at scale — provisioning/migration/pooling cost outweighs the benefit vs per-user keys.
  - ✅ **BUILT (2026-06-15), gated OFF:** `connector-token-crypto.ts` implements per-user DEK
    envelope encryption (DEK per user, wrapped by `SHA256(SESSION_SECRET)` KEK, stored in
    `oshal_user_deks`). Wired into `connectors-routes.ts` token read/write/refresh/revoke behind
    `OSHAL_ENVELOPE_CRYPTO` (**default off** → byte-identical legacy behavior). `decryptToken` is
    format-aware (`v2:` envelope vs legacy KEK blob) so the flag flips without stranding tokens;
    existing tokens upgrade on next write. 4 unit tests pass (`tests/connector-token-crypto.spec.ts`):
    flag on/off, per-user isolation (user B can't read user A), legacy-compat.
  - ⬜ **To activate:** rebuild image, set `OSHAL_ENVELOPE_CRYPTO=true`, live-verify Gmail/connector
    reads still work, confirm new writes are `v2:`-prefixed. (Left off because it couldn't be
    live-verified without disrupting in-flight Facebook/connector testing.) SQLite-vault variant
    still a future option for stronger self-hosted isolation.
- **Done when:** a user has an isolated file space (quota-enforced, packs live there per-user),
  GitHub + Dropbox connectors exist in the hub, and a deployed swarm can write its output to the
  user's connected GitHub/Dropbox or their local space.
  - Progress: packs-per-user ✅, GitHub ✅, Dropbox ✅, DEK crypto ✅ (gated off),
    **file space ✅** (`/api/files`, Dropbox-backed, verified), **storage targets ✅**
    ([ADR-041](../../adr/041-per-user-storage-targets.md): Code/Files buckets → Dropbox/GitHub/
    OSHAL-local, settings page `/api/storage`, `saveContent` resolver, OSHAL-local 250 MB quota),
    **Storage + Presentations apps surfaced ✅** (catalog tiles). Presentations generates real
    .pptx (pptxgenjs, Presenton replacement) → saves to the Files target.
    Remaining: GitHub-as-target for large/tree code (build-swarm push, not contents API); the
    swarm→storage write path for build outputs; the data-management bot (below).

**Verified 2026-07-19:** MOSTLY DONE — 250MB quota enforced (storage-target.ts:49), upload/download work, GitHub/Dropbox/local write+delete all in place; only the large-tree multi-file git push remains.

**Verified 2026-07-19 (completion-day):** RESOLVED — supersedes the MOSTLY-DONE stamp above. `ab3a961a` added `pushTree` to `storage-target.ts` (+ guard `tests/unit/storage-target-tree-push.spec.ts`): a whole file tree is pushed to GitHub as ONE commit via the git Trees/Commits API (blobs → tree → commit → ref update), closing the "GitHub-as-target for large/tree code (build-swarm push, not the contents API)" residual. The swarm→storage write path for build outputs and the data-management bot remain separate items above.

---

## Jarvis hand-off implementation history

## Jarvis assistant — two-tier hand-off (2026-06-20)
- **Confirm complex auto-dispatch ✅** — verified by inspection: `QueueManagerService` runs a poll loop (~15s dev / 60s prod) that claims `status:'approved'` tickets into the swarm pipeline, with free slots (`available:5`). Tier-2 files exactly that, so complex tasks auto-dispatch. (Default ticket status is `backlog`, which the loop ignores — so Tier-1 records never double-execute.)
- **Read & understand finished work ✅** — when a complex/swarm task completes, `summarizeComplexTask()` runs once in the background: Jarvis READS the deliverable and writes a summary in his own voice (outcome + notable + where the full thing is) into `jarvis_tasks.result`; `/tasks` triggers it (guarded by a `summarizing` status) and shows "Reading the results…" until it lands. (Code-verified; full complex→summarize lifecycle needs a browser `/tasks` confirm.)
- **Rich output ✅** — surface renderer now does images + links (already did Mermaid graphs + tables); persona told to use tables/diagrams/images when they help. Live-tested: a compare request returned a Markdown table **and** a Mermaid flowchart.
- **Short-answer drop ✅** — response extraction no longer requires >20 chars (dropped "Paris"/"Yes" to "Execution completed."); now any non-empty completion/text. Live-verified.
- **Tier-1 visibility tickets ✅** — removed entirely; they only added a never-moving `backlog` row to the Command Center. Tier-1 work is tracked solely by the durable `jarvis_tasks` row + Tasks list.
- **Email task-complete notification ⬜** — user is logged in (OIDC email available); needs a mail transport (SMTP/SendGrid or send via the connected Gmail). Twilio SMS later when available. **Done = a finished task emails the user.**
- **Scroll-to-assistant ⬜** — confirm the cockpit doesn't jump to the (now-hidden) chat panel on the Jarvis view after a hard refresh; pin to the assistant if it still does. **Needs a live check.**
- **Decision turn grinds on "build" requests ⚠️ (backstop in place; proper fix open)** — LIVE TEST (2026-06-20): chat → inline (6.6s) ✓; simple tool ask → hand-off, no grind (16s) ✓; but **"build me a bot" IGNORED the hand-off rule and built it inline — 8.6 min, 1.87M tokens.** The persona is model-judgment, not a guarantee. Backstop shipped: `/ask` races the decision against `DECISION_TIMEOUT_MS` (75s) and on timeout auto-files a complex swarm ticket + acks "handed to the team" — so the user never waits >75s. **Open (proper fix): a lightweight decision LLM** (Haven-style direct completion, tool-less) for the decide step instead of the codex agentic bot — eliminates the grind + the wasted tokens (today the timed-out turn still finishes server-side AND the swarm rebuilds it = double work). **Done = a "build" request acks in <20s and is built once, by the swarm.**
- **Plan B: richer swarm fan-out ⬜** — optional, beyond auto-dispatch: explicit decomposition hints from Jarvis to the PM.

**Verified 2026-07-19:** OPEN — the decide-timeout→swarm backstop exists; task-complete email, the dedicated decision-LLM, and richer Plan B fan-out remain open.

---

## GUC pool identity implementation

### GUC pool identity — close the remaining fail-open-to-operator proof
- **Context:** `src/shared/services/database/guc-pool.ts` fail-opens — a DB access with no request
  identity in AsyncLocalStorage (schedulers, queue workers, bots) is stamped `is_operator='on'`,
  i.e. full cross-tenant visibility, by design (availability over strictness). Isolation therefore
  depends on every user-facing path establishing caller identity before querying; `verify:rls`
  only tests explicitly GUC-stamped principals and never proves this invariant holds across
  runtime paths. Flagged by adversarial verification 2026-07-05 as the residual isolation caveat
  for a category whose whole thesis is "isolation is the wedge".
- **Investigation 2026-07-10 (validated against code):** the invariant MOSTLY held already — the pool
  is GUC-wrapped at all 3 build sites, anonymous requests stamp `{sub:'', is_operator:'off'}` (deny,
  NOT fail-open), and a GLOBAL identity middleware covers every route mounted after it. The genuine
  residual was NARROW: **three route groups mounted BEFORE the identity middleware** (`server.ts`):
  `audit-capture`, `tv-pairing`, `jarvis-voice` ran with an empty ALS → `is_operator='on'`, and
  `tv-pairing-routes.ts` actually queries `tv_token_revocations` (a user-scoped RLS table) — no leak
  today only because of an explicit `WHERE user_sub=$1`, but RLS-bypassed.
- **Fixed:**
  1. **Concrete gap closed** — hoisted the RLS request-identity middleware in `server.ts` to
     immediately after audit-capture and BEFORE the tv-pairing / jarvis-voice route mounts, so every
     `/api` route now runs under an established identity. Verified safe: jarvis-voice has no pool
     queries; the tv-pairing revocation READ runs in the TV-token auth middleware (still pre-identity,
     operator — correct); the revoke WRITE is on an authed route writing the caller's OWN row (RLS
     owner policy allows). Full unit suite 1190/1190 green after the reorder.
  2. **Static regression guard** — [tests/unit/identity-middleware-ordering.spec.ts](../../../tests/unit/identity-middleware-ordering.spec.ts)
     parses `server.ts` and asserts the identity middleware mounts after auth+audit-capture and BEFORE
     tv-pairing/jarvis-voice. Would have FAILED before the hoist; stops the ordering from regressing.
  3. **Runtime auditability** — `OSHAL_DB_GUC_STRICT` ([guc-pool.ts](../../../src/shared/services/database/guc-pool.ts),
     [tests/unit/guc-pool-strict-identity.spec.ts](../../../tests/unit/guc-pool-strict-identity.spec.ts)):
     `warn` logs each unique fail-open call site once (catches dynamically-mounted app-store/ADR-085
     routes a static parse can't); `deny` stamps anonymous non-operator there. Default `off` (unchanged).
- **Still open (deferred, dangerous):** flipping the identity-less DEFAULT from operator→deny is NOT
  overnight-safe — schedulers/queue-manager/bot runtimes depend on fail-open-to-operator, and
  `runWithoutRequestIdentity` still yields `undefined` (no positive system marker). Closing it fully
  needs a `runWithSystemIdentity` sentinel + migrating every background caller onto it, then a proof
  that `deny` starves nothing. Interim: run `OSHAL_DB_GUC_STRICT=warn` in a canary to enumerate the
  fail-open call sites, confirm none are user-facing, THEN plan the migration.
- **Done when (remaining):** an explicit system-context marker replaces bare-`undefined`, every
  background caller uses it, and `deny` can be the default with a two-tenant proof that no user-facing
  route reaches user-scoped tables without identity AND no background path is starved.

**Verified 2026-07-19:** remaining clause OPEN — `OSHAL_DB_GUC_STRICT` still defaults 'off', not deny; background callers not fully migrated.

**Verified 2026-07-19 (completion-day):** the remaining clause is RESOLVED **in code** — supersedes the OPEN stamp above. The positive SYSTEM identity sentinel landed (`491c3279`, `runWithSystemIdentity`) and every background caller was migrated onto it across five commits — server.ts-resident boot seams `281f5f19`, scheduler/queue/worker loops `4a536c1c`, cron/watchdog RLS-table writers `8fbb5298`, the six route crons `63e44a65`, bot-node execution paths `f693da5f` — with `runWithoutRequestIdentity` deleted (only systemized callers remain). A static seam-coverage guard `c9d32272` asserts every listed background runner references the sentinel, home stays owner-scoped, and no bare background caller regresses. `47732ac2` then flipped the `OSHAL_DB_GUC_STRICT` **code default off→deny** (unknown→deny, fail-closed), with `RLS-RUNBOOK.md` + `.env.example` documenting the warn-first rollout. **Deliberately NOT wrapped (documented):** `runRuntimeSchemaBootstrap`/verification-scheduler (tool tables + boot DDL, not owner-RLS) and the bot-node/extensions-swarm boot (public-read + DDL). **Live-stack nuance:** the deployed stack is pinned `OSHAL_DB_GUC_STRICT=warn` (compose `5b00ab19`, `:-warn` default) for a rollout soak — deny promotion is gated on the warn audit being clean across a real window (see the new "guc-strict warn→deny promotion" follow-up below). Break-glass on starvation: `OSHAL_DB_GUC_STRICT=off`.

---

## Trading venue sizing correction

## Trading: the LIVE book sizes off Alpaca's IEX feed while it executes at Schwab (2026-07-12)

Found while closing the extended-hours defect. The order-*pricing* path correctly uses
`getMarketData(mode, sub)` — Schwab for live, Alpaca for paper (`trading-routes.ts:148`). But the
autopilot's **sizing** calls import the raw `latestPrice` from `market-data.ts`, which is hardwired to
**Alpaca IEX** regardless of book (`trading-schedule-dispatch.ts:395` core top-up, `:530` rotation
`priceOf`). So a LIVE position's share count is computed from a *different broker's* feed — one that
carries ~0.7% of the consolidated tape.

**Severity: LOW, not urgent.** It feeds `qty = floor(notional / px)` and the orders are RTH *market*
orders, so they fill at the true market price regardless; the error is in the share count only
(median divergence 5.6 bps → position ~0.06% off target; worst measured 54 bps → 0.54% off). Nothing
mis-executes. `:856` is the pop-catcher leg, which is disabled.

**Why it still matters:** (1) it is a silent-degradation path — if Alpaca creds were ever absent or
expired for a live-only user, `latestPrice` returns null and the core top-up simply *skips the buy*
while rotation falls back to the last daily close, with no error; (2) it is architecturally wrong —
live should size off the book it trades in.

- **Done when:** the sizing calls route through `getMarketData(mode, sub)` like the pricing path does,
  and a live-only configuration (no Alpaca creds) is proven to size correctly off Schwab.

**Verified 2026-07-19:** OPEN — sizing at trading-schedule-dispatch.ts:545 (core) and :750/:864 (rotation priceOf) still call raw `latestPrice`, not `getMarketData(mode, sub)`.

**Verified 2026-07-19 (completion-day):** RESOLVED by `82e40f1b` — supersedes the OPEN stamp above: new exported `sizingPrice(mode, sub, symbol, fallbackClose?)` routes all three sizing sites (ensureCore top-up + both rotation `priceOf` closures) through `getMarketData(mode, sub)`; live is FAIL-CLOSED — a name the executing venue can't price is skipped for that fire with a warn, never silently sized off the IEX tick — and paper is byte-identical (Alpaca first, rotation daily-close fallback kept). Guard: `tests/unit/trading-sizing-venue.spec.ts` (9) proves a poisoned raw `latestPrice` is never consulted live, end-to-end through ensureCore. The done-when's "live-only config proven off Schwab" clause is proven at spec level, not by a live fire. Strategy-log row appended per the mandatory-row rule.

---

## Gap-list cockpit surface implementation

### Cockpit surfaces for the gap-list shared services (budgets / notify / DLQ / export)
- **Reason:** budgets, notification prefs, queue DLQ, and data export/delete shipped 2026-07-15 with
  auth-gated routes but no surfaces — only global-search and run-trace got one.
- **Done when:** each has a bind-mounted cockpit tool surface registered like `tool-global-search` /
  `tool-run-trace` — budgets: view/set caps + breach events; notify: per-topic channel + quiet hours; DLQ:
  operator quarantine list + requeue; export: request export / two-step delete. Operator-scoped where appropriate.

**Verified 2026-07-19:** OPEN — no tool-budgets/notify/dlq/export surfaces (DLQ has an operator surface, so partial there).

**DONE — corrected 2026-08-01 (wave17-cockpit):** the done-when was already MET and this entry was
stale. `5d5db19` (PR #24) shipped all four bind-mounted tool surfaces —
`src/pages/cockpit/tools/{budgets,notify,dlq,my-data}.html` — registered in
`src/pages/cockpit/js/components/RibbonNav.js` (Budgets / Notifications / Dead Letters / My Data)
and served by the cockpit's own `requiresAuth` `express.static` mount, so they need no Express route
and no image rebuild. Dead Letters is operator-only in the rail AND server-side. Budgets is
read-only over `/api/budgets` + `/api/budgets/spend` with an operator-wide `/api/budgets/state`
view; notify does per-topic channel prefs + a test send; DLQ does list + requeue + JSON export;
my-data does export + the two-step delete. What was genuinely missing was a GUARD for the DLQ
surface specifically — added now as `tests/unit/dlq-surface.spec.ts`
(**dlq-surface-shows-real-entries**): drives the real router over a stubbed `oshal_queue_dlq`,
asserts what/why/when/how-many reach the payload, that a non-operator is refused BEFORE the store is
read, that a malformed id never reaches SQL, and — the anti-drift half — that `dlq.html` renders
every field the route's own response carries and offers NO action the router does not expose.

**Verified 2026-07-19 (completion-day):** PARTIAL — the operator DATA rails now exist (routes, not cockpit surfaces): `GET /api/budgets/state` (`3173f104`, requiresOperator — every cap + trailing-window spend + recent `oshal_budget_events`), `POST /api/notify/operator` (`07a9aef0`, requiresOperator + `confirm:true`→428, fails LOUD 502 when the transport skips so a monitoring operator is never fooled by a silent no-op), and `GET /api/queue/dlq/export` (`bf738100`, requiresOperator — downloadable JSON over the SAME `DeadLetterService.listEntries`, not a second surface). Each is operator-gated inside an already-`requiresAuth` mount (route-auth inventory unchanged, 5/5 green) and ships its guard spec. The entry's done-when — bind-mounted **cockpit tool surfaces** (like `tool-global-search`/`tool-run-trace`) — stays OPEN; these routes are the accountable data layer such a surface would consume. DLQ now has list + requeue + export.

---

## Connector action audit and approval UX

### Connector write-actions: marketplace surfacing + audit read endpoint + interactive-approval UX
- **Reason:** the actions tier + `connector_action_audit` shipped 2026-07-15, but actions are not surfaced in
  the connector marketplace, there is no audit read endpoint, and the interactive-approval path has no UX.
- **Done when:** the marketplace shows which connectors expose actions + their risk level; an auth-gated GET
  reads the caller's `connector_action_audit`; a 428-style interactive prompt lets a user approve/deny a
  pending high-risk action from the surface.

**Verified 2026-07-19:** PARTIAL — actions + riskLevel are surfaced in the marketplace and the 428 rail exists (connector-action-routes.ts:134); the `connector_action_audit` read endpoint + approve/deny UX remain open.

**2026-08-01 — DONE.** (1) **Audit read:** `GET /api/connectors/actions/audit`
(routes/connector-action-audit.ts) returns the CALLER's own trail with connector/status filters, a
per-connector rollup and a page size capped at 200. `user_sub` is bound from the OIDC session into
the predicate and can never come from request data; there is deliberately no cross-user variant (that
is a different decision with a different gate). It mounts on the always-on marketplace router rather
than inside `CONNECTOR_SPEC_ROUTES`, because reading what already happened must not depend on whether
writes are currently switched on — and a deployment that never applied migration 083 gets an honest
empty trail instead of a 500. (2) **428 UX:**
`src/pages/cockpit/js/views/ConnectorActionRunner.js`, opened from the Discover card of any connector
that declares write actions (the entry now carries `writeActions` — the declared `actions:` block,
which the resource-derived `actions` never held). Run → the refusal is rendered in full (connector,
action, risk, the exact params, "nothing has been sent") → Approve re-sends the IDENTICAL params plus
the confirm flag, or Deny closes it. The panel never confirms on a first attempt. **Design note,
deliberate:** the rail is STATELESS and the audit keeps only a params hash, so "approve" means the
attempt in front of you — a past 428 cannot be replayed from the trail. Replaying one would need raw
payload retention, which is exactly what the hash exists to avoid; do not add it without an ADR.
(3) **The bespoke write:** LinkedIn publish now runs through the executor (see the entry above).
Guards: `tests/unit/connectors/connector-write-actions.spec.ts`,
`tests/unit/connectors/connector-action-confirm-ux.spec.ts`.

---

## Global search deep links and indexes

### Global search: deep-link contract + pg_trgm indexes
- **Reason:** results link into surfaces via ad-hoc URLs and rank via an ILIKE+recency fallback; no trigram
  indexes exist.
- **Done when:** a documented per-source deep-link contract (each adapter returns a canonical surface URL) and
  pg_trgm indexes on the searched text columns, with a measured before/after latency recorded.

**Verified 2026-07-19:** OPEN — no pg_trgm migration, no canonical deep-link contract.

**DONE 2026-08-01 (wave17-cockpit):** both clauses shipped.
1. **Deep-link contract** — `src/features/global-search/services/deep-link.ts` is now the ONLY
   place a hit's URL is minted. `SearchHit` gained a required `kind`
   (ticket/chat/app/connector/bot/doc/entity); `deepLinkFor(kind, id)` is exhaustive over the union
   via a `never` check, so a new kind without a builder is a COMPILE error rather than an unlinked
   row found in production. Two adapters used to return a bare surface path (`'/cockpit/'`,
   `'/chat'`) — the right screen, the wrong row — and two returned an unexplained `null`; both
   are gone. Unlinked kinds are now declared in `NO_SURFACE_REASON` **with the reason**, which
   `GET /api/search/sources` publishes as `{name, kind, deepLink, noSurfaceReason}` so the surface
   explains an unlinked hit from the API instead of from its own copy of the rules. The cockpit end
   of the contract shipped too: `?ticket=` in `src/pages/cockpit/js/app.js` (seeds
   `pendingTicketSelection` → `TicketView.focusTicket`) and `?connector=` in
   `src/api/utilities.html` (scrolls + outlines the matching card).
2. **Three new typed adapters** — `apps`, `bots`, `connectors`, each owning its own visibility
   rule IN the adapter (apps mirror `isVisibleToCaller`; bots apply ADR-087 `accessRoles` through
   the shared `roleCanAccess` at the caller's effective role; connectors pin `user_sub = $1` and
   never name a token column). The app/bot listers are injected UNFILTERED from the route on
   purpose — pre-narrowing in `SwarmAppService` would make two filters where only one is auditable.
3. **`scripts/migrations/103-global-search-trgm.sql`** — `pg_trgm` GIN indexes on the columns the
   adapters actually ILIKE, plus `(owner_sub, updated_at DESC)` composites. Idempotent,
   `to_regclass`-guarded, no `CONCURRENTLY` (the runner wraps each migration in one transaction).
4. **Measured, and the measurement changed the story.**
   `scripts/measure-global-search-latency.js` benchmarks in a throwaway database it creates and
   drops — it never touches a production index. Medians:
   chat **215.32 → 5.41 ms (39.8×)** at 100k rows/50 owners; tickets **154.45 → 1.39 ms
   (111.5×)** at 100k rows/single owner; connectors 7.70 → 2.30 ms (3.3×) single-owner.
   Honest reading, recorded in the doc: the **trigram** index is decisive only on `chat_messages`
   (no owner column → whole-table text scan); the tickets win is the **composite btree**, not the
   trigram (`EXPLAIN` shows no trigram in the tickets plan in any scenario); and two cells are
   mildly NEGATIVE (−3 ms on sub-8 ms operations) where the planner picks the index on a small
   table — kept because the shape that regresses is the shape that was already fast.
   Full table + reproduce commands: [global-search-deep-link-contract.md](../../architecture/global-search-deep-link-contract.md).
   Guards: `tests/unit/global-search-deep-links.spec.ts` —
   **search-results-carry-resolvable-deeplinks** (each link's parameter asserted against the REAL
   surface source that reads it, so deleting a handler goes red) and **search-is-caller-scoped**
   (a second user's person-scoped app, an operator-only bot, and another sub's connections all
   proven absent; the SQL adapters assert the bound parameter AND the owner predicate, not a
   substring).

---

## User-data Chroma and Arango exporters

### `/api/me` export gaps: Chroma + Arango exporters
- **Reason:** the data-lifecycle exporter registry covers the Postgres stores; ChromaDB (RAG / swarm memory)
  and ArangoDB (graph tier) have none. Currently disclosed in-product via `KNOWN_EXPORT_GAPS`.
- **Done when:** exporters exist for the caller's Chroma collections and per-person Arango graph (or a
  documented decision that they are out of scope), and `KNOWN_EXPORT_GAPS` shrinks accordingly.

**Verified 2026-07-19:** OPEN — `KNOWN_EXPORT_GAPS` unchanged (default-exporters.ts:311).

**Verified 2026-07-19 (completion-day):** PARTIAL — `8274294e` landed real exporters: `chroma-exporter.ts` (owner_sub-metadata-scoped export+delete across collections, absent-engine no-op) + `arango-person-graph-exporter.ts` (dump + drop the caller's isolated per-sub DB via GraphConnector, no-op without ARANGO_URL), and reshaped `KNOWN_EXPORT_GAPS` to the honest residual (non-attributed Chroma content). **Wiring defect found while verifying:** both builders are imported into default-exporters.ts (:29–30) but `buildAllExporters` (:354) never appends them to the returned registry — so `/api/me` export/delete does NOT actually run either exporter, while the trimmed gap list no longer discloses it. Remaining: append both builders to the `buildAllExporters` return + a guard spec asserting they appear in its output.

**Verified 2026-07-19 (completion-day):** the wiring defect is FIXED by `ee3a386c` — `buildAllExporters` now appends `buildChromaExporter()` + `buildArangoPersonGraphExporter()` to the returned registry, so `/api/me` export/delete actually runs both. Guard `tests/unit/data-lifecycle.spec.ts` extended (+25 lines) to assert both appear in `buildAllExporters`' output. This entry is now RESOLVED for the Chroma + Arango exporters; `KNOWN_EXPORT_GAPS` discloses only the honest residual (non-attributed Chroma content).

---

## Run-trace token and duration instrumentation

### Run trace: per-LLM-call tokens + durations on llm-call spans
- **Reason:** `oshal_cost_events` carries no per-event token split or duration, so `TraceService` deliberately
  omits `tokens`/`durationMs` on llm-call spans rather than fabricate them (real tokens live on the bot span).
- **Done when:** an additive migration adds `input_tokens`/`output_tokens`/`duration_ms` to
  `oshal_cost_events`, `CostTrackingService.recordCost`/`appendCostLedgerRow` write them, and `TraceService`
  populates the spans. Purely additive — the trace already leaves those fields undefined.

**Verified 2026-07-19:** OPEN — `oshal_cost_events` still has only cost_usd (migration 078); TraceService still omits tokens/durations (trace-service.ts:264).

**Verified 2026-07-19 (completion-day):** RESOLVED by `b2a2cc94` — supersedes the OPEN stamp above: migration `090-cost-event-tokens-duration.sql` adds nullable `input_tokens`/`output_tokens`/`duration_ms` (NULL = "producer did not know", never 0); `appendCostLedgerRow` writes them with a 42703 fallback to the legacy 6-column insert so a pre-090 DB never loses the cost row; producers (llm-execution-handler, bot-node-execution-handler, storyboard-image-cost, vision-describe) thread `CostEvent.durationMs`; `TraceService.mapLlmSpan` populates llm-call spans when the row carries them and `loadLlmSpans` selects `e.*` for pre-090 compat. Guard: `tests/unit/run-trace.spec.ts` round-trip + null-safe cases.

---

## Jarvis ambient decomposition

### Decompose `src/api/jarvis-ambient.js` (983 code lines, past the 800 propose-decomposition threshold)

- **Context:** The ambient browser client crossed 800 code lines during the 07-09 feature burst and
  sits at 983 after the 2026-07-17 hypothesis-coalescing fix (`9c80c8d6`) — under the 1000 hard cap
  but adding anything further first requires this split. Natural seams already exist: pure helpers
  (settings normalize/parse, `parseWakeCommand`, `coalescePendingSegment`), the recognition/queue
  engine (`AmbientClient` capture + flush + speaker-outcome holds), and the settings-panel/transcript
  UI (`htmlTemplate`, modal focus/inert, sync copy).
- **Done when:** jarvis-ambient.js splits into ≤3 sibling assets (e.g. `jarvis-ambient-core.js` pure
  helpers, `jarvis-ambient-ui.js` template+panel, thin composer) each under 800 code lines, loaded in
  order by jarvis.html exactly like the existing jarvis-speakers/jarvis-speaker-capture siblings; the
  `JarvisAmbient` public API (`mount/unmount/getInstance/parseWakeCommand/coalescePendingSegment`)
  is unchanged; `tests/unit/jarvis-ambient-client.spec.ts` + ambient/speaker wiring specs pass
  unmodified (they assert on source content — update paths only); compose bind-mounts updated for
  the new file names alongside the existing per-file jarvis mounts.

**Verified 2026-07-19:** OPEN (worse) — now ~1044 code lines (grew from 983, past the hard cap), still no siblings.

**Verified 2026-07-19 (completion-day):** RESOLVED by `0f71b125` — supersedes the OPEN stamp above: decomposed into a slim coordinator (jarvis-ambient.js, ~373 code lines) + siblings jarvis-ambient-core.js (~205) / -ui.js (~253) / -recognition.js (~214), all well under 800; jarvis.html loads them in dependency order, jarvis-routes.ts serves the new assets, and the per-file compose bind-mounts landed in `1aefd92a`. `JarvisAmbient` public API unchanged; the ambient/speaker specs updated paths only. (Landed as 3 siblings + coordinator rather than the entry's "≤3 siblings" example shape — same seams, one file more.)

---

## Skill-profile carrier and rollout

### Skill profiles — interactive + inline-concierge injection (ADR-090 addendum, follow-up)

- **Status:** The core primitive is **BUILT 2026-07-17** (ADR-090 addendum): `skillProfiles:`
  manifest field → a closed capability registry (`summarize`, separate from `KERNEL_SKILLS`) →
  fail-closed loader validation → shared registry written on activate / cleared on deactivate →
  controller-side resolution + `composeSkillProfilePrompt` at `dispatchManifestWorkerTicket`.
  Two consumers prove it: little-monsters (`class-notes`, ticketType `education`) and
  email-summarizer (`email-digest`, ticketType `email-summarizer`). Unit spec covers the enum,
  fail-closed validation, register→resolve→teardown, and the two-profile composition proof.
- **What's live now:** two injection sites, one per shipped consumer's real path — the
  manifest-worker **ticket** dispatch (`dispatchManifestWorkerTicket`, by ticketType → LM education)
  and the email **interactive** chokepoint (`email-routes.ts runOnBot('summary')`, by app name →
  email-summarizer, which ships no schedules). Both are ADR-036-safe.
- **What's left (this entry):** a GENERAL carrier so ANY app's `BotNodeClient.execute` /
  inline-concierge (`executeBotOrInline` → `processMessage`) call carries its profile without the app
  hand-wiring its own chokepoint the way email does.
- **Done when:** a `BotNodeRequest.pattern` (or equivalent) carrier is threaded
  `execute → /api/swarm-execute → envelope.payload → bot-node-execution-handler` and injected in
  BOTH the layered (non-direct) and verbatim (direct) prompt branches; the inline path weaves the
  resolved pattern into `request.text` before `processMessage`; resolution keyed by the calling app
  (`resolveSkillProfileByApp`). A unit test proves a generic interactive summarize call carries the
  profile. Optional: more capabilities beyond `summarize` as they earn a declarable pattern.
- **Adjacent framework gap (optional, not owed by this feature):** a manifest edit that flips an
  app from `active` to `inactive` via `POST /api/swarm/apps/load` re-runs `loadApp` but calls
  neither `activate()` nor `deactivate()`, so the app reads `status='inactive'` while its
  bots/workflow/tools/schedules/guest-tier/skill-profiles stay live until a real toggle-off. Central
  fix: in `loadApp`, `if (record.status==='active') activate(record) else deactivate(record)`
  (deactivate is idempotent, so the boot path stays a safe no-op). Closes it for all activate-scoped
  resources at once. Surfaced by the skill-profiles adversarial review; pre-existing + framework-wide.

**Verified 2026-07-19:** OPEN — `resolveSkillProfileByApp` is still email-only; no `pattern` field on BotNodeClient.

**Verified 2026-07-19 (completion-day):** RESOLVED by `c737c71c` — supersedes the OPEN stamp above: `BotNodeRequest` gains optional `app`/`capability`/`pattern` (backward-compatible); `executeBotOrInline` resolves the calling app's profile ONCE controller-side (bot holds no registry, ADR-036) — the inline path weaves the block into the text before `processMessage`, the remote path sets `request.pattern` so it rides `envelope.payload` to the bot node; `bot-node-execution-handler` appends `payload.pattern` in BOTH the verbatim (direct) and LAYERED prompt branches (the layered branch never reads `payload.text`, which is exactly why pre-composing into text could never reach it). Guard: `tests/unit/skill-profile-carrier.spec.ts` (6 cases, fails against pre-change code). The adjacent `loadApp` activate/deactivate framework gap was deliberately NOT touched — still open.

**Verified 2026-08-01:** the adjacent `loadApp` activate/deactivate framework gap is **CLOSED** —
`loadApp` now runs the entry's central fix verbatim: the resulting record's status drives
`activate(record)` / `deactivate(record)`, so a manifest edit flipping `active → inactive` via
`POST /api/swarm/apps/load` actually tears down bots/workflow/tools/schedules/guest-tier/
skill-profiles instead of leaving them live behind an `inactive` row. `deactivate()` is
idempotent, so the boot auto-load of an already-inactive app stays a safe no-op (the repository's
status precedence — operator-applied inactive survives routine reloads — is unchanged). Guard:
`tests/unit/swarm-app-status-flip.spec.ts` (asserts real teardown CALLS — bot-registry retraction,
workflow deregistration, agent status writes — not substrings; red against pre-fix code).

---

## ADR-100 enable-gate implementation

### ADR-100 enable gate — run the remaining fresh-database trigger check

- **DONE + ENABLED 2026-07-18** (`OSHAL_AMBIENT_ENRICH=1`, deployed): (1) ✅ **Six-surface disclosure
  rewrite** shipped (`66d78ecc`) — panel no longer claims "only transcript text… are kept"; discloses
  the deletable per-person inferences + decline-purges + own-voice-implicit + minors-not-modeled;
  README/site/architecture match; pinned test asserts the new copy and that the old line is gone.
  (2b) ✅ **Consent read/write routes** — `GET/POST /api/jarvis/ambient/person/consents` +
  `listPersonConsentStatus` (live-verified SQL); consent is now operable via API. (3) ✅ **Nightly
  pure-SQL retention pass** — `purgeExpiredPersonModelData` bounds `ambient_person_topic_daily` +
  `ambient_person_relations` to each owner's `transcript_retention_days`, always-on runtime
  (`startPersonModelMaintenanceRuntime`), no LLM.
- **DONE 2026-07-18 (`6342a53e`):**
  - (2a) ✅ **Graphical consent panel** — `src/api/jarvis-person-consent.js`, a self-contained sibling
    loaded by `jarvis.html`. It **self-wires** its own "Per-person insights" launcher next to Manage
    voices (via a MutationObserver on `[data-ja-speakers-open]`), so it needed NO edits to the over-cap
    `jarvis-speakers.js`/`jarvis-ambient.js`. Per-heard-voice Model / Don't model / Minor over the live
    GET/POST `/api/jarvis/ambient/person/consents`; declining purges (server path). Consumes the
    framework `--ja-*` theme read-only. Allowlisted in `JARVIS_CLIENT_ASSETS` + hot-swap bind-mount +
    surface mount; covered by the `jarvis-speaker-wiring` spec. Live-verified: asset serves + endpoint 200.
  - (4) ✅ **Recall-guard dispatch** — implemented as a DETERMINISTIC answer in `/ask` (see the
    "in-Jarvis recall hook" entry above), NOT a dispatch to the `ambient-analyst` LLM. A recall is a
    literal transcript read, so answering it deterministically (no model turn) is stronger than routing
    it to a bot. Live-proven curry→32.
- **REMAINING:**
  - (5) Confirm on a FRESH DB that the UPDATE-only consent trigger coexists with profile-delete CASCADE
    and `/api/me` delete. (Not yet done — needs a throwaway DB with an enrolled profile + consent row.)
- **Note:** the rollup re-aggregate ("idempotent rebuild from enrichment rows") is a Phase-3 concern
  (semantic recall + rebuild); the retention purge above is the Phase-2 bound.

---

## Presentron renderer implementation

## Re-point the `presentron` chat tool at the real deck renderer (ADR-103 deferred item)

- **What:** The `presentron` chat tool (`tool-executor-service.ts` → `PresentronIntegrationService`)
  still calls the retired Presentron container's endpoint, so a chat-driven "make me a presentation"
  errors against a dead host — and its any-bot sibling `PresentationService.js` returns MOCK data on
  failure (standing no-mock violation). The real renderer (`renderPptx`, ten themes / twenty layouts)
  lives one feature slice over, but FSD bans the sibling import — the clean path is HTTP-to-self
  against `/api/presentations/sections/pptx` with service-secret auth, which means the presentations
  router must accept `X-Service-Secret` (an authz change that must not ride a feature commit).
- **Done when:** (1) a `presentron` tool call renders a real themed .pptx saved under the CALLING
  user's store (sub threaded through, cost attributed); (2) `PresentronIntegrationService`, the
  `readPresentronRuntimeSettings` plumbing, and the legacy `/api/presentations` Presentron mount are
  deleted; (3) the any-bot `PresentationService.js` mock fallback is removed or the file retired;
  (4) a chat e2e proves the tool path against the noop provider.

**Verified 2026-07-19:** OPEN — tool-executor-service.ts:178 still calls the Presentron sidecar, not the in-repo renderer; the any-bot PresentationService.js mock is still present.

**Verified 2026-07-19 (completion-day):** RESOLVED — supersedes the OPEN stamp above. `2d908649` re-pointed `handlePresentron` at the in-repo deck engine (`@/features/presentation-generation` `renderPptx`, ten themes / twenty layouts) — it renders a real themed .pptx into the task workspace, never mock, no dead-host dependency (done-when 1), and deleted the any-bot `PresentationService.js` mock fallback (done-when 3). The dead HTTP sidecar plumbing was then retired: `69ef734e` unwired the `/api/presentations` sidecar mount + the `ToolType.PRESENTRON` healthcheck branch, and `c3f52931` deleted the orphaned modules — `PresentronIntegrationService`, `presentation-routes.ts`, and the `readPresentronRuntimeSettings`/`PresentronIntegrationConfig`/`PresentronIntegrationConfigSchema` plumbing (done-when 2). Guard `tests/unit/presentron-in-repo-renderer.spec.ts` asserts both sidecar modules are absent. **Kept live (verified — NOT the sidecar):** the separate `presentronServiceConfig`→`presentron-mcp` MCP path + `/api/config/presentron`. Remaining: done-when (4) a chat e2e proving the tool path against noop; and the deferred cockpit/chat FRONTEND still fetches the now-removed `/api/presentations/{health,generate}` (a vestigial Presentron modal — its own follow-up, tracked in the COLLABORATE thread).

---

## Jarvis media parsing implementation

## Jarvis media input — PDF/Word document extraction + richer vision (ADR-110 follow-ups)

Jarvis media input shipped 2026-07-18 ([ADR-110](../../adr/110-jarvis-media-input-vision-as-transcription.md)):
attach a photo (phone camera via `<input capture>` or upload) or a text document when prompting Jarvis,
and it *sees* the photo — image → text via `POST /api/vision/describe` (the visual analog of
`/api/voice/transcribe`) → the Codex brain. 19 tests green; see
docs/evidence/jarvis-media-2026-07-18.md. Slice 1 handles images
fully and **text-based** documents. These extend it:

- **PDF / Word (binary) document extraction.** Slice 1 reads only text files client-side; the repo has
  NO binary extractor (RAG upload does naive `buffer.toString('utf-8')`). Add a real server-side
  extractor (pdf/docx → text) behind a `/api/vision/read-doc` (or extend the RAG ingest path),
  returning a bounded excerpt for the prompt and optionally ingesting into the owner's private RAG
  collection so Jarvis's rag tool can pull more than the inline excerpt.
  - **Done when:** attaching a PDF (or .docx) to a Jarvis prompt lets Jarvis answer questions about its
    contents in a browser, with cost recorded and the caller's owner-scope enforced on any ingest.
- **Per-image labeled descriptions.** Multiple attached images are currently described in one combined
  pass. Describe each separately so Jarvis can refer to "the first photo" vs "the second".
  - **Done when:** two attached photos produce two labeled description sections in the prompt block.
- **Live deploy (guard-deferred 2026-07-18).** Code is on `main`, typechecked, 19 tests; the docker
  rebuild+recreate was blocked by an in-flight career scrape. Rides the next rebuild-from-HEAD;
  `OPENROUTER_API_KEY` is already set live.
  - **Done when:** the **+ Add** control on `?app=jarvis` takes a photo on a phone and Jarvis answers
    about it in a browser on the deployed api.

**Verified 2026-07-19:** PARTIAL — image describe + text docs are shipped AND deployed (supersedes the guard-deferred line above); the PDF/Office binary extractor for the jarvis path + per-image labels remain open.

**Update 2026-08-01 — both remainders SHIPPED (code; rides the next deploy).** (1) PDF/Word
extraction: `POST /api/vision/read-doc` over the new `src/features/doc-extract/` slice —
pdf via the already-shipped `pdf-parse` dep, .docx via the already-shipped `yauzl`
(word/document.xml → text), format sniffed magic-bytes-first, output bounded; the Jarvis
**+ Add → document** picker now accepts .pdf/.docx and routes binaries through the server
extractor. Extraction failure is HONEST end-to-end: the route answers `{ ok:false, reason }`,
the surface attaches the named file with an `unreadable` flag, and the prompt assembler
renders a "couldn't read this file" section instead of silently dropping it. The optional
"ingest into the owner's private RAG collection" leg remains open (inline excerpt only).
(2) Per-image labels: with 2+ photos the ONE describe call now emits `=== IMAGE k ===`
sections parsed into `sections[]` (fail-open to the combined description), and the surface
attaches one labeled description per photo — `[Image 1 — a.jpg]` / `[Image 2 — b.jpg]` in
the prompt block, so "the first photo" vs "the second" resolves. Still a single accountable
vision call (no per-image cost multiplication). Guards:
tests/unit/jarvis-media-extraction.spec.ts (`extraction-failure-degrades-honestly`,
`image-descriptions-present-in-assembly`) + tests/unit/vision-read-doc-route.spec.ts.

---

## LOCAL_AUTH TOTP and password reset implementation

## LOCAL_AUTH self-service password reset (ADR-117 deferred) ⬜ (2026-07-28)

**The second factor SHIPPED 2026-07-29 — TOTP, RFC 6238.** The operator's constraint was that
it must not require an external provider, and it does not: a shared secret plus the clock,
verified in-process, enrolment QR rendered locally from the `qrcode` dependency that already
ships. Per-user opt-in with an administrator able to require it per account (the operator chose
per-user over deployment-wide, so there is deliberately **no** env force-flag — the original
done-when asked for one and it was superseded by that decision). Secret AES-256-GCM at rest
under an HKDF key from `SESSION_SECRET`; accepted time step recorded so a code cannot be
replayed; eight single-use recovery codes; admin reset for a lost phone. Guards in
`tests/unit/local-totp.spec.ts` — 29 cases including the **RFC 6238 Appendix B vectors**, which
are what prove real authenticator apps will accept these codes; six mutations verified red.
See [ADR-117](../../adr/117-local-auth-invited-users.md) and
[docs/security/local-auth.md](../../security/local-auth.md#two-step-sign-in-totp).

~~Still open: an unauthenticated "forgot password" flow.~~ **✅ SHIPPED 2026-07-31.**
`POST /api/local-auth/forgot` (from the /login page's "Email me a reset link") rides the same
invite-token machinery: `createPasswordReset` mints a 60-minute one-time link for ACTIVE
accounts only (never creates/resurrects an account, never stomps a pending admin invite), and
delivery reuses the invitation rails (SMTP, else the operator's Gmail connector). Every
done-when clause is guarded in `tests/unit/local-auth-forgot-password.spec.ts`: byte-identical
responses for known/unknown/disabled addresses, fire-and-forget delivery (a hung transport
cannot become a timing oracle), per-IP 429 + a SILENT per-email cap (an overt one would leak),
and — because `acceptInvite` never touches the TOTP columns — a reset provably does NOT clear
the second factor (the spec logs in post-reset and still gets `secondFactor: 'required'`).
Original done-when kept below for the record:

- **Done when:** a user can request a reset from `/login`, receives a one-time link, and sets a
  new password — with an **enumeration-safe response shape** (identical answer whether or not
  the email exists, identical timing), per-ip rate limiting, and a guard proving an unknown
  address is indistinguishable from a known one. Note this weakens nothing only if the mail
  channel is trusted: on a box where the second factor is enabled, the reset link must not by
  itself clear the second factor.

---

## Kernel audit completed K2/K3/K4/K7/K8 controls and implementation detail

## Kernel-vs-app bot boundary: what an 11-agent audit found (2026-07-29)

Operator directive, standing at the first hosted customer box: *"they should have the base swarm
bots which include the rca and build bots but they don't have the pumpkin app so they shouldn't
get the pumpkin bot."* An adversarial classification (5 evidence passes + 4 refutation lenses +
synthesis) was run to define `SWARM_REGISTRY=kernel`. It did not return a clean list — it returned
the reasons a naive filter would break a deployment, plus defects worth fixing on their own.
Everything below carries file:line evidence in the run journal.

**K1 — `SWARM_REGISTRY=kernel` is NOT a name filter over the local registry.** ⬜
Core code pins app-flavoured bots by UUID, so excluding them leaves core dispatching to a
nonexistent agent rather than to a package-restored one: `shopping-concierge`
(bot-node-provider-intent 'walmart-catalog'), `weather-bot` (same file + two committed guards),
`screenplay-writer` (series-pipeline + the unconditional `startSeriesReconciler` boot cron),
`ambient-analyst` (src/app/ambient-enrichment-runtime.ts, not a manifest), plus
`communications-bot`, `social-writer`, `home-bot`, `trading-analyst`. Their surfaces carved; the
packages declare **no bots**, so nothing would re-register them.
- **Done when:** kernel is defined **by agentId, not name** (see K2); every pinned-but-app-flavoured
  bot is either carved WITH a package that declares it, or its core pin is replaced by a
  fail-loud escalate; and a guard proves a kernel-mode boot dispatches no ticket to an unregistered
  agentId. Until then `UI_PROFILE=<app>` is the shipped mitigation (customer sees only their app).

**K2 — `system-architect` / `architect-bot`: one UUID, three names.** ✅ SHIPPED 2026-08-01
`swarm-bot-registry-local.ts:772` says `system-architect`; `swarm-bot-registry.ts:782` and
`swarm-apps/oshal-engineering.yaml:70` say `architect-bot`; `dispatch-routing.ts:96-99` resolves
the built-in **build** workflow BY NAME on `system-architect`. The kernel manifest registers the
name the build workflow cannot resolve, and `agent-profile-controller.ts` assigns the name
`system-architect` to a *different* uuid.
- **Done when:** one name across both registries and the manifest, name-vs-id resolution is
  consistent in dispatch-routing, and a guard fails on a registry/manifest name divergence.
- **Shipped 2026-08-01:** `system-architect` is the one name — it is what dispatch-routing
  resolves, what the persona (`system-architect.yaml`) declares, what the compose service is
  called, and what the local (default) registry already used. Renamed in the full registry +
  `oshal-engineering.yaml` (bot AND `workflow.workerBot`); `agent-profile-controller.ts` maps
  a0…0018 to it everywhere and the LEGACY unported a0…0034 row is relabeled
  `legacy-system-architect` so exactly one identity carries the canonical name; migration 100
  renames any DB row. Guard: `tests/unit/registry-name-consistency.spec.ts` — shared-id name
  parity across both registries, manifest-vs-registry name agreement, and every built-in
  `WORKFLOW_PIPELINES` workerBot resolving BY NAME in BOTH lineups (red on any rename).
  Residual (cosmetic, deliberately untouched): `intake-l1-processor-service.ts` artifact
  `ownerRole` prose strings still mix the two spellings — display text, not dispatch.

**K3 — `codex-packer` agentId is a three-way collision.** ✅ SHIPPED 2026-08-01
`a0000000-0000-0000-0000-000000000030` is declared by `swarm-apps/codex-packer.yaml:36` AND
`swarm-apps/intelligent-processing.yaml:54`, and `docker-compose.oshal-local.yml:1277` assigns it
to the **self-healing-bot** service. `validate-swarm-wiring.ts` matches by agentId only, so the
boot audit reports OK. A UUID cannot be safely re-pointed once tickets, `chat_tasks` and Redis
heartbeats reference it.
- **Done when:** self-healing-bot has its own agentId, the wiring validator fails on a
  one-id-many-names/services collision, and a migration note covers existing rows.
- **Shipped 2026-08-01:** self-healing-bot now owns `a0000000-0000-0000-0000-000000000056`
  (compose `AGENT_ID`, persona `agent_id` — was a slug — and the agent-profile fallback maps);
  a0…030 is codex-packer's alone. `validate-swarm-wiring.ts` grew `findAgentIdCollisions()` —
  one agentId under two NAMES across active manifests logs ERROR at boot and throws under
  `STRICT_SWARM_WIRING=true` (same-name re-declares stay legal). Migration 100 covers existing
  rows and documents the ambiguity: pre-migration tickets/chat_tasks under a0…030 are a truthful
  record of the collision era and are left untouched; post-migration attribution is unambiguous.
  Redis heartbeats self-heal (90s TTL). Guard: `tests/unit/swarm-wiring-collision.spec.ts`
  (pure detector red on the collision shape, STRICT throw through the real audit, shipped
  manifests collision-free, compose/persona pinned to a0…056).

**K4 — `self-healing-bot` is the sharpest object in the tree.** ✅ STRICT FORM SHIPPED 2026-08-01
Mounts `/var/run/docker.sock` (root-equivalent on the host), sets `TOOL_AUTH_DOCKER_SOCKET=auto`
(the only service overriding the swarm-wide `off`), runs autonomously under
`ENABLE_SELF_HEALING_SCHEDULER`, grants restart-container / git-pull / analyze-and-fix-code /
docker-build, declares **no accessRoles anywhere**, and reaches a box through
`swarm-apps/intelligent-processing.yaml:53-56` even though it is in no registry.
- **Done when:** it is removed from that manifest's `bots:` (or the manifest is not kernel-resident),
  its compose service is profile-gated away from any customer bring-up, and a guard asserts no
  kernel-resident manifest declares a docker-socket bot.
- **Partial 2026-07-31:** the reachability half is closed the accessRoles way — the manifest
  declaration now carries `accessRoles: [operator, swarm]` (ADR-087), so Jarvis discovery,
  user delegation, and the (now default-enforce) execute-time entitlement gate all refuse it;
  `tests/unit/kernel-manifest-docker-bot-guard.spec.ts` asserts EVERY host-privileged bot in
  EVERY kernel manifest is so scoped (via the real roleCanAccess/manifestBotDefinition, red on
  widen-or-drop). The compose service was already profile-gated (`profiles: incident, extras`).
  Still open from the strict done-when: moving the bot out of the kernel-resident manifest set
  entirely (needs an app-store home for the remediation leg + the K3 agentId collision fixed
  first — re-pointing a…030 is its own migration).
- **STRICT form shipped 2026-08-01 (unblocked by K3):** `intelligent-processing.yaml` declares
  **no bots at all** — the docker-socket bot is out of the kernel-resident manifest set, so a
  customer box loading the kernel manifests is never handed a root-equivalent identity. The
  workflow (rca-specialist worker, queue-bot reviewer) is unchanged; the container remains
  compose-side behind `profiles: incident, extras` under its own a0…056 identity for the
  operator's opt-in remediation leg. `kernel-manifest-docker-bot-guard.spec.ts` now asserts the
  ABSENCE (no kernel manifest declares any host-privileged bot; a0…056 not in the kernel id set)
  with the seq-1 scoped-accessRoles walk kept as defense-in-depth. Remaining (unchanged intent):
  an app-store package as the remediation leg's future home — packaging it is store-repo work.

**K5 — worker bots inherit the SUPERUSER database URL; the api does not.** ✅ CODE SHIPPED 2026-08-01 (live soak = deploy-time)
`docker-compose.oshal-local.yml:225` gives the shared bot env a DSN for the `oshal` role
(superuser, `rolbypassrls=true`) while the api was moved to least-privilege `oshal_app` at :679.
**Postgres superuser bypasses RLS** — the keystone of the multi-user isolation the platform is sold
on. VERIFIED NOT APPLICABLE to the first customer box (2026-07-29: api runs `oshal_app`;
`rolsuper=f, rolbypassrls=f`; zero bot containers exist). It applies to any deployment that runs
bot nodes, including the dev box.
- **Done when:** worker bots use `oshal_app` (or a per-bot least-privilege role), a guard asserts no
  compose service hands a bot a superuser DSN, and the RLS two-user live test is re-run with bots up.
- **Shipped 2026-08-01 (code + guard):** new dedicated `oshal_bot` role — NOSUPERUSER,
  NOBYPASSRLS, NOCREATEROLE, DML-only, owns NOTHING (weaker than `oshal_app`, which owns tables
  for startup DDL: bots do no DDL, so plain RLS enforces everywhere a policy exists). Created
  idempotently + privilege-tolerantly by migration 099 (runs as superuser in the flag-ON compose
  bootstrap; degrades to NOTICE elsewhere), with default-privilege grants from BOTH creators
  (`oshal` migrations + `oshal_app` runtime DDL). All 18 bot-side compose DSNs now read
  `${BOT_DATABASE_URL:-postgresql://oshal_bot:oshal-bot-dev@oshal-db:5432/oshal}` — deliberately
  NOT `${DATABASE_URL}`, so bots can never again inherit whatever the operator's api DSN is
  (custom-DB boxes set `BOT_DATABASE_URL` beside `DATABASE_URL`). Guard:
  `tests/unit/bot-db-least-privilege.spec.ts` (no superuser DSN anywhere, exactly ONE
  `${DATABASE_URL:-…}` left = the api's oshal_app line, role attributes + no-ownership pinned
  in the migration). **Remaining leg (deploy-time, do at next `oshal-deploy.sh`):**
  (1) confirm migration 099 applied and `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
  WHERE rolname='oshal_bot'` shows f/f; (2) with bot containers up, confirm a bot connects as
  `oshal_bot` (`SELECT current_user` via the bot's pool log or `docker exec`); (3) re-run the
  RLS two-user live test with bots up; (4) rotate the dev password on any shared box
  (`ALTER ROLE oshal_bot WITH PASSWORD …` + `BOT_DATABASE_URL` in `.env`). Residuals noted:
  `docker-compose.incident-lab.yml` still hands its LAB bots the lab-DB superuser (isolated
  throwaway DB, api shares the anchor — out of K5's multi-user-isolation scope); `TSDB_URL`
  (market bars) is a separate single-purpose DB, untouched.

**K6 — `OSHAL_EXECUTE_ENTITLEMENT` appears in no compose file** ⬜ so it defaults to `warn`:
entitlement denials are logged and then **allowed**. Setting `enforce` (with `OSHAL_OPERATOR_SUBS`
populated) is the single highest-value hardening step, but it must be proven on the dev box first —
flipping an enforcement default on a live customer box without an exercised path is how a working
deployment goes dark.
- **Done when:** `enforce` is the compose default, an e2e proves an unentitled execute is refused
  AND an operator path still works, and the customer runbook lists it.
- **Shipped 2026-07-31:** the CODE default is now `enforce` (stronger than a compose default —
  it covers every deployment that sets nothing, including k8s), with `warn`/`off` as explicit
  opt-outs and unknown values falling back to enforce (a typo must not relax it). Flip decision
  was soak-based: the seq-2 warn default had been logging would-be denials box-wide and a 7-day
  grep across api + bot containers found ZERO, so nothing legitimate is behind the wall.
  `tests/unit/bot-node-execute-entitlement.spec.ts` now proves the default DENIES (403 through
  the real middleware chain) while the operator + queue-dispatch paths stay green. Still open:
  a runbook line for customer boxes (set `OSHAL_OPERATOR_SUBS` before inviting users to scoped
  bots), and re-checking the denial log on the dev box after the next deploy.

**K7 — internal machinery bots ship unscoped.** ✅ SHIPPED 2026-08-01 — `code-developer`, `code-reviewer`,
`test-engineer`, `tester-bot`, `devops-bot`, `research-bot`, `security-analyst`, `vault-bot` and
`general-bot` declare no `accessRoles`, so ADR-087's "omitted = open to every caller" makes them
live Jarvis / inbound-A2A call-out candidates with the shared workspace mounted read-write.
`security-analyst` is the sharpest: its ROUTE is `requiresOperator`-gated but its IDENTITY is not,
so a call-out reaches it around the gate. Care needed: `general-bot` is the Jarvis `task` lane
fallback, so scoping it must include the `jarvis` role or Jarvis routing breaks.
- **Done when:** each gets an explicit accessRoles decision (both registries per
  docs/building-a-bot.md), and a guard asserts every bot the platform treats as internal machinery
  declares them.
- **Shipped 2026-08-01:** all eight get `accessRoles: [operator, swarm]` in BOTH registries
  where present (security-analyst/vault-bot are local-only by design), plus apply-operator and
  linkedin-profile-operator on the same decision (desktop-driving rail). `general-bot` gets
  `[operator, swarm, jarvis]` — the jarvis role is KEPT per the wave-2 constraint (task-lane
  fallback; `routability-critical-bots.spec.ts` also enforces it). Direct-by-id dispatch
  (security-routes → security-analyst, devops surface → vault-bot, build pipeline → workers)
  is unaffected per ADR-087; what closes is discovery + the around-the-gate call-out + (under
  the K6 enforce default) interactive non-operator execute. Guard:
  `tests/unit/internal-machinery-scoping.spec.ts` — a NAMED machinery list, every definition in
  both registries must declare valid roles that DENY 'jarvis' via the real roleCanAccess, the
  security-analyst identity-vs-route case pinned via live isBotAccessibleTo, and the general-bot
  constraint pinned as its own case. Behavior note for operators: chatting AS a non-operator
  user directly with these bots now 403s under the enforce default — set `OSHAL_OPERATOR_SUBS`.

**K8 — registry-membership hazards.** ✅ SHIPPED 2026-08-01 — `linkedin-profile-operator` is pinned by
`src/app/profile-studio-dispatch.ts:37` and mounted unconditionally, but exists ONLY in
`swarm-bot-registry.ts` — a kernel filter written against the local registry alone silently misses
it. `advisor-bot` looks like a **phantom**: no persona, no compose service, no references outside
the registries. `research-bot` defaults `TOOL_AUTH_GOOGLE_SEARCH=auto` while kubectl/aws/docker
default off — a prompt-to-external-vendor path with no approval gate, and a third LLM vendor in the
customer's DPA inventory.
- **Done when:** both registries agree on membership for every pinned bot, phantoms are deleted or
  justified, and tool-auth defaults are consistent with the swarm-wide `off` posture.
- **Shipped 2026-08-01:** linkedin-profile-operator AND its rail sibling apply-operator (also
  full-registry-only, pinned by browser-task-dispatch) added to the local registry — identical
  defs, operator+swarm scoped; `internal-machinery-scoping.spec.ts` pins both core-pinned ids to
  exist in BOTH registries under one name. The `advisor-bot` phantom was ALREADY deleted on main
  (2026-07-29 ADR-045 closure, both registries — this item's description predates it; verified
  zero references remain). Tool-auth: `TOOL_AUTH_GOOGLE_SEARCH` compose default flipped
  auto→off (matches the code default in cliTools.js and the off posture of every other
  externally-reaching lane; opt back in per-deployment via `.env`); plane/chroma stay auto as
  pinned in-stack exceptions. Guard: `tests/unit/compose-tool-auth-defaults.spec.ts` (all
  external lanes -off}, exactly two auto exceptions, and the ONLY hard per-service escalation is
  self-healing-bot's docker-socket inside the profile-gated service).

---

## Installer connector-liveness completion

## Installer-gaps hardening — deferred remainders (G-Squared incident, 2026-07-31)

The G1/G2/G3/G4/G7/G9/G12/G14 core landed (oshal-verify.sh, /api/readiness, OSHAL_NO_AI,
onboarding-gate requirement, mount modes, TaskController direct-path rejection, invite reconnect
message — see `oshal-app-private/gsquared-install-issues/INSTALLER-GAPS.md` for the ledger).
These are the deliberately-deferred remainders:

- ~~**Connections screen trusts its own DB row for the "connected" badge (G14 leg 2).**~~
  ✅ **SHIPPED 2026-08-01 (code; rides the next deploy).** "1 connected" used to mean a row
  exists, not that Google would honor the token. Now: `GET /api/connect/liveness`
  (src/app/routes/connector-liveness.ts, auth-gated, caller-scoped) probes each connected
  provider — rows with a refresh token get a FORCED real refresh (`getValidAccessToken`
  grew `opts.forceRefresh`; a dead Testing-mode grant surfaces as `refresh 400` →
  `needs_reconnect` with the ~30-second fix named), refresh-token-less rows validate via the
  account endpoint (unverifiable → honest `unknown`, never a false red); results cached
  ≤15 min per (caller, provider), `?fresh=1` bypasses. `/utilities` calls it after the list
  loads: a dead grant's pill flips to **needs reconnect** (distinct red badge), the card grows
  an actionable warning line, the summary counts it out of "connected", and a banner points at
  the badge. The invite flow's send-time distinction (leg 1) shipped earlier in
  local-auth-routes.ts and now has its own guard. Guards:
  tests/unit/connector-liveness.spec.ts (`connected-badge-reflects-live-check` — pins the
  `refresh 400` → needs_reconnect state and that the probe provably forces a refresh) +
  tests/unit/invite-reconnect-message.spec.ts (`reconnect-message-distinct-from-transport-missing`).

- **`--apps` installs run no per-app smoke (G8).** An app installed with no engine reports
  success and misbehaves at runtime. `/api/readiness` now covers the engine leg globally, but an
  app's own advertised AI features (e.g. intelligent-sales `structure-note` returning a
  structured draft) go unprobed.
  *Done when:* a store package can declare a `smoke:` block in `oshal-app.yaml`,
  `oshal-verify.sh --apps a,b` executes each installed package's smoke, and the install fails
  naming the app whose advertised feature cannot run.

- **`noop` answers with text instead of a disabled state (G2 remainder).** Surfaces advertising
  AI render stub *answers* on a declared no-AI box because the noop provider RETURNS TEXT — the
  `if (!raw)` offline fallbacks fail open (see memory: a customer rep saw internal board context
  echoed back). OSHAL_NO_AI now declares the posture server-side; surfaces still need to read it.
  *Done when:* with OSHAL_NO_AI=true, chat/Jarvis/app surfaces render an explicit "AI is
  disabled on this deployment" state instead of noop text, pinned by a spec per surface class.

- **`oshal-verify.sh` has no live chat probe (G1 remainder).** The verifier proves provider +
  credential + heartbeat, not an actual end-to-end generation ("a real chat call returns a real
  answer"). A live probe needs an authenticated call and costs tokens, so it must be explicit.
  *Done when:* `oshal-verify.sh --live` (PAT via env) sends one real chat message, asserts a
  non-stub answer, and strict mode documents when to use it (customer handover, post-deploy).

---

## Payroll shipped ACH, EFW2, calendar, check, and RT-6 implementation history

## Payroll app (ADR-123) — remaining deferred product and coverage gaps

Payroll ships as a store package (v2.2.0). Everything below was *chosen* not to build, not missed —
each entry says why, so it is not silently re-litigated. Nothing here is required for the shipped
scope to be correct; each is a coverage or product gap. Items marked SHIPPED have been built since
this section was written and are kept here with what they uncovered, because the landmines outlive
the gap.

1. **State withholding beyond the shipped set.** Four states ship verified tables (PA, IL, KY flat;
   MO progressive) plus the nine no-wage-income-tax states; every other state falls back to an
   operator-entered rate WITH a warning. **Deferred because** a wrong table is worse than an absent
   one — the operator cannot tell it is wrong. **Done when:** the state's rule is in `STATE_RULES`
   with a retrieved primary-source citation, a known-value test derived from that state's own worked
   example (the Missouri pattern), and its removal from `KNOWN_UNSUPPORTED` if listed. Indiana needs
   the mandatory county-tax table first; North Carolina needs its withholding rate (deliberately
   higher than its tax rate) confirmed from NC-30.

2. **Local/city taxes and state disability / paid-leave contributions.** Indiana counties, Ohio
   municipalities, PA Act 32 EIT/LST, NYC and Yonkers, Maryland county piggyback, Michigan cities;
   CA SDI, NY DBL/PFL, NJ TDI/FLI, WA PFML and Cares, MA/CT/OR/CO PFML. **Deferred because** these
   are a second withholding dimension, not a rate tweak — for IN and MD the local piece is part of
   the answer, which is why those states cannot ship at all. **Done when:** the engine carries a
   jurisdiction list per employee and each shipped jurisdiction has a cited table plus a test.

3. **Per-workweek hours.** FLSA overtime is computed per workweek and may never be averaged across
   weeks, but a run line holds ONE hours figure for the whole period. Today the engine warns when a
   multi-week period records more than 40 hours/week with no overtime. **Deferred because** the real
   fix is a per-workweek (better: per-workday) child table, which is the same restructuring that
   multiple pay rates and PTO need. **Done when:** hours are rows of (earnings code, rate, hours,
   workweek), overtime is computed per workweek from them, and 29 CFR 516.2 daily/weekly records
   exist for the retention period.

4. **SSN, addresses and the employer EIN.** The W-2 output is a *preview* precisely because these
   are absent. **Deferred because** SSN is the most sensitive field the platform would hold and
   deserves encryption at rest, masked display, and audited reads — a security design, not a column.
   **Done when:** those fields exist with that handling and the W-2 can be issued.

5. **Employee self-service.** One login is the whole company; an employee cannot fetch their own
   stub. **Deferred because** it needs a second identity class scoped to one `employee_id`, a
   platform decision. **Done when:** an invited employee reads ONLY their own stubs and W-2 preview,
   proven by an isolation spec that fails if they reach another employee's row.

6. **Overpayment repayment across tax years.** **Deferred because** it is genuinely different from a
   void: the employee had constructive receipt, so box 1 is NOT adjusted for a prior year — only
   boxes 3–6 move, via W-2c, with a claim-of-right deduction. Getting it backwards is an IRS
   violation, so approximating is worse than refusing. **Done when:** same-year and prior-year
   repayment are separate transactions with a test asserting the prior-year case leaves box 1 alone.

7. **Multiple garnishment orders with priority.** One CCPA-capped garnishment field exists; a second
   order, priority ordering (support, then levy, then creditor), arrears multipliers and per-order
   remittance do not. **Done when:** deductions are rows with type/priority/caps and each prints as
   its own stub line.

8. **Deposit schedule and due dates.** Reports are quarterly; federal deposits are monthly or
   semiweekly by the lookback test, with a $100,000 next-day rule. **Done when:** a depositor status
   setting drives a per-payday deposit amount and due date.

9. **PTO/leave accrual, multiple pay rates, employer 401(k) match, workers' compensation, employer
   benefit share, payment records (check number / ACH trace), bank-holiday pay-date shifting, and
   1099 contractors.** **Deferred because** none changes a tax computation — they are additional
   record types. **Done when:** each is a first-class type with its own stub or report presentation.

10. **Money movement and filings** — ✅ PARTLY SHIPPED in v2.1 (2026-08-01), remainder below.
    **Shipped:** the NACHA PPD ACH file the employer uploads to their OWN bank (with prenote mode),
    Form 941 and Form 940 worksheets carrying real line numbers and a reconciliation against the tax
    actually withheld, and issuable W-2s once identity is on file. oshal produces; the employer's bank
    and EFTPS execute. ⚠ **Correction to this entry's original premise:** the Gusto connector is
    READ-ONLY (`GET /me`, `/employees`, `/payrolls`) and was never a filing path. More importantly an
    embedded provider computes its OWN withholding, so delegating would make the verified engine
    decorative — which is why the self-contained direction was chosen instead.
    **Still open, each with its own done-when:** items 11–16 below.


11. **Electronic W-2 filing (SSA EFW2)** - SHIPPED in v2.2 for verified tax years (2026-08-02).
    `payroll-efw2.ts` builds the RA/RE/RW/RT/RF submission at 512 fixed positions, and its RT totals
    are read back **out of the finished file** rather than compared to the builder's own arithmetic.
    The RW and RT field ORDERS diverge (RW runs Q, C, V, Y, AA, BB, DD, FF; RT runs Q, DD, C,
    sick-pay, V, Y, AA, BB, FF), so a positional loop swaps DD and C and mis-aligns everything after
    them - both maps are keyed by name and a guard asserts it with distinguishable amounts.
    **HUMAN TASK, and the only thing blocking tax year 2026:** SSA Publication 42-007 for TY2026
    could not be retrieved (`https://www.ssa.gov/employer/efw/26efw2.pdf` returns HTTP 403 to every
    automated fetch - WebFetch, curl and PowerShell, multiple user agents). TY2026 **adds Box 12
    codes TT and TP**, which the engine already computes and which have no field in the verified 2025
    layout, so the builder refuses that year BY NAME rather than guessing. A person with a browser can
    download it in ten seconds. **Done when:** `26efw2.pdf` is retrieved, its layout added to
    `EFW2_VERIFIED_TAX_YEARS` with the TT/TP money-field positions cited, and a file validated through
    AccuWage Online (itself a human step - an SSA web tool, not an API).

12. **EFTPS deposit initiation and 941 e-file** - STILL OPEN, and the only item in this group that
    is not a code problem. The deposit SCHEDULE and the 941 worksheet exist; nothing transmits. **Deferred because** both need enrolment and credentials, and the worksheet
    already tells an employer exactly what to pay and by when. **Done when:** a deposit is initiated
    through an enrolled channel and the confirmation number is recorded against the obligation, so
    the deposit report shows paid-vs-owed rather than owed-only.

13. **ACH returns and notifications of change** - SHIPPED in v2.2 (2026-08-02).
    `payroll-ach-returns.ts` parses the return/NOC file, the matching payment moves to
    returned/corrected, an NOC correction is applied behind an explicit confirm (re-validating the ABA
    check digit), and the run surfaces exactly who was NOT paid.
    **A prerequisite this uncovered:** `buildAchFile` assigned each entry a trace number and threw it
    away, and a return identifies its entry ONLY by that original trace - so there was nothing to
    match against. The builder now returns the traces and the ACH route persists them. **Runs whose
    ACH file was generated before v2.2 have no stored trace and must be matched by hand**; the
    settlement view reports that count rather than hiding it.
    **Provenance is weaker than the rest of this app, and is stated in the module header:** the Nacha
    Operating Rules are paywalled and were never read. The addenda 98/99 layouts are reconstructed
    from concurring secondary sources (a Nacha-member education deck, moov-io/ach's parser source, a
    real bank-produced return file). We PARSE only and never originate a return, dishonour or
    reversal, which is the safe direction at that confidence level.

14. **Bank-holiday calendar** - SHIPPED in v2.2 (2026-08-02). `payroll-calendar.ts` drives both the
    pay-date shift and the deposit due date, chaining through consecutive closures, with the reason
    shown.
    **The finding that mattered: ONE holiday list is a bug - there are TWO calendars.** The Federal
    Reserve decides whether money moves; the IRS decides when a deposit is due, and they disagree. A
    holiday falling on SATURDAY costs the Fed nothing (Reserve Banks stay open the preceding Friday -
    zero banking days lost) while the IRS observes it on that Friday. DC Emancipation Day is an IRS
    legal holiday the Fed does not observe at all. Friday 2026-07-03 is both at once: banks open,
    payroll funds, deposit deadline moves. The semiweekly rule also implements Pub 15's
    extra-day-per-legal-holiday allowance, which is NOT a next-business-day roll and can land later
    than one.
    **Only 2026's IRS list has been read from that year's Pub 15.** Later years are computed from the
    same rules (which reproduce the verified 2026 list exactly) and returned with `verified: false`.
    Pub 15 republishes the list annually - re-read it each year rather than trusting the derivation.

15. **Check printing** - PARTLY SHIPPED in v2.2 (2026-08-02); the MICR half is REFUSED, not pending.
    Numbering, the printable check with the amount in words, and the UCC 4-404 six-month staleness
    legend all ship. Numbers come from an atomic single-statement sequence, and the existing
    uniqueness index prevents reuse.
    **No MICR line is generated, and that is a decision rather than a gap.** ANSI X9.100-160-1 is
    paywalled, and every obtainable vendor source contradicts the others: 62 vs 65 character
    positions; the EPC field at "either, but not both, positions 44 or 45" vs "position 44-45"; the
    auxiliary on-us field starting at 44 vs 45; and one manual calling the on-us field "positions
    13-32" and "nineteen spaces" in consecutive sentences. A line one position out is rejected by a
    reader-sorter or posted to the wrong account, and the band needs magnetic toner no software
    supplies. Checks print onto bank-encoded stock, which is what small employers already buy. Same
    rule as the state tax tables: **a wrong table is worse than an absent one.**
    **Done when (if ever):** someone buys ANSI X9.100-160-1 and X9.100-20, the field positions are
    cited from the standard rather than from vendors, and a printed sample is accepted by a real
    reader-sorter. Until a paid-for standard is in hand this stays refused - do NOT "fix" it by
    picking whichever vendor number appears most often.

16. **State quarterly returns (FL RT-6 first)** - SHIPPED in v2.2 (2026-08-02). `payroll-rt6.ts`
    produces every line from the ledger and reconciles against the reemployment tax accrued, following
    the 941 pattern. Florida qualified under the "never outrun correctness" rule precisely BECAUSE it
    levies no wage income tax - there is no withholding table to be wrong about.
    The $7,000 base is per employee per calendar year with a quarterly year-to-date carry (the FUTA
    trap). It deliberately does NOT generate the payment coupon's OCR scanline - no retrieved document
    describes that string's structure or check digit - and does NOT roll the penalty-after date off a
    weekend, because Florida's rule for that appears in none of the department's documents and the
    IRS calendar is the wrong authority for a state deadline (it includes DC Emancipation Day).
    **Next state done when:** the same, for a state whose withholding table is already verified -
    which today means PA, IL, KY or MO (see item 1), not an arbitrary next state.
