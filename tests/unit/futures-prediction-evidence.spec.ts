/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise locked replay, real archive parsing, explicit clocks and future-only grading with disposable files.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BacktestConfig, FuturesBar } from '@/features/trading';
import { normalizeFuturesResearchConfig } from '@/app/trading-futures-research-dispatch';
import type { FuturesResearchMarket } from '@/app/trading-futures-research-study';
import { normalizeFuturesPredictions } from '@/app/trading-futures-prediction-config';
import { futuresWallTimeUtc } from '@/app/trading-futures-prediction-clock';
import { readFuturesClosedBars } from '@/app/trading-futures-prediction-source';
import { buildFuturesPredictionDrafts, gradeFuturesPrediction } from '@/app/trading-futures-prediction-evidence';

const dirs: string[] = [];
const hour = 3_600_000;
const start = Date.parse('2026-01-05T00:00:00.000Z');
const study = { roots: ['ES'], source: 'kibot-file', timeframe: '1Hour', ltfTimeframe: '1Hour' };
const strategy: BacktestConfig = { instrument: { symbol: 'ES', multiplier: 50, tickSize: .25 },
  entry: { generation: 'ensemble', useLtfTrendFilter: false, allowShort: false, ensembleEntryThresholdPct: 1, riskPerTradePercent: 1 },
  startingEquity: 500000, stops: { useStrangleTrail: false } };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function csv(bars: FuturesBar[]): string {
  return bars.map(bar => { const d = new Date(bar.t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()},${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')},${bar.o},${bar.h},${bar.l},${bar.c},${bar.v}`; }).join('\n');
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'futures-prediction-')); dirs.push(dir); mkdirSync(join(dir, 'minute'));
  // Two prints per hour, including the last minute: the trailing aggregate is demonstrably closed.
  const bars: FuturesBar[] = Array.from({ length: 900 }, (_, i) => {
    const n = Math.floor(i / 2), c = 5000 + n * 2 + Math.sin(n / 8) * 10;
    return { t: new Date(start + n * hour + (i % 2 ? 59 * 60000 : 0)).toISOString(), o: c - 1, h: c + 2, l: c - 2, c, v: 1000 };
  });
  const file = join(dir, 'minute', 'ESH26.txt'); writeFileSync(file, csv(bars));
  const config = normalizeFuturesResearchConfig({ ...study, dataDir: dir, start: '2024-01-01', end: '2025-12-01', endMode: 'fixed',
    split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 }, stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} },
    predictions: { enabled: true, contracts: { ES: 'ESH26' }, sourceTimeZone: 'UTC', historyBars: 256, horizonHours: 2, gradingToleranceHours: 2 } });
  const market = { root: 'ES', evidenceFingerprint: 'a'.repeat(64), report: { windows: [{ window: { oosEnd: '2025-12-01T00:00:00.000Z' }, finalConfig: strategy }] } } as FuturesResearchMarket;
  return { config, market, bars, file, issued: new Date(start + 400 * hour).toISOString() };
}

describe('explicit forward prediction envelope', () => {
  it('keeps legacy schedules off without guessing an archive zone or contract', () => {
    expect(normalizeFuturesPredictions(undefined, study)).toMatchObject({ enabled: false, sourceTimeZone: '', contracts: {} });
  });
  it('rejects unbounded, ambiguous and mismatched console settings', () => {
    for (const raw of [null, [], { enabled: 'true' }, { enabled: true }, { horizonHours: 0 }, { historyBars: 4097 },
      { sourceTimeZone: 'guess' }, { contracts: { ES: 'CLZ26' } }, { contracts: { ES: 'ESF26' } }, { contracts: { ES: '../ESZ26' } }]) {
      expect(() => normalizeFuturesPredictions(raw, study)).toThrow();
    }
    for (const over of [{ source: 'kibot' }, { source: 'mock' }, { timeframe: '1Week' }]) {
      expect(() => normalizeFuturesPredictions({ enabled: true, contracts: { ES: 'ESZ26' }, sourceTimeZone: 'UTC' }, { ...study, ...over })).toThrow();
    }
  });
  it('resolves summer/winter explicitly and refuses both DST fold and gap', () => {
    expect(new Date(futuresWallTimeUtc('2026-07-01T12:00:00.000Z', 'America/Chicago')).toISOString()).toBe('2026-07-01T17:00:00.000Z');
    expect(new Date(futuresWallTimeUtc('2026-01-01T12:00:00.000Z', 'America/Chicago')).toISOString()).toBe('2026-01-01T18:00:00.000Z');
    for (const stamp of ['2026-11-01T01:30:00.000Z', '2026-03-08T02:30:00.000Z']) expect(() => futuresWallTimeUtc(stamp, 'America/Chicago')).toThrow(/Ambiguous or nonexistent/);
  });
});

