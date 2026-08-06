/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the durable apply
 *   enqueuer: "auto submit this résumé" must file ONE real `task` ticket, created `approved`, whose
 *   metadata carries postingId (number, so the dispatcher applies THAT packet) + applyPostingId
 *   (string dedup key), and whose title matches the apply-intent regex so it routes to the browser
 *   dispatcher. A repeat enqueue for the same posting must DEDUPE to the existing open ticket, never
 *   file a second. Also pins the per-user in-flight serialization primitive (hasUserInFlight) that
 *   makes the queue work one submission at a time behind the single desktop.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard restart recovery against owner-sub normalization: rehydration and orphan reaping retain exact case and surrounding whitespace.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard strict per-ticket final-submit state and
 *   the shared exact-request-user bulk gate: absent/false/unavailable settings and identity mismatch
 *   mint zero, explicit true authorizes each bulk ticket, and a single authenticated action may opt in.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Require stale runs to use ambiguity-safe human-review recovery and raw-claim cleanup instead of blindly returning tickets to auto-submit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the CLI runner so enqueueApplyQueue can be exercised without spawning oshal-apply.js. It
// returns snake_case rows (posting_id) — the sqlite/DB convention — which the enqueuer must map to
// the camelCase ApplyPosting shape (the bug this guards: a mismatch minted 0 tickets).
const runApplyCliMock = vi.fn();
const recoverUnknownApplyMock = vi.fn();
const reapUserApplyClaimsMock = vi.fn();
const reconcileApplyInFlightMock = vi.fn();
vi.mock('@/app/apply-submit', () => ({
  runApplyCli: (...a: unknown[]) => runApplyCliMock(...a),
  recoverUnknownApply: (...a: unknown[]) => recoverUnknownApplyMock(...a),
  reapUserApplyClaims: (...a: unknown[]) => reapUserApplyClaimsMock(...a),
  reconcileApplyInFlight: (...a: unknown[]) => reconcileApplyInFlightMock(...a),
}));

const authorization = vi.hoisted(() => ({
  identity: { sub: 'example-user-sub', isOperator: false } as Record<string, unknown> | undefined,
  decision: { authorized: true, reason: 'enabled' } as Record<string, unknown>,
}));
const readAuthorizationMock = vi.fn(async () => authorization.decision);
vi.mock('@/app/apply-authorization-bridge', () => ({
  readCareerAutoSubmitAuthorization: (...args: unknown[]) => readAuthorizationMock(...args),
}));

// The cross-owner boot/background sweeps read the owner-RLS'd tickets table. Under
// OSHAL_DB_GUC_STRICT=deny an identity-less query is REJECTED, so they must run under the SYSTEM
// sentinel — otherwise they silently restore/reap nothing (exactly what shipped on 2026-07-21).
const identity = vi.hoisted(() => ({ system: 0 }));
vi.mock('@/shared/services/database/request-identity', () => ({
  getRequestIdentity: () => authorization.identity,
  runWithRequestIdentity: (_id: unknown, fn: () => unknown) => fn(),
  runWithSystemIdentity: (fn: () => unknown) => { identity.system += 1; return fn(); },
}));

import { enqueueApplyTicket, enqueueApplyQueue, reapOrphanedApplyTickets, rehydrateApplyInFlight } from '@/app/apply-enqueue';
import { applyInFlight, hasUserInFlight, findByTicket, clearInFlight } from '@/app/apply-inflight';
import { AUTHENTICATED_SINGLE_JOB_SUBMIT } from '@/app/apply-submit-authorization';

const SUB = 'example-user-sub';
const previousSessionSecret = process.env.SESSION_SECRET;

beforeAll(() => { process.env.SESSION_SECRET = 'apply-ticket-seal-secret-placeholder'; });
afterAll(() => {
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;
});

/** ctx stub exposing only ticketService, which is all enqueueApplyTicket touches. */
function ctxWith(overrides: Record<string, unknown>) {
  const created: Array<Record<string, unknown>> = [];
  const ticketService = {
    findActiveTicketByMetadataKey: vi.fn(async () => null),
    createTicket: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { ticketId: 'new-ticket-1', ...input }; }),
    updateTicket: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    ...overrides,
  };
  return { ctx: { pool: {}, ticketService } as never, ticketService, created };
}

