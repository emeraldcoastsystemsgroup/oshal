/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove protected inline SSE deferral, bounded refusal, nested/concurrent isolation and current subscriber authorization.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StreamManager, type SSEWritable } from '@/features/streaming/services/stream-manager';
import type { StreamEventType } from '@/shared/types';
import { ApprovalWorkflowService, APPROVAL_EVENTS } from '@/features/tool-approval';

let manager: StreamManager;
const clients: string[] = [];
beforeEach(() => { manager = new StreamManager(60_000); });
afterEach(() => { clients.splice(0).forEach(id => manager.unregisterClient(id)); });

function subscriber(taskId: string, authorize?: (taskId: string, eventType?: StreamEventType) => Promise<boolean>) {
  let body = '', ended = false;
  const response: SSEWritable = { headersSent: false, writeHead: vi.fn(),
    write: text => { body += text; return true; }, end: () => { ended = true; }, on: vi.fn() };
  const id = `client-${clients.length}`; clients.push(id);
  manager.registerClient(id, taskId, response, authorize);
  return { body: () => body, ended: () => ended };
}

function hold() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}

it('keeps a legitimate pending stream connected and delivers ordered events only after trusted completion', async () => {
  let completed = false;
  const authorize = vi.fn(async () => completed), client = subscriber('task', authorize), gate = hold();
  const turn = manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastTaskUpdate('task', { status: 'processing' });
    manager.broadcastMessage('task', { text: 'PRIVATE COMPLETED REPLY' });
    await gate.promise; completed = true; return 'completed';
  });
  expect(client.body()).not.toContain('processing'); expect(client.body()).not.toContain('PRIVATE');
  expect(authorize).not.toHaveBeenCalled(); expect(client.ended()).toBe(false);
  gate.release(); expect(await turn).toBe('completed');
  await vi.waitFor(() => expect(client.body()).toContain('PRIVATE COMPLETED REPLY'));
  expect(client.body().indexOf('processing')).toBeLessThan(client.body().indexOf('PRIVATE COMPLETED REPLY'));
  expect(client.ended()).toBe(false); expect(authorize).toHaveBeenCalledTimes(2);
});

it('discards unpublished processing, message and error events when the trusted completion boundary rejects', async () => {
  const client = subscriber('task', async () => true);
  await expect(manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastTaskUpdate('task', { status: 'processing' });
    manager.broadcastMessage('task', { text: 'PRIVATE FAILED OUTPUT' });
    manager.broadcastError('task', 'PRIVATE FAILURE'); throw new Error('completion refused');
  })).rejects.toThrow('completion refused');
  expect(client.body()).not.toContain('PRIVATE'); expect(client.body()).not.toContain('processing');
  expect(client.ended()).toBe(false);
});

it('rechecks each subscriber after completion and never flushes private output to a revoked viewer', async () => {
  let allowed = true;
  const owner = subscriber('task', async () => allowed), other = subscriber('task', async () => true), gate = hold();
  const turn = manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastMessage('task', { text: 'PRIVATE OWNER REPLY' }); await gate.promise; return 'completed';
  });
  allowed = false; gate.release(); await turn;
  await vi.waitFor(() => expect(owner.ended()).toBe(true));
  await vi.waitFor(() => expect(other.body()).toContain('PRIVATE OWNER REPLY'));
  expect(owner.body()).not.toContain('PRIVATE'); expect(other.ended()).toBe(false);
});

it('keeps unrelated concurrent task broadcasts independent while a protected turn remains pending', async () => {
  const pending = subscriber('pending', async () => true), unrelated = subscriber('other', async () => true), gate = hold();
  const turn = manager.withDeferredTaskEvents('pending', async () => {
    manager.broadcastMessage('pending', { text: 'PENDING PRIVATE' }); await gate.promise;
  });
  manager.broadcastMessage('other', { text: 'OTHER VISIBLE' });
  await vi.waitFor(() => expect(unrelated.body()).toContain('OTHER VISIBLE'));
  expect(pending.body()).not.toContain('PENDING PRIVATE');
  gate.release(); await turn;
  await vi.waitFor(() => expect(pending.body()).toContain('PENDING PRIVATE'));
  expect(unrelated.body()).not.toContain('PENDING PRIVATE');
});

it('isolates simultaneous deferred turns and permits each task to publish only after its own boundary', async () => {
  const first = subscriber('first'), second = subscriber('second'), gate = hold();
  const pending = manager.withDeferredTaskEvents('first', async () => {
    manager.broadcastMessage('first', { text: 'FIRST PRIVATE' }); await gate.promise;
  });
  await manager.withDeferredTaskEvents('second', async () => {
    manager.broadcastMessage('second', { text: 'SECOND COMPLETED' });
    expect(second.body()).not.toContain('SECOND COMPLETED');
  });
  expect(second.body()).toContain('SECOND COMPLETED'); expect(first.body()).not.toContain('FIRST PRIVATE');
  gate.release(); await pending;
  expect(first.body()).toContain('FIRST PRIVATE'); expect(first.body()).not.toContain('SECOND COMPLETED');
});

