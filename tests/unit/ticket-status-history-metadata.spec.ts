import { describe, expect, it } from 'vitest';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';

describe('ticket status history metadata', () => {
  it('records one actor-aware history row with metadata for a transition', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Build a validator',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      metadata: {},
    });

    await service.updateStatusAs(ticket.ticketId, 'in_process_build', 'test-lab', 'Test Lab', {
      reason: 'operator_approved_build',
    });

    const history = await service.getStatusHistory(ticket.ticketId);
    const buildTransitions = history.filter((entry) => entry.toStatus === 'in_process_build');

    expect(buildTransitions).toHaveLength(1);
    expect(buildTransitions[0]).toMatchObject({
      changedBy: 'test-lab',
      changedByLabel: 'Test Lab',
      metadata: { reason: 'operator_approved_build' },
    });
  });

  it('adds default metadata when a ticket escalates without a caller-provided reason', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Build reliability gate',
      ticketType: 'build',
      status: 'in_process_build',
      priority: 'medium',
      labels: [],
      metadata: {},
    });

    await service.updateStatus(ticket.ticketId, 'escalated');

    const history = await service.getStatusHistory(ticket.ticketId);
    const escalation = history.find((entry) => entry.toStatus === 'escalated');

    expect(escalation?.metadata).toMatchObject({
      reason: 'unspecified_escalation',
      source: 'ticket-service',
      severity: 'medium',
      nextAction: 'operator_review_required',
      previousStatus: 'in_process_build',
      ticketId: ticket.ticketId,
    });
    expect(escalation?.metadata.escalatedAt).toEqual(expect.any(String));
  });

  it('preserves explicit escalation metadata while filling required dashboard fields', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Build regression exhausted',
      ticketType: 'build',
      status: 'in_process_build',
      priority: 'medium',
      labels: [],
      metadata: {},
    });

    await service.updateStatusAs(ticket.ticketId, 'escalated', 'queue-manager', 'Queue Manager', {
      reason: 'verification_exhausted',
      source: 'queue-manager',
    });

    const history = await service.getStatusHistory(ticket.ticketId);
    const escalation = history.find((entry) => entry.toStatus === 'escalated');

    expect(escalation).toMatchObject({
      changedBy: 'queue-manager',
      changedByLabel: 'Queue Manager',
      metadata: {
        reason: 'verification_exhausted',
        source: 'queue-manager',
        severity: 'medium',
        nextAction: 'operator_review_required',
        changedBy: 'queue-manager',
      },
    });
  });

  it('copies status metadata to the ticket row without overwriting queue provenance', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Run Jarvis task',
      ticketType: 'task',
      status: 'approved',
      priority: 'medium',
      labels: [],
      metadata: { source: 'jarvis', queueId: 'jarvis' },
    });

    await service.updateStatus(ticket.ticketId, 'escalated', {
      reason: 'manifest_worker_dispatch_failed',
      source: 'dispatch-manifest-worker',
      nextAction: 'check_service_secret',
    });

    const updated = await service.getTicket(ticket.ticketId);
    expect(updated?.metadata).toMatchObject({
      source: 'jarvis',
      queueId: 'jarvis',
      reason: 'manifest_worker_dispatch_failed',
      statusSource: 'dispatch-manifest-worker',
      nextAction: 'check_service_secret',
      lastStatusTransition: {
        status: 'escalated',
        reason: 'manifest_worker_dispatch_failed',
        source: 'dispatch-manifest-worker',
      },
    });
  });

  it('records internal activity without changing ticket status', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Long running bot execution',
      ticketType: 'build',
      status: 'in_process_build',
      priority: 'medium',
      labels: [],
      metadata: {},
    });

    await service.recordActivity(ticket.ticketId, {
      source: 'swarm-agent-worker',
      event: 'execution_heartbeat',
      internalComment: true,
      agentId: 'agent-code-developer',
      elapsedMs: 180000,
    });

    const updated = await service.getTicket(ticket.ticketId);
    const history = await service.getStatusHistory(ticket.ticketId);
    const activity = history.find((entry) => entry.metadata.event === 'execution_heartbeat');

    expect(updated?.status).toBe('in_process_build');
    expect(activity).toMatchObject({
      fromStatus: 'in_process_build',
      toStatus: 'in_process_build',
      changedBy: 'agent-code-developer',
      changedByLabel: 'Swarm Worker',
      metadata: {
        source: 'swarm-agent-worker',
        event: 'execution_heartbeat',
        internalComment: true,
        internalActivity: true,
        currentStatus: 'in_process_build',
        elapsedMs: 180000,
      },
    });
  });
});
