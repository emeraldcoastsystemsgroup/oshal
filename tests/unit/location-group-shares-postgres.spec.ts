/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 done-when, group sharing on a private PostgreSQL whose tables the NOSUPERUSER NOBYPASSRLS runtime role owns (FORCE row-level security is what holds), every fix through the real browser ingest. A member who has not shared with the group is never evaluated by a group rule, and a sharing member only at the places they approved; a share over 20 places, a foreign place and a foreign device subject are refused by the service and by the database. After a member revokes a share, their rule state, share presence and fires stay theirs until they purge them, and the projection returns nothing for that share. A restriction exists only once the invited account accepts an invitation from a current admin; an invitation naming an admin is refused; the invited account cannot join unrestricted; a stale issuer is refused; a restricted member cannot be made admin. A restricted member cannot create a share; a guardian share lets its named members (and nobody else) read the minor's transitions through the projection, at approved places only and with no coordinates, and returns nothing after revocation, to a grantee removed from the group, once the restriction is lifted or once the minor has left; the minor's "who can see me" lists it with its grantees. Erasing an admin leaves no row naming them in the group's rule tables. Synthetic identities and coordinates only.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseLocationData, purgeOwnLocationHistory, type LocationPrincipal } from '@/features/location';
import { addMember, createTenant, removeMember, setMemberRole } from '@/app/routes/connector-tenancy';
import { optInBrowserDevice } from '@/app/location-consent';
import { dispatchClaimedFires, type LocationDeliveryRails } from '@/app/location-fire-dispatch';
import {
  acceptRestrictedInvite, createGuardianShare, issueRestrictedInvite, liftRestriction, parseGuardianShareRequest, readSharedPresence,
  revokeGuardianShare,
} from '@/app/location-group-shares';
import { acceptMemberShare, parseShareRequest, revokeMemberShare } from '@/app/location-member-shares';
import { readLocationOverview } from '@/app/location-overview';
import { createLocationPlace, parsePlaceInput } from '@/app/location-places';
import { ingestBrowserFix, parseBrowserFix } from '@/app/location-presence';
import { LocationRequestError } from '@/app/location-request';
import { createLocationRule, listLocationRules, parseRuleInput } from '@/app/location-rules';
import { EARTH_RADIUS_M, type GeoPoint } from '@/shared/utils/geo';
import { FIXTURE_ISSUER, asSession, convergeAppRole, locationDatabase, sqlState, type FixtureSession } from '../helpers/location-postgres-fixture';

const db = locationDatabase('location-group-shares');
let app: Pool;
const T0 = Date.now() - 6 * 3600_000;
const DEG_PER_M = 180 / (Math.PI * EARTH_RADIUS_M);
const north = (p: GeoPoint, m: number): GeoPoint => ({ lat: p.lat + m * DEG_PER_M, lon: p.lon });
const SCHOOL_AT = { lat: -12.3464, lon: -31.9884 };
const PARK_AT = north(SCHOOL_AT, 6000);
const FAR = north(SCHOOL_AT, -20000);
const S = { admin: 'loc-l5g-admin', admin2: 'loc-l5g-admin2', a: 'loc-l5g-a', b: 'loc-l5g-b', minor: 'loc-l5g-minor', grantee: 'loc-l5g-grantee', stranger: 'loc-l5g-stranger' };
const ROOT: FixtureSession = { sub: 'loc-l5g-root', operator: true };
const who = (sub: string): LocationPrincipal => ({ sub, principalIssuer: FIXTURE_ISSUER });
const ids = { group: '', school: '', park: '', schoolRule: '', parkRule: '', aShare: '', aHome: '', strangerPlace: '', strangerDevice: '' };
const devices: Record<string, string> = {};
const clock: Record<string, number> = {};
const notified: Array<{ actor: string; subject: string }> = [];
const rails: LocationDeliveryRails = { shelf: async () => true, notify: async (actor, m) => { notified.push({ actor: actor.sub, subject: m.subject }); return { delivered: true, channel: 'email' }; } };

