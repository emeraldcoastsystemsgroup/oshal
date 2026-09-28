/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2 done-when, proven against the enforcing role: a private PostgreSQL with the shipped migrations 060/100/174/175, every table owned by the NOSUPERUSER NOBYPASSRLS runtime role oshal_app (as the provisioner leaves a real deployment, so FORCE is what holds), and identities stamped by the real GUC pool wrapper and request-identity seam. Owner vs stranger, same subject under another issuer, member reads but cannot write group rows, an operator-stamped session and a group admin read no one else's rows, the membership fence (self-add, operator self-add, self-promotion, the empty-and-rewrite-creator hijack) with all three core membership writers still succeeding, SYSTEM denied, the owner's purge counted before and after, a group admin's device purge and a member refused, member shares refused for a restricted member and below the precision floor, guardian shares written only by the minor's group admin within the group's members and places and 20-place cap, restrictions with no insert path, and the live catalog free of any oshal.is_operator in a location policy or the helpers it calls.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createTenant, setMemberRole } from '@/app/routes/connector-tenancy';
import {
  LOCATION_TABLES, LocationForbiddenError, inspectLocationRlsPosture, purgeGroupDeviceHistory, purgeOwnLocationHistory,
} from '@/features/location';
import {
  FIXTURE_ISSUER, LOCATION_APP_ROLE, asSession, asSystem, convergeAppRole, inRolledBackTransaction, locationDatabase, sqlState,
  type FixtureSession,
} from '../helpers/location-postgres-fixture';

const db = locationDatabase('location-storage-rls');
let app: Pool;

const OWNER: FixtureSession = { sub: 'loc-owner' };
const STRANGER: FixtureSession = { sub: 'loc-stranger' };
const ROOT: FixtureSession = { sub: 'loc-root', operator: true };
const ADMIN: FixtureSession = { sub: 'loc-admin' };
const MEMBER: FixtureSession = { sub: 'loc-member' };
const MINOR: FixtureSession = { sub: 'loc-minor' };
const OUTSIDER: FixtureSession = { sub: 'loc-outsider' };
const OTHER_ISSUER = 'https://other-login.oshal.example.com';

/** Seeded ids. */
const ids = { group: '', otherGroup: '', place: '', smallPlace: '', otherPlace: '', drone: '', groupPlaces: [] as string[] };

