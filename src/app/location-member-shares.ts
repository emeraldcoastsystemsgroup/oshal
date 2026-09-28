/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: accepting and revoking a member share (Q1: in a group each member chooses whether to share). Accepting records the person's own grant of their place transitions to one group over an explicit set of that group's places, with the digest of those places' current geometry; the router admits it only with a spent step-up proof for exactly that group and place set. Row-level security decides admissibility through migration 175's predicate (a member of the group, not restricted there, 1-20 of the group's own places, each no finer than the member's precision class), so a refusal from the database is reported as share_refused without saying which rule failed. Revoking reduces exposure and needs no proof. What a group then sees of a share is L5's projection; nothing here reads another person's rows.
 *
 * @module app/location-member-shares
 */

import { createChildLogger } from '@/shared/logger';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { LOCATION_ID_SHAPE, LocationRequestError, requireLocationId } from './location-request';

const log = createChildLogger({ module: 'location-member-shares' });

/** @description The most places one share may approve (ADR-169 D3/D6). */
export const LOCATION_SHARE_PLACE_CAP = 20;

/** @description A share request after validation: the group and a sorted, distinct place set. */
export interface LocationShareRequest {
  tenantId: string;
  placeIds: string[];
}

/**
 * @description Validate a share request. The place ids come back lower-cased, distinct and sorted,
 * which is also the canonical form the step-up digest is taken over.
 * @param body - The parsed JSON body.
 * @returns The request.
 * @throws {LocationRequestError} 400 for a malformed group id or place set.
 */
export function parseShareRequest(body: unknown): LocationShareRequest {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof input.tenantId !== 'string' || !LOCATION_ID_SHAPE.test(input.tenantId)) {
    throw new LocationRequestError('invalid_group', 400, 'tenantId must be a group id.');
  }
  const raw = Array.isArray(input.placeIds) ? input.placeIds : [];
  if (!raw.length || raw.length > LOCATION_SHARE_PLACE_CAP || raw.some((id) => typeof id !== 'string' || !LOCATION_ID_SHAPE.test(id))) {
    throw new LocationRequestError('invalid_places', 400, `placeIds must be 1 to ${LOCATION_SHARE_PLACE_CAP} place ids.`);
  }
  const placeIds = [...new Set(raw.map((id) => String(id).toLowerCase()))].sort();
  if (placeIds.length !== raw.length) throw new LocationRequestError('invalid_places', 400, 'placeIds must not repeat.');
  return { tenantId: input.tenantId.toLowerCase(), placeIds };
}

/**
 * @description Accept a member share: grant one group the person's place transitions at the
 * approved places. Call only after the request's step-up proof was spent for this exact request.
 * @param db - The pool.
 * @param principal - The person granting.
 * @param request - A parsed request ({@link parseShareRequest}).
 * @returns The new share's id.
 * @throws {LocationRequestError} 400 places_not_in_group, 403 share_refused.
 */
export async function acceptMemberShare(db: LocationDb, principal: LocationPrincipal, request: LocationShareRequest): Promise<{ shareId: string }> {
  const shareId = await withLocationOwnerSession(db, principal, async (client, who) => {
    const digest = (await client.query('SELECT location_places_digest($1::uuid, $2::uuid[]) AS d',
      [request.tenantId, request.placeIds])).rows[0]?.d;
    if (!digest) throw new LocationRequestError('places_not_in_group', 400, 'Every place must be a place of that group that you can see.');
    try {
      const inserted = await client.query(`INSERT INTO location_shares (owner_sub, principal_issuer, tenant_id, place_ids, geometry_digest)
        VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING share_id`, [who.sub, who.principalIssuer, request.tenantId, request.placeIds, digest]);
      return String(inserted.rows[0].share_id);
    } catch (error) {
      if ((error as { code?: string }).code === '42501') {
        throw new LocationRequestError('share_refused', 403, 'That share is not allowed: you must be an unrestricted member and each place must be at least as coarse as your precision.');
      }
      throw error;
    }
  });
  log.info({ op: 'accept-share', outcome: 'ok', shareId, tenantId: request.tenantId, placeCount: request.placeIds.length }, 'location member share accepted');
  return { shareId };
}

/**
 * @description Revoke one of the person's own member shares. It stays as a revoked record (their
 * own history) until they purge or erase it.
 * @param db - The pool.
 * @param principal - The person.
 * @param shareIdValue - The share.
 * @returns The share id.
 * @throws {LocationRequestError} 400 malformed, 404 not theirs or already revoked.
 */
export async function revokeMemberShare(db: LocationDb, principal: LocationPrincipal, shareIdValue: unknown): Promise<{ shareId: string }> {
  const shareId = requireLocationId(shareIdValue, 'invalid_share', 'shareId');
  await withLocationOwnerSession(db, principal, async (client, who) => {
    const updated = await client.query(`UPDATE location_shares SET revoked_at = NOW(), updated_at = NOW()
       WHERE share_id = $1 AND owner_sub = $2 AND principal_issuer = $3 AND revoked_at IS NULL`, [shareId, who.sub, who.principalIssuer]);
    if (!updated.rowCount) throw new LocationRequestError('share_not_found', 404, 'No such active share of yours.');
  });
  log.info({ op: 'revoke-share', outcome: 'ok', shareId }, 'location member share revoked');
  return { shareId };
}
