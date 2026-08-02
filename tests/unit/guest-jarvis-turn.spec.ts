/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the guest Jarvis turn. Two failures are pinned here, in both directions. UNDER-GRANTING: `jarvis` is Tier-A but its turn posts to /api/tasks + /api/tasks/:id/messages — segment `tasks` — so the whole public demo 403'd guest_readonly and could not answer a question. OVER-GRANTING: the fix must NOT be a literal '/api/tasks' prefix, which would also hand an anonymous visitor DELETE /api/tasks/:id and POST /api/tasks/:id/workspace/bootstrap. Also pins the guard's lifetime model-turn cap, since the sliding window alone lets one guest spend rateMax() every window for the entire session TTL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  GUEST_ALLOWED_MUTATIONS,
  guestDecision,
  guestMutationGrant,
  guestSpendsModel,
} from '../../src/shared/middleware/guest-capability-matrix';
import { createGuestGuard } from '../../src/shared/middleware/guest-guard';

describe('guest Jarvis turn — the routes the demo actually posts to', () => {
  it('lets a guest open a conversation and take a turn', () => {
    expect(guestDecision('/api/tasks', 'POST')).toBe('allow');
    expect(guestDecision('/api/tasks/abc-123/messages', 'POST')).toBe('allow');
  });

  it('still lets a guest use the mic (the entry-9 regression)', () => {
    expect(guestDecision('/api/voice/transcribe', 'POST')).toBe('allow');
    expect(guestDecision('/api/voice/synthesize', 'POST')).toBe('allow');
  });

  it('reads the conversation back', () => {
    expect(guestDecision('/api/tasks/abc-123/messages', 'GET')).toBe('allow');
  });
});

describe('the grant must not widen past the routes it names', () => {
  // Each of these WOULD have been allowed by a literal '/api/tasks' prefix grant.
  it.each([
    ['DELETE', '/api/tasks/abc-123', 'deleting a task'],
    ['POST', '/api/tasks/abc-123/workspace/bootstrap', 'bootstrapping a workspace'],
    ['POST', '/api/tasks/abc-123/usage', 'writing cost telemetry'],
    ['POST', '/api/tasks/abc-123/checkpoints', 'writing checkpoints'],
    ['POST', '/api/tasks/abc-123/messages/evil', 'a deeper path under messages'],
    ['POST', '/api/tasksomething', 'a segment that merely starts with tasks'],
  ])('denies %s %s (%s)', (method, path) => {
    expect(guestDecision(path, method)).toBe('guest_readonly');
  });

  it('denies the voice routes any deeper path (the old prefix form allowed it)', () => {
    expect(guestDecision('/api/voice/transcribe/evil', 'POST')).toBe('guest_readonly');
  });

  it('grants only the named method', () => {
    expect(guestDecision('/api/tasks', 'DELETE')).toBe('guest_readonly');
    expect(guestDecision('/api/tasks/abc-123/messages', 'PUT')).toBe('guest_readonly');
  });

  it('never lets a grant outrank a Tier-C block', () => {
    expect(guestDecision('/api/workflow-studio', 'POST')).toBe('guest_blocked');
    expect(guestDecision('/api/forge/bots', 'POST')).toBe('guest_blocked');
  });

  it('anchors every grant pattern, so none can be widened by a suffix', () => {
    for (const grant of GUEST_ALLOWED_MUTATIONS) {
      expect(grant.pattern.source.startsWith('^')).toBe(true);
      expect(grant.pattern.source.endsWith('$')).toBe(true);
    }
  });
});

