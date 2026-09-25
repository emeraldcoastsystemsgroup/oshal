/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify bar-date freshness, configured per-window floors and the real archive-to-optimizer refusal boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as trading from '@/features/trading';
import { assertFuturesSourceFreshness, assessFuturesSample, normalizeFuturesQuality } from '@/app/trading-futures-research-quality';
import { normalizeFuturesResearchConfig } from '@/app/trading-futures-research-dispatch';
import { executeFuturesStudy } from '@/app/trading-futures-research-study';

const policy = { maxSourceLagDays: 7, minOosTradesPerWindow: 10 };
const freshness = assertFuturesSourceFreshness(policy, 'ES', '2021-05-31', '2021-05-28', '2021-05-28');
const report = (trades: number[]): trading.StagedOptimizerReport => ({
  split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
  windows: trades.map((n, i) => ({ window: { index: i, isStart: '2021-01-01', isEnd: `2021-0${i + 2}-01`,
    oosStart: `2021-0${i + 2}-01`, oosEnd: `2021-0${i + 3}-01` }, stages: [], finalConfig: {} as trading.BacktestConfig,
  outOfSampleTrades: n, outOfSampleNet: -10, outOfSampleMaxDD: 10 })),
  outOfSampleTrades: trades.reduce((n, count) => n + count, 0), outOfSampleNet: -20, worstOutOfSampleMaxDD: 10,
});

describe('Futures source and sample gates', () => {
  it('bounds console settings and refuses disabled, non-numeric or unknown gates', () => {
    expect(normalizeFuturesQuality(undefined)).toEqual(policy);
    expect(normalizeFuturesQuality({ maxSourceLagDays: 90, minOosTradesPerWindow: 25 })).toEqual({ maxSourceLagDays: 90, minOosTradesPerWindow: 25 });
    for (const bad of [[], 'anything', { maxSourceLagDays: 0 }, { maxSourceLagDays: 367 }, { minOosTradesPerWindow: -1 },
      { minOosTradesPerWindow: 100001 }, { minOosTradesPerWindow: '10' }, { maxSourceLagDays: 1.5 }, { skip: true }]) {
      expect(() => normalizeFuturesQuality(bad)).toThrow();
    }
  });
  it('uses calendar dates relative to the resolved study end, never pretends source wall time is true UTC', () => {
    expect(freshness).toMatchObject({ referenceDate: '2021-05-31', timestampBasis: 'bar-start-calendar-date', chartLagDays: 3, ltfLagDays: 3 });
    expect(assertFuturesSourceFreshness(policy, 'ES', '2021-05-31', '2021-05-24T23:55:00Z', '2021-05-24T00:00:00Z').ltfLagDays).toBe(7);
    expect(() => assertFuturesSourceFreshness(policy, 'ES', '2021-05-31', '2021-05-23', '2021-05-30')).toThrow(/chart 2021-05-23 \(8 days\)/);
    expect(() => assertFuturesSourceFreshness(policy, 'ES', '2021-05-31', '2021-05-30', '2021-05-23')).toThrow(/higher timeframe 2021-05-23 \(8 days\)/);
    expect(() => assertFuturesSourceFreshness(policy, 'ES', '2021-05-31', '2021-06-01', '2021-05-30')).toThrow(/beyond the study end/);
    expect(() => assertFuturesSourceFreshness(policy, 'ES', '2021-05-31', '', '2021-05-30')).toThrow(/no valid/);
  });
  it('does not let an aggregate hide an empty or low-trade OOS window', () => {
    const assessment = assessFuturesSample(policy, freshness, report([100, 0, 9]));
    expect(assessment.sampleStatus).toBe('insufficient');
    expect(assessment.lowTradeWindows.map(w => w.trades)).toEqual([0, 9]);
    expect(assessFuturesSample(policy, freshness, report([])).sampleStatus).toBe('insufficient');
    // This sample floor is independent of profit: a losing study can pass the count, not a promotion gate.
    expect(assessFuturesSample(policy, freshness, report([10, 20])).sampleStatus).toBe('meets_configured_floor');
  });
  it('reads an actual stale Kibot file and refuses before invoking the optimizer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'futures-quality-'));
    const optimizer = vi.spyOn(trading, 'runStagedOptimizer');
    try {
      mkdirSync(join(dir, 'minute'));
      writeFileSync(join(dir, 'minute', 'ESH21.txt'), '01/04/2021,10:00,3700,3701,3699,3700,900\n');
      const config = normalizeFuturesResearchConfig({ roots: ['ES'], source: 'kibot-file', dataDir: dir, timeframe: '1Day', ltfTimeframe: '1Day',
        start: '2021-01-01', endMode: 'fixed', end: '2021-05-31', split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
        stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} } });
      await expect(executeFuturesStudy(config)).rejects.toThrow(/stale Futures source.*2021-01-04.*Optimizer not run/);
      expect(optimizer).not.toHaveBeenCalled();
    } finally { optimizer.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});
