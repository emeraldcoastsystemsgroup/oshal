/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: what the Settings, Location tab shows a person about their own location, read in one transaction under their own identity. Their default precision, their own devices, their current place (the place their latest fix fell in, with its age; no coordinates: an owner coordinate read needs the step-up and is not part of this read), how many fixes their history holds, and "who can see me" (D6): the member shares they granted to groups, and any restriction or guardian share that names them. Everything a group admin or the swarm's root could otherwise see is absent by design: the location tables have no operator branch (Q2).
 *
 * @module app/location-overview
 */

import type { PoolClient } from 'pg';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { DEFAULT_LOCATION_PRECISION, toDeviceView, type LocationDeviceView } from './location-consent';

/** @description A place by reference: never its geometry or address. */
export interface LocationPlaceRef {
  placeId: string;
  name: string;
  label: string;
}

/** @description The person's current state: where their latest fix fell and how old it is. */
export interface LocationCurrentView {
  deviceId: string | null;
  source: string;
  precisionClass: string;
  accuracyM: number | null;
  receivedAt: string;
  ageSeconds: number;
  place: LocationPlaceRef | null;
}

/** @description A member share the person granted a group (Q1). */
export interface LocationMemberShareView {
  shareId: string;
  tenantId: string;
  groupName: string | null;
  places: LocationPlaceRef[];
  placeCount: number;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

/** @description A guardian share naming the person (Q5): who was granted, at which places. */
export interface LocationGuardianShareView {
  shareId: string;
  tenantId: string;
  groupName: string | null;
  grantees: Array<{ sub: string; issuer: string }>;
  places: LocationPlaceRef[];
  createdAt: string;
  revokedAt: string | null;
  active: boolean;
}

/** @description A group in which the person is a restricted member (Q5). */
export interface LocationRestrictionView {
  tenantId: string;
  groupName: string | null;
  createdAt: string;
}

/** @description "Who can see me" (ADR-169 D6). */
export interface LocationVisibility {
  memberShares: LocationMemberShareView[];
  guardianShares: LocationGuardianShareView[];
  restrictions: LocationRestrictionView[];
}

/** @description Everything the Settings, Location tab shows. */
export interface LocationOverview {
  settings: { defaultPrecisionClass: string };
  devices: LocationDeviceView[];
  current: LocationCurrentView | null;
  history: { observationCount: number };
  visibility: LocationVisibility;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

/**
 * @description The person's current row with the place it names, if they can still see that place.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @param nowMs - The clock, for the age.
 * @returns The view, or null when there is no current row.
 */
async function readCurrent(client: PoolClient, who: LocationPrincipal, nowMs: number): Promise<LocationCurrentView | null> {
  const result = await client.query(`SELECT c.device_id, c.source, c.precision_class, c.accuracy_m, c.received_at,
         c.place_id, p.name AS place_name, p.label AS place_label
    FROM location_current c LEFT JOIN location_places p ON p.place_id = c.place_id
   WHERE c.tenant_id IS NULL AND c.owner_sub = $1 AND c.principal_issuer = $2 AND c.subject_ref = $1`,
  [who.sub, who.principalIssuer]);
  const row = result.rows[0];
  if (!row) return null;
  const received = row.received_at instanceof Date ? row.received_at : new Date(String(row.received_at));
  return {
    deviceId: row.device_id ? String(row.device_id) : null,
    source: String(row.source),
    precisionClass: String(row.precision_class),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    receivedAt: received.toISOString(),
    ageSeconds: Math.max(0, Math.round((nowMs - received.getTime()) / 1000)),
    place: row.place_id && row.place_name
      ? { placeId: String(row.place_id), name: String(row.place_name), label: String(row.place_label) } : null,
  };
}

/**
 * @description Names of the places and groups the visibility rows reference, as far as the person
 * can see them (a group they have left reads as unnamed).
 * @param client - A client stamped as the person.
 * @param placeIds - Every referenced place id.
 * @param tenantIds - Every referenced group id.
 * @returns Lookup maps.
 */
async function readNames(client: PoolClient, placeIds: string[], tenantIds: string[]): Promise<{
  places: Map<string, LocationPlaceRef>; groups: Map<string, string | null>;
}> {
  const places = new Map<string, LocationPlaceRef>();
  const groups = new Map<string, string | null>();
  if (placeIds.length) {
    const rows = await client.query('SELECT place_id, name, label FROM location_places WHERE place_id = ANY($1::uuid[])', [placeIds]);
    for (const r of rows.rows) places.set(String(r.place_id), { placeId: String(r.place_id), name: String(r.name), label: String(r.label) });
  }
  if (tenantIds.length) {
    const rows = await client.query('SELECT tenant_id, name FROM oshal_tenants WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
    for (const r of rows.rows) groups.set(String(r.tenant_id), r.name === null ? null : String(r.name));
  }
  return { places, groups };
}

/**
 * @description Place references for a stored id array, skipping ones the person can no longer see.
 * @param ids - The array column.
 * @param places - The lookup.
 * @returns The references.
 */
function placeRefs(ids: unknown, places: Map<string, LocationPlaceRef>): LocationPlaceRef[] {
  return (Array.isArray(ids) ? ids : []).map((id) => places.get(String(id))).filter((p): p is LocationPlaceRef => Boolean(p));
}

/**
 * @description Read "who can see me": member shares granted, guardian shares and restrictions naming the person.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @param nowMs - The clock, for the active flag.
 * @returns The visibility lists.
 */
async function readVisibility(client: PoolClient, who: LocationPrincipal, nowMs: number): Promise<LocationVisibility> {
  const shares = (await client.query(`SELECT share_id, tenant_id, place_ids, created_at, expires_at, revoked_at
    FROM location_shares WHERE owner_sub = $1 AND principal_issuer = $2 ORDER BY created_at`, [who.sub, who.principalIssuer])).rows as Row[];
  const guardian = (await client.query(`SELECT share_id, tenant_id, grantees, place_ids, created_at, revoked_at
    FROM location_guardian_shares WHERE user_sub = $1 ORDER BY created_at`, [who.sub])).rows as Row[];
  const restrictions = (await client.query(`SELECT tenant_id, created_at FROM location_member_restrictions
    WHERE user_sub = $1 ORDER BY created_at`, [who.sub])).rows as Row[];
  const placeIds = [...shares, ...guardian].flatMap((r) => (Array.isArray(r.place_ids) ? r.place_ids.map(String) : []));
  const tenantIds = [...shares, ...guardian, ...restrictions].map((r) => String(r.tenant_id));
  const { places, groups } = await readNames(client, [...new Set(placeIds)], [...new Set(tenantIds)]);
  const live = (revoked: unknown, expires?: unknown): boolean =>
    !revoked && (!expires || new Date(expires as string | Date).getTime() > nowMs);
  return {
    memberShares: shares.map((r) => ({
      shareId: String(r.share_id), tenantId: String(r.tenant_id), groupName: groups.get(String(r.tenant_id)) ?? null,
      places: placeRefs(r.place_ids, places), placeCount: Array.isArray(r.place_ids) ? r.place_ids.length : 0,
      createdAt: iso(r.created_at) ?? '', expiresAt: iso(r.expires_at), revokedAt: iso(r.revoked_at), active: live(r.revoked_at, r.expires_at),
    })),
    guardianShares: guardian.map((r) => ({
      shareId: String(r.share_id), tenantId: String(r.tenant_id), groupName: groups.get(String(r.tenant_id)) ?? null,
      grantees: (Array.isArray(r.grantees) ? r.grantees : []).map((g: Row) => ({ sub: String(g.sub), issuer: String(g.issuer) })),
      places: placeRefs(r.place_ids, places), createdAt: iso(r.created_at) ?? '', revokedAt: iso(r.revoked_at), active: live(r.revoked_at),
    })),
    restrictions: restrictions.map((r) => ({
      tenantId: String(r.tenant_id), groupName: groups.get(String(r.tenant_id)) ?? null, createdAt: iso(r.created_at) ?? '',
    })),
  };
}

/**
 * @description Everything the Settings, Location tab shows, read under the person's own identity.
 * No coordinate leaves this function.
 * @param db - The pool.
 * @param principal - The person.
 * @param nowMs - The clock (injectable for tests).
 * @returns The overview.
 */
export async function readLocationOverview(db: LocationDb, principal: LocationPrincipal, nowMs: number = Date.now()): Promise<LocationOverview> {
  return withLocationOwnerSession(db, principal, async (client, who) => {
    const settings = await client.query(
      'SELECT default_precision_class FROM location_settings WHERE owner_sub = $1 AND principal_issuer = $2', [who.sub, who.principalIssuer]);
    const devices = await client.query(`SELECT device_id, device_kind, reporting_enabled, precision_class, last_seen_at, created_at
      FROM location_devices WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 ORDER BY created_at`, [who.sub, who.principalIssuer]);
    const history = await client.query(`SELECT count(*)::int AS n FROM location_observations
      WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2`, [who.sub, who.principalIssuer]);
    return {
      settings: { defaultPrecisionClass: String(settings.rows[0]?.default_precision_class ?? DEFAULT_LOCATION_PRECISION) },
      devices: devices.rows.map(toDeviceView),
      current: await readCurrent(client, who, nowMs),
      history: { observationCount: Number(history.rows[0]?.n ?? 0) },
      visibility: await readVisibility(client, who, nowMs),
    };
  });
}
