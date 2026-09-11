/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register installed application smoke discovery and its local lifecycle regression suite in the AI Test Lab.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** @description Read the caller's live catalog and verify package cases retain their version and owner-app association. */
async function installedCatalog(cookie: string): Promise<StepResult> {
  const label = 'Installed app test catalog';
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/test-lab/catalog`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000), redirect: 'manual',
  });
  if (response.status !== 200) {
    return { app: 'test-lab', label, status: response.status,
      state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
      detail: `Installed test catalog returned HTTP ${response.status}.` };
  }
  const body = await response.json() as Record<string, unknown>;
  const apps = body.installedApps as Array<{ name: string; version: string; caseIds: string[] }>;
  const scenarios = body.scenarios as Array<{ id: string; installedTest?: {
    id: string; appName: string; appVersion: string; revision: string; runnable: boolean; pendingReason?: string;
  } }>;
  if (!Array.isArray(apps) || !Array.isArray(scenarios)) {
    return { app: 'test-lab', label, state: 'fail', detail: 'Catalog is missing installedApps or scenarios.' };
  }
  const cases = scenarios.filter(scenario => scenario.installedTest !== undefined);
  const valid = new Set(cases.map(scenario => scenario.id)).size === cases.length && cases.every(scenario => {
    const test = scenario.installedTest;
    if (!test || typeof test !== 'object') return false;
    return typeof test.id === 'string' && test.id.startsWith('app:') && test.id === scenario.id
      && typeof test.appName === 'string' && typeof test.appVersion === 'string' && test.appVersion.length > 0
      && /^[a-f0-9]{64}$/.test(test.revision) && typeof test.runnable === 'boolean'
      && (test.runnable || (typeof test.pendingReason === 'string' && test.pendingReason.length > 0))
      && apps.some(app => app?.name === test.appName && app.version === test.appVersion
        && Array.isArray(app.caseIds) && app.caseIds.includes(test.id));
  });
  return { app: 'test-lab', label, state: valid ? 'pass' : 'fail',
    detail: valid ? `Catalog contract verified: ${cases.length} visible installed smoke cases. No app test was executed.`
      : 'Installed cases lost their app/version association or prerequisite state.' };
}

export const INSTALLATION_SCENARIOS: Scenario[] = [{
  id: 'installed-app-tests', title: 'Installed application test registration', group: 'tool',
  description: 'Read the current caller-visible package test catalog and check case identity, version and prerequisites. Lifecycle behavior is covered by the linked isolated suite.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/installed-app-test-lab.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-platform-registration.spec.ts' },
  ],
  steps: [{ id: 'catalog', app: 'test-lab', label: 'Installed package cases', run: installedCatalog }],
}];
