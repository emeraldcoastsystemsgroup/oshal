# Real-boundary regression audit

This audit applies the integration-boundary corollary in `CLAUDE.md`: a test double may isolate
logic outside the defect, but closure evidence must execute the database, resolver, image, file, or
protocol seam that actually failed. “Real” here does not always mean a paid external account; a
real local HTTP server or Node resolver is sufficient for protocol/wiring claims. A production
provider claim still needs a separate live acceptance run.

## Dispositions

| Boundary audited | Mock/stub disposition | Required real companion | Status |
|---|---|---|---|
| Ticket-store writes under RLS | Unit router/gateway doubles stay for transition and error-branch coverage; they cannot prove PostgreSQL accepts or owns a row. | `tests/alert-intake-rls-live.spec.ts` and `tests/connector-webhook-rls-live.spec.ts` drive the real routers, `PostgresTicketStore`, GUC wrapper, NOBYPASSRLS role, policies, and rows. Both are mandatory in `tests/e2e-green-suite.txt`. | Real companion present. |
| Installed-package `@/` resolution | Route fixtures without framework imports stay for mount ordering/auth behavior; they no longer stand as alias evidence. | `tests/unit/manifest-route-mounter.spec.ts` registers the production `tsconfig-paths` hook and uses Node `createRequire` from an external temporary package to load a real module through `@/`. | Real companion present. |
| Package-facing build artifacts | Source/barrel checks remain useful but cannot prove the shipped image contains a module. | `scripts/check-kernel-skills.ts --image` inspects the built container; `tests/unit/kernel-uses-declaration.spec.ts` removes exact artifacts from a complete build fixture and requires the real gate to fail. | Real companion present. |
| Provider and connector gateways | Mocked fetch/provider specs are retained only for deterministic request shaping, status mapping, and retry branches. They may not close a “live provider works” outcome. | Local protocol-server tests close transport/wiring defects. Items explicitly requiring production OAuth, billing, hardware, or deployed-provider behavior remain in `docs/BACKLOG.md` until dated live evidence exists. | Explicitly separated; live outcomes remain queued. |
| `tests/unit/notify-channel-tier.spec.ts` (Notifications per-channel account tier) | Scoped doubles OUTSIDE the boundary: the pool answers the two existing connection probes (`gmailReady`, `twilioReady` - their SQL is unchanged and not what this claims), the fixed per-user Twilio operation is a recorder, and the Twilio vendor API is a fetch capture. | REAL: the `/api/notify` router over loopback HTTP, each sender's own `tier()` and the `available()`/`send()` branch that follows it (a reported `own` SMS reaches the per-user operation, a reported `deployment` SMS leaves from the deployment's number), and the page's shipped inline script executing under a minimal DOM with its fetch answered by that same route. Red on all 9 cases against unmodified main; mutation-checked by bare labels, a fixed label and a send branch decoupled from its tier. Not evidence that a real Twilio or Gmail account delivers. | Green 2026-09-15 |
| Demo-gated operator-key LLM lane | `tests/unit/operator-key-lane.spec.ts` stubs the vendor HTTP probe and the connections store. The defective boundary was the RESOLVER (`resolveUserLlmConnection` returning nothing for an operator, and the demo gate deciding whether a host key may be lent at all) — that seam runs for real in the spec, including the env switch, lane order, verdict cache, and non-operator refusal; the mutation check for the gate is documented in the header. | A live vendor completion on the lane the deployment actually runs (dated probe of the configured lane from inside the container) — the mocked fetch cannot prove a real key answers. | Real resolver covered; live-key acceptance is per-deployment and dated in the deploy record. |
| Durable swarm-memory provenance ledger | Pool-less service/route doubles cover normalization and HTTP decisions but cannot prove migration 117 permits the intended owner flow or blocks a second owner. | A real/wrapped-Pool test must exercise two owners plus operator promotion against migration 117 after its RLS policy is corrected. | Open SEC-05 blocker; this audit item cannot close before that test lands. |
| Dev-mode live-apply path confinement | Docker `restart` and the api's manifest-reload HTTP call are doubled in `tests/unit/live-apply-confinement.spec.ts` — they are effects OUTSIDE the boundary under test and are asserted on call shape only. | The defective boundary is the FILESYSTEM (a write escaping the checkout), so it runs for real: a temp repo, real `fs` writes, and a real directory symlink/Windows junction proving a lexically-confined path still resolves outside. Mutation-checked by removing the ancestor-realpath call — the junction case goes red. | Real boundary covered; container restart / manifest reload remain doubled and are exercised live by the dev-node itself. |
| Dev-mode promote (`scripts/oshal-deploy.sh`) | `tests/unit/deploy-promoter.spec.ts` injects the process spawner: a real run rebuilds an image and recreates ~34 containers and cannot live in a unit suite. | The exit-code CONTRACT is the defective boundary and runs for real as a pure function over 0/1/2/3/null/unknown; the script's own end of that contract stays pinned structurally by `tests/unit/deploy-rollback-outcome.spec.ts` (including a real `bash -n` parse). A live promote is dated in the deploy record. | Contract covered both sides; live promote is per-deployment and dated. |
| Hugging Face Inference Providers lane | `tests/unit/huggingface-lane.spec.ts` stubs the vendor HTTP probe (a canned 200 completion). The boundaries under test are the two lane TABLES (free-tier catalog and OpenAI-compatible operator lanes) and the operator-key RESOLVER, which run for real: one shared router base URL, `:cheapest` policy on every candidate, last-in-order placement, HF_TOKEN / HUGGINGFACE_API_KEY acceptance, and the probe URL + bearer header the resolver emits. | `scripts/evidence/prove-free-tier-live.ts` with `HF_TOKEN` set makes a real completion against `router.huggingface.co/v1` — the stub cannot prove a real token answers or that the `:cheapest` model ids are still served. No HF token was present on the operator box on 2026-09-04, so the live companion has not run yet. | Real tables + resolver covered; live-key acceptance pending an operator token, dated when run. |
| Kalshi live-order gate passthrough (compose → api env) | `tests/unit/compose-kalshi-live-gate.spec.ts` reads the compose file as TEXT: it pins the `x-bot-env` passthrough line, its `false` default, the api service inheriting the anchor, and the code-side `process.env.KALSHI_LIVE_ENABLED === 'true'` read. It cannot prove the interpolated container environment. | `docker compose -f docker-compose.oshal-local.yml config` must list `KALSHI_LIVE_ENABLED` under the api service (run 2026-09-04 at merge: resolved to `"false"` on every `*bot-env` service), and `docker exec oshal-local-api env | grep KALSHI_LIVE_ENABLED` after the next api recreate. | Static text + `compose config` covered; the in-container env probe is due at the next `oshal-deploy.sh` and dated in COLLABORATE.md when run. |
| `tests/unit/trading-settlement.spec.ts` (ADR-134 D8 cash settlement) | The VENUE is doubled at the engine's `getBrokerAdapter` seam — no Schwab call is made from a spec | REAL: the live Postgres (books/accounts join, the orders ledger, the `settlement_policy` CHECK) and the engine order path itself — both refusals are driven through `placeDecisionOrder` for an operator buy and an autonomous buy | Green 2026-09-06 |
| `tests/unit/trading-dispatch-golden-plan.spec.ts` (autopilot decomposition) | Scoped doubles OUTSIDE the boundary: the broker adapter, market data, the multi-timeframe scan, order placement and ticket creation are recorders/fixtures | REAL: the Postgres trading stores under the spec role — books, signals, decisions and orders through the real FK chain, plus peaks, daily equity, equity high-water mark, rotation state, pinned lots and config overrides. The claim is that the ordered dispatch plan and its persisted provenance rows are byte-identical across the split; it is not closure evidence for the venue or market-data boundaries | Green 2026-09-06 |
| `tests/unit/trading-watchdog-books.spec.ts` (ADR-134 D3.7 per-book beats) | None for the decision logic — the PowerShell functions are dot-sourced from the real script | REAL: `powershell.exe` 5.1 executing the shipped functions, the live Redis schedule store (seeded active/paused legs, cleaned up), the live Postgres roster read, and the cutover gate executed under `bash` with stubbed `docker`/`schtasks` for each refuse branch | Green 2026-09-06 |
| `tests/unit/trading-book-report-scripts.spec.ts` (ADR-134 D2 #7 per-book reports) | None for the SQL — it is the shipped module's own text | REAL: the live Postgres as the enforcing `oshal_app` role (self-validated: `current_user`, not superuser, not RLS-bypassing) with and without the operator GUC, plus real CLI runs of all three report scripts over seeded two-live-book data | Green 2026-09-06 |
| `tests/unit/trading-watchdog-checks.spec.ts` (ADR-134 D3.7 watchdog checks) | Scoped doubles: the Log/Raise sinks, and a stubbed exec wrapper in the core-hold case | REAL: the shipped PowerShell parsed and executed by `powershell.exe`, a real never-answering HTTP server for the wedge/deadline cases, and the pure check module itself — every threshold, alert key and message is mutation-proven | Green 2026-09-07 |
| `tests/unit/world-series-read-gate.spec.ts` (the market-hours pulse saturating the world series store) | Scoped double: the pg client. It records how many series reads it is asked to answer at once and returns canned rows; it says nothing about PostgreSQL's own behaviour under that load | REAL: the service's own `rollupFeatures`, its real statement text and the real process-wide gate — the measured quantity is the number of concurrent statements the pulse ISSUES, which is the quantity that saturated the store. Proven red before green by bypassing the gate (max in-flight 12 against a bound of 3; four sentiment statements for two answers). The read-cost half is separately evidenced by read-only `EXPLAIN (ANALYZE)` on the live `oshal_ts`: 786 ms planning + 366 ms execution on the stream vs 245 + 16 on the daily head | Statement-issuing boundary covered; the live companion is the pulse's own `seriesStatements`/`elapsedMs` record on the box after deploy, still to be taken |
| `tests/unit/multipart-request-identity-postgres.spec.ts` (multipart uploads losing the RLS request identity) | Scoped doubles OUTSIDE the boundary: the sign-in rail, and the domain service each post-upload handler calls (RAG ingest, the knowledge-memory record, the swarm-app loader, the ambient receipt store and diarization orchestrator, the agent-profile repository). Each double performs the handler's owner-scoped write as a real INSERT through the real GUC pool | REAL: loopback HTTP with the body streamed in 64 KB chunks with gaps, the four production routers and their multer parsers, the server.ts identity-middleware shape, the production GUC pool, and PostgreSQL FORCE RLS (the live owner-or-operator policy) evaluated for `oshal_app` in a throwaway database the spec creates and drops (self-validated: `current_user`, not superuser, not RLS-bypassing, and an identity-less write is refused). Red on all four routes before the fix and when the helper's re-bind is removed. Not evidence that each domain table's own policy is correct | Green 2026-09-14 |
| `tests/unit/trading-settlement-autopilot-clamp.spec.ts` (ADR-134 D8 tail — the autopilot's settled-cash clamp) | Scoped doubles OUTSIDE the boundary: the venue adapter's `getAccount` (it answers the post-sell snapshot with the venue's own `accountType`/`settledCash`/`unsettledCash`; the Schwab adapter's mapping of those fields is not what this claims), market data, the `placeDecisionOrder` recorder, and a pool that answers the provenance INSERTs | REAL: `rotateSleeve` end to end (drop-out sell, settle wait, post-sell re-read, buy sizing), `capAccount` with the capital cap, and `settledBuyingPower`/`buildSettlementView`/`clampToSettled`. Red on 3 of 6 cases against unmodified main (the cash-book rotation funded both leaders from unsettled proceeds); red on 2 of 6 with the clamp placed before the cap. Not evidence that the Schwab venue reports those figures, nor of the engine's own refusal (that is `trading-settlement.spec.ts`) | Green 2026-09-15 |
| `tests/unit/bot-status-toggle-substrate.spec.ts` (the cockpit enable/disable toggle was compose-only) | Scoped doubles OUTSIDE the boundary: `node:child_process` — a real `docker compose stop` inside a unit run would stop a live container, so the command TEXT is what is asserted — `https.request`, so the Kubernetes API call is captured rather than sent, and an in-memory `agents` table underneath the real repository. | REAL: loopback HTTP, the shipped `/api/agents` router with its operator gate, `AgentStatusController`, `AgentProfileRepository`, `resolveBotRuntimeLauncher` and both launchers, and the dispatcher's own `normalizeCandidates` reading the row the toggle wrote. The live companion for the cluster seam is [`scripts/validate-dynamic-bot-manifest.mjs`](../../scripts/validate-dynamic-bot-manifest.mjs), which now also asks a reachable API server whether `deployments/scale` exists and accepts PATCH. Red on 7 of 7 against unmodified main; mutation-checked by rebuilding the compose pair inside the route (the in-pod toggle then issues one docker command) and by keying the toggle on the agent UUID (both compose cases go red). Not evidence that a real cluster scales the Deployment. | Green 2026-09-15; the live `deployments/scale` discovery check is due on the next reachable cluster |
| `tests/unit/oshal-app-build-staging.spec.ts` (a package build leaving sources in the kernel's `src/app/routes/`) | Scoped double OUTSIDE the boundary: the TypeScript compiler, in the two cases that need it stopped at a chosen moment — a stand-in `node_modules/typescript/bin/tsc` that records what was staged and blocks (the kill case) or exits non-zero (the failure case). What it compiles is not the claim. | REAL: the shipped `scripts/oshal-app.js build` against a real throwaway framework checkout on the real filesystem, killed with its whole process tree (`taskkill /T /F`), with every file under `src/app` sha256-hashed before and after; the success case runs the INSTALLED TypeScript compiler through the same path and proves the emit still carries `@/` from the new staging depth; and the killed run's survivor is handed to the real `scripts/check-repo-separation.js`, which refuses it. Red on 2 of 4 against unmodified main, whose failure output names `framework\src\app\routes\sports-routes.ts` as the destination it copied to. Not evidence about the store repo's own `rebuild-store-routes.mjs`. | Green 2026-09-16 |
| `tests/unit/send-message-budget-gate.spec.ts` (the INLINE half of `/api/send-message` cleared no admission gate - ADR-161) | Scoped doubles OUTSIDE the boundary: the pg driver, as a fake pool answering `BudgetService`'s own three statements (this box has no disposable Postgres and the live one is off limits), the ticket-context resolver, and the ADR-127 hosted-brain ladder's `resolveUserLlmConnection`, which serves one lane so a budget block cannot be confused with a missing brain. What PostgreSQL does with those statements is not the claim. | REAL: loopback HTTP, the shipped `createMessageRoutes` router and its whole inline branch, the real swarm bot registry (the controller-inline agent is FOUND in it, not hand-typed, so a bot changing container surfaces here), `assertBotInvocationAdmissible`, and the real `BudgetService` - its scope matching, spend comparison, hard/soft decision and fail-open semantics. The boundary that failed is route -> admission -> governance, and all of it runs. Red on 1 of 3 against the unmodified branch (an over-cap inline turn answered 200 and reached the orchestrator); the two allow/fail-open cases were green before and after, which is what pins the gate as a gate. Not evidence that `oshal_budgets`/`oshal_cost_events` are shaped as assumed - and explicitly NOT evidence that inline spend reaches the ledger those caps read (no inline path writes `oshal_cost_events`; that gap is its own BACKLOG entry). | Green 2026-09-16 |

## Configurable Home (2026-09-09)

`tests/unit/app-home-customization.spec.ts` uses a recording pool only for HTTP input/owner binding and failure branches. Its real companion is the store's `identity/tests/home-summary.integration.cjs`: actual PostgreSQL with the canonical owner-RLS policy and a non-superuser role, the production GUC wrapper and preference queries, the compiled Identity extractor and real accessible-connections helper, plus Chromium on the actual Home module/CSS. Mock authentication and seeded source records remain intentional boundaries; this is not live-provider acceptance. The harness rejects nonlocal/non-test database names and removes only its generated schema/role. Passed for owner isolation, stale revisions, shared-account scope, renewable expiry, unavailable-source failures, keyboard editing and desktop/mobile rendering.

## Core/store compatibility gate (2026-09-10)

`tests/unit/store-compatibility.spec.ts` uses real disposable Git repositories, the shipped store
compiler and the installed TypeScript compiler; none of those boundaries are mocked. It proves
committed-only selection despite dirty/untracked source, TS2305 rejection of a consumer whose
ambient stub invents a core export, dependency-lock mismatch refusal, normal cleanup, and source
repository preservation when the compiler process tree is forcibly interrupted.

The full exported pair `9655afde416e09058562cba0b965521bff1a0550` (core) and
`f5db2153a25d8ebd18709dec10a03b130dac559c` (applications) passed on 2026-09-10:
386 sources across 52 packages, followed by a failing real TS2305 compile naming
`compatibility-negative-probe/probe.ts` and `inventedCompatibilityExport`. These are dated
compiler-produced counts, not an inventory constant. The first acceptance run explicitly reused
manifest/lock-matching provisioned dependencies. A second full run installed fresh dependencies
with `npm ci` from the pinned core lockfile and passed with the same counts; both exports cleaned
successfully. Per-run logs and the two SHAs are retained by
[`check-store-compatibility.mjs`](../../scripts/check-store-compatibility.mjs); invocation and
scope are documented in [the local CI runbook](../runbooks/local-ci.md#corestore-compatibility-release-check).
This attests to source compatibility, not legacy JavaScript behavior or emitted-output parity.

## Shared artifact picker (2026-09-10)

`tests/unit/artifact-picker.spec.ts` runs the actual framework artifact/file routers, local
owner-hashed storage directories, short-lived handles, loopback byte redemption and Chromium on
the shipped Portrait Studio surface and shared picker. It also loads the real Portrait Studio
source route. Authentication and the portrait SQL store are explicit fixtures; this does not
claim PostgreSQL/RLS or external connector acceptance. No compiler, filesystem, picker or handle
redemption implementation is replaced.

The local proof passes for registered/visible source discovery, removal on unregister, MIME
filtering, invalid navigation, owner-only listings, foreign-handle refusal, byte-identical file
redemption, folder/back navigation, zero mints on cancellation, rejection of external source URLs,
late-response cancellation, and selecting both a local file and a gallery image into the actual
crop stage. No generation or publication is triggered. Mobile width and light/dark theme changes
pass. The related artifact/auth suites pass together (34 tests); Portrait Studio's standalone
camera proof passes 23 checks. Run locally with `node node_modules/vitest/vitest.mjs run
tests/unit/artifact-picker.spec.ts`; set `OSHAL_STORE_REPO` when the repositories are not siblings.
The deployed signed-in acceptance remains in BACKLOG until the protected core change lands.

## Jarvis YAML routing and artifact handoff (2026-09-10)

`tests/unit/jarvis-tool-catalog.spec.ts` loads the shipped YAML and mutates invalid metadata and
role grants. `tests/unit/jarvis-artifact-routing.spec.ts` exercises actual registry and owner-bound
handle selection, post-model expiry/visibility checks, and the real Jarvis ask/result HTTP path.
Its model and persistence are explicit fixtures; no live deployment database is used.

`tests/unit/artifact-dispatch-browser.spec.ts` runs Chromium with the shipped dispatcher and Jarvis
surface, actual artifact HTTP routes and registry, and explicit authentication/model-result/source
fixtures. It checks same-ref dispatch, confirmation refusal, foreign handles, removed destinations,
and stale selection. This does not prove deployed model disambiguation. Keep ADR-139 Stage 4b open
until a signed-in live model handoff and ambiguous-target refusal are recorded after deployment.

## Swarm administration route chain (2026-09-14)

`tests/unit/swarm-admin-route-chain-authorization.spec.ts` closes the ADR-148 open thread "no
route-chain guard for the 403 path". The boundary that had no coverage is the CHAIN, not any one
function: the shipped guards proved the role store and `isOperatorIdentity` separately, and the
signed-in non-operator 403 existed only as a hand check on a box. The spec runs the whole chain for
real — the deployment auth set from `createApplicationAuthMiddlewareSet` in its LOCAL_AUTH shape, a
session cookie minted by the real `POST /api/local-auth/login`, that set's own `requiresAuth`,
`requiresOperator`, `isOperatorIdentity`, the privileged-identity snapshot, a real `swarm_roles`
table in a disposable PostgreSQL container, and the shipped `/api/swarm/roles` and
`/api/swarm/registries` routers. Both break-glass allowlists are stubbed empty, so a row is the
only path to operator; the same account is asserted 403 before the grant, 200 after it, and 403
again after the revoke.

The ONE scoped double is `SwarmAppService.loadApp`, injected into the registry router. It is
outside the boundary (it installs a package) and throws if anything calls it, so no assertion can
reach it. Its real companions are `tests/unit/multi-store-installer.spec.ts` and
`tests/unit/app-dependencies-loader-browser.spec.ts`.

Every outcome is asserted on the RESPONSE BODY, never the status alone: on a live box every
unauthenticated `/api/*` path answers an identical 401, including paths that do not exist, so a
status-only assertion proves the global guard and not the mount. Mutation-proven both ways on
2026-09-14 — making `requiresOperator` always call `next()` turned 3 of 4 red (the non-operator
case first, "expected 200 to be 403"), and dropping the `swarm_roles` snapshot consult from
`isOperatorIdentity` turned 2 of 4 red ("expected 403 to be 200") while leaving the anonymous and
non-operator refusals green. This is not evidence for RLS: `swarm_roles` deliberately has no row
policy — the route is the gate — and the spec asserts exactly that gate.

## Authorization readiness handed to downstream consumers (2026-09-15)

`tests/unit/authorization-readiness-consumers.spec.ts` closes the gap left by
`tests/unit/authorization-schema-recovery.spec.ts`: the bootstrap thunk recovers, but the readiness
the wiring RETURNS was derived from it once, so a first-attempt failure was inherited permanently
by everything chaining off it - including the queued-principal capture that
`TicketService.createTicket` performs on every authenticated ticket.

The defective boundary is a pool acquire lost under real contention, and it runs for real: a
disposable `postgres:16-alpine` container, a genuine `pg` Pool with `max: 1` and a 500 ms acquire
timeout whose only client the test holds, the production GUC wrapper, and the real locked-DDL
bootstraps. The failure is a real `timeout exceeded when trying to connect` raised out of
`applyLockedSchema`, not an injected error, and recovery is asserted by reading the tables the
retry had to create and the `oshal_queued_application_principals` row the retry had to insert.

The scoped doubles are all OUTSIDE that boundary: the tool catalog and dynamic executor registry
(recorded call counts, so "the tools registered on the retry" is an assertion rather than a mock
return), the `SwarmAppService`/`AppAccessService` ports, and the ticket row store. The ticket store
is doubled deliberately - ticket persistence is not what fails here, and substituting it is what
makes the case assert on the capture that follows the insert. Its real companions are the
ticket-store RLS entries at the top of this table. Red-proven on `1f0978a0`: both cases fail with
`timeout exceeded when trying to connect`, the first raised out of `createTicket`.

The last consumer left permanently dead by that first attempt was local Test Lab schedule POLLING:
schedule reads recovered per operation, but the poll timer was started inside the boot attempt's
`.then()`, so one lost acquire stopped scheduling until the process restarted. The two polling cases
in `tests/unit/test-lab-schedule-wiring.spec.ts` close it. They inject the failure at the real seam -
the readiness the controller hands the wiring - with the same `timeout exceeded when trying to
connect` PostgreSQL raises, and run the wiring, the schedule schema bootstrap with its advisory-lock
DDL, the store's claim transaction and the service's own poll timer for real, asserting the claim
SQL a later cycle issued. The pg pool is the one scoped double, because a real one cannot
fail-then-recover without a server; its real companion is the disposable-PostgreSQL file above.
Red-proven against the unmodified wiring: the recovery case fails with the readiness asked exactly
once, while the shutdown case passes on both sides.

Not covered: the user-directory and Jarvis-briefing routes are proven at their readiness seam only,
not driven over HTTP.

## Store persistence activation after a lost connection at boot (2026-09-15)

`tests/unit/store-persistence-recovery.spec.ts` covers the boundary that failed on the 00:25:11Z api
boot: the task store, the message store and the memory layer each lost a pool acquire inside the
api's own migration and provisioning burst, fell back to an in-memory Map, ended and nulled their
pools, and stayed non-persistent for the life of the process.

The boundary runs for real. A disposable `postgres:16-alpine` on an ephemeral loopback port; the
store's OWN private pool, built from the process environment by `createOptionalPostgresPool` exactly
as it is in production; a real connection shortage (a non-superuser role with `CONNECTION LIMIT 1`
whose one connection the test holds, so the store's connect is refused by PostgreSQL rather than by
an injected error); the production GUC wrapper; and the real idempotent DDL. Recovery is asserted by
reading the row back out of `chat_tasks` over a separate connection - a store that never recovered
leaves no table at all. A second case repeats it for the injected-pool family
(`PostgresSwarmEscalationStore` with a `max: 1` pool whose only client is held), and a third points
the store at a closed port to prove the degrade still lets the process serve.

The fixture role carries `BYPASSRLS`, which is the legacy single-role posture
`buildOwnerRlsPolicyStatements` documents itself as inert under. That is deliberate: it keeps the
case measuring the connection boundary instead of re-testing RLS, whose real companions are the
ticket-store and authorization RLS entries above.

`tests/unit/persistence-mode-readiness.spec.ts` is the scoped-double companion. Its
`createPersistenceActivation` cases substitute the `activate` callback and the pool, because the
variable there is the retry arithmetic (one shared in-flight attempt, a dropped failed attempt, the
cooldown) and the reporting surface (`/api/readiness` `persistence` leg), not the database. It is
NOT closure evidence for the database seam; the file above is.

## Rules for future fixes

1. Name the failed boundary in the test header and name what remains doubled.
2. Self-validate the fixture where bypass is possible: prove RLS is enforcing, the resolver loaded
   from outside the repo module, or the artifact probe turns red when the file is removed.
3. Put non-optional live/database guards in a required suite. Missing environment is a failure, not
   a skip, unless the outcome is explicitly retained as externally blocked in the active backlog.
4. When a scoped mock remains, link its real companion here. When the companion closes, move the
   completion narrative to durable evidence and remove the item from the active queue.
