/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove owner RLS, true-UTC gap refusal, wall-clock aggregation and worker admission of captured Schwab research bars.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeContractAt, contractsForRange } from '@/features/trading';
import { isSessionBucket } from '@/features/trading/services/futures-session-calendar';
import { executeFuturesStudyOffLoop, normalizeFuturesResearchConfig } from '@/app/trading-futures-research-dispatch';
import { SchwabCapturedFuturesDataSource } from '@/app/trading-futures-schwab-source';
import { futuresUtcToWall, futuresWallTimeUtc } from '@/app/trading-futures-prediction-clock';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const fixture = new DisposablePostgres({ purpose: 'futures-schwab-source', roles: ['oshal_app'],
  migrations: ['167-futures-schwab-owner-bars.sql'] });
const table = 'oshal_trading_futures_schwab_bars';
const contract = activeContractAt('ES', new Date('2026-09-24T19:00:00Z'))!;
const window = { start: new Date('2026-09-24T14:00:00Z'), end: new Date('2026-09-24T16:00:00Z') };
let ownerPool: Pool;

function application(sub: string): Pool {
  return new Pool({ ...fixture.roleConnection('oshal_app'), max: 2,
    options: `-c oshal.current_sub=${sub} -c oshal.is_operator=off`, connectionTimeoutMillis: 2000 });
}
function stubWorkerDatabase(): void {
  const connection = fixture.roleConnection('oshal_app');
  const dsn = new URL(`postgresql://${connection.host}:${connection.port}/${connection.database}`);
  dsn.username = connection.user; dsn.password = connection.password;
  vi.stubEnv('DATABASE_URL', dsn.toString());
}
async function insert(pool: Pool, sub: string, minutes: number[]): Promise<void> {
  for (const minute of minutes) {
    const stamp = new Date(Date.parse('2026-09-24T18:00:00Z') + minute * 60_000);
    const i = minute / 30;
    await pool.query(`INSERT INTO ${table}(owner_sub,symbol,timeframe,bar_ts,o,h,l,c,v)
      VALUES($1,$2,'30Min',$3,$4,$5,$6,$7,$8)`, [sub, contract.symbol, stamp, 100 + i, 104 + i, 99 + i, 102 + i, 7]);
  }
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
  await fixture.start();
  ownerPool = application('schwab-study-owner');
  await insert(ownerPool, 'schwab-study-owner', [0,30,60,90]);
}, 180_000);
afterAll(async () => { await ownerPool?.end(); await fixture.stop(); vi.unstubAllEnvs(); });

