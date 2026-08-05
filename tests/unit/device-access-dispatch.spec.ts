/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for owner-scoped device
 *   dispatch. A registered leaf node is somebody's REAL desktop and work sent to it runs codex.exec at
 *   sandbox=danger-full-access against their logged-in browser. The 2026-07-09 ownership pass gated the
 *   HTTP surface but deliberately left "platform dispatchers" on machine trust, and those dispatchers
 *   picked nodes by LIVENESS ALONE. /api/apply-operator is requiresAuth (NOT operator-gated) and passes
 *   a request-body `targetRemoteClientId` straight through as the pin, so any signed-in user could
 *   name another user's node and execute on their machine — with the requester's résumé staged into
 *   that workspace. This locks the fix: selection is owner-scoped BEFORE the preference order, a
 *   foreign pin dispatches NOTHING, the picker never enumerates another user's box, and the operator +
 *   legacy-unowned compat paths (the live single-node setup) still work.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Await journal-backed browser dispatch so every ownership assertion observes the committed enqueue result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const enqueued: Array<{ clientId: string; env: Record<string, unknown> }> = [];
  const state = { clients: [] as Array<Record<string, unknown>> };
  return { enqueued, state };
});

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    listClients: () => hoisted.state.clients,
    enqueueTask: (clientId: string, env: Record<string, unknown>) => {
      hoisted.enqueued.push({ clientId, env });
      return { taskId: env.taskId };
    },
  },
  taskWorkspaceFolder: (id: string) => `/tmp/${id}`,
}));

import { dispatchBrowserTask } from '@/app/browser-task-dispatch';
import { listApplyWorkers } from '@/app/apply-queue-status';
import { canUseDevice } from '@/features/remote-client';

const ALICE = 'alice-sub-1111';
const BOB = 'bob-sub-2222';
const OPERATOR = 'operator-sub-9999';

