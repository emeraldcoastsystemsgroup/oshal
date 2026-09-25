/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Cross actual archive files, isolated workers, confirmed import transactions, reference readers and enforcing RLS without a deployment database.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractsForRange } from '@/features/trading';
import { previewFuturesArchive, confirmFuturesArchive, listFuturesArchiveImports } from '@/app/trading-futures-archive-import';
import { FUTURES_ARCHIVE_CONFIRM, normalizeFuturesArchiveConfig } from '@/app/trading-futures-archive-config';
import { prepareFuturesArchive } from '@/app/trading-futures-archive-source';
import { barCoverage, readBars, latestClose, upsertBars } from '@/app/trading-bar-store';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const fixture = new DisposablePostgres({ purpose: 'futures-archive-import', roles: ['oshal_app'],
  migrations: ['096-market-bars.sql', '162-futures-archive-imports.sql'] });
const owner = 'archive-owner', other = 'archive-other';
const directory = mkdtempSync(join(tmpdir(), 'futures-import-'));
const config = { roots: ['ES', 'CL'], timeframes: ['1Hour', '1Day'], dataDir: directory, sourceTimeZone: 'America/New_York',
  start: '2025-10-01', end: '2025-10-01', minVolume: 1 };
const symbols = config.roots.map(root => contractsForRange(root, new Date(config.start), new Date(config.end))[0].symbol);
const minute = '10/01/2025,10:00,100,101,99,100,50\n10/01/2025,10:59,100,103,99,102,50\n10/01/2025,11:15,102,103,101,102,50\n';
let pool: Pool;
beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', `${owner},${other}`);
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
  pool = await fixture.start();
  for (const folder of ['minute', 'daily']) mkdirSync(join(directory, folder));
}, 180_000);
beforeEach(async () => {
  await pool.query('TRUNCATE market_bars,oshal_trading_futures_archive_imports');
  for (const symbol of symbols) {
    writeFileSync(join(directory, 'minute', `${symbol}.txt`), minute);
    writeFileSync(join(directory, 'daily', `${symbol}.txt`), '10/01/2025,100,103,99,102,100\n');
  }
});
afterAll(async () => { await fixture.stop(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function settled(id: string, database: Pool = pool) {
  let result!: Awaited<ReturnType<typeof listFuturesArchiveImports>>[number];
  await vi.waitFor(async () => {
    result = (await listFuturesArchiveImports(database, owner)).find(job => job.importId === id)!;
    expect(['ready', 'completed', 'failed']).toContain(result.status);
  }, { timeout: 30_000 });
  return result;
}
async function ready(database: Pool = pool) {
  const job = await settled((await previewFuturesArchive(database, owner, config)).importId, database);
  expect(job.status, job.error ?? '').toBe('ready'); return job;
}
async function commit(job: Awaited<ReturnType<typeof ready>>, database: Pool = pool) {
  await confirmFuturesArchive(database, owner, job.importId, { confirmation: FUTURES_ARCHIVE_CONFIRM, fingerprint: job.plan!.fingerprint });
  return settled(job.importId, database);
}

describe('real Futures archive import and persistence', () => {
  it('completes the actual service through the non-superuser application role and migration grants', async () => {
    const application = new Pool({ ...fixture.roleConnection('oshal_app'), max: 3,
      options: `-c oshal.current_sub=${owner} -c oshal.is_operator=off`, connectionTimeoutMillis: 2000 });
    try {
      expect((await application.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(await commit(await ready(application), application)).toMatchObject({ status: 'completed', inserted: 4, unchanged: 0 });
      expect(await listFuturesArchiveImports(application, other)).toEqual([]);
      expect((await readBars(application, symbols[0], '1Hour', '2025-10-01', '2025-10-02'))[0].t).toBe('2025-10-01T14:00:00.000Z');
    } finally { await application.end(); }
  }, 60_000);
  it('previews without writing, then imports both roots/timeframes and matches canonical readers', async () => {
    const preview = await ready();
    expect(preview.plan?.totalBars).toBe(4);
    expect(preview.plan?.incomplete).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n).toBe(0);
    const result = await commit(preview);
    expect(result).toMatchObject({ status: 'completed', inserted: 4, unchanged: 0, plan: preview.plan, config: normalizeFuturesArchiveConfig(config) });
    for (const symbol of symbols) {
      expect(await barCoverage(pool, symbol, '1Hour')).toMatchObject({ count: 1, firstIso: '2025-10-01T14:00:00.000Z', lastIso: '2025-10-01T14:00:00.000Z' });
      expect(await readBars(pool, symbol, '1Hour', '2025-10-01', '2025-10-02')).toEqual([{ t: '2025-10-01T14:00:00.000Z', o: 100, h: 103, l: 99, c: 102, v: 100 }]);
      expect(await latestClose(pool, symbol, '1Day')).toBe(102);
      expect((await barCoverage(pool, symbol, '1Day')).firstIso).toBe('2025-10-01T04:00:00.000Z');
    }
    expect((await pool.query('SELECT DISTINCT source FROM market_bars')).rows).toEqual([{ source: 'kibot-file:utc-v1:America/New_York' }]);
  }, 60_000);
  it('is idempotent across new previews and replays completed receipts without rereading files', async () => {
    const first = await commit(await ready());
    const before = (await pool.query('SELECT * FROM market_bars ORDER BY symbol,timeframe,bar_ts')).rows;
    const second = await commit(await ready());
    expect(second).toMatchObject({ status: 'completed', inserted: 0, unchanged: 4 });
    expect((await pool.query('SELECT * FROM market_bars ORDER BY symbol,timeframe,bar_ts')).rows).toEqual(before);
    writeFileSync(join(directory, 'minute', `${symbols[0]}.txt`), 'invalid source now');
    expect(await confirmFuturesArchive(pool, owner, first.importId, { confirmation: FUTURES_ARCHIVE_CONFIRM, fingerprint: first.plan!.fingerprint })).toEqual(first);
    expect((await pool.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n).toBe(4);
  }, 60_000);
  it('refuses anonymous authority, foreign previews, wrong citations and missing or extra confirmation fields', async () => {
    await expect(previewFuturesArchive(pool, 'ordinary', config)).rejects.toMatchObject({ statusCode: 403 });
    const job = await ready();
    for (const body of [{}, { confirmation: FUTURES_ARCHIVE_CONFIRM, fingerprint: 'wrong' },
      { confirmation: FUTURES_ARCHIVE_CONFIRM, fingerprint: job.plan!.fingerprint, ownerSub: owner }]) {
      await expect(confirmFuturesArchive(pool, owner, job.importId, body)).rejects.toThrow();
    }
    await expect(confirmFuturesArchive(pool, other, job.importId, { confirmation: FUTURES_ARCHIVE_CONFIRM, fingerprint: job.plan!.fingerprint })).rejects.toMatchObject({ statusCode: 404 });
    expect(await listFuturesArchiveImports(pool, other)).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n).toBe(0);
  });
  it('rejects source drift after approval before committing any shared data', async () => {
    const job = await ready();
    const file = join(directory, 'minute', `${symbols[0]}.txt`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('100,103,99,102,50', '100,104,99,103,50'));
    const result = await commit(job);
    expect(result.status).toBe('failed'); expect(result.error).toContain('changed since preview');
    expect(result.plan).toEqual(job.plan);
    expect((await pool.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n).toBe(0);
  });
  it('freezes ready preview settings and refuses import after operator access is revoked', async () => {
    const job = await ready();
    await expect(pool.query("UPDATE oshal_trading_futures_archive_imports SET config='{}'::jsonb WHERE import_id=$1", [job.importId])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE oshal_trading_futures_archive_imports SET plan='{}'::jsonb WHERE import_id=$1", [job.importId])).rejects.toThrow(/immutable/);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', other);
    try { await expect(commit(job)).rejects.toMatchObject({ statusCode: 403 }); }
    finally { vi.stubEnv('OSHAL_OPERATOR_SUBS', `${owner},${other}`); }
    expect((await pool.query('SELECT count(*)::int AS n FROM market_bars')).rows[0].n).toBe(0);
  });
  it.each(['price', 'provenance'])('rolls back all new rows on a later-series %s conflict without replacing old rows', async kind => {
    const job = await ready(), symbol = symbols[0]; // ES sorts after CL in the prepared plan.
    await upsertBars(pool, symbol, '1Hour', kind === 'price' ? 'kibot-file:utc-v1:America/New_York' : 'legacy-other-clock',
      [{ t: '2025-10-01T14:00:00.000Z', o: 100, h: 103, l: 99, c: kind === 'price' ? 101 : 102, v: 100 }]);
    const before = (await pool.query('SELECT * FROM market_bars')).rows;
    const result = await commit(job);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/conflict|different stored source/);
    expect((await pool.query('SELECT * FROM market_bars')).rows).toEqual(before);
  });
  it('refuses concurrent worker admission and fences duplicate confirmation', async () => {
    const first = await previewFuturesArchive(pool, owner, config);
    await expect(previewFuturesArchive(pool, other, config)).rejects.toMatchObject({ code: '23505' });
    const job = await settled(first.importId);
    const replies = await Promise.allSettled([1, 2].map(() => confirmFuturesArchive(pool, owner, job.importId,
      { confirmation: FUTURES_ARCHIVE_CONFIRM, fingerprint: job.plan!.fingerprint })));
    expect(replies.filter(reply => reply.status === 'fulfilled')).toHaveLength(1);
    expect((await settled(job.importId)).status).toBe('completed');
  });
  it('keeps owner previews and immutable completed receipts behind the enforcing RLS role', async () => {
    const job = await commit(await ready()), client = await fixture.rolePool('oshal_app').connect();
    try {
      await client.query("SELECT set_config('oshal.current_sub',$1,false),set_config('oshal.is_operator','off',false)", [other]);
      expect((await client.query('SELECT * FROM oshal_trading_futures_archive_imports')).rows).toEqual([]);
      expect((await client.query("UPDATE oshal_trading_futures_archive_imports SET status='ready' RETURNING import_id")).rows).toEqual([]);
      await client.query("SELECT set_config('oshal.current_sub',$1,false)", [owner]);
      expect((await client.query('SELECT import_id FROM oshal_trading_futures_archive_imports')).rows[0].import_id).toBe(job.importId);
      await expect(client.query("UPDATE oshal_trading_futures_archive_imports SET plan='{}'::jsonb")).rejects.toThrow(/immutable/);
      await expect(client.query("UPDATE oshal_trading_futures_archive_imports SET status='ready'")).rejects.toThrow(/immutable/);
    } finally { client.release(); }
  });
  it('rejects malformed and missing data honestly without a preview ready for import', async () => {
    writeFileSync(join(directory, 'minute', `${symbols[0]}.txt`), minute + '10/01/2025,12:00,broken\n');
    const job = await settled((await previewFuturesArchive(pool, owner, config)).importId);
    expect(job).toMatchObject({ status: 'failed', plan: null, inserted: null });
    expect(job.error).not.toContain(directory);
    await expect(prepareFuturesArchive({ ...config, dataDir: join(directory, 'absent') })).rejects.toThrow(/not configured/);
  });
});
