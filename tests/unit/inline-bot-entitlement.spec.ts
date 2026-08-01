/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the CONTROLLER execute-time entitlement chokepoint (BACKLOG "Bot-endpoint privilege model", diagnosis bot-endpoint-priv): controller-inline bots resolve to a null endpoint (CONTROLLER_INLINE_CONTAINERS) and never reach the bot-node HTTP gate, so executeBotOrInline must run assertExecuteEntitlement itself. Drives the REAL executeBotOrInline + REAL entitlement module against the REAL local registry (project-manager a0000000-...-0001 is ADR-087 operator+swarm-scoped): enforce mode throws CallerNotEntitledError (statusCode 403) BEFORE the orchestrator/bot-node is invoked on BOTH branches; warn (the default) allows-and-logs with surface 'executeBotOrInline'; internal, swarm-dispatch, and operator callers stay trusted. Goes red if the chokepoint check is ever removed or the inline branch stops being covered.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | K6 close-out: the default flipped warn -> ENFORCE in bot-node-execute-entitlement.ts, so the default-mode case here now proves the CONTROLLER chokepoint DENIES with the env unset (CallerNotEntitledError before the orchestrator fires), and the allow-and-log soak behavior is asserted under an EXPLICIT OSHAL_EXECUTE_ENTITLEMENT=warn. Goes red if the chokepoint's default ever regresses to allow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
}));

// Budget gate is out of scope here — always allow so the entitlement behavior is isolated.
vi.mock('@/features/cost-governance', () => ({
  BudgetService: class {
    /** @description Always-allowed budget verdict (the real gate has its own guard specs). */
    async checkBudget(): Promise<{ allowed: boolean }> {
      return { allowed: true };
    }
  },
}));

// The REAL chokepoint + the REAL entitlement module (no policy copy to drift).
import { executeBotOrInline } from '../../src/app/routes/inline-bot-execution';
import { CallerNotEntitledError } from '../../src/app/bot-node-execute-entitlement';
import type { BotNodeRequest, BotNodeResponse } from '../../src/features/agent-management';

const SCOPED_AGENT_ID = 'a0000000-0000-0000-0000-000000000001'; // project-manager — accessRoles ['operator','swarm'] (ADR-087)
const OPEN_AGENT_ID = 'b0000000-0000-0000-0000-000000000001'; // communications-bot — unscoped (open) in the local registry
const OPERATOR_SUB = 'auth0|operator-owner';
const USER_SUB = 'auth0|plain-user';

