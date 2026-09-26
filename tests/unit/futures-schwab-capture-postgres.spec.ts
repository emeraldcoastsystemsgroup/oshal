/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove private Schwab bar capture, immutable replay and owner RLS against disposable PostgreSQL.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assessSchwabCaptureHealth, captureSchwabFuturesBars, listSchwabFuturesCoverage, listSchwabFuturesHealth, parseSchwabFuturesCandles,
  readSchwabFuturesWallBars } from '@/app/trading-futures-schwab-capture';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const fixture = new DisposablePostgres({ purpose: 'futures-schwab-capture', roles: ['oshal_app'],
  migrations: ['167-futures-schwab-owner-bars.sql'] });
const owner = 'schwab-capture-owner';
const other = 'schwab-capture-other';
const now = Date.UTC(2026, 8, 25, 20);
const stamp = Date.UTC(2026, 8, 24, 19);
const candle = { datetime: stamp, open: 100, high: 103, low: 99, close: 102, volume: 20 };
let pool: Pool;

beforeAll(async () => {
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
  pool = await fixture.start();
}, 180_000);
afterAll(async () => { await fixture.stop(); vi.unstubAllEnvs(); });

function provider(payload = { candles: [candle] }) {
  return vi.fn(async () => Response.json(payload)) as unknown as typeof fetch;
}
function application(sub: string): Pool {
  return new Pool({ ...fixture.roleConnection('oshal_app'), max: 3,
    options: `-c oshal.current_sub=${sub} -c oshal.is_operator=off`, connectionTimeoutMillis: 2000 });
}

describe('private Schwab Futures forward bars', () => {
  it('counts true-UTC session slots, ignores closed weekends and exposes a trailing gap without inventing history', () => {
    const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 8, 24, hour, minute)).toISOString();
    const gap = assessSchwabCaptureHealth('ES', 'ESZ26', [at(14,0), at(15,0), at(15,30)], Date.UTC(2026,8,24,16,4));
    expect(gap).toMatchObject({ state: 'missing', expected: 4, received: 3, missing: 1, trailingMissing: 0, gapCount: 1,
      largestGaps: [{ first: at(14,30), last: at(14,30), missingBars: 1 }] });
    const friday = new Date(Date.UTC(2026,8,25,20,30)).toISOString();
    const closed = assessSchwabCaptureHealth('ES', 'ESZ26', [friday], Date.UTC(2026,8,27,20));
    expect(closed).toMatchObject({ state: 'covered', expected: 1, received: 1, missing: 0, trailingMissing: 0 });
    expect(assessSchwabCaptureHealth('CL', 'CLX26', [], Date.UTC(2026,8,25,20))).toMatchObject({
      state: 'unobserved', expected: null, missing: null, latestCaptured: null });
  });

  it('does not double-count the fall DST fold or fabricate a Sunday-open bar before it closes', () => {
    const friday = new Date(Date.UTC(2026,9,30,20,30)).toISOString();
    const beforeOpenClose = assessSchwabCaptureHealth('ES', 'ESZ26', [friday], Date.UTC(2026,10,1,23,4));
    expect(beforeOpenClose).toMatchObject({ expected: 1, missing: 0, trailingMissing: 0 });
    const afterOpenClose = assessSchwabCaptureHealth('ES', 'ESZ26', [friday], Date.UTC(2026,10,1,23,35));
    expect(afterOpenClose).toMatchObject({ expected: 2, missing: 1, trailingMissing: 1, latestExpected: '2026-11-01T23:00:00.000Z' });
  });
  it('rejects malformed, unaligned, duplicate and still-forming candles', () => {
    expect(parseSchwabFuturesCandles({ candles: [candle] }, now)).toEqual([{ t: new Date(stamp).toISOString(), o: 100, h: 103, l: 99, c: 102, v: 20 }]);
    expect(() => parseSchwabFuturesCandles({ candles: [{ ...candle, datetime: stamp + 1 }] }, now)).toThrow(/Invalid/);
    expect(() => parseSchwabFuturesCandles({ candles: [candle, candle] }, now)).toThrow(/duplicate/);
    expect(() => parseSchwabFuturesCandles({ candles: [{ ...candle, high: 101 }] }, now)).toThrow(/Invalid/);
    expect(parseSchwabFuturesCandles({ candles: [{ ...candle, datetime: now - 1_800_000 }] }, now)).toEqual([]);
  });

  it('captures dated contracts once, converts the clock for research and denies other owners', async () => {
    const app = application(owner);
    try {
      const fetcher = provider();
      const first = await captureSchwabFuturesBars(app, owner, 'test-token', ['ES', 'CL'], fetcher, now);
      expect(first.series).toHaveLength(2);
      expect(first.series.map(series => series.inserted)).toEqual([1, 1]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(String(fetcher.mock.calls[0][0])).toContain('/pricehistory?');
      const second = await captureSchwabFuturesBars(app, owner, 'test-token', ['ES', 'CL'], provider(), now);
      expect(second.series.map(series => series.inserted)).toEqual([0, 0]);
      const coverage = await listSchwabFuturesCoverage(app, owner);
      expect(coverage).toHaveLength(2);
      expect(coverage.map(item => item.bars)).toEqual([1, 1]);
      const health = await listSchwabFuturesHealth(app, owner, now);
      expect(health).toHaveLength(2);
      expect(health.every(item => item.root === 'ES' || item.root === 'CL')).toBe(true);
      expect(health.every(item => item.received <= item.expected!)).toBe(true);
      const wall = await readSchwabFuturesWallBars(app, owner, coverage[0].symbol, '2026-09-24', '2026-09-25');
      expect(wall).toEqual([{ t: '2026-09-24T15:00:00.000Z', o: 100, h: 103, l: 99, c: 102, v: 20 }]);
      const outsider = application(other);
      try {
        expect(await listSchwabFuturesCoverage(outsider, owner)).toEqual([]);
        expect((await listSchwabFuturesHealth(outsider, owner, now)).every(item => item.state === 'unobserved')).toBe(true);
        expect(await readSchwabFuturesWallBars(outsider, owner, coverage[0].symbol, '2026-09-24', '2026-09-25')).toEqual([]);
        await expect(captureSchwabFuturesBars(outsider, owner, 'test-token', ['ES'], provider(), now)).rejects.toThrow();
      } finally { await outsider.end(); }
      expect((await pool.query('SELECT count(*)::int AS n FROM oshal_trading_futures_schwab_bars')).rows[0].n).toBe(2);
    } finally { await app.end(); }
  }, 60_000);

  it('refuses revised closed bars without replacing stored evidence', async () => {
    const app = application(owner);
    try {
      const revised = provider({ candles: [{ ...candle, close: 101 }] });
      await expect(captureSchwabFuturesBars(app, owner, 'test-token', ['ES'], revised, now)).rejects.toThrow(/revised/);
      const rows = (await app.query('SELECT DISTINCT c FROM oshal_trading_futures_schwab_bars WHERE owner_sub=$1', [owner])).rows;
      expect(rows).toEqual([{ c: 102 }]);
    } finally { await app.end(); }
  }, 60_000);
});
