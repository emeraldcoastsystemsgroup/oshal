# BUG-22 — the first kept run of the local CI gate, 2026-09-14 (spec-level failures)

Companion to [local-ci.md](./local-ci.md) ("BUG-22 — what is done, and how to continue", item 2) and
[BUG-22](../operations/bug-log.md#bug-22--the-nightly-gate-has-failed-46-consecutive-runs-emailed-every-time-and-nothing-changed).
This file is evidence only: every line below is backed by a line in the kept log or in one of the
two re-runs named in "Sources". It records no root cause and proposes nothing beyond what the
failing assertions themselves say.

## The run

- **Command:** `bash scripts/ci-local.sh --head --skip-image`. The `ci-local.log` header line:
  `LOCAL CI start (scheduled=0 head=1 skip-e2e=0 skip-image=1) node-source=HEAD archive-ref=HEAD sha=231b76f4f6d6 posture=interactive-head`.
- **Tree under test:** HEAD `231b76f4` of `feat/store-compatibility-gate`, exported to
  `%LOCALAPPDATA%\oshal\ci-src` (the lint finding and the security-policy `RUN` header both name
  that path). The export has no `.git` directory.
- **When:** 2026-09-13 23:58:40 to 2026-09-14 00:20:03 local (-0500), i.e. 04:58–05:20 UTC.
- **Skipped by the flag:** image build, image-smoke and trivy. No `GATE image-build`,
  `GATE image-smoke`, `GATE trivy` or skip-marker line appears between the start and outcome lines
  of this run in `ci-local.log`.
- **Host conditions (not idle):** 22 idle Claude Code sessions (~0.1–0.2 GB each) and VS Code
  open; host free RAM 0.4–1.3 GB of 16 GB; the Docker VM with all 45 stack containers up at
  load1 2–5 on 8 CPUs. e2e ran with `--workers=4 --retries=2` (`Running 532 tests using 4 workers`).
- **Outcome lines:** `=== LOCAL CI: FAILED gates: unit lint security-policy e2e-green ===` and
  `=== OSHAL LOCAL CI FAILED - no new failures; FIXED: store-compatibility trivy (night 51) ===`.
  `store-compatibility` did pass (43 s). `trivy` did not run in this invocation; its appearance
  under `FIXED` is the streak comparison's reading of a gate absent from this run against the
  previous night's failing set (`2026-09-13 ... FAILED gates: store-compatibility unit lint
  security-policy e2e-green trivy`).
- **Kept output:** `%LOCALAPPDATA%\oshal\ci-runs\ci-head-skipimage-20260913-2358.out.log`
  (70,156 lines). Per-gate lines: `%LOCALAPPDATA%\oshal\ci-local.log`.

### Gate table (durations from `ci-local.log`)

| Gate | Result | Duration |
|---|---|---|
| head-src | PASS | 43 s |
| typecheck | PASS | 34 s |
| store-compatibility | PASS | 43 s |
| unit | **FAIL** | 496 s |
| lint | **FAIL** | 35 s |
| connectors | PASS | 2 s |
| manifests | PASS | 5 s |
| kernel-skills | PASS | 18 s |
| workflow-triggers | PASS | 0 s |
| security-policy | **FAIL** | 10 s |
| repo-separation | PASS | 0 s |
| worktree-strays | PASS | 1 s |
| secret-scan | PASS | 74 s |
| local-secret-hygiene | PASS | 0 s |
| unpushed-commits | PASS | 7 s |
| e2e-green | **FAIL** | 514 s |
| image-build, image-smoke, trivy | not run (`--skip-image`) | — |

## What the kept log does and does not contain

- `test:unit` is `vitest run` (`package.json`). In the kept log the unit gate printed one `❯ <file>
  (N tests …)` line per failed file (45 of them; 27 with a `| M failed` count) and one
  `× <title> <ms>` line per failed test — and nothing else: no `Failed Tests` block, no assertion
  message, no stack. The summary line `Errors 1 error` has no accompanying detail anywhere in the
  unit section.
- The security-policy gate (also vitest) printed the same shape: titles only.
- The e2e section (`--reporter=line`) carries one numbered failure block per failed test with the
  error message, and a `(retry #n)` progress line per retried attempt.

### Sources of the error lines below

| Tag | What | When | Where |
|---|---|---|---|
| **[G]** | the gate run itself | 00:00:41–00:08:57 -0500 | `ci-src` export; titles + durations only |
| **[P]** | a re-run of the three security-policy spec files with a detail reporter | `Start at 00:11:15` -0500 | `RUN v4.1.9 C:/Projects/oshal` (the working checkout, not the export); `Test Files 3 failed (3)`, `Tests 5 failed / 41 passed (46)`, 33.15 s |
| **[X]** | a re-run of 15 failing unit files that need no Docker, browser or database, one file at a time | `Start at 00:26:22` -0500 (05:26 UTC), Docker VM load1 4.01 | `cd %LOCALAPPDATA%\oshal\ci-src && OSHAL_STORE_REPO=C:/Projects/oshal-applications npx vitest run --no-file-parallelism --reporter=default <15 files>`; `Test Files 13 failed / 2 passed (15)`, `Tests 27 failed / 195 passed / 9 skipped (231)`, 19.09 s |

Files not re-run (browser, Docker image, or database specs) are marked **detail not in the log**.

## unit — 45 failed files / 49 failed tests / 8785 passed / 47 skipped / 1 runner error

`Test Files 45 failed | 846 passed | 2 skipped (893)` · `Tests 49 failed | 8785 passed | 47 skipped (8881)`
· `Errors 1 error` · `Duration 491.23s (transform 41.33s, setup 0ms, import 596.55s, tests 2506.62s)`.
The log has 45 `❯` lines. 27 carry a `| M failed` count and account for the 49 `×` lines. The
other 18 are listed as failed files with **no failed-test count and no other line** in the log:
14 `*-browser.spec.ts` files (`workspace-theme-browser (20 tests) 46388ms`,
`workspace-navigation-browser (44 tests) 71607ms`, `authorization-admin-browser (39 tests)
70204ms`, `workspace-navigation-contextual-browser (15 tests) 33836ms`, `jarvis-dashboard-browser
(19 tests) 32106ms`, `app-home-browser (14 tests) 51550ms`, `onboarding-provisioning-browser (8
tests) 34013ms`, `jarvis-briefing-browser (4 tests) 23699ms`, `data-model-explorer-browser (6
tests) 16904ms`, `jarvis-legacy-thread-browser (2 tests) 23125ms`, `workspace-chat-theme-browser (8
tests) 26002ms`, `core-surface-theme-browser (110 tests) 55956ms`, `test-lab-run-browser (4 tests)
80155ms`, `package-test-catalog-browser (1 test) 31132ms`), two `(0 test)` files
(`takeout-package-registration`, `node-window-controls`), and two all-skipped files
(`trading-book-report-scripts (13 tests | 13 skipped) 1720ms`,
`test-lab-installed-package-batch-follow (1 test | 1 skipped) 78825ms`). Those 18 are outside the
classification below — the log gives nothing to classify.

### Bucket counts (49 tests, by the first error line)

| Bucket | Tests | Files |
|---|---|---|
| assertion (`AssertionError` / `expect` / expected-HTTP-status) | 27 | 14 |
| environment (`git ls-files` failed in the `.git`-less export; missing DB table) | 3 | 2 |
| runtime `TypeError` | 2 | 1 |
| gate detail not in the log; **passed** on re-run [X] | 2 | 2 |
| detail not in the log; not re-run (browser / image / database) | 15 | 9 |
| timeout (vitest hook/test timeout) — no error line in any source says so | 0 | 0 |
| declined by its own guard (load/memory gate) — no error line in any source says so | 0 | 0 |

One recorded unit duration exceeds 30 s: `does not restore a late Users roster preview after refresh
discards it 30307ms` (`principal-registration.spec.ts`). That is a duration, not an error line.

### Per file — bucket and first error line (trimmed to ~120 chars)

| Spec file | Failed | Bucket | First error line | Src |
|---|---|---|---|---|
| `tests/unit/app-store-remote.spec.ts` | 9 | assertion | `resolves the built-in default…`: `AssertionError: expected null to be 'https://raw.githubusercontent.com/eme…'` · `actually FETCHES…`: `expected "vi.fn()" to be called at least once` · `reports available:false…`: `expected 'store repo is not a GitHub https URL:…' to match /OSHAL_STORE_TOKEN/` · `serves the parsed catalog…`: `expected false to be true` · `404s a name…`: `expected { ok: false, status: 503, …(1) } to match object { ok: false, status: 404 }` · the three `409s…` cases: `expected { ok: false, status: 503, …(1) } to match object { ok: false, status: 409 }` · `runs the installer…`: `expected { ok: false, status: 503, …(1) } to match object { ok: true, name: 'hello-oshal' }` | [X] |
| `tests/unit/site-product-pages.spec.ts` | 4 | environment ×2, TypeError ×2 | `every referenced screenshot…`: `Error: Command failed: git ls-files -- site/oswarm.ai/assets` · `has every generated page TRACKED…`: `Error: Command failed: git ls-files -- site/oswarm.ai` · `the catalog orb…`: `TypeError: Cannot read properties of undefined (reading 'length')` (`:196`) · `maps every subdomain key…`: `TypeError: Cannot read properties of undefined (reading 'map')` (`:315`) | [X] |
| `tests/unit/publish-gate.spec.ts` | 4 | detail not in the log | `ignores artifacts/remote-control/samsara-form.png 51ms`, `…/some-future-pipeline/nested/deep/capture.jpg 31ms`, `…/remote-control/alt-f4.ps1 28ms`, `…/whatever/notes.txt 26ms`; file 13783 ms; not re-run | [G] |
| `tests/unit/artifact-dispatch-browser.spec.ts` | 3 | detail not in the log | `opens email compose without sending and never retries a 428 with confirmation 5013ms`, `refuses foreign handles and deactivated destinations before any write 693ms`, `ships the picker selection through the actual Jarvis form and does not replay it on reload 511ms`; file 37944 ms; browser, not re-run | [G] |
| `tests/unit/invite-reconnect-message.spec.ts` | 3 | assertion | `a DEAD grant…`: `AssertionError: expected 500 to be 201` (`:102`) · `NO connection at all…`: `expected 500 to be 201` (`:115`) · `the two failure messages are DISTINCT…`: `expected undefined to be truthy` (`:128`) | [X] |
| `tests/unit/machine-write-identity.spec.ts` | 3 | assertion | `stale-entry guard`: `AssertionError: artifact-exchange-core: src/app/routes/artifact-exchange-routes.ts no longer authenticates a machine caller — remove the entry: expected false to be true` · `jarvis-service-callers…`: `AssertionError: jarvis-service-callers: the driver produced no owner-scoped write to observe: expected 0 to be greater than 0` · `local-auth…`: `Error: local-auth bootstrap identity probe: expected HTTP 201, received 403: {"error":"installer setup requires the original browser origin"}` | [P] |
| `tests/unit/schema-lock-privilege-tolerance.spec.ts` | 2 | detail not in the log | `confirms the two roles really are owner and non-owner 170ms`, `applies what the app role CAN run and reports only what it cannot 101ms`; database, not re-run | [G] |
| `tests/unit/static-surface-glass.spec.ts` | 2 | assertion | `loads the shared surface-glass stylesheet…`: `AssertionError: src\pages\data-model\index.html: expected '<!--\n  CHANGE LOG…' to contain '/shared/ui/css/surface-glass.css'` · `loads surface-glass after local page styles…`: `src\pages\data-model\index.html: expected -1 to be greater than 1142` | [X] |
| `tests/unit/any-bot-runtime-containment.spec.ts` | 1 | passed on re-run | gate: `fences malicious tool output before the next model request 61ms`; re-run: `✓ (10 tests) 29ms` | [G][X] |
| `tests/unit/cockpit-startup-browser.spec.ts` | 1 | detail not in the log | `boots the complete shell when external scripts stall 5132ms`; file 25121 ms; browser, not re-run | [G] |
| `tests/unit/controller-runtime-boundary.spec.ts` | 1 | assertion | `AssertionError: expected { …(8) } to deeply equal { …(8) }` — the diff adds `src/app/composition/manifest-bot-runtime-defaults.ts` to the importers of `src/app/composition/provider-runtime.ts` (`:209`) | [X] |
| `tests/unit/internal-tool-bridge-authz.spec.ts` | 1 | assertion | `a granted tool passes the gate…`: `AssertionError: expected 4 to be 3` (`:183`) | [X] |
| `tests/unit/jarvis-artifact-routing.spec.ts` | 1 | assertion | `loads YAML and destination metadata…`: `AssertionError: expected 404 to be 202` (`:179`) | [X] |
| `tests/unit/jarvis-briefing-preferences.spec.ts` | 1 | detail not in the log | `keeps a source retracted when an earlier activation commits during retirement 1276ms`; file 25152 ms; not re-run | [G] |
| `tests/unit/jarvis-catalog-block.spec.ts` | 1 | assertion | `the live turn assembly actually injects the block…`: `AssertionError: expected 7 to be less than -1` (`:93`) | [X] |
| `tests/unit/jarvis-provider-intent-routing.spec.ts` | 1 | assertion | `dispatches weather and priority inbox reads…`: `AssertionError: expected 404 to be 202` (`:279`) | [X] |
| `tests/unit/migration-transactionality.spec.ts` | 1 | assertion | `AssertionError: New self-wrapping migrations must declare "-- oshal:no-transaction" instead of relying on auto-detection: 127-application-authorization.sql, 129-verified-principal-directory.sql, 130-jarvis-briefing-preferences.sql, 131-authorization-audit-indexes.sql, 132-application-remote-executions.sql, 133-queued-application-principals.sql, 134-principal-registrations.sql, 135-external-tenant-memberships.sql, 136-test-lab-runs.sql, 137-test-lab-local-schedules.sql` | [P] |
| `tests/unit/multi-store-routes-browser.spec.ts` | 1 | detail not in the log | `closes the legacy install-remote bypass with409 9ms`; file 8160 ms; browser, not re-run | [G] |
| `tests/unit/package-test-runner.spec.ts` | 1 | detail not in the log | `withholds real completed output when a later authority read never resolves 11079ms`; file 79904 ms; not re-run | [G] |
| `tests/unit/package-test-sandbox.spec.ts` | 1 | detail not in the log | `verifies the browser profile on the real image and runs a Node-harness Playwright recipe against loopback with no network 18980ms`; file 80698 ms; image, not re-run | [G] |
| `tests/unit/principal-registration.spec.ts` | 1 | detail not in the log | `does not restore a late Users roster preview after refresh discards it 30307ms`; file 52702 ms; not re-run | [G] |
| `tests/unit/route-audit.spec.ts` | 1 | assertion | `AssertionError: the Security Center would show these as standing HIGH findings — reconcile PUBLIC_BY_DESIGN or guard the mount: expected [ …(3) ] to deeply equal []` — `route_auth:/api/authorization/tenant-memberships (src/app/server.ts:1190)`, `route_auth:/api/authorization (src/app/server.ts:1191)`, `route_auth:/api/user-directory (src/app/server.ts:1192)` | [X] |
| `tests/unit/route-schema-validate-only.spec.ts` | 1 | environment | `Error: trading accounts schema is not ready for the runtime DB role: missing oshal_trading_accounts table. Run migrations/schema bootstrap as the owner role before starting with OSHAL_SCHEMA_BOOTSTRAP=validate-only.` (`:311`) | [X] |
| `tests/unit/server-route-auth-inventory.spec.ts` | 1 | assertion | `AssertionError: expected [ …(3) ] to deeply equal []` — the three messages are quoted verbatim under "security-policy" below | [P] |
| `tests/unit/surface-glass-assets.spec.ts` | 1 | assertion | `AssertionError: expected [ 'src/pages/data-model/index.html' ] to deeply equal []` (`:33`) | [X] |
| `tests/unit/surface-theming.spec.ts` | 1 | assertion | `AssertionError: derive these from framework tokens instead: data-model.css: #0f1420 #171e2e #131a28 #e6ebf5 #97a3b8: expected [ Array(1) ] to deeply equal []` (`:99`) | [X] |
| `tests/unit/trading-schwab-account-binding.spec.ts` | 1 | passed on re-run | gate: `no source file reads process.env.SCHWAB_ACCOUNT_NUMBER 5512ms`; re-run: `✓ (16 tests) 1995ms` | [G][X] |

## e2e-green — 59 failed / 2 skipped / 3 did not run / 468 passed (8.2 min)

`[e2e-green] running 71 curated-green e2e spec files (args: --retries=2 --workers=4 --reporter=line)`
· `Running 532 tests using 4 workers` · `59 failed`, `2 skipped`, `3 did not run`, `468 passed (8.2m)`.
The line reporter does not name the skipped or did-not-run tests.

### Bucket counts (59 tests, by the first error line of each numbered failure block)

| Bucket | Tests |
|---|---|
| assertion (`expect(...)`: `toBe` 15, `toBeVisible` 6, `toContain` 5, `toBeTruthy` 5, `toBeGreaterThan` 3, `toMatch` 2, `toContainText` 2, `toHaveLength` 1, `rejects.toThrow` 1) | 40 |
| thrown `Error` with a spec-authored message (listed below) | 8 |
| `Test timeout of 30000ms exceeded.` | 5 |
| `TimeoutError: page.waitForFunction: Timeout 45000ms/40000ms exceeded.` | 4 |
| runtime `TypeError` (`reading 'documents'`, `reading 'totalTokens'`) | 2 |

**`Test timeout of 30000ms exceeded` occurrences:** 27 in the e2e section. All 27 sit inside the
five numbered blocks whose first error line is that timeout (each block also carries the retried
attempts): `tool-approval-workflow.spec.ts` 2 blocks / 12 lines (`:226` approve payload, `:257`
deny payload), `ticket-activity-rollup.spec.ts` 1 / 6 (`:150`), `agent-profile-persistence.spec.ts`
1 / 6 (`:22`), `optimizer-native-routing.spec.ts` 1 / 3 (`:18`). No other file's failure block
contains that line.

**Non-timeout failures by file (first error line):** the remaining 50 blocks are in
`agent-memory-and-swarm-memory` (8), `orchestration-workstreams-api` (6), `tool-approval-workflow`
(8 of its 10), `llm-execution-handler` (3), `rls-core-table-coverage-live` (3), `app-theme-matrix`
(2), `calendar-app-queue-browser` (2), `gemini-harness-wiring` (2), `hardening-csp` (2),
`provider-runtime-auth-guard` (2), `rls-two-role-isolation-live` (2), `session-18-swarm-pipeline`
(2), and one each in `app-access-rls-live`, `app-surface-clickthrough`, `cline-provider-key-sync`,
`cockpit-calendar-agent-visibility`, `operational-intelligence`, `rag-query-tool`,
`security-review-fixes`, `smartthings-oauth-connector`, `storage-browse-local`,
`ticket-activity-rollup` (its other case), `ticket-cost-rollup-by-bot`,
`workload-delegation-rls-live`.

### Per-file counts (from the reporter's final `59 failed` list)

| Spec file | Failed |
|---|---|
| `tests/tool-approval-workflow.spec.ts` | 10 |
| `tests/agent-memory-and-swarm-memory.spec.ts` | 8 |
| `tests/orchestration-workstreams-api.spec.ts` | 6 |
| `tests/llm-execution-handler.spec.ts` | 3 |
| `tests/rls-core-table-coverage-live.spec.ts` | 3 |
| `tests/app-theme-matrix.spec.ts`, `tests/calendar-app-queue-browser.spec.ts`, `tests/gemini-harness-wiring.spec.ts`, `tests/hardening-csp.spec.ts`, `tests/provider-runtime-auth-guard.spec.ts`, `tests/rls-two-role-isolation-live.spec.ts`, `tests/session-18-swarm-pipeline.spec.ts`, `tests/ticket-activity-rollup.spec.ts` | 2 each |
| `tests/agent-profile-persistence.spec.ts`, `tests/app-access-rls-live.spec.ts`, `tests/app-surface-clickthrough.spec.ts`, `tests/cline-provider-key-sync.spec.ts`, `tests/cockpit-calendar-agent-visibility.spec.ts`, `tests/operational-intelligence.spec.ts`, `tests/optimizer-native-routing.spec.ts`, `tests/rag-query-tool.spec.ts`, `tests/security-review-fixes.spec.ts`, `tests/smartthings-oauth-connector.spec.ts`, `tests/storage-browse-local.spec.ts`, `tests/ticket-cost-rollup-by-bot.spec.ts`, `tests/workload-delegation-rls-live.spec.ts` | 1 each |

### Per test — first error line of the final failure block (trimmed to 120 chars)

| Spec file:line | Test | First error line |
|---|---|---|
| `tests/agent-memory-and-swarm-memory.spec.ts:312:7` | SwarmMemoryService › extractAndStore() stores learnings from completed work | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/agent-memory-and-swarm-memory.spec.ts:338:7` | SwarmMemoryService › extractAndStore() is idempotent — skips duplicate work items | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/agent-memory-and-swarm-memory.spec.ts:360:7` | SwarmMemoryService › extractAndStore() handles unstructured output as fallback | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/agent-memory-and-swarm-memory.spec.ts:376:7` | SwarmMemoryService › queryRelevant() finds relevant past experiences | `Error: expect(received).toBeGreaterThan(expected)` |
| `tests/agent-memory-and-swarm-memory.spec.ts:396:7` | SwarmMemoryService › queryRelevantContext() returns formatted prompt block | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/agent-memory-and-swarm-memory.spec.ts:432:7` | SwarmMemoryService › stores metadata including verification failures and escalations | `TypeError: Cannot read properties of undefined (reading 'documents')` |
| `tests/agent-memory-and-swarm-memory.spec.ts:476:7` | AgentMemoryService + SwarmMemoryService integration › agent memory and swarm memory use separate collections | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/agent-memory-and-swarm-memory.spec.ts:498:7` | AgentMemoryService + SwarmMemoryService integration › full lifecycle: create agent → bootstrap knowledge → execute → store swarm learning → recall | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/agent-profile-persistence.spec.ts:22:5` | chat settings save agent profile through dedicated agent-profile endpoint | `Test timeout of 30000ms exceeded.` |
| `tests/app-access-rls-live.spec.ts:102:5` | real PostgreSQL enforces exact assignments, explicit deny, defaults, and operator-only writes | `Error: expect(received).rejects.toThrow()` |
| `tests/app-surface-clickthrough.spec.ts:99:7` | priority app click-through polish › cockpit connector marketplace searches and applies operator presets | `TimeoutError: page.waitForFunction: Timeout 40000ms exceeded.` |
| `tests/app-theme-matrix.spec.ts:38:9` | dark/light stylesheet and surface theme matrix › cockpit core surfaces render cleanly in midnight | `TimeoutError: page.waitForFunction: Timeout 45000ms exceeded.` |
| `tests/app-theme-matrix.spec.ts:38:9` | dark/light stylesheet and surface theme matrix › cockpit core surfaces render cleanly in daylight | `TimeoutError: page.waitForFunction: Timeout 45000ms exceeded.` |
| `tests/calendar-app-queue-browser.spec.ts:55:7` | Cockpit calendar — per-app queue scoping (browser) › ?app=oshal-engineering calendar requests only the build queue | `Error: expect(received).toBeGreaterThan(expected)` |
| `tests/calendar-app-queue-browser.spec.ts:90:7` | Cockpit calendar — per-app queue scoping (browser) › default cockpit (no app) requests the calendar unscoped | `Error: expect(received).toBeGreaterThan(expected)` |
| `tests/cline-provider-key-sync.spec.ts:44:5` | persisted provider keys stay out of Cline runtime files | `Error: Unknown provider: noop` |
| `tests/cockpit-calendar-agent-visibility.spec.ts:97:7` | Cockpit calendar agent visibility › calendar bot filter renders with live assignee-backed options | `TimeoutError: page.waitForFunction: Timeout 40000ms exceeded.` |
| `tests/gemini-harness-wiring.spec.ts:67:7` | gemini-cli harness wiring › docker-compose declares a gemini auth volume anchor | `Error: expect(received).toMatch(expected)` |
| `tests/gemini-harness-wiring.spec.ts:80:7` | gemini-cli harness wiring › research-bot is registered against the gemini-cli harness | `Error: expect(received).toMatch(expected)` |
| `tests/hardening-csp.spec.ts:24:5` | off by default — cspFromEnv returns false (helmet CSP stays disabled) | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/hardening-csp.spec.ts:28:5` | off by default — explicit "off" also returns false ─────── | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/llm-execution-handler.spec.ts:81:7` | createLLMExecutionHandler › passes verification context and execution output to the verifier prompt | `Error: expect(received).toContain(expected) // indexOf` |
| `tests/llm-execution-handler.spec.ts:130:7` | createLLMExecutionHandler › keeps standard execution prompts focused on work units | `Error: expect(received).toContain(expected) // indexOf` |
| `tests/llm-execution-handler.spec.ts:157:7` | createLLMExecutionHandler › passes work-intent review focus into consensus-review prompts | `Error: expect(received).toContain(expected) // indexOf` |
| `tests/operational-intelligence.spec.ts:67:7` | CostTrackingService › upserts missing swarm task rows and persists usage_by_model | `TypeError: Cannot read properties of undefined (reading 'totalTokens')` |
| `tests/optimizer-native-routing.spec.ts:18:7` | Optimizer native routing › cockpit Optimizer opens the first-party Token Chase surface | `Test timeout of 30000ms exceeded.` |
| `tests/orchestration-workstreams-api.spec.ts:96:7` | Track B S4 — Agent Status Container Response Shape › PATCH /api/agents/:agentId/status — response includes container field | `Error: expect(received).toBeTruthy()` |
| `tests/orchestration-workstreams-api.spec.ts:105:7` | Track B S4 — Agent Status Container Response Shape › PATCH /api/agents/:agentId/status — rejects missing status body | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/orchestration-workstreams-api.spec.ts:114:7` | Track B S4 — Agent Status Container Response Shape › PATCH /api/agents/:agentId/status — valid toggle returns container operation info when agent exists | `Error: expect(received).toBeTruthy()` |
| `tests/orchestration-workstreams-api.spec.ts:150:7` | WS6 — Agent Status API (Session 3 baseline) › GET /api/agents/status-list — returns agent list with status fields | `Error: expect(received).toBeTruthy()` |
| `tests/orchestration-workstreams-api.spec.ts:159:7` | WS6 — Agent Status API (Session 3 baseline) › GET /api/agents/status-list?status=active — filters by active status | `Error: expect(received).toBeTruthy()` |
| `tests/orchestration-workstreams-api.spec.ts:170:7` | WS6 — Agent Status API (Session 3 baseline) › PATCH /api/agents/:agentId/status — rejects invalid status value | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/provider-runtime-auth-guard.spec.ts:21:7` | provider-runtime auth guard › routes Anthropic selection through the Cline runtime even without direct env credentials | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/provider-runtime-auth-guard.spec.ts:49:7` | provider-runtime auth guard › keeps Anthropic selection routed through Cline when secrets.json has anthropicApiKey | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/rag-query-tool.spec.ts:18:7` | RAG Query Tool › queries across all collections through the built-in RAG service | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/rls-core-table-coverage-live.spec.ts:185:7` | ADR-124 — every core table is walled or justified › no core table is unwalled without a written justification | `Error: These CORE tables have RLS off (or enabled-but-not-forced) and no entry in JUSTIFIED_EXCEPTIONS. Either wall them` |
| `tests/rls-core-table-coverage-live.spec.ts:203:7` | ADR-124 — every core table is walled or justified › every justified exception is still a real, still-unwalled core table | `Error: Stale exceptions. An allowlist that outlives its reason is how the BACKLOG residual list drifted for a month. Del` |
| `tests/rls-core-table-coverage-live.spec.ts:225:7` | ADR-124 — every core table is walled or justified › the tables migrations 112 and 113 walled are ENABLED and FORCED with their policy | `Error: migrations 112/113 did not take effect on this database` |
| `tests/rls-two-role-isolation-live.spec.ts:221:7` | migration 112 — direct owner column (voice_user_prefs.user_sub) › identity B cannot DELETE it | `Error: A's row must survive B's delete` |
| `tests/rls-two-role-isolation-live.spec.ts:266:7` | migration 113 — derived owner through tickets.owner_sub › identity B cannot DELETE the history of A's ticket | `Error: A's history must survive B's delete` |
| `tests/security-review-fixes.spec.ts:97:7` | P2 — sanitizeWorkspacePath rejects sibling-prefix paths › source uses anchored prefix check (startsWith with path.sep, not bare string) | `Error: sanitizeWorkspacePath function found` |
| `tests/session-18-swarm-pipeline.spec.ts:215:7` | Credential sync service: structured logging › findOpenAiCodexCredentialBlob has resolution chain logging | `Error: expect(received).toContain(expected) // indexOf` |
| `tests/session-18-swarm-pipeline.spec.ts:242:7` | Architecture documentation › swarm-pipeline-architecture.md exists with all required diagrams | `Error: expect(received).toContain(expected) // indexOf` |
| `tests/smartthings-oauth-connector.spec.ts:88:7` | SmartThings OAuth connector › starts OAuth-In authorization and stores returned access and refresh tokens | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/storage-browse-local.spec.ts:77:5` | path traversal cannot escape the per-user root ──── | `Error: invalid path` |
| `tests/ticket-activity-rollup.spec.ts:121:7` | Ticket Activity Rollup › root and child ticket activity point workspace browsing at the populated shared root workspace | `Error: expect(received).toBe(expected) // Object.is equality` |
| `tests/ticket-activity-rollup.spec.ts:150:7` | Ticket Activity Rollup › cockpit root ticket feed shows subtask source badge for rolled-up child entries | `Test timeout of 30000ms exceeded.` |
| `tests/ticket-cost-rollup-by-bot.spec.ts:134:7` | Cockpit Ticket Cost Rollup by Bot › ticket detail shows contributing bot badges and Cost by Bot table from linked chat_tasks usage | `Error: expect(received).toBeTruthy()` |
| `tests/tool-approval-workflow.spec.ts:24:9` | Tool Approval Workflow › Approval Modal UI › modal shows when approval request event fires | `Error: expect(locator).toBeVisible() failed` |
| `tests/tool-approval-workflow.spec.ts:51:9` | Tool Approval Workflow › Approval Modal UI › modal displays tool input as JSON | `Error: expect(locator).toContainText(expected) failed` |
| `tests/tool-approval-workflow.spec.ts:71:9` | Tool Approval Workflow › Approval Modal UI › countdown timer displays and decrements | `Error: expect(locator).toContainText(expected) failed` |
| `tests/tool-approval-workflow.spec.ts:94:9` | Tool Approval Workflow › Approval Modal UI › approve button hides modal | `Error: expect(locator).toBeVisible() failed` |
| `tests/tool-approval-workflow.spec.ts:119:9` | Tool Approval Workflow › Approval Modal UI › deny button hides modal | `Error: expect(locator).toBeVisible() failed` |
| `tests/tool-approval-workflow.spec.ts:146:9` | Tool Approval Workflow › SSE Event Handling › timeout event hides modal | `Error: expect(locator).toBeVisible() failed` |
| `tests/tool-approval-workflow.spec.ts:172:9` | Tool Approval Workflow › SSE Event Handling › response event hides modal | `Error: expect(locator).toBeVisible() failed` |
| `tests/tool-approval-workflow.spec.ts:198:9` | Tool Approval Workflow › SSE Event Handling › mismatched requestId does not hide modal | `Error: expect(locator).toBeVisible() failed` |
| `tests/tool-approval-workflow.spec.ts:226:9` | Tool Approval Workflow › API Submission › approve sends correct payload to API | `Test timeout of 30000ms exceeded.` |
| `tests/tool-approval-workflow.spec.ts:257:9` | Tool Approval Workflow › API Submission › deny sends correct payload to API | `Test timeout of 30000ms exceeded.` |
| `tests/workload-delegation-rls-live.spec.ts:250:5` | stores only a credential hash and hides both authority tables without the broker marker | `Error: expect(received).toHaveLength(expected)` |

## security-policy — what the gate asserts (5 failed tests in 3 files)

Gate summary: `Test Files 3 failed | 17 passed (20)` · `Tests 5 failed | 154 passed (159)`. The
messages are from [P] (the gate itself printed titles only). Verbatim:

1. `tests/unit/server-route-auth-inventory.spec.ts` › *every unguarded /api mount is on the reviewed
   allowlist* — `AssertionError: expected [ …(3) ] to deeply equal []`, received:
   - `/api/authorization/tenant-memberships (app.use at src/app/server.ts:1190) is mounted WITHOUT requiresAuth / serviceSecretOr / requiresOperator — it is anonymous-callable (oidc.ts runs authRequired:false). Either add a guard to the mount, or READ the route module end-to-end and add {path, reason} to UNGUARDED_ALLOWLIST in tests/unit/server-route-auth-inventory.spec.ts citing its internal guard.`
   - `/api/authorization (app.use at src/app/server.ts:1191) …` (same text)
   - `/api/user-directory (app.use at src/app/server.ts:1192) …` (same text)
2. `tests/unit/migration-transactionality.spec.ts` › *no NEW migration self-manages transactions
   (top-level BEGIN;/COMMIT;) without the explicit pragma* —
   `AssertionError: New self-wrapping migrations must declare "-- oshal:no-transaction" instead of relying on auto-detection:`
   `127-application-authorization.sql`, `129-verified-principal-directory.sql`,
   `130-jarvis-briefing-preferences.sql`, `131-authorization-audit-indexes.sql`,
   `132-application-remote-executions.sql`, `133-queued-application-principals.sql`,
   `134-principal-registrations.sql`, `135-external-tenant-memberships.sql`,
   `136-test-lab-runs.sql`, `137-test-lab-local-schedules.sql` (ten files; expected `[]`).
3. `tests/unit/machine-write-identity.spec.ts` › *no inventory or exempt entry points at a file the
   scan no longer finds (stale-entry guard)* —
   `AssertionError: artifact-exchange-core: src/app/routes/artifact-exchange-routes.ts no longer authenticates a machine caller — remove the entry: expected false to be true` (`:607`).
4. `tests/unit/machine-write-identity.spec.ts` › *jarvis-service-callers: the write runs under the
   declared identity* —
   `AssertionError: jarvis-service-callers: the driver produced no owner-scoped write to observe: expected 0 to be greater than 0` (`:765`).
5. `tests/unit/machine-write-identity.spec.ts` › *local-auth: the write runs under the declared
   identity* —
   `Error: local-auth bootstrap identity probe: expected HTTP 201, received 403: {"error":"installer setup requires the original browser origin"}` (`tests/helpers/machine-write-identity-drivers.ts:168`, from `driveLocalAuthIdentity` `:349`).

## lint — what the gate asserts (1 warning; warnings block)

```
C:\Users\roger\AppData\Local\oshal\ci-src\src\app\server.ts
  2011:1  warning  File has too many lines (1003). Maximum allowed is 1000  max-lines

✖ 1 problem (0 errors, 1 warning)
```

`lint: eslint reported findings (BLOCKING — drive to zero: npx eslint src tests scripts)`.