const q = (who: FixtureSession, sql: string, params: unknown[] = []) => asSession(who, () => app.query(sql, params));
const truth = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);
const seen = async (who: FixtureSession, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await q(who, `SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);

const INSERT_PERSON_OBS = `INSERT INTO location_observations
  (owner_sub, principal_issuer, subject_ref, source, precision_class, lat, lon, accuracy_m, observed_at)
  VALUES ($1, $2, $1, 'browser', 'block', -12.346, -31.988, 20, NOW())`;
const INSERT_PERSON_CURRENT = `INSERT INTO location_current
  (owner_sub, principal_issuer, subject_ref, source, precision_class, lat, lon, accuracy_m, observed_at)
  VALUES ($1, $2, $1, 'browser', 'block', -12.346, -31.988, 20, NOW())`;
const INSERT_GROUP_PLACE = `INSERT INTO location_places (tenant_id, name, label, center_lat, center_lon, radius_m, created_by_sub)
  VALUES ($1, $2, 'home', -12.346, -31.988, $3, $4) RETURNING place_id`;
const INSERT_SHARE = `INSERT INTO location_shares (owner_sub, principal_issuer, tenant_id, place_ids, geometry_digest)
  VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING share_id`;
const INSERT_GUARDIAN = `INSERT INTO location_guardian_shares (tenant_id, user_sub, granted_by_sub, grantees, place_ids, geometry_digest)
  VALUES ($1, $2, $3, $4::jsonb, $5::uuid[], $6) RETURNING share_id`;

/** Digest of a set of the group's places, as the session sees them. */
async function digest(who: FixtureSession, places: string[], tenant = ids.group): Promise<string | null> {
  return (await q(who, 'SELECT location_places_digest($1, $2::uuid[]) AS d', [tenant, places])).rows[0].d;
}

/** A person's own settings, place, carried browser device, three fixes and current row, written through RLS. */
async function seedPerson(who: FixtureSession): Promise<void> {
  const params = [who.sub, FIXTURE_ISSUER];
  await q(who, 'INSERT INTO location_settings (owner_sub, principal_issuer) VALUES ($1, $2)', params);
  const place = await q(who, `INSERT INTO location_places (owner_sub, principal_issuer, name, label, center_lat, center_lon, radius_m, created_by_sub)
    VALUES ($1, $2, 'Home', 'home', -12.346, -31.988, 100, $1) RETURNING place_id`, params);
  await q(who, `INSERT INTO location_devices (device_kind, device_ref, owner_sub, principal_issuer, carried_by_sub, place_id)
    VALUES ('browser', $1 || '-browser', $1, $2, $1, $3)`, [...params, place.rows[0].place_id]);
  for (let i = 0; i < 3; i += 1) await q(who, INSERT_PERSON_OBS, params);
  await q(who, INSERT_PERSON_CURRENT, params);
}

/** The household group through the real core writers, its places, a group drone and its fixes. */
async function seedGroup(): Promise<void> {
  ids.group = (await asSession(ADMIN, () => createTenant(app, { name: 'Household', createdBySub: ADMIN.sub }))).tenant_id;
  await asSession(ADMIN, () => addMember(app, ids.group, MEMBER.sub, ADMIN.sub));
  await asSession(ADMIN, () => addMember(app, ids.group, MINOR.sub, ADMIN.sub));
  for (let i = 0; i < 21; i += 1) {
    ids.groupPlaces.push((await q(ADMIN, INSERT_GROUP_PLACE, [ids.group, `Place ${i}`, 150, ADMIN.sub])).rows[0].place_id);
  }
  ids.place = ids.groupPlaces[0];
  ids.smallPlace = (await q(ADMIN, INSERT_GROUP_PLACE, [ids.group, 'Small', 60, ADMIN.sub])).rows[0].place_id;
  ids.otherGroup = (await asSession(OUTSIDER, () => createTenant(app, { name: 'Elsewhere', createdBySub: OUTSIDER.sub }))).tenant_id;
  ids.otherPlace = (await q(OUTSIDER, INSERT_GROUP_PLACE, [ids.otherGroup, 'Theirs', 150, OUTSIDER.sub])).rows[0].place_id;
  ids.drone = (await q(ADMIN, `INSERT INTO location_devices (device_kind, device_ref, tenant_id, precision_class)
    VALUES ('drone', 'drone-fixture-1', $1, 'exact') RETURNING device_id`, [ids.group])).rows[0].device_id;
  for (let i = 0; i < 2; i += 1) {
    await q(ADMIN, `INSERT INTO location_observations (tenant_id, subject_ref, device_id, source, precision_class, lat, lon, observed_at)
      VALUES ($1, 'device:' || $2::text, $2::uuid, 'mavlink', 'exact', -12.34567, -31.98765, NOW())`, [ids.group, ids.drone]);
  }
  await q(ADMIN, `INSERT INTO location_current (tenant_id, subject_ref, device_id, source, precision_class, lat, lon, observed_at)
    VALUES ($1, 'device:' || $2::text, $2::uuid, 'mavlink', 'exact', -12.34567, -31.98765, NOW())`, [ids.group, ids.drone]);
  // The restriction row stands in for L5's acceptance function, the only writer the schema allows.
  await db.pool.query('INSERT INTO location_member_restrictions (tenant_id, user_sub, issued_by_sub) VALUES ($1, $2, $3)',
    [ids.group, MINOR.sub, ADMIN.sub]);
}

beforeAll(async () => {
  await db.start();
  app = await convergeAppRole(db);
  await seedPerson(OWNER);
  await seedPerson(STRANGER);
  await seedGroup();
}, 180_000);
afterAll(async () => { await db.stop(); });

describe('ADR-169 L2 location storage on PostgreSQL, as the enforcing role', () => {
  it('runs as a non-superuser table owner, with every location table forced and nothing else named location_', async () => {
    const role = await db.rolePool(LOCATION_APP_ROLE).query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const tables = (await db.pool.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c WHERE c.relkind = 'r' AND c.relname LIKE 'location\\_%' ORDER BY c.relname`)).rows;
    expect(tables.map((t) => t.relname)).toEqual([...LOCATION_TABLES].sort());
    for (const t of tables) expect(t, t.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owner: LOCATION_APP_ROLE });
  });

  it('lets an owner read their own rows and a stranger, or the same subject under another issuer, read none', async () => {
    for (const table of ['location_settings', 'location_places', 'location_devices', 'location_observations', 'location_current']) {
      const own = `${table} WHERE owner_sub = $1`;
      expect(await seen(OWNER, own, [OWNER.sub]), table).toBe(await truth(own, [OWNER.sub]));
      expect(await truth(own, [OWNER.sub]), table).toBeGreaterThan(0);
      expect(await seen(STRANGER, own, [OWNER.sub]), table).toBe(0);
      expect(await seen({ sub: OWNER.sub, issuer: OTHER_ISSUER }, own, [OWNER.sub]), table).toBe(0);
      expect(await seen({ sub: OWNER.sub, issuer: null }, own, [OWNER.sub]), table).toBe(0);
    }
    expect(await sqlState(q(STRANGER, INSERT_PERSON_OBS, [OWNER.sub, FIXTURE_ISSUER]))).toBe('42501');
    expect((await q(STRANGER, 'UPDATE location_settings SET default_precision_class = $2 WHERE owner_sub = $1', [OWNER.sub, 'exact'])).rowCount).toBe(0);
  });

  it('lets a group member read group rows but not write them, while the group admin can', async () => {
    for (const table of ['location_places', 'location_devices', 'location_observations', 'location_current']) {
      const group = `${table} WHERE tenant_id = $1`;
      expect(await seen(MEMBER, group, [ids.group]), table).toBe(await truth(group, [ids.group]));
      expect(await seen(STRANGER, group, [ids.group]), table).toBe(0);
    }
    expect(await sqlState(q(MEMBER, INSERT_GROUP_PLACE, [ids.group, 'Mine now', 150, MEMBER.sub]))).toBe('42501');
    expect((await q(MEMBER, 'UPDATE location_places SET radius_m = 5000 WHERE place_id = $1', [ids.place])).rowCount).toBe(0);
    expect((await q(MEMBER, 'DELETE FROM location_devices WHERE device_id = $1', [ids.drone])).rowCount).toBe(0);
    expect((await q(MEMBER, 'DELETE FROM location_observations WHERE tenant_id = $1', [ids.group])).rowCount).toBe(0);
    expect(await truth('location_places WHERE place_id = $1 AND radius_m = 150', [ids.place])).toBe(1);
    await inRolledBackTransaction(app, ADMIN, async (client) => {
      expect((await client.query('UPDATE location_places SET radius_m = 200 WHERE place_id = $1', [ids.place])).rowCount).toBe(1);
    });
  });

});

