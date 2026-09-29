/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 (D4): a person's proximity reminders and a group's arrival notices, as the Settings, Location tab and the Jarvis "next time I'm at X" intent manage them. A person arms a rule about themself at one of their own places or a place of a group they belong to; a group admin arms a group rule at one of the group's places about any sharing member or about themself, and the rule carries an arm digest computed in the database over every field that decides when it fires (so any later edit disarms it). A rule reminds (text required) or notifies (text optional), on enter or exit, once or on every visit, with a cooldown and an accuracy floor inside the D4 bounds. Device subjects are refused here until the device ingest exists (L6); the database refuses a foreign device outright. The list says which group rules are watching the person now (they hold an active member share covering the rule's place) and, for the person's own rules, which have finished. Recent fires are read under the person's identity, as the subject or as the actor, and resolved to their full text here, which is where the Jarvis shelf row sends them. Every statement runs in the person's own owner session (is_operator off); row-level security and migration 177's predicates decide.
 *
 * @module app/location-rules
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { LOCATION_EVALUATION } from './location-evaluator';
import { locationFireMessage } from './location-fire-dispatch';
import type { LocationPlaceRef } from './location-overview';
import { requireGroupAdmin, rethrowLocationWriteError } from './location-places';
import { LOCATION_ID_SHAPE, LocationRequestError, requireLocationId } from './location-request';

const log = createChildLogger({ module: 'location-rules' });

/** @description Cooldown bounds, seconds (the migration 177 CHECK). */
export const LOCATION_RULE_COOLDOWN_SEC = Object.freeze({ min: 0, max: 604_800 });

/** @description Accuracy floor bounds, metres (the migration 177 CHECK). */
export const LOCATION_RULE_ACCURACY_M = Object.freeze({ min: 5, max: 500 });

/** @description The most characters a reminder text may carry. */
export const LOCATION_RULE_TEXT_MAX = 500;

/** @description A validated rule request. */
export interface LocationRuleInput {
  placeId: string;
  groupId: string | null;
  subject: 'self' | 'any-member' | { deviceId: string };
  on: 'enter' | 'exit';
  repeat: 'once' | 'every-visit';
  cooldownSec: number;
  accuracyFloorM: number;
  action: { kind: 'remind' | 'notify'; text: string | null };
}

/** @description A rule as the Settings tab and Jarvis show it. */
export interface LocationRuleView {
  ruleId: string;
  place: LocationPlaceRef;
  group: { groupId: string; name: string | null } | null;
  subject: 'self' | 'any-member' | 'device';
  on: 'enter' | 'exit';
  repeat: 'once' | 'every-visit';
  cooldownSec: number;
  action: { kind: string; text: string | null };
  /** Whether the caller may delete it (their own, or a group they administer). */
  editable: boolean;
  /** Whether it evaluates the caller now (a group rule whose place they share). */
  watchingMe: boolean;
  completedAt: string | null;
  createdAt: string;
}

/** @description A fire, resolved to its text under the reader's own identity. */
export interface LocationFireView {
  fireId: string;
  ruleId: string;
  transition: 'enter' | 'exit';
  aboutMe: boolean;
  place: string;
  subject: string;
  body: string;
  firedAt: string;
  outcome: string | null;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

/**
 * @description Read a whole number within bounds, or its default when absent.
 * @param value - The request value.
 * @param bounds - min and max.
 * @param fallback - The default.
 * @param code - The refusal code.
 * @returns The number.
 * @throws {LocationRequestError} 400 with `code`.
 */
function boundedNumber(value: unknown, bounds: { min: number; max: number }, fallback: number, code: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new LocationRequestError(code, 400, `Must be a number from ${bounds.min} to ${bounds.max}.`);
  }
  return Math.round(value);
}

/**
 * @description Read the rule's action: remind needs text; notify may carry a note.
 * @param raw - The request's action.
 * @returns The action.
 * @throws {LocationRequestError} 400 invalid_action or invalid_text.
 */
function parseAction(raw: unknown): LocationRuleInput['action'] {
  const action = (raw && typeof raw === 'object' ? raw : {}) as Row;
  if (action.kind !== 'remind' && action.kind !== 'notify') {
    throw new LocationRequestError('invalid_action', 400, 'action.kind must be remind or notify; other actions arrive with their own slices.');
  }
  const text = typeof action.text === 'string' ? action.text.trim() : '';
  if (text.length > LOCATION_RULE_TEXT_MAX || (action.kind === 'remind' && !text)) {
    throw new LocationRequestError('invalid_text', 400, `A reminder needs text of 1 to ${LOCATION_RULE_TEXT_MAX} characters.`);
  }
  return { kind: action.kind, text: text || null };
}