const ENV_KEYS = ['OSHAL_EXECUTE_ENTITLEMENT', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'SWARM_REGISTRY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
  logSpies.warn.mockClear();
  logSpies.info.mockClear();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** @description Minimal AppContext double: a real orchestrator spy behind the inline branch. */
function makeCtx() {
  const processMessage = vi.fn(async () => ({
    success: true,
    response: 'inline-ok',
    usageSummary: { inputTokens: 1, outputTokens: 2, totalTokens: 3, totalCost: 0.01, byModel: { 'test-model': {} } },
  }));
  return { ctx: { pool: {}, orchestrator: { processMessage } } as any, processMessage };
}

/** @description Bot-node client double for either branch of the chokepoint. */
function makeBotClient(hasEndpoint: boolean) {
  const execute = vi.fn(async (): Promise<BotNodeResponse> => ({
    success: true,
    response: 'remote-ok',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0.01,
    model: 'test-model',
    provider: 'test',
    durationMs: 5,
  }));
  return { client: { hasEndpoint: () => hasEndpoint, execute } as any, execute };
}

function makeRequest(overrides: Partial<BotNodeRequest> = {}): BotNodeRequest {
  return {
    text: 'do the thing',
    taskId: 'task-entitlement-1',
    workspaceFolderId: 'ws-1',
    agentId: SCOPED_AGENT_ID,
    ...overrides,
  } as BotNodeRequest;
}

describe('executeBotOrInline execute-time entitlement chokepoint', () => {
  it('ENFORCE: an unentitled identity caller targeting the scoped project-manager is denied BEFORE the inline orchestrator runs', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const { ctx, processMessage } = makeCtx();
    const { client } = makeBotClient(false); // inline bot: null endpoint — never reaches the bot-node HTTP gate

    const attempt = executeBotOrInline(ctx, client, SCOPED_AGENT_ID, makeRequest({ userSub: USER_SUB, direct: true }));
    await expect(attempt).rejects.toBeInstanceOf(CallerNotEntitledError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 403, code: 'caller_not_entitled_to_agent' });
    expect(processMessage).not.toHaveBeenCalled();

    expect(logSpies.warn).toHaveBeenCalledTimes(1);
    const [meta] = logSpies.warn.mock.calls[0] as [Record<string, unknown>];
    expect(meta.outcome).toBe('DENIED');
    expect(meta.callerSub).toBe(USER_SUB);
    expect(meta.targetAgentId).toBe(SCOPED_AGENT_ID);
    expect(meta.surface).toBe('executeBotOrInline');
    expect(String(meta.backlogItem)).toContain('Bot-endpoint privilege model');
  });

  it('ENFORCE: the remote branch is denied controller-side BEFORE botClient.execute fires', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const { ctx } = makeCtx();
    const { client, execute } = makeBotClient(true);

    await expect(
      executeBotOrInline(ctx, client, SCOPED_AGENT_ID, makeRequest({ userSub: USER_SUB, direct: true })),
    ).rejects.toBeInstanceOf(CallerNotEntitledError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('the DEFAULT (env unset) is ENFORCE: the unentitled inline call is DENIED before the orchestrator fires', async () => {
    const { ctx, processMessage } = makeCtx();
    const { client } = makeBotClient(false);

    const attempt = executeBotOrInline(ctx, client, SCOPED_AGENT_ID, makeRequest({ userSub: USER_SUB, direct: true }));
    await expect(attempt).rejects.toBeInstanceOf(CallerNotEntitledError);
    expect(processMessage).not.toHaveBeenCalled();
    const denials = logSpies.warn.mock.calls.filter(([meta]) => (meta as Record<string, unknown>)?.surface === 'executeBotOrInline');
    expect(denials).toHaveLength(1);
    expect(String((denials[0][0] as Record<string, unknown>).outcome)).toBe('DENIED');
  });

  it('WARN is an EXPLICIT soak opt-out: the same unentitled call executes but the would-be denial is logged', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'warn';
    const { ctx, processMessage } = makeCtx();
    const { client } = makeBotClient(false);

    const result = await executeBotOrInline(ctx, client, SCOPED_AGENT_ID, makeRequest({ userSub: USER_SUB, direct: true }));
    expect(result.success).toBe(true);
    expect(processMessage).toHaveBeenCalledTimes(1);

    const denials = logSpies.warn.mock.calls.filter(([meta]) => (meta as Record<string, unknown>)?.surface === 'executeBotOrInline');
    expect(denials).toHaveLength(1);
    expect(String((denials[0][0] as Record<string, unknown>).outcome)).toContain('warn-only');
  });

  it('ENFORCE: trusted caller classes still execute — internal (no userSub), swarm dispatch (userSub, no direct), operator, and an open bot', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const { ctx, processMessage } = makeCtx();
    const { client } = makeBotClient(false);

    // Anonymous internal dispatch.
    await executeBotOrInline(ctx, client, SCOPED_AGENT_ID, makeRequest());
    // Queue/swarm dispatch threading the ticket owner's sub (no direct flag) — must not break pipelines.
    await executeBotOrInline(ctx, client, SCOPED_AGENT_ID, makeRequest({ userSub: USER_SUB }));
    // Operator interactive delegation to internal machinery.
    await executeBotOrInline(ctx, client, SCOPED_AGENT_ID, makeRequest({ userSub: OPERATOR_SUB, direct: true }));
    // Plain user's interactive delegation to an OPEN (unscoped) bot.
    await executeBotOrInline(ctx, client, OPEN_AGENT_ID, makeRequest({ agentId: OPEN_AGENT_ID, userSub: USER_SUB, direct: true }));

    expect(processMessage).toHaveBeenCalledTimes(4);
    const denials = logSpies.warn.mock.calls.filter(([meta]) => (meta as Record<string, unknown>)?.surface === 'executeBotOrInline');
    expect(denials).toHaveLength(0);
  });
});
