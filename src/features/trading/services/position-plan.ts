/**
 * Per-position exit plans (ADR-052 addendum, "every buy carries its full plan") — the PURE half.
 *
 * At entry the engine stamps each autonomous position with its complete plan: the entry reference
 * price, the stop / take-profit / trailing dials of the policy in force at that moment, and an
 * expiry N NYSE sessions out. From then on the position exits on ITS OWN plan, not the global
 * policy, so a later posture flip cannot silently re-price positions already in flight (the
 * 2026-07-08 incident); re-pricing is the explicit amendPlans() action instead. The plan is the
 * default path, not a cage: event doors (breakdown, technical sell, rotation) may still exit early,
 * and the ledger records which door fired. A fresh buy signal re-underwrites the plan with a new
 * clock. This file holds the math and the one resolver; the table lives in
 * src/app/trading-position-plans.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — exitPlanSessions (the ONE resolver the dispatch and the Strategy Lab read: a finite StrategyConfig knob decides, an absent knob inherits the mode-aware TRADING_EXIT_PLANS / TRADING_EXIT_PLAN_SESSIONS env default, OFF unless armed), planTermsFor (stamp a plan from the policy in force and an entry reference price), addSessions (NYSE-session expiry clock over the exchange's own closure table), and planExits (judge each held position against its own stored plan: stop, take-profit, trailing, expiry — positions with no plan are handed back for the global rules).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | exitPlanSessions reads TRADING_EXIT_PLAN_SESSIONS through envNumberOr, so a blank value is unset. The compose file forwards it as `${TRADING_EXIT_PLAN_SESSIONS:-}`: armed with TRADING_EXIT_PLANS=paper and no value in .env, the api received an empty string, Number('') is 0, and plans resolved OFF while armed. Blank now means the pre-registered 20 sessions; a deliberate '0' is still the explicit off.
 *
 * @module position-plan
 */

import type { Position } from './broker-adapter';
import type { RiskPolicy, ExitOrder, PlanExitDoor } from './portfolio';
import { modeArmed, envNumberOr } from './entry-guards';
import { nyseHolidayOn } from './nyse-holidays';

/** Pre-registered expiry, in NYSE sessions: four times the default weekly rotation cadence
 *  (TRADING_ROTATION_EVERY_DAYS=5), so a name the rotation keeps re-selecting is re-underwritten
 *  several times before its clock can run out, while a position nothing re-earns leaves within
 *  about a calendar month. Harness-tested like the stop width before any live promotion. */
export const DEFAULT_EXIT_PLAN_SESSIONS = 20;

/** Upper clamp on a plan's life (one trading year); a longer clock is indistinguishable from none. */
const MAX_EXIT_PLAN_SESSIONS = 252;

/**
 * @description Whether per-position exit plans are armed for one book or one Lab walk, and their
 * expiry — the ONE resolver the dispatch and the Strategy Lab both read. A finite `knob`
 * (StrategyConfig.exitPlanSessions on the applied strategy) decides: 0 is an explicit off, N > 0 arms
 * plans that expire after N sessions. An absent knob (null/undefined) inherits the book's mode-aware
 * env default — TRADING_EXIT_PLANS arms the book kind, TRADING_EXIT_PLAN_SESSIONS sets N (default
 * {@link DEFAULT_EXIT_PLAN_SESSIONS}). A Lab walk passes mode null, so an absent knob is off there.
 * @param knob - The applied StrategyConfig's exitPlanSessions (null/undefined = inherit).
 * @param mode - The book kind firing, or null for a Lab walk.
 * @returns N sessions (whole, clamped 1–252) when plans are armed; 0 when they are off.
 */
export function exitPlanSessions(knob: number | null | undefined, mode: 'paper' | 'live' | null): number {
  const clampN = (v: number): number => (Number.isFinite(v) && v >= 1 ? Math.min(MAX_EXIT_PLAN_SESSIONS, Math.round(v)) : 0);
  if (knob !== null && knob !== undefined) return clampN(Number(knob));
  if (!mode || !modeArmed('TRADING_EXIT_PLANS', mode)) return 0;
  return clampN(envNumberOr('TRADING_EXIT_PLAN_SESSIONS', DEFAULT_EXIT_PLAN_SESSIONS));
}

/** The terms of one plan — everything an exit needs, fixed at stamp time. */
export interface PlanTerms {
  /** The posture whose dials were stamped (display and audit only). */
  posture: string;
  /** The entry REFERENCE price the engine sized against — known at stamp time, never moves. */
  entryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailArmPct: number;
  trailGivebackPct: number;
  /** entryPrice × (1 − stopLossPct/100), rounded to 4dp for display; exits judge the percent. */
  stopPrice: number;
  /** entryPrice × (1 + takeProfitPct/100), rounded to 4dp for display. */
  takeProfitPrice: number;
  /** The plan's life in NYSE sessions. */
  sessions: number;
  /** The ET session date the plan was stamped (YYYY-MM-DD). */
  stampedSession: string;
  /** The ET session date on which the plan-expiry door opens (YYYY-MM-DD). */
  expirySession: string;
}