/** A live, idle, screen-control-capable node — the shape pickApplyClient accepts. */
const node = (clientId: string, ownerSub?: string) => ({
  clientId,
  agentId: `agent-${clientId}`,
  tailnetHostname: `${clientId}-host`,
  status: 'online',
  healthy: true,
  capabilities: ['codex.exec'],
  taskQueueDepth: 0,
  controlPlaneUrl: 'http://box.lan:35457',
  ...(ownerSub ? { ownerSub } : {}),
});

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED', 'APPLY_EDGE_CLIENT_ID', 'APPLY_EDGE_HOSTNAME'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Fail-closed defaults: no operators, no legacy-unowned escape, no env pin.
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  delete process.env.OSHAL_ALLOW_LEGACY_UNOWNED;
  delete process.env.APPLY_EDGE_CLIENT_ID;
  process.env.APPLY_EDGE_HOSTNAME = 'nothing-matches-this';
  hoisted.enqueued.length = 0;
  hoisted.state.clients = [node('node-alice', ALICE), node('node-bob', BOB)];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('owner-scoped dispatch — a leaf node is somebody\'s real computer', () => {
  it('REFUSES to run Alice\'s task on Bob\'s machine even when she names it explicitly', async () => {
    // The exploit: /api/apply-operator/{submit,enqueue} take targetRemoteClientId from the REQUEST BODY
    // on a requiresAuth (not operator-gated) mount, and it became the dispatch pin unchecked.
    const r = await dispatchBrowserTask({
      taskId: 'apply-1', fromAgentId: 'career-bot', userSub: ALICE,
      prompt: 'drive the browser', preferredClientId: 'node-bob',
    });
    expect(r.ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);   // nothing reached Bob's desktop
  });

  it('auto-picks only Alice\'s OWN node, never falling through to Bob\'s', async () => {
    // With no pin the old order ended in "any online node" — which is how a foreign box got selected.
    const r = await dispatchBrowserTask({ taskId: 'apply-2', fromAgentId: 'career-bot', userSub: ALICE, prompt: 'x' });
    expect(r.ok).toBe(true);
    expect(r.clientId).toBe('node-alice');
    expect(hoisted.enqueued.map((e) => e.clientId)).toEqual(['node-alice']);
  });

  it('leaves Alice with NO worker when only Bob\'s machine is online (fails closed, not over)', async () => {
    hoisted.state.clients = [node('node-bob', BOB)];
    const r = await dispatchBrowserTask({ taskId: 'apply-3', fromAgentId: 'career-bot', userSub: ALICE, prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not connected/i);
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('does not even ENUMERATE another user\'s desktop in the target-computer picker', () => {
    // The picker returned every node's clientId — the exact value needed to pin dispatch at someone.
    const { workers, defaultClientId } = listApplyWorkers({ sub: ALICE });
    expect(workers.map((w) => w.clientId)).toEqual(['node-alice']);
    expect(defaultClientId).toBe('node-alice');
  });

  it('denies an UNATTRIBUTED dispatch (no userSub, not flagged system) rather than picking any box', async () => {
    const r = await dispatchBrowserTask({ taskId: 'apply-4', fromAgentId: 'career-bot', prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('still lets genuinely platform-originated work run (system flag)', async () => {
    const r = await dispatchBrowserTask({ taskId: 'sys-1', fromAgentId: 'scheduler', system: true, prompt: 'x' });
    expect(r.ok).toBe(true);
  });
});

describe('owner-scoped dispatch — the operator and legacy-unowned compat paths keep working', () => {
  it('lets an OPERATOR drive any node, and see the whole fleet', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
    expect((await dispatchBrowserTask({
      taskId: 'op-1', fromAgentId: 'career-bot', userSub: OPERATOR, prompt: 'x', preferredClientId: 'node-bob',
    })).ok).toBe(true);
    expect(listApplyWorkers({ sub: OPERATOR }).workers).toHaveLength(2);
  });

  it('an UNOWNED node is operator-only by default, and opens up under OSHAL_ALLOW_LEGACY_UNOWNED', async () => {
    // The live box registered before the owner binding shipped, so it carries ownerSub=null. The
    // deployment sets OSHAL_ALLOW_LEGACY_UNOWNED=true, which is what keeps that setup working.
    hoisted.state.clients = [node('node-legacy')];

    expect((await dispatchBrowserTask({ taskId: 'l-1', fromAgentId: 'b', userSub: ALICE, prompt: 'x' })).ok).toBe(false);

    process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
    expect((await dispatchBrowserTask({ taskId: 'l-2', fromAgentId: 'b', userSub: OPERATOR, prompt: 'x' })).ok).toBe(true);

    process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';
    expect((await dispatchBrowserTask({ taskId: 'l-3', fromAgentId: 'b', userSub: ALICE, prompt: 'x' })).ok).toBe(true);
  });
});

describe('canUseDevice — mirrors canAccessResource so HTTP and dispatch answer identically', () => {
  it('owner passes, foreign user denied, unowned fails closed, unknown requester denied', () => {
    expect(canUseDevice({ sub: ALICE }, { ownerSub: ALICE })).toBe(true);
    expect(canUseDevice({ sub: BOB }, { ownerSub: ALICE })).toBe(false);
    expect(canUseDevice({ sub: ALICE }, {})).toBe(false);             // unowned = operator-only
    expect(canUseDevice({}, { ownerSub: ALICE })).toBe(false);        // no identity, no access
    expect(canUseDevice({ system: true }, { ownerSub: ALICE })).toBe(true);
  });

  it('denies an unknown requester on an UNOWNED device even with the legacy flag on', async () => {
    // Regression: the unknown-requester check used to sit BELOW the unowned branch, so this exact
    // combination — no sub + unbound device + OSHAL_ALLOW_LEGACY_UNOWNED=true, which is the live
    // deployment — returned true and let unattributed work pick somebody's desktop. The original
    // guards missed it because they cleared the flag and asked about an OWNED device.
    process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';
    expect(canUseDevice({}, {})).toBe(false);
    expect(canUseDevice({ sub: null }, { clientId: 'node-legacy' })).toBe(false);
    // …while a real user still gets the documented legacy-compat behaviour on that same device.
    expect(canUseDevice({ sub: ALICE }, {})).toBe(true);

    hoisted.state.clients = [node('node-legacy')];
    expect((await dispatchBrowserTask({ taskId: 'u-1', fromAgentId: 'b', prompt: 'x' })).ok).toBe(false);
    expect(hoisted.enqueued).toHaveLength(0);
  });

  it('honours the operator allowlist by sub and by email', () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
    expect(canUseDevice({ sub: OPERATOR }, { ownerSub: ALICE })).toBe(true);
    delete process.env.OSHAL_OPERATOR_SUBS;
    process.env.OSHAL_OPERATOR_EMAILS = 'boss@example.com';
    expect(canUseDevice({ sub: 'x', email: 'BOSS@example.com' }, { ownerSub: ALICE })).toBe(true);
  });
});