describe('raw locked-strategy issuance and later outcomes', () => {
  it('freezes real replay inputs and deduplicates identical evidence across run clocks', () => {
    const { config, market, issued } = fixture();
    const [draft] = buildFuturesPredictionDrafts(config, [market], Date.parse(issued));
    expect(draft.status, draft.reason ?? '').toBe('pending');
    expect(draft.snapshot?.observation.bias).toBe('long');
    expect(draft.snapshot?.chart).toHaveLength(256);
    expect(draft.snapshot?.reference.closedAt).toBe(issued);
    const [repeat] = buildFuturesPredictionDrafts(config, [market], Date.parse(issued) + 1);
    expect(repeat.fingerprint).toBe(draft.fingerprint);
    expect(draft.snapshot?.chart.every(bar => bar.t < issued)).toBe(true);
  });
  it('does not score before target, uses first qualifying completed same-contract close, and retains signed ticks', () => {
    const { config, market, issued } = fixture();
    const snapshot = buildFuturesPredictionDrafts(config, [market], Date.parse(issued))[0].snapshot!;
    expect(gradeFuturesPrediction(snapshot, issued, Date.parse(issued) + hour)).toEqual({ status: 'pending', reason: null });
    const outcome = gradeFuturesPrediction(snapshot, issued, Date.parse(issued) + 4 * hour);
    expect(outcome.status).toBe('graded');
    expect(outcome.bar?.closedAt).toBe(new Date(Date.parse(issued) + 2 * hour).toISOString());
    expect(outcome.correct).toBe(true);
    expect(outcome.signedTicks).toBeCloseTo(outcome.priceChange! / .25);
    expect(gradeFuturesPrediction({ ...snapshot, observation: { ...snapshot.observation, bias: 'short' } }, issued, Date.parse(issued) + 4 * hour).correct).toBe(false);
  });
  it('keeps revised and absent reference bars unscored instead of silently rewriting inputs', () => {
    const { config, market, issued, bars, file } = fixture();
    const snapshot = buildFuturesPredictionDrafts(config, [market], Date.parse(issued))[0].snapshot!;
    const reference = snapshot.reference.bar.t;
    writeFileSync(file, csv(bars.map(bar => bar.t === reference ? { ...bar, h: bar.h + 5 } : bar)));
    expect(gradeFuturesPrediction(snapshot, issued, Date.parse(issued) + 4 * hour)).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/revised/) });
    writeFileSync(file, csv(bars.filter(bar => bar.t < reference)));
    expect(gradeFuturesPrediction(snapshot, issued, Date.parse(issued) + 4 * hour).status).toBe('unavailable');
  });
  it('withholds stale or uncompleted studies; off means no archive work', () => {
    const { config, market, issued } = fixture();
    expect(buildFuturesPredictionDrafts({ ...config, predictions: { ...config.predictions!, enabled: false } }, [], NaN)).toEqual([]);
    expect(buildFuturesPredictionDrafts(config, [], Date.parse(issued))[0]).toMatchObject({ status: 'withheld', snapshot: null });
    expect(buildFuturesPredictionDrafts(config, [market], Date.parse(issued) + 300 * hour)[0]).toMatchObject({ status: 'withheld', reason: expect.stringMatching(/Stale/) });
    const future = structuredClone(market); future.report.windows[0].window.oosEnd = '2027-01-01T00:00:00.000Z';
    expect(buildFuturesPredictionDrafts(config, [future], Date.parse(issued))[0].reason).toMatch(/not yet past/);
  });
  it('refuses malformed/duplicate OHLCV and incomplete trailing aggregates', () => {
    const { config, market, issued, bars, file } = fixture();
    const source = buildFuturesPredictionDrafts(config, [market], Date.parse(issued))[0].snapshot!.source;
    writeFileSync(file, csv(bars.slice(0, 799)));
    const closed = readFuturesClosedBars(source, '1Hour', Date.parse(issued));
    expect(closed.at(-1)?.closedAt).toBe(new Date(Date.parse(issued) - hour).toISOString());
    for (const broken of [csv([...bars, bars[0]]), csv([{ ...bars[0], h: 1 }]), `${csv(bars)}\n01/32/2026,12:00,1,2,0,1,1`, csv(bars).replace(/1000$/, 'invalid')]) {
      writeFileSync(file, broken);
      expect(() => readFuturesClosedBars(source, '1Hour', Date.parse(issued))).toThrow();
    }
  });
  it('records an abstention rather than treating no bias as a successful prediction', () => {
    const { config, market, issued } = fixture();
    market.report.windows[0].finalConfig = { ...strategy, entry: { ...strategy.entry, allowLong: false, allowShort: false } };
    const [draft] = buildFuturesPredictionDrafts(config, [market], Date.parse(issued));
    expect(draft).toMatchObject({ status: 'abstained', snapshot: { observation: { bias: null } } });
    expect(draft.reason).toContain('excluded from accuracy');
  });
  it('allows late-arriving in-window bars but never substitutes a later-than-tolerance bar', () => {
    const { config, market, issued, bars, file } = fixture();
    const snapshot = buildFuturesPredictionDrafts(config, [market], Date.parse(issued))[0].snapshot!;
    writeFileSync(file, csv(bars.filter(bar => bar.t < issued || Date.parse(bar.t) >= Date.parse(issued) + 5 * hour)));
    expect(gradeFuturesPrediction(snapshot, issued, Date.parse(issued) + 10 * hour).status).toBe('unavailable');
    writeFileSync(file, csv(bars));
    expect(gradeFuturesPrediction(snapshot, issued, Date.parse(issued) + 10 * hour).status).toBe('graded');
  });
});
