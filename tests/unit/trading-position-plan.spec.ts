/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the pure half of the per-position exit plans (ADR-052 addendum): exitPlanSessions (one resolver for dispatch and Lab; knob outranks env, mode-aware arming, clamps), addSessions over the NYSE closure table, planTermsFor, and planExits — each door (stop, take-profit, trailing, expiry) with its priority, a POLICY FLIP that cannot re-price a stored plan, unplanned and unmanaged positions handed back to the global rules. No database, no network.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  exitPlanSessions, addSessions, planTermsFor, planExits, exitsToRun, RISK_POLICIES, DEFAULT_EXIT_PLAN_SESSIONS,
  type Position, type PositionPlan,
} from '../../src/features/trading';

/** A held long marked at `price` whose venue average is `avg`. */
const pos = (symbol: string, price: number, avg = 100, qty = 10, extra: Partial<Position> = {}): Position =>
  ({ symbol, qty, avgEntryPrice: avg, currentPrice: price, marketValue: qty * price, unrealizedPl: qty * (price - avg), ...extra });

/** A plan stamped under `posture` at `entry` on 2026-09-01 with a `sessions` clock. */
const plan = (symbol: string, entry = 100, posture: keyof typeof RISK_POLICIES = 'balanced', sessions = 20): PositionPlan =>
  ({ planId: `plan-${symbol}`, symbol, ...planTermsFor(RISK_POLICIES[posture], entry, sessions, '2026-09-01') });

const TODAY = '2026-09-10';

describe('exitPlanSessions — ONE resolver for the dispatch and the Strategy Lab', () => {
  beforeEach(() => { delete process.env.TRADING_EXIT_PLANS; delete process.env.TRADING_EXIT_PLAN_SESSIONS; });

  it('is OFF by default for both books and for a Lab walk', () => {
    expect(exitPlanSessions(undefined, 'paper')).toBe(0);
    expect(exitPlanSessions(null, 'live')).toBe(0);
    expect(exitPlanSessions(undefined, null)).toBe(0);
  });

  it('an absent knob inherits the mode-aware env: paper arms paper only, with the pre-registered 20 sessions', () => {
    process.env.TRADING_EXIT_PLANS = 'paper';
    expect(exitPlanSessions(undefined, 'paper')).toBe(DEFAULT_EXIT_PLAN_SESSIONS);
    expect(DEFAULT_EXIT_PLAN_SESSIONS).toBe(20);
    expect(exitPlanSessions(undefined, 'live')).toBe(0);
    expect(exitPlanSessions(undefined, null)).toBe(0);
    process.env.TRADING_EXIT_PLAN_SESSIONS = '10';
    expect(exitPlanSessions(null, 'paper')).toBe(10);
  });

  it('a finite knob outranks the env (0 = explicit off), is whole and clamped', () => {
    process.env.TRADING_EXIT_PLANS = 'both';
    expect(exitPlanSessions(0, 'paper')).toBe(0);
    expect(exitPlanSessions(7.6, 'live')).toBe(8);
    expect(exitPlanSessions(9999, null)).toBe(252);
    expect(exitPlanSessions(-1, 'paper')).toBe(0);
  });
});

describe('addSessions — the plan clock counts NYSE sessions', () => {
  it('skips weekends', () => {
    expect(addSessions('2026-09-25', 1)).toBe('2026-09-28'); // Fri → Mon
  });
  it('skips an exchange closure (Thanksgiving 2026-11-26)', () => {
    expect(addSessions('2026-11-25', 1)).toBe('2026-11-27');
  });
  it('counts twenty sessions across four weekends', () => {
    expect(addSessions('2026-09-28', 20)).toBe('2026-10-26');
  });
  it('zero sessions is the start date', () => {
    expect(addSessions('2026-09-28', 0)).toBe('2026-09-28');
  });
});

describe('planTermsFor — a plan carries the dials in force at entry', () => {
  it('stamps stop/take-profit prices and the expiry from the policy and the reference price', () => {
    const t = planTermsFor(RISK_POLICIES.balanced, 50, 20, '2026-09-28');
    expect(t).toEqual({
      posture: 'balanced', entryPrice: 50, stopLossPct: 9, takeProfitPct: 20, trailArmPct: 8, trailGivebackPct: 4,
      stopPrice: 45.5, takeProfitPrice: 60, sessions: 20, stampedSession: '2026-09-28', expirySession: '2026-10-26',
    });
  });
});