/** One fix through the real ingest for a person, on their own monotonic scripted clock; returns fire ids. */
async function fixAt(sub: string, point: GeoPoint, afterSec = 35): Promise<string[]> {
  clock[sub] = (clock[sub] ?? 0) + afterSec;
  const t = T0 + clock[sub] * 1000;
  const fired: string[] = [];
  await ingestBrowserFix(app, who(sub), parseBrowserFix({ deviceId: devices[sub], lat: point.lat, lon: point.lon, accuracyM: 10,
    observedAt: new Date(t).toISOString() }, t), { minIntervalMs: 0, nowMs: t, onFired: (f) => fired.push(...f) });
  return fired;
}

/** Arrive at a point from far away: a far baseline fix, then two inside fixes 35 s apart. */
async function arrive(sub: string, point: GeoPoint): Promise<string[]> {
  await fixAt(sub, FAR);
  await fixAt(sub, point);
  return fixAt(sub, point);
}

const code = (work: Promise<unknown>): Promise<string> => work.then(() => 'resolved', (e) => (e instanceof LocationRequestError ? e.code : String((e as Error).message)));
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);
const seenBy = (sub: string) => readSharedPresence(app, who(sub));

/** The group, its places and rules, the people and their devices. */
async function buildWorld(): Promise<void> {
  ids.group = (await asSession({ sub: S.admin }, () => createTenant(app, { name: 'Household', createdBySub: S.admin }))).tenant_id;
  for (const sub of [S.admin2, S.a, S.b, S.grantee]) await asSession({ sub: S.admin }, () => addMember(app, ids.group, sub, S.admin, sub === S.admin2 ? 'admin' : 'member'));
  const place = async (name: string, center: GeoPoint) => (await createLocationPlace(app, who(S.admin), parsePlaceInput({ name, center, radiusM: 150, groupId: ids.group }, 'create'))).placeId;
  ids.school = await place('School', SCHOOL_AT);
  ids.park = await place('Park', PARK_AT);
  const rule = async (placeId: string) => (await createLocationRule(app, who(S.admin), parseRuleInput({ placeId, groupId: ids.group, subject: 'any-member',
    repeat: 'every-visit', action: { kind: 'notify', text: null } }))).ruleId;
  ids.schoolRule = await rule(ids.school);
  ids.parkRule = await rule(ids.park);
  for (const sub of Object.values(S)) devices[sub] = (await optInBrowserDevice(app, who(sub), { deviceId: null, precisionClass: 'block' })).deviceId;
  ids.aHome = (await createLocationPlace(app, who(S.a), parsePlaceInput({ name: 'A home', center: FAR, radiusM: 100 }, 'create'))).placeId;
  ids.strangerPlace = (await createLocationPlace(app, who(S.stranger), parsePlaceInput({ name: 'Stranger place', center: SCHOOL_AT }, 'create'))).placeId;
  ids.strangerDevice = devices[S.stranger];
  ids.aShare = (await acceptMemberShare(app, who(S.a), parseShareRequest({ tenantId: ids.group, placeIds: [ids.school] }))).shareId;
}

beforeAll(async () => {
  await db.start();
  app = await convergeAppRole(db);
  await buildWorld();
}, 180_000);

afterAll(async () => { await db.stop(); }, 60_000);

