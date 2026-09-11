/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register isolated nightly and first-run suites with honest local-runner prerequisites and a read-only progress probe.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register signed remote authorization and exact-principal result regressions with a fixed isolated runner.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Register package tool activation, current authorization and execution boundary tests.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register bot initialization, specialist context and briefing behavior suites with read-only discovery and explicit runner prerequisites.
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
  id: 'nightly-isolated-regression', title: 'Isolated nightly regressions', group: 'tool',
  description: 'Disposable PostgreSQL alert/topology coverage and bounded local runner evidence. Deployment credentials and live notification endpoints are excluded.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/alert-incident-cutover.spec.ts' },
    { level: 'integration', path: 'tests/unit/alert-incident-reopen.spec.ts' },
    { level: 'integration', path: 'tests/unit/topology-traversal.spec.ts' },
    { level: 'integration', path: 'tests/unit/alert-postgres-isolation.spec.ts' },
    { level: 'integration', path: 'tests/unit/nightly-isolated-runner.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-scheduled-ref.spec.ts' },
    { level: 'integration', path: 'tests/unit/ci-local-run-log.spec.ts' },
    { level: 'unit', path: 'tests/unit/ci-gate-streak.spec.ts' },
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
  regressionTests: [{ level: 'integration', path: 'tests/unit/package-tools.spec.ts' }],
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
  id: 'protected-remote-application-execution', title: 'Protected remote application execution', group: 'tool',
  description: 'Current per-user application rights across signed controller dispatch, hosted worker reasoning, immutable queued initiators, history, caches and SSE. Isolated HTTP/SQLite/PostgreSQL fixtures cover allowed, forged, replayed, revoked and stale requests.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/application-remote-execution.spec.ts' },
    { level: 'integration', path: 'tests/unit/application-remote-execution-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-controller-permit.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-protected-execution.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-remote-authorization-client.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-result-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-jarvis-results.spec.ts' },
    { level: 'integration', path: 'tests/unit/protected-ticket-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/queued-application-principal.spec.ts' },
    { level: 'integration', path: 'tests/unit/remote-execution-end-to-end.spec.ts' },
    { level: 'unit', path: 'tests/unit/authorization-runtime.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-client-delegation.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-delegation.spec.ts' },
    { level: 'unit', path: 'tests/unit/bot-node-delegation-wiring.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-workspace-owner-binding.spec.ts' },
    { level: 'integration', path: 'tests/unit/bot-node-swarm-execute-auth.spec.ts' },
    { level: 'unit', path: 'tests/unit/owner-principal-issuer.spec.ts' },
    { level: 'integration', path: 'tests/unit/ticket-isolation-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/task-message-isolation-routes.spec.ts' },
    { level: 'unit', path: 'tests/unit/jarvis-task-lifecycle.spec.ts' },
    { level: 'integration', path: 'tests/unit/specialist-context-dispatch.spec.ts' },
    { level: 'integration', path: 'tests/unit/manifest-worker-bot-node-boundary.spec.ts' },
    { level: 'unit', path: 'tests/unit/autonomous-test-lab-registration.spec.ts' },
  ],
  steps: [{ id: 'runner', app: 'test-lab', label: 'Protected remote authorization fixtures', run: async () => ({
    app: 'test-lab', label: 'Protected remote authorization fixtures', state: 'degraded',
    detail: 'Run npm run test:remote-authorization with local Node and Docker. Fixtures create disposable databases and SQLite workspaces; no live provider, application data or account is changed. No tests ran from this step.',
  }) }],
}];
