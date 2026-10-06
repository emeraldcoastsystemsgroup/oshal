/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register isolated nightly and first-run suites with honest local-runner prerequisites and a read-only progress probe.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register signed remote authorization and exact-principal result regressions with a fixed isolated runner.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Register package tool activation, current authorization and execution boundary tests.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register bot initialization, specialist context and briefing behavior suites with read-only discovery and explicit runner prerequisites.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Register the BUG-20 guards on the isolated nightly regression scenario: the alert replay-idempotency and consolidateLanded suites on disposable PostgreSQL.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Register the local CI export-purge and partial-secret-scan guards (Git Bash runs of the production script pieces) on the isolated nightly regression scenario.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Register the protected derived-result return guard on the protected remote application execution scenario.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Register the three trading guards that now start and destroy their own PostgreSQL (earnings rules, event plans, engine cost basis). They are the same disposable-container class this scenario already covers, and it is the only registered gate that executes them - they read no database address, so nothing else can point them anywhere.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Register the trading schema bootstrap race guard on the same isolated nightly scenario. It starts its own PostgreSQL and drives several independent copies of the trading bootstrap modules at it concurrently, so like its three neighbours it reads no address and executes only where Docker is present.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Register the inherited-export guard next to the purge guard it completes. The purge guard runs purge_tree alone; this one runs ci-local.sh's own gate sequence over a state directory that already holds the previous run's export, which is the state the 2026-09-09 nightly wedged in.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Register the provider-embedded tool tier: per-agent grants read from the agent's own persona, a fail-closed refusal at execution, and a run trace that names the tier and the provider operation.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Register the trading spec bare-cluster prerequisite guard on the isolated nightly scenario. It owns its PostgreSQL and asserts the trading DB specs' shared prologue builds every relation they touch on an EMPTY server, which is the gate that made three of them runnable anywhere but the operator's own database.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Register the planted-fixture secret-scan proof on the isolated nightly scenario, beside the partial-scan guard it completes. That guard replaces docker on PATH; this one runs the real gitleaks image over a disposable repository and requires the gate to go red on a planted synthetic credential and green once it is removed, so the scenario now lists a run that actually exercises the scanner.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Register the nightly backup diagnostic's round-trip guard on the isolated nightly scenario. The backup/restore leg had no Lab scenario at all, which is how a diagnostic that published passing evidence off a partial restore stayed unwatched; the guard owns its PostgreSQL and executes a real pg_dump and psql, so this scenario is the only gate that can run it.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Register the partial-scan secret-scan proof beside the other two. It is the only one of the three that makes the real gitleaks image actually skip a path and exit 0, which is the failure shape the gate was written for, so the scenario now lists a run that exercises the refusal as well as the detection.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Register the two ADR-052 addendum parity guards on the isolated nightly scenario: the per-position exit-plan table spec (immutable terms at the database, supersede/close/amend paths, (user_sub, book_id) scoping, owner RLS against a NOSUPERUSER NOBYPASSRLS role) and the parity fire spec (real dispatchTradingSchedule fires: the market-gap hold of every entry leg with its counterfactual rows and kept rotation slot, and plans stamped, honored, expired and closed with their doors). Both start and destroy their own PostgreSQL and read no address, so this runner is the gate that executes them.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Register the ADR-052 addendum P6 yield-sleeve fire spec on the isolated nightly scenario: real dispatchTradingSchedule fires that sell the armed sleeve before the entries it funds (scan and rotation), keep it out of every exit leg, park idle cash on a quiet fire, idle it while its own order works, and read the Test Lab sleeve ledger back from the same database. It starts and destroys its own PostgreSQL and reads no address, so this runner is the gate that executes it.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Register the two replay ledger guards on the protected remote application execution scenario: the store's own spec, which was on disk and in no scenario, and its real-Redis companion for the first connect under concurrent callers. The companion starts and removes its own Redis and reads no address, so the scenario's fixed runner is the gate that executes it, and the description names Redis among the fixtures.
 * 18 | maintainer@emeraldcoastsystemsgroup.com | Register the database-free Vitest discovery guard beside the tree-walk suites whose default scheduling it protects.
 * 19 | maintainer@emeraldcoastsystemsgroup.com | Register the two-tenant isolation proof for provision-tenant.sh (isolated tier, ADR-035 amendment) on the isolated nightly scenario: it renders two tenants with the shipped script, applies each rendering with the real psql on a PostgreSQL it starts and destroys, and requires a cross-tenant database connection and a cross-tenant row read to be refused. It reads no database address, so the scenario's fixed local runner is the gate that executes it.
 * 20 | maintainer@emeraldcoastsystemsgroup.com | Register the logic spec of the tenant-isolation cluster acceptance (accept-tenant-isolation.sh over a stateful kubectl stand-in: accepts only proven isolation with both created namespaces confirmed deleted, refuses before creating anything) on the same isolated nightly scenario. It needs Git Bash and reaches no cluster.
 * 21 | maintainer@emeraldcoastsystemsgroup.com | Register the nightly-saturation guards on the isolated nightly scenario: the worker quiesce (only named, running, non-critical workers stop, silenced; restored after pass, fail, SIGTERM, SIGINT, and from the state file after SIGKILL), the RESOURCE-EXHAUSTED outcome (decided by measured host memory, never by words in gate output) and the duration measurement the backlog's done-when is read with. Git Bash and stand-ins only; no engine.
 * 22 | maintainer@emeraldcoastsystemsgroup.com | Register caller-private cockpit streams, activity contributors, project discovery and operator escalation reads.
 * 23 | maintainer@emeraldcoastsystemsgroup.com | Register real HTTP operator administration refusals and caller-summary compatibility.
 * 24 | maintainer@emeraldcoastsystemsgroup.com | Register connector/channel administration refusals and caller override/link compatibility.
 * 25 | maintainer@emeraldcoastsystemsgroup.com | Register real HTTP workflow administration and shared publishing regressions with member-work compatibility.
 * 26 | maintainer@emeraldcoastsystemsgroup.com | Register mounted global swarm telemetry and Plane diagnostic operator boundaries with normal processing compatibility.
 * 27 | maintainer@emeraldcoastsystemsgroup.com | Register actual Token Chase spending HTTP gates and caller-bound replay attribution with qualified isolated provider/cost seams.
 * 28 | maintainer@emeraldcoastsystemsgroup.com | Register ticket filing integrity over the real ticket router: pinned-agent entitlement, unreadable-parent refusal and the privileged-type filer check, on create and on PATCH.
 * 29 | maintainer@emeraldcoastsystemsgroup.com | Register global project registry administration: non-operator create/rename/archive refused, operator allowed, own-ticket project assignment unaffected.
 * 30 | maintainer@emeraldcoastsystemsgroup.com | Register protected parent selection: a parent GET refuses (the owner after a result-rights revocation, the exact-principal twin, an operator without result access) is refused on POST and PATCH with the missing-parent 404, writing nothing; the owner with current rights still files under it.
 * 31 | maintainer@emeraldcoastsystemsgroup.com | Register controller ticket chat retirement: every caller (own, foreign, bare task id, unknown id, operator) naming a privileged bot gets 410 legacy_execution_route_retired, the orchestrator is never reached, and nothing is linked or created.
 * 32 | maintainer@emeraldcoastsystemsgroup.com | Register PUT /tickets/:id/state access: another user's ticket or bare task id is refused with the missing-id 404 and nothing moves, the owner still changes their own, and a revoked owner is refused a protected ticket or task.
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | Register one exact-principal ticket verdict (P5 step 1): on an issuer-stamped ticket the same sub from another issuer, an inactive owner and a session with no verified actor are refused on load, parent selection and state; operators still read; /api/tickets and cockpit verdicts are equal.
 * 34 | maintainer@emeraldcoastsystemsgroup.com   | Register dispatch-time pin authorization (Z-08): a non-operator's pin to a bot they may not call escalates terminally without a claim or a worker; operator, permitted-pin and absent-owner dispatches still reach the pinned bot; an invalid owner is refused, not treated as internal.
 * 35 | maintainer@emeraldcoastsystemsgroup.com   | Link new ordinary Project Manager task issuer stamps beside the canonical owner-principal regressions; the fixture runner remains isolated.
 * 36 | maintainer@emeraldcoastsystemsgroup.com   | Link authenticated stamped guest own-ticket read and refusal regressions through the real guest injector and guard; the runner remains isolated.
 * 37 | maintainer@emeraldcoastsystemsgroup.com   | Link global queue-health operator refusal and summary compatibility regressions without changing the isolated runner's read-only guidance.
 * 38 | maintainer@emeraldcoastsystemsgroup.com | Register Jarvis direct ticket projections, exact-principal carrier reuse and current close refusal with provider-free HTTP/module fixtures.
 * 39 | maintainer@emeraldcoastsystemsgroup.com | Register fixed no-lineage completion notice refusals and ordinary work compatibility through real isolated PostgreSQL and current application policy.
 * 40 | maintainer@emeraldcoastsystemsgroup.com   | Register idle persistence cooldown recovery, SYSTEM retry isolation and truthful readiness with the existing isolated store-persistence runner.
 * 41 | maintainer@emeraldcoastsystemsgroup.com   | Register the guest demo seed own-read regression on the protected remote application execution scenario: the rows the real seeder writes are read through the real guest chain by their guest, and refused to another guest and to the same sub from another issuer.
 * 42 | maintainer@emeraldcoastsystemsgroup.com | Register protected inline concierge authority, empty histories, pending approval streams, real PostgreSQL conversation reload and isolated native recovery browser coverage through the existing fixed runner.
 * 43 | maintainer@emeraldcoastsystemsgroup.com   | Register concierge operation logging, secret omission and bounded documentation/catch negative controls in the existing protected-execution runner.
 * 44 | maintainer@emeraldcoastsystemsgroup.com   | Register the protected node chat-turn guard on the protected remote application execution scenario: rail, cockpit and legacy chat bodies reach a protected node bot direct and non-agentic with one brain shape, an unprotected node keeps its shape, and the persisted node reply is published on the real task stream only after both turns are saved. It is integration level, over the real routers, chokepoint, node client and stream with a loopback stub node.
 * 45 | maintainer@emeraldcoastsystemsgroup.com   | Register the protected bot-persona guards on the protected remote application execution scenario: the signed carrier end to end (real client, policy service, worker ingress and handler) and the composer over real package directories.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

