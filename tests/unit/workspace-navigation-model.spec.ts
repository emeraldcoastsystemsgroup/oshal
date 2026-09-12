/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify canonical workspace descriptors and independent browser-local navigation preference boundaries.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep explicit sidebar delegation limited to selected admitted workspace families and the default framework profile.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { admittedWorkspaces, isWorkspaceDelegated, readNavigationLayout, setNavigationLayout, workspaceSidebarNames } from '@/pages/cockpit/js/workspace-navigation.js';

afterEach(() => vi.unstubAllGlobals());

it('keeps existing navigation for missing, invalid and unavailable preferences', () => {
  for (const value of [null, '', 'workspace', 'create', 'unexpected']) {
    vi.stubGlobal('localStorage', { getItem: () => value });
    expect(readNavigationLayout()).toBe('sidebar');
  }
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable'); } });
  expect(readNavigationLayout()).toBe('sidebar');
  vi.stubGlobal('localStorage', { getItem: () => 'workspaces' });
  expect(readNavigationLayout()).toBe('workspaces');
});

it('changes only the navigation preference and broadcasts its exact normalized value', () => {
  const writes: unknown[] = [], events: CustomEvent[] = [];
  vi.stubGlobal('localStorage', { setItem: (...args: unknown[]) => writes.push(args) });
  vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => events.push(event) });
  setNavigationLayout('workspaces'); setNavigationLayout('invalid');
  expect(writes).toEqual([['oshal-navigation-layout', 'workspaces'], ['oshal-navigation-layout', 'sidebar']]);
  expect(events.map(event => [event.type, event.detail])).toEqual([
    ['oshal-navigation-layout-changed', 'workspaces'], ['oshal-navigation-layout-changed', 'sidebar'],
  ]);
});

it('admits exact local profiles while omitting duplicate, external, query-smuggled and malformed descriptors', () => {
  const create = { name: 'create', displayName: 'Create', href: '/cockpit/?app=create', kind: 'app' };
  const career = { name: 'intelligent-career', displayName: 'Intelligent Career', href: '/cockpit/?app=intelligent-career', kind: 'group' };
  const bad = [{ ...create, href: 'https://example.test/cockpit/?app=create' },
    { ...create, href: '/cockpit/?app=create&workspace=foreign' },
    { ...create, href: '//example.test/' }, { ...create, name: '../create' },
    { ...create, displayName: '' }, { ...create, kind: 'invented' }, null];
  expect(admittedWorkspaces({ workspaces: [...bad, create, create, career] })).toEqual([create, career]);
  expect(admittedWorkspaces({ workspaces: 'create' })).toEqual([]);
});

it('does not retain authority or source metadata in descriptors', () => {
  const descriptor = { name: 'capture-crm', displayName: '<CRM>', href: '/cockpit/?app=capture-crm', kind: 'app' };
  expect(admittedWorkspaces({ workspaces: [{ ...descriptor, theme: 'private-skin', issuer: 'private', grants: ['admin'] }] }))
    .toEqual([descriptor]);
});

it('delegates Career sidebar pages through its admitted group or app fallback without treating More as a top destination', () => {
  for (const name of ['intelligent-career', 'career-hunter']) {
    expect(workspaceSidebarNames([{ name }, { name: 'fixture-studio' }])).toEqual(['intelligent-career', 'career-hunter']);
  }
  const invalidCrm = { name: 'capture-crm', displayName: 'CRM', kind: 'app', href: '/cockpit/?app=gov-contracting' };
  expect(workspaceSidebarNames(admittedWorkspaces({ workspaces: [invalidCrm] }))).toEqual([]);
  expect(workspaceSidebarNames([{ name: 'capture-crm' }])).toEqual(['capture-crm']);
  expect(workspaceSidebarNames([])).toEqual([]);
});

it('requires exact workspace metadata and the default profile instead of matching labels, groups or URL prefixes', () => {
  const names = ['create'];
  expect(isWorkspaceDelegated({ workspace: 'create' }, 'oshal-framework', names)).toBe(true);
  for (const profile of ['create', 'little-monsters', 'framework-fallback', 'custom-framework'])
    expect(isWorkspaceDelegated({ workspace: 'create' }, profile, names)).toBe(false);
  for (const view of [{ label: 'Create' }, { group: 'Create' }, { workspace: 'create-extra' },
    { toolUi: { iframeUrl: '/api/create/' } }, { workspace: 'create', group: 'Create' }]) {
    expect(isWorkspaceDelegated(view, 'oshal-framework', [])).toBe(false);
    if (!('workspace' in view) || view.workspace !== 'create') expect(isWorkspaceDelegated(view, 'oshal-framework', names)).toBe(false);
  }
});
