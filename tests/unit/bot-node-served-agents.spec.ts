/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the concierge node's served-agent policy and the handler's foreign-agent rules. The policy is driven through the real ownership reader (application-execution-ownership.ts) over a doubled pool that records each read: a dedicated node serves only itself and never reads; an unknown BOT_NODE_SERVES refuses to start; the concierge serves itself without a read, never a kernel or static identity (no read either), an owned agent after one read that is cached until the TTL, never an unowned one (and does not cache the refusal), and a failed read rejects. The handler cases drive createBotNodeExecutionHandler with a stubbed any-bot controller: N8 two served agents on one workspace get two different agent-scoped tasks while the cost task id stays `${workspace}::${agent}` and the node's own agent keeps the workspace task; N9 a served agent's credential carrier or provider intent is refused before any task, lookup or provider operation, while the same intent for the node's own agent still runs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The static-floor example is now vault-bot (core); feeds-curator, a reviewed static app concierge, is served only when an installed application owns it.
 */

import { describe, expect, it, vi } from 'vitest';
import { createServedAgentPolicy } from '@/app/bot-node-served-agents';
import { createBotNodeExecutionHandler } from '@/app/bot-node-execution-handler';
import { canonicalBotWorkspaceId } from '@/app/bot-node-request-scope';

const LOCAL = 'd97fe8e7-d2d6-4b18-b8df-f15e15820d79';
const OWNED = 'c0ffee00-0000-4000-8000-0000000000e1';
const OWNED_TOO = 'c0ffee00-0000-4000-8000-0000000000e2';
const UNOWNED = 'c0ffee00-0000-4000-8000-0000000000e3';
const KERNEL = 'a0000000-0000-0000-0000-000000000001';
const STATIC = 'a0000000-0000-0000-0000-0000000000d0'; // vault-bot: a core static inline bot, never served
const REVIEWED_STATIC = 'fd000000-0000-0000-0000-000000000001'; // feeds-curator: a reviewed static app concierge
const SERVES = { BOT_NODE_SERVES: 'inline-app-bots' };
const OWNER = 'auth0|concierge-operator';
const WORKSPACE = 'jarvis-thread-0001';

/** An ownership pool that knows two installed application bots and records every read. */
function ownershipPool() {
  const query = vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: [OWNED, OWNED_TOO, REVIEWED_STATIC].includes(String(params[1])) ? [{ app: 'spec-concierge-app', protected: false }] : [],
  }));
  return { pool: { query } as never, query };
}

