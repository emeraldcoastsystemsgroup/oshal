/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register compact Home/Jarvis asset readiness and the actual navigation, browser and lifecycle regression suites.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** Read a fixed first-party asset in the caller's session; never execute it or start assistant work. */
async function assetReadiness(cookie: string, route: string, mime: string, label: string): Promise<StepResult> {
  const base = { app: 'cockpit', label };
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${route}`, {
      headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) return { ...base, status: response.status,
      state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
      detail: `Dashboard asset returned HTTP ${response.status}. No assistant, preference or application action was started.` };
    const pass = (response.headers.get('content-type') || '').includes(mime) && (await response.text()).trim().length > 0;
    return { ...base, status: response.status, state: pass ? 'pass' : 'fail', detail: pass
      ? 'Dashboard asset is available. This readiness check does not execute the linked browser or integration suites.'
      : 'The dashboard response is empty or has an unexpected content type.' };
  } catch {
    return { ...base, state: 'degraded', detail: 'Dashboard asset could not be checked. No assistant or application action was started.' };
  }
}

export const DASHBOARD_SCENARIOS: Scenario[] = [{
  id: 'cockpit-daily-dashboard', title: 'Jarvis and daily dashboard', group: 'tool',
  description: 'Read the fixed compact Home/Jarvis assets without starting voice, generation or application work. Linked suites exercise actual browser layout, task grouping, preserved drafts, directory navigation and current-user summaries; run them from the core checkout with Chromium.',
  regressionTests: [
    { level: 'browser', path: 'tests/unit/jarvis-dashboard-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/app-home-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-home-plan.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-home-customization.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-home-lifecycle.spec.ts' },
    { level: 'unit', path: 'tests/unit/applications-directory-navigation.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-dashboard-assets.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-delayed-visual-lifecycle.integration.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-dashboard-registration.spec.ts' },
    { level: 'unit', path: 'tests/unit/isolated-browser.spec.ts' },
  ],
  steps: [
    { id: 'jarvis-dashboard-style', app: 'cockpit', label: 'Compact Jarvis stylesheet',
      run: cookie => assetReadiness(cookie, '/api/jarvis/assets/jarvis-dashboard.css', 'text/css', 'Compact Jarvis stylesheet') },
    { id: 'jarvis-dashboard-client', app: 'cockpit', label: 'Compact Jarvis client',
      run: cookie => assetReadiness(cookie, '/api/jarvis/assets/jarvis-dashboard.js', 'javascript', 'Compact Jarvis client') },
    { id: 'daily-home-client', app: 'cockpit', label: 'Daily Home client',
      run: cookie => assetReadiness(cookie, '/cockpit/js/views/AppsHomeView.js', 'javascript', 'Daily Home client') },
  ],
}];
