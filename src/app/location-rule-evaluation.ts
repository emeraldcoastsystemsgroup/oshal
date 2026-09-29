/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 (D4 "Evaluation is event-driven, on the controller, as the subject"): evaluate one full-precision fix, in memory, inside the ingest transaction that wrote it and under the subject's own identity. The rules read are exactly those migration 177's location_rule_evaluable() admits for the subject (their own unfinished rules about themself, and group rules whose arm digest is current and whose place is in an active member share of theirs), so a member who has not shared, or has not approved that place, is never evaluated by a group rule. Each (rule, subject) state is locked, stepped with the pure hysteresis of location-evaluator.ts and written back; a fire is claimed in the idempotent ledger (UNIQUE rule, subject, transition) with its evidence provenance and no coordinate, and a `once` rule of the person's own is marked finished. The subject's share presence (each active member share place, and each place of a guardian share naming them) is kept with the same hysteresis and fires nothing. The claimed fire ids are returned so the caller dispatches them after commit (ADR-125 durable-before-ack). Log lines carry ids and counts only.
 *
 * @module app/location-rule-evaluation
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { LocationPrincipal } from '@/features/location';
import {
  EMPTY_TRACK_STATE, LOCATION_EVALUATION, fireDecision, stepPresence,
  type LocationFixSample, type LocationStepResult, type LocationTrackState,
} from './location-evaluator';

const log = createChildLogger({ module: 'location-rule-evaluation' });

/** @description A fix as the evaluator receives it from an ingest path, with its provenance. */
export interface LocationEvaluationFix extends LocationFixSample {
  /** The reporting device, if any. */
  deviceId: string | null;
  /** Where the fix came from (the observation source). */
  source: 'browser' | 'android' | 'mavlink' | 'manual' | 'hub';
  /** How the reporter authenticated: a person's browser session, or a device-bound credential. */
  authMode: 'browser-session' | 'device-credential';
  /** Whether the reporter flagged the fix as a mock location. */
  mock: boolean;
}

/** @description What one evaluation did. */
export interface LocationEvaluationResult {
  /** Fire rows this fix claimed, to dispatch after commit. */
  firedIds: string[];
  /** Rules evaluated. */
  ruleCount: number;
  /** Share places tracked. */
  shareCount: number;
}

type Row = Record<string, unknown>;

/** A rule as the evaluator reads it, with its place's geometry. */
interface EvaluatedRule {
  ruleId: string;
  tenantId: string | null;
  actorSub: string;
  actorIssuer: string;
  on: 'enter' | 'exit';
  repeat: 'once' | 'every-visit';
  cooldownSec: number;
  accuracyFloorM: number;
  actionKind: string;
  actionText: string | null;
  placeId: string;
  placeName: string;
  circle: { center: { lat: number; lon: number }; radiusM: number };
}

/** A (rule, subject) state row as the evaluator keeps it. */
interface RuleState extends LocationTrackState {
  transitionSeq: number;
  fireCount: number;
  lastFireMs: number | null;
}

const RULES_SQL = `SELECT r.rule_id, r.tenant_id, r.armed_by_sub, r.armed_by_issuer, r.on_transition, r.repeat_mode,
    r.cooldown_sec, r.accuracy_floor_m, r.action_kind, r.action_text, p.place_id, p.name AS place_name,
    p.center_lat, p.center_lon, p.radius_m
  FROM location_rules r JOIN location_places p ON p.place_id = r.place_id
  WHERE location_rule_evaluable(r.rule_id, $1) ORDER BY r.rule_id`;

const STATES_SQL = `SELECT rule_id, presence, presence_since, enter_candidate_at, exit_candidate_at, transition_seq,
    fire_count, last_fire_at FROM location_rule_state
  WHERE subject_ref = $1 AND tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 AND rule_id = ANY($3::uuid[])
  FOR UPDATE`;

