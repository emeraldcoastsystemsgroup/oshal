/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-169 L5 location reminders card is registered exactly once with suites that exist on disk, and its two steps run for real against the localhost MOCK_OIDC fixture server (the real /api/location mount) and a private PostgreSQL owned by the enforcing runtime role, with the Jarvis shelf table applied so the production shelf rail has somewhere to write: the route step (which leaves the signed-in person's rules as it found them) and the synthetic-people lifecycle (which leaves no row behind: no rule, state, fire, share, presence, observation, device, place, membership, group or shelf row) both pass. Each goes red when what it checks is broken: a route that accepts a restricted invitation without a proof, and an evaluability predicate that admits a member who never shared (the lifecycle's "never evaluated" check catches it). A run without the server grades as a gap.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_REMINDERS_SCENARIOS } from '@/app/routes/test-lab-location-reminders-scenarios';
import { countRows, startLocationBrowserServer, type LocationBrowserServer } from '../helpers/location-browser-server';

let fx: LocationBrowserServer;
const [card] = LOCATION_REMINDERS_SCENARIOS;
const [routes, lifecycle] = card.steps;
const runtime = (base?: string): ScenarioRunContext =>
  ({ ctx: { pool: fx.runtime } as never, ownerSub: 'mock-user-001', issuer: 'urn:oshal:mock-oidc', apiBaseUrl: base ?? fx.base });
const MIGRATION_177 = readFileSync('scripts/migrations/177-location-rules-and-shares.sql', 'utf8');

/** The CREATE FUNCTION statement for one helper, verbatim from migration 177 (to restore it after a mutation). */
function originalFunction(name: string): string {
  const start = MIGRATION_177.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = MIGRATION_177.indexOf('$$;', MIGRATION_177.indexOf('AS $$', start)) + 3;
  return MIGRATION_177.slice(start, end);
}

/** Every row the lifecycle could leave behind, counted as the superuser (past row-level security). */
async function syntheticRows(): Promise<number> {
  const like = "LIKE 'test-lab-location-l5-%'";
  const counts = await Promise.all([
    countRows(fx, `location_rules WHERE owner_sub ${like} OR armed_by_sub ${like}`),
    countRows(fx, `location_rule_state WHERE owner_sub ${like}`),
    countRows(fx, `location_rule_fires WHERE owner_sub ${like} OR actor_sub ${like}`),
    countRows(fx, `location_share_presence WHERE owner_sub ${like}`),
    countRows(fx, `location_shares WHERE owner_sub ${like}`),
    countRows(fx, `location_observations WHERE owner_sub ${like}`),
    countRows(fx, `location_current WHERE owner_sub ${like}`),
    countRows(fx, `location_devices WHERE owner_sub ${like}`),
    countRows(fx, `location_places WHERE owner_sub ${like} OR created_by_sub ${like}`),
    countRows(fx, `oshal_tenants WHERE created_by_sub ${like}`),
    countRows(fx, `oshal_tenant_memberships WHERE user_sub ${like}`),
    countRows(fx, `jarvis_tasks WHERE user_sub ${like}`),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

beforeAll(async () => { fx = await startLocationBrowserServer('test-lab-location-reminders', ['100-jarvis-tasks-base-schema.sql']); }, 180_000);
afterAll(async () => { await fx?.close(); }, 60_000);

describe('ADR-169 L5 location reminders Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === card.id)).toEqual([card]);
    expect(card.steps.map((s) => s.id)).toEqual(['reminder-routes', 'reminders-lifecycle']);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes both steps and leaves nothing behind', async () => {
    const first = await routes.run('lab=1', {}, runtime());
    expect(first.state, first.detail).toBe('pass');
    expect(first.detail).toContain('5 checks hold');
    expect(await countRows(fx, 'location_rules')).toBe(0);
    const second = await lifecycle.run('', {}, runtime());
    expect(second.state, second.detail).toBe('pass');
    expect(second.detail).toContain('14 checks hold');
    expect(await syntheticRows()).toBe(0);
  });

  it('grades a run without the server as a gap, never a pass', async () => {
    expect((await routes.run('', {})).state).toBe('gap');
    expect((await lifecycle.run('', {})).state).toBe('gap');
  });
});

describe('ADR-169 L5 location reminders Test Lab card: red when broken', () => {
  it('the route step fails when a restricted invitation is accepted without a proof', async () => {
    const open = express();
    open.use(express.json());
    for (const p of ['/rules', '/fires', '/shared', '/group-sharing']) open.get(`/api/location${p}`, (_req, res) => { res.json({ mine: [], group: [], fires: [], shared: [] }); });
    open.post('/api/location/invites/:inviteId/accept', (_req, res) => { res.json({ groupId: 'x', restricted: true }); });
    open.post('/api/location/guardian-shares', (_req, res) => { res.status(403).json({ error: 'step_up_required' }); });
    open.post('/api/location/rules', (_req, res) => { res.status(404).json({ error: 'place_not_found' }); });
    const server = open.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    try {
      const r = await routes.run('lab=1', {}, runtime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('accepting a restricted invitation is refused without a fresh sign-in');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('the lifecycle fails when a group rule evaluates a member who never shared', async () => {
    await fx.db.pool.query(`CREATE OR REPLACE FUNCTION location_session_shares_place(p_tenant uuid, p_place uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
         AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m WHERE m.tenant_id = p_tenant AND m.user_sub = current_setting('oshal.current_sub', true)) $$`);
    try {
      const r = await lifecycle.run('', {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('the member who did not share is never evaluated');
    } finally {
      await fx.db.pool.query(originalFunction('location_session_shares_place'));
    }
    expect(await syntheticRows()).toBe(0);
  });
});
