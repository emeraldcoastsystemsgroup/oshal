/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove internal Apply dispatch cannot gain final
 *   submit authority from body-asserted user/boolean fields. Durable ticket dispatch reloads exact
 *   owner, posting, target, and strict authorization metadata server-side; direct service calls deny.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve } from '../helpers/machine-write-identity-drivers';

const routeState = vi.hoisted(() => ({
  gather: vi.fn(async () => ({ status: 202, body: { ok: true } })),
}));

vi.mock('@/app/apply-submit', () => ({
  gatherAndDispatch: (...args: unknown[]) => routeState.gather(...args),
  runApplyCli: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/app/apply-dispatch', () => ({ removeApplyWorkspace: vi.fn(async () => undefined) }));
vi.mock('@/app/apply-enqueue', () => ({
  enqueueApplyTicket: vi.fn(async () => ({ ok: true, ticketId: 'queued-ticket' })),
  enqueueApplyQueue: vi.fn(async () => ({
    ok: false, created: 0, deduped: 0, ticketIds: [],
    denialReason: 'authenticated-user-required',
  })),
}));
vi.mock('@/app/apply-batch-runner', () => ({
  stopApplyBatch: vi.fn(() => false), getApplyBatchStatus: vi.fn(() => null),
}));

import { createApplyIngestRoutes } from '@/app/routes/apply-ingest-routes';
import {
  applySubmitAuthorizationMetadata,
  CAREER_AUTO_SUBMIT_SETTING,
} from '@/app/apply-submit-authorization';

const SERVICE_SECRET = 'apply-service-secret-placeholder';
const EXACT_OWNER = ' Tenant|Exact Subject ';
const previousSessionSecret = process.env.SESSION_SECRET;

beforeAll(() => {
  process.env.SWARM_SERVICE_SECRET = SERVICE_SECRET;
  process.env.SESSION_SECRET = 'apply-route-seal-secret-placeholder';
});
afterAll(() => {
  delete process.env.SWARM_SERVICE_SECRET;
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;
});
beforeEach(() => { routeState.gather.mockClear(); });

async function dispatch(ctx: never, body: Record<string, unknown>) {
  const { url, close } = await serve('/api/apply', createApplyIngestRoutes(ctx));
  try {
    const response = await fetch(`${url}/api/apply/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-secret': SERVICE_SECRET },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await close();
  }
}

describe('internal Apply dispatch authorization', () => {
  it('body-only service dispatch stays final-submit denied even when the body asserts true', async () => {
    const ctx = { ticketService: { getTicket: vi.fn() } } as never;
    const response = await dispatch(ctx, {
      userSub: EXACT_OWNER, postingId: 42, finalSubmitAuthorized: true,
    });
    expect(response.status).toBe(202);
    expect(routeState.gather).toHaveBeenCalledWith(
      ctx, EXACT_OWNER, undefined, 42, undefined,
      expect.objectContaining({ finalSubmitAuthorized: false }),
    );
  });

  it('reloads strict authorization and exact dispatch bindings from the durable ticket', async () => {
    const binding = { ticketId: 'ticket-1', userSub: EXACT_OWNER, postingId: 42 };
    const ticket = {
      ownerSub: EXACT_OWNER,
      metadata: {
        postingId: 42,
        targetRemoteClientId: 'desktop-exact',
        ...applySubmitAuthorizationMetadata(CAREER_AUTO_SUBMIT_SETTING, binding),
      },
    };
    const ctx = { ticketService: { getTicket: vi.fn(async () => ticket) } } as never;
    const response = await dispatch(ctx, {
      userSub: EXACT_OWNER, ticketId: 'ticket-1', postingId: 42,
      targetRemoteClientId: 'body-target-ignored', finalSubmitAuthorized: false,
    });
    expect(response.status).toBe(202);
    expect(routeState.gather).toHaveBeenCalledWith(
      ctx, EXACT_OWNER, 'ticket-1', 42, 'desktop-exact',
      expect.objectContaining({
        finalSubmitAuthorized: true, source: 'career-auto-submit-setting',
      }),
    );
  });

  it('does not accept copied or model-authored authorization metadata for another ticket', async () => {
    const copied = applySubmitAuthorizationMetadata(CAREER_AUTO_SUBMIT_SETTING, {
      ticketId: 'ticket-original', userSub: EXACT_OWNER, postingId: 42,
    });
    const ctx = { ticketService: { getTicket: vi.fn(async () => ({
      ownerSub: EXACT_OWNER,
      metadata: {
        postingId: 42,
        ...copied,
      },
    })) } } as never;
    const response = await dispatch(ctx, {
      userSub: EXACT_OWNER, ticketId: 'ticket-2', finalSubmitAuthorized: true,
    });
    expect(response.status).toBe(202);
    expect(routeState.gather).toHaveBeenCalledWith(
      ctx, EXACT_OWNER, 'ticket-2', 42, undefined,
      expect.objectContaining({ finalSubmitAuthorized: false }),
    );
  });

  it('rejects a body owner that does not match the server-loaded ticket owner', async () => {
    const ctx = { ticketService: { getTicket: vi.fn(async () => ({
      ownerSub: EXACT_OWNER, metadata: { postingId: 42 },
    })) } } as never;
    const response = await dispatch(ctx, {
      userSub: 'another-user', ticketId: 'ticket-3', finalSubmitAuthorized: true,
    });
    expect(response).toMatchObject({ status: 409 });
    expect(routeState.gather).not.toHaveBeenCalled();
  });
});