// The apply-intent regex the manifest-worker uses to route a ticket to the browser dispatcher.
const NOUN = /\b(apply|application|resumes?|job posting|job postings)\b/i;
const VERB = /\b(submit|deploy|apply|application)\b/i;

beforeEach(() => {
  runApplyCliMock.mockReset();
  recoverUnknownApplyMock.mockReset();
  recoverUnknownApplyMock.mockImplementation(async (_ctx, taskId) => {
    clearInFlight(String(taskId));
    return true;
  });
  reapUserApplyClaimsMock.mockReset();
  reapUserApplyClaimsMock.mockResolvedValue({ released: 0 });
  reconcileApplyInFlightMock.mockReset();
  reconcileApplyInFlightMock.mockResolvedValue(0);
  readAuthorizationMock.mockClear();
  authorization.identity = { sub: SUB, isOperator: false };
  authorization.decision = { authorized: true, reason: 'enabled' };
});

describe('durable apply enqueuer', () => {
  it('files ONE approved task ticket with postingId (number) + applyPostingId (string) + apply-routable title', async () => {
    const { ctx, created } = ctxWith({});
    const r = await enqueueApplyTicket(ctx, SUB, { postingId: 833653, company: 'Airtable', title: 'Staff TPM', url: 'https://x/y', location: 'Remote, US' });

    expect(r.ok).toBe(true);
    expect(r.deduped).toBeFalsy();
    expect(created).toHaveLength(1);
    const t = created[0];
    expect(t.ticketType).toBe('task');
    expect(t.status).toBe('approved');
    expect(t.ownerSub).toBe(SUB);
    const meta = t.metadata as Record<string, unknown>;
    expect(meta.postingId).toBe(833653);          // number → dispatcher selects THIS packet
    expect(meta.applyPostingId).toBe('833653');   // string → dedup key
    expect(meta.applyFinalSubmitAuthorized).toBe(false);
    // The title must satisfy the apply-intent noun+verb regex so it routes to dispatchJobApplicationTask.
    const text = `${t.title as string}\n${t.description as string}`;
    expect(NOUN.test(text)).toBe(true);
    expect(VERB.test(text)).toBe(true);
  });

  it('DEDUPES to the existing open ticket instead of filing a second for the same posting', async () => {
    const { ctx, ticketService, created } = ctxWith({
      findActiveTicketByMetadataKey: vi.fn(async () => ({ ticketId: 'existing-77' })),
    });
    const r = await enqueueApplyTicket(ctx, SUB, { postingId: 833653, company: 'Airtable' });

    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.ticketId).toBe('existing-77');
    expect(ticketService.createTicket).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('rejects a missing/invalid postingId (no ticket filed)', async () => {
    const { ctx, ticketService } = ctxWith({});
    const r = await enqueueApplyTicket(ctx, SUB, { postingId: Number.NaN });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/postingId/i);
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('an authenticated single-job action authorizes only that ticket', async () => {
    const { ctx, created, ticketService } = ctxWith({});
    const result = await enqueueApplyTicket(
      ctx, SUB, { postingId: 833654 }, AUTHENTICATED_SINGLE_JOB_SUBMIT,
    );
    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      status: 'backlog', metadata: { applyFinalSubmitAuthorized: false },
    });
    expect(ticketService.updateTicket).toHaveBeenCalledWith('new-ticket-1', {
      metadata: expect.objectContaining({
        applyFinalSubmitAuthorized: true,
        applyFinalSubmitAuthorizationSource: 'authenticated-single-job',
        applyFinalSubmitAuthorizationSeal: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }),
    });
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      'new-ticket-1', 'approved', expect.objectContaining({ source: 'apply-enqueue' }),
    );
  });

  it('an authenticated single-job action upgrades an existing denied task without duplicating it', async () => {
    const existing = { ticketId: 'existing-78', metadata: { applyPostingId: '833655' } };
    const { ctx, ticketService } = ctxWith({
      findActiveTicketByMetadataKey: vi.fn(async () => existing),
    });
    const result = await enqueueApplyTicket(
      ctx, SUB, { postingId: 833655 }, AUTHENTICATED_SINGLE_JOB_SUBMIT,
    );
    expect(result).toMatchObject({ ok: true, deduped: true, ticketId: 'existing-78' });
    expect(ticketService.updateTicket).toHaveBeenCalledWith('existing-78', {
      metadata: expect.objectContaining({
        applyFinalSubmitAuthorized: true,
        applyFinalSubmitAuthorizationSource: 'authenticated-single-job',
      }),
    });
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });
});

