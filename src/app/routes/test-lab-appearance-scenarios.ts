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
 * =============================================================================
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

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

export const APPEARANCE_SCENARIOS: Scenario[] = [{
  id: 'cockpit-appearance', title: 'Cockpit appearance', group: 'tool',
  description: 'Read the fixed Workspace stylesheet. This does not execute the browser suite or change saved themes; linked fixtures cover the portal chooser, application colors, open tabs, chat, administration and operations surfaces.',
  regressionTests: [
    { level: 'browser', path: 'tests/unit/workspace-theme-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-chat-theme-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/core-surface-theme-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/surface-theme-bundled-skin.spec.ts' },
  ],
  steps: [{ id: 'workspace-stylesheet', app: 'cockpit', label: 'Workspace stylesheet', run: workspaceStylesheet }],
}, {
  id: 'cockpit-workspace-navigation', title: 'Cockpit workspace navigation', group: 'tool',
  description: 'Read current application workspace links. Linked tests cover contextual sidebars, Federal CRM, custom screens and current policy. The Career group integration recipe requires the public store checkout (OSHAL_PUBLIC_STORE_ROOT); this read-only check does not execute it.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/workspace-navigation-model.spec.ts' },
    { level: 'integration', path: 'tests/unit/workspace-navigation-routes.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-navigation-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-navigation-contextual-browser.spec.ts' },
    { level: 'integration', path: 'tests/unit/career-group-navigation.spec.ts' },
    { level: 'integration', path: 'tests/unit/swarm-app-groups.spec.ts' },
  ],
  steps: [{ id: 'workspace-discovery', app: 'cockpit', label: 'Current workspace navigation', run: workspaceDiscovery }],
}];
