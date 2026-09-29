/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-169 L7 location map card is registered exactly once with suites that exist on disk, and its two steps run for real against a private PostgreSQL owned by the enforcing runtime role and a temporary scans root: the catalog posture passes, and the synthetic-people lifecycle passes and leaves nothing behind (no scan, anchor, place, group, membership or capture sidecar). Each goes red when what it checks is broken: a group fence that is missing, a group fence recreated as a permissive policy, a group policy that names the operator flag, a missing trigger; a lifecycle on a database whose fence no longer restricts (an operator-stamped stranger then reads a group's scans); and a cleanup that row-level security turns into a no-op. A run without the server grades as a gap.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_MAP_SCENARIOS, gradeMapPosture, type MapPosture } from '@/app/routes/test-lab-location-map-scenarios';
import { convergeAppRole, locationDatabase } from '../helpers/location-postgres-fixture';

const db = locationDatabase('test-lab-location-map');
const [card] = LOCATION_MAP_SCENARIOS;
const [posture, lifecycle] = card.steps;
const MIGRATION_179 = readFileSync('scripts/migrations/179-location-map-anchors.sql', 'utf8');
const savedRoot = process.env.OSHAL_SPACES_ROOT;
let app: Pool;
let root = '';

const runtime = (): ScenarioRunContext =>
  ({ ctx: { pool: app } as never, ownerSub: 'mock-user-001', issuer: 'urn:oshal:mock-oidc', apiBaseUrl: 'http://127.0.0.1:0' });

/** One CREATE POLICY statement, verbatim from migration 179 (to restore it after a mutation). */
function originalPolicy(name: string): string {
  const start = MIGRATION_179.indexOf(`CREATE POLICY ${name} `);
  const end = MIGRATION_179.indexOf(';', start) + 1;
  return MIGRATION_179.slice(start, end);
}

/** Everything the lifecycle could leave behind: rows counted as the superuser, and sidecar directories. */
async function residue(): Promise<number> {
  const count = async (fromWhere: string): Promise<number> =>
    Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${fromWhere}`)).rows[0].n);
  const rows = await Promise.all([
    count("spatial_scans WHERE user_sub LIKE 'test-lab-location-l7-%'"),
    count("location_map_anchors WHERE created_by_sub LIKE 'test-lab-location-l7-%'"),
    count("location_places WHERE created_by_sub LIKE 'test-lab-location-l7-%'"),
    count("oshal_tenants WHERE created_by_sub LIKE 'test-lab-location-l7-%'"),
    count("oshal_tenant_memberships WHERE user_sub LIKE 'test-lab-location-l7-%'"),
  ]);
  return rows.reduce((a, b) => a + b, 0) + (await fs.readdir(root)).length;
}

const healthy: MapPosture = {
  columns: ['capture_session_id', 'tenant_id'],
  policies: [
    { name: 'spatial_scans_tenant_fence', permissive: false, namesOperator: false },
    { name: 'spatial_scans_tenant_member', permissive: true, namesOperator: false },
  ],
  triggers: ['location_map_anchor_scan_removed', 'spatial_scans_owner_fence'],
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'oshal-l7-lab-'));
  process.env.OSHAL_SPACES_ROOT = root;
  await db.start();
  app = await convergeAppRole(db);
}, 180_000);

afterAll(async () => {
  if (savedRoot === undefined) delete process.env.OSHAL_SPACES_ROOT; else process.env.OSHAL_SPACES_ROOT = savedRoot;
  await fs.rm(root, { recursive: true, force: true });
  await db.stop();
}, 60_000);

describe('ADR-169 L7 location map Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === card.id)).toEqual([card]);
    expect(card.steps.map((s) => s.id)).toEqual(['map-posture', 'map-lifecycle']);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes both steps and leaves nothing behind', async () => {
    const first = await posture.run('', {}, runtime());
    expect(first.state, first.detail).toBe('pass');
    const second = await lifecycle.run('', {}, runtime());
    expect(second.state, second.detail).toBe('pass');
    expect(second.detail).toContain('9 checks hold');
    expect(await residue()).toBe(0);
  });

  it('grades a run without the server as a gap, never a pass', async () => {
    expect((await posture.run('', {})).state).toBe('gap');
    expect((await lifecycle.run('', {})).state).toBe('gap');
  });
});

describe('ADR-169 L7 location map Test Lab card: red when broken', () => {
  it('grades each broken posture as a failure that names it', () => {
    const graded = (over: Partial<MapPosture>) => gradeMapPosture({ ...healthy, ...over });
    expect(gradeMapPosture(healthy).state).toBe('pass');
    expect(graded({ columns: ['tenant_id'] }).detail).toContain('migration 179 is not applied');
    expect(graded({ policies: [healthy.policies[1]] }).detail).toContain('is missing');
    expect(graded({ policies: [{ ...healthy.policies[0], permissive: true }, healthy.policies[1]] }).detail).toContain('is permissive');
    expect(graded({ policies: [healthy.policies[0], { ...healthy.policies[1], namesOperator: true }] }).detail).toContain('names the operator flag');
    expect(graded({ triggers: ['spatial_scans_owner_fence'] }).detail).toContain('location_map_anchor_scan_removed');
    for (const over of [{ columns: [] }, { policies: [] }, { triggers: [] }]) expect(graded(over).state).toBe('fail');
  });

  it('the posture step fails on a database whose group fence was recreated as permissive', async () => {
    await db.pool.query('DROP POLICY spatial_scans_tenant_fence ON spatial_scans');
    await db.pool.query(originalPolicy('spatial_scans_tenant_fence').replace('AS RESTRICTIVE', 'AS PERMISSIVE'));
    try {
      const r = await posture.run('', {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toContain('is permissive');
    } finally {
      await db.pool.query('DROP POLICY spatial_scans_tenant_fence ON spatial_scans');
      await db.pool.query(originalPolicy('spatial_scans_tenant_fence'));
    }
    expect((await posture.run('', {}, runtime())).state).toBe('pass');
  });

  it('the lifecycle fails when the group fence no longer restricts, and still cleans up', async () => {
    await db.pool.query('DROP POLICY spatial_scans_tenant_fence ON spatial_scans');
    await db.pool.query(originalPolicy('spatial_scans_tenant_fence').replace('AS RESTRICTIVE', 'AS PERMISSIVE'));
    let graded = { state: '', detail: '' };
    try {
      graded = await lifecycle.run('', {}, runtime());
    } finally {
      await db.pool.query('DROP POLICY spatial_scans_tenant_fence ON spatial_scans');
      await db.pool.query(originalPolicy('spatial_scans_tenant_fence'));
    }
    expect(graded.state).toBe('fail');
    expect(graded.detail).toContain('a stranger opens neither scan, stamped as an operator or not');
    expect(await residue()).toBe(0);
  });

  it('the lifecycle fails when its cleanup leaves a row behind', async () => {
    await db.pool.query('CREATE POLICY lab_no_tenant_delete ON oshal_tenants AS RESTRICTIVE FOR DELETE USING (false)');
    try {
      const r = await lifecycle.run('', {}, runtime());
      expect(r.state).toBe('fail');
      expect(r.detail).toMatch(/Cleanup incomplete: [1-9]\d* synthetic rows or files remain/);
    } finally {
      await db.pool.query('DROP POLICY lab_no_tenant_delete ON oshal_tenants');
      await db.pool.query("DELETE FROM oshal_tenants WHERE created_by_sub LIKE 'test-lab-location-l7-%'");
    }
    expect(await residue()).toBe(0);
  });
});
