/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the approve -> draft half of the Career rail live acceptance's `--complete` mode (scripts/operations/career-rail-draft.js) over an in-memory model of career-hunter 1.27.0's routes in their response shapes: the board, the application list, the Test Lab application seam, the approve route and its draft run in GET /runs, run cancellation, the packet removal, and the kernel's cost ledger answering the proof's exact statement. It passes only when the draft run ends succeeded with admitted calls, the application reads drafted and the Career bot's ledger rows since the approve number at least one and no more than those calls; it names a kernel refusal; it cancels a draft still running; a package without the seam, auto-submit on or no untouched posting is unavailable with nothing written; and every path that planted an application removes the packet and the marked application and reads the posting back, red when anything is left. The combined `--complete` verdict passes only when the score half and this half both pass. The real boundaries are the package's own suites (career-hunter tests/career-test-lab-applications.test.mjs: the seam over its compiled routes, SQLite and disposable PostgreSQL) and the ledger statement's real-PostgreSQL block in career-rail-live-proof.spec.ts; the installed run is the deploy lane's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { protectedBotWorkspaceId } from '@/app/bot-node-protected-workspace';
import { AUTHORIZATION_SCENARIOS } from '@/app/routes/test-lab-authorization-scenarios';

const requireCjs = createRequire(import.meta.url);
const proof = requireCjs('../../scripts/operations/career-rail-live-proof.js');
const draft = requireCjs('../../scripts/operations/career-rail-draft.js');

const OWNER = '100000000000000000001';
const AGENT = 'cb000000-0000-0000-0000-000000000001';
const ISSUER = 'https://oshal.example.com/';
const EPOCH = 1_700_000_000_000;
const SCORE_RUN = '11111111-2222-4333-8444-555555555555';
const DRAFT_RUN = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const API = '/api/career-hunter';
const HEX = '0a1b2c3d4e5f';
const TAG = `rail-draft-${HEX}`;
const BUDGETS = { runBudgetMs: 60_000, ledgerBudgetMs: 5_000, pollMs: 1_000, draftBudgetMs: 60_000 };

interface Job { id: number; status: string; has_resume: number; has_cover: number; generated_at: string | null }
interface Run { runId: string; verb: string; state: string; reason: string | null; startedAt: number; railCalls: number }
interface Options {
  version?: string;
  autoSubmit?: boolean;
  jobs?: Job[];
  applied?: number[];
  plantStatus?: number;
  outcome?: 'succeeded' | 'failed' | 'timeout';
  calls?: number;
  reason?: string;
  approveError?: string;
  noLedger?: boolean;
  extraLedger?: number;
  notDrafted?: boolean;
  seamDeleteStatus?: number;
  leavePacket?: boolean;
  scoreCalls?: number;
}

const job = (id: number, over: Partial<Job> = {}): Job => ({ id, status: 'new', has_resume: 0, has_cover: 0, generated_at: null, ...over });
/** The board: a worked posting, one with an application, then the untouched one the proof may borrow. */
const BOARD = [job(41, { status: 'generated', has_resume: 1, has_cover: 1, generated_at: '2026-09-20T00:00:00Z' }), job(42), job(43)];

/** One ledger row the way the Career node keys a protected execution. */
function ledgerRow(ts: number, execution: string) {
  const workspace = protectedBotWorkspaceId({ principalIssuer: ISSUER, userSub: OWNER, app: 'career-hunter', agentId: AGENT,
    workspaceFolderId: `career-engine-${OWNER}`, executionId: execution });
  return { ts, taskId: `${workspace}::${AGENT}` };
}

