/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Data-model explorer integration-map guards: MIME overlap, every declared edge kind (integration offers, dependencies, group members from toolbar + setup, artifact Send-to flows by type), no self edges, edges to apps that are not installed dropped, labels aggregated per (from, to, kind), and the core / app nodes built from ownership.
 */

import { describe, expect, it } from 'vitest';
import { CORE_OWNER, aggregateEdges, buildIntegrationMap, mimeOverlap, type AppRecordLite, type OwnershipResult } from '@/features/data-model';

const rec = (name: string, manifest: Record<string, unknown>): AppRecordLite => ({ name, displayName: `${name} app`, version: '1.0.0', status: 'active', manifestPath: `/apps/${name}/oshal-app.yaml`, manifest });
const table = (name: string, owners: string[]) => ({
  name, kind: 'table' as const, comment: null, rls: true, forced: true, policies: [], columns: [], primaryKey: [], foreignKeys: [], uniques: [],
  hypertable: null, materialized: false, source: 'catalog' as const, database: 'oshal', owners, definers: {}, access: { state: 'forced' as const, scopes: [], ownerColumns: [] },
});
const own: OwnershipResult = {
  tables: [table('tickets', [CORE_OWNER]), table('portraits', ['studio']), table('shared_orders', [CORE_OWNER, 'shop'])],
  views: [], declaredAbsent: [], unowned: [],
  sqlite: [{ ...table('corpus', ['career']), owner: 'career', files: ['engine/db.py'], engine: 'sqlite', source: 'parsed' }] as unknown as OwnershipResult['sqlite'],
};

describe('mimeOverlap', () => {
  it('matches exact types and wildcards on either side', () => {
    expect(mimeOverlap('image/png', 'image/*')).toBe(true);
    expect(mimeOverlap('image/*', 'image/jpeg')).toBe(true);
    expect(mimeOverlap('application/pdf', '*/*')).toBe(true);
    expect(mimeOverlap('image/png', 'application/pdf')).toBe(false);
    expect(mimeOverlap('image/png', 'image/jpeg')).toBe(false);
  });
});

describe('buildIntegrationMap', () => {
  const recs = [
    rec('studio', { uses: ['deck-generation'], ragCollections: ['studio-*'], migrations: ['m/1.sql'], routes: [{ mountPath: '/api/studio' }], artifacts: { provides: [{ types: ['image/png'] }], accepts: [{ id: 'self', types: ['image/*'] }] } }),
    rec('office', { artifacts: { accepts: [{ id: 'insert', types: ['image/*', 'application/pdf'] }] }, integrations: { offers: [{ id: 'o1', label: 'Draft a deck', targetApp: 'studio', targetAction: 'draft', contextType: 'deck', version: 1 }, { id: 'o2', label: 'Ghost', targetApp: 'not-installed', targetAction: 'x', contextType: 'y', version: 1 }] } }),
    rec('bundle', { kind: 'group', toolbar: [{ app: 'studio', surface: 'home' }, { app: 'office', surface: 'home' }], setup: [{ label: 's', app: 'office', readiness: 'r' }] }),
    rec('shop', { dependencies: { apps: ['office'] } }),
    rec('career', {}),
  ];
  const { apps, integrations } = buildIntegrationMap(recs, own, [{ from: CORE_OWNER, to: 'shop', kind: 'shared-table', label: 'shared_orders' }]);

  it('builds the core node first, then apps sorted, with tables, views and SQLite from ownership', () => {
    expect(apps.map((a) => a.name)).toEqual([CORE_OWNER, 'bundle', 'career', 'office', 'shop', 'studio']);
    expect(apps[0]).toMatchObject({ kind: 'core', tables: ['tickets', 'shared_orders'] });
    expect(apps.find((a) => a.name === 'studio')).toMatchObject({ tables: ['portraits'], uses: ['deck-generation'], ragCollections: ['studio-*'], migrations: 1, routes: ['/api/studio'] });
    expect(apps.find((a) => a.name === 'career')!.sqliteTables).toEqual(['corpus']);
    expect(apps.find((a) => a.name === 'bundle')!.kind).toBe('group');
  });

  it('draws every declared edge kind, drops self and uninstalled targets', () => {
    const lines = integrations.map((e) => `${e.from}>${e.to}:${e.kind}:${e.label}`);
    expect(lines).toEqual([
      `${CORE_OWNER}>shop:shared-table:shared_orders`,
      'bundle>office:group-member:member',
      'bundle>studio:group-member:member',
      'office>studio:context-offer:Draft a deck',
      'shop>office:dependency:depends on',
      'studio>office:artifact:image/png',
    ]);
  });
});

describe('aggregateEdges', () => {
  it('merges labels per (from, to, kind) and caps long label lists', () => {
    const raw = Array.from({ length: 15 }, (_, i) => ({ from: 'a', to: 'b', kind: 'shared-table' as const, label: `t${String(i).padStart(2, '0')}` }));
    const [edge] = aggregateEdges([...raw, { from: 'a', to: 'b', kind: 'shared-table', label: 't00' }]);
    expect(edge.label.startsWith('t00, t01')).toBe(true);
    expect(edge.label.endsWith('(+3 more)')).toBe(true);
  });
});