describe('what a guest turn costs', () => {
  it('meters the model-reaching routes and only those', () => {
    expect(guestSpendsModel('/api/tasks/abc-123/messages', 'POST')).toBe(true);
    expect(guestSpendsModel('/api/voice/transcribe', 'POST')).toBe(true);
    // Opening a conversation is a DB row, not a model call — it must stay free.
    expect(guestSpendsModel('/api/tasks', 'POST')).toBe(false);
    expect(guestSpendsModel('/api/tasks/abc-123', 'DELETE')).toBe(false);
  });

  it('documents why every grant is safe for an anonymous caller', () => {
    for (const grant of GUEST_ALLOWED_MUTATIONS) {
      expect(grant.why.length).toBeGreaterThan(10);
    }
  });

  it('resolves the grant covering a request', () => {
    expect(guestMutationGrant('/api/tasks', 'POST')?.spendsModel).toBe(false);
    expect(guestMutationGrant('/api/tasks/x/messages', 'post')?.spendsModel).toBe(true);
    expect(guestMutationGrant('/api/tasks/x', 'DELETE')).toBeUndefined();
  });
});

describe('lifetime model-turn cap', () => {
  const CAP = 3;
  let sub: string;

  /** Builds a guest request the guard will recognise, keyed to this test's sub. */
  function guestReq(path: string, method = 'POST'): Request {
    return {
      path,
      method,
      oidc: { user: { sub, is_guest: true } },
      header: () => undefined,
      get: () => undefined,
    } as unknown as Request;
  }

  /** Runs the guard once and reports what it did. */
  function run(req: Request): { status: number | null; body: unknown; passed: boolean } {
    let status: number | null = null;
    let body: unknown = null;
    let passed = false;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;
    createGuestGuard()(req, res, () => {
      passed = true;
    });
    return { status, body, passed };
  }

  beforeEach(() => {
    process.env.GUEST_MODEL_TURN_CAP = String(CAP);
    // A fresh sub per test so the module-level counter can't leak between cases.
    sub = `guest-${Math.random().toString(36).slice(2)}`;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.GUEST_MODEL_TURN_CAP;
    vi.restoreAllMocks();
  });

  it('allows exactly CAP turns, then 429s with guest_turn_cap', () => {
    for (let i = 0; i < CAP; i += 1) {
      const r = run(guestReq('/api/tasks/t1/messages'));
      expect(r.passed, `turn ${i + 1} should pass`).toBe(true);
    }
    const over = run(guestReq('/api/tasks/t1/messages'));
    expect(over.passed).toBe(false);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'guest_turn_cap', guest: true });
  });

  it('does not spend the budget on opening conversations', () => {
    for (let i = 0; i < CAP * 3; i += 1) {
      expect(run(guestReq('/api/tasks')).passed).toBe(true);
    }
    // The whole model budget must still be there.
    for (let i = 0; i < CAP; i += 1) {
      expect(run(guestReq('/api/tasks/t1/messages')).passed).toBe(true);
    }
  });

  it('counts per guest sub, not globally', () => {
    for (let i = 0; i < CAP; i += 1) run(guestReq('/api/tasks/t1/messages'));
    expect(run(guestReq('/api/tasks/t1/messages')).status).toBe(429);

    sub = `guest-${Math.random().toString(36).slice(2)}`;
    expect(run(guestReq('/api/tasks/t1/messages')).passed).toBe(true);
  });

  it('leaves signed-in callers untouched', () => {
    const signedIn = {
      path: '/api/tasks/t1/messages',
      method: 'POST',
      oidc: { user: { sub: 'real-user', is_guest: false } },
      header: () => undefined,
      get: () => undefined,
    } as unknown as Request;
    for (let i = 0; i < CAP * 5; i += 1) {
      expect(run(signedIn).passed).toBe(true);
    }
  });
});

// The ticket-context resolver and the token broker want a real store/pool; stub them so the
// route's OWN behaviour is what is asserted. `resolveProjectManagerTicketExecutionContext` is
// the chokepoint that decides whether a turn creates a ticket, so capturing its input is
// exactly how we prove a guest turn cannot.
vi.mock('@/features/chat-orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat-orchestration')>();
  return {
    ...actual,
    resolveProjectManagerTicketExecutionContext: vi.fn(
      async (_deps: unknown, input: { requestedTaskId: string; source: string }) => ({
        taskId: input.requestedTaskId,
        source: input.source,
        ticketCreated: false,
        ticketId: null,
        ticketStatus: null,
        ticketTitle: null,
        ticketContext: undefined,
      }),
    ),
  };
});
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn(async () => ({})) }));

