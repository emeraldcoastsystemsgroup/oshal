/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the generic
 *   browser-task dispatch rail extracted from apply-dispatch. Locks the contract both career-apply and
 *   linkedin-profile now depend on: it enqueues a codex.exec envelope with the CALLER's agent id +
 *   prompt (no app vocabulary of its own), passes the chosen worker's callback URL to a prompt-builder
 *   form, honors an explicit node pick, treats a wedged (non-draining) worker as unavailable, and
 *   returns a clean error (never throws) when no browser-capable node is connected.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | 2026-07-30 23:04:00 | Isolated
 *   device-ownership environment variables around the generic browser-task dispatch tests so the
 *   owner-scoped picker contract is deterministic after suites that exercise operator or legacy
 *   unowned-device compatibility flags.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const enqueued: Array<{ clientId: string; env: any }> = [];
  const state = {
    clients: [] as Array<Record<string, unknown>>,
  };
  return { enqueued, state };
});

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => hoisted.state.clients,
    enqueueTask: (clientId: string, env: any) => { hoisted.enqueued.push({ clientId, env }); return { taskId: env.taskId }; },
  },
  taskWorkspaceFolder: (id: string) => `/tmp/${id}`,
}));

import { dispatchBrowserTask } from '@/app/browser-task-dispatch';

/** The signed-in user these tasks are on behalf of; the nodes below are HIS machines. Node selection
 *  is owner-scoped (tests/unit/device-access-dispatch.spec.ts owns that rule), so a rail test has to
 *  say who is asking — an unattributed dispatch is denied on purpose. */
const OWNER = 'owner-sub-1';
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED', 'APPLY_EDGE_CLIENT_ID', 'APPLY_EDGE_HOSTNAME'] as const;
const savedEnv: Record<string, string | undefined> = {};

const NODE_A = {
  clientId: 'node-a', tailnetHostname: 'edge-node-1', status: 'online', healthy: true, ownerSub: OWNER,
  capabilities: ['codex.exec'], taskQueueDepth: 0, agentId: 'agent-a', controlPlaneUrl: 'http://box.lan:35457',
};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  delete process.env.OSHAL_ALLOW_LEGACY_UNOWNED;
  delete process.env.APPLY_EDGE_CLIENT_ID;
  process.env.APPLY_EDGE_HOSTNAME = 'edge-node-1';
  hoisted.enqueued.length = 0;
  hoisted.state.clients = [structuredClone(NODE_A)];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('dispatchBrowserTask — the generic browser-task rail', () => {
  it('enqueues a codex.exec envelope with the CALLER\'s agent id + prompt (no app vocabulary)', () => {
    const r = dispatchBrowserTask({ taskId: 't1', userSub: OWNER, fromAgentId: 'caller-bot-xyz', prompt: 'do the thing in the browser' });
    expect(r.ok).toBe(true);
    expect(r.clientId).toBe('node-a');
    const { env } = hoisted.enqueued[0];
    expect(env.fromAgentId).toBe('caller-bot-xyz');          // caller-supplied, not hardcoded
    expect(env.toAgentId).toBe('agent-a');
    expect(env.intent).toBe('mcp.call-tool');
    expect(env.input.name).toBe('codex.exec');
    expect(env.input.arguments.prompt).toBe('do the thing in the browser');
    expect(env.input.arguments.sandbox).toBe('danger-full-access');
    // The rail carries nothing career-specific.
    expect(JSON.stringify(env)).not.toMatch(/resume|CAREER_HUNTER|posting/i);
    expect(env.input.arguments.model).toBeUndefined();       // omitted when not requested
    expect(env.workspacePath).toBeUndefined();               // omitted when nothing staged
  });

  it('passes the chosen worker\'s callback URL to a prompt-builder form', () => {
    let seen = '';
    dispatchBrowserTask({
      taskId: 't2', userSub: OWNER, fromAgentId: 'b', workspacePath: 't2', model: 'gpt-5.5-codex',
      prompt: ({ controllerUrl, client }) => { seen = controllerUrl; return `post back to ${controllerUrl} / ${client.clientId}`; },
    });
    expect(seen).toBe('http://box.lan:35457');               // the node's registered controlPlaneUrl wins
    const { env } = hoisted.enqueued[0];
    expect(env.input.arguments.prompt).toContain('http://box.lan:35457');
    expect(env.input.arguments.model).toBe('gpt-5.5-codex'); // included when requested
    expect(env.workspacePath).toBe('t2');                    // staged folder carried
  });

  it('honors an explicit node pick, and errors when that pick is not available', () => {
    hoisted.state.clients = [structuredClone(NODE_A), {
      ...structuredClone(NODE_A), clientId: 'node-b', tailnetHostname: 'render-box', agentId: 'agent-b',
    }];
    expect(dispatchBrowserTask({ taskId: 't3', userSub: OWNER, fromAgentId: 'b', prompt: 'x', preferredClientId: 'node-b' }).clientId).toBe('node-b');
    // A pinned node that isn't connected → clean no-worker error, not a wrong-node dispatch.
    const r = dispatchBrowserTask({ taskId: 't4', userSub: OWNER, fromAgentId: 'b', prompt: 'x', preferredClientId: 'node-ghost' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No online desktop worker/i);
  });

  it('treats a wedged (non-draining) worker as unavailable', () => {
    hoisted.state.clients = [{ ...structuredClone(NODE_A), taskQueueDepth: 2 }];
    const r = dispatchBrowserTask({ taskId: 't5', userSub: OWNER, fromAgentId: 'b', prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No online desktop worker/i);
    expect(hoisted.enqueued).toHaveLength(0);                // nothing dispatched onto a wedged box
  });

  it('returns a clean error (never throws) when no browser-capable node is connected', () => {
    hoisted.state.clients = [];
    const r = dispatchBrowserTask({ taskId: 't6', userSub: OWNER, fromAgentId: 'b', prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/box is not connected/i);
  });
});
