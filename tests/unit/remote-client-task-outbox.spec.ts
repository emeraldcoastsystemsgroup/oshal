/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard settlement reconstruction, outboxId propagation, cost dedupe invocation, and fail-closed partial publication for the production remote-task outbox publisher.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require strict work-item persistence before mesh notification and assert the durable outboxId is stored as the landing idempotency receipt.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Assert settlement publication fails before cost or mesh effects when its strict work-item repository is absent.
 */

import { describe, expect, it, vi } from 'vitest';
import { createRemoteTaskOutboxPublisher } from '@/app/routes/remote-client-task-operations';
import type { RemoteTaskOutboxRecord } from '@/features/remote-client';

const sourceTask = {
  taskId: 'task-outbox',
  correlationId: 'ticket-outbox',
  fromAgentId: 'accountable-agent',
  toAgentId: 'remote-agent',
  intent: 'mcp.call-tool' as const,
  input: { name: 'codex.exec', arguments: { model: 'gpt-5' } },
  userSub: 'owner-a',
  artifacts: [],
  status: 'queued' as const,
  createdAt: '2026-08-05T12:00:00.000Z',
};

const result = {
  taskId: sourceTask.taskId,
  correlationId: sourceTask.correlationId,
  clientId: 'client-a',
  status: 'completed' as const,
  output: {
    usage: { inputTokens: 10, outputTokens: 5 },
    cost: 0.5,
    provider: 'openai-codex',
  },
  artifacts: [],
  completedAt: '2026-08-05T12:01:00.000Z',
};

function settlementRecord(): RemoteTaskOutboxRecord {
  return {
    outboxId: '11111111-1111-4111-8111-111111111111',
    taskId: sourceTask.taskId,
    clientId: 'client-a',
    ownerSub: 'owner-a',
    eventId: 2,
    topic: 'remote-task.settlement',
    payload: { version: 1, envelope: sourceTask, result },
    createdAt: '2026-08-05T12:01:00.000Z',
    deliveredAt: null,
  };
}

/** @description Configured direct-enqueuer landing boundary with no originating work item. */
function noMatchingWorkItems() {
  return {
    findByExternalIdAnyProvider: vi.fn(async () => []),
    setExecutionOutput: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
  };
}

describe('remote task settlement outbox publisher', () => {
  it('passes outboxId to atomic cost recording and every mesh result envelope', async () => {
    const send = vi.fn(async () => undefined);
    const recordCostOnce = vi.fn(async () => true);
    let executionOutput: unknown;
    const updateStatus = vi.fn(async () => undefined);
    const publish = createRemoteTaskOutboxPublisher({
      meshCommunicationService: { send } as never,
      recordCostOnce,
      workItemRepository: {
        findByExternalIdAnyProvider: vi.fn(async () => [{ workItemId: 'work-1', status: 'executing' }]),
        setExecutionOutput: vi.fn(async (_id: string, output: unknown) => { executionOutput = output; }),
        updateStatus,
      },
    });
    const record = settlementRecord();
    await publish(record);

    expect(recordCostOnce).toHaveBeenCalledWith(record.outboxId, expect.objectContaining({
      taskId: 'ticket-outbox::accountable-agent',
      ownerSub: 'owner-a',
      totalCost: 0.5,
    }));
    expect(executionOutput).toMatchObject({ outboxId: record.outboxId, taskId: sourceTask.taskId });
    expect(updateStatus).toHaveBeenCalledWith('work-1', 'completed');
    expect(send).toHaveBeenCalledTimes(2);
    for (const [envelope] of send.mock.calls) {
      expect(envelope.payload).toMatchObject({ outboxId: record.outboxId, taskId: sourceTask.taskId });
    }
  });

  it('does not publish mesh effects or acknowledge success after a cost failure', async () => {
    const send = vi.fn(async () => undefined);
    const publish = createRemoteTaskOutboxPublisher({
      meshCommunicationService: { send } as never,
      recordCostOnce: vi.fn(async () => { throw new Error('cost transaction failed'); }),
      workItemRepository: noMatchingWorkItems(),
    });
    await expect(publish(settlementRecord())).rejects.toThrow('cost transaction failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed before cost or mesh when strict landing is unconfigured', async () => {
    const send = vi.fn(async () => undefined);
    const recordCostOnce = vi.fn(async () => true);
    const publish = createRemoteTaskOutboxPublisher({
      meshCommunicationService: { send } as never,
      recordCostOnce,
    });
    await expect(publish(settlementRecord())).rejects.toThrow('landing repository is not configured');
    expect(recordCostOnce).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('remote task dispatch outbox publisher', () => {
  it('acknowledges dispatch without invoking settlement side effects', async () => {
    const recordCostOnce = vi.fn(async () => true);
    const send = vi.fn(async () => undefined);
    const publish = createRemoteTaskOutboxPublisher({
      meshCommunicationService: { send } as never,
      recordCostOnce,
    });
    await publish({ ...settlementRecord(), topic: 'remote-task.dispatch' });
    expect(recordCostOnce).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
