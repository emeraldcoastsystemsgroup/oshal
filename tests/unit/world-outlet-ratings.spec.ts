/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for oshal's own OBSERVED outlet ratings (operator decision 2026-09-22: the seed table is deleted, no external license). Pure half: the lean, bucket and reliability arithmetic, the stated minimums below which a source is insufficient and carries no number, the env-overridable parameters, identity resolution that keeps a publisher's history under one id, the identity-only seed that nulls the retired rating props, and the memoized reader (TTL, shared read, a failed read is not served from the memo). The aggregate itself runs on TimescaleDB in world-outlet-ratings-postgres.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import * as outletRatings from '../../src/features/world-data/outlet-ratings';
import {
  OUTLET_IDENTITIES,
  RETIRED_RATING_PROPS,
  buildOutletSeedContribution,
  outletByName,
  outletRatingParams,
  outletSourceId,
  rateOutlet,
  rateOutlets,
  ratingFor,
  type OutletDivergenceStats,
} from '../../src/features/world-data/outlet-ratings';
import { createOutletRatingReader } from '../../src/features/world-data/outlet-observations';

const PARAMS = { windowDays: 90, minComparisons: 20, minSubjects: 3 };

/** Statistics for one source; sd 0.5 over 25 comparisons gives a standard error of exactly 0.1. */
function stats(over: Partial<OutletDivergenceStats> = {}): OutletDivergenceStats {
  return {
    source: 'world:outlet:sample', comparisons: 25, subjects: 4, observations: 60,
    firstDay: '2026-08-01', lastDay: '2026-09-29',
    meanDivergence: 0.3, sdDivergence: 0.5, meanAbsDivergence: 0.4, ...over,
  };
}

describe('rateOutlet — the observed rating', () => {
  it('rates a source above the minimums with its counts and date range', () => {
    expect(rateOutlet(stats(), PARAMS)).toEqual({
      source: 'world:outlet:sample', status: 'rated', lean: 0.3, leanBucket: 'above', reliability: 0.8,
      comparisons: 25, subjects: 4, observations: 60, firstObserved: '2026-08-01', lastObserved: '2026-09-29',
    });
  });

  it('is insufficient below the comparison minimum and carries no number', () => {
    const r = rateOutlet(stats({ comparisons: 19 }), PARAMS);
    expect(r).toMatchObject({ status: 'insufficient', lean: null, leanBucket: null, reliability: null, comparisons: 19, subjects: 4 });
  });

  it('is insufficient below the subject minimum even with many comparisons', () => {
    const r = rateOutlet(stats({ comparisons: 500, subjects: 2 }), PARAMS);
    expect(r).toMatchObject({ status: 'insufficient', lean: null, reliability: null });
  });

  it('is rated exactly at both minimums', () => {
    expect(rateOutlet(stats({ comparisons: 20, subjects: 3 }), PARAMS).status).toBe('rated');
  });

  it('is insufficient when there is no divergence to average', () => {
    expect(rateOutlet(stats({ meanDivergence: null }), PARAMS).status).toBe('insufficient');
    expect(rateOutlet(stats({ meanAbsDivergence: null }), PARAMS).status).toBe('insufficient');
  });

  it('calls a lean below/above only beyond two standard errors (here 0.2)', () => {
    expect(rateOutlet(stats({ meanDivergence: 0.2 }), PARAMS).leanBucket).toBe('near');
    expect(rateOutlet(stats({ meanDivergence: 0.2001 }), PARAMS).leanBucket).toBe('above');
    expect(rateOutlet(stats({ meanDivergence: -0.2001 }), PARAMS).leanBucket).toBe('below');
    expect(rateOutlet(stats({ meanDivergence: -0.05 }), PARAMS).leanBucket).toBe('near');
  });

  it('buckets by sign alone when every divergence was identical (no spread)', () => {
    expect(rateOutlet(stats({ meanDivergence: 0.01, sdDivergence: 0 }), PARAMS).leanBucket).toBe('above');
    expect(rateOutlet(stats({ meanDivergence: 0, sdDivergence: 0 }), PARAMS).leanBucket).toBe('near');
  });

  it('maps mean |divergence| onto reliability in [0, 1]', () => {
    expect(rateOutlet(stats({ meanAbsDivergence: 0 }), PARAMS).reliability).toBe(1);
    expect(rateOutlet(stats({ meanAbsDivergence: 1 }), PARAMS).reliability).toBe(0.5);
    expect(rateOutlet(stats({ meanAbsDivergence: 2 }), PARAMS).reliability).toBe(0);
  });

  it('rounds lean and reliability to three decimals', () => {
    const r = rateOutlet(stats({ meanDivergence: 0.123456, meanAbsDivergence: 0.333333 }), PARAMS);
    expect(r.lean).toBe(0.123);
    expect(r.reliability).toBe(0.833);
  });
});

