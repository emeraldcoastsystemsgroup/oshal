/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify global queue-health admission over mounted HTTP before any data read, preserve operator results and check revocation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Supply canonical creation-schema defaults to fixture inputs without changing ownership assertions.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import { CreateInternalTicketSchema } from '@/entities/ticket';
import { buildQueueHealthSummary, handleGetCockpitQueueHealth } from '../../src/app/routes/cockpit-queue-health-route';

describe('global queue health admission over mounted HTTP', () => {
  let server: Server, origin: string;
  const listTickets = vi.fn(async () => []);
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('GROUP BY status')
    ? [{ status: 'PRIVATE_GLOBAL_STATUS', count: 238 }] : [{ active: 0, historical: 9 }] }));

  beforeEach(async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'queue-operator');
    vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
    listTickets.mockClear(); query.mockClear();
    const app = express();
    app.use((req, _res, next) => {
      const sub = req.get('x-fixture-user');
      Object.assign(req, { oidc: { isAuthenticated: () => Boolean(sub), user: sub ? { sub } : undefined } });
      next();
    });
    app.get('/api/v1/metrics/queue-health', handleGetCockpitQueueHealth({
      ticketService: { listTickets, getStatusHistory: async () => [] }, pool: { query },
    } as never));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(done => server.once('listening', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(done => server.close(() => done()));
    vi.unstubAllEnvs();
  });

  /** @description Call the real queue-health handler using an isolated fixture session.
   * @param sub Optional fixture identity. @param suffix Query string. @returns Native HTTP response. */
  function call(sub?: string, suffix = '') {
    return fetch(origin + '/api/v1/metrics/queue-health' + suffix,
      { headers: sub ? { 'x-fixture-user': sub } : {} });
  }

  it.each([undefined, 'queue-member', 'queue-operator-twin'])(
    'refuses %s before ticket or global work-item reads, including hostile query controls', async sub => {
      for (const suffix of ['', '?scope=all&ownerSub=queue-operator&operator=true', '?scope=mine']) {
        const response = await call(sub, suffix);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Operator privilege required' });
      }
      expect(listTickets).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
    },
  );

  it('preserves the operator global queue collector and the existing default ticket scope', async () => {
    const global = await call('queue-operator', '?scope=all');
    expect(global.status).toBe(200);
    const body = await global.json();
    expect(body.data.scope).toBe('all');
    expect(body.data.workItems.byStatus).toEqual({ PRIVATE_GLOBAL_STATUS: 238 });
    expect(body.data.workItems.historicalRoutingFailed).toBe(9);
    expect(listTickets).toHaveBeenLastCalledWith(expect.objectContaining({ ownerSub: undefined }));
    expect(query).toHaveBeenCalledTimes(2);
    const personal = await call('queue-operator');
    expect(personal.status).toBe(200);
    expect((await personal.json()).data.scope).toBe('mine');
    expect(listTickets).toHaveBeenLastCalledWith(expect.objectContaining({ ownerSub: 'queue-operator' }));
  });

  it('rechecks operator admission on the next request after revocation', async () => {
    expect((await call('queue-operator', '?scope=all')).status).toBe(200);
    const reads = query.mock.calls.length;
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await call('queue-operator', '?scope=all')).status).toBe(403);
    expect(listTickets).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(reads);
  });
});

describe('cockpit queue health route helpers', () => {
  it('reports stale approved work, build escalations, and metadata gaps under owner scope', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const now = new Date('2030-06-22T17:00:00.000Z');

    await service.createTicket(CreateInternalTicketSchema.parse({
      title: 'Approved build not picked up',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    }));

    await service.createTicket(CreateInternalTicketSchema.parse({
      title: 'Manual intake waiting for approval',
      ticketType: 'build',
      status: 'backlog',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    }));

    const escalated = await service.createTicket(CreateInternalTicketSchema.parse({
      title: 'Build escalated without metadata',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    }));
    await store.updateStatus(escalated.ticketId, 'escalated', {
      changedBy: 'system',
      changedByLabel: 'System',
      metadata: {},
    });

    const providerStall = await service.createTicket(CreateInternalTicketSchema.parse({
      title: 'Claude lane stalled',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    }));
    await store.updateStatus(providerStall.ticketId, 'escalated', {
      changedBy: 'worker',
      changedByLabel: 'Worker',
      metadata: {
        reason: 'swarm_worker_execution_failed',
        source: 'swarm-agent-worker',
        failureClass: 'provider_runtime_stall',
      },
    });

    const assignedEscalation = await service.createTicket(CreateInternalTicketSchema.parse({
      title: 'Assigned escalation',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
      assignedAgentId: 'agent-code',
    }));
    await store.updateStatus(assignedEscalation.ticketId, 'escalated', {
      changedBy: 'worker',
      changedByLabel: 'Worker',
      metadata: {
        reason: 'assigned_failure',
        source: 'worker',
      },
    });

    const rowMetadataOnly = await service.createTicket(CreateInternalTicketSchema.parse({
      title: 'Legacy row metadata escalation',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    }));
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

    await service.createTicket(CreateInternalTicketSchema.parse({
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
    }));

    const otherUser = await service.createTicket(CreateInternalTicketSchema.parse({
      title: 'Other user stale approved',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-b',
    }));
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