async function onboardingProgress(cookie: string): Promise<StepResult> {
  const label = 'Saved onboarding progress';
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/user/onboarding`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(10000), redirect: 'manual',
  });
  if (response.status !== 200) return { app: 'onboarding', label, status: response.status,
    state: [401, 403, 503].includes(response.status) ? 'degraded' : 'fail', detail: `Progress returned HTTP ${response.status}; no setup changes attempted.` };
  const body = await response.json() as Record<string, unknown>;
  const valid = typeof body.completed === 'boolean' && Number.isSafeInteger(body.currentStep)
    && Number(body.currentStep) >= 0 && body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data);
  return { app: 'onboarding', label, state: valid ? 'pass' : 'fail',
    detail: valid ? 'Caller-owned saved progress is available. No package, source or account changes attempted.' : 'Saved progress has an invalid response shape.' };
}

async function briefingSources(cookie: string): Promise<StepResult> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/jarvis/briefings`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(10000), redirect: 'manual',
  });
  const label = 'Caller-visible briefing sources';
  if (response.status !== 200) return { app: 'jarvis', label, status: response.status,
    state: [401, 403, 503].includes(response.status) ? 'degraded' : 'fail', detail: 'Briefing catalog unavailable; no preferences or delivery claims changed.' };
  const body = await response.json() as { sources?: unknown };
  const valid = Array.isArray(body.sources) && body.sources.every(source => source && typeof source.sourceId === 'string'
    && typeof source.preference?.enabled === 'boolean' && Array.isArray(source.channels));
  return { app: 'jarvis', label, state: valid ? 'pass' : 'fail',
    detail: valid ? 'Registered sources and caller preferences are readable. No notification was claimed or delivered.' : 'Briefing catalog response is invalid.' };
}

