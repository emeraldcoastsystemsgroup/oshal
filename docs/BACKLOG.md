# OSHAL Backlog

This file contains only unfinished or externally blocked outcomes. Completion history belongs in the relevant ADR, runbook, package README, release note, or evidence record; when an item closes, remove it from this queue.

Framework, kernel, shared-service, security-boundary, and orchestration work belongs in this repository. Application-owned work belongs in [`oshal-applications`](https://github.com/emeraldcoastsystemsgroup/oshal-applications); core entries below retain only a framework dependency or a concise pointer to the owning package.

Every item has an observable **Done when**. Live-proof requirements cannot be closed from unit results alone.

The operator's [ranked ten priorities](backlog/next-priorities.md) link each autonomous implementation
outcome to its local proof. This queue retains the remaining rollout and broader acceptance work.

## Promotion, deployment, and regression proof

### No gate typechecks a test file, so "typecheck clean" says nothing about one

- **Found 2026-09-16** reviewing PR #579. `tsconfig.json` has `include: ["src/**/*.ts", "src/**/*.tsx"]` and `exclude: ["node_modules", "dist", "tests", "**/*.spec.ts", "**/*.test.ts"]`; `tsconfig.server.json` includes only four `src/` subtrees. So `npx tsc --noEmit` never reads a spec, and neither does the pre-push hook, which runs that same command against committed HEAD. Vitest transpiles with esbuild, which strips types without checking them.
- **The consequence, measured on our own reporting:** a great many test-only changes have been landed this week with "typecheck clean" recorded as evidence. The claim is true of the command and vacuous about the file that changed - a spec can carry a type error onto main and the only thing that can notice is an assertion happening to fail at runtime. A wrong `as` cast, a doubled object missing a field the production type requires, a helper whose return shape drifted: all invisible.
- **Remaining:** typecheck the test tree. The shape that fits this repo is a second project (for example `tsconfig.tests.json`) that includes `tests/**` with the same path aliases, run as its own step beside the existing typecheck gate in `scripts/ci-local.sh` - not a widening of `tsconfig.json`, which would pull specs into the build's own project and change what `dist/` compiles.
- **Expect a backlog of existing errors.** This has never run, so the first pass will not be green; the entry is not done until it is, or until each remaining error is quarantined with a reason rather than silenced wholesale.
- **Done when:** a gate typechecks `tests/**` and fails on a type error there, a deliberately broken spec is shown to redden it, and the existing errors are either fixed or individually recorded.

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

### Native background wake: the microphone-release invariants are unproven

- **Found:** 2026-09-15, running the wake acceptance suite against deployed core `1f0978a0`.
  `tests/jarvis-rich-response-native-wake.spec.ts` is **3 failed of 3**. All three fail at the same
  first assertion - `window.__nativeWakeAudio.streams.length` is `0` rather than `1` and `#mic`
  never gains the `live` class - so the post-wake command microphone is never opened and the three
  release invariants (release after speech, release on the no-voice timeout, release on user
  interruption and page close) have nothing to assert against. The page loads and the button
  exists, so this is not a load failure.
- **Why it went unnoticed:** the Run block in
  [jarvis-native-background-wake.md](architecture/jarvis-native-background-wake.md) listed only
  `jarvis-audio-lifecycle.spec.ts`, while the 07-11 baseline it records covered three Playwright
  files. Following the documented command therefore cannot see this. The Run block is now corrected
  to name both files.
- **Not yet diagnosed:** `src/api/jarvis.html` has taken 15 commits since 2026-07-11 while the spec
  has not been touched since a governance chore, so spec-drift against a moved page is at least as
  likely as a runtime regression. Diagnose before changing either - the page is core and the
  handler region is load-bearing for an always-on-microphone feature.
- **Done when:** the three cases pass against the deployed page, OR the spec is retired with a
  written reason and replaced by one that asserts the same three release invariants; and the
  passing command is the one the Run block documents, so the next reader cannot miss it again.
  Until then the wake path is not delivery-ready, and its doc says so.

### Refusal visibility: the substrate for P1, P3 and P4

- **Found 2026-09-14, measured:** **125** distinct refusal reason codes in `src/**` and **zero**
  surfaces that aggregate them. A refusal is a return value and, at best, a log line - not a row,
  not replayable, not countable. The operator cannot ask "what did the platform decline to do
  today, and what would unblock it?" Full diagnosis and a six-stage roadmap in
  [operating-fluency-spec.md](architecture/operating-fluency-spec.md).
- **Closed so far:** P2 (#491, access checks report instead of denying in silence) and the same
  defect family at the bot posture guard (#496). Both keep their fail-closed returns unchanged;
  only the reporting changed.
- **Remaining - P1 (Stage 1), the blocker:** one durable `refusals` store (code, actor, owning
  package, target agent/route, prepared execution id, remedy text, timestamp) under the same RLS
  contract as every other table, one recording chokepoint, and `GET /api/ops/refusals` auth-gated
  and caller-scoped. Reuse the ADR-125 alert-pipeline shape rather than inventing one - this is
  exactly that problem one layer up.
- **Remaining - P3 (Stage 3), the multiplier:** enumerate the operator-remediable subset of the 125
  codes (not all are; some are correct hard denials) and make each name what is unset and what to
  set, with the setting names in one exported constant so check and message cannot drift. `8ae6a57b`
  did this for exactly one code and is the pattern.
- **Remaining - P4 (Stage 2 tail):** refused work strands. Observed at `escalated` and at
  `chat_tasks.status='created'`. Needs a terminal state carrying the reason, or a reaper.
- **Done when:** a query answers "every refusal in the last 24 h by code, actor, package and
  target" and the cockpit renders it; the five 09-10 schedule refusals appear in it without a
  `docker exec`; a guard enumerates the remediable codes and fails when one carries no remedy; and
  a spec drives a refused dispatch end-to-end and asserts the ticket reaches a terminal state with
  its reason. Guards must cross the real boundary - a real store under the enforcing role, not a
  mocked one.

### Concierge and tool coverage is not a contract (P8) - and its first done-when was wrong

- **Measured 2026-09-14 across the store repo:** **26 of 61** packages declare no concierge at all,
  and only **25 of 61** declare a top-level `tools:` block (of those 25, all set `defaultAuthMode`
  and 23 set `routingTags`, so the mechanism is well-formed wherever it is used). **36 of 61
  packages expose no tools to Jarvis.** The rail is built and correct; adoption is not enforced.
- **The original done-when in the spec was wrong and is corrected there.** It said "a
  repo-separation-style check fails a package that registers a surface and declares no concierge".
  Repo-separation scans the **core** repo; these packages live in `oshal-applications`, so a core
  CI gate cannot see them. The real enforcement point is load-time manifest validation in
  `swarm-app-loader.ts`.
- **Which makes this a migration, not a gate.** Switching on load-time validation would refuse 26
  currently-working packages. It needs a deprecation path: warn-on-load first, a backfill pass in
  the store repo, then fail-closed - and the store-side backfill is per-package work that does not
  touch core.
- **Sequencing:** do not start this before the refusal store. A concierge that cannot see refusals
  can only apologise, which is the current behaviour and the reason adding concierges has not made
  the environment feel more fluent.
- **Done when:** a package that registers a cockpit surface and declares no concierge fails to
  load; the gate is green with no allowlist; a spec proves it goes red per violation shape; and the
  backfill landed in the store repo rather than being waived.

### Jarvis fast-lane: the deterministic shortcut is hardcoded to three intents

- **Measured 2026-09-14:** `detectProviderBoundHandoff` (288 lines of hand-written regex in core)
  recognises exactly three things - weather, priority inbox, read-only Walmart catalog. On a hit,
  `buildToolsBlock` is never called and the turn is answered with no model tokens. On a miss, every
  turn carries the full tool block (44 catalogued scripts, a 10.4 KB catalog) plus the whole app
  catalog, which "rides EVERY model turn". `buildToolsBlock` already SCORES tools against the
  message and surface but only **sorts** - nothing is ever cut.
- **Why it matters more than it looks:** the native background-wake path lands on the same `/ask`
  route, so a spoken request is answered immediately only when one of those three intents matches.
  Voice makes the slow lane the product; typing merely tolerates it.
- **Two changes, OPPOSITE failure modes - they cannot share a gate.** Cutting the tool block fails
  by dropping a tool the model needed, so it gates on **recall**. Widening the fast lane fails by
  firing the wrong deterministic handler with the model bypassed entirely, so it gates on
  **precision** - and that failure is worse than the status quo.
- **Proving it must be off-core.** `buildToolsBlock` is exported, so a harness can import the real
  selector read-only and race candidates implemented entirely in the harness - zero core delta.
  Shape it like [`bench/`](../bench/README.md), which exists to convert an asserted claim into a
  measured one and reports `not-run` rather than inventing a number. Start with a synthetic corpus;
  ground truth must be the RECORDED invocation, never a model's guess.
- **Done when:** the harness reports, per candidate selector, recall, false-match count and real
  input-token delta, with a binary `regressions == 0` gate (average improvement with one regression
  is the thing that burns you); and any core change ships behind a shadow step that computes both
  selectors, logs the delta and uses the baseline, so production behaviour is unchanged while real
  traffic validates it.

### Boot-time schema bootstraps fail open - and the one I called a functional loss was NOT one

- ⛔ **CORRECTION, 2026-09-15, same day this entry was filed.** The first version of this entry
  said *"One is a real functional loss: `oshal_cli_tokens schema bootstrap failed - PAT auth
  unavailable until it exists`"*. **That is false.** It was written by believing a log line, which
  is precisely the defect class the rest of this file is about. Disproved by an adversarial
  investigation:
  - `oshal_cli_tokens` has existed since **2026-07-12** and holds **286 rows**. Migration
    `100-cli-token-base-schema.sql` creates the table, index, RLS and policy as the bootstrap
    superuser **before** `exec node dist/app/server.js` - so the table is present before the code
    that re-asserts it ever runs.
  - **15 PATs authenticated successfully inside the very process whose boot logged the failure**
    (`last_used_at` is written only after a successful lookup).
  - A live probe minted, used and revoked a PAT: 200 / 200 / 401.
  - The bootstrap in `createCliTokenRoutes` is **fire-and-forget and nothing awaits it**; the PAT
    auth middleware is constructed separately (`server.ts:757`) and queries the table directly.
  So the failure could not have caused a functional loss, and none occurred.
- **What is actually wrong, and it is worth fixing:** the catch block hardcodes
  `PAT auth unavailable until it exists` - **a consequence it never verified.** An error handler
  that asserts an impact it has not checked is the same defect as a refusal that will not name its
  cause; it sent me, and would send the next reader, after a bug that does not exist.
- **The second real issue:** the bootstrap issues 8 idempotent statements
  (`cli-token-routes.ts:83-109`), each taking its own 5 s pool acquire through `gucQuery`, against a
  pool of 8 while 83 manifests load. That is the contention, and it is why it fails on a cold boot.
- **Still true and unexamined:** about ten `* schema bootstrap failed` lines on a cold boot - ticket
  (x3), venture rebaseline, tv_token_revocations, social_content_drafts, person-model,
  linkedin-assistant, `ensureInboxSchema`, `ensureFeedsSchema` - plus two `DB access with NO request
  identity DENIED (OSHAL_DB_GUC_STRICT=deny)`. **Each needs its own check before anyone claims an
  impact for it**; do not repeat this entry's original mistake across the other nine.
- ⛔ **Do NOT "fix" this with a verify-first early return.** `assertSchemaReady` runs `hasTable` as
  one query plus `hasColumn` as one query **per column** - with the 7 required columns that is 8 pool
  acquires, identical to the DDL it would replace - and its requirements are columns-only, so it
  would silently retire the RLS/policy self-heal on a FORCE-RLS credential table.
- **Done when:** the bootstrap takes one advisory-locked client (a `lockKey`; `47110008` is free)
  instead of 8 separate acquires, keeping the per-boot RLS/policy re-assert; the catch **re-probes
  and branches** - table present -> warn that PAT auth is unaffected, absent -> the error wording,
  unverifiable -> name the uncertainty; and a spec forces the DDL to fail and asserts the log level
  and wording for each branch. A fixture claiming to prove PAT authentication must connect as a
  **non-superuser** role with the ADR-076 grants - `postgres`/`oshal` bypass FORCE RLS (measured:
  309 rows vs 0), so it cannot prove the policy boundary otherwise.

### The ONNX runtime installs process-global rethrow handlers that make any stray rejection fatal (2026-09-15)

- **Root-caused 2026-09-15 with probes on the real api image. The board's stated mechanism was
  WRONG and is corrected here.** The board said "an abort inside the WASM during inference is not
  caught (the try/catch covers model LOADING only)". **False** -
  `src/features/rag/services/local-embedding-service.ts:51-61` already wraps the inference loop, and
  a probe proved an ORT wasm error IS caught by an ordinary try/catch around the awaited call. The
  abort function throws a normal `WebAssembly.RuntimeError`; it does not call `process.exit`.
- **The actual cause:** `Dockerfile.oshal:216-225` shims `onnxruntime-node` -> `onnxruntime-web` on
  musl, and onnxruntime-web's Emscripten Node shell installs two **process-global** handlers the
  moment the wasm initialises - `process.on('unhandledRejection', t => { throw t })` and
  `process.on('uncaughtException', t => { if (!(t instanceof ExitStatus)) throw t })`. They are
  appended **behind** oshal's own guards (`installProcessCrashGuards`, `server.ts:1939`). From that
  instant **any** unhandled rejection anywhere in the controller - not just in the RAG lane - is
  converted to an uncaught exception and rethrown from inside the handler, which is fatal.
- **Measured signature:** exit code **7**, **548,627 bytes** of minified bundle on stderr (the
  "offending source line" is line 6 of a 547 KB file), and the process dies **before** oshal's 250 ms
  flush and its `process.on('exit')` hook run - so the api destroys its own evidence as it goes.
- **Live state:** the running api logged `Local embedding model ready` with `RAG_LOCAL_EMBEDDINGS`
  unset, so it is carrying those handlers now.
- **Fix (additive, one file):** in `load()`, snapshot `process.listeners('unhandledRejection')` and
  `('uncaughtException')` before the dynamic `import("@xenova/transformers")`, and after
  `mod.pipeline(...)` resolves **and in the catch** remove any listener not in the snapshot whose
  source matches `/throw t/` - a failing `InferenceSession.create` registers the pair too, and the
  api is serving during the 4-5 s load window, so do not strip indiscriminately. Registration is
  once-per-process, so one strip is sufficient.
- ⛔ **The obvious guard does NOT work** - proved by execution, not reading. A test child that
  forces wasm init directly never calls `load()`, so the strip never runs and the case is
  permanently red; and on a Windows host `@xenova/transformers` resolves to the **native**
  `onnxruntime-node`, so cases that do not run in the image are vacuous - they pass with the fix,
  without it, and with the strip deleted.
- **Done when:** the strip is an exported helper so a test child can reproduce the defect and apply
  the fix in one process; a **host** case installs the real crash guards, registers the pair via a
  failing `InferenceSession.create(new Uint8Array([1,2,3,4,5,6,7,8]))`, calls the helper, raises a
  stray rejection and asserts exit 0 with stderr under 8 KB (red on today's tree at exit 7 and
  >500 KB); and an **image** case runs the real `load()` under `docker exec` on `oshal-bot:latest`
  asserting post-load listener counts equal pre-load and `embed(['x'])` still returns 384 dims - the
  image probe is mandatory, because `Dockerfile.oshal:216-225` is where the defect is created.
- **Mitigation if the box is actively crashing before this lands:** `RAG_LOCAL_EMBEDDINGS=0` plus an
  api bounce - `isEnabled()` short-circuits before wasm init. Cost: RAG drops to BM25 and
  person-model projection defers. Not a fix.
- ⛔ **Not the defect:** "an uncatchable in-process WASM abort" and "move embedding to a worker".
  The branch `docs/embedding-abort-kills-api` carries the wrong mechanism in its text; correct it
  before opening that PR or the next reader adds a try/catch that is already there.

### Benchmark and cost claims are still un-earned (P5, P6)

- **P5 - the cross-framework benchmark measures competitors, not us.** `bench/` runs the same task
  on the same free model across vanilla/langgraph/crewai and records real tokens, but the oshal leg
  is not wired: it reports `not-run`. So the cheaper-routing claim remains asserted.
- **P6 - the cost figure is small-n.** `$1.30` against a `$4.05` median for incident RCA are real
  `chat_tasks` rows, one workload, one corpus. Directionally strong; not a benchmark.
- **Neither blocks operation** - both block a slide. Do not publish the determinism/cost head-to-head
  until measured.
- **Done when:** `run_oshal` POSTs to the real dispatch and reads `chat_tasks` input/output token
  columns so the benchmark reports oshal alongside the others at a stated n; the cost claim covers
  more than one ticket type with its n and limits kept in the same sentence as the number.

### Trading DB specs race on schema bootstrap
- **The bootstrap half is CLOSED (2026-09-16).** All seventeen `oshal_trading_*` lazy bootstraps now
  pass `lockKey: SCHEMA_LOCK_KEYS.trading` to `runRuntimeSchemaBootstrap`, so the family applies its
  DDL through `applyLockedSchema` under one transaction-scoped advisory lock. `ensurePeaksTable` was
  converted from eleven bare `pool.query` statements onto the same path — it is the only trading
  bootstrap with no memo, so it re-ran on every fire and was the family's most frequent racer. ONE
  key, not one per module: six stores arm a trigger on the `oshal_trading_book_id_fill()` function the
  books module owns, and the books legacy-mint reads three other modules' tables.
- **The mechanism, measured rather than reasoned about.** Fourteen DSN-backed trading specs run against
  one disposable `postgres:16-alpine` on a fresh schema, without `--no-file-parallelism`, failed six of
  fourteen files on each of three runs — with a DIFFERENT set of files each time. The errors were
  `23505` on `pg_type_typname_nsp_index` (`oshal_trading_signals`, `oshal_trading_orders`,
  `oshal_trading_strategy_journal`) and on `pg_class_relname_nsp_index` (`idx_trd_peaks_book`) —
  `CREATE TABLE/INDEX IF NOT EXISTS` is NOT race-safe in PostgreSQL — plus `42710`
  `trigger "trg_trd_daily_equity_book_fill" … already exists` from the `DROP TRIGGER IF EXISTS` /
  `CREATE TRIGGER` pair, and `40P01` deadlock detected. After the lock: five consecutive runs, byte-identical (`2 failed | 107 passed | 41 skipped`), zero occurrences of any of those codes.
- **Guard:** `tests/unit/trading-schema-bootstrap-race.spec.ts` starts its own PostgreSQL and drives
  four independent copies of the trading modules (`vi.resetModules()` — a second vitest worker in
  everything but the process boundary) at it at once, on an empty database and again on a built one - after a repair: as first written the four copies were constructed with `Promise.all`, and `vi.resetModules()` clears the registry synchronously, so all four shared ONE module instance and only the un-memoised `ensurePeaksTable` actually raced. That is why coverage of the other sixteen is now asserted STATICALLY by `tests/unit/trading-schema-lock-coverage.spec.ts`, which names any trading bootstrap missing the family lock key and fails on it - the concurrency spec cannot, because the locked books/accounts prologue staggers cold workers enough to hide a single downstream miss. Three trading modules issue bare DDL outside that helper and hold no lock at all (`trading-bar-store`, `trading-config-overrides`, `trading-strategy-lab-store`); they are named by that guard so a fourth cannot join them quietly.
  Red on the unlocked tree in 3 of 3 runs, green in 5 of 5 after. Registered in the isolated nightly
  set (`scripts/ci/run-nightly-isolated.mjs`) and on the Test Lab `nightly-isolated-regression`
  scenario, which is the only gate that executes a Docker-owning spec.
- **Remaining:** the trading set is not GREEN on a bare cluster, for reasons that are not the race and
  were not touched here. Five files fail identically before and after, on prerequisites nothing in the
  trading bootstrap creates: `trading-book-report-scripts` needs `OSHAL_TEST_APP_DSN` (the enforcing
  `oshal_app` role); `trading-books-schema` and `trading-settlement` need `oshal_user_deks`
  (connector-token-crypto, `42P01`); `trading-dispatch-golden-plan` needs `trading_config_overrides`
  (`42P01`); `trading-watchdog-books` needs `OSHAL_TEST_DB_CONTAINER`. That is the 'whether the whole
  set survives on a bare cluster is still unmeasured' clause of the disposable-PostgreSQL entry below
  — now measured, and it belongs there. The golden-plan spec's single-retry workaround
  (`bootstrapOnce`) is now redundant but was left in place; removing it is a separate change.
- **Done when:** ~~the bootstrap takes an advisory lock (or tolerates the concurrent create)~~ DONE,
  and the same ten-file trading set is green without `--no-file-parallelism` — PARTIAL: no file fails
  for the race any more and the run is deterministic, but five fail on the bare-cluster prerequisites
  listed above.

### The DB-backed unit specs need a disposable PostgreSQL to run against
- **What changed:** 23 `tests/unit/*.spec.ts` resolved their DSN with a fallback onto the local
  stack's published Postgres port — `oshal-local-db`, the operator's LIVE trading database — so an
  unpointed `npx vitest run tests/unit/trading-*.spec.ts` created and dropped schema and wrote order
  rows in production. They now resolve through `tests/helpers/spec-database-url.ts`, which REFUSES an
  unpointed run and names the variable to set, and the `spec-database-default` gate in
  `scripts/ci-local.sh` keeps that true for the next spec.
- **Three of the 23 are closed (2026-09-16):** `trading-earnings-rules`, `trading-event-plans` and
  `trading-engine-cost-basis-postgres` now START their own `postgres:16-alpine` and remove it,
  through the shared `tests/helpers/disposable-postgres.ts` (the alert fixture delegates to the
  same class). They take no address from the environment at all, so they run in any gate that has
  Docker. That also answers the `oshal_app` / create-database question for the cost-basis spec: it
  needed neither — it builds the trading schema itself on a bare cluster as the container's own
  superuser. The watchdog spec's `OSHAL_TEST_DB_CONTAINER` / `OSHAL_TEST_REDIS_CONTAINER` defaults
  onto the live containers are gone with it (`specContainerName`, no default, live stack refused),
  and the `spec-database-default` gate now fails on that shape as well as on the port.
- **Remaining:** the other 20 specs execute only when a run points them at a database. Nothing in
  the repo does that yet, so the local-CI `unit` gate cannot execute them (it was already FAIL on
  the 2026-09-14 and 2026-09-13 scheduled runs, for unrelated reasons). Converge them on
  `tests/helpers/disposable-postgres.ts` the same way, or point them at the ephemeral `oshal-ci-pg`
  the e2e gate already starts. Whether the whole set survives on a bare cluster is still
  unmeasured: several of them expect the enforcing `oshal_app` role. Measure before wiring, and
  never point the variable at the published port.
- **Residue left behind, measured 2026-09-15 read-only after deleting the 24 orphan books:** 42
  `spec-%` rows remain in the live trading database — `oshal_trading_event_plans` 10,
  `oshal_trading_signals` 9, `oshal_trading_decisions` 8, `oshal_trading_pinned_lots` 5,
  `oshal_trading_orders` 4, `oshal_trading_dated_orders` 4, `oshal_trading_accounts` 1, and the one
  `oshal_trading_books` row (`spec-settle-60e074b1`) that still has orders and so fell outside the
  authorised delete. All of it is `spec-%`-owned, so no user-scoped surface reads it. Survey with:

  ```sql
  SELECT 'books' t, count(*) FROM oshal_trading_books WHERE user_sub LIKE 'spec-%'
  UNION ALL SELECT 'orders', count(*) FROM oshal_trading_orders WHERE user_sub LIKE 'spec-%'
  UNION ALL SELECT 'event_plans', count(*) FROM oshal_trading_event_plans WHERE user_sub LIKE 'spec-%'
  UNION ALL SELECT 'signals', count(*) FROM oshal_trading_signals WHERE user_sub LIKE 'spec-%'
  UNION ALL SELECT 'decisions', count(*) FROM oshal_trading_decisions WHERE user_sub LIKE 'spec-%'
  UNION ALL SELECT 'pinned_lots', count(*) FROM oshal_trading_pinned_lots WHERE user_sub LIKE 'spec-%'
  UNION ALL SELECT 'dated_orders', count(*) FROM oshal_trading_dated_orders WHERE user_sub LIKE 'spec-%'
  UNION ALL SELECT 'accounts', count(*) FROM oshal_trading_accounts WHERE user_sub LIKE 'spec-%';
  ```

- **Done when:** the remaining 20 specs run green against a database the run provisions and
  destroys, the local-CI `unit` gate executes them there rather than skipping or refusing, and the
  survey above returns zero rows.
### Codeless k8s install — first live-cluster proof (ADR-129)
- **Remaining:** run `oshal-install.sh --mode 4` (or `-Kubernetes`) end-to-end on a real second machine — the dev laptop is excluded on purpose (Docker Desktop k8s beside the 44-container swarm is the documented OOM pairing). Then publish the OCI chart (`bash scripts/publish-chart.sh` + the one-time GHCR visibility flip) so the installer's OCI-first path goes live.
- **Done when:** a fresh box reaches `/welcome` in a browser via the NodePort with only kubectl+helm+the installer present, a model connects through the wizard and a jarvis turn answers, and `helm show chart oci://ghcr.io/emeraldcoastsystemsgroup/charts/oshal` succeeds anonymously.

### k8s shared-service tier — live proof of the features it restores (ADR-129 amendment)
- **Remaining:** chart 0.3.0 templates the whole tier (tsdb, arangodb, vault, code-server, diarization; ollama opt-in) and stages store packages via an api initContainer, but only template-level proof exists (lint, render matrix, `kubectl apply --dry-run`, a mutation-tested guard). Nothing has run against a live cluster.
- **Done when:** on a real cluster — a staged store package serves its surface and survives an api pod restart; a trading query returns series from the in-cluster tsdb; `/api/graph` answers instead of 503; a transcription round-trips through the diarization Service; and `helm upgrade --set infra.arangodb.inCluster=false` degrades the graph cleanly (null connector, no connection-refused) rather than erroring.

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
- **Commissioned (operator, 2026-09-15):** build Bot Forge edit-in-place. The done-when above now applies unconditionally: editing an existing pack re-emits the same pack, never a duplicate.

### Nightly tasks still launched from the ADR-115 archive — LAUNCHERS DONE 2026-09-16, one operator action left
- **Done 2026-09-16 (code):** every scheduled-task launcher in `scripts/` now resolves its payload from its own directory. `claude-token-keepalive-hidden.vbs`, `oshal-signal-daily-hidden.vbs`, `oshal-signal-daily.cmd` and `make-trade-report.cmd` no longer name a checkout; `register-claude-token-keepalive.ps1` registers the windowless launcher with `-WorkingDirectory $repo` (the bare-powershell action it used to write is what got hand-edited into a hardcoded archive path), and a new `register-signal-labeler.ps1` gives the hand-made Signal Labeler a registrar it never had. Proven headless from an unrelated cwd: both chains ran the checkout they sit in, not the one they used to name. `tests/unit/scheduled-task-launchers-self-locating.spec.ts` holds the line over every `scripts/*.vbs`, `*.cmd` and `register-*.ps1`, gating on the shape of a typed `C:\Projects\<name>` path rather than the archive's name; mutation-proven red on a reintroduced path, on a silent "fix" of the deliberate exception, and on a registrar reverting to bare powershell. Inventory, drift measurements and the repoint commands: [scheduled-tasks-trunk-vs-archive.md](runbooks/scheduled-tasks-trunk-vs-archive.md). (Kalshi was done 2026-09-04 the same way.)
- **Evidence-Nightly: RETAINED at the private archive, deliberately.** It writes its board to `docs/evidence/`, which is internal-only and refused by the publish gate, so this trunk cannot hold it. `run-evidence-nightly-hidden.vbs` declares the exception in-band (`OSHAL-INTENTIONAL-ARCHIVE-PATH`) and the guard asserts it is the *only* launcher on the archive and that it is not quietly made self-locating.
- **Remaining (operator, one-time):** run the two registrars on the box so the live Task Scheduler actions name `C:\Projects\oshal`, then `Start-ScheduledTask` each once. Commands are in the runbook. Until then the keepalive and the signal labeler still execute the frozen archive tree — whose `oshal-signal-label.js` differs from this trunk's by 234 lines. `JobHunterSwarmSync` is disabled and not movable (its target lives under `apps/`, runtime staging that is never tracked — Rule 0c); unregister it or leave it disabled.
- **Also still on the archive, separately:** `run-daily-recap.ps1` resolves `$REPO` (its asset/`out` root, `OSHAL_RECAP_REPO`-overridable) to the archive, so the recap's *launcher* is trunk-resident but `assemble-recap.js` and the vids-operator `out` directory are not. Moving it is its own coordinated change — `assemble-recap.js`, `oshal-recap-email.js`'s container path, `oshal-recap-render-remote.js`, `oshal-recap-agent-remote.js` and the compose `OSHAL_DOCKER_PROJECT_ROOT` default all encode that same root, and a partial move breaks the nightly recap. Not attempted here.
- **Done when:** each movable task test-runs from `C:\Projects\oshal`, its scheduler action names that path, and Evidence-Nightly is documented at an intentional private location. See [ADR-115](adr/115-clean-trunk-branch-strategy.md).

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

### Installer and chat-channel strings still use the retired standalone product name
- **Remaining:** the docs/evidence half of the naming disposition is closed — the register is
  [docs/business/product-naming-disposition.md](business/product-naming-disposition.md). What it
  deliberately left alone is shipped user-facing product behaviour, where the standalone form
  "Open Swarm" is still what a user sees: the installer window title (`installer/install.ps1`), the
  Desktop shortcut name and description, the "look for the Open Swarm window" and "Open Swarm
  folder" messages (`installer/lib/install-node.ps1`), the join-code and port-reuse messages
  (`installer/lib/common.ps1`), the Windows firewall rule name `Open Swarm cockpit (<port>)`
  (`installer/lib/install-swarm.ps1`), the node launcher's console title
  (`installer/Open-Swarm-Node.cmd`), and two Telegram replies — "an Open Swarm account" and
  "Welcome to Open Swarm" (`src/app/routes/chat-channel-routes.ts`). These are not prose edits: a
  shortcut name and a firewall rule name are identities an already-installed box carries, so
  changing them needs an upgrade path decision (rename in place, or leave existing installs alone)
  rather than a find-and-replace. The `.bat`/`.cmd` filenames and the `oswarm`/`openswarm`
  infrastructure identifiers stay as they are — CLAUDE.md grandfathers identifiers.
- **Done when:** every user-visible string in `installer/` and `src/app/routes/chat-channel-routes.ts`
  reads "oshal" or "open swarm oshal"; a decision is recorded for the shortcut and firewall-rule
  names on boxes installed under the old names; `tests/unit/node-installer.spec.ts` and
  `tests/unit/installer-scripts-parse.spec.ts` are extended so a standalone "Open Swarm" in an
  installer script or a chat-channel reply fails the unit suite; and the register above is updated
  to move these rows out of "Out of scope here".

### Nightly gate has a twelve-night failure streak
- **Remaining:** the scheduled task `OSHAL Local CI` (daily 23:30, `ci-local-hidden.vbs` → `ci-local.sh --scheduled`) runs unattended, propagates its exit code, and emails the operator — all of that works. It has simply reported FAILED every night from 2026-08-02 to 2026-08-13 with `unit`, `e2e-green` and `trivy` red each time (BUG-22), so a newly-red guard inside it is invisible. Drive each of the three to green or quarantine it with a dated entry naming what is deferred and why: `unit` (BUG-15/16/17 plus the DB-backed specs — read BUG-16 before running the suite against a live stack), `e2e-green`, `trivy` (a CVE-budget decision, not a code fix). **Do not "fix" this by adding a `push:`/`pull_request:` trigger** — manual-only hosted CI is deliberate and `scripts/check-workflow-triggers.js` enforces it.
- **Done when:** `%LOCALAPPDATA%\oshal\ci-local.log` records at least one PASSED nightly run, every gate still red has a dated BACKLOG entry, and the notifier reports the streak and which gates are *newly* red rather than sending an identical failure mail each night.

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
- **The borrowing is already gone (2026-09-11, e9179047).** Both specs own a private PostgreSQL:
  `tests/helpers/disposable-alert-postgres.ts` starts a per-run `postgres:16-alpine` container on a
  random loopback port with a generated password and a tmpfs data directory, applies migrations
  104-109 and 141 into it, and removes the container in teardown. `alert-incident-cutover.spec.ts`
  also builds the receiver with `startPendingSweep: false` and asserts no `setInterval` was taken,
  so no consumer stands on the deployment queue. Neither spec reads `DATABASE_URL`,
  `TEST_DATABASE_URL`, `ALERT_PIPELINE_TEST_DSN` or `OSHAL_PG_PORT`, and
  `tests/unit/alert-postgres-isolation.spec.ts` holds that shut. The `afterAll` hang was
  `server?.close(cb)` with `server` still `undefined` — the callback never fires, so the hook sat
  out its whole 60 s timeout on exactly the runs where setup had already failed; teardown now
  guards the server and closes the fixture in a `finally`. Neither spec can skip: that, and the
  absence of the hang shape, are now asserted at source level in the isolation guard.
- **Built 2026-09-15 on `fix/alert-specs-own-database` (PR #480).** The standing gate the done-when asked for:
  `scripts/ci/check-alert-residue.sh`, wired into `scripts/ci-local.sh` as the last gate
  (`alert-residue`). It runs SELECTs only, so it is safe against a running stack, and it is
  fail-closed — a database it could not query reports UNCHECKED (exit 2) rather than clean, because
  a guard that passes without looking is the false-green recorded twice elsewhere in this file. A
  deployment that never ran the consolidation migrations says so and passes. The three fixture
  shapes are named once in the script so gate and guard cannot drift: `primary_target =
  'probe-target'`, `primary_target LIKE 'cut-%'`, and `dedup_key LIKE 'zz-incident-reopen-%'` (which
  catches a reopen row whose target column looks real), checked across `oshal_incident`,
  `oshal_incident_member` and `oshal_alert_event`. Guard: `tests/unit/ci-local-alert-residue.spec.ts`
  runs the real script in Git Bash against a real migrated PostgreSQL — a clean database passes,
  genuine `oshal-local-*` incidents pass, each fixture shape fails and is named in the output,
  member and event rows are counted alongside incidents, an unreachable database is UNCHECKED, an
  unmigrated one says so, and `ci-local.sh` is checked to actually call the gate.
- **The fail-closed claim now holds after the opening probe too (review of PR #480).** Only the
  connectivity probe was fail-closed in the first pass: every later statement folded failure into a
  benign answer, so a connection lost after the probe exited 0 as "the consolidation migrations have
  not run here", and an unreadable `oshal_incident_member` / `oshal_alert_event` contributed 0 to the
  total. Existence checks now carry a third "could not ask" outcome and every count must come back as
  a number; anything else is UNCHECKED. Three guard cases judge it per statement — two take the
  database away at an exact call behind a counting stand-in for the docker CLI (script, shell, SQL,
  exit code and PostgreSQL all real), and one needs no stand-in at all: a real unprivileged role that
  may read `oshal_incident` and is refused `oshal_incident_member`, which the gate must report as
  UNCHECKED rather than count as zero.
- **Remaining: the residue itself, which is an operator deletion and was deliberately left alone.**
  Measured 2026-09-15 against `oshal-local-db`: 27 `oshal_incident` rows (24 carrying
  `probe-target`, 3 carrying a `cut-…-container` run prefix), 5 `oshal_incident_member` rows and 1
  `oshal_alert_event` row. 22 of the 27 are in state `open`, which is why every surface reading that
  table counts them as live incidents. First seen spans 2026-08-06 to 2026-09-08 — all of it before
  the disposable-fixture change landed, so nothing new has been written since. The `alert-residue`
  gate is therefore RED on this box until they are removed. The query that finds them:
  `SELECT incident_id, dedup_key, primary_target, state, first_seen FROM oshal_incident WHERE
  primary_target = 'probe-target' OR primary_target LIKE 'cut-%' OR dedup_key LIKE
  'zz-incident-reopen-%' ORDER BY first_seen;`
- **Done when:** that query returns no rows against the deployment database, and a `ci-local.sh` run
  records `GATE alert-residue: PASS`.

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
- **Blocked on the provider (operator, 2026-09-15):** Hugging Face is not provisioning accounts - sign-in fails on the provider side. Do not re-ask until that changes.

### Deploy — the api process exits during the bot-recreate storm
- **Remaining:** on the 2026-09-05 deploy of f59494b7, while `oshal-deploy.sh` recreated the 34 bots the api sat above 200% CPU, host-port HTTP timed out for about three minutes, and the process then exited (exit 1) on `terminating connection due to idle-in-transaction timeout` raised through process-crash-guards (api log 04:43:20Z; `docker events` shows die then start). Docker restarted it in the same container, it was healthy about 40 s later, and the gate reported DEPLOYED with the advisory scan counting 19 error lines — so a deploy currently carries roughly a minute of api downtime that only the container's RestartCount records. Which transaction idles through the storm is not yet identified.
- **Done when:** a full `oshal-deploy.sh` run on the dev box recreates every bot with the api container's RestartCount unchanged and zero `idle-in-transaction` error lines in the api log for that window, proven by a log/inspect probe recorded in the real-boundary audit; if the fix is pacing the recreate rather than closing the transaction, the deploy log says so.

### The nightly gate has been red for 46 consecutive runs — trivy is a budget decision, not a fix
- **Remaining:** [BUG-22](operations/bug-log.md) recorded twelve straight failed nights on 2026-08-13; the streak is now **46 runs, first failure 2026-07-27**, and `trivy` is red in nearly all of them. The gate scans a `docker save` tarball of the freshly built image and fails on its findings, so "fix trivy" means one of three things and only the operator can choose: accept a documented CVE budget (severity floor, allowlisted CVE ids with expiry dates), rebase the image onto a base with fewer findings, or downgrade the gate to advisory and report findings without failing. Today it fails on a set nobody has read, which is the same as not scanning. The last full report on disk is `%LOCALAPPDATA%\oshal\trivy-report.txt` and it is from 2026-07-09 — nine weeks stale, so the current finding set is not actually known.
- **Done when:** a fresh trivy report is captured and read; the chosen posture is written into `scripts/ci-local.sh` next to `gate_trivy` with its rationale (budget file with expiries, new base image, or advisory-only); and the gate's result is either green or deliberately non-failing — never red-and-ignored.

### `unit` and `e2e-green` have been red for 46 nights and have never been triaged
- **Remaining:** both gates appear in essentially every failed run since 2026-07-27, and no run log records WHICH specs fail — `ci-local.log` keeps only the per-gate PASS/FAIL line, and `ci-local-last-run.log` is overwritten each night. So the failure set is unknown, and it is not safe to assume it is the same set it was in July: BUG-15/16/17 are three known-red specs, but `unit` was already red on 2026-08-03, eight days before the PR that landed two of those guards. The obvious first move is a single clean run against a pinned `origin/main` export on a quiet box, with the spec-level output kept.
- **Done when:** one `bash scripts/ci-local.sh --head` run completes on an idle box with the unit and e2e output retained; each failing spec is either fixed or has a dated quarantine entry naming what is deferred and why; and `ci-local.sh` retains per-gate failure detail across runs (a per-run log file rather than one overwritten `ci-local-last-run.log`) so the next triage does not start from nothing again.

### The nightly gate runs against a saturated box, so its results are not trustworthy
- **Remaining:** the 2026-09-08 run is the clearest evidence yet that the gate is measuring the host, not the code. It started at 23:30 while the full swarm, Docker Desktop and an editor were running; the box had **0.4 GB free of 15.7 GB**. `head-src` (a `git archive` plus `npm ci`) took **2144 s** and failed, which skipped seven gates including `unit` and `e2e-green`; `secret-scan` then logged `cannot allocate memory` against dozens of files it could not even read; `image-build` ran **55+ minutes** against the 68 s it took in the 10:28 manual run the same day; and the docker daemon returned `500` to an unrelated `docker ps` while it was in flight. A gate that cannot allocate memory does not report on the code — it reports on the host, and it does so in the same red that a real defect would use. This is a scheduling/host decision, not a code change: stop the swarm for the run, move the run to a quiet hour, raise the WSL memory ceiling (`.wslconfig`, not the Docker Desktop slider), or accept and label resource-caused failures distinctly.
- **Done when:** a scheduled run completes without any `cannot allocate memory` in its log and with per-gate durations within the same order of magnitude as a manual run on an idle box; and resource-exhaustion failures are reported as a distinct outcome from gate failures, so an out-of-memory night can never again be read as a code regression.


### GitHub-side residue of the 2026-09-12 attribution scrub
- **Remaining:** closed-PR refs `refs/pull/N/head` still reach the old commits (verified on core #426 and #430 after the push) and old SHAs stay viewable at `/commit/<sha>` until GitHub garbage-collects. Only GitHub Support can purge unreachable objects; nothing on any branch carries the attribution and the contributors graph is computed from `main`.
- **Done when:** either a support request is filed for the three repos and a sample old SHA returns 404 while `git ls-remote origin 'refs/pull/*/head'` no longer reaches an attributed commit, or the operator records here that the residue is accepted.

### An abort inside the local embedding runtime takes the whole api process down (2026-09-15)
- **Observed:** the api container restarted three times in 45 minutes on a loaded box (01:47:33Z,
  02:26:47Z, 02:33:08Z). For the last two the container log ends the same way: the entire
  `onnxruntime-web/dist/ort-web.node.js` bundle dumped to stderr followed by Emscripten `Aborted(`
  markers, then the process is gone and Docker restarts it. Nothing else is logged — no error object,
  no module name, no indication of which caller was embedding.
- **The path:** the alpine image shims `onnxruntime-node` to `onnxruntime-web`, stated in
  `src/features/rag/services/local-embedding-service.ts:83` ("glibc natives fail on musl; with
  gcompat they SEGFAULT") and single-threaded there because ort-web's threaded WASM needs a browser
  Worker. `localEmbeddings.embed()` is reached from `src/features/rag/services/rag-service.ts:213`
  and `src/features/person-model/services/semantic-projection.ts:58`. The service's own try/catch
  wraps MODEL LOADING (it sets `unavailable` and degrades RAG to lexical); an abort raised inside the
  WASM runtime during inference is not contained by it, and the process dies.
- **Not the cause, checked:** `runMaintenancePass`
  (`src/app/ambient-enrichment-runtime.ts:165`) performs two SQL purges and does not embed, so the
  person-model maintenance first-pass deployed on 2026-09-15 is not implicated. The 01:47 restart's
  window does not retain the same signature, so it is not established to be the same crash.
- **Why it matters beyond RAG:** when the api dies, every schedule, Jarvis, and the trading surface go
  with it, and on the restart the governed provisioner strips the bot grants and the authorization
  bootstrap re-runs its connection race. One WASM abort therefore cascades into an outage the
  operator experiences as "Jarvis is down again".
- **Done when:** an abort or crash inside the embedding backend cannot terminate the api process —
  the inference runs somewhere the failure is containable (a worker thread or child process with its
  own memory budget), or the abort is trapped and the service degrades the way a failed model load
  already does; the log names the caller and the input size that triggered it instead of dumping the
  bundle; a guard drives an embedding backend that aborts mid-inference and proves the process is
  still serving afterwards; and a restart-count probe over a deploy window shows the api's
  `RestartCount` unchanged.

### The isolated-browser fixture fails a passing suite when the browser takes over 5 s to exit (2026-09-15)
- **Remaining:** `tests/fixtures/isolated-browser.ts` bounds the owned browser's exit at `CLOSE_TIMEOUT_MS = 5000`
  and throws `Owned fixture browser <pid> did not terminate after explicit cleanup` past it.
  `tests/unit/jarvis-no-brain-browser.spec.ts` failed that way twice in a row on 2026-09-15 with both of its tests
  passing, while two lanes ran on the box; the pid had exited when checked about a minute later.
- **Done when:** browser suites that use the fixture pass five consecutive runs while two lanes run on the box,
  and a browser that never exits still fails the suite loudly.

### The ci-local export step after the purge is still unbounded

- **Carried over 2026-09-16** from "The nightly can wedge for hours deleting its own previous export", which closed on its own done-when (the purge is bounded, fail-loud and proven). Its last line named this remainder and left it untouched: the `git archive | tar` export that follows the purge has no timeout of its own — only `npm ci` carries one. A hang there holds `ci-local.lock` exactly the way the unbounded delete did, and produces the same silence: no outcome line, no alert.
- **Remaining:** bound the export the way `purge_tree` is bounded — a watchdog, one verdict line through `log`, a failure that fails its gate and lets the run continue to its outcome line rather than holding the lock.
- **Done when:** an export that cannot finish inside its limit ends in a named FAIL line in `ci-local.log`, the run still reaches its outcome line, and a spec proves the timeout path the way `tests/unit/ci-local-purge.spec.ts` proves the purge's.

### secret-scan has never been shown to fail against the REAL gitleaks image

- **Registered 2026-09-16** in [the real-boundary audit](governance/real-boundary-regression-audit.md) as an owed proof, because the guard that protects this gate stands a fake `docker` first on PATH: `tests/unit/ci-local-secret-scan.spec.ts` replays the image's stderr wording and `zricethezav/gitleaks:latest` never runs. The branch logic is genuinely covered - `FAIL unread=2 of 3`, the 2026-09-10 wording, a clean `PASS unread=0`, and a findings `rc=1` - but every one of those verdicts is reached from text this repository wrote.
- **Why it is worth a real run:** the wordings were calibrated against v8.30.1 while the gate runs the floating `:latest`, so a phrase change in the image turns a partial scan back into a silent pass - the exact defect the helper was built to end. And nothing has exercised the failing path in production: `%LOCALAPPDATA%\oshal\ci-local.log` carries `unread=0 of 5598` (2026-09-15) and `unread=0 of 5666` (2026-09-16), and **zero** `FAIL unread=` or `FAIL scanner rc=` lines have ever been written.
- **Remaining:** run `gate_secrets` against the real `zricethezav/gitleaks:latest` over an export holding a path the scanner cannot read, and record which of the five `GITLEAKS_UNREAD_PATTERN` phrases the current image actually emits.
- **Done when:** one dated run shows `secret-scan: FAIL unread=N of M` produced by the real image, the five calibrated phrases are re-derived from that run rather than from v8.30.1's release notes, and the audit row moves from `Owed` to green with that date.
### The publish gate's attribution wall can be disabled by author, and no case would notice

- **Found 2026-09-16** reviewing PR #573. Mutating `scripts/publish-gate.sh` check 5b to skip when `git log -1 --format=%ae` equals `maintainer@emeraldcoastsystemsgroup.com` leaves `tests/unit/publish-gate.spec.ts` at **45 passed**, and the same gate then exits 0 on all three refusal shapes a separate harness drives through it - the `-by:` trailer, the vendor no-reply address, and the "generated with" footer.
- **Why it is not theoretical:** every commit in this repository is authored as that exact address ([CLAUDE.md](../CLAUDE.md) mandates it and `lane-clone.sh` sets it), so an author allowlist added for any reason - a "skip our own commits" convenience, a rebase helper - turns the wall off for ALL real traffic. The spec cannot see it because all 45 cases commit as `t@example.com` (`tests/unit/publish-gate.spec.ts:145,160,243`).
- **Five other single-point mutations of the gate are caught** (dropping the footer pattern, losing case-folding, judging HEAD instead of the pushed range, dropping the address branch, failing open when a pushed commit cannot be enumerated), so this is one uncovered axis, not an absent guard.
- **Remaining:** one case that commits a fixture carrying model attribution as `maintainer@emeraldcoastsystemsgroup.com` and asserts the gate still refuses it.
- **Done when:** that case is green on today's gate and red against a gate carrying an author allowlist, recorded the way the other mutations are.

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
- **Needs a deeper dive (operator, 2026-09-15) - what this actually asks, plainly:** oshal owns some credentials of its own (platform API keys, not a user's). With more than one machine running bot nodes, those machines sometimes need the same key. The old system broadcast keys between machines and was switched off because it could not guarantee delivery order, so a key you had REVOKED could arrive late and quietly come back to life. The real question is: will this deployment ever run more than one machine that must share platform keys? On a single box the answer is no and this entry can close as not commissioned; with several nodes it has to be rebuilt safely. Not decided yet - explain it again before asking.

### Platform SaaS account migration (paused by operator)
- **Remaining:** when unpaused, recreate platform-owned services under `maintainer@emeraldcoastsystemsgroup.com`, re-mint/re-consent credentials, and record the YouTube relinking flow; personal brokerage accounts remain out of scope.
- **Done when:** every platform credential traces to an ECSG-owned or explicitly demo-only account, old accounts are drained/closed as appropriate, the relinking video is published, and Twilio A2P is completed on the ECSG account.

### Every deterministic service-route schedule on this box is refused under ADR-149 enforce (2026-09-14)
- **Observed (api log from the 22:31Z recreate to 23:25Z):** seven `ApplicationExecutionDeniedError` /
  `authorization_execution_identity_required` refusals across `app-route_intelligent-sales-email-auto-log`
  (4), `app-route_daily-trade-recap-daily-trade-recap-recorded-reports` (2) and
  `app-route_venture-plan-rebaseline-policy-tick` (1), each logged as `Manifest service-route schedule
  failed`. The runner (`src/app/manifest-service-route-schedule.ts:172`, added in `0cfe4d9b` on 2026-09-10)
  wraps every handler in `runWithApplicationExecution({ app, kind: 'jobs' })`, which throws that code when
  the app is protected and no actor is active (`src/shared/application-authorization-execution/index.ts:53`);
  a cron tick has no request, so it never has one. All five service-route schedules registered at boot —
  the three above plus `marketing-engine-daily-metrics-ingest` and `marketing-engine-weekly-campaign-review`,
  which had not come due in that window — belong to apps with `oshal_authorization_applications.protected = t`,
  so none of them can run on this box. The log does not reach back before the recreate; the start date is
  inferred from the commit, not observed. Trading's own schedules (`trading-events`, `trading-fast`,
  `trading-autopilot`) take the queue path and dispatched normally in the same window.
- **Decided 2026-09-14 (operator):** [ADR-157](adr/157-scheduled-application-services-run-under-an-activated-principal.md)
  - two classes: a **system service** runs as the application's service principal, activated by a swarm
  administrator with exactly the declared permissions; a **user service** runs as the person who activated it
  from the app's configuration. Nothing runs by declaration; an inactive schedule skips at INFO and shows as a
  readiness to-do. Slices: S1 kernel contract (manifest `runsAs`/`requires`, activation table, service
  principal, runner, routes), S2 the Scheduled services panel + readiness + guide, S3 the five packages
  declare, S4 Jarvis. Status per slice is kept here as each lands.
- **S1 landed 2026-09-14 (kernel contract).** The manifest declares `runsAs` (system | user) and `requires`,
  and the loader refuses a permission the app's own imported catalog does not define. Migration 144 adds
  `oshal_application_service_activations` (owner-or-operator RLS; a system row belongs to no person).
  A system activation mints `{ sub: 'service:<app>', issuer: 'oshal:application-service' }` and grants it
  exactly the declared permissions as assignments tagged `service-activation:<id>`, so deactivation revokes
  precisely those. The runner resolves the activation for the instance it is dispatching: no activation skips
  at INFO with `Manifest service-route schedule skipped: not activated` and no ERROR, a user activation runs
  as that person with `userSub` pinned on their own `app-route:{app}-{id}:{sub}` instance, and a run-time
  denial suspends the activation with the decision's reason. `GET /api/swarm/apps/:name/services`,
  `POST …/services/:id/activate` (system = swarm admin only; user = the caller for themselves, authorized
  now) and `DELETE …/services/:id/activation` sit behind requiresAuth, and the same response carries the
  ADR-145 readiness answer (`ready`, `awaitingActivation`) the S2 panel renders. **S2-S4 remain**, so the
  five schedules on the box skip visibly rather than run until their packages declare (S3) and an
  administrator activates them.
- **Done when:** a protected app's manifest schedule executes under a recorded principal that
  `authorize()` accepts for `kind: 'jobs'`, an app that principal is not assigned to is still refused, a unit
  guard proves both against the real policy, and each of the five schedules above logs `Manifest
  service-route schedule completed` on the box.

### Signed delegation refuses every ticket whose worker bot runs inline (2026-09-15)
- **Built 2026-09-16 on `fix/signed-delegation-core-ticket-types`.** With `OSHAL_DELEGATION_SIGNING_KID`
  and `OSHAL_DELEGATION_SIGNING_PRIVATE_KEY` set on the controller (live on this box since the
  2026-09-15 deploy), a worker with no dedicated bot-node endpoint was refused:
  `dispatch-manifest-worker.ts` threw `Signed HTTP delegation requires a dedicated bot-node endpoint`
  and the incident pipeline re-threw `No endpoint found for agent a0...0016 - bot node may not be
  registered` for the same missing endpoint. Both messages are live on this box: the first appears
  five times in the api log in the 24 h to 2026-09-16 (e.g. ticket `a058ca53` at 07:38:34Z), the
  second on six `intelligent-processing` tickets - though those escalated on 2026-09-11, so their
  trigger was the ADR-034 push-on-dispatch rethrow rather than signing. The routing decision is now
  written down in
  [docs/security/http-delegation.md](security/http-delegation.md) under "Worker routing for core
  ticket types": a **queued** ticket type must name a worker that owns a dedicated node; a
  controller-inline concierge stays inline for its **interactive** surface, where the turn runs
  in-process through `executeBotOrInline` and crosses no network hop, and is not eligible to own a
  queued type. rca-specialist, system-architect and queue-bot already named running compose nodes and
  were sent inline only by the codex rule that `resolve-bot-node-endpoint.ts` already logs as a
  declaration bug, so they carry `requiresOwnNode: true`; security-analyst and workflow-assistant were
  `container: oshal-api` and get their own bot-node services, which for security-analyst also takes
  untrusted Trivy output out of the control-plane container. No signed inline path was designed: the
  same result was available as configuration, and the doc records what one would have to provide if a
  future queued type genuinely cannot own a node.
- **Guard:** `tests/unit/signed-delegation-core-ticket-types.spec.ts` enumerates the core ticket types
  from the tree (`WORKFLOW_PIPELINES` plus every `swarm-apps/*.yaml`), resolves each worker and
  reviewer through the real registry and the real `resolveBotNodeEndpoint`, and dispatches one ticket
  per manifest-worker type through the real `dispatchManifestWorkerTicket` with a real `BotNodeClient`
  holding a locally generated Ed25519 signing key, over a real loopback bot node that records the
  signed token. Mutation-proved: putting `security-analyst` back on `container: oshal-api` turns two
  cases red, naming the bot, its container, the ticket type and the manifest it came from.
- **Done when:** met for the core ticket types - every one of the seven routes to a dedicated node
  under signing, the choice and its reasoning are in `docs/security/http-delegation.md`, and the guard
  fails if any of them is refused. Two refusals are NOT covered and are filed separately below: the
  `task` call-out can still select a controller-inline bot, and the build/swarm pipeline never uses
  this hop at all.

### The `task` call-out can still hand a ticket to a controller-inline bot under signing

- **Observed live 2026-09-16.** Of the five `Signed HTTP delegation requires a dedicated bot-node
  endpoint` refusals in this box's api log in the preceding 24 h, THREE are this shape rather than the
  pinned-worker shape the entry above fixes: `routedBy: "bid"`, `workerAgentId
  a0000000-0000-0000-0000-000000000056` (self-healing-bot), on the `task` tickets
  `scripts/lib/deploy-verify.sh` files - `"deploy verification 2026-09-16T07:38:04.781Z"` refused at
  07:38:34.332Z, and two more at 07:39:34.264Z and 07:44:04.314Z. `self-healing-bot` has no entry in
  either registry file - it is registered dynamically - so it resolves to no endpoint and wins the bid
  anyway. (The other two, at 07:57:54.330Z and 08:10:30.744Z, are `routedBy: "pinned"` on
  `a0000000-0000-0000-0000-000000000047`, security-analyst: the case the entry above closes.)
- ADR-083 lets an online knowledge owner claim a `task` ticket and override the workflow's declared
  worker
  (`task-call-out.ts` -> `callOutAgentId` in `dispatch-manifest-worker.ts`). The workflow default is
  now a dedicated node (general-bot), but the local registry still holds 24 bots on
  `container: oshal-api` plus 13 that name a node and are held inline by the codex rule, and a
  dispatch to any of those is refused with `Signed HTTP delegation requires a dedicated bot-node
  endpoint`. `task` is the operator's highest-volume lane (269 escalated rows on this box).
- **Why the obvious fix needs care:** dropping endpoint-less candidates from the call-out silently
  changes who owns a ticket, and the 13 codex-held bots each name a real running container, so for
  them the answer is probably `requiresOwnNode` rather than exclusion - but two of the 13
  (`apply-operator`, `linkedin-profile-operator`) are remote-worker identities with no compose
  service, and one is `oshal-assistant`, the Jarvis brain, whose interactive path would move to its
  node with it. Each needs its own decision.
- **Done when:** a `task` ticket whose call-out winner has no dedicated endpoint either reaches a
  worker that does or is refused with a reason naming the routing decision rather than the transport;
  every remaining controller-inline bot is recorded in `docs/security/http-delegation.md` as
  interactive-only by intent; and a guard drives a call-out that selects an endpoint-less bot under
  signing and proves the ticket does not escalate with the transport message.

### The build/swarm pipeline has no signed transport - every work unit rides the Redis mesh

- **Found 2026-09-16** while routing the core ticket types (entry above). `build` does not use the
  controller-to-bot HTTP hop at all: `multi-round-dispatch-service.ts`,
  `swarm-execution-lifecycle-service.ts` and `swarm-subtask-handler.ts` publish
  `buildExecutionEnvelope(...)` onto `MESH_CHANNELS.agentDirect(<agent>)`, and every bot node wraps
  its mesh execution handler in `prohibitUnsignedMeshExecution` (`bot-node-server.ts:187`), which with
  a public ring configured answers `Unsigned Redis mesh execution is prohibited while delegation
  enforcement is active`. Verified on this box: all four sampled nodes log `Bot-node HTTP delegation
  is fail-closed ...` at boot, so the prohibition is active. Giving system-architect
  `requiresOwnNode: true` fixes the controller's endpoint decision; it does not give the swarm
  pipeline a transport. `docs/security/http-delegation.md` states the prohibition as intended
  behaviour; it does not say the build lane stops with it.
- **Not established:** whether any `build` ticket has actually failed this way since signing went on.
  The last `build` row on this box predates the 2026-09-15 deploy, so the refusal is read from the
  code path, not from a ticket.
- **Done when:** a `build` ticket completes with signing configured - its work units cross a signed,
  replay-bounded boundary rather than an unsigned mesh envelope, or the swarm pipeline is explicitly
  recorded as unavailable under signing with the surfaces that file `build` tickets saying so - and a
  guard runs one work unit end to end in whichever shape is chosen.

### A protected Jarvis answer with no bindable lineage leaves the thread silent

- **Observed 2026-09-16:** `returnProtectedComplexSummaries` ([src/app/routes/jarvis-orchestrator.ts](../src/app/routes/jarvis-orchestrator.ts)) skips a task when `recordDerivedJarvisResultLineage` returns no actor (`if (!actor) continue`), and no other leg picks that task up: the row stays `done` with a null result and the conversation the user asked in never says anything. A ticket classified protected by its SESSION binding but carrying no executions of its own reaches this state permanently.
- **Why the obvious fix is wrong:** the same null actor is how an unauthorised reader is refused. `tests/unit/protected-jarvis-thread-return.spec.ts` ("never derives or returns the answer for a principal carrying no verified issuer") pins that a PAT-shaped principal polling the owner's task must NOT cause a summary — so handing every unbound task to the automatic summarizer turns the refusal into a leak. The two cases have to be told apart at the source: "this reader may not have it" versus "this source has no lineage anyone could bind".
- **Remaining:** distinguish the two at the point of decision (the authority already knows which it answered), return the genuinely unbindable set to the caller, and give it an honest outcome — the automatic summarizer when the work product is not protected at all, otherwise a stated sentence in the thread rather than silence. Leave the refusal path exactly as it is.
- **Done when:** a protected-classified task whose source has NO executions ends with either an answer or a sentence in the thread it was asked in, proven against the real authority and real PostgreSQL in the existing fixture; and the unauthorised-reader case still produces nothing — same spec file, both cases green.

### The spec-database gate cannot see the live database reached through `docker exec`

- **Found 2026-09-16** verifying the fix for "Two trading specs default their DSN to the operator's LIVE database". The new gate (`scripts/ci/check-spec-database-default.sh`) catches the live databases as a DSN host, a `host:` field and an `env || 'oshal-local-db'` fallback, and catches port 55433 in every careless spelling — but a spec that runs `execFileSync('docker', ['exec', 'oshal-local-db', 'psql', '-c', '...'])` passes clean. That is the same defect class in the spelling the fixed file itself used, and it can WRITE, not just read.
- **Why it was left:** the exemption is deliberate and written into the script's header — `tests/dynamic-agent-live-e2e.spec.ts` legitimately drives the running deployment that way, and telling the two apart needs a path distinction the gate does not have. The hole is that the exemption is not scoped: a brand-new `tests/unit/*.spec.ts` gets it too.
- **Remaining:** scope the exemption to the suites whose purpose IS the live stack (an explicit, reviewed list or a directory rule), and refuse the shape everywhere else.
- **Done when:** a new `tests/unit/` spec that reaches `oshal-local-db` through `docker exec` fails the gate; the live-stack e2e suites still pass it; and the guard spec carries a case for each side.

## Workflow, agent, and model runtime

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

### Embedded LLM tools as a formal tier
- **Remaining:** model provider-native embedded tools beside framework-registry and harness-native tools with per-agent policy and audit semantics.
- **Done when:** an agent can enable/disable a named embedded tool, denied use fails at execution, and the run trace identifies the tier and provider operation.

### A protected dispatch refuses on a controller with no delegation signing material (2026-09-15)
- **Observed:** the operator asked a trading question at 00:51:01Z; it became ticket
  `aaa86e48-eaca-4977-b77f-bbffed0a6ca2` (`task`, title "yes but how much did we make or loose") and
  `dispatch-manifest-worker` failed with `authorization_recorded_delegation_required`. The ticket is
  sitting `escalated` in the cockpit with no answer. One occurrence in 24 h — the only dispatch that
  reached this path in that window. `ticket_status_history` names `workerBot: communications-bot`,
  `workerAgentId b0000000-0000-0000-0000-000000000001`.
- **Mechanism, corrected against the code and the running box.** The refusal is thrown in exactly one
  place, `BotNodeClient.prepareRemoteDispatch`, when the authority returned a prepared execution and
  the client holds no recorded issuer. The missing constructor option is **not** the determinant: the
  constructor derives a recorded issuer from the controller environment whenever
  `hasDelegationSigningConfiguration` is true, so `new BotNodeClient(resolver)` is a complete
  construction on a configured controller. What is missing on this box is the signing material itself.
  `docker exec oshal-local-api` reading `/proc/1/environ` shows `OSHAL_DELEGATION_SIGNING_KID` and
  `OSHAL_DELEGATION_SIGNING_PRIVATE_KEY` present and **empty** (no `BEGIN` anywhere in that environ);
  compose passes both through unconditionally (`docker-compose.oshal-local.yml:877-878`), the host
  `.env` sets neither, and `.env.example:794-795` carries them commented out. Meanwhile
  `createApplicationRemoteExecutionWiring` registers the authority unconditionally with lazy signing,
  so the controller looks healthy until a protected dispatch asks it to mint. `prepare()` returns null
  unless the target bot's owning package is `protected`, which is why one dispatch in 24 h reached it.
- **Shipped in this change (PR "A queued dispatch carries a recorded delegation instead of refusing"):**
  the refusal keeps the stable code as its first token and now names the unset keys and what to set,
  so the escalation metadata a ticket carries is actionable; it logs the agent, package and prepared
  execution at ERROR; and boot logs ERROR once when the authority is registered on a controller with
  no signing material. Guards: a spec drives the real client constructed the way production
  constructs it — endpoint resolver plus controller environment, no injected issuer — and proves both
  shapes, a configured environment minting a real Ed25519 delegation the fixture authority verifies
  before dispatch, and the live empty-key shape refusing with both key names in the message. The
  refusal case was red on the message before the change.
- **Still open, and it is the half that answers the operator's question:** nothing here provisions a
  signing keypair. Making a prepared dispatch complete on this box needs an Ed25519 key on the
  controller and the matching `OSHAL_DELEGATION_PUBLIC_KEYS` ring on every bot node — operator-local
  secret material, not something an agent mints. The fix is also not deployed and no re-ask has been
  run. The boot ERROR is a log, not a gate: boot is deliberately not failed, because an existing
  deployment running only unprotected packages would stop starting.
- **Done when:** the controller holds a signing keypair and every bot node the matching public ring;
  the operator's question above (or an equivalent re-ask) returns an answer instead of escalating; and
  a live protected dispatch is observed completing with a recorded delegation.

### Jarvis knows the shape of the data he can reach

- **Operator, 2026-09-15:** "why doesnt jarvis know about the data in the databases.. as an admin i should be albe to look across all data and have access to all functions". Approved shape, his choice: **schema first, rows behind signed delegation.**
- **Remaining:** give the turn a schema-level capability — the tables/columns/relationships the caller is authorised to see, assembled from the catalog rather than hand-listed, so Jarvis can answer "what do we hold about X" and name the right store without reading a single row. Row access stays where it is: an exact, schema-bounded read through the signed delegation rail, never a model-visible connection string, and never a free-text SQL tool. The catalog must be derived (the schema docs generator already does this for docs) so a migration cannot leave the answer stale.
- **Done when:** Jarvis answers "which databases and tables do we have, and what is in them" from the live catalog with no row data in the prompt; a row-level ask still routes to the delegated read and refuses without it; the catalog is generated, not typed; and a schema change is reflected without editing a prompt. Register the scenarios in AI Test Lab.

### Jarvis /ask answers 404 session_not_found in two guards (2026-09-16)

- **Built 2026-09-16 on `fix/jarvis-ask-session-not-found`. The GUARDS were wrong, and they were wrong about a rule the product tightened on purpose.** Instrumenting `ensureSessionTask` under both cases printed the same line twice — `created= undefined typeof= undefined` — so the write half never produced an owner-bound task, and `canReadJarvisSession` was never even reached. Each spec's fake task store answered `undefined` to `create()` and `null` to `get()` forever, which violates `ITaskStore.create(input): Promise<StoredTask>`; the real `InMemoryTaskStore` returns the created row (or the existing one) on every path, in memory and in Postgres.
- **Why it only started failing then:** commit `c18f057a` (2026-09-11, "Enforce current user rights across protected remote reasoning") changed the check from `return !created || created.ownerSub === sub` — where a store that returned NOTHING was read as agreement — to `Boolean(created && created.ownerSub === sub && ...)`, and added `canReadJarvisSession` to `/ask`. That is the correct rule (a store that cannot hand back an owner-bound task has not proved ownership) and it was not relaxed. The doubles had been written the day before, against the older reading.
- **What the live evidence does and does not show.** On the running box: 65 `chat_tasks` rows with `metadata->>'origin' = 'jarvis-chat'` spanning 2026-06-20 to 2026-09-15, **zero** with a null `owner_sub`, and zero `ensureSessionTask failed` lines. That is weaker than it looks, and the review of this change said so: `ensureSessionTask` always passes `ownerSub: sub`, so a null owner from this path is near-impossible either way, and the false-return branches logged NOTHING until this change - zero hits is equally consistent with "the gate is fine" and with "the gate is invisible". The honest reading is that this defect was not OBSERVED live, not that it could not happen. The shape it would leave is a session stranded at `status='created'` with zero messages, because the gate refuses before `markJarvisSessionTaskStatus(..., 'processing')`; exactly two such rows exist (`jarvis-f52548b2-...`, `jarvis-61f6f847-...`, 150 ms apart on 2026-09-14, both issuer-stamped), inside the window of the September Jarvis outage whose cause was the `text = uuid` ownership comparison in `application-execution-ownership.ts` - a different branch, already fixed on main. Nothing is stranded after that date.
- **Fixed:** both specs now run against the REAL `InMemoryTaskStore` through `tests/helpers/jarvis-session-task-store.ts`, which withholds `DATABASE_URL`/`PGHOST`/`POSTGRES_HOST` across construction so the store is memory-backed and holds no pool — it cannot reach a deployment's database. No assertion was weakened: the provider-intent spec's cross-owner case, which used to assert that a second owner reaching the same session id got an ordinary model answer, now asserts the stricter truth (404 before the model), and its direct-turn count follows that refusal from four to three.
- **And the silence is closed:** `/ask` used to emit the 404 with no log line at all, and `ensureSessionTask` called its own failure "non-fatal" while the caller turned it into a hard refusal — the same indistinguishability that let a Jarvis ownership fault read as an empty conversation for three days. The route now records which half refused (`refusedBy: 'ownership' | 'read-back'`) and the store fault is logged at ERROR as UNDETERMINED. The decision, the status and the body are unchanged.
- **Done when:** met — both cases green (`jarvis-provider-intent-routing` 63/63, `jarvis-artifact-routing` 21/21, from 1 failed each), the reason is in the commit and in both specs' Change Logs, no assertion relaxed, and [jarvis-ask-session-ownership.spec.ts](../tests/unit/jarvis-ask-session-ownership.spec.ts) covers the 404 branch end to end through the real route — owner admitted, foreign owner refused quietly, a store that returns nothing refused (restoring `!created ||` turns it red), a throwing store refused AND reported at ERROR, and a write-but-no-read-back session refused as the read-back half. Registered on the `jarvis-routing` Lab scenario, which had no `regressionTests` at all.

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
- **Blocked on the provider (operator, 2026-09-15):** Stripe is not provisioning accounts - sign-in fails on the provider side. Do not re-ask until that changes. Plaid is DONE: PLAID_ENV, PLAID_CLIENT_ID and PLAID_SECRET are set; only the Stripe test key remains.

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

### The nightly trading assessment loses its per-algo record to a market-data rate limit (2026-09-15)
- **Observed:** the 00:01:48Z `trading-assess` run recorded its predictions for the next session
  (`assessment recorded — predictions for next session`, 00:01:48.020Z) and then raised
  `too many requests.` twice from the market-data vendor — once at
  `recordPerAlgoPredictions` (`trading-assess-dispatch.js:49` → `barsBatch`,
  `market-data.js:164` → `adata`, `market-data.js:113`, logged at WARN as
  `per-algo prediction record failed`) and once from `multiTimeframeScan`
  (`multi-timeframe.js:140`), logged at ERROR as `assessment run failed`. The session's
  predictions survive; the per-algo detail behind them does not, and the ERROR line names the
  whole run rather than the step. One occurrence in 24 h, on the only assessment dispatch in that
  window; markets were closed.
- **Not established:** whether the limit is a burst from this run's own batches or contention with
  the other trading schedules (`trading-fast`, `trading-events`, `trading-autopilot` all fired in
  the same window), and whether `barsBatch` retries at all.
- **Done when:** `barsBatch` respects the vendor's rate limit (a bounded retry with backoff on the
  documented status, or a request budget shared across the trading schedules — read the vendor's
  limit rather than guessing one), a spec drives the limiter with a fake transport that returns the
  limit response and proves the batch completes rather than raising, the assessment logs which STEP
  failed instead of failing the run, and two consecutive nightly assessments record their per-algo
  detail with no `too many requests.` line.

### Trading — the engine manages positions it did not buy (ADR-159, 2026-09-15)
- **Decided by the operator 2026-09-15:** *"yes i bought some shares on the outside. if it cant be
  accounted for then it shouldnt be managed only monitored and fleged as unmanaged."* Recorded as
  [ADR-159](adr/159-the-engine-manages-only-what-it-can-account-for.md).
- **Today:** the engine manages whatever the VENUE reports it holds. `withEngineCostBasis`
  (`src/app/trading-engine-cost-basis.ts:98`) attaches `engineAvgCost` only when the engine’s own
  filled orders fully cover the quantity; a position it cannot cover is returned unchanged and the
  exit path measures it against the venue’s average price. The only ring-fence is a per-symbol
  `TRADING_CORE_SYMBOLS=SYM:0` the operator has to set before buying.
- **Evidence (30 days to 2026-09-15, live book, 219 sells):** −$33.03 on the engine’s own fills
  against −$9,697.53 stored by the venue; the 4 sells with no engine basis are all USO. The paper
  book — no wash-sale adjustments — agrees within ~5 % (−$6,797.57 against −$7,181.90), which is what
  shows the live gap is the venue’s adjusted basis rather than a replay defect.
- **Core — done:** `withEngineCostBasis` marks every long its own filled orders do not cover
  `Position.unmanaged` (partial coverage counts as uncovered) and carries the count on the
  `engine cost basis attached` line; `runAutopilot` applies the mark ONCE, right after the
  protected-lot overlay, so the core leg, the exits and the rotation all read it; `exitsToRun`,
  `trailingExits` and `rebalanceTrims` emit nothing for a marked position and are unchanged for a
  covered one; the beta-core top-up and both rotation paths withhold their buy, their trim and their
  drop-out sell for one, reserving the withheld buy's dollars so no other name's order can grow.
  Exposure, capital, the per-name/sector/deployed caps and the daily-loss halt still count it. Guards:
  `tests/unit/trading-unmanaged-positions.spec.ts`, `tests/unit/trading-unmanaged-entry-paths.spec.ts`,
  the `unmanaged` cases in `tests/unit/trading-engine-cost-basis-postgres.spec.ts`, and the golden
  dispatch plan, whose fixture now seeds the engine's own covering fills (without them the same fire
  withholds 4 of its 6 orders, which is the integrated proof that the rule only ever removes orders).
- **Done when:** the trading surface shows the flag and the reason on the row and in place of an exit
  that will not fire; and on the box the operator sees USO flagged with no engine order emitted for it
  after a deploy.
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

### World Intelligence: the market-hours pulse saturates the series store (2026-09-14)
- **Observed at 23:20Z:** `docker stats` showed `oshal-local-tsdb` at 282 % CPU and 1.9 GB;
  `pg_stat_activity` on `oshal_ts` held 19 active sessions, every one the per-source sentiment aggregate
  from `perSourceSentimentHours` in `src/features/world-data/world-intelligence-service.ts`
  (`… FROM world_metrics WHERE entity=$1 AND metric='sentiment' AND ts >= now() - ($2 || ' hours')::interval
  GROUP BY source`), each 35 s old. The statement is indexed (`world_metrics_entity_metric_ts_idx`; EXPLAIN
  gives an index scan), the newest `world_metrics` chunk holds 3.1 M rows / 681 MB and `world_items`
  1.76 M rows / 2.3 GB, the Docker VM one-minute load was 29 on 8 CPUs, and `app_world-ticker-pulse` logged
  `Schedule dispatch timed out — abandoning to unblock the runner` six times in ten minutes. The 18:10Z
  watchdog note in the coordination thread recorded the same timeouts under a different load spike.
- **Root cause, established from source:** one pulse touches **184 entities** (`DEFAULT_UNIVERSE`'s 159
  symbols plus the 25 `MARKET_SUBJECTS`, `world-schedule-dispatch.ts` `dispatchWorldSchedule`) and rolls
  features up for every one of them, four indexed aggregates each. The only bound was a compiled-in
  `FEATURE_ROLLUP_CONCURRENCY = 8` inside a single `mapPool`, and `schedule-service.ts:320-327`
  **abandons** a dispatch that overruns rather than cancelling it — "the underlying promise is left to
  settle on its own" — so an overrunning pulse keeps its fan-out running while the next one starts.
  Each rolled-up entity holds one statement open at a time, so one fire puts at most 8 aggregates on the
  store and N overlapping fires put 8N. Still not measured: whether the 19 sessions were two fires plus
  other readers or three fires — the source establishes only that nothing bounded the sum, which is the
  defect either way.
- **Fixed (PR, not yet deployed):** (a) a process-wide bounded gate in front of every world series read
  (`src/features/world-data/world-series-gate.ts`, `WORLD_SERIES_READ_CONCURRENCY`, default 4) — it holds
  across overlapping fires, which a per-run limit structurally cannot; (b) identical in-flight reads
  (same entity, metric, window) coalesce onto one statement; (c) the rollup's whole-day sentiment
  windows read `world_metrics_daily`, which carries `source`, instead of scanning the stream per source —
  read-only `EXPLAIN (ANALYZE)` on the live store: 786 ms planning + 366 ms execution for the 24 h stream
  read and 810 + 651 for the 168 h one, against 245 + 16 and 303 + 20 for the same answers off the head;
  (d) the pulse logs entity count, statements issued, statements coalesced and wall time at INFO and
  WARNs above a configured fraction of its window (`WORLD_PULSE_WINDOW_MS`, `WORLD_PULSE_WARN_FRACTION`).
  Guards: `tests/unit/world-series-read-gate.spec.ts` (proven red with the gate bypassed — max in-flight
  12 against a bound of 3, and four sentiment statements for two answers).
- **Done when:** the ticker pulse completes inside its window on this box with the full name set, with
  the World app re-enabled after the fix deploys, and the pulse's own `elapsedMs` / `seriesStatements`
  record shows it — the one remaining item, and it is the coordinator's after deploy.

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

### Lazy-DDL trigger and function guards must converge, not create-once
- **Done (2026-09-14):** `tests/unit/lazy-ddl-guard-convergence.spec.ts` with `tests/helpers/lazy-ddl-guards.ts` enumerates every guard under `src/` that keys a trigger or function on its name alone (`IF NOT EXISTS … pg_trigger / pg_proc / information_schema.triggers / information_schema.routines`, `to_regproc … IS NULL`). The inventory is two guards, both in `person-model-schema.ts`: the consent trigger (converges on the tgtype DELETE bit) and the `ambient_speaker_consents_no_flip` function (create-once by design — `CREATE OR REPLACE` raises 42501 for the app role — so its CREATE statement and live body are pinned). A new, moved or removed guard, or a changed CREATE statement without a convergence decision, is red; an empty inventory is red; the scanner is self-tested on fixtures of every shape. Read-only psql against the dev box on 2026-09-14 returned exactly the pinned rendering: `CREATE TRIGGER ambient_speaker_consents_no_mutate BEFORE UPDATE ON public.ambient_speaker_consents FOR EACH ROW EXECUTE FUNCTION ambient_speaker_consents_no_flip()` (tgtype 19) and the pinned `prosrc` body.
- **Remaining:** the real-boundary case added to `tests/unit/person-model-parity-postgres.spec.ts` (every known guard rendered on a real Postgres via `pg_get_triggerdef` / `prosrc` equals its pinned live definition) has not run: the host port is wedged and the Docker load gate stayed above 6 on 2026-09-14.
- **Done when:** that case is green from `ci-local.sh --head` (or the host) once the engine is repaired.

### Person-model maintenance never runs on a box that restarts daily
- **Done (2026-09-14):** `startPersonModelMaintenanceRuntime` runs the first pass `PERSON_MODEL_MAINTENANCE_INITIAL_DELAY_MS` (default 120000, clamped 1 s–24 h) plus up to `PERSON_MODEL_MAINTENANCE_JITTER_MS` (default 30000) after boot, then daily; compose forwards both knobs with empty defaults and `.env.example` documents them. `tests/unit/person-model-maintenance-runtime.spec.ts` pins the schedule with fake timers (red on the old runtime: 4 of 6 cases failed, "first pass at base + jitter: expected vi.fn() to be called 1 times, but got 0 times"; green after) and `tests/unit/compose-env-passthrough.spec.ts` pins the forwarding.
- **Remaining:** the live proof — one `person-model maintenance pass complete` line in the api log of a fresh boot — waits for the next deploy; no container was restarted on 2026-09-14.
- **Done when:** that line appears in the fresh-boot api log after the deploy.

### Real-Postgres specs cannot run from this host while Docker port publishing is wedged
- **Remaining:** the database container's published port is configured but not live, and a new bind reports "port is already allocated" for a free port, so every real-database spec (this one and the trading/authorization ones) fails loudly from the host. `scripts/person-model-gate-in-container.js` is the hand-kept twin of `tests/unit/person-model-parity-postgres.spec.ts`.
- **Done when:** either the engine is repaired and `npx vitest run tests/unit/person-model-parity-postgres.spec.ts` is green from the host, or `ci-local.sh --head` runs the gate inside the api container when the host port is dead; and the twin shares its assertion list with the spec so they cannot drift.

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

### Six host scheduled tasks predate the platform scheduler and should move into it

- **Operator, 2026-09-16:** *"should there be scheduled vbs tasks really shouldnt this be done via cron"*. Windows has no cron — but this platform has its own scheduler and it is already running: twelve-plus distinct `scheduleId`s in six hours of api log, including `daily-trade-recap-…-recorded-reports`, `trading-assess_…`, `marketing-engine-weekly-campaign-review`, `venture-plan-rebaseline-policy-tick` and `social-daily-digest`. So the question is not cron versus Task Scheduler; it is **host versus platform**.
- **Must stay on the host** — a schedule inside the stack cannot start the stack, build its image, or write the operator's own credentials: `OSHAL Stack Watchdog`, `OSHAL Local CI`, `OSHAL Claude token keepalive` (writes `~/.claude`).
- **Should move into the platform** — domain work whose siblings already schedule internally: `OSHAL Signal Labeler`, `OSHAL Kalshi Forward Test`, `OSHAL Trading Watchdog`, `OSHAL Lab Report Publish`, `OSHAL Weekly Report`, `OSHAL-Store-Publish`. Each one that moves also stops depending on a checkout path, which is the class of failure that left three tasks running a 55-day-old tree until 2026-09-16.
- **The `.vbs` wrappers are a symptom, not a design.** All eleven tasks are `LogonType: Interactive` (measured), so they run on the operator's desktop session and a bare `powershell.exe` action flashes a console window — the `.vbs` exists only to suppress it. Registering them `-LogonType S4U` ("run whether user is logged on or not") runs them in session 0 with no window and no wrapper. **Test the keepalive first:** S4U has no stored password, so anything needing network-share auth or an interactive token can behave differently, and that task touches `~/.claude`.
- **Remaining:** decide the split above task by task, move the six, and retire each `.vbs` whose only job is hiding a window. `OSHAL-Evidence-Nightly` stays on the archive by design and is out of scope (see [the runbook](runbooks/scheduled-tasks-trunk-vs-archive.md)).
- **Done when:** every moved task runs as a platform schedule with its outcome visible where the others are, no launcher in `scripts/` exists solely to hide a console window, and the host task list contains only entries that genuinely cannot run inside the stack — with the reason for each written next to it.

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
  two-registries fail-closed rule are not built.
- **Built 2026-09-16 — D10.** A registry hostname that resolves into private space is refused, and
  the approved address is PINNED for the fetch: `fetchRegistryCatalog` hands `https.request` a
  `lookup` returning the validated address, so the connection cannot be moved by a second DNS answer.
  Verified against a loopback DNS server and a real resolver seam: 22 address spellings refused
  (loopback, RFC1918, `169.254.169.254` and its IPv6 form, IPv4-mapped IPv6 in both spellings,
  decimal/octal/hex integer forms, trailing-dot names, CGNAT, broadcast, multicast), a rebinding name
  resolved exactly once, HTTP redirects refused, and TLS still validated against the NAME rather than
  the pinned address. The clone path refuses redirects too (`http.followRedirects=false`), because
  `http.curloptResolve` maps only `host:port` and git's default follows the first hop straight past
  the pin — measured with git 2.51.2. NAT64 (`64:ff9b::/96`), 6to4, site-local and IPv4-compatible
  IPv6 forms are refused as well: on an IPv6-only network with NAT64 the gateway translates
  `64:ff9b::10.0.0.1` into `10.0.0.1` and the connection succeeds.
- **Still unfenced, deliberately out of scope here:** the installer child (`scripts/oshal-app.js`)
  and the preview clone (`app-registry-routes.ts` `entry.source?.url ?? registry.url`), whose nested
  sparse checkout does fetch.
- **Done when:** a two-registry dependency spec fails closed on ambiguity; a fence spec where a
  hostname resolving to `10.0.0.0/8` is refused through a real local resolver seam; and ADR-147's
  As built section records the completed behavior and evidence.

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
- **Built 2026-09-16 on `feat/node-installer-posix`.** `GET /api/join/node-installer?platform=macos|linux` now renders a POSIX `.sh` carrying the same per-device token and nothing swarm-wide, refusing the same loopback and quotable-character cases, and the Get oshal Desktop tile detects the platform and offers it. Guarded by `tests/unit/node-installer-platforms.spec.ts` - 16 of its 19 cases go red when the two source files are reverted, and the rendered script was executed under bash 5.2, bash 3.2 (what macOS actually ships) and busybox ash across seven branches. **Remaining:** the bare-machine run. The node app itself installs from npm on macOS and Linux, and the five values the Windows script seeds (`OSHAL_CONTROL_PLANE_URL`, `OSHAL_SHARED_SECRET`, `OSHAL_ENROLLMENT_TOKEN`, `OSHAL_CLIENT_ID`, `OSHAL_CLIENT_NAME`) are platform-neutral, but no script renders them for a shell and the path has never been run on a Mac or Linux box.
- **Done when:** the route renders a platform-appropriate script (`?platform=macos|linux` → a `.sh` carrying the same per-device token and nothing swarm-wide, refusing the same loopback and quotable-character cases), the Desktop tile offers it by detected platform, and one real macOS or Linux machine with no checkout registers owned through that file — recorded in the real-boundary audit.

### Node enrolment is the blocker for every remote-node capability
- **Built 2026-09-16 on `fix/node-enrolment-no-shared-secret`:** `installer/lib/install-node.ps1` no longer configures a node with `REMOTE_CLIENT_SHARED_SECRET` - it refuses `-SharedSecret` by name, requires an enrolment token, and drops the secret out of the join-code branch. Proven by executing the real `Start-NodeApp` rather than reading it, and 6 of its 30 cases go red when the file is reverted. **Remaining:** the bare-machine proof (a no-checkout machine enrolling and appearing OWNED in the mesh view), and the minting gap this entry has always named - device-bound tokens come only from `POST /api/join/enroll`, mounted behind `requiresAuth` (a real OIDC session), so nothing headless can mint one, while `POST /api/cli-tokens` mints an UNBOUND 30-day PAT, which is more reach than a node should hold and expires under it. The one-click download (`GET /api/join/node-installer`) is the only surface that emits a bound, non-expiring token together with the client id it is bound to; any path that collects a token WITHOUT that id yields a 403 `node_token_client_mismatch` or an unbound hour-long credential.
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
- **Done 2026-09-14:** the orphaned operator PAT `f17a2172-9345-4770-aab9-2e1dd3f84a1f` was revoked by its
  owner through `DELETE /api/cli-tokens/:id` (`{ ok: true, revoked: true }`), and the owner's token list
  then reported `revoked: true` for that id.
- **Remaining:** `printServiceEnabled` was left **true** (port 633) on this machine's node, an
  outward-facing service advertising on the LAN.
- **Done when:** the operator has decided whether the node's printer stays enabled on this machine.

### App status contract (ADR-145) — build the `status:` declaration and the highlights section
- **Built 2026-09-16 on `feat/adr-145-app-status-dashboard` (D3/D4/D5), on top of D1/D2.** The dashboard reports for ONE app rather than only a group: a manifest's `summary:` is fetched from a route that app itself owns, in the viewer's own session, and an app that declares nothing falls back to its recent `jarvis_tasks` rows. The plan route is caller-scoped through `listApps('active', {ownerSub, isOperator})`, so another person's person-scoped app 404s exactly like a name nothing installed - which the group plan it replaces did not do.
- **The cost ADR-145 accepted, recorded here so nobody rediscovers it as a defect:** `summary:` is a DECLARATION. Validation is structural (own mount, canonical path, session-admitting route, valid RFC 6901 pointers) and the coercion caps counts and degrades an unknown tone - but nothing reconciles a declared value against observable state, so an app can paint a green tile while it is broken. What bounds the blast radius is that the value must come from the app's own route in the viewer's own session: no app can report for another, and no card can show data the viewer is not entitled to.
- **Remaining:** the last done-when clause only - a signed-in operator seeing one app's tiles and items beside its setup steps on the DEPLOYED box, with a deliberately broken probe rendering "can't check". Everything else in that clause is proven headlessly against the shipped page.
- **Done when:** a manifest declaring a `status:` that is unowned, non-canonical, service-only, or malformed fails the load (extending `tests/unit/swarm-app-groups.spec.ts`); a pure spec pins the caps, the tone degrade, and the can't-check path; a REAL-BOUNDARY case drives the plan route against a live app probe over an actual HTTP mount (not a mocked resolver) and is recorded in the real-boundary audit; and a signed-in operator sees one app's tiles and items rendered beside its setup steps on the shipped page, with a deliberately broken probe rendering "can't check" rather than a green state.

### A global Home composing every app's status card (ADR-145 D9)
- **Remaining:** a second renderer over the ADR-145 plan that fans out across every active app the user has, one card each. Needs a harder fan-out bound than D7's per-page one (59 active apps on the operator's box today) and probably a short-TTL cache. Also forces two decisions ADR-145 deliberately left open: what supersedes the cockpit `DashboardHomeView`, and whether the orphaned `src/pages/user-dashboard/` is retired or deleted outright (it is mounted at `/user-dashboard` and referenced by nothing).
- **Done when:** one page renders a card per active app within a stated latency budget under the real installed-app count, a slow or failing app degrades to "can't check" without delaying the others, the superseded surface is removed in the same change rather than left as a second answer, and no card displays a value its owning app did not assert over its own declared route.

### Codex swarm-side OAuth — the token exchange fails at the last step (2026-09-08)

- **Remaining:** the redirect half is fixed and proven (core #372): `GET /api/openai-codex/oauth/start` now mints a valid authorize URL (`auth.openai.com/oauth/authorize`, the Codex CLI's own `client_id`, `redirect_uri=http://localhost:1455/auth/callback`, PKCE S256), the dedicated `:1455` listener accepts the redirect, and `/auth/callback` forwards a codex-shaped callback to the codex handler. A real browser round trip delivered a genuine authorization code (`code=ac_…` with the exact state the swarm minted). **The exchange then failed**: `openai-codex-oauth-routes` threw `TypeError: fetch failed: other side closed` about 34 s after `Completing OpenAI Codex authorization flow`, so nothing was written back and the browser showed `ERR_EMPTY_RESPONSE` / "Authentication Failed". Cause NOT identified. Basic egress to that host is fine (DNS resolves to Cloudflare, TCP 443 connects, TLS completes); the 403 a bare `GET https://auth.openai.com/` returns is Cloudflare's normal answer to a request with no browser headers and reproduces from the host too, so it is not evidence of a block. Candidates not yet tested: Cloudflare refusing the POST to the token endpoint from a datacenter/NAT egress, a proxy/TLS-inspection layer, or a client assertion the exchange omits (the CLI's own authorize URL carries `codex_cli_simplified_flow=true` and `originator=codex_cli` plus a broader scope, which the swarm's URL does not). ⚠ Do NOT brute-force retries: repeated failed authorize attempts risk rate-limiting or flagging the OpenAI account (operator, 2026-09-08).
- **Done when:** one `/start` → browser → `:1455` round trip completes with the swarm logging a successful token exchange and `GET /api/openai-codex/oauth/status` reporting `authenticated:true` with an `expiresAt` that provably came from THAT exchange (not from a pre-existing credential or a refresh), captured in the real-boundary audit; and if the cause turns out to be the missing CLI flow parameters, the authorize URL carries them.
- **Workaround meanwhile:** the file-push path works end to end — `codex login` on the machine, then **Push to swarm** in the node app (`POST /api/openai-codex/oauth/import`), verified 2026-09-08.

### partner-app-registration.md covers about a third of the wired hub connectors
- **Remaining:** the registration reference table omits ~19 providers that are wired in `connector-provider-registry.ts` (schwab, slack, square, paypal, plaid, jira, twilio, walmart, uber, uber-rides, duffel, ringcentral, kalshi, finnhub, bluesky, resend, plus the ADR-065 PAT batch). The generated per-spec pages under `docs/connectors/` do not cover partner registration (portal steps, env-var names, redirect overrides). Found by the 2026-08-30 connection-framework docs audit — the doc's own "every connector named here is wired" claim holds, but the reverse direction does not.
- **Done when:** every `PROVIDERS` entry with auth `oauth`/`link` has a reference row (env keys verified against `providerCreds()`, redirect path/override named), or the doc explicitly lists which providers are PAT-paste-only and points at their `tokenHelpUrl`; any count in the doc derives from the registry, never typed.

### ADR-145 Home view: the browser render is still unverified (2026-09-09)
- **Remaining:** the deploy half is CLOSED. `scripts/oshal-deploy.sh` ran unpiped to exit 0 on 2026-09-09 (image `4e6773a850c5`, label `b10f79f060eb` == HEAD), the `api fully up (healthy + auto-load)` gate that failed the two prior attempts passed in 26 s, census 35/35 healthy with parity clean and 0 restarts. The earlier failures were host memory pressure, not ADR-145: the box had ~1 GB available of 15.7 GB, and stopping the 34 bots the deploy recreates anyway (dropping the daemon's polled container count 46 -> 12) was enough for the gate to clear. `GET /api/swarm/apps/home-plan` was then verified AS A SIGNED-IN USER via a bootstrap-minted PAT (revoked by captured id immediately after, `revoked:true`): HTTP 200, 33 KB, **67 cards — 65 `kind:app` + 2 `kind:group`**. What is NOT verified is the part that needs a human at a browser: that the cockpit Home view actually RENDERS those cards, and that an app whose probe is broken degrades to "can't check" rather than showing a green state. Core returns manifest data only — every status/readiness probe is issued by the page in the viewer's own session (ADR-145 D6) — so no headless call can exercise the render or the degrade path.
- **Done when:** a signed-in operator opens the cockpit Home view and sees one card per active group/app, and an app with a deliberately broken probe renders "can't check" instead of a green state.

### Cockpit rail: static tiles that target another package must follow that package's discoverability (ADR-149)
- **Done (core, 2026-09-14):** `synthesiseProfile(name, discovery?)` hands its static tiles to `lockUndiscoverableTiles` (`src/features/swarm-apps/services/swarm-app-tile-discoverability.ts`): a tile whose `iframeUrl` is under ANOTHER active package's mount (longest mount wins) asks that package's `canDiscover(actor)` through a port `src/app/routes/ui-profile-routes.ts` binds to the verified actor, and a non-discoverable target comes back `locked: { app, reason: 'application-role-required', roleGuidanceUrl }` — kept in place, `toolUi` untouched. `RibbonNav.js` forwards `locked` into the view and renders it in the existing `guest-disabled` treatment (lock glyph, dimmed) with `data-role-guidance` on the button; a click follows that link top-level (`/users`, or `/access` for a swarm admin — `roleGuidance(actor)` in `application-navigation-authorization.ts`, the same link the 403 page offers). A tile under the app's OWN mount or on a path no package owns is never touched; a legacy-mode package is always discoverable (runtime `canDiscover`); an ADR-141 group's borrowed tiles follow their member; no port (internal callers) = the declared rail; no manifest changed. Guards: `npx vitest run tests/unit/rail-tile-discoverability.spec.ts tests/unit/ribbon-locked-tile.spec.ts` — 16 pass on the change and 12 of them fail on the unchanged source (real profile route, real `SwarmAppService`, real `ApplicationAuthorizationRuntime` over `MemoryAuthorizationStore`, real package loading; repository and identity doubled).
- **Done (core, 2026-09-16) — the LANDING half.** A locked tile is no longer what the cockpit opens on: the synthesised `defaultView` comes from `openableDefaultView` — the declared tile when it is openable, else the first openable tile, else `frameworkItems[0]`, which every one of the 68 installed manifests produces. Identical to the previous behaviour when nothing is locked (84 no-lock input shapes, zero divergences). `renderToolView` renders the lock panel instead of iframing a `locked` view, covering the landing view, a rail click, and an `app-navigate` onto an already-railed tile. The lock is decided server-side from the verified actor and is a DISCOVERY mark only — a client that ignores it still meets the mount guard, measured as 403 with the surface body absent. Guards: `npx vitest run tests/unit/rail-tile-discoverability.spec.ts tests/unit/cockpit-locked-surface.spec.ts` — 17 pass, and 2 and 4 respectively fail against the unchanged source.
- **Remaining:** nothing in the done-when. The rail has not been exercised in a browser against a live enforce-mode install.

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
- **Deployed half verified 2026-09-15 00:35Z** (image `651c503a44c4`, the `aba0e31f` deploy): the two
  shared fixtures the `harness:core-test-fixtures` prerequisite needs are IN the running image at
  `/app/tests/fixtures/` (isolated-browser.ts 4,624 B, stl-viewer.ts 8,654 B) and load through the
  image’s own tsx exactly as the runner probe loads them (`require("tsx/cjs")` then the fixture;
  exports `closeOwnedBrowser, launchIsolatedBrowser, observeBrowserExit`). That is the staging and
  probe mechanism only. The three store cases that declare the prerequisite (cad-studio
  surface-lifecycle, embodied surface-browser, scan-to-print surface-freshness) still report
  `pending` on the HOST batch runner by design — it supplies disposable offline fixtures only — so
  the sealed-sandbox run remains the open proof, and the Test Lab route refuses a service identity
  under ADR-149, which is why it needs the operator’s signed-in session.
- **Run it with:** `npx vitest run tests/unit/package-test-sandbox.spec.ts -t "browser profile|browser environment"`
  from the core checkout, with Docker up and `oshal-bot:latest` present, when the Docker VM's
  one-minute load is below 6 (read it with `docker exec oshal-local-api cut -d' ' -f1-3 /proc/loadavg`).
- **Done when:** both cases pass on the image, a Create browser recipe runs to a result from the
  installed Lab after a core deploy, and the batch path admits the `browser` level — schedule
  levels, the selector's exact-match rule and the page's counts are a separate slice, and changing
  the selector rule must not strand the existing `integration,unit` selector the operator uses.
- **`harness:core-test-fixtures` (2026-09-14, `feat/test-lab-core-fixture-harness`):** three store
  browser cases (cad-studio `surface-lifecycle`, embodied `surface-browser`, scan-to-print
  `surface-freshness`) stayed pending on this name because they require the core's
  `tests/fixtures/isolated-browser.ts` and `tests/fixtures/stl-viewer.ts` from `OSHAL_CORE_ROOT`
  through `tsx/cjs`, and the image shipped no `tests/` at all (`ls /app/tests` in `oshal-local-api`:
  no such directory). Measured closure: those two files, 13,278 bytes, no relative imports, bare
  imports `playwright` and `express` (runtime dependencies) plus Node builtins; `tsx` 4.22.4 is a
  runtime dependency present at `/app/node_modules/tsx` in the running image. *Done:*
  `Dockerfile.oshal` copies exactly that closure to `/app/tests/fixtures/` with the matching
  `.dockerignore` allowlist; the runner probe loads each file through tsx from the core root and
  `harness:core-test-fixtures` is advertised only on a positive report;
  `tests/unit/package-test-core-fixtures.spec.ts` holds the staged set, the COPY, the allowlist and
  the advertisement together (its COPY, allowlist, probe-content and advertisement cases were red
  before the change, 4 failed / 5 passed, and green after). *Not done:* the Docker case
  `advertises harness:core-test-fixtures exactly when the image carries the staged fixture closure`
  in `tests/unit/package-test-sandbox.spec.ts` has not run (Docker VM one-minute load 8.9 when this
  landed). **Cleared 2026-09-16 by the deploy of `1cc13e12` (image `d3db70cd34f2`):** the image now
  carries `/app/tests/fixtures/isolated-browser.ts` and `stl-viewer.ts`, and that Docker case passes
  on it — `npx vitest run tests/unit/package-test-sandbox.spec.ts -t "core-test-fixtures"`, 1 passed
  in 11.4 s with `harness:core-test-fixtures` in the probe's verified set (Docker VM one-minute load
  3.69; the duration matters because a sandbox DECLINE returns in about 200 ms and reports the same
  green). *Still open:* one Lab run of each of the three store cases on the box.
  **Done when:** that Docker case passes on a rebuilt image (run it with
  `npx vitest run tests/unit/package-test-sandbox.spec.ts -t "core-test-fixtures"` under the same
  load rule as above) and one Lab run of each of the three cases passes on the box — a real run of
  seconds, not a sub-second decline. The store side needs no change for admission: the cases already
  declare this exact name.

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

### Compare our simulators against PteroSim (2026-09-15)

**Context:** operator ask — carry PteroSim as the outside comparison point for our own simulators.
[PteroSim](https://pterolabs.ai/) ([GitHub](https://github.com/PteroLabsAI/PteroSim-UAV-Simulator),
[PX4 docs](https://docs.px4.io/main/en/sim_pterosim/index)) renders in Unreal Engine 5, computes 6-DOF
dynamics with JSBSim, and speaks the lockstep Simulator MAVLink API on TCP 4560 to PX4, ArduPilot and
Betaflight SITL, with a gRPC/Python SDK for multi-vehicle orchestration on Windows and Ubuntu. Our
simulators solve different problems and none of them overlap it fully: `aero-lab` is a design-space
search on a custom two-timescale 3-DOF integrator (it rejected JSBSim after measuring it add energy at
wind-field steps); the `embodied` physics lab ([ADR-152](adr/152-embodied-physics-and-training-lab.md))
is MuJoCo from the parts model with the kinematic sim as the certification gate; the embodied drone node
already flies real PX4 SITL (SIH) over MAVLink but with no scene and no aerodynamic model; Spaces' Sim
engine reconstructs rather than flies. The gap is an independent 6-DOF result to check ours against, and
a rendered world for camera-in-the-loop work. This entry is evaluation, not adoption.

**Done when:**
- A written comparison covers each of our simulators against PteroSim on: what physics it solves, what it
  renders, which flight stack it drives, how a bot or node would call it, and what it costs to run — and
  states for each one whether PteroSim is a cross-check oracle, a replacement, or neither, with the reason.
- One reproducible cross-check is run and recorded, not asserted: the same vehicle and the same commanded
  manoeuvre through the embodied PX4 SITL node and through PteroSim, with the two trajectories and the
  divergence published. A disagreement is a finding about one of the two models, named as such.
- The licence position is recorded before any dependency is taken: the free tier's one-vehicle, F450-only,
  two-hour/five-hour-cooldown and non-commercial limits are written down against the way we would actually
  use it, and anything that would need a paid tier is called out as a purchase decision, not assumed.
- If the answer is "neither", that verdict is recorded with its reason and the entry closes — a negative
  result here is a result.

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

**Written, not deployed (2026-09-14).** Both halves are open as PRs and neither is on the box.

- **Core — [PR #473](https://github.com/emeraldcoastsystemsgroup/oshal/pull/473):** `import-limits.ts` resolves `OSHAL_SPACES_PLY_MAX_BYTES` (default 50 MiB)
  and `OSHAL_SPACES_PLY_WORKER_HEAP_MB` (default 1024) from the environment at the point of use, so
  no limit is a literal anywhere; `ply-convert-host.ts` / `ply-convert-worker.ts` run the conversion
  in a `node:worker_threads` Worker under `resourceLimits`; `ImportReconstructionProvider` refuses a
  `.ply` over the gate and turns a worker death (out of memory, parse throw, silent exit) into a
  `ReconstructionError` whose message the service writes onto the failed row. `.splat` passthrough
  unchanged. `tests/unit/spatial-import-event-loop.spec.ts` is red on the on-thread provider (`loop
  held 404 ms while the on-thread conversion takes 346 ms`) and green after;
  `tests/unit/spatial-import-worker.spec.ts` kills a real Worker under a 24 MB cap and reads the
  reason off the failed row.
- **Store — [oshal-applications PR #206](https://github.com/emeraldcoastsystemsgroup/oshal-applications/pull/206):** `spaces` 0.9.0 gates the `.ply` **while the part streams** — a multer
  storage engine stops writing at the first chunk past `resolvePlyImportLimits().plyMaxBytes` and the
  lane answers 413 naming the limit, so an oversized capture is never fully received, written or
  parsed. `tests/ply-import-off-loop.core.test.js` drives the compiled packaged router over real
  loopback HTTP beside a real `/health` route with the framework's real limits and conversion engine.
  Both halves are red before their fix and green after: the gate case fails `201 !== 413` on the
  un-gated route (an 11 MB `.ply` accepted whole), and the loop case fails `/health worst round trip
  346 ms against a 438 ms on-thread conversion` when the kernel provider is put back on the main
  thread.

**Still open:**
- The core PR has to merge and **deploy before** the store package is updated on a box — the route
  imports `resolvePlyImportLimits` from the pinned `spatial-mapping` kernel skill, which an older core
  does not export. Until both land the live lane is still ungated.
- Neither the 117 MB nor the 44 MB capture from the incident has been re-imported against the fix; the
  proofs above run generated fixtures either side of a 4 MB test gate.
- The store guard is a `*.core.test.js`, so it runs only where a framework checkout is present
  (`OSHAL_CORE_DIR`), the same convention as the package's `upload-identity.core.test.js`; the
  bare-checkout store CI glob does not reach it.

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

### The durable escalation store only ever sees swarm-run escalations (2026-09-15)

**Context:** `swarm_escalations` has exactly one writer — `persistEscalationRecord`
([swarm-ticket-lifecycle-helpers.ts](../src/features/swarm-orchestration/services/swarm-ticket-lifecycle-helpers.ts)),
called only from `SwarmExecutionLifecycleService`, which needs a `runId`. An escalation raised
outside a swarm run — a manifest-worker dispatch failure, an operator park, a queue DLQ
transition — has no run id and so structurally cannot produce a row. On the operator box the table
holds 100 rows whose newest is dated 2026-07-19, while tickets have escalated since. The cockpit
now reads the reason from the transition record instead (`ticket_status_history`, mirrored on the
ticket row as `metadata.lastStatusTransition`), so the operator-visible text is correct either way;
what is unresolved is what the durable store is *for* now that it answers a strict subset of
escalations.

**Done when:** a written decision records whether `swarm_escalations` is the canonical escalation
record — and therefore every escalating path writes one, run id or not — or a run-scoped
attempt-state record that the cockpit should stop treating as its primary escalation lookup.
Whichever it is, `PostgresSwarmEscalationStore` and the cockpit's `getTicketEscalations` lookup
agree with it, and a guard proves an escalation raised by a non-run path lands wherever the
decision says it belongs, proven red by removing that write.

### A vehicle record, and the medium it runs in as a parameter (ADR-160) (2026-09-15)

**Context:** [ADR-160](adr/160-a-vehicle-record-and-the-medium-as-a-parameter.md). Two vehicles are fully
specified and neither can be developed or moved: the 300 mm marine explorer exists as
[a design study document](research/autonomous-explorer-design-study.md) whose engines were carved into the
`ocean-lab` store package while the vehicle itself was not, and the Floater solar dynastat exists as a
committed `aero-lab/reference-design/` folder holding one `export_build_files.py` run that cannot report it
has gone stale. Neither `ocean-lab` nor `aero-lab` has a `migrations/` directory, so nothing persists and no
object can carry a stage. The operator then added interchangeability — run an aircraft in the water module
and the reverse, and *"want the boat fall to the ground"*. Verified before costing: the medium is already an
argument in most force models (`aeropolar.wing_polar` takes `rho_kgm3`/`mu_Pas`, and
`vehicle/aerosurface.py` `evaluate()` L720–721 sets both from the `AtmoSample` and passes them through
`coefficients()` L504 → `_polar_for_bin()` L417 → `aeropolar.wing_polar` L447/L460; `rotor-types.ts`
L69–72 and `bemt-solver.ts` L563/L711 take density and kinematic viscosity with seawater only a preset;
`panel-method.ts:239` contains no viscosity at all; `embodied_worker.py:223` reads the controller's
gravity from the model). The assumption lives in presets, in
`marine/services/power-budget.ts:70` (a second hardcoded `SEAWATER_DENSITY_KGM3`), in
`embodied/src-routes/engine/physics/mjcf.ts:115` (gravity from a module constant, no `density`, no
`viscosity`) with the same literal again in `arm-mjcf.ts:135`, and in validity envelopes declared
nowhere but `aeropolar`'s per-point `valid` flag — which cannot catch a medium swap, because water's
lower kinematic viscosity moves Reynolds *up*, away from the floor that flag enforces, so an air
surrogate answers a water run and reports `valid = True`. Store-repo
work in `ocean-lab`, `aero-lab` and `embodied`; no core code.

**Done when:**
- **S1 — the boat falls.** The medium record exists (id, gravity vector, density, dynamic viscosity, an
  optional field with its gradient, a free surface or none, validity bounds and a refusal outside them) with
  three implementations — vacuum, air behind `aerosim.env`, seawater; the MJCF `<option>` is fed from the
  chosen medium instead of `G_MPS2`; the explorer hull is one solid from its published envelope and all-up mass.
  In air it falls at g. In seawater it **refuses by name** rather than producing a plausible float, and that
  refusal is a test case, not a note. Because D3 forbids a cross-package runtime import, these media are a
  third TypeScript location: their property values must therefore be one committed data row per medium,
  shared as data and pinned by the S5 drift test, not a third and fourth independent answer to "what is
  seawater" — the defect this entry diagnoses one level down.
- **S2 — the Explorer record.** `ocean-lab` carries its first migration (vehicle records, owner RLS), the
  explorer seed vector as a committed fixture, the limit rows from the study's "What is not true" section, and
  an **Explorer** tile. Changing the wing stop angle or the tether length and evaluating moves the five-row
  sea-state table, the occurrence-weighted mean, the km/day and the km/year; the stage recomputes on read and
  drops when the vector changes; the open limits and the runs S1 recorded are listed.
- **S3 — parts and geometry.** The explorer's parts model and each watertight part as a CAD Studio program
  with **Open in CAD Studio**, emitting the portable-object shape (identity and provenance, geometry, mass
  properties with provenance, a named attachment frame, force-model requirements). The displacement budget
  closes against the sizing computed at that mass or the stage refuses to advance.
- **S4 — the Floater record.** `aero-lab` stores the existing export run as the first evaluation, with
  `BOM_v2`'s mass delta as a budget check (expected red on first run: real parts are 274 g heavier than the
  certified ledger) and its force models' validity envelopes declared.
- **S5 — the guards.** Cross-package read-only tests fail when the record shape, the stage function, the
  medium shape, the medium property values or the portable-object shape drift between labs; a regression asserts the engine at today's
  version still reproduces the study's published figures from the seed within a stated tolerance; there is one
  case per named refusal (`medium_property_unavailable`, `model_not_valid_in_medium`). An undeclared validity
  envelope fails closed — refusing every medium but the model's default — rather than defaulting
  permissive. The store's package-separation guard is not weakened: shared shapes travel as data, never as an
  imported runtime (consistent with the one-parts-model entry above, which this consumes rather than
  duplicates).
- Every surface that renders a stage renders with it that `fabricable` means the files are complete and
  self-consistent, not that the machine is safe to build, fly or wet; and every run result carries its medium id
  and engine fingerprints or is not displayed. No slice buys, builds or tests hardware, and none attempts
  free-surface hydrodynamics, added mass, cavitation, or aerodynamics inside the physics plant.

### Event-plan EXITS are not ring-fenced, only the entry is

`stepListed` in `src/app/trading-event-plans.ts` refuses to open a position in a ticker
`TRADING_CORE_SYMBOLS` fences, which is what stops a fenced name from ever entering an event
plan's book. The exits (`stepFilled`'s take-profit and stop, `stepExitsPlaced`'s time stop) are
deliberately NOT fenced: they close the quantity the plan's own entry bought, and withholding them
would strip a filled position of its protection — strictly worse than the exposure prevented. The
residual is narrow but real: a plan that reached `filled` BEFORE the operator added its ticker to
`TRADING_CORE_SYMBOLS` keeps running its exits against a name the fence now covers. The ADR-159
`unmanaged` mark does not apply to this module at all — its `EventBroker` interface is
`configured/getAccount/getOrder/cancelOrder` with no `getPositions`, so every quantity it sells
comes from `entry.filledQty`/`exits.qty`, which the engine's ledger accounts for by construction.

**Done when:** arming or fencing decides the question before a position exists — adding a symbol to
`TRADING_CORE_SYMBOLS` while a plan on it is `filled` or `exits_placed` either hands the position
to the operator explicitly (the plan closes and says the exits are now theirs to manage) or records
on the plan timeline that its exits continue under the pre-fence mandate, rather than the current
silence. A guard in the shape of the `ADR-159 sibling` block in
`tests/unit/trading-event-plans.spec.ts` drives a plan to `filled`, fences its ticker, ticks, and
asserts the chosen behaviour — proven red against today's code, which neither closes nor records.

**Assessed and deliberately left alone:** `trading-pinned-lots.ts` and `trading-dated-orders.ts`
ride the same `trading-events:<sub>` leg and place through the same `deps.place` seam, and neither
reads the `unmanaged` mark or `TRADING_CORE_SYMBOLS`. They are not the same defect shape: both
execute an order the OPERATOR authored (a protected lot is the operator's own buy with its own exit
rules, explicitly subtracted from the autopilot's view by ADR-138 D3; a dated order is an operator
decision minted now and placed at a time they chose). ADR-159 withholds where the engine trades a
position it did not buy, not where the operator instructed a specific order.
