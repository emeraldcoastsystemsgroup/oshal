/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-111 amendment of ADR-169 L7, against a private PostgreSQL whose tables are owned by the NOSUPERUSER NOBYPASSRLS runtime role, through the real SpatialScanStore and SpatialMappingService. A person's own scans behave exactly as before (the owner reads them, a stranger does not, and the operator branch of migration 093 is unchanged). A group's scan is reached only by that group's members: a non-member cannot register one, an operator-stamped session and SYSTEM read none, and a capturer who has left the group no longer reads the scan they captured. A scan's owner and group cannot be rewritten. Deleting a group's scan as a member who is not an admin deletes its anchor. A group's scan is reconstructed under its capturer's identity and reaches `ready`; registered without the capturer signed in it is refused and no row is written. Capture GPS is joined to the scan that names the session, and to no other. The store's bootstrap leaves the migrated policies as they are, puts a missing group fence back before the first read, and on a database with no tenancy helper it installs a fence that admits no group row at all.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpatialMappingService, SpatialScanStore, buildGroupScanStatements, type ReconstructionProvider } from '@/features/spatial-mapping';
import { addMember, createTenant, removeMember } from '@/app/routes/connector-tenancy';
import { LOCATION_APP_ROLE, asSession, asSystem, convergeAppRole, locationDatabase, sqlState, type FixtureSession } from '../helpers/location-postgres-fixture';
import { MAP_HOME, anchorFromCapture, captureScan, openMapWorld, refusalOf, writeCaptureTelemetry, type MapWorld } from '../helpers/location-map-fixture';

const ADMIN: FixtureSession = { sub: 'scan-l7-admin' };
const MEMBER: FixtureSession = { sub: 'scan-l7-member' };
const LEAVER: FixtureSession = { sub: 'scan-l7-leaver' };
const STRANGER: FixtureSession = { sub: 'scan-l7-stranger' };
const T0 = Date.parse('2026-09-02T09:00:00.000Z');
const db = locationDatabase('spatial-group-scans');
let app: Pool;
let world: MapWorld;
const ids = { group: '', own: '', shared: '' };
/** The policies on spatial_scans as the migrations left them, before the store's bootstrap ever ran. */
let migrated: ScanPolicy[] = [];

const as = <T>(who: FixtureSession, fn: () => Promise<T>) => asSession(who, fn);
const visible = (who: FixtureSession, id: string) => as(who, async () => (await app.query('SELECT id FROM spatial_scans WHERE id = $1', [id])).rowCount);
const groupInput = (who: FixtureSession, id: string, extra: Record<string, unknown> = {}) => ({
  id, userSub: who.sub, title: 'Group scan', sourceKind: 'sim-mission' as const, sourceName: 'mission.json',
  sourceRef: path.join(world.root, `${id}-mission.json`), sourceBytes: 2, tenantId: ids.group, ...extra,
});

/** A provider that answers at once, so the spec proves the identity the job runs under and not an engine. */
const instant: ReconstructionProvider = {
  kind: 'sim',
  probe: async () => ({ available: true }),
  reconstruct: async () => ({ splat: Buffer.alloc(32), gaussianCount: 1, providerKind: 'sim' }),
};

async function until(read: () => Promise<string | undefined>, wanted: string, timeoutMs = 20_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let seen = await read();
  while (seen !== wanted && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200));
    seen = await read();
  }
  return seen;
}

/** One policy on spatial_scans as the catalog holds it. */
interface ScanPolicy { polname: string; polpermissive: boolean; using: string | null; check: string | null }

/** Policies on spatial_scans as the catalog holds them, with their expressions. */
async function scanPolicies(client: Pool | PoolClient): Promise<ScanPolicy[]> {
  return (await client.query(`SELECT polname, polpermissive, pg_get_expr(polqual, polrelid) AS using,
      pg_get_expr(polwithcheck, polrelid) AS check
    FROM pg_policy WHERE polrelid = 'spatial_scans'::regclass ORDER BY polname`)).rows;
}

const shapeOf = (policies: ScanPolicy[]): Array<[string, boolean]> => policies.map((p) => [p.polname, p.polpermissive]);

beforeAll(async () => {
  await db.start();
  migrated = await scanPolicies(db.pool);
  app = await convergeAppRole(db);
  world = await openMapWorld(app);
  ids.group = (await as(ADMIN, () => createTenant(app, { name: 'Survey team', createdBySub: ADMIN.sub }))).tenant_id;
  await as(ADMIN, () => addMember(app, ids.group, MEMBER.sub, ADMIN.sub));
  await as(ADMIN, () => addMember(app, ids.group, LEAVER.sub, ADMIN.sub));
  ids.own = await captureScan(world, MEMBER, MAP_HOME, { title: 'Member own', whenMs: T0 });
  ids.shared = await captureScan(world, LEAVER, MAP_HOME, { title: 'Team scan', whenMs: T0, group: ids.group });
}, 180_000);

afterAll(async () => {
  await world?.close();
  await db.stop();
}, 60_000);

