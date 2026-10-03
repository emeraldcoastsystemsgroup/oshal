/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The congressional disclosure card is registered exactly once, its attached suites exist, and its live step reports honestly: degraded when world is off or nothing observed exists, fail when the store cannot be read, pass only with observed feed points - reading the congress_* metrics under the quiver-congress source, bounded, and never writing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The degraded detail also names the credential refusal line and WORLD_POLITICAL_TOKEN (the default feed answered 401 without it on 2026-09-28).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The World sources and schedules card: registered once with suites on disk; each read-only step is degraded without its backend, passes naming what it read (on/off, override, not pulling, collector runs) and fails on a store error.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import {
  CONGRESS_LAB_METRICS, WORLD_SIGNAL_SCENARIOS, congressCoverageStep, worldScheduleStep, worldSourcesStep,
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

describe('World sources and schedules Test Lab card', () => {
  const card = () => WORLD_SIGNAL_SCENARIOS.find((s) => s.id === 'world-sources-schedules')!;
  const record = (status: 'active' | 'paused', cron: string) => ({ id: 'x', status, cron, nextRunAt: null }) as never;

  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === 'world-sources-schedules')).toEqual([card()]);
    for (const t of card().regressionTests!) expect(existsSync(t.path), t.path).toBe(true);
    expect(card().steps.map((s) => s.id)).toEqual(['live-schedules', 'live-sources']);
  });

  it('schedules: degraded without a scheduler or a registered schedule, pass naming on/off and an override, fail on a store error', async () => {
    expect((await worldScheduleStep(null)).state).toBe('degraded');
    const missing = await worldScheduleStep({ getScheduleForTaskType: async () => null, getManifestOverride: async () => null } as never);
    expect(missing).toMatchObject({ state: 'degraded' });
    expect(missing.detail).toContain('world-refresh, ticker-pulse');
    const live = await worldScheduleStep({
      getScheduleForTaskType: async (t: string) => (t === 'app:world-world-refresh' ? record('paused', '0 */12 * * *') : record('active', '*/5 8-23 * * 1-5')),
      getManifestOverride: async (k: string) => (k === 'world-world-refresh' ? { enabled: false, cron: '0 */12 * * *', updatedBy: 'op', updatedAt: new Date().toISOString() } : null),
    } as never);
    expect(live.state).toBe('pass');
    expect(live.detail).toContain('world-refresh off at "0 */12 * * *" (operator override)');
    expect(live.detail).toContain('ticker-pulse on at "*/5 8-23 * * 1-5"');
    const broken = await worldScheduleStep({ getScheduleForTaskType: async () => { throw new Error('redis down'); }, getManifestOverride: async () => null } as never);
    expect(broken).toMatchObject({ state: 'fail' });
    expect(broken.detail).toContain('redis down');
  });

  it('sources: degraded when world is off, pass with what is not pulling and each collector run, fail on a store error', async () => {
    expect((await worldSourcesStep(null)).state).toBe('degraded');
    const control = {
      listSwitches: async () => [{ sourceId: 'reddit', enabled: false, updatedBy: 'op', updatedAt: new Date().toISOString() }],
      feedPullStats: async () => [],
      collectorRuns: async () => [{ collector: 'congress-trades', ranAt: '2026-10-02T18:46:00.000Z', outcome: 'ok', detail: {} }],
    };
    const live = await worldSourcesStep({ sourceControl: () => control } as never);
    expect(live.state).toBe('pass');
    expect(live.detail).toMatch(/not pulling: [^;]*reddit/);
    expect(live.detail).toContain('congress-trades ok');
    expect(live.detail).toContain('5 collectors');
    const broken = await worldSourcesStep({ sourceControl: () => ({ ...control, listSwitches: async () => { throw new Error('tsdb down'); } }) } as never);
    expect(broken).toMatchObject({ state: 'fail' });
  });
});
