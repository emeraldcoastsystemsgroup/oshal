/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the remote task-result landing loop: the sender must emit BOTH the targeted reply and the remoteTaskResult landing event with a guaranteed correlation id, and the controller-side handler must land completed/failed results on the first still-active work item (external_id = correlationId) via the canonical setExecutionOutput + updateStatus path — subtask-aware, ignoring foreign payload types, and no-oping safely with no match. Would go red if the result forward went back to being produced-but-never-consumed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  boundRemoteResultLanding,
  buildRemoteTaskResultEnvelopes,
  createRemoteTaskResultHandler,
  type RemoteTaskResultLandingRepository,
} from '@/app/routes/remote-client-task-results';
import { MESH_CHANNELS, type MeshEnvelope } from '@/features/agent-management';
import type { A2ATaskEnvelope, A2ATaskResult } from '@/shared/types';

function fakeRepo(items: Array<{ workItemId: string; status: string }>): RemoteTaskResultLandingRepository & {
  setExecutionOutput: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  findByExternalIdAnyProvider: ReturnType<typeof vi.fn>;
} {
  return {
    findByExternalIdAnyProvider: vi.fn(async () => items),
    setExecutionOutput: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
  };
}

function resultEnvelope(overrides: Partial<MeshEnvelope> = {}, payloadOverrides: Record<string, unknown> = {}): MeshEnvelope {
  return {
    correlationId: 'ticket-123',
    fromAgentId: 'edge-node-1',
    toAgentId: 'swarm-controller',
    channel: MESH_CHANNELS.remoteTaskResult,
    messageType: 'event',
    payload: {
      type: 'remote-client.task-result',
      taskId: 'task-9',
      intent: 'mcp.call-tool',
      correlationId: 'ticket-123',
      result: {
        taskId: 'task-9',
        correlationId: 'ticket-123',
        clientId: 'client-a',
        status: 'completed',
        output: { response: 'done' },
        completedAt: '2026-07-19T12:00:00.000Z',
      },
      ...payloadOverrides,
    },
    ...overrides,
  };
}

const sourceTask: A2ATaskEnvelope = {
  taskId: 'task-9',
  correlationId: 'ticket-123',
  fromAgentId: 'cb000000-0000-0000-0000-000000000001',
  toAgentId: 'edge-node-1',
  intent: 'mcp.call-tool',
  input: { name: 'codex.exec', arguments: {} },
  artifacts: [],
  createdAt: '2026-07-19T11:00:00.000Z',
  status: 'claimed',
};

const taskResult: A2ATaskResult = {
  taskId: 'task-9',
  correlationId: 'ticket-123',
  clientId: 'client-a',
  status: 'completed',
  output: { response: 'done' },
  artifacts: [],
  completedAt: '2026-07-19T12:00:00.000Z',
};

describe('buildRemoteTaskResultEnvelopes (the sender contract)', () => {
  it('emits the targeted requester reply AND the controller landing event', () => {
    const envelopes = buildRemoteTaskResultEnvelopes(sourceTask, taskResult);
    expect(envelopes).toHaveLength(2);

    const [reply, landing] = envelopes;
    expect(reply.channel).toBe(MESH_CHANNELS.agentDirect(sourceTask.fromAgentId));
    expect(reply.toAgentId).toBe(sourceTask.fromAgentId);
    expect(reply.messageType).toBe('reply');

    expect(landing.channel).toBe(MESH_CHANNELS.remoteTaskResult);
    expect(landing.messageType).toBe('event');

    for (const envelope of envelopes) {
      expect(envelope.correlationId).toBe('ticket-123');
      expect(envelope.fromAgentId).toBe('edge-node-1');
      expect(envelope.payload.type).toBe('remote-client.task-result');
      expect(envelope.payload.taskId).toBe('task-9');
      expect(envelope.payload.result).toEqual(taskResult);
    }
  });

  it('adds a correlation id at the sender when the source task lacks one', () => {
    const noCorrelation = { ...sourceTask, correlationId: '   ' } as A2ATaskEnvelope;
    const envelopes = buildRemoteTaskResultEnvelopes(noCorrelation, taskResult);
    expect(envelopes[0].correlationId).toBe('task-9'); // falls back to the taskId
    expect(envelopes[1].payload.correlationId).toBe('task-9');

    const blankEverything = { ...sourceTask, correlationId: '', taskId: '' } as A2ATaskEnvelope;
    const minted = buildRemoteTaskResultEnvelopes(blankEverything, taskResult);
    expect(minted[0].correlationId.length).toBeGreaterThan(0); // fresh UUID
    expect(minted[1].correlationId).toBe(minted[0].correlationId);
  });
});