describe('a person\'s own scans are unchanged by the amendment', () => {
  it('are read by their owner, not by a stranger, and the operator branch of migration 093 still applies', async () => {
    expect((await as(MEMBER, () => world.service.getScan(MEMBER.sub, ids.own)))?.tenantId).toBeNull();
    expect(await visible(MEMBER, ids.own)).toBe(1);
    expect(await visible(STRANGER, ids.own)).toBe(0);
    expect(await visible(ADMIN, ids.own)).toBe(0);
    expect(await visible({ ...STRANGER, operator: true }, ids.own)).toBe(1);
    expect(await asSystem(async () => (await app.query('SELECT id FROM spatial_scans WHERE id = $1', [ids.own])).rowCount)).toBe(1);
  });
});

describe('a group\'s scan is reached only by that group\'s members', () => {
  it('is opened by a member who did not capture it, and by nobody outside the group', async () => {
    expect((await as(MEMBER, () => world.service.getGroupScan(MEMBER.sub, ids.shared)))?.userSub).toBe(LEAVER.sub);
    expect(await as(MEMBER, () => world.service.getGroupScan(MEMBER.sub, ids.own))).toBeNull();
    expect(await as(STRANGER, () => world.service.getGroupScan(STRANGER.sub, ids.shared))).toBeNull();
    expect(await visible(STRANGER, ids.shared)).toBe(0);
    expect(await visible({ ...STRANGER, operator: true }, ids.shared)).toBe(0);
    expect(await asSystem(async () => (await app.query('SELECT id FROM spatial_scans WHERE id = $1', [ids.shared])).rowCount)).toBe(0);
  });

  it('cannot be registered by a non-member, stamped as an operator or not', async () => {
    const insert = (who: FixtureSession) => sqlState(as(who, () => world.store.insert(groupInput(STRANGER, randomUUID()))));
    expect(await insert(STRANGER)).toBe('42501');
    expect(await insert({ ...STRANGER, operator: true })).toBe('42501');
    expect(await refusalOf(() => as(MEMBER, () => world.store.insert(groupInput(MEMBER, randomUUID(), { tenantId: 'the-team' }))))).toBe('RangeError');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM spatial_scans WHERE user_sub = $1', [STRANGER.sub])).rows[0].n).toBe(0);
  });

  it('keeps its owner and its group: neither can be rewritten', async () => {
    const rewrite = (who: FixtureSession, sql: string, value: string | null) => sqlState(as(who, () => app.query(sql, [value, ids.shared])));
    expect(await rewrite(MEMBER, 'UPDATE spatial_scans SET tenant_id = NULL, user_sub = $1 WHERE id = $2', MEMBER.sub)).toBe('42501');
    expect(await rewrite(ADMIN, 'UPDATE spatial_scans SET user_sub = $1 WHERE id = $2', ADMIN.sub)).toBe('42501');
    expect(await rewrite(LEAVER, 'UPDATE spatial_scans SET tenant_id = $1 WHERE id = $2', null)).toBe('42501');
    expect(await rewrite(MEMBER, 'UPDATE spatial_scans SET title = $1 WHERE id = $2', 'Team scan, renamed')).toBe('resolved');
    expect((await db.pool.query('SELECT user_sub, tenant_id FROM spatial_scans WHERE id = $1', [ids.shared])).rows[0])
      .toEqual({ user_sub: LEAVER.sub, tenant_id: ids.group });
  });

  it('is no longer read by its capturer once they have left the group', async () => {
    expect((await as(LEAVER, () => world.service.getScan(LEAVER.sub, ids.shared)))?.id).toBe(ids.shared);
    await as(ADMIN, () => removeMember(app, ids.group, LEAVER.sub, ADMIN.sub));
    expect(await as(LEAVER, () => world.service.getScan(LEAVER.sub, ids.shared))).toBeNull();
    expect(await visible(LEAVER, ids.shared)).toBe(0);
    expect(await visible(MEMBER, ids.shared)).toBe(1);
  });
});

describe('a deleted scan takes its anchor with it', () => {
  it('when a member who is not an admin deletes a group\'s scan', async () => {
    const scan = await captureScan(world, ADMIN, MAP_HOME, { title: 'To delete', whenMs: T0, group: ids.group });
    await anchorFromCapture(world, ADMIN, scan, { groupId: ids.group });
    const anchors = async () => (await db.pool.query('SELECT count(*)::int AS n FROM location_map_anchors WHERE map_ref = $1', [scan])).rows[0].n;
    expect(await anchors()).toBe(1);
    expect((await as(MEMBER, () => app.query('DELETE FROM location_map_anchors WHERE map_ref = $1', [scan]))).rowCount).toBe(0);
    expect((await as(MEMBER, () => app.query('DELETE FROM spatial_scans WHERE id = $1', [scan]))).rowCount).toBe(1);
    expect(await anchors()).toBe(0);
  });
});

