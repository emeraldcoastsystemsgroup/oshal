/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Require an explicit boolean review opt-in and keep it outside deterministic market fingerprints.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Require an explicit source-alert opt-in without changing research evidence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Guard captured Schwab source bounds, New York latest end and scheduler owner consistency.
 */
import { describe, expect, it, vi } from 'vitest';
import { FUTURES_RESEARCH_CRON_DEFAULT, dispatchTradingFuturesResearch, executeFuturesStudyOffLoop, futuresResearchTaskType, normalizeFuturesResearchConfig } from '@/app/trading-futures-research-dispatch';

describe('console-configured futures research loop', () => {
  it('normalizes the bounded nightly research contract', () => {
    const config = normalizeFuturesResearchConfig({
      roots: ['es', 'CL', 'ES'], timeframe: '1Hour', ltfTimeframe: '1Day', source: 'kibot-file',
      dataDir: 'C:\\MarketData\\kibot',
      start: '2023-01-01',
      split: { inSampleMonths: 12, oosMonths: 3, stepMonths: 3 },
      stageGrids: { Entry: { 'entry.ensembleEntryThresholdPct': [62, 70] } },
    });
    expect(config.roots).toEqual(['ES', 'CL']);
    expect(config.nightlyCron).toBe(FUTURES_RESEARCH_CRON_DEFAULT);
    expect(config.nightlyReview).toBe(false);
    expect(config.sourceAlerts).toBe(false);
    expect(normalizeFuturesResearchConfig({ ...config, sourceAlerts: true }).sourceAlerts).toBe(true);
    for (const sourceAlerts of ['true', 1, null, {}]) expect(() => normalizeFuturesResearchConfig({ ...config, sourceAlerts })).toThrow(/sourceAlerts.*boolean/);
    expect(normalizeFuturesResearchConfig({ ...config, nightlyReview: true }).nightlyReview).toBe(true);
    expect(() => normalizeFuturesResearchConfig({ ...config, nightlyReview: 'true' })).toThrow(/boolean/);
    expect(config.split).toEqual({ inSampleMonths: 12, oosMonths: 3, stepMonths: 3 });
    expect(config.stageGrids.Entry?.['entry.ensembleEntryThresholdPct']).toEqual([62, 70]);
    expect(config.endMode).toBe('latest');
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setTime(yesterday.getTime() - 1_000);
    expect(config.end).toBe(yesterday.toISOString());
    const fixed = normalizeFuturesResearchConfig({ source: 'kibot-file', dataDir: 'C:\\MarketData\\kibot', endMode: 'fixed', end: '2025-12-31T23:59:59Z' });
    expect(fixed.end).toBe('2025-12-31T23:59:59.000Z');
  });

  it('refuses unbounded or unsafe study definitions', () => {
    expect(() => normalizeFuturesResearchConfig({ roots: ['NOPE'] })).toThrow(/unknown futures root/);
    expect(() => normalizeFuturesResearchConfig({ stageGrids: { Entry: { 'entry.ensembleEntryThresholdPct': Array.from({ length: 9 }, (_, i) => i + 1) } } })).toThrow(/1-8 candidates/);
    expect(() => normalizeFuturesResearchConfig({ split: { inSampleMonths: 0 } })).toThrow(/integer/);
    expect(() => normalizeFuturesResearchConfig({ stageGrids: { Entry: { '__proto__.admin': [true] } } })).toThrow(/unsupported futures optimizer axis/);
    expect(() => normalizeFuturesResearchConfig({ stageGrids: { Sizing: { 'entry.riskPerTradePercent': [100] } } })).toThrow(/invalid candidate/);
    expect(() => normalizeFuturesResearchConfig({ split: { oosMonths: 7, stepMonths: 6 } })).toThrow(/must not overlap/);
    expect(() => normalizeFuturesResearchConfig({ start: '2024-01-01', endMode: 'fixed', end: '2024-06-01' })).toThrow(/no complete out-of-sample/);
    expect(() => normalizeFuturesResearchConfig({ endMode: 'tomorrow' })).toThrow(/unsupported futures research end mode/);
  });

  it('re-resolves the rolling end on every nightly admission but preserves a fixed study', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-24T14:00:00Z'));
      const scheduled = normalizeFuturesResearchConfig({ source: 'kibot-file', dataDir: '/data/kibot', start: '2023-01-01' });
      expect(scheduled.end).toBe('2026-09-23T23:59:59.000Z');
      vi.setSystemTime(new Date('2026-09-25T14:00:00Z'));
      expect(normalizeFuturesResearchConfig(scheduled).end).toBe('2026-09-24T23:59:59.000Z');
      expect(normalizeFuturesResearchConfig({ ...scheduled, endMode: 'fixed' }).end).toBe('2026-09-23T23:59:59.000Z');
    } finally { vi.useRealTimers(); }
  });

  it('keeps captured Schwab research on dated ES/CL, coarse bars and a completed New York day', () => {
    vi.useFakeTimers();
    vi.stubEnv('KIBOT_DATA_DIR', '/unrelated/archive');
    try {
      vi.setSystemTime(new Date('2026-09-26T02:00:00Z')); // Friday 22:00 in New York.
      const request = { roots: ['ES','CL'], source: 'schwab-capture', timeframe: '1Hour', ltfTimeframe: '1Day',
        start: '2026-05-01T00:00:00Z', split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 } };
      const config = normalizeFuturesResearchConfig(request);
      expect(config.end).toBe('2026-09-24T23:59:59.000Z');
      expect(config.dataDir).toBe('');
      vi.setSystemTime(new Date('2026-09-26T04:00:00Z')); // Saturday midnight in New York.
      expect(normalizeFuturesResearchConfig(request).end).toBe('2026-09-25T23:59:59.000Z');
      expect(() => normalizeFuturesResearchConfig({ ...request, roots: ['NQ'] })).toThrow(/supports ES\/CL/);
      expect(() => normalizeFuturesResearchConfig({ ...request, timeframe: '5Min' })).toThrow(/1Hour or 1Day/);
      expect(() => normalizeFuturesResearchConfig({ ...request, ltfTimeframe: '1Week' })).toThrow(/1Hour or 1Day/);
      expect(() => normalizeFuturesResearchConfig({ ...request, predictions: { enabled: true } })).toThrow(/require Kibot files/);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });

  it('rejects a schedule whose owner, task type and payload identity do not agree before any owner-private read', async () => {
    const base = { id: 'schwab-spec', taskType: futuresResearchTaskType('owner'), ownerSub: 'owner',
      taskData: { userSub: 'owner', futures: { source: 'schwab-capture' } } };
    for (const schedule of [
      { ...base, ownerSub: null },
      { ...base, taskType: futuresResearchTaskType('other') },
      { ...base, taskData: { ...base.taskData, userSub: 'other' } },
    ]) {
      const result = await dispatchTradingFuturesResearch({} as never, schedule as never);
      expect(result).toMatchObject({ success: false, error: 'futures research schedule owner mismatch' });
    }
  });

  it('runs a bounded synthetic study in an isolated worker and returns per-window evidence', async () => {
    const config = normalizeFuturesResearchConfig({
      roots: ['ES'], source: 'mock', timeframe: '1Day', ltfTimeframe: '1Day',
      start: '2021-01-01', endMode: 'fixed', end: '2021-05-31',
      split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
      stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} },
    });
    const markets = await executeFuturesStudyOffLoop(config);
    expect(markets).toHaveLength(1);
    expect(markets[0].report.windows.length).toBeGreaterThan(0);
    expect(markets[0].report.windows[0].stages).toHaveLength(6);
    expect(markets[0].latestCompleteOosEnd).toBe(markets[0].report.windows.at(-1)?.window.oosEnd);
    expect(markets[0].chartAsOf).toBeTruthy();
    expect(markets[0].ltfAsOf).toBeTruthy();
    expect(markets[0].evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const repeated = await executeFuturesStudyOffLoop(normalizeFuturesResearchConfig({ ...config, end: '2021-05-30T23:59:59Z', nightlyReview: true, sourceAlerts: true }));
    expect(repeated[0].evidenceFingerprint).toBe(markets[0].evidenceFingerprint);
  }, 60_000);
});
