import { describe, expect, it } from 'vitest';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';
import { TicketService } from '../../src/features/ticketing/services/ticket-service';
import { QueueManagerService } from '../../src/features/swarm-orchestration/services/queue-manager-service';

interface FakeWorkItem {
  workItemId: string;
  externalId: string;
  status: string;
  executionOutput?: unknown;
  metadata?: Record<string, unknown>;
}

class FakeWorkItemRepository {
  readonly items: FakeWorkItem[] = [];

  add(item: FakeWorkItem): void {
    this.items.push(item);
  }

  async findByExternalIdAnyProvider(externalId: string): Promise<FakeWorkItem[]> {
    return this.items.filter((item) => item.externalId === externalId);
  }
}

describe('QueueManagerService work-item reconciliation', () => {
  it('marks stale child tickets complete from already-completed work items before parent assembly', async () => {
    const ticketService = new TicketService(new InMemoryTicketStore());
    const workItemRepository = new FakeWorkItemRepository();
    const queueManager = new QueueManagerService(
      ticketService,
      buildSwarmProcessingService(),
      buildPipelineDeps(workItemRepository),
    );

    const parent = await ticketService.createTicket({
      title: 'Parent build',
      description: 'Parent stuck after child execution.',
      status: 'in_process_build',
      metadata: {},
    });
    const child = await ticketService.createTicket({
      title: 'Child build',
      description: 'Child work already finished.',
      status: 'in_process_build',
      parentTicketId: parent.ticketId,
      metadata: {},
    });
    workItemRepository.add({
      workItemId: 'wi-child-complete',
      externalId: child.ticketId,
      status: 'completed',
      executionOutput: { content: 'done' },
    });

    await callSweepStaleParents(queueManager);

    await expect(ticketService.getTicket(child.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'complete' }),
    );
    await expect(ticketService.getTicket(parent.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'customer_action' }),
    );
  });

  it('keeps the parent escalated when one exhausted child sits beside completed siblings', async () => {
    const ticketService = new TicketService(new InMemoryTicketStore());
    const workItemRepository = new FakeWorkItemRepository();
    const queueManager = new QueueManagerService(
      ticketService,
      buildSwarmProcessingService(),
      buildPipelineDeps(workItemRepository),
    );

    const parent = await ticketService.createTicket({
      title: 'Parent build',
      description: 'Parent waiting on a routed child.',
      status: 'in_process_build',
      metadata: {},
    });
    const child = await ticketService.createTicket({
      title: 'Child build',
      description: 'Child routing exhausted.',
      status: 'in_process_build',
      parentTicketId: parent.ticketId,
      metadata: {},
    });
    const completedSibling = await ticketService.createTicket({
      title: 'Completed sibling',
      description: 'Another child already finished.',
      status: 'in_process_build',
      parentTicketId: parent.ticketId,
      metadata: {},
    });
    workItemRepository.add({
      workItemId: 'wi-child-routing-exhausted',
      externalId: child.ticketId,
      status: 'routing_failed',
      metadata: { routingRetryExhausted: true },
    });
    workItemRepository.add({
      workItemId: 'wi-completed-sibling',
      externalId: completedSibling.ticketId,
      status: 'completed',
      executionOutput: { content: 'done' },
    });

    await callSweepStaleParents(queueManager);

    await expect(ticketService.getTicket(child.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'escalated' }),
    );
    await expect(ticketService.getTicket(completedSibling.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'complete' }),
    );
    await expect(ticketService.getTicket(parent.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'escalated' }),
    );
  });
});

function buildSwarmProcessingService() {
  return {
    async getRuntimeReadiness() {
      return { ready: true };
    },
    async processTickets() {
      return { processedCount: 0, processed: [] };
    },
  } as never;
}

function buildPipelineDeps(workItemRepository: FakeWorkItemRepository) {
  return {
    taskFolderService: {},
    decompositionService: {},
    subtaskLifecycleService: {},
    workspaceService: {},
    workItemRepository,
  } as never;
}

async function callSweepStaleParents(queueManager: QueueManagerService): Promise<void> {
  await (queueManager as unknown as { sweepStaleParents(): Promise<void> }).sweepStaleParents();
}