const UPSERT_STATE_SQL = `INSERT INTO location_rule_state (rule_id, subject_ref, owner_sub, principal_issuer, presence,
    presence_since, enter_candidate_at, exit_candidate_at, transition_seq, fire_count, last_fire_at, last_fix_at, updated_at)
  VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
  ON CONFLICT (rule_id, subject_ref) DO UPDATE SET presence = EXCLUDED.presence, presence_since = EXCLUDED.presence_since,
    enter_candidate_at = EXCLUDED.enter_candidate_at, exit_candidate_at = EXCLUDED.exit_candidate_at,
    transition_seq = EXCLUDED.transition_seq, fire_count = EXCLUDED.fire_count, last_fire_at = EXCLUDED.last_fire_at,
    last_fix_at = EXCLUDED.last_fix_at, updated_at = EXCLUDED.updated_at`;

const CLAIM_FIRE_SQL = `INSERT INTO location_rule_fires (rule_id, subject_ref, transition_id, owner_sub, principal_issuer,
    actor_sub, actor_issuer, transition, action_kind, place_id, place_name, reminder_text, evidence, fired_at, claimed_at)
  VALUES ($1, $2, $3, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $13)
  ON CONFLICT (rule_id, subject_ref, transition_id) DO NOTHING RETURNING fire_id`;

const SHARE_PLACES_SQL = `SELECT x.share_kind, x.share_id, x.place_id, p.center_lat, p.center_lon, p.radius_m,
    sp.presence, sp.presence_since, sp.enter_candidate_at, sp.exit_candidate_at
  FROM (SELECT 'member'::text AS share_kind, s.share_id, unnest(s.place_ids) AS place_id FROM location_shares s
         WHERE s.owner_sub = $1 AND s.principal_issuer = $2 AND s.revoked_at IS NULL
        UNION ALL
        SELECT 'guardian'::text, g.share_id, unnest(g.place_ids) FROM location_guardian_shares g
         WHERE g.user_sub = $1 AND g.revoked_at IS NULL) x
  JOIN location_places p ON p.place_id = x.place_id
  LEFT JOIN location_share_presence sp ON sp.share_kind = x.share_kind AND sp.share_id = x.share_id AND sp.place_id = x.place_id
  WHERE location_share_presence_writable(x.share_kind, x.share_id, x.place_id)`;

const UPSERT_PRESENCE_SQL = `INSERT INTO location_share_presence (share_kind, share_id, place_id, owner_sub, principal_issuer,
    presence, presence_since, enter_candidate_at, exit_candidate_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (share_kind, share_id, place_id) DO UPDATE SET presence = EXCLUDED.presence,
    presence_since = EXCLUDED.presence_since, enter_candidate_at = EXCLUDED.enter_candidate_at,
    exit_candidate_at = EXCLUDED.exit_candidate_at, updated_at = EXCLUDED.updated_at`;

/**
 * @description A timestamp column as epoch ms, or null.
 * @param value - The column value.
 * @returns Epoch ms or null.
 */
function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * @description Epoch ms as a Date for a statement parameter, or null.
 * @param value - Epoch ms or null.
 * @returns The Date or null.
 */
const at = (value: number | null): Date | null => (value === null ? null : new Date(value));

/**
 * @description A track state from a row's four state columns (unknown when there is no row).
 * @param row - The row, or undefined.
 * @returns The state.
 */
function trackOf(row: Row | undefined): LocationTrackState {
  if (!row || row.presence === null || row.presence === undefined) return { ...EMPTY_TRACK_STATE };
  return {
    presence: row.presence as LocationTrackState['presence'],
    presenceSinceMs: ms(row.presence_since),
    enterCandidateMs: ms(row.enter_candidate_at),
    exitCandidateMs: ms(row.exit_candidate_at),
  };
}

/**
 * @description Shape a rule row.
 * @param r - A row from {@link RULES_SQL}.
 * @returns The rule.
 */
