/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the World-Intelligence deterministic core: bias-aware sentiment math, outlet ratings, feed utils (ADR-061).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The breakdown is read through oshal's own OBSERVED outlet ratings (the seed table is deleted): the lean axis buckets by observed lean, reliability-weighting uses observed reliability, an insufficient source joins no bucket and no weight and carries no number, and the rating method travels with the read.
 */

import { describe, it, expect } from 'vitest';
import { computeSentimentBreakdown, toPerSource, consensusOf, type SentimentRow } from '../../src/features/world-data/sentiment-math';
import { rateOutlets, type OutletDivergenceStats } from '../../src/features/world-data/outlet-ratings';
import { itemHash, slugifyEntity, pubIso, lexicon } from '../../src/features/world-data/feed-util';

/** Divergence statistics with every field explicit: lean = mean, sd and mean |d| as given. */
function stats(source: string, comparisons: number, subjects: number, mean: number, sd: number, abs: number): OutletDivergenceStats {
  return {
    source, comparisons, subjects, observations: comparisons * 2, firstDay: '2026-07-01', lastDay: '2026-09-30',
    meanDivergence: mean, sdDivergence: sd, meanAbsDivergence: abs,
  };
}

// Observed ratings for a synthetic set (40 comparisons, sd 0.2 -> 2 standard errors = 0.063):
//  fox      mean -0.30 -> below, reliability 1 - 0.35/2 = 0.825
//  cnn      mean +0.25 -> above, reliability 1 - 0.30/2 = 0.85
//  reuters  mean +0.01 -> near,  reliability 1 - 0.10/2 = 0.95
//  wsj      mean -0.02 -> near,  reliability 1 - 0.12/2 = 0.94
//  thin     5 comparisons over 2 subjects -> insufficient (minimums 20 / 3)
const RATINGS = rateOutlets([
  stats('world:outlet:foxnews', 40, 6, -0.3, 0.2, 0.35),
  stats('world:outlet:cnn', 40, 6, 0.25, 0.2, 0.3),
  stats('world:outlet:reuters', 40, 6, 0.01, 0.2, 0.1),
  stats('world:outlet:wsj', 40, 6, -0.02, 0.2, 0.12),
  stats('world:outlet:thin', 5, 2, 0.5, 0.1, 0.5),
], { windowDays: 90, minComparisons: 20, minSubjects: 3 }, '2026-10-01T00:00:00.000Z');

const ROWS: SentimentRow[] = [
  { source: 'world:outlet:foxnews', points: 6, avg: -0.4 },
  { source: 'world:outlet:cnn', points: 5, avg: 0.3 },
  { source: 'world:outlet:reuters', points: 4, avg: 0.1 },
  { source: 'world:outlet:wsj', points: 7, avg: 0.15 },
];

describe('toPerSource', () => {
  it('reads a source through its observed rating', () => {
    const fox = toPerSource(ROWS[0], RATINGS);
    expect(fox).toMatchObject({ outlet: 'Fox News', bias: 'below', lean: -0.3, reliability: 0.825, points: 6, value: -0.4 });
    expect(fox.rating).toMatchObject({ status: 'rated', comparisons: 40, subjects: 6, observations: 80, firstObserved: '2026-07-01', lastObserved: '2026-09-30' });
  });
  it('marks an insufficient source insufficient and carries no number', () => {
    const thin = toPerSource({ source: 'world:outlet:thin', points: 3, avg: 0.9 }, RATINGS);
    expect(thin).toMatchObject({ bias: 'insufficient', lean: null, reliability: null });
    expect(thin.rating).toMatchObject({ status: 'insufficient', comparisons: 5, subjects: 2 });
  });
  it('marks a never-compared source insufficient with zero counts, never a guessed number', () => {
    const u = toPerSource({ source: 'world:outlet:nobody', points: 1, avg: 0.9 }, RATINGS);
    expect(u).toMatchObject({ outlet: 'world:outlet:nobody', bias: 'insufficient', lean: null, reliability: null });
    expect(u.rating).toMatchObject({ status: 'insufficient', comparisons: 0, observations: 0, firstObserved: null, lastObserved: null });
  });
});