describe('createRemoteTaskResultHandler (the controller-side landing)', () => {
  it('lands a completed result on the first active work item via setExecutionOutput + updateStatus', async () => {
    const repo = fakeRepo([
      { workItemId: 'wi-done', status: 'completed' }, // already terminal — must be skipped
      { workItemId: 'wi-live', status: 'executing' },
    ]);
    await createRemoteTaskResultHandler({ workItemRepository: repo })(resultEnvelope());

    expect(repo.findByExternalIdAnyProvider).toHaveBeenCalledWith('ticket-123');
    expect(repo.setExecutionOutput).toHaveBeenCalledTimes(1);
    const [workItemId, landed] = repo.setExecutionOutput.mock.calls[0] as [string, Record<string, unknown>];
    expect(workItemId).toBe('wi-live');
    expect(landed.source).toBe('remote-client');
    expect(landed.taskId).toBe('task-9');
    expect(landed.status).toBe('completed');
    expect(landed.output).toEqual({ response: 'done' });
    expect(repo.updateStatus).toHaveBeenCalledWith('wi-live', 'completed');
  });

  it('lands a failed result as failed with the node error', async () => {
    const repo = fakeRepo([{ workItemId: 'wi-1', status: 'assigned' }]);
    await createRemoteTaskResultHandler({ workItemRepository: repo })(resultEnvelope({}, {
      result: {
        taskId: 'task-9',
        correlationId: 'ticket-123',
        clientId: 'client-a',
        status: 'failed',
        error: 'CLI exploded',
        completedAt: '2026-07-19T12:00:00.000Z',
      },
    }));

    const [, landed] = repo.setExecutionOutput.mock.calls[0] as [string, Record<string, unknown>];
    expect(landed.status).toBe('failed');
    expect(landed.error).toBe('CLI exploded');
    expect(repo.updateStatus).toHaveBeenCalledWith('wi-1', 'failed');
  });

  it('is subtask-aware: a subtask-executing item lands as subtask-completed', async () => {
    const repo = fakeRepo([{ workItemId: 'wi-sub', status: 'subtask-executing' }]);
    await createRemoteTaskResultHandler({ workItemRepository: repo })(resultEnvelope());
    expect(repo.updateStatus).toHaveBeenCalledWith('wi-sub', 'subtask-completed');
  });

  it('ignores envelopes that are not remote-client.task-result payloads', async () => {
    const repo = fakeRepo([{ workItemId: 'wi-1', status: 'pending' }]);
    await createRemoteTaskResultHandler({ workItemRepository: repo })(resultEnvelope({}, { type: 'remote-client.presence' }));
    expect(repo.findByExternalIdAnyProvider).not.toHaveBeenCalled();
    expect(repo.setExecutionOutput).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('no-ops safely when no active work item matches the correlation id', async () => {
    const repo = fakeRepo([{ workItemId: 'wi-done', status: 'completed' }]);
    await createRemoteTaskResultHandler({ workItemRepository: repo })(resultEnvelope());
    expect(repo.setExecutionOutput).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('refuses to land without any correlation id (payload AND envelope blank)', async () => {
    const repo = fakeRepo([{ workItemId: 'wi-1', status: 'pending' }]);
    await createRemoteTaskResultHandler({ workItemRepository: repo })(
      resultEnvelope({ correlationId: '' }, { correlationId: undefined }),
    );
    expect(repo.findByExternalIdAnyProvider).not.toHaveBeenCalled();
  });

  it('falls back to the ENVELOPE correlation id when the payload omits one', async () => {
    const repo = fakeRepo([{ workItemId: 'wi-1', status: 'pending' }]);
    await createRemoteTaskResultHandler({ workItemRepository: repo })(
      resultEnvelope({ correlationId: 'ticket-777' }, { correlationId: undefined }),
    );
    expect(repo.findByExternalIdAnyProvider).toHaveBeenCalledWith('ticket-777');
  });

  it('swallows repository failures with a log instead of killing the subscription', async () => {
    const repo = fakeRepo([{ workItemId: 'wi-1', status: 'pending' }]);
    repo.setExecutionOutput.mockRejectedValueOnce(new Error('db down'));
    await expect(
      createRemoteTaskResultHandler({ workItemRepository: repo })(resultEnvelope()),
    ).resolves.toBeUndefined();
  });
});

describe('boundRemoteResultLanding (work_items bloat guard)', () => {
  it('passes reasonable payloads through untouched', () => {
    const landing = { source: 'remote-client', output: { response: 'small' } };
    expect(boundRemoteResultLanding(landing)).toBe(landing);
  });

  it('truncates an oversized output (e.g. a screenshot data URL) to a bounded marker', () => {
    const landing = {
      source: 'remote-client',
      status: 'completed',
      output: { dataUrl: 'x'.repeat(300_000) },
    };
    const bounded = boundRemoteResultLanding(landing);
    const output = bounded.output as Record<string, unknown>;
    expect(output.truncated).toBe(true);
    expect(String(output.head).length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(bounded).length).toBeLessThan(20_000);
    expect(bounded.status).toBe('completed'); // non-output fields survive
  });
});
