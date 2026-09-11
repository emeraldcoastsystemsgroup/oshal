/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register isolated nightly and first-run suites with honest local-runner prerequisites and a read-only progress probe.
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
    && Number(body.currentStep) >= 0 && body.data !== null && typeof body.data === 'object';
  return { app: 'onboarding', label, state: valid ? 'pass' : 'fail',
    detail: valid ? 'Caller-owned saved progress is available. No package, source or account changes attempted.' : 'Saved progress has an invalid response shape.' };
}

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
}];