describe('bulk enqueue maps CLI snake_case rows to durable tickets', () => {
  it('mints one ticket per posting_id row (posting_id → postingId — the "minted 0" bug)', async () => {
    runApplyCliMock.mockResolvedValueOnce({ items: [
      { posting_id: 833653, company: 'Airtable', title: 'Staff TPM', url: 'https://a/1', location: 'Remote, US' },
      { posting_id: 818531, company: 'Datadog', title: 'Director TPM', url: 'https://d/2', location: 'New York, USA' },
    ], returned: 2 });
    const { ctx, created, ticketService } = ctxWith({});
    const r = await enqueueApplyQueue(ctx, SUB, 40);

    expect(r.ok).toBe(true);
    expect(r.created).toBe(2);
    expect(created).toHaveLength(2);
    expect((created[0].metadata as Record<string, unknown>).postingId).toBe(833653);
    expect((created[1].metadata as Record<string, unknown>).postingId).toBe(818531);
    expect(created.every((ticket) => ticket.status === 'backlog')).toBe(true);
    expect(ticketService.updateTicket).toHaveBeenCalledTimes(2);
    for (const [, update] of ticketService.updateTicket.mock.calls) {
      expect(update).toEqual({
        metadata: expect.objectContaining({
          applyFinalSubmitAuthorized: true,
          applyFinalSubmitAuthorizationSource: 'career-auto-submit-setting',
          applyFinalSubmitAuthorizationSeal: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        }),
      });
    }
    expect(ticketService.updateStatus).toHaveBeenCalledTimes(2);
  });

  it('returns cleanly (mints nothing) when the ready queue is empty', async () => {
    runApplyCliMock.mockResolvedValueOnce({ items: [], returned: 0 });
    const { ctx, ticketService } = ctxWith({});
    const r = await enqueueApplyQueue(ctx, SUB, 40);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(0);
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it.each([
    ['settings row absent', { authorized: false, reason: 'disabled' }, 'auto-submit-disabled'],
    ['auto_submit is false', { authorized: false, reason: 'disabled' }, 'auto-submit-disabled'],
    ['settings query failed', { authorized: false, reason: 'unavailable' }, 'authorization-unavailable'],
  ])('%s: denies before listing or minting', async (_label, decision, denialReason) => {
    authorization.decision = decision;
    const { ctx, ticketService } = ctxWith({});
    const result = await enqueueApplyQueue(ctx, SUB, 40);
    expect(result).toMatchObject({ ok: false, created: 0, deduped: 0, denialReason });
    expect(runApplyCliMock).not.toHaveBeenCalled();
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('body-only/background identity cannot use another user setting to bulk enqueue', async () => {
    authorization.identity = { sub: null, isOperator: true };
    const { ctx, ticketService } = ctxWith({});
    const result = await enqueueApplyQueue(ctx, SUB, 40);
    expect(result).toMatchObject({
      ok: false, created: 0, denialReason: 'authenticated-user-required',
    });
    expect(readAuthorizationMock).not.toHaveBeenCalled();
    expect(runApplyCliMock).not.toHaveBeenCalled();
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });
});

describe('in-flight rehydration (the slot survives a restart)', () => {
  it('restores the in-flight slot so a restart cannot dispatch a second job onto the same desktop', async () => {
    const sub = ' Rehydrate-Sub ';
    expect(hasUserInFlight(sub)).toBe(false);
    const ctx = {
      pool: { query: vi.fn(async () => ({ rows: [{ ticket_id: 't-live', owner_sub: sub, posting_id: '900001', age_ms: '120000' }] })) },
    } as never;

    const before = identity.system;
    const restored = await rehydrateApplyInFlight(ctx);

    expect(restored).toBe(1);
    // Must query as SYSTEM or guc-strict deny rejects it and nothing is restored.
    expect(identity.system).toBeGreaterThan(before);
    // THE point: the per-user guard is held again, so gatherAndDispatch 409s instead of starting a
    // second concurrent submission on the single Chrome.
    expect(hasUserInFlight(sub)).toBe(true);
    // Ingest must still be able to resolve it by ticketId.
    expect(findByTicket('t-live')?.ticketId).toBe('t-live');
    clearInFlight('rehydrated:t-live');
    expect(hasUserInFlight(sub)).toBe(false);
  });

  it('only restores submissions still inside the watchdog window', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await rehydrateApplyInFlight({ pool: { query } } as never);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status = 'in_process_build'/);
    expect(sql).toMatch(/updated_at >/);            // fresh-only (the inverse of the reaper's bound)
    expect(Number(params[0])).toBe(30 * 60 * 1000); // matches APPLY_SUBMISSION_TIMEOUT
  });
});

describe('orphan reaper (durable queue survives an api restart)', () => {
  it('parks stale in-flight tickets for review and reaps the exact owner raw claims', async () => {
    const exactSub = ' Example-User-Sub ';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        ticket_id: 't-orphan', owner_sub: exactSub, posting_id: '833653',
        task_id: 'apply-11111111-1111-4111-8111-111111111111', client_id: 'client-1',
      }] })
      .mockResolvedValueOnce({ rows: [{ owner_sub: exactSub }] });
    const ctx = {
      pool: { query },
      ticketService: { updateStatus: vi.fn(async () => undefined) },
    } as never;

    const before = identity.system;
    const reaped = await reapOrphanedApplyTickets(ctx);

    expect(reaped).toBe(1);
    // Must query as SYSTEM or guc-strict deny rejects it and nothing is ever reaped.
    expect(identity.system).toBeGreaterThan(before);
    expect(recoverUnknownApplyMock).toHaveBeenCalledWith(
      ctx, 'apply-11111111-1111-4111-8111-111111111111',
      'apply_controller_restart_orphan',
    );
    expect(ctx.ticketService.updateStatus).not.toHaveBeenCalledWith(
      't-orphan', 'approved', expect.anything(),
    );
    expect(reapUserApplyClaimsMock).toHaveBeenCalledWith(exactSub);
  });

  it('only selects tickets older than the watchdog window (the node may still be submitting)', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await reapOrphanedApplyTickets({ pool: { query }, ticketService: {} } as never);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/status = 'in_process_build'/);
    expect(sql).toMatch(/updated_at </);                 // staleness bound present
    expect(sql).toMatch(/apply-enqueue/);                // scoped to apply tickets only
    // MUST exceed the 30-min APPLY_SUBMISSION_TIMEOUT or we could re-apply a live submission.
    expect(Number(params[0])).toBeGreaterThan(30 * 60 * 1000);
  });

  it('is a no-op without a pool (never throws)', async () => {
    await expect(reapOrphanedApplyTickets({} as never)).resolves.toBe(0);
  });
});

describe('per-user in-flight serialization (one desktop, one Chrome)', () => {
  it('hasUserInFlight is true only while that user has a submission dispatched', () => {
    expect(hasUserInFlight(SUB)).toBe(false);
    const timer = setTimeout(() => undefined, 0);
    applyInFlight.set('task-x', { taskId: 'task-x', ticketId: 't1', postingId: 1, userSub: SUB, timer, startedAt: Date.now() });
    try {
      expect(hasUserInFlight(SUB)).toBe(true);
      expect(hasUserInFlight('someone-else')).toBe(false);
    } finally {
      clearTimeout(timer);
      applyInFlight.delete('task-x');
    }
    expect(hasUserInFlight(SUB)).toBe(false);
  });
});
