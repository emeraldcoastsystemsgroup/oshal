/**
 * Blend planning (ADR-095 round 2) — the PURE math for running several rotation strategies at
 * once ("30% into this one, 20% into that one"). The live dispatch executes what this module
 * plans; the lab sim walks components as independent sub-books. Keeping the planner pure (no
 * I/O, no imports from the dispatch/sim layers beyond types) makes the money math unit-testable
 * and breaks what would otherwise be an import cycle (blend → sim → dispatch → blend).
 *
 * Live semantics: each component ranks ITS universe with ITS rank/topN/weighting and claims its
 * weight-share of the sleeve budget; per-name goals are capped by the COMPONENT's posture
 * (per-name % of the component's own budget — tighter than book-wide, the safe direction);
 * overlapping picks MERGE by summing goals — economically the netting of the sim's independent
 * sub-books. Book-level exits use the most-conservative component policy (tightest stop,
 * earliest take-profit).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — blendUnionUniverse, conservativeBlendPolicy, and blendRotationPlan (per-component rank → weight-share budgets → per-component caps → merged per-symbol goals).
 *
 * @module trading-blend
 */

import { DEFAULT_UNIVERSE, RISK_POLICIES } from '@/features/trading';
import type { RiskPolicy } from '@/features/trading';
import type { BlendComponent } from './trading-strategy-lab-sim';

/** A component's effective policy: its posture dials with its own take-profit override. */
function componentPolicy(c: BlendComponent): RiskPolicy {
  const base = RISK_POLICIES[c.config.posture] ?? RISK_POLICIES.balanced;
  return c.config.takeProfitPct != null ? { ...base, takeProfitPct: c.config.takeProfitPct } : base;
}

/**
 * @description The most-conservative composite policy across a blend's components — tightest
 * stop-loss wins the posture dials, earliest (smallest) take-profit wins the tp. Book-level
 * consumers (live protective exits, the equity guard) use this so no component's risk budget is
 * ever exceeded by a book-wide rule.
 * @param components - The blend's components.
 * @returns The composite risk policy.
 */
export function conservativeBlendPolicy(components: BlendComponent[]): RiskPolicy {
  const policies = components.map(componentPolicy);
  const tightest = policies.reduce((a, b) => (b.stopLossPct < a.stopLossPct ? b : a));
  return { ...tightest, takeProfitPct: Math.min(...policies.map((p) => p.takeProfitPct)) };
}

/**
 * @description The union of the components' resolved universes — what the live dispatch scans
 * (breakdown exits need bars for every name any component might hold).
 * @param components - The blend's components.
 * @param fallback - The default universe an empty component universe resolves to.
 * @returns Upper-cased de-duplicated symbol list.
 */
export function blendUnionUniverse(components: BlendComponent[], fallback: readonly string[] = DEFAULT_UNIVERSE): string[] {
  return [...new Set(components.flatMap((c) => (c.config.universe.length ? c.config.universe : [...fallback])).map((s) => s.toUpperCase()))];
}

/** One merged target: the summed dollar goal and the strongest contributing score (buy ordering). */
export interface BlendPlanEntry { goal: number; score: number }

/** The plan the dispatch executes: per-symbol merged goals + the union target set. */
export interface BlendPlan { goals: Map<string, BlendPlanEntry>; targetSet: Set<string> }

/**
 * @description Plans one blend rotation: each component ranks its own universe, takes its top-N
 * positive-score names, sizes per-name goals inside its weight-share of the sleeve budget — capped
 * per name at ITS posture's book-level per-name % (mirroring rotateSleeve) — and the per-symbol
 * goals merge by summation, with the MERGED goal capped at the most-conservative component's
 * book-level per-name cap so the buy path never fights the cap-breach trims the book-level
 * (conservative) policy enforces every fire.
 * @param components - The blend's components (weights need not sum to 100 — the remainder is core).
 * @param sleeveBudget - Dollars the whole blend sleeve may deploy (already applyPct-scaled by core).
 * @param equity - Book equity (the base every per-name cap is a percent of, as in rotateSleeve).
 * @param bars - Daily closes for the UNION universe (a component reads only its own slice).
 * @param coreSet - Core symbols (never rotation targets).
 * @param blocked - Operator blocklist (never targets).
 * @param rank - The production rank function (rankUniverse), injected to keep this module pure.
 * @returns Merged per-symbol goals and the target set.
 */
export function blendRotationPlan(
  components: BlendComponent[],
  sleeveBudget: number,
  equity: number,
  bars: Map<string, number[]>,
  coreSet: Set<string>,
  blocked: Set<string>,
  rank: (rankName: string, bars: Map<string, number[]>, coreSet: Set<string>) => Array<{ sym: string; score: number }>,
): BlendPlan {
  const goals = new Map<string, BlendPlanEntry>();
  const totalWeight = components.reduce((s, c) => s + c.weightPct, 0);
  if (totalWeight <= 0 || sleeveBudget <= 0 || equity <= 0) return { goals, targetSet: new Set() };

  for (const c of components) {
    const budget = (c.weightPct / totalWeight) * sleeveBudget;
    const universe = new Set((c.config.universe.length ? c.config.universe : [...DEFAULT_UNIVERSE]).map((s) => s.toUpperCase()));
    const slice = new Map<string, number[]>();
    for (const [sym, closes] of bars) {
      if (universe.has(sym.toUpperCase()) && closes.length >= 60) slice.set(sym, closes);
    }
    const ranked = rank(c.config.rank, slice, coreSet).sort((x, y) => y.score - x.score);
    const target = ranked.filter((r) => r.score > 0 && !blocked.has(r.sym)).slice(0, c.config.topN);
    if (!target.length) continue;
    const policy = componentPolicy(c);
    const perName = (policy.maxPerNamePct / 100) * equity; // book-level cap, as in rotateSleeve
    const scoreSum = target.reduce((s, r) => s + Math.max(0, r.score), 0);
    for (const r of target) {
      const goal = c.config.weighting === 'conviction' && scoreSum > 0
        ? Math.min(perName, (Math.max(0, r.score) / scoreSum) * budget)
        : Math.min(perName, budget / Math.max(1, c.config.topN));
      if (goal <= 0) continue;
      const prev = goals.get(r.sym);
      goals.set(r.sym, { goal: (prev?.goal ?? 0) + goal, score: Math.max(prev?.score ?? -Infinity, r.score) });
    }
  }
  // The book-level cap-breach trims run with the CONSERVATIVE policy — cap merged goals to match,
  // or an overlapping name would be bought past the cap and trimmed right back next fire.
  const mergedCap = (conservativeBlendPolicy(components).maxPerNamePct / 100) * equity;
  for (const [sym, g] of goals) if (g.goal > mergedCap) goals.set(sym, { ...g, goal: mergedCap });
  return { goals, targetSet: new Set(goals.keys()) };
}
