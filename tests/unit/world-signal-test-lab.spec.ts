/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The congressional disclosure card is registered exactly once, its attached suites exist, and its live step reports honestly: degraded when world is off or nothing observed exists, fail when the store cannot be read, pass only with observed feed points - reading the congress_* metrics under the quiver-congress source, bounded, and never writing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The degraded detail also names the credential refusal line and WORLD_POLITICAL_TOKEN (the default feed answered 401 without it on 2026-09-28).
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import {
  CONGRESS_LAB_METRICS, WORLD_SIGNAL_SCENARIOS, congressCoverageStep,
} from '@/app/routes/test-lab-world-signal-scenarios';

/** A reader double: the step's only collaborator, recording what it was asked. */
function reader(answer: () => Promise<unknown[]>) {
  const calls: unknown[][] = [];
  return {
    calls,
    svc: { recentFeedMetricPoints: async (...args: unknown[]) => { calls.push(args); return answer(); } } as never,
  };
}

describe('congressional disclosure Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    const [scenario] = WORLD_SIGNAL_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
    expect(scenario.regressionTests!.map((t) => t.path)).toContain('tests/unit/world-metrics-observed-at-postgres.spec.ts');
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps.map((s) => s.id)).toEqual(['live-coverage']);
  });

  it('is degraded, not failed, when world intelligence is off', async () => {
    const r = await congressCoverageStep(null);
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('disabled');
  });

  it('is degraded with the log line to check when nothing observed has been written', async () => {
    const { calls, svc } = reader(async () => []);
    const r = await congressCoverageStep(svc);
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('political trades collected');
    expect(r.detail).toContain('congress trades feed refused');
    expect(r.detail).toContain('WORLD_POLITICAL_TOKEN');
    expect(r.detail).toContain('not live-proven');
    expect(calls).toEqual([[CONGRESS_LAB_METRICS, 'quiver-congress', 90, 100]]);
  });

  it('fails when the series store cannot be read', async () => {
    const { svc } = reader(async () => { throw new Error('getaddrinfo ENOTFOUND oshal-tsdb'); });
    const r = await congressCoverageStep(svc);
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('ENOTFOUND oshal-tsdb');
  });

  it('passes with the name count, newest disclosure day and last observation it read', async () => {
    const { svc } = reader(async () => [
      { entity: 'world:ticker:nvda', metric: 'congress_net', ts: '2026-09-23T00:00:00.000Z', value: 2, source: 'quiver-congress', observedAt: '2026-09-25T06:00:00.000Z' },
      { entity: 'world:ticker:nvda', metric: 'congress_buys', ts: '2026-09-23T00:00:00.000Z', value: 2, source: 'quiver-congress', observedAt: '2026-09-25T06:00:00.000Z' },
      { entity: 'world:ticker:aapl', metric: 'congress_net', ts: '2026-09-15T00:00:00.000Z', value: -1, source: 'quiver-congress', observedAt: '2026-09-25T12:00:00.000Z' },
    ]);
    const r = await congressCoverageStep(svc);
    expect(r.state).toBe('pass');
    expect(r.output).toEqual({ names: 2, newestDisclosure: '2026-09-23', lastObservedAt: '2026-09-25T12:00:00.000Z', sample: ['NVDA', 'AAPL'] });
    expect(r.detail).toContain('no feed call');
  });
});
