/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: the location kernel's package-facing reads against a private PostgreSQL whose tables are owned by the NOSUPERUSER NOBYPASSRLS runtime role (FORCE row-level security is what holds). placeAt: containment edges (half a metre inside and outside a radius, nested places smallest first, a group place for its members only, never a stranger's place, not even for an operator-stamped session), and a bad point refused. currentPlace: nothing before a fix; "since" kept while fixes stay in one place and moved when the place changes, through the real browser ingest; a group camera's assigned place for a member with its assignment time; a group drone's observed place; a stranger's device not found. distanceBand: at, <1 km, <10 km and farther from the stored fix, unknown for a stale fix, a place-only fix elsewhere or no fix, and an assigned device placed at its place's centre. operationAddress: the address and centre of the caller's own or group place only. Every read refuses no identity, SYSTEM and an identity without a verified issuer. Synthetic identities and coordinates only.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocationInputError, LocationNotFoundError, LocationPrincipalError, currentPlace, distanceBand, locationBandMaxAgeMs,
  operationAddress, placeAt,
} from '@/features/location';
import { addMember, createTenant } from '@/app/routes/connector-tenancy';
import { optInBrowserDevice } from '@/app/location-consent';
import { enrolPlacedDevice, parseEnrolInput } from '@/app/location-devices';
import { ingestBrowserFix, parseBrowserFix } from '@/app/location-presence';
import { EARTH_RADIUS_M } from '@/shared/utils/geo';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { FIXTURE_ISSUER, asSession, asSystem, convergeAppRole, locationDatabase, type FixtureSession } from '../helpers/location-postgres-fixture';

const OWNER: FixtureSession = { sub: 'loc-l4-owner' };
const MEMBER: FixtureSession = { sub: 'loc-l4-member' };
const STRANGER: FixtureSession = { sub: 'loc-l4-stranger' };
const COARSE: FixtureSession = { sub: 'loc-l4-coarse' };
const HOME = { lat: -12.346, lon: -31.988 };
const DEG_PER_M = 180 / (Math.PI * EARTH_RADIUS_M);
const north = (p: { lat: number; lon: number }, metres: number) => ({ lat: p.lat + metres * DEG_PER_M, lon: p.lon });
const db = locationDatabase('location-place-reads');
let app: Pool;
const ids = { home: '', hood: '', cafe: '', far: '', school: '', theirs: '', group: '', camera: '', drone: '' };

const principal = (who: FixtureSession) => ({ sub: who.sub, principalIssuer: FIXTURE_ISSUER });
const as = <T>(who: FixtureSession, fn: () => Promise<T>) => asSession(who, fn);

async function insertPlace(who: FixtureSession, name: string, center: { lat: number; lon: number }, radiusM: number, extra: { tenant?: string; address?: string } = {}): Promise<string> {
  const row = await as(who, () => app.query(`INSERT INTO location_places
      (owner_sub, principal_issuer, tenant_id, name, label, center_lat, center_lon, radius_m, address, timezone, created_by_sub)
    VALUES ($1, $2, $3, $4, 'other', $5, $6, $7, $8, $9, $10) RETURNING place_id`,
  [extra.tenant ? null : who.sub, extra.tenant ? null : FIXTURE_ISSUER, extra.tenant ?? null, name, center.lat, center.lon, radiusM,
    extra.address ?? null, extra.address ? 'Atlantic/South_Georgia' : null, who.sub]));
  return String(row.rows[0].place_id);
}

async function fix(who: FixtureSession, deviceId: string, point: { lat: number; lon: number }): Promise<void> {
  await ingestBrowserFix(app, principal(who), parseBrowserFix({ deviceId, ...point, accuracyM: 8 }), { minIntervalMs: 0 });
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return (error as { name?: string }).name ?? 'thrown';
  }
}

beforeAll(async () => {
  await db.start();
  app = await convergeAppRole(db);
  ids.home = await insertPlace(OWNER, 'Home', HOME, 100, { address: 'Synthetic address 1' });
  ids.hood = await insertPlace(OWNER, 'Neighbourhood', HOME, 2000);
  ids.cafe = await insertPlace(OWNER, 'Cafe', north(HOME, 700), 100);
  ids.far = await insertPlace(OWNER, 'Airport', north(HOME, 30_000), 500);
  ids.theirs = await insertPlace(STRANGER, 'Theirs', HOME, 5000);
  ids.group = (await as(OWNER, () => createTenant(app, { name: 'Household', createdBySub: OWNER.sub }))).tenant_id;
  await as(OWNER, () => addMember(app, ids.group, MEMBER.sub, OWNER.sub));
  ids.school = await insertPlace(OWNER, 'School', north(HOME, 4000), 150, { tenant: ids.group });
  ids.camera = (await as(OWNER, () => enrolPlacedDevice(app, principal(OWNER),
    parseEnrolInput({ kind: 'camera', ref: 'cam-porch', groupId: ids.group, placeId: ids.school }, principal(OWNER))))).deviceId;
  ids.drone = (await as(OWNER, () => app.query(`INSERT INTO location_devices (device_kind, device_ref, tenant_id, precision_class)
    VALUES ('drone', 'drone-l4-1', $1, 'exact') RETURNING device_id`, [ids.group]))).rows[0].device_id;
}, 180_000);

