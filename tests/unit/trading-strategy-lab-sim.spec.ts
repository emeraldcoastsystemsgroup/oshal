/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Strategy Lab sim (ADR-092): config normalization, tearsheet metric math, and the rotation walk's core invariants (buys the leader, protective stop fires, no NaN poisoning, resumable state) on synthetic bars — no network, no DB.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-052 addendum knobs: normalizeConfig keeps an absent knob null (inherit) and clamps a set one; an UNARMED walk writes no new state field (existing runs replay unchanged); marketGapFilterPct holds a rotation rebalance on a gapped-down SPY open and defers it to the next unheld session, fails OPEN with no opens, and holds the ensemble scan's buys; exitPlanSessions sells a lot on the plan clock and a rotation re-selection re-underwrites it; blends zero both knobs.
 */

import { describe, expect, it } from 'vitest';
import {
  LAB_START_CASH, metricsFor, normalizeConfig, policyFor, stepDay, sessionGapHeld, blendPartConfig,
  type EquityPoint, type StrategyConfig, type WalkState,
} from '../../src/app/trading-strategy-lab-sim';

/** Synthetic aligned bars: N sessions, symbols with a fixed daily drift. */
function makeAligned(days: number, drifts: Record<string, number>, spyDrift = 0.001) {
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 2 + i));
    return d.toISOString().slice(0, 10);
  });
  const series = new Map<string, { firstReal: number; closes: number[] }>();
  for (const [sym, drift] of Object.entries(drifts)) {
    const closes: number[] = [];
    let px = 100;
    for (let i = 0; i < days; i++) { closes.push(px); px *= 1 + drift; }
    series.set(sym, { firstReal: 0, closes });
  }
  const spy: number[] = [];
  let s = 500;
  for (let i = 0; i < days; i++) { spy.push(s); s *= 1 + spyDrift; }
  return { dates, spy, series, feed: 'sip' as const };
}

function freshState(lastDate = ''): WalkState {
  return { cash: LAB_START_CASH, lots: {}, coreQty: 0, barCount: 0, peakEquity: LAB_START_CASH, maxDD: 0, wins: 0, losses: 0, trades: 0, lastDate, spyAnchor: 500 };
}

const rotationCfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => normalizeConfig({
  kind: 'rotation', posture: 'active', rank: 'momentum', cadenceDays: 1, topN: 1,
  weighting: 'equal', universe: ['UPP', 'DWN'], corePct: 0, warmupDays: 65, ...over,
});

describe('normalizeConfig', () => {
  it('applies armed-shape defaults and clamps', () => {
    const c = normalizeConfig({});
    expect(c.kind).toBe('rotation');
    expect(c.posture).toBe('active');
    expect(c.rank).toBe('gravity');
    expect(c.topN).toBe(12);
    expect(c.coreSymbol).toBe('SPY');
    expect(c.takeProfitPct).toBeNull();
    expect(c.warmupDays).toBeGreaterThanOrEqual(61);
    const clamped = normalizeConfig({ corePct: 400, topN: 9999, cadenceDays: -5 });
    expect(clamped.corePct).toBe(90);
    expect(clamped.topN).toBe(64);
    expect(clamped.cadenceDays).toBe(1);
  });

  it('rejects a universe with no valid tickers, uppercases valid ones', () => {
    expect(() => normalizeConfig({ universe: ['!!', '123456789'] })).toThrow(/universe/);
    expect(normalizeConfig({ universe: ['aapl', 'msft '] }).universe).toEqual(['AAPL', 'MSFT']);
  });

  it('take-profit override flows into the effective policy', () => {
    const cfg = normalizeConfig({ posture: 'active', takeProfitPct: 25 });
    expect(policyFor(cfg).takeProfitPct).toBe(25);
    expect(policyFor(normalizeConfig({ posture: 'active' })).takeProfitPct).toBe(8);
  });
});

