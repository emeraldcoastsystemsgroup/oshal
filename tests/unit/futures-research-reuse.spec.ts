/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove real-file rereads, exact-input optimizer skips, and invalidation without mocking study computation.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as trading from '@/features/trading';
import { normalizeFuturesResearchConfig, type FuturesResearchConfig } from '@/app/trading-futures-research-dispatch';
import { executeFuturesStudy, type FuturesResearchMarket } from '@/app/trading-futures-research-study';
import { futuresStudyInputFingerprint, type FuturesStudyReuse } from '@/app/trading-futures-research-reuse';

let dir: string, config: FuturesResearchConfig, first: FuturesResearchMarket[], reuse: FuturesStudyReuse;
let optimizer: MockInstance<typeof trading.runStagedOptimizer>;

function archive(days = 151, revised = false): void {
  const rows = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(2021, 0, index + 1));
    return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/2021,3700,3701,3699,${revised && index === 10 ? 3701 : 3700},900`;
  }).join('\n');
  for (const symbol of ['ESH21', 'ESM21']) writeFileSync(join(dir, 'daily', `${symbol}.txt`), rows);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'futures-reuse-'));
  mkdirSync(join(dir, 'daily'));
  archive();
  config = normalizeFuturesResearchConfig({ roots: ['ES'], source: 'kibot-file', dataDir: dir, adjust: 'none',
    timeframe: '1Day', ltfTimeframe: '1Day', start: '2021-01-01', endMode: 'fixed', end: '2021-05-29',
    split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
    stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} } });
  optimizer = vi.spyOn(trading, 'runStagedOptimizer');
  first = await executeFuturesStudy(config, { generation: 'fixture-api' });
  // JSON round trip models non-finite optimizer sentinels becoming null in durable evidence.
  reuse = { generation: 'fixture-api', previous: { runId: 'prior-owned-run', markets: JSON.parse(JSON.stringify(first)) } };
  expect(optimizer).toHaveBeenCalledTimes(1);
  optimizer.mockClear();
});
afterEach(() => { optimizer?.mockRestore(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('pre-optimizer Futures reuse through actual archives', () => {
  it('skips the real optimizer and refreshes source counts/dates on a longer incomplete tail', async () => {
    const result = await executeFuturesStudy({ ...config, end: '2021-05-31T23:59:59Z', nightlyReview: true, nightlyCron: '0 3 * * *' }, reuse);
    expect(optimizer).not.toHaveBeenCalled();
    expect(result[0].computation).toMatchObject({ status: 'reused', reusedFromRunId: 'prior-owned-run', reportFingerprint: first[0].computation!.reportFingerprint });
    expect(result[0].evidenceFingerprint).toBe(first[0].evidenceFingerprint);
    expect(result[0].bars).toBeGreaterThan(first[0].bars);
    expect(result[0].chartAsOf).toContain('2021-05-31');
    expect(result[0].quality?.referenceDate).toBe('2021-05-31');
    expect(result[0].quality?.sampleStatus).toBe('insufficient');
  });
  it('rereads revised completed-window prices and recomputes', async () => {
    archive(151, true);
    const result = await executeFuturesStudy(config, reuse);
    expect(optimizer).toHaveBeenCalledTimes(1);
    expect(result[0].computation?.status).toBe('computed');
    expect(result[0].evidenceFingerprint).not.toBe(first[0].evidenceFingerprint);
  });
  it('computes when a new complete window is available', async () => {
    archive(152);
    const result = await executeFuturesStudy({ ...config, end: '2021-06-01T23:59:59Z' }, reuse);
    expect(optimizer).toHaveBeenCalledTimes(1);
    expect(result[0].report.windows).toHaveLength(first[0].report.windows.length + 1);
  });
  it.each(['grid', 'split', 'generation'] as const)('invalidates a changed %s', async change => {
    const next = structuredClone(config), context = structuredClone(reuse);
    if (change === 'grid') next.stageGrids.Entry = { 'entry.ensembleEntryThresholdPct': [62] };
    if (change === 'split') next.split.inSampleMonths = 2;
    if (change === 'generation') context.generation = 'restarted-api';
    const result = await executeFuturesStudy(next, context);
    expect(optimizer).toHaveBeenCalledTimes(1);
    expect(result[0].computation?.status).toBe('computed');
    expect(result[0].computation?.inputFingerprint).not.toBe(first[0].computation?.inputFingerprint);
  });
  it.each(['legacy', 'damaged', 'wrong-root'] as const)('computes normally for %s prior evidence', async shape => {
    const market = reuse.previous!.markets[0];
    if (shape === 'legacy') delete market.computation;
    if (shape === 'damaged') market.report.outOfSampleNet = 123456;
    if (shape === 'wrong-root') market.root = 'CL';
    const result = await executeFuturesStudy(config, reuse);
    expect(optimizer).toHaveBeenCalledTimes(1);
    expect(result[0].computation?.status).toBe('computed');
    expect(result[0].outOfSampleNet).toBe(first[0].outOfSampleNet);
  });
  it('refuses a newly stale or missing archive instead of reusing its old report', async () => {
    await expect(executeFuturesStudy({ ...config, end: '2021-06-10T23:59:59Z' }, reuse)).rejects.toThrow(/stale Futures source/);
    archive(0);
    await expect(executeFuturesStudy(config, reuse)).rejects.toThrow(/empty/);
    expect(optimizer).not.toHaveBeenCalled();
  });
  it('keys resolved engine settings and preserves grid axis/candidate tie order', () => {
    const input = { generation: 'fixture', config, root: 'ES', base: { startingEquity: 100000 } as trading.BacktestConfig,
      stages: [{ name: 'Entry', fitness: 'entry-logic', grid: { a: [1, 2], b: [3, 4] } }] as trading.OptimizerStage[],
      windows: first[0].report.windows.map(row => row.window), chart: [], ltf: [], ltfResampledFromMinute: false };
    const original = futuresStudyInputFingerprint(input);
    const changes = [
      { ...input, base: { ...input.base, startingEquity: 200000 } },
      { ...input, stages: [{ ...input.stages[0], grid: { b: [3, 4], a: [1, 2] } }] },
      { ...input, stages: [{ ...input.stages[0], grid: { a: [2, 1], b: [3, 4] } }] },
      { ...input, ltfResampledFromMinute: true },
    ];
    for (const changed of changes) expect(futuresStudyInputFingerprint(changed)).not.toBe(original);
  });
});