/**
 * @description Read the rule's subject.
 * @param raw - 'self', 'any-member' or { deviceId }.
 * @param groupId - The group, for a group rule.
 * @returns The subject.
 * @throws {LocationRequestError} 400 invalid_subject.
 */
function parseSubject(raw: unknown, groupId: string | null): LocationRuleInput['subject'] {
  if (raw === undefined || raw === null || raw === 'self') return 'self';
  if (raw === 'any-member') {
    if (!groupId) throw new LocationRequestError('invalid_subject', 400, 'Only a group rule can watch any sharing member.');
    return 'any-member';
  }
  const deviceId = (raw && typeof raw === 'object' ? (raw as Row).deviceId : undefined);
  if (typeof deviceId === 'string' && LOCATION_ID_SHAPE.test(deviceId)) return { deviceId: deviceId.toLowerCase() };
  throw new LocationRequestError('invalid_subject', 400, 'subject must be "self", "any-member" or { deviceId }.');
}

/**
 * @description Validate a rule request.
 * @param body - The parsed JSON body.
 * @returns The rule input.
 * @throws {LocationRequestError} 400 for anything malformed; messages never echo a value.
 */
export function parseRuleInput(body: unknown): LocationRuleInput {
  const input = (body && typeof body === 'object' ? body : {}) as Row;
  const groupId = input.groupId === undefined || input.groupId === null ? null : requireLocationId(input.groupId, 'invalid_group_id', 'groupId');
  const on = input.on === undefined ? 'enter' : input.on;
  const repeat = input.repeat === undefined ? 'once' : input.repeat;
  if (on !== 'enter' && on !== 'exit') throw new LocationRequestError('invalid_on', 400, 'on must be enter or exit.');
  if (repeat !== 'once' && repeat !== 'every-visit') throw new LocationRequestError('invalid_repeat', 400, 'repeat must be once or every-visit.');
  return {
    placeId: requireLocationId(input.placeId, 'invalid_place_id', 'placeId'),
    groupId,
    subject: parseSubject(input.subject, groupId),
    on, repeat,
    cooldownSec: boundedNumber(input.cooldownSec, LOCATION_RULE_COOLDOWN_SEC, LOCATION_EVALUATION.defaultCooldownSec, 'invalid_cooldown'),
    accuracyFloorM: boundedNumber(input.accuracyFloorM, LOCATION_RULE_ACCURACY_M, LOCATION_EVALUATION.defaultAccuracyFloorM, 'invalid_accuracy_floor'),
    action: parseAction(input.action),
  };
}

const VIEW_SQL = `SELECT r.rule_id, r.tenant_id, r.subject_kind, r.on_transition, r.repeat_mode, r.cooldown_sec, r.action_kind,
    r.action_text, r.completed_at, r.created_at, p.place_id, p.name AS place_name, p.label AS place_label, t.name AS group_name,
    (r.tenant_id IS NULL OR oshal_is_tenant_admin(r.tenant_id::text)) AS editable,
    (r.tenant_id IS NOT NULL AND location_rule_evaluable(r.rule_id, $1)) AS watching_me
  FROM location_rules r JOIN location_places p ON p.place_id = r.place_id LEFT JOIN oshal_tenants t ON t.tenant_id = r.tenant_id`;

/**
 * @description Shape a rule row.
 * @param r - A row from {@link VIEW_SQL}.
 * @returns The view.
 */
function toRuleView(r: Row): LocationRuleView {
  return {
    ruleId: String(r.rule_id),
    place: { placeId: String(r.place_id), name: String(r.place_name), label: String(r.place_label) },
    group: r.tenant_id ? { groupId: String(r.tenant_id), name: r.group_name === null ? null : String(r.group_name) } : null,
    subject: r.subject_kind === 'any-member' ? 'any-member' : r.subject_kind === 'device' ? 'device' : 'self',
    on: r.on_transition === 'exit' ? 'exit' : 'enter',
    repeat: r.repeat_mode === 'every-visit' ? 'every-visit' : 'once',
    cooldownSec: Number(r.cooldown_sec),
    action: { kind: String(r.action_kind), text: r.action_text === null ? null : String(r.action_text) },
    editable: r.editable === true, watchingMe: r.watching_me === true,
    completedAt: iso(r.completed_at), createdAt: iso(r.created_at) ?? '',
  };
}