describe('metricsFor', () => {
  it('computes return / CAGR / win rate / SPY alpha from a curve', () => {
    const curve: EquityPoint[] = Array.from({ length: 253 }, (_, i) => ({
      d: `2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      e: LAB_START_CASH * (1 + 0.10 * (i / 252)),
      s: LAB_START_CASH * (1 + 0.05 * (i / 252)),
    }));
    const st = freshState(); st.wins = 6; st.losses = 4; st.trades = 10; st.maxDD = 0.03;
    const m = metricsFor(curve, st);
    expect(m.totalReturnPct).toBeCloseTo(10, 0);
    expect(m.cagrPct).toBeGreaterThan(9);
    expect(m.spyReturnPct).toBeCloseTo(5, 0);
    expect(m.alphaVsSpyPct).toBeCloseTo(5, 0);
    expect(m.winRatePct).toBe(60);
    expect(m.maxDrawdownPct).toBe(3);
    expect(m.sharpe).toBeGreaterThan(0);
  });
});

describe('rotation walk (stepDay on synthetic bars)', () => {
  it('buys the momentum leader, never NaN-poisons, and tracks equity through a rising tape', () => {
    const a = makeAligned(90, { UPP: 0.004, DWN: -0.003 });
    const cfg = rotationCfg();
    const state = freshState(a.dates[64]);
    let equity = 0;
    for (let t = 65; t < 90; t++) equity = stepDay(a, cfg, policyFor(cfg), state, t);
    expect(Number.isFinite(equity)).toBe(true);
    expect(Number.isFinite(state.cash)).toBe(true);
    expect(Object.keys(state.lots)).toEqual(['UPP']); // top-1 momentum = the up-drifting name
    expect(equity).toBeGreaterThan(LAB_START_CASH * 0.99);
    expect(state.lastDate).toBe(a.dates[89]);
    expect(state.barCount).toBe(25);
  });

  it('protective stop sells a crashed holding and the state stays resumable', () => {
    const a = makeAligned(90, { UPP: 0.004, DWN: -0.003 });
    // Crash UPP 12% on session 80 — the active posture's 5% stop must fire that day.
    const upp = a.series.get('UPP')!;
    for (let i = 80; i < 90; i++) upp.closes[i] = upp.closes[79] * 0.88;
    const cfg = rotationCfg({ cadenceDays: 63 }); // rotate once, then exits only
    const state = freshState(a.dates[64]);
    for (let t = 65; t <= 80; t++) stepDay(a, cfg, policyFor(cfg), state, t);
    expect(state.lots.UPP).toBeUndefined();
    expect(state.losses).toBeGreaterThanOrEqual(1);
    expect(state.maxDD).toBeGreaterThan(0);
    // Resume from persisted state (JSON round-trip) — the walk continues without error.
    const resumed = JSON.parse(JSON.stringify(state)) as WalkState;
    for (let t = 81; t < 90; t++) expect(() => stepDay(a, cfg, policyFor(cfg), resumed, t)).not.toThrow();
    expect(resumed.lastDate).toBe(a.dates[89]);
  });

  it('core sleeve is bought once and never rotated', () => {
    const a = makeAligned(90, { UPP: 0.004, DWN: -0.003, SPY: 0.001 });
    const cfg = rotationCfg({ corePct: 50, coreSymbol: 'SPY', universe: ['UPP', 'DWN'] });
    const state = freshState(a.dates[64]);
    const corePx = a.series.get('SPY')!.closes[65];
    state.coreQty = Math.floor((0.5 * LAB_START_CASH) / corePx);
    state.cash -= state.coreQty * corePx;
    const coreQty = state.coreQty;
    for (let t = 65; t < 90; t++) stepDay(a, cfg, policyFor(cfg), state, t);
    expect(state.coreQty).toBe(coreQty);
    expect(state.lots.SPY).toBeUndefined(); // core symbol excluded from rotation targets
  });
});

describe('ADR-052 addendum knobs — marketGapFilterPct and exitPlanSessions', () => {
  /** SPY's opens = its prior close (no gap), except where `gaps` says (calendar index → percent). */
  const withOpens = (a: ReturnType<typeof makeAligned>, gaps: Record<number, number> = {}) => ({
    ...a, spyOpen: a.spy.map((c, i) => (i === 0 ? c : a.spy[i - 1] * (1 + (gaps[i] ?? 0) / 100))),
  });

  it('normalizeConfig keeps an absent knob null (inherit) and clamps a set one', () => {
    const c = normalizeConfig({});
    expect(c.marketGapFilterPct).toBeNull();
    expect(c.exitPlanSessions).toBeNull();
    const set = normalizeConfig({ marketGapFilterPct: 400, exitPlanSessions: 7.6 });
    expect(set.marketGapFilterPct).toBe(50);
    expect(set.exitPlanSessions).toBe(8);
    expect(normalizeConfig({ marketGapFilterPct: 0, exitPlanSessions: 0 })).toMatchObject({ marketGapFilterPct: 0, exitPlanSessions: 0 });
    expect(normalizeConfig({ marketGapFilterPct: 'junk', exitPlanSessions: 9999 })).toMatchObject({ marketGapFilterPct: null, exitPlanSessions: 252 });
  });

  it('an UNARMED walk writes no new field — every existing run replays unchanged', () => {
    const a = withOpens(makeAligned(90, { UPP: 0.004, DWN: -0.003 }), { 66: -5 });
    const state = freshState(a.dates[64]);
    for (let t = 65; t < 90; t++) stepDay(a, rotationCfg(), policyFor(rotationCfg()), state, t);
    expect(Object.keys(state).sort()).toEqual(Object.keys(freshState()).sort());
    expect(Object.keys(state.lots.UPP).sort()).toEqual(['entry', 'peak', 'qty']);
  });

  it('holds a rotation rebalance on a gapped-down open and runs it on the next unheld session', () => {
    const a = withOpens(makeAligned(90, { UPP: 0.004, DWN: -0.003 }), { 65: -1.5 });
    const cfg = rotationCfg({ marketGapFilterPct: 1 });
    const state = freshState(a.dates[64]);
    stepDay(a, cfg, policyFor(cfg), state, 65);
    expect(state.lots).toEqual({});                // nothing bought into the gap
    expect(state.rebalanceDue).toBe(true);         // ...and the slot is kept, not burned
    expect(state.gapHeldSessions).toBe(1);
    stepDay(a, cfg, policyFor(cfg), state, 66);
    expect(Object.keys(state.lots)).toEqual(['UPP']);
    expect(state.rebalanceDue).toBeUndefined();
    // The gate-off twin bought on the gapped session itself.
    const twin = freshState(a.dates[64]);
    stepDay(a, rotationCfg({ marketGapFilterPct: 0 }), policyFor(cfg), twin, 65);
    expect(Object.keys(twin.lots)).toEqual(['UPP']);
  });

  it('a smaller dip does not hold, and a walk with no SPY opens fails OPEN', () => {
    const cfg = rotationCfg({ marketGapFilterPct: 1 });
    const a = makeAligned(90, { UPP: 0.004, DWN: -0.003 });
    expect(sessionGapHeld(withOpens(a, { 65: -0.5 }), cfg, 65)).toBe(false);
    expect(sessionGapHeld(withOpens(a, { 65: -1 }), cfg, 65)).toBe(true);
    expect(sessionGapHeld(a, cfg, 65)).toBe(false); // attachSpyOpens failed → no opens → unheld
    const state = freshState(a.dates[64]);
    stepDay(a, cfg, policyFor(cfg), state, 65);
    expect(Object.keys(state.lots)).toEqual(['UPP']);
  });

  it('holds the ensemble scan BUYS on a gapped session (its sells still run)', () => {
    const a = withOpens(makeAligned(300, { UPP: 0.004, DWN: -0.003 }), { 250: -3 });
    const ens = (knob: number) => normalizeConfig({ kind: 'ensemble', posture: 'active', universe: ['UPP', 'DWN'], warmupDays: 65, marketGapFilterPct: knob });
    const held = freshState(a.dates[249]);
    const twin = freshState(a.dates[249]);
    stepDay(a, ens(1), policyFor(ens(1)), held, 250);
    stepDay(a, ens(0), policyFor(ens(0)), twin, 250);
    expect(Object.keys(twin.lots).length, 'the twin must actually buy for the hold to mean anything').toBeGreaterThan(0);
    expect(held.lots).toEqual({});
    expect(held.gapHeldSessions).toBe(1);
  });

  it('a lot nothing re-underwrites leaves on the plan clock; a rotation re-selection resets it', () => {
    const a = makeAligned(90, { UPP: 0.004, DWN: -0.003 });
    const once = rotationCfg({ cadenceDays: 63, exitPlanSessions: 3 }); // rebalance once, then exits only
    const s1 = freshState(a.dates[64]);
    for (let t = 65; t <= 67; t++) stepDay(a, once, policyFor(once), s1, t);
    expect(s1.lots.UPP).toMatchObject({ planBar: 0 });
    stepDay(a, once, policyFor(once), s1, 68);    // barCount 3 − planBar 0 ≥ 3 → the clock fires
    expect(s1.lots.UPP).toBeUndefined();
    expect(s1.planExpiries).toBe(1);
    // Plans off: the same walk still holds UPP.
    const off = rotationCfg({ cadenceDays: 63, exitPlanSessions: 0 });
    const s0 = freshState(a.dates[64]);
    for (let t = 65; t <= 68; t++) stepDay(a, off, policyFor(off), s0, t);
    expect(s0.lots.UPP).toBeDefined();
    // A daily rotation re-selects UPP every session: re-underwritten each time, it never expires.
    const daily = rotationCfg({ cadenceDays: 1, exitPlanSessions: 3 });
    const s2 = freshState(a.dates[64]);
    for (let t = 65; t < 80; t++) stepDay(a, daily, policyFor(daily), s2, t);
    expect(s2.lots.UPP).toMatchObject({ planBar: 14 });
    expect(s2.planExpiries).toBeUndefined();
  });

  it('blends zero both knobs rather than silently ignoring them', () => {
    const part = blendPartConfig({ name: 'x', weightPct: 50, config: rotationCfg({ marketGapFilterPct: 2, exitPlanSessions: 5 }) });
    expect(part).toMatchObject({ marketGapFilterPct: 0, exitPlanSessions: 0, earningsGateDays: 0, corePct: 0 });
  });
});
