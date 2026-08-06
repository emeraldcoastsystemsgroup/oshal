/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove Apply completion derives identity from
 *   a one-use capability, rejects body-asserted/stale/replayed callbacks, requires an acknowledged
 *   queue write before owner-scoped ticket settlement, and retires global-secret interactive APIs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require the Career queue acknowledgement to
 *   echo task-bound worker provenance before a trusted completion can settle.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Require a retained link-free image before verified-submission provenance and keep missing/unsafe artifacts at worker-reported.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Require the exact Apply V2 run binding, claim-token CAS, confirmation SHA, and unknown_outcome classification for evidence-free worker reports.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Prove a callback retry can finish ticket/capability settlement after the exact ledger run is already terminal.
 */

import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyInFlight, clearInFlight } from '@/app/apply-inflight';
import {
  createApplyIngestRoutes,
  type ApplyCompletionRuntime,
} from '@/app/routes/apply-ingest-routes';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import { serve } from '../helpers/machine-write-identity-drivers';

const TOKEN = 'A'.repeat(43);
const CLAIM = {
  taskId: 'apply-11111111-2222-4333-8444-555555555555',
  tokenHash: 'b'.repeat(64), userSub: ' Tenant|Exact Subject ', ticketId: 'ticket-1',
  settleTicket: true, postingId: 42, clientId: 'desktop-1', targetHost: 'jobs.example.com', generation: 3,
  expiresAt: '2026-08-05T22:00:00.000Z',
};
const RUN = {
  runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  ticketId: CLAIM.ticketId,
  ownerSub: CLAIM.userSub,
  postingId: CLAIM.postingId,
  claimToken: 'ffffffff-1111-4222-8333-444444444444',
  taskId: CLAIM.taskId,
  workerClientId: CLAIM.clientId,
  state: 'queued_to_worker' as const,
  claimedAt: '2026-08-05T21:00:00.000Z',
  dispatchedAt: '2026-08-05T21:00:01.000Z',
  acknowledgedAt: null,
  lastProgressAt: '2026-08-05T21:00:01.000Z',
  timeoutAt: '2026-08-05T22:00:00.000Z',
  finishedAt: null,
  result: null,
  failureCode: null,
  failureDetail: null,
  confirmationPath: null,
  confirmationSha256: null,
  metadata: {
    trigger: 'authenticated-single-job' as const,
    initiatedBySub: CLAIM.userSub,
    automationSettingsVersion: 'authenticated-single-job-v1',
  },
};
const BODY = {
  taskId: CLAIM.taskId,
  context: { workflow: 'apply', generation: CLAIM.generation },
  result: { result: 'applied', note: 'visible confirmation' },
};

function fixture(overrides: Partial<ApplyCompletionRuntime> = {}) {
  const events: string[] = [];
  const runtime: ApplyCompletionRuntime = {
    reserve: vi.fn(async () => { events.push('reserve'); return CLAIM; }),
    consume: vi.fn(async () => { events.push('consume'); return true; }),
    release: vi.fn(async () => { events.push('release'); }),
    runCli: vi.fn(async (_sub, args) => {
      events.push(args[0] === 'queue' ? 'queue' : 'trace');
      const sourceAt = args.indexOf('--source');
      const source = sourceAt >= 0 ? args[sourceAt + 1] : null;
      return args[0] === 'queue' ? {
        ok: true,
        posting_id: CLAIM.postingId,
        status: args[3],
        application_source: source,
        application_task_id: source ? CLAIM.taskId : null,
        confirmation_verified: source === 'verified-submission',
      } : { ok: true };
    }),
    removeWorkspace: vi.fn(async () => { events.push('cleanup'); }),
    persistConfirmation: vi.fn(() => null),
    getRun: vi.fn(async () => RUN),
    transitionRun: vi.fn(async (_pool, input) => {
      events.push(`ledger:${input.to}`);
      return { ...RUN, state: input.to } as never;
    }),
    ...overrides,
  };
  const identities: unknown[] = [];
  const ticketService = {
    updateStatus: vi.fn(async () => { events.push('ticket'); identities.push(getRequestIdentity()); }),
  };
  const ctx = { pool: {} as Pool, ticketService } as never;
  return { ctx, runtime, events, identities, ticketService };
}

