/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The world outlet-rating Test Lab card is registered exactly once with suites that exist, and its steps report honestly: the live rating read is degraded when world is off or nothing is rated yet, fails on a read error or a broken rating, and passes with what it read; the live breakdown read fails on a seeded axis or an unrated source; the in-build containment step passes on this build through the real classifier with a capturing provider.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import {
  WORLD_OUTLET_RATING_SCENARIOS, breakdownStep, classifyContainmentStep, observedRatingsStep, ratingViolation,
} from '@/app/routes/test-lab-world-outlet-rating-scenarios';
import { rateOutlets, type ObservedOutletRating, type OutletDivergenceStats } from '@/features/world-data/outlet-ratings';

const PARAMS = { windowDays: 90, minComparisons: 20, minSubjects: 3 };
const stats = (source: string, comparisons: number, subjects: number): OutletDivergenceStats => ({
  source, comparisons, subjects, observations: comparisons, firstDay: '2026-07-03', lastDay: '2026-09-30',
  meanDivergence: 0.2, sdDivergence: 0.3, meanAbsDivergence: 0.3,
});
const SET = rateOutlets([stats('world:outlet:reuters', 120, 30), stats('world:outlet:thin', 4, 1)], PARAMS, '2026-10-01T00:00:00.000Z');

describe('world outlet-rating Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    const [scenario] = WORLD_OUTLET_RATING_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps.map((s) => s.id)).toEqual(['live-ratings', 'live-breakdown', 'classify-containment']);
  });

  it('checks the rating contract both ways', () => {
    const rated = SET.ratings.get('world:outlet:reuters')!;
    expect(ratingViolation(rated, SET)).toBeNull();
    expect(ratingViolation(SET.ratings.get('world:outlet:thin')!, SET)).toBeNull();
    expect(ratingViolation({ ...rated, firstObserved: null }, SET)).toContain('date range');
    expect(ratingViolation({ ...rated, comparisons: 3 }, SET)).toContain('below the minimums');
    const insufficient: ObservedOutletRating = { ...SET.ratings.get('world:outlet:thin')!, lean: 0.4 };
    expect(ratingViolation(insufficient, SET)).toContain('carries a number');
  });
});

describe('live-ratings step', () => {
  it('is degraded when world intelligence is off', async () => {
    expect((await observedRatingsStep(null)).state).toBe('degraded');
  });
  it('fails when the series store cannot be read', async () => {
    const r = await observedRatingsStep({ outletRatings: async () => { throw new Error('ECONNREFUSED oshal-tsdb'); } });
    expect(r).toMatchObject({ state: 'fail' });
    expect(r.detail).toContain('ECONNREFUSED');
  });
  it('is degraded, naming the minimums, when no source is rated yet', async () => {
    const onlyThin = rateOutlets([stats('world:outlet:thin', 4, 1)], PARAMS, '2026-10-01T00:00:00.000Z');
    const r = await observedRatingsStep({ outletRatings: async () => onlyThin });
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('20 compared subject-days');
    expect(r.detail).toContain('Not live-proven');
  });
  it('fails on a rating that breaks the contract', async () => {
    const broken = { ...SET, ratings: new Map([['world:outlet:x', { ...SET.ratings.get('world:outlet:thin')!, source: 'world:outlet:x', reliability: 0.9 }]]) };
    expect((await observedRatingsStep({ outletRatings: async () => broken })).state).toBe('fail');
  });
  it('passes with the counts, method and most-compared source it read', async () => {
    const r = await observedRatingsStep({ outletRatings: async () => SET });
    expect(r.state).toBe('pass');
    expect(r.detail).toContain('1 source(s) rated, 1 insufficient');
    expect(r.detail).toContain('world:outlet:reuters');
    expect(r.output).toMatchObject({ rated: 1, insufficient: 1, method: 'consensus-divergence-v1', windowDays: 90 });
  });
});

describe('live-breakdown step', () => {
  const reader = (bd: Record<string, unknown>, subjects = [{ entity: 'world:ticker:nvda', label: 'NVDA', items: 10, lastSeen: null }]) => ({
    listEntities: async () => subjects, outletRatings: async () => SET, sentimentBreakdown: async () => bd,
  });
  const good = { lean: {}, ratings: { method: 'consensus-divergence-v1' }, bySource: [{ source: 'world:outlet:reuters', rating: SET.ratings.get('world:outlet:reuters') }] };

  it('is degraded with no tracked subject', async () => {
    expect((await breakdownStep(reader(good, []))).state).toBe('degraded');
  });
  it('fails when a seeded axis comes back', async () => {
    const r = await breakdownStep(reader({ ...good, political: { balanced: 0.1 } }));
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('political');
  });
  it('fails when a source carries no rating', async () => {
    expect((await breakdownStep(reader({ ...good, bySource: [{ source: 'world:outlet:x' }] }))).state).toBe('fail');
  });
  it('passes on a breakdown read through the ratings', async () => {
    const r = await breakdownStep(reader(good));
    expect(r.state).toBe('pass');
    expect(r.output).toMatchObject({ entity: 'world:ticker:nvda', sources: 1 });
  });
});

describe('classify-containment step (in-build, this build)', () => {
  it('passes through the real classifier with a capturing provider', async () => {
    const r = await classifyContainmentStep();
    expect(r.state).toBe('pass');
  });
});