describe('served-agent policy', () => {
  it('a dedicated node serves only its own agent and never reads ownership', async () => {
    const { pool, query } = ownershipPool();
    const policy = createServedAgentPolicy({ localAgentId: LOCAL, pool, env: {} });
    expect(policy.multiAgent).toBe(false);
    expect(await policy.serves(LOCAL)).toBe(true);
    expect(await policy.serves(OWNED)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses to start on an unknown BOT_NODE_SERVES mode', () => {
    expect(() => createServedAgentPolicy({ localAgentId: LOCAL, pool: null, env: { BOT_NODE_SERVES: 'everything' } }))
      .toThrow(/BOT_NODE_SERVES/);
  });

  it('the concierge serves itself and owned application bots, never a kernel or static identity', async () => {
    const { pool, query } = ownershipPool();
    const policy = createServedAgentPolicy({ localAgentId: LOCAL, pool, env: SERVES });
    expect(policy.multiAgent).toBe(true);
    expect(await policy.serves(LOCAL)).toBe(true);
    expect(await policy.serves(KERNEL)).toBe(false);
    expect(await policy.serves(STATIC)).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(await policy.serves(OWNED)).toBe(true);
    expect(await policy.serves(UNOWNED)).toBe(false);
    expect(query.mock.calls.map((call) => call[1])).toEqual([['bots', OWNED, true], ['bots', UNOWNED, true]]);
  });

  it('serves a reviewed static app concierge only when an installed application owns it', async () => {
    const { pool, query } = ownershipPool();
    const policy = createServedAgentPolicy({ localAgentId: LOCAL, pool, env: SERVES });
    expect(await policy.serves(REVIEWED_STATIC)).toBe(true);
    expect(query.mock.calls.map((call) => call[1])).toEqual([['bots', REVIEWED_STATIC, true]]);
    const unowned = createServedAgentPolicy({ localAgentId: LOCAL, pool: { query: vi.fn(async () => ({ rows: [] })) } as never, env: SERVES });
    expect(await unowned.serves(REVIEWED_STATIC)).toBe(false);
  });

  it('caches a positive answer until the TTL and never caches a refusal', async () => {
    const { pool, query } = ownershipPool();
    let clock = 1_000;
    const policy = createServedAgentPolicy({ localAgentId: LOCAL, pool, env: SERVES, now: () => clock });
    await policy.serves(OWNED);
    await policy.serves(OWNED);
    expect(query).toHaveBeenCalledTimes(1);
    clock += 30_001;
    await policy.serves(OWNED);
    expect(query).toHaveBeenCalledTimes(2);
    await policy.serves(UNOWNED);
    await policy.serves(UNOWNED);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('reads in legacy mode when the deployment says so, and rejects when the read fails', async () => {
    const { pool, query } = ownershipPool();
    await createServedAgentPolicy({ localAgentId: LOCAL, pool, env: { ...SERVES, OSHAL_APPLICATION_AUTHORIZATION_MODE: 'legacy' } })
      .serves(OWNED);
    expect(query.mock.calls[0][1]).toEqual(['bots', OWNED, false]);
    const failing = createServedAgentPolicy({ localAgentId: LOCAL, env: SERVES,
      pool: { query: vi.fn(async () => { throw new Error('database unreachable'); }) } as never });
    await expect(failing.serves(OWNED)).rejects.toThrow('Application execution ownership is unavailable');
    await expect(createServedAgentPolicy({ localAgentId: LOCAL, pool: null, env: SERVES }).serves(OWNED)).rejects.toThrow();
  });
});

/** A handler on the concierge node with a stubbed any-bot controller that records every call. */
function conciergeHandler() {
  const getTask = vi.fn(async () => null);
  const createTask = vi.fn(async (_title: string, _mode: string, opts?: { forceTaskId?: string }) => ({ id: opts?.forceTaskId ?? 'generated' }));
  const processMessage = vi.fn(async () => ({ messages: [{ say: 'completion_result', text: 'served answer' }], apiMetrics: { totalTokens: 3 } }));
  const recordCost = vi.fn(async (_event: { taskId: string }) => undefined);
  const executeProviderIntent = vi.fn(async () => ({ completion: 'forecast', providerRecords: [] }));
  const handler = createBotNodeExecutionHandler({
    runtimeAgentId: LOCAL, multiAgentNode: true,
    anyBotTaskController: { getTask, createTask, processMessage },
    providerName: 'noop', modelName: 'none', recordCost, executeProviderIntent,
  });
  return { handler, getTask, createTask, processMessage, recordCost, executeProviderIntent };
}

function envelope(agentId: string, payload: Record<string, unknown> = {}) {
  return {
    correlationId: `served-${agentId}`, fromAgentId: 'swarm-controller', toAgentId: agentId,
    channel: `swarm.agent.${agentId}`, messageType: 'request' as const,
    payload: { text: 'hello', workspaceTaskId: WORKSPACE, workspaceFolderId: WORKSPACE, userSub: OWNER,
      direct: true, agenticMode: false, ...payload },
  };
}

describe('the handler on a multi-agent node', () => {
  it('N8: two served agents on one workspace get different agent-scoped tasks; cost ids and the node\'s own task are unchanged', async () => {
    const node = conciergeHandler();

    const first = await node.handler(envelope(OWNED));
    const second = await node.handler(envelope(OWNED_TOO));
    const own = await node.handler(envelope(LOCAL));

    expect([first.success, second.success, own.success]).toEqual([true, true, true]);
    const forced = node.createTask.mock.calls.map((call) => call[2]?.forceTaskId);
    expect(forced).toEqual([
      canonicalBotWorkspaceId(`${WORKSPACE}--${OWNED}`),
      canonicalBotWorkspaceId(`${WORKSPACE}--${OWNED_TOO}`),
      WORKSPACE,
    ]);
    expect(new Set(forced).size).toBe(3);
    expect(node.recordCost.mock.calls.map((call) => call[0].taskId)).toEqual([
      `${WORKSPACE}::${OWNED}`, `${WORKSPACE}::${OWNED_TOO}`, `${WORKSPACE}::${LOCAL}`,
    ]);
  });

  it('N8b: a dedicated node (no multiAgentNode) keeps the workspace task for whatever agent it is handed', async () => {
    const createTask = vi.fn(async (_title: string, _mode: string, opts?: { forceTaskId?: string }) => ({ id: opts?.forceTaskId ?? 'generated' }));
    const handler = createBotNodeExecutionHandler({
      runtimeAgentId: LOCAL,
      anyBotTaskController: { getTask: async () => null, createTask,
        processMessage: async () => ({ messages: [{ say: 'completion_result', text: 'answer' }] }) },
      providerName: 'noop', modelName: 'none',
    });
    await handler(envelope(OWNED));
    expect(createTask.mock.calls[0][2]?.forceTaskId).toBe(WORKSPACE);
  });

  it.each([
    { label: 'a credential carrier', payload: { creds: { OSHAL_CRED_GOOGLE: 'never-used' } } },
    { label: 'a provider intent', payload: { providerIntent: { schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Pensacola' } } },
  ])('N9: $label for a served agent is refused before any task, lookup or provider operation', async ({ payload }) => {
    const node = conciergeHandler();

    const result = await node.handler(envelope(OWNED, payload));

    expect(result).toMatchObject({ success: false });
    expect(String(result.error)).toContain('accepts no connector credentials or provider intent');
    expect(node.getTask).not.toHaveBeenCalled();
    expect(node.createTask).not.toHaveBeenCalled();
    expect(node.processMessage).not.toHaveBeenCalled();
    expect(node.executeProviderIntent).not.toHaveBeenCalled();
  });

  it('N9b: the same provider intent for the node\'s own agent still runs', async () => {
    const node = conciergeHandler();
    const result = await node.handler(envelope(LOCAL, {
      providerIntent: { schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Pensacola' },
    }));
    expect(result).toMatchObject({ success: true });
    expect(node.executeProviderIntent).toHaveBeenCalledTimes(1);
  });
});