describe('group rules evaluate only sharing members, only at approved places (Q1, D4)', () => {
  it('fires for the sharing member at an approved place and never evaluates the member who did not share', async () => {
    const fired = await arrive(S.a, SCHOOL_AT);
    expect(fired).toHaveLength(1);
    expect(await arrive(S.b, SCHOOL_AT)).toEqual([]);
    expect(await count('location_rule_state WHERE owner_sub = $1', [S.b])).toBe(0);
    expect(await count('location_rule_fires WHERE owner_sub = $1', [S.b])).toBe(0);
    expect(await dispatchClaimedFires(app, rails, fired, who(S.a))).toEqual({ [fired[0]]: 'delivered' });
    expect(notified).toEqual([{ actor: S.admin, subject: 'A member of your group arrived at School' }]);
  });

  it('never evaluates a sharing member at a group place outside their approved set', async () => {
    expect(await arrive(S.a, PARK_AT)).toEqual([]);
    expect(await count('location_rule_state WHERE owner_sub = $1 AND rule_id = $2', [S.a, ids.parkRule])).toBe(0);
    const rules = await listLocationRules(app, who(S.a));
    expect(rules.watchingMe.map((r) => r.ruleId)).toEqual([ids.schoolRule]);
    expect((await listLocationRules(app, who(S.b))).watchingMe).toEqual([]);
  });

  it('refuses a set above the cap, a foreign place and a foreign device subject, in the service and in the database', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(await code(Promise.resolve().then(() => parseShareRequest({ tenantId: ids.group, placeIds: many })))).toBe('invalid_places');
    expect(await code(acceptMemberShare(app, who(S.b), parseShareRequest({ tenantId: ids.group, placeIds: [ids.aHome] })))).toBe('places_not_in_group');
    expect(await code(createLocationRule(app, who(S.a), parseRuleInput({ placeId: ids.strangerPlace, action: { kind: 'remind', text: 'x' } })))).toBe('place_not_found');
    expect(await code(createLocationRule(app, who(S.a), parseRuleInput({ placeId: ids.aHome, subject: { deviceId: ids.strangerDevice }, action: { kind: 'remind', text: 'x' } })))).toBe('device_not_found');
    expect(await code(createLocationRule(app, who(S.a), parseRuleInput({ placeId: ids.school, groupId: ids.group, subject: 'any-member', action: { kind: 'notify' } })))).toBe('group_admin_required');
    const insert = (placeId: string, kind: string, ref: string) => asSession({ sub: S.a }, () => app.query(`INSERT INTO location_rules
      (owner_sub, principal_issuer, armed_by_sub, armed_by_issuer, subject_kind, subject_ref, place_id, action_kind, action_text)
      VALUES ($1, $2, $1, $2, $3, $4, $5, 'remind', 'x')`, [S.a, FIXTURE_ISSUER, kind, ref, placeId]));
    expect(await sqlState(insert(ids.strangerPlace, 'person', S.a))).toBe('42501');
    expect(await sqlState(insert(ids.aHome, 'device', `device:${ids.strangerDevice}`))).toBe('42501');
    expect(await sqlState(insert(ids.aHome, 'device', `device:${devices[S.a]}`))).toBe('resolved');
    expect(await sqlState(asSession({ sub: S.a }, () => app.query(`INSERT INTO location_shares (owner_sub, principal_issuer, tenant_id, place_ids, geometry_digest)
      VALUES ($1, $2, $3, $4::uuid[], 'x')`, [S.a, FIXTURE_ISSUER, ids.group, many])))).not.toBe('resolved');
  });
});

