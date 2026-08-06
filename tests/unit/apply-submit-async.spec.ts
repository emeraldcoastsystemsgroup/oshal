/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavior guard for the async conversion of the job-apply gather+dispatch core (was spawnSync — up to four sequential 60s blocking spawns per dispatch on the api event loop; the 07-15 wedge class). Mocks child_process.spawn: proves the {parse-last-stdout-line -> null} CLI contract, the 202 dispatch path, the empty-queue 409, per-user single-flight (409) and the global APPLY_MAX_DISPATCHES ceiling (429), and that runApplyCli resolves (never rejects) on process error.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require the queue CLI to acknowledge the exact
 *   posting claim before dispatch and prove an absent/mismatched acknowledgement stays retryable.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove unspecified/internal dispatch is
 *   final-submit denied and only explicit server authorization reaches ApplyDispatchInput as true.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Guard raw-claim reaping and ambiguity-safe timeout/idle-worker recovery: strip submit authority, release the posting, and park the ticket for human review.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Prove apply helper children receive exact caller/trace scope without controller, database, or caller-injected environment values.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Prove dispatch creates and binds one durable Apply V2 run and sends its exact claim token through every Career queue mutation.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A controllable fake ChildProcess: emit stdout lines then close, all async. */
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
}

interface SpawnCall { argv: string[]; proc: FakeProc; }
const spawnCalls: SpawnCall[] = [];
/** Per-test responder: receives the CLI argv AFTER the script path; drives the fake proc. */
let responder: (verbArgs: string[], proc: FakeProc) => void = () => { /* set per test */ };

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, argv: string[]) => {
    const proc = new FakeProc();
    const call = { argv, proc };
    spawnCalls.push(call);
    // Defer so runApplyCli attaches its stdout/close listeners first (mirrors real spawn timing).
    queueMicrotask(() => responder(argv.slice(1), proc));
    return proc;
  }),
}));

vi.mock('@/app/apply-dispatch', () => ({
  dispatchApply: vi.fn(async () => ({ ok: true, taskId: 'task-1', clientId: 'client-1' })),
  removeApplyWorkspace: vi.fn(async () => undefined),
}));

const remoteState = vi.hoisted(() => ({
  client: null as Record<string, unknown> | null,
  completed: null as Record<string, unknown> | null,
}));
const getCompletedResultMock = vi.fn(async () => remoteState.completed);
vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    getClient: () => remoteState.client,
    getCompletedResult: (...args: unknown[]) => getCompletedResultMock(...args),
  },
}));

const revokeCapabilityMock = vi.fn(async () => 'revoked');
vi.mock('@/app/apply-task-capability', () => ({
  revokeUnclaimedApplyCapability: (...args: unknown[]) => revokeCapabilityMock(...args),
}));

const ledgerState = vi.hoisted(() => ({
  run: {
    runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    claimToken: 'ffffffff-1111-4222-8333-444444444444',
  },
  expired: [] as Array<Record<string, unknown>>,
}));
const createRunMock = vi.fn(async (_pool: unknown, input: Record<string, unknown>) => ({
  ...ledgerState.run,
  ticketId: input.ticketId,
  ownerSub: input.ownerSub,
  postingId: input.postingId,
  state: 'claimed',
}));
const transitionRunMock = vi.fn(async (_pool: unknown, input: Record<string, unknown>) => ({
  ...ledgerState.run, state: input.to,
}));
vi.mock('@/app/apply-run-ledger', () => ({
  APPLY_UNDISPATCHED_TIMEOUT_MS: 120_000,
  createApplyRun: (...args: unknown[]) => createRunMock(...args as [unknown, Record<string, unknown>]),
  listExpiredApplyRuns: async () => ledgerState.expired,
  transitionApplyRun: (...args: unknown[]) => transitionRunMock(...args as [unknown, Record<string, unknown>]),
}));

import {
  buildApplyCliProcessEnv,
  gatherAndDispatch,
  reconcileApplyInFlight,
  recoverExpiredApplyRuns,
  recoverUnknownApply,
  runApplyCli,
} from '@/app/apply-submit';
import { dispatchApply, removeApplyWorkspace } from '@/app/apply-dispatch';
import { APPLY_WORKER_ACK_TIMEOUT_MS, applyInFlight, clearInFlight } from '@/app/apply-inflight';
import type { AppContext } from '@/app/composition/app-context';
import { AUTHENTICATED_SINGLE_JOB_SUBMIT } from '@/app/apply-submit-authorization';

/** Emits `lines` on stdout then closes with `code` (async, like a real process). */
function reply(proc: FakeProc, lines: string[], code = 0): void {
  for (const l of lines) proc.stdout.emit('data', `${l}\n`);
  proc.emit('close', code);
}

