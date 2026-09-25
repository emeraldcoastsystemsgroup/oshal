/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove review admission, retries, immutable evidence and FORCE RLS on private PostgreSQL; inference is an explicit fixture.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import type { AppContext } from '@/app/composition-root';
import { normalizeFuturesResearchConfig, listFuturesResearchRuns } from '@/app/trading-futures-research-dispatch';
import { reviewFuturesResearchRun } from '@/app/trading-futures-research-review';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const rails = vi.hoisted(() => ({ execute: vi.fn(), resolve: vi.fn(), registry: vi.fn() }));
vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: rails.execute }));
vi.mock('@/app/routes/free-tier-rotation', () => ({ resolveUserLlmConnection: rails.resolve }));
vi.mock('@/app/extensions/swarm/swarm-bot-registry', () => ({ getActiveRegistry: rails.registry }));
const database = new DisposablePostgres({ purpose: 'futures-research-review', database: 'review_fixture', memory: '384m', roles: ['oshal_app'] });
const owner = 'futures-review-owner', other = 'futures-other-owner';
let pool: Pool, ctx: AppContext;
const previousOperators = process.env.OSHAL_OPERATOR_SUBS;
const config = normalizeFuturesResearchConfig({ source: 'mock', roots: ['ES'], start: '2021-01-01', endMode: 'fixed', end: '2021-05-31',
  split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
  stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} } });
const markets = [{ root: 'ES', evidenceFingerprint: 'b'.repeat(64), outOfSampleNet: -25, outOfSampleTrades: 2,
  worstOutOfSampleMaxDD: 30, report: { windows: [] } }];
const valid = JSON.stringify({ summary: 'Losses in a small historical fixture.', limitations: ['No live or forward evidence.'],
  evidence: [{ root: 'ES', fingerprint: markets[0].evidenceFingerprint }], nextStudy: null });
