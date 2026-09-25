/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove bounded owner/RLS context, stable settled citations and replayable reviews against real PostgreSQL; inference is an explicit fixture.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/composition-root';
import { normalizeFuturesResearchConfig, type FuturesResearchRun } from '@/app/trading-futures-research-dispatch';
import { captureFuturesForwardContext, futuresReviewEvidenceKey } from '@/app/trading-futures-review-forward-context';
import { fingerprintFuturesEvidence } from '@/app/trading-futures-prediction-evidence';
import { futuresReviewPrompt, parseFuturesReview } from '@/app/trading-futures-research-review-contract';
import { reviewFuturesResearchRun } from '@/app/trading-futures-research-review';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { insertForwardReceipt, settleForwardReceipt, replyWithForwardContext } from '../helpers/futures-review-fixtures';

const fixture = new DisposablePostgres({ purpose: 'futures-review-forward', roles: ['oshal_app'],
  migrations: ['159-futures-research-runs.sql', '160-futures-research-review.sql', '161-futures-predictions.sql'] });
const owner = 'forward-review-owner', other = 'forward-review-other';
const config = normalizeFuturesResearchConfig({ source: 'mock', roots: ['ES'], start: '2021-01-01', endMode: 'fixed', end: '2021-05-31',
  split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 }, stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} } });
const markets: FuturesResearchRun['markets'] = [{ root: 'ES', evidenceFingerprint: 'c'.repeat(64), outOfSampleNet: -25, outOfSampleTrades: 2,
  bars: 100, ltfBars: 100, ltfResampledFromMinute: false, chartAsOf: '2021-05-31', ltfAsOf: '2021-05-31', latestCompleteOosEnd: '2021-05-01', worstOutOfSampleMaxDD: 30,
  report: { split: config.split, windows: [], outOfSampleNet: -25, outOfSampleTrades: 2, worstOutOfSampleMaxDD: 30 } }];
