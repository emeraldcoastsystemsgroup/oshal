/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavior guard for the async conversion of the job-apply gather+dispatch core (was spawnSync — up to four sequential 60s blocking spawns per dispatch on the api event loop; the 07-15 wedge class). Mocks child_process.spawn: proves the {parse-last-stdout-line -> null} CLI contract, the 202 dispatch path, the empty-queue 409, per-user single-flight (409) and the global APPLY_MAX_DISPATCHES ceiling (429), and that runApplyCli resolves (never rejects) on process error.
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
}));

import { gatherAndDispatch, runApplyCli } from '@/app/apply-submit';
import { dispatchApply } from '@/app/apply-dispatch';
import { applyInFlight, clearInFlight } from '@/app/apply-inflight';
import type { AppContext } from '@/app/composition/app-context';

/** Emits `lines` on stdout then closes with `code` (async, like a real process). */
function reply(proc: FakeProc, lines: string[], code = 0): void {
  for (const l of lines) proc.stdout.emit('data', `${l}\n`);
  proc.emit('close', code);
}

function makeCtx(): AppContext {
  return { ticketService: { updateStatus: vi.fn(async () => undefined) } } as unknown as AppContext;
}

const ITEM = { posting_id: 7, title: 'SE II', company: 'ACME', url: 'https://jobs.test/7', location: 'Remote', resume_pdf: '/p/r.pdf', cover_pdf: '/p/c.pdf', workday_autofill: null };

/** Happy-path responder: queue next -> item, profile -> profile, everything else -> {}. */
function happyResponder(verbArgs: string[], proc: FakeProc): void {
  const verb = verbArgs.join(' ');
  if (verb.startsWith('queue next')) reply(proc, ['gathering…', JSON.stringify({ item: ITEM })]);
  else if (verb.startsWith('profile')) reply(proc, [JSON.stringify({ name: 'the operator', email: 'r@test' })]);
  else reply(proc, ['{}']);
}

beforeEach(() => {
  spawnCalls.length = 0;
  vi.mocked(dispatchApply).mockClear();
  vi.mocked(dispatchApply).mockResolvedValue({ ok: true, taskId: 'task-1', clientId: 'client-1' });
});

afterEach(() => {
  // Drop any armed watchdog so the fake taskId can't leak between tests.
  clearInFlight('task-1');
});

describe('runApplyCli — async CLI contract (no spawnSync)', () => {
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
    // CLI chain ran in order: queue next -> profile -> queue claim
    const verbs = spawnCalls.map((c) => c.argv.slice(1, 3).join(' '));
    expect(verbs).toEqual(['queue next', 'profile', 'queue claim']);
  });

  it('returns 409 when no submittable job is ready', async () => {
    responder = (_v, proc) => reply(proc, [JSON.stringify({ note: 'queue empty' })]);
    const r = await gatherAndDispatch(makeCtx(), 'user-b');
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('no submittable job');
    expect(r.body.note).toBe('queue empty');
  });

  it('single-flight per user: a concurrent dispatch for the SAME user gets 409 without spawning', async () => {
    let release!: () => void;
    responder = (_v, proc) => { release = () => reply(proc, ['null']); }; // first spawn hangs until released
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
    responder = (_v, proc) => { releases.push(() => reply(proc, ['null'])); };
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
});
