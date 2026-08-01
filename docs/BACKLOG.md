# Backlog

Tracking items deferred from the OSHAL build session. Each item has the
deferral reason and the "done" condition so future work isn't ambiguous.

## Alert triage & consolidation — intelligent-processing intake (P1–P4 built; P4 code+guards 2026-08-01, live drill pending)

**Specified 2026-07-28** (operator directive: non-noisy alerts flow to the queue, duplicates get
bundled and consolidated — the analyst + self-healing portion). The functional specification is
[docs/architecture/alert-triage-and-consolidation-spec.md](architecture/alert-triage-and-consolidation-spec.md),
mined from the retired SRE platform's pipeline (ADR-069 §2a) including its own postmortem trail —
its proven constants are the spec's defaults and its documented flaws are do-not-repeat
requirements. The end state is [ADR-119](adr/119-autonomous-health-ticket-processing.md):
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
4. **P4 Autonomy ladder ([ADR-119](adr/119-autonomous-health-ticket-processing.md))** — structurally
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

## Strategy Studio + Bot Forge conversational parity — deferred pieces

**Deferred 2026-07-26** — the Studio refine-in-place ship (store PR #4, trading v1.1.0) and the
Forge registry-parity fix (core PR #37) closed the operator's "modify strategies conversationally"
ask; three follow-ons were consciously left open.

1. **Studio live shakeout.** The refine loop is unit-guarded and deployed but has never run
   end-to-end against a real LLM session. **Done when:** the operator (or a logged-in e2e run) has
   exercised one full cycle in the browser — design → ≥2 refinements on the same strategy row →
   Apply live (confirm) → Revert — and a prose reply has been observed coming back as a
   `needsInput` chat turn rather than an error.
2. **Forge refine-in-place.** The Bot Forge interviews and emits packs but cannot conversationally
   EDIT an already-emitted pack the way the workflow assistant refines a graph (the pattern the
   Studio now follows). Operator interest voiced 2026-07-25, not yet commissioned. **Done when:**
   a forge chat turn naming an existing pack loads its persona+manifest as refinement context and
   re-emits the SAME pack dir with only the requested change (injection stays the operator's
   one-click gate), with a guard spec proving edit-not-duplicate.
3. **codex-packer agent-id naming drift.** `swarm-app-bot-integrity-check.sh` (advisory REVIEW,
   overall PASS) shows agent `a0000000-…-030` registered in the live DB as `self-healing-bot`
   owned by `intelligent-processing`, while both registries name it `codex-packer` — same class as
   the drone/portrait id collision resolved 2026-07-21. **Done when:** the DB row for `…030` is
   named `codex-packer` (or the shared-id is documented as intentional in the integrity check's
   allowlist), and the advisory line for it no longer appears.

Non-goal, recorded deliberately: blends stay non-refinable in the Studio (components are embedded
snapshots by ADR-095 design — the chat explains this and points at the Lab's blend builder).
Earlier studio deferrals stand: RAG-corpus graduation for the research findings, streamed
narration, futures.

## Seven agent-worktree branches pushed but not landed (+ the push gap that stranded them) ✅ CLOSED 2026-08-01

**Deferred 2026-07-26** — found while auditing the ADR-045 graph tier; the branches were
discovered only because a gitignored path turned up in a background grep.

Seven background agents each opened a git worktree under `.claude/worktrees/agent-*`, committed
once on 2026-07-24, and stopped without pushing. All seven were pushed to `origin` on 2026-07-26
and **every one passed the publish gate and the committed-HEAD typecheck on the first try** — there
was never a technical blocker, no gate rejection, no auth failure. They were simply never pushed.

| branch | commit |
|---|---|
| `harden/graceful-degradation` | external deps degrade (503/fallback) instead of unhandled 500 |
| `test/critical-path-guards` | vitest guards for 3 critical paths (harness resolve, manifest load, …) |
| `feat/run-trace-token-duration` | guard write persistence of the per-call token/duration ledger |
| `feat/api-me-chroma-arango-export` | behavioral guards for the `/api/me` Chroma + Arango export |
| `fix/workflow-studio-bridge-fire` | talk-to-build fires the surface dock, no fence leak |
| `feat/notification-transports` | severity→transport policy, email transport, inbound SMS |
| `docs/jsdoc-orchestration` | JSDoc on exported members in the two largest orchestration files |

**Why this is a new failure mode, not the old one.** Under the shared-worktree model an unpushed
commit was still *visible* — it sat in the one index on the one branch, so the next agent tripped
over it within minutes. That accident was load-bearing. Worktree isolation gives each agent a
private tree **and** a private branch, so an unpushed commit is invisible to everyone including the
next agent. Rule 0's "push your branch immediately after committing" stopped being advice and
became the only thing standing between a commit and oblivion. Two of the seven were regression
guards — the category the 2026-07-19 hardening doctrine says must never be orphaned.

**Done when:** (1) each of the seven has been reviewed and either merged or closed with a reason —
none may sit as a permanently open branch; (2) `.claude/worktrees/` is empty and `git worktree list`
shows one entry, run only after the branches land; (3) a guard exists that makes an unpushed
agent-worktree commit loud rather than silent — a `git worktree list` + ahead-of-origin check in
`ci-local.sh` or the session-close path, so this cannot recur undetected.

**✅ All three legs closed 2026-08-01.**

- **Leg 1 — the seven are gone.** None of the seven names resolves to a ref any more, local or
  remote (`harden/graceful-degradation`, `test/critical-path-guards`,
  `feat/run-trace-token-duration`, `feat/api-me-chroma-arango-export`,
  `fix/workflow-studio-bridge-fire`, `feat/notification-transports`, `docs/jsdoc-orchestration`).
- **Leg 2 — one worktree.** `.claude/worktrees/` is empty; `git worktree list` shows the single
  primary checkout.
- **Leg 3 — the guard exists, and it is the half that was missing.**
  `scripts/check-worktree-strays.sh` (shipped first) covers **linked worktrees** and deliberately
  skips the primary checkout, so the shapes that actually strand work here were still invisible: a
  commit on the shared checkout's branch, a local branch ref left ahead of origin, and a detached
  HEAD carrying a commit — the push-by-SHA recipe's failure mode, where a stale branch pointer
  pushes "successfully" and only GitHub's 422 "no commits between" ever complains. New
  `scripts/check-unpushed-commits.sh` judges every local ref plus any detached HEAD against every
  origin remote-tracking ref, wired as the `unpushed-commits` gate in `ci-local.sh` (run
  unconditionally beside `secret-scan`, so ref state is still judged when the HEAD export fails).
  Because every PR here squash-merges, the hard part is not detection but not crying wolf: a naive
  ahead-of-origin count flags 37 refs on this box. Four classes, all printed by name — STRANDED
  (fails), stale ref (a no-op merge into `origin/main`, or every patch-id already upstream per
  `git cherry`), pre-scrub orphan (no merge base; the trunk history restarts 2026-07-29), and
  `archive/*` (deliberate local-only history that must never be pushed). No origin refs, or no
  `origin/main`, exits 2 UNAVAILABLE rather than 0. Guard:
  `tests/unit/unpushed-commit-guard.spec.ts` — 12 cases on throwaway bare-origin + clone fixtures
  (the real repo's ref state is never read), 9 mutations proven red.

**Full remote-branch sweep, 2026-08-01 — nothing else is stranded.** Every `origin/*` branch
(60, excluding `main` and the read-only `pull/*` refs) was checked two ways: does merging it into
`origin/main` produce `origin/main`'s exact tree, and does `git cherry` find each of its commits'
patch-ids already upstream. **All 60 are content-landed**, and every one traces to a merged PR by
commit subject — including `fix/pump-tuning-from-first-run`, whose subject was reworded on the way
in (PR #53) and which therefore looked absent under a naive subject search. All 60 remote branches
were deleted; nothing unmerged was touched. Local refs ahead of origin: 35 pre-scrub orphans, 1
`archive/*`, and 1 stale ref (`chore/extract-coder-bot`, landed via PR #19 and then deliberately
removed by PR #31 when coder-bot was extracted to its own repo — merging it back would re-add the
carved-out directory, so it is a delete, not a land).

**`origin/fix/psycopg2-dockerfile` — the "next rebuild cannot reach Postgres" claim is now FALSE,
and the branch is deleted.** The claim was TRUE when written: `psycopg2-binary` had been
pip-installed into a running container during the career-engine SQLite→Postgres cutover and was not
in the image. The fix landed on `main` on 2026-07-30 inside the **PR #58 squash** (`7381978`), which
carried the Dockerfile commit `8ac4c7d` ahead of the light-AI paper commits — which is why no
separate "psycopg2" PR exists and why a patch-id search for the branch reported it unlanded.
Evidence: `7381978`'s diff produces Dockerfile blob `7bcefc4`, byte-identical to the branch tip's
blob, and `origin/main`'s `Dockerfile.oshal` still carries
`pip3 install … python-docx anthropic psycopg2-binary` with the original justification comment
intact. `main`'s Dockerfile is a strict superset (it also gained the `oshal-verify.sh` /
`swarm-routability-check.sh` COPY trio), so merging the branch was a no-op. **An image rebuilt from
`main` today installs the Postgres driver.** No action required at deploy time.

**Where the deploy-time proofs live now:** the deploy-time legs scattered across this file (K5's role
verification, K6's denial-log re-check, ADR-119 P4's container-kill drill, the store packages needing
re-registration, the bind-mounted `jarvis.html` copy) are consolidated as one operator procedure in
[runbooks/pre-deploy-checklist.md](runbooks/pre-deploy-checklist.md). The done-when text here stays
authoritative; the runbook is the order to do it in.

## ADR-045 graph tier — the pieces that were never built

**Deferred 2026-07-26** — recorded when ADR-045's status was reconciled from `Proposed` to
as-built (PR #48). The connector, both tiers, `/api/graph`, the kernel skill and the swarm
operational graph are live; these three are not, and the ADR now says so.

- **RCA-persona rewiring.** ADR-045 planned to point the RCA bots at the connector. The personas
  it names — `graph-analyst`, `advisor-bot`, `alert-intake-bot` — do not exist in
  `ai-lab/bot-personas/`. `remediation-writer.yaml` still advertised the dead **Memgraph** as a
  platform component until PR #48; the *rewiring* itself is still unbuilt.
- **`subgraph()`.** The shipped `GraphHandle` is `upsertNodes` / `upsertEdges` / `neighbors` /
  `shortestPath` / `rawQuery`. Planned `query` shipped as `rawQuery`; `subgraph` never landed.
- **Store packages reach `@/features/graph` without declaring `uses:`.** `career-hunter`
  (the first ADR-045 carve-out) imports the kernel graph slice directly, and neither its manifest
  nor `world`'s has a top-level `uses:` block. The validator only rejects a `uses:` naming an
  *unknown* id — it does not require declaration — so this may be intentional, but the app→kernel
  graph dependency is invisible to the registry either way. Resolve against ADR-090 before the
  next carve-out copies the pattern.

**Done when:** each of the three is either built, or has an explicit "won't build, because…" line
in ADR-045 — no item stays in the ambiguous middle. The `uses:` question in particular needs a
yes/no from ADR-090, not silence.

## Nightly scheduled tasks still launch from the frozen archive repo (ADR-115 cleanup)

**Deferred 2026-07-25** — found during the night-reliability pass after a swarm OOM incident.

Five enabled Task Scheduler jobs still execute from `C:\Projects\open-shal-swarm-harness-agent-llm`
(the frozen [ADR-115](adr/115-clean-trunk-branch-strategy.md) reference archive) instead of this
trunk: **OSHAL Claude token keepalive, OSHAL Daily Trade Recap, OSHAL Kalshi Forward Test, OSHAL
Signal Labeler, OSHAL-Evidence-Nightly**. Only Lab-Report-Publish + Local-CI + the two watchdogs
were migrated at cutover.

**Why it is NOT a one-line repoint:** the trunk copies of these launchers *hardcode* the archive
path — `claude-token-keepalive-hidden.vbs`, `run-daily-recap-hidden.vbs`, and
`oshal-signal-daily-hidden.vbs` all `Run "...\open-shal-swarm-harness-agent-llm\scripts\...";
`kalshi-forward-daily.cmd` does `cd /d C:\Projects\open-shal-swarm-harness-agent-llm`. So pointing
the *task* at the trunk `.vbs` still runs the archive scripts. A real migration must (a) rewrite
each launcher self-locating (the pattern `publish-lab-report-hidden.vbs` already uses) and (b)
verify each downstream chain runs from the trunk. **Evidence-Nightly cannot move** — it writes its
board to `docs/evidence/`, which is internal-only and absent from the public trunk by design; it
stays archive-resident (or moves to a private, non-public path).

**Why it is non-urgent:** the core logic runs in-container (trunk code) regardless of which repo
launched the task, and failure alerting is now fixed (`oshal-send-alert.js`, 2026-07-25) so a
broken run is no longer silent. These are live data-collection services (operator: "we need all of
those services") — a careless launcher rewrite pointed at an incomplete trunk chain would silently
break one, and several have side effects (recap emails, signal writes), so each needs a green
test-run after repointing.

**Done when:** each of the four movable tasks (keepalive, recap, kalshi, signal) has a self-locating
launcher, its downstream chain verified to run from `C:\Projects\oshal`, and its Task Scheduler
action repointed + test-run green; Evidence-Nightly explicitly documented as archive-resident (or
relocated to a private path).

## brace-expansion CVE-2026-14257 quarantine (trivy gate)

**Quarantined 2026-07-25** (`.trivyignore`, honored by `gate_trivy` from the committed tree).
Upstream fixed the DoS only in v5.0.8; the v1/v2 majors have no fixed release, and v5's export
shape (`{expand}` named vs bare function) breaks every `minimatch@3/@5` consumer — proven live:
a tree-wide override killed eslint brace patterns with "expand is not a function". Current state:
the `minimatch@>=10` copy is override-pinned to `^5.0.8` (package.json); the remaining vulnerable
copies are `1.1.16` (eslint→minimatch@3, dev tooling, code-authored globs only) and `2.1.2`
(exceljs→archiver@5→readdir-glob@1→minimatch@5, constant zip globs, no untrusted input). The
escape for the exceljs chain exists upstream (archiver@8→readdir-glob@3→minimatch@10) but is a
cross-major archiver API change under exceljs — riskier than the DoS it avoids.

**Done when:** the `.trivyignore` entry for CVE-2026-14257 is DELETED because (a) 1.x/2.x
compat fixed releases appeared and the lockfile picked them up, or (b) eslint's and exceljs's
chains both resolve brace-expansion@>=5.0.8 naturally (check `npm ls brace-expansion`), and the
trivy gate passes without the entry.

## App store (ADR-085) — completing the swarm reset ✅ MIGRATION COMPLETE 2026-07-19 (all carve-eligible app surfaces carved to the store; kernel down to 10 core-platform manifests — see the completion stamp in §3)

ADR-085 is **Accepted + live-proven** (tags `appstore-v0.1.0`→`v0.5.0`): little-monsters is
fully carved out of core and reinstalls from the store working — routes, schema, deps, privacy
hook, bundled skin. The full plan for the remaining ~39 baked-in apps is written (execution under
way — see the wave-progress stamp in §3):
[docs/apps/swarm-store-migration-plan.md](apps/swarm-store-migration-plan.md). Resume order:

### 1. Operator decisions blocking Wave 0
- **Kernel sign-off — ✅ DONE 2026-07-13 (the operator approved both lists as proposed):** (a) the six
  never-carve apps (jarvis, oshal-engineering, oshal-dev, security-center, workflow-studio,
  codex-packer); (b) the Tier-0b kernel-SKILLS list (voice TTS/STT, notifications, RAG, storage,
  deck-gen, graph, scheduling, memory, tool-registry, media-gen) INCLUDING the surface rule —
  `presentations`/`storage` carve their SURFACE only, engines stay kernel. Stamped in the
  migration plan §2. **Wave 1 now waits only on D1.**
  ⚠ Process note (operator, 2026-07-13): future decision asks of this kind must come with a
  **cost/benefit view per option** — what he gains/loses by picking each — not just the lists.
- **D1 bot-container model — ✅ DONE 2026-07-13: [ADR-093](adr/093-packaged-app-runtime-placement.md).**
  Staged tiers, minimum framework change (operator's explicit caution): inline-concierge for
  reason-only bots (exists), package-shipped compose fragment for heavy bots (INTERIM,
  operator-applied, first-party only), generic node pool = TARGET requiring its own go/no-go.
  Per O5 the same tiers govern skill-declared infra (the skill-declared-server case).

### 1b. ADR-090 — the skill model ✅ ACCEPTED 2026-07-13 (O1–O8 all resolved per the decision slate — resolutions inline in the ADR; nothing built yet)

[ADR-090](adr/090-skills-as-first-class-packages.md). Skills get **three origins**
(kernel / skill-package / app-private) and **two orthogonal axes**: **visibility** (who may
DEPEND — private|internal|public) vs **authorization** (who may CALL — ADR-087 accessRoles +
capability scoping + confirm gates). This resolves the app-introduced shareable skill (publish it as a *skill package*
beside the app so a 2nd app can require it, instead of an unresolvable dependency tree) and the
uber-eats one-off (app-private). The resolver/ref-count/reverse-dep machinery already exists.

**Evidence to decide against:** [docs/apps/skill-registry.md](apps/skill-registry.md) — every
skill, its consumers, a proposed tier, plus the app→skill matrix. Regenerate after any carve with
`node scripts/skill-inventory.js`.

**Decisions (all resolved by the operator 2026-07-13 — see ADR-090 "Decision revision"):** **O1 →**
keep "skill" for this concept; ADR-089's feature is renamed "Agent-Skills import" (rename sweep owed).
**O4 →** default `callableBy` = operator-only for skills (kernel skills declare themselves broader).
**O6 →** third-party store packages get a **scoped per-app RLS-bound facade**, never the raw `ctx.pool`;
first-party keeps the raw pool during migration. **Remaining build task (not a decision):** confirm each
proposed tier and do the manual bots/tools pass for the route-less apps the derivation can't see — gated
on the per-wave go, nothing built yet.

### 2. Wave 0 framework gaps — ✅ COMPLETE 2026-07-14

D2, D3, D4, D5, D6, D8, D9, D10, D11, D12 are all closed. Only the **optional** D7 remains, and it
is not a carve blocker. **Wave 1 is unblocked and waits only on the per-wave go.**

Three of these turned out not to be gaps at all but LIVE BUGS or wrong specifications — worth
reading before trusting any remaining backlog entry at face value:
- **D11** — a live cross-app tool mis-routing in production (the shopping concierge was calling the
  travel endpoint).
- **D2** — eight manifests were misdeclaring their auth, and the specified two-value enum could not
  express what the code actually does.
- **D9** — the fix was NOT the shell-JS injection the backlog specified, and should not have been.
- **~~D8 — kernel-skills contract (HIGH, silent-breakage class)~~ ✅ DONE 2026-07-13.** The kernel's
  package-facing API is now **declared, pinned, and CI-enforced** — it was accidental before
  (`tsconfig.server.json` excludes `src/features/**`, so a feature reaches `dist/` only if a *core*
  file imports it; this silently ate `google-calendar`, then `notifications`).
  - **Declared:** [`src/shared/kernel-skills/registry.ts`](../src/shared/kernel-skills/registry.ts)
    — the ten signed-off Tier-0b skills (10 skills / 16 modules), each with the `@/…` specifier a
    package imports and the `distFile` the guard asserts. Single source of truth.
  - **Pinned:** [`src/app/composition/kernel-skills.ts`](../src/app/composition/kernel-skills.ts)
    re-exports every declared module (namespace re-exports — a flat `export *` would collide).
    Replaces the `package-feature-anchors.ts` stopgap (deleted). *Note: "explicit tsconfig includes"
    from the original plan is a **no-op** — `exclude` filters `include`, so the import graph is the
    only reliable pin. Documented rather than built.*
  - **Guarded:** [`scripts/check-kernel-skills.ts`](../scripts/check-kernel-skills.ts) — phase 1
    (source: every declared skill is anchored, no build needed) + phase 2 (`--dist` / `--image`:
    every module is really in the built image). Wired as ci-local gates `kernel-skills` +
    `kernel-skills-image` (after image-build) and the Actions TypeCheck job.
  - **Proven both ways:** with the anchor, `notifications` = 9 files in dist; drop the one anchor
    line and rebuild → **0 files**, and the guard fails (exit 1) naming the skill and the fix.
    40 unit tests in `tests/unit/kernel-skills.spec.ts`.
  - **Manifest `uses:`** added (`SwarmAppManifest.uses`), validated **fail-closed** in `readManifest`
    — an unknown skill id dies at load, not at mount. `oshal-app validate` checks shape + warns on
    the `presentations`-as-a-dependency mistake (skill ids deliberately not re-listed in the JS CLI
    — a second source of truth would drift).
  - **LM corrected** (store repo, v1.0.5): `dependencies.apps: [presentations]` → `uses:
    [deck-generation, voice, rag, tool-registry, storage]`, derived from what the package's code
    *actually imports*, not its description (it also imports `llm-provider` and `storage-target`).
  - **Contract doc:** [docs/apps/kernel-skills.md](apps/kernel-skills.md).
  - **Follow-up (small):** LM's package must be rebuilt+reinstalled for the v1.0.5 manifest to reach
    the deployed swarm; `dependencies.apps: []` there is now correct but the *installed* row still
    carries the old `[presentations]` until then. Harmless — the resolver treats a stale app-dep as a
    no-op, and as of 2026-07-19 `presentations` is itself a carved store package (surface `775d76c7`),
    with the deck-gen ENGINE staying kernel per the surface-only rule.
- **~~D6 — restore LM's data~~ ⚠ CLOSED AS DATA LOSS 2026-07-13 (@lm-demo-session). DO NOT retry
  the restore.** `c:/Projects/oshal-lm-db-backup-2026-07-10.sql` is **RLS-TRUNCATED and unusable** —
  it was taken as an RLS-subject role, so `pg_dump` hit FORCE ROW LEVEL SECURITY on `lm_classes`,
  wrote its error *into* the dump, and the truncated file looked plausible (only ~7 synthetic rows
  captured). The pre-reset LM data is **gone**; surviving material/lecture FILES were salvaged from
  the workspace volume to `c:/Projects/oshal-lm-recovered-2026-07-13/`. The app is seeded with demo
  classes instead (`little-monsters/scripts/seed-demo-classes.js`).
  **The rule this bought, MANDATORY for every wave carve-out:** back up with
  **`bash scripts/oshal-app-backup.sh <prefix> <out.sql>`** (superuser dump + loud parity check) —
  **never a bare `pg_dump` as `oshal_app`**. No `VERIFIED` output = no drop. A verified LM backup now
  exists at `c:/Projects/oshal-lm-backup-verified-2026-07-13.sql`.
- **~~D2 manifest `auth:` per route~~ ✅ DONE 2026-07-14 — and the manifests were LYING about their auth.**
  Auth is opt-in per route here, so an Express route is publicly callable unless something wraps it.
  The mounter knew exactly ONE posture (plain OIDC), which is why `serviceSecretOr` apps could not
  carve: carving one would have re-authed it and 401'd every bot node, the headless CLI, and its own
  in-container tools.
  **FIVE modes shipped, not the backlog's two** (and not four — a fourth still can't express it):
  `oidc` (default, applied on omission) | `service-or-oidc` | `service` | `operator` | `public`.
  `service` (secret REQUIRED, no OIDC fallback) is a real posture — `/api/apply` and `/api/lora`
  ingest, whose mount is literally commented "service-secret authed (no OIDC)". Collapsing it into
  `public` would re-create the exact lie the field exists to kill.
  **Eight manifests misdeclared their auth** (`requiresAuth: true` against `serviceSecretOr` mounts:
  eats, kalshi, purchasing, rides, spotify, trading×3, travel); `security` is really operator-gated;
  `world` is really anonymous + self-guarded. Harmless only because a manifest's route block is
  informational until the app carves — at which point it becomes a 401 storm. All 16 reconciled, and
  **a standing test fails CI if a declared mode drifts from its real `server.ts` mount, BEFORE the
  carve.**
  **Fail-closed throughout:** unknown mode → throw at load (and resolve to `oidc`, never `public`, if
  one reaches the mounter another way); `auth` contradicting the legacy `requiresAuth` → throw;
  `auth: public` must sit ≥2 segments under `/api/` (the package dispatcher runs BEFORE core's own
  `/api` mounts and could otherwise shadow them unauthenticated). Modules sharing a `mountPath` must
  agree on the mode — the mounter runs each entry's guards as it walks the chain, so mixed modes let a
  stricter sibling reject requests bound for a laxer one purely by declaration order (`/api/lora` is
  exactly that shape).
  **Caller identity:** under `service`/`service-or-oidc` a valid secret passes WITHOUT populating
  `req.oidc`, so a carved app reading `getCaller()` would see a null sub and mis-scope its
  `user_sub`-keyed store (the ADR-036 failure mode). The mounter now resolves `oshalCallerSub`.
  **Side-effects:** `swarm-apps-build/` joined the CI manifest gate (the variant dirs had ZERO
  coverage — these fail-closed checks would first have fired at `POST /api/swarm/apps/load`, in
  production). That immediately exposed `swarm-apps-little-monsters/` as **dead** — a pre-carve
  leftover whose personas the carve had already deleted, so it could not load. Removed.
  **Still open (small):** the Security Center route scanner (`route-audit.ts`) only reads
  `server.ts`, so dynamically-mounted package routes are invisible to it — as apps carve, its
  `route_auth` coverage decays silently. It should walk the manifests and raise a finding for any
  `public` route not on PUBLIC_BY_DESIGN.
- **~~D3 manifest bot `accessRoles`~~ ✅ DONE 2026-07-14 (ADR-087 parity).** Core bots could be scoped
  to caller roles since ADR-087; packaged bots could NOT — the registrar's mapper silently **dropped**
  the field, so a manifest bot was open to every caller, **Jarvis included**, whatever its manifest
  said. Three things had to be true for the field to be real rather than decorative:
  1. **The mapper must carry it.** `server.ts`'s manifest-bot registrar mapped agentId/name/role/
     capabilities/harness and dropped everything else.
  2. **Most-restrictive-wins.** `getActiveRegistry()` concatenates the statics with the dynamic app
     bots, so ONE agentId can carry TWO definitions — and `isBotAccessibleTo` used `find()`, which
     takes the first: the statics. That cut both ways. A packaged bot's scoping was ignored, **and a
     package could WIDEN a core bot's reach** by re-declaring its agentId with no roles. Every
     matching definition must now permit the caller, so a package can only ever narrow.
  3. **Register before the DB row.** `activate()` wrote the `agents` row and only then registered the
     bot. Scoping is enforced from the REGISTRY, and an agentId the registry doesn't know is open to
     every caller — so during that window a bot scoped AWAY from Jarvis was reachable BY Jarvis,
     while already being an eligible call-out candidate.

  Validation is fail-closed: an unknown role throws, and so does an **empty** list — `accessRoles:`
  with no values parses to **null** in YAML, the likeliest author typo and the one that would
  otherwise read as "no restrictions", the exact opposite of the intent. Omitting the key entirely
  still means open to every caller (ADR-087's backward-compat contract, unchanged).
  **Still open (small):** the resolved-owner re-check after call-out resolution, and persisting
  `accessRoles` onto the `agents` row so scoping survives a registry-cold boot.
- **~~D4 manifest `guestTier`~~ ✅ DONE 2026-07-14 — a REQUEST, not a grant.** Core hardcoded each
  app's guest tier in the capability matrix, which is exactly the coupling the store migration exists
  to remove. A manifest now declares `guestTier: full | readonly | blocked` — and it **grants
  nothing**. Guests are UNAUTHENTICATED: if a package could set its own tier, installing one would
  silently widen what an anonymous visitor reaches, and `full` includes **writes**. An app cannot be
  trusted to decide how much of itself to expose to the public; the deployment's owner decides
  (operator decision 2026-07-13).
  Only `PATCH /api/swarm/apps/:name/guest-tier` (**operator-only**) grants it, persisted in
  `swarm_applications.guest_tier_approved` (migration **076**, CHECK-constrained). Unapproved — the
  default, and the state of every app installed before 076 — means the safe Tier-B default: guests
  read, every mutation blocked. Nothing in the load path can write the approval; the service reads it
  off the DB row, never off the manifest. Core's lists are checked FIRST and win, so a package can
  contribute a tier for a segment core doesn't claim but can never unlock a core Tier-C app
  (`payments`) or lock down a core Tier-A one. Deactivate / uninstall / revoke all retract it.
- **~~D5 permanent CI fixture~~ ✅ DONE 2026-07-14.** Shared specs were fixtured on a REAL app:
  little-monsters, then re-pointed to `gov-contracting` when LM carved — and gov-contracting is
  itself a Wave-1 carve candidate, so it was about to break a **third** time (the retired ops surface was no
  safer). That treadmill has no end, because the whole point of the migration is that ANY product app
  can carve.
  **`tests/fixtures/swarm-apps/oshal-ci-fixture.yaml`** is a permanent fixture app: not a product,
  ships no code, can never carve. Loaded ONLY by the test server via the new **`SWARM_APPS_EXTRA_DIRS`**
  (unset in production, so it never reaches a real swarm). `swarm-apps-framework.spec` is re-fixtured
  onto it plus `oshal-engineering` (kernel-RESIDENT — one of the signed-off never-carve six).
  It also now points at the Playwright-managed server instead of the live docker stack, so it
  actually **runs**: it had been silently skipping in CI, and wasn't even in the green suite. Added.
- **~~D7 (OPTIONAL — the only Wave 0 item left)~~ ✅ DONE 2026-08-01.** `install-remote` API endpoint + cockpit Discover
  surface. Was NOT a carve blocker (`oshal-app install` already pulled a package on the CLI) —
  built as the in-cockpit "browse and one-click install" affordance it was specified to be.
  **Built:** `GET /api/swarm/apps/catalog` serves the store repo's machine-derived
  `marketplace.json` (OSHAL_STORE_TOKEN honored, same env-only posture as the update-check
  daemon; an absent token against a private store degrades HONESTLY to `available:false` with a
  reason — never an error loop) and **operator-only** `POST /api/swarm/apps/install-remote`
  installs by name with the repo/ref/path pinned to the CATALOG entry — never caller-supplied,
  so the endpoint can only install what the store publishes, and only entries the store marks
  `status: ready`. Fetch/validate/stage rides the existing `scripts/oshal-app.js install` rail
  (sparse clone, package validation, npm-style dep resolution, provenance stamp) into
  `deployed-apps/`, registration rides the same `SwarmAppService.loadApp` as every other
  install path, owner stamped from the session (the LM RLS lesson). The `/applications/` page
  grew the **Discover** section: store rows (name/suite/version/description straight from the
  catalog API, never hand-typed) minus the installed set, suite-shelved like the installed
  list, one-click Install with the operator-chrome convention. Guards:
  `tests/unit/app-store-remote.spec.ts` (catalog parse fail-soft-per-row/fail-closed-per-doc,
  honest private-store degrade, catalog-pinned install fail-closed shapes, 403-before-installer
  for non-operators).
- **~~D9 — package shell-JS injection~~ ✅ DONE 2026-07-13 — but NOT as specified. We did not build
  shell-JS injection, and should not.** Operator decision 2026-07-13: **a package never runs
  JavaScript in the cockpit's authenticated origin.** Such a script could read any DOM content and
  call any API as the signed-in user; auth-gating the script FILE (the backlog's implied mitigation)
  does not constrain what the file DOES once the browser runs it, and CSP is no help either — it is
  off by default and `script-src 'self'` would explicitly permit a same-origin package script. JS is
  also not symmetric with CSS: removing a `<script>` element does not undo what it executed, so the
  planned "applied/removed with the transient skin" teardown was false comfort.
  **Built instead:** manifest `ui.assistant` (label/icon/iframeUrl/title) — the FRAMEWORK renders the
  floating bubble; `readManifest` fails closed on any iframeUrl that isn't same-origin + root-relative,
  and the cockpit re-checks at the point of use. Emitted only for an ACTIVE app.
  **The other half of the bug wasn't shell-JS at all:** "the generic chat rail is back" is
  `ribbon.hideChatPanel`, a field that has worked end-to-end all along — the LM package simply never
  set it. Building a supply-chain-risky mechanism for that would have been a mistake.
  LM v1.0.6 (store `2e03079`): assistant + hideChatPanel declared, `ui/lm-concierge.js` DELETED.
  ⚠ Needs a package rebuild+reinstall to reach the deployed swarm.
- **D10 — `OSHAL_APP_PACKAGE_DIR` is process-global — ✅ FIXED 2026-07-12 evening.** The mounter
  now hands every package factory a per-package context carrying `ctx.appPackageDir`
  (manifest-route-mounter.ts; `AppContext.appPackageDir` optional field); the env var remains a
  documented load-time-only channel. LM v1.0.3 (store 56e3814) captures at factory time —
  serveFile/voice/games no longer read env per-request; BUILDING-EXTENSIONS.md documents the rule.
  Done-when met in tests: manifest-route-mounter.spec.ts mounts TWO asset-serving packages and
  proves each serves its own dir while the env var demonstrably points at the last one.
  Remaining: the DEPLOYED LM package updates on the next reinstall (deployed-apps/ in the
  container still carries v1.0.2 until then — harmless while LM is the only asset-serving app).
- **~~D11 — tools/connectors ref-count graph~~ ✅ DONE 2026-07-13 — and it was hiding a LIVE BUG.**
  **The live bug (fixed):** tool names are GLOBAL — `runtime_tool_executors` is keyed by `tool_name`
  and upserted `ON CONFLICT DO UPDATE` — so two manifests declaring one name means whichever loads
  LAST silently owns the executor, and load order is `readdirSync` (alphabetical). `purchasing.yaml`
  and `travel.yaml` BOTH declared `explain-pick`, with different endpoints; travel sorted last.
  Verified in the running database: `explain-pick → POST /api/travel/chat`. The **shopping**
  concierge's explain-pick was calling the **travel** endpoint in production, and a unit test
  asserted the collision as correct. Renamed travel's tool → `explain-travel-pick`; live rows
  repaired and re-verified.
  **Two corrections to the backlog's own plan, both load-bearing:** (a) **the ownership anchors are
  not anchors** — `tools.registered_by` is written on INSERT only (first-writer-wins) while the
  `swarm-app:<name>` tag IS in the update field map (last-writer-wins): the two *disagree* under a
  collision, and neither is multi-valued. `swarm_applications.tool_names` is polluted by
  `ui.static[].toolName` (ribbon surface ids). Ownership is therefore derived from the ACTIVE
  MANIFESTS at query time and from nothing else. (b) **A tool dependent must BLOCK an uninstall,
  never RETAIN the tool** — retention-by-dependent (which done-when 3 implied) would let any
  installed package, third-party included, pin another app's executor alive past its owner's removal
  simply by naming it, leaving a runnable executor with no owning app. Under `--force` the tool goes
  with its owner.
  **Built:** uniqueness — not provider ref-counting — is the invariant. `loadApp` fails CLOSED on a
  tool name another ACTIVE app provides, so teardown can never strand a survivor and no package can
  co-opt a core tool's name; provider ref-counting would have shipped dead paths. Teardown still
  refuses to remove a tool another active app provides (defence in depth for a pre-guard database).
  `dependencies.tools` fails closed but RESILIENTLY — the registry read is best-effort, because a
  90s bootstrap timeout must not fail-close all 42 apps. `uninstallImpact` returns `toolsProvided` /
  `toolDependents` and the DELETE 409 names the stranded tools.
  **The second write door, closed:** `POST /api/tools/runtime/register` and
  `DELETE /api/tools/runtime/:toolName` sit behind `serviceSecretOr(requiresAuth)` — reachable by ANY
  signed-in user and EVERY bot node — and went straight past manifest ownership (POST repointed an
  app's tool at an arbitrary endpoint or CLI command; DELETE removed it outright). Both now 409,
  naming the owning app. Without this the rest of D11 would have been theatre.
  **Connector ref-counting — OUT OF SCOPE** (done-when 4): apps *cannot provide* connectors today
  (fixed core spec dirs; no manifest field for a package spec dir), so there is no second owner to
  count. `dependencies.connectors` stays a needs-declaration plus the UI allow-list. Revisit only if
  a `connectorsDir:` manifest field lands — the tool machinery then applies verbatim, since connector
  spec tools already live in the same `tools` table.
  **~~Still open (small)~~ ✅ CLOSED 2026-08-01:** `oshal-app uninstall`'s impact scan now mirrors
  the server's tool semantics (done-when 6): provided = the manifest's `tools[].name` ONLY (never
  `ui.static[].toolName` — the server's `providedToolNames` line), other installed packages'
  `dependencies.tools` intersections are tool dependents, and they BLOCK absent `--force` — never
  retain (guard: `tests/unit/oshal-app-cli-impact.spec.ts`, real CLI runs against a temp deploy
  dir). The ADR-085 addendum recording the above corrections is written — see "Addendum — D11
  tool ownership" in [the ADR](adr/085-remote-app-packages-and-registries.md).
- **~~D12 — `toolsDir` is a declared-but-dead manifest field~~ ✅ DONE 2026-07-13 (warn now, remove
  next release — operator decision).** Nothing in core consumes `toolsDir`, so a package's bundled
  tool JS is NOT callable. The loader now WARNs on it, and the field leaves the store contract in the
  next release. Removing it outright today would have failed validation for little-monsters, which
  declares it — a breaking store change with no warning window. LM v1.0.6 already drops it.
  **Not doing (for now):** building the execution path. It would run package-supplied JS inside a bot
  node — a new security surface — for a capability no package currently needs.

### 3. Waves 1–4 per the plan
Light apps → single-surface route apps → engine/multi-bot heavies → **world + intelligent-trades
LAST (live autopilot — dedicated safety plan, market-closed windows, paper-parity soak)**.
**Done when (whole effort):** `swarm-apps/` has zero application manifests; a fresh clone boots
kernel-only; `oshal-app install` rebuilds today's 44-app swarm with data; the 5 env-gated cron
starters are manifest schedules under toggle control; ~0 app mounts left in server.ts.

**Verified 2026-07-19 (completion-day wave progress):** Waves 2–3 are EXECUTING — carved to the
store with kernel rips at HEAD: **storage** `351219d1`, **presentations/AI Office** `775d76c7`,
**home/Smart Home** `1cc38e92`, **social** `d9f45cc0` (Wave 2); **job-apply** `4fc8419d` (manifest-only
rip — the apply ENGINE stays core per ADR-093), **feeds** `183f1847` (Wave 3). Each rip removed the
manifest (+ surface/routes where the app had them) from the kernel; engines stay per the surface-only
rule (storage-target + `/api/files` browser, deck-gen, feeds-indexing cron, the heavy bot containers).
Further Wave-3 carves (cloud/identity/travel) are mid-flight in an active lane (see COLLABORATE.md) —
deliberately not stamped here.

**✅ MIGRATION COMPLETE 2026-07-19 (completion-day, final carves at HEAD):** the remaining Wave-3
surfaces carved to the store — **kalshi** `d8a4ea3c`, **world** `fd12b46f`, and **trading**
(engine-extraction `72dcd734`, zero-behavior-change, then the surface carve `ee63f201`). Two D8
orphan-module fixes followed the rips: **world** surface-html removed `4e105d2f`, **pumpkin** engine
slice removed `127947ac` (both now live in their store packages). **Kernel is down to 10
core-platform manifests** (verified `ls swarm-apps/*.yaml`): jarvis, person-model, workflow-studio,
codex-packer, oshal-dev, oshal-engineering, devops, intelligent-operations, intelligent-processing,
security. The "Done when (whole effort)" above is met in substance — `swarm-apps/` holds zero
carve-eligible *application* manifests (the 10 residual are the never-carve kernel/core-platform
manifests per §1), and `/api/vids`, `/api/video`, `/api/kalshi`, `/api/world`, `/api/trading`,
`/api/career-hunter`, `/api/storage`, `/api/presentations`, `/api/home`, `/api/social` are all
unmounted from `server.ts` (packages re-mount them). Store tag `appstore-v0.44.0`. Per the surface-only
rule, engines stay kernel (deck-gen, storage-target + `/api/files`, the trading/prediction-markets/
video-series engines, the heavy bot containers). Final deploy `52c96391` — 36/36 healthy, parity clean.

Session context for whoever resumes: memory `app-store-adr-085-state.md`, COLLABORATE.md thread
(@app-store-session), store repo `github.com/emeraldcoastsystemsgroup/oshal-applications`.

## Video Series pipeline (ADR-082) — remaining work

The pipeline (describe → write → approve → storyboard → render → assemble) is built, the conductor
is exhaustively unit-tested (17/17, zero cost), and it is deployed live. Reference:
[docs/creative-studio/video-series-pipeline.md](creative-studio/video-series-pipeline.md) and
[ADR-082](adr/082-video-series-pipeline.md). Four items remain, in value order.

### Video Series: a live run THROUGH the conductor (the acceptance test)
- **Context:** the state machine is unit-tested with stubs, and each stage (write / storyboard /
  render) was proven live *separately* — a real episode, "Spread Too Thin", was produced end to end
  once by driving the stages by hand. What has NOT run is a single `POST /api/video/series` →
  auto-write → `POST /approve` → auto-storyboard → auto-render → `done` as ONE flow through
  `advanceVideoSeries` + the reconciler.
- **Deferred because:** it spends real image + render credits and needs an explicit operator go; the
  session it was built in was cost-sensitive. It also needs a working image provider (see next item)
  and a connected render node.
- **Done when:** one short series (1 episode, 2 scenes) submitted via the API reaches series status
  `done` with a real Drive link on its episode, with NO manual stage POSTs between create and
  approve — the conductor and reconciler do everything else. Verify the produced MP4 with ffprobe
  (streams present, non-zero audio, ~0s silence).

**Verified 2026-07-19:** OPEN — conductor built + 17/17 unit + routes live; the single end-to-end flow has never run live (spends credits, needs an operator go).

### Video Series: wire the FREE ComfyUI image path — codex is a dead end (proven 2026-07-13)
- **Context:** storyboard images sit behind `StoryboardImageProvider` (codex | comfyui | vertex),
  selected by `STORYBOARD_IMAGE_PROVIDER`, failing closed. Only `vertex` (paid, per-image — this is
  what consumed the operator's GCP credits) actually runs today.
- **THE CODEX DEFAULT CANNOT WORK — do not re-attempt it as written.** The swarm's OpenAI identity is
  a **ChatGPT *subscription* OAuth**, not a platform API key. Proven empirically: `codex exec` runs
  fine on that token (exit 0), but `api.openai.com` returns **403 on `/v1/models`** and **401 on
  `/v1/images`** — recognized and *forbidden*. The ChatGPT/Codex backend and the platform API are
  different auth realms. So codex authenticates the harness but can never call the images API. This
  is a platform fact, not a bug and not a stale token (the token is healthy — see
  `swarm-credentials.ts` and the note below).
- **So the real options are only two:**
  1. **ComfyUI on the GPU box** — FREE, no new credential at all, and it is the same box that already
     runs LoRA (so a trained character LoRA could later make cast consistency exact rather than
     merely anchored). `createComfyUiImageProvider().generate` is deliberately stubbed to **throw**
     rather than return a placeholder. **This is the recommended path.**
  2. A real **platform `OPENAI_API_KEY`** with billing — an operator decision, not a code task. If one
     is ever configured, `getSwarmApiKey('openai')` already prefers a named `openAiApiKey` over the
     OAuth token, so the codex provider would light up with no code change.
- **Done when:** `COMFYUI_URL` + `COMFYUI_STORYBOARD_WORKFLOW` are set, and
  `createComfyUiImageProvider().generate` submits the workflow, polls `/history`, and returns a real
  PNG (mirroring `providers/comfyui-provider.ts`); a storyboard then runs end to end with
  `STORYBOARD_IMAGE_PROVIDER=comfyui` and costs nothing. Change the default in
  `resolveStoryboardImageProvider` from `codex` to `comfyui` at the same time, and note it in ADR-082.

**Verified 2026-07-19:** OPEN — `createComfyUiImageProvider().generate()` still throws; the `openrouter` sibling provider is PAID, not the free path.

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

### Video Series: season-level intro + assembly
- **Context:** `episode.assemble` (the node worker tool) stitches ONE episode from its clips. A
  series has a reusable intro clip and, for a multi-episode season, a season-level stitch — neither
  is wired into the pipeline. The hand-run packs used a cached `<series>-intro-FINAL.mp4` prepended
  to every episode.
- **Deferred because:** single-episode delivery was the proof target; the season assembly is a
  second pass over already-rendered episodes and not on the critical path to "it produces a video".
- **Done when:** a series with a defined intro renders each episode with the intro spliced on, and a
  `assembling` → `done` transition produces a single season file (or a playlist manifest) from the
  per-episode MP4s, driven by the conductor, with the result linked on the series row.

**Verified 2026-07-19:** OPEN — episode assemble exists node-side; season stitch not wired.

### Video Series: retire or wire the `pipeline: graph` manifest ✅ DONE 2026-07-19 — retired (header reconciled 2026-07-24)

**Verified 2026-07-24 (diagnosis fleet):** the retirement took the "remove" arm on 2026-07-19:
`swarm-apps/video.yaml` no longer exists in the kernel (video carved to the store, ADR-085 Wave 3);
the store manifest registers `pipeline: manifest-worker` with the retirement comment; ADR-082 carries
the one-line note; the conductor remains the live path. Guards: `tests/unit/video-manifest-no-graph.spec.ts`
(kernel) + the store twin.
- **Context:** `swarm-apps/video.yaml` declares a `pipeline: graph` workflow (start → write →
  approve → render → assemble → deliver) that registered correctly but is NOT the live path — the
  conductor (`series-orchestrator.ts`) is, because the graph engine discards each bot's reply and so
  cannot carry a validated, persisted script between stages (ADR-082).
- **Deferred because:** the out-of-band conductor works today and is the ADR-036-aligned pattern;
  reconciling the two is cleanup, not capability.
- **Done when:** EITHER the graph nodes are reduced to thin triggers that call the conductor's stage
  functions (so the ticket UI and the conductor agree), OR the graph block is removed from the
  manifest and the ticket is created without a graph workflow — with a one-line note in ADR-082
  recording which way it went and why. No dead `processDefinition` left registered-but-unused.

**Verified 2026-07-19:** OPEN — the dead `pipeline: graph` block is still registered unused; retire to thin triggers or wire to the conductor.

### ADR-087 access roles: the deferred layers (per-user, sandbox, manifest)
- **Context:** ADR-087 shipped the caller-role model (registry `accessRoles` + role-aware
  `TOOL_CATALOG`) gating Jarvis's tool feed, app catalog, surface chips, and the jarvis-sourced
  call-out. Three layers were deliberately deferred:
  1. **Per-user scoping** — roles are platform declarations today; the original ask was
     user-centric ("a user may not want Jarvis to see everything"). Needs a per-user allow/deny
     overlay on the same role model + a settings surface.
  2. **Sandbox-level tool enforcement** — the jarvis-bot container still mounts `/app/scripts`;
     hiding a CLI from the tool feed is prompt/routing-layer only. Hard enforcement = per-container
     mount scoping or an exec-guard in the bot sandbox.
  3. **Manifest `accessRoles:` field** — manifest-installed app bots can't declare roles yet
     (they default to accessible); the field should flow from `swarm-apps/*.yaml` into the loaded
     registry entry.
- **Hardening / cleanup (small, follow-ups found 2026-07-10):**
  4. **Dispatch-side owner re-check** — the call-out filter is the only gate; when the resolver
     returns null the dispatcher falls back to the workflow's declared `workerBot`. Safe TODAY
     because the `task` lane's fallback is `general-bot` (unscoped —
     [dispatch-routing.ts:117](../src/features/swarm-orchestration/services/dispatch-routing.ts)),
     but a one-line `isAgentAccessibleTo` re-check on the RESOLVED owner for jarvis-sourced
     tickets makes the gate survive a future default change or a manifest overriding `task`.
  5. **Fold `CALL_OUT_EXCLUDED_AGENT_IDS` into the role model** — the hardcoded ID set in
     task-call-out.ts now expresses the same idea as `accessRoles` a second way; migrate so
     exclusions have one source (mind the semantics: that set applies to ALL call-outs, roles
     are per-caller — a `'swarm'`-excluding declaration on PM/queue-bot/dev-bot covers it).
  6. **Live-proof after the next image rebuild** (the routes are compiled, so ADR-087 is not in
     the running containers yet): tool feed omits the scoped CLIs; a probe Jarvis ticket's
     BID_REQUEST exclusion list contains the scoped agent ids; record the probe here.
- **Done when:** (1) a signed-in user can hide a bot/tool from THEIR Jarvis and a scoped item no
  longer appears in their tool feed/catalog nor wins their jarvis-sourced tickets; (2) a
  jarvis-hidden CLI is not executable from inside the jarvis-bot container; (3) a manifest bot with
  `accessRoles: [operator, swarm]` is invisible to Jarvis with no registry edit; (4) items 4–6
  landed, with the post-rebuild live probe recorded in this entry.

**Verified 2026-07-19:** PARTIAL — manifest `accessRoles` (item 3, server.ts:900) + jarvis dispatch re-check (item 4) DONE; per-user overlay, sandbox enforcement, and the CALL_OUT_EXCLUDED fold-in open; the live probe (item 6) remains unrecorded.

### ~~oshal-developer: "0 work units" for query-shaped tickets~~ RESOLVED 2026-07-10
- **Was:** the dev bot reported "ticket payload contains 0 work units" for query-shaped `oshal-dev`
  tickets and did nothing (example: `ab985e3a`). **Two-layer root cause, both fixed in
  [llm-execution-handler.ts](../src/features/swarm-orchestration/services/llm-execution-handler.ts):**
  (1) `buildTaskLayer` announced "0 work unit(s)" for every whole-ticket dispatch — now frames the
  message as the single work unit; (2) the deeper half — `buildExecutionUserMessage` **never included
  `payload.text`**, so on manifest-worker dispatches (task/oshal-dev/app ticketTypes) the actual
  request was silently dropped from the prompt (probe `396da4d0`: the bot received the new framing
  but no message, and honestly reported "no concrete request in the ticket body" while the 549-char
  ask sat in `payload.text`). Whole-ticket payloads now carry a "THE TICKET — YOUR WORK UNIT" section.
- **Done-when met (probe `c36c5dfb`, 2026-07-10):** a query-shaped `oshal-dev` ticket produced a real
  investigation deliverable — the resume-link 404 root cause (route-shape mismatch:
  `GET /resume?id=&kind=` exists, `/resume/:id` does not) with file:line evidence and no code changes.
  Ticket-time `git pull` in `/app/dev-repo` also verified inside the real ticket.
- The two sibling items from 2026-07-09 were also **RESOLVED** (same investigation):
  (1) *Claude OAuth token expiry 401-escalating claude-code dispatches* — host-side
  2-hourly keepalive ("OSHAL Claude token keepalive" scheduled task →
  [scripts/claude-token-keepalive.ps1](../scripts/claude-token-keepalive.ps1) → direct refresh grant
  in [scripts/claude-token-refresh.js](../scripts/claude-token-refresh.js)); live-verified 3.5h→8h
  with instant propagation into the ro-mounted containers. (2) *dev-repo ticket-time git auth* —
  helper was global-only and the codex harness runs tickets with `HOME=<workspace>/.codex-home`;
  now repo-local + a container-local `/run/oshal-dev-token` fallback
  ([scripts/bot-entrypoint.sh](../scripts/bot-entrypoint.sh)).
  Full operator detail: [runbooks/claude-auth-and-token-keepalive.md](runbooks/claude-auth-and-token-keepalive.md).

### ~~career-hunter: resume links 404 — route-shape mismatch (found by the dev bot, 2026-07-10)~~ ✅ DONE 2026-07-12
- **Was:** the dev bot's investigation (ticket `c36c5dfb`) root-caused the user-reported broken
  resume links: the API defines `GET /api/career-hunter/resume?id=<postingId>&kind=resume|cover`
  (`career-hunter-routes.ts`, now in the [oshal-applications store](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter) per ADR-085) but circulated links
  (digest emails / bot-written text) use the path shape `/api/career-hunter/resume/<id>`, which
  matched no route → 404.
- **Fixed (commit e653d537):** `GET /resume/:id` alias added, registered LAST so the static
  `/resume/doc|guide|save|upload|state` routes keep precedence; serving logic shared via
  `serveResumeFile()` so both shapes are one code path. Regression-locked by
  `career-hunter-resume-alias.spec.ts` (packaged with the store carve; 4/4:
  path shape routes, query shape unchanged, non-numeric id → 400, no shadowing of /resume/state).
  A signed-in browser click on a previously-broken link is the remaining nicety, not a gate —
  the spec proves the route now matches and serves through the same scoped file logic.

### career-hunter: move per-posting scoring off the api (swarm-controller) onto a bot-node ⬜ NOT STARTED (long-term)
- **Why:** career-hunter's `score`/`match`/`tailor` engine runs a **per-posting `codex exec` fan-out
  inside the `oshal-local-api` container** (the swarm controller) — it shells out via
  `scripts/oshal-jobhunter.js` → `python -m jobhunter`. This violates the CLAUDE.md invariant "the
  **controller never calls an LLM**; bot nodes own all LLM execution." It also means cost is not
  captured in `chat_tasks`, and per-bot harness/model settings don't apply — the ADR-036
  "bot owns its domain" rails are bypassed.
- **Interim mitigation already shipped (commit 26592cce, 2026-07-15):** `POST /run/:verb` was
  `spawnSync` and **blocked the whole Node event loop for the entire multi-minute run** — a single
  third-party `/run/{match,score}` (the board "Build my board" onboarding) took the front end down
  for ~76 min. Now async + awaited (event loop stays free), guarded by per-user+verb single-flight
  (409) and a global ceiling `CAREER_HUNTER_MAX_RUNS` (default 3 → 429). This **bounds** the blast
  radius; it does not move the LLM work off the controller.
- **Also latent (same file):** `/companies-admin/seturl`, `/strengthen`, `/strengthen/:key/status`,
  `/applications/:id/approve` still call the blocking `runCli` (spawnSync). Bounded/admin/quick today,
  but move any that can grow to a multi-second LLM run to the async `runCliAwait`.
- **Done-when:** career-hunter scoring/tailoring runs on a real career bot-node (own container +
  registry + persona, heartbeating) reached via `BotNodeClient.execute` (interactive) or a dedicated
  `ticketType`+workflow (scheduled), per [ADR-036](adr/036-bot-owned-application-architecture.md);
  the api container spawns **zero** `codex`/LLM subprocesses for career-hunter; cost lands in
  `chat_tasks`; the `/run/:verb` route becomes a thin dispatch to the bot (no engine spawn). The
  native "jobs 2026" app is unaffected — this is only the OSHAL swarm surface.

**Verified 2026-07-19:** OPEN — jobhunter score still spawnSync's Python on the api; latent spawnSync callers also in apply-submit.ts + apply-ingest-routes.ts.

**Verified 2026-07-19 (completion-day):** the **event-loop wedge CLASS is closed** by `555fc679` — supersedes the OPEN stamp's spawnSync clause. Every remaining latent sync child_process on the api process was moved async: `apply-submit.ts` (`runApply` spawnSync → async `runApplyCli`, single-flight per user + `APPLY_MAX_DISPATCHES` ceiling), `apply-ingest-routes.ts` (`/ingest` record+trace), the security `dependency-scanner`/`trivy-scanner` (execFileSync `npm audit` / 15-min image scan → async), and `trading-strategy-lab-ops` `buildSha`. Guard `tests/unit/no-sync-spawn-on-api.spec.ts` statically forbids sync child_process in `src/**` outside a justified allowlist (dev-console dev-node runtime + the ~100ms bounded secret-scanner walk). The original career-hunter `/run/score` offender was separately **carved to the oshal-applications store** (ADR-085 Wave 3 carve #1 — `/api/career-hunter` unmounted from `server.ts`), so it no longer spawns on the kernel api; the deeper done-when (career-hunter LLM work on a real bot-node with cost in `chat_tasks`) now belongs to the store package per ADR-093.

### career-hunter apply automation: "learn the 5 patterns" recipe-runner (native + swarm) ⬜ IN PROGRESS (native quick wins done 2026-07-16)
- **Problem (operator):** auto-apply is slow — an LLM agent drives the browser one screenshot-and-decision at a time. The same ~5 ATS patterns (Greenhouse/Ashby automated; Workday/Lever/embedded/custom parked) get re-derived per application instead of replayed.
- **Two systems.** The LIVE one is the native "Jobs 2026" app (`C:\Users\you\OneDrive\Documents\Jobs 2026\job-hunter\_autoapply`, **NOT** git-tracked): JS injection via `driver.py` + `gh_fill.js`/`ashby_fill.js`, `getcode.sh` → this repo's `scripts/oshal-gmail.js` for the Gmail code. The go-forward is the in-repo swarm `apply-operator` (`packages/apply-operator-mcp` vision loop, no JS injection, ASSIST-gated, paused) that the Jobs-2026 cutover replaces it with. Operator chose **"Both."**
- **Done (native, 2026-07-16 — OneDrive, not git):** `driver.py` adaptive `nav` (returns on title-settle vs a blind 4s) + **auto-shot after every ACT command** (act+observe in one call — ~half the vision round-trips) + env knobs (`APPLY_NAV_WAIT`/`APPLY_JS_WAIT`/`APPLY_CONSOLE_WAIT`/`APPLY_AUTOSHOT`). Backup `driver.py.bak-20260715`; `WORKER_BRIEF.md` + `_autoapply/README.md` document the new driver contract.
- **Operator decisions (2026-07-16):** (a) recipe-runner **keeps today's auto-submit** on the proven patterns (Greenhouse/Ashby); (b) Workday accounts may be created **fully unattended** — the `WORKER_BRIEF` "do NOT create accounts unattended" guardrail is **lifted** for Workday, with the caveat the operator accepted: the bot creates real employer-portal accounts that persist until deleted by hand.
- **Done (swarm, git — the two Workday gates, both live-verified):**
  1. `scripts/oshal-gmail.js verify` (commit `f39b6a0e`) — reads the message **body** (the digest path is `format=metadata`, so an activation LINK was invisible; Workday sends a link, not a code), extracts code **or** link, **bounded poll** instead of the one-shot race, recency enforced client-side off `internalDate` because Gmail's `newer_than:` only understands d/m/y (the swarm's `newer_than:1h` was silently not an hour). Emits only the token, never the body. 8 tests.
  2. `ats_site_credentials` + `scripts/oshal-site-creds.js` (commit `be2abaf1`) — per-(user,site) login store, AES-256-GCM envelope, FORCE-RLS owner-or-operator policy **live-proven isolating** (userB sees 0 of userA's rows). `gen|put|get|list`; `list` never returns secrets. 9 tests.
- **To build — native `run_apply.py` recipe-runner:** recognize ATS by URL host → replay `gh_fill.js`/`ashby_fill.js` deterministically (no model in the loop) → LLM fallback only on a novel form → call `oshal-gmail.js verify` for the code/link step. Auto-submit per the decision above. OUTWARD-FACING (submits real applications).
- **To build — Workday:** signup via `oshal-site-creds put --generate` + `oshal-gmail.js verify --from <tenant>` for the activation link, then login+apply. ⚠ The remaining hard part is NOT the submit — it is the **work-history parse-correction grid** (Workday re-parses the résumé into editable rows; that is the 40–80-screenshot cost). Needs a **live tuning pass on the operator's machine** — selectors/grid behavior can't be derived from here.
- **To build — swarm recipe-cache:** clone the proven `packages/oshal-vids-operator` recipe + self-heal engine into a new `packages/oshal-apply-operator/`; fingerprint (host + DOM markers + form signature) → replay → learn-back on `/api/apply/ingest result=applied`; recipes store selectors + rule-answers ONLY, never PII; family-generic recipes shareable, learned variants `OSHAL_USER_SUB`-scoped; assist-gate preserved, auto-submit a separate per-ATS-family opt-in. Depends on the JS-injection/CDP decision.
- **Done-when:** the 5 known patterns apply with zero model round-trips (recipe replay); novel forms fall back to vision AND get learned; the Gmail-code step polls; native + swarm share the recipe schema so the cutover inherits it.

**Verified 2026-07-19:** OPEN — no recipe-runner / `packages/oshal-apply-operator` in the repo (only `apply-operator-mcp` browser control); the native `_autoapply` lives outside git.

### ~~Re-enable CI after the GitHub Actions billing fix — and prove one green scheduled run~~ DONE 2026-07-09 — then SUPERSEDED same day — then RE-ENABLED MANUAL-ONLY same evening
**Re-enabled 2026-07-09 evening (operator decision — the operator paid the billing hold):**
`.github/workflows/ci.yml` restored from the archive with **`workflow_dispatch` + `pull_request`
triggers ONLY — no `push:`, no `schedule:` cron.** Automatic/per-push runs are what burned the
free minutes at this repo's push cadence; CI now runs only on an explicit "Run workflow" (or via
`gh workflow run CI`). `deploy.yml` + `firetv-android.yml` stay archived. The local gates
(`scripts/ci-local.sh` + daily "OSHAL Local CI" task) remain the AUTOMATIC daily signal —
see [runbooks/local-ci.md](runbooks/local-ci.md); GitHub CI is the on-demand cloud check.
**(Historical) Superseded 2026-07-09 morning (operator decision):** the billed runs (~$15 against
already-exhausted free minutes) ended it — GitHub Actions retired entirely, workflows disabled
server-side, files archived to `docs/archive/github-actions-retired/`.
Done-when met: run 29048082693 (workflow_dispatch on ca89e5e8) concluded **fully green — all
7 jobs — the first green CI run in the repo's history.** Getting there took, in order: billing
unblocked (operator) + propagation lag; 2 never-runner-proven e2e specs quarantined (below);
the unbuildable Dockerfile.bot step dropped; ~20GB runner-disk freed for Trivy's image export;
bundled npm 10→11 in Dockerfile.oshal (12 fixable HIGHs); Trivy gate scoped past vendored
/usr/local/bin binaries (21 upstream-compiled HIGHs, no release to bump to). Daily cron
15:00 UTC is live and fits the free-minute tier.
- **Context (2026-07-08):** every CI job on every push was dying at start with GitHub's
  billing error ("recent account payments have failed or your spending limit needs to be
  increased") — `emeraldcoastsystemsgroup` is a personal **user** account (not an org), so
  the fix lives at github.com/settings/billing (payment method / Actions spending limit;
  private-repo free tier is 2,000 runner-minutes/month and this pipeline burns ~45
  job-minutes/run). With 50+ pushes/day that was 100+ failure emails/day. Remediation
  shipped: CI workflow **disabled** (`gh workflow disable "CI"`) and its trigger rewired
  from per-push to a schedule + `pull_request` + `workflow_dispatch` (commit 4f484052;
  tightened to ONCE DAILY 15:00 UTC on 2026-07-09 — operator decision, ~1,350 job-min/month
  fits the 2,000 free private-repo minutes). deploy.yml's parse bug (`secrets` context in
  `environment.url`) is fixed (commit aec6977a), so it no longer mints a failed run per push.
- **Update 2026-07-09:** operator cleared the billing hold (took a few minutes to propagate);
  CI workflow re-enabled; cron tightened to once daily 15:00 UTC. Verification run
  29043394351 = the FIRST time the e2e green-ratchet gate ever executed on a runner (the
  07-06 runs died earlier, at a since-fixed unit test; then billing blocked everything).
  Result: Lint/TypeCheck/Secret-Scan/Quickstart green; e2e 482 passed / 2 failed / 1 flaky.
  The 2 failures (`agent-profile-persistence`, `firetv-tv-pairing`) were quarantined out of
  `tests/e2e-green-suite.txt` with in-file evidence notes — they were local-Windows-proven
  only, never runner-proven; fix + re-add tracked under "CI Playwright e2e suite
  normalization" below.
- **(Historical — resolved by run 29048082693, above)** These two bullets predate the first green
  run and are kept only for context. **Was — reason still open:** no CI run had ever concluded green
  in retained history (deterministic jobs passed; the e2e Test job was the documented red), and Trivy
  ran with `exit-code: 1` on CRITICAL,HIGH. **Was — done when:** one scheduled/dispatched run concludes
  fully green — **met** by run 29048082693 (all 7 jobs green). Standing guidance still applies: do
  **not** re-add a push trigger (operator decision 2026-07-08), and Trivy base-image CVEs can red a
  future run, so keep red jobs triaged to non-required/`continue-on-error` with a reason.

### deploy.yml "deploys" to the ephemeral runner, not a real environment
- **Dockerfile.bot DISPOSITIONED 2026-07-09 evening (commits 4e9a25c1 + 8ae892a5):**
  `Dockerfile.bot` DELETED (unbuildable — COPYd the removed `vite.config.js`; predated the
  single-image design) and its vestigial `build:` stanza removed from swarm-local's
  `x-bot-common` anchor. **PREMISE CORRECTION — `docker-compose.swarm-local.yml` is NOT stale
  and must NOT be deleted:** the earlier note ("its only consumer was the retired workflow")
  was wrong — it is the LIVE per-container bot compose: `oshal.sh`/`oshal.bat` set
  `SWARM_COMPOSE_FILE` to it, and `bot-container-spawner-service.ts` /
  `dynamic-compose-service.ts` / `ComposeGenerator.js` / `ProvisioningManager.js` /
  `PersonaAutoDeployer.js` manage bots through it. Its bots run the prebuilt
  `oshal-bot:latest` (built from Dockerfile.oshal); nothing ever did `up --build` against it,
  so removing the build stanza changed no behavior. What REMAINS open from this item: the
  archived deploy.yml jobs themselves (can never run while archived — delete or rebuild
  against a real host if Actions deploys are ever wanted again).
- **Context (2026-07-08):** found while fixing the deploy.yml validation bug. The
  `deploy-staging` / `deploy-production` jobs run `docker compose up` **on the GitHub
  runner itself** and health-check `localhost:3456` — the "deployment" is destroyed when
  the job's VM is reaped minutes later. Real deployment today follows `main` via the local
  hot-swap override; the workflow's deploy jobs are aspirational scaffolding from 03-29.
- **Update 2026-07-09:** same stale track owns `Dockerfile.bot` + `docker-compose.swarm-local.yml`.
  CI run 29044270678 (the first to ever reach the Docker job) proved Dockerfile.bot cannot
  build (COPYs `vite.config.js`; repo moved to `vite.config.ts`) — it predates the
  single-image design (Dockerfile.oshal + `BOT_RUNTIME`), nothing ships it, and its only
  live reference is swarm-local compose, which only deploy.yml uses. The CI "Build bot
  image" step was removed; the files remain for this item to disposition.
- **Done when:** either (a) the deploy jobs target a real persistent host (self-hosted
  runner on the operator's hardware, or SSH/tunnel to it) and a `workflow_dispatch`
  staging deploy is reachable after the run ends, or (b) the deploy jobs are deleted and
  the workflow is reduced to what's real (tag-triggered image publish), per the
  as-built-not-aspirational docs rule — and in either case `Dockerfile.bot` +
  `docker-compose.swarm-local.yml` are made buildable/real or removed with them.

**Verified 2026-07-19:** PARTIAL — Dockerfile.bot deleted, swarm-local compose kept (live); the archived deploy.yml is neither deleted nor retargeted.

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

### Dev-console sandbox: Linux userns-remap /work portability
- **Reason:** the ADR-077 `SandboxedAgentRunner` bind-mounts a `mkdtemp` (mode-0700) scratch at
  `/work`. On engines with userns-remap (GitHub Actions' Docker), container-root maps to a host
  subuid that doesn't own that dir, so every `/work` write is "Permission denied" and the
  isolation self-test reports `workWritable=false`. Authored/validated on Windows Docker Desktop
  (which doesn't remap), never on Linux. The integration specs now gate on `sandboxUsable()` (a
  real write-to-/work probe) so they run where the sandbox works and skip cleanly in CI — but the
  sandbox itself should WORK on Linux, not just skip.
- **Done when:** the runner makes `/work` writable under userns-remap (e.g. `chmod 0777` the
  scratch dir before mount, or `--user $(id -u):$(id -g)`, or a named volume) and
  `sandboxUsable()` returns true on an ubuntu-latest runner, so the dev-console integration tests
  RUN (not skip) in CI.

**Verified 2026-07-19:** PARTIAL — `sandboxUsable()` gating shipped; no chmod/`--user`/named-volume fix yet.

## Trading: queued live-parity features (2026-07-09 pre-open) — build on PAPER first, promote after soak

Both requested by the operator the night the live cap went full-account (52K). Both change the
tested algorithm's behavior, so per the live==paper parity rule neither ships straight to live:
build → paper proves it → promote. The watchdog's pre-market gap ALERT (check F) is the interim
human-in-the-loop for #1.

- **Market-wide gap-down entry filter.** Per-name blockers (short-term breakdown, news veto,
  regime gate) approximate "don't buy into a selloff", but nothing checks the WHOLE tape: if SPY
  is down ≥ X% pre-market / intraday vs prior close, the entry leg should skip the fire (defense
  legs unaffected). Threshold pre-registered, not fitted.
  **Done when:** filter in the entry path behind an env flag, ON for paper only; after ≥1 gap-down
  day where paper demonstrably skipped entries, operator flips it for live.
- **Per-position exit contract ("every buy carries its full plan" — operator, 2026-07-09).** At
  entry, stamp the position with its complete plan: entry price, stop price, take-profit price,
  trailing arm/giveback params — persisted (decision row or a positions-plan table) and displayed
  in the cockpit per open position. Exit evaluation reads the position's OWN contract, not the
  global policy — so a policy change no longer silently re-prices in-flight positions (that
  happened 07-08 when the posture flip retro-applied new stops to the whole live book; make it a
  deliberate "amend contracts" action instead). Evidence note: the 07-09 stop-width backtest
  (scripts/oshal-trading-stop-width-backtest.ts) shows exit-parameter variation moves returns ~0
  (3%..10% stops all ±0.4pp) — this feature is for TRANSPARENCY/auditability, not returns; it also
  becomes the natural home for per-name (vol-scaled) plans later.
  Operator refinements (same night): the contract is the DEFAULT plan, not a cage — event doors
  (news fast-sell, breakdown, signal flip, rotation bench) may exit early, and the ledger records
  WHICH door fired vs the plan; rotation-opened positions get a FRESH contract stamped at their own
  entry (price/stop/trail/target from that name at that moment) — automatic if stamping lives in
  the single shared entry path. Contracts SELF-RESOLVE: each carries an expiry (N sessions, N
  pre-registered and harness-tested like the stop width) — no infinitely-long positions; a name
  that neither stops, sells, nor rotates exits on the clock (kills zombie/dead-capital drift, the
  one case rotation misses when no hotter candidate is waiting). A FRESH BUY SIGNAL on a held name
  before expiry RE-UNDERWRITES the contract — re-stamped at current price/vol with a new clock;
  positions are re-earned, never grandfathered.
  **Done when:** every new paper entry writes a plan (visible via API + cockpit position view),
  exits provably honor the stored plan OR record the overriding door (ledger cross-check), policy
  changes leave existing plans untouched, rotation entries demonstrably carry fresh contracts;
  then operator promotes to live.
- **Idle-cash yield sleeve (SGOV or equivalent T-bill ETF).** Sidelined cash earns ~0 at Schwab's
  sweep by design. Park cash above a working float in an intraday-liquid T-bill ETF; entry sizing
  learns "sleeve is spendable — sell first, then buy". Worth ~$300/yr at 15% idle on 52K; the real
  payoff is sit-out stretches (2022-style: months mostly-cash) and scale ($500K trajectory →
  ~$20K/yr while sidelined). Care: the engine sizes off broker `cash`; a naive sleeve starves
  entries.
  **Done when:** paper runs the sleeve ≥1 week with entries funding correctly (ledger shows sleeve
  sells before buys), no starved entries, then operator promotes to live.

**Verified 2026-07-19:** OPEN — (a) only the per-name gap guard exists (entry-guards.ts), no market-wide SPY entry filter; (b) no per-position contract persistence/table; (c) SGOV sleeve not built (cash parked in SPY core instead).

## Market Remediation (2026-06-30 → 07-01 session)

Plan: `archive/market-remediation-swarm-plan-2026-06-29.md`. Assessment:
`archive/competitive-market-reassessment-2026-06-29.md`. Deploy/reboot: `runbooks/market-remediation.md`.
Admin console: `admin-console.md`. Shipped + tested this session (committed to main): append-only
audit (live); broad audit coverage + activity summary; RLS posture full-coverage + auditAppendOnly;
permission-aware RAG (group/tenant ingestion + connector-source ACL sync); A1.2 provisioning + the
`OSHAL_APP_ROLE_BOOTSTRAP` flag; admin console control plane (tenant CRUD + roles + connector toggle);
Workflow Studio template gallery; D4 quality gate; connector curation audit; nightly refresh.
Market score ~7.6 → ~8.0 (est.). Remaining:

### ~~Deploy the committed TS batch~~ DONE 2026-07-05
Done-when met: `oshal-bot:latest` rebuilt from committed HEAD (contains audit/posture routes,
A1.2 boot path, `owner-rls-policy` chokepoint, governance scripts) and the live api recreated
onto it (started 2026-07-05 05:46Z as `oshal_app`). Verified live: health 200, cockpit 200,
`/api/governance/posture` present + auth-gated (401 anonymous), core-4 tables FORCE-RLS'd
with policies on the live DB. Rollback image: `oshal-bot:prev`.

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

### ~~A1.2 committed-default cutover — final step~~ DONE 2026-07-04
Both done-when clauses met (commits ace8d338, 070c35fe): flag-ON fresh boot of the actual api
container enforces two-user isolation (`verify:rls` exit 0 inside the container as `oshal_app`;
evidence `docs/evidence/app-role-fresh-boot-cutover-2026-07-04.md`), and the committed api-service
`DATABASE_URL` default is flipped to `oshal_app` with `OSHAL_APP_ROLE_BOOTSTRAP` defaulting true.
As-built: `docs/runbooks/market-remediation.md` §"A1.2: as-built".

### ~~Tier-1 RLS for lazy app-store tables (A1.2 follow-up)~~ DONE 2026-07-05
Every lazy in-app DDL chokepoint that creates a 060-listed table now appends
`buildOwnerRlsPolicyStatements(table, 'user_sub')` (all 8 are tier-1 in 060 — none dual):
finance items/data/payments, merchant payments, youtube activity, trading equity-hwm + peaks;
`tv_token_revocations` additionally gained its first automated creation path
(`ensureTvRevocationSchema` in tv-pairing-routes.ts — its docker/postgres migration file was
wired to no runner). Guarded by `tests/unit/lazy-store-rls.spec.ts`; the fresh-boot "zero
060-listed tables without FORCE RLS + policy" check is covered by re-running the existing A1.2
smoke procedure (docs/evidence/app-role-fresh-boot-cutover-2026-07-04.md).

### First-run wizard + one-click installer
- **Reason:** UI + guided flow; needs browser verification.
- **Partly built (2026-07-08):** Windows has a double-click installer — `Install-OpenSwarm.bat`
  → `installer/install.ps1` — with a two-role chooser (run the swarm / join a swarm), Docker and
  Node.js bootstrap via winget, a generated `REMOTE_CLIENT_SHARED_SECRET` packed into a pasteable
  `OSJOIN1.*` join code, and the post-install verification pass. See [INSTALL.md](../INSTALL.md).
- **Done when:** clean-account provider→connector→flagship→safe-test with no docs; a guided
  installer/doctor on a clean machine. Still open: the macOS/Linux GUI equivalent, a `doctor`
  subcommand, and the in-cockpit first-run wizard (provider → connector → first ticket).

**Verified 2026-07-19:** OPEN — macOS/Linux GUI installer, standalone doctor subcommand, and the in-cockpit first-run wizard all remain (the Windows installer has a doctor panel; a welcome page exists).

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

### NOT doing: public/hosted SaaS readiness
- Deliberately out of scope — it works against the self-host / you-own-it moat. Do not chase that score.

## Active Product Polish Defects - app surfaces are not yet category-native

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

### Consumer commerce surfaces - Rides / Eats / Shopping
- **Rides:** must be map-first, ask for browser/current location, support destination
  search and scrollable ride options, and keep the concierge as a state-driving helper
  rather than a JSON/debug transcript.
- **Eats:** must behave like a food delivery app: delivery address/current location,
  cuisine/search chips, restaurant/menu browsing, one-restaurant cart, preference and
  order history, and chat that updates the same order state.
- **Shopping / Procurement:** must behave like a marketplace: shipping address/current
  location, Walmart/Amazon-style browse/search, product grid, price comparison/options,
  cart/list state, preference/history memory, and concierge-driven add/checkout.
- **Done when:** each surface supports browse/search/scroll plus chat-driven state,
  shows address/location status, persists order/cart/preferences, and hands off to the
  external merchant without claiming OSHAL charged or placed the order.
- **2026-06-23 01:56 CT update:** source surfaces now use category-native layouts
  (`rides-app.html`, `eats-app.html`, `shopping-chat.html`) and route replies pass
  through `cleanConciergeReply()` to suppress raw JSON envelopes when bots misbehave.
  Next deployment must prove the running UI matches these source files.

## Chat-channel surfaces — message your swarm on Telegram / Discord / WhatsApp 🟨 PARTIAL (Telegram inbound shipped — see 2026-07-19 stamp)

Motivation: the OpenClaw playbook (steipete, 346k★ in ~4 months) proved the demand — its whole
magic moment is "I message a bot in an app I already have open, it replies." OSHAL's cockpit is a
*destination*; a chat-channel surface is the *ambient* surface that produces screenshots and
time-to-magic in minutes. This is a **surface over the existing accountable bot** (ADR-036), NOT a
new brain: an inbound message becomes a `BotNodeClient.execute` call, the reply goes back out the
channel, cost is captured in `chat_tasks` like any other call.

**Current truth:** `swarm-apps/connectors/{telegram,discord}.yaml` exist but are **read-only REST
connectors** (GET identity/guilds) from the 306-catalog expansion — they prove auth+icon plumbing,
they are NOT conversational adapters. There is no inbound listener anywhere. `slack-bot.yaml` persona
exists but is not a wired inbound channel either.

**Verified 2026-07-19:** PARTIAL — supersedes the "NOT BUILT"/"no inbound listener anywhere" lines above: Telegram inbound SHIPPED (telegram-channel-adapter.ts + webhook + Channels card + docs/channels); Discord + WhatsApp inbound still absent.

### Channel adapter (inbound → bot → reply) — the core
- A **dedicated bot-node** (own container, real heartbeat — never an inline stub) runs an inbound
  listener per channel: Telegram long-poll/webhook, Discord gateway websocket (or interactions
  webhook), WhatsApp Cloud API webhook. Inbound message → resolve the owning `user_sub` from the
  channel identity → `BotNodeClient.execute(agentId, prompt)` → post the reply back on the channel.
- Per-user isolation is the hard part: a channel identity (Telegram chat id, Discord user id, WA
  phone) must map to exactly one OSHAL `user_sub`, and one shared demo bot must never leak one user's
  data to another's DM. Reuse the token-broker + RLS rails; do NOT invent a new identity path.
- Outbound-only proactive push (the millionaire-alarm "text me" leg) is the easy half and can land
  first: a `notify.telegram` / `notify.discord` action over the same bot token.
- **Done when:** a signed-in user links a channel, DMs the bot a real task, the accountable bot runs
  it with the user's connectors, the reply comes back in-channel, and the call shows in `chat_tasks`
  under that user — proven live for at least Telegram, with two users not seeing each other's data.

### One-click enable + "configure your own" — the demo path
- **Provider asymmetry is real and must not be glossed:** Telegram = trivial (BotFather token, no
  review). Discord = easy (application + bot token / OAuth). **WhatsApp = hard** — Meta Business
  verification, WhatsApp Business Platform number registration, pre-approved message templates, and
  the 24-hour session-window rule. WhatsApp is a "documented-but-staged, needs-operator" item like
  Alexa, not a weekend task. Do not promise one-click WhatsApp.
- "One-click" realistically = one-click **enable** of a demo bot the operator pre-registers under the
  business email (partner-app-registration rule), shipped via the per-user broker; PLUS a documented
  **BYO-bot-token** path for real users (same shape as BYOK). The test-user account is the vehicle to
  prove + screenshot the enable-then-configure flow end to end.
- **Done when:** the marketplace has a "Channels" enable card per provider, a one-click demo link for
  Telegram+Discord on the test account, and a `docs/connectors/*` page showing a real user how to
  register their own bot and paste the token. WhatsApp card is present but marked staged.

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
  [src/features/notifications/](../src/features/notifications/) — a `NotificationTransport` interface
  (`kind`/`configured()`/`send()`), a registry (`resolveTransport(kind?)` by `NOTIFY_TRANSPORT`, no-op
  fallback), and `notifyOperator(message)` as the ONE call any feature uses (trading watchdog, creative
  studio delivery, failed jobs). The first-party **Telegram** transport is fully implemented
  (sendMessage/sendVideo, 50MB → text+link fallback, no-op when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
  absent, token never surfaced in a result/error). 11 unit tests with injected fetch (no network/creds)
  ([tests/unit/notification-transport.spec.ts](../tests/unit/notification-transport.spec.ts)); tsc clean.
  This is the same pluggable-provider discipline as LLM providers + TTS (CLAUDE.md). **≥2 real impls
  DONE 2026-07-10:** the **Twilio SMS** sibling now ships too
  ([twilio-sms-transport.ts](../src/features/notifications/services/twilio-sms-transport.ts)) — Messages
  API, Basic auth, BYO-account (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER` + a
  destination), media-URL appended to the SMS body, no-op when unconfigured, auth token never surfaced.
  **THREE real transports now** (text / SMS / call): `telegram`, `twilio-sms`, and **`twilio-voice`**
  ([twilio-voice-transport.ts](../src/features/notifications/services/twilio-voice-transport.ts) —
  Calls API, inline TwiML `<Say>`, XML-escaped so the spoken text can't break/inject the TwiML, no-op
  when unconfigured, token never surfaced) — the millionaire-alarm "call me" leg. 20 unit tests total.
  **BYO-Twilio via the per-user broker + connect doc DONE 2026-07-11:** the `twilio` connect card on
  /utilities (pasted Account SID + Auth Token, Jira two-value shape, validated against the Accounts
  API before persisting encrypted), brokered to the communications-bot as `OSHAL_CRED_TWILIO`, and
  consumed by the new [scripts/oshal-twilio.js](../scripts/oshal-twilio.js) (reads:
  digest/messages/calls/numbers/account; sends: sms/call, confirm-gated
  `--confirm`/`OSHAL_MESSAGE_SEND_CONFIRM`) — the comms bot now owns email + calendar + social +
  **phone/text**. Connect doc: [docs/channels/twilio.md](channels/twilio.md).
  **FOUR real transports now — WhatsApp-via-Twilio DONE 2026-07-11:** `twilio-whatsapp`
  ([twilio-whatsapp-transport.ts](../src/features/notifications/services/twilio-whatsapp-transport.ts))
  — the SAME Messages API as SMS with the `whatsapp:` address prefix + native `MediaUrl` (WhatsApp
  carries media inline, so no link fallback), BYO the same Twilio account (`TWILIO_WHATSAPP_FROM` +
  `TWILIO_WHATSAPP_TO`/`NOTIFY_WHATSAPP_TO`), no-op when unconfigured, token never surfaced. Numbers
  accepted with or without the `whatsapp:` prefix. 11 unit tests (injected fetch, no creds); registry +
  barrel wired; `.env.example` documented. **This closes the WhatsApp gap without Meta Business
  verification** (Twilio is a sanctioned WhatsApp reseller) — the "same adapter, different endpoint"
  the done-when calls out.
  **Fan-out primitive DONE 2026-07-11:** `notifyAll(message, {kinds?})` +
  `configuredTransportKinds()` in [notification-service.ts](../src/features/notifications/services/notification-service.ts)
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

### Comms-bot phone/text — go-live wrap-up ⬜ BUILT, NOT LIVE-PROVEN (parked 2026-07-11)
- **Context:** the communications-bot's phone/text leg shipped 2026-07-11 (commit `fe80d631` — see
  the Twilio transport entry above + [docs/channels/twilio.md](channels/twilio.md)) but the session
  ended before credentials + a live smoke. Everything below is pick-up work, in order:
  1. **Credential (operator, ~2 min):** paste the Twilio **Account SID + Auth Token** into the
     "Twilio (SMS & Voice)" card at `/utilities` (from [console.twilio.com](https://console.twilio.com/)).
     The account must own **at least one phone number** or sends will fail with an actionable error.
     BYO only — never a platform key in `.env` for the bot path.
  2. **Deploy check:** `scripts/` is bind-mounted `:ro` into bot containers (CLI already live). The
     api-side changes (connect card, broker, routes) follow `main` under the hot-swap override; a
     plain api container needs a rebuild. The manifest capability change (`sms-texting`/`voice-calls`)
     needs an api restart or `POST /api/swarm/apps/load`.
  3. **Live smoke (the human-testability gate):** from cockpit chat — (a) a read: "any texts or
     calls on my Twilio?" → bot runs `oshal-twilio.js` digest and names real data; (b) a send:
     "text <own cell, E.164> saying OSHAL test" → real SMS arrives, bot reports the returned
     `sid`/status; (c) a call: "call me and say the build finished" → phone rings + speaks it.
     Confirm routing picks communications-bot (ADR-083 keywords: text/sms/call/phone).
  4. **Sanity checks while smoking:** `chat_tasks` rows record the bot's cost; exit-2 path reads
     well when NOT connected (bot says "connect at /utilities", doesn't hallucinate); auth token
     never appears in any log/response.
- **Then (already-listed follow-ons, from the transport entry above):** inbound SMS → Jarvis webhook
  channel; inbound WhatsApp chat channel; millionaire-alarm fan-out policy across transports.
- **Done when:** all three smoke legs pass from a browser as a signed-in user against the live
  stack, and the result (with the Twilio message sid) is noted in this entry or COLLABORATE.md.

**Verified 2026-07-19:** OPEN — transports coded; no live credentialed smoke evidence.

**Update 2026-07-31 (host-side credential proof):** `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`
landed in the operator's `.env` and were validated LIVE from the host — Accounts GET returned
HTTP 200, `status: active` (Trial). **The SMS live-proof is blocked exactly where step 1 warned:**
the account owns ZERO phone numbers (IncomingPhoneNumbers is empty — the free trial number was
never claimed), and `TWILIO_FROM_NUMBER`/`TWILIO_TO_NUMBER` are empty keys in `.env`. One verified
outgoing caller ID exists (the operator's cell), which is the only destination a Trial account can
text. Exactly one send was attempted and it 400'd BEFORE creating a message (no sid, no charge; not
retried). Also shipped this pass: compose now forwards `TWILIO_*` into the api service (previously
never forwarded, so the in-container transports/CLI could not see the host env at all). Next, in
order: operator claims the trial number in the Twilio console → fills `TWILIO_FROM_NUMBER` (the
claimed number) + `TWILIO_TO_NUMBER` (the verified cell) → one live SMS proof host-side → paste
SID+token into the `/utilities` Twilio card for the BYO bot path → deploy → the three-leg cockpit
smoke above.

**Update 2026-08-01 — VOICE LEG LIVE-PROVEN; SMS paused by directive.** The trial number
**+13082704875** was provisioned via the Twilio API and written to `.env` (TO = the verified
operator cell); compose now forwards `TWILIO_*`/`TELEGRAM_*` into the api (PR #75, passthrough
guard extended) and the api was recreated — env verified in-container. A live voice call was
DELIVERED and human-confirmed ("it rang", caller ID matched the provisioned number). SMS was
attempted and carrier-rejected with **error 30034** (unregistered US A2P 10DLC) — the fix is a
paid-account upgrade + campaign registration, and per operator directive 2026-08-01 that is
**PAUSED**: no further spend on the demo Twilio account; A2P registration happens on the ECSG
account after the SaaS migration (see "HUMAN: migrate platform SaaS accounts" below). Telegram:
webhook registered on the public URL, bot @The_oshal_bot answers; the operator /start link tap
is still pending. Remaining for the done-when: the three-leg cockpit browser smoke (voice will
pass; SMS waits on the migration), the BYO `/utilities` card paste, and inbound SMS.

### ~~Absorb, don't fight — import OpenClaw / markdown skills~~ ✅ BUILT 2026-07-11 (high-leverage, on-thesis)
- The operator's instinct: "take md files into our bots and absorb the thing through integration." Correct and
  cheap. OSHAL already ingests markdown into RAG (ChromaDB corpus); an OpenClaw **skill** is markdown +
  declared tool conventions. A **skill-import adapter** maps a skill's md + tools into an OSHAL persona
  + `swarm-apps/*.yaml` manifest (the packer/ADR-038 shape) so a stranger's skill runs inside a
  governed swarm.
- **This is a security feature, not just a compat feature.** OpenClaw's ClawHub marketplace had a
  ~12%-malware supply-chain incident ("ClawHavoc"). An importer MUST run every skill through the
  existing connector audit + quarantine + per-bot capability scoping — never blind-execute. The pitch
  writes itself: *"run your OpenClaw skills inside a sandbox with RLS, cost caps, and approval gates."*
- **BUILT 2026-07-11** ([ADR-089](adr/089-skill-import-adapter.md)) — a deterministic, non-interactive codex-packer. Pure FSD slice
  [src/features/skill-import/](../src/features/skill-import/) (`parseSkillMd` → `translateTools` →
  `auditSkill` → `mapSkillToPersona`/`mapSkillToManifest` → `importSkill`; no fs/network, 31 unit tests
  in `tests/unit/skill-import-{parser,audit,mapper}.spec.ts`) + CLI
  [scripts/skill-import.ts](../scripts/skill-import.ts) (reuses `serializeManifest` from the swarm-apps
  barrel). **Security realized:** bundled `scripts/` are **quarantined** (copied aside, never wired);
  `allowed-tools` + inline `mcp__*` are **translated to OSHAL tool ids and minimized** (foreign tools
  recorded, never granted; empty grant → minimal `[read_file]`, never the `[]` "unrestricted" footgun);
  a broken skill **BLOCKS** (no artifacts); a scripts/foreign-tool skill lands **`review`**; the emitted
  manifest is **`status: inactive`** so import never auto-injects. The `perspective` is the skill body
  verbatim under an OSHAL governance footer (Mode B, citations, granted-tools list, quarantine notice,
  DRY_RUN default). Doc [docs/apps/skill-import.md](apps/skill-import.md); worked example
  [docs/apps/examples/skill-import/](apps/examples/skill-import/) (real skill → emitted persona +
  manifest, the manifest verified against the real `readManifest` loader).
- **Done when (MET):** an OpenClaw-format skill imports to a runnable, capability-scoped OSHAL bot via the
  audit gate, with a doc page and one real imported example.
- **references/ → RAG ingest DONE 2026-07-12:** `--ingest-refs` on the CLI POSTs each bundled reference
  doc to `/api/rag/ingest` in the skill's own `<slug>-refs` collection, each stamped with a
  `skill:<slug>/<file>` doc_id (traceable-citation provenance, like `web:`). Pure payload builders in
  [skill-rag.ts](../src/features/skill-import/services/skill-rag.ts) (10 unit tests); the CLI path is
  proven end-to-end against the live gated endpoint (build → POST → graceful 401 → exit 3) — a
  successful ingest needs an operator PAT.
- **Remaining (follow-ups):** a cockpit "Import a skill" surface over the CLI; more foreign
  tool-vocabulary translations as skills are absorbed.

**Site/positioning note (for the marketing decision, not code):** compare to OpenClaw by *absorbing*
its vocabulary and surface, not by punching down with a feature table — a pre-release solo project
running "us vs 346k★" reads as insecure. The durable, honest contrast is the one OpenClaw structurally
can't make anymore: its creator now works for OpenAI, OpenAI pays its token bills and monetizes its
users — it became a single-vendor distribution channel. Open Swarm's neutrality means *no vendor can
absorb the layer between you and the models.* Lead with "bring the self-hosted-agent idea to work:
multi-user, isolated, metered, approval-gated," and offer "message your swarm on Telegram/Discord" as
a surface — riding their SEO instead of fighting their star count.

## Roadmap wrap-up: Argo, free-tier router, tenancy, ollama, harness naming, A2A (2026-07-08)

Operator raised six items and asked for validation before planning. **Verified against the code and
the live cluster on 2026-07-08** — most statements correct, three materially wrong. Findings first,
so nobody re-litigates the premises.

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

### Plan A — Argo locally, then a promotion pipeline 🟡 IN PROGRESS
The gaming PC is for *sustained* workloads and GPU model serving, **not** for proving Argo. Prove it on
the cluster that is already running.

**Done 2026-07-08** (see [078-argo-batch-proveout-status.md](architecture/078-argo-batch-proveout-status.md) addendum):
- ✅ `argo-workflows v4.0.7` installed; `workflow-controller` + `argo-server` Running.
- ✅ A real Workflow ran to **Succeeded** on this cluster (`argo runtime ok on this cluster`).
- ✅ `oshal-incident-rca` WorkflowTemplate **accepted by the live Argo CRD** in `tenant-a`
  (server-side apply, not `--dry-run=client`), entrypoint + 5 templates intact.
- ✅ **Cross-tenant isolation proven BOTH directions** — the deny had been one-directional
  (`tenant-b REACHED tenant-a`). Applied the ADR's symmetric deny-all + same-tenant re-grant to both
  namespaces ([tenant-network-policies.yaml](../ops/deployment/argo/tenant-network-policies.yaml));
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

### ~~Free-tier model rot — runtime discovery instead of hardcoded IDs~~ ✅ DONE 2026-07-12
**Was (found live 2026-07-08):** 2 of the 3 hardcoded OpenRouter `freeModels` had 404'd and the
platform default was 429 — "run free by default" silently returned a dead model. The 07-08 interim
fix (probe + rotate a refreshed hardcoded list) still rotted by design.
**Done (commit cf4057fd) — both done-when conditions met:**
- `platformFreeConnection` ([free-tier-rotation.ts](../src/app/routes/free-tier-rotation.ts)) now
  sources candidates from live `GET /models` discovery: `:free` suffix **AND** zero prompt+completion
  pricing (double filter — spend-safety on the now-credited shared account), family/context ranking,
  30-min catalog cache, order = `OPENROUTER_FREE_MODEL` override → last-live model → discovered rank,
  capped at 6 probes. `PLATFORM_FREE_MODELS` is deleted — no hardcoded model ids remain. The
  2026-07-11 `:free`-only override guard is preserved.
- 200-but-empty handled: platform probes require actual content (16-token probe, parse the body), so
  a reasoning model that eats the probe on hidden reasoning is rotated past instead of returned.
  User-connection probe semantics unchanged (their explicit model pick is validated for liveness only).
- `prove-free-tier-live.ts` OpenRouter lane now discovers too (was hardcoded despite its header) —
  **live PASS 2026-07-12** with only the key set: discovery → `openai/gpt-oss-20b:free` →
  "free swarm online". Unit spec 15/15 incl. catalog-sourced candidates, sneaky `:free`-suffix-but-
  priced exclusion, reasoning-model rotation, and discovery-failure → fast null (no probe burn).

### Free-by-default needs $10 of OpenRouter credit on the shared account ✅ DONE 2026-07-11
**CLOSED 2026-07-11:** operator created a fresh OpenRouter account, put the one-time **$10** on it
(confirmed live via `/api/v1/credits`: total_credits 10, usage 0 — `is_free_tier: false`), and the
new key is in `.env` + live on the api. The 1,000 `:free` requests/day ceiling is unlocked. Guarded
same day (`791286de`): `platformFreeConnection` now HARD-drops any non-`:free` candidate (including
a misconfigured `OPENROUTER_FREE_MODEL`) so the credited account can never spend — the platform key
is free-models-only by code, not convention. Original entry kept below for the numbers.
**The catch that decides whether "run free by default" is real.** OpenRouter's `:free` models are
rate-limited by the account's LIFETIME credit purchase (confirmed at openrouter.ai/docs/api-reference/limits,
2026-07-08):
- **< $10 credits: 50 `:free` requests/day** (20/min).
- **>= $10 credits: 1,000 `:free` requests/day** (20/min).

A default swarm is ~30 bots; 50 requests/day is exhausted almost instantly, so the platform-free
fallback (`OPENROUTER_API_KEY`) on a **fresh, zero-credit** account is only good for a demo — it 429s
within a handful of turns. To make "the swarm runs free for everyone" actually hold, the operator must
put a **one-time $10** on the shared OpenRouter account (it is credit, not a subscription; `:free`
models still cost $0 to run — the $10 only raises the daily ceiling and never depletes from `:free`
usage). This is an operator/cost decision, not code.
- **Note:** each USER connecting their OWN OpenRouter key (or Groq/Gemini/etc. free tier) gets their
  own per-account limit, so heavy users should still connect their own — the shared key is the
  zero-setup floor, not the ceiling.
- **Done when:** the shared `OPENROUTER_API_KEY` account has >= $10 credit (1,000/day unlocked), and
  the install/docs state the 50-vs-1000/day threshold so operators aren't surprised by a demo-only
  free tier. See also `.env.example` OPENROUTER section and [ADR-064](adr/064-free-tier-llm-access.md).

### BYO / free-tier connections bypass the agentic loop — tool-less turns ⬜
**Found while root-causing the 2026-07-10 free-tier incident:** when a `byoLlmConnection` is
present (a user's explicit BYO endpoint OR any free-tier/platform-free pick), any-bot
`TaskController.processMessage` skips agentic mode entirely (`useAgenticMode = !byoLlm && ...`)
and runs a single plain `generateResponse` — no tools, no shell-outs, no multi-turn loop. So a
free-tier user's Jarvis/email/finance turn is reasoning-only, while the same ask on the bot's
configured provider runs the full agentic loop. ADR-064 intended the free-tier pick to route
"through Cline / the OpenAI provider" — the Cline-native handoff shape
(`freeTierToHarnessConfig()` → `buildClineProvider`) already exists but is not the execution
path. Consequence today: non-operator users get degraded (tool-less) answers wherever the tools
matter, silently.
- **Done when:** either byo/free-tier connections drive the agentic loop (e.g. Cline CLI with the
  custom baseUrl/key/model), or the tool-less limitation is made explicit — documented in ADR-064
  and surfaced to the caller (e.g. a `toolLess: true` marker on the response) instead of silent.

**Verified 2026-07-19:** OPEN — TaskController.js:276 still keeps `useAgenticMode = !byoLlm`; no `toolLess` marker.

### ~~Deploy parity check — api and bot containers must run the same image build~~ ✅ DONE 2026-07-12
**Bit us 2026-07-10 (weather "produced no readable output"):** a two-half feature (ticket-result
writer in dispatch-manifest-worker + reader/visual in jarvis-routes) shipped split because the
bots were recreated from one session's fresh build while `oshal-bot:latest` (what the api
recreates from) was an older build — tickets completed, nothing was persisted for Jarvis to
read, every delayed job showed the fallback text with no visual. Concurrent sessions retagging
`:latest` at different times makes this easy to repeat.
- **BUILT 2026-07-12:** [scripts/deploy-parity-check.sh](../scripts/deploy-parity-check.sh) discovers
  every OSHAL app container by its `BOT_RUNTIME` env (so infra is excluded), takes the api
  (`BOT_RUNTIME=swarm`) image id as the reference, and compares every bot-node's image id against it —
  printing the reference build, an in-parity/drifted count, the distinct builds in play, and on drift
  a loud per-container list (name + image id + build time) plus the exact `--force-recreate` fix.
  Exit `0` parity / `1` drift / `2` env error; `--quiet` prints only on drift. `oshal-up.sh` runs it
  (advisory) at the end of an ordered bring-up. **Live-proven:** caught a real 32-of-35 drift on the
  running stack (api rebuilt while the bots stayed ~3h stale). Runbook
  [docs/runbooks/deploy-parity.md](runbooks/deploy-parity.md); pointer in CLAUDE.md's recreate section.
- **Done when (MET):** a check exists (in `scripts/oshal-up.sh` and/or a standalone
  `scripts/deploy-parity-check.sh`) that compares the running api's image digest against every
  running bot-node container's digest and prints a loud mismatch warning naming the stale
  containers; the deploy docs/runbook tell operators to run it after any recreate.

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
3. ⬜ **Make rotation observable** — surface `markUsed` / `reportRateLimit` / `reportSuccess` state in the
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

### Plan C — multi-tenancy as infra, with two isolation tiers ⬜
The operator's model is right and already half-expressed in ADR-078. Make the tier explicit.

- **Tier 1 — full isolation:** provision from YAML → own namespace + **own database** (the per-tenant
  DB secret in `tenant-namespace.example.yaml`). Precedent exists: the graph tier's `getTenantGraph()`
  already gives each tenant an isolated ArangoDB database.
- **Tier 2 — shared DB:** a platform-wide **`tenant_id` column** + RLS policy (ADR-076 already forces
  RLS on 84 tables at the *user* level). Today `030-multi-tenant.sql` adds `tenant_id` only to
  `lm_students`/`lm_classes` (education). ADR-035 (org tenancy) is still **Proposed**.
- The tenant manifest is the source of truth; a `tenancy: isolated|shared` field picks the tier.
- **CRITICAL PREREQUISITE for the shared tier (double-check 2026-07-08):** a **tenant-scoped DB
  service identity**. Today the shared bot-node runtime's GUC wrapper stamps identity-less pods with
  the trusted system context (`oshal.is_operator='on'`) — a full RLS bypass that ANY per-tenant
  Postgres role gets for free (setting a custom GUC needs no privilege). Until batch/tenant pods
  stamp a tenant-scoped sub instead (and the policies grow a tenant arm), the shared-DB tier has NO
  effective data isolation and `oshal-tenant-db` MUST point at a separate per-tenant database. The
  template + ops/deployment/argo/README.md now say this honestly.
- **Done when:** `provision-tenant.sh <name> --tenancy=isolated|shared` renders the namespace + either
  a fresh DB or a `tenant_id` scope, and a two-tenant assertion proves neither can read the other's
  rows (shared tier) or reach the other's DB (isolated tier).

**Verified 2026-07-19:** OPEN — no provision-tenant.sh; ADR-035 still Proposed.

### Plan D — add the ollama service (unblocks the all-local profile) 🟡 IN PROGRESS
1. ✅ **DONE 2026-07-08** — `oshal-ollama` + one-shot `oshal-ollama-pull` added to
   `docker-compose.oshal-local.yml` behind the **`local-llm` profile** (default stack unchanged:
   `config --services` shows 0 ollama services without the profile). `OLLAMA_HOST` declared on the
   shared bot env; `oshal_ollama_models` volume caches the pull. Runbook:
   [docs/runbooks/local-llm-profile.md](runbooks/local-llm-profile.md).
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

### Local-LLM hardware for the single-user lane — operator decision ⬜ (priced 2026-07-11)
Sizing from the 2026-07-10/11 free-tier session. A single user's real load: concurrency ≈ 1
(chat OR a background ticket, occasionally both), 15–30 tok/s feels good, and the **quality floor
for agentic bot work (tool calls, structured artifacts, quality gates) is the 20–30B MoE class** —
7–8B models flunk the harness work. gpt-oss-120b (MoE, ~5B active, ~60–65GB at native MXFP4) is the
comfort ceiling. Constraint: the main workstation is an HP OmniBook laptop (16GB RAM, Arc iGPU)
already carrying the whole compose stack — the model must live on a second LAN box.
- **$0** — status quo: BYOK subscription bots + free rotation + the one-time $10 OpenRouter unlock
  (its own BACKLOG entry above).
- **~$700–900** — used RTX 3090 (24GB) into the existing gaming PC → gpt-oss-20b class at 100+
  tok/s. **Check what GPU the gaming PC already has first** — a 12–24GB card makes this ~$0.
- **~$2,000–2,600** — Framework Desktop (Ryzen AI Max+ 395, 128GB unified) → gpt-oss-120b at
  ~40–55 tok/s; a single user never saturates it. (DGX Spark ~$4K buys CUDA tooling, same speed
  class; Mac Studio M3 Ultra 256GB ~$5.6–8K is faster at 819GB/s but no CUDA.)
- **$14–18K RTX PRO 6000 Blackwell tier is fleet hardware** (6–7× single-stream + real batching) —
  explicitly NOT needed for one user; revisit only when multiple bots must hit local iron concurrently.
- Wiring already exists — Plan D's `oshal-ollama` service + the `ollama`/`lmstudio`/`litellm`
  providers in provider-definitions.ts; a LAN box is a base-URL change, not a build.
- **Done when:** the operator has picked a tier (including "stay $0"), and — if hardware is bought —
  the box serves an OpenAI-compatible endpoint reachable from the stack and Plan D step 3's
  zero-cloud-keys ticket proof runs against it.

### Plan E — harness naming + a real one-click Gemini login ⬜
**Naming (site + docs):** drop the term "CLI" from user-facing copy. The four harnesses are
**Cline** (the general harness — any model, any API), **Claude Code** (Anthropic; Claude login or key),
**Codex** (OpenAI; ChatGPT login or key), **Gemini** (Google).
`noop` is test-only. **Ollama is a provider, not a harness** — it runs under the Cline harness.
Internal identifiers (`codex-cli`, `gemini-cli` in `HarnessType`) stay as-is; this is copy only.

**One-click Gemini — the honest options** (there is no "just add Google sign-in"):
- **(a) Mirror the gemini harness's own OAuth.** `gemini auth login` writes `~/.gemini/oauth_creds.json`
  via Google OAuth with Gemini Code Assist scopes. Replicating it needs **our own Google OAuth client**
  registered under the business email (partner-app-registration rule) with those scopes. This is the
  only true popup-redirect path, and it mints the same creds the harness already reads.
- **(b) AI Studio key paste** — already built (`free-tier` `gemini`, `oauth: false`). Google exposes no
  OpenRouter-style key provisioning, so a Google sign-in **cannot** mint an AI Studio key.
- Mirror `openai-codex-oauth-routes.ts` (`/start` `/callback` `/status` `/signout`) for (a).
- **Also:** Anthropic has **no** popup-redirect route either. Parity across the three is a third build,
  not an existing pattern to copy.
- **Done when:** a signed-in user clicks "Connect Gemini", completes a Google consent popup, and a
  gemini-harness bot answers using the resulting credentials — with no key pasted.

**Verified 2026-07-19:** PARTIAL — the harness copy is de-CLI'd (README naming done); the Gemini OAuth popup-redirect route is still unbuilt.

### Plan F — A2A gateway: core SHIPPED 2026-07-18 (default-OFF), deployment/interop residuals ⬜ OPEN
The gateway itself is built, adversarially reviewed, and live-proven against a real standalone
(non-OSHAL) A2A agent —
see [ADR-109](adr/109-a2a-gateway-external-agents-join-the-swarm.md) for the full decision record.
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

## The 60-second on-ramp: publish a prebuilt image so first-run PULLS instead of BUILDS ⬜ (gated on launch)

**Competitive context:** VRSEN/OpenSwarm's `npx @vrsen/openswarm` is genuinely ~60s because it's a
thin CLI. OSHAL's click-install (`Install-OpenSwarm.bat` → graphical `installer/install.ps1`, or
`scripts/install.sh` on mac/Linux) is **built and polished** — it installs Docker/Node if missing,
mints join codes, offers dev mode — but its dominant first-run cost is a `docker build` of the
**6.5 GB `oshal-bot` image** (four agent CLIs + a TS compile). NO install path avoids it: even
`--minimal` runs the controller from that image. So "60 seconds" is only true after the image exists;
README timing corrected to say so honestly (2026-07-08).

**The one real gap-closer:** publish the prebuilt image to a registry (GHCR) so the installer/compose
`docker pull`s it instead of building. A ~6.5 GB pull is minutes of *download* (no source tree, no
build toolchain, no npm installs on the user's machine) — the actual "download and it just works"
experience, and it drops the RAM/disk/CPU build requirements too.

- **Gated on the public-launch decision** — publishing an image is a public artifact, and the repo is
  private until launch ([[openswarm-two-repo-flow]]). Don't push an image to a public registry ahead
  of that call. Also needs: image versioning/tags, a CI build-and-push, and the compose/installer
  `OSHAL_BOT_IMAGE` default flipped to the registry ref with a local-build fallback.
- **Shrink is a parallel win:** 6.5 GB is heavy for a pull too. The four bundled CLIs + build layers
  are the bulk; a multi-stage slim image (or lazily-installed CLIs) would cut both pull time and the
  40 GB disk ask.
- **Done when:** a first-time user on a clean machine goes from the installer to a booting cockpit
  **without a local image build**, and the README's fast-path claim is true end-to-end.

**Verified 2026-07-19:** PARTIAL — GHCR push scaffolding exists in the manual-only ci.yml; the default is still a local build; publish remains gated on launch.

## Job-application autofill — the surface never appeared + the pipeline is too fragile to rely on 🟨 BUILT-BUT-UNUSABLE

**Operator report (2026-07-08):** *"we already worked on one but the autofill button never surfaced,
and the system is up and down so much I had to use a side project to apply to jobs."* The operator is
hand-maintaining browser-console bookmarklets (Ashby/Greenhouse/Lever/Distyl field fillers with their
own PII) as a fallback — which is the real signal here.

**What EXISTS (deep, ticket-gated):** `src/app/apply-dispatch.ts` + `apply-submit.ts` drive real Chrome
on the operator's **desktop worker node** (edge-node-1) via `codex.exec` + the `browser_control` MCP,
reached only through the queue/worker path (ADR-070 privilege rule). `scripts/oshal-apply.js` (profile /
queue next / claim), a canonical **Apply Profile**, and the dedicated **apply-operator** bot
(`cb…003`) with its `/api/apply-operator` route are all built. career-hunter.yaml wires the tools.

**Why it's unusable in practice — two distinct failures:**
1. **The cockpit surface/button never rendered** for the operator, so there is no way to *invoke* the
   pipeline from the UI even when it's healthy. Find where the career board was supposed to expose
   "Apply" / "Autofill" and why it's absent (surface not registered? behind a profile? JS error?).
2. **Dependency fragility.** The working path needs ALL of: desktop worker online + heartbeating,
   `codex.exec` quota, `browser_control` MCP up, the queue not wedged, and `danger-full-access`. When
   the stack flaps (its normal state during active dev) the whole chain breaks, so it can't be relied
   on for time-sensitive applications — hence the bookmarklet fallback.

**The lesson from the fallback:** the bookmarklet just *works* — no worker, no MCP, no queue, no LLM.
The autofill feature needs a **robust low-dependency path** alongside the powerful desktop-automation
one, generated from the SAME canonical Apply Profile the operator already maintains:
- **Generate a per-user bookmarklet / userscript** from Apply Profile (`oshal-apply.js profile`) — a
  "copy your autofill bookmarklet" button in the Career app. It fills the visible form in the user's
  own already-authenticated browser tab. Zero backend at fill time; degrades to nothing when the
  stack is down. This is the honest MVP and directly replaces the operator's side project.
- Keep the desktop-automation pipeline as the "hands-off, do it for me" upgrade for when it's healthy.
- Site-adapter library (Ashby / Greenhouse / Lever / Workday / Distyl) — the field-label heuristics the
  operator's scripts already encode, hardened and shared.
- **Done when:** a signed-in Career user can (a) copy a bookmarklet built from their Apply Profile and
  autofill a real Ashby/Greenhouse posting with it in a browser with the stack DOWN, and (b) see an
  "Apply / Autofill" affordance in the Career board that actually renders. The desktop pipeline's
  reliability is a separate, lower-priority gate.

**Validated externally (2026-07-09), outside this product code:** driving the same class of remote
desktop directly with a Claude Code agent-per-posting (no `apply-dispatch`/`apply-operator`/queue
involved at all) submitted 9 real Ashby/Greenhouse applications with zero corrupted forms and zero
false-positive "applied" marks, using: (1) one orchestrator that claims a single posting in the DB, then
spawns exactly one subagent per posting **sequentially** (never parallel — one shared desktop, and an
earlier session this same day proved two workers driving it concurrently DOES interleave keystrokes and
corrupt forms — see the "runaway-poll"-style collision write-up in project memory `remote-job-apply-
pipeline`); (2) the subagent is handed the full field-answer profile + platform-specific step list +
coordinate/gotcha reference inline in its prompt (it has no other memory) and returns a small typed
JSON result, never touching the DB itself; (3) the orchestrator visually re-verifies the subagent's own
confirmation screenshot before marking the row applied — never trusts the self-reported status string.
This orchestrator/subagent split, plus the explicit non-parallel constraint on a single shared browser
worker, is the concrete pattern the `apply-operator` bot + `career-hunter.yaml` queue path should adopt
once the cockpit surface / dependency-fragility issues above are fixed — it is a stronger contract than
"one long-running worker session drives the whole queue."

**Verified 2026-07-19:** OPEN on both done-when clauses (bookmarklet + rendered Apply affordance); effort has pivoted to the desktop-worker autoapply lane (apply-operator/apply-ingest routes).

## HUMAN-IN-THE-LOOP — needs operator decision / credentials / review

These cannot be closed by code alone — they need a person to decide, pay for, supply credentials, or
sign off. They are honest gates, not unfinished work; the engineering around each is built + verified.

### World Intelligence — outlet bias values are SEED PLACEHOLDERS ⬜ NEEDS OPERATOR (license + budget)
- **Built (ADR-061):** `src/features/world-data/outlet-ratings.ts` carries per-outlet political lean +
  economic lean + reliability, and the bias-aware sentiment read (political / econ / by-outlet-kind) is
  built + tested. The **rating values are illustrative placeholders** in the AllSides / Ad Fontes shape.
- **Needs a human:** license **Ad Fontes** (numeric bias + reliability) and/or **AllSides** (categorical),
  replace the seed values, keep each `provenance`. Neither vendor permits scraping, and fabricating cited
  ratings is a liability — so this is a procurement/decision, not a code task. The `econLean` axis is
  OSHAL's own dimension (no vendor rates it) — it needs its own documented rubric or academic source.
- **Done when:** outlet ratings come from a licensed dataset with provenance, and the read is treated as
  load-bearing rather than illustrative.

### DevOps/Vault — production Vault hardening ⬜ NEEDS OPERATOR (deployment)
- **Built (ADR-040):** Vault dev server (`oshal-vault`) + the `vault-bot` broker (KV + short-TTL scoped
  token broker + dynamic Postgres DB-cred engine), verified single-admin.
- **Needs a human:** local dev uses in-memory Vault + a dev **root token**. Any non-local use needs real
  init/unseal, persistent storage, TLS, and **AppRole** auth (never the root token in env).
- **Done when:** a non-local deployment runs Vault with unseal + TLS + AppRole and no root token.

### DevOps/Vault — cloud secrets engines (AWS STS / kube) ⬜ NEEDS OPERATOR (credentials)
- **Built:** the dynamic-engine path `vault_issue {engine, role}` is **proven** via the Postgres database
  engine (issue → connect → revoke → role dropped, verified).
- **Needs a human:** configure Vault's AWS/kube engine with the operator's real cloud credentials; then
  `vault_issue {engine:"aws", role}` issues real short-TTL cloud creds over the **same code path**. No
  unverifiable engine code was added (can't prove it without real creds).
- **Done when:** an AWS or kube engine is mounted and a role issues a verified short-TTL credential.

### DevOps/Vault — multi-user ephemeral runtime ⬜ NEEDS DECISION + SECURITY REVIEW
- **Built:** the single-admin broker (issue → scope → revoke). For one admin this is complete.
- **Needs a human:** the ephemeral per-session privileged runtime (per-task tmpfs, cross-user blast-radius
  isolation, lease teardown on task end) is ADR-040's stated gating prerequisite for **multi-tenant**, and
  ADR-040 explicitly requires a **security review before first production use**. Not needed for single-admin.
- **Done when:** multi-tenant is greenlit, the ephemeral runtime is built, and a security review signs off.

## ~~New CI jobs unproven on a real GitHub runner~~ runner-proven green — only the planted-secret red proof still open ⬜
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

## ~~Noisy first-boot logs on a clean database (autoload startup race)~~ ✅ DONE 2026-07-12
- **Was (2026-06-21):** on a fresh DB the swarm-app auto-loader's first attempt ran before the
  migration that creates `swarm_applications` finished — ~40 self-healing ERROR lines on first boot
  (plus `tickets` from the queue manager's crash-recovery sweep and `agents` from the registry boot
  sync, found while proving this fix).
- **Fixed (commit b20ad9c8) — gated on migration completion, the done-when's option 1:**
  `waitForBootstrapComplete()` ([app-runtime-factory.ts](../src/app/composition/app-runtime-factory.ts))
  is the awaitable companion to `isBootstrapComplete` — released on bootstrap completion OR failure,
  bounded (90s) so a broken bootstrap never deadlocks boot. Consumers gated: swarm-app autoload
  (server.ts — route mounting unaffected), `qms.start()` + the registry→profile boot sync
  (extensions/swarm — shutdown hook still registers immediately). The one racer below the app layer
  (swarm boot seeder → `AgentProfileRepository.listAgents/createAgent`) takes the done-when's
  option 2: pg 42P01 logs at WARN with a "pre-migration boot race, self-healing" message, rethrow
  unchanged.
- **Done-when MET, live-proven:** clean postgres:16-alpine + `RUN_MIGRATIONS=true` first boot =
  ZERO error-level lines for migration-created tables; Bootstrap complete → Boot sync (all INFO) →
  "Swarm app auto-load complete" with no retry passes. (Remaining ERRORs in the proof harness were
  Redis ECONNREFUSED — no Redis in the harness env, not table races.)

## Build phase auto-escalates instead of completing (eval-wall diagnosis) ✅ CODE-RESOLVED (verified 2026-07-24) — residual: golden-run refresh (live-gated)

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
  [test-lab-golden.ts](../src/app/routes/test-lab-golden.ts).
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
  poll/sweep/gate paths), and `buildStatusTransitionMetadata` ([ticket-service.ts](../src/features/ticketing/services/ticket-service.ts))
  BACKSTOPS any reason-less escalation with `reason:'unspecified_escalation'` + `previousStatus` +
  `source` + `severity` + `nextAction` — so an empty-metadata escalation is now structurally impossible.
  No store-bypass path exists (the only metadata-less `ticket_status_history` INSERT is ticket *creation*,
  not escalation). Regression-locked by [ticket-status-history-metadata.spec.ts](../tests/unit/ticket-status-history-metadata.spec.ts)
  (the `from_status='in_process_build'`, no-reason case → `unspecified_escalation` + `previousStatus`).
  **Depth fix (the real "why"):** `pipeline_work_items_failed` recorded only a COUNT — you saw "N items
  failed" but not the cause. It now embeds per-item detail (`failedWorkItems[]` = title + assigned agent
  + the extracted agent/CLI error) via `summarizeFailedWorkItems`/`extractWorkItemError`
  ([queue-manager-service.ts](../src/features/swarm-orchestration/services/queue-manager-service.ts)),
  bounded (≤5 items, ≤300-char errors, only known string error fields — never dumps raw output/prompts).
  Tested: [queue-manager-escalation-detail.spec.ts](../tests/unit/queue-manager-escalation-detail.spec.ts).
- **(a) STILL OPEN — live/LLM-gated, not a code bug.** Root cause of the systematic escalation: a child
  build ticket escalates on `pipeline_work_items_failed` when its LLM execution produces no output
  (keyless / Cline exit 1 / the Claude-token-401 escalation item), and the parent then propagates
  `child_ticket_escalated`. A build reaching `complete` therefore needs a live swarm with a WORKING LLM —
  it's the build-path owner's + the token-keepalive fix's territory, and forcing it means a real
  end-to-end run, not a unit change. The new `failedWorkItems[].error` is exactly the trace to diagnose
  it: parent (`child_ticket_escalated`) → child (`pipeline_work_items_failed` → `failedWorkItems`).
- **Owner:** swarm-orchestration (build pipeline / `in_process_build` → escalate path) — for (a).

**Verified 2026-07-19:** PARTIAL — (b) closed 07-10; (a) remains live/LLM-gated: the 07-19 loopback evidence proves the complete-vs-escalate logic sound, but is not a live e2e run.

## Parent ticket reaches `complete` while its children are still building (parent-assembly gate too loose) ✅ RESOLVED 2026-07-19 (see completion-day stamp below; header reconciled 2026-07-24)
- **Found (2026-07-18, recursive-build proveout):** a `build` root ("smart-home automation controller",
  `e68befb3`) decomposed into 4 child tickets and reached terminal `complete` **while 2 of its 4 children
  were still `in_process_build`** (verified twice by direct Postgres query on `tickets`). A parent must not
  report a terminal `complete` before all its children are terminal and the parent is assembled from their
  results — otherwise it misreports delivery and can mask a child failure.
- **Context:** children are created `approved`/depth-1 and the parent moves to `approval_required` after
  decomposition ([queue-manager-service.ts](../src/features/swarm-orchestration/services/queue-manager-service.ts)
  `dispatchTicket` → `createChildTicketsFromPlanningOutput`). Completion is supposed to come from
  `parentAssemblyService.checkAndAssemble` (per-child) + the `sweepStaleParents` sweep
  ([parent-assembly-service.ts](../src/features/swarm-orchestration/services/parent-assembly-service.ts),
  [queue-manager-sweeps.ts](../src/features/swarm-orchestration/services/queue-manager-sweeps.ts)) only once
  **all** children are terminal. The observed early `complete` means either assembly fired on a partial set
  or the parent's own non-child completion path marked it `complete` independent of its children — **root
  cause not yet confirmed; investigate before fixing.**
- **Related:** the ADR-031 human build gate was relaxed so children auto-dispatch from `approval_required`
  (see ADR-031 Amendment 2026-07-18 + swarm-orchestration README "Decomposition depth and limits"). The
  parent's *terminal-state* gating did not keep pace with that autonomous-release change.
- **Done when:** (a) a parent build ticket stays non-terminal (`approval_required` / `in_process_build` /
  `customer_action`) until **every** child is in a terminal state, and only then assembles to its final
  state; and (b) a regression test asserts a parent with ≥1 non-terminal child can never be `complete`.
- **Owner:** swarm-orchestration (parent-assembly / queue-manager completion path).

**Verified 2026-07-19:** OPEN — no completion-gate fix, no regression spec; parent-assembly-service.ts untouched since 03-22.

**Verified 2026-07-19 (completion-day):** RESOLVED by `5cdbf7fe` — supersedes the OPEN stamp above. Root cause confirmed first (the entry's investigate-before-fixing ask): the post-build-gate re-dispatch (existingChildren > 0 → `in_process_build` entry, no re-planning, `planningDecomposition` undefined) skipped both Step-7 guards and fell through to the unconditional `complete` while children were still building; `VALID_TRANSITIONS.complete` only allows `backlog`, so the later assembly (→ `customer_action`) and child-failure escalation both threw and were swallowed — the parent wedged terminal. Fix: the `complete` write in `dispatchTicket` now runs through `shouldDeferCompletionToChildren` → `ParentAssemblyService.checkAndAssemble`, so existing rollup semantics apply unchanged (done-when a). Guard: `tests/unit/parent-assembly-completion-gate.spec.ts`, proven to catch the bug — gate neutralized → 3/4 fail, restored → 4/4 (done-when b).

## OSHAL Node desktop app — remote worker (`packages/oshal-chat`) ⬜
- **Built (2026-06-18):** an Electron desktop app that joins the swarm as an A2A remote-client and
  becomes a real worker: Jarvis orb chat + pulls dispatched tasks and runs them locally with the
  user's own CLIs (`codex`/`claude`) and gated system control (screen/shell/mouse/keyboard, nut.js →
  PowerShell fallback, off by default). Auto-connects + self-heals (re-registers when the in-memory
  control-plane registry is wiped by an `oshal-api` recreate). Verified end-to-end live: secret auth
  (401/201), online in the runtime registry with capabilities, and a dispatched `shell.exec` actually
  ran on the machine. Shared secret wired via `REMOTE_CLIENT_SHARED_SECRET` (`.env` + `oshal-api` env).
- **Scoped workspace sync (2026-06-18):** the node syncs ONLY the shared task folder it currently holds
  (`/api/remote-clients/:id/tasks/:taskId/workspace` — manifest/GET/PUT), gated by held-task +
  path-scoped (no traversal), additive push (never deletes sibling rounds' handovers or `.tokenchase`),
  push-before-complete. Runs CLI/shell in the mapped folder. **Invariant written down:** correct ONLY
  while the swarm is sequential-handover (one writer per round). If rounds ever run truly parallel on
  the same folder, snapshot-sync must become a live scoped mount (see below).
- **Open follow-ons:**
  1. **Bot-initiated control (result-return).** A reasoning bot can't yet *autonomously* call the
     node's tools — needs (a) the node's MCP tools surfaced into the bots' tool list, (b) orchestrator
     routing of a tool-call to the node, (c) `forwardTaskResultToSwarm` actually consumed so the
     result returns to the requesting bot (today it fires into the mesh unconsumed; results are
     retrieved out-of-band). Until then, dispatch is operator/API-driven, not bot-reasoned.
  2. **Live scoped mount (Option B).** If parallel same-folder rounds become real, replace snapshot
     sync with a per-task SMB/WebDAV mount whose root is exactly the one `workspaceFolderId`.
  3. **npx publish readiness.** `dist/` is gitignored + `electron` is a devDep → a publish ships empty;
     add a `files` allowlist + `prepack`, move electron to a dependency.
  4. **Per-action confirm mode** for system control; **rotate the plaintext headscale pre-auth key** in
     `scripts/start-local-agent.bat`.
- **Done when:** you say "open Word and screenshot it" to the orb and a swarm *bot* drives the node
  and returns the image inline; and a node-run round leaves its files in the shared task folder for
  the next bot.

**Verified 2026-07-19:** PARTIAL — npx-publish readiness (follow-on 3) + headscale key rotation DONE; `forwardTaskResultToSwarm` still fires unconsumed (no subscriber); scoped mount + per-action confirm open.

**Verified 2026-07-19 (completion-day):** follow-on 1(c) CLOSED by `4e494b4f` — `forwardTaskResultToSwarm` now also emits on `swarm.remote-task-result` with a guaranteed correlationId, and a controller-side XREADGROUP subscriber ([remote-client-task-results.ts](../src/app/routes/remote-client-task-results.ts)) lands each result on the originating work item via the canonical path (`setExecutionOutput` bounded 200K + status, subtask-aware; 12 tests). Still open from this entry: 1(a) the node's MCP tools surfaced into bots' tool lists + 1(b) orchestrator routing of a bot's tool-call to the node — so the overall done-when (a swarm bot autonomously driving the node) remains — plus the live scoped mount (2) and per-action confirm mode (4).

## Inline-bot execution is broken for finance/identity/kid-lens/deck/social ✅ RESOLVED 2026-06-22 (verified 2026-07-24) — residual: identity-leg live smoke

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

## Jarvis (unified assistant) — historical inline data-app design (superseded by ADR-083) ✅
- **Current architecture (2026-07-10):** Jarvis converses or files one ticket; the queue manager calls
  out to knowledge owners. The canonical current flow is
  [Jarvis architecture and flow](./architecture/jarvis-architecture-and-flow.md). The bullets below
  preserve the v1 gap/design history; they are not the current routing contract.
- **Built (v1):** route-layer orchestrator [jarvis-routes.ts](../src/app/routes/jarvis-routes.ts) (classify →
  delegate self-serve bots via `BotNodeClient.execute` → synthesize), [oshal-assistant.yaml](../ai-lab/bot-personas/oshal-assistant.yaml)
  bot (`…-0050`, inline claude-code), [jarvis.yaml](../swarm-apps/jarvis.yaml) manifest (`?app=jarvis`),
  [jarvis.html](../src/api/jarvis.html) surface. tsc-clean.
- **The gap:** the reason-only data-apps (finance, youtube-kids, identity, storage) are **handoff-only** —
  Jarvis can't answer them inline because it can't pre-assemble their data context (Plaid aggregate,
  Takeout upload, connection inventory, storage target). v1 deep-links the user to those apps instead.
- **What (to close it):** give each data-app a callable, caller-scoped "answer" service (fetch + reason)
  that Jarvis can invoke server-side with the caller's `userSub` (e.g. reuse `finance` `/brief`, `identity`
  `/advice`) and fold the result into synthesis as a `delegate` target rather than a handoff.
- **Alternative path:** when OSHAL runs on a tool-capable server-side provider (real `ANTHROPIC_API_KEY`),
  add the in-conversation `delegate_to_agent` builtin tool so Jarvis becomes a true tool-calling agent.
- **Done when:** asking Jarvis "how's my portfolio?" with linked accounts returns a real brief inline
  (not just an "Open Finance" chip), with cost landing under the finance bot's `agent_id`.

## Jarvis — tool work through the queue (current contract in ADR-083) ✅ LIVE-VERIFIED
Jarvis (the one you talk to) runs on a **single-threaded** `jarvis-bot` — if IT runs a tool, the chat locks
for the tool's whole duration. Fix: Jarvis is **purely conversational** (talks, reads OPEN WORK / the incident
view, gathers context, files tickets) and the MOMENT a tool/bot is clearly needed it files an **auto-approved
ticket into the build queue**, which routes it **by selector** (`CapabilityMatcher`) to the owning bot — a ride
→ `rides-concierge`, food → `eats-concierge` — or decomposes a build into a team on the fly. The conversation
stays free; the result is reported back enriched on delivery.
- **2026-07-10 status:** the queue/call-out path is live-verified. ADR-083 replaced the old direct
  selector details with knowledge-owner bids and queue-manager lane selection; use the
  [canonical as-built flow](./architecture/jarvis-architecture-and-flow.md), not this section's older
  implementation vocabulary, when changing routing.
- **Historical implementation notes (some routing details superseded by ADR-083):**
  - [jarvis-routes.ts](../src/app/routes/jarvis-routes.ts) `dispatchHandoffs`: single path — every hand-off →
    `createTicket(status:'approved', ticketType:'task', metadata.source:'jarvis')`; the queue-manager pipeline
    (`QueueManagerService` → `TicketProcessor` → `CapabilityMatcher`/`CompetencyRanker`/`LLMAgentRouter`) routes
    by capability. No simple/complex branch (complexity is a hint only).
  - [oshal-assistant.yaml](../ai-lab/bot-personas/oshal-assistant.yaml): Jarvis never runs tools — it batches
    everything to the queue; YOUR TOOLS is awareness (never "I can't"), not a run-it instruction.
  - **Removed the earlier `oshal-worker`** (generic catch-all that bypassed selector routing AND collided with
    agent id `…-0099` = the existing `everything-default` general bot): registry entry, `worker-bot` compose
    service, `oshal-worker.yaml`, `WORKER_AGENT_ID`/`runWorkItem`.
- **Why inline wasn't enough (FedRAMP):** the concierge bots ran **inline** on `oshal-api`
  (`container: oshal-api`), so the build queue couldn't HTTP-dispatch to them — it fell back to in-process
  execution on the controller, losing container isolation + the standard dispatch path. Not acceptable for
  traceability/security. The build queue HTTP-dispatches only when a bot has its OWN container endpoint
  (the container-endpoint check in [AgentDispatchEngine.js](../any-bot/server/services/queue-manager/AgentDispatchEngine.js),
  extracted from QueueManagerService.js in the 2026-07-11 decomposition).
- **rides-concierge → REAL bot-node (DONE, tsc-clean):** promoted to its own `rides-bot` container on CODEX
  (shells out to `oshal-uber-rides.js`), mirroring `home-bot`. Registry x2 (`container: rides-bot`,
  `codex-cli`/`openai-codex`), `rides-bot` compose service, persona rewritten to shell-out + rich markdown
  (`bash: auto`), and `rides-routes.ts` `/chat` now dispatches via
  `BotNodeClient` → `rides-bot` (same path the build queue uses) instead of `orchestrator` inline. Option
  **cards still render** via the dedicated `/estimate` endpoint (unchanged).
- **`eats-concierge` → REAL bot-node (DONE, tsc-clean):** same recipe — own `eats-bot` container on CODEX
  (shells out to `oshal-uber.js` search/menu/order → the checkout deep-link), registry x2, `eats-bot` compose
  service, persona rewritten to shell-out + markdown (`bash: auto`), and `eats-routes.ts`
  `/chat` dispatches via `BotNodeClient`. The dedicated cart endpoints still drive the surface's cart UI.
- The other inline reason-only bots (finance-analyst, identity-advisor) only serve their own surfaces, not the
  build queue, so they stay inline for now — revisit per FedRAMP scoping.
- **TODO (minor):** the rides surface chat bubble renders the bot's markdown as plain text — add a small
  markdown render (rolls into the Shared Response Renderer below).
- **Historical deploy note:** `docker build -t oshal-bot:latest .` → `docker rm -f oshal-local-api oshal-local-jarvis-bot
  oshal-local-rides-bot oshal-local-eats-bot` → `docker compose -f docker-compose.oshal-local.yml up -d
  --no-deps oshal-api jarvis-bot rides-bot eats-bot`.
- **Done when:** asking Jarvis "get me a ride" files a build-queue ticket that routes to `rides-bot` (verify in
  the routing-decision log + `oshal-local-rides-bot` logs show the CLI run), jarvis-bot stays responsive, and
  the result comes back enriched.

## Shared Response Renderer — Jarvis vertical slice built; cross-surface registry open 🟨
Operator vision (2026-06-20): a **shared renderer layer** every surface uses that takes a bot's response
narrative and *brings forward whatever is relevant* — ride wait times + fares + car locations on a map; cart
items + costs; a deck it opens and flips through (or offers as a download); a stock chart; etc. The bot
describes the result; the renderer decides the component (map / table / cards / chart / doc-viewer / download
button) and updates the UX on the fly. Markdown rendering is the **first step** ("better than today"); the
renderer grows to typed blocks (e.g. fenced ```oshal:map / ```oshal:chart / ```oshal:doc) the bot can emit.
- **Built 2026-07-10 — Jarvis vertical slice:** one optional strict `oshal:visual` contract supports
  `weather`, `priority-email`, `table`, `chart`, and `summary`; the server deterministically renders an
  owner-private immutable SVG, the orb materializes/narrates/fades it, and Discussion replays the exact
  artifact. No valid spec means no visual surface. Weather and communications have dedicated live-data
  nodes. Mobile center copy now occupies a stable bounded response slot, and hostile unbroken reply/
  caption tokens cannot grow the document or shift its primary controls. See the
  [as-built Jarvis flow](./architecture/jarvis-architecture-and-flow.md).
- **Trust boundary:** NWS weather and Gmail priority-email visuals require provider source references.
  Their provider-owned display fields are rebuilt from bounded records captured on the successful
  allowlisted control-plane command path; conflicting model values are ignored. Artifact bytes and
  source-job identity are locked. This is field-grounded inside the trusted worker/controller boundary,
  but it is **not** provider-signed cryptographic attestation and does not defend against a compromised
  worker or controller.
- **Why:** every app currently hand-builds its own surface widgets (rides cards, eats tiles, deck viewer).
  A shared renderer = consistent UX, less per-app surface code, and Jarvis/any bot can return rich results
  that render the same everywhere.
- **Markdown-narrative segmenter BUILT 2026-07-10 (the "first step" + typed-block hook):** the other
  half named above — turning a bot's free-form markdown reply into the right rich UI — now has its pure
  foundation in [src/shared/ui/response-renderer/](../src/shared/ui/response-renderer/). `parseResponse(text)`
  segments a reply into ordered typed blocks — `markdown` (prose the surface renders with the existing
  message-renderer), `code` (with language), `mermaid`, and **`oshal:<kind>`** (the fenced typed blocks
  this item calls out — `oshal:map`/`oshal:chart`/`oshal:doc` — JSON-parsed to `{kind,data}`, degrading a
  malformed one to a visible code block, never throwing). `hasRichBlocks()` lets a surface decide whether
  to invoke the rich path. Complements `features/visual-response` (that renders a STRUCTURED spec to server
  SVG; this segments a NARRATIVE reply) and pairs with `features/surface-bridge` (a `set_content` op carries
  markdown a surface segments with this). DOM-free, 10 unit tests
  ([tests/unit/response-renderer-parse.spec.ts](../tests/unit/response-renderer-parse.spec.ts)); tsc clean.
  **Remaining (browser):** a block→component registry (mermaid renderer, oshal:map/chart/doc components) +
  wiring the concierge/orb surfaces onto `parseResponse` — the "portable block/component registry" below.
- **Still open:** authenticated seeded Gmail/browser proof, one joined queue-backed delayed-worker
  lifecycle test, more safe response kinds, a portable block/component registry for concierges/desktop/
  TV, confirmation-gated actions/forms, selectable TTS/local-private voices, calibrated speaker
  attribution, and separately reviewed native all-day transcript capture. The prioritized acceptance
  plan and done-when criteria live in
  [Jarvis voice and visuals — next steps](./backlog/jarvis-voice-and-visuals.md).

**Verified 2026-07-19:** cross-surface registry OPEN — scaffold + parser + tests exist; no concrete components, and no surface imports `parseResponse` yet. (Per-file audit of jarvis-voice-and-visuals.md: JVV-002/005 done, the rest open.)

**Verified 2026-07-19 (completion-day):** the registry is no longer empty — `36233ec5` supersedes the "no concrete components / no consumer" stamp above: concrete components landed (markdown safe-default / code / mermaid with data-mermaid fallback, no CDN / `oshal:chart` dependency-free SVG / `oshal:table` — all sanitized construction over UNTRUSTED bot output, DOM-free) plus a wired reference consumer: the `/swarmbot/chat` bubble upgrades assistant messages via `renderResponseHtml` with a permanent plain-text fallback (browser delivery via the sanctioned vite → `src/api/dist` path). Guard: `tests/unit/response-renderer-components.spec.ts` (18, incl. XSS payloads never landing as elements). Remaining: `oshal:map`/`oshal:doc` components, wiring the Jarvis/concierge/orb surfaces onto `parseResponse`, and the rest of the jarvis-voice-and-visuals plan.

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

## Finance — read-only money aggregation (Plaid, ADR-048) 🟨 BUILT, NOT DEPLOYED/VERIFIED

The finance bundle: link banks + brokerages via Plaid (one connection → ~12k institutions),
fold balances + holdings + transactions into a per-user aggregate, and let the `finance-analyst`
bot turn it into a plain-English brief (net worth, portfolio, spending, watch-outs). Built on the
kid-lens inline pattern (controller does the Plaid HTTPS I/O; reason-only claude-code bot `…0044`
runs the brief) — see [ADR-048](adr/048-finance-aggregation-swarm.md) for why this deviates
from the codex shell-out reference. v1 scope: **read-only aggregation only, no trade execution,
no crypto.**

- **Built + tsc-clean (not deployed):** `finance-plaid.ts`,
  `finance-routes.ts`, [scripts/oshal-plaid.js](../scripts/oshal-plaid.js),
  `src/api/finance.html`, [finance-analyst.yaml](../ai-lab/bot-personas/finance-analyst.yaml),
  `swarm-apps/finance.yaml`, local-registry entry `…0044`, server.ts mount.

- **NOT done (the handoff):**
  1. **Operator must register the Plaid app** (business email, partner-app rule) and set
     `PLAID_CLIENT_ID` / `PLAID_SECRET` in `.env` (`PLAID_ENV` defaults to `sandbox`). Sandbox
     keys are instant — no review.
  2. **Deploy** — routes + HTML are baked into the image. Commit → `docker build -f Dockerfile.oshal
     -t any-bot:latest -t oshal-bot:latest .` → `docker compose -f docker-compose.oshal-local.yml
     up -d --force-recreate --no-deps oshal-api`.
  3. **Verify** — `/cockpit/?app=finance` → Demo-connect (Sandbox) → Sync → brief; or headless
     `node scripts/oshal-plaid.js link-sandbox <user_sub>`. Then a real-bank link once Plaid
     production access is granted.

- **Done when:** stack rebuilt + `oshal-api` recreated, and a human (MOCK_OIDC=true) opens
  Finance, demo-connects, syncs, and reads a grounded brief with correct net-worth/holdings/spend.

- **Compose env gotcha (fixed 2026-06-17):** `oshal-api` enumerates every connector's env
  explicitly — `PLAID_*` (and the new `PAYMENT_PROVIDER`/`STRIPE_SECRET_KEY`) were missing, so keys
  in `.env` never reached the container. Added to `docker-compose.oshal-local.yml` + `.env.example`.

**Verified 2026-07-19:** holds — the Plaid HUB connector (auth:'link') is built but keys are EMPTY → unverified; payments adapters are coded, not deployed; the Finance app itself is carved to the store.

### Finance — money movement (payment adapter) 🟨 BUILT, NOT DEPLOYED/VERIFIED

Operator asked to relax read-only by one capability ("we need at least a pay"). Built a
**provider-agnostic `PaymentAdapter`** ([src/features/payments/](../src/features/payments/)) parallel
to the harness-adapter pattern: interface (`createTransfer`/`getTransfer`/`configured`/`isTestMode`)
+ `StripePaymentAdapter` (fetch, no SDK; ACH debit of the user's bank via a `us_bank_account`
PaymentIntent) + `getPaymentAdapter()` selected by `PAYMENT_PROVIDER`. Wired into
`finance-routes.ts`: `GET /pay-status`, `POST /pay`
(idempotency-keyed `sub:requestId`), `GET /pay/:id`, `GET /payments`; owner-scoped
`oshal_finance_payments` audit table; Send-money panel on the surface. Deterministic I/O, no LLM.
tsc clean. See the [ADR-048 addendum](adr/048-finance-aggregation-swarm.md).

- **NOT done (handoff):** operator sets `STRIPE_SECRET_KEY` (a `sk_test_…` key is instant, test mode)
  → rebuild/recreate `oshal-api` → `?app=finance` → Send-money panel → send a test ACH to
  `pm_usBankAccount_success` → see it in Recent transfers.
- **Done when:** a human (MOCK_OIDC=true) initiates a transfer in test mode and the
  `oshal_finance_payments` row + status poll reflect it.

**Verified 2026-07-19:** holds — payment adapters coded, not deployed (needs keys).

### Finance — deferred beyond v1 ⬜
- **True account-to-account payouts** — the Stripe rail debits the user's bank into the platform
  Stripe balance; routing to an arbitrary biller needs the **Plaid Transfer / Dwolla** rail
  (registered as not-yet-implemented in `payment-provider.ts`, fails loudly if `PAYMENT_PROVIDER`
  selects them). **Done when:** a sibling adapter does real A2A money movement, sandbox-verified.
- **Live-money compliance gate** — money movement is money-transmitter territory; only Stripe test
  mode is exercisable. **Done when:** an ADR scopes the compliance/security model before any
  `sk_live_…` key is configured.
- **Trade execution** — SnapTrade / broker APIs (Alpaca, Schwab) to actually place trades.
  Broker-dealer / regulatory burden; a separate bundle, not an add-on. **Done when:** its own ADR
  scopes the regulatory + security model before any code.
- **Real-bank production verification** — only the Sandbox path is exercisable until Plaid grants
  production access (one-time use-case review). **Done when:** a real institution links + syncs.
- **Multi-account labels + household tenancy** — `oshal_finance_items` is currently a flat per-user
  set; no labels or personal∪shared sharing (ADR-042). **Done when:** items carry labels and respect
  tenancy like the connector store.
- **Scheduled re-sync + alerts, bill/cash-flow forecasting** — v1 syncs on demand only.
  **Done when:** a `finance-brief` ticket re-syncs on a schedule and can surface notable changes.

## Token Chase — checkpoint/replay optimization (FLAGSHIP, ADR-046) 🟡 IN PROGRESS — steps 1–3 + savings loop built; first REAL free-lane grade 2026-07-11

> **2026-07-11 milestone:** the first real (non-demo) baseline was graded against a `:free` lane at
> $0 — real captured frames replayed on a bot node, determinism-gated. Evidence:
> token-chase-real-baseline-2026-07-11.md. All
> earlier `token-chase-demo-*.md` files are the synthetic `/demo/comparison` route, not real grades.
> Grading remains the **lexical Jaccard proxy** — the step-4 LLM judge (below) is still the upgrade.
> A platform-key spend guard now keeps the optimizer's `framework:openrouter` lane on `:free`
> (`optimizer-providers.ts`, `tests/unit/optimizer-platform-key-guard.spec.ts`). See also "Plan B".

The platform's headline differentiator (see [ROADMAP.md](../ROADMAP.md) → "The differentiator").
Mechanism design is [ADR-046](adr/046-token-chase-checkpoint-replay-optimization.md);
positioning is locked. Build is **risk-front-loaded** — steps 1–2 carry all the risk; the
optimization loop on top is comparatively easy. Do not pitch as shipped until step 2 passes
(CLAUDE.md as-built rule). Concrete implementation sketch for steps 1–2 (real hooks: capture at
`AgenticController.js:382`, git-per-call in `task.workspace_dir`, per-call cost from `response.usage`
not `chat_tasks`, name the unit `frame` to avoid the existing `/api/checkpoints` collision):
[docs/architecture/token-chase-capture-and-debugger-spec.md](architecture/token-chase-capture-and-debugger-spec.md).

**Verified 2026-07-19 (per step):** Step 2 tail-replay OPEN (single-call gate only); Step 2b debugger OPEN; Step 3 variant-splice + lane abstraction SHIPPED (token-chase-routes.ts:164, optimizer-providers.ts); Step 4 assessor/judge SHIPPED 07-15 (token-chase-assessor.ts); Step 4b savings report SHIPPED (`GET /savings/report`); Step 5 selection policy OPEN.

### Step 1 — Trace capture, read-only ✅ BUILT (2026-06-17)
- **What:** for an existing workflow (start with `incident-rca` — single-bot, known shape),
  record the chain of LLM calls and link each to its `chat_tasks` row (`chat_task_id`,
  tokens_in/out, cost_usd). No checkpointing, no replay yet.
- **Why:** proves the call chain reconstructs end-to-end and that cost is attributable per call
  without duplicating `chat_tasks`.
- **Done when:** a captured trace for one real run renders the ordered call list with per-call
  decision (tool/api/llm/harness) + cost pulled by reference from `chat_tasks`.
- **As built:** dark-by-default capture lane (`TOKEN_CHASE_CAPTURE=true`) wraps the per-call
  chokepoint at `AgenticController.js:390/438`, writes redacted per-call frames to
  `<workspace>/.tokenchase/`; read API + owner-scoped read service + `/api/token-chase/ui` debugger.
  (`TokenChaseCapture.js`, `token-chase-read-service.ts`, `token-chase-routes.ts`, `token-chase.html`.)

### Step 2 — Checkpoint + forward-only replay (THE DETERMINISM GATE) 🟡 single-call gate built; workspace-tree tail-replay open
- **What:** before each LLM call, commit a checkpoint binding {workspace tree + bot
  `user_sub`-keyed store version + `.tokenchase/checkpoint.json` (serialized envelope, prompt,
  pinned external reads)} under one SHA. Then replay from a checkpoint with **no edit** and assert
  the tail reproduces baseline. Use git worktrees for isolated replay.
- **Why:** forward-only replay is only a controlled experiment if restoration is exact. This is the
  precondition for every later step — if the no-edit replay drifts, counterfactual labels are
  silently corrupt.
- **Done when:** no-edit replay from checkpoint N reproduces the baseline tail (same artifacts +
  same store version) for a replayable workflow; calls with live/unpinned reads are flagged
  `non-replayable` and excluded; store versions preserve owner-keyed AES-GCM encryption across
  restore.
- **Built so far (slice 1 — single-call no-edit gate, 2026-06-17):** `POST /api/token-chase/runs/:runId/replay`
  rehydrates ONE captured frame's exact sent prompt (system + post-truncation history) and re-fires it
  **on the owning bot node** (`/api/token-chase/replay-call` → one `generateResponse`, cost recorded
  under a `::replay` task id) — the controller never gains an LLM call. The fresh response is graded vs
  baseline by `assessDeterminism` (byte-exact → `deterministic`; token-set Jaccard ≥ 0.85 → `equivalent`;
  else `divergent`); `non-replayable`/`open-frame`/`no-endpoint` frames are excluded before any tokens
  spend. Surfaced as a per-frame "Replay" button in the debugger. (`determinism-verdict.ts`,
  `token-chase-replay-service.ts`, `BotNodeClient.replayCall`, `tests/token-chase-determinism-gate.spec.ts`.)
- **Still open (the full step-2 done-when):** git frame-commits binding the whole workspace tree + bot
  `user_sub`-store version per call; worktree-isolated **tail** replay (re-enter `processAgenticTask` and
  reproduce all downstream artifacts, not just one call's response); honest `replayable=false` detection
  from real pinned-read tracking (capture currently always sets `true`); tool-schema re-binding on replay
  (the frame stores tool *names* only); AES-GCM-preserving store restore.

### Step 2b — Debugger view (FIRST SHIPPABLE DELIVERABLE, ADR-046 §10) ⬜
- **What:** an operator surface over the captured timeline — scrub / rewind / step call-by-call /
  inspect the exact prompt+response into any call / hand-edit a response and play forward.
- **Why:** needs *only* steps 1–2 (no assessor, corpus, or policy), is independently useful
  (forensics + explainability), and is the visible proof the substrate works. Build/sell this before
  the optimizer.
- **Done when:** an operator can open a finished run, rewind to the call where an answer went wrong,
  see that call's prompt+response, and play forward from an edited response; `non-replayable` calls
  are marked on the timeline.

### Step 3 — Single-variant splice + diff + cost-floor lanes (ADR-046 §9) ✅ SHIPPED (verified 2026-07-19)
- **What:** rewind to a checkpoint, inject one variant on the **LLM/model axis** (lowest contract
  risk), replay forward, render cost+quality+latency diff vs. baseline as a matched pair. Add the
  **lane abstraction** so {local-Llama via Ollama, Gemini-free via Google account, paid-frontier}
  are first-class selectable variants (mostly surfacing the existing provider/harness registries).
- **Why:** first end-to-end counterfactual; validates splice → forward-replay → diff on the safest
  axis, and makes the $0 lanes (local + legit free tier) routable — the headline "same output, cost →
  near zero" demo. **Legit free tiers only:** one free tier per provider + local hosting; no
  account-farming (ToS, fragile).
- **Done when:** an operator can swap the model/lane at one splice point (incl. to a $0 local or
  free-tier lane), see the forward-only diff, and the upstream calls are provably untouched (same
  SHAs).

### Step 4 — Assessor + run–learn loop + corpus ✅ SHIPPED 2026-07-15 (verified 2026-07-19)
- **What:** a judge persona proposes splice points, scores `quality_score`, and checks
  `backwards_compatible` at phase boundaries. Automate keep-winner → re-baseline → next point.
  Persist `(context{task_class,query_type,mode,checkpoint_sig,input_size,metadata}, decision,
  outcome)` rows as the corpus (cost by `chat_task_id` reference).
- **Why:** turns one-off splices into accumulating counterfactual training data across all four
  axes.
- **Done when:** a full workflow auto-optimizes across ≥1 splice point unattended, and each
  decision lands a corpus row; `backwards_compatible=false` rows are disqualified from "winner".
- **Tier the wins (ADR-046 §11):** Tier 1 = equivalence-swap (cheaper lane produced an *equivalent*
  output → swap, zero-risk, quality provably unchanged; "equivalent" is a semantic tolerance, not
  byte-exact). Tier 2 = quality-equivalent trade-off (differs but judge passes it). Lead with Tier 1.

### Step 4b — Cost savings report (HEADLINE OUTPUT, ADR-046 §12) ✅ SHIPPED (verified 2026-07-19)
- **What:** `GET /api/token-chase/savings` + cockpit surface. Baseline vs. optimized $ (and %), split
  by tier (zero-risk equivalence-swap vs. quality-equivalent), by lane (local/free/paid), by
  `query_type`; each swap links to its matched-pair replay as evidence. Reads the corpus, re-runs
  nothing.
- **Why:** the legible payoff — what you put in front of an operator/buyer. Equivalence-swap $ is the
  number to lead with (no quality caveat).
- **Done when:** for a workflow with ≥1 applied swap, the report shows the saved $ + % with the tier
  and lane breakdown, and each line is auditable to its baseline/variant frames.

### Step 5 — Heuristic → trained selection policy ⬜
- **What:** lookup/heuristic first ("for this task_class/query_type the corpus prefers X"); graduate
  to a trained policy only once the corpus beats the heuristic. Build the corpus before the model.
- **Done when:** the orchestrator consults the policy to pre-select a variant before spending tokens
  testing it, and measurably beats the always-baseline cost on a held-out workflow at equal quality.

**Caveats to honor:** determinism (step 2) and label quality (clean `quality_score` +
*checkable* `backwards_compatible` contracts, not vibes) bound everything; add a checkpoint
retention/GC policy (keep baselines + winning branches, GC losing variants); replay must run
through accountable bot nodes — the controller never gains an LLM call.

## Apps & surfaces — 2026-06-15 operator walkthrough (HIGH PRIORITY)

Owner walkthrough of `/applications`. The two strongest swarms are **email
(Intelligent Communication)** and **social** — treat those as the reference;
the rest are broken, surfaceless, or stale.

### Combined "home" view — all apps in one cockpit (operator ask 2026-06-16) ⬜ NOT BUILT
- **What:** one unified cockpit shape that aggregates the personal/home apps into a
  single ribbon — Intelligent Communication (My Day / Inbox), Social, Career, Storage,
  Presentations, Bot Forge — instead of switching between separate `?app=` shapes.
  **Exceptions kept standalone:** Little Monsters (kid-facing product, its own focused
  shape) and the raw Tickets app (its own queue view).
- **Why:** the consumer "home AI hub" story — one place for all your stuff. Today each
  app is a distinct ribbon shape reached by `?app=<name>`; there's no single combined
  surface. The framework-default cockpit is the closest thing (now has Tickets + Bot
  Forge + Chat + Calendar + Dashboard) but doesn't surface the app workspaces.
- **Shape:** a `swarm-apps/workspace.yaml` (or `home-hub`) manifest whose `ui.static`
  lists each home app's primary surface URL (gathered, build-ready):
  `/api/email/my-day`, `/api/email/inbox`, `/api/social/workspace`, `/api/social/signals/ui`,
  `/api/career-hunter/board`, `/api/storage/assistant/ui`, `/api/files`,
  `/api/presentations/sections/ui`, `/api/forge`. Theme neutral. Surfaces inherit their
  owning app's gate (503 if that app is inactive).
- **⚠️ Chat wrinkle (verified 2026-06-16):** the loader REQUIRES ≥1 bot per manifest, and
  `reconcileAgentsTable` dedupes agents **by name** and rewrites `metadata.manifestApp` to
  the last manifest that declared a bot. So the combined view must NOT re-declare the home
  bots (comms/social/career/storage) — that would hijack their ownership and could
  deactivate them for their real apps on unload. The unified chat needs **its own dedicated
  generalist `home-assistant` bot** (new persona + registry entry), or a selector path that
  lists bots without claiming ownership. This is why it's a real task, not a 5-min manifest.
- **Done when:** `/cockpit/?app=workspace` shows every home app's surface in one ribbon,
  each renders live, the right-rail chat works (via the dedicated generalist bot), no other
  app's bot ownership is disturbed, and Little Monsters + the Tickets app remain reachable
  as their own standalone shapes.

**Verified 2026-07-19:** OPEN — no workspace.yaml exists. **Post-carve note:** several surface URLs listed above (social workspace/signals, storage assistant, presentations sections) are now mounted by STORE packages (`d9f45cc0` / `351219d1` / `775d76c7`) — a workspace.yaml design must reference installed-package surfaces (or gate on those packages being installed), not kernel routes.

### Career Hunter — operator data + resumes migrated, storage persistent ✅ DONE (2026-06-16)
- **What:** the operator's legacy single-user `jobs.db` (1.5GB, OneDrive) was migrated into
  OSHAL's multi-user layout under `user_sub example-user-sub` via `_seed_corpus.py`:
  807,417 postings + 1,107 companies (shared `corpus.db`), 700,863 fit signals incl.
  **21 applied / 3 promoted / 1,151 generated**, 192 recruiters.
- **Resumes:** 4,776 legacy resume/cover PDFs (789MB) `docker cp`'d into the per-user
  volume `…/applications/`; 1,180 `resume_path`/`cover_path` rows repathed off the old
  Windows paths (all resolve). Persistence bug fixed (0018edd): the engine wrote new
  resumes to the container FS (`config.ROOT/applications`, lost on recreate) — now
  `config.APP_DIR` defaults into the per-user volume in multi-user mode.
- **Storage model:** everything under `/app/output/career-hunter-data/<tenant>/…` on the
  `api-output` named volume (persists). `corpus.db` (shared) + `user-<sub>.db` (per-user,
  base table `postings_corpus`, `postings` is a cross-DB view) + `<sub>/applications/`.
  App reads via `JOBHUNTER_STORE_ROOT`; the node wrapper sets `JOBHUNTER_DATA` per user.
- **Residual (low):** migration is a per-user manual run (only `…909` done; a self-serve
  "import my legacy jobs.db" flow is unbuilt). `/applications` working-list now includes
  career-hunter (commit f319326).

### `/applications` — gray out non-working apps, reorder working-first, fix codex-packer link ✅ DONE (2026-06-15)
- **Done:** [src/pages/applications/index.html](../src/pages/applications/index.html) defines
  `WORKING = ['social','email-summarizer','codex-packer','little-monsters']`, sorts working-first +
  enabled and greys/disables the rest, treats operator-deployed swarms as working, and the Codex
  Packer tile launches `CODEX_PACKER_LAUNCH = /swarmbot/chat?agentId=a0000000-…-030` (the real
  builder) instead of `?app=codex-packer`. Commit 8ea2fa7.
- **What:** Only **Social**, **Intelligent Communication**, **Codex Packer**, and
  **Little Monsters** work. List those **first + enabled**; **grey out / disable everything
  else** (capture-crm, federal-capture, issue-rca, oshal-engineering, the retired ops surface…).
  **Codex Packer must launch the real builder** —
  `/swarmbot/chat?agentId=a0000000-0000-0000-0000-000000000030&taskId=<fresh>` (the working
  "create a swarm" chat) — NOT `?app=codex-packer` (opens the default app + legacy toolbar).
- **Done when:** `/applications` lists the 4 working apps first + enabled, the rest
  greyed/disabled, and the Codex Packer tile opens the swarmbot-chat builder.

### Workflow Studio — bot-driven; the canvas is a *view* of a conversation, not a hand editor
- **Design:** [ADR-039 — bot-driven workflow authoring](adr/039-bot-driven-workflow-authoring.md)
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

### Codex Packer → download / deploy rails ✅ DONE + VERIFIED (2026-06-15)
- **Done:** codex-packer writes to the accessible `packs/<name>/` + `pack.json` (mode
  wrapper|swarm). New `swarm-pack-routes`: GET `/api/swarm/packs` (list), `/:name/download`
  (dependency-free ZIP, verified extractable), `/:name/workflow` (read-only flow), POST
  `/:name/deploy` (swarm → generates a manifest → `loadApp`: registers bots in `agents`,
  workflow + ticketType in the registry, gated swarms get reviewer+maxRevisions). Deployed
  swarms write to a writable `deployed-apps/` the boot auto-loads (survive restarts). Packs
  panel at `/api/swarm/packs/studio` (Download / View flow / Deploy). Verified: 3-bot gated
  pack deployed → 3 active bots + `ticketType=html5-game` registered + persisted across recreate.
- **Remaining:** (a) a **Packs ribbon icon** for one-click access (panel is URL-only today);
  (b) the **legacy-toolbar `?app=codex-packer`** entry-point cleanup; (c) the full **bot-driven
  Workflow Studio canvas** (ADR-039 — the studio rendering the conversation graph live) is
  still roadmap — today the flow view is a lightweight read-only node/edge list in the panel.

### Social surface — show X/Twitter + actually help create posts ✅ DONE (2026-06-16, d13c952)
- **Built:** the Composer (`?app=social` → Composer) shows connected **X (@handle + followers)**,
  LinkedIn, and Facebook; a **network selector (X | LinkedIn)**; **platform-aware AI draft**
  (X = tweet ≤280, verified at 208 chars / LinkedIn = post); **refine chips** (reusing
  `/api/content/refine`); per-network char counter (280 / 3000) with over-limit warning; and
  **approval-gated Publish** to the chosen network (`/api/social/post?target=`, confirm dialog).
- **Small follow-up:** show recent X *activity* (the user's timeline), not just the profile header.

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
- **Already possible TODAY (free, no X):** the news/RSS stream ([scripts/oshal-research.js](../scripts/oshal-research.js))
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
  + deduped in `oshal_inbox_messages` ([inbox-ingest.ts](../src/app/routes/inbox-ingest.ts)) — nothing
  missed on a busy day. `GET /api/social/signals` reads the stored `category='social'` notifications
  (complete + fast, never a live grab). **Remaining:** a Signals panel UI in the social app + a
  bot-assessment pass (cluster/prioritize stored signals) + mesh-notify for subscribing bots; the
  digest/email read should migrate to read this store too. X-paid path stays an optional upgrade.
- **X sensor is built but paywalled:** [scripts/oshal-x-read.js](../scripts/oshal-x-read.js) reads
  the connected account's home timeline + following. TESTED → X **free tier returns HTTP 402
  CreditsDepleted** on reads; needs **Basic (~$100/mo)**. Identity works free; reads don't.
- **Done when:** (1) a bot can register a watch (account/keyword/topic) with the social bot;
  (2) the social bot polls its sensors and XADDs a signal to the requesting bot's mesh stream
  on a match; (3) news-stream sensor works free; X sensor lights up when Basic is enabled.
  Likely an ADR — this is a new inter-bot capability, distinct from the content/branding surface.

**Verified 2026-07-19:** the "Remaining" list above is partly stale — the Signals panel UI (`GET /signals/ui`, social-signals.html) and the bot-assessment pass (`POST /signals/organize`, comms-bot grouped briefing) both shipped and are now STORE-owned after the social carve (`d9f45cc0`); mesh-notify for subscribing bots (the watch/XADD trigger layer, the done-when above) remains unbuilt.

### Rename email-summarizer → "Intelligent Communication" in all user-facing strings ✅ DONE (2026-06-15)
- **Verified:** the manifest `displayName` is "Intelligent Communication"; the email surfaces
  (email-inbox/my-day/social.html) all title "… — Intelligent Communication"; the persona role
  reads "… for the Intelligent Communication app". The only remaining `email-summarizer` strings
  are the internal manifest/persona/agent **id** (explicitly allowed) and a few **code comments**
  (not user-facing). No user-visible leak found.
- **What:** display is "Intelligent Communication" but the **email-summarizer** id leaks into UI.
- **Done when:** users only ever see "Intelligent Communication" (manifest id may stay).

### Capture CRM — broken ("not found")  ✅ broken surface removed (2026-06-16)
- **What:** `?app=capture-crm` iframed `localhost:8787` (an external `python crm/server.py` not
  part of OSHAL, not running) → "not found".
- **Done (2026-06-16):** removed the dead `ui.static` surface from `swarm-apps/capture-crm.yaml`.
  The app is **NOT deleted** — it keeps its real `capture-coordinator` bot (reachable via cockpit
  chat) + the shared RAG corpus. No more broken tile.
- **Remaining (real surface):** bake a **same-origin** Capture CRM board into the cockpit (kanban
  over the federal-capture tickets/opportunity data) and re-add a `ui.static` entry — the
  FAST-FOLLOW noted in the manifest. Then it becomes a fully-working app.

### Federal Capture — no surface  ℹ️ not broken — functional ticket workflow (greyed by choice)
- **What:** it's a real one-and-done workflow (`ticketType: federal-capture` → `capture` pipeline
  → `capture-specialist`). It has **no custom UI on purpose** — it runs through the cockpit Tickets
  view (`?app=federal-capture` filters to its ticketType). So it's *surfaceless-but-functional*,
  greyed in the catalog per the operator's walkthrough, not "broken".
- **Done when:** EITHER add a custom portfolio surface (overlaps with the Capture CRM board above —
  do them together), OR leave it as the deliberate ticket-driven worker. No action needed to be correct.

### OSHAL Engineering screens — normalize UX + verify data  ℹ️ functional — design polish deferred
- **What:** task-explorer / queue-dashboard / queue-manager-admin / mesh-dashboard /
  ops-dashboard / health-dashboard / config / redis-visibility / rag-center are **reachable + work**
  (verified: 302 auth-gated, they load + show live data) — they're just **old/outdated styling**
  (don't share the cockpit design system). Not broken; the deliberate all-swarms engineering/admin view.
- **Done when:** engineering screens adopt the cockpit design system + confirmed live-correct data.
  (Polish task — lower priority; the screens function today.)

### Ticket queues isolated per app/swarm — cockpit ticket view DONE; queue dashboards remain (folds into #8)
- **Already done:** the **cockpit Tickets view** is scoped per app — `TicketView._resolveActiveTicketType()`
  reads `?app=`, looks up the manifest's `ticketType` (`/api/swarm/apps/:name`), and filters
  `getTicketHierarchy(projectId, ticketType)`; `TicketModals` stamps new tickets with the app's
  ticketType. Backend stores/filter support `ticketType` end-to-end. So launching `?app=email-summarizer`
  shows only email tickets, `?app=social` only social, etc. No cross-app bleed in the main ticket list.
- **Remaining (→ folded into the OSHAL Engineering screens rework, #8):** the old **queue dashboards**
  (`queue-dashboard`, `queue-manager-admin`, `mesh-dashboard`, `ops-dashboard`) still show **global**
  queues/tickets across all swarms. Scope them per app when launched in an app context (or keep the
  Engineering app as the deliberate all-swarms admin view, but stop the per-app surfaces from showing it).
- **Gap to close:** apps that don't declare a `ticketType` (e.g. social, whose primary surfaces are
  Studio/Composer not tickets) fall back to unfiltered — fine for now, but give each ticket-bearing app
  an explicit ticketType.
- **Done when:** every per-app surface's ticket + queue views filter to that app's swarm.

## Swarm catalog — swarms bundled by type (ADR-038)

The pattern is proven (email swarm, ADR-037): **connector → bot (codex runs the
provider CLI) → cockpit surface.** Each item below is a category bundle. Each
provider added = a connector (`/utilities`) + a `scripts/oshal-<provider>.js` CLI;
never a new app.

### Operations & SecOps swarms — normalize ITSM/observability + rebuild ops (ADR-069) ⬜ NOT STARTED
- **Why:** the operator CLI toolchain (vault/terraform/kubectl/helm/argocd/aws/gcloud/az/ansible) and 46
  app connectors are built, but operations/observability never moved onto the connector runtime.
  ServiceNow + Splunk are ad-hoc **per-bot MCP servers** ([servicenow-mcp-server.ts](../src/mcp-servers/servicenow-mcp-server.ts),
  [splunk-mcp-server.ts](../src/mcp-servers/splunk-mcp-server.ts)) configured by global env vars, not
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
  Trivy; DB provisioned out-of-band per [runbooks/trivy-airgap-security-scanner.md](runbooks/trivy-airgap-security-scanner.md).
  Tests: `tests/unit/security-trivy-scanner.spec.ts` (11). *Remaining (deploy/env):* seed the offline DB
  + substitute the FIPS binary in the target enclave, then live-verify a scan files backlog tickets. Also
  fixed in the same pass: `POST /findings/:id/ticket` was dropping finding data into a Zod-stripped `payload`
  field — now carried in `metadata`.
- **Owner:** any engineer (Phases 1–4 are buildable now; Phase-4 go-live is review-gated).

**Verified 2026-07-19:** Phase 3 PARTIAL — the legacy OpenSearch push-intake is ripped out (04265e30) but not replaced with connector pulls nor the legacy RCA engine as worker; Phase 4 OPEN — no secops-analyst bot, no `?app=secops`.

### Email swarm — finish the providers
- **Built (2026-06-15):** Gmail (`oshal-gmail.js`, codex bot, Intelligent Communication
  surface). **Outlook / Microsoft 365 connector** (`PROVIDERS.outlook` in
  `connectors-routes.ts`, `/api/connect/outlook/callback`): Azure AD OAuth on the
  **tenant-specific** endpoint, **IMAP delegated scope** (`IMAP.AccessAsUser.All`) +
  `offline_access`, identity from the id_token (the IMAP scope can't call Graph `/me`).
  The live 302 was verified against real container env (correct oshal redirect + all 5
  scopes parsed). *Ready for the user to connect at `/utilities`.*
- **IMAP reader BUILT (2026-06-15):** `scripts/oshal-outlook-imap.js` — the read path for the
  IMAP-scoped connector (can't use Graph). Refreshes the MS token itself (IMAP scope), connects
  `imapflow` to `outlook.office365.com:993` via **XOAUTH2**, emits the **same digest JSON** as
  `oshal-gmail.js`. `MAIL_PROVIDER=yahoo` swaps the host (`imap.mail.yahoo.com`) so one reader
  covers Yahoo once a Yahoo connector exists. Adds the `imapflow` dep; baked in the image.
  (`oshal-outlook.js` is the Graph-scope variant — kept for tenants that grant `Mail.Read`.)
- **Untested against a live token** (no Outlook connection yet): code is complete + syntax/dep
  verified. First real connect validates the XOAUTH2 handshake. Remaining wiring: the email
  bot's persona/dispatch should select `oshal-outlook-imap.js` vs `oshal-gmail.js` by which
  provider the user connected.
- **Done when:** a user connects Outlook or Yahoo at `/utilities`, and the email bot
  produces a digest/draft from that account the same way it does for Gmail.
- **Owner:** any engineer.

**Verified 2026-07-19:** PARTIAL — Outlook send/IMAP paths exist (dormant until a microsoft connection); no live token test yet; Yahoo untouched.

### Social swarm — LinkedIn (MVP composer BUILT)
- **Built (2026-06-15):** `swarm-apps/social.yaml`; LinkedIn connector
  (`/api/connect/linkedin/callback`, scopes `openid profile email w_member_social`);
  `scripts/oshal-linkedin.js` (publish post + profile); `/api/social/*` (profiles,
  AI draft on the comms bot, publish via UGC Posts); the **Composer** surface
  (`?app=social`). Facebook read-only until Meta review.
- **X / Twitter connector BUILT (2026-06-15):** `PROVIDERS.twitter` — OAuth 2.0 + **PKCE**
  (S256; verifier carried encrypted in the signed state), HTTP Basic token auth (confidential
  client), refresh-token rotation, `/2/users/me` identity. `/api/connect/twitter/callback`,
  scopes `tweet.read users.read tweet.write offline.access`. Creds `TWITTER_CLIENT_ID/SECRET`
  (X_* fallback). **X publish BUILT (2026-06-15):** `scripts/oshal-x.js` (`POST /2/tweets`,
  self-refreshing the short-lived token) + `social-routes /post target=twitter` + `/profiles`
  reads the X handle. Publish stays inline/approval-gated (no auto-post). **Remaining:** the
  Composer surface's network toggle (LinkedIn|X) — the backend already accepts `target`. Live
  publish untested until the user connects X (the connector + button both work now).
- **Next providers:** Instagram/Threads, Mastodon (connector + CLI each).
- **Done when (composer MVP):** a user connects LinkedIn at `/utilities`, drafts in the
  Composer, and a real post publishes via Share on LinkedIn. *(Pending: user connects
  LinkedIn once to test a live post.)*

**Verified 2026-07-19:** the "Remaining" network toggle is DONE (d13c9523) — X + LinkedIn + FB; "recent X activity" is served via the inbox-as-feed workaround only.

**CARVED 2026-07-19 (`d9f45cc0`, ADR-085 Wave 2):** swarm-apps/social.yaml + social-routes.ts + the composer/workspace/signals/facebook-stream surfaces are ripped from the kernel and now live in the store package — surface/composer follow-ups (e.g. the Instagram/Threads/Mastodon providers above) belong there; the LinkedIn/X/Facebook connectors and publish CLIs stay core.

### LinkedIn AI Content Assistant — the orchestrated workflow (north star)
- **Built (2026-06-15) — Content Studio (research + topics + draft):**
  `scripts/oshal-research.js` replaces the dead Google Search MCP with keyless feeds
  (Hacker News / Reddit / Lobsters / RSS, focus-scored, deduped). `/api/content/*`:
  the api runs research, the comms bot (codex) clusters candidates into **leading topic
  cards** (`title / whyItMatters / angle / question`, cached 3h per user), and drafts a
  post from the user's take. `content-studio.html` (the **Studio** surface in `?app=social`)
  leads the user: hot topics → answer the card's question with your take → draft →
  **iteratively refine** (`POST /api/content/refine` + Studio chips: punchier / shorter /
  more technical / more personal / add a CTA / end with a question, or free-text — revises
  in place keeping the user's voice) → edit/save. **No posting to personal LinkedIn**
  (owner decision) — a bot on the
  **agenticfederal Page** is the future posting path. This is Milestones 2–4 (research,
  thought-capture, drafting) as a direct surface; the *queue-backed orchestrated* version
  below adds the ticket workflow, email/audio signals, and the approval gate.
- **Remaining (the full vision):** The full queue-backed swarm workflow per
  [docs/apps/linkedin-ai-content-assistant-requirements.md](apps/linkedin-ai-content-assistant-requirements.md)
  + [docs/architecture/linkedin-content-swarm-workflow.md](architecture/linkedin-content-swarm-workflow.md):
  `ticketType: linkedin-content-post` → `linkedin-content-orchestrator` with phases
  (signal-intake → topic-selection → user-commentary → draft → approval → publish).
  Mesh handoffs to the **email swarm** (`email-summarizer` for focus-query email
  context; `email-bot` for outbound alerts), a research/news bot, a writing/review bot,
  and `queue-bot` governance. **Audio + text commentary** is the primary post source;
  a hard **approval gate** (approval record required) before publish; workspace
  artifacts per phase. The Composer above becomes the "Draft Studio" inside this flow.
- **Why deferred:** large; build incrementally on the MVP foundation. Start
  **single-orchestrator** (one worker writing phase artifacts + child tickets), reuse
  existing STT for audio transcription, enforce the approval gate server-side.
- **Done when:** a `linkedin-content-post` ticket flows through the phases — email/web
  signal → topic card → user audio/text take → AI draft → approval record → live publish
  — all artifacts inspectable in the ticket workspace; nothing publishes without approval.
- **Owner:** any engineer.

**Verified 2026-07-19:** MOSTLY DONE — a `linkedin-content` ticketType + draft state machine + approval gate + Profile Studio all exist; realized as a single-bot flow, not the multi-phase orchestration above.

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

### Smart-home aggregation — the OSHAL edge-agent model (DECIDED DIRECTION, 2026-06-17) ⭐
- **Why:** operator's real goal is to **aggregate every smart-home ecosystem** (Alexa/Ring/
  Google Home/SmartThings/Matter/Fiat) under one roof with AI on top, after 5 years of
  per-provider re-entry + identity-fragmentation hell. Decision: **do NOT aggregate at the
  voice-assistant layer** (Alexa vs Google Home are walled gardens that fight). Aggregate one
  layer down on **Home Assistant**, which already integrates Ring, Google, SmartThings, Matter,
  AND Stellantis/Fiat. The OSHAL home-bot / cloud swarm is the AI brain on top.
- **CORE MODEL (operator's vision — NOT a hardware appliance):** aggregation needs a "body" on
  the home LAN that can physically reach devices, but that body is **software, not a special
  device**. It's a **lightweight OSHAL edge bot-node** (same bot-node pattern OSHAL already has,
  deployed to the edge) that:
  - runs as software on **any device the operator already owns** — laptop now, a cheap always-on
    host (mini-PC / old PC / NAS / generic Android-TV box) later for 24/7 automation;
  - **embeds Home Assistant Core as its device engine** (DECIDED — wrap HA Core's ~2,000
    integrations under the hood; user never "logs into HA"). For the IP/cloud subset OSHAL may
    talk natively, but HA Core is the coverage engine.
  - bridges local discovery (Matter/mDNS, WiFi devices, cloud-account integrations) up to the
    cloud swarm (the brain: reasoning, cost capture, multi-user).
- **Extension nodes (thin, point at the host — NOT the engine host):** phone = companion/voice/
  presence; smart speakers = streaming voice in/out add-on; **Fire TV Stick / Android-TV =
  display + voice + TV control surface** (sideloadable Fire OS/Android app; it IS the
  display-hijack vector — cast dashboard, launch apps, change input). A Firestick is too weak
  (~1–2GB RAM, Fire OS kills background services) to HOST HA Core — it's a thin surface, the
  engine runs on the always-on host.
  - **BUILT + COMPILED + LIVE on a real Firestick, 2026-06-23:** [packages/oshal-firetv/](../packages/oshal-firetv/)
    — native Android/Fire OS app, **Jarvis-first** (loads `<host>/api/jarvis/tv`): phone-as-mic
    (`/api/jarvis/remote`, scan the on-screen QR) → reply **shows + is spoken** on the TV via **Gemini
    neural TTS** (native Pico fallback); live conversation + tasks + online/firing bots; professional
    clamp-bounded UI with an animated eye. Sign-in is **device-link pairing** (TV shows a code →
    approve in a phone browser → HMAC token; Google blocks WebView login). **30-day token TTL +
    durable per-user revocation** (`POST /api/tv/pair/revoke` → `tv_token_revocations`); WebView
    hardened (no file/content access, mixed-content blocked). The Android toolchain (SDK + JDK 17 +
    Gradle 8.2) is installed on the dev box; APK compiled + sideloaded via `adb`. **Tested:** backend
    Playwright ([tests/firetv-tv-pairing.spec.ts](../tests/firetv-tv-pairing.spec.ts), in CI via
    `npm test`) + Robolectric `ConfigTest` (firetv-android.yml).
    **Does NOT** reproduce Amazon's native Ring PiP overlay (closed Amazon-internal). **Still TODO:**
    TV control (CEC/Cast/vendor APIs), an Alexa custom skill ("ask OSHAL to…"), Appstore-signed
    release + artwork, https-only/LAN-allowlist cleartext (Android NSC can't CIDR), security review
    of the pairing ingress.
  - **Roku + Samsung surfaces — BUILT (project, not yet compiled/published), 2026-06-22 (ADR-068):**
    Both are **Jarvis-first** (phone-as-mic / TV-as-display): scan the TV's QR → push-to-talk on the
    phone (`/api/jarvis/remote`) → the reply shows on the TV (`/api/jarvis/tv`); Smart Home is the
    secondary surface. [packages/oshal-samsung-tv/](../packages/oshal-samsung-tv/) — a **Tizen web
    app** that navigates top-level to `/api/jarvis/tv` (or `/api/home/ui?tv=1`); top-level so Google
    OIDC + the dashboard's `?tv=1` spatial-nav work. [packages/oshal-roku/](../packages/oshal-roku/)
    — **native BrightScript/SceneGraph** (no WebView) rebuilding the Jarvis screen over
    `/api/jarvis/history` + a scan-to-talk QR, device grid on `*`. **Login is by QR** ("scan to sign
    in"): pairing returns `qr_url` + `GET /api/tv/pair/qr` renders a QR PNG of the prefilled
    `/tv?code=` approval URL. Both reuse the existing Fire TV pairing rail
    ([src/app/routes/tv-pairing-routes.ts](../src/app/routes/tv-pairing-routes.ts)) — extended so the
    token is accepted via the `X-OSHAL-TV-Token` header (Roku has no cookie jar). **Room targeting**
    (no multi-TV echo): each TV claims a room (its own Jarvis session thread) via
    `POST /api/jarvis/tv/register` + heartbeat; the phone lists active rooms (`GET /api/jarvis/tv/rooms`)
    and a "send to: [room]" selector routes `/ask` to one screen's `sessionId`, so only that TV shows +
    speaks (a TV's scan-to-talk QR carries `?room=` to pre-select it). Runbook:
    [docs/tv-surfaces/roku-and-samsung-registration.md](tv-surfaces/roku-and-samsung-registration.md).
    **Still TODO:** compile/sideload on real devices; replace placeholder store artwork; **Roku spoken
    TTS** (Roku only displays the reply — no public channel TTS API); Roku host-entry screen;
    **security review of the pairing ingress** before public exposure; future platforms (Android/
    Google TV reuses the Fire TV APK, LG webOS reuses `?tv=1`, Apple TV reuses device-link).
- **TV "hijack" is real but bounded** by each TV's exposed protocol: Google Cast/DIAL (cast +
  launch apps), HDMI-CEC (power/input/volume), vendor APIs (Roku ECP, LG webOS, Samsung Tizen,
  Android TV). Can push a display / change inputs / control playback / launch apps; cannot paint
  arbitrary pixels on a TV that only exposes cast/launch.
- **Physics constraints (honest, not policy):** (1) something must stay **awake + on the LAN**
  for always-on automation — laptop works while on; 24/7 needs a cheap always-on host. (2)
  **IP/WiFi/Matter/cloud devices = pure software, no dongle**; only legacy **Zigbee/Z-Wave**
  need a ~$20 USB radio plugged into the host.
- **Phasing (DECIDED — laptop now, always-on host later):**
  1. Edge bot-node ships to run on the **laptop** first (works while it's on), embedding HA Core.
  2. Add an optional **cheap always-on host** later for 24/7 schedules + away-from-home + voice.
  3. Thin extension nodes (Firestick/phone/speaker) attach as display/voice/control surfaces.
- **Identity-fragmentation fix (the wife's-Ring-ID problem) is structural, not an API:** the one
  edge-agent/HA engine holds all integrations (Ring linked once *inside* it, under whatever
  account); the per-account chaos stays trapped there. OSHAL connects to that one engine as a
  **shared household** surface (existing connector-token isolation + ADR-042 personal∪shared).
  No re-linking per device, ever again.
- **Strategy: aggregate-first, Matter-migrate later.** Get the bot controlling devices AS-IS
  through the edge agent first; migrate devices to Matter opportunistically afterward to kill the
  root duplication. Do NOT block on any migration.
- **ARTIFACT DONE:** [ADR-047 (smart-home edge-agent)](adr/047-smart-home-edge-agent.md) —
  formalizes the edge bot-node (= the ADR-044 A2A device-as-swarm-node rail, toolset = co-located
  HA Core) + cloud-swarm brain + thin extension nodes + TV hooks + laptop-first phasing. Decisions
  locked there: HA-layer aggregation, embed HA Core (co-located, bridged via local API), laptop-first
  then always-on host, aggregate-first, security review gates phase 1.
- **NEXT (build):** Phase 1 per the ADR — edge bot-node on the laptop embedding HA Core, exposing
  `home.list`/`home.control`/`home.state` MCP tools; prove the home-bot controls 2 ecosystems
  (Ring + SmartThings) end-to-end, behind a security review of the new ingress.
- **Done when (phase 1):** the edge agent runs on the operator's laptop, embeds HA Core, and the
  home-bot can list + control devices spanning ≥2 original ecosystems (e.g. a Ring entity + a
  SmartThings light) from the cockpit, end-to-end, with the Firestick showing the dashboard.
- **Owner:** any engineer — this is the operator's top smart-home priority.

**Verified 2026-07-19:** OPEN — no HA-Core edge-agent embed exists.

### Amazon Alexa device control — Login with Amazon + certified Smart Home Skill
- **What:** A way for the home-bot to control Alexa-connected devices directly. Unlike
  SmartThings/Nest, Amazon offers **no public third-party REST API** — controlling devices
  requires **Login with Amazon (OAuth, Shape A)** *plus* a **certified Smart Home Skill**
  (AWS Lambda + Smart Home Skill API + Amazon's multi-week certification review). A
  Login-with-Amazon connector on its own is a *connector to nowhere* (token but nothing to
  actuate), which is why Alexa is documented-but-staged — see the appendix entry in
  [docs/partner-app-registration.md](partner-app-registration.md) (§ Amazon Alexa).
- **Mitigation in place (no skill needed):** most Alexa-controllable devices are also
  reachable via **SmartThings or Matter** (SmartThings acts as a Matter hub). Add the device
  in SmartThings → OSHAL controls it through the existing SmartThings connector. Build this
  skill **only** if a device is genuinely Alexa-exclusive.
- **Done when:** Login with Amazon registered under the business email, a certified Smart
  Home Skill (Lambda) deployed, redirect `/api/connect/alexa/callback` wired, and the
  home-bot can read state + actuate at least one Alexa-exclusive device end-to-end.
- **Owner:** any engineer — but defer until an Alexa-exclusive device actually demands it.

### DevOps swarm — Vault broker LIVE (ADR-040 activated 2026-07-18); ephemeral privileged runtime still the big open piece ⭐ (storage ✅ / social ✅ / devops broker ✅, runtime ⬜)
- **ACTIVATED (2026-07-18, commit 1285b483) — the facade is history:** the console at
  `/api/devops/console` now drives a **real backend** — superadmin-gated + audited, KV secrets,
  the broker loop (issue → scope → revoke) live-proven, and the **dynamic Postgres database
  engine** proven end-to-end (issue → connect → revoke → role dropped). Remaining from the
  ADR-040 build: **AWS STS engine** (needs operator cloud creds), **AppRole/cert auth methods**,
  and the **per-session wipe / ephemeral single-user runtime** — tracked in the two
  "DevOps/Vault — …" NEEDS-OPERATOR / NEEDS-DECISION items earlier in this file.
- **Design DONE + facade shipped (2026-06-16 — historical):** [ADR-040](adr/040-devops-vault-swarm.md)
  is the full architecture (vault-bot + vault-tool, dynamic config registration, controlled
  cred injection via the token-broker channel, ephemeral single-user runtime, lifecycle +
  security model, build order). A **Private Preview facade** shipped ahead of the build —
  catalog tile (badged "Private Preview", openable, NOT "coming soon") +
  [src/api/devops-vault.html](../src/api/devops-vault.html) control-panel surface (Vault config
  form, staged bot roster, capabilities, credential lifecycle) served at `/api/devops/console`
  via the devops swarm-app manifest. The bullets below are the original build plan — the broker
  portions are now live (above); the ephemeral-runtime portions are the open remainder.
- **What:** `swarm-apps/devops.yaml`: hypervisor CLIs (Proxmox, vSphere/ESXi, Hyper-V),
  a Terraform-writer bot, health-check tools. **Before** any of that, build the
  **ephemeral/isolated privileged runtime** (ADR-038 security model): strong auth
  (cert / SSH key / 2FA interactive "log in now", NOT a stored bearer); the bot serves
  **one user at a time**; after each cycle it **kills the session, wipes creds (per-session
  tmpfs), and logs out**; no shared-workspace secrets.
- **The Vault credential-broker model (operator's vision — the heart of this swarm):**
  - **`vault-bot` carries a `vault-tool`.** The vault-tool authenticates to **HashiCorp
    Vault** (AppRole / cert / token / whatever login method the operator configures —
    "however someone logs into Vault") and pulls **short-lived, scoped** cloud credentials
    (AWS STS, GCP, Azure) **per task**. The bot never holds long-lived cloud keys.
  - **Dynamic bot config registration.** The vault-bot + its tool register **live** into a
    running swarm (same rail as codex-packer's `POST /api/swarm/apps/load`) — the swarm
    gains the vault-tool + a Vault-settings panel without a redeploy. "Settings for Vault"
    = a per-swarm config surface (Vault addr, auth method, role/policy, secret path).
  - **Controlled cred injection = the token-broker pattern we already shipped.** Reuse the
    `applyUserScoping` channel (`.oshal-cred-*` per-request workspace files + scoped env,
    wiped after) so Vault-issued creds reach the bot's shelled tools the same way the
    Gmail/Twitter tokens do — controller brokers, bot never holds the master. **Proven:**
    The operator loaded agents with AWS creds and "had great results **when controlled**" —
    this swarm productizes that control loop (Vault issues → broker scopes → bot acts →
    session wiped). Pairs with [[oshal-connector-token-isolation]] + the DEK envelope crypto.
- **Why still open (updated 2026-07-19 — was "why deferred"):** the Vault integration itself now
  exists and is live (above); what doesn't exist is the single-user/ephemeral isolation +
  per-session credential wipe, which must precede any infra-touching tool going multi-user.
- **Done when:** a privileged bot accepts a Vault login (cert/AppRole/2FA), the vault-tool
  pulls a short-lived scoped AWS cred, runs one infra/hypervisor CLI cycle for one user, and
  provably wipes the credential + logs out at cycle end (test asserts no residual cred + no
  cross-user access). Vault settings are a registered per-swarm config panel. (Token auth + the
  dynamic Postgres engine are already proven; the AWS/AppRole/wipe clauses are the open part.)
- **Owner:** any engineer (security-reviewed).

**Verified 2026-07-19:** STALE framing — supersedes the "facade only / build still pending" lines above: the real broker is live (ADR-040 activated 1285b483; KV + issue/revoke + dynamic Postgres engine proven). Remaining: AWS STS, AppRole, per-session wipe.

### Apps page as a swarm catalog
- **What:** Make `/applications` a clear catalog: each bundle, the providers it includes,
  and per-provider connect-state ("Gmail connected / Yahoo not connected"), so a user
  knows exactly what loading a swarm gives them.
- **Done when:** the apps page lists each swarm bundle with its providers + live
  connect-state, and "load" activates the bundle (manifest + bots + surface).
- **Owner:** any engineer.

**Verified 2026-07-19:** OPEN — app activation badges only; per-provider connect-state is not on the catalog.

**Verified 2026-07-19 (completion-day):** LARGELY RESOLVED by `3014739f` — per-provider connect-state is now live on the connector Discover catalog: each card shows a Connected / Not-connected badge (from `/api/connect/list`) plus a per-user On/Off toggle (migration 091 override layer — usable = deployment-enabled AND NOT user-disabled, absence of a row = allowed). The `/applications` bundle view itself still shows activation badges only; the bundle-level rendition of connect-state remains open if still wanted, but the state + routes now exist to feed it.

## Connectors / multi-user

### Connector marketplace + dynamic tool loading (ADR-067) 🟨 PHASE 1/2 BUILT — 2026-06-22
- **Why:** cloud dev platforms ship a large connector catalog via a *marketplace* (browse/install);
  OSHAL has ~46 hand-curated connectors and the ADR-065 runtime to back them, but no catalog,
  discovery, install/enable, or mass-import. Goal: reach "hundreds of connectors" without bloating
  bots off a laptop. See [ADR-067](adr/067-connector-marketplace-and-dynamic-tool-loading.md) for the
  full architecture + the corrected mental model (it is **not** an MCP-only framework; CLI + API +
  RAG + Presentron all execute server-side, MCP runs only inside the CLI harness).
- **Hard constraint:** stay laptop-runnable. The previous bloat ("each bot the size of the api
  server") was **MCP subprocesses spawned per-bot** (`@playwright/mcp` alone ≈ 80–100 MB; 5 bots × 6
  servers ≈ 750 MB), NOT connector count — a connector spec is a ~2–5 KB in-memory `SpecClient` in the
  controller, zero per-bot weight.

  **Phase 1 — per-bot capability scoping (DONE 2026-06-22).** `EXECUTABLE_REGISTRY_TOOL_NAMES` and
  the Cline MCP server list are filtered by each bot's `capabilities[]`; covered by focused unit
  tests and the live agent startup manifest check.

  **Phase 2 — turn the API path on + wire spec tools (DONE 2026-06-22).** ADR-065 connector
  `tool:` resources are registered into the framework tool registry and execute through an
  in-process `connector` executor with broker-resolved caller credentials.

  **Phase 3 — marketplace index + installer + Discover surface.** `marketplace.json` (the
  git-subdir-manifest pattern proven by claude-plugins-official + awesome-codex-plugins), a
  `marketplace-routes.ts` (browse/enable/disable/remove), **lazy mount-on-enable** (today
  `mountConnectorSpecRoutes()` eagerly mounts ALL specs —
  [connector-spec-routes.ts:77](../src/app/routes/connector-spec-routes.ts)), and a `ui.static`
  cockpit Discover view. Reuse `auditConnectorCatalog` as the install gate.
  - **Done when:** a connector can be enabled/disabled per user/deployment from the cockpit and only
    enabled connectors are mounted; a 200+-entry catalog adds no footprint until entries are enabled.
  - **Verified 2026-07-19 (completion-day):** the per-user half DONE by `3014739f` — migration 091
    (`oshal_connector_user_enablement`, FORCE-RLS owner-or-operator), marketplace
    `enable/disableProviderForUser` + `-for-me` routes + `my-enablement`, the Discover On/Off toggle,
    and `resolveBotCreds` skipping a user-disabled connector; non-breaking default-allow so existing
    credentialed connectors never regress. Mount gating rides the deployment `providerGate` in
    `mountConnectorSpecRoutes` (per-user is enforced at broker/route level, the right layer). Guard:
    `tests/unit/connector-user-enablement.spec.ts`.

  **Phase 4 — mass-import pipeline.** A transpiler CLI: OpenAPI (`specFromOpenApi` exists) /
  Nango `providers.yaml` (Elastic License 2.0 — **reference data only**, don't vendor the runtime) /
  Activepieces pieces (MIT) → `connector.yaml`, prioritizing the **API-key/PAT** bucket (free —
  user brings the credential, no app registration). OAuth providers stay one-app-each + possible
  review per [partner-app-registration.md](partner-app-registration.md). Avoid Composio as a runtime
  dep (closed credential runtime + May-2026 breach).
  - **2026-06-23 01:57 CT update:** the working tree has **306** curated/local connector
    YAMLs under `swarm-apps/connectors` plus **1,000** generated OpenAPI connector YAMLs
    under ignored `output/connectors/imported-openapi`. The import report shows 2,500
    candidates processed to 1,000 imports, 981 skips, 0 failures, and 519 unprocessed
    after the target cap. Icon enrichment reports 621 verified Simple Icons and 379
    favicon fallbacks for generated specs, with 0 initials fallbacks and 0 failures.
    The Discover UI searches/filters and renders 96 cards at a time; the remaining
    competitive gap is credentialed onboarding/live reads and provider-specific auth
    repair, not connector YAML count.
  - **Done when:** the CLI emits audit-passing specs from at least one OpenAPI source AND `log()`s
    everything it skipped (opaque bodies, multi-scheme auth, audit failures) — no silent caps.

**Verified 2026-07-19:** Phase 3/4 PARTIAL — cockpit enable/disable + tool (de)registration + the import CLI are done (Phase 4 import CLI confirmed shipped); enablement is deployment-level not per-user, and spec routes still boot-mount rather than lazy mount-on-enable.

**Verified 2026-08-01:** lazy mount-on-enable is **still OPEN** and is now the last item here —
`mountConnectorSpecRoutes` still mounts every enabled spec at boot. Not attempted this pass (a clean
subset beat a sloppy sweep). **Done when:** enabling a connector mounts its router at that moment and
disabling unmounts it, with a guard proving a disabled connector's route 404s BEFORE and AFTER an
enable/disable cycle. Note before starting: an Express router cannot simply be removed from the
stack, so the honest shape is probably a stable per-provider mount that delegates to the gate rather
than a real unmount — decide that first, or the "lazy" in the title will not survive contact.

### connectors-routes.ts is past the decomposition threshold (967 code lines)

- **Reason:** CLAUDE.md says stop and propose a plan at 800 code lines. The file was already at 943
  when the multi-account work landed and is now 967 — under the 1000 hard cap, but the multi-account
  change should have proposed this instead of adding to it. Recording it rather than leaving the next
  person to discover it at 1001.
- **The shape it wants** (mechanical, no behaviour change): the file is really four things wearing one
  hat. (1) The PROVIDERS registry + per-provider client-credential resolution + redirect/scope
  handling — roughly 600 of the 967 lines, pure data plus small pure functions, and the part that
  grows every time a connector is added. (2) The OAuth ceremony (state signing, PKCE, exchangeCode,
  the flavor branches). (3) The Express routes. (4) `getValidAccessToken`, which several other modules
  import from here — note that `connector-token-broker.ts`, `connector-action-routes.ts` and
  `linkedin-assistant-routes.ts` all import it, so moving it is the one step with real blast radius
  and wants its own commit.
- **Done when:** the registry + creds move to a `connector-providers.ts` and the ceremony to a
  `connector-oauth.ts`, `connectors-routes.ts` keeps only the router, every importer of
  `getValidAccessToken` still resolves (re-export from the old path if that keeps the diff honest),
  and `npm run test:unit -- tests/unit/connector-multi-account.spec.ts
  tests/unit/connector-token-lookup-scope.spec.ts` stays green with no test edits — a decomposition
  that needs its guards rewritten was not a decomposition.

### ✅ Multi-account-per-provider — DONE 2026-08-01 (ADR-113 section 4 unblocked)

- **Was:** `oshal_connections` declared `UNIQUE (user_sub, provider)` in the runtime CREATE TABLE.
  `ensureTenancySchema` dropped it again a moment later, so a fresh local boot worked by accident —
  but the bootstrap does nothing under `OSHAL_SCHEMA_BOOTSTRAP=validate-only` and there was no
  migration, so a migration-driven deployment kept the constraint and the second connect's
  ON CONFLICT quietly UPDATED the first account. The user saw "connected". One account.
  `scripts/migrations/101-connections-multi-account.sql` is the owner-role half; the runtime mirror
  stays for a fresh local boot.
- **Three more things had to be true.** REACHABLE: Google's default `prompt=consent` re-authorises
  whichever account the browser is already signed into, so `/start` now forces the provider's account
  chooser once the caller holds a connection (or asks with `?another=1`). DETERMINISTIC: resolution
  fell back to the first row of an `updated_at DESC` list, and updated_at is rewritten by every token
  refresh — so with two accounts and no marked default, "the user's Gmail token" changed identity
  between two calls. SURVIVABLE: `DELETE /:provider` revoked ONE refresh token and then deleted them
  all, leaving live grants at the provider for the rest.
- **The resolution rule** (pure + exported as `pickConnection`): ownership-scope narrowing → an
  explicit selector (connectionId, then label, then account email; a named selector that matches
  nothing returns null, so a bot asks instead of acting on the wrong account) → the account the user
  MARKED default → the only candidate → a stable tiebreak (household-first, then `created_at`, then
  `connection_id`). Never recency. `upsertConnection` seeds exactly one default per (ownership scope,
  provider) and both disconnect paths re-seed it, so the marked-default branch is the normal path.
- **The seam for consumers** (switchboard's multi-source slice, store PR #29): `/api/connect/list`
  publishes `defaultConnectionId` + `multiAccount` per provider alongside `connections[]`;
  `/api/connect/:provider/access-token` already selects by `?connection=` / `?label=` / `?email=`;
  and `resolveBotCreds` takes an optional per-provider selector, logging at WARN when a provider has
  several accounts and nobody said which.
- **Still open:** nothing in the kernel. Household (`tenant_id`-owned) connections are still removed
  by a tenant admin only (ADR-042 Phase 3) — unchanged by this work.
- Guard: `tests/unit/connector-multi-account.spec.ts`.

### ✅ Secrets out of bot containers — token broker DONE + VERIFIED (2026-06-15)
- **Done:** `connector-token-broker.ts` `resolveBotCreds()` decrypts the caller's google/twitter
  tokens controller-side and threads them (`BotNodeRequest.creds` / `ProcessMessageOptions.creds`)
  to the bot's per-request workspace as `.oshal-cred-<provider>` files. `oshal-gmail.js`/
  `oshal-x-read.js` prefer the provided token (no DB, no key); DB+sub-scoping kept as fallback.
  `SESSION_SECRET` removed from the `x-bot-env` anchor (controller-only); `applyUserScoping` scrubs
  `SECRET_ENV_KEYS` from every in-controller codex spawn. **Verified:** email-bot reads Gmail with
  `SESSION_SECRET`+`DATABASE_URL` unset; email-bot container env has no key; in-controller codex
  `printenv SESSION_SECRET` → empty; controller still holds the key + broker works.
- **Remaining (low):** (1) a full `--force-recreate` of ALL bot containers drops `SESSION_SECRET`
  everywhere (only api+email-bot recreated so far; other bots don't read connector tokens).
  (2) Per-user DEK / envelope encryption (defense-in-depth on the controller) still open below.

**Verified 2026-07-19:** PARTIAL — SESSION_SECRET controller-only is done; envelope crypto (`OSHAL_ENVELOPE_CRYPTO`) remains default-OFF and enabled nowhere.

**Verified 2026-07-19 (completion-day):** envelope crypto is no longer default-off — `e1c4b4b1` flipped `OSHAL_ENVELOPE_CRYPTO` **default off→on** (explicit `false/0/no/off` = rollback). It is legacy-blob-safe: `decryptToken` stays format-aware, so pre-existing single-key blobs keep decrypting under the same `SESSION_SECRET` — no already-connected user is stranded, existing tokens upgrade to `v2:` on next write. Key absence FAILS LOUD (`kek()` throws when crypto is on and `SESSION_SECRET` is unset; `connectors-routes.ts` logs it at boot) — no weak-key/plaintext downgrade; **deploy requires `SESSION_SECRET` set** (production always has it). Guard `tests/connector-token-crypto.spec.ts` extended (default-on round-trip, legacy decrypt under default, off-rollback, per-user isolation, key-absent-fails-loud, key-absent-tolerated-when-off). Live stack runs crypto ON with `SESSION_SECRET` present, so the "⬜ To activate" bullet under the Storage entry below is now satisfied.

### (historical) 🔴 Secrets out of bot containers — token broker (HIGH PRIORITY, pre-multi-user) — 2026-06-15
- **The hole:** `SESSION_SECRET` (the AES key for ALL connector tokens) + `OIDC_CLIENT_SECRET`
  live in the shared `x-bot-env` anchor → **every bot container has them**. Bots run codex with
  `danger-full-access`, so a compromised/injected swarm can `printenv SESSION_SECRET`, read
  `oshal_connections`, and decrypt EVERY user's tokens. Untrusted swarm code must not share a
  container with the master key.
- **Why we can't just delete it:** `oshal-gmail.js`/`oshal-x-read.js` run IN the bot and decrypt
  tokens with `SESSION_SECRET`. Remove it and the bots can't act on accounts.
- **Fix — token broker (controller-mediated secrets):** the CONTROLLER (api) is the only holder
  of keys + decryption. When a bot needs to act on a user's account, the controller resolves +
  decrypts that ONE user's token and passes a **short-lived, single-user scoped access token** to
  the bot per-request (extend the per-request channel we already built — today it carries
  `OSHAL_USER_SUB` via the workspace `.oshal-user-sub` file; carry the resolved token the same way,
  short-TTL). The bot uses the provided token, never holds `SESSION_SECRET`, never reaches the
  store. Blast radius of a compromised swarm = one short-lived token for the one user it serves.
- **Also:** never write user-provided creds to `process.env` — encrypted store only; pairs with
  the per-user DEK / envelope-encryption item below. OAuth *app* creds stay controller-only
  (already true for GitHub).
- **Done when:** no bot container has `SESSION_SECRET`/connector secrets in env; bots receive only
  short-lived per-user tokens from the controller; a swarm reading `printenv` learns nothing reusable.

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
    ([ADR-041](adr/041-per-user-storage-targets.md): Code/Files buckets → Dropbox/GitHub/
    OSHAL-local, settings page `/api/storage`, `saveContent` resolver, OSHAL-local 250 MB quota),
    **Storage + Presentations apps surfaced ✅** (catalog tiles). Presentations generates real
    .pptx (pptxgenjs, Presenton replacement) → saves to the Files target.
    Remaining: GitHub-as-target for large/tree code (build-swarm push, not contents API); the
    swarm→storage write path for build outputs; the data-management bot (below).

**Verified 2026-07-19:** MOSTLY DONE — 250MB quota enforced (storage-target.ts:49), upload/download work, GitHub/Dropbox/local write+delete all in place; only the large-tree multi-file git push remains.

**Verified 2026-07-19 (completion-day):** RESOLVED — supersedes the MOSTLY-DONE stamp above. `ab3a961a` added `pushTree` to `storage-target.ts` (+ guard `tests/unit/storage-target-tree-push.spec.ts`): a whole file tree is pushed to GitHub as ONE commit via the git Trees/Commits API (blobs → tree → commit → ref update), closing the "GitHub-as-target for large/tree code (build-swarm push, not the contents API)" residual. The swarm→storage write path for build outputs and the data-management bot remain separate items above.

### Data-management / storage bot (ADR-041 layer 3)  ✅ BUILT as the Storage Assistant (2026-06-16)
- **Done:** `POST /api/storage/assistant` + the **Assistant** tab in the Storage app — chat to manage
  storage. The comms bot parses the request into a structured action; the controller executes it with
  the caller's token (ADR-036): `create_repo` ("make me a repo"), `set_target` ("save my files to
  Dropbox"), `get_prefs` ("where do my files save?"), `list_files`. Reliable (controller acts, no DB
  creds in the bot); `create_repo` is the only outward action + only on request. Tools reused:
  `createGithubRepo`, `setStoragePrefs`/`getStoragePrefs`, Dropbox list.
- **Remaining (polish):** a DEDICATED bot node (vs the comms bot doing NLU) with a `selector_descriptor`;
  more actions (move/delete/share); the "send this build's code to repo X on completion" auto-route.
- **What:** a bot that OWNS the storage domain (ADR-036): edits the storage prefs AND has tools
  to act — `github_create_repo`, make a folder, `storage_write`/move, read/write prefs — so the
  operator can just chat ("make me a new GitHub project", "send this build's code to repo X on
  completion", "where are my decks?"). The Storage settings page becomes a view over its config;
  `resolveStorageTarget`/`saveContent` are tools it also uses.
- **Why deferred:** the foundation (prefs + resolver + save + settings page) had to land first —
  the bot is the conversational face over those tools.
- **Done when:** a real bot node (persona + container + registry) with the storage tools can,
  from chat, create a repo and set a bucket's target, and a subsequent generation saves there.

**Verified 2026-07-19:** PARTIAL — a dedicated storage-assistant node exists in the registry (agentId …041), superseding "comms bot doing NLU"; storage.yaml prose is stale; move/share actions + the auto-route-builds path remain open.

**CARVED 2026-07-19 (`351219d1`, ADR-085 Wave 2):** the Storage surface (storage-assistant.html + storage-settings.html + storage-routes.ts + swarm-apps/storage.yaml) is ripped from the kernel and now lives in the store package — assistant/action follow-ups belong there; the storage-target engine and the `/api/files` browser stay kernel per the surface-only rule.

**Verified 2026-07-19 (completion-day):** the "move/share actions" residual shipped **store-side** (`appstore-v0.44.0`, oshal-applications) — now that the Storage surface is carved (`351219d1`), the assistant move/share actions live in the store package's storage app, not this kernel. The dedicated storage-assistant node (agentId …041) and the storage-target engine stay core; the "send this build's code to repo X on completion" auto-route-builds path remains open (store-side).

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

### Per-user token routing through bot execution ✅ DONE + VERIFIED (2026-06-15)
- **Done:** The caller's OIDC `sub` is threaded into bot execution on BOTH transports —
  remote dispatch (`BotNodeRequest.userSub` → `/api/swarm-execute` → executionHandler →
  AgenticController → CLI wrapper) and interactive chat (`message-routes` → `processMessage`
  → AgenticLoop → HarnessTask → in-controller CLI adapter). Centralized for ALL harnesses
  (bots are user-configurable): `BaseCliHarnessAdapter.applyUserScoping` + any-bot
  `codebase/user-scoping.js`. The sub reaches shelled tools via env `OSHAL_USER_SUB`
  (claude/gemini/cline propagate env) AND a `.oshal-user-sub` task-workspace file (codex
  strips env). `oshal-gmail.js` reads either and ignores `GMAIL_ACCOUNT` when the sub is
  present — codex cannot override. **Verified:** sub 106925→gmail, 100447→emeraldcoast on
  both transports. Safe for multi-user sign-up on connector data.

### (historical) Per-user token routing — original deferral note
- **What:** Bots that act on a connected account (email-bot via `scripts/oshal-gmail.js`,
  future Facebook/Calendar actions) must use the **requesting user's** token, fetched
  via `getValidAccessToken(userSub)`. Today the requesting user's OIDC `sub` is not
  propagated all the way into bot execution, so the bot cannot auto-select the right
  account. `oshal-gmail.js` now **fails closed** when >1 Google connection exists and
  `GMAIL_ACCOUNT` is unset (multi-tenant safety), but that is a guard, not the wiring.
- **Why deferred:** threading user identity through the dispatch envelope →
  `bot-node-execution-handler` → the bot's tool invocation is an execution-path change
  that needs to preserve the existing taskId/workspace contract; out of scope for the
  connectors enablement pass.
- **Done when:** a bot acting in a conversation can resolve the requesting user's `sub`,
  call `getValidAccessToken(sub, provider)` (or pass `GMAIL_ACCOUNT` derived from it),
  and a test proves user A's chat never reads user B's mailbox even with both connected.
  See [docs/architecture/connectors-tenant-isolation.md](architecture/connectors-tenant-isolation.md).
- **Owner:** any engineer.

## Infrastructure

### Docker Desktop port-forward wedge on Windows
- **What:** `localhost:35457` periodically stops responding while the api
  container's internal `localhost:5000` keeps serving fine. Recovery is
  `docker stop` + `docker start` (in `scripts/api-bounce.sh`); compose
  restart is insufficient for the deepest wedge state.
- **Why deferred:** vpnkit/Docker Desktop bug, not application code.
- **Done when:** identified upstream issue (Docker Desktop release note
  closing the bug, or specific request pattern that triggers it), AND
  either DD upgrade fixes it OR we have a passive watcher script that
  detects + auto-recovers without operator intervention.

**Verified 2026-07-19:** PARTIAL (done-when met via the root-cause branch) — the wslrelay `::1` squatter is root-caused with a runbook + the `127.0.0.1` workaround repo-wide; no auto-recovery watcher exists.

## Bots / workflows

### incident-remediation-bot has no dedicated ticket-type workflow ✅ DONE (2026-06-15)
- **Done:** added `swarm-apps/incident-remediation.yaml` (since folded into [swarm-apps/intelligent-operations.yaml](../swarm-apps/intelligent-operations.yaml)) —
  `ticketType: incident-remediation`, `workflow.pipeline: incident-rca`,
  `workflow.workerBot: incident-remediation-bot`, declaring the bot (agentId e0000000-…-100,
  persona, full capability set). One-and-done (no reviewer): remediation output is scripts +
  a report for human review, never auto-applied. Manifest validates + workerBot matches the
  declared bot; boot auto-load registers the ticket type → worker mapping.
- **What:** [src/app/extensions/swarm/swarm-bot-registry-local.ts](../src/app/extensions/swarm/swarm-bot-registry-local.ts) declares `incident-remediation-bot` with rich capabilities (k8s / aws / splunk / servicenow inspection, remediation-scripting). The bot has a persona at `ai-lab/bot-personas/incident-remediation-bot.yaml`, its own container in `docker-compose.oshal-local.yml`, and a dedicated compose service in `docker-compose.incident-lab.yml`. But no `WORKFLOW_PIPELINES` entry or `swarm-apps/*.yaml` manifest names it as `workerBot`, so the only way to reach it today is build-pipeline capability matching or operator-direct dispatch.
- **Why deferred:** the bot works via capability routing; "ticket-type → worker" is the architectural default but not the only valid pattern.
- **Done when:** either a `swarm-apps/incident-remediation.yaml` manifest is added (declaring `ticketType: 'incident-remediation'` + `workerBot: 'incident-remediation-bot'` + `pipeline: 'incident-rca'`), OR the bot is intentionally documented as "capability-routed only" in CLAUDE.md.

## Workflow Studio

> Roadmap context: see [ROADMAP.md](../ROADMAP.md) → "Next" and "Later".

### Compile-to-runtime: canvas definitions become executable workflows
- **What:** Workflow Studio's compile step produces a *descriptive preview* only
  ([src/features/workflow-studio/services/workflow-studio-compiler.ts](../src/features/workflow-studio/services/workflow-studio-compiler.ts)). Runtime
  workflows are still registered exclusively from `swarm-apps/*.yaml` manifests via
  `WorkflowPipelineRegistry`. A canvas saved in the studio cannot be dispatched.
- **Why deferred:** the canvas data model and node catalog are still settling; the
  runtime services (`PlanningRoundOrchestrator`, `PhaseRoutingService`,
  `TicketCycleStateMachine`, etc.) remain authoritative and must not be forked.
- **Done when:** a compiled canvas definition can be registered as a ticket-type
  workflow the queue-manager dispatches (equivalent to a manifest `workflow` block),
  with a test that authors a canvas, publishes it, submits a ticket of that type, and
  reaches `complete`.

**Verified 2026-07-19:** PARTIAL — supersedes the "descriptive preview only" line above: compile-to-runtime (Publish) shipped for the simple case; the branching/parallel canvas path remains open.

**Verified 2026-07-23 (LIVE):** the done-when's publish→ticket→complete chain proven against the
running docker stack (single-shot spec → graph nodeGraph → ticket
`c9c00a66-d43c-4df4-bee4-a42f2431d50f` reached `complete`, real bot execution + run history —
details under "Workflow Studio — test-run, run history, run inspector"). The unit half of the
done-when already exists (`tests/unit/workflow-authoring-e2e.spec.ts`). Remaining: graph-mode
(branching/parallel) live proof + a repeatable live spec.

### Agentic authoring: describe a workflow, an agent builds the canvas
- **What:** Today the canvas is hand-authored on a drag-and-drop surface, and
  `codex-packer` is the only agentic authoring path — and it emits *bots*, not full
  workflows. The intended end-state is an agent that takes a natural-language
  description and composes the canvas (workflow + agents + gates + goals). The canvas
  remains the single end-state representation, whether produced by the agent or by hand.
- **Why deferred:** depends on compile-to-runtime landing first (an agentic author
  needs a canvas that can actually execute).
- **Done when:** an operator can describe a workflow in natural language and receive a
  saved, valid, executable canvas, editable afterward in the manual designer.

**Verified 2026-07-19:** PARTIAL — describe→canvas shipped for the simple case; full agentic authoring (composing brand-new agents/goals) remains open.

## Agents & A2A

> Roadmap context: see [ROADMAP.md](../ROADMAP.md).

### A2A external/remote-agent gateway productionization
- **What:** A2A types ([src/shared/types/a2a.ts](../src/shared/types/a2a.ts), transports
  `headscale-http`/`http`/`sse`/`stdio`) and a remote-client MCP bridge
  ([src/features/remote-client/](../src/features/remote-client/)) exist, but internal swarm
  coordination still runs over the Redis mesh and there is no documented end-to-end
  proof of an external A2A agent joining a live swarm.
- **Why deferred:** ADR [013](adr/013-headscale-self-hosted-overlay-network.md) and
  [014](adr/014-any-bot-k8s-headscale-gateway.md) are *Proposed*, not Accepted.
- **Done when:** an external/remote A2A agent registers, receives a task envelope, runs
  it, and returns a result that advances a ticket — with the run documented.

### One-call create-and-start agent transaction ✅ DONE 2026-07-19 (header reconciled 2026-07-24)

**Verified 2026-07-24 (diagnosis fleet):** shipped 2026-07-19 — `POST /api/swarm/agents/create-and-start`
(`agent-factory-routes.ts`) → `createAndStartAgent` with rollback-on-launch-failure
(`rollbackCreatedAgent` removes the dynamic-compose entry then deletes the profile), mapped to
201/409/400/500 and 502+`rolledBack`. Guard: `tests/unit/agent-create-and-start.spec.ts` (11 tests).
ROADMAP + framework-developer-guide reconciled in the same 2026-07-24 change.

- **What (historical):** Dynamic agent creation was two steps (`POST /api/swarm/agents` then
  `POST /api/agents/:agentId/launch`). Live Docker E2E passed 2026-05-09.
- **Why deferred:** create (persona/registry) and start (compose container) are separate
  concerns; closing them into one transaction needs rollback handling.
- **Done when:** a single API call creates and starts a bot-node container with
  heartbeat + mesh subscription, rolling back cleanly on partial failure.

**Verified 2026-07-19:** OPEN — create and launch remain two calls; no rollback transaction.

**Verified 2026-07-19 (completion-day):** RESOLVED by `4e494b4f` — supersedes the OPEN stamp above: `POST /api/swarm/agents/create-and-start` (same requiresAuth-mounted agent-factory router, route-auth inventory green) creates + launches via `deployWithContainer`, and on ANY launch failure (compose registration, container start, spawner unconfigured) rolls the creation back — `removeService` + `deleteAgent`, falling back to marking the profile inactive when deletion fails, so a failed launch never leaves a routable persona-only zombie (502 carries `rolledBack`). Guard: `tests/unit/agent-create-and-start.spec.ts` (11 tests).

## Config ownership & sync (ADR-034)

> Bidirectional any-bot config ownership/sync shipped on the `any-bot` runtime and was
> proven end-to-end on local docker (push-down 0→1, broadcast-up reconcile 1→2→3, plus
> the `scripts/oshal-local-checks.sh` 10/10 suite). See
> [ADR-034](adr/034-bidirectional-config-ownership-sync.md). Remaining follow-on:

**Verified 2026-07-19 (all four follow-ons):** OPEN — no config-change envelope from bot-node-server; execute still self-resolves provider/model; no boot bootstrap-pull; the three runtimes are all still live.

### Close the `bot-node` runtime broadcast gap
- **What:** The broadcast-up hook lives in the `any-bot` runtime ([any-bot/server/swarm-node.js](../any-bot/server/swarm-node.js))
  and the full server ([any-bot/server/app.js](../any-bot/server/app.js)). The compose default
  worker runtime is `bot-node` ([src/app/bot-node-server.ts](../src/app/bot-node-server.ts)),
  which does not yet publish a config-change envelope on a local config change.
- **Why deferred:** the demo ran a bot as `BOT_RUNTIME=any-bot`; closing the gap means
  either porting the hook into `bot-node-server.ts` or standardizing workers on `any-bot`.
- **Done when:** a default `bot-node` worker broadcasts its local config changes and the
  controller reconciles them (extend `scripts/oshal-local-checks.sh` to assert it).

### Push-on-dispatch param enforcement
- **What:** Config *sync* is done, but `swarm-execute` still runs the bot's self-resolved
  provider rather than the `providerId`/`model` OSHAL carries per task (the fields exist on
  `BotNodeRequest` but the handlers drop them).
- **Why deferred:** touches the load-bearing dual dispatch path; warrants its own reviewed change.
- **Done when:** a dispatched task executes with OSHAL's authoritative provider/model and the
  bot echoes the applied `configVersion` for drift detection.

### Bot bootstrap-pull on boot (env-as-seed)
- **What:** On boot the bot restores from its own cache; it does not yet pull its
  authoritative record from OSHAL when reachable. `ANTHROPIC_API_KEY`/`FORCE_LLM_*` are still
  steady-state authorities rather than first-boot seeds.
- **Done when:** a reachable-OSHAL bot pulls its record on boot and overwrites its caches;
  env vars defer to the pulled record; standalone (offline) boot still works.

### Consolidate the dual/tri runtime
- **What:** Three runtimes exist for a bot — `app.js` (full), `swarm-node.js` (slim any-bot),
  `bot-node-server.ts` (TS worker). This is the root of the config-ownership contention and
  the breadth gaps in the audit.
- **Done when:** one canonical bot runtime, with the others removed or clearly demoted.

## Tools

### Embedded LLM tools as a formal third tier
- **What:** Two tool tiers are modeled — the shared OSHAL registry
  ([src/features/tool-registry/](../src/features/tool-registry/)) and each harness's native
  tools. Provider-native ("embedded") LLM tools (e.g. a provider's own web search) are
  used opaquely, not modeled as a managed tier.
- **Why deferred:** embedded-tool surfaces differ per provider; modeling them needs a
  per-provider capability map.
- **Done when:** embedded LLM tools can be enabled/disabled per agent alongside the
  shared and native tiers, with the active set visible in the cockpit.

## Models

### Repeatable self-hosted local-LLM swarm profile
- **What:** Ollama / LM Studio / LiteLLM are wired in
  [src/features/llm-provider/services/provider-definitions.ts](../src/features/llm-provider/services/provider-definitions.ts);
  Llama and Mistral run local via Ollama. `gpt-oss-120b` is offered via the Cerebras API
  (not self-hosted). Historically `gpt-oss-20b` ran in the ai-lab Kubernetes config on
  AWS as a single-threaded POC swarm; `gpt-oss-120b` was not, because the AWS spend
  (~$100k/mo) was not justified for a POC.
- **Why deferred:** a reproducible local-swarm profile needs GPU sizing guidance and a
  benchmark harness, not just provider wiring.
- **Done when:** a documented compose/K8s profile runs an all-local swarm (e.g. `gpt-oss`
  on Ollama) end-to-end on a ticket, with a recorded benchmark.

## Code governance

> Roadmap context: see [ROADMAP.md](../ROADMAP.md) → "Code health".

### Decompose files over the 1000-line hard cap ✅ (2026-07-11; final holdout cleared 2026-07-18)
- **What:** [CLAUDE.md](../CLAUDE.md) declares a **1000-line hard cap — no exceptions** (measured
  in CODE lines: comments/blanks excluded, html/md exempt), with a decomposition plan required at
  800 lines. The 2026-06-07 audit listed 19 offenders; by 2026-07-11 the live count was 12
  (7 fixed in between, 5 new growers). The 2026-07-11 burn-through decomposed all of them behind
  their existing interfaces with per-file equivalence proofs (route-surface dumps, verbatim-move
  checks, side-by-side method harnesses, tsc + focused specs green, commit-per-file on main):
  `any-bot/server/app.js` (4259→314), `QueueManagerService.js` (3597→342),
  `queue-manager-service.ts` (2069→727), `workflow-studio.js` (1470→299),
  `seed-tools.ts` (1330→140), `google-workspace-cli.js` (1209→112),
  `trading-routes.ts` (1186→162), `LLMProviderRegistry.js` (1146→29),
  `ui-logic.js` (1085→388), `process-lab-service.ts` (1034→581), `server.ts` (1024→761).
- **Remaining over-cap: 0 files ✅ (2026-07-18, `b0757df4`)** — `src/app/routes/jarvis-routes.ts`
  had grown to ~2481 code lines (2.5× the cap). Decomposed VERBATIM into 7 cohesive siblings under
  `src/app/routes/`: `jarvis-{directives,provider-intent-detect,visuals,tool-catalog,overview,task-store,orchestrator}.ts`.
  The public surface (the ~28 symbols the 5 jarvis unit specs + `server.ts` + `privacy-routes.ts`
  import) is **re-exported from `jarvis-routes.ts`**, so every importer resolves unchanged.
  `JARVIS_CLIENT_ASSETS` + `serveJarvisClientAsset` + `/assets/:file` kept LITERALLY in
  `jarvis-routes.ts` (pinned by `jarvis-speaker-wiring`'s source-assertion test). Result: `jarvis-routes.ts`
  ~761 code lines. Behaviour-preserving: `tsc --noEmit` clean, full unit suite 2728 passed, clean live boot.
- **`orchestrate()` — the dead ADR-050 v1 classify→delegate→synthesize path** (zero call sites; `POST
  /ask` goes through `runJarvisBot`) was MOVED verbatim into `jarvis-orchestrator.ts` rather than deleted,
  to keep the decomposition strictly behaviour-preserving. It (plus its orchestrate-only helpers
  `buildClassifyPrompt`/`buildSynthesisPrompt`/`delegateOne`/`resolveHandoffs`) is still a ~200-line
  no-behaviour-change deletion available in that file for a future cleanup — note `loadEffectiveRoutes`
  is NOT orchestrate-only (also used by `GET /catalog`), so keep it.
- **Done ✅:** jarvis-routes.ts under cap behind the same registration interface, `tsc --noEmit` passes,
  jarvis specs green.
- **Note:** 16 files sit in the 800–1000 "propose-decomposition" warn band (largest:
  `ticket-view-detail-renderer.js` 988, `jarvis-ambient.js` 961, `TaskController.js` 958);
  address opportunistically before they cross the cap.

### Documentation-standard backfill (completed 2026-06-07)
- **What:** As of 2026-06-07, a backfill pass added the required Change Log header to the 140
  TS/JS and 42 sh/sql source files that lacked one, and brought their exported members up to the
  JSDoc standard. The already-headered files were audited for JSDoc coverage.
- **Done when:** every tracked source file carries the Change Log header and exported members
  carry `@description` (+ `@param`/`@returns` where applicable). Track any residual gaps here.

### Harden inline controller bots (token-broker rollout, phase 2) 🟨 LARGELY CLOSED 2026-08-01
- **What:** The per-app chat bots `social-writer`/`storage-assistant`/`deck-builder` — and the
  pre-existing `codex-packer`/`project-manager` — run INLINE in the
  `oshal-api` (controller) container, which holds `SESSION_SECRET` (the master connector-token
  key) + `DATABASE_URL`. Those bots have `Bash` (via `CLAUDE_ALLOWED_TOOLS`), so in principle a
  bot could read the controller's env and reach beyond the chatting user. The acute case
  (`social-writer` purpose-built to handle per-user data inline) was mitigated by moving the
  social-data access to `communications-bot` (its own no-master-key container) and stripping
  `social-writer`'s shell/DB access. The general pattern remains.
- **Why deferred:** removing `Bash` per-bot needs the persona→harness `allowedTools` wiring (not
  just the global `CLAUDE_ALLOWED_TOOLS` env), or moving inline bots out of the controller into
  their own containers — both behavior-bearing changes, not a wrap-up edit.
- **Done when:** controller-resident bots cannot read `SESSION_SECRET`/decrypt another user's
  tokens — either they carry no `Bash` (per-bot `allowedTools` without it) or they run in
  dedicated non-controller containers; verified by attempting an env read from a bot tool call.

**Shipped 2026-08-01 — the `allowedTools` half of the done-when, plus a control the item missed.**
`resolveHarnessForAgent` resolves a per-bot scope from the registry `container`
([controller-inline-scope.ts](../src/features/llm-provider/services/controller-inline-scope.ts)) and
threads it into the harness factory, so this is per-bot wiring, not the global env:
1. **No shell for inline bots.** The deployment-wide `CLAUDE_ALLOWED_TOOLS` is filtered
   (`Bash`/`BashOutput`/`KillBash`/`KillShell`/`Shell`, case-insensitively) for any bot whose
   container is the api. Read/Write/Edit/Glob/Grep/WebFetch survive, so `codex-packer` still emits
   its persona + manifest. Bot-node bots keep the full incident "SWAT team" set — the restriction is
   inline-only and additive by construction.
2. **Platform-plane credentials scrubbed from the child env.** `SESSION_SECRET` was ALREADY scrubbed
   from every bot spawn (`BaseCliHarnessAdapter.SECRET_ENV_KEYS`) — the item's premise was partly
   stale. What was NOT scrubbed, and matters more, is `REMOTE_CLIENT_SHARED_SECRET`: it lives only on
   the api service, and it is MACHINE TRUST on the worker plane, meaning it skips per-device
   ownership. An injected inline bot holding it could enqueue a shell-exec task on ANY user's
   desktop. It is now deleted for inline spawns, along with
   `REMOTE_CLIENT_CONTROL_PLANE_TOKEN`/`ALERT_WEBHOOK_TOKEN`/`WORLD_INGEST_TOKEN`/`TV_PAIRING_SECRET`.
   Deliberately NOT scrubbed: `SWARM_SERVICE_SECRET` (personas legitimately call the api with it) and
   provider API keys (the CLI *is* the LLM caller).
- **Still open (why this is 🟨 not ✅):** a codex-harness inline bot has a shell by construction —
  the vendor CLI owns its own permission model and compose sets `CODEX_SANDBOX_MODE:
  danger-full-access` — so for those the env scrub is the load-bearing control and the tool list is
  not. `DATABASE_URL` also still reaches inline spawns (removing it risks breaking bot shell-outs
  that were not audited here; the api role is the non-superuser `oshal_app`, so RLS applies).
  The complete answer is this done-when's OTHER option: move inline bots into dedicated
  non-controller containers. That is a topology change with a compose + registry migration behind
  it, not a wrap-up edit. **Live verification of the done-when's own test** ("attempt an env read
  from a bot tool call") still needs a deployed stack.
- **Guard:** `tests/unit/inline-bot-no-shell.spec.ts` (13 cases; 6 targeted mutations proven red
  2026-08-01, including unwiring the scope in `provider-runtime` and dropping `extraSecretEnvKeys`
  from either `super()` branch of the claude adapter).

### Bot-node `/api/swarm-execute` is unauthenticated + host-published (security audit 2026-06-16) — ✅ CLOSED 2026-07-15
- **What:** [bot-node-server.ts](../src/app/bot-node-server.ts) `POST /api/swarm-execute` runs LLM
  execution and accepts `body.creds` (the caller's short-lived per-user access tokens) with **no
  auth**, listening on `0.0.0.0:5000`. Compose **publishes** each bot-node's 5000 to the host
  (`3040:5000`, `3041:5000`, …), so the endpoint is reachable from `localhost` — anything that can
  reach the host port can trigger LLM runs (cost) and submit creds. The controller→bot-node path
  is internal (Docker service DNS), so this is the *bot-node*, not the public controller.
- **Audit context:** the PUBLIC controller (the cloudflared-tunneled `oshal-api`) was swept and is
  **clean** — every `/api` route is `requiresAuth`-gated or legitimately public (branding, health,
  own-session `/api/auth/user`, and `/api/remote-clients` which is self-gated fail-closed via
  `authorizeRemoteClient`: OIDC session OR `REMOTE_CLIENT_SHARED_SECRET`). The register-helper
  routes (fast-intake, debug, code-bridge, cockpit-static, legacy-compat, ui-surface) all apply
  `requiresAuth`. So no internet-facing gap; this is internal defense-in-depth.
- **Fix (deliberately NOT done unattended — it's a two-sided change on the core dispatch path):**
  (1) **de-publish** the bot-node ports in compose (`expose:` instead of `ports:`) so they're only
  reachable on the Docker network — non-breaking for the controller (it uses service DNS), needs a
  full bot-container recreate; and/or (2) add an **optional shared-secret** check on `/api/swarm-execute`
  (enforce only when an env secret is set, like `authorizeRemoteClient`) + have `BotNodeClient` send
  it — fail-open until configured so it can't break existing dispatch. Test the full controller→bot
  dispatch after either change.
- **Done when:** the bot-node execute endpoint is unreachable from outside the Docker network OR
  requires a shared secret, with controller→bot-node dispatch verified still working.
- **Resolution (2026-07-15):** BOTH fixes are in. (1) All 35 bot-node `127.0.0.1:30xx:5000`
  publishes in `docker-compose.oshal-local.yml` are now `expose:`-only — bots are reachable
  solely over the Docker network (controller uses service DNS; needs a bot-container recreate to
  take effect). The same de-publish was swept across the alternate stacks in the follow-up: the
  16 bot `30xx:5000` publishes in `docker-compose.swarm-local.yml` (project-manager keeps its
  `1455:1455` codex-callback port published) and the two bot publishes in
  `docker-compose.incident-lab.yml` (`3054`/`3055`) are now `expose:`-only as well —
  `docker-compose.core.yml`/`.dev.yml` never published bot ports. (2) The shared-secret gate
  (2026-07-10, `SWARM_SERVICE_SECRET` +
  `X-Service-Secret` via `BotNodeClient.serviceSecretHeaders()`) is now LOUD when unconfigured:
  startup WARN + per-request WARN naming this item ([bot-node-request-auth.ts](../src/app/bot-node-request-auth.ts),
  any-bot `swarm-execute-auth.js`); configured ⇒ fail-closed 401. Identity/credential-bearing
  payloads (userSub/creds/byoLlmConnection/providerIntent) fail closed regardless. Covered by
  `tests/unit/bot-node-swarm-execute-auth.spec.ts` + the compose posture assertion in
  `tests/unit/live-weather-email-wiring.spec.ts`.

## Product experience — interactive, bot-driven surfaces (the important vision, was missing)

These are the app-experience items repeatedly asked for but not previously tracked. The
through-line: surfaces should be **guided, interactive, and driven by the app's bot** — not
bare forms beside a disconnected chat.

### Presentation Studio ✅ v1 BUILT (2026-06-16) → interactive bot-driven v2 ✅ DONE (verified 2026-07-19)
- **Built v1:** the store-side `presentations.html` surface is now a Studio —
  a **template gallery** (Pitch / Strategy Review / Project Update / Teaching / Blank, click →
  loads a starter outline to edit), an outline editor, **topic → AI deck**, Generate → real
  .pptx → saved, and a **"My decks"** list (`oshal_presentations` record per generate, served
  by `GET /api/presentations/sections/list`). Split-screen, themed.
- **Pending v2 (the full vision):** (a) **in-app slide preview** of the rendered deck (not just
  download); (b) the **deck-builder chat actually drives the Studio UI** — see the bridge below.
- **Done when:** the user can preview a generated deck inline, and a conversation with
  deck-builder fills/edits the outline live (chat ↔ surface).

**Verified 2026-07-19:** v2 DONE — inline preview + chat-driven outline shipped in AI Office (presentations.html); note the preview is an outline-model approximation, not a pptx pixel render.

**CARVED 2026-07-19 (`775d76c7`, ADR-085 Wave 2):** the AI Office surface (presentations.html + bot-presentation-routes.ts + swarm-apps/presentations.yaml) is ripped from the kernel and now lives in the store package — Studio follow-ups (incl. the surface-bridge `applyActions` migration) belong there; the deck-gen engine stays kernel per the surface-only rule.

### Chat ↔ surface bridge — the bot updates the UI with options the user selects ⭐ (CORE PRIMITIVE)
- **What:** the operator's repeated ask — "the bot is updating the UI with options and things
  to select, and I chat + select to make decisions." Today each app is a **surface iframe + a
  separate chat-rail iframe** that can't talk to each other. Build a **postMessage bridge**
  (cockpit-mediated, since they're sibling iframes): the app bot emits structured events
  (`render-options`, `set-outline`, `fill-field`, `propose`) the surface renders as clickable
  cards/fields; the user's clicks emit events back to the bot. The bot becomes the conductor of
  the surface.
- **Generalizes to:** Presentation Studio (deck-builder fills the outline), Workflow Studio
  (the [ADR-039](adr/039-bot-driven-workflow-authoring.md) "watch the graph build as you
  chat" canvas), Storage (storage-assistant drives the settings), Social (social-writer fills
  the composer). It is the same primitive every "interactive, guided" app needs.
- **Why deferred:** cross-iframe messaging contract + per-app event vocabulary + the cockpit
  relay is a real framework piece, not a one-surface edit.
- **Foundation BUILT 2026-07-10 — the generic contract (RibbonNav.js's own in-code TODO):** the
  hard part, the manifest-keyed **event contract**, now exists as a pure FSD slice
  [src/features/surface-bridge/](../src/features/surface-bridge/) — a typed, zod-validated superset
  of the existing presentations `{op:'set_title'|'set_outline'|...}` actions AND the Little Monsters
  `lm-navigate`/`lm-classes-changed` postMessage events. Outbound (bot→surface):
  `render_options`/`set_field`/`set_content`/`propose`/`navigate`/`notify`/`custom`; inbound
  (surface→bot): `select`/`field_change`/`submit`/`event`. `normalizeSurfaceEvent()` fail-closes on
  wrong channel/version/unknown-op/malformed and **strips HTML from every text field** (no markup
  crosses the bridge); `resolveRelayTarget()` enforces the isolation key (an app can't spoof another
  app's surface, and can only emit the ops its manifest declares). DOM-free, so it's reusable
  server-side to validate an ADR-085 app package's declared surface ops too. 15 unit tests
  ([tests/unit/surface-bridge-contract.spec.ts](../tests/unit/surface-bridge-contract.spec.ts)); tsc clean.
- **Remaining (browser wiring — deliberately not done overnight):** the cockpit-mediated postMessage
  relay (`embedded-chat-panel-controller.js` / `RibbonNav.js` → route normalized events between the
  app surface iframe and the chat rail), a surface-side renderer for the outbound ops (cards/fields),
  and migrating presentations' `applyActions` onto the contract. The app-store manifest gains an
  `surface.ops: [...]` allow-list `resolveRelayTarget` reads.
- **Done when:** in at least one app, chatting the app bot renders selectable options into the
  surface and the user's selections flow back to the bot, end to end (uses the contract above).

**Verified 2026-07-19:** OPEN — the contract slice shipped; the cockpit relay, the presentations `applyActions` migration, and the manifest `surface.ops` allow-list are all unbuilt.

### Per-app workspace consolidation (Social ✅ → the rest)
- **Built:** Social combined Studio + Composer into one **Workspace** (engage-left / compose-right).
- **Pending:** apply the same "one cohesive workspace" treatment where it fits (Storage:
  Assistant + Settings + Files; the engineering screens). Each app should open as a single,
  guided workspace, not a row of disconnected tabs.
- **Done when:** each multi-surface app presents one coherent workspace with its bot beside it.

### Guide bots that actually drive their app
- **What:** the per-app guide personas (deck-builder, storage-assistant, social-writer) currently
  only *talk*. Once the chat↔surface bridge exists, each should **operate its app** — deck-builder
  builds the outline, storage-assistant flips the targets, social-writer fills/refines the post —
  via the bridge, with the user confirming.
- **Done when:** an app's guide bot can complete the app's core task by driving the surface, with
  human-approval gates on anything outward-facing.

**Verified 2026-07-19:** PARTIAL — per-app guide bots + the Storage workspace consolidation exist; app-driving + the broader consolidation remain ongoing.

## Kid Lens + Takeout ingestion spine — next steps (BUILT 2026-06-17, partly unverified) 🟨

**CARVED 2026-07-17 (ADR-085 Wave 1 carve #2):** the Kid Lens app now lives ONLY in the
oshal-applications store package `youtube-kids/` (manifest + persona + compiled routes +
surface; ships inactive at core-retirement parity). The generic **Takeout ingestion spine**
stays core (`src/app/routes/takeout-ingest.ts` selective streamed unzip via yauzl +
`takeout-routes.ts` `/api/takeout` ingest-zip + Dropbox list/pickup) but now has ZERO
registered slices — the youtube handler left with the app, and **package-contributed slice
registration is the framework gap** that reconnects an installed lens to whole-archive
uploads. The items below remain valid; file references to `youtube-kids-routes.ts` now mean
the store package's `src-routes/`. See memory `kid-lens-app.md`.

**Verified 2026-07-19:** OPEN, ownership moved — the Takeout spine is kept but `KNOWN_SLICES` is empty (YouTube carved to the store 07-17); all the next-steps below belong to the store package.

### Verify end-to-end with real data (operator's last mile) ⬜
- **What:** export real YouTube history (JSON) at takeout.google.com → drop the `.zip` at
  `/cockpit/?app=youtube-kids` → confirm the brief renders and a `chat_tasks` cost row is written.
- **Why:** MOCK_OIDC is off on this host (real Google login), so the authed upload→brief round-trip
  and the bot's *brief quality* were never exercised — the one genuinely untested path.
- **Done when:** a real export produces a useful brief (sensible interest clusters + gift ideas, not
  generic mush); if weak, tune the `buildBriefPrompt` contract in youtube-kids-routes.ts.

### Dropbox pickup — exercise against a real archive ⬜
- **What:** run `GET /api/takeout/dropbox/list` + `POST /dropbox/pickup` against a real Takeout zip
  in the user's Dropbox; confirm the streamed temp-file download + selective extract works at size.
- **Why:** type-checks and mounts, but never run against a real Dropbox archive; big-archive
  streaming designed-for but not stress-tested.
- **Done when:** a Dropbox-delivered Takeout zip ingests via pickup and the YouTube slice lands.

### Full-auto harvest (the deferred privacy decision) ⬜
- **What:** let OSHAL read Google's OWN Takeout delivery folder directly (zero manual steps).
- **Why blocked:** OSHAL's Dropbox is an **app-folder** sandbox — it cannot see
  `/Apps/Google Download Your Data/`. Requires either a Dropbox **full-access** app re-registration
  (bigger privacy footprint, re-consent) or a **Google Drive** sensitive scope (Google verification).
- **Done when:** operator picks a path with eyes open on the privacy tradeoff; not snuck in.

### Phase 2 — live YouTube connector (subscriptions/likes) ⬜
- **What:** add `youtube.readonly` to the Google connector + `scripts/oshal-youtube.js` for live
  subscriptions/likes (NOT watch history — that stays Takeout-only; NOT the recommendation feed —
  no API exists).
- **Why deferred:** `youtube.readonly` is a Google "sensitive" scope → app-verification review under
  the business email before non-owner users can consent.
- **Done when:** a connected user's live subscriptions/likes augment the Kid Lens brief.

### More lenses on the spine ⬜
- **What:** add `KNOWN_SLICES` entries + `routeSlice` cases for other Takeout slices — Mail, Photos
  metadata, Maps/Location, Search history — each feeding a small lens app.
- **Why:** the spine was built generic for exactly this; YouTube is just the first slice.
- **Done when:** at least one non-YouTube slice (e.g. Location history) ingests + renders a lens.

### Multi-kid / mine-vs-kid separation ⬜
- **What:** detect distinct viewing personalities (younger vs older kid) or separate the operator's
  own viewing from the kid's before profiling.
- **Why deferred:** operator chose single-kid for v1.
- **Done when:** the brief can segment by detected viewer, or filter out adult/self viewing.

## Storage — unified file browser (drill-down + preview across ALL backends) ✅ BUILT + DEPLOYED + LIVE-VERIFIED (2026-06-17)

The Storage "Files" tab used to be a flat, Dropbox-only list. Rebuilt as a real file browser:
a **source rail** (all connected storage), **breadcrumb folder drill-down**, and a **preview
pane** (inline text/code, images; download fallback for binaries). GitHub's root lists your
repos as folders; you drill into them.

- **Built + code-verified:**
  - [src/app/routes/storage-browse.ts](../src/app/routes/storage-browse.ts) — cross-provider model:
    `listRoots` / `browse(provider, path)` / `readBytes` / `previewFile` (2 MB inline cap) over
    Dropbox, GitHub repos+contents, and the OSHAL-local per-user dir. Per-user connector tokens.
  - [src/app/routes/files-routes.ts](../src/app/routes/files-routes.ts) — `GET /api/files/roots`,
    `/browse`, `/preview`, provider-aware `/download` (defaults `dropbox` for back-compat with
    `saveContent()` links), `/upload?dir=` lands in the open Dropbox folder.
  - [src/api/files.html](../src/api/files.html) — rebuilt 3-pane browser; manifest label `My Files → Files`.
  - Tests: [tests/storage-browse-local.spec.ts](../tests/storage-browse-local.spec.ts) — **7/7 green**
    for the OSHAL-local provider (drill-down, folders-first sort, text preview, binary→download,
    byte read, **path-traversal safety**). `tsc --noEmit` clean.
  - Fixed while building: GitHub owner now resolved from `GET /user`.login (the stored
    `account_email` is the *email* when public — would have 404'd every GitHub call); OSHAL-local
    paths now preserve spaces in filenames (the old `sanitizeSubfolder` stripped them).

- **Fixed since first handoff:** the pre-existing GitHub-owner bug in `storage-target.ts`
  (`saveContent()` + `listFolder()`) now uses the shared `resolveGithubOwner()` (`GET /user`.login)
  exported from storage-browse — a codebase sweep confirmed those two were the only broken sites.
  `tsc` clean, OSHAL-local tests 7/7 green.

- **Deployed (2026-06-17):** rebuilt `oshal-bot:latest` + `--force-recreate` of `oshal-api`;
  `/api/files/roots` live (401 unauth → route present), new `files.html` browser markup served.
- **Live-verified against real tokens (2026-06-17):** drove the compiled `storage-browse`
  functions inside the api container with the operator's real connector tokens (sub …909).
  `listRoots` → `oshal-local, dropbox, github`. **Dropbox**: listed root, drilled, read a real
  79 KB `CoverLetter.pdf` (correctly `encoding=none` → download-only). **GitHub**: listed 13 repos
  as folders, drilled into a repo, `readBytes` on real files, and text preview of a `.gitignore`
  returned `encoding=text`/`text/plain` with correct content — proving the owner-resolution fix
  works end-to-end over the live GitHub API.

- **Residual (optional):** a human MOCK_OIDC click-through wasn't run (would need
  `MOCK_OIDC_SUB=…909` to reach the operator's connections); the underlying data path was verified
  directly instead. Dropbox *text/image* preview wasn't hit live (the app folder held a PDF +
  folder), but the render path is provider-agnostic (decided post-`readBytes` by mime) and is
  covered by the GitHub live text preview + the OSHAL-local tests.

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

## Onboarding — first-run LLM gate (2026-06-19) ✅ (open: none blocking)
- **Done:** `GET /` + `/chat` + `/cockpit` redirect to `/welcome` when there's no active LLM OR the user hasn't completed onboarding; free shared model (pooled Codex creds, keys never shown); Codex `auth.json` import (bypasses the localhost:1455 callback); app-surface 404 fix (`any-bot/server/services/tools` COPYed into the image + bind-mounted). Migration `053-onboarding-and-presets.sql` adds `user_preferences`.

## Video platform (ADR-070) — deferred providers + carry-forward security

### Flow free-generation via screen-control / UI automation ⬜ (deferred — not a show-stopper)
- **Why:** programmatic Veo has **no free tier**; Google **Flow / AI Studio** generates video free but exposes **no API**. The remote client can already control a screen, so Flow's free generation can be driven as a `flow` generation provider (ADR-070) via **recorded-then-replayed clicks**.
- **Shape:** a dedicated idle host opens Flow at a **fixed window size + fixed pixel geometry**; record the click/prompt-entry/extend/download sequence **once**; play it back (Puppeteer or a screen-control MCP exposed as MCP functions). The downloaded clips feed the existing stitch/captions/voiceover/publish pipeline. Free (compute only).
- **Caveats:** UI-automation of a Google product is ToS-gray (operator-accepted, personal use) and brittle to UI drift — must **detect breakage and fail cleanly** (escalate to the paid Veo gate) rather than silently produce garbage.
- **Done when:** a `flow` free provider, on a designated host, opens Flow at fixed geometry, replays a recorded generate→download sequence, returns the clip into the pipeline, and surfaces a clear failure (not a hang) when the UI changes.

**Verified 2026-07-19:** OPEN — no provider exists; ADR-070 still Proposed for this item.

### Bot-endpoint privilege model — authorize the ACTUAL endpoint call, not just DB/UI ⬜ (CARRY-FORWARD SECURITY)
- **Why (operator-flagged):** access control must hold at the **bot endpoint-call layer** (`POST /api/swarm-execute`, `/api/send-message`), not only at the database (RLS) or by hiding UI. The failure case: **Jarvis (or any orchestrator) delegates to a cluster-node bot/tool the caller isn't entitled to** — e.g. a **kid reaching a parent's** privileged bot via Jarvis. Today bot-to-bot calls authenticate with a **service secret (machine trust)**, which proves *a bot is calling*, not *that this caller is entitled to that bot*.
- **Build on existing rails:** `requiresAuth` (route), `serviceSecretHeaders` (machine), `connector-token-broker`/`resolveBotCreds` (per-user tokens), ADR-056 ticketed data-access broker, the public-launch isolation audit (cross-user leaks), `BotNodeClient.execute`.
- **Done when:** every bot endpoint call carries the **authenticated caller's identity** (`userSub`) **and** an enforced **entitlement check** (RBAC / ownership / per-bot ACL) before execution; Jarvis/orchestrator delegation **propagates the caller's privilege and never escalates to the bot's**; a restricted user **provably cannot invoke or reach** a bot/tool outside their entitlement, even through Jarvis; covered by tests in the security-review/isolation suite. Ties to the per-app/per-bot scoping noted in [[oshal-iot-tenancy-design]] and the isolation audit.

**Verified 2026-07-19:** OPEN — `/api/swarm-execute` has the service-secret + fail-closed identity payloads, but no per-caller entitlement check at execute time.

**Status 2026-08-01 — the endpoint layer is now covered; delegation shape and the live proof remain.**
- ✅ `POST /api/swarm-execute` (bot node): `createExecuteEntitlementGate` runs after the machine-auth
  gate. Default mode is **enforce** (K6) — unknown values fail closed, `warn`/`off` are explicit
  opt-outs.
- ✅ `executeBotOrInline` (controller chokepoint): `assertExecuteEntitlement`, which is what covers
  INLINE bots — they resolve to a null endpoint and never reach the bot-node HTTP gate.
- ✅ **`POST /api/send-message` + `POST /api/tasks/:taskId/messages` — the gap this line named and
  nothing had closed.** The route honoured a caller-supplied `body.agentId` VERBATIM and called
  `ctx.orchestrator.processMessage` directly, never through `executeBotOrInline`. Its IDOR guard
  checks the THREAD, not the BOT, so a signed-in non-operator could reach exactly the ADR-087
  operator+swarm machinery K7 scoped (`oshal-developer`, `devops-bot`, `vault-bot`,
  `security-analyst`, `code-developer`, `tester-bot`, …) by naming its agentId on a task they
  legitimately own. The resolved agentId now runs through the SAME pure decision, BEFORE any ticket
  is created or any LLM work starts, and a denial answers 403 `caller_not_entitled_to_agent`.
  `direct` is set only for genuine interactive identity callers, so a valid service-secret call
  remains swarm/queue dispatch — the `dispatch-manifest-worker`/`dispatch-incident-worker` localhost
  fallback and the headless CLI are unaffected.
  Guard: `tests/unit/send-message-entitlement.spec.ts` (7 cases; the denial-path mutation proven red).
- ⬜ **Still open:** the done-when's *delegation* clause — "Jarvis/orchestrator delegation propagates
  the caller's privilege and never escalates to the bot's" — is satisfied in the paths above only
  because every one of them threads the caller's own sub. A bot-to-bot call-out (ADR-083) that
  re-enters on the service secret still presents as swarm dispatch, which is trusted by design; if a
  future call-out lets a USER-initiated turn fan out to a bot the user is not entitled to, that is
  the next hole. ⬜ Also open: the live restricted-user proof ("a restricted user provably cannot
  reach a bot outside their entitlement, even through Jarvis") on a deployed stack with
  `OSHAL_OPERATOR_SUBS` populated — the unit guards prove the decision, not the deployment.

### Biometric unlock module — "you can only access Jarvis if you are who you say you are" ⬜ (cool, deferred)
- **Why:** an optional identity-verification gate for privileged access — **face scan** (stand in front of the Ring camera / phone) and/or **voice recognition** — before granting Jarvis or a high-privilege bot. Pairs with the bot-endpoint privilege model (a passed biometric challenge becomes a condition for high-privilege actions) and the smart-home edge-node (Ring camera access, ADR-047).
- **Shape:** a pluggable **identity-verification provider** interface (face + voice providers behind it, like the TTS provider registry), with enrollment + challenge/verify flow, and an honest fallback when no camera/mic is present.
- **Done when:** a protected app/bot can require a passed face/voice challenge (enrolled per user) before access, the challenge result feeds the endpoint-privilege gate above, and there's a documented fallback for no-biometric devices.

**Verified 2026-07-19:** OPEN — no provider interface exists.

## Vids Operator — tool/function registry + scenario library (ADR-073) 🟨 PHASE 1 + PHASE 2 BUILT (2026-06-26); LIVE-VERIFY PENDING
- **Why:** the `@oshal/vids-operator` computer-use bot re-derives the whole Google Vids click-path from a loose goal on **every** job (token burn). Target model: **every Vids operation is a named tool** (`add_caption`, `add_text` (box with words), `add_shape`, `add_image`, `generate_clip`, `animate_image`, `insert`, `add_voiceover`, `add_music`) backed by a deterministic "playwright" click-path; the **director LLM calls tools by name** and never figures out clicks; **screen capture is for verification, not button-finding**. Scenarios = compositions of those tool calls. "Animate an image" (one reused still — or a LoRA-rendered face) is the proven cheap host, no avatar re-training. Three suite tools stay separate (Vids Operator / Video Studio ADR-070 / LoRA Studio ADR-071), bridged as tools not couplings. Full decision in [ADR-073](adr/073-vids-operator-scenario-library.md).
- **Done (Phase 1, on working tree, not committed):** `recipes/scenarios.yaml` (5 presets) + `src/scenarios/store.js` + `buildScenarioGoal()`/`job.scenario` branch in `src/server.js` + chat trigger + `GET /api/scenarios` + scenario-aware `POST /api/jobs` + runbook/README updates. Verified: modules load, parser preserves Windows backslash paths, checklist text correct.
- **Phase 2 DONE (2026-06-26):** tool registry `recipes/vids-tools.yaml` (11 tools) + `src/tools/registry.js` + `src/tools/executor.js` (real-screen, focused-vision `locate`, `wait_render`) + `src/tools/director.js` (`ToolDirector` function-calling loop, same pause/abort surface as the pixel agent) + server wiring (`mode:'tools'`, `tools:` chat trigger, `scenario:… mode=tools`, `VIDS_TOOL_MODE=1`, `GET /api/tools`, `buildToolsGoal`). Pixel agent stays default; `plan` path unchanged. All modules `node --check` + load-verified.
- **Backlog (remaining):** (1) **live-verify** each tool against real Vids — confirm `locate` resolves labels (Animate an image, Captions, Text, Shape…), tune prompts/timeouts; (2) locate caching to cut repeat vision calls; (3) panel UI scenario `<select>` + tool-mode toggle in `web/src/App.jsx` + `npm run build`, mirror legacy `src/ui/index.html`; (4) refactor Phase-1 scenarios to emit explicit tool-call sequences (shared path with the director); (5) suite bridges (LoRA still → `animate_image`; Studio clip → Operator finishing); (6) optional token before/after measurement.
- **Done when:** the director builds a multi-element video (clip + caption + text/shape box + music) by **calling named tools**, using screen capture only to verify, proven live against real Vids; recurring format costs materially fewer tokens than free-form.

**Verified 2026-07-19:** OPEN — the tool-director was never live-verified; locate caching, panel UI, the scenario refactor, suite bridges, and token measurement remain pending.

## Retire the legacy brand name from the framework (2026-06-22) ✅ CODE-COMPLETE 2026-07-18

### Full de-brand — coordinated rename/retirement pass ✅ (landed 2026-07-18)
- **What happened:** the legacy demo-scaffolding brand (the RCA-build-bot debut; the real RCA product was packed/exported to a private out-of-repo project) leaked into the framework as five tangled meanings. All five are now retired (operator directive 2026-07-18: the brand word must not appear in checked-in files):
  1. **Stub provider** → `noop` end-to-end: `HarnessType` + factory key (e308175, June) and now the reported provider NAME (`NoopProvider` reports `'noop'`; telemetry/chat_tasks key on it). First-run banner detection tracks the new name (functional fix, first-run.js).
  2. **Active registry** → `swarm-bot-registry-local.ts` / `LOCAL_BOT_REGISTRY`. `getActiveRegistry()` DEFAULTS to local; `SWARM_REGISTRY=full` opts into the fuller lineup; any stale/legacy env value falls through to the default (hot-swap-safe). Values flipped in `.env.example`, both compose files, Dockerfile.
  3. **Incident/alert provider**: ripped out (04265e30) — client lib, staged-item intake, work-item adapter, dead trace route, RCA-prompt curl blocks, cockpit compare fetch, the legacy intake-provider enum member, `TRUSTED_ALERT_PROVIDERS` entry. The retired-platform pump/port-forward scripts + the dead k8s deployment descriptors were deleted. A REAL ops data backend for RCA bots remains the ADR-069 `?app=operations` rebuild.
  4. **Cockpit ribbon dead-key**: dropped (833b271c) from FRAMEWORK_ITEMS + fallback profile; launcher panel retired.
  5. **Tests/profiles**: provider/settings literals → `noop`, ribbon fixtures re-pointed at real framework items, the legacy e2e pipeline spec deleted, legacy ops-surface residue removed from the sandbox profile.
- **Stays (documented exceptions):** literal shell `echo` in scripts (a different word — load-bearing print statements); the browser WebRTC `echoCancellation` API property; generated bundles under `src/api/dist/` (regenerate from clean source at next build); append-only history logs (COLLABORATE/CHANGELOG) and git history.
- **Remaining collateral (tracked, not code):** brand-named files under `docs/archive/` + top-level `archive/` + `docs/release/` (the history-purge runbook family) — archival-disposition decision with @pm/operator (untrack-keep-local vs rewrite); dated `docs/evidence/*` snapshots regenerate clean on the next nightly; docs held by @docs-honesty's sweep (README body/reference.md/CLAUDE.md/adr/**) carry the remaining prose mentions.
- **Verified:** `tsc --noEmit` clean; vitest 2819/2819 green at the rename commit (51dea57e).

## LoRA Studio — reusable character training + validation/improve loop (ADR-071) 🟨 BUILT, NOT RUN END-TO-END

The `?app=lora` studio trains, validates, and iteratively improves a reusable character LoRA (the
`oshbrainrot` cyclops). P0–P5 are built, type-clean (0 tsc errors), unit-tested, and Python-syntax-checked;
nothing has run on the GPU box yet. Design + decisions in [ADR-071](adr/071-character-lora-studio.md).

### Run it end-to-end (the immediate "done" path) ⬜
- **Blocked on:** the GPU edge box being reachable. Bring up ComfyUI + the `oshal-chat` worker node on
  edge-node-1 (it disconnected when its session ended — see the box-down diagnosis), then it re-registers
  in `/api/remote-clients` within ~10s.
- **Steps:** (1) rebuild + recreate `oshal-api` so the new TS routes load (TS doesn't hot-swap;
  `src/api/lora.html` does). (2) `setup-kohya.ps1` once on the box (kohya is NOT installed). (3) Open
  `?app=lora` → Train → Validate → Improve on the existing `overnight/curated.zip`.
- **Done when:** a real `oshbrainrot_v1.safetensors` trains, a scorecard lands in `oshal_lora_scores` via
  `/api/lora/ingest`, and an improved v2 scores higher than v1 on the identical validation matrix.
- **Untested-without-box seam:** the dispatch path (`lora-train-dispatch.ts` → exported `remoteClientRegistry`
  → embedded `mcp.call-tool`/`shell.exec` → worker) is written to the documented worker contract but has
  not executed; the secret is passed on the command line for v1 (see hardening below).

**Verified 2026-07-19:** OPEN — P0–P5 built + box scripts exist; still no real end-to-end training run (blocked on the GPU box).

### P6 — generalize to any character ⬜
- **Why:** v1 hardcodes the cyclops constants (HERO/IDENT/trigger) in the box scripts and the seed row.
- **Build:** read per-character config from `oshal_lora_characters` instead of constants; add the
  create-wizard intake (name + reference images or a hero prompt → hero candidates → dataset matrix gen →
  curate → train). `make-targeted-batch.py`/`validate-lora.py` already parameterize `--character`.
- **Done when:** a new character can be created in the UI and taken through train→validate→improve with no
  code edits.

### Automated curation judge (rejection at scale) ⬜
- **Why:** `make-curate.py` still even-samples; rejection of off-identity images (two eyes, morphed,
  deformed) is not yet automatic. The CLIP scorer in `validate-lora.py` already encodes the mechanism.
- **Build:** reuse the CLIP-to-hero + single-eye guard to pre-score the candidate pool and propose
  keep/reject in the gallery; the human confirms. Optional metered LLM-vision judge as a tie-breaker (off
  by default — free-first).
- **Done when:** the curate step proposes keep/reject per image and excludes rejects from the training set.

### Gallery image hosting ⬜
- **Why:** scorecard cell images live on the box filesystem; the studio UI only renders `http(s)` image
  URLs, so the gallery currently shows scores without thumbnails.
- **Build:** either serve validation thumbnails from the box over the mesh, or have `validate-lora.py`
  POST small thumbnails to a controller store referenced by `cells[].image`.
- **Done when:** the scorecard gallery shows the generated cell image next to each score.

### Autonomous overnight — schedule trigger + secret hardening ⬜
- **Now:** autonomous mode is opt-in via the per-character toggle + a "Run overnight now" dispatch
  (`/improve-overnight`); the box `overnight-loop.py` parks an `approval_required` morning-review ticket on
  finish.
- **Build:** a schedule-runtime trigger (cron/`schedules[]`) so "improve overnight" fires on its own when
  the toggle is on, instead of a manual click. Also inject `SWARM_SERVICE_SECRET` into the box via the
  node's env rather than passing `--secret` on the command line (avoids the secret appearing in process
  args / ticket metadata).
- **Done when:** toggling autonomous on schedules the nightly loop, and the box authenticates `/ingest`
  from its own environment.

## Repo-audit follow-ups (2026-07-05, 74-agent audit)

### Vids — per-user PUBLIC publish directory ⬜ (operator-requested 2026-07-05)
- **Context:** `/api/vids` is now auth-gated (commit 2a89dae6) — the dispatch/job API was
  anonymous-callable through the public tunnel. The ORIGINAL intent of the open mount was
  "we want to publish the videos": finished renders should be shareable publicly.
- **Build:** a dedicated public-publish rail, separate from the job API: per-user publish
  directory (user_sub-keyed, like the bot-owned stores) + an explicit "publish" action that
  copies a finished render into it + a public, unauthenticated, read-only static route
  (e.g. `GET /public/vids/<user-slug>/<video>`) that serves ONLY that directory. Nothing else
  about jobs/prompts/queue is ever public. Publishing is opt-in per video, never automatic.
- **Done when:** a signed-in user can mark a finished vids job "publish", receives a public
  URL that plays the video logged-out through the tunnel, and unpublish removes it; the job
  API itself stays behind auth.

**Verified 2026-07-19:** OPEN — no `/public/vids` route exists.

**Verified 2026-07-19 (completion-day):** PARTIAL — shipped **store-side** (`appstore-v0.44.0`, oshal-applications), not in this kernel (Vids Studio itself carved to the store, ADR-085 Wave 3 — `/api/vids` is unmounted from `server.ts`). The public read rail is mounted at **`/api/vids-public/<slug>/<file>`**, NOT the `/public/vids/...` path this entry proposed — the store package kept it under the audited `/api/` prefix rather than a too-broad public static mount (the D2 rule). The **publish action itself (copy a finished render into the per-user public dir) is a deferred, fail-closed follow-up** in the store package — until it lands nothing is copied in, so the rail exposes an empty dir rather than any render. The done-when (mark-publish → logged-out URL → unpublish) is now tracked store-side.

### ~~Remote-client tasks — per-user device ownership binding~~ ✅ DONE 2026-07-09
- **Done-when met:** `tests/unit/remote-client-device-ownership.spec.ts` (6 tests, green) proves a
  second non-operator user gets **403** enqueueing to and reading results/screenshots from a device
  they don't own, through the real router.
- **As built:** `ownerSub` on `RemoteClientRegistrationSchema` (a2a.ts) — a node asserts its
  signed-in user at registration ([mesh-client.ts](../packages/oshal-chat/src/main/mesh-client.ts)
  sends `config.userSub`); a browser-session registration pins it to the session sub (operators may
  bind anyone) and CANNOT re-register/take over another user's device. Enforcement in
  [remote-client-routes.ts](../src/app/routes/remote-client-routes.ts): every `/:clientId` action
  surface (enqueue, result read, task lifecycle, chat, workspace sync, swarm queues, heartbeat) runs
  `requireDeviceAccess` — session callers need `canAccessResource(req, ownerSub)` (owner OR
  operator; **unowned device = operator-only fail-closed**, `OSHAL_ALLOW_LEGACY_UNOWNED=true` is the
  explicit compat escape). Machine callers (shared secret = the node daemon + platform dispatchers,
  now checked BEFORE the session branch) are unchanged. Ownership is sticky across owner-less
  re-registrations; `POST /:clientId/owner` = operator reassignment
  (`RemoteClientRegistryService.setOwner`). Session chat turns now run under the SESSION sub — the
  `payload.userSub` assertion is machine-trust only (closed a cross-user identity assertion in the
  same pass).
- **Residual (minor):** `GET /` list + `GET /:clientId` remain visible to any authenticated user
  (device metadata only — no results); scope them if fleet metadata privacy matters. Deployed nodes
  bind on their next registration once the daemon update ships (registry is in-memory, so a
  control-plane recreate re-registers everything).
- **Follow-up CLOSED 2026-07-23 — the internal dispatchers.** The line above ("machine callers …
  platform dispatchers … are unchanged") was the hole: that pass gated the HTTP surface, but the
  dispatchers that CHOOSE a machine ran on machine trust and selected on liveness alone. Live paths:
  `/api/apply-operator` is `requiresAuth` (not operator-gated), `GET /workers` enumerated every
  screen-control node in the swarm, `POST /submit|/enqueue*` took `targetRemoteClientId` from the
  request body straight into the dispatch pin, the no-pin fall-through was "any online node", and
  `explicitRemoteClientId()` regex-scrapes a node uuid out of a ticket's own free text. Any signed-in
  user could therefore run `codex.exec` at `sandbox=danger-full-access` on another user's desktop,
  with their own résumé staged into that workspace. Closed by
  [device-access.ts](../src/features/remote-client/services/device-access.ts) (`canUseDevice` /
  `filterUsableDevices` / `assertDeviceUsable`, mirroring `canAccessResource` so HTTP and dispatch
  answer identically), wired into `pickApplyClient` (filters BEFORE the preference order, so a
  foreign pin dispatches nothing), `listApplyWorkers`/`describeApplyWorker`, and
  `dispatchExplicitRemoteTicket`. Unattributed dispatch fails closed; platform work opts in via an
  explicit `system` flag. **Done-when met:** `tests/unit/device-access-dispatch.spec.ts` (11 tests,
  green) proves the pin exploit dispatches nothing, no fall-through to a foreign node, the picker
  does not enumerate another user's box, and the operator + `OSHAL_ALLOW_LEGACY_UNOWNED` compat
  paths still work. Commit `31a51352`.
- **Node-token auth for the remote-client plane (retire the swarm-wide shared secret).** Self-service
  enrollment (`19b48998`) binds a node to its user, but the worker plane (register / heartbeat /
  claim / complete) still authenticates with `REMOTE_CLIENT_SHARED_SECRET`, so a BRAND-NEW install
  still needs an operator-minted join code carrying that secret — the exact "email yourself a
  password" step enrollment was meant to remove. `createCliTokenAuthMiddleware` already turns
  `Bearer oshal_pat_…` into an authenticated `req.oidc`, and `authorizeRemoteClient` already accepts a
  session, so a per-node long-lived token would flow through `requireDeviceAccess` as the device's own
  owner with no new auth path. **Done-when:** a node configured with ONLY a node token registers,
  heartbeats, claims and completes; `/api/join/enroll` issues that token; no `OSHAL_SHARED_SECRET` is
  written by the installer for a user install; a guard proves a node token scoped to user A cannot act
  on user B's device; the shared-secret branch remains for legacy nodes with a deprecation note.
- **Serve the node bundle from the controller (true one-click install).** The api image ships neither
  `installer/` nor `packages/oshal-chat`, so the controller cannot hand a new machine the node app —
  today the user must already have the Open Swarm folder. **Done-when:** `Dockerfile.oshal` copies the
  installer + node source (source only; `npm install` still pulls Electron on the target),
  `GET /api/join/node-bundle.zip` serves it auth-gated, and a personalized bootstrap downloaded from
  the cockpit takes a clean Windows box to a registered, owner-bound node with one double-click.
  Note honestly in INSTALL.md that the first launch is a multi-minute Node+Electron build.
- **Still open (tracked below):** `series-dispatch.ts` (`findShellWorker` / `findVidsWorker`) selects
  render nodes with no identity threaded at all, so it relies on the `system` trust path.
  **Done-when:** the vids/series dispatch carries the owning user's sub and picks through
  `filterUsableDevices`, with a guard proving a second user's render cannot land on the first
  user's box.

### Decompose the 11 real over-cap files + add lint gates — decomposition ✅ 2026-07-11, lint gate 🟢 WIRED 2026-07-12
- **Decomposition DONE (2026-07-11 burn-through):** all 11 files from this list are under the cap
  (ticket-view-detail-renderer.js dropped to 988 via a separate task-result-presentation change).
  Details + per-file proofs in the "Decompose files over the 1000-line hard cap" entry above.
  One NEW violator appeared since this list was written: `src/app/routes/jarvis-routes.ts` — **cleared
  2026-07-18 (`b0757df4`)**, decomposed into 7 siblings (see the entry above); back under cap at ~761.
- **Lint gate WIRED 2026-07-12 (warnings-first):** ESLint 9 flat config
  ([eslint.config.mjs](../eslint.config.mjs)) with exactly the four governance rules — `no-restricted-imports`
  (FSD barrel boundary: a deep `@/features|entities|pages/X/…` import past the slice barrel; `@/shared|app`
  exempt), `no-empty` (allowEmptyCatch:false), `no-console`, and `max-lines`
  (max 1000, skipComments+skipBlankLines = the CODE-lines cap). Syntax-only (fast), focused (no
  recommended-set noise), the tseslint plugin registered so existing `// eslint-disable` comments
  resolve (no "rule not found" errors). Scripts: `npm run lint` (exit 0, advisory) + `npm run lint:strict`
  (`--max-warnings 0`); the CI + `ci-local.sh` lint gates now actually run (dropped the eslint-9-removed
  `--ext` flag) and are advisory until counts reach 0.
- **Measured counters (2026-07-12 baseline):** **no-restricted-imports 286**, **no-console 51**,
  **max-lines 1** (the jarvis-routes over-cap file), **no-empty 0** — every existing catch block carries
  a comment, so none are silently empty (documented, not the "57" the old grep counted). 0 errors →
  `npm run lint` is green (warnings-only). **Update 2026-07-18:** the `max-lines` offender
  (jarvis-routes.ts) was decomposed (`b0757df4`), so its violation is cleared; re-run `npm run lint`
  to refresh the deep-import / console counters before promoting the gate.
- **Done when:** the three counters (deep imports / console / over-cap) are driven to 0 or explicitly
  allowlisted so `lint:strict` passes and the CI gate can be promoted from advisory to required.
  (over-cap: cleared for jarvis-routes 2026-07-18.)

### Promote real DB-backed live specs into the own-data evidence flow ⬜
- **Context:** adversarial verification (2026-07-05) flagged that Own Data/Isolation "closed"
  leans on two integration-tier proofs: `data-export-delete-*` is loopback (in-memory
  taskStore/messageStore/ticketService stubs + fakeAuth — no DB, RLS, or OIDC), and
  `live-two-user-isolation-*` is a DB GUC visibility matrix reframed from the same single
  `verify:rls` run (not a real browser/API session). The genuine DB-backed specs already exist
  — `tests/live/privacy-export-delete.live.spec.ts` and `tests/live/two-user-isolation.live.spec.ts`
  — but are skipped unless `MOCK_OIDC_ALLOW_HEADER=true` and are not run by the nightly evidence
  flow. The core RLS isolation IS real (verify:rls, FORCE RLS, non-superuser owner); the gap is
  that export/delete and the two-user HTTP path are proven by stubs, not the live DB.
- **Build:** wire the two live specs into the nightly evidence flow (headless,
  `MOCK_OIDC_ALLOW_HEADER=true` against the running stack) emitting `Proof-Tier: live` docs from
  their results; OR write a `prove-export-delete-live.ts` that drives the real privacy routes
  against the live DB. CRITICAL SAFETY: it must NOT mutate production data — use a dedicated
  throwaway schema/DB, or a single shared connection wrapped in BEGIN/ROLLBACK (the store
  abstractions currently each draw their own pool connection, so a naive transaction won't cover
  them — making the routes share one connection is the real work).
- **Done when:** the own-data `export-delete` and `live-two-user` competitive gates are backed by
  proofs that touch live Postgres under enforced RLS (not in-memory stubs), cross-user delete
  isolation is proven end-to-end, and no production rows are mutated.

**Verified 2026-07-19:** MOSTLY DONE — prove-own-data-live.ts is already DB-backed + live (real privacy routes + two-user isolation); the thin follow-up was invoking the .live.spec.ts files directly, and CI now RUNS both .live specs un-skipped (gate_e2e `MOCK_OIDC_ALLOW_HEADER` — see ci-local.sh change log).

### Prove the guc-pool identity invariant (fail-open-to-operator) 🟢 LARGELY CLOSED 2026-07-10
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
  2. **Static regression guard** — [tests/unit/identity-middleware-ordering.spec.ts](../tests/unit/identity-middleware-ordering.spec.ts)
     parses `server.ts` and asserts the identity middleware mounts after auth+audit-capture and BEFORE
     tv-pairing/jarvis-voice. Would have FAILED before the hoist; stops the ordering from regressing.
  3. **Runtime auditability** — `OSHAL_DB_GUC_STRICT` ([guc-pool.ts](../src/shared/services/database/guc-pool.ts),
     [tests/unit/guc-pool-strict-identity.spec.ts](../tests/unit/guc-pool-strict-identity.spec.ts)):
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

### guc-strict warn→deny promotion — clear the warn-audit gate, then remove the compose pin ⬜ (completion-day follow-up 2026-07-19)
- **Reason:** the `OSHAL_DB_GUC_STRICT` **code** default is now `deny` (fail-closed identity, flip `47732ac2`),
  but the **live stack is pinned `OSHAL_DB_GUC_STRICT=warn`** (docker-compose `5b00ab19`, `:-warn`) for a
  rollout soak so identity-less callers are audited without being starved. The boot warn-audit logged
  **2 identity-less sites**: (1) `runRuntimeSchemaBootstrap` — boot DDL, deliberately unwrapped by the
  security lane as not-owner-RLS, **benign**; and (2) a **second site** whose stack was truncated at
  `processTicksAndRejections`, **not yet identified**. Deny cannot be promoted until site #2 is traced
  and confirmed benign/wrapped, since deny would stamp it anonymous non-operator and could starve it.
- **Done when:** both audit sites are confirmed benign or explicitly wrapped in `runWithSystemIdentity`;
  the warn audit shows **zero un-attributed identity-less callers across a real observation window**
  (a live soak, not a single boot); then the compose pin (`5b00ab19`) is removed so the deployed env
  falls through to the code `deny` default, and a post-promotion boot logs no starvation.
- **Break-glass:** `OSHAL_DB_GUC_STRICT=off` restores the pre-flip fail-open-to-operator behavior on any
  starvation incident.

### Deploy: bot-recreate thundering-herd on `/api/config/runtime` — stagger or size the pool ⬜ (completion-day follow-up 2026-07-19)
- **Reason:** every deploy recreates all ~35 bot containers, and they simultaneously pull
  `/api/config/runtime` on boot, bursting DB connection checkouts against the api's pg pool. The new
  guc per-checkout identity stamping (`set_config` + `reset` per checkout, from the deny-migration
  work) marginally lengthens each connection hold, which worsens the burst — the final closeout deploy
  (`52c96391`) logged **~16 transient `config-runtime-routes` connection-timeout error lines**. It is
  **non-fatal and self-settling** (0 timeouts within ~40s once the herd drains), but it is noise on
  every deploy and trains operators to ignore boot error lines.
- **Done when:** the bot config-pull is staggered/jittered on boot (or the api pg pool is sized for the
  full recreate herd, or both), AND a subsequent full-recreate deploy shows **0** `config-runtime`
  connection timeouts in the boot logs. (Note: ~13 additional boot error-lines seen at the same deploy
  are a SEPARATE pre-existing item — orphaned `oshal-chat` remote-client heartbeats — not this herd.)

### OSHAL Telegram notification bot (platform-wide mouthpiece) 🟨 HOOKS WIRED + TOKEN PROVEN 2026-07-31 — chat id + live send remain
- **Core BUILT 2026-07-10:** the `TelegramNotifier` behind the pluggable-notifier shape this item
  specifies is done — [src/features/notifications/](../src/features/notifications/): `TelegramTransport`
  (`sendMessage`/`sendVideo`, ≤50MB → text+link fallback, no-op when the two env vars are absent, token
  never surfaced) behind a `NotificationTransport` interface + registry, with `notifyOperator(message)`
  as the general service other features call. 11 unit tests (injected fetch — no network/creds); tsc clean.
  Matches the "Build" spec below exactly. **Remaining (need the real token):** the operator finishes
  @BotFather + sets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`; then wire the opt-in creative-studio
  story-delivery hook + a live-send proof, and one more subsystem (trading watchdog) calling
  `notifyOperator`.
- **Context:** operator wants finished creative-studio episodes pushed to his phone without
  digging through Drive (2026-07-08 session). Scoped during the mini-series build: one Telegram
  bot as OSHAL's outbound notification channel — video deliveries now, and later any
  platform alert (trading watchdog, failed overnight jobs, evidence-refresh failures).
  Operator created a burner Telegram account via a Twilio inbound number; bot creation via
  @BotFather was walked through but not completed. SECURITY RULE established: the bot token
  goes into `.env` (`TELEGRAM_BOT_TOKEN`) by the operator's own hand — never through a chat
  transcript. Delivery target = the chat that messages the bot first (getUpdates → chat_id).
- **Build:** a `TelegramNotifier` behind the same pluggable-notifier shape as TTS/providers
  (sibling implementations, no vendor hardcode): `sendMessage`/`sendVideo` (≤50MB bot API cap,
  else send the Drive link), wired as an opt-in hook on story delivery (creative studio) and
  as a general `notifyOperator(text, media?)` service other features can call. Config:
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`; no token → notifier disabled, no-op.
- **Done when:** with the two env vars set, a finished story-pack episode arrives in the
  operator's Telegram chat automatically (video or link), nothing is sent when unset, the
  token never appears in logs/git, and one other subsystem (e.g. trading watchdog alert)
  can send through the same service.

**Verified 2026-07-19:** OPEN — transport + `notifyOperator` built (budget-service wired); the BotFather token, a live-send proof, and the creative-studio + watchdog hooks remain pending.

**Update 2026-07-31 (host-side go-live pass):** the @BotFather token IS in the operator's `.env` and
was proven live from the host: `getMe` → ok (bot `@The_oshal_bot`). `getUpdates` is EMPTY and no
webhook is set — **nobody has messaged the bot yet, so there is no chat id and the one authorized
test send was correctly skipped** (delivery target = the chat that messages the bot first).
The remaining wiring from the done-when SHIPPED in the same pass: the creative-studio
story-delivery hook (`syncPumpRuns` → `notifyOperator`, video-as-link when Drive returned one,
honest node-only text when it did not — guard `tests/unit/video-pump-delivery-notify.spec.ts`),
the watchdog-family hook (`scripts/oshal-send-alert.js` now runs a Telegram leg before its Gmail
leg, so the trading/stack watchdogs + lab-report + ci-local + earnings-gate all push to the phone
with zero caller changes — guard `tests/unit/send-alert-telegram.spec.ts`), and the compose
passthrough of `NOTIFY_TRANSPORT`/`TELEGRAM_*`/`TWILIO_*` into the api service (they were never
forwarded, so in-container transports silently no-opped regardless of the host `.env`). Remaining
for done: (1) operator messages `@The_oshal_bot` once → `getUpdates` → set `TELEGRAM_CHAT_ID`;
(2) a deploy/recreate so the containers receive the env; (3) the live send-proof (an episode or a
watchdog alert arriving in the chat).

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

## Trading: graduate SK Hynix from core-exempt to sleeve-managed

- **Context:** 2026-07-10 operator directive bought ~20% of the LIVE book in the SK Hynix Nasdaq
  IPO (when-issued ticker SKHYV; permanent ticker SKHY from 2026-07-13). A day-one IPO has no bar
  history, so the sleeve rotation would have benched it (rankUniverse needs 60+ daily closes) and
  the 5-min protective exits would have stop-lossed routine IPO chop. It is therefore held as
  TRADING_CORE_SYMBOLS=SKHYV,SKHY (exempt from rotation sells, trims, AND all protective exits -
  a pure operator hold with no automated downside protection). SKHY is already in
  DEFAULT_UNIVERSE (commit 055b1212), inert until history accumulates.
- **Deferred because:** nothing to do until the ticker transitions and bar history exists.
- **Done when:** (1) after 2026-07-13, SKHYV is dropped from TRADING_CORE_SYMBOLS (position
  renames to SKHY at the broker); (2) once SKHY has 60+ daily bars (~2026-10), the operator
  decides hold-as-core vs sleeve-managed; if sleeve-managed, remove SKHY from
  TRADING_CORE_SYMBOLS and confirm the next rotation ranks it instead of benching it blind.

**Verified 2026-07-19:** OPEN — .env still reads SPY:60,SKHYV:0,SKHY:0 (SKHYV not dropped); the sleeve decision awaits ~60 bars (~Oct).

## Trading: venue-resident stops tested WEAK - do not build on performance grounds

- **Context:** 2026-07-10, after the pre-market gap bleed week (AMD/MU 07-07, MRNA/VRTX/SHOP
  watchdog alerts), venue-resident GTC stops + gap-exit-at-open were backtested via
  scripts/oshal-trading-gap-stop-backtest.ts (548-day OHLC walk, close-fill vs venue modes,
  4 configs x 4 window starts, adversarial judge). Result: NOT consistent - venue wins 3/7
  pairs, loses 3/7 (including the most recent window, worse on ALL metrics), 7-pair average
  -1.0pp return / -0.02 Sharpe / +0.8pp DD, and the marginal wins do not survive a realistic
  20-30% haircut on the optimistic fill-at-open gap model. The win-rate lift (+7pp) is
  mechanical truncation, no P&L content. Mechanism: first-print exits lock in gap losses that
  close-fill rides back roughly as often as they save real bleed.
- **Residual case:** cheap tail insurance ONLY - a WIDE catastrophe stop (e.g. -15%, far below
  the 5% soft stop) against the monster overnight gap the 548-day sample never contained.
  UNTESTED - no numbers claimed.
- **Done when:** if ever revisited: (1) test the wide catastrophe-stop variant specifically,
  (2) model gap fills at open-minus-slippage, (3) only build if the tail-insurance premium
  (return drag) prices out under ~0.5pp/yr.

## Trading: opportunistic fast-win sleeve (pop-catcher arming study + IPO event plays)

- **Context:** 2026-07-10 the operator manually played the SK Hynix IPO (in 69sh@170 via platform
  + 50sh@170 manual, out 119sh@173.86 same day, +$459 realized) and asked for "more of those" -
  systematic fast, event-driven wins. The platform HAS a pop-catcher (TRADING_POP_CATCHER,
  currently false: isShortTermPop entries, 1% tranches, max 5, threshold 0.34) but it has NEVER
  been honestly backtested - it keys off 5Min+1Hour decisions the daily-bar harnesses cannot
  model. IPO day-one plays have no module at all (would need: IPO calendar feed -> when-issued
  ticker discovery -> day-one entry/exit rules; note Schwab is LIMIT-ONLY on when-issued).
- **Deferred because:** honest evaluation needs an INTRADAY (5Min IEX) backtest harness - a real
  build; nothing armable before it exists (strategy-log rule: no config change without evidence).
- **Done when:** (1) intraday pop harness exists (5Min bars, models isShortTermPop entries + the
  breakdown/trailing exits, realistic marketable-limit fills); (2) pop-catcher tested across >=3
  months of 5Min data at >=3 thresholds; (3) verdict row in docs/apps/trading/strategy-log.md;
  (4) separately, an IPO-events design note (calendar source, when-issued mechanics, sizing) if
  The operator still wants it after seeing pop-catcher numbers.

  **UPDATE 2026-07-10 night:** done-when items (1)+(2) DONE same day - intraday harness built
  (oshal-trading-pop-backtest.ts) and swept (7 runs). Verdict REJECT (strategy-log sweep #4):
  the entry signal does not discriminate (~40 names/step qualify; thr 0.34 == 0.6 byte-identical).
  Remaining scope REDEFINED: (a) signal REWORK - a pop selector that thins ~20K signals/week to
  a handful (e.g. z-scored 5-min return vs the name's own intraday vol + volume surge + session-end
  hard close), (b) the arming bar from the strategy-log entry, (c) the IPO-events design note.

**Verified 2026-07-19:** PARTIAL — the pop-rework was built then killed with the event-pop family; the arming bar is defined; the earnings-calendar gate shipped; the IPO-events design note is still unwritten.

## Trading: EVENT-pop detector - connect the news brain to the trading hand (design) — ✅ CLOSED 2026-07-14 (verified 2026-07-19)

- **Context (2026-07-10 night):** operator: "I can spot these casually watching the news; you
  have all the news and cannot spot a pop. The gov-contract feed was supposed to catch awards."
  Diagnosis confirmed: (1) the gov feed IS running (9,187 datapoints, 6h cycle) but writes a
  STATIC 180-day rolling sum per name (BA $15.86B, same value every cycle) - revenue visibility,
  not an event stream; USAspending also POSTS awards 1-14 days after announcement, so it can
  never be the tradeable trigger. (2) The world layer already computes the right pop ingredients
  (mention_velocity, sentiment_shift) but TRADING_WORLD_SIGNALS/TRADING_WORLD_RANK are false -
  trading never reads them - and WORLD_CLASSIFY_DISABLED=true means new-item sentiment is
  currently dark (operator/session to confirm why; classify runs on codex, not the free pool).
  (3) The price-only pop-catcher was REJECTED (strategy-log sweep #4, no discrimination).
- **Design (build order):**
  (a) **DoD daily-contracts watcher** - defense.gov publishes award announcements daily ~5pm ET,
      free + public + same-day: parse, map recipients via symbolForName, write gov_award_event
      (notional, vs market cap) + a trading signal row (source gov-award). THIS is the
      real-time award trigger; keep USAspending as the slow revenue-visibility layer.
  (b) **News-velocity pop candidates** - z-spike of mention_velocity vs the name's own 30-day
      baseline AND positive sentiment_shift -> candidate set (expected: a HANDFUL/day, not 40/step).
  (c) **Price confirmation gate** - candidate + reworked 5-min confirmation (z-scored move vs
      own intraday vol + volume surge) -> entry; session-end hard close; tp/stop per sweep #4 best.
  (d) Paper-only 4 weeks against the sweep-#4 arming bar before any live arming.
- **Done when:** (a)-(c) built + a 4-week paper record meeting the sweep-#4 bar (>=200 trades,
  >=0.4%/trade gross, no overnight carries, skippedFull <20%, net >=0 in a non-bull week).

**Verified 2026-07-19:** CLOSED 2026-07-14 — supersedes the design above: the event-pop family was killed (analysts follow price, no tradeable signal); see the strategy-log analyst-pop-test row + evidence docs.

  **UPDATE 2026-07-11 early AM (operator direction, pre-registered for the next session):**
  (e) **LLM specialist reader** - operator directive verbatim: read every headline "as an
      informed trading specialist", decide deep-dive-worthy + market-shift, set a trigger,
      fire on confirmation. Replaces the KILLED keyword scorer (strategy-log sweep #5). Test
      plan ready: prefilter clean-period candidates -> workflow fan-out LLM triage -> replay
      through the blind-forward harness.
  (f) **Confirmation entry spec (operator, to test not assume):** after the news trigger, BUY
      on a +0.25% move within/after 2 five-minute bars ("buy into the strong signal, adjust
      momentum early" - i.e. scale in early on momentum), cancel if unconfirmed within ~30 min.
      Session-end hard close + the no-overnight rule (7/7 runs) still apply.

  **UPDATE 2026-07-12 (operator) — RUN IT FRIDAY 2026-07-17 AT THE OPEN. Shape is mandated:**
  The (e) reader must NOT be rebuilt in the shape that died. Three binding constraints:
  - (g) **NOT one-headline-at-a-time.** Per-item scoring is exactly what the regex did and it
        drowns in volume (388K items streamed last test). Read in **batches**.
  - (h) **Continuous through the session, with rolling summarisation.** Not a single pre-open
        pass: the reader runs on a rolling cadence all day, keeping a **compacted running state**
        of the day's narrative per name/sector, so a 10:42 headline is judged at 10:42 *with the
        morning's context*, not read cold.
  - (i) **A cheap deterministic pre-filter in front of the model**, so the LLM is only spent on
        candidates. The filter must NOT be the old count-velocity gate (**caught 0/25** in the
        miss audit). Cut by **subject proximity** (the headline is ABOUT the name, not a listicle
        mention) and drop the classes already proven to be noise — "big dollar figure in headline"
        was negative in **all 7 runs** and was 55% of volume.
  - **Model:** a *decent* reader (frontier-class for the run; the local 20-30B is the eventual
    home — this is precisely the latency-tolerant, high-volume, $0 workload the appliance exists
    for, see [demo/trading-appliance/](../demo/trading-appliance/)). Do not price it as a
    per-headline frontier-API job.
  - **Judged against the unchanged pre-registered bar:** sweep-#4 arming bar, RTH-only, and the
    surviving hypotheses ONLY (M&A-target, approval). **Pre-register the kill condition BEFORE the
    run.** A result that fails the bar is a *success for the process*: log the verdict in
    [strategy-log.md](apps/trading/strategy-log.md) and close it — do not retry quietly.
  - **Blocker to clear first:** `WORLD_CLASSIFY_DISABLED=true` — classification is off, and
    materiality needs classification **at ingest** (the 5-min pulse), not the batch path.
  - **Done when:** the Friday 07-17 open-to-close paper run produces a trade list judged against
    the bar, with the verdict (including a kill) appended to the strategy log.

  **⚠️ UPDATE 2026-07-12 — TWO DATA DEFECTS FOUND. The plan above changes; read before building.**
  (strategy-log 2026-07-12; evidence
  news-wire-recall-2026-07-12.md)
  - **(1) The surge detector was measuring OVERNIGHT GAPS.** `findSurges()` compared RTH-filtered
    bars by array index, so adjacent slots straddled a session boundary. MU's audited
    "+8.27%/30min surge" was an **18-hour gap** (07-08 15:50 ET $948.59 → 07-09 09:50 ET $1025.31).
    **Every pop-era conclusion drawn from the top-25 surge list is VOID** — including "19/25 had no
    warning" and the inference that *headline materiality* is the axis. Fixed in both scripts
    (session-grouped + wall-clock contiguity guard). Same bug class as the `resample()` reversal.
  - **(2) We were hunting surges on `feed=iex` — ~2% of consolidated volume.** MU moved **+0.03%**
    on the real tape over an hour IEX showed as +0.58% (9.0M shares vs 189K). The paper key has SIP
    **historical** entitlement — so **all backtest/research work must run `feed=sip`**.
    ⚠️ **CORRECTED 2026-07-12 (later):** it does **NOT** have SIP *real-time* (403 —
    `"subscription does not permit querying recent SIP data"`), so the **live pricing path cannot
    move to SIP** without a paid plan. Backtests → SIP; live → stays IEX.
    **TODO: audit every other trading script for `feed=iex`.**
  - **(3) `world_items` is unusable for pops regardless:** median detection lag **5.3 hours**
    (84,342 items/7d). The reader must read the **Alpaca/Benzinga wire** — `recentNews()` in
    `market-data.ts` already hits it — NOT the scrape. This is the single biggest change to the
    (e)-(i) design above.
  - **(4) The target class changed.** On the corrected tape, recall is **7/25 (28%) within 60 min**,
    and the headlines that actually lead are **analyst upgrades / price-target raises** (RKLB "B of A
    …Raises Price Target" 60 min; KLAC "Cantor …Raises Price Target" **5 min**) — *not* the
    M&A/approval class the old work pre-registered. Listicles and *reactive* post-move stories
    ("What's Going on With AMD Stock Monday?", a 107-min "lead") are cleanly separable noise.
  - **Revised Friday 07-17 objective:** do NOT build the general reader yet. Run the narrow,
    pre-registered test — **analyst-action headlines, SIP tape, Benzinga wire, RTH-only**, with
    reactive/listicle classes filtered out. Far smaller build, real hypothesis. Log the verdict
    (including a kill) either way.

## Trading: ✅ the 403 was the probe, not the engine — CLOSED 2026-07-12 (read the correction)

**Not a bug.** `trades/latest?feed=iex` (the production path) returns **200**. The 403 fires only on
`feed=sip`: `"subscription does not permit querying recent SIP data"` — the audit had exported
`ALPACA_DATA_FEED=sip`. Live order pricing never touched SIP. **No live-money defect.**

**But it corrected a claim this backlog made yesterday.** The entry above says *"the paper key has full
SIP entitlement… everything must run `feed=sip`."* That is **only true for historical data**:

| | paper key |
|---|---|
| SIP **historical** (>15 min old) | ✅ — this is why the recall backtest worked |
| SIP **real-time** | ❌ **403** |
| IEX real-time | ✅ |

So **backtests must move to SIP; live pricing structurally cannot.** Real-time SIP needs Alpaca Algo
Trader Plus (~$99/mo). Intraday scripts still on IEX (backtest-side, so they SHOULD move):
`oshal-backtest-live.js`, `oshal-bars.js`, `oshal-equity-bars.js`, `oshal-gravity2-backtest.ts`,
`oshal-monitor.js`, `oshal-optimize.js`. Daily-timeframe work may stay on IEX (max 0.16% divergence).

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

## Trading: extended hours was structurally unpriceable — turned OFF 2026-07-12 ✅

**`TRADING_EXTENDED_HOURS=false`** (it was unset → defaulting to **true**, while the `.env` comment
directly above already claimed "regular hours only"). Logged in `strategy-log.md`.

**IEX is a venue and it operates 08:00–17:00 ET.** It prints **zero** trades 04:00–07:59 and
17:00–19:59, and 1.3% at 16:00 (vs 85–93% during the regular session). Extended-hours orders are
converted to a marketable limit priced off `latestTrade()` — so outside 08:00–17:00 **there is nothing
to price them against.** The order ledger confirms it: **529 of 593 extended-hours orders never
filled** (17:00–20:00 = 89 orders, **0.0%** fill) vs **97%** in the regular session. The 07-08
staleness guard had already cut the churn (**434/day → 1**) by *declining*; this makes it explicit.

**Live was never affected** — all 66 live orders were regular-session, 95.5% filled.

- **Before ever re-enabling:** the ext-hours slippage buffer is **30 bps**, but measured IEX-vs-
  consolidated divergence tails to **54 bps** (RGTI; SOUN 45, IONQ 30, SMCI 29 — the thin volatile
  names rotation picks). An adverse 54 bps produces a **non-marketable limit that never fills** — the
  MRNA cancel/re-place failure mode via *feed divergence*, which the staleness guard does **not**
  catch. Re-enable only with real-time SIP, and re-measure this first.
- **Done when:** (this is done) — reversal criteria are in the strategy log.

## swarm-cli: the two gaps the 2026-07-12 live proof could NOT close

Context: docs/evidence/swarm-cli-live-2026-07-12.md —
23/23 live assertions + TTY banner/color + real TAB completion (bash via `COMP_WORDS`, PowerShell
via `TabExpansion2`, in-REPL readline on a pty) all passed. These two did not, and are logged so
they don't quietly rot into "we tested it".

**Verified 2026-07-19:** PARTIAL — gap 2 (stderr color) DONE (a41c975d); gap 1 remains: zsh completion has still never executed on a real zsh.

### 1. zsh completion has NEVER been executed (unverified, could be shipping broken) 🔴

`packages/swarm-cli/completions/swarm-cli.zsh` was authored, emitted by `swarm-cli completion zsh`, and read —
but **never run**. There is no `zsh` binary on the Windows host, in WSL Ubuntu, or in the
`oshal-bot` image, so nothing exercised it. bash and PowerShell were both driven through their real
completion engines and pass; zsh is the one shell we are asserting on faith.

Specifically unexercised, and each is a plausible silent break:
- the `funcstack[1]` guard that makes one file work both `eval`'d from `~/.zshrc` **and** autoloaded
  from `$fpath` (the two install paths the script's own header advertises);
- the `_arguments -C` / `_describe` / `->state` dispatch for subcommand-vs-args;
- `_swarm-cli_contexts`, which shells out to `node` to read saved context names out of
  `~/.oshal/config.json` for `--context <TAB>`.

**Done when:** zsh completion is driven on a real zsh (simplest: `apk add zsh` / `apt-get install
zsh` in a throwaway container, source the script, drive `compdef`), and these all complete:
`swarm-cli <TAB>` → the 12 subcommands · `completion <TAB>` → bash/zsh/powershell · `tokens <TAB>` →
revoke · `--context <TAB>` → the saved context names · plus `zsh -n` clean. Evidence appended to the
2026-07-12 proof doc. If it turns out broken, fix or delete the zsh script — do not ship a
completion that errors into a user's shell startup.

### 2. Status notes are UNDER-colored when stdout is piped but stderr is a terminal ✅ DONE (a41c975d, verified 2026-07-19)

Consciously shipped as the safe direction; logging it so it isn't mistaken for correct.

`f328ee94` fixed the real bug (ANSI **leaking into** a redirected `2>file`) by gating `note()` on a
per-stream `COLOR_ERR`. But the `ui.*`/`c.*` helpers still bake `COLOR_ON`, which is derived from
**stdout**. So in the common `swarm-cli ask "…" | jq` shape — stdout piped, stderr still a TTY —
`COLOR_ERR` is true but `ui[role]()` no-ops on `COLOR_ON=false`, and the status notes print plain on
a terminal that could have shown them colored.

This errs safe (under-color, never a leak) and no user has hit it, hence 🟡 not 🔴.

**Done when:** the color helpers resolve their gate from the destination stream (either take the
stream as an argument, or build a second stderr-baked `ui`), so `swarm-cli ask "x" | jq` shows
colored status notes on the terminal while stdout stays byte-clean. Guard it with a test that asserts
BOTH directions: colored-on-TTY-stderr, and still zero ANSI when stderr is redirected.

## Codex refreshed OAuth token is STRANDED in the per-task home — no write-back to the shared auth.json ✅ FIXED 2026-07-12 same-day (header reconciled 2026-07-24)

**Verified 2026-07-24 (diagnosis fleet):** fixed the same day it was filed — `codex-auth-write-back.ts`
CAS-writes a mid-run rotation back to the shared source inside the prime-gated closure (TS adapter),
with the JS `CodexCLIWrapper._writeBackAuth` twin covering the second launch path. Guard:
`tests/unit/codex-auth-write-back.spec.ts` (27 tests, both twins). **Residual (opportunistic):**
observe the write-back log line after the next natural ChatGPT token rotation — cannot be forced.

Context: found while verifying ADR-090 O8 mechanics against the code (six-reader audit). Both codex
launch paths — `src/features/llm-provider/services/codex-cli-harness-adapter.ts` (`ensureRuntimeHome`,
`buildEnv` sets `HOME=<workspace>/.codex-home`) and `any-bot/server/services/codebase/CodexCLIWrapper.js`
(`_ensureHome`, sets `HOME`+`CODEX_HOME`) — **copy** `/root/.codex/auth.json` into a per-task home and
point the CLI there. The codex CLI rotates the token **in the file it was given**, i.e. the per-task
copy. **No code anywhere copies the refreshed auth.json back to `/root/.codex/auth.json`.**

Why that's fatal: a ChatGPT-login `auth.json` carries a **single-use refresh_token** (the prime-gate
comment at codex-cli-harness-adapter.ts:98-110 says so verbatim). So the first in-container refresh
*spends* the shared file's refresh token and strands its replacement in a dead task workspace; every
subsequent task re-copies the stale shared file whose refresh token is already used → `"refresh token
was already used. Please log out and sign in again."` until the operator re-logs on the host. The
prime gate serializes the race but cannot fix the stranding — its own comment ("token proven fresh in
the shared file") describes a write-back that does not exist. Presents as INTERMITTENT codex auth
death after a task whose run spanned a token expiry (the 2026-06-12 "codex broken" episode was a
model-name mismatch, not this). Contrast claude-code: host-side 2-hourly keepalive + ro mount = no
in-container rotation, so it can never strand a token.

Fix directions (pick one, don't do both):
- **Write-back**: after a codex run, if the per-task `auth.json` mtime/content changed, atomically
  copy it back to the source path under the same prime-gate/lease that guards the refresh; or
- **Shared home**: stop copying — run the CLI against a shared writable `CODEX_HOME` per identity
  with a per-home file lock (this is what the `:rw` mount was for), accepting that task workspaces
  no longer isolate the credential.

**Done when:** an in-container token refresh demonstrably survives into the next task — proven by
forcing an expiry (or waiting one out), running two sequential codex tasks, and showing task 2
authenticates without a host re-login; plus the prime-gate comment matches the real file topology.

**STATUS 2026-07-12 evening — BUILT, unit-proven, adversarially reviewed; live expiry proof pending.**
Fix shipped on both launch paths: `codex-auth-write-back.ts` (TS helper: snapshot post-lease → CAS
write-back inside the prime-gated closure) + the `CodexCLIWrapper.js` twin, plus the enabling
`user-scoping.js` change (the workspace lease is now UNCONDITIONAL — TS parity; the old no-sub/no-creds
fast path let unscoped same-workspace runs interleave and re-strand the token). Hardened through a
4-skeptic adversarial pass + a verifier round: gate waiters re-seed an untouched copy from the advanced
source; re-seed requires a provably NEWER (`last_refresh`) valid-shaped source (a failed write-back
leaves the DEAD chain in the source — "differs" alone would erase the only live copy); torn/injected
content never reaches the shared credential; a missing source (secrets-seeded container) is created
atomically+exclusively (tmp+link); non-ENOENT read errors report as `failed`, not `source-moved`.
27 unit tests pin all of it (tests/unit/codex-auth-write-back.spec.ts), full vitest suite otherwise
green (the 4 `rag-permission-wired` failures pre-date this change — RAG session's workstream).
REMAINING for done-when: the live two-task expiry-spanning proof (observational — next natural
rotation exercises it) and a deployed image (bot-node containers run the baked JS layer; api hot-swap
picks up TS from main). Known accepted limits: cross-process CAS has a microsecond TOCTOU window
(worst case = pre-fix status quo); a failed-write-back workspace keeps working locally but its chain
strands if the workspace is deleted before a successful retry.

**Verified 2026-07-19:** PARTIAL — built + the 27-test spec stand; the live expiry-spanning proof + a deployed image remain.

## Trading: market-data streams — wire what we already own before buying anything (2026-07-13)

- **Context:** operator ask "we purchased some data and we have Schwab — do we need more streams?"
  Inventory as wired today: Alpaca paper key = IEX real-time + full IEX daily history + **SIP
  HISTORICAL** (consolidated tape, free, 15-min end lag — the Strategy Lab now backtests on it,
  ADR-092); Alpaca news API + the Benzinga-wire recall harness for headlines; Schwab Trader API
  (LIVE book execution + token refresh ~7d).
- **The gap is real-time consolidated quotes only** — it blocks intraday strategies (pop-catcher
  reuse, news materiality live, extended-hours re-enable per the #8 verdict) and the 5-min exit
  legs' fidelity. Daily-bar work needs NOTHING new (feed ruling 2026-07-12: IEX daily ≤0.16%).
- **Order of attack (cheapest first):**
  1. **Schwab streamer — already paid for.** The Schwab Trader API includes real-time streaming
     market data for account holders. Wire it as a `MarketDataSource` sibling (the seam exists:
     `getMarketData()` / `SchwabMarketData` in src/features/trading). Done when: 5-min bars from
     the Schwab streamer drive one intraday harness run end-to-end and diverge <0.5% from SIP
     historical on the same session.
  2. **Only if streamer breadth/latency disappoints:** Alpaca Algo Trader Plus (~$99/mo,
     real-time SIP) or Polygon starter (~$29–199/mo). NEEDS OPERATOR (spend) — do not buy until
     (1) is proven insufficient.
- **Done when:** an ADR records the chosen real-time source and one intraday backtest cites it.

**Verified 2026-07-19:** OPEN — SchwabMarketData is REST-only; no streamer `MarketDataSource` sibling; no ADR for a real-time source.

## Prediction markets (event contracts) — Kalshi lane 🟨 PHASE 1 BUILT ([ADR-094](adr/094-kalshi-prediction-markets-app.md), [docs/apps/kalshi/](apps/kalshi/README.md)); Phase 2 NEEDS OPERATOR (account)

- **Context (2026-07-13 operator ask):** Robinhood's prediction-markets hub is EVENT CONTRACTS
  routed through **Kalshi** (CFTC-regulated exchange). Operator priorities for the build:
  "winning, not easy-to-use", "predictive market indicators", "identify the bets and weigh the
  risk — like a poker hand but with probability". OSHAL offers the lane the same way it offers
  equities: the user's OWN account, per-user brokered creds — never house-money, never custody.
- **Phase 1 BUILT 2026-07-13 (no account needed — Kalshi market data is public):**
  `src/features/prediction-markets/` (public client, quadratic fee math from per-series API
  metadata, settled-tape price→outcome **calibration** with beta shrinkage, two-sided poker-hand
  **bet evaluator**: net-of-fee edge, quarter-Kelly, risk-flag discounts), `swarm-apps/kalshi.yaml`
  (`?app=kalshi` surface at `/api/kalshi/`), calibration + scan scripts with evidence docs, and
  the connector card (two-value `keyId:PEM` paste, validated by RSA-PSS-signing a real
  `/portfolio/balance` call; `OSHAL_CRED_KALSHI` broker key). See ADR-093 for the rationale.
- **Phase 2 BUILT + live-verified 2026-07-13:** portfolio (balance/positions/resting orders),
  confirm-gated limit-order placement + cancel, `kalshi_orders` audit trail (migration 074) with
  the justifying `BetHand` snapshot, and the bet dialog on the surface. Four guards, each proven
  against the real exchange: live-money gate off the key's **detected** exchange (never a client
  flag; needs `KALSHI_LIVE_ENABLED=true`), explicit `confirm === true`, limit-only 1..99¢, and
  size/cost caps. Auth env is auto-detected per key — `KALSHI_API_BASE` is NOT the switch and
  should stay unset (compose never forwards `.env` into containers, and it would also point
  market data at the thin demo book).
- **Calibration re-study (the REAL next step — the 4-skeptic adversarial review judged v1 NOT
  tradeable as measured; see evidence doc + ADR-094 status):** rebuild
  `oshal-kalshi-calibration.ts` with (1) **ask-basis pricing** (candle `yesAskClose` /
  `1−yesBidClose` as entry cost; record per-sample staleness, drop >2 candle periods stale),
  (2) randomized series order, ≤10 markets/series, one observation per event per horizon,
  (3) series-level cluster-bootstrap intervals; gate the live table on the
  multiplicity-adjusted conservative bound clearing ask+fee, (4) 6–12-month date stratification
  via `min_close_ts`/`max_close_ts`, keep only regime-stable cells, (5) isotonic/monotone curve
  instead of 16 step buckets (kills the 0.50 discontinuity). **Pre-registered hypothesis to
  test:** YES at 0.50–0.60 beats ask+fee (the only cell that survived conservatively).
  Done when: the re-run table publishes ask-basis edges with cluster-robust CIs and the
  evaluator consumes only cells that pass the gate.
- **Follow-ups (either phase):** scheduled calibration refresh (table stales toward
  fold-everything — safe but blunt); grade scan snapshots (`docs/evidence/kalshi-scan-*.json`)
  against settlements = forward-test of the edge; paper-trade the scanner logging
  quoted-ask-at-signal vs achieved fill (adverse-selection measurement) before ANY live sizing;
  portfolio layer beyond the shipped per-event dedup (per-category aggregate caps); Polymarket
  cross-venue divergence as a second `trueProb` estimator feeding the SAME evaluator.
- **Remaining on Phase 2 (operator step, not code):** the operator's DEMO connection must be
  saved + made default on `/utilities` to actually paper-trade — the live connection is saved and
  the gate correctly refuses it (403). Once a demo order fills, grade it against settlement.
- **Done when (Phase 2):** ✅ a signed-in user can browse live Kalshi markets, place a DEMO order
  audited with its justifying hand snapshot, and see it in a positions ledger; live trading stays
  gated. (Code complete + live-verified; awaiting the operator's demo connection to fill a first
  paper order.)

**Verified 2026-07-19:** OPEN (operator-gated) — code live-verified; still awaiting the demo connection + first demo order fill (no fill evidence).

**CARVED 2026-07-19 (`d8a4ea3c`, ADR-085 Wave 3):** the Kalshi surface (kalshi.html + kalshi-routes.ts + swarm-apps/kalshi.yaml) is ripped from the kernel and now lives in the store package — `/api/kalshi` is unmounted from `server.ts`, the package re-mounts it (auth: service-or-oidc, the ADR-094 confirm/fail-closed order posture byte-identical). The prediction-markets ENGINE (`src/features/prediction-markets`), the kalshi connector + `OSHAL_CRED_KALSHI` broker key, the calibration/forward-test CLIs, migrations 074/075, and the `tool-kalshi-home` default tile stay core per ADR-093. The Phase-2 operator step (demo connection + first fill) and the calibration re-study are now tracked store-side.

The host-side [scripts/trading-watchdog.ps1](../scripts/trading-watchdog.ps1) had its 07-13..15
false-positive storm fixed (commits `f4d2b3a7`, `c1cc5b41`: session-mismatch heartbeat, container-
recreate guard, RTH-gated bleeders, core-hold exclusion, retried health probe, F-check logging). A
6-agent adversarial audit surfaced deeper FALSE-NEGATIVE classes — real problems the watchdog would
NOT catch. **The 3 HIGH items were closed overnight 2026-07-16 in `5f10bdab`** (one reframed after
tracing the engine); the medium/low items below remain. Ranked by real-money exposure:

- **✅ HIGH DONE (`5f10bdab`) — live check fails OPEN on a 503/error body.** `pos=(pj&&pj.positions)||[]`
  treated a Schwab-disconnected `{error}` (HTTP 503) as an EMPTY (=healthy) book, silencing the net
  during the weekly token-expiry window. FIXED: the live JS now asserts `response.ok` AND an array
  payload; a non-200/error body returns an explicit error (fail-closed). Schwab auth/token/config
  errors route to a once-daily "re-login needed" notice; anything else to a real `live-check-error`.
  The StartedAt/recreate guard already covers cold-start transients. (Two-consecutive-error hardening
  was deemed unnecessary given the guard + 60-min suppression; revisit only if transients recur.)
- **✅ HIGH DONE (`5f10bdab`) — heartbeat was book-agnostic and ignored run errors.** New B2 block:
  during RTH the LIVE (`_live`) schedule must show its own dispatch outcome or a distinct
  `live-loop-silent` alert fires (a healthy paper beat no longer masks a dead live loop); and any
  recent "run complete" whose `errors[]` is non-empty raises `autopilot-run-errors` (the 07-07
  zombie-fire signature — the loop "completes" but isn't doing its job).
- **✅ HIGH REFRAMED + DONE (`5f10bdab`) — live "no working sell" was structurally always-true.** The
  audit proposed reading working sells from the venue; an Explore pass corrected the premise: the
  live autopilot rests **NO** protective sells on Schwab — it exits via MARKET orders each 5-min run
  and *cancels* any working sell between runs (`trading-schedule-dispatch.ts` `freeStaleSells` /
  `persistDecision` hard-codes `order_type='market'`). So a venue read would still show zero resting
  sells; the true protection signal is loop-health (B2 above). FIXED as a semantic/text correction —
  the misleading "NO working sell / the autopilot should be exiting these" text on both bleeder
  alerts now states the market-order-exit model and points at the loop-health check. **Deliberately
  NOT changed:** the drawdown threshold (still `WD_ALERT_PCT`=5). A higher live "deep-drawdown"
  threshold (e.g. -8%, giving the ~5% synthetic stop + gap room) would cut normal-drawdown noise but
  is an **operator policy call** — decide before changing when real-money paging happens.
- **MEDIUM — protection is only checked once a position is already ≥5% down** (C/E). A cancelled/
  never-placed stop on a flat/-3% position is invisible until the loss materializes — the exact
  slide the watchdog was built to prevent. **Done when:** a coverage check raises on any uncovered
  *managed* position at a tighter warn threshold, independent of current P/L.
- **MEDIUM — no halt-state / live-opt-in check.** `TRADING_HALT=true` and the live double-opt-in
  silently disable protective selling; nothing reads them. **Done when:** the watchdog raises if
  halt is active (or live opt-in is off) during RTH while the live book holds positions.
- **MEDIUM — no account-level check** (cash/margin/concentration/position-count): a sizing bug that
  over-buys into margin or over-concentrates reads all-clear. **Done when:** an account check alerts
  on negative buying power, position count above a ceiling, or single-name weight beyond a max.
- **MEDIUM — suppression key churns on set-membership changes.** Keys are the sorted symbol SET, so
  when one symbol in a multi-symbol bleed recovers the remaining ones form a new (unsuppressed) key
  and re-alert; and the stable-key case can silence a *worsening* position for a full hour. **Done
  when:** suppression is per-symbol with recovery hysteresis and a shorter live-bleed window.
- **MEDIUM — docker-CLI/container-name drift silently blinds B–F** while port-based check A still
  passes; empty `docker exec` output parses to `$null` with no throw → zero alerts. **Done when:**
  empty/whitespace exec output is treated as a distinct "check-infra" failure.
- **LOW — pre-market gap (F) can fire on one thin IEX odd-lot print** (no volume/recency bound);
  **LOW — live working-status whitelist is a hardcoded case-sensitive copy of `IN_FLIGHT_STATUSES`**
  (a future/upper-case status is missed); **LOW — `WD_ALERT_PCT` is culture-interpolated** (a
  comma-decimal locale would NaN the threshold — latent, US-locale host so not biting).

Not bugs (audited + dismissed): the ET gate's `'Eastern Standard Time'` id carries DST on Windows so
July resolves to EDT correctly; the PSSA null-compare, regex escaping, and Out-String/Substring caps
are safe as written.

**Verified 2026-07-19:** PARTIAL — the halt-during-RTH check shipped (trading-watchdog.ps1:133, closing that MEDIUM). Still open: coverage at a tighter threshold, account-level checks, per-symbol suppression hysteresis, and the empty-exec→check-infra failure.

---

## Gap-list build leftovers (2026-07-15/16 session)

Deferred work from the 13-item gap-list build, round2 (run-trace, LinkedIn assistant), and the
mobile-ux fix. Context: `docs/evidence/gap-list-build-2026-07-15.md` and the `@gap-list-build` / `@gap-list-round2` /
`@frontier-scout-ux` entries in COLLABORATE.md.

### Operator follow-ups (credentials/config — NOT engineering work)
- **Reason:** three shipped features are inert-but-correct until the operator sets a value.
- **Done when:** (1) **Outlook/M365** — Azure app registered under `maintainer@emeraldcoastsystemsgroup.com`
  (Mail.Send delegated) per the appendix in [partner-app-registration.md](partner-app-registration.md),
  `.env` `AZURE_EMAIL_APPLICATION_ID` + `OUTLOOK_CLIENT_VALUE` set, existing Outlook connections
  reconnected; (2) **Budgets** — real daily $ caps set (rails ship enforcing; **no rows = no
  enforcement**); (3) **Bot-node auth** — `SWARM_SERVICE_SECRET` set in `.env` + recreate, flipping
  `/api/swarm-execute` from WARN-only to fail-closed.

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

### Bot registry cross-variant consistency — promoted concierges live only in the local registry
- **Reason:** `social-writer` (and the 10 other concierges promoted to real bot-nodes 2026-07-09) are
  declared only in `swarm-bot-registry-local.ts`, not the canonical `swarm-bot-registry.ts`, while
  [building-a-bot.md](building-a-bot.md) says register in **BOTH**. Pre-existing; the running local stack
  uses the local variant so nothing is broken today, but a canonical-variant deploy would not see these bots.
  (Bots added since — e.g. `quality-judge` — ARE in both.)
- **Done when:** either (a) the promoted bots are mirrored into `swarm-bot-registry.ts` with identical
  UUIDs/capabilities, or (b) `building-a-bot.md` + `CLAUDE.md` are corrected to state which registry is
  authoritative per deployment variant and why the split exists. Decide **before** any canonical-variant deploy.

### Marketing Plan app (`?app=marketing`) — HELD (buildable now, zero credential)
- **Reason:** the `marketing-strategy-bot` persona already carries the full plan SOP; siblings exist
  (`business-plan-bot`, `pr-communications-bot`, `online-sales-bot`, `brand-graphics`, `website-design-bot`).
  No cohesive app wires them together. Held per operator 2026-07-16: no large/intrusive mid-week builds.
- **Done when:** `swarm-apps/marketing.yaml` registers a ticketType + `workerBot`; the persona is a real node
  (concierge on `oshal-api`, same pattern as `codex-packer`) registered in **both** registries; a
  `?app=marketing` surface produces a real structured plan (positioning, ICP, SWOT, competitor scan, channel
  mix + budget, 90-day calendar, KPIs, launch checklist); output graded by `JudgeService`; "Export to deck"
  via the shipped `/api/presentations` pptx renderer; human-testable at localhost with `MOCK_OIDC`.

### HTML5 Game Generator (`?app=game`) — HELD (buildable now, zero credential)
- **Reason:** research verified every game-engine MCP (Phaser Editor v5, Godot, Unity, Blender, RPG Maker)
  needs a **co-located GUI editor** — structurally impossible in a container bot-node, and it fails the
  human-testability gate. **Do NOT bind a game-engine MCP.** The real path is LLM-emitted self-contained
  games. Held per operator 2026-07-16. (Existing `rawg`/`steam`/`giantbomb` connectors are game *data*,
  not generation.)
- **Done when:** a dedicated bot-node emits a single self-contained CSP-safe HTML5 game (canvas + inline
  vanilla JS, zero external deps) from a prompt; a `?app=game` surface previews it in a sandboxed iframe
  (`srcdoc` + `sandbox` allow-scripts), supports iterate ("make it harder"), and saves owner-scoped (reuse the
  pumpkin/vids manifest+surface shape + visual-response RLS-scoped persistence); manifest + persona registered
  in both registries; human-testable at localhost.

### Content-creation enhancements — Atomizer / share-cards / judge-scored A/B — HELD
- **Reason:** the richest reuse of shipped rails (JudgeService, NotificationRouter, scheduler, token-chase,
  content/social/video/presentations/brand-graphics). Held per operator 2026-07-16.
- **Done when:** each is independently shippable; **do (a) first** — (a) **Atomizer**: one input fans out into
  a LinkedIn post + X thread + video storyboard + slide outline, each judge-graded, from one click (ties four
  shipped apps together — the strongest demo); (b) **OG-image / share-card generator**: local + keyless via
  existing deps (`sharp`/`playwright`), matching the brand-graphics look; (c) **A/B variants scored by the
  judge**: a fan-out of the generate-then-grade loop already in `linkedin-content-service.ts`.

### AI Deal Finder integration — DESIGN SESSION; do NOT rebuild these domains
- **Reason:** gov-auctions / foreclosures / real-estate / distressed assets are **already built** as a
  standalone product at `C:\Projects\ai-dealfinder` (Flask, `127.0.0.1:8061`, live auction+surplus listings,
  AI valuation, deal-score + ROI ranking, Leaflet map, CSV bid-sheet export, own login; reads
  `C:/Projects/gov-procurment/auction-intel/data/auctions.db`). The earlier gov-auctions "buildable-byok" verdict is **SUPERSEDED**. Operator 2026-07-16:
  integration is too large/intrusive for mid-week.
- **Done when:** a design session decides the integration shape (its own bot + connector + `?app=` surface per
  ADR-038, vs. leaving it standalone), including how `auctions.db` is reached, per-user scoping under OSHAL's
  model, and whether the surplus-funds PII exclusion (`DEALFINDER_INCLUDE_SURPLUS=0` — real names + amounts
  owed) holds. **Do NOT build a from-scratch gov-auctions/foreclosure app.**

### Cockpit surfaces for the gap-list shared services (budgets / notify / DLQ / export)
- **Reason:** budgets, notification prefs, queue DLQ, and data export/delete shipped 2026-07-15 with
  auth-gated routes but no surfaces — only global-search and run-trace got one.
- **Done when:** each has a bind-mounted cockpit tool surface registered like `tool-global-search` /
  `tool-run-trace` — budgets: view/set caps + breach events; notify: per-topic channel + quiet hours; DLQ:
  operator quarantine list + requeue; export: request export / two-step delete. Operator-scoped where appropriate.

**Verified 2026-07-19:** OPEN — no tool-budgets/notify/dlq/export surfaces (DLQ has an operator surface, so partial there).

**Verified 2026-07-19 (completion-day):** PARTIAL — the operator DATA rails now exist (routes, not cockpit surfaces): `GET /api/budgets/state` (`3173f104`, requiresOperator — every cap + trailing-window spend + recent `oshal_budget_events`), `POST /api/notify/operator` (`07a9aef0`, requiresOperator + `confirm:true`→428, fails LOUD 502 when the transport skips so a monitoring operator is never fooled by a silent no-op), and `GET /api/queue/dlq/export` (`bf738100`, requiresOperator — downloadable JSON over the SAME `DeadLetterService.listEntries`, not a second surface). Each is operator-gated inside an already-`requiresAuth` mount (route-auth inventory unchanged, 5/5 green) and ships its guard spec. The entry's done-when — bind-mounted **cockpit tool surfaces** (like `tool-global-search`/`tool-run-trace`) — stays OPEN; these routes are the accountable data layer such a surface would consume. DLQ now has list + requeue + export.

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

### Global search: deep-link contract + pg_trgm indexes
- **Reason:** results link into surfaces via ad-hoc URLs and rank via an ILIKE+recency fallback; no trigram
  indexes exist.
- **Done when:** a documented per-source deep-link contract (each adapter returns a canonical surface URL) and
  pg_trgm indexes on the searched text columns, with a measured before/after latency recorded.

**Verified 2026-07-19:** OPEN — no pg_trgm migration, no canonical deep-link contract.

### Token Chase: auto keep-winner then re-baseline loop + per-run judge budget cap
- **Reason:** step 4 (LLM-judge assessor) + 4b (judged savings report) shipped, but a winning variant is not
  promoted to the new baseline automatically, and judge calls have no per-run cost ceiling.
- **Done when:** a winning variant (judgeScore at/above bar AND cheaper) can be promoted to baseline and
  re-graded on the next run; judge spend per optimizer run is capped by an env knob and enforced (reuse the
  cost-governance `BudgetService`). Keep llm-judged and lexical-fallback frames separated in the report —
  never blend them into one "verified" number.

**Verified 2026-07-19:** OPEN — no promote/BudgetService wiring in token-chase; `TOKEN_CHASE_JUDGE_BAR` is a quality bar, not a spend cap.

### Persona evals: real-lane runs, an `eval_runs` store, and an Eval Wall ✅ SHIPPED (verified 2026-07-19)
- **Reason:** the golden-task runner + tiered assertions shipped; results are neither persisted nor surfaced.
  WARNING: the **noop lane exits 1 BY DESIGN** (semantic assertions cannot pass without an LLM) — do **NOT**
  wire the noop lane as a CI gate.
- **Done when:** a real-lane run persists to an `eval_runs` table and an Eval Wall surface shows per-persona
  pass/fail history, so a persona edit can be regression-checked before deploy.

**Verified 2026-07-19:** SHIPPED — eval-results-store.ts, src/pages/eval-wall, eval-wall-routes.ts + tests all exist. Mark done.

### `/api/me` export gaps: Chroma + Arango exporters
- **Reason:** the data-lifecycle exporter registry covers the Postgres stores; ChromaDB (RAG / swarm memory)
  and ArangoDB (graph tier) have none. Currently disclosed in-product via `KNOWN_EXPORT_GAPS`.
- **Done when:** exporters exist for the caller's Chroma collections and per-person Arango graph (or a
  documented decision that they are out of scope), and `KNOWN_EXPORT_GAPS` shrinks accordingly.

**Verified 2026-07-19:** OPEN — `KNOWN_EXPORT_GAPS` unchanged (default-exporters.ts:311).

**Verified 2026-07-19 (completion-day):** PARTIAL — `8274294e` landed real exporters: `chroma-exporter.ts` (owner_sub-metadata-scoped export+delete across collections, absent-engine no-op) + `arango-person-graph-exporter.ts` (dump + drop the caller's isolated per-sub DB via GraphConnector, no-op without ARANGO_URL), and reshaped `KNOWN_EXPORT_GAPS` to the honest residual (non-attributed Chroma content). **Wiring defect found while verifying:** both builders are imported into default-exporters.ts (:29–30) but `buildAllExporters` (:354) never appends them to the returned registry — so `/api/me` export/delete does NOT actually run either exporter, while the trimmed gap list no longer discloses it. Remaining: append both builders to the `buildAllExporters` return + a guard spec asserting they appear in its output.

**Verified 2026-07-19 (completion-day):** the wiring defect is FIXED by `ee3a386c` — `buildAllExporters` now appends `buildChromaExporter()` + `buildArangoPersonGraphExporter()` to the returned registry, so `/api/me` export/delete actually runs both. Guard `tests/unit/data-lifecycle.spec.ts` extended (+25 lines) to assert both appear in `buildAllExporters`' output. This entry is now RESOLVED for the Chroma + Arango exporters; `KNOWN_EXPORT_GAPS` discloses only the honest residual (non-attributed Chroma content).

### Run trace: per-LLM-call tokens + durations on llm-call spans
- **Reason:** `oshal_cost_events` carries no per-event token split or duration, so `TraceService` deliberately
  omits `tokens`/`durationMs` on llm-call spans rather than fabricate them (real tokens live on the bot span).
- **Done when:** an additive migration adds `input_tokens`/`output_tokens`/`duration_ms` to
  `oshal_cost_events`, `CostTrackingService.recordCost`/`appendCostLedgerRow` write them, and `TraceService`
  populates the spans. Purely additive — the trace already leaves those fields undefined.

**Verified 2026-07-19:** OPEN — `oshal_cost_events` still has only cost_usd (migration 078); TraceService still omits tokens/durations (trace-service.ts:264).

**Verified 2026-07-19 (completion-day):** RESOLVED by `b2a2cc94` — supersedes the OPEN stamp above: migration `090-cost-event-tokens-duration.sql` adds nullable `input_tokens`/`output_tokens`/`duration_ms` (NULL = "producer did not know", never 0); `appendCostLedgerRow` writes them with a 42703 fallback to the legacy 6-column insert so a pre-090 DB never loses the cost row; producers (llm-execution-handler, bot-node-execution-handler, storyboard-image-cost, vision-describe) thread `CostEvent.durationMs`; `TraceService.mapLlmSpan` populates llm-call spans when the row carries them and `loadLlmSpans` selects `e.*` for pre-090 compat. Guard: `tests/unit/run-trace.spec.ts` round-trip + null-safe cases.

### Mobile responsive: extend the pinned-header / single-scroll-child pattern + a real viewport test
- **Reason:** the ticket detail pane was fixed 2026-07-16 (`6c42cb3b` — the pane is now a bounded flex column
  and only `.td-body` scrolls), but the same flexbox scroll trap (`overflow-y:auto` on a parent with
  `flex-shrink:0` children and no `min-height:0`) likely exists on other detail surfaces. The fix is verified
  by jsdom/CSS-text assertions, **not** a real browser at 375px.
- **Done when:** calendar/workboard/settings (and any surface operators report clipping on) are audited for the
  same pattern; a Playwright viewport test at 375px asserts `.td-body` is the scrolling element
  (`scrollHeight > clientHeight` while the pane itself does not scroll); if the pinned escalation panel still
  crowds the body on a real device, collapse it into a `<details>` at 640px and below.

**Verified 2026-07-19:** OPEN — still jsdom/CSS-regex only; no Playwright 375px scrollHeight assertion.

### Portrait Studio image engine ✅ RESOLVED 2026-07-17 — `openrouter` sibling provider (`ef8c7583`)
- **What actually happened:** the 07-16 diagnosis was wrong in an instructive way. The codex OAuth token
  was NOT expired (JWT `exp` five days out) and the codex CLI was NOT wedged (0.144.5 completes; the probe
  had left stdin open — `codex exec` waits on piped stdin for EOF). The real blocker: **`/v1/images`
  rejects ChatGPT-subscription tokens** with a misleading "token has expired" — subscription auth works
  for the codex backend, never for the platform Images API. Fix: `STORYBOARD_IMAGE_PROVIDER=openrouter` —
  a new explicit, fail-closed sibling driving `google/gemini-2.5-flash-image` (image-to-image via data-URL
  chat parts) on the swarm's OpenRouter key, ~$0.04/image against the prepaid credit. The ADR-064
  :free-only guard covers the CHAT fallback only and is untouched. Portrait Studio's daily cap
  (`PORTRAIT_STUDIO_DAILY_CAP`, 25/user/day) bounds worst-case spend ≈ $1/user/day.

### Drone Ops phase 2 — drones as remote swarm nodes + carve to the store (ADR-099)
- **Reason:** phase 1 (2026-07-17, ADR-098) shipped single-drone automation control against the built-in
  deterministic sim (`src/features/drone/`, `?app=drone`) — hardware-free by design. Operator decision
  2026-07-17 ([ADR-099](adr/099-drones-as-remote-swarm-nodes.md)): Drone Ops is an **extension, not
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

### ADR-100 person-model: the deterministic in-Jarvis recall hook ✅ SHIPPED 2026-07-18 (`6342a53e`)

- **Context:** ADR-100 Phase 1 shipped the ambient recall engine (`src/features/person-model/`), the
  auth-gated route `/api/jarvis/ambient/person/recall`, and the `person-model` extension app + surface.
  The hero **spoken** path ("Jarvis, how many times has Ella mentioned volleyball today?") needed a
  recall-guard hook in the `/api/jarvis/ask` flow — which was blocked because `jarvis-routes.ts` was
  >2× the hard cap. That blocker is gone (decomposed 2026-07-18, `b0757df4`).
- **Shipped:** the `/ask` handler now calls `detectRecallIntent(message)` and, on a match for an owner
  who actually has ambient data (`ownerHasAmbientData` gate — so ordinary questions aren't hijacked),
  answers **deterministically** from the transcript store via `recallQuery` + a new user-facing
  formatter `buildRecallSpokenAnswer` — a literal SQL count + verbatim quotes, **no model turn** (a
  stronger version of the "never from model memory" goal than the originally-planned prepend-to-model).
  Recall wins over the provider-bound/weather path; a recall failure falls back to a graceful message.
  The surface's browser TTS reads the answer back for playback. New feature helpers:
  `recall-query.ownerHasAmbientData` (fail-closed), `recall-guard.buildRecallSpokenAnswer`.
- **Verified:** +3 unit tests on `buildRecallSpokenAnswer`; live-proven on the deployed api —
  "how many times has anyone mentioned curry" → **32**, `done` on the first poll.

### ADR-100 person-model Phases 2–4 (enrichment, consent ledger, semantic recall, person pages)

- **Context:** Phase 1 is recall-only. The remaining phases are specified in
  [docs/adr/100-ambient-person-model.md](adr/100-ambient-person-model.md) with per-phase done-when.
- **Done when (per the ADR):** Phase 2 = the `ambient-analyst` Form-B bot + micro-batch enrichment +
  ask extraction + the per-heard-person consent ledger (default-off modeling, **decline = stop AND
  purge**, minors' inference hard-stop) + the six-surface disclosure rewrite. Phase 3 = semantic
  recall via `rag_chunks` behind the `owner_sub`-column entry gate + trend/relationship queries +
  `scripts/person-model-rebuild.ts`. Phase 4 = person-profile pages + delete/rename/merge
  re-projection hooks. Audio-clip retention stays REJECTED behind the ADR §5 reopening gate.

**Verified 2026-07-19:** PARTIAL — the Phase 2 enable-gate is done (residual (5): the fresh-DB consent trigger check); the Phase 3 rebuild script is absent; Phase 4 person pages are absent.

### ADR-100 Phase 2 "enable gate" — ✅ COMPLETE 2026-07-18 (one residual: fresh-DB trigger check)

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

## Comms delivery adapters for AI Office artifacts (ADR-108 deferred item)

- **What:** Deliver a generated .pptx/.docx/.xlsx to office-communication surfaces — Slack
  (connector already connected), Teams (needs Microsoft connection), SMS/MMS link via the Twilio
  comms bot (built, uncredentialed). Same adapter seam as storage (ADR-108): "where does the
  artifact land." **EMAIL LEG SHIPPED 2026-07-18** (`3dca302d`, live-proven self-send):
  `POST /api/presentations/sections/email` renders the current outline and sends it via the
  user's own Gmail (`sendGmail`) or Microsoft Graph (`sendOutlookMail`, dormant), behind the
  `confirm: true` 428 gate, with the ✉ Email compose row in the Studio. Slack/Teams/SMS remain.
- **Done when (remaining):** (1) slack adapter behind the same explicit-confirm gate (2) the
  Studio's send affordance offers only connected providers; (3) a live Slack round-trip proven
  with the existing connected workspace; (4) Teams adapter lands dormant behind the same
  microsoft token used by the onedrive adapter; (5) if a third sender appears, extract the
  `deliverContent(ctx, sub, target, artifact)` seam — two senders didn't justify it.

**Verified 2026-07-19:** PARTIAL — the email adapter shipped (ADR-108 `POST /email` + 428 gate); slack/Teams/SMS + the `deliverContent` seam remain.

## Sat-ops: MEKF measurement-noise mapping under the 'conjugate' 42 convention (ADR-102 W2)

- **What:** The 42 adapter's convention voter can lock `conjugate` (q from 42 needs conjugating
  before use); the MEKF's ST measurement covariance `rBody` is built once from the mount
  quaternion assuming the right-multiplicative body-frame error of the DIRECT mapping. Under a
  conjugate lock the noise ellipsoid may be applied mirrored (inertial-side vs body-side),
  mis-weighting the 2/2/20-arcsec anisotropy. All live CfsSat missions locked `direct`
  (votes ~21–23 vs 2–4), so the suspect path has never executed live — flagged by the W2
  adversarial review; refuters never ran (session limit), so it is unverified either way.
- **Done when:** (1) a unit test constructs both conventions from the same synthetic 42 stream
  and proves the applied R anisotropy lands on the same BODY axes in both; (2) either the
  mapping is proven convention-invariant or `updateStarTracker` gains the conjugate-aware
  rotation; (3) a forced-conjugate live run (or replayed capture) shows gate accept-rates
  comparable to the direct lock.

**Verified 2026-07-19:** PARTIAL — the mount-rotated `rBody` + `quatConjugate` handling is implemented; the convention-invariance unit test does not exist.

## DevOps cockpit — Phase 2+ (topology, node deploy, specialists, connectivity)

Design: [docs/architecture/devops-cockpit-connectivity.md](architecture/devops-cockpit-connectivity.md).
Phase 1 (Vault broker console + green/yellow/red creds light) is **shipped + live** (ADR-040
activation, `1285b483`). The remaining phases are designed, not built — each identifies the
connectivity choices rather than hard-wiring one.

- **Topology discovery ("startup step one").** A read-only pass that shells the logged-in CLIs
  (`aws`/`gcloud`/`az`/`kubectl`/`terraform`/`ssh`/`docker`) and ingests the result into the
  ADR-045 graph tier as a node/edge topology.
  - **Done when:** running the pass on a box with ≥1 logged-in cloud CLI produces a queryable
    topology graph (accounts/clusters/instances/boxes as nodes) with NO standing creds stored,
    and the cockpit renders it; unreachable/denied CLIs are skipped with a reason, not a crash.
- **Connect-Vault flow + generalized traffic-light.** A UI to point OSHAL at a Vault (addr +
  Token/AppRole/TLS/OIDC), stored encrypted; the shipped green/yellow/red light generalized to
  every connection (cloud, k8s ctx, terraform backend, box).
  - **Done when:** an operator configures Vault without editing env, each connection shows a live
    🟢/🟡/🔴 with a reason, and a bad cred reads 🔴 denied (not 🟡).
- **Spatial selectors.** Terraform-state selector (local/S3/TFC/git/box, self-discovered from
  `backend` blocks) and k8s login-pattern selector (kubeconfig ctx / in-cluster SA / cloud IAM /
  OIDC), each independent of the cloud creds.
  - **Done when:** the cockpit self-discovers candidates and the operator can override + test each.
- **Node deployment.** Get the `@oshal/chat` edge CLI onto discovered nodes. Ship the NAT-friendly
  pull paths first (HTTPS self-register one-liner + image/cloud-init startup hook), then push paths
  (AWS SSM, SSH, `kubectl apply` DaemonSet).
  - **Done when:** a node behind NAT self-registers over HTTPS and appears in the topology as a live
    bidirectional node; an SSM/SSH push deploys to a reachable box; the image hook self-provisions on boot.
- **Bidirectional remote node.** Select ONE transport (Headscale overlay ADR-013 / A2A gateway /
  HTTPS long-poll) so OSHAL dispatches work to a node AND it reports back.
  - **Done when:** a registered remote node round-trips a dispatched task over the chosen transport
    with the node outbound-only (no inbound firewall change required for the long-poll/overlay path).
- **The specialists** (CI/CD → infra → k8s → observability), each a persona that pulls a short-TTL
  scoped cred from the Phase-1 broker per task; privileged ones behind the per-session ephemeral
  runtime + a security review (the remaining ADR-040 build).
  - **Done when:** a specialist completes a real task (e.g. `terraform plan` / `kubectl get`) using
    ONLY a Vault-brokered short-TTL credential that is provably revoked after, apply/deploy stays
    human-gated, and the ephemeral runtime leaves no residual credential.

**Non-negotiables:** superadmin-gated; mutations `confirm:true` + audited; no standing cloud keys;
apply/deploy human-gated; every remote node operator-owned + consented.

**Verified 2026-07-19:** OPEN — Phase 1 is live; topology discovery / connect-Vault / spatial selectors / node deployment / specialists remain designed, not built.

## Camera Ops (`?app=camera`) — real-device follow-ups

Camera Ops shipped 2026-07-18: the `features/camera` slice (engine-agnostic `CameraProvider`), the
always-on `sim-1` engine, a real Open GoPro HTTP adapter (usb/ap/cohn link modes), the `camera-node`
host companion, `/api/camera` routes with a destructive-op confirm gate, the `camera-operator`
concierge, and the cockpit surface. 30 tests green (unit + route-boundary). See
[docs/runbooks/camera-node-gopro.md](runbooks/camera-node-gopro.md). The HTTP control plane is real;
these extend reach:

- **BLE bootstrap + COHN provisioning (GoPro).** USB control needs no Bluetooth, but AP mode needs a
  BLE command to enable the camera's Wi-Fi, and COHN (HERO12+) needs one-time BLE provisioning (join
  STA network → create/fetch the self-signed cert → read username/password/ip). A `gopro-ble` module
  in the camera-node using a Node BLE stack (protobuf for COHN/networking; TLV for AP-enable).
  - **Done when:** `CAMERA_GOPRO_LINK=cohn` on a HERO12+ provisions over BLE once and thereafter
    controls the camera over `https://<lan-ip>` with the pinned cert + Basic auth, and
    `CAMERA_GOPRO_LINK=ap` enables the camera Wi-Fi over BLE without the camera UI.
- **Browser-playable preview (transcode).** The GoPro preview/webcam feed is H.264/MPEG-TS over UDP
  :8554 — not browser-playable. The node should transcode to HLS or MJPEG and publish it as
  `CAMERA_VIDEO_URL` so the surface's live card shows an actual feed.
  - **Done when:** starting preview on a real GoPro makes a moving image appear in the cockpit
    live-preview card (the node serves the transcoded URL; the controller already caches + exposes it).
- **COHN cert pinning at the node.** The adapter builds the COHN URL + Basic auth; trusting the
  camera's self-signed Root CA cert needs an https dispatcher wired at the node (undici Agent / CA).
  - **Done when:** a COHN request verifies against the provisioned cert (no blanket TLS-verify-off).
- **Next brands (one adapter each, not a new app).** Canon **CCAPI** and **ONVIF/RTSP** are the
  easiest next real adapters (both LAN-IP HTTP). Sony CRSDK (licensed C++), Insta360 (partner-gated),
  and DJI Osmo (no public API) are lower priority.
  - **Done when:** a second-brand adapter implements `CameraProvider` and drives a real device from
    the same surface with zero controller/surface changes.
- **Live deploy (guard-deferred 2026-07-18).** Code is on `main` and unit/route-tested; the docker
  rebuild+recreate was blocked by an in-flight career scrape. Rides the next rebuild-from-HEAD.
  - **Done when:** `?app=camera` loads on the deployed api and drives the `sim-1` camera in a browser.

**Verified 2026-07-19:** OPEN — BLE/COHN, preview transcode, cert pinning, second brand, and the live deploy all pending; the camera-node standalone is not packaged.

## Jarvis media input — PDF/Word document extraction + richer vision (ADR-110 follow-ups)

Jarvis media input shipped 2026-07-18 ([ADR-110](adr/110-jarvis-media-input-vision-as-transcription.md)):
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

## A2A auth-failure limiter keyed on spoofable req.ip ✅ (security review LOW, 2026-07-19 — FIXED 2026-07-19)

- **Context:** server.ts sets `trust proxy` true, so a rotating `X-Forwarded-For` defeats the
  10-failures/60s limiter on the A2A bearer endpoint (a2a-routes.ts:169). Impact small (192-bit
  tokens make brute force impractical), but the stated defense doesn't hold as written.
- **Done when:** the limiter keys on a non-client-controlled value (socket remoteAddress or a
  pinned trust-proxy hop count) + a unit case proving a rotated XFF still lands in one bucket.
- **Fixed 2026-07-19:** `a2aLimiterKey()` in a2a-routes.ts keys the bucket on the transport peer
  (`req.socket.remoteAddress`), never `req.ip`; req.ip stays in the warn log only. Accepted
  tradeoff (documented on the helper): behind cloudflared all external callers share one failure
  bucket — fine, the limiter throttles FAILED authentications only. Unit regression in
  tests/unit/a2a-gateway.spec.ts ("limiter keying — rotated X-Forwarded-For cannot escape the
  failure bucket"): rotated-XFF failures 429 out of one bucket, distinct peers keep their own
  buckets, successful auth is unaffected.

## llm-provider barrel drags the harness stack onto the controller graph ⬜ (TODO-BOUNDARY-FINDING, 2026-07-19)

- **Context:** found by tests/unit/controller-runtime-boundary.spec.ts. `src/features/llm-provider/index.ts`
  re-exports the harness adapters, so any controller import of the barrel statically loads them; the
  sanctioned edge is only `extensions/swarm → resolveHarnessForAgent`.
- **Done when:** harness exports are moved off the barrel (deep module or a separate entry point), and
  the boundary spec's allowlist shrinks to the sanctioned edge only.

## ~~Security Center route-audit PUBLIC_BY_DESIGN list stale~~ ✅ DONE (verified 2026-07-31; shipped 07-24/07-29)

- **Context:** `src/features/security/route-audit.ts` doesn't know `/api/profile-studio` (added
  07-17, serviceSecretOk-gated) — likely a standing false positive in the Security Center.
- **Done when:** the list is updated + a sync check exists against
  `tests/unit/server-route-auth-inventory.spec.ts`'s allowlist.
- **Verified 2026-07-31: BOTH halves already shipped** — this entry had gone stale in the other
  direction. `/api/profile-studio` (+ the five reviewed package mounts and the two inline-handler
  mounts) landed in PUBLIC_BY_DESIGN via route-audit.ts seq 5–7, and route-audit.spec.ts seq 2
  carries the PROGRAMMATIC two-list sync check (imports both lists, asserts containment in both
  directions, plus the method-coverage guard that closed the app.get/app.post blind spot). Nothing
  left to build.

## Spaces / spatial mapping (ADR-111) — deferred phases + box-side pipeline ⬜ (2026-07-20)

Phase 1 (`?app=spaces`: upload a walkthrough video → walk the 3DGS scene) is BUILT + verified.
These are the deferred halves, recorded here per the deferred-work rule (they previously lived
only inside [ADR-111](adr/111-spatial-mapping-3d-reconstruction.md)):

- **Box-side reconstruction service (`spatial-recon-edge`).** ✅ BUILT 2026-07-20
  ([scripts/spatial-recon-edge/](../scripts/spatial-recon-edge/README.md)): stdlib HTTP server +
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

### Spaces store carve — activate (flip marketplace `packaging` → `ready`) — ADR-111 / ADR-085

The Spaces surface is **carved and published** to the oshal-applications store
(`spaces/` package, `807c69a`; marketplace `status: packaging`). The engine stays core as
the pinned `spatial-mapping` kernel skill (`689855f0`), the `spaces-operator` inline
concierge + both registry entries stay core, and the sim-scan `@/features/drone` dep resolves
via the `drone-node-server.ts` anchor. The package's `routes/spaces-routes.js` is built (incl.
the `/pair` mobile-ingest endpoint; `insertCliToken` via `@/app/routes/cli-token-routes`);
`oshal-app validate` clean. **Deferred because** the core rip needs an image rebuild (api runs
`node dist/app/server.js`, not tsx-watch) + `oshal-deploy.sh`, and that must not fire unattended
while another lane is mid-deploy or `docker-compose.oshal-local.yml` is dirty with WIP.
**Done when (one atomic, attended window):** (1) delete `swarm-apps/spaces.yaml`; (2) remove the
`createSpacesRoutes` barrel export ([src/app/routes/index.ts](../src/app/routes/index.ts)) + the
`/api/spaces` import+mount ([src/app/server.ts](../src/app/server.ts)); (3) delete
`src/app/routes/spaces-routes.ts`; (4) `node scripts/oshal-app.js install spaces` (sparse-pull
into `deployed-apps/`) + hot-load; (5) `bash scripts/oshal-deploy.sh` green (parity + health +
kernel-skills guard, `spatial-mapping` still in dist); (6) `?app=spaces` loads from the installed
package, `/api/spaces/app` 200, install/uninstall works; (7) flip marketplace `spaces` →
`status: ready`. **Then clean up** the now-dead `src/api/spaces{,-viewer,-capture}.html` + the
three `docker-compose.oshal-local.yml` binds (L1123-1125) once compose is uncontended.

### Native iOS Spaces LiDAR scanner — build / sign / ship — ADR-111

Scaffold committed at [clients/ios-spaces-scanner/](../clients/ios-spaces-scanner/) (`4cd5e7b4`):
SwiftUI/ARKit app that reads the iPhone (15 Pro Max) LiDAR mesh, exports a real `.ply` (correct
`ARMeshGeometry` buffer parsing) + a pose sidecar matching the swarm `poses.json` contract, and
uploads to `POST /api/spaces/scans/import` with an `Authorization: Bearer oshal_pat_…` pairing
token. Not compilable here (Windows/no Xcode). **Done when:** it opens via `xcodegen generate`,
builds + signs with a real Apple team + unique bundle id, deploys to the device, captures a room,
pairs with a cockpit-minted token, and the uploaded scan appears in `?app=spaces`. First Xcode
build is the Swift compile check.

### Guard the Spaces package's uncontracted framework deps — ADR-085 D8 / ADR-090

The `spaces` store package imports two modules that are **not** declared kernel skills, so the
kernel-skills CI guard (`scripts/check-kernel-skills.ts`) does not protect them:
`@/features/drone` (`SimDroneProvider`/`validateMission`, anchored in dist only by
[src/app/drone-node-server.ts](../src/app/drone-node-server.ts)) and
`@/app/routes/cli-token-routes` (`insertCliToken`; in dist because `src/app/**` is always an
include root). Both resolve today, but a future drone-engine carve or a cli-token refactor could
silently prune them → the installed package fails at **mount** (the google-calendar/notifications
bug class). **Done when:** either (a) `check-kernel-skills.ts` is extended to assert every non-skill
module a published store package imports is present in the built image, or (b) a targeted CI check
asserts `dist/features/drone/index.js` + `dist/app/routes/cli-token-routes.js` exist while any
package requires them, or (c) an ADR records this as accepted (drone stays a node per ADR-099;
app-layer always builds) with the risk noted in the carve-activation checklist above.

### ci-local --head: three reds from the first trunk run (2026-07-23) — ✅ ALL CLEARED 2026-07-24 (fix fleet; residual: one quiet-box e2e rerun)

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

### Registry installer: live fresh-install trial — the codebase-free path is BUILT, unproven end-to-end

The full no-codebase install path shipped 2026-07-23: images on GHCR
(`oshal-bot` + `oshal-speaker-diarization`, tagged
latest / version / sha), `compose.dist.yml` generated at image build
(scripts/gen-dist-compose.js — build sections dropped, repo binds removed with
an env-default-aware filter, `./config-seed` + BYOK home mounts kept),
non-secret seeds baked to `config-seed.dist/`, and a self-contained
`scripts/oshal-install.sh` (pull → extract → generate `.env` secrets →
ordered+batched bring-up embedded — no repo scripts assumed). What has NOT run
is the actual trial: this 6 GB box cannot host a second swarm (see
oshal-6gb-docker-bringup), so every piece is verified in isolation but not the
end-to-end on a fresh machine. **Done when:** on a clean box/VM with only
Docker, `bash oshal-install.sh` (with GHCR_TOKEN while private) completes the
batched bring-up, a human signs in via MOCK_OIDC at the cockpit, the
routability set heartbeats, and one ticket round-trips. Known deltas to expect,
by design: no `scripts/` beyond the image allowlist (operator/seed scripts
absent), no dev-repo mount (oshal-dev degrades), connector OpenAPI imports
start empty (re-importable).

## Futures extension layer (ADR-116) — deferred pieces

The foundation shipped 2026-07-24: instrument model, mock+Kibot data source, `market_bars` store
(migration 096), completeness validator + ingest orchestrator, and an in-memory paper futures broker,
all proven end-to-end by `scripts/oshal-futures-ingest.ts` and three unit specs. What was deliberately
deferred (`do what you can, backlog the rest`):

- ~~**The friend's actual strategy rules — the critical input.**~~ **COMPLETE 2026-07-28.** Both
  halves are ported and all five open questions are ANSWERED by the trader. The exit half (three-layer
  stop stack) and entry half (ten graded states, both generations) shipped 2026-07-27; his answers
  landed 2026-07-28 and moved three defaults plus added a third entry generation. Full answer table:
  [docs/apps/trading/futures-stop-engine.md](apps/trading/futures-stop-engine.md#dictation-vs-code-divergences--answered-by-the-source-trader-2026-07-28).
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
  [docs/apps/trading/futures-backtester.md](apps/trading/futures-backtester.md). **Remaining from
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

## Game Show app (ADR-112) — the show is built; the remaining work is polish and coverage

**Status 2026-07-26** — the app itself lives in the **oshal-applications store repo**
(`game-show/`), and so does its detailed backlog with per-item done-when criteria:
[`game-show/README.md` → "Backlog — next steps"](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/game-show/README.md).
This entry exists so the core backlog does not imply the app is unfinished, and so the two
items with a *core* dependency are visible from here.

Shipped since the ADR was written: all four shows (Family Feud + Fast Money, Jeopardy +
Double Jeopardy, Wheel of Fortune, Whammy!), AI contestants so one person can play a whole
game night with zero LLM calls, and a broadcast presentation layer (per-show television sets,
podium characters, sound cues, opening titles). [ADR-112](adr/112-game-shows-as-plugins.md)
carries an amendment recording what shows #3/#4 cost the design and the two new plug-in
points (`npcMove`, the per-show set).

**The two items with a core-side dependency:**

- **The show opens in silence.** The opening titles fire with a synthesized fanfare, but the
  *announcer* never speaks unless the host clicks 🎤 Intro — the TTS speaker lease is already
  elected by then, so this is a dispatch gap, not a voice gap. Relevant because host voice
  rides the platform TTS harness (swarm default: billed `google-cloud-tts`; this package
  resolves `gemini-tts` first because the Workspace OAuth profile it needs is not configured).
  **Done when:** starting a game auto-narrates the open on the speaker surface, with
  caption-only fallback when TTS is unavailable.
- **Installed by `docker cp`, not by the sanctioned installer.** The store checkout is not
  bind-mounted and `oshal-deploy.sh` does not ship store packages, so every deploy of this app
  is a manual copy into the `oshal_workspace` volume plus an api restart.
  **Done when:** the package installs via `scripts/oshal-app.js install game-show --ref main`
  and leaves a provenance stamp.

**Everything else is app-local** (an unbroken Whammy panel ring at 8–12 panels, a browser spec
per show rather than Feud only, a deterministic set-screenshot rig, the motion-avatar presence
module, the rendered cutaway MP4s, a cross-game leaderboard surface) and is tracked in the
package README above — do not duplicate those items here.

---

## remote-client specs are flaky under full-suite parallelism (2026-07-27)

`tests/unit/remote-client-auth.spec.ts` and `tests/unit/remote-client-reregistration.spec.ts`
time out intermittently when the whole `tests/unit/**` suite runs, and the *set* that fails
changes between runs — 4 failed on one pass, 3 on the next, different cases each time. Both bind
network ports, so the signature is port contention under parallel load rather than a product
defect.

**Evidence:** green in isolation, every time —
`npx vitest run tests/unit/remote-client-auth.spec.ts tests/unit/remote-client-reregistration.spec.ts`
→ 21/21 passed in 3.5s. Full suite the same afternoon: 3,905–3,906 of 3,908 passed, with only
these two files varying.

**Why it is logged rather than left red:** a red gate nobody acts on trains everyone to ignore
red. This is the explicit quarantine that rule asks for, filed the same day it was observed.

**Done when:** the full `tests/unit/**` suite passes 20 consecutive runs with no flake — proven by
a loop, not by one green run. If a cause cannot be found, mark the specs `sequential` in the vitest
config so parallelism cannot cause it, and say so here.

**⚠ CORRECTION (2026-07-28) — port contention is NOT the cause, and the original done-when was a
no-op.** Both specs call `app.listen(0)`, which binds an **ephemeral** port assigned by the OS, so
two suites cannot collide on one. "Allocate ephemeral ports" was therefore already satisfied;
implementing it would have changed nothing and the flake would have survived. Verify before
adopting a stated cause here — this one did not survive reading the two files.

**Partial fix applied (2026-07-28):** `remote-client-reregistration.spec.ts` had a real, separate
weakness — each of its three route tests booted its OWN express server, so each paid the one-time
dynamic-import/transform of the real router graph on vitest's **5s default**. That is precisely the
cost `remote-client-device-ownership.spec.ts` documents and buys `15_000` for. It now boots one
server per file in a `beforeAll` with an explicit 30s budget.

**Still open, and honestly unexplained:** that does NOT account for
`remote-client-auth.spec.ts`, whose four server-booting tests **already carry `15_000` budgets** and
which the entry reports flaking anyway. The timeout-budget theory covers one file, not both. Two
untested leads for whoever picks this up: (a) `remote-client-routes.ts` holds a **module-level**
`remoteClientRegistry` singleton, and (b) the auth spec's flag-gated rate limiter keeps **bucket
state across tests within the file**, so its "throttles the 3rd request" case depends on what ran
before it. Neither is confirmed.

**Reproduction status:** NOT reproduced on 2026-07-28 — two consecutive full-suite runs came back
419/419 and 418+1-skipped, both green. The flake is real (it was observed) but it is infrequent
enough that two runs prove nothing; the 20-run loop in the done-when is the bar for a reason.

**Not caused by:** the delivery-bot registry entries (#68) — those add data to two arrays and are
covered by `tests/unit/delivery-bots-registered.spec.ts`, which is green in both modes.

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
See [ADR-117](adr/117-local-auth-invited-users.md) and
[docs/security/local-auth.md](security/local-auth.md#two-step-sign-in-totp).

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

## App access tiers Phase 2 — the platform primitive (ADR-118) ⬜ (2026-07-28)

The deny/viewer/editor/admin contract is Accepted and binding on manifests; the platform-side
assignment + enforcement is the build. Nothing blocks a client-box install meanwhile — tiers are
set inside each app's own admin (the CRM's Users screen) until this lands.

- **Done when:** (1) `oshal_app_access` (user_sub × app × tier) exists with explicit-deny-wins
  resolution and an operator/admin API + cockpit surface to set tiers per user per app;
  (2) an enforcement middleware at the app-route boundary answers deny→403 on every method and
  viewer→read-only (the guest Tier-B lockdown shape, but per-user), with editor/admin deferring
  to the app's capability model; (3) a red-provable guard shows a denied user 403s on a
  previously-open app route and a viewer's POST is refused; (4) the ten kernel manifests plus
  intelligent-sales carry `access:` declarations and an unknown tier name fails the manifest
  load; (5) docs/security/local-auth.md links the ladder so the invite flow and the tier
  assignment read as one story.

## Explicit-remote pin must beat apply-intent text sniffing ✅ SHIPPED 2026-07-28 (PR #79)

A `task` ticket carrying a structured `metadata.targetRemoteClientId` pin was re-routed by the
`applicationRequested` free-text matcher in `dispatch-manifest-worker.ts`: the Windows path
`C:\Program Files\Google\Chrome\Application\chrome.exe` inside the ticket description satisfied
BOTH the apply-noun and apply-verb regex (the word "Application"), so the ticket went down
`dispatchJobApplicationTask`, which auto-picked the next packet-ready posting and really submitted
it from the desktop node (posting 1339467, `applied_at` 2026-07-29T00:29:13Z) — an outward-facing
action the operator did not order. The comment above `explicitRemoteRequested` already states an
exact remote-client target is "an execution address, not a routing hint" that must be resolved
before routing heuristics; the evaluation order doesn't yet honor that.

- **Done when:** (1) a ticket with a structured `metadata.targetRemoteClientId` dispatches via
  `dispatchExplicitRemoteTask` even when its title/description text matches the apply regexes —
  the explicit-remote branch is evaluated before `applicationRequested` (the structured metadata
  pin at minimum; decide deliberately whether the free-text uuid scrape keeps its current lower
  precedence); (2) a unit spec proves it red on today's order — a pinned ticket whose text
  contains `...\Chrome\Application\chrome.exe` plus the word "send" must NOT reach
  `dispatchJobApplicationTask`; (3) the apply matcher no longer fires on file-path tokens
  (require apply intent to also carry `metadata.postingId`/`applyPostingId`, or strip path-like
  tokens before matching) — pick one and guard it.
- **Shipped (PR #79):** all three, and BOTH remedies were taken rather than one. Intent is now
  structured-first — `metadata.postingId`/`applyPostingId` alone means apply; prose decides only
  when there is no apply metadata AND no `targetRemoteClientId` pin, which is what makes an
  explicit execution address win without reordering the branches (a real apply ticket also carries
  a node pin, so a naive reorder would have broken the apply rail in the opposite direction).
  `stripPathLikeTokens` blanks whitespace-delimited tokens containing a path separator before
  matching, so paths and URLs cannot supply intent words. Guard:
  `tests/unit/explicit-remote-at-most-once.spec.ts`, proven red with an identity strip function.

## Explicit-remote tickets need at-most-once semantics across an api restart ✅ SHIPPED 2026-07-28 (PR #79)

`dispatchExplicitRemoteTicket` awaits the node's result in an **in-process** polling loop
(`getCompletedResult` every 1s up to `EXPLICIT_REMOTE_TICKET_TIMEOUT_MS`). If the api restarts
between enqueue and completion, that await dies with the process: the node runs the task to
completion anyway (it is a separate process), the result is published to a mesh stream nobody is
waiting on, and the ticket is left stranded in `in_process_build` until the queue watchdog rolls it
back to `approved` — at which point it is **dispatched a second time and the real-world action runs
twice**. Live 2026-07-28: ticket `52fc430c` (send a contact-form message) was dispatched at
00:37:28Z, the Stack Watchdog restarted the api 15s later at 00:37:43Z, run #1 submitted the form at
00:43:09Z, the rollback re-dispatched at 00:53Z, and run #2 submitted the same form again at
00:58:17Z. The recipient got the message twice.

The apply rail already solved exactly this shape (`rehydrateApplyInFlight` re-seeds the in-flight
registry at boot, plus a 35-minute orphan reaper that only reclaims tickets older than the
watchdog); the explicit-remote rail has neither, and outward-facing sends are the worst class of
work to retry blind.

- **Done when:** (1) a completed remote task result is reconciled against its ticket from
  PERSISTED state rather than only an in-process await, so an api restart mid-flight resolves the
  ticket instead of re-running it (the mesh result already carries `correlationId` = the ticket id
  — a boot-time reconcile or a durable result consumer both satisfy this); (2) a rollback of an
  `in_process_build` explicit-remote ticket cannot re-dispatch while a task for that ticket is
  still outstanding on the node (mirror the apply in-flight guard/reaper bounds); (3) a unit spec
  proves the restart path red — dispatch, drop the await, deliver a completed result, and assert
  exactly ONE enqueue for that ticket; (4) the outward-action prompt convention gains an
  idempotency note so a re-run detects "already sent" where the target surface allows it.
- **Shipped (PR #79):** `dispatchExplicitRemoteTicket` records its remote task id onto the ticket's
  own metadata (`explicitRemoteTaskId`, Postgres) BEFORE enqueueing — the reverse order loses the
  very race the guard exists for — and a later dispatch of the same ticket resolves that prior
  attempt: completed → adopt its result (success or failure), still in flight → resume waiting,
  no record at all → REFUSE with an operator-readable escalation, because a wiped registry means
  the node may have done the work and a repeat is not a safe retry. A `recordDispatch` that throws
  aborts the dispatch instead of enqueueing unguarded. The node prompt now also carries the
  exactly-once instruction (done-when 4). Guard:
  `tests/unit/explicit-remote-at-most-once.spec.ts` (11 cases), proven red by removing the guard.
- **Still open (deliberately):** this makes the rail at-most-once, not automatically self-healing —
  the unknown-outcome case asks a human rather than reconciling from the node's own task history.
  A durable result consumer that resolves the ticket from the mesh result would close that gap.


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

## First-run provisioning wizard — store → apps → users → defaults (operator vision, 2026-07-28) ⬜

Stated the night the first hosted customer box went live, after doing all of it by hand: "the
first time swarm login should allow you to import your applications… you pick your applications,
you change app stores by providing a URL… and then it asks you about users and… default backup
keys." Today that flow is a human with SSH: the /welcome wizard covers identity+LLM only; app
install is deploy-scripts; users are the (new) invite screen; backups are a hand-written cron.
The pieces exist — the wizard that strings them into one first-run path does not.

- **Done when:** on a fresh LOCAL_AUTH box, the first admin login walks: (1) **store selection**
  — default store preselected, "add a store by URL" accepted and persisted (the
  OSHAL_STORE_TOKEN private-store mechanics reused, never a new auth path); (2) **app pick +
  install** — chosen packages download and register through the existing loader (POST
  /api/swarm/apps/load rails), with per-app progress and a failure that names the app instead of
  wedging the wizard; (3) **users** — the ADR-117 invite screen inline (email + role, copyable
  links); (4) **defaults** — backup schedule ON by default with a generated key/destination
  prompt, and the MUST-CHANGE secrets surfaced with a "minted for you" default rather than a
  blank; (5) skipping any step leaves a working box and the wizard is re-enterable; (6) an ADR
  records the design (store trust model for third-party URLs is the hard decision — a malicious
  store URL must not get code execution just by being typed) and a red-provable guard covers the
  gate: an anonymous visitor can never reach the wizard's install actions.

## Joke-shorts pump — deferred work (ADR-120)

The pump is live and producing (six shows, 1/day each). Three things it deliberately does NOT do:

- **Nothing is published anywhere.** Episodes land in the node's content folder and the owner's
  Drive, and stop there. Publishing to YouTube/Shorts is a separate decision with its own consent
  question — per the operator's standing rule, outward-acting automation is explicit opt-in, so this
  needs a per-destination switch, not a flag on the pump.
  *Done when:* an operator can enable a destination per show, a dry-run shows exactly what would be
  posted, and nothing posts without that switch being on.

- **The tuning loop only reads outcomes, not the video.** `video_pump_runs` records what happened
  (delivered / failed / skipped and why) and auto-pauses a show after three consecutive failures, but
  nothing watches a delivered episode back. The failure modes that matter most — a joke that does not
  land, four scenes that drifted apart, dialogue that came out garbled — are invisible to it.
  *Done when:* a delivered episode is scored on at least the mechanical checks the hand-run era used
  (duration, silence stretches, per-scene frame distinctness) and a failing score pauses the show the
  same way three failures do.

- **The recap does not take the node lease.** The pump takes a lease before it renders, and detects
  the recap by its own markers (`out/build.pid`, `out/build.log`) plus a blackout window. That works,
  but it is inference: if the recap runner changes its markers the gate goes blind to it and only the
  clock protects the collision.
  *Done when:* `run-daily-recap.ps1` acquires and releases the same `<data>\node.lock` the pump uses,
  and the pump's `recap-running` probe becomes a backstop rather than the primary signal.

- **`pumpkin` ships a persona for a bot it never declares.** `personas/pumpkin-bot.yaml` drives a
  **real** inline bot (`a0000000-0000-0000-0000-000000000054`, used by `routes/pumpkin-routes.js`)
  that no `bots:` block declares — so `swarm_applications.agent_ids` stays empty, Jarvis has never
  been able to discover it, and its reasoning has no accountable `agentId` under ADR-036. Same
  defect intelligent-sales had. Out of scope for a core + intelligent-sales install, so recorded
  rather than fixed.
  *Done when:* pumpkin declares its bot in `bots:` with a selector descriptor, and Jarvis can reach it.

- **The orphaned-persona gate needs an opt-out before it can land.** A draft loader check that
  refuses a persona no `bots[]` entry claims would have caught the intelligent-sales bug at load —
  but it also rejects `daily-trade-recap`, which is CORRECT: that manifest deliberately ships a
  `COPY of the vids-operator persona for the registrar` while the actual bot is the shared
  `packages/oshal-vids-operator` desktop worker registered elsewhere. A persona copy for an
  externally-registered bot is a legitimate shape and the check has no way to see it.
  *Done when:* the manifest can declare the shape explicitly (e.g. `externalPersonas: [...]`, or the
  registrar copy is referenced from a field the check reads), `daily-trade-recap` and every other
  package with a `personas/` directory loads unchanged, and a spec pins BOTH the refusal of an
  undeclared bot and the acceptance of a declared external copy.

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


## Payroll app (ADR-123) — deliberately deferred, with the reason ⬜ (2026-08-01)

Payroll v1.1 shipped as a store package. Everything below was *chosen* not to build, not missed —
each entry says why, so it is not silently re-litigated. Nothing here is required for the shipped
scope to be correct; each is a coverage or product gap.

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

10. **Money movement and filings.** No ACH/direct deposit, no tax deposits, no 941/940/W-2 filing.
    **Deferred because** these are regulated activities better reached through a provider connector
    (a Gusto connector already exists in the catalog) than reimplemented. **Done when:** a connector
    performs the deposit/filing and the app records the confirmation — never when this app files.


## HUMAN: migrate platform SaaS accounts to real ECSG accounts (operator-led; record it) ⬜ PAUSED BY DESIGN

- **Context (operator, 2026-08-01):** the platform's SaaS accounts were opened personally while
  the business was still being established. The business is now established. Everything current
  stays AS-IS for beta/demo — deliberately frozen: **no upgrades, no paid tiers, no
  double-dipping** (e.g. Twilio A2P registration is deliberately NOT being done on the demo
  trial account — it happens once, on the ECSG account).
- **The move, when unpaused:** re-create each account under ECSG ownership
  (`maintainer@emeraldcoastsystemsgroup.com`, [partner-app-registration Rule 0](partner-app-registration.md)),
  re-mint keys, re-link the swarm (`.env` + connector re-consents), and **record the re-linking
  end-to-end for YouTube** — the "stand up a swarm's integrations from scratch" video is part of
  the deliverable, not an afterthought.
- **Known inventory (verify + complete at execution):** Twilio (trial), Plaid (sandbox), GCP
  project `tactical-gate-256211` (Vertex/Veo SA + Google APIs — at execution this supersedes the
  earlier deliberate "GCP stays on the personal gmail" exception), Telegram bot (@The_oshal_bot),
  Google OAuth clients (login + connector), Cloudflare (zones / tunnel / Pages), DigitalOcean,
  model-provider keys (OpenRouter, Groq, Mistral, Cerebras), and the connector apps
  (Dropbox / Spotify / SmartThings / Meta / LinkedIn / X — most already registered under the
  business email; verify each). **Out of scope:** personal brokerage/trading accounts
  (Schwab, Alpaca) — those are the operator's own by nature.
- **Done when:** every platform SaaS credential in `.env` / config-seed traces to an ECSG-owned
  account; the old personal accounts are drained and closed or explicitly designated demo-only;
  the re-linking session is recorded and published; and Twilio A2P registration is completed on
  the ECSG account (which unblocks the SMS leg above).