describe('ADR-169 L2 operator-stamped and group-admin sessions, as the enforcing role', () => {
  it('shows an operator-stamped session and a group admin no one else\'s rows', async () => {
    for (const table of ['location_settings', 'location_places', 'location_devices', 'location_observations', 'location_current', 'location_shares']) {
      expect(await seen(ROOT, table), table).toBe(0);
      expect(await seen({ ...ADMIN, operator: true }, `${table} WHERE owner_sub IS NOT NULL`), table).toBe(0);
    }
    expect(await seen(ROOT, 'location_member_restrictions')).toBe(0);
    expect(await seen(ROOT, 'location_guardian_shares')).toBe(0);
    expect(await sqlState(q(ROOT, INSERT_GROUP_PLACE, [ids.group, 'Root place', 150, ROOT.sub]))).toBe('42501');
    expect((await q(ROOT, 'DELETE FROM location_observations')).rowCount).toBe(0);
  });

});

describe('ADR-169 L2 membership fence, as the enforcing role', () => {
  it('fences memberships: no one joins a group they do not administer, whatever is_operator says', async () => {
    const join = (who: FixtureSession, tenant: string, sub: string, role = 'member') =>
      q(who, 'INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, $3)', [tenant, sub, role]);
    expect(await sqlState(join(ROOT, ids.group, ROOT.sub, 'admin'))).toBe('42501');
    expect(await sqlState(join(OWNER, ids.group, OWNER.sub))).toBe('42501');
    expect(await sqlState(join(MEMBER, ids.group, OUTSIDER.sub))).toBe('42501');
    expect(await sqlState(join(OUTSIDER, ids.group, OUTSIDER.sub, 'admin'))).toBe('42501');
    expect(await sqlState(asSystem(() => app.query('INSERT INTO oshal_tenant_memberships (tenant_id, user_sub) VALUES ($1, $2)', [ids.group, ROOT.sub])))).toBe('42501');
    expect(await sqlState(q(MEMBER, "UPDATE oshal_tenant_memberships SET role = 'admin' WHERE tenant_id = $1 AND user_sub = $2", [ids.group, MEMBER.sub]))).toBe('42501');
    expect(await seen(ROOT, 'location_places WHERE tenant_id = $1', [ids.group])).toBe(0);
    expect(await truth("oshal_tenant_memberships WHERE tenant_id = $1 AND user_sub IN ('loc-root', 'loc-owner', 'loc-outsider')", [ids.group])).toBe(0);
  });

  it('refuses the empty-the-group-and-rewrite-its-creator path to a first-row self-add', async () => {
    const kAdmin: FixtureSession = { sub: 'loc-k-admin' };
    const k = (await asSession(kAdmin, () => createTenant(app, { name: 'Scratch', createdBySub: kAdmin.sub }))).tenant_id;
    await q(kAdmin, INSERT_GROUP_PLACE, [k, 'K place', 150, kAdmin.sub]);
    expect((await q(ROOT, 'DELETE FROM oshal_tenant_memberships WHERE tenant_id = $1', [k])).rowCount).toBe(1);
    expect(await sqlState(q(ROOT, 'UPDATE oshal_tenants SET created_by_sub = $2 WHERE tenant_id = $1', [k, ROOT.sub]))).toBe('42501');
    expect(await sqlState(q(ROOT, "INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'admin')", [k, ROOT.sub]))).toBe('42501');
    expect(await seen(ROOT, 'location_places WHERE tenant_id = $1', [k])).toBe(0);
    // Its own creator may still re-enter its emptied group as the first row.
    expect(await sqlState(q(kAdmin, "INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'admin')", [k, kAdmin.sub]))).toBe('resolved');
  });

  it('keeps all three core membership writers working', async () => {
    const founder: FixtureSession = { sub: 'loc-founder' };
    const t = (await asSession(founder, () => createTenant(app, { name: 'Founded', createdBySub: founder.sub }))).tenant_id;
    await asSession(founder, () => addMember(app, t, 'loc-founder-member', founder.sub));
    await asSession(founder, () => setMemberRole(app, t, 'loc-founder-member', 'admin', founder.sub));
    await asSession(founder, () => setMemberRole(app, t, 'loc-founder-member', 'member', founder.sub));
    const rows = (await db.pool.query('SELECT user_sub, role FROM oshal_tenant_memberships WHERE tenant_id = $1 ORDER BY user_sub', [t])).rows;
    expect(rows).toEqual([{ user_sub: 'loc-founder', role: 'admin' }, { user_sub: 'loc-founder-member', role: 'member' }]);
    await expect(asSession(MEMBER, () => addMember(app, t, MEMBER.sub, MEMBER.sub))).rejects.toThrow('not a tenant admin');
  });

});