/** The policy dials a plan carries — any RiskPolicy satisfies it. */
export type PlanDials = Pick<RiskPolicy, 'posture' | 'stopLossPct' | 'takeProfitPct' | 'trailArmPct' | 'trailGivebackPct'>;

/** A stored plan, as the exit leg reads it back. */
export interface PositionPlan extends PlanTerms {
  planId: string;
  symbol: string;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * @description Advance an ET session date by `n` NYSE sessions: weekends and the exchange's own
 * full-closure days (nyse-holidays, plus any TRADING_MARKET_HOLIDAYS additions) are skipped. Beyond
 * the closure table's horizon only weekends are skipped, so a plan there can expire at most a
 * holiday early.
 * @param isoDate - The start session, YYYY-MM-DD.
 * @param n - Sessions to advance (0 returns the start date).
 * @returns The session date `n` sessions later, YYYY-MM-DD.
 */
export function addSessions(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (day === 0 || day === 6 || nyseHolidayOn(iso)) continue;
    left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * @description Stamp a plan from the policy in force and the entry reference price. Pure.
 * @param policy - The dials in force at entry (a RiskPolicy, or an amended set of dials).
 * @param entryPrice - The price the engine sized the buy against.
 * @param sessions - The plan's life in NYSE sessions (> 0).
 * @param stampedSession - Today's ET session date, YYYY-MM-DD.
 * @returns The plan terms.
 */
export function planTermsFor(policy: PlanDials, entryPrice: number, sessions: number, stampedSession: string): PlanTerms {
  return {
    posture: policy.posture,
    entryPrice: round4(entryPrice),
    stopLossPct: policy.stopLossPct,
    takeProfitPct: policy.takeProfitPct,
    trailArmPct: policy.trailArmPct,
    trailGivebackPct: policy.trailGivebackPct,
    stopPrice: round4(entryPrice * (1 - policy.stopLossPct / 100)),
    takeProfitPrice: round4(entryPrice * (1 + policy.takeProfitPct / 100)),
    sessions,
    stampedSession,
    expirySession: addSessions(stampedSession, sessions),
  };
}

/**
 * @description The door, if any, a position's own plan opens right now. Priority mirrors the global
 * rules: stop, then take-profit, then trailing — and the clock last, so a position that is also
 * past a price door records the price door that actually judged it.
 * @param plan - The stored plan.
 * @param price - The position's current price (0 or less = unknown; only the clock can fire).
 * @param peak - The highest price seen since entry (the trailing high-water mark).
 * @param todaySession - Today's ET session date, YYYY-MM-DD.
 * @returns The door and the P&L percent from the plan's entry, or null to hold.
 */
function planDoor(plan: PositionPlan, price: number, peak: number, todaySession: string): { door: PlanExitDoor; pnlPct: number } | null {
  const entry = plan.entryPrice;
  const pnlPct = price > 0 && entry > 0 ? ((price - entry) / entry) * 100 : 0;
  if (price > 0 && entry > 0) {
    if (pnlPct <= -plan.stopLossPct) return { door: 'plan-stop', pnlPct };
    if (pnlPct >= plan.takeProfitPct) return { door: 'plan-tp', pnlPct };
    const high = Math.max(peak, entry);
    const givebackPct = high > 0 ? ((high - price) / high) * 100 : 0;
    if (pnlPct >= plan.trailArmPct && givebackPct >= plan.trailGivebackPct) return { door: 'plan-trail', pnlPct };
  }
  if (todaySession >= plan.expirySession) return { door: 'plan-expiry', pnlPct };
  return null;
}

/**
 * @description Split the held book into positions that exit on their OWN stored plan and positions
 * that have none (handed back for the global rules, exactly as before plans existed). A position the
 * engine cannot account for (ADR-159 `unmanaged`) is handed back too — the global rules already
 * withhold every decision for it, and a plan must never be the path that trades it.
 * @param positions - The marked, overlaid positions the fire holds.
 * @param plans - Open plans by UPPERCASE symbol.
 * @param peaks - The rolled-forward peak per UPPERCASE symbol.
 * @param todaySession - Today's ET session date, YYYY-MM-DD.
 * @returns The plan exits (full-position sells naming their door and plan) and the unplanned positions.
 */
export function planExits(
  positions: Position[], plans: Map<string, PositionPlan>, peaks: Map<string, number>, todaySession: string,
): { exits: ExitOrder[]; unplanned: Position[] } {
  const exits: ExitOrder[] = [];
  const unplanned: Position[] = [];
  for (const p of positions) {
    const sym = p.symbol.toUpperCase();
    const plan = plans.get(sym);
    if (!(p.qty > 0) || !plan || p.unmanaged) { unplanned.push(p); continue; }
    const hit = planDoor(plan, p.currentPrice ?? 0, peaks.get(sym) ?? plan.entryPrice, todaySession);
    if (hit) exits.push({ symbol: p.symbol, qty: p.qty, reason: hit.door, pnlPct: hit.pnlPct, planId: plan.planId });
  }
  return { exits, unplanned };
}