describe('computeSentimentBreakdown — read through observed ratings', () => {
  const b = computeSentimentBreakdown(ROWS, RATINGS);

  it('keeps a naive average but it is near-zero/misleading', () => {
    // (-0.4 + 0.3 + 0.1 + 0.15) / 4 = 0.0375
    expect(b.naive).toBeCloseTo(0.0375, 2);
  });
  it('splits the observed LEAN axis so one habitual slant cannot dominate by volume', () => {
    expect(b.lean.byLean.below).toBeCloseTo(-0.4, 5);  // fox
    expect(b.lean.byLean.near).toBeCloseTo(0.125, 5);  // mean(reuters .1, wsj .15)
    expect(b.lean.byLean.above).toBeCloseTo(0.3, 5);   // cnn
    expect(b.lean.balanced).toBeCloseTo(0.008, 3);     // (-0.4 + 0.125 + 0.3) / 3
  });
  it('flags the buckets as divergent at this spread', () => {
    expect(b.lean.spread).toBeCloseTo(0.7, 5);
    expect(b.lean.consensus).toBe('divergent');
  });
  it('weights by observed reliability', () => {
    // (-.4*.825 + .3*.85 + .1*.95 + .15*.94) / (.825 + .85 + .95 + .94) = 0.161 / 3.565
    expect(b.reliabilityWeighted).toBeCloseTo(0.045, 3);
  });
  it('keeps the top-level lean fields the feature rollup reads', () => {
    expect(b.balanced).toBe(b.lean.balanced);
    expect(b.consensus).toBe(b.lean.consensus);
    expect(b.byLean).toEqual(b.lean.byLean);
    expect(b.spread).toBe(b.lean.spread);
  });
  it('returns no seeded axes', () => {
    expect(b).not.toHaveProperty('political');
    expect(b).not.toHaveProperty('econ');
    expect(b).not.toHaveProperty('byKind');
  });
  it('states the rating method and how many sources it rated', () => {
    expect(b.ratings).toEqual({
      method: 'consensus-divergence-v1', windowDays: 90, minComparisons: 20, minSubjects: 3, leanZ: 2,
      computedAt: '2026-10-01T00:00:00.000Z', rated: 4, insufficient: 0,
    });
  });
  it('does not let an insufficient or never-compared source into a bucket or a weight', () => {
    const noisy = computeSentimentBreakdown([
      ...ROWS,
      { source: 'world:outlet:thin', points: 9, avg: 0.99 },
      { source: 'world:outlet:nobody', points: 1, avg: -0.99 },
    ], RATINGS);
    expect(noisy.lean.byLean).toEqual(b.lean.byLean);
    expect(noisy.reliabilityWeighted).toBe(b.reliabilityWeighted);
    expect(noisy.ratings).toMatchObject({ rated: 4, insufficient: 2 });
    expect(noisy.naive).not.toBe(b.naive); // the naive mean still counts them
  });
  it('handles the empty case without throwing', () => {
    const e = computeSentimentBreakdown([], RATINGS);
    expect(e.naive).toBeNull();
    expect(e.reliabilityWeighted).toBeNull();
    expect(e.lean.consensus).toBe('insufficient');
    expect(e.lean.byLean).toEqual({ below: null, near: null, above: null });
  });
  it('consensusOf thresholds', () => {
    expect(consensusOf(0.1)).toBe('agree');
    expect(consensusOf(0.5)).toBe('mixed');
    expect(consensusOf(0.9)).toBe('divergent');
  });
});

describe('feed-util', () => {
  const a = { outlet: 'Reuters', title: 'Fed holds rates', link: 'http://x/1' };
  it('itemHash is stable + per-entity (same article, two subjects = two hashes)', () => {
    expect(itemHash('world:topic:fed', a)).toBe(itemHash('world:topic:fed', a));
    expect(itemHash('world:topic:fed', a)).not.toBe(itemHash('world:topic:rates', a));
    expect(itemHash('world:topic:fed', a)).not.toBe(itemHash('world:topic:fed', { ...a, title: 'different' }));
  });
  it('slugifyEntity normalizes, caps, and rejects empties', () => {
    expect(slugifyEntity('Cooper Flagg!')).toBe('cooper-flagg');
    expect(slugifyEntity('  ---  ')).toBe('');
    expect(slugifyEntity('')).toBe('');
  });
  it('pubIso parses valid dates and rejects junk', () => {
    expect(pubIso('')).toBeNull();
    expect(pubIso('not a date')).toBeNull();
    expect(pubIso('2026-06-20T00:00:00Z')).toBe('2026-06-20T00:00:00.000Z');
  });
  it('lexicon falls back to a bounded [-1,1] signal', () => {
    expect(lexicon('surge record profit growth')).toBeGreaterThan(0);
    expect(lexicon('plunge lawsuit fraud layoff')).toBeLessThan(0);
    expect(lexicon('the quiet cat sat')).toBe(0);
    expect(lexicon('plunge crash fraud scandal probe')).toBeGreaterThanOrEqual(-1); // clamped
  });
});
