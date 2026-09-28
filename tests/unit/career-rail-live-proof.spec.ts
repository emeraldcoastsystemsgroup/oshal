/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Career worker-rail live acceptance's own logic. Pure cases over an in-memory run registry in the package's real response shapes: a run that ends on its own with an admitted rail call passes on the kernel's attribution; a longer run is cancelled after its first admitted call and still passes; the kernel's enforce-mode refusal (the engine's stderr `career worker unavailable: authorization_identity_required`) fails LOUDLY naming it, as does a run that ends on a rail failure; a run with no rail call is not-runnable; admitted calls with no cost row are red; a caller the package does not admit is not-runnable; a run still running after cancellation is incomplete cleanup. The task id the proof reads is derived through the kernel's real canonicalBotWorkspaceId. Real boundary for the attribution read: the exact ROLLUP_SQL and LEDGER_SQL run against a disposable PostgreSQL carrying the shipped chat/cost migrations (005, 055, 078, 090) and count only this owner's rows for the Career bot written since the run started. The case is registered on the Access Administration Test Lab card beside the enforce-posture boundary spec.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalBotWorkspaceId } from '@/app/bot-node-request-scope';
import { AUTHORIZATION_SCENARIOS } from '@/app/routes/test-lab-authorization-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const requireCjs = createRequire(import.meta.url);
const proof = requireCjs('../../scripts/operations/career-rail-live-proof.js');

const OWNER = 'auth0|career-rail-owner';
const AGENT = 'cb000000-0000-0000-0000-000000000001';
const RUN_ID = '11111111-2222-4333-8444-555555555555';

interface FakeOptions {
  /** Rail calls the run admits before it ends (default 1). */
  calls?: number;
  /** How the run ends once its calls are admitted; 'never' keeps it running until cancelled. */
  finish?: 'succeeded' | 'failed' | 'never';
  /** The reason the registry records for a failed run. */
  reason?: string | null;
  /** The engine's stderr tail the run route quotes. */
  stderr?: string;
  /** Refuse the run route with this status and error before any run exists. */
  refuseStart?: { status: number; error: string };
  /** The kernel never records a cost row (the node's recordCost failed). */
  noLedger?: boolean;
  /** Cancellation is acknowledged but the child never exits. */
  stayRunningAfterCancel?: boolean;
}

interface FakeRun { runId: string; verb: string; state: string; reason: string | null; startedAt: number; finishedAt: number | null; railCalls: number }

/** The package's run registry, the owner's run routes and the kernel's two cost tables, in memory. */
function fake(options: FakeOptions = {}) {
  let clock = 1_700_000_000_000;
  const now = () => (clock += 1_000);
  const calls = options.calls ?? 1;
  const finish = options.finish ?? 'succeeded';
  const state = { run: null as FakeRun | null, settle: null as null | ((value: { status: number; json: Record<string, unknown> }) => void),
    rollupRequests: 0, ledger: [] as Array<{ ts: number }>, cancels: 0, posts: 0 };
  const taskId = proof.railTaskId(canonicalBotWorkspaceId, OWNER) as string;

  /** One poll's worth of engine progress: admit a rail call while calls remain, then end the run. */
  const progress = (): void => {
    const run = state.run!;
    if (run.railCalls < calls) {
      run.railCalls += 1;
      if (!options.noLedger) { state.rollupRequests += 1; state.ledger.push({ ts: clock }); }
    }
    if (run.railCalls >= calls && finish !== 'never') {
      run.state = finish; run.reason = finish === 'failed' ? (options.reason ?? 'engine-failed') : null; run.finishedAt = clock;
      const tail = { out: '', err: options.stderr ?? '' };
      state.settle?.(finish === 'failed'
        ? { status: run.reason === 'career-worker-unavailable' ? 503 : 502, json: { ok: false, error: run.reason, runId: run.runId, state: run.state, ...tail } }
        : { status: 200, json: { ok: true, out: 'AI-scored 1 postings (0 skipped).', runId: run.runId } });
    }
  };

  const api = vi.fn(async (method: string, route: string) => {
    if (method === 'POST' && route === '/api/career-hunter/run/score') {
      state.posts += 1;
      if (options.refuseStart) return { status: options.refuseStart.status, json: { ok: false, error: options.refuseStart.error, err: options.refuseStart.error } };
      state.run = { runId: RUN_ID, verb: 'score', state: 'running', reason: null, startedAt: clock, finishedAt: null, railCalls: 0 };
      return new Promise<{ status: number; json: Record<string, unknown> }>((settle) => { state.settle = settle; });
    }
    if (method === 'GET' && route === '/api/career-hunter/runs') {
      if (state.run?.state === 'running') progress();
      return { status: 200, json: { runs: state.run ? [{ ...state.run }] : [] } };
    }
    if (method === 'POST' && route === `/api/career-hunter/run/${RUN_ID}/cancel`) {
      state.cancels += 1;
      const run = state.run!;
      if (run.state !== 'running') return { status: 409, json: { error: 'run already finished', state: run.state } };
      if (!options.stayRunningAfterCancel) {
        run.state = 'cancelled'; run.reason = 'cancelled-by-owner'; run.finishedAt = clock;
        state.settle?.({ status: 409, json: { ok: false, error: 'cancelled', runId: run.runId, state: 'cancelled', out: '', err: '' } });
      }
      return { status: 202, json: { ok: true, runId: run.runId, cancelled: true } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });

  const query = vi.fn(async (sql: string, params: unknown[]) => {
    expect(params[0]).toBe(taskId); expect(params[1]).toBe(AGENT); expect(params[2]).toBe(OWNER);
    if (sql === proof.ROLLUP_SQL) {
      return { rows: state.rollupRequests ? [{ task_id: taskId, agent_id: AGENT, owner_sub: OWNER, status: 'completed', total_requests: state.rollupRequests, total_cost: 0.01, updated_at: new Date(clock) }] : [] };
    }
    const since = (params[3] as Date).getTime();
    const rows = state.ledger.filter((row) => row.ts >= since);
    return { rows: [{ calls: rows.length, cost_usd: rows.length * 0.001, input_tokens: rows.length * 900, output_tokens: rows.length * 120 }] };
  });

  const ports = { api, query, withOwner: <T>(fn: () => Promise<T>) => fn(), ownerSub: OWNER, taskId, careerVersion: '1.25.0', sleep: async () => undefined, now };
  return { ports, state, taskId };
}

describe('the rail task id and the package version gate', () => {
  it('derives the rollup task id the node records under: the canonical rail workspace of the owner, then the Career bot', () => {
    const taskId = proof.railTaskId(canonicalBotWorkspaceId, OWNER);
    expect(taskId).toBe(`${canonicalBotWorkspaceId(`career-engine-${OWNER}`)}::${AGENT}`);
    expect(taskId).toMatch(/^scope-[0-9a-f]{64}::cb000000-0000-0000-0000-000000000001$/);
    expect(proof.railTaskId(canonicalBotWorkspaceId, 'plainowner')).toBe(`career-engine-plainowner::${AGENT}`);
  });

  it('runs only against a package that has the rail (1.24.0 and later)', () => {
    expect(proof.hasRail('1.23.0')).toBe(false);
    expect(proof.hasRail('1.24.0')).toBe(true);
    expect(proof.hasRail('1.25.1')).toBe(true);
    expect(proof.hasRail('2.0.0')).toBe(true);
    expect(proof.hasRail('rail')).toBe(false);
    expect(proof.hasRail(undefined)).toBe(false);
  });

  it('names the kernel refusal the engine child records, and nothing for an ordinary engine error', () => {
    expect(proof.detectRailRefusal(['engine-failed', undefined, 'career worker unavailable: authorization_identity_required'])).toBe('authorization_identity_required');
    expect(proof.detectRailRefusal(['engine-failed', null, 'career worker unavailable: http-403'])).toBe('http-403');
    expect(proof.detectRailRefusal(['engine-failed', null, 'Traceback: sqlite3.OperationalError'])).toBeNull();
  });
});

describe('runCareerRailAcceptance', () => {
  it('passes when the run ends on its own with an admitted rail call the kernel attributed to the Career bot for this owner', async () => {
    const f = fake();
    const result = await proof.runCareerRailAcceptance(f.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('ended succeeded after 1 rail calls');
    expect(result.detail).toContain(`the Career bot ${AGENT} recorded 1 ledger row(s) for this owner`);
    expect(result.detail).toContain("the scores it wrote are the owner's own and stay");
    expect(result.evidence).toMatchObject({ verb: 'score', taskId: f.taskId, runId: RUN_ID, runState: 'succeeded', railCalls: 1,
      cancelledByProof: false, routeStatus: 200, rollupRequestsBefore: null, rollupRequestsAfter: 1, ledger: { calls: 1 }, cleanupErrors: [] });
    expect(f.state.cancels).toBe(0);
  });

  it('cancels a longer run as soon as its first rail call is admitted, bounding the spend, and still passes on the attribution', async () => {
    const f = fake({ calls: 40 });
    const result = await proof.runCareerRailAcceptance(f.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('cancelled by the proof after its first admitted rail call (1 admitted)');
    expect(f.state.cancels).toBe(1);
    expect(f.state.run!.railCalls).toBe(1);
    expect(result.evidence).toMatchObject({ runState: 'cancelled', cancelledByProof: true, routeStatus: 409, cleanupErrors: [] });
  });

  it('fails LOUDLY naming the kernel refusal when the enforce box turns the engine child away before package code', async () => {
    const f = fake({ calls: 0, finish: 'failed', reason: 'engine-failed', stderr: 'career worker unavailable: authorization_identity_required\n' });
    const result = await proof.runCareerRailAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('The kernel refused the rail call before package code ran: authorization_identity_required');
    expect(result.detail).toContain(`run ${RUN_ID} failed with reason engine-failed, 0 calls admitted`);
    expect(f.ports.query).toHaveBeenCalledTimes(2); // the baseline read only; nothing is attributed to a refused run
    expect(result.evidence).toMatchObject({ runState: 'failed', runReason: 'engine-failed', railCalls: 0, routeStatus: 502 });
  });

  it('fails naming the rail failure a run ended on', async () => {
    const f = fake({ calls: 1, finish: 'failed', reason: 'career-worker-unavailable', stderr: 'career worker unavailable: career-worker-unavailable' });
    const result = await proof.runCareerRailAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`Run ${RUN_ID} failed with reason career-worker-unavailable after 1 admitted rail calls`);
    expect(result.evidence).toMatchObject({ routeStatus: 503 });
  });

  it('is not runnable when the owner had nothing to score, so the rail was never exercised', async () => {
    const f = fake({ calls: 0 });
    const result = await proof.runCareerRailAcceptance(f.ports);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('without a single rail call');
  });

  it('turns admitted calls with no cost row red instead of trusting the run list', async () => {
    const f = fake({ noLedger: true });
    const result = await proof.runCareerRailAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`the kernel recorded no cost for agent ${AGENT} under this owner`);
    expect(result.detail).toContain('rollup absent, 0 ledger rows since the run started');
  });

  it('is not runnable when the package does not admit the operator automation identity, and starts nothing', async () => {
    const refused = await proof.runCareerRailAcceptance(fake({ refuseStart: { status: 403, error: 'authorization_app_admin_required' } }).ports);
    expect(refused.state).toBe('unavailable');
    expect(refused.detail).toContain('not admitted to career-hunter (POST /run/score answered HTTP 403 authorization_app_admin_required)');
    const held = await proof.runCareerRailAcceptance(fake({ refuseStart: { status: 409, error: 'score already running' } }).ports);
    expect(held.state).toBe('unavailable');
    expect(held.detail).toContain('another engine run holds the slot');
  });

  it('reports incomplete cleanup when the run is still running after cancellation', async () => {
    const f = fake({ calls: 40, stayRunningAfterCancel: true });
    const result = await proof.runCareerRailAcceptance(f.ports, { runBudgetMs: 10_000, pollMs: 1_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`Run ${RUN_ID} was still running after 10s`);
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: run ${RUN_ID} is still running after cancellation`);
    expect(f.state.cancels).toBeGreaterThanOrEqual(2);
  });
});

describe('Test Lab registration', () => {
  it('attaches the posture boundary spec and this spec to the Access Administration card, in the command that runs it', () => {
    const scenario = AUTHORIZATION_SCENARIOS.find((item) => item.id === 'authorization-management')!;
    expect(SCENARIOS.find((item) => item.id === scenario.id)).toBe(scenario);
    const paths = scenario.regressionTests!.map((item) => item.path);
    for (const path of ['tests/unit/career-rail-enforce-posture.spec.ts', 'tests/unit/career-rail-live-proof.spec.ts']) {
      expect(paths).toContain(path);
      expect(existsSync(resolve(path)), path).toBe(true);
      expect(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts['test:authorization']).toContain(path);
    }
    expect(existsSync(resolve('scripts/operations/career-rail-live-proof.js'))).toBe(true);
  });
});

describe('the attribution read against the shipped chat/cost schema (real PostgreSQL)', () => {
  const database = new DisposablePostgres({
    purpose: 'career-rail-live-proof', database: 'career_rail_fixture', memory: '256m', max: 2,
    connectionTimeoutMillis: 5_000, statementTimeoutMs: 30_000,
    migrations: ['005-conversation-history-and-usage.sql', '055-chat-tasks-owner-sub.sql', '078-cost-governance.sql', '090-cost-event-tokens-duration.sql'],
  });
  let pool: Pool;
  beforeAll(async () => { pool = await database.start(); }, 180_000);
  afterAll(async () => { await database.stop(); });

  it('returns this owner\'s rollup for the Career bot and counts only ledger rows written since the run started', async () => {
    const taskId = proof.railTaskId(canonicalBotWorkspaceId, OWNER);
    const otherTask = proof.railTaskId(canonicalBotWorkspaceId, 'auth0|someone-else');
    const since = new Date('2026-09-28T09:00:00.000Z');
    await pool.query(`INSERT INTO chat_tasks (task_id, agent_id, owner_sub, status, total_requests, total_cost) VALUES ($1, $2, $3, 'completed', 7, 0.05), ($4, $2, $5, 'completed', 2, 0.01)`,
      [taskId, AGENT, OWNER, otherTask, 'auth0|someone-else']);
    await pool.query(`INSERT INTO oshal_cost_events (ts, task_id, owner_sub, agent_id, cost_usd, input_tokens, output_tokens) VALUES
        ($1, $2, $3, $4, 0.002, 800, 100), ($5, $2, $3, $4, 0.003, 900, 150), ($6, $2, $3, $4, 0.004, 700, 90), ($5, $7, $8, $4, 0.009, 1, 1)`,
      [new Date(since.getTime() - 60_000), taskId, OWNER, AGENT, since, new Date(since.getTime() + 60_000), otherTask, 'auth0|someone-else']);
    const read = await proof.readAttribution({ query: (sql: string, params: unknown[]) => pool.query(sql, params), withOwner: <T>(fn: () => Promise<T>) => fn(), ownerSub: OWNER, taskId }, since);
    expect(read.rollup).toMatchObject({ task_id: taskId, agent_id: AGENT, owner_sub: OWNER, total_requests: 7 });
    expect(read.ledger).toEqual({ calls: 2, costUsd: 0.007, inputTokens: 1600, outputTokens: 240 });
    const nobody = await proof.readAttribution({ query: (sql: string, params: unknown[]) => pool.query(sql, params), withOwner: <T>(fn: () => Promise<T>) => fn(), ownerSub: 'auth0|third', taskId }, since);
    expect(nobody).toEqual({ rollup: null, ledger: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 } });
  });
});