describe('a guest turn answers and stops — it cannot create swarm work', () => {
  const TASK_ID = 'e6d1f4c2-0000-4000-8000-0000000000ff';
  const servers: Array<{ close: (cb: () => void) => void }> = [];
  let savedEntitlement: string | undefined;

  beforeEach(() => {
    savedEntitlement = process.env.OSHAL_EXECUTE_ENTITLEMENT;
    // The entitlement gate is a separate control with its own guard; keep it out of the way so
    // this file asserts only the chatOnly forcing.
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'off';
  });
  afterEach(async () => {
    if (savedEntitlement === undefined) delete process.env.OSHAL_EXECUTE_ENTITLEMENT;
    else process.env.OSHAL_EXECUTE_ENTITLEMENT = savedEntitlement;
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(r))));
    servers.length = 0;
    vi.clearAllMocks();
  });

  /** Boots the REAL message router with an identity stamped in the OIDC middleware's shape. */
  async function bootApp(): Promise<string> {
    const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
    const ctx = {
      taskStore: { get: async () => null },
      workspaceService: { resolveTaskOwner: async () => null },
      ticketService: {},
      pool: {},
      orchestrator: {
        processMessage: vi.fn(async () => ({ success: true, response: 'ok', usageSummary: undefined })),
      },
    } as unknown as Parameters<typeof createMessageRoutes>[0];

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const sub = req.header('x-test-sub');
      if (sub) {
        (req as Request & { oidc?: unknown }).oidc = {
          isAuthenticated: () => true,
          user: { sub, email: `${sub}@example.test`, is_guest: req.header('x-test-guest') === 'true' },
        };
      }
      next();
    });
    app.use('/api', createMessageRoutes(ctx));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return `http://127.0.0.1:${address.port}/api`;
  }

  /** The captured input of the ticket-context resolver for the most recent turn. */
  async function lastResolverInput(): Promise<{ chatOnly?: boolean }> {
    const mod = await import('@/features/chat-orchestration');
    const fn = mod.resolveProjectManagerTicketExecutionContext as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(fn.mock.calls.length).toBeGreaterThan(0);
    return fn.mock.calls[fn.mock.calls.length - 1][1] as { chatOnly?: boolean };
  }

  async function turn(base: string, headers: Record<string, string>, body: Record<string, unknown> = {}) {
    return fetch(`${base}/tasks/${TASK_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'what can you do?', ...body }),
    });
  }

  it('forces chatOnly for a guest', async () => {
    const base = await bootApp();
    const res = await turn(base, { 'x-test-sub': 'guest-abc', 'x-test-guest': 'true' });
    expect(res.status).toBe(200);
    expect((await lastResolverInput()).chatOnly).toBe(true);
  }, 30_000);

  it('does NOT let a guest opt out of it from the body', async () => {
    const base = await bootApp();
    // The whole point: a guest asking for a full ticketed run must still get chat only.
    const res = await turn(base, { 'x-test-sub': 'guest-abc', 'x-test-guest': 'true' }, { chatOnly: false });
    expect(res.status).toBe(200);
    expect((await lastResolverInput()).chatOnly).toBe(true);
  }, 30_000);

  it('leaves a signed-in caller free to create a ticket', async () => {
    const base = await bootApp();
    const res = await turn(base, { 'x-test-sub': 'auth0|real-user' }, { chatOnly: false });
    expect(res.status).toBe(200);
    expect((await lastResolverInput()).chatOnly).toBe(false);
  }, 30_000);
});
