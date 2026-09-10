/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | Codex | Exercise default-on display choices, source identity, safe highlights, and preference route ownership.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createAppHomePreferenceRoutes, parseHomePreferences } from '@/app/routes/app-home-preferences';
import { readManifest, buildHomePlan } from '@/features/swarm-apps';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const model = () => import('@/pages/cockpit/js/views/app-home-model.js' as any);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });

describe('Home source contract and display preferences', () => {
  it('accepts catalog declarations and retains the owning surfaces in the plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-catalog-'));
    try {
      const file = join(dir, 'oshal-app.yaml');
      writeFileSync(file, 'name: example\ndisplayName: Example\nroutes:\n  - {module: routes/app.js, factory: createApp, mountPath: /api/example, auth: oidc}\nsummary:\n  path: /api/example/summary\n  metricsPointer: /metrics\nui:\n  static:\n    - {toolName: example-home, label: Example, iframeUrl: /api/example}\n');
      const [plan] = buildHomePlan([readManifest(file)]);
      expect(plan.summary[0]).toMatchObject({ metricsPointer: '/metrics', surfaces: ['example-home'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps choices stable across renamed labels and turns new metrics on', async () => {
    const { catalog, selected } = await model();
    const tiles = catalog([{ id: 'saved', label: 'Renamed', value: '7' }, { id: 'new', label: 'New', value: '4' }], 'identity');
    const data = { tiles, items: [], open: [], total: 0 };
    expect(selected(data, { hiddenMetrics: ['identity/saved'] }).tiles.map((t: any) => t.id)).toEqual(['identity/new']);
    expect(selected(data).tiles).toHaveLength(2);
    const optional = { ...data, tiles: [{ id: 'a/optional', defaultVisible: false }] };
    expect(selected(optional, { metricOrder: ['a/optional'] }).tiles).toEqual([]);
    expect(selected(optional, { shownMetrics: ['a/optional'] }).tiles).toHaveLength(1);
    expect(catalog([{ id: 'x', label: 'x', value: 1 }], 'a')).toEqual([]);
    expect(catalog([{ id: 'x', label: 'x', value: '1' }, { id: 'x', label: 'other', value: '2' }], 'a')).toEqual([]);
  });

  it('orders new apps after saved apps and bounds movement', async () => {
    const { ordered, move } = await model();
    expect(ordered([{ id: 'new' }, { id: 'a' }, { id: 'b' }], ['b', 'a']).map((x: any) => x.id)).toEqual(['b', 'a', 'new']);
    expect(move(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(move(['a', 'b'], 'a', 1)).toEqual(['b', 'a']);
  });

  it('does not promote hidden metrics or updates into highlights', async () => {
    const { highlights } = await model();
    const entries = [{ name: 'a', displayName: 'A', firstSurface: 'a-home' }];
    const cards = new Map([['a', { tiles: [{ id: 'a/risk', label: 'Risk', value: '2', tone: 'warn' }], items: [{ text: 'Update', tone: 'neutral' }], open: [], total: 0 }]]);
    expect(highlights(entries, cards, { cards: { a: { hiddenMetrics: ['a/risk'], showItems: false } } })).toEqual([]);
    expect(highlights(entries, cards, {})[0]).toMatchObject({ text: 'Risk: 2', fix: 'a-home' });
    cards.get('a')!.items = [{ text: 'Same risk in prose', tone: 'warn', metricId: 'a/risk' } as any];
    expect(highlights(entries, cards, { cards: { a: { hiddenMetrics: ['a/risk'] } } })).toEqual([]);
  });

  it('reports partial failure and removes unowned fix destinations in actual card loading', async () => {
    const { AppsHomeView } = await import('@/pages/cockpit/js/views/AppsHomeView.js' as any);
    const view = new AppsHomeView(); view.cards = new Map();
    const entry = { name: 'a', displayName: 'A', kind: 'app', todos: [], summary: [{ app: 'a', path: '/a', metricsPointer: '/missing', itemsPointer: '/items', surfaces: ['a-home'] }] };
    const html = await view.loadCard(entry, new Map(), new Map([['/a', { ok: true, body: { items: [{ text: '<script>', fix: 'other-secret-surface' }] } }]]));
    expect(html).toContain('cannot be checked');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('other-secret-surface');
  });

  it('rejects unknown fields, wrong switches, excessive ids and prototype keys', () => {
    expect(parseHomePreferences({ version: 1 })).toEqual({ version: 1 });
    for (const bad of [{ version: 1, userSub: 'victim' }, { version: 1, cards: { a: { compact: 'yes' } } }, { version: 1, hiddenApps: Array(257).fill('a') }, JSON.parse('{"version":1,"cards":{"__proto__":{}}}')]) {
      expect(() => parseHomePreferences(bad)).toThrow();
    }
  });
});

describe('Home preference HTTP boundary', () => {
  async function start(pool: any, authenticated = true) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).oidc = { isAuthenticated: () => authenticated, user: { sub: 'exact-Subject' } }; next(); });
    app.use('/prefs', createAppHomePreferenceRoutes({ pool } as any));
    const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as any).port}/prefs`;
  }

  it('uses session ownership, rejects unauthenticated calls, and surfaces revision conflicts', async () => {
    const calls: any[] = [];
    const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [] }; } };
    const url = await start(pool);
    const loaded = await (await fetch(url + '?userSub=victim')).json();
    expect(loaded).toEqual({ preferences: { version: 1 }, revision: 0 });
    expect(calls[0].params).toEqual(['exact-Subject']);
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: { version: 1 }, revision: 0, userSub: 'victim' }) });
    expect(response.status).toBe(409);
    expect(calls[1].params[0]).toBe('exact-Subject');
    const unauth = await start(pool, false);
    expect((await fetch(unauth)).status).toBe(401);
    expect(calls).toHaveLength(2);
  });

  it('does not return successful empty settings on a database failure', async () => {
    const url = await start({ query: async () => { throw new Error('offline'); } });
    expect((await fetch(url)).status).toBe(503);
    const invalid = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: { version: 1 }, revision: -1 }) });
    expect(invalid.status).toBe(400);
  });
});