describe('rateOutlets / ratingFor', () => {
  const set = rateOutlets([stats(), stats({ source: 'world:outlet:thin', comparisons: 2 })], PARAMS, '2026-10-01T12:00:00.000Z');

  it('records the method and parameters on the set', () => {
    expect(set).toMatchObject({ method: 'consensus-divergence-v1', leanZ: 2, computedAt: '2026-10-01T12:00:00.000Z', ...PARAMS });
    expect(set.ratings.size).toBe(2);
  });

  it('returns an insufficient zero-count rating for a source never compared', () => {
    expect(ratingFor(set, 'world:outlet:absent')).toEqual({
      source: 'world:outlet:absent', status: 'insufficient', lean: null, leanBucket: null, reliability: null,
      comparisons: 0, subjects: 0, observations: 0, firstObserved: null, lastObserved: null,
    });
    expect(ratingFor(set, 'world:outlet:thin').status).toBe('insufficient');
    expect(ratingFor(set, 'world:outlet:sample').status).toBe('rated');
  });
});

describe('outletRatingParams', () => {
  it('states the defaults', () => {
    expect(outletRatingParams({})).toEqual({ windowDays: 90, minComparisons: 20, minSubjects: 3 });
  });
  it('takes whole-number overrides and ignores malformed ones', () => {
    expect(outletRatingParams({
      WORLD_OUTLET_RATING_WINDOW_DAYS: '30', WORLD_OUTLET_RATING_MIN_COMPARISONS: '50', WORLD_OUTLET_RATING_MIN_SUBJECTS: '5',
    })).toEqual({ windowDays: 30, minComparisons: 50, minSubjects: 5 });
    expect(outletRatingParams({
      WORLD_OUTLET_RATING_WINDOW_DAYS: '0', WORLD_OUTLET_RATING_MIN_COMPARISONS: '2.5', WORLD_OUTLET_RATING_MIN_SUBJECTS: 'many',
    })).toEqual({ windowDays: 90, minComparisons: 20, minSubjects: 3 });
  });
});

describe('outlet identity — no rating lives in the module', () => {
  it('holds identity only: id, name and domain, never a number', () => {
    for (const o of OUTLET_IDENTITIES) {
      expect(Object.keys(o).sort()).toEqual(['domain', 'id', 'name']);
      expect(Object.values(o).every((v) => typeof v === 'string')).toBe(true);
    }
  });

  it('no longer exports the seed table or its lookups', () => {
    expect(outletRatings).not.toHaveProperty('OUTLET_RATINGS');
    expect(outletRatings).not.toHaveProperty('ratingOf');
    expect(outletRatings).not.toHaveProperty('ratingByName');
    expect(outletRatings).not.toHaveProperty('econBucket');
  });

  it('keeps resolving a publisher to the id its history is stored under', () => {
    expect(outletSourceId('Fox News')).toBe('world:outlet:foxnews');
    expect(outletSourceId('Fox Business')).toBe('world:outlet:foxnews');
    expect(outletSourceId('AP News')).toBe('world:outlet:ap');
    expect(outletSourceId('WSJ')).toBe('world:outlet:wsj');
    expect(outletSourceId('The New York Times')).toBe('world:outlet:nyt');
    expect(outletSourceId('Some Regional Blog')).toBe('world:outlet:some-regional-blog');
    expect(outletByName('')).toBeUndefined();
  });

  it('seeds identity only and nulls every retired rating prop', () => {
    const c = buildOutletSeedContribution('2026-10-01T00:00:00.000Z');
    expect(c.source).toBe('outlet-identity-seed');
    expect(c.edges).toEqual([]);
    expect(c.facts).toEqual([]);
    expect(c.entities).toHaveLength(OUTLET_IDENTITIES.length);
    for (const e of c.entities) {
      expect(e.type).toBe('outlet');
      for (const key of Object.keys(RETIRED_RATING_PROPS)) expect(e.props?.[key]).toBeNull();
      expect(Object.values(e.props ?? {}).some((v) => typeof v === 'number')).toBe(false);
    }
  });
});

describe('createOutletRatingReader — one read per refresh interval', () => {
  const row = {
    source: 'world:outlet:sample', comparisons: 25, subjects: 4, observations: '60', first_day: '2026-08-01', last_day: '2026-09-29',
    mean_div: '0.3', sd_div: '0.5', mean_abs_div: '0.4',
  };

  it('reuses the set within the TTL and re-reads after it', async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    let clock = 1_000;
    const reader = createOutletRatingReader({ query } as unknown as Pool, { WORLD_OUTLET_RATING_TTL_MS: '500' }, () => clock);
    const first = await reader.read();
    expect(first.ratings.get('world:outlet:sample')).toMatchObject({ status: 'rated', lean: 0.3, reliability: 0.8, observations: 60 });
    clock += 499;
    await reader.read();
    expect(query).toHaveBeenCalledTimes(1);
    clock += 1;
    await reader.read();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('passes the window to the query', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    await createOutletRatingReader({ query } as unknown as Pool, { WORLD_OUTLET_RATING_WINDOW_DAYS: '45' }).read();
    expect(query.mock.calls[0]?.[1]).toEqual([45]);
  });

  it('does not serve a failed read from the memo', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('statement timeout'))
      .mockResolvedValueOnce({ rows: [row] });
    const reader = createOutletRatingReader({ query } as unknown as Pool, {}, () => 5_000);
    await expect(reader.read()).rejects.toThrow('statement timeout');
    await expect(reader.read()).resolves.toMatchObject({ method: 'consensus-divergence-v1' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
