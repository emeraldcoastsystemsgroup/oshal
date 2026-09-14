/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Data-model explorer page-model guards (the browser modules, imported directly): the app graph's filters (isolated apps hidden, link kinds), the table graph for an owner (external FK targets marked) and a table's FK neighbourhood by depth, shared objects, search over tables / columns / apps, URL state round-trip with depth clamping, and a deterministic in-bounds layout.
 */

import { describe, expect, it } from 'vitest';
import {
  CORE_OWNER, appGraph, indexSnapshot, neighbourhood, parseViewState, searchModel, serializeViewState, sharedObjects, tableGraph,
} from '../../src/pages/data-model/js/model-index.js';
import { layoutGraph } from '../../src/pages/data-model/js/layout.js';

const rel = (name: string, owners: string[], fks: Array<[string, string]> = [], cols = ['id']) => ({
  name, kind: 'table', owners, columns: cols.map((c) => ({ name: c })), primaryKey: ['id'], uniques: [],
  foreignKeys: fks.map(([col, ref]) => ({ columns: [col], refTable: ref, refColumns: ['id'] })),
});
const snap = {
  database: 'oshal',
  tables: [
    rel('tickets', [CORE_OWNER]), rel('work_items', [CORE_OWNER], [['ticket_id', 'tickets']]),
    rel('audit', [CORE_OWNER], [['item_id', 'work_items']]),
    rel('shop_items', ['shop'], [['ticket_id', 'tickets']], ['id', 'sku_code']),
    rel('shared_orders', [CORE_OWNER, 'shop']),
  ],
  views: [],
  apps: [
    { name: CORE_OWNER, displayName: 'oshal core', kind: 'core', tables: ['tickets', 'work_items', 'audit', 'shared_orders'], views: [] },
    { name: 'shop', displayName: 'Shop', kind: 'app', tables: ['shop_items', 'shared_orders'], views: [] },
    { name: 'lonely', displayName: 'Lonely', kind: 'app', tables: [], views: [] },
    { name: 'office', displayName: 'Office', kind: 'app', tables: [], views: [] },
  ],
  integrations: [
    { from: CORE_OWNER, to: 'shop', kind: 'shared-table', label: 'shared_orders' },
    { from: 'shop', to: CORE_OWNER, kind: 'foreign-key', label: 'shop_items → tickets' },
    { from: 'office', to: 'shop', kind: 'artifact', label: 'image/png' },
  ],
  unowned: [], declaredAbsent: [], sqlite: [], generatedAt: '2026-09-13T00:00:00Z',
};
const index = indexSnapshot(snap);

describe('appGraph', () => {
  it('hides apps with no links and no tables unless asked', () => {
    expect(appGraph(snap).nodes.map((n: any) => n.id)).toEqual([CORE_OWNER, 'shop', 'office']);
    expect(appGraph(snap, { showIsolated: true }).nodes.map((n: any) => n.id)).toContain('lonely');
  });

  it('filters by link kind and drops edges whose ends are hidden', () => {
    const g = appGraph(snap, { kinds: ['artifact'] });
    expect(g.edges).toEqual([{ source: 'office', target: 'shop', kind: 'artifact', label: 'image/png' }]);
  });
});

describe('tableGraph and neighbourhood', () => {
  it('draws an owner\'s relations and marks the tables its FKs reach as external', () => {
    const g = tableGraph(index, { owner: 'shop' });
    expect(g.nodes.map((n: any) => `${n.id}${n.external ? '*' : ''}${n.shared ? '+' : ''}`).sort()).toEqual(['shared_orders+', 'shop_items', 'tickets*']);
    expect(g.edges).toEqual([{ source: 'shop_items', target: 'tickets', kind: 'foreign-key', label: 'ticket_id' }]);
  });

  it('walks the FK neighbourhood in both directions to the requested depth', () => {
    expect([...neighbourhood(index, 'work_items', 1)].sort()).toEqual(['audit', 'tickets', 'work_items']);
    expect([...neighbourhood(index, 'audit', 2)].sort()).toEqual(['audit', 'tickets', 'work_items']);
    expect([...neighbourhood(index, 'audit', 3)].sort()).toEqual(['audit', 'shop_items', 'tickets', 'work_items']);
    expect(tableGraph(index, { focus: 'audit', depth: 1 }).nodes.every((n: any) => !n.external)).toBe(true);
  });
});

describe('shared objects and search', () => {
  it('lists tables with several owners and FKs that cross owners', () => {
    const { sharedTables, crossFks } = sharedObjects(snap);
    expect(sharedTables).toEqual([{ name: 'shared_orders', owners: [CORE_OWNER, 'shop'] }]);
    expect(crossFks).toEqual([{ table: 'shop_items', columns: ['ticket_id'], refTable: 'tickets', from: ['shop'], to: [CORE_OWNER] }]);
  });

  it('finds apps, tables and columns', () => {
    expect(searchModel(index, 'shop').map((r: any) => `${r.type}:${r.name}`)).toEqual(['app:shop', 'table:shop_items']);
    expect(searchModel(index, 'sku')[0]).toMatchObject({ name: 'shop_items', detail: 'column sku_code' });
    expect(searchModel(index, '  ')).toEqual([]);
  });
});

describe('view state and layout', () => {
  it('round-trips URL state and clamps depth', () => {
    const state = parseViewState('?view=tables&app=shop&table=shop_items&focus=shop_items&depth=9');
    expect(state).toEqual({ view: 'tables', app: 'shop', table: 'shop_items', focus: 'shop_items', depth: 3, q: '' });
    expect(parseViewState(serializeViewState(state))).toEqual(state);
    expect(parseViewState('?view=bogus').view).toBe('apps');
  });

  it('lays the same graph out identically, inside the canvas', () => {
    const g = tableGraph(index, { owner: CORE_OWNER });
    const a = layoutGraph(g.nodes, g.edges, { width: 800, height: 600 });
    const b = layoutGraph(g.nodes, g.edges, { width: 800, height: 600 });
    expect([...a.entries()]).toEqual([...b.entries()]);
    for (const p of a.values()) { expect(p.x).toBeGreaterThanOrEqual(20); expect(p.x).toBeLessThanOrEqual(780); expect(p.y).toBeGreaterThanOrEqual(20); expect(p.y).toBeLessThanOrEqual(580); }
  });
});
