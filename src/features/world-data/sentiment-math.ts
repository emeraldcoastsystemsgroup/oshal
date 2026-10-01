/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract the bias-aware sentiment MATH from the DB method so it is unit-testable (pure, no pg)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Read sentiment through oshal's OWN observed outlet ratings instead of the deleted seed table (operator decision 2026-09-22). The political and economic axes and the outlet-kind breakdown are gone with the hand-typed numbers they were computed from; the lean axis now buckets each source by its observed lean (below / near / above the other sources), reliability-weighting uses observed reliability, and every per-source entry carries its rating with the counts and dates behind it. A source below the minimums is "insufficient" and joins no bucket and no weight. The top-level balanced/byLean/spread/consensus fields keep their names and now describe the lean axis, so the feature rollup reads them unchanged.
 */

/**
 * The bias-aware sentiment aggregation — PURE (no DB, no I/O). The World-Intelligence service queries
 * `world_metrics` for per-source averages and hands the raw rows here, together with the observed
 * outlet ratings (outlet-ratings.ts / outlet-observations.ts); this turns them into the structured read
 * a naive average destroys. See ADR-061.
 */
import { outletById, ratingFor, type LeanBucket, type ObservedOutletRating, type OutletRatingSet } from './outlet-ratings';

/** One per-source row as returned by the metrics query (source id + count + average sentiment). */
export interface SentimentRow { source: string; points: number; avg: number; }

export type Consensus = 'agree' | 'mixed' | 'divergent' | 'insufficient';

/** One source in a subject's breakdown, with the observed rating it was read through. */
export interface PerSource {
  source: string;
  /** Display name: the known publisher's name, else the source id. */
  outlet: string;
  /** Observed lean, or null when the source's rating is insufficient. */
  lean: number | null;
  /** below / near / above the other sources, or 'insufficient'. */
  bias: LeanBucket | 'insufficient';
  /** Observed reliability, or null when insufficient. */
  reliability: number | null;
  /** The full observed rating: status, counts and date range. */
  rating: ObservedOutletRating;
  points: number;
  value: number;
}

/** The lean-axis aggregate: bucket means, their mean, their spread and whether they agree. */
export interface LeanAxis {
  balanced: number | null;
  byLean: Record<LeanBucket, number | null>;
  spread: number;
  consensus: Consensus;
}

/** How the ratings behind a breakdown were computed, so the read states its own provenance. */
export interface RatingProvenance {
  method: string; windowDays: number; minComparisons: number; minSubjects: number; leanZ: number;
  computedAt: string; rated: number; insufficient: number;
}

export interface SentimentBreakdown extends LeanAxis {
  naive: number | null;
  reliabilityWeighted: number | null;
  lean: LeanAxis;
  bySource: PerSource[];
  ratings: RatingProvenance;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null): number | null => (x != null ? Number(x.toFixed(3)) : null);
/** Spread → consensus: tight agreement, mixed, or genuinely divergent across buckets. */
export const consensusOf = (spread: number): Exclude<Consensus, 'insufficient'> =>
  (spread < 0.3 ? 'agree' : spread < 0.7 ? 'mixed' : 'divergent');

/**
 * @description Map a raw metric row to a per-source entry read through its observed rating.
 * @param row - One per-source sentiment row.
 * @param ratings - The observed rating set.
 * @returns The per-source entry; an unrated source is 'insufficient', never guessed.
 */
export function toPerSource(row: SentimentRow, ratings: OutletRatingSet): PerSource {
  const rating = ratingFor(ratings, String(row.source));
  return {
    source: row.source,
    outlet: outletById(String(row.source))?.name ?? row.source,
    lean: rating.lean,
    bias: rating.leanBucket ?? 'insufficient',
    reliability: rating.reliability,
    rating,
    points: row.points,
    value: Number(row.avg),
  };
}

/** Bucket means → the lean axis (mean of bucket means, spread, consensus). */
function leanAxis(buckets: Record<LeanBucket, number[]>): LeanAxis {
  const byLean = { below: mean(buckets.below), near: mean(buckets.near), above: mean(buckets.above) };
  const means = [byLean.below, byLean.near, byLean.above].filter((x): x is number => x != null);
  const balanced = means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
  const spread = means.length > 1 ? Math.max(...means) - Math.min(...means) : 0;
  return {
    balanced: round(balanced), byLean, spread: Number(spread.toFixed(3)),
    consensus: means.length > 1 ? consensusOf(spread) : 'insufficient',
  };
}

/**
 * @description Turn per-source averages into the bias-aware breakdown. A naive average lets the
 * most prolific sources dominate; `lean.byLean` (mean of bucket means) stops one habitual slant
 * dominating by volume, `reliabilityWeighted` trusts the sources that track the others, and
 * `consensus` says whether sources that usually read below, near and above the others agree here.
 * @param rows - Per-source sentiment averages for one subject and window.
 * @param ratings - The observed outlet rating set.
 * @returns The breakdown, with each source's rating and the rating method.
 */
export function computeSentimentBreakdown(rows: SentimentRow[], ratings: OutletRatingSet): SentimentBreakdown {
  const bySource = rows.map((row) => toPerSource(row, ratings));
  const buckets: Record<LeanBucket, number[]> = { below: [], near: [], above: [] };
  let wSum = 0, wTot = 0, naiveSum = 0;
  for (const s of bySource) {
    naiveSum += s.value;
    if (s.bias !== 'insufficient') buckets[s.bias].push(s.value);
    if (s.reliability != null) { wSum += s.value * s.reliability; wTot += s.reliability; }
  }
  const lean = leanAxis(buckets);
  const rated = bySource.filter((s) => s.rating.status === 'rated').length;
  return {
    naive: bySource.length ? Number((naiveSum / bySource.length).toFixed(3)) : null,
    reliabilityWeighted: wTot ? Number((wSum / wTot).toFixed(3)) : null,
    lean,
    ...lean,
    bySource,
    ratings: {
      method: ratings.method, windowDays: ratings.windowDays, minComparisons: ratings.minComparisons,
      minSubjects: ratings.minSubjects, leanZ: ratings.leanZ, computedAt: ratings.computedAt,
      rated, insufficient: bySource.length - rated,
    },
  };
}