describe('a group\'s scan is reconstructed as its capturer', () => {
  it('reaches ready under the capturer\'s identity', async () => {
    const service = new SpatialMappingService(app, { simProvider: instant });
    const id = randomUUID();
    const queued = await as(MEMBER, () => service.registerAndStart(groupInput(MEMBER, id)));
    expect(queued).toMatchObject({ status: 'queued', tenantId: ids.group, userSub: MEMBER.sub });
    const status = await until(async () => (await as(ADMIN, () => service.getGroupScan(ADMIN.sub, id)))?.status, 'ready');
    expect(status).toBe('ready');
  });

  it('is refused without the capturer signed in, and no row is written', async () => {
    const service = new SpatialMappingService(app, { simProvider: instant });
    const id = randomUUID();
    expect(await refusalOf(() => service.registerAndStart(groupInput(MEMBER, id)))).toBe('Error');
    expect(await refusalOf(() => asSystem(() => service.registerAndStart(groupInput(MEMBER, id))))).toBe('Error');
    expect(await refusalOf(() => as(ADMIN, () => service.registerAndStart(groupInput(MEMBER, id))))).toBe('Error');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM spatial_scans WHERE id = $1', [id])).rows[0].n).toBe(0);
  });
});

describe('capture GPS is joined to the scan that names the session', () => {
  it('yields the anchor the scan\'s own session recorded, and nothing for a scan without one', async () => {
    const anchor = await as(MEMBER, () => world.service.captureAnchorForScan(MEMBER.sub, ids.own));
    expect(anchor).toMatchObject({ lat: MAP_HOME.lat, lon: MAP_HOME.lon, accuracyM: 6, headingDeg: 40, footprintRadiusM: 10, fixCount: 3 });
    expect(anchor?.capturedAt).toBe(new Date(T0 + 2000).toISOString());
    const bare = await captureScan(world, MEMBER, MAP_HOME, { title: 'No session', whenMs: T0, session: false });
    expect(await as(MEMBER, () => world.service.captureAnchorForScan(MEMBER.sub, bare))).toBeNull();
  });

  it('does not read another person\'s scan or another person\'s session', async () => {
    expect(await as(STRANGER, () => world.service.captureAnchorForScan(STRANGER.sub, ids.own))).toBeNull();
    const theirs = randomUUID();
    await writeCaptureTelemetry(STRANGER.sub, theirs, MAP_HOME, T0);
    const id = randomUUID();
    await as(MEMBER, () => world.store.insert({
      id, userSub: MEMBER.sub, title: 'Names a stranger\'s session', sourceKind: 'model', sourceName: 'c.ply', sourceRef: '', sourceBytes: 0,
      captureSessionId: theirs,
    }));
    expect(await as(MEMBER, () => world.service.captureAnchorForScan(MEMBER.sub, id))).toBeNull();
  });
});

describe('the store\'s bootstrap and the migration agree', () => {
  it('leaves the migrated policies as they are', async () => {
    await as(MEMBER, () => new SpatialMappingService(app).listScans(MEMBER.sub));
    expect(await scanPolicies(db.pool)).toEqual(migrated);
    expect(shapeOf(migrated)).toEqual([
      ['spatial_scans_owner_or_operator', true],
      ['spatial_scans_tenant_fence', false],
      ['spatial_scans_tenant_member', true],
    ]);
    expect(JSON.stringify(migrated.filter((p) => p.polname.startsWith('spatial_scans_tenant_')))).not.toContain('is_operator');
  });

  it('puts a missing group fence back before the first read', async () => {
    await db.pool.query('DROP POLICY spatial_scans_tenant_fence ON spatial_scans');
    const fresh = new SpatialScanStore(app);
    expect(await as({ ...STRANGER, operator: true }, () => fresh.getGroupScan(STRANGER.sub, ids.shared))).toBeNull();
    expect(await visible({ ...STRANGER, operator: true }, ids.shared)).toBe(0);
    expect(await scanPolicies(db.pool)).toEqual(migrated);
  });

  it('installs a fence that admits no group row where there is no tenancy helper', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP POLICY spatial_scans_tenant_fence ON spatial_scans');
      await client.query('DROP POLICY spatial_scans_tenant_member ON spatial_scans');
      await client.query('ALTER FUNCTION oshal_is_tenant_member(text) RENAME TO oshal_is_tenant_member_absent');
      for (const statement of buildGroupScanStatements()) await client.query(statement);
      expect(shapeOf(await scanPolicies(client))).toEqual([
        ['spatial_scans_owner_or_operator', true],
        ['spatial_scans_tenant_fence', false],
      ]);
      await client.query(`SET LOCAL ROLE ${LOCATION_APP_ROLE}`);
      await client.query("SELECT set_config('oshal.current_sub', $1, true), set_config('oshal.is_operator', 'on', true)", [MEMBER.sub]);
      expect((await client.query('SELECT id FROM spatial_scans WHERE id = $1', [ids.shared])).rowCount).toBe(0);
      expect((await client.query('SELECT id FROM spatial_scans WHERE id = $1', [ids.own])).rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await visible(MEMBER, ids.shared)).toBe(1);
  });
});