/** career-hunter 1.27.0's owner routes and the kernel's cost ledger, in memory. */
function fakePackage(options: Options = {}) {
  const state = {
    clock: EPOCH, calls: [] as string[], runs: [] as Run[], ledger: [] as Array<{ ts: number; taskId: string }>,
    jobs: new Map((options.jobs ?? BOARD).map((row) => [row.id, { ...row }])),
    apps: new Map<number, { posting_id: number; status: string; tag: string | null }>((options.applied ?? [42]).map((id) => [id, { posting_id: id, status: 'drafted', tag: null }])),
  };
  const now = () => (state.clock += 1_000);
  const answer = (status: number, json: Record<string, unknown> = {}) => ({ status, json });

  function approve(postingId: number) {
    const app = state.apps.get(postingId);
    if (!app) return answer(500, { ok: false, error: 'career application ticket is missing' });
    app.status = 'drafting';
    const run: Run = { runId: DRAFT_RUN, verb: 'draft', state: 'running', reason: null, startedAt: state.clock, railCalls: 0 };
    state.runs.unshift(run);
    const outcome = options.outcome ?? 'succeeded';
    for (let call = 1; call <= (options.calls ?? 2); call += 1) {
      run.railCalls = call;
      if (!options.noLedger) state.ledger.push(ledgerRow(state.clock, `draft-${call}`));
    }
    for (let extra = 0; extra < (options.extraLedger ?? 0); extra += 1) state.ledger.push(ledgerRow(state.clock, `elsewhere-${extra}`));
    if (outcome === 'timeout') throw new Error('The operation was aborted due to timeout');
    if (outcome === 'failed') {
      Object.assign(run, { state: 'failed', reason: options.reason ?? 'engine-failed' });
      app.status = 'error';
      return answer(500, { ok: false, error: options.approveError ?? 'career worker unavailable: career-worker-error' });
    }
    run.state = 'succeeded';
    app.status = options.notDrafted ? 'error' : 'drafted';
    Object.assign(state.jobs.get(postingId)!, { status: 'generated', has_resume: 1, has_cover: 1, generated_at: '2026-09-29T00:00:00Z' });
    return answer(200, { ok: true, oshal: false });
  }

  function plant(body: { postingId: number; tag: string }) {
    if (options.plantStatus) return answer(options.plantStatus, { error: 'the posting has been worked; the seam borrows only an untouched posting' });
    expect(body.tag).toMatch(/^[a-z0-9][a-z0-9-]{5,63}$/);
    state.apps.set(body.postingId, { posting_id: body.postingId, status: 'approval_required', tag: body.tag });
    return answer(201, { ok: true, postingId: body.postingId, tag: body.tag, status: 'approval_required' });
  }

  function removePacket(postingId: number) {
    const row = state.jobs.get(postingId)!;
    if (!row.has_resume) return answer(404, { error: 'no generated packet for this posting' });
    if (!options.leavePacket) Object.assign(row, { status: 'new', has_resume: 0, has_cover: 0, generated_at: null });
    return answer(200, { ok: true, removed: [`Fixture__${postingId}`], status: 'new' });
  }

  function removeMarked(postingId: number, tag: string) {
    if (options.seamDeleteStatus) return answer(options.seamDeleteStatus, { error: 'the marked application could not be removed' });
    const app = state.apps.get(postingId);
    if (!app || app.tag !== tag) return answer(404, { error: 'no application of the caller carries this Test Lab mark' });
    if (app.status === 'drafting') return answer(409, { error: 'the application is drafting; it is not removed from here', status: 'drafting' });
    state.apps.delete(postingId);
    return answer(200, { ok: true, postingId, removed: { application: true, ticket: true } });
  }

  function scoreRun() {
    const run: Run = { runId: SCORE_RUN, verb: 'score', state: 'succeeded', reason: null, startedAt: state.clock, railCalls: options.scoreCalls ?? 1 };
    for (let call = 1; call <= run.railCalls; call += 1) state.ledger.push(ledgerRow(state.clock, `score-${call}`));
    state.runs.push(run);
    return answer(200, { ok: true, out: 'AI-scored 1 postings (0 skipped).', runId: run.runId });
  }

  function cancel(runId: string) {
    const run = state.runs.find((item) => item.runId === runId);
    if (!run) return answer(404, { error: 'run not found' });
    if (run.state !== 'running') return answer(409, { error: 'run already finished', state: run.state });
    Object.assign(run, { state: 'cancelled', reason: 'cancelled-by-owner' });
    const app = [...state.apps.values()].find((item) => item.status === 'drafting');
    if (app) app.status = 'error';
    return answer(202, { ok: true, runId, cancelled: true });
  }

  const api = vi.fn(async (method: string, route: string, body?: any) => {
    state.calls.push(`${method} ${route}`);
    const path = route.split('?')[0].replace(API, '');
    const [, first, second, third, fourth] = path.split('/');
    if (method === 'GET' && path === '/automation/state') return answer(200, { autoGenerate: false, autoSubmit: options.autoSubmit === true });
    if (method === 'GET' && path === '/jobs') return answer(200, { jobs: [...state.jobs.values()].map((row) => ({ ...row })) });
    if (method === 'GET' && first === 'jobs' && second) return answer(200, { job: { ...state.jobs.get(Number(second))! } });
    if (method === 'GET' && path === '/applications') return answer(200, { applications: [...state.apps.values()].map(({ posting_id, status }) => ({ posting_id, status })) });
    if (method === 'GET' && path === '/runs') return answer(200, { runs: state.runs.map((run) => ({ ...run })) });
    if (method === 'POST' && path === '/test-lab/applications') return plant(body);
    if (method === 'POST' && first === 'applications' && third === 'approve') return approve(Number(second));
    if (method === 'POST' && path === '/run/score') return scoreRun();
    if (method === 'POST' && first === 'run' && third === 'cancel') return cancel(second);
    if (method === 'DELETE' && first === 'jobs' && third === 'packet') return removePacket(Number(second));
    if (method === 'DELETE' && first === 'test-lab' && second === 'applications') return removeMarked(Number(third), fourth);
    throw new Error(`unexpected ${method} ${route}`);
  });

  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql === proof.LEDGER_SQL) {
      expect(params.slice(0, 2)).toEqual([AGENT, OWNER]);
      const rows = state.ledger.filter((row) => row.ts >= (params[2] as Date).getTime());
      return { rows: [{ calls: rows.length, cost_usd: rows.length * 0.002, input_tokens: rows.length * 4000, output_tokens: rows.length * 900, task_ids: rows.map((row) => row.taskId) }] };
    }
    expect(sql).toBe(proof.ROLLUP_SQL);
    return { rows: [] };
  });

  const io = { api, query, withOwner: <T>(fn: () => Promise<T>) => fn(), ownerSub: OWNER, careerVersion: options.version ?? '1.27.0',
    sleep: async () => undefined, now, randomHex: () => HEX };
  return { io, state };
}

