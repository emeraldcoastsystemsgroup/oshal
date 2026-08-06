/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard validated service inputs and prove startup recovery runs as trusted system work, drains only pending outbox rows, and performs retention cleanup afterward.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard queued-state normalization and owner/user attribution consistency at the service boundary.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Split startup and validation groups so each describe callback remains below 50 physical lines.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Cover owner-aware claim normalization and satisfy the durable registration/reassignment repository boundary.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Assert omitted task attribution is stamped from the authoritative durable owner before persistence.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Prove concurrent replay callers join one service-level pass, bounding shared-pool journal connections while publishers perform nested writes.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Prove durable owner identities retain exact case/whitespace while client identifiers keep normalization and whitespace-only owner values still fail closed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  RemoteTaskJournalService,
  type RemoteTaskJournalRepository,
  type RemoteTaskOutboxRecord,
} from '@/features/remote-client';
import { getRequestIdentity, isSystemIdentity } from '@/shared/services/database/request-identity';

const envelope = {
  taskId: 'task-startup',
  correlationId: 'correlation-startup',
  fromAgentId: 'controller',
  toAgentId: 'agent-a',
  intent: 'status.sync' as const,
  createdAt: '2026-08-05T12:00:00.000Z',
};

function outbox(outboxId: string): RemoteTaskOutboxRecord {
  return {
    outboxId,
    taskId: 'task-startup',
    clientId: 'client-a',
    ownerSub: 'user-a',
    eventId: 1,
    topic: 'remote-task.dispatch',
    payload: { taskId: 'task-startup' },
    createdAt: '2026-08-05T12:00:00.000Z',
    deliveredAt: null,
  };
}

function startupRepository(pendingRows: RemoteTaskOutboxRecord[]) {
  const pending = [...pendingRows];
  const systemChecks: boolean[] = [];
  const repository: RemoteTaskJournalRepository = {
    initialize: vi.fn(async () => { systemChecks.push(isSystemIdentity(getRequestIdentity())); }),
    enqueue: vi.fn(async () => { throw new Error('not used'); }),
    bindClientOwner: vi.fn(async () => { throw new Error('not used'); }),
    transitionClientOwner: vi.fn(async () => { throw new Error('not used'); }),
    claimNext: vi.fn(async () => { throw new Error('not used'); }),
    settle: vi.fn(async () => { throw new Error('not used'); }),
    getTask: vi.fn(async () => null),
    listEvents: vi.fn(async () => []),
    deliverNextOutbox: vi.fn(async (publish) => {
      systemChecks.push(isSystemIdentity(getRequestIdentity()));
      const row = pending.shift();
      if (!row) return false;
      await publish(row);
      return true;
    }),
    purgeExpiredTombstones: vi.fn(async () => {
      systemChecks.push(isSystemIdentity(getRequestIdentity()));
      return 3;
    }),
  };
  return { repository, systemChecks };
}

describe('RemoteTaskJournalService startup', () => {
  it('replays pending rows under system identity before tombstone cleanup', async () => {
    const fixture = startupRepository([outbox('11111111-1111-4111-8111-111111111111'), outbox('22222222-2222-4222-8222-222222222222')]);
    const published: string[] = [];
    const service = new RemoteTaskJournalService(fixture.repository);
    const result = await service.start(async (record) => { published.push(record.outboxId); });

    expect(result).toEqual({ replayedOutboxRows: 2, purgedTombstones: 3 });
    expect(published).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    expect(fixture.systemChecks.every(Boolean)).toBe(true);
    expect(fixture.repository.purgeExpiredTombstones).toHaveBeenCalledAfter(
      fixture.repository.deliverNextOutbox as ReturnType<typeof vi.fn>,
    );
  });

  it('validates an envelope before invoking durable persistence', async () => {
    const repository = startupRepository([]).repository;
    const service = new RemoteTaskJournalService(repository);
    await expect(service.enqueue('client-a', 'user-a', { taskId: 'missing-contract-fields' })).rejects.toThrow();
    expect(repository.enqueue).not.toHaveBeenCalled();
  });
});

describe('RemoteTaskJournalService replay serialization', () => {
  it('joins concurrent callers onto one repository delivery pass', async () => {
    const repository = startupRepository([]).repository;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(repository.deliverNextOutbox).mockImplementation(async () => {
      await blocked;
      return false;
    });
    const service = new RemoteTaskJournalService(repository);
    const first = service.replayPendingOutbox(async () => undefined);
    const second = service.replayPendingOutbox(async () => undefined);
    expect(repository.deliverNextOutbox).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    expect(repository.deliverNextOutbox).toHaveBeenCalledTimes(1);
  });
});

describe('RemoteTaskJournalService validation', () => {
  it('normalizes the client identifier but preserves the exact owner identity before enqueue', async () => {
    const repository = startupRepository([]).repository;
    vi.mocked(repository.enqueue).mockResolvedValue({
      kind: 'enqueued',
      task: {
        taskId: envelope.taskId, clientId: 'client-a', ownerSub: 'user-a',
        correlationId: envelope.correlationId, envelope: { ...envelope, input: {}, artifacts: [], status: 'queued' },
        status: 'queued', claimedByClientId: null, claimedAt: null, settledAt: null,
        terminalResult: null, tombstoneExpiresAt: null,
        createdAt: envelope.createdAt, updatedAt: envelope.createdAt,
      },
    });
    const service = new RemoteTaskJournalService(repository);
    await service.enqueue(' client-a ', ' User-A ', { ...envelope, status: 'completed' });
    expect(repository.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client-a', ownerSub: ' User-A ',
      task: expect.objectContaining({ status: 'queued', userSub: ' User-A ' }),
    }));
  });

  it('rejects a user assertion that disagrees with the persisted owner', async () => {
    const repository = startupRepository([]).repository;
    const service = new RemoteTaskJournalService(repository);
    await expect(service.enqueue('client-a', 'user-a', { ...envelope, userSub: 'user-b' }))
      .rejects.toThrow('Task userSub must match the durable ownerSub');
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only identities before touching the repository', async () => {
    const repository = startupRepository([]).repository;
    const service = new RemoteTaskJournalService(repository);
    await expect(service.claimNext('   ', 'user-a')).rejects.toThrow('clientId must be a non-empty string');
    await expect(service.claimNext('client-a', '   ')).rejects.toThrow('expectedOwnerSub must be a non-empty string');
    expect(repository.claimNext).not.toHaveBeenCalled();
  });
});