describe('owner-private captured Schwab research source', () => {
  it('converts true UTC only after a complete session check and aggregates volume after resampling', async () => {
    expect(contract.symbol).toBe('ESZ26');
    const source = new SchwabCapturedFuturesDataSource(ownerPool, 'schwab-study-owner', 10);
    expect(await source.fetchBars(contract, '1Hour', window)).toEqual([
      { t: '2026-09-24T14:00:00.000Z', o: 100, h: 105, l: 99, c: 103, v: 14 },
      { t: '2026-09-24T15:00:00.000Z', o: 102, h: 107, l: 101, c: 105, v: 14 },
    ]);
    await expect(source.fetchBars(contract, '5Min', window)).rejects.toThrow(/1Hour or 1Day/);
    await expect(source.fetchBars(contract, '1Week', window)).rejects.toThrow(/1Hour or 1Day/);
  });

  it('refuses missing session bars and denies cross-owner reads under forced RLS', async () => {
    const sparse = application('schwab-sparse-owner');
    const outsider = application('schwab-outsider');
    try {
      await insert(sparse, 'schwab-sparse-owner', [0,60,90]);
      await expect(new SchwabCapturedFuturesDataSource(sparse, 'schwab-sparse-owner').fetchBars(contract, '1Hour', window))
        .rejects.toMatchObject({ issue: { code: 'incomplete', root: 'ES' }, message: expect.stringContaining('2026-09-24T18:30:00.000Z') });
      expect(await new SchwabCapturedFuturesDataSource(outsider, 'schwab-study-owner', 0, false)
        .fetchBars(contract, '1Hour', window)).toEqual([]);
      await expect(new SchwabCapturedFuturesDataSource(outsider, 'schwab-study-owner').fetchBars(contract, '1Hour', window))
        .rejects.toMatchObject({ issue: { code: 'incomplete', root: 'ES' } });
    } finally { await sparse.end(); await outsider.end(); }
  });

  it('keeps an underfilled Schwab study out of the isolated optimizer worker', async () => {
    stubWorkerDatabase();
    const config = normalizeFuturesResearchConfig({ roots: ['ES'], source: 'schwab-capture', timeframe: '1Hour',
      ltfTimeframe: '1Day', start: '2026-05-01T00:00:00Z', endMode: 'fixed', end: '2026-09-24T23:59:59Z',
      split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 } });
    await expect(executeFuturesStudyOffLoop(config, undefined, 'schwab-study-owner'))
      .rejects.toMatchObject({ issue: { code: 'incomplete', root: 'ES' } });
  }, 60_000);

  it('runs a complete synthetic owner-private front-month chain through the isolated study worker', async () => {
    const owner = 'schwab-complete-owner';
    stubWorkerDatabase();
    const pool = application(owner);
    try {
      const rows: Array<{ symbol: string; bar_ts: string; o: number; h: number; l: number; c: number; v: number }> = [];
      for (let stamp = Date.parse('2026-06-01T04:00:00Z'); stamp < Date.parse('2026-09-03T04:00:00Z'); stamp += 30 * 60_000) {
        const wall = futuresUtcToWall(stamp, 'America/New_York');
        if (!isSessionBucket(wall, 30 * 60_000)) continue;
        const active = activeContractAt('ES', new Date(wall));
        if (!active) throw new Error('fixture has no active ES contract');
        const o = 4800 + (rows.length % 40) * .25;
        rows.push({ symbol: active.symbol, bar_ts: new Date(stamp).toISOString(), o, h: o + .5, l: o - .25, c: o + .25, v: 7 });
      }
      await pool.query(`INSERT INTO ${table}(owner_sub,symbol,timeframe,bar_ts,o,h,l,c,v)
        SELECT $1,x.symbol,'30Min',x.bar_ts,x.o,x.h,x.l,x.c,x.v
        FROM jsonb_to_recordset($2::jsonb) AS x(symbol text,bar_ts timestamptz,o double precision,h double precision,l double precision,c double precision,v double precision)`,
      [owner, JSON.stringify(rows)]);
      const request = { roots: ['ES'], source: 'schwab-capture',
        timeframe: '1Day', ltfTimeframe: '1Day', start: '2026-06-01T00:00:00Z',
        endMode: 'fixed', end: '2026-09-02T23:59:59Z',
        split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
        stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} } };
      await expect(executeFuturesStudyOffLoop(normalizeFuturesResearchConfig(request), undefined, owner))
        .rejects.toMatchObject({ issue: { code: 'incomplete', root: 'ES' },
          message: expect.stringContaining('roll lacks overlapping dated-contract bars') });
      const incoming = contractsForRange('ES', new Date(request.start), new Date(request.end))
        .find(item => item.symbol === 'ESU26');
      if (!incoming) throw new Error('fixture lacks incoming contract');
      const rollUtc = futuresWallTimeUtc(incoming.activeStart.toISOString(), 'America/New_York');
      const overlap = rows.filter(row => row.symbol !== incoming.symbol
        && Date.parse(row.bar_ts) >= rollUtc - 72 * 3_600_000 && Date.parse(row.bar_ts) < rollUtc)
        .map(row => ({ ...row, symbol: incoming.symbol, o: row.o + 10, h: row.h + 10,
          l: row.l + 10, c: row.c + 10 }));
      expect(overlap.length).toBeGreaterThan(0);
      await pool.query(`INSERT INTO ${table}(owner_sub,symbol,timeframe,bar_ts,o,h,l,c,v)
        SELECT $1,x.symbol,'30Min',x.bar_ts,x.o,x.h,x.l,x.c,x.v
        FROM jsonb_to_recordset($2::jsonb) AS x(symbol text,bar_ts timestamptz,o double precision,h double precision,l double precision,c double precision,v double precision)`,
      [owner, JSON.stringify(overlap)]);
      const rolled = await executeFuturesStudyOffLoop(normalizeFuturesResearchConfig(request), undefined, owner);
      expect(rolled).toHaveLength(1);
      expect(rolled[0].report.windows).toHaveLength(2);
      const config = normalizeFuturesResearchConfig({ ...request, start: '2026-07-01T00:00:00Z' });
      const markets = await executeFuturesStudyOffLoop(config, undefined, owner);
      expect(markets).toHaveLength(1);
      expect(markets[0].report.windows).toHaveLength(1);
      expect(markets[0].bars).toBeGreaterThan(35);
      expect(markets[0].computation?.status).toBe('computed');
    } finally { await pool.end(); }
  }, 120_000);
});
