/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the World-Intelligence deterministic core: bias-aware sentiment math, outlet ratings, feed utils (ADR-061).
 */

import { describe, it, expect } from 'vitest';
import { computeSentimentBreakdown, toPerSource, consensusOf, type SentimentRow } from '../../src/features/world-data/sentiment-math';
import { ratingByName, leanBucket, econBucket } from '../../src/features/world-data/outlet-ratings';
import { itemHash, slugifyEntity, pubIso, lexicon } from '../../src/features/world-data/feed-util';

// A cross-spectrum set with KNOWN ratings (real outlet ids so ratingOf resolves):
//  fox      -> partisan, right, econ pro-market, rel 0.60
//  cnn      -> broadcast, left, econ pro-labor,  rel 0.72
//  reuters  -> wire, center, econ neutral,       rel 0.95
//  wsj      -> financial, center(lean .2), econ pro-market, rel 0.88
const ROWS: SentimentRow[] = [
  { source: 'world:outlet:foxnews', points: 6, avg: -0.4 },
  { source: 'world:outlet:cnn', points: 5, avg: 0.3 },
  { source: 'world:outlet:reuters', points: 4, avg: 0.1 },
  { source: 'world:outlet:wsj', points: 7, avg: 0.15 },
];

describe('outlet-ratings', () => {
  it('maps Google-News short names via aliases', () => {
    expect(ratingByName('AP News')?.id).toBe('world:outlet:ap');
    expect(ratingByName('WSJ')?.id).toBe('world:outlet:wsj');
    expect(ratingByName('Fox News')?.id).toBe('world:outlet:foxnews');
  });
  it('maps by substring when no alias', () => {
    expect(ratingByName('The New York Times')?.id).toBe('world:outlet:nyt');
  });
  it('returns undefined for an unrated outlet', () => {
    expect(ratingByName('Totally Unknown Blog')).toBeUndefined();
    expect(ratingByName('')).toBeUndefined();
  });
  it('buckets the political axis', () => {
    expect(leanBucket(-0.5)).toBe('left');
    expect(leanBucket(0)).toBe('center');
    expect(leanBucket(0.6)).toBe('right');
    expect(leanBucket(0.2)).toBe('center'); // WSJ sits center on the political axis
  });
  it('buckets the economic axis', () => {
    expect(econBucket(-0.3)).toBe('pro-labor');
    expect(econBucket(0)).toBe('neutral');
    expect(econBucket(0.5)).toBe('pro-market');
  });
});

describe('toPerSource', () => {
  it('enriches a row with both bias axes + kind', () => {
    const fox = toPerSource(ROWS[0]);
    expect(fox).toMatchObject({ outlet: 'Fox News', kind: 'partisan', bias: 'right', econBias: 'pro-market' });
    expect(fox.reliability).toBeGreaterThan(0);
  });
  it('marks an unrated source unknown without inventing ratings', () => {
    const u = toPerSource({ source: 'world:outlet:nobody', points: 1, avg: 0.9 });
    expect(u).toMatchObject({ kind: 'unknown', bias: 'unknown', econBias: 'unknown', lean: null, econLean: null, reliability: null });
  });
});

describe('computeSentimentBreakdown — the bias-aware product', () => {
  const b = computeSentimentBreakdown(ROWS);

  it('keeps a naive average but it is near-zero/misleading', () => {
    // (-0.4 + 0.3 + 0.1 + 0.15) / 4 = 0.0375
    expect(b.naive).toBeCloseTo(0.0375, 2);
  });
  it('splits the POLITICAL axis so one lean cannot dominate by volume', () => {
    expect(b.political.byLean.left).toBeCloseTo(0.3, 5);   // cnn
    expect(b.political.byLean.center).toBeCloseTo(0.125, 5); // mean(reuters .1, wsj .15)
    expect(b.political.byLean.right).toBeCloseTo(-0.4, 5);  // fox
    // right far below left → cross-spectrum disagreement
    expect(b.political.byLean.right!).toBeLessThan(b.political.byLean.left!);
  });
  it('flags political consensus as divergent at this spread', () => {
    expect(b.political.spread).toBeCloseTo(0.7, 5); // 0.3 - (-0.4)
    expect(b.political.consensus).toBe('divergent');
  });
  it('exposes the ECON axis the political axis misses (pro-market is the outlier)', () => {
    expect(b.econ.byEcon['pro-labor']).toBeCloseTo(0.3, 5);    // cnn
    expect(b.econ.byEcon.neutral).toBeCloseTo(0.1, 5);         // reuters
    expect(b.econ.byEcon['pro-market']).toBeCloseTo(-0.125, 5);// mean(fox -.4, wsj .15)
    expect(b.econ.byEcon['pro-market']!).toBeLessThan(b.econ.byEcon['pro-labor']!);
  });
  it('breaks down by outlet KIND', () => {
    expect(b.byKind.partisan).toEqual({ value: -0.4, n: 1 });
    expect(b.byKind.wire).toEqual({ value: 0.1, n: 1 });
    expect(b.byKind.financial).toEqual({ value: 0.15, n: 1 });
    expect(b.byKind.broadcast).toEqual({ value: 0.3, n: 1 });
  });
  it('reliability-weights toward the factual sources', () => {
    // (−.4*.6 + .3*.72 + .1*.95 + .15*.88) / (.6+.72+.95+.88) ≈ 0.064
    expect(b.reliabilityWeighted).toBeCloseTo(0.064, 2);
  });
  it('keeps back-compat top-level political fields', () => {
    expect(b.balanced).toBe(b.political.balanced);
    expect(b.consensus).toBe(b.political.consensus);
  });
  it('does not let an unrated source pollute the bucket aggregates', () => {
    const withNoise = computeSentimentBreakdown([...ROWS, { source: 'world:outlet:nobody', points: 1, avg: 0.99 }]);
    expect(withNoise.political.byLean.left).toBeCloseTo(0.3, 5); // unchanged
    expect(withNoise.bySource.some((s) => s.kind === 'unknown')).toBe(true);
  });
  it('handles the empty case without throwing', () => {
    const e = computeSentimentBreakdown([]);
    expect(e.naive).toBeNull();
    expect(e.political.consensus).toBe('insufficient');
    expect(e.political.byLean).toEqual({ left: null, center: null, right: null });
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
