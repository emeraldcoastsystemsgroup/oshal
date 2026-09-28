/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Career worker-rail live acceptance's own logic. Pure cases over an in-memory run registry in the package's real response shapes: a run that ends on its own with an admitted rail call passes on the kernel's attribution; a longer run is cancelled after its first admitted call and still passes; the kernel's enforce-mode refusal (the engine's stderr `career worker unavailable: authorization_identity_required`) fails LOUDLY naming it, as does a run that ends on a rail failure; a run with no rail call is not-runnable; admitted calls with no cost row are red; a caller the package does not admit is not-runnable; a run still running after cancellation is incomplete cleanup. The task id the proof reads is derived through the kernel's real canonicalBotWorkspaceId. Real boundary for the attribution read: the exact ROLLUP_SQL and LEDGER_SQL run against a disposable PostgreSQL carrying the shipped chat/cost migrations (005, 055, 078, 090) and count only this owner's rows for the Career bot written since the run started. The case is registered on the Access Administration Test Lab card beside the enforce-posture boundary spec.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The proof no longer predicts a task id (the first live run reported "no cost" over two real ledger rows keyed `protected-<sha256>::<Career bot>`, the per-execution digest a protected application's bot history carries), so the cases follow it: fixture rows are keyed through the REAL protectedBotWorkspaceId with one execution id per call, and the verdict rests on the Career bot's ledger rows for the owner since the start, no more than the admitted rail calls. Real boundary widened to the read the container mode performs: the whole acceptance runs over a disposable PostgreSQL carrying the chat/cost migrations plus owner-or-operator RLS (112 on oshal_cost_events, the conversation schema's chat_tasks policy via buildOwnerRlsPolicyStatements), read through a NOSUPERUSER NOBYPASSRLS role behind the production GUC wrapper under the owner's request identity. A run shaped like the live one (8 admitted, 2 settled under protected keys) passes; the same fixture with no ledger row since the start fails naming "no cost"; another owner's rows never count (RLS for the identity read, and the SQL's own owner filter read as the superuser); the canonical `career-engine-<owner>` rollup shape is still accepted as evidence; more ledger rows than admitted calls fail. The in-memory verdict cases no longer expect a pre-run baseline read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { protectedBotWorkspaceId } from '@/app/bot-node-protected-workspace';
import { canonicalBotWorkspaceId } from '@/app/bot-node-request-scope';
import { AUTHORIZATION_SCENARIOS } from '@/app/routes/test-lab-authorization-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import { buildOwnerRlsPolicyStatements } from '../../src/shared/services/database/owner-rls-policy';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const requireCjs = createRequire(import.meta.url);
const proof = requireCjs('../../scripts/operations/career-rail-live-proof.js');

/** A plain subject, like the live owner's: its canonical rail workspace is `career-engine-<owner>` verbatim. */
const OWNER = '100000000000000000001';
const OTHER = '100000000000000000002';
const AGENT = 'cb000000-0000-0000-0000-000000000001';
const OTHER_AGENT = 'fixture-other-bot';
const ISSUER = 'https://oshal.example.com/';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
/** The fake clock's origin; the proof's `since` is its first tick. */
const EPOCH = 1_700_000_000_000;
const PROTECTED_TASK = /^protected-[0-9a-f]{64}::cb000000-0000-0000-0000-000000000001$/;

/**
 * The task id the Career node records one call of a protected execution under: the REAL kernel
 * digest over the rail's binding (one execution id per call), then the agent.
 */
function protectedTaskId(owner: string, executionId: string, agent = AGENT): string {
  return `${protectedBotWorkspaceId({ principalIssuer: ISSUER, userSub: owner, app: 'career-hunter', agentId: agent,
    workspaceFolderId: `career-engine-${owner}`, executionId })}::${agent}`;
}

interface FakeOptions {
  /** Rail calls the run admits before it ends (default 1). */
  calls?: number;
  /** Rail calls admitted per poll of the run list (default 1). */
  perPoll?: number;
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
  /** Extra in-window ledger rows for this owner and bot that no admitted call explains. */
  unexplainedRows?: number;
  /** Settle an admitted call somewhere real instead of in memory (call is 1-based). */
  admit?: (at: Date, call: number) => Promise<void>;
  /** Cancellation is acknowledged but the child never exits. */
  stayRunningAfterCancel?: boolean;
}

interface FakeRun { runId: string; verb: string; state: string; reason: string | null; startedAt: number; finishedAt: number | null; railCalls: number }
type RouteAnswer = { status: number; json: Record<string, unknown> };
interface FakeState { clock: number; run: FakeRun | null; settle: null | ((value: RouteAnswer) => void); ledger: Array<{ ts: number; taskId: string }>; cancels: number; posts: number }

/** Settle one admitted call the way the node does: one ledger row under a fresh protected execution. */
async function settleCall(state: FakeState, options: FakeOptions, call: number): Promise<void> {
  if (options.admit) return options.admit(new Date(state.clock), call);
  if (!options.noLedger) state.ledger.push({ ts: state.clock, taskId: protectedTaskId(OWNER, `execution-${call}`) });
}

/** One poll's worth of engine progress: admit rail calls while calls remain, then end the run. */
async function advanceRun(state: FakeState, options: FakeOptions): Promise<void> {
  const run = state.run!;
  const calls = options.calls ?? 1;
  const finish = options.finish ?? 'succeeded';
  for (let admitted = 0; admitted < (options.perPoll ?? 1) && run.railCalls < calls; admitted += 1) {
    run.railCalls += 1;
    await settleCall(state, options, run.railCalls);
    if (run.railCalls === 1) for (let i = 0; i < (options.unexplainedRows ?? 0); i += 1) state.ledger.push({ ts: state.clock, taskId: protectedTaskId(OWNER, `elsewhere-${i}`) });
  }
  if (run.railCalls >= calls && finish !== 'never') {
    run.state = finish; run.reason = finish === 'failed' ? (options.reason ?? 'engine-failed') : null; run.finishedAt = state.clock;
    const tail = { out: '', err: options.stderr ?? '' };
    state.settle?.(finish === 'failed'
      ? { status: run.reason === 'career-worker-unavailable' ? 503 : 502, json: { ok: false, error: run.reason, runId: run.runId, state: run.state, ...tail } }
      : { status: 200, json: { ok: true, out: 'AI-scored 1 postings (0 skipped).', runId: run.runId } });
  }
}

/** The owner's run routes over the package's run registry, in the compiled routes' response shapes. */
function fakeRunRoutes(state: FakeState, options: FakeOptions) {
  return vi.fn(async (method: string, route: string): Promise<RouteAnswer> => {
    if (method === 'POST' && route === '/api/career-hunter/run/score') {
      state.posts += 1;
      if (options.refuseStart) return { status: options.refuseStart.status, json: { ok: false, error: options.refuseStart.error, err: options.refuseStart.error } };
      state.run = { runId: RUN_ID, verb: 'score', state: 'running', reason: null, startedAt: state.clock, finishedAt: null, railCalls: 0 };
      return new Promise<RouteAnswer>((settle) => { state.settle = settle; });
    }
    if (method === 'GET' && route === '/api/career-hunter/runs') {
      if (state.run?.state === 'running') await advanceRun(state, options);
      return { status: 200, json: { runs: state.run ? [{ ...state.run }] : [] } };
    }
    if (method === 'POST' && route === `/api/career-hunter/run/${RUN_ID}/cancel`) {
      state.cancels += 1;
      const run = state.run!;
      if (run.state !== 'running') return { status: 409, json: { error: 'run already finished', state: run.state } };
      if (!options.stayRunningAfterCancel) {
        run.state = 'cancelled'; run.reason = 'cancelled-by-owner'; run.finishedAt = state.clock;
        state.settle?.({ status: 409, json: { ok: false, error: 'cancelled', runId: run.runId, state: 'cancelled', out: '', err: '' } });
      }
      return { status: 202, json: { ok: true, runId: run.runId, cancelled: true } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
}

/** The kernel's two cost tables in memory, answering the proof's exact two statements. */
function fakeCostTables(state: FakeState) {
  return vi.fn(async (sql: string, params: unknown[]) => {
    if (sql === proof.LEDGER_SQL) {
      expect(params.slice(0, 2)).toEqual([AGENT, OWNER]);
      const rows = state.ledger.filter((row) => row.ts >= (params[2] as Date).getTime());
      return { rows: [{ calls: rows.length, cost_usd: rows.length * 0.001, input_tokens: rows.length * 900, output_tokens: rows.length * 120, task_ids: rows.map((row) => row.taskId) }] };
    }
    expect(sql).toBe(proof.ROLLUP_SQL);
    expect([params[0], params[2]]).toEqual([OWNER, `::${AGENT}`]);
    const rows = state.ledger.filter((row) => row.ts >= (params[1] as Date).getTime());
    return { rows: rows.map((row) => ({ task_id: row.taskId, total_requests: 1, total_cost: 0.001, updated_at: new Date(row.ts) })) };
  });
}

/** The package's run registry, the owner's run routes and the kernel's two cost tables, in memory. */
function fake(options: FakeOptions = {}) {
  const state: FakeState = { clock: EPOCH, run: null, settle: null, ledger: [], cancels: 0, posts: 0 };
  const now = () => (state.clock += 1_000);
  const ports = { api: fakeRunRoutes(state, options), query: fakeCostTables(state), withOwner: <T>(fn: () => Promise<T>) => fn(),
    ownerSub: OWNER, careerVersion: '1.25.1', sleep: async () => undefined, now };
  return { ports, state };
}

describe('the package version gate and the refusal naming', () => {
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
    expect(result.detail).toContain('no more than the 1 admitted rail calls');
    expect(result.detail).toContain("the scores it wrote are the owner's own and stay");
    expect(result.evidence).toMatchObject({ verb: 'score', runId: RUN_ID, runState: 'succeeded', railCalls: 1,
      cancelledByProof: false, routeStatus: 200, ledger: { calls: 1 }, rollups: [{ totalRequests: 1 }], cleanupErrors: [] });
    expect(result.evidence.ledger.taskIds).toEqual([protectedTaskId(OWNER, 'execution-1')]);
    expect(result.evidence).not.toHaveProperty('taskId');
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
    expect(f.ports.query).not.toHaveBeenCalled(); // nothing is attributed to a refused run
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
    expect(result.detail).toContain(`0 ledger rows since the run started, 0 rollup row(s) ending ::${AGENT} touched`);
  });

  it('fails when the ledger holds more rows for the owner and bot than the run admitted rail calls', async () => {
    const f = fake({ unexplainedRows: 2 });
    const result = await proof.runCareerRailAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('holds 3 ledger rows for agent');
    expect(result.detail).toContain('more than the 1 rail calls the run admitted: the cost cannot be attributed to this run');
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

describe('the attribution against the shipped chat/cost schema and owner RLS (real PostgreSQL)', () => {
  const READER = 'career_rail_reader';
  const database = new DisposablePostgres({
    purpose: 'career-rail-live-proof', database: 'career_rail_fixture', memory: '256m', max: 2,
    connectionTimeoutMillis: 5_000, statementTimeoutMs: 30_000, roles: [READER],
    migrations: ['005-conversation-history-and-usage.sql', '055-chat-tasks-owner-sub.sql', '078-cost-governance.sql',
      '090-cost-event-tokens-duration.sql', '112-owner-column-rls.sql'],
  });
  let pool: Pool;
  let reader: Pool;
  beforeAll(async () => {
    pool = await database.start();
    for (const statement of buildOwnerRlsPolicyStatements('chat_tasks', 'owner_sub')) await pool.query(statement);
    await pool.query(`GRANT SELECT ON chat_tasks, oshal_cost_events TO ${READER}`);
    reader = wrapPoolWithGuc(database.rolePool(READER));
  }, 180_000);
  afterAll(async () => { await database.stop(); });
  beforeEach(async () => { await pool.query('TRUNCATE oshal_cost_events, chat_tasks CASCADE'); });

  /** What the Career node writes for one settled call: its rollup row and its ledger row (seeded as the superuser). */
  const settle = async (taskId: string, owner: string, at: Date, agent = AGENT): Promise<void> => {
    await pool.query(`INSERT INTO chat_tasks (task_id, agent_id, owner_sub, status, total_requests, total_cost, updated_at)
      VALUES ($1, $2, $3, 'completed', 1, 0.002, $4)`, [taskId, agent, owner, at]);
    await pool.query(`INSERT INTO oshal_cost_events (ts, task_id, owner_sub, agent_id, provider_id, model_id, cost_usd, input_tokens, output_tokens)
      VALUES ($1, $2, $3, $4, 'fixture-provider', 'fixture-model', 0.002, 18000, 160)`, [at, taskId, owner, agent]);
  };
  /** Rows that must never count for OWNER's run: another owner's, OWNER's before the start, OWNER's for another bot. */
  const seedNoise = async (): Promise<void> => {
    await settle(protectedTaskId(OTHER, 'other-1'), OTHER, new Date(EPOCH + 5_000));
    await settle(protectedTaskId(OTHER, 'other-2'), OTHER, new Date(EPOCH + 6_000));
    await settle(protectedTaskId(OWNER, 'before-start'), OWNER, new Date(EPOCH - 60_000));
    await settle(protectedTaskId(OWNER, 'job-guide', OTHER_AGENT), OWNER, new Date(EPOCH + 5_000), OTHER_AGENT);
  };
  /** The container mode's read: the GUC-wrapped non-superuser pool under the owner's request identity. */
  const asOwner = (owner: string) => ({
    ownerSub: owner,
    query: (sql: string, params: unknown[]) => reader.query(sql, params),
    withOwner: <T>(fn: () => Promise<T>) => runWithRequestIdentity({ sub: owner, isOperator: false }, fn),
  });

  it('the fixture enforces owner RLS on both tables and keys calls the way the node keys a protected execution', async () => {
    const forced = await pool.query(`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('chat_tasks', 'oshal_cost_events') ORDER BY relname`);
    expect(forced.rows).toEqual([{ relname: 'chat_tasks', relforcerowsecurity: true }, { relname: 'oshal_cost_events', relforcerowsecurity: true }]);
    expect(protectedTaskId(OWNER, 'execution-1')).toMatch(PROTECTED_TASK);
    expect(protectedTaskId(OWNER, 'execution-2')).not.toBe(protectedTaskId(OWNER, 'execution-1'));
    expect(protectedTaskId(OWNER, 'execution-1')).not.toBe(`${canonicalBotWorkspaceId(`career-engine-${OWNER}`)}::${AGENT}`);
  });

  it('passes a run shaped like the live one: 8 admitted, 2 settled under protected-<64 hex> task ids, read as the owner under RLS', async () => {
    await seedNoise();
    const f = fake({ calls: 40, perPoll: 8, admit: async (at, call) => { if (call <= 2) await settle(protectedTaskId(OWNER, `execution-${call}`), OWNER, at); } });
    const result = await proof.runCareerRailAcceptance({ ...f.ports, ...asOwner(OWNER) }, { ledgerBudgetMs: 10_000 });
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('cancelled by the proof after its first admitted rail call (8 admitted)');
    expect(result.detail).toContain(`the Career bot ${AGENT} recorded 2 ledger row(s) for this owner since the run started (36000 in / 320 out tokens`);
    const settled = [protectedTaskId(OWNER, 'execution-1'), protectedTaskId(OWNER, 'execution-2')].sort();
    expect(result.evidence.ledger).toEqual({ calls: 2, costUsd: 0.004, inputTokens: 36000, outputTokens: 320, taskIds: settled });
    for (const taskId of result.evidence.ledger.taskIds) expect(taskId).toMatch(PROTECTED_TASK);
    expect(result.evidence.rollups.map((row: { taskId: string }) => row.taskId).sort()).toEqual(settled);
  });

  it('fails naming "no cost" when the same fixture holds no ledger row of this owner and bot since the run started', async () => {
    await seedNoise();
    const f = fake({ calls: 40, perPoll: 8, admit: async () => undefined });
    const result = await proof.runCareerRailAcceptance({ ...f.ports, ...asOwner(OWNER) }, { ledgerBudgetMs: 10_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`(8 admitted), but the kernel recorded no cost for agent ${AGENT} under this owner within 10s`);
    expect(result.detail).toContain(`0 ledger rows since the run started, 0 rollup row(s) ending ::${AGENT} touched`);
  });

  it("never counts another owner's rows: RLS hides them from the owner's identity, and the query's own owner filter excludes them without RLS", async () => {
    await seedNoise();
    const since = new Date(EPOCH);
    await settle(protectedTaskId(OWNER, 'execution-1'), OWNER, new Date(EPOCH + 5_000));
    const legacy = `${canonicalBotWorkspaceId(`career-engine-${OWNER}`)}::${AGENT}`;
    await settle(legacy, OWNER, new Date(EPOCH + 7_000));
    const mine = { calls: 2, costUsd: 0.004, inputTokens: 36000, outputTokens: 320, taskIds: [legacy, protectedTaskId(OWNER, 'execution-1')].sort() };
    const owned = await proof.readAttribution(asOwner(OWNER), since);
    expect(owned.ledger).toEqual(mine);
    expect(owned.rollups.map((row: { taskId: string }) => row.taskId)).toEqual([legacy, protectedTaskId(OWNER, 'execution-1')]);
    // The superuser sees every row; the query itself still counts only OWNER's.
    const unwalled = await proof.readAttribution({ ownerSub: OWNER, query: (sql: string, params: unknown[]) => pool.query(sql, params), withOwner: <T>(fn: () => Promise<T>) => fn() }, since);
    expect(unwalled.ledger).toEqual(mine);
    // OWNER's subject asked for through OTHER's request identity: RLS leaves nothing to count.
    const walled = await proof.readAttribution({ ...asOwner(OWNER), withOwner: asOwner(OTHER).withOwner }, since);
    expect(walled).toEqual({ rollups: [], ledger: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, taskIds: [] } });
  });
});