beforeAll(async () => {
  process.env.OSHAL_OPERATOR_SUBS = `${owner},${other}`;
  pool = await database.start(); ctx = { pool } as unknown as AppContext;
  for (const name of ['159-futures-research-runs', '160-futures-research-review']) await pool.query(readFileSync(`scripts/migrations/${name}.sql`, 'utf8'));
}, 180_000);
afterAll(async () => {
  if (previousOperators === undefined) delete process.env.OSHAL_OPERATOR_SUBS; else process.env.OSHAL_OPERATOR_SUBS = previousOperators;
  await database.stop();
});
async function insert(status = 'completed'): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO oshal_trading_futures_research_runs(run_id,owner_sub,schedule_id,status,config,markets,completed_at)
    VALUES($1,$2,'fixture',$3,$4::jsonb,$5::jsonb,now())`, [id, owner, status, JSON.stringify(config), JSON.stringify(markets)]);
  return id;
}

describe('Futures review real ledger with fixture inference', () => {
  it('refuses non-operators, other owners, invalid ids and incomplete studies before inference', async () => {
    const id = await insert(), reviewer = vi.fn(async () => valid);
    await expect(reviewFuturesResearchRun(ctx, 'ordinary', id, reviewer)).rejects.toMatchObject({ statusCode: 403 });
    await expect(reviewFuturesResearchRun(ctx, other, id, reviewer)).rejects.toMatchObject({ statusCode: 404 });
    await expect(reviewFuturesResearchRun(ctx, owner, 'invalid', reviewer)).rejects.toMatchObject({ statusCode: 400 });
    await expect(reviewFuturesResearchRun(ctx, owner, await insert('failed'), reviewer)).rejects.toMatchObject({ statusCode: 409 });
    expect(reviewer).not.toHaveBeenCalled();
  });
  it('persists one review, reuses it on duplicate clicks and preserves all deterministic evidence', async () => {
    const id = await insert(), reviewer = vi.fn(async () => valid);
    const result = await reviewFuturesResearchRun(ctx, owner, id, reviewer);
    expect(result.status).toBe('completed');
    expect(await reviewFuturesResearchRun(ctx, owner, id, reviewer)).toEqual(result);
    expect(reviewer).toHaveBeenCalledTimes(1);
    const row = (await listFuturesResearchRuns(ctx.pool, owner)).find(run => run.runId === id)!;
    expect(row).toMatchObject({ config, markets, status: 'completed', review: result });
    expect(await listFuturesResearchRuns(ctx.pool, other)).toEqual([]);
  });
  it('records invalid output as failed, then admits a fresh attempt without rewriting study success', async () => {
    const id = await insert();
    const failed = await reviewFuturesResearchRun(ctx, owner, id, async () => '{"orders":["buy"]}');
    expect(failed.status).toBe('failed');
    expect(failed.result).toBeUndefined();
    const completed = await reviewFuturesResearchRun(ctx, owner, id, async () => valid);
    expect(completed.status).toBe('completed');
    expect(completed.attemptId).not.toBe(failed.attemptId);
  });
  it('blocks overlapping calls and fences a late reply after an interrupted attempt is reclaimed', async () => {
    const id = await insert();
    let release!: (value: string) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<string>(resolve => { release = resolve; });
    const pending = reviewFuturesResearchRun(ctx, owner, id, async () => { started(); return response; });
    await entered;
    await expect(reviewFuturesResearchRun(ctx, owner, id, async () => valid)).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(`UPDATE oshal_trading_futures_research_runs SET review=jsonb_set(review,'{requestedAt}',to_jsonb((now()-interval '2 hours')::text)) WHERE run_id=$1`, [id]);
    const replacement = await reviewFuturesResearchRun(ctx, owner, id, async () => valid);
    const superseded = expect(pending).rejects.toMatchObject({ statusCode: 409 });
    release(valid); await superseded;
    expect((await pool.query(`SELECT review FROM oshal_trading_futures_research_runs WHERE run_id=$1`, [id])).rows[0].review).toEqual(replacement);
  });
  it('keeps reviews inside the forced owner RLS boundary using the enforcing application role', async () => {
    const id = await insert(); await reviewFuturesResearchRun(ctx, owner, id, async () => valid);
    const client = await database.rolePool('oshal_app').connect();
    try {
      await client.query("SELECT set_config('oshal.current_sub',$1,false),set_config('oshal.is_operator','off',false)", [other]);
      expect((await client.query('SELECT review FROM oshal_trading_futures_research_runs WHERE run_id=$1', [id])).rows).toEqual([]);
      expect((await client.query("UPDATE oshal_trading_futures_research_runs SET review=null WHERE run_id=$1 RETURNING run_id", [id])).rows).toEqual([]);
      await client.query("SELECT set_config('oshal.current_sub',$1,false)", [owner]);
      expect((await client.query('SELECT review FROM oshal_trading_futures_research_runs WHERE run_id=$1', [id])).rows[0].review.status).toBe('completed');
    } finally { client.release(); }
  });
  it('threads the exact owner and unique task into the accounted tool-less hosted bot rail', async () => {
    rails.registry.mockReturnValue([{ name: 'futures-research-analyst', agentId: 'fixture-reviewer' }]);
    rails.resolve.mockResolvedValue({ baseUrl: 'https://fixture.invalid', apiKey: 'fixture', resolutionSource: 'explicit' });
    rails.execute.mockResolvedValue({ success: true, response: valid });
    const id = await insert(), result = await reviewFuturesResearchRun(ctx, owner, id);
    expect(result.status).toBe('completed');
    expect(rails.resolve).toHaveBeenCalledWith(ctx.pool, owner);
    expect(rails.execute.mock.calls.at(-1)?.[3]).toMatchObject({ agentId: 'fixture-reviewer', userSub: owner, agenticMode: false,
      direct: true, taskId: `futures-review-${result.attemptId}`, byoLlmResolutionSource: 'explicit' });
    rails.resolve.mockResolvedValue(undefined);
    const calls = rails.execute.mock.calls.length;
    expect((await reviewFuturesResearchRun(ctx, owner, await insert())).status).toBe('failed');
    expect(rails.execute).toHaveBeenCalledTimes(calls);
  });
});