/**
 * @description Refuse a device subject: a device the caller cannot see is not found; their own is
 * refused until the device ingest (L6) exists, so no rule is armed that could never fire.
 * @param client - A client stamped as the person.
 * @param deviceId - The device.
 * @returns Never.
 * @throws {LocationRequestError} 404 device_not_found or 400 device_subject_not_available.
 */
async function refuseDeviceSubject(client: PoolClient, deviceId: string): Promise<never> {
  const seen = (await client.query('SELECT 1 FROM location_devices WHERE device_id = $1', [deviceId])).rows.length;
  if (!seen) throw new LocationRequestError('device_not_found', 404, 'No such device of yours or your groups.');
  throw new LocationRequestError('device_subject_not_available', 400, 'Rules about a device arrive with device reporting; watch yourself or your group for now.');
}

/**
 * @description Check the place and group before the insert, turning a refusal into a clear answer.
 * @param client - A client stamped as the person.
 * @param input - The rule input.
 * @returns Nothing.
 * @throws {LocationRequestError} 403, 404 or 400.
 */
async function checkRuleTarget(client: PoolClient, input: LocationRuleInput): Promise<void> {
  if (input.groupId) await requireGroupAdmin(client, input.groupId);
  const place = (await client.query('SELECT tenant_id FROM location_places WHERE place_id = $1', [input.placeId])).rows[0];
  if (!place) throw new LocationRequestError('place_not_found', 404, 'No such place of yours or your groups.');
  if (input.groupId && String(place.tenant_id ?? '') !== input.groupId) {
    throw new LocationRequestError('place_not_in_group', 400, 'A group rule must use one of that group\'s places.');
  }
  if (typeof input.subject === 'object') await refuseDeviceSubject(client, input.subject.deviceId);
}

/**
 * @description Insert the rule row; a group rule's arm digest is computed by the database.
 * @param client - A client stamped as the person.
 * @param who - The person arming it.
 * @param input - The rule input.
 * @returns The new rule id.
 */
async function insertRule(client: PoolClient, who: LocationPrincipal, input: LocationRuleInput): Promise<string> {
  const group = input.groupId;
  const kind = input.subject === 'any-member' ? 'any-member' : 'person';
  const ref = kind === 'any-member' ? `tenant:${group}` : who.sub;
  const inserted = await client.query(`INSERT INTO location_rules (owner_sub, principal_issuer, tenant_id, armed_by_sub, armed_by_issuer,
      subject_kind, subject_ref, place_id, on_transition, repeat_mode, cooldown_sec, accuracy_floor_m, action_kind, action_text, arm_digest)
    VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8::uuid, $9, $10, $11::int, $12::double precision, $13, $14,
      CASE WHEN $3::uuid IS NULL THEN NULL ELSE location_rule_arm_digest($3::uuid, $6, $7, $8::uuid, $9, $10, $11::int, $12::double precision, $13) END)
    RETURNING rule_id`,
  [group ? null : who.sub, group ? null : who.principalIssuer, group, who.sub, who.principalIssuer, kind, ref, input.placeId,
    input.on, input.repeat, input.cooldownSec, input.accuracyFloorM, input.action.kind, input.action.text]).catch(rethrowLocationWriteError);
  return String(inserted.rows[0].rule_id);
}

/**
 * @description Create a rule. With `seedInside`, a person's own rule starts with them inside its
 * place (the Jarvis "here" flow: they are standing in the place just saved), so it waits for the
 * next visit rather than for a first determination.
 * @param db - The pool.
 * @param principal - The person arming it.
 * @param input - A validated input.
 * @param options - `seedInside` and the clock.
 * @returns The rule.
 * @throws {LocationRequestError} 403 group_admin_required, 404 place_not_found, 400 place_not_in_group, or a mapped write refusal.
 */
