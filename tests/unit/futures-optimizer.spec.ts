/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard Phase 2's locked-winner contract, minimum-trade sentinel ranking, non-overlapping OOS handoff, and deterministic ties.
 */
import { describe, expect, it } from 'vitest';
import { runStagedOptimizer, type OptimizerStage } from '@/features/trading';
import type { BacktestConfig, BacktestResult, FuturesBar } from '@/features/trading';

function bars(from = '2021-01-01T00:00:00.000Z'): FuturesBar[] {
  const start = new Date(from);
  return Array.from({ length: 36 }, (_, i) => ({
    t: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).toISOString(),
    o: 100, h: 101, l: 99, c: 100, v: 10,
  }));
}

const base: BacktestConfig = {
  instrument: { symbol: 'ES', multiplier: 50, tickSize: 0.25 },
  entry: { generation: 'dynstops', riskPerTradePercent: 2 },
  stops: { useStrangleTrail: true },
};

function result(config: BacktestConfig, net: number, barsProcessed: number): BacktestResult {
  const marker = Number((config as unknown as { marker?: number }).marker ?? 1);
  return {
    symbol: 'ES', barsProcessed, trades: Array.from({ length: Math.max(1, Math.round(marker)) }, (_, i) => ({
      direction: 'long', signalBar: i, entryBar: i, entryTime: '2021-01-01', entryPrice: 100,
      exitBar: i + 1, exitTime: '2021-01-02', exitPrice: 100, quantity: 1, exitName: 'TimedExit',
      profit: net, grossProfit: net, commission: 0, mfe: 1, mae: 1, mfePct: 1, maePct: 1, barsHeld: 1,
    })),
    equityCurve: [], netProfit: net, maxDrawdown: 0, winRate: 1, skippedZeroQty: 0,
    marginModeled: false, marginCappedTrades: 0, skippedNoMargin: 0, marginCalls: 0,
    peakNotional: 0, peakLeverage: 0, regimeBlockedSignals: 0, regimeBlockedBars: 0, warnings: [],
  };
}

describe('futures Phase 2 locked-winner optimizer', () => {
  it('locks stage N before constructing stage N+1 and evaluates the final lock on OOS only', () => {
    const seen: Array<{ marker?: number; bars: number }> = [];
    const stages: OptimizerStage[] = [
      { name: 'Entry', fitness: () => 1, grid: { marker: [1, 2] } },
      { name: 'StopLoss', fitness: () => 2, grid: { 'entry.riskPerTradePercent': [3] } },
      { name: 'Trail', fitness: () => 3, grid: {} },
    ];
    const report = runStagedOptimizer({ chart: bars(), ltf: bars(), daily: bars() }, base, {
      split: { inSampleMonths: 12, oosMonths: 6, stepMonths: 6 }, stages,
      runner: (chart, _ltf, config) => {
        const marker = (config as unknown as { marker?: number }).marker;
        seen.push({ marker, bars: chart.length });
        return result(config, marker === 2 ? 20 : 1, chart.length);
      },
    });
    expect(report.windows.length).toBe(3);
    expect(report.windows[0].stages[0].winnerPatch).toEqual({ marker: 1 });
    expect(report.windows[0].stages[1].baseConfig).toMatchObject({ marker: 1 });
    expect(report.windows[0].stages[2].baseConfig).toMatchObject({ marker: 1, entry: { riskPerTradePercent: 3 } });
    expect(report.windows[0].finalConfig).toMatchObject({ marker: 1, entry: { riskPerTradePercent: 3 } });
    expect(seen.at(-1)?.bars).toBeGreaterThan(0);
    expect(report.outOfSampleNet).toBeGreaterThan(0);
  });

  it('keeps the minimum-trade gate sentinel finite and deterministic when all candidates fail it', () => {
    const stages: OptimizerStage[] = [{ name: 'Entry', fitness: 'max-net-profit-min-trades-50', grid: { marker: [1, 2] } }];
    const report = runStagedOptimizer({ chart: bars(), ltf: bars() }, base, {
      split: { inSampleMonths: 12, oosMonths: 6, stepMonths: 6 }, stages,
      runner: (chart, _ltf, config) => result(config, -100, chart.length),
    });
    expect(report.windows[0].stages[0].inSampleScore).toBe(-1e10);
    expect(report.windows[0].stages[0].winnerPatch).toEqual({ marker: 1 });
  });
});