afterAll(async () => { await db.stop(); }, 60_000);

describe('placeAt: containment edges and visibility', () => {
  it('returns the caller\'s places containing a point, smallest first, and never a stranger\'s', async () => {
    expect((await as(OWNER, () => placeAt(app, HOME))).map((p) => p.name)).toEqual(['Home', 'Neighbourhood']);
    expect(await as(STRANGER, () => placeAt(app, HOME))).toEqual([{ placeId: ids.theirs, name: 'Theirs', label: 'other' }]);
    expect(await as({ ...MEMBER, operator: true }, () => placeAt(app, HOME))).toEqual([]);
  });

  it('counts half a metre inside the radius as inside and half a metre outside as outside', async () => {
    expect((await as(OWNER, () => placeAt(app, north(HOME, 99.5)))).map((p) => p.name)).toEqual(['Home', 'Neighbourhood']);
    expect((await as(OWNER, () => placeAt(app, north(HOME, 100.5)))).map((p) => p.name)).toEqual(['Neighbourhood']);
    expect((await as(OWNER, () => placeAt(app, north(HOME, 1999.5)))).map((p) => p.name)).toEqual(['Neighbourhood']);
    expect(await as(OWNER, () => placeAt(app, north(HOME, 2000.5)))).toEqual([]);
  });

  it('a group place contains the point for its members and for nobody else', async () => {
    const at = north(HOME, 4000);
    expect(await as(MEMBER, () => placeAt(app, at))).toEqual([{ placeId: ids.school, name: 'School', label: 'other' }]);
    expect((await as(STRANGER, () => placeAt(app, at))).map((p) => p.placeId)).toEqual([ids.theirs]);
  });

  it('refuses a bad point, and every caller that is not a signed-in person with an issuer', async () => {
    expect(await refusal(() => as(OWNER, () => placeAt(app, { lat: 91, lon: 0 })))).toBe('LocationInputError');
    expect(await refusal(() => as(OWNER, () => placeAt(app, { lat: Number.NaN, lon: 0 })))).toBe('LocationInputError');
    expect(await refusal(() => placeAt(app, HOME))).toBe('LocationPrincipalError');
    expect(await refusal(() => asSystem(() => placeAt(app, HOME)))).toBe('LocationPrincipalError');
    expect(await refusal(() => as({ sub: OWNER.sub, issuer: null }, () => placeAt(app, HOME)))).toBe('LocationPrincipalError');
    expect(await refusal(() => runWithRequestIdentity({ sub: null, isOperator: true }, () => placeAt(app, HOME)))).toBe('LocationPrincipalError');
  });
});

