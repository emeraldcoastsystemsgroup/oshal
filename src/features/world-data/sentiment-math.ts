/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the bias-aware sentiment MATH from the DB method so it is unit-testable (pure, no pg)
 */

/**
 * The bias-aware sentiment aggregation — PURE (no DB, no I/O). The World-Intelligence service queries
 * `world_metrics` for per-source averages and hands the raw rows here; this turns them into the
 * structured, bias-contextualized read a naive average destroys. Pure so the math (the actual product)
 * is unit-testable without a database or LLM. See [[world-intelligence-framework-app]] / ADR-061.
 */
import { ratingOf, leanBucket, econBucket } from './outlet-ratings';

/** One per-source row as returned by the metrics query (source id + count + average sentiment). */
export interface SentimentRow { source: string; points: number; avg: number; }

export type Consensus = 'agree' | 'mixed' | 'divergent' | 'insufficient';

export interface PerSource {
  source: string; outlet: string; kind: string;
  lean: number | null; bias: string; econLean: number | null; econBias: string;
  reliability: number | null; points: number; value: number;
}

export interface SentimentBreakdown {
  naive: number | null;
  reliabilityWeighted: number | null;
  political: { balanced: number | null; byLean: Record<'left' | 'center' | 'right', number | null>; spread: number; consensus: Consensus };
  econ: { balanced: number | null; byEcon: Record<'pro-labor' | 'neutral' | 'pro-market', number | null>; spread: number; consensus: Consensus };
  byKind: Record<string, { value: number | null; n: number }>;
  // Back-compat top-level political fields (pre-econ-axis callers).
  balanced: number | null; byLean: Record<'left' | 'center' | 'right', number | null>; spread: number; consensus: Consensus;
  bySource: PerSource[];
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null): number | null => (x != null ? Number(x.toFixed(3)) : null);
/** Spread → consensus: tight agreement, mixed, or genuinely divergent across buckets. */
export const consensusOf = (spread: number): Exclude<Consensus, 'insufficient'> =>
  (spread < 0.3 ? 'agree' : spread < 0.7 ? 'mixed' : 'divergent');

/** Map a raw metric row to a bias-rated per-source entry (rating lookup is pure). */
export function toPerSource(row: SentimentRow): PerSource {
  const rating = ratingOf(String(row.source));
  return {
    source: row.source,
    outlet: rating?.name ?? row.source,
    kind: rating?.kind ?? 'unknown',
    lean: rating?.lean ?? null,
    bias: rating ? leanBucket(rating.lean) : 'unknown',
    econLean: rating?.econLean ?? null,
    econBias: rating ? econBucket(rating.econLean) : 'unknown',
    reliability: rating?.reliability ?? null,
    points: row.points,
    value: Number(row.avg),
  };
}

/**
 * Turn per-source averages into the full bias-aware breakdown. The point: a `naive` average is
 * misleading; `byLean`/`byEcon` (mean of bucket means) stop one lean dominating by volume,
 * `reliabilityWeighted` trusts factual sources, `consensus` says whether the buckets actually AGREE,
 * and `byKind` separates the financial press from the wires from partisan media.
 */
export function computeSentimentBreakdown(rows: SentimentRow[]): SentimentBreakdown {
  const bySource = rows.map(toPerSource);

  const pol: Record<'left' | 'center' | 'right', number[]> = { left: [], center: [], right: [] };
  const eco: Record<'pro-labor' | 'neutral' | 'pro-market', number[]> = { 'pro-labor': [], neutral: [], 'pro-market': [] };
  const kindBuckets: Record<string, number[]> = {};
  let wSum = 0, wTot = 0, naiveSum = 0, naiveN = 0;
  for (const s of bySource) {
    naiveSum += s.value; naiveN += 1;
    if (s.bias === 'left' || s.bias === 'center' || s.bias === 'right') pol[s.bias].push(s.value);
    if (s.econBias === 'pro-labor' || s.econBias === 'neutral' || s.econBias === 'pro-market') eco[s.econBias].push(s.value);
    if (s.kind && s.kind !== 'unknown') (kindBuckets[s.kind] ??= []).push(s.value);
    if (s.reliability != null) { wSum += s.value * s.reliability; wTot += s.reliability; }
  }

  const byLean = { left: mean(pol.left), center: mean(pol.center), right: mean(pol.right) };
  const leanMeans = [byLean.left, byLean.center, byLean.right].filter((x): x is number => x != null);
  const balanced = leanMeans.length ? leanMeans.reduce((a, b) => a + b, 0) / leanMeans.length : null;
  const spread = leanMeans.length > 1 ? Math.max(...leanMeans) - Math.min(...leanMeans) : 0;
  const consensus: Consensus = leanMeans.length > 1 ? consensusOf(spread) : 'insufficient';

  const byEcon = { 'pro-labor': mean(eco['pro-labor']), neutral: mean(eco.neutral), 'pro-market': mean(eco['pro-market']) };
  const econMeans = [byEcon['pro-labor'], byEcon.neutral, byEcon['pro-market']].filter((x): x is number => x != null);
  const econBalanced = econMeans.length ? econMeans.reduce((a, b) => a + b, 0) / econMeans.length : null;
  const econSpread = econMeans.length > 1 ? Math.max(...econMeans) - Math.min(...econMeans) : 0;
  const econConsensus: Consensus = econMeans.length > 1 ? consensusOf(econSpread) : 'insufficient';

  const byKind: Record<string, { value: number | null; n: number }> = {};
  for (const [k, xs] of Object.entries(kindBuckets)) byKind[k] = { value: round(mean(xs)), n: xs.length };

  return {
    naive: naiveN ? Number((naiveSum / naiveN).toFixed(3)) : null,
    reliabilityWeighted: wTot ? Number((wSum / wTot).toFixed(3)) : null,
    political: { balanced: round(balanced), byLean, spread: Number(spread.toFixed(3)), consensus },
    econ: { balanced: round(econBalanced), byEcon, spread: Number(econSpread.toFixed(3)), consensus: econConsensus },
    byKind,
    balanced: round(balanced), byLean, spread: Number(spread.toFixed(3)), consensus,
    bySource,
  };
}
