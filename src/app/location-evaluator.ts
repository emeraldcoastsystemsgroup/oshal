/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 (D4 "Hysteresis, debounce, confidence"): the pure presence stepper the rule evaluator and the share-presence tracker share, and the fire decision for a rule. Every timing decision uses the server's receipt time; the client-reported observation time can only disqualify a fix (one observed more than the freshness window before it was received is a back-dated, buffered fix), never make one fresh. A fix qualifies only with a reported accuracy within the floor and a receipt no older than the freshness window at evaluation. Enter needs two qualifying fixes inside the circle received at least the enter spacing apart; exit needs the subject confidently outside (distance minus accuracy beyond radius plus margin, margin max(50 m, 25 % of the radius)) for the exit dwell, and any qualifying fix that is not confidently outside cancels a pending exit, so edge jitter never flaps the state. The first determination from an unknown state is a baseline and never fires, which is what makes "remind me next time I'm at X", said while at X, wait for the next visit. The fire decision applies the rule's direction, once versus every visit and the per-(rule, subject) cooldown, all against receipt times. No clock, database or logger is read here: the callers pass time in, so a scripted fix sequence replays exactly.
 *
 * @module app/location-evaluator
 */

import { circleContains, haversineM, type GeoCircle, type GeoPoint } from '@/shared/utils/geo';

/** @description The D4 defaults; each is a named constant so specs and callers share one source. */
export const LOCATION_EVALUATION = Object.freeze({
  /** A fix counts only if it was received at most this long before evaluation (and observed at most this long before receipt). */
  maxFixAgeMs: 120_000,
  /** Two inside fixes must be received at least this far apart to enter. */
  enterSpacingMs: 30_000,
  /** The subject must stay confidently outside this long to exit. */
  exitDwellMs: 180_000,
  /** The smallest exit margin, metres. */
  minExitMarginM: 50,
  /** The exit margin as a fraction of the radius, when that is larger. */
  exitMarginFraction: 0.25,
  /** The default accuracy floor a fix must be within, metres. */
  defaultAccuracyFloorM: 50,
  /** The default per-(rule, subject) cooldown, seconds. */
  defaultCooldownSec: 900,
});

/** @description Where a subject is relative to one place, as far as qualifying fixes have established. */
export type LocationPresence = 'unknown' | 'inside' | 'outside';

/** @description The durable hysteresis state for one (rule or share place, subject). Times are receipt times, epoch ms. */
export interface LocationTrackState {
  presence: LocationPresence;
  presenceSinceMs: number | null;
  enterCandidateMs: number | null;
  exitCandidateMs: number | null;
}

/** @description One fix as the evaluator sees it: full precision, in memory only. */
export interface LocationFixSample {
  point: GeoPoint;
  accuracyM: number | null;
  /** Server receipt time, epoch ms. */
  receivedAtMs: number;
  /** Client-reported observation time, epoch ms. */
  observedAtMs: number;
}

/** @description Why a fix did or did not qualify. */
export type LocationFixVerdict = 'qualifies' | 'no-accuracy' | 'inaccurate' | 'stale' | 'back-dated';

/** @description What one step did. */
export interface LocationStepResult {
  state: LocationTrackState;
  /** The presence change this fix completed, if any. */
  change: 'enter' | 'exit' | null;
  /** True when the change was the first determination from 'unknown' (a baseline: never fires). */
  baseline: boolean;
  verdict: LocationFixVerdict;
}

/** @description A rule's firing parameters. */
export interface LocationFireParams {
  on: 'enter' | 'exit';
  repeat: 'once' | 'every-visit';
  cooldownMs: number;
}

/** @description What a (rule, subject) has fired so far. */
export interface LocationFireCounters {
  fireCount: number;
  /** Receipt time of the fix that caused the last fire, epoch ms. */
  lastFireMs: number | null;
}

/** @description Why a rule did or did not fire on a step. */
export type LocationFireReason = 'fire' | 'no-change' | 'baseline' | 'other-direction' | 'once-done' | 'cooldown';

/** @description A state with nothing established. */
export const EMPTY_TRACK_STATE: LocationTrackState = Object.freeze({
  presence: 'unknown', presenceSinceMs: null, enterCandidateMs: null, exitCandidateMs: null,
}) as LocationTrackState;

/**
 * @description Whether a fix may move a state (ADR-169 D4): a reported accuracy within the floor,
 * received no more than the freshness window before evaluation, and not observed more than that
 * window before it was received.
 * @param fix - The fix.
 * @param accuracyFloorM - The rule's floor.
 * @param nowMs - Evaluation time, epoch ms.
 * @returns 'qualifies' or the reason it does not.
 */
export function fixVerdict(fix: LocationFixSample, accuracyFloorM: number, nowMs: number): LocationFixVerdict {
  if (fix.accuracyM === null || !Number.isFinite(fix.accuracyM)) return 'no-accuracy';
  if (fix.accuracyM > accuracyFloorM) return 'inaccurate';
  if (nowMs - fix.receivedAtMs > LOCATION_EVALUATION.maxFixAgeMs) return 'stale';
  if (fix.receivedAtMs - fix.observedAtMs > LOCATION_EVALUATION.maxFixAgeMs) return 'back-dated';
  return 'qualifies';
}

/**
 * @description The exit margin for a radius: max(50 m, 25 % of the radius).
 * @param radiusM - The place radius.
 * @returns Metres.
 */
