/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pure draft-lifecycle state machine + judge-bar + slot helpers for the LinkedIn assistant. No IO, no LLM — the whole contract (which transitions are legal, publish-blocked-unless-approved, reject-is-terminal, when a refine pass is owed, and the next publish slot) is unit-testable with zero cost. The store + service enforce these rules; nothing hardcodes a transition string of its own.
 */

import type { DraftState } from '../types';

/**
 * @description The legal state transitions. A draft is generated (`draft`), graded and shown
 * for review (`pending-approval`), approved into a slot (`scheduled`), then published or
 * rejected. Publish is reachable ONLY from `scheduled` — the machine is where "you can't
 * publish something that wasn't approved" is enforced, not scattered across route guards.
 * `published` and `rejected` have no outgoing edges (terminal).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<DraftState, readonly DraftState[]>> = {
  draft: ['pending-approval', 'rejected'],
  'pending-approval': ['scheduled', 'rejected'],
  scheduled: ['published', 'rejected'],
  published: [],
  rejected: [],
} as const;

/**
 * @description Is a state terminal (no further transitions allowed)? Used to fail a mutation
 * on an already-published or already-rejected draft with a clear reason instead of a silent
 * no-op.
 * @param state - The current draft state.
 * @returns True when the state has no outgoing transitions.
 */
export function isTerminal(state: DraftState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

/**
 * @description May a draft move from `from` to `to`? The single authority both the store and
 * the service consult before writing a new state.
 * @param from - The current state.
 * @param to - The desired next state.
 * @returns True when the transition is legal.
 */
export function canTransition(from: DraftState, to: DraftState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * @description Throwing form of {@link canTransition}. Used by the service so an illegal
 * transition (e.g. publish from `pending-approval`, or any move off a terminal state) surfaces
 * as a 409-worthy error the route maps, rather than a corrupt row.
 * @param from - The current state.
 * @param to - The desired next state.
 * @throws Error when the transition is illegal (message names both states).
 */
export function assertTransition(from: DraftState, to: DraftState): void {
  if (!canTransition(from, to)) {
    throw Object.assign(
      new Error(
        isTerminal(from)
          ? `Draft is ${from} (terminal) — no further changes are allowed.`
          : `Cannot move a ${from} draft to ${to}.`,
      ),
      { code: 'illegal_transition', from, to },
    );
  }
}

/**
 * @description Does a first-pass score fall below the quality bar, so the assistant owes the
 * draft exactly one refine pass? Kept pure + separate so the "when do we spend a second LLM
 * call" decision is testable without running the flow.
 * @param score - The overall grade (0..100).
 * @param bar - The pass bar (env SOCIAL_JUDGE_BAR, default 75).
 * @returns True when a refine pass should run.
 */
export function needsRefine(score: number, bar: number): boolean {
  return Number.isFinite(score) && score < bar;
}

/**
 * @description Resolve the judge bar from an env-style string, clamped to a sane 0..100 with a
 * default of 75. Centralized so the route and the service never re-parse SOCIAL_JUDGE_BAR
 * inconsistently.
 * @param raw - The raw env value (may be undefined/garbage).
 * @returns The effective bar, 0..100.
 */
export function resolveJudgeBar(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 75;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * @description Compute the next publish slot at approval time: the next occurrence of the
 * configured posting hour (in the server's local time) strictly after `from`. Deterministic
 * (no randomness) so approving a draft always lands on a predictable, reviewable slot — a real
 * scheduled time the operator can see, not an "immediately" placeholder. The publish-now path
 * ignores this; it exists so a scheduled draft has an honest target time.
 * @param from - The reference "now".
 * @param slotHour - The preferred posting hour 0..23 (env SOCIAL_POST_SLOT_HOUR, default 9).
 * @returns The next slot as a Date.
 */
export function computeNextSlot(from: Date, slotHour: number): Date {
  const hour = Number.isFinite(slotHour) ? Math.min(23, Math.max(0, Math.round(slotHour))) : 9;
  const slot = new Date(from.getTime());
  slot.setSeconds(0, 0);
  slot.setMinutes(0);
  slot.setHours(hour);
  if (slot.getTime() <= from.getTime()) {
    slot.setDate(slot.getDate() + 1);
  }
  return slot;
}