describe('a revoked member share (D6: history stays until purged; the projection forgets the share)', () => {
  it('shows A at School to members while shared, and nothing once A revokes, while A keeps their rows', async () => {
    const before = await seenBy(S.b);
    expect(before.filter((r) => r.shareId === ids.aShare)).toEqual([expect.objectContaining({ shareKind: 'member', subjectSub: S.a,
      place: { placeId: ids.school, name: 'School', label: 'other' } })]);
    expect(JSON.stringify(before)).not.toMatch(/"(lat|lon|center|radius|address)/);
    expect(await seenBy(S.stranger)).toEqual([]);
    expect(await asSession(ROOT, () => seenBy(ROOT.sub))).toEqual([]);
    const kept = { state: await count('location_rule_state WHERE owner_sub = $1', [S.a]), presence: await count('location_share_presence WHERE owner_sub = $1', [S.a]),
      fires: await count('location_rule_fires WHERE owner_sub = $1', [S.a]) };
    expect(kept.state * kept.presence * kept.fires).toBeGreaterThan(0);
    await revokeMemberShare(app, who(S.a), ids.aShare);
    expect((await seenBy(S.b)).filter((r) => r.shareId === ids.aShare)).toEqual([]);
    expect((await seenBy(S.admin)).filter((r) => r.shareId === ids.aShare)).toEqual([]);
    expect(await arrive(S.a, north(SCHOOL_AT, 30))).toEqual([]);
    expect({ state: await count('location_rule_state WHERE owner_sub = $1', [S.a]), presence: await count('location_share_presence WHERE owner_sub = $1', [S.a]),
      fires: await count('location_rule_fires WHERE owner_sub = $1', [S.a]) }).toEqual(kept);
    const purged = await purgeOwnLocationHistory(app, who(S.a));
    expect(purged.evaluationCount).toBe(kept.state + kept.presence + kept.fires);
  });
});

describe('restricted invitations (Q5): a restriction exists only after the invited account accepts', () => {
  it('refuses an invitation naming an admin, keeps the invited account out until it accepts, and refuses anyone else\'s acceptance', async () => {
    expect(await code(issueRestrictedInvite(app, who(S.admin), { groupId: ids.group, account: { sub: S.admin2, issuer: FIXTURE_ISSUER } }))).toBe('invite_refused');
    expect(await code(issueRestrictedInvite(app, who(S.a), { groupId: ids.group, account: { sub: S.minor } }))).toBe('group_admin_required');
    const invite = await issueRestrictedInvite(app, who(S.admin), { groupId: ids.group, account: { sub: S.minor } });
    expect(await count('location_member_restrictions WHERE user_sub = $1', [S.minor])).toBe(0);
    expect(await sqlState(asSession({ sub: S.minor }, () => app.query("INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES ($1, $2, 'member')", [ids.group, S.minor])))).toBe('42501');
    expect(await code(acceptRestrictedInvite(app, who(S.b), invite.inviteId))).toBe('invite_not_found');
    expect(await code(acceptRestrictedInvite(app, { sub: S.minor, principalIssuer: 'https://other.example.com' }, invite.inviteId))).toBe('invite_not_found');
    expect(await acceptRestrictedInvite(app, who(S.minor), invite.inviteId)).toEqual({ groupId: ids.group, restricted: true });
    expect(await count('location_member_restrictions WHERE tenant_id = $1 AND user_sub = $2', [ids.group, S.minor])).toBe(1);
    expect(await count("oshal_tenant_memberships WHERE tenant_id = $1 AND user_sub = $2 AND role = 'member'", [ids.group, S.minor])).toBe(1);
    expect(await count('location_restricted_invites WHERE user_sub = $1', [S.minor])).toBe(0);
    expect(await code(asSession({ sub: S.admin }, () => setMemberRole(app, ids.group, S.minor, 'admin', S.admin)))).toMatch(/restricted member cannot hold admin/);
  });

  it('refuses an invitation whose issuer is no longer an admin, and a restricted member\'s own share', async () => {
    const stale = await issueRestrictedInvite(app, who(S.admin2), { groupId: ids.group, account: { sub: S.stranger } });
    await asSession({ sub: S.admin }, () => setMemberRole(app, ids.group, S.admin2, 'member', S.admin));
    expect(await code(acceptRestrictedInvite(app, who(S.stranger), stale.inviteId))).toBe('invite_stale');
    await asSession({ sub: S.admin }, () => setMemberRole(app, ids.group, S.admin2, 'admin', S.admin));
    expect(await count('location_member_restrictions WHERE user_sub = $1', [S.stranger])).toBe(0);
    expect(await code(acceptMemberShare(app, who(S.minor), parseShareRequest({ tenantId: ids.group, placeIds: [ids.school] })))).toBe('share_refused');
  });
});

describe('guardian shares (Q5): named members see a restricted member\'s transitions, nobody else', () => {
  const create = async (): Promise<string> => (await createGuardianShare(app, who(S.admin), parseGuardianShareRequest({
    tenantId: ids.group, minorSub: S.minor, grantees: [{ sub: S.grantee }], placeIds: [ids.school] }))).shareId;
  const guardianRows = async (sub: string) => (await seenBy(sub)).filter((r) => r.shareKind === 'guardian');

  it('lets the named grantee read the minor at approved places only, without coordinates, and lists it for the minor', async () => {
    const shareId = await create();
    expect(await arrive(S.minor, SCHOOL_AT)).toEqual([]);
    await arrive(S.minor, PARK_AT);
    await arrive(S.minor, SCHOOL_AT);
    const rows = await guardianRows(S.grantee);
    expect(rows).toEqual([expect.objectContaining({ shareId, subjectSub: S.minor, transition: 'enter', place: { placeId: ids.school, name: 'School', label: 'other' } })]);
    expect(JSON.stringify(rows)).not.toMatch(/"(lat|lon|center|radius|address)/);
    for (const sub of [S.b, S.admin, S.stranger]) expect(await guardianRows(sub), sub).toEqual([]);
    expect(await count('location_rule_state WHERE owner_sub = $1', [S.minor])).toBe(0);
    const visibility = (await readLocationOverview(app, who(S.minor))).visibility;
    expect(visibility.guardianShares.map((g) => [g.shareId, g.grantees])).toEqual([[shareId, [{ sub: S.grantee, issuer: FIXTURE_ISSUER }]]]);
    expect(await code(asSession({ sub: S.minor }, () => app.query('DELETE FROM location_guardian_shares WHERE share_id = $1', [shareId]).then((r) => { if (!r.rowCount) throw new Error('nothing deleted'); })))).toBe('nothing deleted');
    await revokeGuardianShare(app, who(S.admin), shareId);
    expect(await guardianRows(S.grantee)).toEqual([]);
  });

  it('returns nothing to a grantee removed from the group, once the restriction is lifted, or once the minor has left', async () => {
    await create();
    await arrive(S.minor, SCHOOL_AT);
    expect(await guardianRows(S.grantee)).toHaveLength(1);
    await asSession({ sub: S.admin }, () => removeMember(app, ids.group, S.grantee, S.admin));
    expect(await guardianRows(S.grantee)).toEqual([]);
    await asSession({ sub: S.admin }, () => addMember(app, ids.group, S.grantee, S.admin));
    expect(await guardianRows(S.grantee)).toHaveLength(1);
    expect(await liftRestriction(app, who(S.admin), ids.group, S.minor)).toEqual({ lifted: true });
    expect(await guardianRows(S.grantee)).toEqual([]);
    const again = await issueRestrictedInvite(app, who(S.admin), { groupId: ids.group, account: { sub: S.minor } });
    await acceptRestrictedInvite(app, who(S.minor), again.inviteId);
    await create();
    await arrive(S.minor, SCHOOL_AT);
    expect(await guardianRows(S.grantee)).toHaveLength(1);
    await asSession({ sub: S.admin }, () => removeMember(app, ids.group, S.minor, S.admin));
    expect(await guardianRows(S.grantee)).toEqual([]);
    expect(await count('location_guardian_shares WHERE user_sub = $1', [S.minor])).toBe(0);
  });
});

describe('erasure (D6): after an admin is erased, the group\'s rule tables name them nowhere', () => {
  it('removes the rules they armed, their own state and fires, and their name on fires they were the actor of', async () => {
    const ruleByAdmin2 = (await createLocationRule(app, who(S.admin2), parseRuleInput({ placeId: ids.school, groupId: ids.group, subject: 'any-member',
      repeat: 'every-visit', cooldownSec: 0, action: { kind: 'notify', text: 'school run' } }))).ruleId;
    await acceptMemberShare(app, who(S.admin2), parseShareRequest({ tenantId: ids.group, placeIds: [ids.school] }));
    await acceptMemberShare(app, who(S.b), parseShareRequest({ tenantId: ids.group, placeIds: [ids.school] }));
    expect((await arrive(S.admin2, SCHOOL_AT)).length).toBeGreaterThanOrEqual(1);
    expect(await arrive(S.b, SCHOOL_AT)).toHaveLength(2);
    const naming = () => Promise.all([
      count('location_rules WHERE armed_by_sub = $1 OR subject_ref = $1 OR owner_sub = $1', [S.admin2]),
      count('location_rule_state WHERE owner_sub = $1 OR subject_ref = $1', [S.admin2]),
      count('location_rule_fires WHERE owner_sub = $1 OR subject_ref = $1 OR actor_sub = $1', [S.admin2]),
    ]);
    expect((await naming()).every((n) => n > 0)).toBe(true);
    const erased = await eraseLocationData(app, who(S.admin2));
    expect(erased.stateErasersFailed).toEqual([]);
    expect(await naming()).toEqual([0, 0, 0]);
    expect(await count('location_rules WHERE rule_id = $1', [ruleByAdmin2])).toBe(0);
    expect(await count('location_rule_fires WHERE rule_id = $1 AND owner_sub = $2', [ruleByAdmin2, S.b])).toBe(1);
  });
});
