/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-169 L4 location places card is registered exactly once with suites that exist on disk, and its two steps run for real against the localhost MOCK_OIDC fixture server (the real /api/location mount) and a private PostgreSQL owned by the enforcing runtime role: the route step (which leaves the signed-in person's places and devices as it found them) and the synthetic-people lifecycle (which leaves no row behind: no device, place, group, membership or node binding) both pass. Each goes red when what it checks is broken: a route that admits a camera with no group, a writable-row predicate that lets a group member change the group camera, and a place delete that row-level security silently turns into a no-op (the cleanup's zero-row check catches the leftover). A run without the server grades as a gap.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_PLACES_SCENARIOS } from '@/app/routes/test-lab-location-places-scenarios';
import { countRows, startLocationBrowserServer, type LocationBrowserServer } from '../helpers/location-browser-server';

let fx: LocationBrowserServer;
const [card] = LOCATION_PLACES_SCENARIOS;
const [routes, lifecycle] = card.steps;
const runtime = (base?: string): ScenarioRunContext =>
  ({ ctx: { pool: fx.runtime } as never, ownerSub: 'mock-user-001', issuer: 'urn:oshal:mock-oidc', apiBaseUrl: base ?? fx.base });
const MIGRATION_175 = readFileSync('scripts/migrations/175-location-storage.sql', 'utf8');

/** The CREATE FUNCTION statement for one helper, verbatim from migration 175 (to restore it after a mutation). */
function originalFunction(name: string): string {
  const start = MIGRATION_175.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = MIGRATION_175.indexOf('$$;', MIGRATION_175.indexOf('AS $$', start)) + 3;
  return MIGRATION_175.slice(start, end);
}

/** Every row the lifecycle could leave behind, counted as the superuser (past row-level security). */
async function syntheticRows(): Promise<number> {
  const counts = await Promise.all([
    countRows(fx, "location_devices WHERE owner_sub LIKE 'test-lab-location-l4-%' OR device_ref LIKE 'test-lab-node-%' OR device_ref LIKE 'lab-%'"),
    countRows(fx, "location_places WHERE owner_sub LIKE 'test-lab-location-l4-%' OR created_by_sub LIKE 'test-lab-location-l4-%'"),
    countRows(fx, "oshal_tenants WHERE created_by_sub LIKE 'test-lab-location-l4-%'"),
    countRows(fx, "oshal_tenant_memberships WHERE user_sub LIKE 'test-lab-location-l4-%'"),
    countRows(fx, "remote_task_journal_client_owners WHERE client_id LIKE 'test-lab-node-%'"),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

beforeAll(async () => { fx = await startLocationBrowserServer('test-lab-location-places'); }, 180_000);
afterAll(async () => { await fx?.close(); }, 60_000);

describe('ADR-169 L4 location places Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === card.id)).toEqual([card]);
    expect(card.steps.map((s) => s.id)).toEqual(['place-routes', 'places-lifecycle']);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes both steps and leaves nothing behind', async () => {
    const first = await routes.run('lab=1', {}, runtime());
    expect(first.state, first.detail).toBe('pass');
    expect(first.detail).toContain('5 checks hold');
    expect(await countRows(fx, 'location_places') + await countRows(fx, 'location_devices')).toBe(0);
    const second = await lifecycle.run('', {}, runtime());
    expect(second.state, second.detail).toBe('pass');
    expect(second.detail).toContain('8 checks hold');
    expect(await syntheticRows()).toBe(0);
  });

  it('grades a run without the server as a gap, never a pass', async () => {
    expect((await routes.run('', {})).state).toBe('gap');
    expect((await lifecycle.run('', {})).state).toBe('gap');
  });
});

describe('ADR-169 L4 location places Test Lab card: red when broken', () => {
  it('the route step fails when a camera with no group is admitted', async () => {
    const open = express();
    open.use(express.json());
    open.get('/api/location/places', (_req, res) => { res.json({ places: [], groups: [] }); });
    open.get('/api/location/devices', (_req, res) => { res.json({ devices: [], nodes: [], groups: [] }); });
    open.post('/api/location/devices', (_req, res) => { res.status(201).json({ device: {} }); });
    open.post('/api/location/places', (_req, res) => { res.status(403).json({ error: 'group_admin_required' }); });
    const server = open.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    try {
      const r = await routes.run('lab=1', {}, runtime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('a camera with no group is refused');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('the lifecycle fails when a group member can change the group camera', async () => {
    await fx.db.pool.query(`CREATE OR REPLACE FUNCTION location_row_writable(p_owner_sub text, p_issuer text, p_tenant uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`);
    try {
      const r = await lifecycle.run('', {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('a member cannot change the group camera');
    } finally {
      await fx.db.pool.query(originalFunction('location_row_writable'));
    }
    expect(await syntheticRows()).toBe(0);
  });

  it('the lifecycle fails when its cleanup leaves a row behind', async () => {
    await fx.db.pool.query('DROP POLICY location_places_delete ON location_places');
    try {
      const r = await lifecycle.run('', {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toMatch(/Cleanup incomplete: [1-9]\d* synthetic rows remain/);
    } finally {
      await fx.db.pool.query(`CREATE POLICY location_places_delete ON location_places AS PERMISSIVE FOR DELETE
        USING (location_row_writable(owner_sub, principal_issuer, tenant_id))`);
      await fx.db.pool.query("DELETE FROM location_places WHERE owner_sub LIKE 'test-lab-location-l4-%'");
    }
    expect(await syntheticRows()).toBe(0);
  });
});
