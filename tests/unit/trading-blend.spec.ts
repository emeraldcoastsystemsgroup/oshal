/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-095 round-2 blend math: normalizeBlend validation/derivation, conservative composite policy, union universe, and blendRotationPlan (weight-share budgets, per-component caps + ranks, merged-goal summation with the conservative book cap, blocklist + negative-score exclusion).
 */
import { describe, it, expect } from 'vitest';
import { blendRotationPlan, blendUnionUniverse, conservativeBlendPolicy } from '../../src/app/trading-blend';
import { normalizeConfig, policyFor, snapshotConfig, type BlendComponent, type StrategyConfig } from '../../src/app/trading-strategy-lab-sim';
import { DEFAULT_UNIVERSE, RISK_POLICIES } from '../../src/features/trading';

const rotation = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  kind: 'rotation', posture: 'active', corePct: 0, coreSymbol: 'SPY', takeProfitPct: null,
  rank: 'gravity', cadenceDays: 1, topN: 12, weighting: 'conviction', universe: [],
  warmupDays: 80, windowDays: 780, ...over,
});
const comp = (name: string, weightPct: number, over: Partial<StrategyConfig> = {}): BlendComponent =>
  ({ name, weightPct, config: rotation(over) });

describe('normalizeConfig kind=blend', () => {
  it('derives corePct as the unallocated remainder and cadence/warmup from components', () => {
    const c = normalizeConfig({
      kind: 'blend',
      components: [
        { name: 'A', weightPct: 30, config: rotation({ cadenceDays: 1, warmupDays: 80 }) },
        { name: 'B', weightPct: 20, config: rotation({ rank: 'momentum', cadenceDays: 5, warmupDays: 120 }) },
      ],
    });
    expect(c.kind).toBe('blend');
    expect(c.corePct).toBe(50);
    expect(c.cadenceDays).toBe(1);   // min component cadence gates the live rotation
    expect(c.warmupDays).toBe(120);  // max component warmup
    expect(c.components?.length).toBe(2);
  });
  it('rejects non-rotation components, nested blends, bad weights, and >100% totals', () => {
    const A = rotation();
    expect(() => normalizeConfig({ kind: 'blend', components: [{ name: 'A', weightPct: 50, config: A }] })).toThrow(/2–6/);
    expect(() => normalizeConfig({ kind: 'blend', components: [
      { name: 'A', weightPct: 50, config: A }, { name: 'B', weightPct: 30, config: { ...A, kind: 'ensemble' } },
    ] })).toThrow(/rotation/);
    expect(() => normalizeConfig({ kind: 'blend', components: [
      { name: 'A', weightPct: 60, config: A }, { name: 'B', weightPct: 60, config: A },
    ] })).toThrow(/120/);
    expect(() => normalizeConfig({ kind: 'blend', components: [
      { name: 'A', weightPct: 50, config: A },
      { name: 'N', weightPct: 30, config: { kind: 'blend', components: [{ name: 'x', weightPct: 50, config: A }, { name: 'y', weightPct: 50, config: A }] } },
    ] })).toThrow(); // nested blend → not a rotation component (2–6 also fails inner alone)
  });
});

describe('conservativeBlendPolicy / policyFor(blend)', () => {
  it('takes the tightest stop posture and the earliest take-profit', () => {
    const p = conservativeBlendPolicy([
      comp('A', 30, { posture: 'active' }),                      // stop 5, tp 8
      comp('B', 20, { posture: 'aggressive', takeProfitPct: 6 }), // stop 15, tp override 6
    ]);
    expect(p.posture).toBe('active');
    expect(p.stopLossPct).toBe(RISK_POLICIES.active.stopLossPct);
    expect(p.takeProfitPct).toBe(6); // min(8, 6)
  });
  it('policyFor on a blend config matches the composite', () => {
    const cfg = normalizeConfig({ kind: 'blend', components: [
      { name: 'A', weightPct: 30, config: rotation({ posture: 'active' }) },
      { name: 'B', weightPct: 20, config: rotation({ posture: 'balanced' }) },
    ] });
    const p = policyFor(cfg);
    expect(p.posture).toBe('active');
    expect(p.takeProfitPct).toBe(Math.min(RISK_POLICIES.active.takeProfitPct, RISK_POLICIES.balanced.takeProfitPct));
  });
});

