/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L7: anchorMap and mapsNear against a private PostgreSQL whose tables are owned by the NOSUPERUSER NOBYPASSRLS runtime role (FORCE row-level security is what holds). The slice's done-when, end to end: a group's scan captured inside a saved place and one captured outside every saved place are each registered naming their capture session, anchored from the GPS that session recorded, and both come back from mapsNear on a later visit by another member, newest first and by reference only; a non-member gets nothing from mapsNear and cannot open either scan, through the store or by a direct read, stamped as an operator or not, and SYSTEM cannot either. Then who may anchor what (a member who is not an admin, a stranger's scan, a group's scan anchored as one's own, a personal scan anchored as the group's, a place or device outside the owner's scope, malformed input, callers that are not a signed-in person), the precision an anchor is stored at and the direct write the policy refuses when it is finer than the owner chose, re-anchoring, and the erase and export. Synthetic identities and mid-ocean coordinates only.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorMap, eraseLocationData, exportOwnLocationData, mapsNear, type LocationMapAnchorInput } from '@/features/location';
import { addMember, createTenant } from '@/app/routes/connector-tenancy';
import { asSession, asSystem, convergeAppRole, locationDatabase, sqlState, FIXTURE_ISSUER, type FixtureSession } from '../helpers/location-postgres-fixture';
import {
  MAP_HOME, anchorFromCapture, captureScan, northOf, openMapWorld, principalOf, refusalOf, type MapWorld,
} from '../helpers/location-map-fixture';

const ADMIN: FixtureSession = { sub: 'loc-l7-admin' };
const MEMBER: FixtureSession = { sub: 'loc-l7-member' };
const STRANGER: FixtureSession = { sub: 'loc-l7-stranger' };
const SOLO: FixtureSession = { sub: 'loc-l7-solo' };
const COARSE: FixtureSession = { sub: 'loc-l7-place-only' };
const INSIDE = northOf(MAP_HOME, 20);
const OUTSIDE = northOf(MAP_HOME, 5000);
const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const COORDINATE_KEYS = /"(lat|lon|origin_lat|origin_lon|latitude|longitude|center|distance)/i;
const db = locationDatabase('location-map-anchors');
let app: Pool;
let world: MapWorld;
const ids = { group: '', place: '', theirs: '', drone: '', inside: '', outside: '', own: '' };

const as = <T>(who: FixtureSession, fn: () => Promise<T>) => asSession(who, fn);
const refs = (maps: Array<{ mapRef: string }>): string[] => maps.map((m) => m.mapRef);

async function insertPlace(who: FixtureSession, name: string, center: { lat: number; lon: number }, radiusM: number, tenant?: string): Promise<string> {
  const row = await as(who, () => app.query(`INSERT INTO location_places
      (owner_sub, principal_issuer, tenant_id, name, label, center_lat, center_lon, radius_m, created_by_sub)
    VALUES ($1, $2, $3, $4, 'other', $5, $6, $7, $8) RETURNING place_id`,
  [tenant ? null : who.sub, tenant ? null : FIXTURE_ISSUER, tenant ?? null, name, center.lat, center.lon, radiusM, who.sub]));
  return String(row.rows[0].place_id);
}

/** The stored anchor of a map, read past row-level security by the fixture's superuser. */
async function storedAnchor(mapRef: string): Promise<Record<string, unknown> | undefined> {
  return (await db.pool.query('SELECT * FROM location_map_anchors WHERE map_ref = $1', [mapRef])).rows[0];
}

const decimalsOf = (value: unknown): number => (String(value).split('.')[1] ?? '').length;

const manualAnchor = (mapRef: string, extra: Record<string, unknown> = {}): LocationMapAnchorInput => ({
  mapKind: 'spatial-scan', mapRef, anchor: { ...INSIDE }, footprintRadiusM: 12, source: 'manual', capturedAt: new Date(T0).toISOString(), ...extra,
} as LocationMapAnchorInput);

beforeAll(async () => {
  await db.start();
  app = await convergeAppRole(db);
  world = await openMapWorld(app);
  ids.group = (await as(ADMIN, () => createTenant(app, { name: 'Household', createdBySub: ADMIN.sub }))).tenant_id;
  await as(ADMIN, () => addMember(app, ids.group, MEMBER.sub, ADMIN.sub));
  ids.place = await insertPlace(ADMIN, 'Workshop', MAP_HOME, 150, ids.group);
  ids.theirs = await insertPlace(STRANGER, 'Theirs', MAP_HOME, 5000);
  ids.drone = (await as(ADMIN, () => app.query(`INSERT INTO location_devices (device_kind, device_ref, tenant_id, precision_class)
    VALUES ('drone', 'drone-l7-1', $1, 'exact') RETURNING device_id`, [ids.group]))).rows[0].device_id;
  ids.inside = await captureScan(world, ADMIN, INSIDE, { title: 'Workshop scan', whenMs: T0, group: ids.group });
  ids.outside = await captureScan(world, ADMIN, OUTSIDE, { title: 'Field scan', whenMs: T0 + 3_600_000, group: ids.group });
  ids.own = await captureScan(world, SOLO, INSIDE, { title: 'Solo scan', whenMs: T0 + 7_200_000 });
}, 180_000);

afterAll(async () => {
  await world?.close();
  await db.stop();
}, 60_000);

describe('ADR-169 L7 done-when: both maps on a later visit, and a non-member opens neither', () => {
  it('anchors a scan captured inside a saved place and one captured outside every saved place from their joined capture GPS', async () => {
    const inside = await anchorFromCapture(world, ADMIN, ids.inside, { groupId: ids.group });
    const outside = await anchorFromCapture(world, ADMIN, ids.outside, { groupId: ids.group });
    expect(inside.placeId).toBe(ids.place);
    expect(outside.placeId).toBeNull();
    expect(JSON.stringify([inside, outside])).not.toMatch(COORDINATE_KEYS);
    expect(await storedAnchor(ids.inside)).toMatchObject({ tenant_id: ids.group, owner_sub: null, anchor_source: 'capture-gps', accuracy_m: 6, heading_deg: 40 });
  });

  it('returns both to another member on a later visit, newest first and by reference only', async () => {
    expect(refs(await as(MEMBER, () => mapsNear(app, INSIDE, 50)))).toEqual([ids.inside]);
    expect(refs(await as(MEMBER, () => mapsNear(app, OUTSIDE, 50)))).toEqual([ids.outside]);
    const both = await as(MEMBER, () => mapsNear(app, northOf(MAP_HOME, 2500), 5000));
    expect(both).toEqual([
      { mapKind: 'spatial-scan', mapRef: ids.outside, capturedAt: new Date(T0 + 3_600_000 + 2000).toISOString(), placeId: null },
      { mapKind: 'spatial-scan', mapRef: ids.inside, capturedAt: new Date(T0 + 2000).toISOString(), placeId: ids.place },
    ]);
    expect(JSON.stringify(both)).not.toMatch(COORDINATE_KEYS);
    expect((await as(MEMBER, () => world.store.getGroupScan(MEMBER.sub, ids.inside)))?.title).toBe('Workshop scan');
    expect((await as(MEMBER, () => world.store.getGroupScan(MEMBER.sub, ids.outside)))?.tenantId).toBe(ids.group);
  });

  it('gives a non-member nothing from mapsNear, stamped as an operator or not', async () => {
    expect(await as(STRANGER, () => mapsNear(app, INSIDE, 5000))).toEqual([]);
    expect(await as({ ...STRANGER, operator: true }, () => mapsNear(app, OUTSIDE, 5000))).toEqual([]);
  });

  it('does not let a non-member open either scan, through the store or by a direct read', async () => {
    const direct = (who: FixtureSession) => as(who, async () =>
      (await app.query('SELECT id FROM spatial_scans WHERE id = ANY($1::text[])', [[ids.inside, ids.outside]])).rowCount);
    expect(await as(STRANGER, () => world.store.getGroupScan(STRANGER.sub, ids.inside))).toBeNull();
    expect(await as(STRANGER, () => world.service.getScan(STRANGER.sub, ids.outside))).toBeNull();
    expect(await as(STRANGER, () => world.store.getGroupScan(MEMBER.sub, ids.inside))).toBeNull();
    expect(await direct(STRANGER)).toBe(0);
    expect(await direct({ ...STRANGER, operator: true })).toBe(0);
    expect(await asSystem(async () => (await app.query('SELECT id FROM spatial_scans WHERE tenant_id IS NOT NULL')).rowCount)).toBe(0);
    expect(await direct(MEMBER)).toBe(2);
  });
});

describe('a person\'s own map', () => {
  it('is anchored by its owner and found by nobody else', async () => {
    const anchored = await anchorFromCapture(world, SOLO, ids.own);
    expect(anchored.placeId).toBeNull();
    expect(refs(await as(SOLO, () => mapsNear(app, INSIDE, 50)))).toEqual([ids.own]);
    expect(refs(await as(MEMBER, () => mapsNear(app, INSIDE, 50)))).toEqual([ids.inside]);
    expect(await as({ ...STRANGER, operator: true }, () => mapsNear(app, INSIDE, 50))).toEqual([]);
    expect(await storedAnchor(ids.own)).toMatchObject({ owner_sub: SOLO.sub, principal_issuer: FIXTURE_ISSUER, tenant_id: null });
  });

  it('is stored at the precision its owner chose, and is still found from where it was captured', async () => {
    const row = await storedAnchor(ids.own);
    expect(row).toMatchObject({ precision_class: 'block', origin_alt_m: null });
    expect(decimalsOf(row?.origin_lat)).toBeLessThanOrEqual(3);
    expect(decimalsOf(row?.origin_lon)).toBeLessThanOrEqual(3);
    expect(refs(await as(SOLO, () => mapsNear(app, INSIDE, 1)))).toEqual([ids.own]);
    expect(await as(SOLO, () => mapsNear(app, northOf(INSIDE, 400), 1))).toEqual([]);
  });

  it('takes the capturing device\'s class when the anchor names one', async () => {
    const drone = await captureScan(world, ADMIN, INSIDE, { title: 'Drone scan', whenMs: T0 + 60_000, group: ids.group });
    await as(ADMIN, () => anchorMap(app, manualAnchor(drone, { groupId: ids.group, deviceId: ids.drone, source: 'mavlink', anchor: { ...INSIDE, altM: 31.6 } })));
    const row = await storedAnchor(drone);
    expect(row).toMatchObject({ precision_class: 'exact', captured_by_device_id: ids.drone, origin_alt_m: 32, anchor_source: 'mavlink' });
    expect(Number(row?.origin_lat)).toBeCloseTo(INSIDE.lat, 5);
    await as(ADMIN, () => world.store.delete(ADMIN.sub, drone));
  });

  it('refuses an owner whose precision class stores no coordinates', async () => {
    await as(COARSE, () => app.query(`INSERT INTO location_settings (owner_sub, principal_issuer, default_precision_class)
      VALUES ($1, $2, 'place-only')`, [COARSE.sub, FIXTURE_ISSUER]));
    const scan = await captureScan(world, COARSE, INSIDE, { title: 'Coarse scan', whenMs: T0 });
    expect(await refusalOf(() => as(COARSE, () => anchorMap(app, manualAnchor(scan))))).toBe('LocationPrecisionError');
    expect(await storedAnchor(scan)).toBeUndefined();
  });
});

describe('who may anchor what', () => {
  it('refuses a member who is not an admin, and a group\'s scan anchored as one\'s own', async () => {
    expect(await refusalOf(() => as(MEMBER, () => anchorMap(app, manualAnchor(ids.inside, { groupId: ids.group }))))).toBe('LocationForbiddenError');
    expect(await refusalOf(() => as(STRANGER, () => anchorMap(app, manualAnchor(ids.inside, { groupId: ids.group }))))).toBe('LocationForbiddenError');
    expect(await refusalOf(() => as(ADMIN, () => anchorMap(app, manualAnchor(ids.inside))))).toBe('LocationNotFoundError');
    expect(await refusalOf(() => as(MEMBER, () => anchorMap(app, manualAnchor(ids.inside))))).toBe('LocationNotFoundError');
  });

  it('refuses another person\'s scan, a personal scan anchored as the group\'s, and a map that does not exist', async () => {
    expect(await refusalOf(() => as(STRANGER, () => anchorMap(app, manualAnchor(ids.own))))).toBe('LocationNotFoundError');
    const mine = await captureScan(world, ADMIN, INSIDE, { title: 'Admin own', whenMs: T0 });
    expect(await refusalOf(() => as(ADMIN, () => anchorMap(app, manualAnchor(mine, { groupId: ids.group }))))).toBe('LocationNotFoundError');
    expect(await refusalOf(() => as(ADMIN, () => anchorMap(app, manualAnchor('no-such-scan'))))).toBe('LocationNotFoundError');
    expect((await storedAnchor(ids.own))?.owner_sub).toBe(SOLO.sub);
  });

  it('refuses a place or a device outside the owner\'s scope', async () => {
    expect(await refusalOf(() => as(SOLO, () => anchorMap(app, manualAnchor(ids.own, { placeId: ids.theirs }))))).toBe('LocationNotFoundError');
    expect(await refusalOf(() => as(SOLO, () => anchorMap(app, manualAnchor(ids.own, { placeId: ids.place }))))).toBe('LocationNotFoundError');
    expect(await refusalOf(() => as(SOLO, () => anchorMap(app, manualAnchor(ids.own, { deviceId: ids.drone }))))).toBe('LocationNotFoundError');
    expect(await refusalOf(() => as(ADMIN, () => anchorMap(app, manualAnchor(ids.inside, { groupId: ids.group, placeId: ids.theirs }))))).toBe('LocationNotFoundError');
  });

  it('refuses malformed input before it reaches the database', async () => {
    const bad = (extra: Record<string, unknown>) => refusalOf(() => as(SOLO, () => anchorMap(app, manualAnchor(ids.own, extra))));
    expect(await bad({ mapKind: 'embodied-scene' })).toBe('LocationInputError');
    expect(await bad({ mapRef: '../scans/other' })).toBe('LocationInputError');
    expect(await bad({ anchor: { lat: 91, lon: 0 } })).toBe('LocationInputError');
    expect(await bad({ anchor: { lat: Number.NaN, lon: 0 } })).toBe('LocationInputError');
    expect(await bad({ footprintRadiusM: 0 })).toBe('LocationInputError');
    expect(await bad({ footprintRadiusM: 50_001 })).toBe('LocationInputError');
    expect(await bad({ source: 'guess' })).toBe('LocationInputError');
    expect(await bad({ capturedAt: new Date(Date.now() + 3_600_000).toISOString() })).toBe('LocationInputError');
    expect(await bad({ groupId: 'household' })).toBe('LocationInputError');
    expect(await refusalOf(() => as(SOLO, () => mapsNear(app, { lat: 0, lon: 181 }, 50)))).toBe('LocationInputError');
    expect(await refusalOf(() => as(SOLO, () => mapsNear(app, INSIDE, 0)))).toBe('LocationInputError');
    expect(await refusalOf(() => as(SOLO, () => mapsNear(app, INSIDE, 50_001)))).toBe('LocationInputError');
  });

  it('refuses every caller that is not a signed-in person with a verified issuer', async () => {
    expect(await refusalOf(() => anchorMap(app, manualAnchor(ids.own)))).toBe('LocationPrincipalError');
    expect(await refusalOf(() => asSystem(() => anchorMap(app, manualAnchor(ids.own))))).toBe('LocationPrincipalError');
    expect(await refusalOf(() => as({ sub: SOLO.sub, issuer: null }, () => anchorMap(app, manualAnchor(ids.own))))).toBe('LocationPrincipalError');
    expect(await refusalOf(() => mapsNear(app, INSIDE, 50))).toBe('LocationPrincipalError');
    expect(await refusalOf(() => asSystem(() => mapsNear(app, INSIDE, 50)))).toBe('LocationPrincipalError');
  });
});

describe('the anchor policies, written to directly', () => {
  const INSERT = `INSERT INTO location_map_anchors
      (owner_sub, principal_issuer, tenant_id, map_kind, map_ref, precision_class, origin_lat, origin_lon, footprint_radius_m, anchor_source, captured_at, created_by_sub)
    VALUES ($1, $2, $3, 'spatial-scan', $4, $5, $6, $7, 10, 'manual', NOW(), $8)`;
  const direct = (who: FixtureSession, owner: FixtureSession | null, tenant: string | null, mapRef: string, cls: string, decimals: number) =>
    sqlState(as(who, () => app.query(INSERT, [owner?.sub ?? null, owner ? FIXTURE_ISSUER : null, tenant, mapRef,
      cls, Number(INSIDE.lat.toFixed(decimals)), Number(INSIDE.lon.toFixed(decimals)), who.sub])));

  it('refuses an anchor finer than its owner chose, a group anchor from a non-admin, and an anchor on another owner\'s map', async () => {
    const scan = await captureScan(world, SOLO, INSIDE, { title: 'Direct', whenMs: T0 });
    expect(await direct(SOLO, SOLO, null, scan, 'exact', 5)).toBe('42501');
    expect(await direct(STRANGER, STRANGER, null, scan, 'block', 3)).toBe('42501');
    expect(await direct(SOLO, SOLO, null, ids.inside, 'block', 3)).toBe('42501');
    const group = await captureScan(world, ADMIN, INSIDE, { title: 'Direct group', whenMs: T0, group: ids.group });
    expect(await direct(MEMBER, null, ids.group, group, 'block', 3)).toBe('42501');
    expect(await direct({ ...STRANGER, operator: true }, null, ids.group, group, 'block', 3)).toBe('42501');
    expect(await direct(SOLO, SOLO, null, scan, 'city', 2)).toBe('resolved');
    expect(await direct(ADMIN, null, ids.group, group, 'block', 3)).toBe('resolved');
  });

  it('refuses coordinates finer than the class the row names', async () => {
    const scan = await captureScan(world, SOLO, INSIDE, { title: 'Too fine', whenMs: T0 });
    expect(await direct(SOLO, SOLO, null, scan, 'block', 5)).toBe('23514');
  });

  it('lets a member read a group anchor and not change or delete it', async () => {
    const changed = await as(MEMBER, () => app.query('UPDATE location_map_anchors SET footprint_radius_m = 999 WHERE map_ref = $1', [ids.inside]));
    const deleted = await as(MEMBER, () => app.query('DELETE FROM location_map_anchors WHERE map_ref = $1', [ids.inside]));
    expect([changed.rowCount, deleted.rowCount]).toEqual([0, 0]);
    expect(Number((await storedAnchor(ids.inside))?.footprint_radius_m)).toBe(10);
  });
});

describe('re-anchoring, the erase and the export', () => {
  it('replaces a map\'s anchor instead of adding a second one', async () => {
    const first = await storedAnchor(ids.own);
    const again = await as(SOLO, () => anchorMap(app, manualAnchor(ids.own, { anchor: { ...OUTSIDE }, footprintRadiusM: 40 })));
    expect(again.anchorId).toBe(String(first?.anchor_id));
    expect((await db.pool.query('SELECT count(*)::int AS n FROM location_map_anchors WHERE map_ref = $1', [ids.own])).rows[0].n).toBe(1);
    expect(refs(await as(SOLO, () => mapsNear(app, OUTSIDE, 50)))).toEqual([ids.own]);
    expect(refs(await as(SOLO, () => mapsNear(app, INSIDE, 50)))).not.toContain(ids.own);
  });

  it('exports the person\'s anchors and erases them, leaving the group\'s', async () => {
    const exported = await exportOwnLocationData(app, principalOf(SOLO));
    expect(exported.location_map_anchors.map((r) => r.map_ref)).toContain(ids.own);
    expect((await exportOwnLocationData(app, principalOf(MEMBER))).location_map_anchors).toEqual([]);
    const erased = await eraseLocationData(app, principalOf(SOLO));
    expect(erased.deleted.location_map_anchors).toBeGreaterThanOrEqual(1);
    expect(await storedAnchor(ids.own)).toBeUndefined();
    await eraseLocationData(app, principalOf(ADMIN));
    expect((await storedAnchor(ids.inside))?.tenant_id).toBe(ids.group);
    expect(refs(await as(MEMBER, () => mapsNear(app, INSIDE, 50)))).toContain(ids.inside);
  });
});