it('retains ancestor deferral for broadcasts inside a nested scope for a different task', async () => {
  const outer = subscriber('outer'), inner = subscriber('inner'), gate = hold();
  const turn = manager.withDeferredTaskEvents('outer', async () => {
    manager.broadcastMessage('outer', { text: 'OUTER FIRST' });
    await manager.withDeferredTaskEvents('inner', async () => {
      manager.broadcastMessage('outer', { text: 'OUTER SECOND' });
      manager.broadcastMessage('inner', { text: 'INNER COMPLETED' });
    });
    expect(outer.body()).not.toContain('OUTER'); expect(inner.body()).toContain('INNER COMPLETED');
    await gate.promise;
  });
  gate.release(); await turn;
  expect(outer.body().indexOf('OUTER FIRST')).toBeLessThan(outer.body().indexOf('OUTER SECOND'));
});

it('does not publish nested same-task events if the outer durable boundary fails', async () => {
  const client = subscriber('task');
  await expect(manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastMessage('task', { text: 'PRIVATE OUTER' });
    await manager.withDeferredTaskEvents('task', async () => { manager.broadcastMessage('task', { text: 'PRIVATE INNER' }); });
    expect(client.body()).not.toContain('PRIVATE'); throw new Error('outer completion refused');
  })).rejects.toThrow('outer completion refused');
  expect(client.body()).not.toContain('PRIVATE');
});

it('keeps independent stream manager instances outside another instance deferred scope', async () => {
  const client = subscriber('task'), independent = new StreamManager(60_000);
  const broadcast = vi.spyOn(independent, 'broadcast');
  await manager.withDeferredTaskEvents('task', async () => {
    independent.broadcastMessage('task', { text: 'OTHER INSTANCE' });
    manager.broadcastMessage('task', { text: 'THIS INSTANCE' });
    expect(broadcast).toHaveBeenCalled(); expect(client.body()).not.toContain('THIS INSTANCE');
  });
  expect(client.body()).toContain('THIS INSTANCE'); expect(client.body()).not.toContain('OTHER INSTANCE');
});

it('refuses more than128 deferred events even when the overflow error is swallowed by the turn', async () => {
  const client = subscriber('task');
  await expect(manager.withDeferredTaskEvents('task', async () => {
    for (let index = 0; index < 128; index++) manager.broadcastMessage('task', { text: `PRIVATE${index}` });
    expect(() => manager.broadcastMessage('task', { text: 'PRIVATE OVERFLOW' })).toThrow('deferred_task_stream_unavailable');
    return 'success must not publish the prefix';
  })).rejects.toThrow('deferred_task_stream_unavailable');
  expect(client.body()).not.toContain('PRIVATE'); expect(client.ended()).toBe(false);
});

it('publishes the accepted128-event boundary through the existing subscriber policy queue', async () => {
  const client = subscriber('task', async () => true);
  await manager.withDeferredTaskEvents('task', async () => {
    for (let index = 0; index < 128; index++) manager.broadcastMessage('task', { text: `ACCEPTED-${index}` });
  });
  await vi.waitFor(() => expect(client.body()).toContain('ACCEPTED-127'));
  expect(client.ended()).toBe(false);
  expect((client.body().match(/ACCEPTED-/g) ?? []).length).toBe(128);
});

it('refuses more than1MiB before any unpublished prefix can reach subscribers', async () => {
  const client = subscriber('task');
  await expect(manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastMessage('task', { text: 'PRIVATE PREFIX' });
    manager.broadcastMessage('task', { text: 'x'.repeat(1_048_576) });
  })).rejects.toThrow('deferred_task_stream_unavailable');
  expect(client.body()).not.toContain('PRIVATE PREFIX');
});

it('captures serialized event values before later caller mutation can alter released output', async () => {
  const client = subscriber('task'), message = { text: 'ORIGINAL REPLY' };
  await manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastMessage('task', message); message.text = 'MUTATED PRIVATE TEXT';
  });
  expect(client.body()).toContain('ORIGINAL REPLY'); expect(client.body()).not.toContain('MUTATED PRIVATE TEXT');
});

it('never publishes a deferred prefix when an unserializable event failure is swallowed', async () => {
  const client = subscriber('task'), circular: Record<string, unknown> = {}; circular.self = circular;
  await expect(manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastMessage('task', { text: 'PRIVATE PREFIX' });
    expect(() => manager.broadcastMessage('task', circular)).toThrow('deferred_task_stream_unavailable');
  })).rejects.toThrow('deferred_task_stream_unavailable');
  expect(client.body()).not.toContain('PRIVATE');
});