function ruleOf(r: Row): EvaluatedRule {
  return {
    ruleId: String(r.rule_id), tenantId: r.tenant_id ? String(r.tenant_id) : null,
    actorSub: String(r.armed_by_sub), actorIssuer: String(r.armed_by_issuer),
    on: r.on_transition === 'exit' ? 'exit' : 'enter', repeat: r.repeat_mode === 'every-visit' ? 'every-visit' : 'once',
    cooldownSec: Number(r.cooldown_sec), accuracyFloorM: Number(r.accuracy_floor_m),
    actionKind: String(r.action_kind), actionText: r.action_text === null ? null : String(r.action_text),
    placeId: String(r.place_id), placeName: String(r.place_name),
    circle: { center: { lat: Number(r.center_lat), lon: Number(r.center_lon) }, radiusM: Number(r.radius_m) },
  };
}

/**
 * @description The evidence provenance a fire records: never a coordinate (D4 gate 5).
 * @param fix - The fix that caused the fire.
 * @returns The evidence object.
 */
export function fireEvidence(fix: LocationEvaluationFix): Record<string, unknown> {
  return {
    deviceId: fix.deviceId, source: fix.source, authMode: fix.authMode, mock: fix.mock,
    accuracyM: fix.accuracyM, receivedAt: new Date(fix.receivedAtMs).toISOString(),
  };
}

/**
 * @description Claim the fire for one step in the ledger, and finish a person's `once` rule.
 * @param client - A client stamped as the subject.
 * @param who - The subject.
 * @param rule - The rule.
 * @param state - The state after the step (its transition_seq numbers the transition).
 * @param fix - The fix.
 * @returns The fire id, or null when this transition was already claimed.
 */
async function claimFire(client: PoolClient, who: LocationPrincipal, rule: EvaluatedRule, state: RuleState, fix: LocationEvaluationFix): Promise<string | null> {
  const transitionId = `${rule.on}:${state.transitionSeq}`;
  const claimed = await client.query(CLAIM_FIRE_SQL, [rule.ruleId, who.sub, transitionId, who.principalIssuer, rule.actorSub,
    rule.actorIssuer, rule.on, rule.actionKind, rule.placeId, rule.placeName, rule.actionText,
    JSON.stringify(fireEvidence(fix)), at(fix.receivedAtMs)]);
  const fireId = claimed.rows[0]?.fire_id ? String(claimed.rows[0].fire_id) : null;
  if (fireId && rule.repeat === 'once' && rule.tenantId === null) {
    await client.query('UPDATE location_rules SET completed_at = $2, updated_at = NOW() WHERE rule_id = $1 AND tenant_id IS NULL',
      [rule.ruleId, at(fix.receivedAtMs)]);
  }
  return fireId;
}

/**
 * @description Step one rule for the subject, write its state, and claim a fire when it fires.
 * @param client - A client stamped as the subject.
 * @param who - The subject.
 * @param rule - The rule.
 * @param before - Its state row, if any.
 * @param fix - The fix.
 * @param nowMs - Evaluation time.
 * @returns The claimed fire id, or null.
 */
async function evaluateRule(client: PoolClient, who: LocationPrincipal, rule: EvaluatedRule, before: Row | undefined, fix: LocationEvaluationFix, nowMs: number): Promise<string | null> {
  const counters = { fireCount: Number(before?.fire_count ?? 0), lastFireMs: ms(before?.last_fire_at) };
  const step: LocationStepResult = stepPresence(trackOf(before), fix, rule.circle, rule.accuracyFloorM, nowMs);
  if (step.verdict !== 'qualifies') return null;
  const decision = fireDecision(step, { on: rule.on, repeat: rule.repeat, cooldownMs: rule.cooldownSec * 1000 }, counters, fix.receivedAtMs);
  const state: RuleState = {
    ...step.state,
    transitionSeq: Number(before?.transition_seq ?? 0) + (step.change ? 1 : 0),
    fireCount: counters.fireCount + (decision === 'fire' ? 1 : 0),
    lastFireMs: decision === 'fire' ? fix.receivedAtMs : counters.lastFireMs,
  };
  await client.query(UPSERT_STATE_SQL, [rule.ruleId, who.sub, who.principalIssuer, state.presence, at(state.presenceSinceMs),
    at(state.enterCandidateMs), at(state.exitCandidateMs), state.transitionSeq, state.fireCount, at(state.lastFireMs), at(fix.receivedAtMs)]);
  return decision === 'fire' ? claimFire(client, who, rule, state, fix) : null;
}

