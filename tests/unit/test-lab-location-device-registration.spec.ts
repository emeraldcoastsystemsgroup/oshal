/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-169 L6 location device card is registered exactly once with suites that exist on disk, and its two steps run for real against the localhost MOCK_OIDC fixture server with the real CLI-token middleware (the bearer option) and a private PostgreSQL owned by the enforcing runtime role: the route step (which leaves the signed-in person's devices as it found them) and the synthetic-people lifecycle (which drives the real ingest over the loopback under a real credential and leaves no row behind: no credential, device, fix, place, group or membership) both pass. Each goes red when what it checks is broken: an ingest that admits a browser session, a device-subject insert policy that is gone (the drone's fix is refused), and a device delete that row-level security turns into a no-op (the cleanup's zero-row check catches the leftover). A run without the server grades as a gap.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_DEVICE_SCENARIOS } from '@/app/routes/test-lab-location-device-scenarios';
import { MOCK_SUB_HEADER, countRows, startLocationBrowserServer, type LocationBrowserServer } from '../helpers/location-browser-server';

let fx: LocationBrowserServer;
const [card] = LOCATION_DEVICE_SCENARIOS;
const [routes, lifecycle] = card.steps;
/** The fixture's mock sign-in reads the person from a header; the Lab passes its cookie through the same header slot here. */
const COOKIE = 'lab=1';
const runtime = (base?: string): ScenarioRunContext =>
  ({ ctx: { pool: fx.runtime } as never, ownerSub: 'mock-user-001', issuer: 'urn:oshal:mock-oidc', apiBaseUrl: base ?? fx.base });
const MIGRATION_178 = readFileSync('scripts/migrations/178-location-device-credentials.sql', 'utf8');

/** One CREATE POLICY statement, verbatim from migration 178 (to restore it after a mutation). */
function originalPolicy(name: string): string {
  const start = MIGRATION_178.indexOf(`CREATE POLICY ${name} `);
  const end = MIGRATION_178.indexOf(';', start) + 1;
  return MIGRATION_178.slice(start, end);
}

/** Every row the lifecycle could leave behind, counted as the superuser (past row-level security). */
async function syntheticRows(): Promise<number> {
  const counts = await Promise.all([
    countRows(fx, "location_devices WHERE device_ref LIKE 'lab-%'"),
    countRows(fx, "location_observations o WHERE EXISTS (SELECT 1 FROM oshal_tenants t WHERE t.tenant_id = o.tenant_id AND t.created_by_sub LIKE 'test-lab-location-l6-%')"),
    countRows(fx, "location_places WHERE created_by_sub LIKE 'test-lab-location-l6-%'"),
    countRows(fx, "oshal_tenants WHERE created_by_sub LIKE 'test-lab-location-l6-%'"),
    countRows(fx, "oshal_tenant_memberships WHERE user_sub LIKE 'test-lab-location-l6-%'"),
    countRows(fx, "oshal_cli_tokens WHERE user_sub LIKE 'test-lab-location-l6-%'"),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

beforeAll(async () => { fx = await startLocationBrowserServer('test-lab-location-device', [], { bearer: true }); }, 180_000);
afterAll(async () => { await fx?.close(); }, 60_000);

describe('ADR-169 L6 location device Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === card.id)).toEqual([card]);
    expect(card.steps.map((s) => s.id)).toEqual(['device-routes', 'device-lifecycle']);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes both steps and leaves nothing behind', async () => {
    const first = await routes.run(COOKIE, {}, runtime());
    expect(first.state, first.detail).toBe('pass');
    expect(first.detail).toContain('5 checks hold');
    expect(await countRows(fx, 'location_devices') + await countRows(fx, 'oshal_cli_tokens')).toBe(0);
    const second = await lifecycle.run(COOKIE, {}, runtime());
    expect(second.state, second.detail).toBe('pass');
    expect(second.detail).toContain('8 checks hold');
    expect(await syntheticRows()).toBe(0);
  });

  it('grades a run without the server as a gap, never a pass', async () => {
    expect((await routes.run('', {})).state).toBe('gap');
    expect((await lifecycle.run('', {})).state).toBe('gap');
  });
});

describe('ADR-169 L6 location device Test Lab card: red when broken', () => {
  it('the route step fails when the ingest admits a browser session', async () => {
    const open = express();
    open.use(express.json());
    open.get('/api/location/devices', (_req, res) => { res.json({ devices: [], nodes: [], groups: [], credentialKinds: ['drone'] }); });
    open.post('/api/location/devices/:id/presence', (_req, res) => { res.status(201).json({ place: null }); });
    open.post('/api/location/devices/:id/credential', (_req, res) => { res.status(403).json({ error: 'step_up_required' }); });
    const server = open.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    try {
      const r = await routes.run(COOKIE, {}, runtime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('the device ingest refuses a browser session');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('the lifecycle fails when the device subject may no longer insert its fixes', async () => {
    await fx.db.pool.query('DROP POLICY location_observations_device_insert ON location_observations');
    try {
      const r = await lifecycle.run(COOKIE, {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('the drone\'s fix is accepted under its credential');
    } finally {
      await fx.db.pool.query(originalPolicy('location_observations_device_insert'));
    }
    expect(await syntheticRows()).toBe(0);
  });

  it('the lifecycle fails when its cleanup leaves a row behind', async () => {
    // The drone, its fixes and the place are the group's and go with it, so the leftover that proves the
    // zero-row check is the group itself: a restrictive policy turns the admin's tenant delete into a no-op.
    await fx.db.pool.query('CREATE POLICY lab_no_tenant_delete ON oshal_tenants AS RESTRICTIVE FOR DELETE USING (false)');
    try {
      const r = await lifecycle.run(COOKIE, {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toMatch(/Cleanup incomplete: [1-9]\d* synthetic rows remain/);
    } finally {
      await fx.db.pool.query('DROP POLICY lab_no_tenant_delete ON oshal_tenants');
      await fx.db.pool.query("DELETE FROM oshal_cli_tokens WHERE user_sub LIKE 'test-lab-location-l6-%'");
      await fx.db.pool.query("DELETE FROM oshal_tenants WHERE created_by_sub LIKE 'test-lab-location-l6-%'");
    }
    expect(await syntheticRows()).toBe(0);
  });
});

describe('the fixture cookie slot', () => {
  it('names the mock header the route step signs in with', () => {
    expect(MOCK_SUB_HEADER).toBe('x-mock-oidc-sub');
  });
});
