/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register a read-only Workspace stylesheet readiness check and actual Cockpit/shared-surface browser regression.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register current workspace navigation discovery and linked permission and browser regression suites.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Link the actual embedded chat theme and global preference regression to the appearance scenario.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Register actual core-page palette, native control and live-inheritance browser coverage.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Link contextual sidebar, Federal CRM navigation and actual Career group integration checks with explicit store-fixture prerequisites.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Link full-head local asset startup, rendering and service-worker browser coverage without changing the read-only readiness check.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Register real Profile dialog and abandoned workspace HTTP coverage, with shared fixed-asset readiness.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Register the per-surface in-app help contract: the covered-surface list the cockpit header reads, and a representative deep link, so a deployment that ships without the guide corpus (or with a mapping to a guide nobody wrote) reports it here instead of failing in front of a stuck reader.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Link the default-rail band guard. config-seed/profiles/oshal-framework.json is hand-maintained with no linkage to install state, so a tile drifting between rail groups — or out of the rail entirely — went unnoticed until somebody opened the cockpit and looked.
 * =============================================================================
 */
import type { Scenario, StepResult } from './test-lab-scenarios';
import { assetReadiness } from './test-lab-asset-readiness';

/** @description Read one fixed local stylesheet in the caller's session; this neither changes a theme nor runs a browser. */
async function workspaceStylesheet(cookie: string): Promise<StepResult> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/cockpit/css/themes/workspace.css`, {
    headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  const base = { app: 'cockpit', label: 'Workspace stylesheet', status: response.status };
  if (response.status !== 200) return { ...base, state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
    detail: `Workspace stylesheet returned HTTP ${response.status}. No preference was changed.` };
  const source = await response.text();
  const pass = (response.headers.get('content-type') || '').includes('text/css')
    && source.includes('[data-theme="workspace"]') && source.includes('--bg-primary:') && source.includes('--text-primary:');
  return { ...base, state: pass ? 'pass' : 'fail', detail: pass
    ? 'Workspace stylesheet is available. Browser behavior is covered by the linked isolated suite, not executed by this check.'
    : 'The Workspace response is not the expected theme stylesheet.' };
}

/** @description Read the current caller's workspace links without opening an application or changing the navigation preference.
 * @param cookie Current authenticated request cookie. @returns Honest discovery readiness, separate from linked browser execution.
 */
async function workspaceDiscovery(cookie: string): Promise<StepResult> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/ui/workspaces`, {
    headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  const base = { app: 'cockpit', label: 'Current workspace navigation', status: response.status };
  if (response.status !== 200) return { ...base,
    state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
    detail: `Workspace discovery returned HTTP ${response.status}. No preference was changed.` };
  const body = await response.json() as { workspaces?: Array<{ name: string; href: string }> };
  const pass = Array.isArray(body.workspaces) && body.workspaces.every(item => typeof item.name === 'string'
    && item.href === `/cockpit/?app=${encodeURIComponent(item.name)}`);
  return { ...base, state: pass ? 'pass' : 'fail', detail: pass
    ? `${body.workspaces!.length} currently admitted workspace links. This check does not run the linked browser suite or grant access to application data.`
    : 'Workspace discovery did not return canonical application links.' };
}

/** @description Read the per-surface help contract without rendering account data or running a browser.
 * @param cookie Current authenticated request cookie. @returns Honest coverage readiness for the header help affordance.
 */