async function post(runtime: ApplyCompletionRuntime, ctx: never, body: unknown = BODY, token = TOKEN) {
  const { url, close } = await serve('/api/apply', createApplyIngestRoutes(ctx, runtime));
  try {
    const response = await fetch(`${url}/api/apply/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oshal-callback-capability': token },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await close();
  }
}

afterEach(() => {
  for (const taskId of applyInFlight.keys()) clearInFlight(taskId);
});

describe('Apply trusted completion', () => {
  it('commits queue then exact-owner ticket then capability, and only then cleans PII', async () => {
    const f = fixture();
    const timer = setTimeout(() => undefined, 60_000);
    applyInFlight.set(CLAIM.taskId, { ...CLAIM, timer, company: 'Example', startedAt: Date.now() });

    const response = await post(f.runtime, f.ctx);
    expect(response).toEqual({ status: 200, body: { ok: true, result: 'applied' } });
    expect(f.events.slice(0, 6)).toEqual([
      'reserve', 'queue', 'ledger:running', 'ledger:unknown_outcome', 'ticket', 'consume',
    ]);
    expect(f.events).toContain('cleanup');
    expect(f.identities).toEqual([{ sub: CLAIM.userSub, isOperator: false }]);
    expect(f.runtime.runCli).toHaveBeenCalledWith(CLAIM.userSub, [
      'queue', 'record', '42', 'applied', '--note', 'visible confirmation',
      '--source', 'worker-reported', '--task', CLAIM.taskId,
      '--run-id', RUN.runId, '--claim-token', RUN.claimToken,
    ], { timeoutMs: 30000 });
    expect(f.ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-1', 'customer_action', expect.objectContaining({
        taskId: CLAIM.taskId, generation: 3, applyRunState: 'unknown_outcome',
      }),
    );
    expect(applyInFlight.has(CLAIM.taskId)).toBe(false);
  });

  it('rejects old body-asserted identity/service-secret callbacks before capability lookup', async () => {
    const f = fixture();
    const oldBody = { ticketId: 'victim', userSub: 'victim-sub', postingId: 99, result: 'applied', note: 'spoof' };
    const response = await post(f.runtime, f.ctx, oldBody, 'not-a-capability');
    expect(response.status).toBe(400);
    expect(f.runtime.reserve).not.toHaveBeenCalled();
    expect(f.ticketService.updateStatus).not.toHaveBeenCalled();
  });

  it('records verified provenance only when the exact artifact retention rail succeeds', async () => {
    const retained = {
      path: 'C:\\career\\owner\\confirmations\\apply-proof.png', sha256: 'a'.repeat(64),
    };
    const persistConfirmation = vi.fn(() => retained);
    const f = fixture({ persistConfirmation });
    const response = await post(f.runtime, f.ctx, {
      ...BODY, result: { ...BODY.result, confirmationFile: 'confirmation.png' },
    });
    expect(response).toEqual({ status: 200, body: { ok: true, result: 'applied' } });
    expect(persistConfirmation).toHaveBeenCalledWith(
      CLAIM.userSub, CLAIM.taskId, 'confirmation.png',
    );
    expect(f.runtime.runCli).toHaveBeenCalledWith(CLAIM.userSub, [
      'queue', 'record', '42', 'applied', '--note', 'visible confirmation',
      '--source', 'verified-submission', '--task', CLAIM.taskId,
      '--confirmation', retained.path,
      '--run-id', RUN.runId, '--claim-token', RUN.claimToken,
    ], { timeoutMs: 30000 });
    expect(f.ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-1', 'complete', expect.objectContaining({
        applicationSource: 'verified-submission', applyRunState: 'submitted_verified',
      }),
    );
  });

  it('keeps an absent artifact worker-reported and rejects traversal names before reservation', async () => {
    const f = fixture();
    const missing = await post(f.runtime, f.ctx, {
      ...BODY, result: { ...BODY.result, confirmationFile: 'missing.png' },
    });
    expect(missing.status).toBe(200);
    expect(f.runtime.runCli).toHaveBeenCalledWith(CLAIM.userSub, expect.arrayContaining([
      '--source', 'worker-reported', '--task', CLAIM.taskId,
    ]), { timeoutMs: 30000 });

    const rejected = await post(f.runtime, f.ctx, {
      ...BODY, result: { ...BODY.result, confirmationFile: '../confirmation.png' },
    });
    expect(rejected.status).toBe(400);
    expect(f.runtime.reserve).toHaveBeenCalledTimes(1);
  });

  it('rejects stale task/generation bindings and leaves the current watchdog armed', async () => {
    const f = fixture();
    const timer = setTimeout(() => undefined, 60_000);
    applyInFlight.set(CLAIM.taskId, { ...CLAIM, timer, company: 'Example', startedAt: Date.now() });
    const response = await post(f.runtime, f.ctx, { ...BODY, context: { workflow: 'apply', generation: 4 } });
    expect(response.status).toBe(409);
    expect(f.runtime.release).toHaveBeenCalledOnce();
    expect(f.runtime.runCli).not.toHaveBeenCalled();
    expect(applyInFlight.has(CLAIM.taskId)).toBe(true);
  });

  it('keeps the capability retryable and does not settle a ticket when queue recording fails', async () => {
    const runCli = vi.fn(async () => null);
    const f = fixture({ runCli });
    const response = await post(f.runtime, f.ctx);
    expect(response).toMatchObject({ status: 503, body: { retryable: true } });
    expect(f.runtime.release).toHaveBeenCalledOnce();
    expect(f.runtime.consume).not.toHaveBeenCalled();
    expect(f.ticketService.updateStatus).not.toHaveBeenCalled();
  });

  it('finishes an interrupted callback retry when the exact run is already unknown_outcome', async () => {
    const getRun = vi.fn(async () => ({
      ...RUN, state: 'unknown_outcome' as const, finishedAt: RUN.timeoutAt,
    }));
    const transitionRun = vi.fn(async () => {
      throw new Error('terminal ledger must not transition twice');
    });
    const f = fixture({ getRun, transitionRun });
    const response = await post(f.runtime, f.ctx);
    expect(response).toEqual({ status: 200, body: { ok: true, result: 'applied' } });
    expect(transitionRun).not.toHaveBeenCalled();
    expect(f.ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-1', 'customer_action', expect.objectContaining({ applyRunState: 'unknown_outcome' }),
    );
    expect(f.runtime.consume).toHaveBeenCalledOnce();
  });

  it('rejects a queue acknowledgement that omits or changes callback provenance', async () => {
    const runCli = vi.fn(async () => ({
      ok: true, posting_id: CLAIM.postingId, status: 'applied',
      application_source: 'verified-submission', application_task_id: 'apply-wrong',
    }));
    const f = fixture({ runCli });
    const response = await post(f.runtime, f.ctx);
    expect(response).toMatchObject({ status: 503, body: { retryable: true } });
    expect(f.runtime.release).toHaveBeenCalledOnce();
    expect(f.runtime.consume).not.toHaveBeenCalled();
    expect(f.ticketService.updateStatus).not.toHaveBeenCalled();
  });

  it('rejects consumed/replayed capabilities without any domain write', async () => {
    const reserve = vi.fn(async () => null);
    const f = fixture({ reserve });
    const response = await post(f.runtime, f.ctx);
    expect(response.status).toBe(401);
    expect(f.runtime.runCli).not.toHaveBeenCalled();
    expect(f.ticketService.updateStatus).not.toHaveBeenCalled();
  });

  it('maps a trusted remote execution failure to deferred customer action', async () => {
    const f = fixture();
    const response = await post(f.runtime, f.ctx, {
      ...BODY, result: { result: 'failed', note: 'remote execution did not return valid JSON' },
    });
    expect(response).toEqual({ status: 200, body: { ok: true, result: 'deferred' } });
    expect(f.ticketService.updateStatus).toHaveBeenCalledWith('ticket-1', 'customer_action', expect.any(Object));
  });

  it('does not invent a ticket transition for a direct OIDC Apply correlation id', async () => {
    const directClaim = { ...CLAIM, settleTicket: false, ticketId: 'apply_42_correlation' };
    const reserve = vi.fn(async () => directClaim);
    const getRun = vi.fn(async () => ({ ...RUN, ticketId: directClaim.ticketId }));
    const f = fixture({ reserve, getRun });
    const response = await post(f.runtime, f.ctx);
    expect(response).toEqual({ status: 200, body: { ok: true, result: 'applied' } });
    expect(f.ticketService.updateStatus).not.toHaveBeenCalled();
    expect(f.runtime.consume).toHaveBeenCalledOnce();
  });
});

describe('retired interactive callbacks', () => {
  it.each(['/email-code', '/site-cred', '/site-cred/get', '/shot'])('returns 410 for %s', async (path) => {
    const f = fixture();
    const { url, close } = await serve('/api/apply', createApplyIngestRoutes(f.ctx, f.runtime));
    try {
      const response = await fetch(`${url}/api/apply${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-secret': 'fleet-secret' },
        body: JSON.stringify({ userSub: 'victim', ticketId: 'victim' }),
      });
      expect(response.status).toBe(410);
    } finally {
      await close();
    }
  });
});