export function exitMarginM(radiusM: number): number {
  return Math.max(LOCATION_EVALUATION.minExitMarginM, LOCATION_EVALUATION.exitMarginFraction * radiusM);
}

/**
 * @description Whether a fix puts the subject confidently outside a circle: distance minus accuracy
 * beyond radius plus margin.
 * @param circle - The place.
 * @param point - The fix position.
 * @param accuracyM - The fix accuracy.
 * @returns true when confidently outside.
 */
export function confidentlyOutside(circle: GeoCircle, point: GeoPoint, accuracyM: number): boolean {
  return haversineM(circle.center, point) - accuracyM > circle.radiusM + exitMarginM(circle.radiusM);
}

/**
 * @description The step for a subject not yet known to be inside: two inside fixes at least the enter
 * spacing apart enter; a confidently-outside fix from unknown is an outside baseline.
 * @param state - The state before.
 * @param fix - A qualifying fix.
 * @param circle - The place.
 * @returns The step.
 */
function stepNotInside(state: LocationTrackState, fix: LocationFixSample, circle: GeoCircle): LocationStepResult {
  const at = fix.receivedAtMs;
  if (circleContains(circle, fix.point)) {
    const candidate = state.enterCandidateMs;
    if (candidate === null || at < candidate) {
      return { state: { ...state, enterCandidateMs: at, exitCandidateMs: null }, change: null, baseline: false, verdict: 'qualifies' };
    }
    if (at - candidate < LOCATION_EVALUATION.enterSpacingMs) {
      return { state: { ...state, exitCandidateMs: null }, change: null, baseline: false, verdict: 'qualifies' };
    }
    const baseline = state.presence === 'unknown';
    return {
      state: { presence: 'inside', presenceSinceMs: at, enterCandidateMs: null, exitCandidateMs: null },
      change: 'enter', baseline, verdict: 'qualifies',
    };
  }
  const outside = confidentlyOutside(circle, fix.point, fix.accuracyM as number);
  if (state.presence === 'unknown' && outside) {
    return {
      state: { presence: 'outside', presenceSinceMs: at, enterCandidateMs: null, exitCandidateMs: null },
      change: 'exit', baseline: true, verdict: 'qualifies',
    };
  }
  return { state: { ...state, enterCandidateMs: null }, change: null, baseline: false, verdict: 'qualifies' };
}

/**
 * @description The step for a subject known to be inside: confidently outside for the exit dwell exits;
 * any qualifying fix that is not confidently outside cancels a pending exit.
 * @param state - The state before (presence inside).
 * @param fix - A qualifying fix.
 * @param circle - The place.
 * @returns The step.
 */
function stepInside(state: LocationTrackState, fix: LocationFixSample, circle: GeoCircle): LocationStepResult {
  const at = fix.receivedAtMs;
  if (!confidentlyOutside(circle, fix.point, fix.accuracyM as number)) {
    return { state: { ...state, exitCandidateMs: null }, change: null, baseline: false, verdict: 'qualifies' };
  }
  const candidate = state.exitCandidateMs;
  if (candidate === null || at < candidate) {
    return { state: { ...state, exitCandidateMs: at }, change: null, baseline: false, verdict: 'qualifies' };
  }
  if (at - candidate < LOCATION_EVALUATION.exitDwellMs) {
    return { state, change: null, baseline: false, verdict: 'qualifies' };
  }
  return {
    state: { presence: 'outside', presenceSinceMs: at, enterCandidateMs: null, exitCandidateMs: null },
    change: 'exit', baseline: false, verdict: 'qualifies',
  };
}

/**
 * @description Advance one (place, subject) state by one fix (ADR-169 D4). A fix that does not
 * qualify changes nothing.
 * @param state - The state before.
 * @param fix - The fix, full precision.
 * @param circle - The place.
 * @param accuracyFloorM - The accuracy floor.
 * @param nowMs - Evaluation time, epoch ms.
 * @returns The new state, the change it completed (if any), whether that change was a baseline, and the fix verdict.
 */
export function stepPresence(
  state: LocationTrackState, fix: LocationFixSample, circle: GeoCircle, accuracyFloorM: number, nowMs: number,
): LocationStepResult {
  const verdict = fixVerdict(fix, accuracyFloorM, nowMs);
  if (verdict !== 'qualifies') return { state, change: null, baseline: false, verdict };
  return state.presence === 'inside' ? stepInside(state, fix, circle) : stepNotInside(state, fix, circle);
}

/**
 * @description Whether a rule fires on a step (ADR-169 D4): only on a real change (never a baseline)
 * in the rule's direction, not after a `once` rule has fired, and not inside the cooldown measured
 * from the receipt time of the fix that caused the last fire.
 * @param step - The presence step.
 * @param params - The rule's direction, repeat mode and cooldown.
 * @param counters - What the (rule, subject) has fired.
 * @param fixReceivedAtMs - Receipt time of the fix that made the step.
 * @returns 'fire' or the reason it does not.
 */
export function fireDecision(
  step: Pick<LocationStepResult, 'change' | 'baseline'>, params: LocationFireParams, counters: LocationFireCounters, fixReceivedAtMs: number,
): LocationFireReason {
  if (!step.change) return 'no-change';
  if (step.baseline) return 'baseline';
  if (step.change !== params.on) return 'other-direction';
  if (params.repeat === 'once' && counters.fireCount > 0) return 'once-done';
  if (counters.lastFireMs !== null && fixReceivedAtMs - counters.lastFireMs < params.cooldownMs) return 'cooldown';
  return 'fire';
}
