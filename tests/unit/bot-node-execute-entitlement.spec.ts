/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the execute-time entitlement gate on the bot-node's POST /api/swarm-execute (BACKLOG "Bot-endpoint privilege model"). Drives the REAL middleware chain the server mounts (authorizeBotNodeExecutionCall → createExecuteEntitlementGate) against the REAL local registry: (1) service-secret internal + queue dispatch passes; (2) entitled identity passes (unscoped target / operator sub on a scoped target / the assistant front door); (3) an unentitled identity caller 403s in enforce mode with the denial logged; plus warn-mode allows-and-logs, off-mode (default) no-ops, the pure decision matrix with injected deps, and mode parsing.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | K6 close-out: default mode flipped warn -> ENFORCE. The default-mode e2e case now proves a denial actually DENIES — env unset, unentitled identity caller gets 403 through the REAL middleware chain while the operator path and queue dispatch stay green — and mode parsing pins {} / unknown values -> 'enforce' (fail closed; a typo must not relax enforcement) with 'warn' as the EXPLICIT soak opt-out. Goes red if the default ever silently regresses to allow.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Default mode flipped off → WARN (rollout fix — OSHAL_EXECUTE_ENTITLEMENT was wired nowhere, so 'off default' disabled the gate on every deployment): the default-mode e2e case now asserts allow-and-log (warn soak), 'off' is asserted as an EXPLICIT opt-out only, and mode parsing pins {} / unknown values → 'warn' and off/false/disabled → 'off'. Goes red if the default ever silently regresses to no-check.
 */

import express from 'express';
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

// The REAL middleware the bot-node server mounts on /api/swarm-execute, in the REAL order —
// tested directly so there is no policy copy to drift.
import { authorizeBotNodeExecutionCall } from '../../src/app/bot-node-request-auth';
import {
  createExecuteEntitlementGate,
  decideExecuteEntitlement,
  resolveExecuteEntitlementMode,
} from '../../src/app/bot-node-execute-entitlement';

const SECRET = 'entitlement-test-secret';
const NODE_AGENT_ID = 'b0000000-0000-0000-0000-000000000001';   // communications-bot — unscoped (open) in the local registry
const SCOPED_AGENT_ID = 'a0000000-0000-0000-0000-000000000001'; // project-manager — accessRoles ['operator','swarm'] (ADR-087)
const FRONT_DOOR_AGENT_ID = 'a0000000-0000-0000-0000-000000000050'; // oshal-assistant — scoped, but role assistant/unified-front-door
const OPERATOR_SUB = 'auth0|operator-owner';
const USER_SUB = 'auth0|plain-user';