const writes = (calls: string[]) => calls.filter((call) => !call.startsWith('GET '));

describe('the seam version gate and the tag', () => {
  it('runs the draft half only against career-hunter 1.27.0 and later, with a tag the seam accepts', () => {
    expect(draft.hasDraftSeam('1.26.0')).toBe(false);
    expect(draft.hasDraftSeam('1.27.0')).toBe(true);
    expect(draft.hasDraftSeam('1.28.3')).toBe(true);
    expect(draft.hasDraftSeam('2.0.0')).toBe(true);
    expect(draft.hasDraftSeam('1.9.99')).toBe(false);
    expect(draft.hasDraftSeam(undefined)).toBe(false);
    expect(draft.makeTag(() => HEX)).toMatch(/^[a-z0-9][a-z0-9-]{5,63}$/);
  });
});

describe('runDraftHalf', () => {
  it('passes when the approved draft ends succeeded on the rail, reads drafted and is attributed to the Career bot, then removes exactly what it planted', async () => {
    const f = fakePackage();
    const result = await draft.runDraftHalf(f.io, BUDGETS);
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain(`Run ${DRAFT_RUN} was a draft that ended succeeded after 2 rail calls (the application reads drafted)`);
    expect(result.detail).toContain(`the Career bot ${AGENT} recorded 2 ledger row(s) for this owner`);
    expect(result.detail).toContain('The packet and the marked application with its ticket were removed');
    expect(result.evidence).toMatchObject({ postingId: 43, tag: TAG, planted: true, approveStatus: 200, draftRunId: DRAFT_RUN,
      draftState: 'succeeded', draftRailCalls: 2, applicationStatus: 'drafted', ledger: { calls: 2 } });
    expect(result.cleanupErrors).toEqual([]);
    expect(writes(f.state.calls)).toEqual([`POST ${API}/test-lab/applications`, `POST ${API}/applications/43/approve`,
      `DELETE ${API}/jobs/43/packet`, `DELETE ${API}/test-lab/applications/43/${TAG}`]);
    expect(f.state.apps.has(43)).toBe(false);
    expect(f.state.jobs.get(43)).toEqual(job(43));
    expect(f.state.apps.get(42)).toMatchObject({ status: 'drafted' });
  });

  it('is unavailable, writing nothing, without the seam, with auto-submit on, or with no untouched posting', async () => {
    const cases: Array<[Options, string]> = [
      [{ version: '1.26.0' }, 'career-hunter 1.26.0 has no Test Lab application seam (1.27.0+)'],
      [{ autoSubmit: true }, 'Career auto-submit is on for this identity'],
      [{ jobs: [BOARD[0], BOARD[1]] }, 'No untouched posting without an application'],
    ];
    for (const [options, detail] of cases) {
      const f = fakePackage(options);
      const result = await draft.runDraftHalf(f.io, BUDGETS);
      expect(result.state).toBe('unavailable');
      expect(result.detail).toContain(detail);
      expect(result.detail).toContain('nothing was written');
      expect(writes(f.state.calls)).toEqual([]);
    }
  });

  it('fails naming the kernel refusal when the draft fails at the rail, and still removes the planted application', async () => {
    const f = fakePackage({ outcome: 'failed', reason: 'engine-failed', calls: 0, approveError: 'career worker unavailable: authorization_identity_required' });
    const result = await draft.runDraftHalf(f.io, BUDGETS);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`Draft run ${DRAFT_RUN} ended failed (engine-failed) after 0 admitted rail calls; the kernel refused the rail call before package code ran: authorization_identity_required`);
    expect(f.io.query).not.toHaveBeenCalled();
    expect(result.cleanupErrors).toEqual([]);
    expect(f.state.apps.has(43)).toBe(false);
    expect(f.state.calls).toContain(`DELETE ${API}/jobs/43/packet`);
  });

  it('is red on no cost row, on more cost rows than calls, and on an application that does not read drafted', async () => {
    const none = await draft.runDraftHalf(fakePackage({ noLedger: true }).io, BUDGETS);
    expect(none.state).toBe('fail');
    expect(none.detail).toContain(`the kernel recorded no cost for agent ${AGENT} under this owner`);
    const extra = await draft.runDraftHalf(fakePackage({ extraLedger: 1 }).io, BUDGETS);
    expect(extra.state).toBe('fail');
    expect(extra.detail).toContain('holds 3 ledger rows for agent');
    const error = await draft.runDraftHalf(fakePackage({ notDrafted: true }).io, BUDGETS);
    expect(error.state).toBe('fail');
    expect(error.detail).toContain('succeeded but the application reads error, not drafted');
    for (const result of [none, extra, error]) expect(result.cleanupErrors).toEqual([]);
  });

  it('cancels a draft still running when the approve times out, then removes the application once the handler settles', async () => {
    const f = fakePackage({ outcome: 'timeout' });
    const result = await draft.runDraftHalf(f.io, BUDGETS);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`Draft run ${DRAFT_RUN} was still running after 60s (2 rail calls admitted); the proof cancelled it.`);
    expect(result.evidence).toMatchObject({ approveStatus: 0, draftState: 'running' });
    expect(f.state.calls).toContain(`POST ${API}/run/${DRAFT_RUN}/cancel`);
    expect(f.state.runs[0].state).toBe('cancelled');
    expect(result.cleanupErrors).toEqual([]);
    expect(f.state.apps.has(43)).toBe(false);
  });

  it('turns an incomplete cleanup red: a seam that will not remove, or a posting that does not read as before', async () => {
    const stuck = await draft.runDraftHalf(fakePackage({ seamDeleteStatus: 500 }).io, BUDGETS);
    expect(stuck.cleanupErrors).toEqual([`DELETE /test-lab/applications/43/${TAG} answered 500 the marked application could not be removed`,
      'an application for posting 43 is still listed']);
    const packet = await draft.runDraftHalf(fakePackage({ leavePacket: true }).io, BUDGETS);
    expect(packet.cleanupErrors).toHaveLength(1);
    expect(packet.cleanupErrors[0]).toContain('posting 43 is {"status":"generated"');
    expect(packet.detail).not.toContain('were removed');
  });

  it('fails without cleanup work when the seam refuses the plant', async () => {
    const f = fakePackage({ plantStatus: 409 });
    const result = await draft.runDraftHalf(f.io, BUDGETS);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('POST /test-lab/applications answered 409');
    expect(result.evidence).toMatchObject({ planted: false });
    expect(writes(f.state.calls)).toEqual([`POST ${API}/test-lab/applications`]);
  });
});

