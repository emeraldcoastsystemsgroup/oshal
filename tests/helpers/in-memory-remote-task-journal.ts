/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add an explicit test-only RemoteTaskJournalRepository for registry and route contract tests; production code never imports or falls back to this process-memory fixture.
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  BindRemoteClientOwnerInput,
  BindRemoteClientOwnerOutcome,
  ClaimRemoteTaskInput,
  ClaimRemoteTaskOutcome,
  DurableRemoteTaskRecord,
  EnqueueRemoteTaskInput,
  EnqueueRemoteTaskOutcome,
  RemoteTaskJournalEvent,
  RemoteTaskJournalRepository,
  RemoteTaskOutboxPublisher,
  SettleRemoteTaskInput,
  SettleRemoteTaskOutcome,
  TransitionRemoteClientOwnerInput,
  TransitionRemoteClientOwnerOutcome,
} from '@/features/remote-client';

/** @description Explicit process-memory fixture used only from test modules. */
export class InMemoryRemoteTaskJournalFixture implements RemoteTaskJournalRepository {
  readonly owners = new Map<string, string | null>();
  readonly tasks = new Map<string, DurableRemoteTaskRecord>();

  async initialize(): Promise<void> {}

  async bindClientOwner(input: BindRemoteClientOwnerInput): Promise<BindRemoteClientOwnerOutcome> {
    if (!this.owners.has(input.clientId)) {
      const ownerSub = input.assertedOwnerSub ?? null;
      this.owners.set(input.clientId, ownerSub);
      return { kind: 'bound', ownerSub };
    }
    const ownerSub = this.owners.get(input.clientId) ?? null;
    const matches = input.assertedOwnerSub === undefined || input.assertedOwnerSub === ownerSub;
    return { kind: matches ? 'already_bound' : 'conflict', ownerSub };
  }

  async transitionClientOwner(
    input: TransitionRemoteClientOwnerInput,
  ): Promise<TransitionRemoteClientOwnerOutcome> {
    if (!this.owners.has(input.clientId)) return { kind: 'not_found', ownerSub: null };
    const ownerSub = this.owners.get(input.clientId) ?? null;
    if (ownerSub !== input.expectedOwnerSub) return { kind: 'conflict', ownerSub };
    if (ownerSub === input.nextOwnerSub) return { kind: 'unchanged', ownerSub };
    const busy = [...this.tasks.values()].some((task) => (
      task.clientId === input.clientId && (task.status === 'queued' || task.status === 'claimed')
    ));
    if (busy) return { kind: 'tasks_active', ownerSub };
    this.owners.set(input.clientId, input.nextOwnerSub);
    return { kind: 'updated', ownerSub: input.nextOwnerSub };
  }

  async enqueue(input: EnqueueRemoteTaskInput): Promise<EnqueueRemoteTaskOutcome> {
    const existing = this.tasks.get(input.task.taskId);
    if (existing) {
      const same = existing.clientId === input.clientId
        && existing.ownerSub === input.ownerSub
        && isDeepStrictEqual(existing.envelope, input.task);
      return { kind: same ? 'already_exists' : 'conflict', task: cloneTask(existing) };
    }
    const now = new Date().toISOString();
    const task: DurableRemoteTaskRecord = {
      taskId: input.task.taskId,
      clientId: input.clientId,
      ownerSub: input.ownerSub,
      correlationId: input.task.correlationId,
      envelope: structuredClone(input.task),
      status: 'queued',
      claimedByClientId: null,
      claimedAt: null,
      settledAt: null,
      terminalResult: null,
      tombstoneExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    return { kind: 'enqueued', task: cloneTask(task) };
  }

  async claimNext(input: ClaimRemoteTaskInput): Promise<ClaimRemoteTaskOutcome> {
    const active = [...this.tasks.values()].find((task) => matchesClaim(task, input, 'claimed'));
    if (active) return { kind: 'client_busy', task: cloneTask(active) };
    const queued = [...this.tasks.values()].find((task) => matchesClaim(task, input, 'queued'));
    if (!queued) return { kind: 'empty', task: null };
    queued.status = 'claimed';
    queued.claimedByClientId = input.clientId;
    queued.claimedAt = new Date().toISOString();
    queued.updatedAt = queued.claimedAt;
    return { kind: 'claimed', task: cloneTask(queued) };
  }

  async settle(input: SettleRemoteTaskInput): Promise<SettleRemoteTaskOutcome> {
    const task = this.tasks.get(input.result.taskId);
    if (!task) return { kind: 'not_found', task: null };
    if (task.correlationId !== input.result.correlationId) return { kind: 'conflict', task: cloneTask(task) };
    if (task.terminalResult) {
      const same = isDeepStrictEqual(task.terminalResult, input.result);
      return { kind: same ? 'already_settled' : 'conflict', task: cloneTask(task) };
    }
    if (task.status !== 'claimed') return { kind: 'not_claimed', task: cloneTask(task) };
    if (task.clientId !== input.clientId) return { kind: 'wrong_client', task: cloneTask(task) };
    const now = new Date().toISOString();
    task.status = input.result.status;
    task.terminalResult = structuredClone(input.result);
    task.settledAt = now;
    task.updatedAt = now;
    task.tombstoneExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    return { kind: 'settled', task: cloneTask(task) };
  }

  async getTask(taskId: string): Promise<DurableRemoteTaskRecord | null> {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : null;
  }

  async listEvents(_taskId: string): Promise<RemoteTaskJournalEvent[]> {
    return [];
  }

  async deliverNextOutbox(_publish: RemoteTaskOutboxPublisher): Promise<boolean> {
    return false;
  }

  async purgeExpiredTombstones(_limit?: number): Promise<number> {
    return 0;
  }
}

/** @description Matches both fixed client and expected owner for the requested state. */
function matchesClaim(
  task: DurableRemoteTaskRecord,
  input: ClaimRemoteTaskInput,
  status: 'queued' | 'claimed',
): boolean {
  return task.clientId === input.clientId
    && task.ownerSub === input.expectedOwnerSub
    && task.status === status;
}

/** @description Prevents test callers from mutating fixture authority through return values. */
function cloneTask(task: DurableRemoteTaskRecord): DurableRemoteTaskRecord {
  return structuredClone(task);
}
