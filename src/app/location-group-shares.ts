/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 (D6, Q5): restricted (minor) members and guardian shares, and what a group shares with the person. A group admin invites one account (subject and issuer) to join as a restricted member; only that account can accept, through migration 177's acceptance function, which refuses an expired invitation, one whose issuer is no longer an admin and an account holding admin in the group, and which is the only writer of a restriction. Accepting is a consent change that lets a guardian share expose the account's place transitions, so the route spends a step-up proof for it. An admin may lift a restriction (its guardian shares go with it). A group admin shares a restricted member's place transitions with named current members of the same group over an explicit set of that group's places (1 to 20, each no finer than the minor's precision), with the step-up proof, and may revoke it; the minor sees it in "who can see me" and cannot delete it. What any share exposes is read only through location_shared_presence(), which re-checks share, membership and restriction on every read and returns places by reference and enter/exit with "since", never coordinates. Every statement runs in the person's own owner session; the database's policies and predicates decide, and a refusal is mapped to a coded answer without saying which rule failed.
 *
 * @module app/location-group-shares
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { LOCATION_SHARE_PLACE_CAP } from './location-member-shares';
import { requireGroupAdmin } from './location-places';
import { LOCATION_ID_SHAPE, LocationRequestError, requireLocationId } from './location-request';

const log = createChildLogger({ module: 'location-group-shares' });

/** @description How long an invitation stays open when the admin names no expiry, days. */
export const LOCATION_INVITE_DEFAULT_DAYS = 14;

/** @description The longest an invitation may stay open, days. */
export const LOCATION_INVITE_MAX_DAYS = 90;

/** @description An account named by subject and verified issuer. */
export interface LocationAccountRef {
  sub: string;
  issuer: string;
}

/** @description A validated guardian share request: canonical (sorted) grantees and places. */
export interface LocationGuardianShareRequest {
  tenantId: string;
  minorSub: string;
  grantees: LocationAccountRef[];
  placeIds: string[];
}

/** @description One row of what the person's groups share with them. */
export interface LocationSharedPresenceView {
  shareKind: 'member' | 'guardian';
  shareId: string;
  groupId: string;
  subjectSub: string;
  place: { placeId: string; name: string; label: string };
  transition: 'enter' | 'exit';
  since: string | null;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

/**
 * @description Read an account reference: a subject, and an issuer that may be left empty (it then
 * defaults to the acting admin's own issuer, see {@link withIssuer}).
 * @param raw - { sub, issuer }.
 * @param field - The field name, for the refusal.
 * @returns The reference.
 * @throws {LocationRequestError} 400 invalid_<field>.
 */
function requireAccount(raw: unknown, field: string): LocationAccountRef {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Row;
  const sub = typeof input.sub === 'string' ? input.sub.trim() : '';
  const issuer = typeof input.issuer === 'string' ? input.issuer.trim() : '';
  if (!sub || sub.length > 512 || issuer.length > 512) {
    throw new LocationRequestError(`invalid_${field}`, 400, `${field} needs a subject (and, when it differs from yours, an issuer).`);
  }
  return { sub, issuer };
}

/**
 * @description Fill an account's missing issuer with the acting admin's own (a household usually
 * signs in through one identity provider); an explicit issuer is kept.
 * @param account - The account as parsed.
 * @param who - The acting admin.
 * @returns The account with an issuer.
 */
function withIssuer(account: LocationAccountRef, who: LocationPrincipal): LocationAccountRef {
  return { sub: account.sub, issuer: account.issuer || who.principalIssuer };
}

/**
 * @description Validate a guardian share request into its canonical form (the step-up digest is taken over it).
 * @param body - The parsed JSON body.
 * @returns The request.
 * @throws {LocationRequestError} 400 for a malformed group, minor, grantee list or place set.
 */
export function parseGuardianShareRequest(body: unknown): LocationGuardianShareRequest {
  const input = (body && typeof body === 'object' ? body : {}) as Row;
  const tenantId = requireLocationId(input.tenantId, 'invalid_group', 'tenantId');
  const minorSub = typeof input.minorSub === 'string' ? input.minorSub.trim() : '';
  if (!minorSub || minorSub.length > 512) throw new LocationRequestError('invalid_minor', 400, 'minorSub names the restricted member.');
  const rawGrantees = Array.isArray(input.grantees) ? input.grantees : [];
  if (!rawGrantees.length || rawGrantees.length > 50) throw new LocationRequestError('invalid_grantees', 400, 'Name 1 to 50 grantees.');
  const grantees = rawGrantees.map((g) => requireAccount(g, 'grantee'))
    .sort((a, b) => (a.sub + '\n' + a.issuer).localeCompare(b.sub + '\n' + b.issuer));
  const rawPlaces = Array.isArray(input.placeIds) ? input.placeIds : [];
  if (!rawPlaces.length || rawPlaces.length > LOCATION_SHARE_PLACE_CAP || rawPlaces.some((id) => typeof id !== 'string' || !LOCATION_ID_SHAPE.test(id))) {
    throw new LocationRequestError('invalid_places', 400, `placeIds must be 1 to ${LOCATION_SHARE_PLACE_CAP} place ids.`);
  }
  const placeIds = [...new Set(rawPlaces.map((id) => String(id).toLowerCase()))].sort();
  if (placeIds.length !== rawPlaces.length) throw new LocationRequestError('invalid_places', 400, 'placeIds must not repeat.');
  return { tenantId, minorSub, grantees, placeIds };
}

/**
 * @description A group admin invites one account to join the group as a restricted member.
 * @param db - The pool.
 * @param principal - The admin.
 * @param body - { groupId, account: { sub, issuer }, expiresInDays? }.
 * @returns The invitation id and expiry.
 * @throws {LocationRequestError} 403 group_admin_required or invite_refused (the account holds admin there), 409 already_invited.
 */
export async function issueRestrictedInvite(db: LocationDb, principal: LocationPrincipal, body: unknown): Promise<{ inviteId: string; expiresAt: string }> {
  const input = (body && typeof body === 'object' ? body : {}) as Row;
  const tenantId = requireLocationId(input.groupId, 'invalid_group_id', 'groupId');
  const account = requireAccount(input.account, 'account');
  const days = input.expiresInDays === undefined ? LOCATION_INVITE_DEFAULT_DAYS : Number(input.expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > LOCATION_INVITE_MAX_DAYS) {
    throw new LocationRequestError('invalid_expiry', 400, `expiresInDays must be 1 to ${LOCATION_INVITE_MAX_DAYS}.`);
  }
  const invite = await withLocationOwnerSession(db, principal, async (client, who) => {
    await requireGroupAdmin(client, tenantId);
    const inserted = await client.query(`INSERT INTO location_restricted_invites (tenant_id, user_sub, principal_issuer, issued_by_sub, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $5::int)) RETURNING invite_id, expires_at`,
    [tenantId, account.sub, withIssuer(account, who).issuer, who.sub, days]).catch((error: { code?: string }) => {
      if (error?.code === '42501' || error?.code === '23514') throw new LocationRequestError('invite_refused', 403, 'That account cannot be invited as a restricted member of this group.');
      if (error?.code === '23505') throw new LocationRequestError('already_invited', 409, 'That account already has an open invitation to this group.');
      throw error;
    });
    return { inviteId: String(inserted.rows[0].invite_id), expiresAt: iso(inserted.rows[0].expires_at) ?? '' };
  });
  log.info({ op: 'invite-issue', outcome: 'ok', inviteId: invite.inviteId, tenantId }, 'location restricted invitation issued');
  return invite;
}

/** The acceptance function's refusals, as request refusals. */
const ACCEPT_REFUSALS: Readonly<Record<string, LocationRequestError>> = Object.freeze({
  'not-found': new LocationRequestError('invite_not_found', 404, 'No such open invitation for you.'),
  expired: new LocationRequestError('invite_expired', 410, 'That invitation has expired; ask the group admin for a new one.'),
  'issuer-not-admin': new LocationRequestError('invite_stale', 409, 'The admin who invited you is no longer an admin of that group.'),
  'is-admin': new LocationRequestError('invite_refused', 409, 'An admin of a group cannot become a restricted member of it.'),
});

/**
 * @description The invited account accepts a restricted invitation (migration 177's acceptance
 * function is the only writer of a restriction). Call only after the request's step-up proof was spent.
 * @param db - The pool.
 * @param principal - The invited account.
 * @param inviteIdValue - The invitation.
 * @returns The group joined as a restricted member.
 * @throws {LocationRequestError} 404, 410 or 409 as the function answers.
 */
export async function acceptRestrictedInvite(db: LocationDb, principal: LocationPrincipal, inviteIdValue: unknown): Promise<{ groupId: string; restricted: true }> {
  const inviteId = requireLocationId(inviteIdValue, 'invalid_invite_id', 'inviteId');
  const tenantId = await withLocationOwnerSession(db, principal, async (client) => {
    const invite = (await client.query('SELECT tenant_id FROM location_restricted_invites WHERE invite_id = $1', [inviteId])).rows[0];
    const status = String((await client.query('SELECT location_accept_restricted_invite($1) AS status', [inviteId])).rows[0]?.status);
    if (status !== 'accepted') throw ACCEPT_REFUSALS[status] ?? ACCEPT_REFUSALS['not-found'];
    return String(invite?.tenant_id ?? '');
  });
  log.info({ op: 'invite-accept', outcome: 'ok', inviteId, tenantId }, 'location restricted invitation accepted');
  return { groupId: tenantId, restricted: true };
}

/**
 * @description Decline an invitation (the invited account) or withdraw it (a group admin).
 * @param db - The pool.
 * @param principal - The person.
 * @param inviteIdValue - The invitation.
 * @returns The invitation id.
 * @throws {LocationRequestError} 404 invite_not_found.
 */
export async function removeRestrictedInvite(db: LocationDb, principal: LocationPrincipal, inviteIdValue: unknown): Promise<{ inviteId: string }> {
  const inviteId = requireLocationId(inviteIdValue, 'invalid_invite_id', 'inviteId');
  await withLocationOwnerSession(db, principal, async (client) => {
    const removed = await client.query('DELETE FROM location_restricted_invites WHERE invite_id = $1', [inviteId]);
    if (!removed.rowCount) throw new LocationRequestError('invite_not_found', 404, 'No such invitation you can decline or withdraw.');
  });
  log.info({ op: 'invite-remove', outcome: 'ok', inviteId }, 'location restricted invitation removed');
  return { inviteId };
}

/**
 * @description Create a guardian share (Q5). Call only after the request's step-up proof was spent.
 * The database admits it only for an admin of the minor's group, a restricted minor, distinct
 * grantees who are current members, and 1-20 of the group's places no finer than the minor's class.
 * @param db - The pool.
 * @param principal - The admin.
 * @param request - A parsed request.
 * @returns The share id.
 * @throws {LocationRequestError} 403 group_admin_required or guardian_share_refused, 400 places_not_in_group.
 */
export async function createGuardianShare(db: LocationDb, principal: LocationPrincipal, request: LocationGuardianShareRequest): Promise<{ shareId: string }> {
  const shareId = await withLocationOwnerSession(db, principal, async (client, who) => {
    await requireGroupAdmin(client, request.tenantId);
    const digest = (await client.query('SELECT location_places_digest($1::uuid, $2::uuid[]) AS d', [request.tenantId, request.placeIds])).rows[0]?.d;
    if (!digest) throw new LocationRequestError('places_not_in_group', 400, 'Every place must be a place of that group.');
    const inserted = await client.query(`INSERT INTO location_guardian_shares (tenant_id, user_sub, granted_by_sub, grantees, place_ids, geometry_digest)
      VALUES ($1, $2, $3, $4::jsonb, $5::uuid[], $6) RETURNING share_id`,
    [request.tenantId, request.minorSub, who.sub, JSON.stringify(request.grantees.map((g) => withIssuer(g, who))), request.placeIds, digest]).catch((error: { code?: string }) => {
      if (error?.code === '42501' || error?.code === '23503') {
        throw new LocationRequestError('guardian_share_refused', 403, 'That share is not allowed: the member must be restricted in this group, every grantee a current member, and each place coarse enough.');
      }
      throw error;
    });
    return String(inserted.rows[0].share_id);
  });
  log.info({ op: 'guardian-share-create', outcome: 'ok', shareId, tenantId: request.tenantId, placeCount: request.placeIds.length,
    count: request.grantees.length }, 'location guardian share created');
  return { shareId };
}

/**
 * @description Revoke a guardian share (a group admin only; the minor cannot).
 * @param db - The pool.
 * @param principal - The admin.
 * @param shareIdValue - The share.
 * @returns The share id.
 * @throws {LocationRequestError} 404 share_not_found.
 */
export async function revokeGuardianShare(db: LocationDb, principal: LocationPrincipal, shareIdValue: unknown): Promise<{ shareId: string }> {
  const shareId = requireLocationId(shareIdValue, 'invalid_share', 'shareId');
  await withLocationOwnerSession(db, principal, async (client) => {
    const updated = await client.query(`UPDATE location_guardian_shares SET revoked_at = NOW(), updated_at = NOW()
      WHERE share_id = $1 AND revoked_at IS NULL AND oshal_is_tenant_admin(tenant_id::text)`, [shareId]);
    if (!updated.rowCount) throw new LocationRequestError('share_not_found', 404, 'No such active guardian share in a group you administer.');
  });
  log.info({ op: 'guardian-share-revoke', outcome: 'ok', shareId }, 'location guardian share revoked');
  return { shareId };
}

/**
 * @description Lift a member's restriction in a group (an admin only). Its guardian shares go with it.
 * @param db - The pool.
 * @param principal - The admin.
 * @param groupIdValue - The group.
 * @param memberSub - The restricted member.
 * @returns Whether a restriction was removed.
 * @throws {LocationRequestError} 403 group_admin_required.
 */
export async function liftRestriction(db: LocationDb, principal: LocationPrincipal, groupIdValue: unknown, memberSub: unknown): Promise<{ lifted: boolean }> {
  const tenantId = requireLocationId(groupIdValue, 'invalid_group_id', 'groupId');
  const sub = typeof memberSub === 'string' ? memberSub.trim() : '';
  if (!sub) throw new LocationRequestError('invalid_member', 400, 'Name the restricted member.');
  const lifted = await withLocationOwnerSession(db, principal, async (client) => {
    await requireGroupAdmin(client, tenantId);
    return ((await client.query('DELETE FROM location_member_restrictions WHERE tenant_id = $1 AND user_sub = $2', [tenantId, sub])).rowCount ?? 0) > 0;
  });
  log.info({ op: 'restriction-lift', outcome: lifted ? 'lifted' : 'none', tenantId }, 'location restriction lifted');
  return { lifted };
}

/**
 * @description What the person's groups share with them: the grantee projection (places by
 * reference, enter or exit, since), re-checked by the database on every read.
 * @param db - The pool.
 * @param principal - The reader.
 * @returns The rows.
 */
export async function readSharedPresence(db: LocationDb, principal: LocationPrincipal): Promise<LocationSharedPresenceView[]> {
  return withLocationOwnerSession(db, principal, async (client) => (await client.query(`SELECT * FROM location_shared_presence()
    ORDER BY tenant_id, subject_sub, place_name`)).rows.map((r: Row) => ({
    shareKind: r.share_kind === 'guardian' ? 'guardian' : 'member', shareId: String(r.share_id), groupId: String(r.tenant_id),
    subjectSub: String(r.subject_sub), place: { placeId: String(r.place_id), name: String(r.place_name), label: String(r.place_label) },
    transition: r.transition === 'enter' ? 'enter' : 'exit', since: iso(r.since),
  })));
}

/**
 * @description Invitations addressed to the person, and, for groups they administer, the open
 * invitations, restrictions and guardian shares there.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @returns The lists.
 */
async function readSharingRows(client: PoolClient, who: LocationPrincipal): Promise<Record<string, Row[]>> {
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await client.query(sql, params)).rows as Row[];
  return {
    received: await q(`SELECT i.invite_id, i.tenant_id, t.name AS group_name, i.expires_at FROM location_restricted_invites i
      LEFT JOIN oshal_tenants t ON t.tenant_id = i.tenant_id WHERE i.user_sub = $1 AND i.principal_issuer = $2 ORDER BY i.created_at`, [who.sub, who.principalIssuer]),
    issued: await q(`SELECT invite_id, tenant_id, user_sub, principal_issuer, expires_at FROM location_restricted_invites
      WHERE oshal_is_tenant_admin(tenant_id::text) ORDER BY created_at`),
    restrictions: await q(`SELECT tenant_id, user_sub, created_at FROM location_member_restrictions
      WHERE oshal_is_tenant_admin(tenant_id::text) ORDER BY tenant_id, user_sub`),
    guardian: await q(`SELECT share_id, tenant_id, user_sub, grantees, place_ids, revoked_at, created_at FROM location_guardian_shares
      WHERE oshal_is_tenant_admin(tenant_id::text) ORDER BY created_at`),
  };
}

/**
 * @description The group-sharing panel of the Settings tab: invitations the person received and,
 * for the groups they administer, invitations issued, restricted members and guardian shares.
 * @param db - The pool.
 * @param principal - The person.
 * @returns The lists.
 */
export async function readGroupSharing(db: LocationDb, principal: LocationPrincipal): Promise<Record<string, unknown[]>> {
  const rows = await withLocationOwnerSession(db, principal, readSharingRows);
  return {
    received: rows.received.map((r) => ({ inviteId: String(r.invite_id), groupId: String(r.tenant_id),
      groupName: r.group_name === null ? null : String(r.group_name), expiresAt: iso(r.expires_at) })),
    issued: rows.issued.map((r) => ({ inviteId: String(r.invite_id), groupId: String(r.tenant_id),
      account: { sub: String(r.user_sub), issuer: String(r.principal_issuer) }, expiresAt: iso(r.expires_at) })),
    restrictions: rows.restrictions.map((r) => ({ groupId: String(r.tenant_id), memberSub: String(r.user_sub), since: iso(r.created_at) })),
    guardianShares: rows.guardian.map((r) => ({ shareId: String(r.share_id), groupId: String(r.tenant_id), minorSub: String(r.user_sub),
      grantees: Array.isArray(r.grantees) ? r.grantees : [], placeIds: Array.isArray(r.place_ids) ? r.place_ids.map(String) : [],
      revokedAt: iso(r.revoked_at), createdAt: iso(r.created_at) })),
  };
}