/**
 * @description Evaluate every rule live for the subject against one fix.
 * @param client - A client stamped as the subject.
 * @param who - The subject (a person).
 * @param fix - The fix.
 * @param nowMs - Evaluation time.
 * @returns Claimed fire ids and the number of rules evaluated.
 */
async function evaluateRules(client: PoolClient, who: LocationPrincipal, fix: LocationEvaluationFix, nowMs: number): Promise<{ firedIds: string[]; ruleCount: number }> {
  const rules = (await client.query(RULES_SQL, [who.sub])).rows.map(ruleOf);
  if (!rules.length) return { firedIds: [], ruleCount: 0 };
  const states = new Map((await client.query(STATES_SQL, [who.sub, who.principalIssuer, rules.map((r) => r.ruleId)])).rows
    .map((row) => [String(row.rule_id), row as Row]));
  const firedIds: string[] = [];
  for (const rule of rules) {
    const fired = await evaluateRule(client, who, rule, states.get(rule.ruleId), fix, nowMs);
    if (fired) firedIds.push(fired);
  }
  return { firedIds, ruleCount: rules.length };
}

/**
 * @description Keep the subject's share presence at every place of their active member shares and of
 * the guardian shares naming them. Nothing fires here.
 * @param client - A client stamped as the subject.
 * @param who - The subject.
 * @param fix - The fix.
 * @param nowMs - Evaluation time.
 * @returns How many share places were tracked.
 */
async function trackSharePresence(client: PoolClient, who: LocationPrincipal, fix: LocationEvaluationFix, nowMs: number): Promise<number> {
  const rows = (await client.query(SHARE_PLACES_SQL, [who.sub, who.principalIssuer])).rows as Row[];
  for (const row of rows) {
    const circle = { center: { lat: Number(row.center_lat), lon: Number(row.center_lon) }, radiusM: Number(row.radius_m) };
    const step = stepPresence(trackOf(row), fix, circle, LOCATION_EVALUATION.defaultAccuracyFloorM, nowMs);
    if (step.verdict !== 'qualifies') continue;
    const s = step.state;
    await client.query(UPSERT_PRESENCE_SQL, [row.share_kind, row.share_id, row.place_id, who.sub, who.principalIssuer,
      s.presence, at(s.presenceSinceMs), at(s.enterCandidateMs), at(s.exitCandidateMs), at(fix.receivedAtMs)]);
  }
  return rows.length;
}

/**
 * @description Evaluate one fix for a person subject (ADR-169 D4), inside the transaction that
 * ingested it and under their own identity: the rules live for them and their share presence.
 * @param client - A client stamped as the subject by withLocationOwnerSession.
 * @param who - The subject (a person, subject_ref = their sub).
 * @param fix - The full-precision fix with its provenance; it is never written by this function.
 * @param nowMs - Evaluation time, epoch ms (the fix's receipt time on the ingest path).
 * @returns Claimed fire ids (dispatch them after commit) and what was evaluated.
 */
export async function evaluatePersonFix(client: PoolClient, who: LocationPrincipal, fix: LocationEvaluationFix, nowMs: number): Promise<LocationEvaluationResult> {
  const started = Date.now();
  const rules = await evaluateRules(client, who, fix, nowMs);
  const shareCount = await trackSharePresence(client, who, fix, nowMs);
  log.debug({ op: 'evaluate', outcome: rules.firedIds.length ? 'fired' : 'quiet', ruleCount: rules.ruleCount, shareCount,
    fireCount: rules.firedIds.length, durationMs: Date.now() - started }, 'location fix evaluated');
  return { firedIds: rules.firedIds, ruleCount: rules.ruleCount, shareCount };
}
