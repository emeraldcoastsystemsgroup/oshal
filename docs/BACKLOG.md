# OSHAL Backlog

This file contains only unfinished or externally blocked outcomes. Completion history belongs in the relevant ADR, runbook, package README, release note, or evidence record; when an item closes, remove it from this queue.

Framework, kernel, shared-service, security-boundary, and orchestration work belongs in this repository. Application-owned work belongs in [`oshal-applications`](https://github.com/emeraldcoastsystemsgroup/oshal-applications); core entries below retain only a framework dependency or a concise pointer to the owning package.

Every item has an observable **Done when**. Live-proof requirements cannot be closed from unit results alone.

The operator's [ranked ten priorities](backlog/next-priorities.md) link each autonomous implementation
outcome to its local proof. This queue retains the remaining rollout and broader acceptance work.

## Promotion, deployment, and regression proof

### Government contracting CRM and contract management
- **Delivered:** connected CRM pages, reviewed source import, proposal/award and post-award lifecycle with scoped UI/API/tools and registered tests. Installed import acceptance preserves source records, ownership and documents. See [the scoped backlog](backlog/government-contracting-crm.md); detailed package work stays private.
- **Remaining:** prove website-origin intake and the source-implemented reviewed deadline tasks through the installed workflow; extend conversion to unlinked intake/no-bid history and add a unified decisions/obligations dashboard. External financial and submission operations retain their separate approval scopes.
- **Done when:** a synthetic opportunity travels from intake through reviewed pursuit and award to a managed contract with linked relationships, decisions, documents and obligations; two-user UI/API/Jarvis permissions pass and the package registers its cases with AI Test Lab on installation.

### Enterprise authorization: user, application, function and record
- **Requested:** application permission schemas imported at installation; direct and directory-group grants; installer-established swarm admin; consistent user authority through applications and Jarvis.
- **Implemented foundation:** imported catalogs, durable policy and browsable applied-change history, central Access Administration, existing principal inventory, Users administration, registered typed tools, package HTTP/controller enforcement and local installer proof. [As-built behavior](security/application-authorization.md) distinguishes these from the complete [ADR-149](adr/149-enterprise-application-authorization.md) target.
- **Remaining:** [AUTH-01 through AUTH-10](backlog/enterprise-authorization.md) retain directory provisioning, live worker revalidation, business-data adapters and rollout evidence. Isolated implementation suites are registered in AI Test Lab.
- **Done when:** one installed business package proves differing user/group function and record rights across UI, API and delegated AI; explicit deny and revocation work; installer root has one authorized winner; test cases register with installation and isolated/live evidence is accurately distinguished.

### Application test cases register with AI Test Lab during installation
- **Requested:** test cases belong to application packages and register automatically on installation, with upgrade/reload/disable/uninstall reconciliation. Reuse existing package `smoke:` validation and verification; richer local/browser/live suites need versioned catalog and runner metadata.
- **Implemented in the current branch:** versioned package catalogs, shared CLI/runtime validation, lifecycle reconciliation, caller-filtered discovery, sealed Node execution, durable versioned results and local catalog-selected schedules. Installed catalogs include Hello, Portrait, Kalshi, the ten-package adoption cohort and Sports Edge's coach follow-up; unavailable fixtures remain explicit. See the [execution guide](testing/package-test-execution.md) and dated run records for each proof scope.
- **Backlog:** [Application Test Lab registration](backlog/app-test-lab-registration.md) contains the prioritized core work, complete public-package worklist, pinned suite inventory and lifecycle acceptance cases. Private package rows remain in the private app repository.
- **Remaining:** add confined database/browser/reference-data fixtures, verify the new linked installation reports on the installed runtime, and finish package-suite adoption with representative installed runs. Historical suite evidence and recurring unit selection are implemented; broad registration remains open.
- **Done when:** each application with existing testing installs its cases into the Lab without per-app core edits; lifecycle and ownership tests pass; unavailable prerequisites remain explicit; every inventoried suite has a disposition and representative installation/run evidence. Registration does not automatically execute all tests.

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

### ADR-134 PR4 hardening tail — schema half DEFERRED (operator decision 2026-09-07)
- **The account-pin half LANDED 2026-09-07** (core; store intelligent-trades 1.10.3): `selectSchwabAccount` is single-account-or-refuse for an unbound book, `loadLegacyBook` resolves the legacy books through their DB row (rethrowing an undecryptable binding rather than degrading to unbound), the autopilot and ledger-reconcile readers adopt it, and `SCHWAB_ACCOUNT_NUMBER` is gone from the adapter, discovery, the cutover script, compose and `.env.example`. Remaining hits are ADR/runbook prose and CHANGE LOG history.
- **Decision:** the cutover's "clean week" gate is met (books cut over 2026-08-27; 0 NULL `book_id` across 16,492 order/decision/signal rows on 2026-09-06), so this is eligible — but it was deliberately NOT taken. It converts a reversible state into a roll-forward-only one on the live money ledger to prevent a defect that is not occurring, and it would restrict `oshal-deploy.sh` auto-rollback, which is a working safety net (it cleanly restored the previous image during a Docker-engine failure on 2026-09-06). The account-pin half of the same item is being taken separately, because that one removes a real hazard.
- **Remaining:** `book_id` NOT NULL on orders/signals/decisions; drop the legacy per-mode unique indexes and the three fill triggers; the config-overrides "active implies a book" CHECK; and the deploy rollback floor. Three defects in the drafted plan must be fixed before it ships, all found by its adversarial review: (1) the rollback floor was anchored on migration 124, but the hazard image is a *descendant* of 124 and still pre-hardening, so the ancestry check would PASS the exact image the floor exists to refuse — anchor it on the hardening migration's own add-commit and prove the refusal with a case computed from git, never a typed SHA; (2) the plan edits the runtime schema rail as well as the migration, so ANY `npx vitest` run of the trading suite would apply the hardening to the live database, during market hours, with no `app_migrations` row — prove the migration inside a rolled-back transaction or gate the spec on the cutover script's market-closed check; (3) the legacy-book loader must fall back only when `loadBook` returns null, never when it THROWS, or a decrypt failure silently becomes an unbound book.
- **Also required before it ships:** convert the five kernel writers that still lean on the fill trigger or the legacy index (swing dispatch, the three research captures, reconcile-ledger, and the two host CLIs) — a straggler means a live insert, including a protective exit, fails closed after NOT NULL.
- **Reversal window:** the reverse SQL is only constructible while cross-book `(user_sub, mode, key)` collisions are 0 (verified 0 on 2026-09-06). Two live books are enabled, so that window closes on its own once both trade the same symbol — after which the doctrine is roll-forward-only whether or not this lands.
- **Cheaper substitute, already possible:** a detector instead of a constraint — the books-aware watchdog can alert on any book-less row and gives the same protection with no irreversibility.
- **Done when:** the operator asks for it (or a book-less row actually appears, or a third live book is about to be enabled); the three plan defects above are fixed; the legacy-shaped book-less INSERT is REJECTED on the live schema; `git grep SCHWAB_ACCOUNT_NUMBER` hits only history; and the deploy refuses auto-rollback to any image predating the hardening, proven by a case whose anchor is computed from git.

### Trading DB specs race on schema bootstrap
- **Remaining:** running the trading unit specs WITHOUT `--no-file-parallelism` fails three pre-existing specs (trading-books-schema, trading-event-plans, trading-pinned-lots) in `beforeAll` with `trigger "trg_trd_signals_book_fill" … already exists` — the trading schema bootstrap takes the no-lock path, so two concurrent bootstraps collide. Observed 2026-09-06. The dispatch golden-plan spec works around it locally with a single retry; the underlying files were outside that item's ownership.
- **Done when:** the bootstrap takes an advisory lock (or tolerates the concurrent create) and the same ten-file trading set is green without `--no-file-parallelism`.

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

### Strategy Studio and Bot Forge conversational parity — Studio half PROVEN 2026-09-06
- **Proven:** a live design → refine → refine → apply (paper) → revert cycle updated ONE strategy row (same id; library 84 → 85 → 85 → 85 → 84 rows) through the model rail, and the paper book's active strategy read exactly as before the run — [studio-parity-proof.md](apps/trading/studio-parity-proof.md).
- **Remaining:** Bot Forge edit-in-place for an existing pack, only if that follow-up is commissioned.
- **Done when:** if Forge edit-in-place is commissioned, it re-emits the same pack rather than a duplicate.

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
- **Remaining:** update `docs/building-a-bot.md` and the bot-registry section of CLAUDE.md to explain monitoring inherited from `x-bot-common`; container-label discovery makes a manual scrape-target step unnecessary.
- **Done when:** both surfaces state that a bot inheriting `x-bot-common` is scraped automatically, and neither instructs anyone to edit `ops/monitoring/prometheus.yml`.

### Monitoring overlay does not survive an ungraceful engine stop (BUG-21 tail)
- **Remaining:** BUG-21 closed 2026-08-14 (#213) — the overlay is started by `scripts/oshal-up.sh`
  and guarded by `scripts/monitoring-liveness-check.sh`, and both work. But it recorded the exit 255
  as "unexplained rather than diagnosed", and on 2026-09-13 that tail recurred with a reproducible
  trigger. After the Docker engine stopped ungracefully, `oshal-local-prometheus` and
  `oshal-local-alertmanager` each recorded exit **255** and were NOT restarted, while every container
  recording exit **0** (`oshal-local-api`, `oshal-local-cadvisor`, all forty bots) came back normally.
  All four inspected carry the same `restart: unless-stopped` and all finished at the same instant
  (2026-09-14T00:19:02Z); Prometheus's own log shows routine TSDB compaction right up to the stop, so
  it was killed, not crashed. Net effect: the fleet auto-restarts **monitored by nothing** and
  `docker ps` looks correct the whole time, until a human runs `oshal-up.sh`. The exit-code
  correlation is observational — WHY 255 defeats `unless-stopped` here is still undiagnosed and is
  the first thing to establish. Note the stack watchdog does not cover this: it probes engine, api
  and bot heartbeats, not the overlay (and is currently paused by operator request).
- **Done when:** an ungraceful engine stop (the stack up, then the Docker VM killed) followed by an
  engine start brings Prometheus and Alertmanager back WITHOUT `oshal-up.sh` — or, if Docker's
  restart behaviour cannot be changed, something that is not a human notices within one scrape
  interval and says so. `monitoring-liveness-check.sh --strict` is already the assertion; what is
  missing is anything that RUNS it when nobody is watching. A regression guard must cross the
  restart boundary (stop the engine for real, restart, assert without the bring-up script) — a
  compose-config or mocked-docker test is not closure evidence for this failure.
- **Observed again 2026-09-14 — a second occurrence the same night, and on a third container.** The
  Docker engine went down under host memory starvation and was relaunched at ~03:52Z (session
  ddb0aed5 recorded the engine pipe absent at 03:51Z). Every container auto-started out of order and
  nobody ran `oshal-up.sh`. Read at 04:05Z, BEFORE any bring-up: `oshal-local-prometheus`
  Exited (255), `oshal-local-alertmanager` Exited (255), and `oshal-local-api` Exited (255) finished
  2026-09-14T03:54:35Z with `RestartCount` 0 — all three carrying `restart: unless-stopped`, while
  every container that recorded exit 0 was already running again without help. `docker ps` looked
  correct for the running set throughout and nothing reported that the observers were gone;
  `scripts/monitoring-liveness-check.sh` passed (35 targets, all up) only after this session chose to
  run `scripts/oshal-up.sh` at 04:05Z. That sequence — stack up, engine stopped ungracefully, engine
  started, and the two containers checked WITHOUT the bring-up script — is the reproduction the
  done-when asks for, arrived at by accident: the first was at 2026-09-14T00:19:02Z (recorded above,
  PR #440, commit 8c0d34ec), this is the second the same night, and both times they did not come
  back. Two things this does NOT establish. (1) Why exit 255 defeats `unless-stopped` while exit 0
  does not is still undiagnosed; this is a second dated observation of the symptom, not an
  explanation of the mechanism. (2) `oshal-local-api` recorded exit 255 and also did not come back,
  which is the same symptom on a third container — the first occurrence above lists the api among
  the exit-0 containers that recovered, so the pattern is wider than the two monitoring containers
  and is not specific to the overlay. Open for the operator and deliberately not decided here: the
  stack watchdog that could run the liveness check unattended is PAUSED by operator decision since
  2026-08-07 (`scripts/oshal-stack-watchdog.ps1`, pause file under `%LOCALAPPDATA%\oshal\`) because
  Docker must not start by itself, so anything that closes this has to observe without starting the
  engine.

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

### Deploy — the api process exits during the bot-recreate storm
- **Remaining:** on the 2026-09-05 deploy of f59494b7, while `oshal-deploy.sh` recreated the 34 bots the api sat above 200% CPU, host-port HTTP timed out for about three minutes, and the process then exited (exit 1) on `terminating connection due to idle-in-transaction timeout` raised through process-crash-guards (api log 04:43:20Z; `docker events` shows die then start). Docker restarted it in the same container, it was healthy about 40 s later, and the gate reported DEPLOYED with the advisory scan counting 19 error lines — so a deploy currently carries roughly a minute of api downtime that only the container's RestartCount records. Which transaction idles through the storm is not yet identified.
- **Done when:** a full `oshal-deploy.sh` run on the dev box recreates every bot with the api container's RestartCount unchanged and zero `idle-in-transaction` error lines in the api log for that window, proven by a log/inspect probe recorded in the real-boundary audit; if the fix is pacing the recreate rather than closing the transaction, the deploy log says so.

### A store build can leave package sources behind in the kernel's `src/app/routes/`
- **Remaining:** observed 2026-09-09 — seventeen untracked files (`package-smoke.ts`, `sports-*.ts`) sat in core's `src/app/routes/`, byte-identical to `sports-edge/src-routes/` in the store checkout, with an mtime hours older than the session that found them; a concurrent session removed them by hand. The store compiler stages sources under core's `src/` and clears them in a `finally` (the store repo's `scripts/security/rebuild-store-routes.mjs`, staging prefix `__oshal_store_parity_`; core's [scripts/oshal-app.js](../scripts/oshal-app.js) `build` has the same shape), so either that cleanup can lose a race or an interrupted build skips it — the exact trigger is not established and reproducing it is the first task. The hazard is Rule 0c: `check-repo-separation.js` only inspects **tracked** paths, so leaked sources pass every gate until someone stages them, and a single `git add -A` would land application code in the kernel.
- **Done when:** an interrupted/failed store build is proven to leave `src/app/` byte-identical to its pre-build state (a test that kills the compile mid-run and diffs the tree), and the separation guard additionally fails on **untracked** application-shaped paths under `src/app/routes/` so the leak is caught by the gate rather than by a person reading `git status`.

### The nightly gate has been red for 46 consecutive runs — trivy is a budget decision, not a fix
- **Remaining:** [BUG-22](operations/bug-log.md) recorded twelve straight failed nights on 2026-08-13; the streak is now **46 runs, first failure 2026-07-27**, and `trivy` is red in nearly all of them. The gate scans a `docker save` tarball of the freshly built image and fails on its findings, so "fix trivy" means one of three things and only the operator can choose: accept a documented CVE budget (severity floor, allowlisted CVE ids with expiry dates), rebase the image onto a base with fewer findings, or downgrade the gate to advisory and report findings without failing. Today it fails on a set nobody has read, which is the same as not scanning. The last full report on disk is `%LOCALAPPDATA%\oshal\trivy-report.txt` and it is from 2026-07-09 — nine weeks stale, so the current finding set is not actually known.
- **Done when:** a fresh trivy report is captured and read; the chosen posture is written into `scripts/ci-local.sh` next to `gate_trivy` with its rationale (budget file with expiries, new base image, or advisory-only); and the gate's result is either green or deliberately non-failing — never red-and-ignored.

### `unit` and `e2e-green` have been red for 46 nights and have never been triaged
- **Remaining:** both gates appear in essentially every failed run since 2026-07-27, and no run log records WHICH specs fail — `ci-local.log` keeps only the per-gate PASS/FAIL line, and `ci-local-last-run.log` is overwritten each night. So the failure set is unknown, and it is not safe to assume it is the same set it was in July: BUG-15/16/17 are three known-red specs, but `unit` was already red on 2026-08-03, eight days before the PR that landed two of those guards. The obvious first move is a single clean run against a pinned `origin/main` export on a quiet box, with the spec-level output kept.
- **Done when:** one `bash scripts/ci-local.sh --head` run completes on an idle box with the unit and e2e output retained; each failing spec is either fixed or has a dated quarantine entry naming what is deferred and why; and `ci-local.sh` retains per-gate failure detail across runs (a per-run log file rather than one overwritten `ci-local-last-run.log`) so the next triage does not start from nothing again.

### The nightly gate runs against a saturated box, so its results are not trustworthy
- **Remaining:** the 2026-09-08 run is the clearest evidence yet that the gate is measuring the host, not the code. It started at 23:30 while the full swarm, Docker Desktop and an editor were running; the box had **0.4 GB free of 15.7 GB**. `head-src` (a `git archive` plus `npm ci`) took **2144 s** and failed, which skipped seven gates including `unit` and `e2e-green`; `secret-scan` then logged `cannot allocate memory` against dozens of files it could not even read; `image-build` ran **55+ minutes** against the 68 s it took in the 10:28 manual run the same day; and the docker daemon returned `500` to an unrelated `docker ps` while it was in flight. A gate that cannot allocate memory does not report on the code — it reports on the host, and it does so in the same red that a real defect would use. This is a scheduling/host decision, not a code change: stop the swarm for the run, move the run to a quiet hour, raise the WSL memory ceiling (`.wslconfig`, not the Docker Desktop slider), or accept and label resource-caused failures distinctly.
- **Done when:** a scheduled run completes without any `cannot allocate memory` in its log and with per-gate durations within the same order of magnitude as a manual run on an idle box; and resource-exhaustion failures are reported as a distinct outcome from gate failures, so an out-of-memory night can never again be read as a code regression.


### The nightly can wedge for hours deleting its own previous export
- **Remaining:** the 2026-09-09 23:30 run never got past `head-src`. That gate's first line, `rm -rf "$GATE_SRC"`, was deleting the `ci-src` export (a full `node_modules`) left behind by the previous night's failed run, and sat there from 00:00:50 until it was killed at ~10:00 — **9 hours, 16 CPU-seconds in total, and no progress across a 20-second sample**. It was not a file lock: an exclusive open on a file inside that tree succeeded, and no running process referenced the path. `robocopy /MIR` from an empty directory then purged the same tree in **39 seconds**. `prepare_head_src` bounds only `npm ci` with a timeout — the `rm -rf` and the `git archive | tar` after it are unbounded — so one hung delete held `ci-local.lock` all night and the run produced no outcome line and no alert at all. It will recur: every run that fails after `npm ci` leaves a `node_modules` export for the next run to delete. The cause of the hang is **not established**; MSYS `rm` against a deep `node_modules` tree is the leading candidate, not a finding.
- **Done when:** the purge in `prepare_head_src` (and the `ci-scan-src` purge in `gate_secrets`) is timeout-bounded and fails loud instead of hanging; it uses a delete that clears a real `node_modules` export on this box in minutes (robocopy mirror-from-empty did it in 39 s); and a run that inherits a leftover export from a failed run reaches its gates and writes an outcome line.
### `secret-scan` reports PASS even when gitleaks could not read part of the tree
- **Remaining:** `gitleaks detect` exits **0** when it fails to read files, so `gate_secrets` records a PASS having scanned less than the tree. Measured 2026-09-10 against `origin/main`: 5 of 5077 exported files logged `could not read file: ... cannot allocate memory` and the gate still passed. Memory pressure is the trigger seen so far, but the exit code says nothing about read failures in general (permissions, a path the scanner cannot open), so a clean `secret-scan` is not evidence the tree is clean. This is the false-green twin of the false-red already recorded in the host-contention entry above: that one is about a red night that is not about the code, this one is about a green night that did not look at everything. The scanner's own stderr already names every unread path, so the signal exists and is simply discarded.
- **Done when:** `gate_secrets` fails (or loudly degrades to a named non-pass outcome) when gitleaks reports any unreadable path, rather than inheriting its exit code alone; a run with a deliberately unreadable file in the export is shown not to pass; and the count of unread paths appears in the gate's log line so a partial scan is visible without opening the scanner output.
### Publish gate: refuse model-attribution trailers at push time
- **Built 2026-09-14 on `fix/publish-gate-attribution`.** `scripts/publish-gate.sh` check 5b refuses a
  push whose commits carry model attribution in the MESSAGE: a `-by:` trailer (`Co-Authored-By` in any
  casing, `Assisted-by`, `Signed-off-by`, ...) naming Claude or Anthropic, the vendor no-reply address
  anywhere, or "generated with / by / using / via" followed by Claude (the tool footer, link or no
  link). It matches case-insensitively on the identifier and names each offending commit by short SHA
  and subject, with the matched line and the reword command. It does not reuse check 5's credential
  exclusion filter, which drops every line holding `<...>` — the angle brackets every trailer's address
  sits in.
- **Scope:** exactly the commits the push publishes. The pre-push hook now calls the gate with
  `--pre-push` and passes git's ref-update lines on stdin. Before this, check 5 read only
  `HEAD --not --remotes`, so a push BY SHA (the private-index recipe) with HEAD on another branch
  published commits the gate never looked at. History the remote already holds stays out of scope —
  by remote-tracking refs and by git's `<remote sha>` — so the 45 attributed commits reachable from
  `main` at `d679b696` (the runbook's step-6 query) do not block anyone's push; removing them remains the operator-run scrub in
  [the runbook](runbooks/model-attribution-scrub.md). The credential / identifier scan keeps HEAD and
  adds the pushed commits, so it only widened.
- **Guard:** `tests/unit/publish-gate.spec.ts`, 26 new cases (43 in the file): 13 attribution
  spellings refused, each row tripping exactly one rule; a clean message, a human co-author, the
  maintainer and prose naming the model all pass; the fix instructions; the unpushed-range and
  already-published scope; the pre-push scope (by SHA with HEAD clean, unrelated work on HEAD, git's
  `<remote sha>` with no remote-tracking refs, a deletion, fail-closed enumeration); and one real
  `git push` through the real hook. Against origin/main's gate and hook all 26 failed and a demo push
  landed an attributed commit on the remote, both from HEAD and by SHA; with the change, 43/43 pass
  and both pushes are refused. 14 of 15 single-point mutations of the gate and hook turned their test
  red; the survivor re-cased a pattern that `grep -i` folds anyway.
- **Live when:** `core.hooksPath` points at the shared checkout's `.githooks`, and the hook runs
  `scripts/publish-gate.sh` from that same working tree, so the wall is up once that tree carries the
  merged files — not at merge time.
- **Still a remedy, not a guard:** a PR description is invisible to every hook;
  `scripts/governance/attribution-scrub/strip_pr_footers.py` (runbook step 7) is how bodies are cleaned.

### Store and private repos have no attribution guard
- **Remaining:** `oshal-applications` (163 commits rewritten) and `oshal-app-private` (49) were scrubbed on 2026-09-12 but carry neither the tree guard nor a push-time check, and their private-plan GitHub settings offer no rulesets. Recurrence there is invisible until someone greps.
- **Done when:** each repo runs an equivalent of `tests/unit/no-model-attribution.spec.ts` in its own gate (store-ci for the store), proven red on a fixture, and its pre-push hook refuses attributed commit messages the same way the core gate does once the entry above lands.

### GitHub-side residue of the 2026-09-12 attribution scrub
- **Remaining:** closed-PR refs `refs/pull/N/head` still reach the old commits (verified on core #426 and #430 after the push) and old SHAs stay viewable at `/commit/<sha>` until GitHub garbage-collects. Only GitHub Support can purge unreachable objects; nothing on any branch carries the attribution and the contributors graph is computed from `main`.
- **Done when:** either a support request is filed for the three repos and a sample old SHA returns 404 while `git ls-remote origin 'refs/pull/*/head'` no longer reaches an attributed commit, or the operator records here that the residue is accepted.

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
- **Source proof:** registered application sources, exact-user settings, announcement cadence, channel delivery and Kalshi producer adoption pass isolated PostgreSQL/HTTP/browser and package tests. [The contract](apps/jarvis-briefings.md) distinguishes announcement cadence from collection schedules.
- **Remaining:** promote core and Kalshi 1.5.0, then verify the settings and eligible untouched defaults through the installed browser and producer path; adopt additional package-owned briefing sources.
- **Done when:** the installed settings surface lists registered sources, per-user changes survive restart, disabled sources never deliver, channel and cadence choices govern announcements, and an eligible user with untouched preferences still receives Kalshi updates.

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
- **Source proof:** manifest loads seed authoritative persona/deployment defaults while preserving
  operator changes; disposable PostgreSQL and deterministic dispatch checks pass. See
  [the implementation reference](testing/manifest-bot-initialization.md).
- **Remaining:** promote the implementation and retain fresh installed-node dispatch evidence
  without hand-seeded configuration, under the existing runtime and authorization requirements.
- **Done when:** a clean-DB manifest load leaves a dispatchable record for every declared node bot,
  a unit guard proves it (and goes red when seeding is dropped), and `dispatch-manifest-worker` to a
  freshly loaded packaged bot succeeds on a box with no hand-seeded rows.

### Queue-dispatched concierge answers carry the app's data context
- **Source proof:** the [specialist context contract](apps/specialist-context.md) inserts authorized
  scalar facts before signed dispatch. Core known-answer/revocation/lifecycle checks and an actual
  package consumer pass locally; the model receives no query or credential.
- **Remote source increment (2026-09-11):** [signed current-rights verification](security/remote-application-execution.md)
  supports direct hosted reasoning without tools, with immutable queued initiators and current
  exact-principal result checks. Its local fixture evidence is recorded separately from deployment.
- **Remaining:** add per-operation authorization to the agentic tool broker before enabling generic
  queued handoffs, promote core and the owning application, and retain a live known-answer handoff.
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
- **Implemented in the current branch:** the exact OAuth callback can receive a one-time state without a session and relays an opaque ticket to the initiating configured origin. Only completion with that origin's authenticated owner and browser cookie exchanges and stores tokens. The provider's fixed callback stays unchanged. Local HTTP/provider fixtures cover cross-domain completion, PKCE, expiry, replay and browser/owner binding.
- **Remaining:** merge/deploy and record a real themed-domain provider connection. Pending ceremonies are process-local: a restart requires starting consent again; multiple controllers require routing affinity across configured origins or a shared atomic ceremony store.
- **Done when:** a connect started from `finance.oshal.ai` (or any `*.oshal.ai` surface) completes and stores tokens without the user pre-logging into `oshal.agenticfederal.us`, a forged or expired state is still refused, and a guard covers the cross-cookie-family origin case.

### The ESPN "Log in + push" button has not reached a running node
- **Remaining:** the button ships in `@oshal/chat` source (core #394) and is proven by unit guards, but nothing on this machine is running it. The satellite executes built `dist/` output, so the node needs `npm run build` + a restart before the Config screen shows the row. **The version bump has since landed and the publish has not** — the repo is at `@oshal/chat` 0.4.0 while npm `latest` is still 0.3.0 (checked 2026-09-09), so no fresh install has the button. Publishing is outward-facing, so it is the operator's call, not an agent's. The capture path itself is also unproven end-to-end: the cookie extraction, the both-halves rule and the connector response shapes are guarded, but no run has yet opened a real ESPN window, read a real jar, and stored a real connection — Electron's `session.fromPartition` and `BrowserWindow` are the boundary the unit tests deliberately do not cross.
- **What this is actually blocking, which is more than a convenience button:** there is still no `espn-fantasy` row in `oshal_connections` (checked on the box 2026-09-09), so every credentialed fantasy path in `sports-edge` — the whole 0.6.0 P(win) optimiser included — has only ever run against fixtures and the public feed. Until a real league is linked, that work cannot be graded, and an unverified objective change is exactly the kind of thing that looks correct in tests and is wrong in a season.
- **Done when:** a rebuilt node shows the ESPN Fantasy row under Config → Accounts; one real sign-in captures the pair and the connectors page reports ESPN Fantasy connected with the SWID as the account; `/api/sports-edge/fantasy/status` reads a private league with it; an `espn-fantasy` row exists in `oshal_connections`; and `@oshal/chat` 0.4.0 (or later) is on npm `latest` so a fresh install has the button. The paste path on `/utilities` is the fallback and now works on its own — that half is live (both fields render, the copy names the two cookies).

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

### Complete and cancel nightly backup checks safely
- **Observed 2026-09-12:** the scheduled live dump/restore diagnostic held a table lock needed by API startup. Cancelling that exact dump restored progress, but the diagnostic still produced passing evidence from a partial restore. The generated evidence was marked incomplete and its original output preserved; release backups were unaffected.
- **Remaining:** require successful completion of both dump and restore, reject partial output, bound execution and cleanup, and coordinate live database checks with the deployment lock. Ensure the scheduled launcher uses the reviewed implementation rather than an older checkout.
- **Done when:** cancellation and restore-error regressions cannot publish accepted backup evidence; cleanup preserves the source database, and a concurrent deployment cannot remain blocked by this diagnostic. Register the executable regressions with AI Test Lab.

## Shared product experience

### Top-level workspaces for complete applications

- **Requested:** a small row of themed workspaces across the top: OSHAL Cockpit, Learning, Create and Intelligent Career. Learning opens Little Monsters directly. Existing supporting navigation stays on the left; additional complete applications belong under More.
- **Design:** [clickable navigation prototype](mockups/cockpit-workspaces.html) and [implementation backlog](backlog/cockpit-workspace-navigation.md). The prototype uses synthetic content; People/HR is proposed and does not imply a delivered HR application.
- **Earlier deployed checkpoint:** Workspace and the separate optional Navigation setting preserve existing pages and the default Sidebar. Current profile synthesis and application permissions determine destinations; Career prefers its admitted group or falls back to its admitted application. The earlier checks passed 114 appearance cases, 50 profile/authorization cases (28 new HTTP cases), 18 Chromium cases, four model cases, one Lab registration assertion and 29 separate catalog regressions. Slow discovery has a bounded thirty-second window and Retry removes expired application links. Native and preservation evidence for that checkpoint remains in the [preceding release record](releases/parallel-backlog-2026-09-11.md).
- **Appearance and navigation:** the deployed palette/header checkpoint is recorded in the [facelift release](releases/workspace-facelift-2026-09-12.md). The subsequent [workspace polish release](releases/workspace-polish-2026-09-12.md) records removal of duplicate navigation, the anchored More menu, quieter header, Create 1.3.0 layout and Stories 1.2.1 palette adoption, with separate source and installed acceptance.
- **Contextual navigation and Career:** the [Career navigation release](releases/career-navigation-2026-09-12.md) records the Federal CRM top tab, delegated sidebar duplicates, retained unique tools and the Job Board/Open jobs search refinement.
- **September 13 delivered presentation:** native acceptance passed compact Home/Jarvis, named Finance, no `Other` shelf, and the centered searchable OSHAL application directory, with the unfinished Jarvis message retained through Refresh, area selection and directory use. The two actual core Lab Run controls passed four readiness steps, including 33 admitted links; they do not execute the linked source suites. See the [release record](releases/daily-dashboard-2026-09-13.md) and [Finance/OSHAL contract](backlog/cockpit-workspace-navigation.md#requested-follow-up-finance-and-the-oshal-menu). Producer/context work below and [startup responsiveness](backlog/cockpit-startup-resilience.md) remain open.
- **Profile feedback implemented in source:** [Profile & Access consistency](backlog/cockpit-workspace-navigation.md#follow-up-profile-and-access-consistency) now has compact themed controls, current destination wording, truthful session errors/Retry and guarded loading/focus. Nineteen new actual-renderer cases and seventeen retained appearance cases were accepted; AI Lab registration is present. Installed acceptance remains in the [integration record](releases/component-integration-2026-09-13.md).
- **Done when:** desktop and mobile users can switch directly into permitted complete applications, use their existing pages, recover context after reload and reach all remaining applications without a crowded top bar. Hidden or unavailable destinations remain enforced at the application boundary. Register actual implementation tests with AI Test Lab.

### Jarvis and a compact daily dashboard
- **Direction confirmed 2026-09-11:** combine application updates and a compact Jarvis area on one useful daily page; keep All applications accessible. The prior separate-surface decision is resolved by this direction.
- **September 13 request, P1:** the user reported an unsatisfactory Jarvis layout and requested a compact assistant beside updates/details, named Finance and miscellaneous tools in the OSHAL menu. The delivered presentation addresses this JDX-01/JDX-02 slice.
- **Reported defects:** overlapping eye/response text, persistent Engineering activity, crowded controls, repetitive Kalshi entries, missing morning reports and fixture/probe cards in Home. Reproduce the causes before claiming a fix.
- **September 13 delivered presentation:** the [release](releases/daily-dashboard-2026-09-13.md) records native compact Home with actual Jarvis, seven named areas, at most four updates and one selected detail; draft retention, centered directory search and portal-theme restoration passed. Backend `0c287223` / image `e92d3468` uses published modal CSS `d8080f56` through the existing pages mount. AI Test Lab's four native readiness steps passed separately from the registered source suites.
- **Remaining:** durable grouping/replay/snooze semantics, additional package-owned briefing sources, and update details connected to context-aware editable drafts. Reuse existing Home summaries, briefing preferences and the validated surface bridge.
- **Done when:** [JDX-01 through JDX-06](backlog/jarvis-daily-dashboard.md) pass actual browser, source, ownership and installed-workflow acceptance. Counts come from owning applications; unavailable sources never appear as zero. A user can open an update, review details, prepare a reply and return without losing context or manual edits.

### ADR-139 — adopt artifact source tags
- **Remaining:** the other client-generated exports now have a rail and are simply not tagged yet — Switchboard's composed post image, camera captures, payroll NACHA files, ocean-lab CAD, workflow-studio JSON. Each is the standard tag over a Blob the surface already holds, not new plumbing. **Plus three packages that serve real bytes over an existing owner-scoped URL and were never tagged** — `storage` (`res.download` of the user's own stored files), `aero-lab` (run artifacts) and `payroll` (the W2 report and its sibling); those need no Blob and no new endpoint, only the tag. The audit also names four packages whose existing import route could back an `accepts:` block with the ~30-line `redeemArtifactViaRelay` adapter: marketing-engine, payroll, switchboard, video. **RAG Center documents are NOT in this set** and are not unblocked: a retrieved corpus chunk is not a file, so what a handle would carry there is an open product question, not a missing route.
- **Done when:** each of those surfaces carries the tag and one dispatch per surface is live-proven; and the RAG Center question is either answered in the ADR or explicitly declared out of scope, so nobody re-attempts it as plumbing.

### ADR-139 — LoRA has no image-ingest route at all
- **Remaining:** "send a training image to LoRA" cannot be built as a destination because nothing on the LoRA package accepts an image over HTTP — its dataset lives as a `<name>.png/.txt` folder on the GPU box (`LORA_BOX_DATASET`). This is a package gap, not an exchange gap: the route has to exist before an `artifacts: accepts:` block means anything.
- **Done when:** LoRA exposes an owner-scoped ingest route that writes into the caller's dataset folder, declares `accepts: [image/*]`, and one image sent from the portrait gallery lands in a named dataset and is visible in the LoRA surface.

### ADR-139 — the little-monsters class-materials destination
- **Remaining:** the Tutor destination ships (an image or PDF becomes the pending homework attachment), but **filing a material into a class** does not. Its route is class-scoped under teacher authority, so it needs a class picker in the receive path rather than the Tutor's context-free attach — the reason it was cut from wave 1 rather than rushed.
- **Done when:** a document sent from the files browser lands as a material in a class the caller may write to, chosen in the dispatch, with a non-teacher's share still going through the existing request-share path; proven by one live dispatch.

### ADR-139 Stage 4a — the source direction: a generic "pick an artifact" picker
- **Implemented:** shared registry-backed source discovery, connected-storage adapter and picker component; Portrait Studio 1.11.0 consumes it and provides its finished-image gallery. The old modal and its private helpers are deleted. Local real HTTP/file/handle/Chromium acceptance passes; see ADR-139 Stage 4a.
- **Remaining:** install Portrait Studio 1.11.0 and record one signed-in selection on the deployed cockpit. The protected core change is merged and deployed (checked 2026-09-14): `21ad8902` is on `main` and an ancestor of `b8de2099`, the PR #431 merge that `scripts/oshal-deploy.sh` deployed that day.
- **Done when:** the deployed picker lists registered sources and a selected authorized image reaches Portrait Studio's crop stage through its owner-bound handle.

### ADR-139 Stage 4b ? the NL leg ("Jarvis, send this to X")
- **Implemented:** Jarvis loads versioned YAML tool metadata with keywords and usage context. An explicitly selected artifact supplies a live compatible/visible destination catalog; strict model proposals resolve to the existing browser dispatcher, retaining owner checks and destination confirmation. Local model-fixture, registry/handle and browser proof are documented in ADR-139.
- **Remaining:** a signed-in turn using the actual model to name a destination; exercise an ambiguous request and a confirmation-requiring destination. The protected core merge and deployment are done (checked 2026-09-14): `62e9e4c1` is on `main` and an ancestor of `b8de2099`, the PR #431 merge deployed that day.
- **Done when:** one live-proven Jarvis turn dispatches the selected artifact to the named destination, outward actions retain their confirmation gate, and ambiguous/unavailable targets return available choices without dispatch.

### Surface theming — visual spot check across themes
- **Remaining:** the gate proves the *mechanism*, not the *result*. Walk the converted surfaces in one light theme and one dark theme and look for contrast casualties — a role mapped to a plausible-but-wrong token (a status hue used as a background tint, a border that reads as text) is invisible to a static check. Highest-risk files are the ones with the largest remaps: `swarm-control.css` (53), `task-explorer.css` (21), `workflow-studio.css` (27 across two passes), and `applications/index.html`, which was authored light and now follows the theme.
- **Done when:** each converted surface has been seen in a light and a dark theme with no unreadable text or invisible border, and any mis-mapped role is corrected at its token rather than by reintroducing a hex.

### Identity Hub expiry reporting
- **Remaining:** the connector list response never emits a per-connection `expired` flag, so Identity Hub's Need-attention tile, expired marker, and red Reconnect pill are dead UI ([BUG-13](operations/bug-log.md)). Derive expiry in `buildConnectorListResponse` from the stored token expiry, keeping the projection credential-free.
- **Done when:** a connection whose stored token has passed its expiry renders the expired marker and is counted by the Need-attention tile and filter; a unit assertion pins the response keys the shipped surfaces read, so dropping a consumed field goes red.

### In-app help: per-surface affordances and first-run
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

### Finance workspace navigation
- **September 13 delivered presentation:** native acceptance confirmed admitted Finance in the top navigation and named daily areas, no `Other` shelf, and searchable miscellaneous apps through the OSHAL menu. Only explicitly delegated sidebar entries are removed. The [release record](releases/daily-dashboard-2026-09-13.md) separates this delivered navigation slice from remaining producer, provider and transaction work.
- **Requested 2026-09-13, P1:** Finance is a named application area alongside the established workspaces. Miscellaneous applications belong in the OSHAL menu, not a dashboard section called `Other`.
- **Done when:** the [navigation follow-up](backlog/cockpit-workspace-navigation.md#requested-follow-up-finance-and-the-oshal-menu) and [daily dashboard](backlog/jarvis-daily-dashboard.md) show authorized Finance destinations and grouped updates, preserve each application's permissions and retain every remaining tool through the OSHAL menu. This is presentation work; provider setup and transaction verification remain separate below.

### Finance package live verification
- **Remaining:** configure Plaid Sandbox and Stripe test credentials, install the [`finance`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/finance) package, then exercise link/sync/brief and one test ACH payment.
- **Done when:** the owning user sees grounded balances/holdings/spend, the payment audit/status reflect the test transfer, another user cannot read either, and no live-money key is present. See [ADR-048](adr/048-finance-aggregation-swarm.md).

### Finance post-v1 rails and governance
- **Remaining:** separately decide real A2A payouts, live-money compliance, broker trade execution, Plaid production access, household labels/sharing, and scheduled forecast/alert scope.
- **Done when:** each commissioned capability has its own approved regulatory/security contract and live or sandbox proof; selecting an unimplemented rail continues to fail loudly.

## Trading and market systems

### Political-trades (STOCK Act) signal has never run on this box
- **Found 2026-09-09:** [`political-trades.ts`](../src/features/world-data/political-trades.ts) is built - it pulls live congressional disclosures and aggregates `congress_buys/sells/net/sentiment/notional` per ticker into `world_metrics` - but **no `world_*` table exists in this database**, so the collector has never executed here and there is no disclosure data to read. The operator explicitly wants congressional holdings in the watchlist, and inventing that list from model memory instead of the feed is exactly the fabrication this repo forbids on money-adjacent surfaces.
- **Remaining:** create the world schema and run the collector, then decide how disclosure names reach the watchlist. Note the module's own caveat before treating it as a trade trigger: the STOCK Act carries a ~45-day disclosure lag, so it is a slow POSITIONING signal, not a next-day catalyst.
- **Done when:** `world_metrics` carries `congress_*` rows with a recorded `observed_at`, the watchlist can be populated from that feed with the disclosure date shown beside each name, and no congressional holding is ever written from anything but the feed.

### Arming a second autopilot leg is a deliberate, gated act
- **Remaining:** make the existing one-book dispatch boundary explicit in an arming acknowledgement and regression guard before any second leg is authorized.
- **Context 2026-09-09:** the rollover book `b-77146871` (CASH ...8271) was enabled at operator request. Enabling is inert for trading on its own - the autopilot resolves ONE book per schedule from that schedule's own `bookId` and never enumerates enabled books - so the book gained watchdog coverage and nothing else. That safety depends on a property that is currently only implied by the dispatch code.
- **Why this needs its own entry:** if a leg is ever armed for that book, three things become live at once - daily gravity rotation (`TRADING_SLEEVE_ROTATION=true`, `TRADING_ROTATION_EVERY_DAYS=1`) against roughly $224k of idle cash, protective exits over positions the operator chose by hand, and the sell side of rotation ("dropped out of the top 33") on names picked for reasons the model cannot see. Note also that pinned lots are NOT a ring-fence for existing holdings: a pinned lot at `open` places real GTC sell orders at the venue.
- **Done when:** arming a leg for a book whose positions were not opened by the engine requires an explicit acknowledgement recorded against that book; there is a guard proving `enabled` alone never widens the set of books a schedule dispatches; and the operator-facing copy states plainly that a hand-picked position under an armed leg is subject to rotation sells.

### Queued paper-to-live parity features
- **Remaining:** implement and soak the market-wide gap-down entry filter, immutable per-position exit plan, and idle-cash yield sleeve in paper before any live promotion.
- **Done when:** paper and live share one guarded algorithm/config path, historical and shadow evidence records impact, and promotion requires the existing explicit confirmation. See [ADR-052](adr/052-stock-trading-swarm.md).

### Trading platform surface and engine expansion
- **Done (intelligent-trades 1.11.0, 2026-09-07):** the asset/sector allocation panel, the active stop/take-profit panel, and "default to the full supported universe" — arming no longer pins `DEFAULT_UNIVERSE` into any leg's `taskData`, the ceiling is `TRADING_UNIVERSE_MAX_PIN` and refuses rather than truncates, and `GET /autopilot` reports `universeSource`. Recorded as-built in [ADR-136](adr/136-trading-surface-information-architecture-and-direct-trades.md) D10.
- **Remaining:** design futures/intraday/long sleeves plus a roughly 200-symbol multi-market universe. The sleeves ADR must be numbered **144** — 142 and 143 are both taken.
- **Done when:** every added sleeve is paper-proven behind kernel risk gates.

### SK Hynix sleeve graduation
- **Remaining:** after reliable permanent-ticker history exists, remove the temporary core exemption and evaluate the position through the normal sleeve/risk model.
- **Done when:** the permanent symbol is used consistently, the position has ordinary data/stop/exit coverage, and no IPO-specific bypass remains without an explicit rule.

### IPO event-play design (ADR-142)
- **Designed 2026-09-06:** [ADR-142](adr/142-ipo-event-sleeve.md) reconciles this item against the shipped ADR-136 D6 executor. Verdict: D6 v1 IS the sleeve's skeleton (single-issuer universe fixed by the EDGAR 424B4, day LIMIT at IPO × (1 + premium), percent/dollar sizing under the fleet guardrail, take-profit and stop GTC plus a time stop, one `event-playbook` order path on a gated leg). The generic pop-catcher stays closed and is not reopened — an IPO is a scheduled single-name event, not a latency race.
- **Remaining:** five optional gates whose defaults reproduce today byte-for-byte (opening window, stale/halt proxy at entry, a spread cap shipped DISABLED because no real-time consolidated quote exists on the paper key, a sleeve ceiling plus a settled-cash cap sequenced after the cash-settlement item, and out-by-close), each with its real-DB guard; the `TRADING_EVENT_PLANS_LIVE` paper-acceptance hold that blocks a NEW live entry while still managing a filled plan's exits — today `defaultDeps().place` passes `confirm=true`, so an armed live plan CAN place a real order and this item's "no live order possible" criterion is not met yet; then pre-register and run the listing-day study over the EDGAR-dated 424B4 fixture (SIP and IEX replay, spread sweep on SIP only, 2025+ holdout) and ratify its acceptance bar, which deliberately departs from the 200-trade house arming bar.
- **Done when:** the study's RESULT row is in strategy-log.md with at least 20 listing days and the IEX replay beside the SIP one; a live-book plan at priced/listed records `live_hold` and places nothing while the flag is absent (real-DB spec), while a filled live plan's exits are still managed with the flag off; one paper plan has closed end-to-end on a real listing; and the flag flip is a compose-env action with a strategy-log row.

### Market-data stream decision — DECIDED (ADR-143), build pending
- **Decided 2026-09-06:** [ADR-143](adr/143-market-data-stream.md) names the v1 source per book (Alpaca IEX v2 websocket for Alpaca-backed books, terminated in the kernel; Schwab books keep the 5 s REST poll), the entitlement/staleness guards and their env names, the payload allowlist and the specs, quantifies the IEX gap from the 2026-07-12 strategy-log measurements, cites the two intraday studies with their exact feed (neither ran on a stream), and decides no feed purchase for v1 with named purchase triggers.
- **Remaining:** ADR-143 D9 Phase 1 (kernel `market-data-stream.ts` + barrel + compose/env passthrough + `tests/unit/trading-market-data-stream.spec.ts` + `compose-trading-stream-gate.spec.ts`) and Phase 2 (store `trading-quote-stream-routes.ts`, `tools/ui/quote-stream.js`, `tests/trading-quote-stream.spec.ts`); the operator arms `TRADING_STREAM_ENABLED` after confirming nothing else streams with the paper key.
- **Done when:** the ADR's Phase 1 and Phase 2 guard specs are green, a dated regular-hours observation of prints on the deployed paper ticket is recorded in the real-boundary audit row, and the ADR Status reads "shipped".

### Kalshi calibration and demo paper fill
- **Remaining:** restudy ask-basis calibration with staleness, bounded randomized sampling, cluster-bootstrap intervals, regime/date splits, monotonic probability, fees, and multiplicity adjustment; then save a demo connection and fill/settle one paper order.
- **Done when:** the published calibration passes those gates and one caller-attributed paper trade records quote-at-signal, fill, settlement, and P&L. Track UI/package work in [`kalshi`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/kalshi).

### Kalshi: market signals and world news as pre-registered strategies
- **Context (2026-09-04):** the graded record (2,447 settled predictions) shows both scan strategies losing to the market in every price band before fees; two contrarian variants are pre-registered as zero-stake forward tests (`contrarian-extreme`, `contrarian-weather-disagree`). The operator's next direction is to add market signals (Kalshi price/volume history via `getCandles`) and world news as inputs. The news archive that exists on the box is `oshal_content_articles` (7.9k rows, `published_at` through today, sources msn/HN/Yahoo Finance/Forbes/CNBC/TechCrunch); the world app's `world_items` table has never been created here (no pull has run).
- **Remaining:** (1) a market-signal strategy over Kalshi candles that can be BACKWARD-run on the tape because it does not depend on our model (e.g. price momentum / mean reversion into settlement per series), scored blind-forward like `oshal-trading-news-materiality-backtest.ts`; (2) a news-signal strategy that maps headlines to open Kalshi markets with the headline's `published_at` strictly before the quote used, pre-registered through `kalshi_predictions` at zero stake; (3) neither may bypass the fee/Kelly/judge machinery, and no third contrarian variant without pre-registration.
- **Done when:** each new strategy has a written rule dated before its first prediction, ≥ MIN_GRADED (30) settled rows on the Scorecard tab, and a Brier no worse than the market's before any stake is proposed; the backward run cites the exact candle range and series and reports the overnight/latency cohort separately; the news mapping is reproducible from `oshal_content_articles` rows alone.

### Kalshi books and execution like the stock side (paper/real × manual/auto)
- **Context (2026-09-05):** the Trends tab (kalshi 1.2.0) shows the four books. Only two exist today: *Paper · auto* (the prediction ledger, one contract per pick, graded at settlement) and *manual* orders (demo or live, confirm-gated). The operator wants the full ADR-136 stock-side treatment: sized paper trades, a per-book journal, projections, "pops", and eventually real auto-trades. Cost/benefit, so the order is a decision and not a drift:

  | Book / feature | Exists | Cost | Benefit now | Gate |
  |---|---|---|---|---|
  | Paper · manual (demo exchange) | yes | 0 — paste a demo key on /utilities, *make default* | exercises the order rails with fake money | none |
  | Real · manual (live exchange) | yes | 0 — `KALSHI_LIVE_ENABLED=true` + redeploy | real fills when the operator chooses to bet by hand | operator decision |
  | Paper · auto **with sizing** (Kelly-sized paper fills from the ledger, a bankroll curve instead of one-contract P&L) | no | ~1 day (stake is already computed; add a paper-fill table + bankroll roll-up + a Trends line) | shows what a bankroll would have done; the number people actually ask for | must stay labelled *paper* everywhere — a sized curve reads as money |
  | "Pops": price since announced for open alerts, from `getCandles` | no | ~0.5 day | shows whether the market moved toward or away from a pick before settlement | rate-limited public tier (~3 rps) |
  | Real · auto (autopilot on the ADR-052 rails: decision-FK, caps, kill switch, no confirm dialog) | no | 3–5 days | **zero until a strategy is PROVEN** — every strategy is FAILING or UNPROVEN today | never before a PROVEN row on the Scorecard, and then double opt-in like `TRADING_AUTOPILOT_LIVE` |
- **Remaining:** in that order — sized paper-auto book, pops column, then (only on a PROVEN strategy) the autopilot design as an ADR-094 amendment.
- **Done when:** the Trends tab's Paper · auto tile and curve are bankroll-based and labelled paper; open alerts show price-since-announced; and Real · auto is either still "not built" with the gate stated, or built behind a PROVEN scorecard row plus a double opt-in flag, with orders audited like the manual path.

### Trading watchdog hardening — the rest of the checks (ADR-134 D3.7)
- **Remaining:** quote volume/recency corroboration beyond the pre-market gap check; ~~broker-number parsing~~ (shipped in the same change, #354 — `toNumber`, the "strict broker-number parse" in `scripts/lib/trading-watchdog-checks.js`, which throws on anything that is not a plain finite number; checked 2026-09-14); and the deliberate narrowing recorded in ADR-134 — "uncovered position" for autopilot-managed names is approximated as held-past-the-stop rather than reconciled against the venue's own working stop orders, because the watchdog reads the ledger, not the venue.
- **Done when:** the remaining checks ship with the same mutation guards, and the uncovered-position check compares against venue-resident stops rather than a loss threshold.

### Futures extension layer (ADR-116)
- **Phased 2026-09-06:** [futures-phasing.md](apps/trading/futures-phasing.md) records what exists on disk today (the backtester and adapters, the Kibot ES/CL archives running to 2025-12-31, and an empty `market_bars`) and splits the remaining work into five independently shippable phases with an evidence gate and an explicit stop-line.
- **Remaining:** Phase 1 evidence rail (config/output flags on the backtest runner, a frozen-constant walk-forward in-sample/out-of-sample driver, the ensemble-exit and percent-ATR buffer sweeps, the Kibot env documented); Phase 2 the six-stage locked-winner optimizer inside that walk-forward on every market with bars on disk — this is the evidence gate; Phase 3 ingest the archives into `market_bars`; Phase 4 a durable paper book with stop triggers, behind an operator approval gate; Phase 5 cockpit coverage. The fail-closed live adapter and contract risk semantics are NOT scheduled: they open only if Phase 2 out-of-sample is positive on at least one market AND the operator names a futures-approved account and vendor.
- **Done when:** the Phase 2 out-of-sample report is published in futures-backtester.md and ADR-116 carries an amendment stating which way it fell — a negative result closes the live items as "do not build live", which is an acceptable end state. The paper and UI phases carry their own done-whens in the phasing doc.

### The armed book's stop-loss measures against the venue's adjusted cost basis (2026-09-13)

- **Found on the live book:** the engine takes its entry price from the venue's reported position average
  ([schwab-broker-adapter.ts:672](../src/features/trading/services/schwab-broker-adapter.ts#L672) → `avgEntryPrice`),
  and that number carries the broker's **wash-sale adjustment**. After the engine sells a name at a loss and its own
  rotation re-buys it inside 30 days, the disallowed loss is folded into the replacement shares overnight, so the
  next session's first fire reads a 5–18% loss on a position that is flat or up on the price the engine actually
  paid — and stops it out, which books a bigger disallowed loss into the next re-buy. Over one week the re-entries
  it stopped were mostly names that had not moved anywhere near the stop distance, several of them sold for a gain.
  The same figure is stamped into `cost_basis`, so recorded `realized_pnl` and every report over it are overstated
  by the carried amount. The arithmetic was verified to the cent across three consecutive round trips.
- **Second, related finding:** the autopilot manages every position in the account it is armed for, because it reads
  live venue positions rather than its own ledger — a hand-placed position was cap-trimmed about three minutes after
  it filled. That is the hazard ["Arming a second autopilot leg is a deliberate, gated act"](#arming-a-second-autopilot-leg-is-a-deliberate-gated-act)
  reserves for a second book, already live on the first.
- **Remaining:** both fixes, with their done-when criteria and the code references, are written up as items 21 and 22
  (numbered 5 and 6 until 2026-09-14, when the file's duplicate ids were made unique)
  in [backlog/trading-advisor.md](backlog/trading-advisor.md) — the engine must own its entry price, and it must
  manage only the positions it opened. Neither is started; the operator has not chosen between fixing the core,
  ring-fencing symbols with `TRADING_CORE_SYMBOLS=SYMBOL:0`, and pausing the live leg.
- **Done when:** the two trading-advisor items are closed on their own criteria.

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

### The nightly trade recap has failed at the render-node lease since 2026-08-06

- **Found 2026-09-12:** every scheduled run since the shared render-node lease landed has stopped at
  `could not acquire the shared render-node lease: node-lease CLI returned no JSON`, and the alert rail has emailed
  a failure every day (weekends included). Cause: `Enter-SharedNodeLease` passes a compact JSON string as an
  argument to a native command ([run-daily-recap.ps1](../scripts/run-daily-recap.ps1) `--metadata-json`), and
  **Windows PowerShell 5.1 strips the embedded double quotes from native-command arguments**, so the CLI receives
  `{requestedDate:...}` and refuses it at position 1. Reproduced directly: a `ConvertTo-Json -Compress` value sent
  through `docker exec` arrives unquoted. The scheduled task runs `powershell.exe`, so PowerShell 7's fixed argument
  passing never applies. Secondary defect in the same path: the lease is acquired **before** the market-calendar
  check, so non-trading days fail and alert instead of exiting quietly.
- **Remaining:** pass the metadata so it survives 5.1 native-argument handling (escape the quotes, or hand the value
  over stdin / a file / discrete flags rather than one JSON argument), move the calendar check ahead of the lease,
  and add a guard that would go red on the quoting regression. The last recap that reached the operator was
  2026-08-03; 2026-08-04/05 failed earlier in the chain, at render-node reachability.
- **Done when:** a scheduled run acquires the lease and completes end to end, a non-trading day exits without an
  alert, and a spec covers the argument round trip. Recovery detail is in
  [runbooks/daily-trade-recap-pipeline.md](runbooks/daily-trade-recap-pipeline.md); the pipeline is
  [ADR-074](adr/074-daily-trade-recap-pipeline.md).

### Daily Trade Recap's Home tiles count a table the production path never writes

- **Found 2026-09-12:** the `daily-trade-recap` package's Home summary counts rows in `workflow_runs` for its ticket
  type, but the production recap is a host scheduled task that creates no ticket and no workflow run — so the four
  tiles read `0` on a good night and a bad one alike. There are no `workflow_runs` rows for the type at all; the
  ticket path was last exercised in June, and three of those tickets still sit at `approval_required`, which the
  "needing review" tile does not count either (it counts workflow-run states, not ticket states).
- **Remaining:** decide which record is the truth for this app — have the nightly runner record a run for its ticket
  type, or point the summary at what the runner already writes (its dated artifacts and run log) — then make the
  tiles reflect it. Whichever is chosen, a tile that cannot distinguish "never ran" from "ran fine" is the defect.
- **Done when:** a completed nightly moves a tile, a failed nightly is visible on Home without opening a log, and
  the stale June tickets are resolved or shown. See [ADR-074](adr/074-daily-trade-recap-pipeline.md).

## Device, edge, spatial, and operations domains

### Headscale as standard practice, so an off-LAN node can actually join
- **Built and unrun:** the off-LAN path is complete — [ADR-013](adr/013-headscale-self-hosted-overlay-network.md) is Accepted and implemented (`infra/headscale/` compose + config + hardened ACL policy, `scripts/headscale-setup.sh`, `scripts/headscale-enroll-worker.sh`, the `headscale-http` A2A transport, an ACL guard, and [the enrollment runbook](runbooks/remote-swarm-node-enrollment.md)), and `installer\lib\install-swarm.ps1 -OffLan` mints a Headscale pre-auth key packed into an `OSJOIN2` join code. **But Headscale is not part of the default stack** — on the operator's own box the container has been `Exited` for four weeks, and `Test-ShouldGoOffLan` "returns $false the moment Headscale is absent", so an off-LAN request silently degrades to a LAN-only `OSJOIN1` code. Someone who downloads the open source and tries to connect a machine over the internet therefore hits a dead end that reads like a missing feature rather than a service that was never started.
- **Remaining:** decide whether Headscale joins the default bring-up (operator call — it is an outward-facing network service, so default-on deserves the same opt-in scrutiny as any other outward behaviour), or stays opt-in but **fails loudly**: `-OffLan` should refuse with "Headscale is not running, start it with scripts/headscale-setup.sh" instead of quietly emitting a LAN-only code. Whichever is chosen, `oshal-up.sh` should report Headscale's state alongside the rest of the tier so "why can't my laptop join" is answerable without reading four files.
- **Done when:** a machine on a different network completes the documented path end to end — join the overlay, enrol as an edge node, reach the API — and a deliberately stopped Headscale produces a message naming the cause instead of a join code that cannot work. Relevant to [ADR-135](adr/135-print-to-swarm-and-print-to-rag.md) P2: an edge printer off the LAN needs exactly this reachability before its device-bound credential is worth anything.

### Data-model explorer: deployed — prove it on the box
- **Current state:** the explorer is built, reviewed, merged and deployed — the
  `src/features/data-model` slice, `/api/admin/data-model` (operator-only), the `/data-model` page,
  the Admin-console tool link and the **Data model explorer** Test Lab card. `npm run test:data-model`
  was 51/51 on `18edcbf4` (including a disposable-PostgreSQL catalog read and the page in Chromium),
  the publish gate was clean and the typecheck added no errors. Checked 2026-09-14: `18edcbf4` is on
  `main` and an ancestor of `b8de2099`, the PR #431 merge; `src/app/server.ts` at `b8de2099` mounts
  `/api/admin/data-model` behind `requiresAuth` + `requiresOperator`; and `scripts/oshal-deploy.sh`
  deployed `b8de2099` that day (image `1fe73566ae87`). The deploy this entry waited on is done.
- **Remaining:** walk all four views against real data as an operator and run the Lab card. Record the live
  counts — tables, apps, integration links and, in particular, the unowned relations the snapshot
  reports — so the first real reading is on the record rather than inferred from the fixtures.
- **Done when:** an operator loads `/data-model` on the deployed stack, each view renders from the
  live databases, the Lab card reports `pass` with its counts, and those counts are posted in
  `COLLABORATE.md` or the deploy runbook. See [the explorer guide](architecture/data-model/explorer.md).

### Data-model explorer: one implementation behind both the docs and the surface
- **Current state:** the catalog SQL, the RLS row-scope classifier and the static DDL parser exist
  twice — once as CommonJS in `scripts/schema-docs/` (the committed-docs generator, core #424/#425)
  and once as TypeScript in `src/features/data-model/` (the live surface). They are pinned together
  by `tests/unit/data-model-catalog.spec.ts`, which fails the moment the two disagree, so the risk
  today is duplicated maintenance rather than silent drift.
- **Remaining:** collapse them to one implementation — either run the generator through `tsx` so it
  imports the feature slice (the repo already runs `scripts/*.ts` that way), or extract the three
  pure pieces into a module both can load — then delete the copy and retarget the parity spec at
  whatever boundary remains.
- **Done when:** one copy of each piece ships, `node scripts/generate-schema-docs.js` (or its
  replacement) regenerates `docs/architecture/data-model/` to a zero diff, `npm run test:data-model`
  stays green, and the parity spec either covers the new seam or is removed with its reason recorded.

### Data-model explorer: schema drift as an alarm, not a page someone remembers to open
- **Built 2026-09-14 (the snapshot+diff half; nothing is emitted yet).** The explorer now has a
  durable memory. `buildDigest()` reduces a snapshot to a **structure-only** digest - per relation:
  owners, RLS state, policy NAMES, key columns (primary key plus every foreign-key column) and
  foreign-key targets - plus the applied-migration count and a sha256 fingerprint. It deliberately
  carries no column defaults, no non-key columns and no policy expressions, because a digest is
  persisted and inherits the explorer's operator sensitivity; a spec asserts none of those strings
  survive into the stored JSON. `diffDigests()` compares against the stored baseline and
  **classifies** rather than just reporting: `first-run` (nothing to compare), `unchanged`
  (identical fingerprint), `explained` (the `app_migrations` count moved between the two readings,
  so the change was migrated), `settling` (the baseline is inside a 15-minute quiet window, so a
  mid-deploy reading waits for the shape to hold) and `drift` - the only state that sets
  `alarm: true`. A reading that lost more than half its relations is **refused**
  (`SCHEMA_DIGEST_PARTIAL`, HTTP 409) rather than reported as a dropped schema, and so is a digest
  written by another `digestVersion`. Files: `src/features/data-model/services/schema-digest.ts`
  (pure), `.../drift-store.ts`, `drift()` on `data-model-service.ts`, the two new ports in
  `types.ts` / `src/app/data-model-ports.ts`, and `GET /api/admin/data-model/drift` under the same
  `requiresAuth` + `requiresOperator` mount. A read never advances the baseline - opening the page
  must not silently acknowledge a change - so `?capture=1` is the only thing that records one.
  `scripts/migrations/139-schema-digest-history.sql` creates `oshal_schema_digest` (one row per
  distinct shape per database, unique on `(database, fingerprint)`, forced RLS, operator-only) and
  follows the runner-owned-transaction pattern, so it does **not** join the 127-137 self-managing
  group. `tests/unit/data-model-drift.spec.ts` (22) covers the digest, all five states, the four
  refusals and the store's degrade-by-name when the migration is absent; three cases in
  `data-model-routes.spec.ts` cover the mount's refusals **by response body**.
  `npm run test:data-model` is 92/92.
- **Remaining, and it is the alarm half.** Nothing is raised into the Operations Stream, on
  purpose. The ladder's only producer today is the authenticated Alertmanager webhook
  (`POST /api/alerts/alertmanager` -> `EnvelopeStore.landEnvelope`, which takes a
  `RawAlertmanagerEnvelope`); there is no internal, non-HTTP producer API, and the claim stage that
  turns a landed event into a ticket is driven by `oshal_alert_claim_rule` rows that no migration
  seeds. Emitting today would mean forging an Alertmanager delivery that no Alertmanager sent,
  landing it `signatureVerified: false` on a lane with no claim rule - a durable row nobody reads,
  which is exactly the half-wired notification this entry warns against. What the ladder needs,
  concretely: (a) a producer entry point on `EnvelopeStore` that accepts an already-normalized
  event with its own `source` lane, so a first-party detector does not have to impersonate a
  webhook; (b) a `schema-drift` source lane registered the way the Echo lane entry below describes;
  (c) a claim rule for that lane so a landed drift event becomes one ticket. The same three are
  what the Echo funnel entry needs, so they are one piece of work, not two.
  Also still open: the explorer shows no "what changed since" panel. `src/pages` is bind-mounted
  and goes live immediately, while `/api/admin/data-model/drift` needs a core deploy - shipping the
  panel before the route would put a broken card on the live cockpit, so the page half waits for
  the deploy.
- **Done when:** dropping a policy on a scratch table in a disposable database produces exactly one
  alert naming that table and its previous state, the explorer shows the same change as a diff, and
  a run with no schema change produces no alert. (The classifier half of this is proven in
  `data-model-drift.spec.ts`; the *alert* and the *explorer diff* are what remain.)

### Data-model explorer: export the view you are looking at
- **Built 2026-09-14.** **Export** in the explorer's header copies the current view as Mermaid and
  downloads it as SVG or scoped JSON, entirely client-side from the snapshot already in the page —
  `src/pages/data-model/js/export-view.js`, no new route. The Tables view exports an `erDiagram`;
  the owner views export a `flowchart`; an empty or diagram-less scope refuses by name.
  `tests/unit/data-model-export.spec.ts` (13) pins the erDiagram **byte-identical** to
  `scripts/schema-docs/render.js`'s `mermaidDiagram()`, asserts it names exactly the relations the
  view drew, and covers every refusal; three cases in `data-model-explorer-browser.spec.ts` prove
  the clipboard copy and the two real downloads in Chromium, and that a non-operator — who never
  received a snapshot — is told there is nothing to export. `npm run test:data-model` is 67/67.
- **Remaining:** `src/pages` is bind-mounted, so the export is live wherever `/data-model` already
  serves, but two things are open. **(a)** The Mermaid is asserted structurally and by parity with
  the generator whose output the committed pages already render on GitHub; nothing runs an actual
  mermaid@11 parse, because mermaid is not a dependency of this repo — the earlier note that "the
  docs pipeline already validates with mermaid@11" did not hold. **(b)** `toErDiagram()` is a
  second copy of the generator's renderer; it belongs to the same collapse as the catalog SQL, the
  RLS classifier and the DDL parser, one entry above.
- **Done when:** mermaid@11 (or an equivalent parser) parses an exported block in CI, and the
  renderer has one implementation behind both the docs and the surface.

### Drone physical payloads and peer coordination
- **Remaining:** prove a real approved MAVLink airframe/adaptor, authenticated drone-to-drone coordination, physical camera/video, ESC telemetry, and LED payload through the remote-node envelope; the Drone package carve is already complete.
- **Done when:** [`drone`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/drone) drives auditable capture/telemetry on a physical node and a multi-node mission self-realigns without bypassing geofence, approval, abort, or ownership gates. See [ADR-099](adr/099-drones-as-remote-swarm-nodes.md).

### Camera real-device follow-ups
- **Remaining:** add GoPro BLE AP/COHN provisioning, pinned self-signed CA handling, browser-playable preview transcoding, one second-brand adapter, and package the camera node; deploy/install the current package for a browser smoke.
- **Done when:** a real GoPro provisions and previews without disabling TLS verification, a Canon CCAPI or ONVIF device uses the same provider contract, and [`camera`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/camera) drives both without controller/surface changes.

### 3D-printer store package (FlashForge first)
- **Remaining:** no printer connector exists anywhere (verified 2026-09-05 across core and both store repos); `3d-printing-bot` is an advisory persona with every tool authorization off. Build a store package cloning the camera device shape: deterministic ops (status/temps/upload/start/pause/cancel, cancel confirmation-gated like camera `deleteAll`) over the printer's network link — FlashForge Finder/Adventurer 3/4 speak the proprietary TCP protocol on port 8899 (`~M601`/`~M119`/`~M105`/`~M27`/`~M28`/`~M23`/`~M26`), Adventurer 5M/5M Pro expose HTTP on 8898 or Moonraker REST in open mode, both LAN-reachable from the api container with no node. USB requires a host-side printer-node (containers can't see USB serial under Docker Desktop) and FlashForge has no known Bluetooth control — WiFi first. Blocked on the operator naming the printer model (decides protocol and `.gx` vs `.gcode` upload format). Slicing stays a separate step (OrcaSlicer/PrusaSlicer CLI); the printer op takes finished gcode.
- **Done when:** a store package in `oshal-applications` reports the real printer's status and temperatures in the cockpit, uploads and starts a real print job on the operator's FlashForge over the LAN, cancel requires an explicit confirm, and the `3d-printing-bot` persona serves as the package's concierge without any new core code.

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

### Echo pipeline snapshots into the DevOps monitoring / self-healing funnel
- **Current state:** the reference `oshal` database holds `echo_pipeline_snapshots` (`snapshot_id`, `ts`, `stage`, `count`, `window_hours`; RLS off): 168 rows, 28 each for the stages `normalized`, `deduplicated`, `filtered`, `enriched`, `grouped` and `delivered`, all written between 2026-04-24 16:49 and 2026-04-25 04:27 UTC and none since. No tracked source in core, the store repo or the private package repo declares or writes it — `scripts/generate-schema-docs.js` reports it as the one undeclared live table — and no `.py`/`.sql`/`.ts`/`.js`/`.go`/`.sh` file in the separate Echo SRE project names it. Core's per-stage funnel, `oshal_alert_funnel_snapshot` (migration 108, written at `src/features/alert-pipeline/services/funnel-stats.ts`), has the same shape plus a `source` lane and `window_minutes`, holds 0 rows on the reference stack, and accepts only the closed `FUNNEL_STAGES` vocabulary (`envelopes` … `actions_applied`); its absence alarms sum every lane rather than judging one source alone.
- **Remaining:** operator decision (2026-09-10): fold these Echo pipeline counts into the DevOps monitoring / self-healing workstream ([ADR-119](adr/119-autonomous-health-ticket-processing.md), [ADR-125](adr/125-operations-stream-event-to-action-pipeline.md)) instead of keeping an orphan table. Identify the April writer; decide how Echo's six stages enter the funnel — a mapping onto `FUNNEL_STAGES`, or new stages each with its own query (a stage added without one fails the build by design); capture them as an `echo` `source` lane; give that lane its own "went quiet" signal for the self-healing path; then retire `echo_pipeline_snapshots`, migrating or dropping its 168 April rows.
- **Done when:** Echo's per-stage counts appear as their own lane in the Operations Stream funnel on the reference stack; stopping the Echo writer past its window raises an alarm naming the `echo` lane in `/api/ops/alert-pipeline/health` and that alarm reaches the ADR-119 intake as one ticket; and `node scripts/generate-schema-docs.js` reports no undeclared live table.

### Cockpit startup: remove blocking external script dependencies

- **Observed:** the 2026-09-12 Career/navigation rollout included a blank reload with parsing stopped at the synchronous external marked script, before the body or DOMContentLoaded. A hard refresh restored the shell; no service-worker reload loop was established.
- **Deployed and verified:** core `2739e250` serves marked's existing locked build and exact Phosphor 2.1.2 regular assets through fixed authenticated local routes; the unused parent graph preload is removed. The 87 focused checks pass, and signed-in native reload retained Create and its palette with local Markdown/icons loaded. See [Cockpit startup resilience](backlog/cockpit-startup-resilience.md) for deployment evidence and scope.
- **Remaining:** the separate rollout-time database checkout and intermittent tunnel-origin reset investigation. Local startup assets do not imply offline application data.

### Bot-recreate thundering herd

- **Observed 2026-09-12:** during the full rollout, six API pool-checkout timeouts accompanied workspace discovery requests lasting 83.155–279.995 seconds. After recovery, discovery returned all 33 admitted links in 0.630–1.358 seconds, and explicit Retry restored the Job Board. The captured errors were not PostgreSQL role-limit refusals; the original connection holders were not identified. [Timing evidence and remaining diagnosis](backlog/cockpit-startup-resilience.md#rollout-time-database-checkout-delays).
- **Remaining:** deploy the default-on bounded bootstrap-pull jitter, recreate the full bot fleet against the production-sized API database pool, and tune the window only from observed startup/config-convergence results.
- **Done when:** recreating the full bot fleet causes no pool exhaustion, each bot receives config within a bounded window, and boot authentication/rate limits remain enforced.

### Operations and SecOps swarms
- **Remaining:** prove caller-scoped live reads for Dynatrace, ServiceNow, Datadog, and New Relic and retire the environment-global ServiceNow MCP; integrate the existing one-shot RCA engine; build the SecOps bot/store/surface; seed offline Trivy/FIPS assets and run a real self-scan.
- **Done when:** connector/RCA traces are caller-attributed, findings are encrypted and owner-isolated, security review passes, and a live enclave scan files auditable results without fetching an unapproved database. See [ADR-069](adr/069-operations-and-secops-connectors.md).

### TV surfaces — OSHAL Home in the Fire TV, Roku, and Samsung stores
- **Remaining:** the Get oshal page's TV tile says the apps are not in any store, because they are not: Fire TV (`packages/oshal-firetv`), Roku (`packages/oshal-roku`) and Samsung (`packages/oshal-samsung-tv`) install only by developer-mode sideload from a build. The four-phase registration runbook exists (`docs/tv-surfaces/roku-and-samsung-registration.md`) but none of its phases is recorded as done for any of the three, and the Roku README records that its channel has not been built or tested on a device.
- **Done when:** each app is installable from its platform store or that store's private/beta channel under the business developer account, a store-installed copy completes `/tv` pairing against the public swarm and speaks a Jarvis answer, and the TV tile links to the listings instead of the sideload guide.

### No remote node is registered: the shared secret is retired and nodes were never re-enrolled

- **Found 2026-09-12:** `GET /api/remote-clients` returns **zero clients** on the operator's box, read as the
  operator, while an `@oshal/chat` worker is running on that same machine. Three independent causes, each verified:
  (1) the control plane runs `REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true`, so `authorizeRemoteClient` refuses the
  swarm-wide secret with `shared_secret_retired` ([remote-client-routes.ts](../src/app/routes/remote-client-routes.ts)),
  and the running worker's config still holds exactly that secret — its per-node token was minted in August and
  revoked a minute later; (2) the worker's `controlPlaneUrl` is `http://localhost:35457`, and on that host
  `localhost` resolves to `::1` first, which is wedged by a stale `wslrelay` while `127.0.0.1` answers 200, so its
  requests never arrive at all (the api log has no entry from it); (3) `allowSystemControl` is off in its config, so
  even once registered it refuses `shell.exec`, which is the transport every remote-node job here is built on. The
  registry is in-memory, so nothing repopulates it on its own.
- **Consequence worth naming:** the fail-closed retirement worked exactly as designed, but nothing reports the
  resulting empty fleet. Jobs that need a node (the nightly recap's render step among them) fail one layer deeper,
  at "could not reach the render node", which reads as a node problem rather than an enrollment problem.
- **Remaining:** re-enrol the nodes that should exist onto per-node tokens (`POST /api/join/enroll`), point them at
  `127.0.0.1` or clear the `::1` wedge ([runbooks/localhost-wedge-wslrelay.md](runbooks/localhost-wedge-wslrelay.md)),
  turn on system control where a node is expected to run jobs, and surface "no node registered" where an operator
  will see it rather than only in a failing job's log.
- **Done when:** the registry lists the expected nodes with recent heartbeats, a node job completes end to end, and
  a deliberately empty fleet produces a message naming enrollment as the cause. See
  [ADR-114](adr/114-user-owned-remote-nodes.md) and
  [runbooks/remote-swarm-node-enrollment.md](runbooks/remote-swarm-node-enrollment.md).

## Application-package follow-ups

### Editable CAD Studio and scan-to-design workflow

- **Requested 2026-09-13 UTC:** connect Create's Scan-to-Print workflow to useful mechanical CAD, including an optional SOLIDWORKS integration.
- **Current:** Scan to Print exports measured STL/OBJ meshes and overall-dimension SVG; Ocean/Aero have specialist engineering/export functions. No general CAD editor or SOLIDWORKS adapter was found in the inspected packages. Software `oshal-engineering` is not mechanical CAD.
- **Owner and plan:** the store-owned [CAD Studio delivery plan](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/feat/package-test-catalog-pilots/scan-to-print/CAD-PLAN.md) defines CAD-01 through CAD-10. Recommend a bounded CadQuery worker and a separate CAD document owner exposed through Create; preserve original scans, explicit units, revisions and native documents. STEP/STL remain derived outputs.
- **First useful checkpoint:** create a plate with holes, edit dimensions, undo, save/reopen and independently reimport its real STEP solid and STL. Scan artifact-source handoff and worker feasibility can proceed independently; Video editing remains a parallel application track.
- **Done when:** the installed application imports its roles, registers meaningful model/kernel/database/browser/export tests with prerequisites, passes the full native task and preserves other applications. Licensed SOLIDWORKS operations require actual adapter/workstation proof before being advertised.

### Create visual workspace and integrated editing — active parallel track

- **Current template release:** Create 1.6.0 at `54c1e789` delivers eight original editable image templates, real previews, filtering and safe new-project selection. The [release record](releases/create-templates-2026-09-13.md) records 37 new plus 93 retained local checks, 16 registered Lab cases, five installed runs totaling 58 checks, native standalone editing/export and strict preservation. A recovered origin stall remains separate. The [Create product brief](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/feat/package-test-catalog-pilots/create/PRODUCT.md) defines the requested “Canva but better” direction. The parallel [Video editor plan](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/feat/package-test-catalog-pilots/video/EDITOR-PLAN.md) has an isolated FFmpeg trim/join/title/audio proof; the timeline UI, persistence and export-job workflow remain open.
- **Requested:** Canva-style page layout and a shared generate, manually edit, point/annotate, regenerate and edit-again workflow. Basic image text/crop/filters and video trim/splice/audio come before advanced layers and professional editing depth.
- **Owner:** [`create/BACKLOG.md`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/create/BACKLOG.md) holds the phased application roadmap and acceptance. Reuse Portrait, Video and AI Office capabilities, registered artifact handoffs and current permissions. Project history and supported editable formats must survive editor round-trips.
- **Historical foundation checkpoint:** Create 1.5.0 at `b92013b4` delivered layers, private durable projects, undo/revisions, crop/transforms and PNG/JPEG/editable export, with imported app roles. Native import/save/reopen/export/delete passed; 163 local checks and four installed Lab runs (45 checks, verified cleanup) passed. All 14 Lab cases (13 declared recipes plus readiness) were registered. See the [editor release](releases/create-editor-2026-09-12.md) for exact source attribution and preservation. The earlier Home/template layout is recorded in the [workspace polish release](releases/workspace-polish-2026-09-12.md).
- **Next:** selected-region AI regeneration into a new revision, with the accepted manual canvas retained; video timeline editing remains an independent track. Jarvis selections, masks and deeper desktop-editor interchange remain open. Core retains only demonstrated shared transport or provider-capability dependencies.
- **Done when:** each remaining phase works through the installed Create entry, preserves edits and accepted revisions, exports real media, and registers meaningful tests in AI Test Lab. The delivered manual image slice does not close the full advanced-editor roadmap.

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

### YouTube archive slice adoption
- **Remaining:** reconcile the package-owned YouTube slice installation and whole-archive routing evidence with the package README; this acceptance was previously misplaced beneath Aero Lab.
- **Done when:** installing the package registers its YouTube slice, uninstalling removes it, whole-archive upload routes correctly with owner isolation, and the package README is the canonical per-item product queue.

### Game Show core dependencies
- **Remaining:** auto-narrate the opening after the platform TTS speaker lease and install the package through the sanctioned registry installer rather than `docker cp`; app-local polish stays in the [`game-show` backlog](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/game-show/README.md).
- **Done when:** starting a show speaks or captions the open and `oshal-app install game-show --ref main` leaves provenance and survives redeploy. See [ADR-112](adr/112-game-shows-as-plugins.md).

### Payroll package backlog handoff
- **Remaining:** make the [`payroll` README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/payroll/README.md) the canonical queue for additional cited state/local tables, workweek overtime, protected identifiers, employee isolation, repayment/garnishment/deposit rules, benefits/payment traces, verified EFW2 2026, and enrolled filing/payment rails.
- **Done when:** each commissioned package item has primary-source citations where legally material, a focused calculation/isolation guard, and clean-tenant output evidence; core retains only shared framework dependencies. See [ADR-123](adr/123-payroll-app.md).

### Ambient Recall (ADR-100) — live acceptance on real transcripts
- **Delivered (2026-09-12, `018607e6` + `8a88d33e`; merged to `main` through PR #431 as `b8de2099` and deployed from `main` with `scripts/oshal-deploy.sh` on 2026-09-14):** Phases 2-4 as recorded in [ADR-100](adr/100-ambient-person-model.md) and the [release record](releases/ambient-recall-phases-2-4-2026-09-12.md) — Jarvis front door for asks/trends/connections, semantic recall with database-enforced deletion parity (migration 138), profile pages, the consent-trigger convergence, the parity gate, the in-container gate and live-proof scripts, and the Test Lab scenario `ambient-recall`.
- **Remaining:** (the merge and the `main` release are done — see Delivered) a mic session with speaker recognition on and one named voice (the box holds zero transcripts and the analyst has never run — no `chat_tasks` row under `a0000000-0000-0000-0000-000000000055`); run the `ambient-recall` Lab scenario; allow modeling for that voice and let one enrichment sweep produce asks and topics.
- **Done when:** the Lab scenario passes all five steps on a `main` deploy; one `ambient_person_asks` row exists that the analyst produced with a cost row under its agent id; the People tab shows that voice's topics and presence from real lines; a paraphrase recall returns a related hit from real speech.

### Ambient Recall — attributed ingest fixture for the Test Lab
- **Remaining:** `POST /api/jarvis/ambient/segments` refuses speaker ids by design, so the Lab can only prove the unattributed path (recall by "anyone"); asks, profiles and consent need attributed lines, which today exist only through the audio path.
- **Done when:** a service-secret-gated fixture (or a diarization fixture) lets the Lab seed an attributed line for a fixture voice, the scenario proves an ask and a profile for it, and a normal session cannot reach the fixture.

### Ambient Recall — relevance floor on "possibly related" hits
- **Remaining:** the semantic leg returns the engine's nearest neighbours with no floor; the live proof returned "Can we order pizza tonight" as related to "volleyball" with the same flat RRF score as the true paraphrases. The count is unaffected, but the list reads as noise when few lines exist.
- **Done when:** a similarity floor (or a rule that a hit must score on the vector leg, not only rank) drops the pizza line from the live-proof fixture while keeping the two volleyball paraphrases, and the exact count is unchanged.

### Ambient Recall — Manage Voices bridge to profile pages
- **Remaining:** profile pages live on the extension surface; the Jarvis Manage Voices panel (`jarvis-speakers.js`, over the file cap) has no link into them. A sibling script needs the four registration points (`JARVIS_CLIENT_ASSETS`, `jarvis.html` script + mount, the compose bind mount) and the wiring spec.
- **Done when:** each voice row in Manage Voices opens `/api/jarvis/ambient/person/?tab=people&profile=<id>` and `tests/unit/jarvis-speaker-wiring.spec.ts` pins the four points.

### Lazy-DDL trigger and function guards must converge, not create-once
- **Remaining:** the consent-ledger trigger drift (a by-name `IF NOT EXISTS (SELECT 1 FROM pg_trigger …)` guard froze the July `BEFORE DELETE OR UPDATE` shape on the dev box; fixed for that trigger in `8a88d33e`) is a pattern, not a one-off. Every lazy-DDL guard on a trigger or function that keys on the name alone will keep its first definition forever.
- **Done when:** a unit spec enumerates every such guard under `src/`, and each either converges on a property of the live object (as `person-model-schema.ts` now does on the tgtype DELETE bit) or is covered by an assertion that its definition has not changed since first ship; `pg_get_triggerdef` on the dev box matches the code for every one.

### Person-model maintenance never runs on a box that restarts daily
- **Remaining:** `startPersonModelMaintenanceRuntime` schedules its pass with a 24-hour `setInterval` and no initial tick, so the retention purge of rollups and the orphan-chunk backstop never run on a container that is recreated more often than daily (this box redeploys most days).
- **Done when:** the first pass runs a bounded delay after boot, a unit spec pins that, and the api log of a fresh boot shows one `person-model maintenance pass complete` line.

### Real-Postgres specs cannot run from this host while Docker port publishing is wedged
- **Remaining:** the database container's published port is configured but not live, and a new bind reports "port is already allocated" for a free port, so every real-database spec (this one and the trading/authorization ones) fails loudly from the host. `scripts/person-model-gate-in-container.js` is the hand-kept twin of `tests/unit/person-model-parity-postgres.spec.ts`.
- **Done when:** either the engine is repaired and `npx vitest run tests/unit/person-model-parity-postgres.spec.ts` is green from the host, or `ci-local.sh --head` runs the gate inside the api container when the host port is dead; and the twin shares its assertion list with the spec so they cannot drift.

### `jarvis-routes.ts` is over the decomposition threshold
- **Remaining:** the file counts 802 code lines (the Phase 2 change was net −2). CLAUDE.md requires a decomposition plan before any addition; the person-model hook was routed through the slice for that reason.
- **Done when:** the file is below 800 code lines with the existing jarvis specs green, and the recall hook is unchanged.

### Surface-glass spec is red on four page surfaces
- **Remaining:** `tests/unit/surface-glass-assets.spec.ts` lists `src/pages/access`, `src/pages/app-loader`, `src/pages/jarvis-briefings` and `src/pages/users` as lacking the shared glass stylesheet (observed 2026-09-12 on `feat/store-compatibility-gate`; not introduced by the person-model work).
- **Done when:** each page links the stylesheet or carries a justified exemption, and the spec is green in `ci-local.sh --head`.

### Ambient Recall — prosody tone via a sidecar model (optional, ADR-100 Phase 4)
- **Remaining:** tone today is text-level (analyst inference). The ADR allows an acoustic sidecar writing the same tone column with a different `model` string.
- **Done when:** a sidecar writes tone with its own `model` and confidence for at least one owner, renders as OSHAL's read beside the quote, and is purged by the same triggers and consent decline.

### World Intelligence licensed outlet ratings
- **Remaining:** license Ad Fontes and/or AllSides, map the data with provenance, and replace placeholder bias/reliability seeds; this requires operator budget and license approval.
- **Done when:** every rating displayed in the World package is sourced to the licensed dataset/version and unknown outlets are represented as unknown rather than guessed. See [ADR-061](adr/061-world-intelligence-layer.md).

### Marketing suite — core dependencies (package work is in the store)
- **Remaining:** the suite's application work — audience and recipient consent, compliant email broadcasts, a campaign budget held as a finance project, sequences, SMS, attribution, paid ads, and the Marketing Suite group — is designed in [the marketing suite spec](apps/marketing-suite-spec.md) and tracked with done-when criteria in `marketing-engine/BACKLOG.md` in [oshal-applications](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/marketing-engine/BACKLOG.md) — its **How to continue** section at the top is the pickup order (land the two PRs, recreate the api for the env passthrough, install 0.5.0 plus the `marketing-suite` group on a healthy box, the two operator-only steps, then P1); the earlier engine-phase items (launch execution, waitlist capture, the X posting decision, per-user Mastodon instances, the first real campaign and its Monday ticket) moved there. Core owns four dependencies, each needing operator approval before it starts: (1) the Resend connector gains a `headers` parameter limited to `List-Unsubscribe`/`List-Unsubscribe-Post` and a bounded batch action — today's action is one recipient with `additionalProperties: false`; (2) a bounded PostHog stats resource so scorecard site-traffic ingest stops recording `resource_unavailable`; (3) ads connectors (Google Ads, Microsoft Advertising, Meta, LinkedIn Ads), read-only spend first.
- **Done when:** each core dependency is merged with its guard — a schema test that refuses any header outside the unsubscribe pair, a PostHog resource test, and per-connector auth tests — and the package backlog's broadcast item passes its live proof through the extended Resend action. The compose passthrough half is merged (core `477f3a0b`, PR #431) with its guard in `tests/unit/compose-env-passthrough.spec.ts`; it reaches a running container only at the next recreate.

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
- **Remaining:** the adoption phase the operator named at kickoff — an opt-in (default OFF, per the automation directive) drop-folder watcher that feeds oshal: (a) print-to-swarm (a printed document opens a ticket / reaches Jarvis) and (b) print-to-bot (routes into a chosen bot's RAG corpus keyed on the sidecar metadata). Ships as a store package (Rule 0c), not core; the drop folder is untrusted LAN input and must be parsed defensively.
- **Designed 2026-09-03, awaiting operator review:** [ADR-135](adr/135-print-to-swarm-and-print-to-rag.md) + [print-ingest-spec](apps/print-ingest-spec.md). Five phases (P0 core extraction fix → P4 print-to-ticket) and five open questions the operator must settle before build. The RAG review that ADR carries found a **blocking core defect**: `/api/rag/upload` does `buffer.toString('utf-8')` with no text extraction while the Knowledge tab advertises `.pdf`/`.docx`, so every uploaded PDF is embedded as mojibake — `src/features/doc-extract/` already solves it and is wired only to `/api/vision/read-doc`. That fix (P0) is a prerequisite for print-to-RAG and a bug worth fixing on its own.
- **Superseded status — checked against both trees 2026-09-14:** the bullet above is out of date. ADR-135 is **Accepted** (2026-09-03) and its "Build state" records all five open questions answered (Amendments D and E). **P0 is fixed on `main`:** `src/app/routes/rag-routes.ts` now extracts text through `extractDocText` from `@/features/doc-extract` (PR #273, `44d3697a`), so the blocking defect no longer blocks. **P1 is built:** the store package `print-ingest` is on `oshal-applications` `main` (0.3.0) and installs `inactive`, so a fresh install does nothing until an operator activates it. P2 and P3 were dropped by amendment and P4 is not started (ADR-135 "Build state"). What remains is proving the done-when below on an installed box.
- **Done when:** a store package watches the drop folder only after the operator explicitly enables it, each printed document reaches the chosen corpus/ticket with provenance from its sidecar, hostile file content cannot escape the parser, and a fresh install does nothing until opted in.

### career-hunter — a story per role: revive the interview loop as the resume review conversation (ADR-141 D7)
- **Remaining:** the engine's multi-turn interview (`engine/jobhunter/interview.py`, `interview_bank.py`) is built and orphaned; Strengthen has mic, real questions and visible bullets but no back-and-forth that ends in a story. Design: the review walks role by role, every evidence-bearing answer becomes `roles[].stories[]` (with the bullet it supports) in the career profile, the resume and cover generators cite stories as evidence, and a `stories` readiness reads "N of M roles have a story".
- **Done when:** a user with an indexed resume completes a review conversation from Strengthen that leaves at least one story on every role title; the master resume document shows the stories under their bullets; a generated resume for a job cites a story; and the readiness route reports the count the profile actually holds (guarded by an engine test over a fixture profile).

### Fantasy football — the draft engine, the league site, and the live-draft node (operator, 2026-09-06)
- **Remaining:** complete the management-engine residuals and evidence below; retain the separately gated league-site and draft-node phases in their existing priority order.
- **What was asked:** three halves of one product. (1) The **algorithms** — how to actually pick, framed roster-first by the operator: "the methods and algorithms to pick a team and build from the team out", not a global best-player cheat sheet. (2) A **website on this platform** that does what any fantasy site does — league creation, scoring rules, a draft room, in-season lineups/waivers/trades/standings — with configuration and commissioner/administrative controls. (3) A **remote-node add-on** that assists a live draft dynamically inside an ESPN draft room, which needs the operator's own ESPN login. The operator's ESPN team "is having some issues", so phase one deliberately does not depend on reading their private league; the app must draft standalone (offline/paper mode) with the node as an accelerant, not a dependency.
- **Re-scoped 2026-09-09 — managing comes before drafting.** The operator's draft already happened and went badly: *"we have been positioned last … we picked up running backs first round 2 times that were specifically left over by the other team owners … because we missed the first 2 rounds maybe first 4."* An autopicked roster of other managers' leftovers is the starting position, and ESPN's public season endpoint reports **week 1** (checked live 2026-09-09), so the whole season is still ahead of it. The draft engine is not dropped — it is needed next pre-season and for mocks — but it moves to P2 behind the engine that fixes a roster you already have. **The math barely changes:** the marginal weekly-optimal-lineup value is the same function whether the candidate is a pick, a waiver claim or a trade; only the set of remaining weeks differs.
- **Designed 2026-09-09, awaiting operator review:** [ADR-146](adr/146-fantasy-football-draft-platform.md) (four decisions, exactly one of which touches core — the `fantasy-leagues` kernel skill; the league model stays in-package and the live-draft node needs no new rail) + [fantasy-football-spec](apps/fantasy-football-spec.md) (the buildable detail: every formula below, the data model, the routes, the node loop, six guards). Three operator questions in the ADR gate P1 but not P0.
- **Rule 0c:** this ships as a store package in [`oshal-applications`](https://github.com/emeraldcoastsystemsgroup/oshal-applications), sized like `sports-edge`. Core carries only the node half's existing rails, the skill, and this pointer.
- **The draft data rail is credential-free — probed live from this box 2026-09-06.** `GET lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info` answered **200 with no cookie**, and with an `x-fantasy-filter` header (`{"players":{"limit":600,"sortPercOwned":{"sortAsc":false,"sortPriority":1}}}`) returned **600 players in one call**, each carrying `ownership.averageDraftPosition` (Jahmyr Gibbs 1.32) and `auctionValueAverage` ($70.52), `percentOwned`/`percentStarted`, `draftRanksByRankType` for STANDARD/PPR/**SUPERFLEX**/ELIMINATION with a per-format auction value, `eligibleSlots`, `injuryStatus`, `lastNewsDate`, and a `stats[]` array in which `statSourceId:1` is ESPN's own **projection** and `0` the actual, split by `scoringPeriodId` (0 = season, 1–18 = weeks). ADP, auction values and both season and weekly projections are therefore public: the draft engine needs no login at all. `sports.core.api.espn.com/.../athletes` (20,279 rows) and `site.web.api.espn.com/.../athletes/<id>/stats` also answered 200.
- **Caveat carried with its evidence:** on the same probe run `site.api.espn.com` — the `SITE_API` constant the whole `sports-edge` rail is built on (`sports-edge/src-routes/sports-espn.ts`) — returned **403 Access Denied** for `/nfl/scoreboard`, `/nfl/teams` and `/nfl/news`. Whether that is a block on this box, this user agent, or a service change is unestablished. Establish it before planning to reuse those reads; the `sports.core`/`site.web`/`lm-api-reads` hosts were unaffected.
- **Part of P0 already ships in sports-edge (verified on the box 2026-09-09, 0.4.1 active) — do not rebuild it.** `/api/sports-edge/fantasy/` already serves status, league link/unlink, **the optimal lineup and start/sit calls written to the ledger before kickoff**, the graded record, and a cached shared projection refresh, over `applyScoring` (from the league's own `scoringItems`), `optimiseLineup`, `startSitCalls` and `distilProjections` — with the credential rule already implemented (resolved per request, used outbound, never logged, stored or returned). The GAP after increment 1 is: rest-of-season `SV`/`MV` (the optimiser still values one week at a time), waivers with a bid, the two-sided trade finder plus the nine other rosters it reads, and streaming. Matchup awareness and the `P(win)` objective shipped 2026-09-09. **And none of the shipped half has ever run against a real league** — there is no `espn-fantasy` row in `oshal_connections`, so it has only seen fixtures.
- **User guide written 2026-09-09:** [docs/guides/fantasy-football.md](guides/fantasy-football.md) — connecting ESPN (both credential paths, and what those two cookies actually are), reading the matchup card and the win-probability pair, what "swing" is and is not, the failure messages, and what the app will never do. Indexed in the guides README.
- **P0 increment 1 SHIPPED 2026-09-09 — sports-edge 0.6.0 (store #150), deployed and byte-verified on the box.** The lineup is now set against **the team you actually play**: `mMatchup` is read, the opponent's own best lineup is projected from the same feed, and the recommendation hill-climbs on `P(win) = Φ((μ_you − μ_opp)/√(σ²_you + σ²_opp))` from the highest-projected lineup — so an underdog is moved toward variance and a favourite away from it, deliberately giving up projected points when doing so buys tail. The mean-maximal lineup is returned beside it and every swap carries what it cost and what it bought. Spreads are modelled, not measured (ESPN publishes no dispersion): positional priors shrinking toward a player's own weekly scores, with a floor so a zero projection is not treated as a certainty. Guards are a **matched pair** — underdog AND favourite — because a single-direction test passes for a bug that always maximises variance; mutation-proved by forcing the mean fallback (3 red / 12 green), 154/154 package tests, framework tsc clean. **Not yet run against a real league:** no `espn-fantasy` row exists in `oshal_connections`, so the credentialed path has still only seen fixtures and the public feed.
- **P0 — the management engine (the near-term ask).**
  (a) **Points under YOUR rules**: ESPN publishes raw stats and `appliedTotal` is null, so points are `Σ projectedStats[s] × leagueScoring[s]` with the scoring map read from the league — a hardcoded stat dictionary mis-scores every player in a non-standard league and looks normal doing it. Blended with a tape-built projection using `sports-edge`'s opponent-adjusted ratings and its production-weighted injury adjustment.
  (b) **A spread, not just a mean**, per player per week — half of the engine depends on variance, and there is no free per-player variance feed, so it is a modelled parameter stated as one.
  (c) **Replacement level from the league's own shape** (size × starting slots), recomputed weekly as the wire changes.
  (d) **Marginal lineup value — the one function everything rests on**: `MV(c|R) = SV(R+c, W_remaining) − SV(R, W_remaining)`, where `SV` sums the weekly OPTIMAL STARTING lineup over the remaining weeks. Bye collisions, handcuffs, depth and positional scarcity all price themselves out of it, and a drop candidate is just the player whose removal costs least. Drafting and managing differ only in `W_remaining`.
  (e) **The objective changes when you are behind — the most important piece for this roster.** A week is head-to-head, so the target is `P(win) = Φ((μ_you − μ_opp)/√(σ²_you + σ²_opp))`, not the highest mean. Differentiating it says: an underdog's win probability RISES with variance and a favourite's falls. A team built from leftovers that plays safe lineups all season converges on finishing 7th. Season-level, the same logic maximises P(playoffs) over a simulated remaining schedule.
  (f) **Waivers with a bid**: rank the wire by the swap value `SV(R − d + c) − SV(R)` over the best drop, then convert to money — `bid* = B × Δ/(Δ + E_rest)`, the budget's own marginal value — with a scarcity premium when the add fills a slot your starter is a replacement in for more than a third of remaining weeks (exactly the leftover-RB case), and streaming priced in a separate one-week lane.
  (g) **Trades, two-sided**: `Δ_you` and `Δ_them` are two `SV` calls each; propose only when BOTH are positive. Those exist far more often than they look like they should, because rosters have different slot pressure — a manager who starts three WRs and rosters six has a fourth WR whose value to them is near zero and who fills a hole in yours. This is the search that turns your draft's damage into someone else's surplus.
  (h) **The weekly ledger**: every recommendation recorded before kickoff and graded after — the engine's lineup either beat the one that was started, or it did not, and the report says which.
- **First live run, 2026-09-09 — it works, and it exposed the limit of the spread model.** Linked "League of Gentlemen" (12 teams, RazorHogs) and ran week 1 against the real roster: 29 scoring rules read from the league, 1,630 projected players, opponent *Burnout*, 112.5 vs 120.1, **posture underdog, win probability 40.4%** — and **zero** variance swaps, with the recommended lineup identical to the mean-maximal one. That is correct behaviour and it is also the ceiling of the current model: spread is `|projection| × positional CV`, so two players at the same position with similar projections get nearly identical spreads and there is nothing for the win-probability objective to trade. The live case is exact — Rhamondre Stevenson 13.2 (starting) vs Kyren Williams 13.1 (benched), both RB, modelled spreads 7.26 vs 7.21. **The variance argument cannot bite until spreads vary independently of the mean.** `spreadFor(mean, positionId, samples)` already takes per-player samples and shrinks them toward the prior; nothing feeds `pointsHistory` yet, because the projection cache holds one week.
- **Done when (this bullet):** actual weekly scores are accumulated per player (the ledger and the `statSourceId:0` rows in the same feed already carry them), `pointsHistory` is populated from them, and a real-roster run shows at least one week where the recommended lineup differs from the mean-maximal one with the win-probability gain that justified it — or a season's grading says the objective never beat the mean, reported as a loss.
- **P1 — the site: configuration and commissioner control.** League creation (size, snake/auction/keeper/dynasty, roster slots including superflex, custom per-stat scoring, waiver mode FAAB or rolling, trade deadline and veto policy, playoff weeks and bracket); matchups, standings, transactions; and an administrative surface of its own — commissioner edits (rosters, scores, draft order, re-opening a locked lineup), member invite/removal, and an audit trail of every commissioner action. Package data is `user_sub`-keyed per ADR-036 but a league is a shared object with a member list, so league-scoped isolation is explicit rather than inherited (ADR-146 D3: in-package, single-commissioner first).
- **P2 — the draft layer and the live-draft node.** Tiers by cliff, VONA against the modelled next pick, the Monte Carlo draft simulator, auction max-bid with inflation — all on top of the same `MV` — plus the node assistant: ESPN's private-league and draft-room reads need the operator's `espn_s2` + `SWID` session, so it rides `job-apply`'s rail (a chosen desktop node drives the operator's own logged-in browser, room state returns through the bounded one-use callback, no cookie reaches the model or the database). ADR-146 D4: short cursor-based reads on the EXISTING remote-client rail, because a node runs one claimed task at a time. **Blocked by node enrolment** (see that entry above); acceptance is a mock draft, never the operator's real league.
- **The credential moved onto the critical path.** The draft engine needed none — pool, ADP and projections are public. Managing needs YOUR roster and your opponents', which in a private league means the two ESPN account cookies, and the operator has reported that team "having some issues". So **manual roster entry is a first-class input, not a fallback**: every weekly recommendation must be reachable from hand-typed rosters, with a guard that goes red if the connector ever becomes mandatory.
- **Done when:** (P0) for a real league — connector-read or hand-typed — the weekly board produces a start/sit with the win probability it buys against the mean-maximising lineup, a waiver board ranked by rest-of-season swap value with a bid and a drop for each, and at least one two-sided trade showing both managers' gain; a guard proves an underdog is never handed the lower-variance lineup and that no proposal surfaces with `Δ_them ≤ 0`; and the ledger grades a completed week against what was actually started; (P1) a commissioner creates a league, sets scoring and roster slots, invites a member, and edits a roster, entirely from the surface, with every commissioner action in the audit trail and a spec proving a second league's admin can neither read nor write the first; (P2) a backtest over a completed season reports the draft engine's rosters against straight-ADP rosters across at least 100 simulated drafts with a loss reported as a loss, and a mock ESPN draft on an enrolled node feeds picks back with the recommendation updating within seconds, guarded so the session cookie never leaves the machine.

### The node's ESPN sign-in window makes the user hunt for the one control that works

- **Found 2026-09-09, with a live workaround already in hand.** `connectEspnFantasy` opens
  `https://www.espn.com/fantasy/` and leaves the user to find a way in. The obvious control — the
  **person icon** top-right — opens its dropdown and then does nothing at all when **Log In** is
  clicked: the dropdown closes and no login appears. Reproduced inside the node's own Electron window
  and screenshotted at +600 ms / +2 s / +5 s. The control that DOES work is the **Log In** button in
  the *Customize ESPN* card in the right-hand rail, which hands off to MyDisney and redirects back;
  that path produced this swarm's first working `espn-fantasy` connection (`connected`, SWID
  resolved, 2026-09-09 22:45 UTC).
- **Not ESPN being broken, and not the OneID error it logs.** The same page in a fresh real Chrome
  opens the MyDisney overlay from the same click, and `[OneID] ERROR Session not established` appears
  in the *working* Chrome run too — it is noise. Disabling `ThirdPartyStoragePartitioning`,
  `TrackingProtection3pcd` and `PartitionedCookies` changed nothing. What differs is our window:
  Electron's Client Hints carry no `Google Chrome` brand (`[Not;A=Brand, Chromium]`), which is the
  untested remaining hypothesis rather than a conclusion.
- **Remaining:** stop landing on a page where the first thing a user reaches for is dead. Either open
  the login entry point directly (the Customize-ESPN button is a normal link into MyDisney with a
  redirect back — capture that URL and load it), or keep the current landing page and put one line of
  in-window guidance on it. Whichever, the person-icon path should not be the thing a first-time user
  finds first.
- **Done when:** a user who has never connected reaches an ESPN login form from *Log in + push*
  without hunting, on a fresh node profile; the guide's instruction matches what the window actually
  does; and if the direct-URL route is taken, a guard pins the URL so an ESPN change breaks a test
  rather than the button.

### Fantasy — the app cannot tell "not connected" from "ESPN unreachable"

- **Found 2026-09-09** while the box had no working DNS (the operator read it as an ESPN outage; it was the
  local resolver — `github.com` and `google.com` failed identically and `8.8.8.8` reached ESPN's fantasy API
  with a 200). Everything ESPN-facing failed at once, which is the condition that exposes two misleading
  messages in `sports-edge`'s fantasy half — neither is a crash, both send the reader somewhere useless.
- **Remaining:** (1) `GET /fantasy/lineup` answers `403 "Connect ESPN Fantasy to read a private league."`
  whenever `readLeagueSettings` returns null **and no credential is stored** — but that read returns null for
  an unreachable ESPN exactly as it does for a missing credential, so a user whose network is down is told to
  paste cookies that cannot help. The read has to distinguish *transport failed* from *ESPN said no*, and the
  message has to follow. (2) The matchup card renders *"No opponent could be read for this week"* for a
  genuine bye and for a failed `mMatchup` read alike, so a schedule outage reads as a bye — the lineup shown
  is still safe (it falls back to the highest-projected one), but the reason given is wrong.
- **Done when:** an ESPN transport failure produces a message that names the transport rather than the
  credential, proven by a guard that drives the route with a fetch stub that throws; a bye and a failed
  schedule read produce visibly different copy, proven the same way; and the guide's failure table is
  updated to match, dropping the "those two are not yet told apart" caveat it carries today.

### Circuit Lab (store package `circuit-lab`, ADR-154)
- **Delivered (0.5.1 live on the reference box; 0.6.0 on the store branch, 2026-09-14):** a local electromechanical lab — ngspice in a package-owned engine container, a schematic canvas whose gears, rotors, servo horns and crank-sliders move from the solved angles, a breadboard view held to the schematic's nets, DC motors, hobby servos and steppers with their gear trains, torsion springs, slipping belts and a crank-slider all in the same SPICE solve, an Arduino Uno whose sketch is compiled with avr-gcc and run in avr8js with its output pins as sources in the same transient, thirty-one parts, a shaft-driver catalog, the gear → CAD Studio hand-off, thirteen route-backed tools for the inline concierge, the surface-bridge rail (the page publishes what it shows; Jarvis edits through `circuit_action`; the concierge in delegate mode), nine suites registered in the Test Lab, and the operator's external-tool list evaluated under the package's `docs/evaluations/`. 0.6.0's real-solver run and install are pending — the package's `docs/continuing-0.6.0.md` is the hand-over. See [ADR-154](adr/154-local-electromechanical-lab-circuit-lab.md); the package BACKLOG carries B1's input half (a sketch reading the circuit back — a per-tick co-simulation through libngspice), a general 2-D linkage layer (B5's residual) and the evaluation follow-ups B12–B16.
- **Remaining (owned by the package):** firmware in the loop, a breadboard view, gears handed to CAD Studio, one parts model with the embodied lab (ADR-152 D1), non-rigid mechanics, more parts, a convergence retry, and the operator's list of external engineering tools to evaluate (Onshape, McMaster-Carr, WebPlotDigitizer, SimScale, EES, OpenRocket, ParaView, OpenFOAM, NASA GMAT, NASA CEA) — each with done-when criteria in the package's `BACKLOG.md`.
- **Done when:** the package backlog's B1–B8 close with their stated criteria and every listed tool has a dated evaluation note with a cost / benefit table and either a backlog item or a recorded "no".

### Drone relay chains (store package `drone-relay`, ADR-155)
- **Delivered (0.1.0, 2026-09-14):** relay chains designed and rehearsed before a radio is soldered — a transport catalog with sources, the link budget, the chain planner (hop, slots, spares, the relays a battery rotation needs), the on-board and controller rules, a source-routed signed envelope, a deterministic simulation with failure scenarios, a generated write-up, the relay-designer concierge and a tile. See [ADR-155](adr/155-drone-relay-chains.md) and [the link hardware](architecture/drone-relay-link-hardware.md). **0.2.0 (same day):** relay postures (hover or perch, with the antenna height a perch needs), an out-of-band control channel sized by reach and heartbeat air time, a courier sized by its trip, and the buffer and drain an outage costs on every run — [the expansion](architecture/drone-relay-expansion.md).
- **Remaining:** the relay role on the drone node (`drone-node-server.ts`, a core PR — package B1); the ESP-NOW transport adapter and the bench range test that replaces the catalog rows (B2); frame loss below the modelled edge (B3); corridors from the drone package's map (B4); two tips on one chain (B5); the formation handed to Drone Ops as a draft fleet mission (B6); ground nodes (B7); the control plane inside the simulation (B8); a lattice (B9); two radios per relay (B10); proxy replies and the command queue in the relay role (B11) — each with done-when criteria in the package's `BACKLOG.md`.
- **Done when:** a command reaches a drone beyond the base radio's reach through a relay node on the swarm rail, authenticated end to end, first against ArduPilot SITL and then in a three-drone chain inside direct-link range behind the fleet confirm; killing the relay produces the outage the simulation predicted on the measured catalog rows, within a stated tolerance.

## Provisioning and operator experience

### First-run provisioning wizard
- **Source proof:** trusted source selection, reviewed package install/retry, saved progress and existing-account links pass isolated HTTP/Chromium checks; [the provisioning guide](testing/first-run-provisioning.md) records the implemented flow.
- **Remaining:** prove the promoted flow on a fresh installed swarm and complete the separate safe backup/secret-default setup acceptance; third-party sources continue through the existing explicit registry trust controls.
- **Done when:** a fresh LOCAL_AUTH admin completes or skips each re-enterable step, failures name the package, anonymous users cannot invoke installation, and an ADR prevents a typed store URL from gaining unchecked code execution. See [ADR-117](adr/117-local-auth-invited-users.md).

### Swarm root — the three pieces ADR-148 did not build
- **Context:** [swarm administration — as built, and how to continue](architecture/swarm-administration.md).
- **Remaining:** [ADR-148](adr/148-swarm-root.md) shipped the role store, root claim/transfer, the
  role-aware `isOperatorIdentity`, bootstrap-claims-root and the `/users` page. Three things remain:
  (1) a `MOCK_OIDC` box's installer-configured identity stays break-glass-only until someone claims
  root from `/users` — nothing adopts it; (2) promote and verify the new `/users` invite/disable
  controls, already covered by isolated PostgreSQL and Chromium tests;
  (3) no spec drives an operator-gated route through the real Express middleware chain as a signed-in
  NON-operator — the shipped guards cover the store and `isOperatorIdentity` against live Postgres,
  and the 401/200 route paths were verified on the box, but the authenticated-non-operator 403 was not.
- **Done when:** a `MOCK_OIDC` install ends with its configured identity holding root (or a recorded
  decision that it should not); `/users` can invite and disable a local account; and a spec mounts
  `/api/swarm/roles` and `/api/swarm/registries` behind the real auth middleware and gets 403 as a
  signed-in non-operator and 200 as an admin granted through `swarm_roles`.

### App Loader — the ADR-147 decisions that did not ship
- **Context:** [swarm administration — as built, and how to continue](architecture/swarm-administration.md).
- **Implemented in the current branch:** cross-source replacement requires explicit approval bound
  to the observed installed provenance and is rechecked at the installer write; Applications Discover
  reads the aggregate catalog; App Loader can revoke trust and requires typed-host confirmation to
  restore it. Local CLI, HTTP and browser regressions cover these paths.
- **Remaining:** **D7** — dependencies resolve only from the origin registry;
  cross-registry resolution (exactly-one-other-trusted-registry, shown in the preview) and the
  two-registries fail-closed rule are not built. **D10** — a public hostname that resolves to a
  private address is not refused; the durable fix pins the resolved address for the fetch rather
  than validating then fetching.
- **Done when:** a two-registry dependency spec fails closed on ambiguity; a fence spec where a
  hostname resolving to `10.0.0.0/8` is refused through a real local resolver seam; and ADR-147's
  As built section records the completed behavior and evidence.

### One place that answers "what am I allowed to do"
- **Context:** [swarm administration — as built, and how to continue](architecture/swarm-administration.md) section 3.
- **Remaining:** three authorization axes now exist and each is correct in isolation:
  `swarm_roles` (who administers the SWARM, ADR-148), the governance RBAC role + permissions
  (`features/governance/rbac/policy.ts`, which as of 2026-09-13 reads `swarm_roles` first and
  then the env allowlists), and `application-authorization` (who may use each INSTALLED APP,
  released 2026-09-11, surfaced at `/access`). Nobody — operator or user — can see all
  three together, so "why can't I open this?" is answered by checking three surfaces and an
  environment file. The axes must NOT be merged: folding per-app access into swarm
  administration would make "may use the photo app" and "may administer the swarm" one
  decision. What is missing is a READ-ONLY view that joins them for one identity and names the
  source of each grant (`swarm-role` | `break-glass` | `idp-claim` | `app-assignment`), which
  `/api/governance/whoami` already reports for the first two.
- **Done when:** one authenticated surface shows, for the caller and — for an admin — for any
  chosen subject: their swarm role and where it came from, their governance permissions, and
  their per-app assignments; every value is read from the existing stores with no new grant
  path; and a guard proves a break-glass-only operator is labelled as such rather than
  rendering identically to a granted admin.

### `swarm-cli` zsh completion
- **Remaining:** execute the current completion in real zsh, covering sourced/autoloaded modes, command/state dispatch, and saved context completion.
- **Done when:** `zsh -n` and real tab completion pass for top-level commands, completion shells, token actions, and `--context`; append evidence to the existing 2026-07-12 proof or delete the unsupported script.

### Trading — timed orders: the STORE half of the D4 follow-ups (ADR-136 D4)
- **Kernel shipped 2026-09-06:** the `trading-events` leg fires every minute 07:00–19:59 ET (`TRADING_EVENTS_CRON`); plans + pinned lots step on the full tick (`TRADING_EVENTS_FULL_TICK_MINUTES`, default 5) while dated orders step every fire; the accepted fire window is derived from the cron, so there is no second setting to drift; outside 09:30–16:00 only a LIMIT + extended-hours + DAY order is accepted, failing closed when the caller sends no order shape; NYSE full closures are refused by name from a static 2026/2027 table (`TRADING_MARKET_HOLIDAYS` adds one-offs) whose guard goes red 60 days before its horizon; existing per-user legs migrate at scheduler boot, proven against the real Redis store.
- **Store shipped 2026-09-06 (trading 1.10.1):** the route hands the order shape to both kernel calls — `validateFireAt` fails closed without it, so this is not a convenience; the ticket's time input is minute-precise over the accepted window and its client echo states the venue rule in the server's own words, then names which part is still unmet (the rule has three parts and a rule change resets time-in-force, so it is easy to half-satisfy on the one screen where it must be fixed); `ensureEventSchedule` treats a stale cron or timezone as missing, so an existing leg re-creates onto the every-minute cadence the first time the operator schedules something. The server stays the authority and remains the only side that names an exchange holiday.
- **Remaining:** the operator-side proof only — no code is outstanding.
- **Done when:** a 07:30 extended-hours limit day order is accepted from the ticket and fires at 07:30; a 09:37 fire time is accepted and fires at 09:37; picking an exchange holiday is refused with the holiday named; the ticket never offers a minute the kernel would refuse.

### Trading — earnings-reaction rules: the surface, and the decision to arm one (ADR-136 D5)
- **Kernel shipped 2026-09-06:** the rule store, the held-names-only EDGAR watch for an item-2.02 8-K, the analyst read against the company's own filed numbers, and the mapped action through the one order path — all on the trading-events full tick behind `TRADING_EARNINGS_RULES` (default false). Truncation is never silent (`fired_short` + `shortReason` + the exposed share count) and an ambiguous submission is settled against the venue's own order record before anything is re-placed, with a BUY never re-placed at all.
- **Remaining:** (1) the surface — rules can only be created and read through the kernel module today, so there is no way for the operator to arm or cancel one from the account page; (2) a paper proving run: the feature has never executed against a real broker, and every seam in its guard suite is doubled, so "the venue behaves as typed" is a source-level claim; (3) an adopted order is credited to the rule's state but not written back into the orders ledger — it depends on the normal reconcile sweep.
- **Done when:** a rule can be armed, listed and cancelled from the account page; a paper rule on a held name has fired end-to-end on a real 2.02 filing with the classification, the numbers read and the filing URL in its decision rationale, and a miss on the same rule has sold; and the operator has explicitly decided whether to arm one on a live book (paper-first is the recommendation, with the attempt bound at 1 for the strictest posture).

### Trading — IPO playbook, Anthropic first (ADR-136 D6)
- **Remaining:** the live proof, and two deliberate departures from the original design worth deciding on rather than leaving implied — v1 sizes the entry off the IPO price, not the first-30-minute range/VWAP, and places a fixed STOP rather than a trailing stop.
- **Done when:** the watch fires on the public S-1 filing; the reminder sequence fires at T-3/T-1 days and T-0 morning with the schwab.com link; the playbook's orders are dry-run-listable for the chosen account before pricing day.

### Trading surface — the browser half of the strict-CSP proof (ADR-136 D2 tail)
- **Remaining:** the browser half, which the repo cannot fake — load the surface with `OSHAL_STRICT_CSP=on` on the dev box and exercise every action. Note the precedence the guard records: `OSHAL_CSP_REPORT_ONLY` beats `OSHAL_STRICT_CSP`, so a canary run with report-only still set proves nothing. (The earlier `CSP_MODE=strict` in this entry was not a real flag.)
- **Done when:** a human has driven the surface under enforced strict CSP with zero violation reports for `/api/trading/*`, and the run is recorded.

### Trading — live (Schwab) books still poll: the Schwab streamer is not integrated (ADR-143 D6)
- **Remaining:** ADR-143 streams Alpaca-backed books (build pending, see the entry above) but live Schwab books keep the 5 s REST poll of `/marketdata/v1/quotes` — no `userPreference` → `streamerInfo` resolve and no `LEVELONE_EQUITIES` socket exists in `src/`. The streamer is per-LOGIN (the bearer is the caller's), so it is one socket per connected login, not the process singleton the Alpaca leg uses. Correction to the earlier wording here: the relay rail is a new book-keyed SSE route (the kernel's `stream-manager` is task-keyed and `surface-bridge` is a postMessage contract, not SSE).
- **Done when:** `streamerInfo` is resolved per login through the existing Schwab token resolver; LEVELONE_EQUITIES prints are relayed on the same `GET /api/trading/stream` route and frame shape as the Alpaca leg; a spec proves the Schwab bearer never reaches the browser; the live ticket updates within a second of a print during regular hours.

### Trading — market movers: add Alpaca's REST screener as the whole-market source (ADR-143 D5)
- **Remaining:** a read-only probe on 2026-09-07 with the paper key answered 200 on `GET /v1beta1/screener/stocks/movers` and `.../most-actives?by=volume` — whole-market movers can ride the OWNED key over REST; no paid screener is needed. `GET /api/trading/reports/movers` gains the screener as a second, labelled source (winners/losers ← `movers`, active ← `most-actives`; `volatile` stays on the bounded daily-bar board), printing the vendor's `last_updated` and the label "Alpaca screener" (the reference page calls the data "Real time SIP data" — the vendor's statement, not a measured guarantee), with a stated minimum-price / asset-directory filter because the raw board is dominated by sub-$1 warrants, and today's bounded report as the fail-soft fallback on any non-200.
- **Done when:** with the paper key configured the movers report covers the whole US-equity board for winners/losers/active with source + `last_updated` shown on the surface; without it (or on a screener error) it degrades to today's bounded report, never a blank.

### Trading — cash-account settlement: the autopilot clamp (ADR-134 D8 tail)
- **Remaining:** wire the autopilot clamp. `settledBuyingPower(account, book)` is exported and unit-pinned but `capAccount` is untouched, because the dispatch module is being decomposed. CONSEQUENCE until it lands: an autonomous BUY on an ENABLED cash book that needs unsettled proceeds is REFUSED at the engine rather than sized down — noisy but safe, and moot today because the IRA book is disabled.
- **Done when:** `capAccount` in the post-decomposition dispatch module starts with `account = settledBuyingPower(account, book);` and a spec pins that a rotation's post-sell re-read on a cash book sizes against settled cash only.

### Trading — cash settlement: three narrower gaps (ADR-134 D8)
- **Remaining:** (1) `settlesOn` is weekday-only — it should skip NYSE holidays and share the calendar the ADR-136 D4 timed-order validator now carries. (2) Alpaca exposes no unsettled figure, so a cash-type Alpaca book falls back to the book's own ledger — reconcile it against the venue's non-trade activities or document it as ledger-only. (3) The legacy live book is typeless, so it pays one venue read per BUY and fails closed to a 503 when that read fails, even though it is a MARGIN account at the venue.
- **Done when:** the settlement date skips exchange holidays; the Alpaca path is reconciled or explicitly documented as ledger-only on the surface; and the legacy live book carries a discovered `accountType` so neither the extra read nor the fail-closed refusal applies to it.

### Deploy modes — `codebase` vs `codeless` development posture (ADR-137 amendment A)
- **Remaining:** the operator's fourth axis is recorded, not built: a `codebase` swarm may modify its own code through the developer rails; a `codeless` swarm (installed from Docker images only) may not, and files defects to a tracker (repo issues or Bugzilla) instead. Needs a posture read in `resolveDeployPosture`, a gate on the oshal-developer / self-modification rails, and a defect-submission connector chosen and registered per `docs/partner-app-registration.md`.
- **Done when:** `OSHAL_DEPLOY_MODE` (or a sibling `OSHAL_DEV_POSTURE`) resolves `codebase|codeless`; on `codeless` every self-modification rail refuses with a named reason and a defect ticket lands in the configured tracker from a real failing build; `tests/unit/deploy-mode.spec.ts` covers both; ADR-137's amendment table moves both rows from "recorded" to "built".

### Node app — prove the npm install path on a bare machine
- **Remaining:** `@oshal/chat@0.3.0` is on the registry (published 2026-09-08, 54 files; it carries #300's in-node print service, #302's satellite login push, and #364's Windows login-launcher fix), and `scripts/npm-parity-check.sh` now reports the registry in sync. The registry copy itself was verified with `npm pack @oshal/chat@0.3.0` — its `windowsLoginArgv` returns the fixed, quote-free argv. What has still never been exercised is the path the Get oshal Desktop tile hands a stranger: `install-oshal-node.cmd` on a machine with **no checkout**, installing from npm rather than from this tree. Every proof so far has been on the operator's box, where the app runs Electron straight out of `packages/oshal-chat`.
- **Done when:** a Windows machine with no oshal checkout runs a freshly downloaded `install-oshal-node.cmd`, the node appears owned under "Your computers" on `/cockpit/tools/devices.html`, its Config screen's "Log in + push" opens a console running `claude auth login` from the PUBLISHED build, and the in-node print service is reachable — recorded in the real-boundary audit as the first bare-machine proof of the npm path.

### Node app — one-click installer for macOS and Linux
- **Remaining:** `GET /api/join/node-installer` renders a Windows `.cmd` only, and the Get oshal Desktop tile says so. The node app itself installs from npm on macOS and Linux, and the five values the Windows script seeds (`OSHAL_CONTROL_PLANE_URL`, `OSHAL_SHARED_SECRET`, `OSHAL_ENROLLMENT_TOKEN`, `OSHAL_CLIENT_ID`, `OSHAL_CLIENT_NAME`) are platform-neutral, but no script renders them for a shell and the path has never been run on a Mac or Linux box.
- **Done when:** the route renders a platform-appropriate script (`?platform=macos|linux` → a `.sh` carrying the same per-device token and nothing swarm-wide, refusing the same loopback and quotable-character cases), the Desktop tile offers it by detected platform, and one real macOS or Linux machine with no checkout registers owned through that file — recorded in the real-boundary audit.

### Node enrolment is the blocker for every remote-node capability
- **Remaining:** this swarm sets `REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true`, which retires the swarm-wide secret — but `installer/lib/install-node.ps1` still configures a node with `REMOTE_CLIENT_SHARED_SECRET`. A freshly installed node is therefore refused at `POST /api/remote-clients/register` (`refused swarm-wide shared secret: … re-enrol this node`), observed live 2026-09-06. Device-bound tokens come only from `POST /api/join/enroll`, which is mounted behind `requiresAuth` (a real OIDC session), so nothing headless can mint one — `POST /api/cli-tokens` mints an UNBOUND, 30-day PAT, which is more reach than a node should hold and expires under it. Until this is closed, a remote node cannot join, cannot run swarm work, and cannot deliver printed documents.
- **Done when:** a machine with no checkout runs the one-click installer, enrols on a device-bound non-expiring token, appears **owned** in the cockpit mesh view, and survives a reboot without a human — with the shared-secret path removed from the installer rather than left as a silent fallback.

### The node-resident printer needs installer support to work on a fresh machine
- **Remaining:** three gaps, all found 2026-09-06 while proving the printer on this box. (1) The installer runs `npm install` in `packages/oshal-chat` only, so `@oshal/print-drop`'s one runtime dependency (`bonjour-service`) is never installed — the printer still serves over WSD (which is how Windows discovers it) but loses mDNS, so Macs and iOS never see it. (2) The installer creates **no firewall rules**; on this box the working `oshal print-drop IPP` rule is TCP/631 `profile=Private`, hand-made, and the node's port has none — the blanket `node.exe` allows are **Public profile only**, so a Private LAN is blocked, and testing from the machine itself passes because loopback is exempt. (3) `@oshal/print-drop` is `private: true` and `@oshal/chat` does not declare it, so `npm install -g @oshal/chat` can **never** deliver the printer (`resolvePrintDropEntry` looks for `node_modules/@oshal/print-drop`) — decide between publishing it as a real dependency, bundling its files into the chat package, or accepting repo-checkout-only.
- **Done when:** a machine with no checkout installs the node, enables the print service, and a **second** machine on that LAN sees the printer in its own Add-a-printer dialog and prints into the swarm inbox — with the firewall rule created by the installer, not by hand.

### ADR-140 local device access — acceptance and the P1 inputs
- **Remaining:** [ADR-140](adr/140-local-device-access.md) is **Proposed**; core is untouched pending acceptance (Rule 0d). P0 is cleared (amendment A: Electron 43 reaches the radio and the serial bus on Windows; the "native module per OS" risk is retired) and amendment B reframed it around the operator's correction — this is **outbound**, the swarm's hands, not device sensing. Two operator inputs are still owed: the `actuate` gate (confirm every physical action, or pre-authorize per device?) and a real BLE **GATT peripheral** for P1 — the empty scan proved the AirPods and BT mouse on this box are Bluetooth Classic and structurally invisible to Web Bluetooth.
- **Done when:** the ADR is Accepted or amended, and P1 (outbound print — the swarm prints a document to a chosen system printer, confirm-gated, attributed to the node's owner) lands with a guard that crosses the Electron boundary rather than asserting from plain node.

### print-to-rag has no user guide and no page on the site
- **Remaining:** inline documentation is complete (64 functions, 64 `@description` blocks across every print-drop file), but `docs/guides/` holds 17 guides and none of them is printing; what exists is `docs/apps/print-ingest-spec.md`, written for whoever builds it rather than whoever uses it. The site has **zero** mentions of print-to-rag. There is a structural reason the page cannot simply be written: the site generator works from manifests, and `print-ingest`'s manifest still says `status: inactive` — toggling the database row (done 2026-09-06) makes the app serve but leaves it invisible to the generator.
- **Done when:** `docs/guides/printing.md` exists and is linked from the guides README, and a product page renders for print-ingest — which requires deciding whether the manifest `status` should flip to `active` or whether the generator should stop treating install-state as publish-state.

### Session cleanup left on the operator's box (2026-09-06)
- **Remaining:** two deliberate changes were left in place after proving the printer, both stated to the operator at the time. (1) An operator PAT minted this session, **id `f17a2172-9345-4770-aab9-2e1dd3f84a1f`**, is now orphaned — it was held by a manually started print-drop on port 632 which was stopped, and the node's printer uses the node's own credential instead. It is unbound, operator-scoped and expires 2026-10-05. (2) `printServiceEnabled` was left **true** (port 633) on this machine's node, which is an outward-facing service advertising on the LAN. Revoke **by that exact id** — never by label, which cost five other sessions' tokens once.
- **Done when:** the PAT is revoked by id and confirmed via its `revoked` field (not a guessed field name), and the operator has decided whether the node's printer stays enabled on this machine.

### App status contract (ADR-145) — build the `status:` declaration and the highlights section
- **Remaining:** add `status?:` to `SwarmAppManifest` with a `validateStatusDeclaration` beside the readiness validator (own mount, canonical path, session-admitting route, valid RFC 6901 pointers); the pure D2 coercion (≤4 tiles / ≤5 items truncate rather than reject, unknown tone degrades to `neutral` and never escalates, wrong-typed pointer yields "can't check"); `getAppStatusPlan(name)` resolving a group OR an app; the generalised dashboard route plus the `jarvis_tasks` fallback read; and the highlights section in `app-group-setup.html`. Then kalshi as the first store adopter — it already computes every number the contract asks for.
- **Done when:** a manifest declaring a `status:` that is unowned, non-canonical, service-only, or malformed fails the load (extending `tests/unit/swarm-app-groups.spec.ts`); a pure spec pins the caps, the tone degrade, and the can't-check path; a REAL-BOUNDARY case drives the plan route against a live app probe over an actual HTTP mount (not a mocked resolver) and is recorded in the real-boundary audit; and a signed-in operator sees one app's tiles and items rendered beside its setup steps on the shipped page, with a deliberately broken probe rendering "can't check" rather than a green state.

### A global Home composing every app's status card (ADR-145 D9)
- **Remaining:** a second renderer over the ADR-145 plan that fans out across every active app the user has, one card each. Needs a harder fan-out bound than D7's per-page one (59 active apps on the operator's box today) and probably a short-TTL cache. Also forces two decisions ADR-145 deliberately left open: what supersedes the cockpit `DashboardHomeView`, and whether the orphaned `src/pages/user-dashboard/` is retired or deleted outright (it is mounted at `/user-dashboard` and referenced by nothing).
- **Done when:** one page renders a card per active app within a stated latency budget under the real installed-app count, a slow or failing app degrades to "can't check" without delaying the others, the superseded surface is removed in the same change rather than left as a second answer, and no card displays a value its owning app did not assert over its own declared route.

### Codex swarm-side OAuth — the token exchange fails at the last step (2026-09-08)

- **Remaining:** the redirect half is fixed and proven (core #372): `GET /api/openai-codex/oauth/start` now mints a valid authorize URL (`auth.openai.com/oauth/authorize`, the Codex CLI's own `client_id`, `redirect_uri=http://localhost:1455/auth/callback`, PKCE S256), the dedicated `:1455` listener accepts the redirect, and `/auth/callback` forwards a codex-shaped callback to the codex handler. A real browser round trip delivered a genuine authorization code (`code=ac_…` with the exact state the swarm minted). **The exchange then failed**: `openai-codex-oauth-routes` threw `TypeError: fetch failed: other side closed` about 34 s after `Completing OpenAI Codex authorization flow`, so nothing was written back and the browser showed `ERR_EMPTY_RESPONSE` / "Authentication Failed". Cause NOT identified. Basic egress to that host is fine (DNS resolves to Cloudflare, TCP 443 connects, TLS completes); the 403 a bare `GET https://auth.openai.com/` returns is Cloudflare's normal answer to a request with no browser headers and reproduces from the host too, so it is not evidence of a block. Candidates not yet tested: Cloudflare refusing the POST to the token endpoint from a datacenter/NAT egress, a proxy/TLS-inspection layer, or a client assertion the exchange omits (the CLI's own authorize URL carries `codex_cli_simplified_flow=true` and `originator=codex_cli` plus a broader scope, which the swarm's URL does not). ⚠ Do NOT brute-force retries: repeated failed authorize attempts risk rate-limiting or flagging the OpenAI account (operator, 2026-09-08).
- **Done when:** one `/start` → browser → `:1455` round trip completes with the swarm logging a successful token exchange and `GET /api/openai-codex/oauth/status` reporting `authenticated:true` with an `expiresAt` that provably came from THAT exchange (not from a pre-existing credential or a refresh), captured in the real-boundary audit; and if the cause turns out to be the missing CLI flow parameters, the authorize URL carries them.
- **Workaround meanwhile:** the file-push path works end to end — `codex login` on the machine, then **Push to swarm** in the node app (`POST /api/openai-codex/oauth/import`), verified 2026-09-08.

### MOCK_OIDC truthiness — one predicate, three readings
- **Remaining:** `isMockOidcEnabled()` (`src/shared/middleware/oidc.ts`) accepts `true|1|yes`, but `src/app/server.ts` tests `MOCK_OIDC === 'true'` exactly in two places — the demo-auth route mount and the `/api/auth/user` mode string. A deployment setting `MOCK_OIDC=1` gets the full auth bypass while reporting `mode:'oidc'` and missing the demo login routes. Every doc says `=true`, so doc-following deployments are unaffected. Found by the 2026-08-30 login-framework docs audit; flagged because SECURITY-POSTURE.md treats this flag as the bypass switch.
- **Done when:** both `server.ts` call sites read the shared helper (or the helper narrows to exactly `'true'` — either way ONE source of truth), and a unit guard proves `MOCK_OIDC=1` and `MOCK_OIDC=true` behave identically across all three call sites.

### partner-app-registration.md covers about a third of the wired hub connectors
- **Remaining:** the registration reference table omits ~19 providers that are wired in `connector-provider-registry.ts` (schwab, slack, square, paypal, plaid, jira, twilio, walmart, uber, uber-rides, duffel, ringcentral, kalshi, finnhub, bluesky, resend, plus the ADR-065 PAT batch). The generated per-spec pages under `docs/connectors/` do not cover partner registration (portal steps, env-var names, redirect overrides). Found by the 2026-08-30 connection-framework docs audit — the doc's own "every connector named here is wired" claim holds, but the reverse direction does not.
- **Done when:** every `PROVIDERS` entry with auth `oauth`/`link` has a reference row (env keys verified against `providerCreds()`, redirect path/override named), or the doc explicitly lists which providers are PAT-paste-only and points at their `tokenHelpUrl`; any count in the doc derives from the registry, never typed.

### Entra/local hybrid + identity bridge needs its decision record
- **Remaining:** the composition is shipped (`application-auth.ts`, `entra-local-identity-bridge.ts`, `oshal_external_identity_links`; introduced 2026-08-17 per git log) and as of 2026-09-09 has an operator guide (`docs/security/entra-local-hybrid.md`), but no ADR: ADR-126 explicitly scoped LOCAL_AUTH out, and the design intent lives only in change-log headers and `.env.example`. Decisions worth recording, none of them derivable from the guide alone: link-once with no unlink/expiry rail, allowlist gating the FIRST link only, and an invited account being auto-accepted on link with the password invite left intact as rollback.
- **Done when:** an `NNN-entra-local-identity-bridge.md` ADR records context/decision/consequences with a status line matching as-built, is indexed, ADR-126 carries a pointer to it, and the operator guide links it back.

### ADR-145 Home view: the browser render is still unverified (2026-09-09)
- **Remaining:** the deploy half is CLOSED. `scripts/oshal-deploy.sh` ran unpiped to exit 0 on 2026-09-09 (image `4e6773a850c5`, label `b10f79f060eb` == HEAD), the `api fully up (healthy + auto-load)` gate that failed the two prior attempts passed in 26 s, census 35/35 healthy with parity clean and 0 restarts. The earlier failures were host memory pressure, not ADR-145: the box had ~1 GB available of 15.7 GB, and stopping the 34 bots the deploy recreates anyway (dropping the daemon's polled container count 46 -> 12) was enough for the gate to clear. `GET /api/swarm/apps/home-plan` was then verified AS A SIGNED-IN USER via a bootstrap-minted PAT (revoked by captured id immediately after, `revoked:true`): HTTP 200, 33 KB, **67 cards — 65 `kind:app` + 2 `kind:group`**. What is NOT verified is the part that needs a human at a browser: that the cockpit Home view actually RENDERS those cards, and that an app whose probe is broken degrades to "can't check" rather than showing a green state. Core returns manifest data only — every status/readiness probe is issued by the page in the viewer's own session (ADR-145 D6) — so no headless call can exercise the render or the degrade path.
- **Done when:** a signed-in operator opens the cockpit Home view and sees one card per active group/app, and an app with a deliberately broken probe renders "can't check" instead of a green state.

### Cockpit rail: static tiles that target another package must follow that package's discoverability (ADR-149)
- **Remaining:** a launcher-shaped app (Create, Life, Games, the creative bundle) declares `ui.static` tiles whose `iframeUrl` points at ANOTHER package's surface. Under ADR-149 enforce mode the target may be unprovisioned for the signed-in person; the rail still renders the tile and a click lands on the kernel's role-guidance 403 page inside the frame. Create's own surfaces ask `GET /api/authorization/me?app=` and render such studios locked (create 1.2.0), but the rail is manifest-static and `synthesiseProfile` has no view of the target app.
- **Done when:** `synthesiseProfile` resolves, for each static tile whose `iframeUrl` is under another active package's mount, that package's `canDiscover(actor)` and renders a non-discoverable target as a locked tile (kept in place, `guest-disabled` style, with the role-guidance link) rather than a dead frame; ADR-141 groups get the same treatment for borrowed tiles; a unit guard proves a discoverable target keeps its tile, a non-discoverable one is locked, a tile under the app's OWN mount is never touched, and legacy-mode packages are always discoverable; no manifest change is required.

### Jarvis thread and briefing-asset fix: deployed, live proof outstanding (2026-09-14)
- **Deployed (checked 2026-09-14):** `7aae3ce5` is on `main` and an ancestor of `b8de2099`, the PR 431
  merge, and `scripts/oshal-deploy.sh` deployed `b8de2099` on image `1fe73566ae87` (api + 34 bots,
  parity clean) — the deploy record naming the image and commit that the done-when asks for.
- **Remaining:** the two live proofs in the done-when. History, for context: before that deploy the
  fix reached users only on the next core deploy. Verified on the box at 02:36 UTC: the running
  image (rev `1694a3ca`) has `/app/dist` but no `/app/dist/pages`, so the briefing settings client
  asset cannot be served from `dist`; session 56e3d403 recorded the matching
  `GET /api/jarvis/briefings/client.js` 404 under a signed-in probe, and fixed the route to serve
  from `src`. `src/api/jarvis.html` is bind-mounted, so the thread half of that fix is already live
  while the route half is not — the two halves ship together only at deploy.
- **Done when:** a core deploy from the merged PR 431 head serves the briefing settings asset with
  a 200 to a signed-in operator, a refused persisted thread rolls to a fresh one in the live
  surface, and the deploy record names the image and commit. Nothing here needs new code.

### Test Lab browser runner: the real-boundary proof has not run (2026-09-14)
- **Remaining:** the disposable browser profile is built and pushed (`08440e77`, docs `d07aba01`,
  merged at `ed2a4f95`), and its admission, harness and re-seal rules pass as pure tests. The two
  Docker cases in `tests/unit/package-test-sandbox.spec.ts` — the in-profile capability probe on
  the real image, and a Node-harness Playwright recipe driving loopback with the network off —
  have never been executed. Two attempts were declined by their own guards: the Windows host had
  381 MB free at 01:37 UTC, and the Docker VM's one-minute load was 22 at 02:22 and 133 at 02:36
  on 8 CPUs while other lanes held their own rebuilds. Until those cases run, the browser profile
  is proven only against mocked boundaries and must not be described as working.
- **Run it with:** `npx vitest run tests/unit/package-test-sandbox.spec.ts -t "browser profile|browser environment"`
  from the core checkout, with Docker up and `oshal-bot:latest` present, when the Docker VM's
  one-minute load is below 6 (read it with `docker exec oshal-local-api cut -d' ' -f1-3 /proc/loadavg`).
- **Done when:** both cases pass on the image, a Create browser recipe runs to a result from the
  installed Lab after a core deploy, and the batch path admits the `browser` level — schedule
  levels, the selector's exact-match rule and the page's counts are a separate slice, and changing
  the selector rule must not strand the existing `integration,unit` selector the operator uses.

### AI Office: draw a deck, document or workbook in a brand kit's exact colors and fonts (2026-09-14)

**Context:** Create 1.8.0 stores a person's brand kit (role colors, an Office-safe heading and body face, a
logo and a voice) and every other studio now reads it. AI Office can only *approximate* it: it badges and
pre-picks whichever of the ten built-in looks scores nearest the brand, because `resolveTheme(id)` in
`src/features/presentation-generation/services/deck-themes.ts` resolves a look by id out of the fixed
`DECK_THEMES` record, and `renderPptx` / `renderDocx` / `renderXlsx` accept only that id. A package cannot hand
the renderer a look, so a brand's actual colors and faces never reach the generated file. This needs core and
is not started; the operator asked for a brand kit, not for a renderer change.

**Done when:**
- `resolveTheme` accepts a known id **or** a validated custom look, `docxTheme`/`xlsxTheme` take the same input,
  and the three renderers' `options.theme` type widens to match. An unknown id still falls back exactly as today.
- A `brandTheme(input)` validator derives a complete `DeckTheme` from `{ base id, role colors, heading and body
  face }`: every hex bounded, faces restricted to the existing Office-on-Windows-and-macOS list, chart colors
  derived from the roles, and cover / decor / radius / headingCase inherited from the named base look.
- An invalid custom look is refused with a readable error and never silently becomes the default look.
- The presentations package passes the caller's own kit (already validated and owner-scoped by Create) and the
  stored record names the look as a brand look, so a generated file's provenance stays legible.
- Unit specs prove: a custom look renders its own colors and faces into .pptx, .docx and .xlsx; a refused look
  renders nothing; the ten built-in looks are unchanged.
- No new dependency, and no core route reads Create's storage.

## Animatronics and the maker labs

### An open maker-reference library the engineering bots can cite (2026-09-14)

**Context:** the animatronics work ([ADR-156](adr/156-animatronic-props-as-a-peripheral-kind.md)) started from a
survey of open animatronic and robotics builds, and the reasoning we took from each is recorded prose in
[animatronic prop hardware](architecture/animatronic-prop-hardware.md) §5. The operator keeps finding more of
them and wants them kept. Today `animatronics-bot`, `small-motors-bot`, `robotics-bot` and `3d-printing-bot`
carry that kind of knowledge as persona prose with no sources, and nothing can cite a build, diff two
approaches, or answer "has anyone solved this mechanism already". The RAG rail that would hold it already
exists (`infra-runbooks` is the only collection, and personas already curl `/api/rag/search`).

**Done when:**
- A `maker-references` collection holds one document per build with the same fields every time: what it is,
  the mechanism or subsystem, the actuators and controller it uses, the licence, the source URL, and what a
  reader would take from it. Provenance is a `web:` prefixed `doc_id` per the citation rule.
- Adding a reference is one command against a URL and a short note, and re-running it updates rather than
  duplicates; nothing is vendored into the tree.
- `animatronics-bot`, `small-motors-bot` and `robotics-bot` search that collection before answering a
  mechanism question and cite `doc_id`s, with a red-proven case that an uncited answer fails review.
- A build whose licence forbids reuse is recorded as a reference and marked not-to-copy, so the catalogue
  never silently launders code.

### The `prop` kind belongs in embodied's vocabulary (2026-09-14)

**Context:** [ADR-156](adr/156-animatronic-props-as-a-peripheral-kind.md) D6 declares the ADR-151 D1 `prop`
kind inside the `animatronics` package because `embodied` was under an open claim the day it shipped. Two
packages now describe one vocabulary. `animatronics/tests/engine-kind.test.js` pins the manifest's field set to
embodied's `CapabilityManifest` and asserts embodied still refuses the kind, so it goes red the day the fold-in
lands — by design, and the only thing keeping the duplicate temporary.

**Done when:**
- `KIND_VOCABULARY.prop` exists in embodied's capability manifest with senses `channel-state`,
  `controller-hello`, `supply`, acts `pose`, `scenario`, `look-at`, `jog`, `arm`, `disarm`, `e-stop`, minimum
  safety class 1, and `disarm` in the confirm-exempt set.
- The animatronics package imports that row instead of declaring its own, its seam test is rewritten to assert
  the import, and a rig's manifest validates under embodied's own `validateManifest`.
- Whether a `prop` also becomes a node on the rail stays gated on the ADR-149 decision the embodied backlog
  already records; this entry is the vocabulary only.

### One parts model across Circuit Lab, Animatronics and Embodied (2026-09-14)

**Context:** three packages now describe the same physical parts in three places — Circuit Lab's shaft-driver
catalog (motors, servos, steppers with nameplate numbers), the animatronics servo catalog (pulse range, travel,
speed, currents, torque, mass, price), and embodied's parts model (masses, prices, motor curves feeding MJCF).
Circuit Lab's own backlog already carries the half of this that pairs it with embodied ([ADR-152](adr/152-embodied-physics-and-training-lab.md) D1).
A servo bought once should be describable once.

**Done when:**
- One row per real part is the source: identity, mass, price and a source line, plus the per-domain blocks
  each lab needs (electrical nameplate, pulse and speed, inertia and curves), and each package reads the
  blocks it understands rather than restating name, mass or price.
- A cross-package read-only test fails when a part's shared fields drift between packages, the way Circuit
  Lab already reads embodied's parts model and animatronics reads embodied's manifest module.
- Neither the store's package-separation guard nor the canonical route compile is weakened to allow it: the
  shared rows travel as data, not as an imported runtime.

### Animatronic props: the bench, tracking, dynamics and sound (2026-09-14)

**Context:** `animatronics` 0.1.0 rehearses and drives a rig, and its own backlog carries the done-when
criteria. Four of those items need something outside the package and are worth seeing from here: hardware, a
camera, a physics model and audio.

**Done when:** the package's B2 (the reference ESP32 sketch compiled, flashed and bench-proven with a scope on
one output, then a Test Lab case with a hardware prerequisite), B3 (a detected face becomes a bearing at a few
Hz with a dead-band, so `look-at` tracks a person — the operator's original "eyes that follow you"), B5 (servo
load, inertia and stall on the rehearsal, with Circuit Lab's servo part as the electrical companion) and B6 (a
jaw driven by an audio envelope, and a Pumpkin `speak` triggering it through a browser hand-off, never a
server-to-server call) are each closed on their own criteria. None of them needs core code today.

### Jarvis refused-thread recovery: finish the live proof and make it a Test Lab step (2026-09-14)

**Context:** "Sorry — I couldn't do that just now" on the box was two defects
([runbook](runbooks/jarvis-couldnt-do-that-just-now.md)): the page kept resending a bookmarked thread id the
server refuses under `enforce` (every thread created before issuer provenance, 2026-09-11), and the briefings
settings assets resolved through `__dirname` into a `dist/pages` that does not exist in the image. Both fixed in
`7aae3ce5` with red-on-old-code guards; the page half is live on reload, the router half needs the next core
deploy. The live proof was cut short by two Docker engine wedges on the host, so three pieces are still open.

**Done when:**
- `tests/unit/jarvis-legacy-thread-browser.spec.ts` (real page in Chromium against the real Jarvis router and
  an isolated Postgres) has executed green on a box with Docker, and is kept in the Test Lab dashboard scenario's
  regression list. It is written, typechecks, and is registered; it has not run.
- The two live scripts in `scripts/operations/jarvis-live-*.js` have each produced one recorded pass on the
  box: the operator's real question answered through the live brain (PAT path; answer read from
  `chat_messages`, PAT revoked by id), and the guest Chromium pass showing `404 session_not_found` on the
  planted thread, `202` on the fresh one, an answer bubble, and the new row stamped `urn:oshal:guest`.
- The core deploy has shipped `7aae3ce5` and the Test Lab `cockpit-daily-dashboard` step "Briefing settings
  client" reads `pass` on the box (today it reads `gap`).
- The cleanup in the runbook is verified: PAT `jarvis-operator-ask-56e3d403` revoked by id, any
  `jarvis-validate-56e3d403*` thread and `jarvis-legacy-e2e-*` row deleted by exact id.
- **Innovation to land:** a Test Lab step, run as the signed-in user on the box, that creates an issuer-less
  thread for that user through the task store, asks on it (expects `404 session_not_found`), asks on a fresh id
  (expects `202` and a row with the caller's issuer), and deletes both — so the exact failure the operator hit
  is exercised live by the Lab on every run, not only by fixtures. Needs a server-side cleanup path for the
  rows it creates; it must never touch a thread the user actually uses.

### Package-owned engine containers need a documented pattern (2026-09-14)

**Context:** two packages now run their compute in a container the package owns, because the api image is
Alpine and their Python stacks publish glibc-only wheels — `aero-lab` 1.2.0 (aerosim; casadi has no musl
wheel) and `cad-studio` 0.1.0 (OCCT/CadQuery). Both arrived at the same shape independently: an
`engine/container/Dockerfile` built locally from upstream images and PyPI pins (nothing third-party
committed, no image published), an `engine/install-engine.sh` run from inside the api container, its own
compose project so the core deploy's `--remove-orphans` cannot sweep it, a join to the stack network by
alias with no published port, and a build-hash handshake so a container built from a different package
tree is refused with the exact reinstall command instead of answering with stale physics. The store's
[BUILDING-EXTENSIONS.md](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/BUILDING-EXTENSIONS.md)
has no section on any of it, so the third package will hand-roll it again from two sources that already
disagree in small ways.

**Done when:**
- BUILDING-EXTENSIONS.md carries the pattern with both shipped precedents named, and a new package can
  follow it without reading either package's source.
- The three properties that are load-bearing are stated as requirements, not options: the compose project
  name is the package's own and is asserted after `up` (an inherited `COMPOSE_PROJECT_NAME` silently put
  the first one in the core project, where the next deploy swept it); the container carries no
  `oshal.tier` label (that is the Prometheus docker_sd selector for core/worker tiers); and a stale
  container is refused with the install command rather than served.
- The capability route hands the surface the reason and the install command, so no surface hardcodes
  setup instructions — the behaviour aero-lab's engine-down banner already has.
- An installed package ends up with a working engine without an operator step, or the refusal path is
  explicit: either the installer runs a declared post-install command, or the first engine call builds
  and starts the container, and when it cannot, capabilities stay false with the exact command.

### A calendar-preparation agent: brief me before the meeting (2026-09-14)

**Context:** operator's idea, 2026-09-11, while the Calendar Preparation surface was being pinned to the
default rail (Communications group, `/api/calendar/review`). That surface is a review page, not an agent.
What was described is the agent behind it: before a meeting, the person gets a notification carrying a
brief — what was discussed with these people last time, notes and actions from previous meetings,
who the attendees are and the background the swarm already holds — assembled in the background on a
schedule rather than at request time. The material it would read already exists in pieces: ambient recall
(ADR-100 phases 2-4), transcripts, the identity records, and the calendar package's own domain state.

**Done when:**
- A dedicated ticket type assembles a per-meeting brief for the caller's own calendar from previously
  recorded material, on a schedule, and stores it in the calendar package's `user_sub`-keyed state.
- Every claim in a brief cites what produced it (a transcript, a note, a prior brief); an attendee or a
  meeting with no history produces an honest "no prior context", never invented background.
- Delivery goes through an existing channel (notification, Switchboard or mail) and is consent
  default-OFF per the automation opt-in rule — the brief is assembled for the caller only, and nothing
  the caller has not authorised reaches reasoning.
- The surface shows the same brief it sends, so what the person reads and what was delivered cannot drift.

### Spaces → embodied: the drone simulation starts a world from a real scan (2026-09-14)

**Context:** the operator asked whether an imported Space can be worked into the drone flying program.
The drone program is the store package `embodied` (ADR-151, ADR-152): its `WorldSim` starts from a
hidden `Scene` (room box, axis-aligned obstacle boxes in metres z-up, surfaces/objects/zones/appliances)
chosen by id from `engine/world/scenes.ts`, and the drone discovers that scene through its own LiDAR
sweeps. ADR-151 D3 and open decision Q3 already say the world model is the Spaces scan. The Spaces half
is built and installed: `spaces` 0.8.0 (store commits `9cf1639b` + `45aa3aff` on
`feat/package-test-catalog-pilots`) serves `GET /api/spaces/scans/:id/scene` — the ready scan's splat
mapped into embodied's frame (+Y-up Spaces frame → z-up by a proper rotation; `up=auto` puts the dense
floor at the bottom, 3DGS exports are usually −Y up), the 1st–99th percentile box with floaters
clipped and counted, scale 1 for a metric LiDAR import or fitted to `ceilingM` (2.4 m) otherwise,
5 cm voxels coarsened until the box cap (1500) fits, occupied voxels merged into `kind: fixture`
boxes, drone home and base park on the clearest open floor. `GET /api/spaces/scenes` lists the
caller's ready scans as ADR-139 `provides` artifacts of type `application/vnd.oshal.embodied-scene+json`
and the Spaces surface tags every ready scan as a send-to source. The package README documents the
query contract; `spaces/tests/spaces-embodied-scene.test.js` proves the converter against the compiled
module (14/14 with the surfaces suite). What is missing is the embodied half — the `embodied/**` claim
was held by another session, so it was requested in the store thread (2026-09-14 01:40 UTC), not built.

**Done when:**
- `embodied/oshal-app.yaml` declares `artifacts.accepts` `{ id: scene, label: "Fly it in embodied",
  types: [application/vnd.oshal.embodied-scene+json], mode: post, endpoint:
  /api/embodied/world/scenes/import-artifact }` and the endpoint redeems `{ ref }` through
  `redeemArtifactViaRelay` (the idiom `spaces-routes.ts` uses for `/scans/import-artifact`), parses
  `{ scene, stats, scanId, title }`, runs `validateScene` plus size caps (obstacles ≤ 1500, room ≤ 30 m a
  side), and registers the scene per owner under `scene.name` (`scan:<scanId>`) beside the in-memory
  sessions.
- `POST /api/embodied/world/reset { scenario }` accepts an owner-registered id as well as the built-in
  `SCENARIOS`, and `/capabilities.scenarios` lists the owner's imports after the built-ins so the tile's
  Room selector shows them; an unknown id still answers 400 `unknown_scenario`.
- A route test drives the real compiled router over loopback HTTP with a scene produced by the Spaces
  converter (the sample in the store thread or `GET …/scene` on the box), proves the world resets into
  it, and proves a LiDAR sweep from the drone home paints the scanned walls into the voxel map.
- The 📤 chip on a ready Spaces scan offers "Fly it in embodied" in the cockpit and the world is reset
  into the scan without leaving the browser (ADR-139 post mode), verified by a human on the box.
- The surface says plainly that a scanned box is a hollow shell (a splat is a surface) and that outdoor
  captures need an explicit `scaleM` — the ceiling fit is for rooms.

### Multipart uploads lose the RLS request identity — the same trap sits in core (2026-09-14)

- **Built 2026-09-14 on `fix/backlog-sweep`; not deployed.** `preserveRequestIdentity` in
  `src/shared/middleware/multipart-identity.ts` captures the request identity before multer streams
  the body and re-enters it around the parser's continuation — the spaces 0.7.1 shape, now shared.
- **Scope, re-measured:** core has six multer routes. Four touch the database under the caller's
  identity after the upload and now use the helper: `POST /api/rag/upload` (knowledge-memory
  record; `knowledge_memory_documents` and `rag_chunks` are FORCE RLS), `POST /api/swarm/apps/import`
  (`swarm_applications`, FORCE RLS), `POST /api/jarvis/ambient/audio` (`ambient_user_settings`,
  `ambient_audio_chunk_receipts`, `ambient_speaker_*`, FORCE RLS) and
  `POST /api/agents/:agentId/profile/avatar` (`agents`, which has no RLS policy, so the lost identity
  changed the stamp from operator to anonymous, not the outcome). Two are not exposed and were left
  unchanged: `POST /api/voice/transcribe` touches no database after the upload, and
  `POST /api/artifacts/handles/upload` mints an in-memory handle whose authorization reads all run
  under `runWithSystemIdentity`. Table posture read from `pg_class` on the local stack.
- **Guard:** `tests/unit/multipart-request-identity-postgres.spec.ts` drives the four real routers
  over loopback HTTP with the body streamed in 64 KB chunks with gaps, through the production GUC
  pool, into a FORCE-RLS table as `oshal_app` in a throwaway database the spec creates and drops
  (5/5). Red on all four routes before the fix — rag 500 `RAG ingestion failed`, import 400
  `new row violates row-level security policy`, ambient 500 `speaker_service_unavailable`, avatar
  500 with the same RLS error — and red again on all four when the helper's re-bind line is
  removed. `docs/governance/RLS-RUNBOOK.md` names multipart bodies as an async-context boundary and
  points at the helper.
- **Remaining:** nothing against the done-when; the running api keeps the defect until a core
  deploy carries this change.

### Spaces: the PLY→splat converter runs on the api's event loop and a large import can take the box down (2026-09-14)

**Context:** importing the 117 MB `father-day.ply` from the same public set into the sandbox api
collapsed the 7 GB Docker VM (engine API 500, `docker` CLI hung, the main api unreachable); the 44 MB
`goldorak-ply.ply` had already blocked the event loop for about 14 s, during which a concurrent upload
timed out against `srv.requestTimeout` (30 s). `convertPly` in
`src/features/spatial-mapping/services/import-format.ts` parses the whole buffer into JavaScript objects
on the main thread and the route accepts up to 300 MB. `.splat` passthrough is cheap (65 MB / 2 M
gaussians subsampled in about 6 s).

**Done when:**
- A `.ply` larger than a configured byte gate (default around 50 MB, from config, not a literal) is
  refused at `POST /api/spaces/scans/import` with a 413 that names the limit, before the file is read.
- PLY conversion runs off the event loop (a worker thread or a child process with a memory cap) so a
  large import can neither block other requests nor take the api process with it; the service marks the
  scan `failed` with the reason when the worker dies.
- A regression test imports a PLY above the gate and one below it and proves the api keeps answering
  `/health` throughout.

### Store dependency tiers: manifests converted; catalog mirror and live proof open (2026-09-14)

**Context:** the core reads `dependencies` as `required` / `optional` tiers and the installer, loader
and App Loader honour the difference (ADR-085 addendum). The legacy flat form still loads and means
all-required, which made `create`, `life`, `games` and `system` drag in up to eight apps they merely
route to. The operator approved converting and reclassifying the store **after** a core carrying the
tiers is deployed - a tiered manifest declares the `app-dependencies` floor, which an older core
refuses on purpose. **Both halves have now happened (checked 2026-09-14):** the core carrying the
tiers is deployed (`b8de2099`, the PR #431 merge, per the `scripts/oshal-deploy.sh` log), and the
store conversion merged to `oshal-applications` `main` through PR #197 (`64fb705`) — all 61
`*/oshal-app.yaml` on store `main` use the tiered form and none the flat one.

**Done when:** the plan, the per-package classification with its evidence, and the acceptance
criteria in [backlog/store-dependency-tier-migration.md](backlog/store-dependency-tier-migration.md)
are satisfied. Met, with the evidence recorded in the plan: every store manifest tiered and
validating, and the launchers requiring only what they cannot run without. Still open:
`marketplace.json` mirroring the new shape, and the Test Lab step `app-dependency-tiers` reporting
pass instead of gap against the deployed API.
### Twelve agent ids are claimed by more than one application (2026-09-14)
- **Remaining:** `swarm_applications.agent_ids` is an *association* column (the loader fills it so Jarvis's catalog, mesh fan-out, selector composition and competency ranking can find an app's bot), but the ADR-149 reader `readApplicationExecutionOwnership` reads it as an *ownership* column and raises `Ambiguous package ownership` when an id resolves to more than one app. Twelve ids do; the full census, the evidence for each, and the measured blast radius are in [operations/agent-id-ownership-collisions.md](operations/agent-id-ownership-collisions.md). The refusal is **not new** — before `086832cf` (2026-09-14) the reader failed a type comparison and refused *every* id silently; that commit made unique ids work and these twelve loud. Since the 06:46:14Z boot, 682 refusals, all from `GET /api/tickets`, across 6 of the 12 ids; `career-hunter`/`job-apply` is the largest (204 refusals, 4 operator-owned tickets silently dropped from the operator's own list). Three different problems, and only one of them is "delete the squatter": (1) seven ids are claimed by loose Workflow Studio publish artifacts (`cluster-probe`, `durable-probe`, `smoke-parallel-2`, `smoke-parallel-flow`, `smoke-published-flow`, `test-gate-flow`, `capability-ideation`) or by stale rows whose manifest file no longer exists (`issue-rca`, `incident-remediation`) — none of them declares the bot it borrows; (2) two are carve mistakes where a manifest pinned a uuid it does not own — `trading` pinned `a0000000-…-0045` (`identity-advisor`, owned by `identity`) while the real `trading-analyst` is `…-0046`, and `brand-graphics` pinned `b00f0000-…-0001` (`drone-operator`); (3) the rest are **deliberate aliases** that are correct as designed (`communications-bot` across switchboard/social/email-summarizer, `vids-operator` across vids/creative-studio/video/daily-trade-recap, `career-hunter` across career-hunter/job-apply, `rca-specialist` across intelligent-operations/intelligent-processing) and must NOT be resolved by editing manifests. `scripts/swarm-app-bot-integrity-check.sh` passes and flags 13 of these advisorily, but cannot see the inactive squatters because it inspects only `agent_ids[1]` of active apps.
- **Who decides:** the operator. (1) and (2) uninstall or edit applications installed on the operator's own box; (3) changes the ADR-149 authorization core, which is load-bearing and should not be touched without approval. Nothing in this entry has been performed.
- **Done when:** the census query in the ops doc returns zero rows for classes (a), (b) and (d) — the seven borrowed ids released and the two mispinned uuids corrected in `oshal-applications` and reinstalled — AND the deliberate aliases of class (c) are readable rather than removed, because an association shared on purpose stopped being read as exclusive ownership: either the reader resolves a multi-claim to a single accountable owner from `agents.metadata.manifestApp` (which already carries exactly one stamp per agent), or a manifest declares ownership separately from association, recorded in an ADR amending ADR-149. A regression guard crosses the real boundary that failed — the real reader against a real PostgreSQL carrying a real multi-claimed `UUID[]` row, extending `tests/unit/application-execution-ownership-postgres.spec.ts`, never a doubled query — and proves a deliberately shared bot is readable while an unowned claim is not. The integrity check is widened to scan the whole `agent_ids` array of active *and* inactive apps so a reappearing squatter fails it. `GET /api/tickets` as the operator returns the four `career-hunter` tickets that are dropped today, and the api log shows zero `Ambiguous package ownership` lines across a full boot.

### The bot database role can read almost nothing it was meant to (2026-09-14)

**Context:** fixing [BUG-25](operations/bug-log.md) showed that `oshal_bot` can `SELECT` only **3 of
409** public tables on this stack. Migration 099 created the least-privilege bot role and intended
blanket DML plus "default-privilege grants from BOTH object-creating roles ... so future tables stay
readable without another migration" — but `pg_default_acl` carries **no `oshal_bot` entry at all**,
and every runtime table is owned by `oshal_app`. So nothing `oshal_app` has created since is
readable by the bot role, including `agents`, `swarm_applications` and `chat_tasks` — the last of
which 099's own docblock names as a bot write path ("chat_tasks cost rows ... are all DML").

Migration 140 granted the three relations and one function that the ADR-149 posture guard needs,
because Jarvis was down. It deliberately did **not** re-grant wholesale: that changes a
least-privilege security posture and belongs to the operator.

**Why this is not obviously urgent, and why that is the danger:** bots heartbeat over Redis and
their LLM execution does not read these tables, so the fleet looks healthy. The failures are silent
and only surface when a code path actually reads — which is exactly how this one waited to be found
by a person trying to say hi.

**Done when:**
- The real privilege set `oshal_bot` NEEDS is enumerated from the code that runs in a bot node (not
  guessed from the table list), with the file:line that performs each read or write.
- A migration grants exactly that set, keeping `oshal_workload_identities` and
  `oshal_user_delegations` revoked per migration 099, and keeping every RLS policy intact —
  `oshal_bot` stays `NOSUPERUSER`/`NOBYPASSRLS` and no policy is relaxed to make a query pass.
- `ALTER DEFAULT PRIVILEGES` is set **for the `oshal_app` role** as well, so a table created by the
  api's runtime DDL tomorrow does not silently reopen this gap. Migration 099 set defaults only for
  `oshal`.
- A guard asserts the required set against a real PostgreSQL and the real role, extending
  `tests/unit/bot-role-ownership-reads-postgres.spec.ts`, and is proven red by revoking one grant.
- A written decision records which tables the bot is deliberately DENIED, so the next missing grant
  is distinguishable from a deliberate boundary — the ambiguity that made BUG-25 take a live outage
  to notice.
### Dependency tiers: four gaps the design surfaced (2026-09-14)

**Context:** building `required` / `optional` app dependencies (ADR-085 addendum) exposed four
independent holes. None blocks the store migration above; each is small and separately shippable.
Detail and evidence: [backlog/store-dependency-tier-migration.md](backlog/store-dependency-tier-migration.md).

**Done when**, per gap:

- **"One of these connectors" cannot be expressed.** `home` needs SmartThings *or* Nest,
  `email-summarizer` Gmail *or* Outlook, `payments` Square *or* PayPal. The schema says all-of
  (`required`) or none-of (`optional`), so every such app must pick `optional` and loses the
  "connect at least one" signal. *Done when* an app can declare a choice-of set that the install
  preview and the setup screens render as "connect one of...", without it becoming a hard
  install-time requirement, and a guard proves an app with none of them connected is reported
  unready rather than broken.
- **An app cannot ask whether its optional partner is installed.** Optional dependencies are an
  install-time concept only, so a package that tiles a partner app's surface either 404s or
  hand-rolls a probe. *Done when* a package can ask the kernel whether a named app is installed and
  active (read-only, no new route per package) so its surface hides the tile instead of rendering a
  dead one, with a guard proving the answer follows an uninstall.
- **`marketplace.json`'s dependency mirror drifts unguarded.** The catalog entry for
  `creative-studio` lists one app where its manifest lists four; `scripts/check-catalog.mjs` mirrors
  identity/version/suite/displayName/source but not dependencies. *Done when* the catalog's
  dependency block is generated from the manifest (tiered shape included) and the catalog gate fails
  on drift, proven red by a mutation.
- **The one-click installer hard-codes bundle dependencies.** `scripts/oshal-install.sh` carries
  `BUNDLE_PACKAGES=([little-monsters]="little-monsters presentations" ...)` - "dependencies BOUND"
  by hand - and `--apps` has no way to pull a package's optional extras. *Done when* bundles name
  only their top package (the installer resolves the rest from the manifest), `--apps` accepts a
  `--with-optional` passthrough, and `tests/unit/installer-scripts-parse.spec.ts` covers both.
