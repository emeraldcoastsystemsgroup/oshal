/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register compact Home/Jarvis asset readiness and the actual navigation, browser and lifecycle regression suites.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Reuse the shared fixed-asset readiness reader with Profile and Access.
 */
import type { Scenario } from './test-lab-scenarios';
import { assetReadiness } from './test-lab-asset-readiness';

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
