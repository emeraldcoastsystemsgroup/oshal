# OSHAL Backlog

This file contains only unfinished or externally blocked outcomes. Completion history belongs in the relevant ADR, runbook, package README, release note, or evidence record; when an item closes, remove it from this queue.

Framework, kernel, shared-service, security-boundary, and orchestration work belongs in this repository. Application-owned work belongs in [`oshal-applications`](https://github.com/emeraldcoastsystemsgroup/oshal-applications); core entries below retain only a framework dependency or a concise pointer to the owning package.

Every item has an observable **Done when**. Live-proof requirements cannot be closed from unit results alone.

## Promotion, deployment, and regression proof

### Production core-deploy pipeline + version strategy (operator, 2026-09-05)
- **Remaining:** deploying core to the customer production box (the gsquared CRM landscape) is a
  proven but fully MANUAL procedure: merge to main, then on-box `git reset --hard <sha>` of the
  release dir, an on-box `docker build` tagged `oshal-bot:sha-<sha>`, repoint `OSHAL_BOT_IMAGE`
  in the root-owned env file, and `managed-postgres-compose.sh up` through the fail-closed
  migration/RLS gate. Version identity today is the commit SHA on the image tag + label + the
  release-dir checkout + per-run bootstrap evidence logs - honest, but there is no release
  numbering for core, no image registry (every box builds its own bytes), no staging-to-production
  promotion of a BUILT artifact, and rollback is a manual tag repoint. The 2026-09-05 launcher-gate
  failure (migration 124 on a trading-less box) and the merged-but-never-deployed #164 both belong
  to this gap: nothing tracks "what is main ahead of production" or promotes one tested artifact.
- **Done when:** core has a named release identity (tag or channel) that a production box can be
  AT, shown by a version endpoint/cockpit footer; the deploy promotes the SAME image artifact that
  staging validated (registry pull or verified digest transfer - never a second on-box build of
  different bytes); the procedure is one documented command with automatic pre-deploy DB/rollback
  capture and a one-command rollback to the prior pinned image; a drift check reports release-dir
  sha vs running image vs main; and the gsquared runbook (SETTING-UP-A-CUSTOMER / OPERATIONS)
  replaces the manual step list with the pipeline. Store packages keep their own existing rail
  (manifest `version:` + deploy.js parity) - this entry is the CORE artifact path.

### ADR-134 multi-account books — the pre-second-live-book observability pair
- **Remaining:** the watchdog still greps hand-known schedule ids (`trading-watchdog.ps1`) and the three raw-pool host report scripts (`site-oshal-report.js`, `oshal-deck-data.js`, `oshal-report-journal.js`) render per-mode, not per-book. Safe today (one live book; `book_ref` is denormalized onto daily-equity/journal rows so legacy reads stay truthful), but a SECOND enabled live book must not run unattended behind a watchdog that can't see its beat or a report that merges its curve into another account's.
- **Done when:** the watchdog derives the expected live schedule set FROM `oshal_trading_books` (never a hand list) and alerts per missing enabled-book beat; the three report scripts print a per-book breakdown + sum (proven by a real-DB run of their SQL as the enforcing role); both land BEFORE a second live book is enabled, enforced by a check in `scripts/trading-books-cutover.sh`.

### ADR-134 PR4 hardening tail
- **Remaining:** after the cutover has run and a full week is clean: `book_id NOT NULL` + legacy mode unique-index and fill-trigger drops on orders/signals/decisions, the config-overrides book-less-active CHECK, and `SCHWAB_ACCOUNT_NUMBER` retirement from compose/`.env.example` (with README/ROADMAP/counts reconciliation in the same change).
- **Done when:** the cutover spec's legacy-shaped book-less INSERT is REJECTED on the live schema, `git grep SCHWAB_ACCOUNT_NUMBER` hits only the ADR/runbook history, and a deploy marker refuses `oshal-deploy.sh` auto-rollback past the PR1 image boundary.

### trading-schedule-dispatch.ts decomposition
- **Remaining:** 882 code lines — past the 800-line decomposition threshold it already exceeded before ADR-134 (827 on 2026-08-14). The book threading added ~55 lines to an already-oversized module.
- **Done when:** the file is split along its own section seams (exits/rotation/entries/pop-catcher vs the schedule entry + run loop) with zero behavior change, each new module under 500 code lines, and the existing dispatch-touching specs green without edits.

### Codeless k8s install — first live-cluster proof (ADR-129)
- **Remaining:** run `oshal-install.sh --mode 4` (or `-Kubernetes`) end-to-end on a real second machine — the dev laptop is excluded on purpose (Docker Desktop k8s beside the 44-container swarm is the documented OOM pairing). Then publish the OCI chart (`bash scripts/publish-chart.sh` + the one-time GHCR visibility flip) so the installer's OCI-first path goes live.
- **Done when:** a fresh box reaches `/welcome` in a browser via the NodePort with only kubectl+helm+the installer present, a model connects through the wizard and a jarvis turn answers, and `helm show chart oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal` succeeds anonymously.

### k8s shared-service tier — live proof of the features it restores (ADR-129 amendment)
- **Remaining:** chart 0.3.0 templates the whole tier (tsdb, arangodb, vault, code-server, diarization; ollama opt-in) and stages store packages via an api initContainer, but only template-level proof exists (lint, render matrix, `kubectl apply --dry-run`, a mutation-tested guard). Nothing has run against a live cluster.
- **Done when:** on a real cluster — a staged store package serves its surface and survives an api pod restart; a trading query returns series from the in-cluster tsdb; `/api/graph` answers instead of 503; a transcription round-trips through the diarization Service; and `helm upgrade --set infra.arangodb.inCluster=false` degrades the graph cleanly (null connector, no connection-refused) rather than erroring.

### Cockpit bot enable/disable toggle is compose-only
- **Remaining:** `agent-status-routes` constructs `DynamicComposeService` + `BotContainerSpawnerService` directly, so toggling a bot's status in the cockpit shells `docker compose` — inert inside a pod. The create-and-start path now routes through the substrate-agnostic `BotRuntimeLauncher` (ADR-129 amendment 2); the toggle does not.
- **Done when:** the status toggle resolves the same launcher (scaling the Deployment to 0/1 on k8s, compose start/stop otherwise), with a guard proving a disabled bot stops receiving dispatch on both substrates.

### k8s durability posture for the shared-service tier
- **Remaining:** every in-cluster service is single-replica with dev-parity credentials and no backup/restore path; Vault runs `-dev` (in-memory, lost on restart) by design. Acceptable for a single-box swarm, not for a shared tenant.
- **Done when:** the tenant profile documents (or templates) managed Postgres/Timescale, a real Vault target, and a backup story for the workspace + Chroma volumes — or each is explicitly declared out of scope for the single-box product with the boundary named in the chart README.

### Rides map and fare follow-ups
- **Remaining:** install the merged [`rides`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/rides) package; decide optional OSRM/Valhalla and Google Maps billing paths; make geocode/tile configuration operator-owned and the normalized-address cache durable.
- **Done when:** the live package serves vendored Leaflet and reports `provider: "osm"`; keyless routing is either backed by `OSHAL_ROUTING_URL` or explicitly accepted as straight-line-plus-factor; any Google browser key is referrer-restricted; restarts do not repeat cached geocodes.

### Guest Jarvis turn and public demo card
- **Remaining:** promote merged guest-write support from a quiet, current `main`, then restore only the OSHAL Assistant guest card after production verification.
- **Done when:** deploy parity is green, the running container contains `guestSpendsModel`, a real guest can start a session, create a task, and post a message with a 200 response, and the restored public card passes the same anonymous flow.

### Alert-triage A1/A2 containment drill
- **Remaining:** deploy the current alert-triage implementation and exercise A1 approval, A2 autonomous containment, refusal, and rollback against the live ticket path.
- **Done when:** one dated drill records correct transitions and audit fields for all four legs, with no restart, privilege widening, or unapproved mutation. See [ADR-119](adr/119-autonomous-health-ticket-processing.md).

### Strategy Studio and Bot Forge conversational parity
- **Remaining:** run a real Studio design/refine/apply/revert cycle; add edit-in-place for an existing Forge pack only if that follow-up is commissioned.
- **Done when:** two refinements update one strategy row through a live LLM session and the applied strategy reverts cleanly; if Forge edit-in-place is commissioned, it re-emits the same pack rather than a duplicate.

### Nightly tasks still launched from the ADR-115 archive
- **Remaining:** make keepalive, recap, and signal launchers self-locating, repoint their actual Task Scheduler actions to this trunk, and explicitly retain or relocate the private Evidence-Nightly job. (Kalshi done 2026-09-04: `kalshi-forward-daily.cmd` cd's to `%~dp0..`, the task action names `C:\Projects\oshal`, and it test-ran from there with exit 0. Still on the archive path: JobHunterSwarmSync, OSHAL Claude token keepalive, OSHAL Signal Labeler, OSHAL-Evidence-Nightly.)
- **Done when:** each movable task test-runs from `C:\Projects\oshal`, its scheduler action names that path, and Evidence-Nightly is documented at an intentional private location. See [ADR-115](adr/115-clean-trunk-branch-strategy.md).

### Scheduled Local CI unattended proof
- **Remaining:** inspect an unprompted 23:30 scheduler run; do not substitute a manual launch.
- **Done when:** its log names `archive-ref=origin/main`, records the exact fetched SHA, and Task Scheduler's result equals the completed gate's exit code. See [ADR-090](adr/090-github-actions-to-local-ci.md).

### CI Playwright red-baseline retirement
- **Remaining:** root-cause the specs outside the current green ratchet and separate product defects, fixture/auth defects, and intentionally unsupported cases.
- **Done when:** every spec uses the configured origin, each unsupported case has an explicit disposition, and the complete CI Playwright job is green without retry-dependent success.

### Dev-console `/work` under Linux user-namespace remapping
- **Remaining:** make the ADR-077 sandbox scratch mount writable to remapped container users without widening host access beyond the per-run directory.
- **Done when:** a GitHub-Actions-equivalent userns-remap container writes inside `/work`, cannot escape it, and the focused sandbox/security guards pass. See [ADR-077](adr/077-self-developing-platform-and-super-admin-dev-console.md).

### Remote-client full-suite flake
- **Remaining:** test the module-level registry and rate-limiter state leads in the auth spec; isolate file state or serialize only the affected specs if needed.
- **Done when:** the full unit suite passes 20 consecutive runs with no remote-client timeout; any serialization is local and documented, not a global concurrency reduction.

### Tree-walk guard stability
- **Remaining:** the timeout half is done — `topology-traversal` and `alert-incident-reopen` now carry explicit 45s describe budgets (2026-08-06), and the suite went from 4 failed assertions to **0 failed / 6263 passed**. What is left is contention, not time: three specs still fail at FILE level intermittently, and a different one each run. `alert-incident-cutover`, `alert-incident-reopen` and `topology-traversal` drive the same live Postgres while 650 other files run in parallel, so they collide on connections and revisions (`revision contention unresolved after 2 attempts`). All three pass in isolation. The fix is structural — live-database specs need their own serial project/pool rather than sitting in the parallel `tests/unit/**` sweep — and deliberately is NOT a retry count, which would mask a real regression in exactly the incident path these guards protect.
- **Done when:** `npm run test:unit` is green three consecutive times, file-level included, with repository-separation and no-dev-secret-fallback enabled and no global timeout increase — and the live-DB specs are provably serialized rather than passing by luck of scheduling.

### CI secret-scanner remote mutation proof
- **Remaining:** use a disposable branch to plant the scanner's sanctioned test secret, observe the remote failure, remove it, and rerun.
- **Done when:** linked CI evidence shows fail-then-pass caused by that fixture and no real credential enters Git history.

### Build-phase escalation golden run
- **Remaining:** execute the current escalation workflow through its real provider/tool boundary from a clean fixture and retain its trace and artifacts.
- **Done when:** one repeatable live run exercises every escalation phase without manual state repair and records caller identity, tool results, cost, and terminal outcome.

### Inline-bot deployed identity smoke
- **Remaining:** run the inline path once as a restricted user and once as an operator, recording identity at the authorization boundary.
- **Done when:** the restricted caller never inherits service/operator privilege, the operator succeeds, and the live trace matches the identity guards.

### Registry installer fresh-machine trial
- **Remaining:** exercise the codebase-free GHCR installer on a clean Docker-only machine with enough memory for the batched bring-up.
- **Done when:** `oshal-install.sh` reaches a signed-in cockpit, required services heartbeat, and one ticket round-trips without a source checkout; expected missing developer-only assets are documented.

### Installer runtime-proof gaps
- **Remaining:** run the source-complete CORE-05 verifier against the exact release candidate: execute every active package's manifest-declared smoke, inspect the no-AI state in each surface class, and run the opt-in PAT-backed live generation/cost probe. Brand Graphics and YouTube Kids remain inactive and must be activated deliberately before their otherwise-valid smokes can run; Pumpkin remains outside the current 46-package rollout until its unrelated work is reconciled.
- **Done when:** the installed candidate fails a deliberately broken package by name, every surface class renders an honest `OSHAL_NO_AI=true` state, and `oshal-verify.sh --live` performs exactly one non-stub generation with owner-scoped cost attribution. Source and fixture results alone are not release evidence.

### Public prebuilt-image fast path
- **Remaining:** at launch, publish versioned images, make the installer pull them by default with a local-build fallback, and reduce the image where practical.
- **Done when:** a clean machine reaches a working cockpit without compiling locally and the documented timing includes the actual image download. This is distinct from the private-registry trial above.

### Docker Desktop port-forward wedge
- **Remaining:** identify an upstream Docker Desktop fix or a supported host-network/reverse-proxy workaround for the Windows localhost forwarding failure.
- **Done when:** the documented recovery or supported topology survives repeated API/container restarts without the host port becoming unreachable while the container remains healthy.

### Dev-box disk reclamation
- **Remaining:** inspect then drop the confirmed orphan restore database and extend the scoped cleanup path for reclaimable OSHAL images/volumes; never use a bare global Docker prune.
- **Done when:** exact pre/post disk figures are recorded, the intended orphan only is removed, and all active swarm volumes and databases pass health checks afterward.

### Real-boundary regression doctrine
- **Remaining:** run the existing migration-117 disposable-PostgreSQL proof through the protected promotion job and retain its result. The corrected provenance ledger, connection-scoped broker, two-owner/operator fixture, and real-Pool live spec are implemented locally, but an unexecuted live spec is not RLS evidence.
- **Done when:** the durable-memory ledger has the same real-boundary evidence already recorded for ticket/store gateways, aliased module resolution, and built-image artifacts, and the audit contains no unresolved local boundary.

### Legacy product-name archival disposition
- **Remaining:** classify old names under `docs/archive`, top-level `archive`, and release collateral as intentionally historical or rewrite them; regenerate current evidence still using retired names.
- **Done when:** current docs/evidence use sanctioned naming and every retained legacy occurrence is clearly marked historical.

### Nightly gate has a twelve-night failure streak
- **Remaining:** the scheduled task `OSHAL Local CI` (daily 23:30, `ci-local-hidden.vbs` → `ci-local.sh --scheduled`) runs unattended, propagates its exit code, and emails the operator — all of that works. It has simply reported FAILED every night from 2026-08-02 to 2026-08-13 with `unit`, `e2e-green` and `trivy` red each time (BUG-22), so a newly-red guard inside it is invisible. Drive each of the three to green or quarantine it with a dated entry naming what is deferred and why: `unit` (BUG-15/16/17 plus the DB-backed specs — read BUG-16 before running the suite against a live stack), `e2e-green`, `trivy` (a CVE-budget decision, not a code fix). **Do not "fix" this by adding a `push:`/`pull_request:` trigger** — manual-only hosted CI is deliberate and `scripts/check-workflow-triggers.js` enforces it.
- **Done when:** `%LOCALAPPDATA%\oshal\ci-local.log` records at least one PASSED nightly run, every gate still red has a dated BACKLOG entry, and the notifier reports the streak and which gates are *newly* red rather than sending an identical failure mail each night.

### Add-a-bot checklist omits the scrape target
- **Remaining:** ~~add the scrape step to the checklist~~ — **superseded 2026-08-13.** Prometheus now discovers bots by container label (BUG-15 closed), so there is no scrape step to document and nothing for a checklist to omit. What remains is smaller: `docs/building-a-bot.md` and CLAUDE.md's bot-registry section should say that monitoring is INHERITED from the `x-bot-common` anchor, so nobody re-adds a manual step or wonders where to register a new bot.
- **Done when:** both surfaces state that a bot inheriting `x-bot-common` is scraped automatically, and neither instructs anyone to edit `ops/monitoring/prometheus.yml`.

### DB-backed alert specs borrow the operator's database
- **Remaining:** `tests/unit/alert-incident-cutover.spec.ts` stands a live alert *consumer* on the
  operator's production queue and `tests/unit/alert-incident-reopen.spec.ts` leaks incident rows into
  it (BUG-16: all 26 `oshal_incident` rows are spec residue; 24 from the reopen spec). Give each spec
  its own scratch database or schema with migrations 104-108 applied, or construct the receiver with
  no sweep. Fix the `afterAll` hang at `alert-incident-cutover.spec.ts:119` in the same pass, and
  delete the residue.
- **Done when:** both specs pass with the stack up and with it down (loudly, per doctrine) without
  writing a row visible to the running deployment, `oshal_incident` holds no `probe-target`/`cut-`
  rows, and a `ci-local.sh` post-gate fails if synthetic residue reappears.

### Surface-bridge ops have no success-path log line
- **Remaining:** `src/app/routes/jarvis-routes.ts` logs when surface ops are **dropped** for lack of
  screen context but logs nothing when they are successfully extracted and returned, so a delivered
  op that the surface then ignores leaves no server-side trace. Proving BUG-18 required reading the
  raw pre-strip reply out of a bot container log, because both the clean answer and the persisted turn
  have the fence already removed.
- **Done when:** an emitted-ops turn logs op count + names + the target app at INFO, and the BUG-18
  failure shape (a `custom` op whose name no surface handles) is diagnosable from the api log alone.

### Hugging Face lane — first real completion through the router
- **Remaining:** PR #288 registered Hugging Face Inference Providers as a free-tier, operator-key, and
  Token Chase lane (`router.huggingface.co/v1`, every candidate `:cheapest`, last in the operator
  order) and it is deployed (2f9b6dd1, 2026-09-04). No HF token exists on the operator box, so the
  only proof is `tests/unit/huggingface-lane.spec.ts` with the vendor probe doubled (see the
  real-boundary audit row). The candidate ids were live-listed on `GET /v1/models` on 2026-09-04 and
  will rot like every other lane's; HF's free monthly credit is $0.10 ($2 on PRO), so a walled
  account answers 402, which the rotation already treats as "cool it and move on".
- **Done when:** with `HF_TOKEN` in `.env` and the api recreated, `scripts/evidence/prove-free-tier-live.ts`
  reports the `huggingface` lane UP with a real completion (dated in the deploy record); a token
  pasted on `/free-models` connects and `GET /api/connect/free-tier/rotation` shows the lane
  eligible; and the lane's row in `docs/governance/real-boundary-regression-audit.md` cites that
  dated evidence instead of "pending an operator token".

## Security, tenancy, and trust boundaries

### The SEC/CORE/APP hardening-track identifiers have no definition anywhere in the repo
- **Remaining:** the overnight hardening campaign reported progress against a status matrix keyed `SEC-01…SEC-06`, `CORE-01…CORE-07`, `APP-01…APP-04`, but the scheme is undefined: no doc states what a track ID means, what closes one, or who owns it. Verified 2026-08-06 against `main` — only **five** of the seventeen (`SEC-01`, `SEC-05`, `SEC-06`, `CORE-05`, `APP-02`) appear anywhere in `docs/`, and each is *cited in passing* rather than defined; the other twelve appear in no file and in no commit in this repo's history. A status report keyed to identifiers nobody can resolve cannot be audited, and "SEC-03 Partial" is indistinguishable from a typo. Either define the scheme in one indexed doc — ID, scope, done-when, evidence location, owner — or retire it and let the campaign report against the BACKLOG entries and ADRs that already carry those criteria.
- **Done when:** every track ID that appears in any status report resolves to one indexed definition with a done-when and an evidence pointer, and a gate fails on an ID cited in a report but absent from the index — or the scheme is removed and no surface references it. Do not back-fill definitions by inferring intent from a matrix cell; an invented definition is worse than an undefined one.

### Web-control enforcement rollout
- **Remaining:** promote the exact-byte Alertmanager parser/HMAC guard and corrected posture API; collect and classify the default report-only CSP stream, externalize or nonce remaining inline scripts, canary `OSHAL_STRICT_CSP=on`, tune/enable `OSHAL_RATE_LIMIT_INTERNAL` and `OSHAL_RATE_LIMIT_EXPENSIVE`, and provision a distinct `ALERT_WEBHOOK_HMAC_SECRET` on both receiver and sender.
- **Done when:** a seven-day browser canary has no unexplained CSP violations, enforcement blocks a sanctioned inline-injection fixture without breaking supported surfaces, direct-origin and Jarvis/intake burst probes receive the intended 429s without throttling normal swarm traffic, and exact-body Alertmanager delivery passes while missing/tampered signatures fail before landing a row.

### Fine-grained RBAC and verifiable audit export
- **Remaining:** map production IdP claims/operator allowlists, run restricted/operator/admin route probes, enable `OSHAL_RBAC_ENFORCE`, and add a signed or hash-chained export artifact plus retention and independent verification guidance to the existing JSON/CSV audit endpoints.
- **Done when:** the three deployed roles have least-privilege evidence across every RBAC-gated route, a non-admin cannot export another caller's trail, an authorized export verifies offline against an operator-controlled key/hash chain, and tampering or truncation is detected.

### Connector-token KEK and DEK-fallback hardening
- **Remaining:** promote the completed local `hkdf1:`/`k2:` migration with mixed legacy/v2/current live-database fixtures; add operator rotation/recovery tooling; move production master-key custody from `SESSION_SECRET` to a KMS/HSM-backed, key-id-aware rail; and exercise the explicit `shared-hkdf` incident break-glass against real connector refreshes before immediately returning to deny mode.
- **Done when:** a live migration proves owner isolation across legacy/v2/current rows, key rotation and recovery do not strand users, all supported providers refresh through the shared codec, the default forced DEK-store failure denies without a write, the explicit break-glass is observable and reversible, and production can revoke a KEK generation without retaining an application-readable master secret indefinitely.

### ADR-087 access-role deferred layers
- **Remaining:** add per-user Jarvis visibility overrides, sandbox enforcement for restricted tools, manifest declarations, and the small cleanup items listed in [ADR-087](adr/087-access-roles-jarvis-visibility-scoping.md).
- **Done when:** user-specific hide/show cannot affect another user, scoped tools remain denied at execution as well as discovery, unknown manifest roles fail load, and role behavior is covered end to end.

### Two-tier tenant provisioning
- **Remaining:** implement manifest-selected isolated-database and shared-database provisioning; the shared tier first needs a tenant-scoped service identity rather than the current operator-equivalent system context.
- **Done when:** `provision-tenant.sh <name> --tenancy=isolated|shared` renders the correct namespace/database policy and a two-tenant proof blocks cross-tenant database and row access. See [ADR-035](adr/035-multi-tenant-saas-foundation.md) and [ADR-076](adr/076-tenant-aware-rls-and-least-privilege-db-role.md).

### Production Vault hardening
- **Remaining:** replace the local dev root-token server with persistent storage, TLS, unseal/recovery operations, AppRole/OIDC, backup, and documented rotation.
- **Done when:** a non-local deployment runs without a root token in application config, survives restart/unseal, and completes authenticated issue/use/revoke with audit evidence. See [ADR-040](adr/040-devops-vault-swarm.md).

### Vault cloud secrets engines
- **Remaining:** configure one real AWS STS or Kubernetes secrets engine with operator-owned credentials and a least-privilege role.
- **Done when:** the role issues a short-TTL credential, a real read succeeds, revocation makes reuse fail, and no standing cloud key is stored by a bot.

### Multi-user ephemeral privileged runtime
- **Remaining:** security-review and build a per-task, short-lived privileged runtime with tmpfs credentials, caller scoping, revocation, and residue inspection.
- **Done when:** two-user adversarial tests prevent cross-user credential/process access, a real privileged task uses only a brokered short-TTL credential, and teardown leaves no reusable secret. See [ADR-040](adr/040-devops-vault-swarm.md).

### App access tiers Phase 2
- **Remaining:** promote the implemented Phase 2 through a protected branch, apply migration 121, observe `OSHAL_APP_ACCESS_MODE=shadow`, seed explicit assignments, and canary `enforce` against the exact deployed SHA. The ten kernel manifests are declared; the historical intelligent-sales package is absent from both repositories and must be recovered rather than fabricated.
- **Done when:** deployed deny returns 403 on every method, viewer writes fail, editor/admin defer to package capabilities, unknown tiers fail load, the operator matrix persists assignments through the forced-RLS store, and the canary records no unexplained shadow/enforce drift. See [ADR-118](adr/118-app-access-tiers.md).

### Kernel-versus-app bot boundary
- **Remaining:** promote the implemented agent-ID kernel registry and bot-role posture, apply migration 099, rotate the shared-box `oshal_bot` password, run the deployed two-user bot-DSN RLS probe, and operationalize `OSHAL_OPERATOR_SUBS` denial review.
- **Done when:** kernel boot cannot dispatch to an unregistered app agent, a real bot DSN has neither superuser nor RLS-bypass, two-user RLS passes, and legitimate operator/queue paths remain allowed.

### Inline controller bot isolation
- **Remaining:** move Codex-harness inline bots out of the controller, remove unnecessary `DATABASE_URL` inheritance, and attack each deployed harness for controller and cross-user secrets.
- **Done when:** no controller-resident bot can read platform credentials or another user's tokens, and all required work runs through a dedicated least-privilege runtime.

### One bot-invocation chokepoint — the INLINE half of /api/send-message (+ the missing ADR)
- **Landed (2026-08-12, #186):** the NODE half is done — `handleSendMessage` routes any bot with a dedicated node endpoint through `executeBotOrInline` (budget gate + ADR-090 skills + the ADR-127 remote-brain stamp), with controller-side thread persistence so `GET /api/:taskId/messages` replays node threads. Live-verified: a career chat turn dispatches to `career-bot` and answers on the mounted CLI (`provider: claude-code`, `providerConfigAction: match`, cost event under cb…0001). ADR-093 Tier-2 mechanics were decided as a `profiles:`-gated first-party compose service (`career-bot`, profile `career-node`) + `bots[].container/port` in the manifest — no cross-file fragment, no anchor copying.
- **Remaining:** INLINE bots' send-message turns still call `ctx.orchestrator.processMessage` directly (budget gate, skills, credential refusals still bypassed for them); node-off dispatch is fail-visible by design (manifest comment) — if a degrade-to-hosted posture is ever wanted it needs an explicit decision; write the "bot invocation — one chokepoint" ADR, enumerating as migration debt the ~11 store packages calling `processMessage` directly (dnd, spotify, travel, purchasing, movies, aero-lab, camera, drone, sat-ops, game-show, bake-off engines) and `swarm-control.js`'s browser→bot direct POST.
- **Done when:** a cockpit chat turn to any bot (inline included) passes the budget gate and credential refusals (guard proves a HARD-cap breach blocks it), the ADR is in the index, and the Tier-C call-site list is tracked with owners.

### Inline chat spend is invisible to windowed budget enforcement
- **Remaining:** `BudgetService` reads `oshal_cost_events`, but no inline chat path writes it — only bot-node/A2A/Argo/vision paths call `recordCost`. Inline orchestrator turns land usage in `chat_tasks` only, so the HARD per-user cap at the executeBotOrInline chokepoint can never see spend that chokepoint's own inline branch generates (nor any cockpit chat turn). Related unit mismatch: the BYO hosted lane records $0 cost by design (tokens only), and a CLI turn's cost is a price-equivalent, not a bill (ADR-127).
- **Done when:** an inline chat turn produces an `oshal_cost_events` row under the owner sub (or an ADR explicitly scopes budget enforcement to node work), a guard proves windowed spend moves after an inline turn, and cost surfaces label the price-equivalent/BYO units distinctly.

### Seeding-repair hygiene tail (2026-08-12)
- **Remaining:** (1) rotate whatever `config-seed/claude-credentials.json` holds, then delete it — 25 KB of credential material, world-readable perms, zero consumers since the SEC-05 closure ("never revive a static config-seed token copy"); (2) mirror the eight `requiresOwnNode` entries that exist only in `swarm-bot-registry-local.ts` into the canonical registry (finance-analyst, identity-advisor, social-writer, storage-assistant, deck-builder, trading-analyst, communications-bot, weather-bot — "register in BOTH"); (3) point `WORLD_CLASSIFY_PROVIDERS` at a hosted provider so world classify stops degrading to lexicon-only (its 27 controller CLI refusals per 2h are BY DESIGN — never weaken `assertAuditedAutonomousHarness`).
- **Done when:** the credential file is rotated + gone from the tree and the bind mount, both registries agree on `requiresOwnNode` membership (guarded), and world-classify batch runs complete on a hosted lane with entity/event output in the world store.

### Bot-endpoint delegated identity
- **Remaining:** promote migration 119 and the implemented hash-only workload credential, signed HTTP delegation, exact route/body/scope binding, and one-time durable replay denial. Extend that authority through the still-unowned agent-tool grants and dynamic ribbon definitions with exact tool/version binding and durable ASK consume/recheck; in enforce mode a fleet/service secret may authenticate transport but must never assert or upgrade the initiating principal.
- **Done when:** a two-owner real-boundary route/database proof shows the exact owner can approve and consume one matching request once, while fleet-secret-only, cross-owner, wrong-agent/tool/task/version/digest, replayed, expired, and revoked attempts fail before ticket/model/tool execution or ribbon mutation. The audit record contains the full delegation tuple, and the deployed restricted-user Jarvis path remains denied while an entitled path succeeds without inheriting operator authority.

### Reviewed non-NONE tool provisioning and attestation
- **Remaining:** add an immutable code-owned installer/verifier or signed out-of-band attestation rail for tools whose `executionMethod` is not `none`. Catalog and runtime-registration payloads may select a reviewed recipe/artifact but must never persist or supply a shell command; record artifact version, cryptographic digest, provenance, verifier identity, and revocation state, and require that current attestation at invocation.
- **Done when:** a clean deployment provisions and enables one representative binary/package tool without a persisted shell, forged catalog commands/paths/digests never execute, the audit names the installed version/hash/provenance, revocation blocks the next invocation, and mutation guards fail if any execution-time attestation check is removed.

### Versioned platform-credential distribution if redistribution returns
- **Remaining:** keep the retired unordered credential pub/sub rail disabled. If platform credentials must again cross node-local storage boundaries, replace it with signed, audience-bound, monotonically versioned promotion/refresh events plus durable revocation tombstones and compare-and-set replay; a later operator allowlist change must not promote an earlier private-user credential.
- **Done when:** a two-node restart/offline proof covers promote, refresh, revoke, duplicate, delayed, and out-of-order delivery; no pre-revocation event can resurrect a credential, a returning node converges to the tombstone, private credentials remain private across allowlist transitions, and neither payloads nor logs expose reusable secret material.

### Biometric privileged-access module
- **Remaining:** if commissioned, define pluggable face/voice enrollment and challenge providers whose signed result can satisfy a high-privilege endpoint condition, with a non-biometric fallback.
- **Done when:** an enrolled user can unlock one protected bot/app, replay and cross-user challenges fail, and devices without camera/mic have a documented safe path.

### Platform SaaS account migration (paused by operator)
- **Remaining:** when unpaused, recreate platform-owned services under `maintainer@emeraldcoastsystemsgroup.com`, re-mint/re-consent credentials, and record the YouTube relinking flow; personal brokerage accounts remain out of scope.
- **Done when:** every platform credential traces to an ECSG-owned or explicitly demo-only account, old accounts are drained/closed as appropriate, the relinking video is published, and Twilio A2P is completed on the ECSG account.

## Workflow, agent, and model runtime

### Jarvis must fail honestly when the operator has no hosted brain
- **Remaining:** when `resolveUserLlmConnection` returns nothing and the bot's configured harness is an unbrokered CLI, the surface shows "Sorry, that didn't work" and the log shows a CLI-refusal — neither tells the operator the actual problem or the fix. Root-caused 2026-08-09: the operator's `any-llm` BYO row had disappeared, the operator is (by design) exempt from free-tier fallback, and SEC-05 preflight (correctly) refuses every CLI harness at bot nodes — so Jarvis had no admissible brain and said so in jargon. Restored by re-saving the BYO connection (gemini-2.5-flash over the existing `GEMINI_API_KEY`). Same honesty doctrine as the PR #54 voice fix.
- **Done when:** that state produces a user-facing "Jarvis has no AI engine connected — add one under Settings → BYO LLM" (surface and TTS), a guard proves the message appears when resolution is empty and the harness is unbrokered, and the briefing shelf (which needs no live model) still renders instead of being dragged down with the ask path.

### Jarvis briefing preferences (operator ask, 2026-08-09)
- **Remaining:** the Kalshi playable-hand briefing is loved, but it is the only proactive update Jarvis gives and there is no control surface. Operator asked for: a config screen listing every briefing-capable bot with per-bot on/off, an update frequency, and a delivery-channel choice per briefing — voice, bubble, or main-Jarvis-screen-only.
- **Done when:** a Jarvis settings surface lists briefing sources discovered from registered bots (not hardcoded), each with enable/frequency/channel persisted per user; the cron honors them; a disabled source never briefs; and the Kalshi briefing continues working unchanged for a user who touches nothing.

### ADR-045 graph-tier residuals
- **Remaining:** decide/build RCA-persona graph use, add `subgraph()` if still needed, and make store-package graph dependencies explicit through `uses:` or an ADR-backed alternative.
- **Done when:** each residual is implemented or explicitly rejected in [ADR-045](adr/045-two-tier-graph-database-and-connector.md), and package validation makes the graph dependency visible before activation.

### Workflow Studio draft execution and branching
- **Remaining:** execute an unpublished draft through the production runtime and add a repeatable live graph-mode branching/parallelism spec.
- **Done when:** both paths use the same compiler/runtime and run-history model as published workflows, with guarded branch outputs and terminal state. See [ADR-039](adr/039-bot-driven-workflow-authoring.md).

### Agentic workflow authoring and streamed canvas events
- **Remaining:** give the builder bot a tool that emits node/bot/tool events into the canvas and produces either a packed manifest or reviewer-gated ticket workflow; the basic compile/publish path is already complete.
- **Done when:** one cockpit conversation visibly builds a valid graph, passes validation, and emits a runnable workflow without hand-editing JSON.

### Argo ticket execution and promotion
- **Remaining:** submit queue work as an Argo Workflow, run one real incident-RCA ticket in cluster, persist its cost marker, and wire the documented `dev -> main -> Argo CD` promotion.
- **Done when:** the ticket completes in an isolated Workflow with cost/output evidence and the promoted revision syncs automatically without local batch execution. See [ADR-078](adr/078-kubernetes-argo-batch-and-multi-tenant-proofout.md).

### BYO/free-tier tool-capable turns
- **Remaining:** make BYO and platform-free connections participate in the accountable agentic tool loop, or explicitly restrict them to chat-only with honest UI capability labels.
- **Done when:** a free/BYO bot completes a guarded tool task with caller identity and cost metadata, or every surface prevents selecting that lane for tool-required work.

### All-local Ollama profile
- **Remaining:** recreate Compose services with a reachable `OLLAMA_HOST`, register a Cline-harness Ollama bot, add the `oshal-model` Kubernetes Service, and benchmark a real ticket.
- **Done when:** Compose and Kubernetes both resolve the local endpoint and evidence records a successful ticket, latency/throughput, and zero available cloud credentials. See [ADR-078](adr/078-kubernetes-argo-batch-and-multi-tenant-proofout.md).

### Local-LLM hardware decision
- **Remaining:** inventory the existing gaming-PC GPU and choose the $0/current, used-3090, large unified-memory, or later fleet tier; no purchase is implied by this item.
- **Done when:** the operator records a tier and, if hardware is selected, its OpenAI-compatible LAN endpoint passes the all-local ticket proof above.

### Gemini one-click harness login
- **Remaining:** register the ECSG Google OAuth client and implement start/callback/status/signout for Gemini Code Assist credentials; AI Studio key paste remains a separate existing path.
- **Done when:** a signed-in user completes Google consent and a Gemini-harness bot answers with the resulting credentials without pasting a key.

### A2A gateway productionization and interoperability
- **Remaining:** apply migration 089, enable the bounded public gateway, complete an inbound third-party task, and run the same contract against a second vendor; do not replace per-agent credentials with a global secret.
- **Done when:** an external agent card leads to a completed caller-attributed ticket with authorization/cost evidence and the cross-vendor round trip passes. See [ADR-109](adr/109-a2a-gateway-external-agents-join-the-swarm.md).

### OSHAL Node bot-initiated control
- **Remaining:** expose node MCP tools to eligible bots, route bot tool calls to the selected node, add per-action confirmation, and introduce a live scoped mount only before parallel same-folder writers are enabled.
- **Done when:** a user asks the orb to open Word and return a screenshot, an accountable swarm bot drives the node, the result renders inline, and shared-task artifacts remain available to the next round. See [ADR-114](adr/114-user-owned-remote-nodes.md).

### Push-on-dispatch deployed mismatch proof
- **Remaining:** after promotion, run a deliberately drifted worker through the default-on guarded path and retain the controller/bot result as deployment evidence.
- **Done when:** the deployed worker self-corrects to the dispatched provider/model, a missing authoritative record is refused before task creation, and the returned result records `providerConfigSource: "authoritative-dispatch"` with the config version.

### Manifest bots get an ADR-034 authoritative record at load
- **Remaining:** the gsquared CRM boxes had an EMPTY `agent_config` table, so with push-on-dispatch
  default-on every queue dispatch to any node bot failed closed ("Authoritative provider config was
  required but no actionable record was available") while direct chat paths worked — found live
  2026-09-04 chasing the Jarvis→sales-concierge handoff. Interim: records seeded by hand on both
  boxes (openai-codex/gpt-5.5, matching their env truth). The durable fix: loading a manifest that
  declares `bots:` seeds/updates each bot's `agent_config` record from its persona `runtime:` block
  or the deployment default, so a fresh box is queue-dispatchable without hand seeding.
- **Done when:** a clean-DB manifest load leaves a dispatchable record for every declared node bot,
  a unit guard proves it (and goes red when seeding is dropped), and `dispatch-manifest-worker` to a
  freshly loaded packaged bot succeeds on a box with no hand-seeded rows.

### Queue-dispatched concierge answers carry the app's data context
- **Remaining:** the ADR-083 rail now completes end to end for the CRM (Jarvis files the pull,
  keyword call-out picks sales-concierge, the node executes and the ticket completes — proven live
  2026-09-05 on the gsquared staging box), but the concierge answered honestly that it had no board
  data: the bare swarm-execute prompt does not engage the package's route-backed board tools the
  interactive path uses, so a data question completes without the data. The dispatch (or the bot
  node's tool layer) needs to let the concierge reach its own deterministic board reads on ticket
  work, per the ADR-036 boundary (server-side data access, model sees normalized results only).
- **Done when:** the same Jarvis question ("how many opportunities are in docs out?") returns the
  live count through the handoff rail on a box whose CRM holds a known stage distribution, with the
  read executed by the package's own operation — never by handing the model a credential.

### Bot runtime consolidation
- **Remaining:** choose one canonical implementation across `app.js`, `swarm-node.js`, and `bot-node-server.ts`; remove or explicitly demote the others.
- **Done when:** config, dispatch, result, heartbeat, and authorization behavior are covered once and no supported deployment silently omits a capability because it selected a different runtime.

### Embedded LLM tools as a formal tier
- **Remaining:** model provider-native embedded tools beside framework-registry and harness-native tools with per-agent policy and audit semantics.
- **Done when:** an agent can enable/disable a named embedded tool, denied use fails at execution, and the run trace identifies the tier and provider operation.

## Connectors, channels, and external systems

### Connector OAuth started from a themed subdomain dies at the callback
- **Remaining:** the generic connector ceremony builds its redirect from `APP_URL` ([connector-oauth-ceremony.ts](../src/app/routes/connector-oauth-ceremony.ts)), so every provider sends the browser back to `oshal.agenticfederal.us` regardless of which surface started the flow. A session on `finance.oshal.ai` lives in a cookie scoped to `.oshal.ai`, so the callback arrives with no session and `requiresAuth` rejects it with 401 JSON — tokens are never stored. Live-hit 2026-08-17 reconnecting Schwab from the finance surface (api log: authenticated `/schwab/start` 22:16:18Z → unauthenticated `/schwab/callback` 22:16:36Z). Workaround: run the connect from `oshal.agenticfederal.us` itself. Candidate fixes: authenticate the callback from the signed state it already carries (provider + sub + ts HMAC — treat its verification like the token broker), or have `/start` bounce the browser through the `APP_URL` origin first so the whole ceremony runs inside one cookie family. Registering per-host callbacks does not generalize — Schwab accepts exactly one callback URL, byte-for-byte.
- **Done when:** a connect started from `finance.oshal.ai` (or any `*.oshal.ai` surface) completes and stores tokens without the user pre-logging into `oshal.agenticfederal.us`, a forged or expired state is still refused, and a guard covers the cross-cookie-family origin case.

### Connector marketplace live brokered reads
- **Remaining:** run at least five distinct credentialed connectors through caller-scoped broker resolution; loopback/captured-fetch fixtures do not qualify.
- **Done when:** five owning-user live reads succeed, cross-user credential substitution is denied, and audit evidence names caller, connector, action, and redacted outcome.

### Email providers beyond Gmail
- **Remaining:** live-test Outlook/Microsoft 365 and Yahoo/IMAP through caller-owned connections and finish any provider-specific auth or pagination repair.
- **Done when:** a user connects each supported provider in Utilities and the email bot lists and summarizes that user's mail with cross-user denial proof. See [ADR-037](adr/037-communications-swarm.md).

### Warn before an unrenewable connection lapses
- **Remaining:** [BUG-13](operations/bug-log.md) closed the *has already lapsed* signal — Identity Hub now flags a connection whose authorization has expired with no refresh token to revive it. The case with no signal at all is the one BEFORE that: a connection that holds **no refresh token** and an expiry still in the future is on a countdown to silent failure, and nothing warns. Five connections across three providers are in that state today (facebook ×2, linkedin ×2, meta-business — all short-lived unrenewable grants). The data is already in the projection's reach; what is missing is a decision about the threshold and where the warning belongs (a third pill state, or the Access review only).
- **Done when:** a connection that will lapse within the chosen window and cannot renew itself is visible to the user before it breaks, the threshold is stated on the surface rather than implied, and a guard covers the boundary in [connector-list-expiry.spec.ts](../tests/unit/connector-list-expiry.spec.ts). See [`isConnectionExpired`](../src/app/routes/connector-tenancy.ts).

### Reading a user's own Drive content — the `drive.file` scope wall
- **Remaining:** the Google connector ships `drive.file` (per-file access to files the app created), so the `google-drive` provider in [storage-browse.ts](../src/app/routes/storage-browse.ts) browses successfully and returns an empty listing for a user's own photos. Every other provider on that rail (oshal-local, career, dropbox, github) is unaffected — [portrait-studio](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/portrait-studio) 1.4.0 ships a connected-asset picker over it and degrades Drive honestly, naming the scope as the cause. What is open is the core decision: the Google Picker (minimal scope; needs an API key/app ID and an explicit `script-src` allowance for `apis.google.com`, which [strict-csp.ts](../src/features/security/hardening/strict-csp.ts) has no knob for today) versus the restricted `drive.readonly` scope (Google app verification + CASA assessment, forced reconnect for every existing connection, widened read for every user).
- **Done when:** one option is chosen and recorded, a caller can read a file they did not create through the chosen path, no surface depends on report-only CSP to load its scripts, and the scope set in [connector-provider-registry.ts](../src/app/routes/connector-provider-registry.ts) matches what the verification posture actually permits. See [ADR-080](adr/080-creative-studio-extend-story-pipeline.md).

### Social provider expansion
- **Remaining:** live-verify LinkedIn and X publish/read flows, then add Instagram/Threads and Mastodon only through reviewed connector/CLI adapters.
- **Done when:** each advertised provider connects, drafts, confirmation-gates outward publication, and writes a caller-scoped audit record; unsupported providers are not displayed as ready.

### LinkedIn Content Assistant queue workflow
- **Remaining:** carry the existing research/topic/draft foundation through the queue-backed review, approval, schedule, and publish phases.
- **Done when:** one `linkedin-content-post` ticket reaches a confirmation-gated publish with source citations, caller credentials, audit evidence, and a clean denial path.

### LinkedIn store-package publisher
- **Remaining:** route the Social package publisher through its declared connector action and the kernel's caller-scoped fail-closed audit path.
- **Done when:** audit commits before the provider call, audit failure prevents publication, and no-connection and approval-denial cases stay clean. Track package work in [`social`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/social).

### Subscription-driven social signals
- **Remaining:** define selector descriptors and connect watch registration to sensor polling and authenticated owner-lane `XADD`; current feed/workspace UI is already package-owned and complete.
- **Done when:** one caller-scoped subscription produces an auditable matched signal for that user's bot and another user cannot read the subscription, captured post, or stream event.

### Chat-channel adapter core
- **Remaining:** run dedicated node listeners for Telegram, Discord, and WhatsApp, map provider identities to users, dispatch accountable bot work, and return replies/proactive pushes.
- **Done when:** a linked user DMs a real task, the selected bot completes it, the reply returns in-channel, and unlinked/cross-user identities are denied and audited.

### Channel enable and bring-your-own configuration
- **Remaining:** add provider-specific enable cards, operator demo-bot configuration, and honest setup/review guidance for Telegram, Discord, and Meta/WhatsApp.
- **Done when:** each channel can be enabled/disabled without editing code, BYO secrets are brokered and masked, and the UI distinguishes ready, credential-needed, and provider-review states.

### Twilio policy, fallback, and inbound messaging
- **Remaining:** define topic/severity routing across SMS/voice/WhatsApp, add a non-Twilio email fallback, and authenticate/normalize inbound SMS through the channel adapter.
- **Done when:** policy guards choose the expected channel, email works with Twilio absent, forged webhooks fail, and an inbound message reaches the correct caller-scoped bot. See [Twilio channel guidance](channels/twilio.md).

### Communications bot live wrap-up
- **Remaining:** after ECSG Twilio/A2P configuration, run browser-originated SMS, voice, and fallback-email smokes; then exercise inbound SMS-to-Jarvis.
- **Done when:** all three outbound legs and one authenticated inbound reply work for a signed-in user with delivery/audit evidence and no secret in logs.

### Telegram notification mouthpiece
- **Remaining:** capture the operator chat ID, configure it beside the proven bot token, and send one real completion notification.
- **Done when:** a finished creative episode reaches the intended Telegram chat, another chat cannot subscribe itself, and delivery failure remains visible/retry-bounded.

### AI Office artifact delivery adapters
- **Remaining:** add Slack behind explicit confirmation, then Teams and Twilio link delivery when their credentials exist; preserve artifact ownership and expiry.
- **Done when:** a caller can deliver a generated PPTX/DOCX/XLSX through each enabled adapter, denial sends nothing, and recipients receive an owner-scoped expiring artifact. See [ADR-108](adr/108-office-delivery-adapters.md).

### Smart-home edge-agent Phase 1
- **Remaining:** run a laptop edge node embedding Home Assistant Core, aggregate existing ecosystems, expose only scoped capabilities, and keep Matter migration later.
- **Done when:** the operator controls at least one real LAN device through an accountable bot while another user/device cannot access it, and the node survives reconnect. See [ADR-047](adr/047-smart-home-edge-agent.md).

### Alexa-exclusive control path
- **Remaining:** defer until an Alexa-only device requires it; then register Login with Amazon and a certified Smart Home Skill under the business account.
- **Done when:** the certified skill controls that device through scoped user consent and revocation; devices reachable through the edge-agent path do not create duplicate integrations.

### Operator credential/configuration follow-ups
- **Remaining:** register Outlook under `maintainer@emeraldcoastsystemsgroup.com`, set real daily cost caps, and configure `SWARM_SERVICE_SECRET` so bot-node auth is fail-closed.
- **Done when:** Outlook reconnects and sends, at least one budget denial is proven, and unauthenticated `/api/swarm-execute` is rejected on the deployed stack.

## Shared product experience

### Surface theming — visual spot check across themes
- **Done already:** [BUG-12](operations/bug-log.md) is fixed and gated — every governed surface links a theme source, sets a default `data-theme`, and declares no bare hex in `:root`; 315 hardcoded colours across 37 files were remapped onto framework tokens by semantic role. `tests/unit/surface-theming.spec.ts` is mutation-proved and fails on all three regressions.
- **Remaining:** the gate proves the *mechanism*, not the *result*. Walk the converted surfaces in one light theme and one dark theme and look for contrast casualties — a role mapped to a plausible-but-wrong token (a status hue used as a background tint, a border that reads as text) is invisible to a static check. Highest-risk files are the ones with the largest remaps: `swarm-control.css` (53), `task-explorer.css` (21), `workflow-studio.css` (27 across two passes), and `applications/index.html`, which was authored light and now follows the theme.
- **Done when:** each converted surface has been seen in a light and a dark theme with no unreadable text or invisible border, and any mis-mapped role is corrected at its token rather than by reintroducing a hex.

### Identity Hub expiry reporting
- **Remaining:** the connector list response never emits a per-connection `expired` flag, so Identity Hub's Need-attention tile, expired marker, and red Reconnect pill are dead UI ([BUG-13](operations/bug-log.md)). Derive expiry in `buildConnectorListResponse` from the stored token expiry, keeping the projection credential-free.
- **Done when:** a connection whose stored token has passed its expiry renders the expired marker and is counted by the Need-attention tile and filter; a unit assertion pins the response keys the shipped surfaces read, so dropping a consumed field goes red.

### In-app help: per-surface affordances and first-run
- **Done already:** the per-surface guides live in [docs/guides/](guides/README.md) and are now reachable in-product — `/api/help` renders them behind auth, `?for=<surface>` deep-links a screen to its own page, and a **Help** entry is pinned in the cockpit ribbon. The image ships the corpus and a guard covers the dead-deep-link, traversal, ribbon, mount and Dockerfile-COPY failure modes.
- **Remaining:** the reader still has to know to click Help. Add a per-surface `? Help` affordance on the `sat-ops` pattern that opens `/api/help?for=<surface>` from the screen itself, and honest empty states for the screens that look broken when they are not (Intelligent Processing's parked backlog is the worst offender — a parked row should say whether it is waiting for a person or was stopped on budget). Decide whether the first-run strip should stop suppressing itself on the full framework profile (`src/pages/cockpit/js/first-run.js`), which is why a new user currently gets no orientation at all on the cockpit carrying every surface.
- **Done when:** every covered surface exposes a help affordance that lands on its own guide without the user navigating the ribbon; a parked Intelligent Processing row states its reason on-screen; and first-run behaviour on the full profile is either fixed or explicitly recorded as intended.

### Notifications copy: describe both credential tiers
- **Remaining:** the Notifications screen's intro says every send uses your own connected account and "never a shared deployment credential" ([BUG-14](operations/bug-log.md)). That describes the personal tier only; the swarm service tier is a deliberate second classification (an administrator-configured notification account for users who never registered with the provider), and it is the normal path on a home or demo deployment. Reword the line to state both, and show the effective tier per channel in the routing table.
- **Done when:** the screen states which of the two account kinds carries each channel at choose-time, and the wording matches the per-channel behaviour in `notify-routes.ts` (personal first, service fallback, destination always the user's).

### Shared response-renderer completion
- **Remaining:** add safe `oshal:map` and `oshal:doc` components, wire Jarvis/concierge/orb consumers to the registry, and finish the live Gmail, delayed-worker lifecycle, actions/forms, voice, attribution, and transcript decisions in [the acceptance plan](backlog/jarvis-voice-and-visuals.md).
- **Done when:** the same untrusted response renders safely and consistently across at least Jarvis, chat, and one app; provider-grounded blocks cannot be model-forged; every remaining acceptance-plan item has live evidence or an explicit disposition.

### Chat-to-surface bridge
- **Remaining:** finish cockpit-mediated `postMessage` routing, per-app event vocabularies, selection return to chat, and origin/schema/identity enforcement over the existing bridge foundation.
- **Done when:** in one reference app, bot output updates selectable UI state and the user's selection returns to the same conversation, while forged origins, unknown ops, and cross-user events fail. See [ADR-036](adr/036-bot-owned-application-architecture.md).

### Per-app workspace consolidation
- **Remaining:** apply Social's cohesive workspace pattern where Storage, Career, and other multi-surface packages still expose disconnected panels.
- **Done when:** each selected app presents one navigable workspace with its bot beside the active task and no duplicate ownership of the same action.

### Guide bots that operate their apps
- **Remaining:** after the bridge lands, give deck, storage, social, and other guide bots scoped surface operations rather than prose-only personas.
- **Done when:** one guide bot completes its app's primary task through validated UI operations, with user confirmation at every outward or destructive boundary.

### Combined home workspace
- **Remaining:** compose communication, social, career, storage, media, and home package surfaces into one switchboard without copying their business logic; resolve the manifest bot requirement cleanly.
- **Done when:** `/cockpit/?app=workspace` loads every enabled home app in one ribbon, preserves owner isolation, and routes each action/chat to the owning package. See [ADR-113](adr/113-switchboard-aggregation-surface-and-workspaces.md).

### OSHAL engineering-screen normalization
- **Remaining:** apply the cockpit design system and verify live data contracts for task explorer, queue/admin, mesh, ops, health, config, Redis, and RAG screens.
- **Done when:** each screen has a consistent loading/empty/error state and a browser test proving its displayed values match the backing API.

### Queue dashboards per-app isolation
- **Remaining:** scope legacy queue dashboards and packages without `ticketType` to an explicit app/workflow identity rather than a global queue.
- **Done when:** every app ticket/queue view shows only its declared work and a cross-app fixture proves no leakage.

### Apps page as a swarm catalog
- **Remaining:** show bundles, included providers, install/enable state, and live per-provider connection state rather than a flat tile list.
- **Done when:** `/applications` accurately distinguishes installed, available, connected, credential-needed, and unavailable bundles from registry/broker data.

### Consumer commerce native surfaces
- **Remaining:** keep Rides map/quote-first, Eats delivery/menu/cart-first, and Shopping address/search/cart-first while connecting each concierge through the shared state bridge.
- **Done when:** each package supports browse/search/scroll, chat-driven state, deterministic totals, confirmation-gated outward action, and a real mobile-width browser smoke. Track package UI in [`rides`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/rides), [`eats`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/eats), and [`purchasing`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/purchasing).

### Jarvis hand-off experience
- **Remaining:** send task-complete email, verify hard-refresh focus, and replace the slow agentic decision turn with a lightweight tool-less decision that preserves exactly-once build dispatch.
- **Done when:** email and focus checks pass live and a build request is acknowledged within 20 seconds with one swarm execution and no abandoned duplicate turn.

### Jarvis media-input deployment proof
- **Remaining:** deploy and exercise PDF, Word, and image parsing through the real browser/provider path; private-RAG ingestion remains a separately commissioned feature.
- **Done when:** dated evidence shows every supported type reaches the intended parser/model, extracted text is not silently dropped, and another caller cannot access the attachment or derivative.

### Presentron chat and frontend contract
- **Remaining:** prove the no-provider/noop path reports unavailable rather than rendered, then reconcile any stale modal/API contract in the current frontend.
- **Done when:** production route and browser guards cover both paths, including render failure, stale job state, and artifact ownership. Track package UI in [`presentations`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/presentations).

## Token Chase

### Provider-backed optimization evidence
- **Remaining:** run the production replay/comparison path against a current live provider capture; demo/no-token routes are not acceptance evidence.
- **Done when:** dated evidence records baseline and variant output, determinism verdict, token/cost totals, quality score, provider/model, and keep/reject decision. See [ADR-046](adr/046-token-chase-checkpoint-replay-optimization.md).

### Workspace-bound checkpoint and tail replay
- **Remaining:** bind each frame to workspace commit, owner-store version, pinned reads, and tool schema; restore into an isolated worktree and replay the downstream tail with AES-GCM-preserving store state.
- **Done when:** no-edit replay reproduces artifacts/store version, genuinely live reads are marked non-replayable, and replay always runs on an accountable bot node rather than the controller.

### Token Chase debugger
- **Remaining:** expose the captured timeline with prompt/response inspection, rewind, hand-edit, and forward play; clearly mark non-replayable frames.
- **Done when:** an operator opens a finished run, edits the failing call, and replays the tail while preserving the original immutable baseline and audit trail.

### Variant-selection switches (learned re-routing reframed as a non-goal, 2026-08-09)
- **Decision (operator):** routing is the operator-approved keep-winner switch — promote an LLM-judged, strictly-cheaper winner, optionally apply it to the owning bot via the ADR-034 push, audited and one-click revertible, with cockpit promote/revert controls in the Optimizer. An autonomous learned/trained selector is a ROADMAP non-goal; nothing re-routes without approval (auto mode stays behind `TOKEN_CHASE_AUTO_PROMOTE`, default off).
- **Remaining (optional, unscheduled):** a corpus-backed query-type lookup that *suggests* a switch before any spend — an advisor that proposes for approval, never a re-router.
- **Done when:** closed by the promotion switch; reopen only if the suggestion advisor is commissioned.

## Career and job application

### Career scoring/tailoring bot-node migration
- **Remaining:** move per-posting score/match/tailor execution off the controller/API process into a dedicated Career worker with bounded concurrency, cancellation, heartbeat, caller identity, and package-owned configuration.
- **Done when:** a real Career bot-node completes the workflow, the controller performs no provider shell-out, worker loss terminates visibly, and two-user isolation/cost attribution pass. Track app ownership in [`career-hunter`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/career-hunter).

### Apply recipe runner and learned cache
- **Remaining:** replay known Ashby/Greenhouse patterns without model turns, tune the Workday parse-correction grid live, and share a PII-free family recipe schema between the native runner and swarm apply operator; novel forms may fall back to vision and learn owner-scoped variants.
- **Done when:** five supported ATS families replay deterministically where a recipe exists, Gmail verification is polled, novel forms learn safely, and auto-submit remains separately opted in per family.

### Offline browser autofill smoke
- **Remaining:** with the stack stopped, copy the current Career bookmarklet and exercise one real Ashby and one real Greenhouse form in an already authenticated browser.
- **Done when:** allowed empty fields fill from the caller's profile while existing answers, demographics, uploads, hidden/honeypot controls, and Submit remain untouched, with screenshots recorded.

### Apply pipeline live repair/provenance proof
- **Remaining:** deploy package migrations 100/101 and kernel migration 116; record reaper/provenance pre/post counts; run one healthy final submit and one CAPTCHA/2FA pause through a real worker.
- **Done when:** the bounded reaper releases the historical raw claims, all 164 historical rows have explicit provenance with the 28 evidence-free rows still `unverified`, worker/state transitions are visible, and only retained confirmation-backed submission renders verified.

### Career Hunter PostgreSQL backend cutover
- **Remaining:** the package now has exact engine/driver pins, fail-closed store selection, shared SQLite/PostgreSQL contracts, idempotent loaders, stable interview source identity, a bounded convergence reporter, and a staged cutover runbook. Keep SQLite authoritative until the protected-branch disposable-PostgreSQL job actually runs, the reverse projector is implemented, and a real backup/final sync/read-only smoke/write cutover/rollback drill succeeds. The complete provider/title/enqueue nightly chain also remains a kernel/provider integration proof, not a package-contract result.
- **Done when:** the PostgreSQL half proves posting/company upserts, refresh/deactivation, types, sequences, application lifecycle, ATS ingest, RLS, counts, checksums, and key-query convergence; reverse synchronization prevents stale rollback; the live cutover and rollback are rehearsed; then seven days of freshness, latency, RLS, count, and nightly-marker telemetry remain inside stated bounds. See the package's `BACKEND-CUTOVER.md` and `JOBHUNTER-CONFUSION.md` records.

## Finance

### Finance package live verification
- **Remaining:** configure Plaid Sandbox and Stripe test credentials, install the [`finance`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/finance) package, then exercise link/sync/brief and one test ACH payment.
- **Done when:** the owning user sees grounded balances/holdings/spend, the payment audit/status reflect the test transfer, another user cannot read either, and no live-money key is present. See [ADR-048](adr/048-finance-aggregation-swarm.md).

### Finance post-v1 rails and governance
- **Remaining:** separately decide real A2A payouts, live-money compliance, broker trade execution, Plaid production access, household labels/sharing, and scheduled forecast/alert scope.
- **Done when:** each commissioned capability has its own approved regulatory/security contract and live or sandbox proof; selecting an unimplemented rail continues to fail loudly.

## Trading and market systems

### Queued paper-to-live parity features
- **Remaining:** implement and soak the market-wide gap-down entry filter, immutable per-position exit plan, and idle-cash yield sleeve in paper before any live promotion.
- **Done when:** paper and live share one guarded algorithm/config path, historical and shadow evidence records impact, and promotion requires the existing explicit confirmation. See [ADR-052](adr/052-stock-trading-swarm.md).

### Trading platform surface and engine expansion
- **Remaining:** add asset/sector mix and active stop/take-profit panels, default to the full supported universe, and design futures/intraday/long sleeves plus a roughly 200-symbol multi-market universe.
- **Done when:** the [`trading`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/trading) surface exposes allocations/exits for the actual engine universe and every added sleeve is paper-proven behind kernel risk gates.

### SK Hynix sleeve graduation
- **Remaining:** after reliable permanent-ticker history exists, remove the temporary core exemption and evaluate the position through the normal sleeve/risk model.
- **Done when:** the permanent symbol is used consistently, the position has ordinary data/stop/exit coverage, and no IPO-specific bypass remains without an explicit rule.

### IPO event-play design
- **Remaining:** keep the rejected generic pop-catcher closed; design only the distinct IPO-event sleeve with data availability, allocation, halt, spread, and same-day exit constraints.
- **Done when:** an ADR and replayable paper study define the event universe and risk gates, and no live order is possible before paper acceptance.

### Market-data stream decision
- **Remaining:** exhaust already-owned Alpaca/Schwab data and quantify the consolidated real-time quote gap before purchasing another feed.
- **Done when:** an ADR names the chosen real-time source, entitlement and staleness behavior are guarded, and one intraday backtest cites the exact feed and coverage.

### Kalshi calibration and demo paper fill
- **Remaining:** restudy ask-basis calibration with staleness, bounded randomized sampling, cluster-bootstrap intervals, regime/date splits, monotonic probability, fees, and multiplicity adjustment; then save a demo connection and fill/settle one paper order.
- **Done when:** the published calibration passes those gates and one caller-attributed paper trade records quote-at-signal, fill, settlement, and P&L. Track UI/package work in [`kalshi`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/kalshi).

### Kalshi: market signals and world news as pre-registered strategies
- **Context (2026-09-04):** the graded record (2,447 settled predictions) shows both scan strategies losing to the market in every price band before fees; two contrarian variants are pre-registered as zero-stake forward tests (`contrarian-extreme`, `contrarian-weather-disagree`). The operator's next direction is to add market signals (Kalshi price/volume history via `getCandles`) and world news as inputs. The news archive that exists on the box is `oshal_content_articles` (7.9k rows, `published_at` through today, sources msn/HN/Yahoo Finance/Forbes/CNBC/TechCrunch); the world app's `world_items` table has never been created here (no pull has run).
- **Remaining:** (1) a market-signal strategy over Kalshi candles that can be BACKWARD-run on the tape because it does not depend on our model (e.g. price momentum / mean reversion into settlement per series), scored blind-forward like `oshal-trading-news-materiality-backtest.ts`; (2) a news-signal strategy that maps headlines to open Kalshi markets with the headline's `published_at` strictly before the quote used, pre-registered through `kalshi_predictions` at zero stake; (3) neither may bypass the fee/Kelly/judge machinery, and no third contrarian variant without pre-registration.
- **Done when:** each new strategy has a written rule dated before its first prediction, ≥ MIN_GRADED (30) settled rows on the Scorecard tab, and a Brier no worse than the market's before any stake is proposed; the backward run cites the exact candle range and series and reports the overnight/latency cohort separately; the news mapping is reproducible from `oshal_content_articles` rows alone.

### Trading watchdog hardening
- **Remaining:** add uncovered-position, buying-power/position-count/concentration, per-symbol hysteresis, live-bleed, empty-exec, quote volume/recency, shared working-status, and broker-number parsing checks.
- **Done when:** mutation guards and a paper/live-shadow drill prove each failure alerts once with correct recovery and no silently healthy infrastructure-check result.

### Futures extension layer
- **Remaining:** sweep ensemble exits and ATR-percent buffers; run the six-stage locked-winner optimizer with three-market OOS overlays; stabilize/extract real archives and verify Kibot/Schwab sources; add margin, Target-1, closure/roll rules, durable paper stops, fail-closed live adapter, contract risk semantics, and cockpit coverage.
- **Done when:** reproducible real-bar in-sample/OOS evidence exists, paper state/stops survive restart, contracts/margin/gaps render correctly, and any live order remains behind confirmation and risk gates. See [ADR-116](adr/116-futures-extension-layer.md).

## Video, character, and creative automation

### Video Series conductor live acceptance
- **Remaining:** with explicit spend approval and a working image/render node, submit a one-episode/two-scene series and use only create plus approve while the conductor advances every other stage.
- **Done when:** the series reaches `done` with a real Drive link and `ffprobe` confirms video/audio streams and acceptable silence, with no manual intermediate stage calls. See [ADR-082](adr/082-video-series-pipeline.md).

### Free ComfyUI storyboard provider
- **Remaining:** configure the GPU-box ComfyUI URL and a pinned storyboard workflow; do not retry ChatGPT/Codex subscription OAuth against the OpenAI Images API.
- **Done when:** a real storyboard request returns a generated image through the ComfyUI provider, failure is bounded/visible, and the conductor can consume it without Vertex spend.

### Video Studio storyboards on the demo codex-cli rail
- **Remaining:** the series storyboard stage calls `resolveStoryboardImageProvider` without `userSub`, so under the ADR-130 demo default it fails closed with the carve hint; thread the series owner's sub from the conductor (`series-orchestrator` → `storyboardEpisode` → resolver opts) the way portrait-studio 1.4.1 does.
- **Done when:** a demo-mode series storyboard renders through the `codex-cli` provider end to end with the owner's sub on the SEC-05 gates, and the conductor spec covers the threading. See [ADR-130](adr/130-codex-cli-storyboard-image-provider.md).

### Video Series intro and season assembly
- **Remaining:** splice a reusable intro into each episode and add season-level ordering/stitching over completed episode artifacts.
- **Done when:** a multi-episode series emits independently playable intro-bearing episodes plus one correctly ordered season artifact with validated audio/video streams.

### Flow UI-automation video provider
- **Remaining:** if the accepted personal-use/ToS tradeoff remains, run Flow on a dedicated fixed-geometry host using recorded deterministic interactions and explicit UI-drift detection.
- **Done when:** the provider generates and downloads one clip into the pipeline and a changed UI fails clearly or escalates to the paid provider without hanging or accepting the wrong artifact. See [ADR-070](adr/070-multi-provider-video-generation.md).

### Vids Operator named-tool live proof
- **Remaining:** live-tune each Vids tool, cache located controls, expose scenario/tool mode in both UIs, convert scenarios to explicit tool sequences, and add LoRA/Studio bridges.
- **Done when:** the director builds a multi-element real Vids project by calling named tools, using screenshots only for verification, and repeated format cost is materially below free-form control. See [ADR-073](adr/073-vids-operator-scenario-library.md).

### Vids public-publish rail
- **Remaining:** in the [`vids`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/vids) package, separate explicit per-user publish/unpublish from the authenticated job API and issue revocable public artifact links.
- **Done when:** only the owner can publish/unpublish a finished artifact, anonymous access reaches only the published immutable file, and job/control routes remain authenticated.

### LoRA end-to-end GPU run
- **Remaining:** reconnect the GPU edge node, deploy current routes, and execute train, validate, score ingest, improve, and morning review on a real character.
- **Done when:** a real `.safetensors` file and owner-scoped scorecard/gallery record complete the loop without controller-local GPU work. See [ADR-071](adr/071-character-lora-studio.md).

### LoRA per-character generalization
- **Remaining:** replace hard-coded cyclops constants in box scripts and seed data with `oshal_lora_characters` configuration.
- **Done when:** a newly created character completes train/validate/improve without source edits or reused identity artifacts.

### LoRA automated curation judge
- **Remaining:** reuse CLIP/identity and structural checks to propose keep/reject before training while retaining human override.
- **Done when:** rejected off-identity/deformed candidates do not enter the training set and a labeled validation fixture measures false accept/reject rates.

### LoRA gallery image hosting
- **Remaining:** serve validation thumbnails over an authenticated mesh path or copy bounded thumbnails into owner storage.
- **Done when:** each scorecard cell displays its correct image, another user cannot fetch it, and expired/deleted runs lose access.

### LoRA autonomous overnight scheduling
- **Remaining:** add a real schedule trigger and replace any static ingest secret with short-lived scoped node authentication.
- **Done when:** enabling autonomous mode schedules the nightly loop, only the owning character runs, the morning-review ticket appears, and replayed/expired ingest credentials fail.

### Joke-shorts pump deferred work
- **Remaining:** add per-show destination opt-in/dry-run publishing, post-render mechanical quality review, shared recap/pump node lease, a declared Pumpkin bot, and an explicit external-persona manifest shape.
- **Done when:** nothing publishes without destination consent, bad episodes pause automatically, recap and pump cannot collide, Jarvis discovers Pumpkin, and the loader rejects orphan personas while accepting declared external copies. See [ADR-120](adr/120-joke-shorts-pump.md).

## Device, edge, spatial, and operations domains

### Headscale as standard practice, so an off-LAN node can actually join
- **Built and unrun:** the off-LAN path is complete — [ADR-013](adr/013-headscale-self-hosted-overlay-network.md) is Accepted and implemented (`infra/headscale/` compose + config + hardened ACL policy, `scripts/headscale-setup.sh`, `scripts/headscale-enroll-worker.sh`, the `headscale-http` A2A transport, an ACL guard, and [the enrollment runbook](runbooks/remote-swarm-node-enrollment.md)), and `installer\lib\install-swarm.ps1 -OffLan` mints a Headscale pre-auth key packed into an `OSJOIN2` join code. **But Headscale is not part of the default stack** — on the operator's own box the container has been `Exited` for four weeks, and `Test-ShouldGoOffLan` "returns $false the moment Headscale is absent", so an off-LAN request silently degrades to a LAN-only `OSJOIN1` code. Someone who downloads the open source and tries to connect a machine over the internet therefore hits a dead end that reads like a missing feature rather than a service that was never started.
- **Remaining:** decide whether Headscale joins the default bring-up (operator call — it is an outward-facing network service, so default-on deserves the same opt-in scrutiny as any other outward behaviour), or stays opt-in but **fails loudly**: `-OffLan` should refuse with "Headscale is not running, start it with scripts/headscale-setup.sh" instead of quietly emitting a LAN-only code. Whichever is chosen, `oshal-up.sh` should report Headscale's state alongside the rest of the tier so "why can't my laptop join" is answerable without reading four files.
- **Done when:** a machine on a different network completes the documented path end to end — join the overlay, enrol as an edge node, reach the API — and a deliberately stopped Headscale produces a message naming the cause instead of a join code that cannot work. Relevant to [ADR-135](adr/135-print-to-swarm-and-print-to-rag.md) P2: an edge printer off the LAN needs exactly this reachability before its device-bound credential is worth anything.


### Drone physical payloads and peer coordination
- **Remaining:** prove a real approved MAVLink airframe/adaptor, authenticated drone-to-drone coordination, physical camera/video, ESC telemetry, and LED payload through the remote-node envelope; the Drone package carve is already complete.
- **Done when:** [`drone`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/drone) drives auditable capture/telemetry on a physical node and a multi-node mission self-realigns without bypassing geofence, approval, abort, or ownership gates. See [ADR-099](adr/099-drones-as-remote-swarm-nodes.md).

### Camera real-device follow-ups
- **Remaining:** add GoPro BLE AP/COHN provisioning, pinned self-signed CA handling, browser-playable preview transcoding, one second-brand adapter, and package the camera node; deploy/install the current package for a browser smoke.
- **Done when:** a real GoPro provisions and previews without disabling TLS verification, a Canon CCAPI or ONVIF device uses the same provider contract, and [`camera`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/camera) drives both without controller/surface changes.

### Sat-ops forced-conjugate referee evidence
- **Remaining:** replay a captured NASA 42 stream or run the referee with its convention lock forced to `conjugate`, retaining direct-run comparison evidence.
- **Done when:** the captured/live conjugate branch has MEKF acceptance, rejection, reinitialization, and attitude-error rates comparable to the direct branch. See [ADR-102](adr/102-sat-ops-satellites-as-swarm-nodes.md).

### Spaces live reconstruction and capture expansion
- **Remaining:** deploy `spatial-recon-edge`, reconstruct a real room, add GoPro/personalized and commissioned WebRTC/pose guidance, ingest drone scans with sector patterns, and choose durable storage for 100MB-plus assets.
- **Done when:** one owner's real scan reaches a rendered reconstruction, capture actions are auditable, another user cannot access it, and large-binary retention has an implemented target. See [ADR-111](adr/111-spatial-mapping-3d-reconstruction.md).

### Native iOS Spaces scanner
- **Remaining:** generate the Xcode project, sign with a real Apple team/bundle ID, run on LiDAR hardware, and pair/upload PLY plus poses with a scoped token.
- **Done when:** a captured room imports into the owning user's Spaces surface, invalid/other-user tokens fail, and the first real Xcode build is clean.

### DevOps cockpit Phase 2+
- **Remaining:** discover topology from logged-in CLIs into the graph, add Connect-Vault and live traffic lights, discover/override Terraform and Kubernetes contexts, deploy NAT-friendly/push remote nodes, choose the bidirectional transport, and run specialist tasks with brokered credentials.
- **Done when:** a NATed node self-registers and round-trips work, topology is queryable/rendered, each connection reports a truthful reasoned state, and a specialist completes a real read/plan with a revoked short-TTL credential while apply/deploy stays human-gated. See [connectivity design](architecture/devops-cockpit-connectivity.md).

### Container-health collection without cAdvisor names
- **Remaining:** verify cAdvisor naming on supported Linux targets or adopt a Docker/agent collector whose OSHAL container identity is stable on Desktop and Linux.
- **Done when:** killing a real OSHAL container triggers the ADR-119 signal on every supported deployment class and a healthy container cannot be missed because its metric name differs.

### Bot-recreate thundering herd
- **Remaining:** deploy the default-on bounded bootstrap-pull jitter, recreate the full bot fleet against the production-sized API database pool, and tune the window only from observed startup/config-convergence results.
- **Done when:** recreating the full bot fleet causes no pool exhaustion, each bot receives config within a bounded window, and boot authentication/rate limits remain enforced.

### Operations and SecOps swarms
- **Remaining:** prove caller-scoped live reads for Dynatrace, ServiceNow, Datadog, and New Relic and retire the environment-global ServiceNow MCP; integrate the existing one-shot RCA engine; build the SecOps bot/store/surface; seed offline Trivy/FIPS assets and run a real self-scan.
- **Done when:** connector/RCA traces are caller-attributed, findings are encrypted and owner-isolated, security review passes, and a live enclave scan files auditable results without fetching an unapproved database. See [ADR-069](adr/069-operations-and-secops-connectors.md).

## Application-package follow-ups

### SEC-06 application-store route, ownership, and CI closure
- **Remaining:** promote the completed route/source, ownership/RLS, dependency-lock, secret-allowlist, immutable-action, and blocking-workflow changes through the protected application branch, then retain the first remote workflow evidence for each blocking gate. Re-run the LoRA, Vids, D&D, and Little Monsters disposable-PostgreSQL jobs against the promoted SHA; local source and CI-definition tests do not prove that branch protection actually requires them.
- **Done when:** protected-branch rules require the security workflow, the promoted workflow records green source/generated drift, route-inventory mutation, two-owner forced-RLS, dependency/action immutability, and secret-scan jobs, and a sanctioned fail-then-pass fixture proves each remote gate is blocking rather than advisory.

### Store catalog parity and SHA-bound package audits
- **Remaining:** catalog/manifest/README parity, the immutable audit schema, 47 version-bound structural records, CI validation, and compatible/enforce installer plumbing are implemented. Replace each all-zero `pending` source sentinel with a substantive immutable review bound to the exact package SHA, starting with child, money/trading, communications, physical-device, and external-publishing packages; only then move installations from compatible warnings to enforce rejection.
- **Done when:** all 47 records are `passed`, current, source-SHA exact, and reproduce hashes for manifest, authz, RLS, dependencies, install lifecycle, surface, and one app-specific golden path; a source/version/evidence change without re-audit fails installation, and the exact-SHA installer gate runs in enforce mode on the promoted catalog.

### Venture rebaseline scheduler activation
- **Remaining:** Venture Plan owns its default-off/dry-run policy, service-authenticated tick, UTC slot idempotency, and measured per-run cost gate. Add a first-class kernel schedule target that can invoke that deterministic package worker; do not substitute the generic prompt-dispatching `schedules:` path or imply that the local service route is already unattended.
- **Done when:** an installed schedule calls the tick under service identity; disabled and either dry-run gate produce no run or `chat_tasks`; one opted-in owner produces exactly one rebaseline run per UTC slot; a second owner remains isolated; stored integer-micro cost evidence stops every later call after exhaustion, overshoot, or capture failure; and dated live PostgreSQL/provider evidence records the result.

### Aero Lab real-drive and physical certification
- **Remaining:** keep [`aero-lab/BACKLOG.md`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/aero-lab/BACKLOG.md) authoritative while closing its red real-drive gate: use the vendored engine by default, derive BEMT and buoyant-trim tolerances from convergence, attribute structured aero refusals, step PackEcm exactly once per accepted mission timestep, run the four verification anchors, add browser/server numerical parity and mesh self-intersection checks, then rerun the pinned 30k sweep. Physical certification still needs vent/ballonet design, verified barrier film and helium purity, and a weighed propulsion/power ledger reconciled with BOM/CAD.
- **Done when:** all four reference designs pass or fail for an explicit structured validity reason on the fingerprinted real engine; the f=0.2–0.8 trim sweep, cold-night thermal/heater ledger, four anchors, browser parity, mesh, and deterministic sweep gates pass; and no build is certified until the physical pressure/material/purity/mass evidence reconciles to the exported design.

- **Done when:** installing the package registers its YouTube slice, uninstalling removes it, whole-archive upload routes correctly with owner isolation, and the package README is the canonical per-item product queue.

### Game Show core dependencies
- **Remaining:** auto-narrate the opening after the platform TTS speaker lease and install the package through the sanctioned registry installer rather than `docker cp`; app-local polish stays in the [`game-show` backlog](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/game-show/README.md).
- **Done when:** starting a show speaks or captions the open and `oshal-app install game-show --ref main` leaves provenance and survives redeploy. See [ADR-112](adr/112-game-shows-as-plugins.md).

### Payroll package backlog handoff
- **Remaining:** make the [`payroll` README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/payroll/README.md) the canonical queue for additional cited state/local tables, workweek overtime, protected identifiers, employee isolation, repayment/garnishment/deposit rules, benefits/payment traces, verified EFW2 2026, and enrolled filing/payment rails.
- **Done when:** each commissioned package item has primary-source citations where legally material, a focused calculation/isolation guard, and clean-tenant output evidence; core retains only shared framework dependencies. See [ADR-123](adr/123-payroll-app.md).

### Person-model Phases 2-4
- **Remaining:** implement consent-ledger enrichment, semantic recall, and person pages exactly as staged in [ADR-100](adr/100-ambient-person-model.md), preserving recall-only Phase 1 behavior until each gate passes.
- **Done when:** each ADR phase meets its own red-provable ownership, consent, provenance, deletion, and UX criteria without silently enriching people who have not opted in.

### Person-model fresh-database enable gate
- **Remaining:** apply the current migration chain to a database predating the feature and exercise enable/disable trigger paths.
- **Done when:** every object is created once, both trigger states behave correctly, rerun is idempotent, and no existing tenant data is exposed or rewritten unexpectedly.

### World Intelligence licensed outlet ratings
- **Remaining:** license Ad Fontes and/or AllSides, map the data with provenance, and replace placeholder bias/reliability seeds; this requires operator budget and license approval.
- **Done when:** every rating displayed in the World package is sourced to the licensed dataset/version and unknown outlets are represented as unknown rather than guessed. See [ADR-061](adr/061-world-intelligence-layer.md).

### Marketing engine — remaining phases (P0/P1 shipped 2026-08-23)
- **Shipped 2026-08-23** (ADR-[131](adr/131-marketing-engine-package.md)/[132](adr/132-public-site-analytics.md)/[133](adr/133-outbound-marketing-connectors.md)): the `marketing-engine` store package (campaign board, consent rows default-OFF, deterministic ingest + scorecard, backlog-gated weekly review tickets, four inline bots, LinkedIn/Mastodon/Bluesky/Resend rails), config-driven site analytics (default none), Search Console read spec. Operator setup: [marketing-engine-runbook](business/marketing-engine-runbook.md).
- **Remaining:** P2 launch execution is human-paced (checklists exist); P3 paid ads — ads-operator bot-node + Google Ads/Microsoft/Meta deterministic provider intents behind the existing budget-proposal flow, gated on a live paid product + server-side conversion tracking + a funded tier; P4 automated weekly reallocation proposals from real channel CPA; site waitlist capture (static site needs an endpoint decision: ESP-hosted form vs Pages function); X pay-per-use posting decision; per-user Mastodon instance URLs; a bounded PostHog stats resource (the current spec lists only unbounded resources, so scorecard site-traffic ingest honestly records `resource_unavailable`).
- **Done when:** each remaining phase meets its done-when in [the spec §14](business/marketing-engine-spec.md); every spend increase remains proposal→confirm-gated; the scorecard keeps failing loud (NO DATA, never invented numbers) as sources come online.

### HTML5 Game Generator package (held)
- **Remaining:** when commissioned, use a dedicated bot-node to emit a self-contained CSP-safe browser game; do not depend on co-located GUI editor MCPs.
- **Done when:** one prompt produces a playable packaged game with bounded assets, no unsafe eval/network dependency, and browser/security regression coverage.

### Content atomizer, share cards, and judged A/B (held)
- **Remaining:** if released, build independently in this order: one-input atomization, branded share-card generation, then judge-scored A/B using the existing scheduler, notification, and judge services.
- **Done when:** each capability installs and runs separately, retains source/provenance and owner isolation, and publishing remains explicitly approved.

### AI Deal Finder integration decision
- **Remaining:** decide whether `C:\Projects\ai-dealfinder` joins as a bot, connector, app package, or external A2A service; do not rebuild its auction/foreclosure/real-estate domains inside the kernel.
- **Done when:** an ADR names ownership, auth/data boundary, installation, and lifecycle, and one read-only end-to-end flow proves the chosen integration.

### print-drop swarm adoption (print-to-swarm / print-to-RAG)
- **Shipped 2026-09-02/03** (PRs #256–#266): `packages/oshal-print-drop` — standalone IPP Everywhere + WSD virtual printer; LAN clients print and documents land as PDF/XPS in a local drop folder with a `.json` metadata sidecar. Proven end-to-end on the operator's box (Microsoft IPP Class Driver, real job → PDF).
- **Remaining:** the adoption phase the operator named at kickoff — an opt-in (default OFF, per the automation directive) drop-folder watcher that feeds oshal: (a) print-to-swarm (a printed document opens a ticket / reaches Jarvis) and (b) print-to-bot (routes into a chosen bot's RAG corpus keyed on the sidecar metadata). Ships as a store package (Rule 0c), not core; the drop folder is untrusted LAN input and must be parsed defensively.
- **Designed 2026-09-03, awaiting operator review:** [ADR-135](adr/135-print-to-swarm-and-print-to-rag.md) + [print-ingest-spec](apps/print-ingest-spec.md). Five phases (P0 core extraction fix → P4 print-to-ticket) and five open questions the operator must settle before build. The RAG review that ADR carries found a **blocking core defect**: `/api/rag/upload` does `buffer.toString('utf-8')` with no text extraction while the Knowledge tab advertises `.pdf`/`.docx`, so every uploaded PDF is embedded as mojibake — `src/features/doc-extract/` already solves it and is wired only to `/api/vision/read-doc`. That fix (P0) is a prerequisite for print-to-RAG and a bug worth fixing on its own.
- **Done when:** a store package watches the drop folder only after the operator explicitly enables it, each printed document reaches the chosen corpus/ticket with provenance from its sidecar, hostile file content cannot escape the parser, and a fresh install does nothing until opted in.

## Provisioning and operator experience

### First-run provisioning wizard
- **Remaining:** extend `/welcome` through trusted store selection, package choice/install, invited users, and safe backup/secret defaults; third-party store URLs require an explicit trust design.
- **Done when:** a fresh LOCAL_AUTH admin completes or skips each re-enterable step, failures name the package, anonymous users cannot invoke installation, and an ADR prevents a typed store URL from gaining unchecked code execution. See [ADR-117](adr/117-local-auth-invited-users.md).

### `swarm-cli` zsh completion
- **Remaining:** execute the current completion in real zsh, covering sourced/autoloaded modes, command/state dispatch, and saved context completion.
- **Done when:** `zsh -n` and real tab completion pass for top-level commands, completion shells, token actions, and `--context`; append evidence to the existing 2026-07-12 proof or delete the unsupported script.

### Trading — timed orders outside regular hours, minute precision, holiday refusal (ADR-136 D4 follow-ups)
- **Remaining:** v1 (2026-09-04, `src/app/trading-dated-orders.ts` + trading 1.9.2) fires on the trading-events leg's 5-minute grid inside 09:00–16:55 ET on weekdays. Pre/post-market fire times need the leg cron widened to the extended session AND the existing per-user `trading-events:<sub>` schedule rows migrated (the store's ensureEventSchedule only creates, never updates); minute precision needs a per-order schedule row with pause-after-fire; exchange holidays are handled only as "market closed at fire time → expired", not refused when scheduling.
- **Done when:** a paper order dated 07:30 ET fires at 07:30 as an extended-hours-eligible LIMIT; a 09:37 fire time is accepted and fires at 09:37; a fire time on an exchange holiday is refused at scheduling with the holiday named; existing users' legs carry the widened cron without re-arming.

### Trading — earnings-reaction event rules (ADR-136 D5)
- **Remaining:** `oshal_trading_event_rules` (book_id, symbol, event=earnings, on_beat, on_miss, sizing, expiry; FORCE-RLS); a kernel watcher that polls EDGAR `submissions/CIK…json` for HELD names only inside the world-calendar earnings window and detects a new 8-K with item 2.02; fetch the primary document; the trading-analyst bot (hosted/BYO, cost-attributed) extracts revenue/EPS vs prior year and vs the company's own prior guidance → beat/miss/inline; the rule fires the mapped action as an operator-approved decision (paper auto; live per the book's confirm policy) with the first-print price reaction as a second gate. NOT a consensus-estimate service — no free keyless consensus source exists; say so on the surface.
- **Done when:** a paper rule on a held name fires within 15 minutes of a real 2.02 filing with the classification, the numbers it read, and the filing URL in the decision rationale; a miss on the same rule sells; a rule past expiry never fires.

### Trading — IPO playbook, Anthropic first (ADR-136 D6)
- **Remaining:** an event watch for the PUBLIC S-1 (EDGAR full-text search for the issuer; alert + link); a COTP reminder sequence keyed to the pricing date (the platform cannot submit a Conditional Offer to Purchase — Schwab requires the client to submit it on schwab.com before 4 p.m. ET the day before pricing and CONFIRM after pricing); a day-one plan expressed as ordinary order types on the chosen account — no market-on-open; sized limit entries relative to the first-30-minute range/VWAP; a trailing stop after fill; a position cap (the operator's stated 10% of the IRA ≈ $46K sits inside the $50K notional guardrail).
- **Done when:** the watch fires on the public S-1 filing; the reminder sequence fires at T-3/T-1 days and T-0 morning with the schwab.com link; the playbook's orders are dry-run-listable for the chosen account before pricing day.

### Trading surface — CSP-strict cleanup + sub-tab race for research loaders (ADR-136 D2 tail)
- **Remaining:** the split shell boots from app.js on DOMContentLoaded (no inline `<script>`), but the moved view code still wires many actions through inline `onclick=` attributes, which strict CSP (no `unsafe-inline`/`unsafe-hashes`) blocks; convert to delegated listeners per view. Also: `subTabs()` stamps `#tabbody` with a generation and the journal/performance loaders honour it, but the Lab/Studio/Tuning/Recommendations/Algorithms/Capture loaders still paint without checking `tabStale(gen)`, so a slow response for the previous sub-tab can overwrite the one just selected (non-money surfaces; the account-money loaders are guarded).
- **Done when:** the trading surface renders and every action works with `CSP_MODE=strict` on the dev box (zero CSP reports for /api/trading/*), and a spec proves every `async function load*` in tools/ui captures `tabGen()`/`RENDER_TOKEN` before its first await and bails after it.

### Deploy modes — `codebase` vs `codeless` development posture (ADR-137 amendment A)
- **Remaining:** the operator's fourth axis is recorded, not built: a `codebase` swarm may modify its own code through the developer rails; a `codeless` swarm (installed from Docker images only) may not, and files defects to a tracker (repo issues or Bugzilla) instead. Needs a posture read in `resolveDeployPosture`, a gate on the oshal-developer / self-modification rails, and a defect-submission connector chosen and registered per `docs/partner-app-registration.md`.
- **Done when:** `OSHAL_DEPLOY_MODE` (or a sibling `OSHAL_DEV_POSTURE`) resolves `codebase|codeless`; on `codeless` every self-modification rail refuses with a named reason and a defect ticket lands in the configured tracker from a real failing build; `tests/unit/deploy-mode.spec.ts` covers both; ADR-137's amendment table moves both rows from "recorded" to "built".