let pool: Pool, ctx: AppContext;
const oldOperators = process.env.OSHAL_OPERATOR_SUBS;
beforeAll(async () => {
  process.env.OSHAL_OPERATOR_SUBS = `${owner},${other}`;
  pool = await fixture.start(); ctx = { pool } as unknown as AppContext;
}, 180_000);
beforeEach(async () => {
  // Only the server minted by DisposablePostgres; no inherited deployment connection exists.
  await pool.query('TRUNCATE oshal_trading_futures_predictions,oshal_trading_futures_research_runs');
});
afterAll(async () => {
  if (oldOperators === undefined) delete process.env.OSHAL_OPERATOR_SUBS; else process.env.OSHAL_OPERATOR_SUBS = oldOperators;
  await fixture.stop();
});
async function insertRun(): Promise<FuturesResearchRun> {
  const runId = randomUUID();
  await pool.query(`INSERT INTO oshal_trading_futures_research_runs(run_id,owner_sub,schedule_id,status,config,markets,completed_at)
    VALUES($1,$2,'fixture','completed',$3::jsonb,$4::jsonb,now())`, [runId, owner, JSON.stringify(config), JSON.stringify(markets)]);
  return { runId, ownerSub: owner, scheduleId: 'fixture', status: 'completed', config, markets,
    error: null, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
}
async function boundRun(): Promise<FuturesResearchRun> {
  const run = await insertRun(), forwardContext = await captureFuturesForwardContext(pool, run);
  return { ...run, review: { status: 'reviewing', attemptId: randomUUID(), requestedAt: new Date().toISOString(), forwardContext } };
}

describe('owner-scoped forward feedback on a real immutable ledger', () => {
  it('projects only safe facts for the owner and configured roots, including prior schedules', async () => {
    const own = await insertForwardReceipt(pool, { owner, status: 'graded' });
    const foreign = await insertForwardReceipt(pool, { owner: other, status: 'graded' });
    const otherRoot = await insertForwardReceipt(pool, { owner, root: 'CL', contract: 'CLZ26', status: 'graded' });
    const run = await boundRun(), prompt = futuresReviewPrompt(run), context = run.review!.forwardContext!;
    expect(context.receipts.map(row => row.predictionId)).toEqual([own]);
    expect(context.counts).toMatchObject({ graded: 1, matched: 1, missed: 0, flat: 0 });
    expect(context.available).toEqual({ graded: 1, other: 0 });
    for (const secret of ['PRIVATE_', owner, other, foreign, otherRoot, 'dataDir', 'credential', 'scheduleId']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('not executable P&L');
    expect(prompt).toContain('not independent samples');
    expect(prompt).toContain('new untouched evidence');
  });
  it('caps graded and other samples independently with truthful totals and cohort denominators', async () => {
    for (let i = 0; i < 28; i++) {
      await insertForwardReceipt(pool, { owner, status: 'graded', ticks: i % 3 === 0 ? 4 : i % 3 === 1 ? -4 : 0,
        issuedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), contract: i % 2 ? 'ESH27' : 'ESZ26',
        horizon: i % 2 ? 2 : 1, model: i % 2 ? 'second-model' : 'first-model', study: (i % 2 ? 'a' : 'b').repeat(64) });
    }
    for (let i = 0; i < 30; i++) await insertForwardReceipt(pool, { owner, issuedAt: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
      status: (['pending', 'unavailable', 'withheld', 'abstained'] as const)[i % 4] });
    const context = await captureFuturesForwardContext(pool, await insertRun());
    expect(context.receipts).toHaveLength(50);
    expect(context.available).toEqual({ graded: 28, other: 30 });
    expect(context.counts).toEqual({ graded: 25, matched: 9, missed: 8, flat: 8, pending: 6, unavailable: 7, withheld: 6, abstained: 6 });
    expect(context.cohorts.filter(cohort => cohort.counts.graded).map(cohort => [cohort.contract, cohort.model, cohort.horizonHours]).sort())
      .toEqual([['ESH27', 'second-model', 2], ['ESZ26', 'first-model', 1]]);
    expect(context.cohorts.reduce((sum, cohort) => sum + cohort.counts.graded, 0)).toBe(25);
    expect(context.receipts.some(row => row.issuedAt === '2026-01-01T00:00:00.000Z')).toBe(false);
  });
  it('survives JSONB key order and ignores clock/check changes or new pending calls in the settled key', async () => {
    const id = await insertForwardReceipt(pool, { owner }), run = await insertRun();
    const before = await captureFuturesForwardContext(pool, run);
    const { capturedAt: _capturedAt, fingerprint, settledFingerprint: _settled, ...body } = before;
    const stored = (await pool.query('SELECT $1::jsonb AS value', [JSON.stringify(body)])).rows[0].value;
    expect(fingerprintFuturesEvidence(stored)).toBe(fingerprint);
    await pool.query('UPDATE oshal_trading_futures_predictions SET checked_at=clock_timestamp() WHERE prediction_id=$1', [id]);
    const checked = await captureFuturesForwardContext(pool, run);
    expect(checked.fingerprint).toBe(before.fingerprint);
    await insertForwardReceipt(pool, { owner });
    const pending = await captureFuturesForwardContext(pool, run);
    expect(pending.fingerprint).not.toBe(before.fingerprint);
    expect(futuresReviewEvidenceKey(run, pending)).toBe(futuresReviewEvidenceKey(run, before));
    await settleForwardReceipt(pool, id, -4);
    const graded = await captureFuturesForwardContext(pool, run);
    expect(graded.counts).toMatchObject({ graded: 1, missed: 1, pending: 1 });
    expect(futuresReviewEvidenceKey(run, graded)).not.toBe(futuresReviewEvidenceKey(run, pending));
  });
  it('requires the exact frozen citation and never claims assessment without forward receipts', async () => {
    const empty = await boundRun(), reply = JSON.parse(replyWithForwardContext(futuresReviewPrompt(empty)));
    expect(parseFuturesReview(JSON.stringify(reply), empty).forwardAssessment).toBeNull();
    reply.forwardAssessment = { contextFingerprint: 'a'.repeat(64), summary: 'Invented' };
    expect(() => parseFuturesReview(JSON.stringify(reply), empty)).toThrow(/no forward/);
    await insertForwardReceipt(pool, { owner });
    const run = await boundRun(), valid = JSON.parse(replyWithForwardContext(futuresReviewPrompt(run)));
    expect(parseFuturesReview(JSON.stringify(valid), run).forwardAssessment?.contextFingerprint).toBe(run.review?.forwardContext?.fingerprint);
    for (const bad of [null, undefined, { contextFingerprint: 'a'.repeat(64), summary: 'Wrong context' }]) {
      expect(() => parseFuturesReview(JSON.stringify({ ...valid, forwardAssessment: bad }), run)).toThrow(/frozen forward/);
    }
  });
  it('freezes interactive evidence before inference and replays the same review after more outcomes', async () => {
    const id = await insertForwardReceipt(pool, { owner }), run = await insertRun();
    const reviewer = vi.fn(async (_ctx, _owner, _attempt, prompt: string) => {
      await settleForwardReceipt(pool, id, 4);
      return replyWithForwardContext(prompt);
    });
    const result = await reviewFuturesResearchRun(ctx, owner, run.runId, reviewer);
    expect(result.status).toBe('completed');
    expect(result.forwardContext?.counts).toMatchObject({ pending: 1, graded: 0 });
    const stored = (await pool.query('SELECT review FROM oshal_trading_futures_research_runs WHERE run_id=$1', [run.runId])).rows[0].review;
    expect(stored).toEqual(result);
    await insertForwardReceipt(pool, { owner, status: 'graded', ticks: -4 });
    expect(await reviewFuturesResearchRun(ctx, owner, run.runId, reviewer)).toEqual(result);
    expect(reviewer).toHaveBeenCalledTimes(1);
    const next = await reviewFuturesResearchRun(ctx, owner, (await insertRun()).runId, async (_ctx, _owner, _attempt, prompt) => replyWithForwardContext(prompt));
    expect(next.forwardContext?.counts).toMatchObject({ graded: 2, matched: 1, missed: 1 });
  });
  it('rejects an unchanged grid even when database JSONB reorders the study keys', async () => {
    const run = await boundRun();
    run.config = (await pool.query('SELECT config FROM oshal_trading_futures_research_runs WHERE run_id=$1', [run.runId])).rows[0].config;
    const reply = JSON.parse(replyWithForwardContext(futuresReviewPrompt(run)));
    reply.nextStudy = { rationale: 'Same grid in a different key order', stageGrids: config.stageGrids };
    expect(() => parseFuturesReview(JSON.stringify(reply), run)).toThrow(/no grid change/);
  });
  it('persists a rejected citation as failed and permits a separately frozen retry', async () => {
    await insertForwardReceipt(pool, { owner, status: 'graded' });
    const run = await insertRun();
    const result = await reviewFuturesResearchRun(ctx, owner, run.runId, async (_ctx, _owner, _attempt, prompt) => {
      const reply = JSON.parse(replyWithForwardContext(prompt)); reply.forwardAssessment = null; return JSON.stringify(reply);
    });
    expect(result.status).toBe('failed');
    expect(result.result).toBeUndefined();
    const retried = await reviewFuturesResearchRun(ctx, owner, run.runId, async (_ctx, _owner, _attempt, prompt) => replyWithForwardContext(prompt));
    expect(retried.status).toBe('completed');
    expect(retried.attemptId).not.toBe(result.attemptId);
  });
  it.each(['future', 'early', 'contradictory'])('refuses %s graded evidence before provider admission', async mode => {
    const id = await insertForwardReceipt(pool, { owner });
    const closedAt = mode === 'future' ? '2099-01-01T01:00:00.000Z' : mode === 'early' ? '2026-01-01T00:30:00.000Z' : '2026-01-01T01:00:00.000Z';
    await pool.query("UPDATE oshal_trading_futures_predictions SET status='graded',outcome=$2::jsonb WHERE prediction_id=$1", [id,
      JSON.stringify({ bar: { closedAt, bar: { c: 5001 } }, priceChange: 1, signedTicks: 4, correct: mode !== 'contradictory' })]);
    const run = await insertRun(), reviewer = vi.fn();
    await expect(reviewFuturesResearchRun(ctx, owner, run.runId, reviewer)).rejects.toThrow(/inconsistent graded/);
    expect(reviewer).not.toHaveBeenCalled();
    expect((await pool.query('SELECT review FROM oshal_trading_futures_research_runs WHERE run_id=$1', [run.runId])).rows[0].review).toBeNull();
  });
  it('preserves exact-owner qualification under the enforcing application role, including operator reads', async () => {
    const own = await insertForwardReceipt(pool, { owner, status: 'graded' });
    await insertForwardReceipt(pool, { owner: other, status: 'graded' });
    const run = await insertRun(), client = await fixture.rolePool('oshal_app').connect();
    try {
      await client.query("SELECT set_config('oshal.current_sub',$1,false),set_config('oshal.is_operator','off',false)", [other]);
      expect((await captureFuturesForwardContext(client, run)).receipts).toEqual([]);
      await client.query("SELECT set_config('oshal.current_sub',$1,false)", [owner]);
      expect((await captureFuturesForwardContext(client, run)).receipts.map(row => row.predictionId)).toEqual([own]);
      await client.query("SELECT set_config('oshal.is_operator','on',false)");
      expect((await captureFuturesForwardContext(client, run)).receipts.map(row => row.predictionId)).toEqual([own]);
    } finally { client.release(); }
  });
});
