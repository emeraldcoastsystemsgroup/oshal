import { describe, expect, it } from 'vitest';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import { buildQueueHealthSummary } from '../../src/app/routes/cockpit-queue-health-route';

describe('cockpit queue health route helpers', () => {
  it('reports stale approved work, build escalations, and metadata gaps under owner scope', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const now = new Date('2030-06-22T17:00:00.000Z');

    await service.createTicket({
      title: 'Approved build not picked up',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    });

    await service.createTicket({
      title: 'Manual intake waiting for approval',
      ticketType: 'build',
      status: 'backlog',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    });

    const escalated = await service.createTicket({
      title: 'Build escalated without metadata',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    });
    await store.updateStatus(escalated.ticketId, 'escalated', {
      changedBy: 'system',
      changedByLabel: 'System',
      metadata: {},
    });

    const providerStall = await service.createTicket({
      title: 'Claude lane stalled',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    });
    await store.updateStatus(providerStall.ticketId, 'escalated', {
      changedBy: 'worker',
      changedByLabel: 'Worker',
      metadata: {
        reason: 'swarm_worker_execution_failed',
        source: 'swarm-agent-worker',
        failureClass: 'provider_runtime_stall',
      },
    });

    const assignedEscalation = await service.createTicket({
      title: 'Assigned escalation',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
      assignedAgentId: 'agent-code',
    });
    await store.updateStatus(assignedEscalation.ticketId, 'escalated', {
      changedBy: 'worker',
      changedByLabel: 'Worker',
      metadata: {
        reason: 'assigned_failure',
        source: 'worker',
      },
    });

    const rowMetadataOnly = await service.createTicket({
      title: 'Legacy row metadata escalation',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    });
    await store.updateStatus(rowMetadataOnly.ticketId, 'escalated', {
      changedBy: 'worker',
      changedByLabel: 'Worker',
      metadata: {},
    });
    await service.updateTicket(rowMetadataOnly.ticketId, {
      metadata: {
        reason: 'legacy_row_backfill',
        source: 'legacy-cleanup',
      },
    });

    await service.createTicket({
      title: 'Open Jarvis chat thread',
      ticketType: 'chat',
      status: 'in_process',
      priority: 'none',
      labels: [],
      ownerSub: 'user-a',
      metadata: {
        origin: 'bot-chat',
        kind: 'chat-thread',
        taskId: 'jarvis-user-a',
      },
    });

    const otherUser = await service.createTicket({
      title: 'Other user stale approved',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-b',
    });
    await service.updateStatusAs(otherUser.ticketId, 'escalated', 'worker', 'Worker', {
      reason: 'not_visible',
      source: 'other-user-worker',
    });

    const summary = await buildQueueHealthSummary(service, {
      ownerSub: 'user-a',
      scope: 'mine',
      now,
      approvedStaleMinutes: 10,
      inProcessStaleMinutes: 60,
      workItems: {
        available: true,
        byStatus: { routing_failed: 2 },
        stalePending: 0,
        staleExecuting: 0,
        historicalRoutingFailed: 0,
        routingFailed: 2,
        oldestPendingAgeMinutes: null,
        newestUpdateAt: now.toISOString(),
      },
    });

    expect(summary.status).toBe('blocked');
    expect(summary.totals.ticketsScanned).toBe(7);
    expect(summary.totals.backlog).toBe(1);
    expect(summary.totals.staleBacklog).toBe(1);
    expect(summary.totals.approved).toBe(1);
    expect(summary.totals.inProcess).toBe(1);
    expect(summary.totals.staleApproved).toBe(1);
    expect(summary.totals.staleInProcess).toBe(0);
    expect(summary.totals.buildEscalated).toBe(4);
    expect(summary.totals.providerRuntimeStalled).toBe(1);
    expect(summary.totals.unassignedEscalated).toBe(3);
    expect(summary.totals.escalatedMissingReason).toBe(1);
    expect(summary.workItems.routingFailed).toBe(2);
    expect(summary.recentBlockers.map((item) => item.title)).not.toContain('Other user stale approved');
    expect(summary.recentBlockers).toContainEqual(expect.objectContaining({
      title: 'Claude lane stalled',
      reason: 'provider_runtime_stall',
    }));
    expect(summary.actions.join(' ')).toContain('Provider runtime is stalling');
    expect(summary.actions.join(' ')).toContain('Escalated tickets are unassigned');
    expect(summary.actions.join(' ')).toContain('Backlog tickets are waiting for approval');
    expect(summary.actions.join(' ')).toContain('Queue pickup is stale');
    expect(summary.actions.join(' ')).toContain('Routing failures exist');
  });
});