describe('planExits — each position exits on ITS OWN stored plan', () => {
  it('opens the stop, take-profit and expiry doors, naming the plan', () => {
    const plans = new Map([['STOP', plan('STOP')], ['TAKE', plan('TAKE')], ['OLD', { ...plan('OLD'), expirySession: '2026-09-10' }]]);
    const { exits, unplanned } = planExits([pos('STOP', 90.9), pos('TAKE', 120), pos('OLD', 101)], plans, new Map(), TODAY);
    expect(exits.map((e) => [e.symbol, e.reason, e.planId])).toEqual([
      ['STOP', 'plan-stop', 'plan-STOP'], ['TAKE', 'plan-tp', 'plan-TAKE'], ['OLD', 'plan-expiry', 'plan-OLD'],
    ]);
    expect(exits.every((e) => e.qty === 10)).toBe(true); // a plan door is a full-position exit
    expect(unplanned).toEqual([]);
  });

  it('trails an armed winner back from its peak (balanced: arm +8%, give back 4%)', () => {
    const { exits } = planExits([pos('TRL', 109.5)], new Map([['TRL', plan('TRL')]]), new Map([['TRL', 115]]), TODAY);
    expect(exits.map((e) => e.reason)).toEqual(['plan-trail']);
    // Same price, no peak above it → not trailing, and not at take-profit → hold.
    expect(planExits([pos('TRL', 109.5)], new Map([['TRL', plan('TRL')]]), new Map(), TODAY).exits).toEqual([]);
  });

  it('a price door outranks the clock on the same fire (the ledger names the door that judged it)', () => {
    const old = { ...plan('BOTH'), expirySession: '2026-09-01' };
    expect(planExits([pos('BOTH', 80)], new Map([['BOTH', old]]), new Map(), TODAY).exits[0].reason).toBe('plan-stop');
  });

  it('the clock still fires with no live price', () => {
    const old = { ...plan('NOPX'), expirySession: '2026-09-01' };
    expect(planExits([pos('NOPX', 0)], new Map([['NOPX', old]]), new Map(), TODAY).exits[0].reason).toBe('plan-expiry');
  });

  it('A POLICY FLIP CANNOT RE-PRICE A STORED PLAN — the 2026-07-08 posture flip, replayed', () => {
    // Stamped under balanced (9% stop); the book then flips to active (5% stop). Down 7%:
    const p = pos('FLIP', 93);
    const planned = planExits([p], new Map([['FLIP', plan('FLIP', 100, 'balanced')]]), new Map(), TODAY);
    expect(planned.exits).toEqual([]); // the plan holds
    // ...while the global rule under the new posture WOULD have sold it — the retro-applied stop.
    expect(exitsToRun([p], RISK_POLICIES.active).map((e) => e.reason)).toEqual(['stop_loss']);
  });

  it('judges the plan entry, not the venue average — a re-underwritten plan moves the basis', () => {
    // Venue average 100, but the plan was re-underwritten at 120: at 110 the plan is down 8.3% (hold under balanced).
    const { exits } = planExits([pos('RE', 110, 100)], new Map([['RE', plan('RE', 120)]]), new Map(), TODAY);
    expect(exits).toEqual([]);
    // At 109 it is down 9.2% from ITS entry → plan stop, though the venue average shows a 9% GAIN.
    expect(planExits([pos('RE', 109, 100)], new Map([['RE', plan('RE', 120)]]), new Map(), TODAY).exits[0].reason).toBe('plan-stop');
  });

  it('hands unplanned and unmanaged positions back to the global rules untouched', () => {
    const managed = pos('NOPLAN', 50);
    const handBought = pos('HAND', 50, 100, 10, { unmanaged: true });
    const { exits, unplanned } = planExits([managed, handBought], new Map([['HAND', plan('HAND')]]), new Map(), TODAY);
    expect(exits).toEqual([]); // a plan must never be the path that trades an unaccounted holding
    expect(unplanned).toEqual([managed, handBought]);
  });
});