const ENV_KEYS = ['SWARM_SERVICE_SECRET', 'OSHAL_EXECUTE_ENTITLEMENT', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'SWARM_REGISTRY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.SWARM_SERVICE_SECRET = SECRET;          // machine-auth chain active (fail-closed)
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;     // operator allowlist for the entitled-operator case
  logSpies.warn.mockClear();
  logSpies.info.mockClear();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('bot-node /api/swarm-execute execute-time entitlement gate', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(r))));
    servers.length = 0;
  });

  async function boot(): Promise<string> {
    const app = express();
    app.use(express.json());
    // The REAL production chain: machine auth first, then caller entitlement.
    app.post(
      '/api/swarm-execute',
      authorizeBotNodeExecutionCall,
      createExecuteEntitlementGate({ defaultAgentId: NODE_AGENT_ID }),
      (_req, res) => res.json({ success: true }),
    );
    const server = app.listen(0);
    servers.push(server);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return `http://127.0.0.1:${addr.port}/api/swarm-execute`;
  }

  const post = (url: string, body: Record<string, unknown> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-secret': SECRET },
      body: JSON.stringify(body),
    });

  it('service-secret internal dispatch passes in enforce mode (no identity payload)', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const url = await boot();
    expect((await post(url, { agentId: SCOPED_AGENT_ID })).status).toBe(200);
  });

  it('queue/swarm dispatch threading the ticket owner sub (no direct flag) passes in enforce mode', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const url = await boot();
    // Queue-manager phase dispatch to an internal reviewer bot with the owner's sub for
    // the token broker — MUST stay trusted or the build/incident pipelines break.
    expect((await post(url, { agentId: SCOPED_AGENT_ID, userSub: USER_SUB })).status).toBe(200);
  });

  it('entitled identity passes: unscoped target, operator on a scoped target, and the assistant front door', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const url = await boot();
    // A plain user's interactive delegation to an OPEN bot (ADR-087 unscoped).
    expect((await post(url, { agentId: NODE_AGENT_ID, userSub: USER_SUB, direct: true })).status).toBe(200);
    // An operator reaching internal machinery interactively.
    expect((await post(url, { agentId: SCOPED_AGENT_ID, userSub: OPERATOR_SUB, direct: true })).status).toBe(200);
    // The assistant front door: scoped operator+swarm for discovery-hiding only — every
    // user turn arrives here as direct+userSub, so it must stay reachable (registry comment).
    expect((await post(url, { agentId: FRONT_DOOR_AGENT_ID, userSub: USER_SUB, direct: true })).status).toBe(200);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('unentitled identity 403s in enforce mode and the denial is logged', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const url = await boot();
    const response = await post(url, { agentId: SCOPED_AGENT_ID, userSub: USER_SUB, direct: true, taskId: 't-1' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'caller_not_entitled_to_agent' });
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
    const [meta] = logSpies.warn.mock.calls[0] as [Record<string, unknown>];
    expect(meta.callerSub).toBe(USER_SUB);
    expect(meta.targetAgentId).toBe(SCOPED_AGENT_ID);
    expect(String(meta.backlogItem)).toContain('Bot-endpoint privilege model');
  });

  it('warn mode allows the same unentitled call but logs the would-be denial', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'warn';
    const url = await boot();
    expect((await post(url, { agentId: SCOPED_AGENT_ID, userSub: USER_SUB, direct: true })).status).toBe(200);
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
    const [meta] = logSpies.warn.mock.calls[0] as [Record<string, unknown>];
    expect(String(meta.outcome)).toContain('warn-only');
  });

  it('the DEFAULT (env unset) is ENFORCE: an unentitled call is REFUSED, and the operator/queue paths still work', async () => {
    const url = await boot(); // OSHAL_EXECUTE_ENTITLEMENT unset → enforce default (fail closed)
    const denied = await post(url, { agentId: SCOPED_AGENT_ID, userSub: USER_SUB, direct: true });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ success: false, error: 'caller_not_entitled_to_agent' });
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
    const [meta] = logSpies.warn.mock.calls[0] as [Record<string, unknown>];
    expect(String(meta.outcome)).toBe('DENIED');
    // The flip must not strand legitimate callers: the operator's interactive path and the
    // queue-manager's owner-sub dispatch both stay green under the same default.
    expect((await post(url, { agentId: SCOPED_AGENT_ID, userSub: OPERATOR_SUB, direct: true })).status).toBe(200);
    expect((await post(url, { agentId: SCOPED_AGENT_ID, userSub: USER_SUB })).status).toBe(200);
  });

  it('off mode is an EXPLICIT opt-out: no check, no log', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'off';
    const url = await boot();
    expect((await post(url, { agentId: SCOPED_AGENT_ID, userSub: USER_SUB, direct: true })).status).toBe(200);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('an absent body agentId falls back to the node own agent id', async () => {
    process.env.OSHAL_EXECUTE_ENTITLEMENT = 'enforce';
    const url = await boot();
    // defaultAgentId is the unscoped communications-bot → an interactive user is entitled.
    expect((await post(url, { userSub: USER_SUB, direct: true })).status).toBe(200);
  });

  describe('decideExecuteEntitlement (pure decision matrix, injected deps)', () => {
    const deps = {
      isOperator: (sub: string) => sub === OPERATOR_SUB,
      isUserDelegationAccessible: (agentId: string) => agentId === 'open-bot',
      isAssistantFrontDoor: (agentId: string) => agentId === 'front-door-bot',
    };

    it('classifies every caller class', () => {
      expect(decideExecuteEntitlement({ userSub: null, direct: true, targetAgentId: 'scoped-bot' }, deps))
        .toEqual({ allowed: true, caller: 'internal-dispatch' });
      expect(decideExecuteEntitlement({ userSub: USER_SUB, direct: false, targetAgentId: 'scoped-bot' }, deps))
        .toEqual({ allowed: true, caller: 'swarm-dispatch' });
      expect(decideExecuteEntitlement({ userSub: OPERATOR_SUB, direct: true, targetAgentId: 'scoped-bot' }, deps))
        .toEqual({ allowed: true, caller: 'operator' });
      expect(decideExecuteEntitlement({ userSub: USER_SUB, direct: true, targetAgentId: 'open-bot' }, deps))
        .toEqual({ allowed: true, caller: 'entitled-user' });
      expect(decideExecuteEntitlement({ userSub: USER_SUB, direct: true, targetAgentId: 'front-door-bot' }, deps))
        .toEqual({ allowed: true, caller: 'front-door' });
      expect(decideExecuteEntitlement({ userSub: USER_SUB, direct: true, targetAgentId: 'scoped-bot' }, deps))
        .toEqual({ allowed: false, caller: 'identity-mismatch', callerSub: USER_SUB });
    });

    it('treats a blank/whitespace userSub as internal dispatch', () => {
      expect(decideExecuteEntitlement({ userSub: '   ', direct: true, targetAgentId: 'scoped-bot' }, deps))
        .toEqual({ allowed: true, caller: 'internal-dispatch' });
    });
  });

  describe('resolveExecuteEntitlementMode', () => {
    it('defaults to ENFORCE; warn/off are explicit opt-outs; unknown values fall back to enforce (a typo must not relax enforcement)', () => {
      expect(resolveExecuteEntitlementMode({})).toBe('enforce');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'warn' })).toBe('warn');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'off' })).toBe('off');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'false' })).toBe('off');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'disabled' })).toBe('off');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'enforce' })).toBe('enforce');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'ENFORCE' })).toBe('enforce');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'on' })).toBe('enforce');
      expect(resolveExecuteEntitlementMode({ OSHAL_EXECUTE_ENTITLEMENT: 'banana' })).toBe('enforce');
    });
  });
});
