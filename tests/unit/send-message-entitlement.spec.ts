/**
 * Guard: execute-time entitlement is enforced at the ACTUAL endpoint call on
 * POST /api/send-message (and POST /api/tasks/:taskId/messages).
 * (BACKLOG "Bot-endpoint privilege model — authorize the ACTUAL endpoint call, not
 * just DB/UI", whose done-when names /api/send-message explicitly.)
 *
 * THE HOLE THIS CLOSES. The route honoured a caller-supplied `body.agentId` verbatim and
 * called ctx.orchestrator.processMessage directly — never through executeBotOrInline — so
 * the gate K6 flipped to enforce covered /api/swarm-execute and the executeBotOrInline
 * chokepoint but NOT this route. The IDOR guard above it checks the THREAD, not the BOT, so
 * a signed-in non-operator could reach the ADR-087 operator+swarm machinery K7 scoped
 * (oshal-developer, devops-bot, vault-bot, security-analyst, code-developer …) simply by
 * naming its agentId on a task they legitimately own.
 *
 * Goes red if any of these regress:
 *  - an unentitled interactive caller stops being refused (403), or is refused only AFTER
 *    the orchestrator has been called (a denial must cost no LLM work and create no ticket);
 *  - an entitled caller, an operator, or SWARM/QUEUE dispatch (service secret) starts being
 *    refused — the dispatch-manifest-worker/dispatch-incident-worker localhost fallback and
 *    the headless CLI both arrive on this route;
 *  - the denial is reported as a 500 rather than a 403 with the machine code the bot-node
 *    gate uses.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the send-message entitlement gap. Drives the REAL createMessageRoutes router against the REAL swarm registry over HTTP, asserting both the denial and that the orchestrator was never reached.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ticket-context resolver and the token broker are not under test here and both want a
// real store/pool; stub them so the router's OWN behaviour is what is asserted.
vi.mock('@/features/chat-orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat-orchestration')>();
  return {
    ...actual,
    resolveProjectManagerTicketExecutionContext: vi.fn(async (_deps: unknown, input: { requestedTaskId: string; source: string }) => ({
      taskId: input.requestedTaskId,
      source: input.source,
      ticketCreated: false,
      ticketId: null,
      ticketStatus: null,
      ticketTitle: null,
      ticketContext: undefined,
    })),
  };
});
vi.mock('@/app/routes/connector-token-broker', () => ({
  resolveBotCreds: vi.fn(async () => ({})),
}));

const SECRET = 'send-message-entitlement-secret';
const OPERATOR_SUB = 'auth0|sm-operator';
const USER_SUB = 'auth0|sm-plain-user';
const TASK_ID = 'e6d1f4c2-0000-4000-8000-000000000001';

const ENV_KEYS = [
  'SWARM_SERVICE_SECRET',
  'OSHAL_EXECUTE_ENTITLEMENT',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'SWARM_REGISTRY',
];
const saved: Record<string, string | undefined> = {};
const servers: Array<{ close: (cb: () => void) => void }> = [];

let processMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.SWARM_SERVICE_SECRET = SECRET;
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
  processMessage = vi.fn(async () => ({ success: true, response: 'ok', usageSummary: undefined }));
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
  vi.clearAllMocks();
});

/** Picks a real registry agentId matching an accessRoles shape, so bot moves do not break this. */
async function pickAgentId(scoped: boolean): Promise<string> {
  const { getActiveRegistry } = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const entry = getActiveRegistry().find((bot) => {
    if (!bot.agentId) return false;
    const roles = bot.accessRoles;
    const isScoped = Array.isArray(roles) && roles.length > 0 && !roles.includes('jarvis');
    // Front doors are exempt by design (assistant/* role), so never pick one as the scoped case.
    if (scoped) return isScoped && !String(bot.role ?? '').startsWith('assistant/');
    return !roles || roles.length === 0;
  });
  if (!entry?.agentId) throw new Error(`no ${scoped ? 'scoped' : 'open'} registry bot found`);
  return entry.agentId;
}

/**
 * Boots the REAL message router. Identity is stamped in the shape the OIDC/PAT middleware
 * produces; the ctx stub answers only what the send path reads before dispatch.
 */