function makeCtx(): AppContext {
  return {
    pool: {},
    ticketService: {
      getTicket: vi.fn(async (ticketId: string) => ({
        ticketId, status: 'in_process_build', metadata: {
          applyFinalSubmitAuthorized: true,
          applyFinalSubmitAuthorizationSource: 'authenticated-single-job',
          applyFinalSubmitAuthorizationSeal: 'sealed',
        },
      })),
      updateTicket: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => undefined),
    },
  } as unknown as AppContext;
}

const ITEM = { posting_id: 7, title: 'SE II', company: 'ACME', url: 'https://jobs.test/7', location: 'Remote', resume_pdf: '/p/r.pdf', cover_pdf: '/p/c.pdf', workday_autofill: null };

/** Happy-path responder: queue next -> item, profile -> profile, everything else -> {}. */
function happyResponder(verbArgs: string[], proc: FakeProc): void {
  const verb = verbArgs.join(' ');
  if (verb.startsWith('queue next')) reply(proc, ['gathering…', JSON.stringify({ item: ITEM })]);
  else if (verb.startsWith('profile')) reply(proc, [JSON.stringify({ name: 'the operator', email: 'r@test' })]);
  else if (verb.startsWith('queue claim')) reply(proc, [JSON.stringify({
    ok: true, posting_id: ITEM.posting_id, claimed: true, apply_run_id: ledgerState.run.runId,
  })]);
  else if (verb.startsWith('queue requeue')) reply(proc, [JSON.stringify({ ok: true, posting_id: ITEM.posting_id })]);
  else reply(proc, ['{}']);
}

beforeEach(() => {
  spawnCalls.length = 0;
  vi.mocked(dispatchApply).mockClear();
  vi.mocked(dispatchApply).mockResolvedValue({ ok: true, taskId: 'task-1', clientId: 'client-1' });
  vi.mocked(removeApplyWorkspace).mockClear();
  revokeCapabilityMock.mockClear();
  revokeCapabilityMock.mockResolvedValue('revoked');
  getCompletedResultMock.mockClear();
  createRunMock.mockClear();
  transitionRunMock.mockClear();
  ledgerState.expired = [];
  remoteState.client = null;
  remoteState.completed = null;
});

afterEach(() => {
  // Drop any armed watchdog so the fake taskId can't leak between tests.
  clearInFlight('task-1');
});

describe('runApplyCli — async CLI contract (no spawnSync)', () => {
  it('builds an exact helper environment without controller or injected secrets', () => {
    const env = buildApplyCliProcessEnv(
      ' Owner-Exact ',
      { APPLY_RESULT: 'assist_review', DATABASE_URL: 'caller-injected-database' },
      {
        PATH: 'C:\\runtime',
        JOBHUNTER_STORE_ROOT: 'C:\\career-store',
        DATABASE_URL: 'controller-database',
        SESSION_SECRET: 'controller-session',
      },
    );
    expect(env).toEqual({
      PATH: 'C:\\runtime',
      JOBHUNTER_STORE_ROOT: 'C:\\career-store',
      OSHAL_USER_SUB: ' Owner-Exact ',
      APPLY_RESULT: 'assist_review',
    });
  });

  it('resolves the JSON-parsed LAST stdout line (noise lines ignored)', async () => {
    responder = (_v, proc) => reply(proc, ['warming up', 'not json either', JSON.stringify({ ok: 1 })]);
    await expect(runApplyCli('u1', ['profile'])).resolves.toEqual({ ok: 1 });
  });

  it('resolves null on unparseable/empty output and NEVER rejects on process error', async () => {
    responder = (_v, proc) => reply(proc, []);
    await expect(runApplyCli('u1', ['profile'])).resolves.toBeNull();
    responder = (_v, proc) => proc.emit('error', new Error('spawn ENOENT'));
    await expect(runApplyCli('u1', ['profile'])).resolves.toBeNull();
  });

  it('scopes the run to the user via OSHAL_USER_SUB and threads extraEnv', async () => {
    const cp = await import('child_process');
    const spawnMock = cp.spawn as unknown as { mock: { calls: unknown[][] } };
    responder = (_v, proc) => reply(proc, ['null']);
    await runApplyCli('sub-42', ['trace'], { extraEnv: { APPLY_RESULT: 'escalated' } });
    const opts = spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[2] as { env: Record<string, string> };
    expect(opts.env.OSHAL_USER_SUB).toBe('sub-42');
    expect(opts.env.APPLY_RESULT).toBe('escalated');
  });
});

