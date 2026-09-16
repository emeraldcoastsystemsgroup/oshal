/**
 * Guard: the INLINE half of POST /api/send-message clears the SAME admission gates the
 * executeBotOrInline chokepoint applies — the cost-governance HARD cap first among them.
 * (BACKLOG "One bot-invocation chokepoint — the INLINE half of /api/send-message", whose
 * done-when reads: "a cockpit chat turn to any bot (inline included) passes the budget gate
 * and credential refusals (guard proves a HARD-cap breach blocks it)".)
 *
 * THE HOLE THIS CLOSES. #186 routed the NODE half of this route through executeBotOrInline,
 * so a chat turn to a bot with a dedicated node endpoint passes the budget gate. A bot the
 * registry binds to the controller (`container: 'oshal-api'`, a null endpoint) took the other
 * branch and called `ctx.orchestrator.processMessage` DIRECTLY: no BudgetService check, no
 * specialist-context refusal. A user sitting on a tripped HARD daily cap could keep spending
 * indefinitely through the cockpit chat panel as long as the bot they talked to was inline —
 * which is most of the concierge fleet.
 *
 * WHAT IT CROSSES. The real `createMessageRoutes` router over real HTTP, the real swarm bot
 * registry (the inline agent is picked from it, not hand-typed), the real `BudgetService`
 * SQL + decision logic. Only the pg driver is doubled — a fake pool answering the service's
 * own statements — because this box has no disposable Postgres; the boundary that failed is
 * route → admission gate → BudgetService, and that whole path is real here.
 *
 * Goes red if any of these regress:
 *  - an inline chat turn stops being blocked by a tripped HARD cap, or is blocked only AFTER
 *    the orchestrator has run (a block that costs a model call is an audit line, not a gate);
 *  - the block is reported as a generic 500 rather than the 402 machine code, so the cockpit
 *    cannot tell "you are over your cap" from "the server broke";
 *  - a caller who is UNDER the cap starts being refused (the gate must be a gate, not a wall);
 *  - the gate stops failing OPEN when the budget infrastructure is unreadable — an infra gap
 *    must never brick chat (BudgetService's own documented semantics).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the inline half of the send-message chokepoint.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

// The ticket-context resolver wants a real store/pool and is not under test here; stub it so
// the router's OWN admission behaviour is what is asserted.
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
// Every controller-inline registry bot declares a CLI harness, so the ADR-127 hosted-brain
// ladder runs on this path. That ladder is a SEPARATE decision with its own guards
// (inline-hosted-brain-entry-points.spec.ts); serve it one resolvable lane — everything else in
// the module stays real — so a budget block can never be confused with a missing brain, and so
// the under-cap cases prove the turn actually reaches the orchestrator.
const resolveUserLlmConnection = vi.fn(async () => HOSTED_LANE);
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/routes/free-tier-rotation')>(),
  resolveUserLlmConnection: (...args: unknown[]) => resolveUserLlmConnection(...(args as [])),
}));

const USER_SUB = 'auth0|budget-gate-user';
const TASK_ID = 'c1a5b6d2-0000-4000-8000-000000000042';
const CAP_USD = 1;
const HOSTED_LANE = { baseUrl: 'https://hosted.example.test/v1', model: 'test-model', apiKey: 'test-key' };

const ENV_KEYS = ['SWARM_SERVICE_SECRET', 'OSHAL_EXECUTE_ENTITLEMENT', 'OSHAL_OPERATOR_SUBS', 'SWARM_REGISTRY', 'AGENT_ID', 'BOT_NAME'];
const saved: Record<string, string | undefined> = {};
const servers: Array<{ close: (cb: () => void) => void }> = [];

let processMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  // The entitlement gate is a different control with its own guard; the agent picked below is
  // unscoped, so it never fires here — but pin the mode so a stray env cannot mask this one.
  process.env.OSHAL_EXECUTE_ENTITLEMENT = 'off';
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

/**
 * Picks a real registry agent that is BOTH controller-inline (null endpoint → the branch under
 * test) and unscoped (no accessRoles → the entitlement gate is not what refuses it). Read from
 * the registry so a bot moving container or gaining roles surfaces here instead of silently
 * turning this guard into a test of the node branch.
 */
async function pickInlineAgentId(): Promise<string> {
  const { getActiveRegistry } = await import('../../src/app/extensions/swarm/swarm-bot-registry');
  const { isControllerInlineContainer } = await import('../../src/features/agent-management');
  const entry = getActiveRegistry().find((bot) => {
    if (!bot.agentId || !isControllerInlineContainer(bot.container)) return false;
    const roles = bot.accessRoles;
    return !roles || roles.length === 0;
  });
  if (!entry?.agentId) throw new Error('no unscoped controller-inline registry bot found');
  return entry.agentId;
}

/**
 * A fake pg pool for the REAL cost-governance BudgetService: one enabled HARD user-scope cap of
 * $CAP_USD/day and a ledger spend of `spendUsd`. `unreadable: true` makes every statement throw,
 * which is the infra-gap shape BudgetService fails OPEN on.
 */
function fakeBudgetPool(spendUsd: number, unreadable = false): Pool {
  return {
    query: async (sql: string) => {
      if (unreadable) throw new Error('relation "oshal_budgets" does not exist');
      if (sql.includes('FROM oshal_budgets')) {
        return {
          rows: [{
            id: 1, scope_type: 'user', scope_key: USER_SUB, daily_usd: String(CAP_USD), hard: true,
            enabled: true, set_by_operator: true, created_at: new Date(), updated_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM oshal_cost_events')) return { rows: [{ spend: String(spendUsd) }], rowCount: 1 };
      if (sql.includes('INSERT INTO oshal_budget_events')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

/** Boots the REAL message router over HTTP with the given pool behind the budget gate. */
async function bootApp(pool: Pool): Promise<string> {
  const { createMessageRoutes } = await import('../../src/app/routes/message-routes');
  const ctx = {
    taskStore: { get: async () => null },
    workspaceService: { resolveTaskOwner: async () => null },
    ticketService: {},
    pool,
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

async function send(base: string, agentId: string): Promise<Response> {
  return fetch(`${base}/send-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-sub': USER_SUB },
    body: JSON.stringify({ taskId: TASK_ID, text: 'keep spending', agentId }),
  });
}

describe('POST /api/send-message — the inline half clears the invocation admission gates', () => {
  it('BLOCKS an inline chat turn on a tripped HARD cap, before the orchestrator runs', async () => {
    const base = await bootApp(fakeBudgetPool(CAP_USD + 4));
    const inlineAgent = await pickInlineAgentId();

    const res = await send(base, inlineAgent);

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ success: false, code: 'budget_cap_exceeded' });
    // The load-bearing half: a block that arrives after the model call has already been made
    // is an audit line, not a control. The ladder is untouched too — a refused turn must not
    // consume a free-tier slot on its way to being refused.
    expect(processMessage).not.toHaveBeenCalled();
    expect(resolveUserLlmConnection).not.toHaveBeenCalled();
  }, 30_000);

  it('ALLOWS the same inline turn when spend is under the cap', async () => {
    const base = await bootApp(fakeBudgetPool(CAP_USD - 0.5));
    const inlineAgent = await pickInlineAgentId();

    const res = await send(base, inlineAgent);

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('FAILS OPEN when the budget infrastructure is unreadable — an infra gap must not brick chat', async () => {
    const base = await bootApp(fakeBudgetPool(0, true));
    const inlineAgent = await pickInlineAgentId();

    const res = await send(base, inlineAgent);

    expect(res.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
  }, 30_000);
});