export async function createLocationRule(
  db: LocationDb, principal: LocationPrincipal, input: LocationRuleInput, options: { seedInside?: boolean; nowMs?: number } = {},
): Promise<LocationRuleView> {
  const rule = await withLocationOwnerSession(db, principal, async (client, who) => {
    await checkRuleTarget(client, input);
    const ruleId = await insertRule(client, who, input);
    if (options.seedInside && !input.groupId && input.subject === 'self') {
      const since = new Date(options.nowMs ?? Date.now());
      await client.query(`INSERT INTO location_rule_state (rule_id, subject_ref, owner_sub, principal_issuer, presence, presence_since, last_fix_at)
        VALUES ($1, $2, $2, $3, 'inside', $4, $4)`, [ruleId, who.sub, who.principalIssuer, since]);
    }
    return toRuleView((await client.query(`${VIEW_SQL} WHERE r.rule_id = $2`, [who.sub, ruleId])).rows[0]);
  });
  log.info({ op: 'rule-create', outcome: rule.group ? 'group' : 'person', ruleId: rule.ruleId, placeId: rule.place.placeId }, 'location rule created');
  return rule;
}

/**
 * @description The rules the person can see: their own, their groups', and any naming them.
 * @param db - The pool.
 * @param principal - The person.
 * @returns Their own rules, group rules, and the group rules watching them now.
 */
export async function listLocationRules(db: LocationDb, principal: LocationPrincipal): Promise<{ mine: LocationRuleView[]; group: LocationRuleView[]; watchingMe: LocationRuleView[] }> {
  const rules = await withLocationOwnerSession(db, principal, async (client, who) =>
    (await client.query(`${VIEW_SQL} ORDER BY r.created_at, r.rule_id`, [who.sub])).rows.map(toRuleView));
  return {
    mine: rules.filter((r) => !r.group),
    group: rules.filter((r) => r.group),
    watchingMe: rules.filter((r) => r.watchingMe),
  };
}

/**
 * @description Delete a rule the person may change. Its subjects' state and fire rows are their
 * history and stay until they purge them (Q4).
 * @param db - The pool.
 * @param principal - The person.
 * @param ruleIdValue - The rule.
 * @returns What was deleted.
 * @throws {LocationRequestError} 404 rule_not_found, 403 group_admin_required.
 */
export async function deleteLocationRule(db: LocationDb, principal: LocationPrincipal, ruleIdValue: unknown): Promise<{ ruleId: string; deleted: boolean }> {
  const ruleId = requireLocationId(ruleIdValue, 'invalid_rule_id', 'ruleId');
  const result = await withLocationOwnerSession(db, principal, async (client, who) => {
    const row = (await client.query(`${VIEW_SQL} WHERE r.rule_id = $2`, [who.sub, ruleId])).rows[0];
    if (!row) throw new LocationRequestError('rule_not_found', 404, 'No such rule of yours or your groups.');
    if (row.editable !== true) throw new LocationRequestError('group_admin_required', 403, 'Only an admin of that group may do that.');
    const removed = await client.query('DELETE FROM location_rules WHERE rule_id = $1', [ruleId]).catch(rethrowLocationWriteError);
    return { ruleId, deleted: (removed.rowCount ?? 0) === 1 };
  });
  log.info({ op: 'rule-delete', outcome: result.deleted ? 'deleted' : 'none', ruleId }, 'location rule deleted');
  return result;
}

/**
 * @description Recent fires the person may read, as the subject or as the rule's actor, with their
 * full text resolved here under the person's identity (the only place that text is shown in-app).
 * @param db - The pool.
 * @param principal - The person.
 * @param limit - How many, newest first (1-100).
 * @returns The fires.
 */
export async function listLocationFires(db: LocationDb, principal: LocationPrincipal, limit = 50): Promise<LocationFireView[]> {
  const take = Math.max(1, Math.min(100, Math.round(limit)));
  return withLocationOwnerSession(db, principal, async (client, who) => (await client.query(`SELECT fire_id, rule_id, subject_ref,
      transition, action_kind, place_name, reminder_text, fired_at, outcome FROM location_rule_fires
    ORDER BY fired_at DESC, fire_id LIMIT $1`, [take])).rows.map((r: Row) => {
    const aboutMe = String(r.subject_ref) === who.sub;
    const message = locationFireMessage({ aboutSelf: aboutMe, transition: r.transition === 'exit' ? 'exit' : 'enter',
      actionKind: String(r.action_kind), placeName: String(r.place_name ?? 'a saved place'),
      reminderText: r.reminder_text === null ? null : String(r.reminder_text) });
    return {
      fireId: String(r.fire_id), ruleId: String(r.rule_id), transition: r.transition === 'exit' ? 'exit' : 'enter', aboutMe,
      place: String(r.place_name ?? ''), subject: message.subject, body: message.body, firedAt: iso(r.fired_at) ?? '',
      outcome: r.outcome === null ? null : String(r.outcome),
    };
  }));
}