describe('blendUnionUniverse / snapshotConfig', () => {
  it('unions custom universes and resolves empties to the fallback', () => {
    const u = blendUnionUniverse([comp('A', 30, { universe: ['NVDA', 'MSFT'] }), comp('B', 20, { universe: ['msft', 'CORN'] })], ['SPY']);
    expect(u.sort()).toEqual(['CORN', 'MSFT', 'NVDA'].sort());
    const withDefault = blendUnionUniverse([comp('A', 30), comp('B', 20, { universe: ['CORN'] })]);
    expect(withDefault.length).toBe(new Set([...DEFAULT_UNIVERSE.map((s) => s.toUpperCase()), 'CORN']).size);
  });
  it('snapshotConfig pins each component universe for regression replay', () => {
    const cfg = normalizeConfig({ kind: 'blend', components: [
      { name: 'A', weightPct: 30, config: rotation() },
      { name: 'B', weightPct: 20, config: rotation({ universe: ['CORN'] }) },
    ] });
    const snap = snapshotConfig(cfg);
    expect(snap.components?.[0].config.universe.length).toBe(DEFAULT_UNIVERSE.length);
    expect(snap.components?.[1].config.universe).toEqual(['CORN']);
  });
});

describe('blendRotationPlan', () => {
  // 70 fake closes so every symbol clears the 60-bar eligibility gate.
  const closes = Array.from({ length: 70 }, (_, i) => 100 + i * 0.1);
  const bars = new Map<string, number[]>([['X', closes], ['Y', closes], ['Z', closes], ['W', closes]]);
  /** Fake rank: gravity likes X>Y>Z; momentum likes Y>W; Z is negative for momentum. */
  const rank = (rankName: string, slice: Map<string, number[]>): Array<{ sym: string; score: number }> => {
    const table: Record<string, Record<string, number>> = {
      gravity: { X: 3, Y: 2, Z: 1, W: 0.5 },
      momentum: { X: 0.5, Y: 4, Z: -1, W: 2 },
    };
    return [...slice.keys()].map((sym) => ({ sym: sym.toUpperCase(), score: table[rankName]?.[sym.toUpperCase()] ?? 0 }));
  };
  const A = comp('A', 30, { rank: 'gravity', topN: 2, weighting: 'equal', universe: ['X', 'Y', 'Z'], posture: 'aggressive' });  // 10%/name book cap
  const B = comp('B', 20, { rank: 'momentum', topN: 2, weighting: 'equal', universe: ['Y', 'W'], posture: 'aggressive' });

  it('splits the sleeve by weight share, ranks per component, merges overlapping goals', () => {
    // Equal 10/10 weights on a 20k sleeve (100k book): each component budget 10k, equal/top4 →
    // 2.5k per name — well under the aggressive 10% book cap, so goals stay uncapped and the
    // overlap (Y, picked by both) shows as a true SUM.
    const A4 = comp('A', 10, { rank: 'gravity', topN: 4, weighting: 'equal', universe: ['X', 'Y', 'Z'], posture: 'aggressive' });
    const B4 = comp('B', 10, { rank: 'momentum', topN: 4, weighting: 'equal', universe: ['Y', 'W'], posture: 'aggressive' });
    const plan = blendRotationPlan([A4, B4], 20_000, 100_000, bars, new Set(), new Set(), rank);
    expect([...plan.targetSet].sort()).toEqual(['W', 'X', 'Y', 'Z']); // A: X,Y,Z · B: Y,W
    expect(plan.goals.get('X')?.goal).toBe(2_500);                    // A only
    expect(plan.goals.get('W')?.goal).toBe(2_500);                    // B only
    expect(plan.goals.get('Y')?.goal).toBe(5_000);                    // merged: 2.5k (A) + 2.5k (B)
    expect(plan.goals.get('Y')?.score).toBe(4);                       // strongest contributing score (momentum's Y)
  });
  it('caps the MERGED goal at the conservative component book cap', () => {
    const tightB = comp('B', 20, { rank: 'momentum', topN: 2, weighting: 'equal', universe: ['Y', 'W'], posture: 'active' }); // 3%/name
    const plan = blendRotationPlan([A, tightB], 50_000, 100_000, bars, new Set(), new Set(), rank);
    // conservative (active) cap = 3% × 100k = 3k — merged Y must not exceed it
    expect(plan.goals.get('Y')?.goal).toBe(3_000);
    expect(plan.goals.get('X')?.goal).toBe(3_000); // A's own names also bounded by the merged cap
  });
  it('excludes blocked and negative-score names; empty inputs plan nothing', () => {
    const plan = blendRotationPlan([A, B], 50_000, 100_000, bars, new Set(), new Set(['X']), rank);
    expect(plan.targetSet.has('X')).toBe(false);
    expect(plan.targetSet.has('Z')).toBe(true); // gravity's #3 fills A's top-2 once X is blocked
    expect(blendRotationPlan([A, B], 0, 100_000, bars, new Set(), new Set(), rank).targetSet.size).toBe(0);
  });
});