describe('--complete: the score run and the approve -> draft half', () => {
  it('passes only when both halves pass, reporting the draft under its own evidence', async () => {
    const f = fakePackage({ scoreCalls: 3 });
    const result = await proof.runCareerRailAcceptance(f.io, { mode: 'complete', ...BUDGETS });
    expect(result.state, result.detail).toBe('pass');
    expect(result.caseId).toBe('career-worker-rail-complete');
    expect(result.detail).toContain(`Run ${SCORE_RUN} was ended succeeded after 3 rail calls, uncancelled`);
    expect(result.detail).toContain(`Approve -> draft: Run ${DRAFT_RUN} was a draft that ended succeeded after 2 rail calls`);
    expect(result.evidence).toMatchObject({ runState: 'succeeded', ledger: { calls: 3 }, cleanupErrors: [],
      draft: { state: 'pass', postingId: 43, draftState: 'succeeded', ledger: { calls: 2 } } });
  });

  it('is unavailable when the package has no seam, and never plants when the score half did not pass', async () => {
    const older = fakePackage({ version: '1.26.0' });
    const unseamed = await proof.runCareerRailAcceptance(older.io, { mode: 'complete', ...BUDGETS });
    expect(unseamed.state).toBe('unavailable');
    expect(unseamed.detail).toContain('Approve -> draft: career-hunter 1.26.0 has no Test Lab application seam');
    expect(writes(older.state.calls)).toEqual([`POST ${API}/run/score`]);
    const idle = fakePackage({ scoreCalls: 0 });
    const noScore = await proof.runCareerRailAcceptance(idle.io, { mode: 'complete', ...BUDGETS });
    expect(noScore.state).toBe('unavailable');
    expect(noScore.evidence).not.toHaveProperty('draft');
    expect(writes(idle.state.calls)).toEqual([`POST ${API}/run/score`]);
  });

  it('carries the draft half\'s cleanup errors into the case', async () => {
    const f = fakePackage({ seamDeleteStatus: 500 });
    const result = await proof.runCareerRailAcceptance(f.io, { mode: 'complete', ...BUDGETS });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: DELETE /test-lab/applications/43/${TAG} answered 500`);
    expect(result.evidence.cleanupErrors).toContain('an application for posting 43 is still listed');
  });
});

describe('Test Lab registration', () => {
  it('attaches this spec to the Access Administration card beside the live-proof spec, in the command that runs it', () => {
    const scenario = AUTHORIZATION_SCENARIOS.find((item) => item.id === 'authorization-management')!;
    const paths = scenario.regressionTests!.map((item) => item.path);
    expect(paths).toEqual(expect.arrayContaining(['tests/unit/career-rail-live-proof.spec.ts', 'tests/unit/career-rail-draft.spec.ts']));
    expect(existsSync(resolve('tests/unit/career-rail-draft.spec.ts'))).toBe(true);
    expect(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts['test:authorization']).toContain('tests/unit/career-rail-draft.spec.ts');
    expect(existsSync(resolve('scripts/operations/career-rail-draft.js'))).toBe(true);
  });
});
