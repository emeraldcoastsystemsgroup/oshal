/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify real Futures admission, owner scope and durable study settlement.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Apply the review-state migration before validate-only runtime proof.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Persist insufficient sample evidence and stale-file worker failures without fabricating study results.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Prove JSONB report reuse across real workers while preserving exact owner/schedule scope.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Apply the owned source-alert column before validate-only runtime proof.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import type { AppContext } from '@/app/composition-root';
import { listFuturesResearchRuns, runFuturesResearch } from '@/app/trading-futures-research-dispatch';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const database = new DisposablePostgres({ purpose: 'futures-research-ledger', database: 'futures_fixture', memory: '384m', max: 4, statementTimeoutMs: 60_000, roles: ['oshal_app'] });
let pool: Pool;

beforeAll(async () => { pool = await database.start(); }, 180_000);
afterAll(async () => { await database.stop(); });

const config = {
  roots: ['ES'], source: 'mock', timeframe: '1Day', ltfTimeframe: '1Day',
  start: '2021-01-01', endMode: 'fixed', end: '2021-05-31',
  split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
  stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} },
};

async function settled(owner: string, runId: string): Promise<Awaited<ReturnType<typeof listFuturesResearchRuns>>[number]> {
  for (let i = 0; i < 200; i++) {
    const run = (await listFuturesResearchRuns(pool as AppContext['pool'], owner)).find((entry) => entry.runId === runId);
    if (run && run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('futures research run did not settle in 10 seconds');
}

describe('futures research durable ledger', () => {
  it('the owner migration provisions a forced-RLS ledger for validate-only runtime', async () => {
    await pool.query(readFileSync(resolve('scripts/migrations/159-futures-research-runs.sql'), 'utf8'));
    await pool.query(readFileSync(resolve('scripts/migrations/160-futures-research-review.sql'), 'utf8'));
    await pool.query(readFileSync(resolve('scripts/migrations/163-futures-source-alerts.sql'), 'utf8'));
    const previous = process.env.OSHAL_SCHEMA_BOOTSTRAP;
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'validate-only';
    try { expect(await listFuturesResearchRuns(pool as AppContext['pool'], 'owner-a')).toEqual([]); }
    finally {
      if (previous === undefined) delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
      else process.env.OSHAL_SCHEMA_BOOTSTRAP = previous;
    }
    const proof = (await pool.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege('oshal_app', c.oid, 'SELECT') AS app_can_read FROM pg_class c WHERE c.oid='oshal_trading_futures_research_runs'::regclass`)).rows[0];
    expect(proof).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, app_can_read: true });
  });

  it('admits one bounded worker, prevents overlap and scopes full evidence to the owner', async () => {
    const createTicket = vi.fn(async () => ({}));
    const ctx = { pool, ticketService: { createTicket } } as unknown as AppContext;
    const started = await runFuturesResearch(ctx, 'owner-a', 'schedule-a', config);
    expect(started.status).toBe('running');
    await expect(runFuturesResearch(ctx, 'owner-b', 'schedule-b', config)).rejects.toMatchObject({ code: '23505' });
    const finished = await settled('owner-a', started.runId);
    expect(finished.status).toBe('insufficient_sample');
    expect(finished.markets[0].quality?.sampleStatus).toBe('insufficient');
    expect(finished.markets[0].quality?.lowTradeWindows.length).toBeGreaterThan(0);
    expect(finished.completedAt).not.toBeNull();
    expect(finished.markets[0].report.windows.length).toBeGreaterThan(0);
    expect(finished.markets[0].evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(finished.markets[0].computation?.status).toBe('computed');
    expect((await listFuturesResearchRuns(pool as AppContext['pool'], 'owner-b'))).toEqual([]);
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
      sampleStatus: 'insufficient_sample', markets: expect.arrayContaining([expect.objectContaining({ quality: finished.markets[0].quality })]),
    }) }));
    const repeat = await runFuturesResearch(ctx, 'owner-a', 'schedule-a', { ...config, end: '2021-05-30T23:59:59Z' });
    const unchanged = await settled('owner-a', repeat.runId);
    expect(unchanged.status).toBe('unchanged');
    expect(unchanged.markets[0].evidenceFingerprint).toBe(finished.markets[0].evidenceFingerprint);
    expect(unchanged.markets[0].computation).toMatchObject({ status: 'reused', reusedFromRunId: started.runId });
    expect(createTicket).toHaveBeenCalledTimes(1);
    const changed = await runFuturesResearch(ctx, 'owner-a', 'schedule-a', { ...config, stageGrids: { ...config.stageGrids, Entry: { 'entry.ensembleEntryThresholdPct': [62] } } });
    const newEvidence = await settled('owner-a', changed.runId);
    expect(newEvidence.status).toBe('insufficient_sample');
    expect(newEvidence.markets[0].evidenceFingerprint).not.toBe(finished.markets[0].evidenceFingerprint);
    expect(newEvidence.markets[0].computation?.status).toBe('computed');
    expect(createTicket).toHaveBeenCalledTimes(2);
    await pool.query('GRANT SELECT ON oshal_trading_futures_research_runs TO oshal_app');
    const enforcing = await database.rolePool('oshal_app').connect();
    try {
      const identity = async (sub: string): Promise<void> => {
        await enforcing.query("SELECT set_config('oshal.current_sub', $1, false), set_config('oshal.is_operator', 'off', false)", [sub]);
      };
      await identity('owner-b');
      expect((await enforcing.query('SELECT run_id FROM oshal_trading_futures_research_runs')).rows).toEqual([]);
      await identity('owner-a');
      expect((await enforcing.query('SELECT run_id FROM oshal_trading_futures_research_runs')).rows.map((row) => String(row.run_id))).toContain(started.runId);
    } finally { enforcing.release(); }
  }, 180_000);

  it('never reuses another owner or schedule, and ignores caller-supplied cache fields', async () => {
    const ctx = { pool, ticketService: { createTicket: vi.fn(async () => ({})) } } as unknown as AppContext;
    const previous = (await listFuturesResearchRuns(pool as AppContext['pool'], 'owner-a'))[0];
    for (const [owner, schedule] of [['owner-b', 'schedule-a'], ['owner-a', 'schedule-other']]) {
      const started = await runFuturesResearch(ctx, owner, schedule, { ...previous.config, previous, generation: 'caller-value' });
      const finished = await settled(owner, started.runId);
      expect(finished.markets[0].computation?.status).toBe('computed');
      expect(finished.markets[0].computation?.reusedFromRunId).toBeUndefined();
    }
  }, 180_000);

  it('reuses the latest unchanged receipt repeatedly without another completion ticket', async () => {
    const createTicket = vi.fn(async () => ({}));
    const ctx = { pool, ticketService: { createTicket } } as unknown as AppContext;
    let prior: string | undefined;
    for (let i = 0; i < 3; i++) {
      const started = await runFuturesResearch(ctx, 'owner-a', 'schedule-chain', config);
      const finished = await settled('owner-a', started.runId);
      expect(finished.markets[0].computation?.status).toBe(i ? 'reused' : 'computed');
      expect(finished.markets[0].computation?.reusedFromRunId).toBe(prior);
      expect(finished.status).toBe(i ? 'unchanged' : 'insufficient_sample');
      prior = started.runId;
    }
    expect(createTicket).toHaveBeenCalledTimes(1);
  }, 180_000);

  it('records missing-data failure without fabricating an OOS result', async () => {
    const createTicket = vi.fn(async () => ({}));
    const ctx = { pool, ticketService: { createTicket } } as unknown as AppContext;
    const started = await runFuturesResearch(ctx, 'owner-a', 'schedule-a', { ...config, source: 'kibot-file', dataDir: '/no-such-futures-archive' });
    const finished = await settled('owner-a', started.runId);
    expect(finished.status).toBe('failed');
    expect(finished.markets).toEqual([]);
    expect(finished.error).toMatch(/empty|configured|no.*file/i);
    expect(createTicket).not.toHaveBeenCalled();
  }, 180_000);

  it('retains a stale-file refusal across the real worker and database without a completion ticket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'futures-stale-ledger-'));
    const createTicket = vi.fn(async () => ({}));
    const ctx = { pool, ticketService: { createTicket } } as unknown as AppContext;
    try {
      mkdirSync(join(dir, 'minute'));
      writeFileSync(join(dir, 'minute', 'ESH21.txt'), '01/04/2021,10:00,3700,3701,3699,3700,900\n');
      const started = await runFuturesResearch(ctx, 'owner-a', 'schedule-a', { ...config, source: 'kibot-file', dataDir: dir });
      const failed = await settled('owner-a', started.runId);
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/stale Futures source.*2021-01-04.*Optimizer not run/);
      expect(failed.markets).toEqual([]);
      expect(failed.config.quality).toEqual({ maxSourceLagDays: 7, minOosTradesPerWindow: 10 });
      expect(createTicket).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});
