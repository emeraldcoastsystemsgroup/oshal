import { describe, expect, it, afterEach } from 'vitest';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';
import { TicketService } from '../../src/features/ticketing/services/ticket-service';
import { QueueManagerService } from '../../src/features/swarm-orchestration/services/queue-manager-service';
import { WorkflowPipelineRegistry } from '../../src/features/swarm-orchestration/services/workflow-pipeline-registry';

/**
 * The auto-start sweep (queue-manager) promotes backlog tickets of an auto-start workflow to
 * 'approved' so a published auto-start workflow runs on arrival, while leaving manual workflows
 * (and unrelated tickets) in backlog for operator approval.
 */

const registry = WorkflowPipelineRegistry.getInstance();

function buildSwarmProcessingService() {
  return {
    async getRuntimeReadiness() { return { ready: true }; },
    async processTickets() { return { processedCount: 0, processed: [] }; },
  } as never;
}

async function callSweep(qm: QueueManagerService): Promise<void> {
  await (qm as unknown as { sweepAutoStartTickets(): Promise<void> }).sweepAutoStartTickets();
}

afterEach(() => {
  registry.unregisterApp('autostart-test');
});

describe('queue-manager auto-start sweep', () => {
  it('promotes backlog tickets of an auto-start workflow to approved, leaving manual + unrelated ones', async () => {
    registry.registerFromApp('autostart-test', { ticketType: 'auto-flow', name: 'Auto', pipeline: 'graph', workerBot: 'code-developer', autoStart: true });
    registry.registerFromApp('autostart-test', { ticketType: 'manual-flow', name: 'Manual', pipeline: 'graph', workerBot: 'code-developer' });

    const ticketService = new TicketService(new InMemoryTicketStore());
    const auto1 = await ticketService.createTicket({ title: 'Auto 1', ticketType: 'auto-flow', status: 'backlog', metadata: {} });
    const auto2 = await ticketService.createTicket({ title: 'Auto 2', ticketType: 'auto-flow', status: 'backlog', metadata: {} });
    const manual = await ticketService.createTicket({ title: 'Manual', ticketType: 'manual-flow', status: 'backlog', metadata: {} });
    const unrelated = await ticketService.createTicket({ title: 'Other', ticketType: 'some-other-type', status: 'backlog', metadata: {} });

    const qm = new QueueManagerService(ticketService, buildSwarmProcessingService());
    await callSweep(qm);

    expect((await ticketService.getTicket(auto1.ticketId))?.status).toBe('approved');
    expect((await ticketService.getTicket(auto2.ticketId))?.status).toBe('approved');
    expect((await ticketService.getTicket(manual.ticketId))?.status).toBe('backlog');
    expect((await ticketService.getTicket(unrelated.ticketId))?.status).toBe('backlog');
  });

  it('keeps a GitHub request-only ticket in backlog when its ticket type auto-starts', async () => {
    registry.registerFromApp('autostart-test', { ticketType: 'auto-flow', name: 'Auto', pipeline: 'graph', workerBot: 'code-developer', autoStart: true });

    const ticketService = new TicketService(new InMemoryTicketStore());
    const requestOnly = await ticketService.createTicket({
      title: 'GitHub request',
      ticketType: 'auto-flow',
      status: 'backlog',
      metadata: {
        githubTicket: {
          requestMode: 'request-only',
          issueRepository: 'emeraldcoastsystemsgroup/open-shal',
        },
      },
    });
    const ordinary = await ticketService.createTicket({
      title: 'Ordinary auto-start ticket',
      ticketType: 'auto-flow',
      status: 'backlog',
      metadata: {},
    });

    const qm = new QueueManagerService(ticketService, buildSwarmProcessingService());
    await callSweep(qm);

    expect((await ticketService.getTicket(requestOnly.ticketId))?.status).toBe('backlog');
    expect((await ticketService.getTicket(ordinary.ticketId))?.status).toBe('approved');
  });

  it('is a no-op (and touches nothing) when no auto-start workflow is registered', async () => {
    const ticketService = new TicketService(new InMemoryTicketStore());
    const t = await ticketService.createTicket({ title: 'Plain', ticketType: 'manual-flow', status: 'backlog', metadata: {} });

    const qm = new QueueManagerService(ticketService, buildSwarmProcessingService());
    await callSweep(qm);

    expect((await ticketService.getTicket(t.ticketId))?.status).toBe('backlog');
  });
});