it('refuses late async events from a closed protected scope instead of bypassing its completed boundary', async () => {
  const client = subscriber('task'); let late!: () => void;
  await manager.withDeferredTaskEvents('task', async () => {
    const { AsyncResource } = await import('node:async_hooks');
    const resource = new AsyncResource('inline-late-fixture');
    late = () => resource.runInAsyncScope(() => manager.broadcastMessage('task', { text: 'LATE PRIVATE OUTPUT' }));
  });
  expect(late).toThrow('deferred_task_stream_unavailable'); expect(client.body()).not.toContain('LATE PRIVATE OUTPUT');
});

it.each(Object.values(APPROVAL_EVENTS))('allows only authorized %s control to reach a pending turn viewer', async eventType => {
  const authorize = vi.fn(async (_taskId: string, type?: StreamEventType) => type === eventType);
  const client = subscriber('task', authorize), gate = hold();
  const turn = manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastMessage('task', { text: 'PRIVATE PENDING RESULT' });
    manager.broadcast('task', eventType, { requestId: 'bounded-control', toolName: 'fixture-tool' });
    await gate.promise;
  });
  await vi.waitFor(() => expect(client.body()).toContain('bounded-control'));
  expect(authorize).toHaveBeenCalledWith('task', eventType);
  expect(client.body()).not.toContain('PRIVATE PENDING RESULT');
  gate.release(); await turn;
  await vi.waitFor(() => expect(client.ended()).toBe(true));
  expect(client.body()).not.toContain('PRIVATE PENDING RESULT');
});

it('does not disclose pending control to an ungated or denied legacy subscriber', async () => {
  const ungated = subscriber('task'), denied = subscriber('task', async () => false), gate = hold();
  const turn = manager.withDeferredTaskEvents('task', async () => {
    manager.broadcast('task', APPROVAL_EVENTS.REQUEST, { requestId: 'PRIVATE CONTROL' }); await gate.promise;
  });
  await vi.waitFor(() => expect(denied.ended()).toBe(true));
  expect(denied.body()).not.toContain('PRIVATE CONTROL'); expect(ungated.body()).not.toContain('PRIVATE CONTROL');
  manager.broadcast('task', APPROVAL_EVENTS.RESPONSE, { requestId: 'PRIVATE CONTROL OUTSIDE SCOPE' });
  expect(ungated.body()).not.toContain('PRIVATE CONTROL OUTSIDE SCOPE');
  gate.release(); await turn;
});

it('keeps other event types buffered even when the viewer may currently receive approval controls', async () => {
  const client = subscriber('task', async () => true), gate = hold();
  const turn = manager.withDeferredTaskEvents('task', async () => {
    manager.broadcastToolExecution('task', { name: 'PRIVATE TOOL' }, 'running');
    manager.broadcastCompletion('task', { response: 'PRIVATE RESULT' });
    manager.broadcastStreamChunk('task', 'PRIVATE CHUNK');
    manager.broadcast('task', 'tool:approval:unknown' as StreamEventType, { text: 'PRIVATE UNKNOWN' });
    await gate.promise;
  });
  expect(client.body()).not.toContain('PRIVATE'); gate.release(); await turn;
  await vi.waitFor(() => expect(client.body()).toContain('PRIVATE UNKNOWN'));
});

it('completes an actual pending approval before the result boundary without timing out or releasing output', async () => {
  let completed = false;
  const client = subscriber('task', async (_task, type) => completed || type === APPROVAL_EVENTS.REQUEST || type === APPROVAL_EVENTS.RESPONSE);
  const workflow = new ApprovalWorkflowService({ streamManager: manager });
  const turn = manager.withDeferredTaskEvents('task', async () => {
    const decision = await workflow.requestApproval({ taskId: 'task', agentId: 'agent', toolId: 'tool', toolName: 'fixture-tool',
      toolInput: { bounded: true }, timeoutMs: 10_000 });
    expect(decision.approved).toBe(true);
    manager.broadcastMessage('task', { text: 'PRIVATE AUTHORIZED REPLY' }); completed = true;
  });
  try {
    await vi.waitFor(() => expect(client.body()).toContain(APPROVAL_EVENTS.REQUEST));
    const payload = client.body().split('\n').find(line => line.startsWith('data: ') && line.includes('requestId'))!;
    const request = JSON.parse(payload.slice(6)) as { requestId: string };
    expect(client.body()).not.toContain('PRIVATE AUTHORIZED REPLY');
    expect(workflow.resolveApproval({ requestId: request.requestId, approved: true, decidedBy: 'fixture-user' })).toBe(true);
    await turn;
    await vi.waitFor(() => expect(client.body()).toContain('PRIVATE AUTHORIZED REPLY'));
    expect(client.ended()).toBe(false);
  } finally { workflow.cancelAll(); }
});