async function helpSurfaceCoverage(cookie: string): Promise<StepResult> {
  const origin = `http://127.0.0.1:${process.env.PORT || '5000'}`;
  const request = (path: string) => fetch(`${origin}${path}`,
    { headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const response = await request('/api/help/surfaces');
  const base = { app: 'cockpit', label: 'Per-surface help coverage', status: response.status };
  if (response.status !== 200) return { ...base,
    state: [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail',
    detail: `The covered-surface list returned HTTP ${response.status}. Nothing was changed.` };
  const body = await response.json() as { surfaces?: unknown };
  const surfaces = Array.isArray(body.surfaces) ? body.surfaces.filter(item => typeof item === 'string') : [];
  if (surfaces.length === 0) return { ...base, state: 'gap',
    detail: 'No surface reaches a guide on this deployment — the guide corpus is not installed, so the header help control can only offer the index.' };
  // One representative deep link proves the ?for= contract still lands on a guide rather than the index.
  const sample = surfaces.includes('tickets') ? 'tickets' : surfaces[0];
  const deep = await request(`/api/help?for=${encodeURIComponent(sample)}`);
  const landed = deep.status === 302 && (deep.headers.get('location') || '').startsWith('/api/help/');
  return { ...base, state: landed ? 'pass' : 'fail', detail: landed
    ? `${surfaces.length} surface identifiers reach a guide, and "${sample}" still deep-links to its own page. The linked browser suite, not this check, exercises the header control.`
    : `"${sample}" is advertised as covered but did not deep-link to a guide (HTTP ${deep.status}).` };
}

export const APPEARANCE_SCENARIOS: Scenario[] = [{
  id: 'cockpit-appearance', title: 'Cockpit appearance', group: 'tool',
  description: 'Read the fixed Workspace and Profile stylesheets. This does not execute the browser suite or change saved themes; linked fixtures cover the actual Profile dialog, local-asset startup, the portal chooser, application colors, open tabs, chat, administration and operations surfaces.',
  regressionTests: [
    { level: 'browser', path: 'tests/unit/cockpit-startup-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/cockpit-profile-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-appearance-registration.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-theme-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-chat-theme-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/core-surface-theme-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/surface-theme-bundled-skin.spec.ts' },
  ],
  steps: [
    { id: 'workspace-stylesheet', app: 'cockpit', label: 'Workspace stylesheet', run: workspaceStylesheet },
    { id: 'profile-stylesheet', app: 'cockpit', label: 'Profile and Access stylesheet',
      run: cookie => assetReadiness(cookie, '/cockpit/css/profile-modal.css', 'text/css', 'Profile and Access stylesheet') },
  ],
}, {
  id: 'cockpit-workspace-navigation', title: 'Cockpit workspace navigation', group: 'tool',
  description: 'Read current application workspace links. Linked tests cover Finance, the OSHAL menu, contextual sidebars, Federal CRM, custom screens and current policy. The Career group integration recipe requires the public store checkout (OSHAL_PUBLIC_STORE_ROOT); this read-only check does not execute it.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/workspace-navigation-model.spec.ts' },
    { level: 'integration', path: 'tests/unit/workspace-navigation-routes.spec.ts' },
    { level: 'integration', path: 'tests/unit/workspace-navigation-routes-cancellation.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-navigation-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-navigation-contextual-browser.spec.ts' },
    { level: 'integration', path: 'tests/unit/career-group-navigation.spec.ts' },
    { level: 'integration', path: 'tests/unit/swarm-app-groups.spec.ts' },
    { level: 'integration', path: 'tests/unit/default-rail-groups.spec.ts' },
  ],
  steps: [{ id: 'workspace-discovery', app: 'cockpit', label: 'Current workspace navigation', run: workspaceDiscovery }],
}, {
  id: 'shared-stl-viewer', title: 'Shared 3D mesh viewer', group: 'tool',
  description: 'Read the shared STL viewer asset without generating geometry. The linked real WebGL suite exercises Scan and CAD adapters and requires the public store checkout; readiness does not execute that suite or the CAD kernel.',
  regressionTests: [{ level: 'browser', path: 'tests/unit/stl-viewer-browser.spec.ts' }],
  steps: [{ id: 'stl-viewer-client', app: 'cockpit', label: 'Shared STL viewer',
    run: cookie => assetReadiness(cookie, '/shared/ui/js/stl-viewer.js', 'javascript', 'Shared STL viewer') }],
}, {
  id: 'in-app-help', title: 'In-app help', group: 'tool',
  description: 'Read the per-surface help contract the cockpit header depends on: which surface identifiers reach a guide this deployment actually ships, and whether a representative one still deep-links to its own page. Read-only — it renders no account data and does not execute the linked browser suite.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/help-routes.spec.ts' },
    { level: 'browser', path: 'tests/unit/in-app-surface-help-browser.spec.ts' },
  ],
  steps: [{ id: 'help-surface-coverage', app: 'cockpit', label: 'Per-surface help coverage', run: helpSurfaceCoverage }],
}];
