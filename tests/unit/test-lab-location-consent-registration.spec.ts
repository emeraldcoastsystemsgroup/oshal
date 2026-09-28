/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-169 L3 location consent card is registered exactly once with suites that exist on disk, and its three steps run for real against the localhost MOCK_OIDC fixture server (the real /api/location mount) and a private PostgreSQL owned by the enforcing runtime role: the service rail step, the step-up gate step (which leaves the signed-in person's devices, shares and open challenges as it found them) and the synthetic-person lifecycle (which leaves no row behind) all pass; each goes red when the thing it checks is broken (the rail refusal unmounted, a gated route admitted without a proof, the erase unable to remove the synthetic rows); and a run without the server grades as a gap.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import express from 'express';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_CONSENT_SCENARIOS } from '@/app/routes/test-lab-location-consent-scenarios';
import { countRows, startLocationBrowserServer, type LocationBrowserServer } from '../helpers/location-browser-server';

let fx: LocationBrowserServer;
const [card] = LOCATION_CONSENT_SCENARIOS;
const [rail, gate, lifecycle] = card.steps;
const runtime = (base?: string): ScenarioRunContext =>
  ({ ctx: { pool: fx.runtime } as never, ownerSub: 'mock-user-001', issuer: 'urn:oshal:mock-oidc', apiBaseUrl: base ?? fx.base });

beforeAll(async () => { fx = await startLocationBrowserServer('test-lab-location-consent'); }, 180_000);
afterAll(async () => { await fx?.close(); }, 60_000);

describe('ADR-169 L3 location consent Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === card.id)).toEqual([card]);
    expect(card.steps.map((s) => s.id)).toEqual(['service-rail-refused', 'step-up-gate', 'consent-lifecycle']);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes all three steps and leaves nothing behind', async () => {
    const first = await rail.run('', {}, runtime());
    expect(first.state, first.detail).toBe('pass');
    const second = await gate.run('lab=1', {}, runtime());
    expect(second.state, second.detail).toBe('pass');
    expect(second.detail).toContain('6 checks hold');
    expect(fx.store.size()).toBe(0);
    const third = await lifecycle.run('', {}, runtime());
    expect(third.state, third.detail).toBe('pass');
    expect(third.detail).toContain('6 checks hold');
    for (const table of ['location_observations', 'location_current', 'location_devices', 'location_places', 'location_settings', 'location_shares']) {
      expect(await countRows(fx, table), table).toBe(0);
    }
  });

  it('grades a run without the server as a gap, never a pass', async () => {
    expect((await rail.run('', {})).state).toBe('gap');
    expect((await gate.run('', {})).state).toBe('gap');
    expect((await lifecycle.run('', {})).state).toBe('gap');
  });
});

describe('ADR-169 L3 location consent Test Lab card: red when broken', () => {
  it('the rail step fails when the route answers the service rail with anything but 401', async () => {
    const open = express();
    open.post('/api/location/presence', (_req, res) => { res.status(201).json({ accepted: true }); });
    const server = open.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    try {
      const r = await rail.run('', {}, runtime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('HTTP 201');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('the gate step fails when a gated route is admitted without a proof', async () => {
    const original = fx.store.consume.bind(fx.store);
    fx.store.consume = () => ({ ok: true });
    try {
      const r = await gate.run('lab=1', {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('opt-in with an unproven challenge is refused');
    } finally {
      fx.store.consume = original;
      await fx.db.pool.query('DELETE FROM location_devices');
    }
  });

  it('the lifecycle step fails when the synthetic rows cannot be erased', async () => {
    await fx.db.pool.query('CREATE OR REPLACE RULE keep_places AS ON DELETE TO location_places DO INSTEAD NOTHING');
    try {
      const r = await lifecycle.run('', {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toMatch(/Cleanup incomplete: 1 synthetic rows remain/);
    } finally {
      await fx.db.pool.query('DROP RULE keep_places ON location_places');
      await fx.db.pool.query('DELETE FROM location_places');
    }
  });
});
