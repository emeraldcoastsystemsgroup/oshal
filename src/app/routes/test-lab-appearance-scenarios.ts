/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register a read-only Workspace stylesheet readiness check and actual Cockpit/shared-surface browser regression.
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

export const APPEARANCE_SCENARIOS: Scenario[] = [{
  id: 'cockpit-appearance', title: 'Cockpit appearance', group: 'tool',
  description: 'Read the fixed Workspace stylesheet. This does not execute the browser suite or change saved themes; the linked fixture covers Settings, Home and embedded surfaces.',
  regressionTests: [
    { level: 'browser', path: 'tests/unit/workspace-theme-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/surface-theme-bundled-skin.spec.ts' },
  ],
  steps: [{ id: 'workspace-stylesheet', app: 'cockpit', label: 'Workspace stylesheet', run: workspaceStylesheet }],
}];