describe('gatherAndDispatch — async, guarded (07-15 wedge-class conversion)', () => {
  it('dispatches the gathered job: 202 with postingId + taskId, watchdog armed', async () => {
    responder = happyResponder;
    const r = await gatherAndDispatch(makeCtx(), 'user-a');
    expect(r.status).toBe(202);
    expect(r.body.postingId).toBe(7);
    expect(r.body.taskId).toBe('task-1');
    expect((r.body.job as { company: string }).company).toBe('ACME');
    expect(applyInFlight.has('task-1')).toBe(true);
    expect(dispatchApply).toHaveBeenCalledWith(
      expect.objectContaining({
        finalSubmitAuthorized: false,
        timeoutAt: expect.any(Date),
      }), expect.any(Object),
    );
    const createInput = createRunMock.mock.calls[0]?.[1] as { timeoutAt: Date };
    expect(createInput.timeoutAt.getTime() - Date.now()).toBeGreaterThan(110_000);
    expect(createInput.timeoutAt.getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    // CLI chain ran in order: stale-claim reap -> queue next -> profile -> queue claim.
    const verbs = spawnCalls.map((c) => c.argv.slice(1, 3).join(' '));
    expect(verbs).toEqual(['queue reap', 'queue next', 'profile', 'queue claim']);
  });

  it('carries an explicit authenticated single-job decision into the dispatch input', async () => {
    responder = happyResponder;
    const result = await gatherAndDispatch(
      makeCtx(), 'user-explicit', undefined, undefined, undefined, AUTHENTICATED_SINGLE_JOB_SUBMIT,
    );
    expect(result.status).toBe(202);
    expect(dispatchApply).toHaveBeenCalledWith(
      expect.objectContaining({ finalSubmitAuthorized: true }), expect.any(Object),
    );
  });

  it('does not upgrade a raw true flag without a recognized controller source', async () => {
    responder = happyResponder;
    const result = await gatherAndDispatch(
      makeCtx(), 'user-malformed', undefined, undefined, undefined,
      { finalSubmitAuthorized: true } as never,
    );
    expect(result.status).toBe(202);
    expect(dispatchApply).toHaveBeenCalledWith(
      expect.objectContaining({ finalSubmitAuthorized: false }), expect.any(Object),
    );
  });

  it('returns 409 when no submittable job is ready', async () => {
    responder = (_v, proc) => reply(proc, [JSON.stringify({ note: 'queue empty' })]);
    const r = await gatherAndDispatch(makeCtx(), 'user-b');
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('no submittable job');
    expect(r.body.note).toBe('queue empty');
  });

  it('returns retryable 503 and never dispatches when the exact queue claim is not acknowledged', async () => {
    responder = (verbArgs, proc) => {
      const verb = verbArgs.join(' ');
      if (verb.startsWith('queue next')) reply(proc, [JSON.stringify({ item: ITEM })]);
      else if (verb.startsWith('profile')) reply(proc, [JSON.stringify({ name: 'operator' })]);
      else reply(proc, [JSON.stringify({ ok: true, posting_id: 999, claimed: true })]);
    };
    const result = await gatherAndDispatch(makeCtx(), 'claim-mismatch');
    expect(result).toMatchObject({ status: 503, body: { retryable: true } });
    expect(dispatchApply).not.toHaveBeenCalled();
  });

  it('single-flight per user: a concurrent dispatch for the SAME user gets 409 without spawning', async () => {
    let release!: () => void;
    responder = (verbArgs, proc) => {
      if (verbArgs.join(' ').startsWith('queue reap') && !release) {
        release = () => reply(proc, ['null']);
      } else reply(proc, ['null']);
    }; // first stale-claim sweep hangs until released
    const first = gatherAndDispatch(makeCtx(), 'user-sf');
    await Promise.resolve(); // let the first claim its slot + spawn
    const before = spawnCalls.length;
    const second = await gatherAndDispatch(makeCtx(), 'user-sf');
    expect(second.status).toBe(409);
    expect(spawnCalls.length).toBe(before); // guard rejected BEFORE any engine spawn
    release();
    await expect(first).resolves.toMatchObject({ status: 409 }); // empty queue -> 409, slot freed
    // slot actually freed: a fresh dispatch for the user runs again
    responder = (_v, proc) => reply(proc, ['null']);
    await expect(gatherAndDispatch(makeCtx(), 'user-sf')).resolves.toMatchObject({ status: 409 });
  });

  it('global ceiling (APPLY_MAX_DISPATCHES default 3): a 4th concurrent user gets 429', async () => {
    const releases: Array<() => void> = [];
    responder = (verbArgs, proc) => {
      if (verbArgs.join(' ').startsWith('queue reap')) releases.push(() => reply(proc, ['null']));
      else reply(proc, ['null']);
    };
    const inflight = [gatherAndDispatch(makeCtx(), 'cap-1'), gatherAndDispatch(makeCtx(), 'cap-2'), gatherAndDispatch(makeCtx(), 'cap-3')];
    await Promise.resolve();
    const fourth = await gatherAndDispatch(makeCtx(), 'cap-4');
    expect(fourth.status).toBe(429);
    for (const r of releases) r();
    await Promise.all(inflight);
  });

  it('desktop offline -> 503 retryable and ROLLS THE CLAIM BACK (never poisons its own posting)', async () => {
    responder = happyResponder;
    vi.mocked(dispatchApply).mockResolvedValue({ ok: false, error: 'desktop worker offline' });
    const r = await gatherAndDispatch(makeCtx(), 'user-c');

    expect(r.status).toBe(503);
    // Retryable so the durable job-apply ticket DEFERS (stays approved) instead of escalating.
    expect(r.body.retryable).toBe(true);
    const verbs = spawnCalls.map((c) => c.argv.slice(1, 3).join(' '));
    // We claimed the posting moments ago; the dispatch never reached the desktop, so the claim MUST
    // be rolled back or the retry can't find the posting (`queue next --posting` returns nothing) and
    // the ticket escalates "no submittable job ready" — poisoned by its own attempt (cost 8 tickets
    // on 2026-07-21). Recording a 'deferred' outcome here is exactly that poison.
    expect(verbs).toContain('queue requeue');
    expect(verbs).not.toContain('queue record');
  });

  it('an unknown timeout outcome is never auto-retried and loses final-submit authority', async () => {
    responder = happyResponder;
    const ctx = makeCtx();
    await expect(gatherAndDispatch(ctx, 'timeout-user', 'ticket-timeout')).resolves.toMatchObject({ status: 202 });

    await expect(recoverUnknownApply(ctx, 'task-1', 'apply_submission_timeout')).resolves.toBe(true);

    expect(ctx.ticketService.updateTicket).toHaveBeenCalledWith('ticket-timeout', {
      metadata: expect.objectContaining({
        applyFinalSubmitAuthorized: false,
        applyFinalSubmitAuthorizationSource: null,
        applyFinalSubmitAuthorizationSeal: null,
        applyRecoveryState: 'assist_review',
        applyRecoveryReason: 'apply_submission_timeout',
      }),
    });
    expect(ctx.ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-timeout', 'customer_action', expect.objectContaining({ source: 'apply-recovery' }),
    );
    expect(ctx.ticketService.updateStatus).not.toHaveBeenCalledWith(
      'ticket-timeout', 'approved', expect.anything(),
    );
    expect(spawnCalls.map((c) => c.argv.slice(1, 3).join(' '))).toContain('queue record');
    expect(transitionRunMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runId: ledgerState.run.runId, to: 'unknown_outcome',
    }));
    expect(removeApplyWorkspace).toHaveBeenCalledWith('task-1');
    expect(applyInFlight.has('task-1')).toBe(false);
  });

  it('a healthy assigned worker idle before acknowledgement is safely abandoned and released', async () => {
    responder = happyResponder;
    const ctx = makeCtx();
    await gatherAndDispatch(ctx, 'idle-user', 'ticket-idle');
    remoteState.client = {
      clientId: 'client-1', status: 'online', healthy: true,
      activeTaskId: undefined, taskQueueDepth: 0,
    };

    const recovered = await reconcileApplyInFlight(
      ctx, Date.now() + APPLY_WORKER_ACK_TIMEOUT_MS + 1,
    );

    expect(recovered).toBe(1);
    expect(getCompletedResultMock).toHaveBeenCalledWith('client-1', 'task-1');
    expect(ctx.ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-idle', 'approved', expect.objectContaining({
        reason: 'worker_ack_timeout_idle',
      }),
    );
    expect(transitionRunMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runId: ledgerState.run.runId, to: 'abandoned',
    }));
    expect(applyInFlight.has('task-1')).toBe(false);
  });

  it('CAS-fails and releases an expired undispatched claim without waiting for ticket age', async () => {
    responder = happyResponder;
    ledgerState.expired = [{
      runId: ledgerState.run.runId,
      claimToken: ledgerState.run.claimToken,
      ticketId: 'ticket-expired', ownerSub: 'expired-owner', postingId: 73,
      taskId: null, workerClientId: null, state: 'claimed',
      claimedAt: new Date(Date.now() - 121_000).toISOString(), dispatchedAt: null,
      timeoutAt: new Date(Date.now() - 1_000).toISOString(),
    }];
    const ctx = makeCtx();
    const recovered = await recoverExpiredApplyRuns(ctx);
    expect(recovered).toBe(1);
    expect(transitionRunMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runId: ledgerState.run.runId,
      from: ['claimed'], to: 'failed', failureCode: 'undispatched_claim_timeout',
    }));
    expect(spawnCalls.at(-1)?.argv.slice(1)).toEqual([
      'queue', 'requeue', '73', '--run-id', ledgerState.run.runId,
      '--claim-token', ledgerState.run.claimToken,
    ]);
    expect(ctx.ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-expired', 'approved', expect.objectContaining({ careerClaimReleased: true }),
    );
  });
});