describe('ADR-169 L2 SYSTEM, as the enforcing role', () => {
  it('denies SYSTEM every location read and write', async () => {
    for (const table of LOCATION_TABLES) expect(await asSystem(async () => Number((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)), table).toBe(0);
    expect(await sqlState(asSystem(() => app.query(INSERT_PERSON_OBS, [OWNER.sub, FIXTURE_ISSUER])))).toBe('42501');
    expect(await sqlState(asSystem(() => app.query(INSERT_GROUP_PLACE, [ids.group, 'System', 150, 'loc-system'])))).toBe('42501');
    expect(await asSystem(async () => (await app.query('DELETE FROM location_current')).rowCount)).toBe(0);
  });
});

describe('ADR-169 L2 member shares', () => {
  it('refuses a member share from a restricted member, outside the group, over the cap or finer than the floor', async () => {
    const two = ids.groupPlaces.slice(0, 2);
    const share = (who: FixtureSession, places: string[], d: string | null) =>
      q(who, INSERT_SHARE, [who.sub, FIXTURE_ISSUER, ids.group, places, d]);
    expect(await sqlState(share(MEMBER, two, await digest(MEMBER, two)))).toBe('resolved');
    expect(await sqlState(share(MINOR, two, await digest(MINOR, two)))).toBe('42501');
    expect(await sqlState(share(MEMBER, [ids.place, ids.otherPlace], await digest(MEMBER, [ids.place])))).toBe('42501');
    expect(await sqlState(share(OUTSIDER, two, 'x'))).toBe('42501');
    expect(['42501', '23514']).toContain(await sqlState(share(MEMBER, ids.groupPlaces, await digest(MEMBER, ids.groupPlaces))));
    expect(await sqlState(share(MEMBER, [ids.smallPlace], await digest(MEMBER, [ids.smallPlace])))).toBe('42501');
    await inRolledBackTransaction(app, MEMBER, async (client) => {
      await client.query("INSERT INTO location_settings (owner_sub, principal_issuer, default_precision_class) VALUES ($1, $2, 'exact')", [MEMBER.sub, FIXTURE_ISSUER]);
      const d = (await client.query('SELECT location_places_digest($1, $2::uuid[]) AS d', [ids.group, [ids.smallPlace]])).rows[0].d;
      await client.query(INSERT_SHARE, [MEMBER.sub, FIXTURE_ISSUER, ids.group, [ids.smallPlace], d]);
    });
  });

  it('lets a grantor revoke after the approved geometry changed, and not reinstate the stale approval', async () => {
    const places = [ids.groupPlaces[3]];
    const shareId = (await q(MEMBER, INSERT_SHARE, [MEMBER.sub, FIXTURE_ISSUER, ids.group, places, await digest(MEMBER, places)])).rows[0].share_id;
    await q(ADMIN, 'UPDATE location_places SET radius_m = 400 WHERE place_id = $1', [places[0]]);
    expect((await q(MEMBER, 'UPDATE location_shares SET revoked_at = NOW() WHERE share_id = $1', [shareId])).rowCount).toBe(1);
    expect(await sqlState(q(MEMBER, 'UPDATE location_shares SET revoked_at = NULL WHERE share_id = $1', [shareId]))).toBe('42501');
    expect(await seen(ADMIN, 'location_shares WHERE share_id = $1', [shareId])).toBe(0);
  });

});

describe('ADR-169 L2 guardian shares and restrictions', () => {
  it('lets only the minor\'s group admin write a guardian share, to members of that group over its places', async () => {
    const places = [ids.place];
    const d = await digest(ADMIN, places);
    const grant = (who: FixtureSession, minor: string, grantees: unknown, p = places, dg = d) =>
      q(who, INSERT_GUARDIAN, [ids.group, minor, who.sub, JSON.stringify(grantees), p, dg]);
    const toMember = [{ sub: MEMBER.sub, issuer: FIXTURE_ISSUER }];
    expect(await sqlState(grant(ADMIN, MINOR.sub, toMember))).toBe('resolved');
    expect(await sqlState(grant(MEMBER, MINOR.sub, toMember, places, await digest(MEMBER, places)))).toBe('42501');
    expect(await sqlState(grant(ROOT, MINOR.sub, toMember))).toBe('42501');
    expect(await sqlState(grant(ADMIN, MINOR.sub, [{ sub: OUTSIDER.sub, issuer: FIXTURE_ISSUER }]))).toBe('42501');
    expect(await sqlState(grant(ADMIN, MINOR.sub, [{ sub: MINOR.sub, issuer: FIXTURE_ISSUER }]))).toBe('42501');
    expect(await sqlState(grant(ADMIN, MINOR.sub, [...toMember, ...toMember]))).toBe('42501');
    expect(await sqlState(grant(ADMIN, MINOR.sub, toMember, [ids.place, ids.otherPlace], d))).toBe('42501');
    expect(['42501', '23514']).toContain(await sqlState(grant(ADMIN, MINOR.sub, toMember, ids.groupPlaces, await digest(ADMIN, ids.groupPlaces))));
    expect(await sqlState(grant(ADMIN, MEMBER.sub, [{ sub: ADMIN.sub, issuer: FIXTURE_ISSUER }]))).not.toBe('resolved');
    expect(await truth('location_guardian_shares WHERE user_sub = $1', [MINOR.sub])).toBe(1);
  });

  it('lets the minor see but not delete a guardian share or their restriction, and gives grantees nothing on the base table', async () => {
    expect(await seen(MINOR, 'location_guardian_shares')).toBe(1);
    expect((await q(MINOR, 'DELETE FROM location_guardian_shares')).rowCount).toBe(0);
    expect(await seen(MEMBER, 'location_guardian_shares')).toBe(0);
    expect(await seen(MINOR, 'location_member_restrictions')).toBe(1);
    expect((await q(MINOR, 'DELETE FROM location_member_restrictions')).rowCount).toBe(0);
    expect(await truth('location_guardian_shares WHERE user_sub = $1', [MINOR.sub])).toBe(1);
    expect(await truth('location_member_restrictions WHERE user_sub = $1', [MINOR.sub])).toBe(1);
  });

  it('has no insert path for a restriction, not even for an admin, and no way to re-point one', async () => {
    const restrict = (who: FixtureSession, sub: string) =>
      q(who, 'INSERT INTO location_member_restrictions (tenant_id, user_sub, issued_by_sub) VALUES ($1, $2, $3)', [ids.group, sub, who.sub]);
    expect(await sqlState(restrict(ADMIN, MEMBER.sub))).toBe('42501');
    expect(await sqlState(restrict(ROOT, MEMBER.sub))).toBe('42501');
    expect(await sqlState(q(ADMIN, 'UPDATE location_member_restrictions SET user_sub = $2 WHERE user_sub = $1', [MINOR.sub, MEMBER.sub]))).toBe('42501');
    expect((await q(MEMBER, 'DELETE FROM location_member_restrictions')).rowCount).toBe(0);
    expect((await q(MEMBER, "UPDATE location_member_restrictions SET issued_by_sub = 'x'")).rowCount).toBe(0);
    expect(await seen(MEMBER, 'location_member_restrictions')).toBe(0);
    await inRolledBackTransaction(app, ADMIN, async (client) => {
      expect((await client.query('DELETE FROM location_member_restrictions WHERE user_sub = $1', [MINOR.sub])).rowCount).toBe(1);
      expect(Number((await client.query('SELECT count(*)::int AS n FROM location_guardian_shares')).rows[0].n)).toBe(0);
    });
  });
});

describe('ADR-169 L2 purge (Q4: kept until the owner purges it)', () => {
  it('purges the owner\'s observations and current row, counted before and after, and no one else\'s', async () => {
    const mine = 'WHERE owner_sub = $1';
    const before = { obs: await truth(`location_observations ${mine}`, [OWNER.sub]), cur: await truth(`location_current ${mine}`, [OWNER.sub]),
      strangerObs: await truth(`location_observations ${mine}`, [STRANGER.sub]), groupObs: await truth('location_observations WHERE tenant_id IS NOT NULL') };
    expect(before).toMatchObject({ obs: 3, cur: 1, strangerObs: 3 });
    const result = await asSession(ROOT, () => purgeOwnLocationHistory(app, { sub: OWNER.sub, principalIssuer: FIXTURE_ISSUER }));
    expect(result).toEqual({ observationCount: 3, currentCount: 1 });
    expect(await truth(`location_observations ${mine}`, [OWNER.sub])).toBe(0);
    expect(await truth(`location_current ${mine}`, [OWNER.sub])).toBe(0);
    expect(await truth(`location_observations ${mine}`, [STRANGER.sub])).toBe(before.strangerObs);
    expect(await truth(`location_current ${mine}`, [STRANGER.sub])).toBe(1);
    expect(await truth('location_observations WHERE tenant_id IS NOT NULL')).toBe(before.groupObs);
    expect(await truth(`location_places ${mine}`, [OWNER.sub])).toBe(1);
  });

  it('lets a group admin purge a group device and refuses a member, whose raw delete also reaches nothing', async () => {
    const drone = 'WHERE tenant_id = $1 AND subject_ref = $2';
    const params = [ids.group, `device:${ids.drone}`];
    await expect(purgeGroupDeviceHistory(app, { sub: MEMBER.sub, principalIssuer: FIXTURE_ISSUER }, ids.group, ids.drone))
      .rejects.toBeInstanceOf(LocationForbiddenError);
    expect((await q(MEMBER, `DELETE FROM location_observations ${drone}`, params)).rowCount).toBe(0);
    expect(await truth(`location_observations ${drone}`, params)).toBe(2);
    const result = await purgeGroupDeviceHistory(app, { sub: ADMIN.sub, principalIssuer: FIXTURE_ISSUER }, ids.group, ids.drone);
    expect(result).toEqual({ observationCount: 2, currentCount: 1 });
    expect(await truth(`location_observations ${drone}`, params)).toBe(0);
  });
});

describe('ADR-169 L2 no operator bypass, read from the live catalog', () => {
  it('finds every location table forced with policies, no oshal.is_operator in them or the helpers they reach, and both fences', async () => {
    const posture = await inspectLocationRlsPosture(db.pool);
    for (const t of posture.tables) expect(t, t.table).toMatchObject({ present: true, enabled: true, forced: true });
    for (const t of posture.tables) expect(t.policies, t.table).toBeGreaterThan(0);
    expect(posture.functionsChecked).toEqual(expect.arrayContaining(['oshal_is_tenant_admin', 'location_member_share_admissible']));
    expect(posture.bypasses).toEqual([]);
    expect(posture).toMatchObject({ membershipFence: true, creatorFence: true, tenantAdminHelper: true });
    expect((await inspectLocationRlsPosture(db.rolePool(LOCATION_APP_ROLE))).role).toEqual({ superuser: false, bypassRls: false });
  });

  it('goes red on a planted bypass policy', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE POLICY planted_bypass ON location_observations FOR SELECT
        USING (current_setting('oshal.is_operator', true) = 'on')`);
      expect((await inspectLocationRlsPosture(client)).bypasses).toEqual(['policy location_observations.planted_bypass']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