describe('currentPlace', () => {
  it('knows nothing before a fix, then keeps "since" while fixes stay in a place and moves it when the place changes', async () => {
    expect(await as(OWNER, () => currentPlace(app))).toEqual({ place: null, since: null, ageSeconds: null, basis: 'none' });
    const device = await optInBrowserDevice(app, principal(OWNER), { deviceId: null, precisionClass: 'block' });
    await fix(OWNER, device.deviceId, HOME);
    const first = await as(OWNER, () => currentPlace(app));
    expect(first).toMatchObject({ place: { placeId: ids.home, name: 'Home', label: 'other' }, basis: 'observed' });
    await fix(OWNER, device.deviceId, north(HOME, 20));
    const second = await as(OWNER, () => currentPlace(app));
    expect(second.since).toBe(first.since);
    await fix(OWNER, device.deviceId, north(HOME, 700));
    const moved = await as(OWNER, () => currentPlace(app));
    expect(moved.place?.name).toBe('Cafe');
    expect(Date.parse(moved.since as string)).toBeGreaterThan(Date.parse(first.since as string));
    expect(moved.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(moved)).not.toMatch(/"(lat|lon|center|address|radius)/);
    await fix(OWNER, device.deviceId, HOME);
  });

  it('reads a group camera\'s assigned place for a member, and a group drone\'s observed place', async () => {
    const camera = await as(MEMBER, () => currentPlace(app, { deviceId: ids.camera }));
    expect(camera).toMatchObject({ place: { placeId: ids.school, name: 'School' }, basis: 'assigned', ageSeconds: null });
    expect(Date.parse(camera.since as string)).toBeGreaterThan(0);
    await as(OWNER, () => app.query(`INSERT INTO location_current (tenant_id, subject_ref, device_id, source, precision_class, lat, lon, place_id, observed_at, place_since)
      VALUES ($1, 'device:' || $2::text, $2::uuid, 'mavlink', 'exact', $3, $4, $5, NOW(), NOW())`,
    [ids.group, ids.drone, Number(north(HOME, 4000).lat.toFixed(5)), HOME.lon, ids.school]));
    expect(await as(MEMBER, () => currentPlace(app, { deviceId: ids.drone }))).toMatchObject({ place: { name: 'School' }, basis: 'observed' });
  });

  it('does not find a device the caller may not read, and refuses a malformed subject', async () => {
    expect(await refusal(() => as(STRANGER, () => currentPlace(app, { deviceId: ids.camera })))).toBe('LocationNotFoundError');
    expect(await refusal(() => as(OWNER, () => currentPlace(app, { deviceId: 'not-an-id' })))).toBe('LocationInputError');
    expect(await refusal(() => as(OWNER, () => currentPlace(app, 'everyone' as never)))).toBe('LocationInputError');
    expect(await refusal(() => asSystem(() => currentPlace(app)))).toBe('LocationPrincipalError');
  });
});

describe('distanceBand', () => {
  it('bands the caller\'s stored fix against each of their places', async () => {
    const band = (placeId: string) => as(OWNER, () => distanceBand(app, 'self', placeId));
    expect(await band(ids.home)).toBe('at');
    expect(await band(ids.hood)).toBe('at');
    expect(await band(ids.cafe)).toBe('<1 km');
    expect(await band(ids.school)).toBe('<10 km');
    expect(await band(ids.far)).toBe('farther');
  });

  it('answers unknown for a stale fix, for no fix, and for a place-only fix away from the place', async () => {
    const later = Date.now() + locationBandMaxAgeMs() + 60_000;
    expect(await as(OWNER, () => distanceBand(app, 'self', ids.home, later))).toBe('unknown');
    expect(await as(MEMBER, () => distanceBand(app, 'self', ids.school))).toBe('unknown');
    const own = await insertPlace(COARSE, 'Coarse home', HOME, 100);
    const elsewhere = await insertPlace(COARSE, 'Coarse elsewhere', north(HOME, 700), 100);
    const device = await optInBrowserDevice(app, principal(COARSE), { deviceId: null, precisionClass: 'place-only' });
    await fix(COARSE, device.deviceId, HOME);
    expect(await as(COARSE, () => distanceBand(app, 'self', own))).toBe('at');
    expect(await as(COARSE, () => distanceBand(app, 'self', elsewhere))).toBe('unknown');
  });

  it('places an assigned device at its place\'s centre, and does not find a place the caller may not read', async () => {
    expect(await as(MEMBER, () => distanceBand(app, { deviceId: ids.camera }, ids.school))).toBe('at');
    expect(await as(OWNER, () => distanceBand(app, { deviceId: ids.camera }, ids.home))).toBe('<10 km');
    expect(await refusal(() => as(OWNER, () => distanceBand(app, 'self', ids.theirs)))).toBe('LocationNotFoundError');
    expect(await refusal(() => as(MEMBER, () => distanceBand(app, 'self', ids.home)))).toBe('LocationNotFoundError');
  });
});

describe('operationAddress', () => {
  it('hands server code the caller\'s own or group place\'s address and centre, and nobody else\'s', async () => {
    expect(await as(OWNER, () => operationAddress(app, ids.home))).toEqual({
      placeId: ids.home, address: 'Synthetic address 1', center: HOME, timezone: 'Atlantic/South_Georgia',
    });
    expect(await as(MEMBER, () => operationAddress(app, ids.school))).toMatchObject({ placeId: ids.school, address: null });
    expect(await refusal(() => as(MEMBER, () => operationAddress(app, ids.home)))).toBe('LocationNotFoundError');
    expect(await refusal(() => as({ ...STRANGER, operator: true }, () => operationAddress(app, ids.home)))).toBe('LocationNotFoundError');
    expect(await refusal(() => asSystem(() => operationAddress(app, ids.home)))).toBe('LocationPrincipalError');
  });

  it('exports its refusals as the named classes', () => {
    expect(new LocationInputError('x').code).toBe('location_invalid_input');
    expect(new LocationNotFoundError('place').code).toBe('location_not_found');
    expect(new LocationPrincipalError().code).toBe('location_principal_required');
  });
});
