/**
 * Price→outcome calibration — the empirical backbone of the bet evaluator.
 *
 * From settled-market history we learn what a YES price of p ACTUALLY settled at, per category
 * and time-to-close horizon. Prediction markets carry a documented favorite-longshot bias
 * (longshots overpriced, heavy favorites underpriced); this module measures it on Kalshi's own
 * tape instead of assuming it. Lookups shrink the empirical rate toward the market price with a
 * beta prior (k pseudo-observations), so thin buckets defer to the market and only well-sampled
 * deviations produce edge.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — bucket builder over CalibrationSamples, beta-shrunk lookup (category with pooled '*' fallback), table (de)serialization for config-seed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Contradiction guard from the 4-skeptic adversarial review: pooled fallback may never manufacture edge in a category whose own bucket (n>=12) disagrees in sign — Sports (the fillable category) showed NO favorite edge while the pooled cell did.
 *
 * @module prediction-markets/calibration
 */

import type { CalibrationBucket, CalibrationSample, CalibrationTable } from '../types';

/** Bucket edges in dollars — finer at the extremes where the longshot bias lives. */
export const BUCKET_EDGES = [0, 0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.94, 0.97, 1.0000001];

/** Pseudo-observations for beta shrinkage toward the market price. */
const SHRINK_K = Number(process.env.KALSHI_CALIB_SHRINK_K) || 25;

function emptyBuckets(): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
    out.push({ lo: BUCKET_EDGES[i], hi: BUCKET_EDGES[i + 1], n: 0, avgPrice: 0, yesRate: 0 });
  }
  return out;
}

function bucketIndex(price: number): number {
  for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
    if (price >= BUCKET_EDGES[i] && price < BUCKET_EDGES[i + 1]) return i;
  }
  return -1;
}

function aggregate(samples: CalibrationSample[]): CalibrationBucket[] {
  const buckets = emptyBuckets();
  const sums = buckets.map(() => ({ price: 0, yes: 0 }));
  for (const s of samples) {
    const i = bucketIndex(s.price);
    if (i < 0) continue;
    buckets[i].n += 1;
    sums[i].price += s.price;
    if (s.settledYes) sums[i].yes += 1;
  }
  buckets.forEach((b, i) => {
    if (b.n > 0) {
      b.avgPrice = sums[i].price / b.n;
      b.yesRate = sums[i].yes / b.n;
    }
  });
  return buckets;
}

/**
 * @description Build the full calibration table from settled-market samples: per horizon, one
 * bucket set per category plus a pooled '*' set (the fallback for categories with thin history).
 * @param samples - (price, outcome) observations from settled markets.
 * @returns The table, ready to serialize into config-seed and the evidence doc.
 */
export function buildCalibrationTable(samples: CalibrationSample[]): CalibrationTable {
  const horizons: CalibrationTable['horizons'] = {};
  const sampleCounts: Record<string, number> = {};
  for (const s of samples) sampleCounts[s.category] = (sampleCounts[s.category] || 0) + 1;
  const byHorizon = new Map<number, CalibrationSample[]>();
  for (const s of samples) {
    const list = byHorizon.get(s.horizonHours) || [];
    list.push(s);
    byHorizon.set(s.horizonHours, list);
  }
  for (const [h, hs] of byHorizon) {
    const cats: Record<string, CalibrationBucket[]> = { '*': aggregate(hs) };
    const byCat = new Map<string, CalibrationSample[]>();
    for (const s of hs) {
      const list = byCat.get(s.category) || [];
      list.push(s);
      byCat.set(s.category, list);
    }
    for (const [cat, cs] of byCat) cats[cat] = aggregate(cs);
    horizons[String(h)] = cats;
  }
  return { generatedAt: new Date().toISOString(), sampleCounts, horizons };
}

/** A calibration lookup result: shrunk probability + the evidence behind it. */
export interface CalibratedProb {
  /** Beta-shrunk P(settle YES) for a contract priced at `price`. */
  prob: number;
  /** Raw observations in the bucket that produced it. */
  n: number;
  /** Confidence 0..1 = n/(n+k) — how much the estimate departs from the market's own price. */
  confidence: number;
}

/**
 * @description Look up the calibrated true probability for a YES price. Prefers the category's
 * own buckets, falls back to the pooled '*' set when the category bucket has fewer than
 * `minCategoryN` observations. The empirical rate is shrunk toward the price itself:
 * p̂ = (yes + k·price)/(n + k) — no history ⇒ p̂ = price ⇒ zero edge, by construction.
 * @param table - Calibration table.
 * @param horizonHours - Which horizon's buckets to use.
 * @param category - Kalshi series category.
 * @param price - YES price in dollars.
 * @param minCategoryN - Minimum in-category bucket size before pooling kicks in.
 * @returns Shrunk probability + sample evidence.
 */
export function calibratedProb(
  table: CalibrationTable, horizonHours: number, category: string, price: number, minCategoryN = 40,
): CalibratedProb {
  const cats = table.horizons[String(horizonHours)];
  if (!cats) return { prob: price, n: 0, confidence: 0 };
  const i = bucketIndex(price);
  if (i < 0) return { prob: price, n: 0, confidence: 0 };
  const catBucket = cats[category]?.[i];
  const pooled = cats['*']?.[i];
  const b = catBucket && catBucket.n >= minCategoryN ? catBucket : pooled;
  if (!b || b.n === 0) return { prob: price, n: 0, confidence: 0 };
  const prob = (b.yesRate * b.n + SHRINK_K * price) / (b.n + SHRINK_K);
  // Contradiction guard (2026-07-13 adversarial review): when the POOLED bucket is driving the
  // estimate but the category's own tape — even a thin one — points the OTHER way, do not
  // transplant edge into the category (Sports showed no favorite edge while the pooled cell did).
  if (b === pooled && catBucket && catBucket.n >= 12) {
    const catProb = (catBucket.yesRate * catBucket.n + SHRINK_K * price) / (catBucket.n + SHRINK_K);
    if (Math.sign(catProb - price) !== Math.sign(prob - price)) return { prob: price, n: catBucket.n, confidence: 0 };
  }
  return { prob, n: b.n, confidence: b.n / (b.n + SHRINK_K) };
}
