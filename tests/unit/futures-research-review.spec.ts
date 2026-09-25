/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise bounded, evidence-linked Futures review contracts with explicit historical fixtures.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep unassessed quality explicit and refuse proposals that change operator-owned gates.
 */
import { describe, expect, it } from 'vitest';
import { futuresReviewPrompt, parseFuturesReview } from '@/app/trading-futures-research-review-contract';
import { normalizeFuturesResearchConfig, type FuturesResearchRun } from '@/app/trading-futures-research-dispatch';

const config = normalizeFuturesResearchConfig({
  source: 'kibot-file', dataDir: '/private/archive/never-in-prompt', roots: ['ES'],
  start: '2021-01-01', endMode: 'fixed', end: '2021-05-31',
  split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
  stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} },
});
const market = { root: 'ES', evidenceFingerprint: 'a'.repeat(64), chartAsOf: config.end, ltfAsOf: config.end,
  latestCompleteOosEnd: '2021-05-01', outOfSampleNet: -100, outOfSampleTrades: 3, worstOutOfSampleMaxDD: 150,
  bars: 100, ltfBars: 100, ltfResampledFromMinute: false,
  report: { windows: [], outOfSampleNet: -100, outOfSampleTrades: 3, worstOutOfSampleMaxDD: 150, split: config.split } };
const run: FuturesResearchRun = { runId: 'fixture', ownerSub: 'private-owner', scheduleId: 'private-schedule',
  status: 'completed', config, markets: [market], error: 'private provider detail', createdAt: config.end, completedAt: config.end };
const output = { summary: 'The historical sample lost money.', limitations: ['Three trades are not sufficient evidence.'],
  evidence: [{ root: 'ES', fingerprint: market.evidenceFingerprint }],
  nextStudy: { rationale: 'Test a higher threshold on a new holdout.', stageGrids: { Entry: { 'entry.ensembleEntryThresholdPct': [70] } } } };

describe('Futures review contract', () => {
  it('retains negative evidence but excludes private path, owner and provider error from the prompt', () => {
    const prompt = futuresReviewPrompt(run);
    expect(prompt).toContain('"outOfSampleNet":-100');
    expect(prompt).toContain('NOT forward predictions');
    expect(prompt).toContain('"quality":null');
    expect(prompt).toContain('unassessed, never a pass');
    for (const secret of [run.ownerSub, run.scheduleId, config.dataDir, run.error!]) expect(prompt).not.toContain(secret);
  });
  it('accepts a bounded hypothesis and preserves unspecified stages', () => {
    expect(parseFuturesReview(JSON.stringify(output), run).nextStudy?.stageGrids).toEqual({ ...config.stageGrids, ...output.nextStudy.stageGrids });
    expect(parseFuturesReview(JSON.stringify({ ...output, nextStudy: null }), run).nextStudy).toBeNull();
  });
  it('requires the exact root and fingerprint set, without duplicate or invented citations', () => {
    for (const evidence of [[], [...output.evidence, ...output.evidence], [{ root: 'CL', fingerprint: market.evidenceFingerprint }], [{ root: 'ES', fingerprint: 'invented' }]]) {
      expect(() => parseFuturesReview(JSON.stringify({ ...output, evidence }), run)).toThrow();
    }
  });
  it('refuses authority widening, invalid types, prototype axes, oversized and unchanged grids', () => {
    expect(() => parseFuturesReview(JSON.stringify({ ...output, orders: [] }), run)).toThrow();
    expect(() => parseFuturesReview(JSON.stringify({ ...output, nextStudy: { ...output.nextStudy, source: 'other' } }), run)).toThrow();
    expect(() => parseFuturesReview(JSON.stringify({ ...output, nextStudy: { ...output.nextStudy, quality: { minOosTradesPerWindow: 1 } } }), run)).toThrow();
    for (const stageGrids of [{}, config.stageGrids, { Entry: { '__proto__.admin': [true] } }, { Entry: { constructor: [70] } },
      { Sizing: { 'entry.riskPerTradePercent': [6] } }, { Targets: { 'targets.useTargets': ['true'] } },
      { Entry: { 'entry.ensembleEntryThresholdPct': Array.from({ length: 9 }, () => 70) } }]) {
      expect(() => parseFuturesReview(JSON.stringify({ ...output, nextStudy: { ...output.nextStudy, stageGrids } }), run)).toThrow();
    }
    expect(() => parseFuturesReview('x'.repeat(64_001), run)).toThrow(/64 KB/);
  });
  it('refuses a proposal that exceeds the original total study budget', () => {
    const expensive = { ...run, config: normalizeFuturesResearchConfig({ ...config, end: '2025-12-31' }) };
    const stageGrids = { Entry: { 'entry.ensembleEntryThresholdPct': [10, 20, 30, 40, 50, 60, 70, 80] } };
    expect(() => parseFuturesReview(JSON.stringify({ ...output, nextStudy: { ...output.nextStudy, stageGrids } }), expensive)).toThrow(/too large/);
  });
});