async function bootApp(): Promise<string> {
  const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
  const ctx = {
    // No such task yet + no resolvable ticket owner: callerMayAccessTask's brand-new-thread
    // path, which ALLOWS. That is deliberate — it isolates the assertion on bot entitlement
    // from thread ownership, and makes the point the fix rests on: passing the IDOR guard
    // (owning the THREAD) says nothing about being entitled to the BOT.
    taskStore: { get: async () => null },
    workspaceService: { resolveTaskOwner: async () => null },
    ticketService: {},
    pool: {},
    orchestrator: { processMessage },
  } as unknown as Parameters<typeof createMessageRoutes>[0];

  const app = express();
  app.use(express.json());
  app.use(((req: Request, _res: Response, next: NextFunction) => {
    const sub = req.header('x-test-sub');
    if (sub) {
      (req as Request & { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub, email: `${sub}@example.test` },
      };
    }
    next();
  }));
  app.use('/api', createMessageRoutes(ctx));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}/api`;
}

async function send(base: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/send-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ taskId: TASK_ID, text: 'do the thing', ...body }),
  });
}

describe('POST /api/send-message — execute-time entitlement', () => {
  it('REFUSES a plain signed-in user who names an operator/swarm-scoped bot, and never reaches the LLM', async () => {
    const base = await bootApp();
    const scoped = await pickAgentId(true);

    const res = await send(base, { 'x-test-sub': USER_SUB }, { agentId: scoped });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: 'caller_not_entitled_to_agent' });
    // The load-bearing half: a denial costs nothing. Refusing after processMessage would be
    // an audit line, not a control.
    expect(processMessage).not.toHaveBeenCalled();
  }, 30_000);

  it('ALLOWS the same caller on an unscoped (user-facing) bot', async () => {
    const base = await bootApp();
    const open = await pickAgentId(false);

    const res = await send(base, { 'x-test-sub': USER_SUB }, { agentId: open });

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0][2]).toMatchObject({ agentId: open, userSub: USER_SUB });
  });

  it('ALLOWS an operator on a scoped bot (the allowlist is the escape hatch)', async () => {
    const base = await bootApp();
    const scoped = await pickAgentId(true);

    const res = await send(base, { 'x-test-sub': OPERATOR_SUB }, { agentId: scoped });

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS swarm/queue dispatch on a scoped bot — the service-secret callers are not interactive', async () => {
    // dispatch-manifest-worker / dispatch-incident-worker fall back to this route over
    // localhost with the service secret and the TICKET OWNER's sub; blocking them would break
    // the build + incident pipelines.
    const base = await bootApp();
    const scoped = await pickAgentId(true);

    const res = await send(
      base,
      { 'x-service-secret': SECRET, 'x-oshal-user-sub': USER_SUB },
      { agentId: scoped, source: 'dispatch-manifest-worker' },
    );

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it('the kill switch still works: OSHAL_EXECUTE_ENTITLEMENT=off restores the old behaviour', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'off';
    const base = await bootApp();
    const scoped = await pickAgentId(true);

    const res = await send(base, { 'x-test-sub': USER_SUB }, { agentId: scoped });

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it('warn mode allows but the DEFAULT (unset) denies — a typo must not relax the gate', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'warn';
    let base = await bootApp();
    const scoped = await pickAgentId(true);
    expect((await send(base, { 'x-test-sub': USER_SUB }, { agentId: scoped })).status).toBe(200);

    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'ENFROCE-typo';
    base = await bootApp();
    expect((await send(base, { 'x-test-sub': USER_SUB }, { agentId: scoped })).status).toBe(403);
  });

  it('the same gate applies on POST /api/tasks/:taskId/messages (the aliased mount)', async () => {
    const base = await bootApp();
    const scoped = await pickAgentId(true);

    const res = await fetch(`${base}/tasks/${TASK_ID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
      body: JSON.stringify({ text: 'do the thing', agentId: scoped }),
    });

    expect(res.status).toBe(403);
    expect(processMessage).not.toHaveBeenCalled();
  });
});
