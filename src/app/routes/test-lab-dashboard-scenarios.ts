/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register compact Home/Jarvis asset readiness and the actual navigation, browser and lifecycle regression suites.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Reuse the shared fixed-asset readiness reader with Profile and Access.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Read the briefing settings client through the real route on the running box (the baked image answered it as a JSON 404 the browser refused to run) and link the asset/roll-to-fresh-thread regression suites.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Link the no-hosted-brain honesty suites: the route-level guard over the real router and execution chokepoint, and the Chromium guard that the page writes and speaks the no-engine sentence while the briefing shelf still lists its row.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Link the terminal-ticket return guard: the real-PostgreSQL suite proving a dead ticket closes its work row and says so once in the thread, instead of sitting at 'queued' and being injected into every turn as "in progress".
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Link the Home admission guard: the route-level suite proving Home offers an application only while current application policy admits it, converging with workspace discovery on grant, revocation and explicit deny.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Exercise the signed-in issuer-less Jarvis thread refusal and fresh-thread cleanup in the running Lab, not only the isolated browser suite.
 */
import type { Scenario } from './test-lab-scenarios';
import { assetReadiness } from './test-lab-asset-readiness';
import { runJarvisLegacyThreadLifecycle } from './test-lab-jarvis-thread-lifecycle';

export const DASHBOARD_SCENARIOS: Scenario[] = [{
  id: 'cockpit-daily-dashboard', title: 'Jarvis and daily dashboard', group: 'tool',
  description: 'Read compact Home/Jarvis assets and exercise a clearly labelled, owner-bound Jarvis thread-refusal fixture. The lifecycle step asks only for a deterministic weather-location clarification (no provider dispatch or model call), then deletes its own threads and chat ticket. Linked suites exercise browser layout, task grouping, drafts, navigation and summaries.',
  regressionTests: [
    { level: 'browser', path: 'tests/unit/jarvis-dashboard-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/jarvis-legacy-thread-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/jarvis-no-brain-browser.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-no-hosted-brain-honesty.spec.ts' },
    { level: 'browser', path: 'tests/unit/app-home-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-home-plan.spec.ts' },
    { level: 'integration', path: 'tests/unit/app-home-plan-authorization.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-home-customization.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-home-lifecycle.spec.ts' },
    { level: 'unit', path: 'tests/unit/applications-directory-navigation.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-dashboard-assets.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-briefing-assets.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-jarvis-thread-lifecycle.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-delayed-visual-lifecycle.integration.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-terminal-ticket-return.integration.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-dashboard-registration.spec.ts' },
    { level: 'unit', path: 'tests/unit/isolated-browser.spec.ts' },
  ],
  steps: [
    { id: 'jarvis-dashboard-style', app: 'cockpit', label: 'Compact Jarvis stylesheet',
      run: cookie => assetReadiness(cookie, '/api/jarvis/assets/jarvis-dashboard.css', 'text/css', 'Compact Jarvis stylesheet') },
    { id: 'jarvis-dashboard-client', app: 'cockpit', label: 'Compact Jarvis client',
      run: cookie => assetReadiness(cookie, '/api/jarvis/assets/jarvis-dashboard.js', 'javascript', 'Compact Jarvis client') },
    { id: 'jarvis-briefing-client', app: 'cockpit', label: 'Briefing settings client',
      run: cookie => assetReadiness(cookie, '/api/jarvis/briefings/client.js', 'javascript', 'Briefing settings client') },
    { id: 'daily-home-client', app: 'cockpit', label: 'Daily Home client',
      run: cookie => assetReadiness(cookie, '/cockpit/js/views/AppsHomeView.js', 'javascript', 'Daily Home client') },
    { id: 'jarvis-legacy-thread', app: 'jarvis', label: 'Refused thread rolls to an owned fresh thread and cleans up',
      run: (cookie, _prior, runtime) => runJarvisLegacyThreadLifecycle(cookie, runtime) },
  ],
}];
