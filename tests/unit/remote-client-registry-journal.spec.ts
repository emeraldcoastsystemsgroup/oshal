/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard registry integration with the durable journal: startup fail-closed behavior, restart-safe ownership, one active claim, and first-terminal settlement.
 */

import { describe, expect, it } from 'vitest';
import {
  RemoteClientRegistryService,
  RemoteTaskJournalService,
} from '@/features/remote-client';
import { InMemoryRemoteTaskJournalFixture } from '../helpers/in-memory-remote-task-journal';

const registration = (ownerSub: string | undefined = 'owner-a') => ({
  clientId: 'durable-client-a',
  ownerSub,
  name: 'Durable client A',
  transport: 'http' as const,
  platform: 'windows' as const,
  controlPlaneUrl: 'http://controller.test',
  capabilities: ['mcp.call-tool'],
  tags: ['remote-client'],
});

const envelope = (taskId: string) => ({
  taskId,
  correlationId: `correlation-${taskId}`,
  fromAgentId: 'controller',
  toAgentId: 'durable-client-a',
  intent: 'mcp.call-tool' as const,
  input: { name: 'shell.exec', arguments: { command: taskId } },
  userSub: 'owner-a',
  createdAt: new Date().toISOString(),
});

async function registryOver(
  repository: InMemoryRemoteTaskJournalFixture,
): Promise<RemoteClientRegistryService> {
  const registry = new RemoteClientRegistryService();
  await registry.configureTaskJournal(new RemoteTaskJournalService(repository), async () => undefined);
  return registry;
}

describe('RemoteClientRegistryService journal readiness', () => {
  it('fails task mutation closed when no durable authority is configured', async () => {
    const registry = new RemoteClientRegistryService();
    await registry.register(registration());
    await expect(registry.enqueueTask('durable-client-a', envelope('task-not-ready')))
      .rejects.toMatchObject({ code: 'remote_task_journal_unavailable' });
  });
});

describe('RemoteClientRegistryService restart owner binding', () => {
  it('restores an omitted owner and refuses a different owner after process restart', async () => {
    const repository = new InMemoryRemoteTaskJournalFixture();
    const first = await registryOver(repository);
    await first.register(registration('owner-a'));

    const restarted = await registryOver(repository);
    const restored = await restarted.register(registration(undefined));
    expect(restored.ownerSub).toBe('owner-a');

    const hostileRestart = await registryOver(repository);
    await expect(hostileRestart.register(registration('owner-b'))).rejects.toMatchObject({
      code: 'remote_client_owner_conflict',
    });
  });
});

describe('RemoteClientRegistryService claim serialization', () => {
  it('returns one claim and never redelivers the active task to an overlapping poll', async () => {
    const registry = await registryOver(new InMemoryRemoteTaskJournalFixture());
    await registry.register(registration());
    await registry.enqueueTask('durable-client-a', envelope('task-one'));
    const [first, second] = await Promise.all([
      registry.claimNextTask('durable-client-a', 'owner-a'),
      registry.claimNextTask('durable-client-a', 'owner-a'),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first?.taskId ?? second?.taskId).toBe('task-one');
  });
});

describe('RemoteClientRegistryService first-terminal settlement', () => {
  it('preserves the first result and refuses a conflicting later terminal write', async () => {
    const registry = await registryOver(new InMemoryRemoteTaskJournalFixture());
    await registry.register(registration());
    const task = envelope('task-terminal');
    await registry.enqueueTask('durable-client-a', task);
    await registry.claimNextTask('durable-client-a', 'owner-a');
    const first = terminalResult(task.taskId, task.correlationId, { ok: true });
    await expect(registry.completeTask('durable-client-a', first)).resolves.toMatchObject({ output: { ok: true } });
    await expect(registry.failTask('durable-client-a', {
      ...first,
      status: 'failed',
      error: 'late failure',
    })).rejects.toThrow('Remote task settlement refused: conflict');
    await expect(registry.getCompletedResult('durable-client-a', task.taskId))
      .resolves.toMatchObject({ status: 'completed', output: { ok: true } });
  });
});

function terminalResult(taskId: string, correlationId: string, output: unknown) {
  return {
    taskId,
    correlationId,
    clientId: 'durable-client-a',
    status: 'completed' as const,
    output,
    completedAt: new Date().toISOString(),
  };
}
