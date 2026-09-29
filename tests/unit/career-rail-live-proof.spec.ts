/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Career worker-rail live acceptance's own logic. Pure cases over an in-memory run registry in the package's real response shapes: a run that ends on its own with an admitted rail call passes on the kernel's attribution; a longer run is cancelled after its first admitted call and still passes; the kernel's enforce-mode refusal (the engine's stderr `career worker unavailable: authorization_identity_required`) fails LOUDLY naming it, as does a run that ends on a rail failure; a run with no rail call is not-runnable; admitted calls with no cost row are red; a caller the package does not admit is not-runnable; a run still running after cancellation is incomplete cleanup. The task id the proof reads is derived through the kernel's real canonicalBotWorkspaceId. Real boundary for the attribution read: the exact ROLLUP_SQL and LEDGER_SQL run against a disposable PostgreSQL carrying the shipped chat/cost migrations (005, 055, 078, 090) and count only this owner's rows for the Career bot written since the run started. The case is registered on the Access Administration Test Lab card beside the enforce-posture boundary spec.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The proof no longer predicts a task id (the first live run reported "no cost" over two real ledger rows keyed `protected-<sha256>::<Career bot>`, the per-execution digest a protected application's bot history carries), so the cases follow it: fixture rows are keyed through the REAL protectedBotWorkspaceId with one execution id per call, and the verdict rests on the Career bot's ledger rows for the owner since the start, no more than the admitted rail calls. Real boundary widened to the read the container mode performs: the whole acceptance runs over a disposable PostgreSQL carrying the chat/cost migrations plus owner-or-operator RLS (112 on oshal_cost_events, the conversation schema's chat_tasks policy via buildOwnerRlsPolicyStatements), read through a NOSUPERUSER NOBYPASSRLS role behind the production GUC wrapper under the owner's request identity. A run shaped like the live one (8 admitted, 2 settled under protected keys) passes; the same fixture with no ledger row since the start fails naming "no cost"; another owner's rows never count (RLS for the identity read, and the SQL's own owner filter read as the superuser); the canonical `career-engine-<owner>` rollup shape is still accepted as evidence; more ledger rows than admitted calls fail. The in-memory verdict cases no longer expect a pre-run baseline read.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The two extra modes. `--complete`: a run that ends succeeded on its own after every call passes on the attribution with no cancellation issued; a run still running at the budget is cancelled by the cleanup and red; a run someone else cancelled is red (the default mode still accepts it); no rail call is not-runnable. `--worker-loss` (container half, over the same in-memory run registry plus a registry double the phase hook drives the way docker would): the run fails 503 career-worker-unavailable once the stop phase took the bot away and a strictly newer heartbeat after the start phase passes; a bot that never comes back is red, and so is a stale-online record whose heartbeat never moves (the record a dead bot leaves behind) or a registration that vanished; a run that ends succeeded, fails for another reason, or whose route answers 502 after the stop is red; a run that hangs after the stop is red and cancelled; a run that ends before the stop, a bot that is offline before, and a refused start stop nothing. Host half: the reactor stops on the stop phase, starts on the start phase, each once, and restarts in finish() when the proof died between them; hostVerdict turns a failed stop/start, a never-issued start or a container not running afterwards red. The mode flags exclude each other and the host spec carries the mode's flag after --in-container. stageAndStream keeps stageAndRun's argv and PAT-by-name contract, hands lines to the reactor as they arrive and always unstages.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | `--complete` now also runs the approve -> draft half (career-rail-draft.js, its own spec career-rail-draft.spec.ts): the staged set is four files for every mode, the complete mode's host ceiling adds the draft budget and its attribution wait, and a score half that passes on a package without the Test Lab application seam (below career-hunter 1.27.0) makes the mode unavailable, naming the seam, with no draft route touched.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Guard the announced window itself. Removing the host's refusal of `--worker-loss` without `--announced-window` (runWorkerLossOnHost) left every case above green: the flag was only proven to be READ (parseArgs), never to be REQUIRED. The new block runs the real script as a child process, the boundary an operator's command line crosses: without the flag it must exit 2 naming the flag with nothing started and docker never consulted; with the flag it must get past that refusal and stop at the next one (the Career bot's container is not running), still stopping nothing. The child has no docker on its PATH and names containers that do not exist, so neither the cases nor a regression of the refusal can reach a real container.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const workerLoss = requireCjs('../../scripts/operations/career-rail-worker-loss.js');
const runner = requireCjs('../../scripts/operations/live-proof-runner.js');

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
  /** How the run ends once its calls are admitted; 'never' keeps it running until cancelled; 'cancelled' is an owner's cancellation from elsewhere. */
  finish?: 'succeeded' | 'failed' | 'never' | 'cancelled';
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
    run.state = finish; run.finishedAt = state.clock;
    run.reason = finish === 'failed' ? (options.reason ?? 'engine-failed') : finish === 'cancelled' ? 'cancelled-by-owner' : null;
    const tail = { out: '', err: options.stderr ?? '' };
    if (finish === 'cancelled') state.settle?.({ status: 409, json: { ok: false, error: 'cancelled', runId: run.runId, state: run.state, ...tail } });
    else state.settle?.(finish === 'failed'
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

describe('the mode flags and the host spec', () => {
  it('reads one mode, the announced window and the container marker, and refuses two modes at once', () => {
    expect(proof.parseArgs([])).toEqual({ mode: 'cancel', announcedWindow: false, inContainer: false, error: null });
    expect(proof.parseArgs(['--complete'])).toMatchObject({ mode: 'complete', announcedWindow: false });
    expect(proof.parseArgs(['--worker-loss'])).toMatchObject({ mode: 'worker-loss', announcedWindow: false, error: null });
    expect(proof.parseArgs(['--worker-loss', '--announced-window', '--in-container'])).toEqual({ mode: 'worker-loss', announcedWindow: true, inContainer: true, error: null });
    expect(proof.parseArgs(['--complete', '--worker-loss']).error).toBe('choose one of --complete and --worker-loss');
  });

  it('stages the same four files for every mode and carries the mode flag after --in-container, the PAT never in argv', () => {
    for (const [mode, args] of [['cancel', []], ['complete', ['--complete']], ['worker-loss', ['--worker-loss']]] as const) {
      const spec = proof.hostSpec(mode, 'oshal_pat_secret_value');
      expect(spec.args).toEqual(args);
      expect(spec.files.map((file: { rel: string }) => file.rel)).toEqual(['operations/career-rail-live-proof.js', 'operations/career-rail-worker-loss.js',
        'operations/career-rail-draft.js', 'operations/live-proof-runner.js']);
      expect(spec.entry).toBe('operations/career-rail-live-proof.js');
      expect(spec.pat).toBe('oshal_pat_secret_value');
      expect(JSON.stringify(spec.env)).not.toContain('oshal_pat_secret_value');
    }
    expect(proof.hostTimeoutMs('cancel')).toBe(600_000 + 180_000 + 300_000);
    expect(proof.hostTimeoutMs('complete')).toBe(proof.COMPLETE_RUN_BUDGET_MS + 180_000 + (900_000 + 180_000) + 300_000);
    expect(proof.hostTimeoutMs('worker-loss')).toBe(600_000 * 2 + 180_000 + 300_000);
  });
});

describe('--complete: the score run finishes on its own', () => {
  it('passes the score half on the attribution of every admitted call with no cancellation issued; without the seam the mode is unavailable', async () => {
    const f = fake({ calls: 3 });
    const result = await proof.runCareerRailAcceptance(f.ports, { mode: 'complete' });
    expect(result.state, result.detail).toBe('unavailable');
    expect(result.caseId).toBe('career-worker-rail-complete');
    expect(result.detail).toContain('ended succeeded after 3 rail calls, uncancelled');
    expect(result.detail).toContain(`the Career bot ${AGENT} recorded 3 ledger row(s) for this owner`);
    expect(result.detail).toContain('Approve -> draft: career-hunter 1.25.1 has no Test Lab application seam (1.27.0+)');
    expect(result.evidence).toMatchObject({ mode: 'complete', runState: 'succeeded', railCalls: 3, cancelledByProof: false, routeStatus: 200, ledger: { calls: 3 },
      draft: { state: 'unavailable', planted: false }, cleanupErrors: [] });
    expect(f.state.cancels).toBe(0);
    expect(f.state.run!.railCalls).toBe(3);
  });

  it('is red when the run is still running at the budget, and the cleanup cancels it', async () => {
    const f = fake({ calls: 40, finish: 'never' });
    const result = await proof.runCareerRailAcceptance(f.ports, { mode: 'complete', runBudgetMs: 10_000, pollMs: 1_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`Run ${RUN_ID} was still running after 10s`);
    expect(result.evidence).toMatchObject({ mode: 'complete', cancelledByProof: false, runState: 'running', cleanupErrors: [] });
    expect(f.state.cancels).toBe(1);
    expect(f.state.run!.state).toBe('cancelled');
  });

  it('is red when someone else cancelled the run, which the default mode still accepts', async () => {
    const complete = await proof.runCareerRailAcceptance(fake({ calls: 2, finish: 'cancelled' }).ports, { mode: 'complete' });
    expect(complete.state).toBe('fail');
    expect(complete.detail).toContain(`Run ${RUN_ID} ended cancelled (cancelled-by-owner) after 2 rail calls; a complete run must end succeeded on its own`);
    expect(complete.evidence).not.toHaveProperty('ledger');
    const byDefault = await proof.runCareerRailAcceptance(fake({ calls: 2, finish: 'cancelled' }).ports);
    expect(byDefault.state, byDefault.detail).toBe('pass');
  });

  it('is not runnable when the run finished without a rail call, and red when it failed', async () => {
    const idle = await proof.runCareerRailAcceptance(fake({ calls: 0 }).ports, { mode: 'complete' });
    expect(idle.state).toBe('unavailable');
    expect(idle.detail).toContain('without a single rail call');
    const failed = await proof.runCareerRailAcceptance(fake({ calls: 2, finish: 'failed', reason: 'career-worker-timeout' }).ports, { mode: 'complete' });
    expect(failed.state).toBe('fail');
    expect(failed.detail).toContain(`Run ${RUN_ID} failed with reason career-worker-timeout after 2 admitted rail calls`);
  });
});

interface LossOptions {
  /** Rail calls the run admits per poll while the bot is up (default 1). */
  perPoll?: number;
  /** End the run on its own after this many calls (default: it runs until the bot is gone). */
  finishAfter?: number;
  /** Refuse the run route before any run exists. */
  refuseStart?: { status: number; error: string };
  /** What the run does once the bot is gone (default: fails with the loss reason). */
  afterStop?: 'fails' | 'succeeded' | 'hang';
  /** The reason and status the run fails with once the bot is gone. */
  lossReason?: string;
  lossStatus?: number;
  /** The registration before the run (default: online). */
  before?: { status: string; heartbeatAt: string } | null;
  /** Whether the stop removes the registration (default: it stays, stale and online, as a dead bot's does). */
  stopRemovesRegistration?: boolean;
  /** Whether a restarted bot publishes a new heartbeat (default true), and after how many reads. */
  comesBack?: boolean;
  comebackAfterReads?: number;
}

interface LossState extends FakeState {
  botUp: boolean;
  registration: { status: string; heartbeatAt: string; startedAt: string } | null;
  phases: Array<{ name: string; data: Record<string, unknown> }>;
  readsSinceStart: number | null;
}

/** The registration a bot publishes: startedAt and heartbeatAt are the same instant, every heartbeat. */
function registrationAt(atMs: number, status = 'online') {
  const at = new Date(atMs).toISOString();
  return { status, heartbeatAt: at, startedAt: at };
}

/** The run's progress per poll while the bot is up or gone. */
function advanceLossRun(state: LossState, options: LossOptions): void {
  const run = state.run!;
  if (state.botUp) {
    for (let admitted = 0; admitted < (options.perPoll ?? 1); admitted += 1) {
      if (options.finishAfter !== undefined && run.railCalls >= options.finishAfter) break;
      run.railCalls += 1;
    }
    if (options.finishAfter !== undefined && run.railCalls >= options.finishAfter) {
      run.state = 'succeeded'; run.finishedAt = state.clock;
      state.settle?.({ status: 200, json: { ok: true, out: 'AI-scored 1 postings (0 skipped).', runId: run.runId } });
    }
    return;
  }
  const after = options.afterStop ?? 'fails';
  if (after === 'hang') return;
  if (after === 'succeeded') {
    run.state = 'succeeded'; run.finishedAt = state.clock;
    state.settle?.({ status: 200, json: { ok: true, out: 'AI-scored 1 postings (0 skipped).', runId: run.runId } });
    return;
  }
  run.state = 'failed'; run.reason = options.lossReason ?? 'career-worker-unavailable'; run.finishedAt = state.clock;
  state.settle?.({ status: options.lossStatus ?? 503, json: { ok: false, error: run.reason, runId: run.runId, state: 'failed', out: '', err: `career worker unavailable: ${run.reason}` } });
}

/** The run registry, the run routes, the runtime registry and the phase hook the host would answer, in memory. */
function fakeLoss(options: LossOptions = {}) {
  const state: LossState = { clock: EPOCH, run: null, settle: null, ledger: [], cancels: 0, posts: 0, botUp: true, phases: [], readsSinceStart: null,
    registration: options.before === undefined ? registrationAt(EPOCH - 20_000) : options.before && registrationAt(EPOCH - 20_000, options.before.status) };
  const now = () => (state.clock += 1_000);
  const api = vi.fn(async (method: string, route: string): Promise<RouteAnswer> => {
    if (method === 'POST' && route === '/api/career-hunter/run/score') {
      state.posts += 1;
      if (options.refuseStart) return { status: options.refuseStart.status, json: { ok: false, error: options.refuseStart.error, err: options.refuseStart.error } };
      state.run = { runId: RUN_ID, verb: 'score', state: 'running', reason: null, startedAt: state.clock, finishedAt: null, railCalls: 0 };
      return new Promise<RouteAnswer>((settle) => { state.settle = settle; });
    }
    if (method === 'GET' && route === '/api/career-hunter/runs') {
      if (state.run?.state === 'running') advanceLossRun(state, options);
      return { status: 200, json: { runs: state.run ? [{ ...state.run }] : [] } };
    }
    if (method === 'POST' && route === `/api/career-hunter/run/${RUN_ID}/cancel`) {
      state.cancels += 1;
      const run = state.run!;
      if (run.state !== 'running') return { status: 409, json: { error: 'run already finished', state: run.state } };
      run.state = 'cancelled'; run.reason = 'cancelled-by-owner'; run.finishedAt = state.clock;
      state.settle?.({ status: 409, json: { ok: false, error: 'cancelled', runId: run.runId, state: 'cancelled', out: '', err: '' } });
      return { status: 202, json: { ok: true, runId: run.runId, cancelled: true } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
  const registry = { read: vi.fn(async () => {
    if (state.readsSinceStart !== null) {
      state.readsSinceStart += 1;
      if (options.comesBack !== false && state.readsSinceStart >= (options.comebackAfterReads ?? 2)) state.registration = registrationAt(state.clock);
    }
    return state.registration ? { ...state.registration } : null;
  }) };
  const phase = vi.fn((name: string, data: Record<string, unknown>) => {
    state.phases.push({ name, data });
    if (name === 'worker-stop') { state.botUp = false; if (options.stopRemovesRegistration) state.registration = null; }
    if (name === 'worker-start') state.readsSinceStart = 0;
  });
  return { state, ports: { api, registry, phase, careerVersion: '1.26.0', sleep: async () => undefined, now } };
}

describe('--worker-loss: the container half', () => {
  it('passes when the run fails 503 career-worker-unavailable after the stop and a strictly newer heartbeat follows the start', async () => {
    const f = fakeLoss();
    const result = await workerLoss.runWorkerLossAcceptance(f.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.caseId).toBe('career-worker-rail-worker-loss');
    expect(f.state.phases.map((phase) => phase.name)).toEqual(['worker-stop', 'worker-start']);
    expect(f.state.phases[0].data).toEqual({ runId: RUN_ID, railCalls: 1 });
    expect(f.state.phases[1].data).toEqual({ runId: RUN_ID, state: 'failed', reason: 'career-worker-unavailable' });
    expect(result.detail).toContain(`Run ${RUN_ID} failed with reason career-worker-unavailable after the Career bot was stopped (1 rail calls admitted before the loss) and the run route answered 503 career-worker-unavailable; the Career bot came back online`);
    expect(result.evidence).toMatchObject({ runId: RUN_ID, runState: 'failed', runReason: 'career-worker-unavailable', railCalls: 1, routeStatus: 503, cameBack: true, cleanupErrors: [] });
    expect(Date.parse(result.evidence.heartbeatAfter.heartbeatAt)).toBeGreaterThan(Date.parse(result.evidence.heartbeatAtLoss.heartbeatAt));
    expect(result.evidence.heartbeatBefore).toEqual(result.evidence.heartbeatAtLoss); // the dead bot's record, unchanged
    expect(f.state.cancels).toBe(0);
  });

  it('is red when the bot never comes back: a stale-online record whose heartbeat never moves, or a registration that vanished', async () => {
    const stale = fakeLoss({ comesBack: false });
    const result = await workerLoss.runWorkerLossAcceptance(stale.ports, { heartbeatBudgetMs: 10_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('and the run route answered 503 career-worker-unavailable, but the Career bot did NOT come back within 10s of its restart (last registration online at');
    expect(result.evidence).toMatchObject({ cameBack: false, runReason: 'career-worker-unavailable', cleanupErrors: [] });
    expect(stale.state.phases.map((phase) => phase.name)).toEqual(['worker-stop', 'worker-start']);
    const gone = fakeLoss({ comesBack: false, stopRemovesRegistration: true });
    const vanished = await workerLoss.runWorkerLossAcceptance(gone.ports, { heartbeatBudgetMs: 10_000 });
    expect(vanished.state).toBe('fail');
    expect(vanished.detail).toContain('did NOT come back within 10s of its restart (no registration at all)');
    expect(vanished.evidence.heartbeatAtLoss).toBeNull();
  });

  it('passes when the stop removed the registration and the restarted bot publishes a fresh one', async () => {
    const f = fakeLoss({ stopRemovesRegistration: true });
    const result = await workerLoss.runWorkerLossAcceptance(f.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.evidence.heartbeatAtLoss).toBeNull();
    expect(result.evidence.heartbeatAfter.status).toBe('online');
  });

  it('is red when the loss is not visible: the run ends succeeded, fails for another reason, or its route answers 502', async () => {
    const succeeded = await workerLoss.runWorkerLossAcceptance(fakeLoss({ afterStop: 'succeeded' }).ports);
    expect(succeeded.state).toBe('fail');
    expect(succeeded.detail).toContain(`Run ${RUN_ID} ended succeeded after the Career bot was stopped; the loss was not visible as failed/career-worker-unavailable. the Career bot came back online`);
    const other = await workerLoss.runWorkerLossAcceptance(fakeLoss({ lossReason: 'engine-failed', lossStatus: 502 }).ports);
    expect(other.state).toBe('fail');
    expect(other.detail).toContain(`Run ${RUN_ID} failed with reason engine-failed instead of career-worker-unavailable after the Career bot was stopped`);
    const mapped = await workerLoss.runWorkerLossAcceptance(fakeLoss({ lossStatus: 502 }).ports);
    expect(mapped.state).toBe('fail');
    expect(mapped.detail).toContain('but the run route answered HTTP 502 career-worker-unavailable instead of 503 career-worker-unavailable');
    expect(mapped.evidence).toMatchObject({ routeStatus: 502, cameBack: true });
  });

  it('is red and cancels the run when it keeps running after the stop, and still restarts the bot', async () => {
    const f = fakeLoss({ afterStop: 'hang' });
    const result = await workerLoss.runWorkerLossAcceptance(f.ports, { runBudgetMs: 20_000, pollMs: 1_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`Run ${RUN_ID} was still running 20s after the Career bot was stopped (1 rail calls admitted); the loss never became visible and the proof cancelled it`);
    expect(f.state.phases.map((phase) => phase.name)).toEqual(['worker-stop', 'worker-start']);
    expect(f.state.cancels).toBe(1);
    expect(f.state.run!.state).toBe('cancelled');
    expect(result.evidence).toMatchObject({ runState: 'running', cameBack: true, cleanupErrors: [] }); // the state at verdict time; the cleanup is its own field
  });

  it('stops nothing when the run ends before the bot could be stopped, when the bot is offline before, or when the start is refused', async () => {
    const early = fakeLoss({ finishAfter: 1 });
    const ended = await workerLoss.runWorkerLossAcceptance(early.ports);
    expect(ended.state).toBe('unavailable');
    expect(ended.detail).toContain(`Run ${RUN_ID} ended succeeded after 1 rail calls before the Career bot could be stopped`);
    expect(early.state.phases).toEqual([]);
    const offline = fakeLoss({ before: { status: 'offline', heartbeatAt: '' } });
    const down = await workerLoss.runWorkerLossAcceptance(offline.ports);
    expect(down.state).toBe('unavailable');
    expect(down.detail).toContain('is not online in the runtime registry (status offline); no run was started and nothing was stopped');
    expect(offline.state.posts).toBe(0);
    const none = await workerLoss.runWorkerLossAcceptance(fakeLoss({ before: null }).ports);
    expect(none.detail).toContain('(no registration)');
    const refused = fakeLoss({ refuseStart: { status: 403, error: 'authorization_app_admin_required' } });
    const notAdmitted = await workerLoss.runWorkerLossAcceptance(refused.ports);
    expect(notAdmitted.state).toBe('unavailable');
    expect(notAdmitted.detail).toContain('not admitted to career-hunter (POST /run/score answered HTTP 403 authorization_app_admin_required)');
    expect(refused.state.phases).toEqual([]);
  });

  it('is red, stopping nothing, when the run fails before the stop, naming a kernel refusal', async () => {
    const f = fakeLoss({ perPoll: 0, afterStop: 'fails' });
    // The bot is up but the run fails on its own before a call is admitted: flip it to a refusal shape.
    f.ports.api.mockImplementationOnce(async () => {
      f.state.posts += 1;
      f.state.run = { runId: RUN_ID, verb: 'score', state: 'failed', reason: 'engine-failed', startedAt: f.state.clock, finishedAt: f.state.clock, railCalls: 0 };
      return { status: 502, json: { ok: false, error: 'engine-failed', runId: RUN_ID, state: 'failed', out: '', err: 'career worker unavailable: authorization_identity_required\n' } };
    });
    const result = await workerLoss.runWorkerLossAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`Run ${RUN_ID} failed with reason engine-failed before the Career bot was stopped (the kernel refused the rail call: authorization_identity_required); nothing was stopped`);
    expect(f.state.phases).toEqual([]);
  });

  it('judges a heartbeat only when it is online and strictly newer than the record the dead bot left', () => {
    const seen = registrationAt(EPOCH);
    expect(workerLoss.heartbeatIsNewer(registrationAt(EPOCH + 1), seen)).toBe(true);
    expect(workerLoss.heartbeatIsNewer(registrationAt(EPOCH), seen)).toBe(false);
    expect(workerLoss.heartbeatIsNewer(registrationAt(EPOCH + 5_000, 'offline'), seen)).toBe(false);
    expect(workerLoss.heartbeatIsNewer(registrationAt(EPOCH - 5_000), null)).toBe(true);
    expect(workerLoss.heartbeatIsNewer(null, seen)).toBe(false);
    expect(workerLoss.heartbeatIsNewer({ status: 'online', heartbeatAt: 'never' }, null)).toBe(false);
  });
});

describe('--worker-loss: the host half', () => {
  const BOT = 'oshal-local-career-bot';
  /** A docker double that records every call and answers as asked. */
  function fakeDocker(answers: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
    const calls: string[][] = [];
    const exec = (args: string[]) => { calls.push(args); return Object.assign({ status: 0, stdout: '', stderr: '' }, answers[args[0]]); };
    return { calls, exec };
  }

  it('parses phase lines and ignores everything else', () => {
    expect(workerLoss.parsePhase(`PHASE worker-stop {"runId":"${RUN_ID}","railCalls":1}`)).toEqual({ name: 'worker-stop', data: { runId: RUN_ID, railCalls: 1 } });
    expect(workerLoss.parsePhase('PHASE worker-start')).toEqual({ name: 'worker-start', data: {} });
    expect(workerLoss.parsePhase('PHASE worker-start not-json')).toEqual({ name: 'worker-start', data: {} });
    expect(workerLoss.parsePhase('RESULT {"state":"pass"}')).toBeNull();
    expect(workerLoss.parsePhase('')).toBeNull();
  });

  it('stops on the stop phase, starts on the start phase, once each, and has nothing left to do at the end', () => {
    const docker = fakeDocker();
    const reactor = workerLoss.createWorkerLossReactor({ bot: BOT, exec: docker.exec, env: {} });
    for (const line of ['noise', 'PHASE worker-start {}', `PHASE worker-stop {"runId":"${RUN_ID}"}`, 'PHASE worker-stop {}', 'PHASE worker-start {}', 'PHASE worker-start {}', 'RESULT {}']) reactor.onLine(line);
    expect(docker.calls).toEqual([['stop', BOT], ['start', BOT]]);
    const state = reactor.finish();
    expect(docker.calls).toHaveLength(2);
    expect(state).toEqual({ stop: { status: 0, stderr: '' }, start: { status: 0, stderr: '' } });
  });

  it('restarts the bot at the end when the proof died between the two phases, and never touches it when it stopped nothing', () => {
    const died = fakeDocker();
    const reactor = workerLoss.createWorkerLossReactor({ bot: BOT, exec: died.exec, env: {} });
    reactor.onLine('PHASE worker-stop {}');
    expect(died.calls).toEqual([['stop', BOT]]);
    expect(reactor.finish().start).toEqual({ status: 0, stderr: '' });
    expect(died.calls).toEqual([['stop', BOT], ['start', BOT]]);
    const idle = fakeDocker();
    const quiet = workerLoss.createWorkerLossReactor({ bot: BOT, exec: idle.exec, env: {} });
    quiet.onLine('RESULT {"state":"unavailable"}');
    expect(quiet.finish()).toEqual({ stop: null, start: null });
    expect(idle.calls).toEqual([]);
  });

  it('reads whether the container is running through docker inspect', () => {
    expect(workerLoss.containerRunning(BOT, fakeDocker({ inspect: { status: 0, stdout: 'true\n' } }).exec, {})).toBe(true);
    expect(workerLoss.containerRunning(BOT, fakeDocker({ inspect: { status: 0, stdout: 'false\n' } }).exec, {})).toBe(false);
    expect(workerLoss.containerRunning(BOT, fakeDocker({ inspect: { status: 1, stderr: 'No such object' } }).exec, {})).toBeNull();
  });

  it('turns a passing container verdict red when the host could not stop, never restarted, could not restart, or the container is not running afterwards', () => {
    const pass = { caseId: 'career-worker-rail-worker-loss', state: 'pass', detail: 'the run failed and the bot came back.', evidence: { runId: RUN_ID } };
    const ok = { stop: { status: 0, stderr: '' }, start: { status: 0, stderr: '' } };
    expect(workerLoss.hostVerdict(pass, ok, true)).toEqual({ ...pass, evidence: { runId: RUN_ID, host: { ...ok, running: true } } });
    expect(workerLoss.hostVerdict(pass, { stop: { status: 1, stderr: 'permission denied' }, start: ok.start }, true)).toMatchObject({ state: 'fail', detail: `${pass.detail} HOST: docker stop failed (permission denied).` });
    expect(workerLoss.hostVerdict(pass, { stop: ok.stop, start: null }, false)).toMatchObject({ state: 'fail', detail: `${pass.detail} HOST: docker start was never issued; the Career bot container is not running after the restart.` });
    expect(workerLoss.hostVerdict(pass, { stop: ok.stop, start: { status: 1, stderr: 'no such container' } }, null)).toMatchObject({ state: 'fail', detail: `${pass.detail} HOST: docker start failed (no such container); the Career bot container is in an unknown state after the restart.` });
    expect(workerLoss.hostVerdict(null, ok, true)).toMatchObject({ state: 'fail', detail: 'The container half produced no verdict.' });
    const unavailable = { caseId: 'career-worker-rail-worker-loss', state: 'unavailable', detail: 'offline before.', evidence: {} };
    expect(workerLoss.hostVerdict(unavailable, { stop: null, start: null }, true)).toMatchObject({ state: 'unavailable', detail: 'offline before.' });
  });
});

describe('--worker-loss: the host refusals, through the real script as a child process', () => {
  const SCRIPT = resolve(process.cwd(), 'scripts/operations/career-rail-live-proof.js');
  /** Not a credential: a marker the cases look for in everything the child printed. */
  const PAT = 'fixture-operator-pat-marker';
  const ABSENT_BOT = 'career-rail-spec-absent-bot';
  let emptyDir = '';

  beforeAll(() => { emptyDir = mkdtempSync(join(tmpdir(), 'career-rail-host-')); });
  afterAll(() => { rmSync(emptyDir, { recursive: true, force: true }); });

  /**
   * Run the host half for real. The child's PATH is an empty directory, so no docker executable
   * resolves, and both container names are fixtures that do not exist: nothing here can reach a
   * running container, whatever the script does with its flags.
   */
  function runHost(flags: string[]): { status: number | null; stdout: string; stderr: string } {
    const env: Record<string, string> = { PATH: emptyDir, OSHAL_VERIFY_OPERATOR_PAT: PAT, OSHAL_VERIFY_ENV_FILE: join(emptyDir, 'absent.env'),
      OSHAL_VERIFY_CAREER_BOT_CONTAINER: ABSENT_BOT, OSHAL_VERIFY_API_CONTAINER: 'career-rail-spec-absent-api' };
    for (const name of ['SystemRoot', 'windir', 'TEMP', 'TMP']) if (process.env[name]) env[name] = String(process.env[name]);
    const run = spawnSync(process.execPath, [SCRIPT, ...flags], { cwd: emptyDir, env, encoding: 'utf8', timeout: 60_000 });
    return { status: run.status, stdout: String(run.stdout || ''), stderr: String(run.stderr || '') };
  }

  it('refuses --worker-loss without --announced-window: exit 2, naming the flag, nothing started, docker never consulted', () => {
    const run = runHost(['--worker-loss']);
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(2);
    expect(run.stdout).toContain('career-worker-rail-worker-loss UNAVAILABLE: --worker-loss stops the Career bot for every user of this box');
    expect(run.stdout).toContain('run it inside an announced window with --announced-window. Nothing was started.');
    expect(run.stdout).not.toContain('docker inspect');
    expect(`${run.stdout}${run.stderr}`).not.toContain(PAT);
  }, 90_000);

  it('gets past that refusal only with the flag, and then stops nothing because the Career bot container is not running', () => {
    const run = runHost(['--worker-loss', '--announced-window']);
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(2);
    expect(run.stdout).toContain(`career-worker-rail-worker-loss UNAVAILABLE: the Career bot container ${ABSENT_BOT} is not running (docker inspect); nothing was started and nothing was stopped.`);
    expect(run.stdout).not.toContain('run it inside an announced window');
    expect(`${run.stdout}${run.stderr}`).not.toContain(PAT);
  }, 90_000);
});

describe('stageAndStream', () => {
  it('stages the files, runs the entry with its flags after --in-container, hands lines to the reactor as they arrive, forwards the PAT by name only, and always unstages', async () => {
    const argvs: string[][] = [];
    const envs: Record<string, string | undefined>[] = [];
    const exec = (args: string[], env: Record<string, string | undefined>) => { argvs.push(args); envs.push(env); return { status: 0, stdout: '', stderr: '' }; };
    const seen: string[] = [];
    const spawnChild = async (args: string[], env: Record<string, string | undefined>, timeoutMs: number, onLine: (line: string) => void) => {
      argvs.push(args); envs.push(env);
      expect(timeoutMs).toBe(1_000);
      for (const line of ['PHASE worker-stop {"runId":"r"}', 'PHASE worker-start {}', 'RESULT {"caseId":"c","state":"pass","detail":"d","evidence":{}}']) await onLine(line);
      return { status: 0, stdout: 'PHASE worker-stop {"runId":"r"}\nPHASE worker-start {}\nRESULT {"caseId":"c","state":"pass","detail":"d","evidence":{}}\n', stderr: '' };
    };
    const out = await runner.stageAndStream({ container: 'api', files: [{ src: '/tmp/a.js', rel: 'operations/a.js' }, { src: '/tmp/b.js', rel: 'operations/b.js' }],
      entry: 'operations/a.js', env: { LOG_LEVEL: 'silent' }, pat: 'oshal_pat_secret_value', timeoutMs: 1_000, args: ['--worker-loss'] },
    { exec, spawnChild, onLine: (line: string) => { seen.push(line); } });
    expect(out.status).toBe(0);
    expect(runner.parseResult(out.stdout)).toMatchObject({ state: 'pass' });
    expect(seen).toHaveLength(3);
    const run = argvs.find((args) => args.includes('node'))!;
    expect(run.slice(-2)).toEqual(['--in-container', '--worker-loss']);
    expect(run[run.indexOf('-e', run.indexOf('/app')) + 1]).toBe('OSHAL_VERIFY_OPERATOR_PAT');
    expect(argvs.flat().join(' ')).not.toContain('oshal_pat_secret_value');
    expect(envs.every((env) => env.OSHAL_VERIFY_OPERATOR_PAT === 'oshal_pat_secret_value')).toBe(true);
    expect(argvs.filter((args) => args[0] === 'cp')).toHaveLength(2);
    expect(argvs[argvs.length - 1].slice(0, 4)).toEqual(['exec', 'api', 'rm', '-rf']);
  });

  it('unstages when the streamed child fails or the staging itself fails', async () => {
    const argvs: string[][] = [];
    const exec = (args: string[]) => { argvs.push(args); return { status: 0, stdout: '', stderr: '' }; };
    const spawnChild = async () => { throw new Error('docker exec exploded'); };
    await expect(runner.stageAndStream({ container: 'api', files: [{ src: '/tmp/a.js', rel: 'operations/a.js' }], entry: 'operations/a.js', env: {}, pat: 'oshal_pat_x', timeoutMs: 1_000 },
      { exec, spawnChild })).rejects.toThrow('docker exec exploded');
    expect(argvs[argvs.length - 1].slice(2, 4)).toEqual(['rm', '-rf']);
    const failing: string[][] = [];
    const failExec = (args: string[]) => { failing.push(args); return { status: args[0] === 'cp' ? 1 : 0, stdout: '', stderr: 'no such container' }; };
    const out = await runner.stageAndStream({ container: 'api', files: [{ src: '/tmp/a.js', rel: 'operations/a.js' }], entry: 'operations/a.js', env: {}, pat: 'oshal_pat_x', timeoutMs: 1_000 },
      { exec: failExec, spawnChild: async () => { throw new Error('must not run'); } });
    expect(out.status).toBe(2);
    expect(failing[failing.length - 1].slice(2, 4)).toEqual(['rm', '-rf']);
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
