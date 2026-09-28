/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-169 L2 location storage card is registered exactly once with suites that exist on disk, and both of its steps run for real against a private PostgreSQL carrying the shipped migrations, connected as the NOSUPERUSER NOBYPASSRLS runtime role that owns the tables: the posture step passes, and goes red naming the table when FORCE is dropped and naming the policy when a bypass is planted; the probe passes, leaves no row behind, and fails naming the check when the fence trigger is gone. A connection that bypasses row-level security, and a run without the server pool, grade as gaps rather than passes.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { existsSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_STORAGE_SCENARIOS } from '@/app/routes/test-lab-location-storage-scenarios';
import { convergeAppRole, locationDatabase } from '../helpers/location-postgres-fixture';

const db = locationDatabase('test-lab-location-storage');
let app: Pool;
const [card] = LOCATION_STORAGE_SCENARIOS;
const [posture, probe] = card.steps;
const runtimeFor = (pool: Pool): ScenarioRunContext => ({ ctx: { pool } as never, ownerSub: 'test-lab-owner', issuer: null, apiBaseUrl: '' });

beforeAll(async () => {
  await db.start();
  app = await convergeAppRole(db);
}, 180_000);
afterAll(async () => { await db.stop(); });

describe('ADR-169 L2 location storage Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === card.id)).toEqual([card]);
    expect(card.steps.map((s) => s.id)).toEqual(['rls-posture', 'two-identity-probe']);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(card.explicitOnly).toBeUndefined();
  });

  it('passes both steps on the enforcing role and leaves no probe row behind', async () => {
    const first = await posture.run('', {}, runtimeFor(app));
    expect(first.state, first.detail).toBe('pass');
    const second = await probe.run('', {}, runtimeFor(app));
    expect(second.state, second.detail).toBe('pass');
    expect(second.detail).toContain('6 checks hold');
    const left = await db.pool.query("SELECT (SELECT count(*) FROM location_observations) + (SELECT count(*) FROM oshal_tenants) AS n");
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it('goes red naming the table when FORCE is dropped, and naming the policy when a bypass is planted', async () => {
    await db.pool.query('ALTER TABLE location_current NO FORCE ROW LEVEL SECURITY');
    try {
      const r = await posture.run('', {}, runtimeFor(app));
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('location_current');
    } finally {
      await db.pool.query('ALTER TABLE location_current FORCE ROW LEVEL SECURITY');
    }
    await db.pool.query("CREATE POLICY planted ON location_places FOR SELECT USING (current_setting('oshal.is_operator', true) = 'on')");
    try {
      const r = await posture.run('', {}, runtimeFor(app));
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('policy location_places.planted');
    } finally {
      await db.pool.query('DROP POLICY planted ON location_places');
    }
  });

});

describe('ADR-169 L2 location storage Test Lab card: red and gap grading', () => {
  it('fails the probe naming the check when the membership fence is gone', async () => {
    await db.pool.query('ALTER TABLE oshal_tenant_memberships DISABLE TRIGGER oshal_tenant_membership_fence');
    try {
      const r = await probe.run('', {}, runtimeFor(app));
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('an operator-stamped session cannot add itself to a group');
    } finally {
      await db.pool.query('ALTER TABLE oshal_tenant_memberships ENABLE TRIGGER oshal_tenant_membership_fence');
    }
  });

  it('grades a bypassing connection and a missing server pool as gaps, never passes', async () => {
    expect((await posture.run('', {}, runtimeFor(db.pool))).state).toBe('gap');
    expect((await probe.run('', {}, runtimeFor(db.pool))).state).toBe('gap');
    expect((await posture.run('', {})).state).toBe('gap');
    expect((await probe.run('', {})).state).toBe('gap');
  });
});