/** @description Discover autonomous regression suites without granting the browser host execution authority. */
export const AUTONOMOUS_SCENARIOS: Scenario[] = [{
  id: 'store-persistence-recovery', title: 'Persistence recovery and readiness', group: 'tool',
  description: 'Kept-pool retry, idle cooldown recovery, SYSTEM scheduling and truthful degraded readiness. Clock/identity fixtures and disposable PostgreSQL exclude production data and provider calls.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/store-persistence-recovery.spec.ts' },
    { level: 'unit', path: 'tests/unit/persistence-mode-readiness.spec.ts' },
    { level: 'unit', path: 'tests/unit/readiness-report.spec.ts' },
    { level: 'unit', path: 'tests/unit/catalog-load-readiness.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Local persistence runner', run: async () => ({
    app: 'test-lab', label: 'Local persistence runner', state: 'degraded',
    detail: 'Run npm run test:store-persistence with local Node and Docker. The browser does not execute host tests or attempt live store recovery. No tests ran from this step.',
  }) }],
}, {
  id: 'nightly-isolated-regression', title: 'Isolated nightly regressions', group: 'tool',
  description: 'Disposable PostgreSQL alert, topology, backup round-trip, tenant-isolation and trading-guard coverage with bounded local runner evidence. Deployment credentials and live notification endpoints are excluded.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/alert-incident-cutover.spec.ts' },
    { level: 'integration', path: 'tests/unit/alert-incident-reopen.spec.ts' },
    { level: 'integration', path: 'tests/unit/topology-traversal.spec.ts' },
    { level: 'unit', path: 'tests/unit/vitest-db-serialization.spec.ts' },
    { level: 'integration', path: 'tests/unit/alert-postgres-isolation.spec.ts' },
    { level: 'integration', path: 'tests/unit/alert-event-replay-idempotency.spec.ts' },
    { level: 'integration', path: 'tests/unit/alert-consolidate-landed-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/backup-restore-proof.spec.ts' },
    { level: 'integration', path: 'tests/unit/nightly-isolated-runner.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-scheduled-ref.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-run-log.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-purge.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-inherited-export.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-secret-scan.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-secret-scan-planted-fixture.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-secret-scan-unreadable-path.spec.ts' },
    { level: 'unit', path: 'tests/unit/ci-gate-streak.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-quiesce.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-resource-exhausted.spec.ts' },
    { level: 'unit', path: 'tests/unit/ci-run-durations.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-engine-cost-basis-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-event-plans.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-earnings-rules.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-schema-bootstrap-race.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-spec-bare-cluster-prerequisites.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-position-plans-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-parity-fire.spec.ts' },
    { level: 'integration', path: 'tests/unit/trading-dispatch-yield-sleeve-fire.spec.ts' },
    { level: 'integration', path: 'tests/unit/provision-tenant-isolation-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/accept-tenant-isolation.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Local isolated runner', run: async () => ({
    app: 'test-lab', label: 'Local isolated runner', state: 'degraded',
    detail: 'Registered suites require the local Node/Docker runner. Run npm run test:nightly-isolated; the browser does not execute host test commands. No tests ran from this step.',
  }) }],
}, {
  id: 'first-run-provisioning', title: 'First-run setup and saved progress', group: 'tool',
  description: 'Caller-owned progress, trusted sources, reviewed installation, failure/retry and existing-account links. Browser and database fixtures are isolated.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/onboarding-provisioning.spec.ts' },
    { level: 'browser', path: 'tests/unit/onboarding-provisioning-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/autonomous-test-lab-registration.spec.ts' },
  ],
  steps: [{ id: 'progress', app: 'onboarding', label: 'Saved progress', run: onboardingProgress }],
}, {
  id: 'manifest-bot-initialization', title: 'Installed bot runtime defaults', group: 'tool',
  description: 'Fresh package loads persist runtime defaults and retain operator selections. Isolated database and HTTP fixtures verify load, races, reload and dispatch.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/manifest-bot-authority.spec.ts' },
    { level: 'unit', path: 'tests/unit/manifest-bot-runtime-defaults.spec.ts' },
    { level: 'integration', path: 'tests/unit/manifest-bot-runtime.spec.ts' },
    { level: 'integration', path: 'tests/unit/manifest-node-bot-dispatch.spec.ts' },
    { level: 'integration', path: 'tests/unit/manifest-worker-bot-node-boundary.spec.ts' },
    { level: 'unit', path: 'tests/unit/swarm-app-selector-seeding.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Isolated bot initialization suites', run: async () => ({
    app: 'test-lab', label: 'Isolated bot initialization suites', state: 'degraded',
    detail: 'Run npm run test:bot-initialization with local Node and Docker. The Lab does not load fixture bots into the running swarm. No tests ran from this step.',
  }) }],
}, {
  id: 'specialist-application-context', title: 'Authorized specialist application facts', group: 'tool',
  description: 'Package-owned bounded facts pass through caller authorization before signed dispatch. Isolated fixtures prove known answers, identity, revocation, lifecycle and timeout behavior.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/specialist-context.spec.ts' },
    { level: 'integration', path: 'tests/unit/specialist-context-dispatch.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Specialist fixture runner', run: async () => ({
    app: 'test-lab', label: 'Specialist fixture runner', state: 'degraded',
    detail: 'Run npm run test:specialist-context locally. This step does not query application records or invoke a model. No tests ran from this step.',
  }) }],
}, {
  id: 'authorized-package-tools', title: 'Authorized application tools', group: 'tool',
  description: 'Declared handlers register atomically and execute with current caller permissions. Isolated fixtures verify lifecycle, tenant selection, revocation and approval boundaries.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/package-tools.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-package-tools.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-package-tools-chat.spec.ts' },
    { level: 'browser', path: 'tests/unit/jarvis-package-tools-browser.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Package tool fixtures', run: async () => ({
    app: 'test-lab', label: 'Package tool fixtures', state: 'degraded',
    detail: 'Run npm run test:package-tools locally. The browser does not execute host commands or change application data. No tests ran from this step.',
  }) }],
}, {
  id: 'jarvis-briefing-preferences', title: 'Per-user Jarvis briefing preferences', group: 'tool',
  description: 'Registered source discovery, exact-principal preferences, bounded announcement frequency and voice/bubble/screen delivery. Read-only catalog probe; isolated fixtures cover mutations.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/jarvis-briefing-preferences.spec.ts' },
    { level: 'browser', path: 'tests/unit/jarvis-briefing-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/jarvis-briefing-identity.spec.ts' },
  ],
  steps: [{ id: 'sources', app: 'jarvis', label: 'Caller-visible sources', run: briefingSources }],
}, {
  id: 'protected-remote-application-execution', title: 'Protected remote and inline application execution', group: 'tool',
  description: 'Current per-user rights across signed dispatch, inline concierges, immutable queued initiators, history, caches and SSE. Isolated HTTP/SQLite/PostgreSQL/Redis fixtures prove owner-only empty histories, durable reply reload, pending approval controls and current policy revocation. An isolated browser proves explicit unavailable-thread recovery with an application adapter; deployed native concierge and real model acceptance are separate. Queued dispatch retains its supported direct/hosted shape and missing-owner-connection refusal.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/application-remote-execution.spec.ts' },
    { level: 'integration', path: 'tests/unit/application-remote-execution-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/application-inline-execution.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-empty-task-access.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-task-control-access.spec.ts' },
    { level: 'unit', path: 'tests/unit/protected-inline-stream-events.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-inline-thread-postgres.spec.ts' },
    { level: 'browser', path: 'tests/unit/swarmbot-conversation-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/concierge-operation-logging.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-controller-permit.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-protected-execution.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-remote-authorization-client.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-result-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-jarvis-results.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-ticket-principal-scope-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-jarvis-thread-return.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-jarvis-completion-notice.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-ticket-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/cockpit-private-reads-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/operator-administration-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/workflow-administration-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/swarm-publishing-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/connector-channel-administration-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/cockpit-project-administration-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/cockpit-queue-health-route.spec.ts' },
    { level: 'integration', path: 'tests/unit/swarm-administration-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/token-chase-spending-authority-http.spec.ts' },
    { level: 'integration', path: 'tests/unit/queued-application-principal.spec.ts' },
    { level: 'integration', path: 'tests/unit/remote-execution-end-to-end.spec.ts' },
    { level: 'unit', path: 'tests/unit/authorization-runtime.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-client-delegation.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-delegation.spec.ts' },
    { level: 'unit', path: 'tests/unit/delegation-replay-store.spec.ts' },
    { level: 'integration', path: 'tests/unit/delegation-replay-store-redis.spec.ts' },
    { level: 'unit', path: 'tests/unit/bot-node-delegation-wiring.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-workspace-owner-binding.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-swarm-execute-auth.spec.ts' },
    { level: 'unit', path: 'tests/unit/owner-principal-issuer.spec.ts' },
    { level: 'unit', path: 'tests/unit/project-manager-ticket-intake.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-isolation-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-filing-integrity.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-filing-protected-parent.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-chat-retired.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-state-compat-access.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-exact-principal-ownership.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-guest-own-read.spec.ts' },
    { level: 'integration', path: 'tests/unit/guest-demo-seed-own-read.spec.ts' },
    { level: 'integration', path: 'tests/unit/pinned-ticket-dispatch-gate.spec.ts' },
    { level: 'integration', path: 'tests/unit/task-message-isolation-routes.spec.ts' },
    { level: 'unit', path: 'tests/unit/jarvis-task-lifecycle.spec.ts' },
    { level: 'integration', path: 'tests/unit/specialist-context-dispatch.spec.ts' },
    { level: 'integration', path: 'tests/unit/manifest-worker-bot-node-boundary.spec.ts' },
    { level: 'integration', path: 'tests/unit/queued-protected-dispatch.spec.ts' },
    { level: 'unit', path: 'tests/unit/autonomous-test-lab-registration.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-node-chat-turn.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-bot-persona-carrier.spec.ts' },
    { level: 'integration', path: 'tests/unit/manifest-bot-persona.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Protected application execution fixtures', run: async () => ({
    app: 'test-lab', label: 'Protected application execution fixtures', state: 'degraded',
    detail: 'Run npm run test:remote-authorization with local Node, Docker and Chromium. Fixtures own their databases, SQLite workspaces and browser; no live provider, deployed application data or account is changed. No tests ran from this step.',
  }) }],
}, {
  id: 'embedded-llm-tool-tier', title: 'Provider-embedded tool tier', group: 'tool',
  description: 'A named embedded tool is enabled or disabled per agent in that agent\'s own persona, a denied one refuses at execution with a stable code, and the run trace names the tier and the provider operation. Isolated fixtures; no model provider is called.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/embedded-tool-tier.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Embedded tool tier fixtures', run: async () => ({
    app: 'test-lab', label: 'Embedded tool tier fixtures', state: 'degraded',
    detail: 'Run npm run test:embedded-tools with local Node. Fixtures write persona YAML to a temporary directory and run the agentic loop against a scripted provider; no model, application data or account is reached. No tests ran from this step.',
  }) }],
}];
