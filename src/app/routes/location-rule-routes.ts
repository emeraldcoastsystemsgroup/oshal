/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5: the reminder and group-sharing routes of the one /api/location router (mounted by createLocationRoutes behind its service-rail refusal and browser-session principal, declared in LOCATION_ROUTE_POLICY). Rules: list (own, group, and the group rules watching the person), create, delete; recent fires with their text, which is where the Jarvis shelf row points. Sharing: what the person's groups share with them (the projection), their invitations and, for groups they administer, invitations, restricted members and guardian shares. Two routes raise exposure and spend a step-up proof for exactly their parameters: accepting a restricted invitation (it lets the group admin share the account's place transitions) and creating a guardian share. Issuing an invitation exposes nothing until it is accepted; revoking, declining, withdrawing and lifting a restriction only reduce exposure. A reminder or notice rule tells only its own actor and needs no proof; arming a device action will (L8).
 *
 * @module app/routes/location-rule-routes
 */

import type { Request, Response, Router } from 'express';
import type { Pool } from 'pg';
import {
  acceptRestrictedInvite, createGuardianShare, issueRestrictedInvite, liftRestriction, parseGuardianShareRequest,
  readGroupSharing, readSharedPresence, removeRestrictedInvite, revokeGuardianShare,
} from '../location-group-shares';
import { requireLocationId } from '../location-request';
import { createLocationRule, deleteLocationRule, listLocationFires, listLocationRules, parseRuleInput } from '../location-rules';
import type { LocationStepUpOperation } from '../location-step-up';
import type { GuardedLocationHandler } from './location-place-routes';
import { locationContext } from './location-session';

/** @description Spend the request's step-up proof for one operation's canonical parameters, or throw the refusal. */
export type LocationStepUpSpender = (req: Request, res: Response, operation: LocationStepUpOperation, params: unknown) => true;

/** @description The route policy rows for this file, merged into LOCATION_ROUTE_POLICY. */
export const LOCATION_RULE_ROUTE_POLICY = Object.freeze({
  'GET /rules': { stepUp: null, why: 'Lists the person\'s rules, their groups\' rules and the group rules watching them now.' },
  'POST /rules': { stepUp: null, why: 'A reminder or notice tells only its own actor; it starts no reporting and shares nothing. Device actions (L8) will spend arm-rule.' },
  'DELETE /rules/:ruleId': { stepUp: null, why: 'Deleting a rule only reduces what is evaluated; its subjects keep their history.' },
  'GET /fires': { stepUp: null, why: 'Fires the person is the subject or the actor of, with the text their shelf row points to.' },
  'GET /shared': { stepUp: null, why: 'The grantee projection: place transitions shared with the person, places by reference, never coordinates.' },
  'GET /group-sharing': { stepUp: null, why: 'Invitations addressed to the person and, for groups they administer, invitations, restrictions and guardian shares.' },
  'POST /invites': { stepUp: null, why: 'An invitation exposes nothing until the invited account accepts it with its own proof.' },
  'POST /invites/:inviteId/accept': { stepUp: 'accept-restricted-invite', when: 'always', why: 'Accepting makes the account restricted, which lets its group admin share its place transitions.' },
  'DELETE /invites/:inviteId': { stepUp: null, why: 'Declining or withdrawing an invitation only reduces exposure.' },
  'POST /guardian-shares': { stepUp: 'create-guardian-share', when: 'always', why: 'A guardian share lets named members see a restricted member\'s place transitions.' },
  'POST /guardian-shares/:shareId/revoke': { stepUp: null, why: 'Revoking only reduces exposure.' },
  'POST /restrictions/lift': { stepUp: null, why: 'Lifting a restriction ends its guardian shares; it exposes nothing. The member is named in the body, not the path.' },
} as const);

/**
 * @description Canonical parameters of accepting one invitation (the challenge and the route digest the same form).
 * @param raw - { inviteId }.
 * @returns The canonical parameters.
 */
export function normalizeInviteAcceptance(raw: unknown): { inviteId: string } {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { inviteId: requireLocationId(input.inviteId, 'invalid_invite_id', 'inviteId') };
}

/**
 * @description Mount the rule and fire routes.
 * @param router - The /api/location router.
 * @param pool - The pool.
 * @param guarded - The router's error-mapping wrapper.
 * @returns Nothing.
 */
function mountRuleRoutes(router: Router, pool: Pool, guarded: GuardedLocationHandler): void {
  router.get('/rules', guarded(async (_req, res) => {
    res.json(await listLocationRules(pool, locationContext(res).principal));
  }));
  router.post('/rules', guarded(async (req, res) => {
    res.status(201).json({ rule: await createLocationRule(pool, locationContext(res).principal, parseRuleInput(req.body)) });
  }));
  router.delete('/rules/:ruleId', guarded(async (req, res) => {
    res.json(await deleteLocationRule(pool, locationContext(res).principal, req.params.ruleId));
  }));
  router.get('/fires', guarded(async (_req, res) => {
    res.json({ fires: await listLocationFires(pool, locationContext(res).principal) });
  }));
}

/**
 * @description Mount the group-sharing routes.
 * @param router - The /api/location router.
 * @param pool - The pool.
 * @param guarded - The router's error-mapping wrapper.
 * @param spend - Spends a step-up proof.
 * @returns Nothing.
 */
function mountSharingRoutes(router: Router, pool: Pool, guarded: GuardedLocationHandler, spend: LocationStepUpSpender): void {
  router.get('/shared', guarded(async (_req, res) => {
    res.json({ shared: await readSharedPresence(pool, locationContext(res).principal) });
  }));
  router.get('/group-sharing', guarded(async (_req, res) => {
    res.json(await readGroupSharing(pool, locationContext(res).principal));
  }));
  router.post('/invites', guarded(async (req, res) => {
    res.status(201).json(await issueRestrictedInvite(pool, locationContext(res).principal, req.body));
  }));
  router.post('/invites/:inviteId/accept', guarded(async (req, res) => {
    const params = normalizeInviteAcceptance({ inviteId: req.params.inviteId });
    spend(req, res, 'accept-restricted-invite', params);
    res.json(await acceptRestrictedInvite(pool, locationContext(res).principal, params.inviteId));
  }));
  router.delete('/invites/:inviteId', guarded(async (req, res) => {
    res.json(await removeRestrictedInvite(pool, locationContext(res).principal, req.params.inviteId));
  }));
  router.post('/guardian-shares', guarded(async (req, res) => {
    const request = parseGuardianShareRequest(req.body);
    spend(req, res, 'create-guardian-share', request);
    res.status(201).json(await createGuardianShare(pool, locationContext(res).principal, request));
  }));
  router.post('/guardian-shares/:shareId/revoke', guarded(async (req, res) => {
    res.json(await revokeGuardianShare(pool, locationContext(res).principal, req.params.shareId));
  }));
  router.post('/restrictions/lift', guarded(async (req, res) => {
    res.json(await liftRestriction(pool, locationContext(res).principal, req.body?.groupId, req.body?.memberSub));
  }));
}

/**
 * @description Mount the reminder and group-sharing routes on the location router (ADR-169 L5).
 * @param router - The /api/location router (after its session gate).
 * @param pool - The pool.
 * @param guarded - The router's error-mapping wrapper.
 * @param spend - Spends a step-up proof for the two routes that raise exposure.
 * @returns Nothing.
 */
export function mountLocationRuleRoutes(router: Router, pool: Pool, guarded: GuardedLocationHandler, spend: LocationStepUpSpender): void {
  mountRuleRoutes(router, pool, guarded);
  mountSharingRoutes(router, pool, guarded, spend);
}
