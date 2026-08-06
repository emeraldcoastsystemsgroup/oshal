/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove user-facing Apply actions never fall back to
 *   body identity. A real session may authorize one Submit/Enqueue task, and the exact session subject
 *   — never body.userSub — is carried with the explicit server decision.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove legacy task-id completion and process-global in-flight enumeration are retired without invoking any mutation rail.
 */

import { describe, expect, it, vi } from 'vitest';
import { Router, type Request } from 'express';
import { serve } from '../helpers/machine-write-identity-drivers';

const state = vi.hoisted(() => ({
  gather: vi.fn(async () => ({ status: 202, body: { ok: true } })),
  enqueue: vi.fn(async () => ({ ok: true, ticketId: 'ticket-1' })),
  queue: vi.fn(async () => ({ ok: true, created: 0, deduped: 0, ticketIds: [] })),
}));

vi.mock('@/app/apply-submit', () => ({
  gatherAndDispatch: (...args: unknown[]) => state.gather(...args),
}));
vi.mock('@/app/apply-enqueue', () => ({
  enqueueApplyTicket: (...args: unknown[]) => state.enqueue(...args),
  enqueueApplyQueue: (...args: unknown[]) => state.queue(...args),
}));
vi.mock('@/app/apply-batch-runner', () => ({
  stopApplyBatch: vi.fn(() => false), getApplyBatchStatus: vi.fn(() => null),
}));
vi.mock('@/app/apply-queue-status', () => ({
  getApplyQueueSnapshot: vi.fn(async () => ({})), listApplyWorkers: vi.fn(() => ({ workers: [] })),
}));
vi.mock('@/app/apply-story', () => ({
  readApplyStory: vi.fn(async () => []), resolveApplyShotPath: vi.fn(async () => null),
}));

import { createApplyOperatorRoutes } from '@/app/routes/apply-operator-routes';

const SESSION_SUB = 'Tenant|Case-Sensitive-Subject';

function routerWithOptionalSession(ctx: never): Router {
  const router = Router();
  router.use((req, _res, next) => {
    const sub = req.header('x-test-session-sub');
    if (sub) (req as Request & { oidc: unknown }).oidc = { user: { sub } };
    next();
  });
  router.use(createApplyOperatorRoutes(ctx));
  return router;
}

async function post(ctx: never, path: string, body: Record<string, unknown>, withSession: boolean) {
  const { url, close } = await serve('/api/apply-operator', routerWithOptionalSession(ctx));
  try {
    const response = await fetch(`${url}/api/apply-operator${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(withSession ? { 'x-test-session-sub': SESSION_SUB } : {}),
      },
      body: JSON.stringify(body),
    });
    return response;
  } finally {
    await close();
  }
}

async function get(ctx: never, path: string, withSession: boolean) {
  const { url, close } = await serve('/api/apply-operator', routerWithOptionalSession(ctx));
  try {
    return await fetch(`${url}/api/apply-operator${path}`, {
      headers: withSession ? { 'x-test-session-sub': SESSION_SUB } : {},
    });
  } finally {
    await close();
  }
}

describe('authenticated single-job Apply authorization', () => {
  it('rejects body-only identity before a direct submit can dispatch', async () => {
    state.gather.mockClear();
    const response = await post({} as never, '/submit', {
      userSub: 'body-victim', postingId: 42,
    }, false);
    expect(response.status).toBe(401);
    expect(state.gather).not.toHaveBeenCalled();
  });

  it('uses the exact session subject and explicit decision for one submit', async () => {
    state.gather.mockClear();
    const ctx = {} as never;
    const response = await post(ctx, '/submit', {
      userSub: 'body-victim', postingId: 42,
    }, true);
    expect(response.status).toBe(202);
    expect(state.gather).toHaveBeenCalledWith(
      ctx, SESSION_SUB, undefined, 42, undefined,
      expect.objectContaining({
        finalSubmitAuthorized: true, source: 'authenticated-single-job',
      }),
    );
  });

  it('uses the same per-task decision for one authenticated enqueue', async () => {
    state.enqueue.mockClear();
    const ctx = {} as never;
    const response = await post(ctx, '/enqueue', {
      userSub: 'body-victim', postingId: 42,
    }, true);
    expect(response.status).toBe(201);
    expect(state.enqueue).toHaveBeenCalledWith(
      ctx, SESSION_SUB, expect.objectContaining({ postingId: 42 }),
      expect.objectContaining({
        finalSubmitAuthorized: true, source: 'authenticated-single-job',
      }),
    );
  });

  it('retires task-id completion without invoking submit or enqueue mutations', async () => {
    state.gather.mockClear();
    state.enqueue.mockClear();
    state.queue.mockClear();
    const response = await post(
      {} as never, '/complete/apply-11111111-1111-4111-8111-111111111111', {}, true,
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('task-capability ingest'),
    });
    expect(state.gather).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.queue).not.toHaveBeenCalled();
  });

  it('retires process-global in-flight enumeration in favor of the owner queue', async () => {
    const response = await get({} as never, '/inflight', true);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: 'retired: use the owner-scoped /queue endpoint', replacement: '/queue',
    });
  });
});
