/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard that an escalation reason recorded by a status transition survives all the way to the cockpit activity payload: derived from a real TicketService escalation (not a hand-built row), read back over the real HTTP route, and still null when no reason was ever recorded. Also pins selectEscalationDetail so an empty durable swarm_escalations lookup cannot erase it.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveTicketEscalationDetail } from '../../src/entities/ticket';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import { createCockpitRoutes } from '../../src/app/routes/cockpit-routes';
import { selectEscalationDetail } from '../../src/pages/cockpit/js/views/ticket-view-helpers.js';

const OWNER_SUB = 'auth0|escalation-owner';

/**
 * @description Creates a ticket and escalates it the way a dispatch failure does,
 * through the real service so the recorded metadata is whatever the product writes.
 * @param service - Ticket service under test.
 * @param metadata - Transition metadata the escalating path supplies.
 * @returns The created ticket id.
 */
async function escalateTicket(
  service: TicketService,
  metadata: Record<string, unknown>,
): Promise<string> {
  const ticket = await service.createTicket({
    title: 'Dispatch failed before a swarm run existed',
    ticketType: 'build',
    status: 'approved',
    priority: 'medium',
    labels: [],
    ownerSub: OWNER_SUB,
  });
  await service.updateStatusAs(ticket.ticketId, 'escalated', 'system', 'System', metadata);
  return ticket.ticketId;
}

describe('ticket escalation detail derivation', () => {
  it('reads back the reason, source and next action a real escalation recorded', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticketId = await escalateTicket(service, {
      reason: 'manifest_worker_dispatch_failed',
      source: 'dispatch-manifest-worker',
      message: 'authorization_recorded_delegation_required',
      workerBot: 'communications-bot',
    });

    const detail = deriveTicketEscalationDetail(
      await service.getStatusHistory(ticketId),
      (await service.getTicket(ticketId))?.metadata,
    );

    expect(detail).not.toBeNull();
    expect(detail?.reason).toBe('manifest_worker_dispatch_failed');
    expect(detail?.source).toBe('dispatch-manifest-worker');
    expect(detail?.message).toBe('authorization_recorded_delegation_required');
    // severity/nextAction are the escalation backstop in buildStatusTransitionMetadata:
    // every escalation carries them, so the panel always has a next action to show.
    expect(detail?.severity).toBe('medium');
    expect(detail?.nextAction).toBe('operator_review_required');
    expect(detail?.previousStatus).toBe('approved');
    expect(detail?.origin).toBe('status-history');
  });

  it('falls back to the ticket row transition mirror when history is unavailable', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticketId = await escalateTicket(service, {
      reason: 'operator_parked_pending_credentials',
      source: 'cockpit',
    });
    const ticket = await service.getTicket(ticketId);

    const detail = deriveTicketEscalationDetail([], ticket?.metadata);

    expect(detail?.reason).toBe('operator_parked_pending_credentials');
    expect(detail?.source).toBe('cockpit');
    expect(detail?.origin).toBe('ticket-metadata');
  });

  it('returns null when nothing recorded a reason, rather than inventing one', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Legacy escalation with no recorded reason',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: OWNER_SUB,
    });
    // Straight at the store: this bypasses the service backstop the same way the
    // pre-backstop rows already sitting in ticket_status_history did.
    await store.updateStatus(ticket.ticketId, 'escalated', {
      changedBy: 'system',
      changedByLabel: 'System',
      metadata: {},
    });

    const detail = deriveTicketEscalationDetail(
      await service.getStatusHistory(ticket.ticketId),
      (await service.getTicket(ticket.ticketId))?.metadata,
    );

    expect(detail).toBeNull();
  });

  it('ignores transitions that did not land on escalated and prefers the newest that did', () => {
    const detail = deriveTicketEscalationDetail(
      [
        {
          id: '1',
          ticketId: 't',
          fromStatus: 'approved',
          toStatus: 'escalated',
          changedBy: 'system',
          changedByLabel: 'System',
          metadata: { reason: 'first_escalation' },
          createdAt: '2026-09-01T00:00:00.000Z',
        },
        {
          id: '2',
          ticketId: 't',
          fromStatus: 'escalated',
          toStatus: 'complete',
          changedBy: 'operator',
          changedByLabel: 'Operator',
          metadata: { reason: 'operator_closed_it' },
          createdAt: '2026-09-02T00:00:00.000Z',
        },
        {
          id: '3',
          ticketId: 't',
          fromStatus: 'approved',
          toStatus: 'escalated',
          changedBy: 'system',
          changedByLabel: 'System',
          metadata: { reason: 'second_escalation' },
          createdAt: '2026-09-03T00:00:00.000Z',
        },
      ],
      null,
    );

    expect(detail?.reason).toBe('second_escalation');
  });
});

describe('cockpit activity payload escalation projection', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  /**
   * @description Mounts the real cockpit routes over a real ticket service.
   * @param ticketService - Ticket service backing the route.
   * @returns A listening express app bound to an ephemeral port.
   */
  function appFor(ticketService: TicketService) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as { oidc?: unknown }).oidc = { user: { sub: OWNER_SUB, email: 'owner@example.test' } };
      next();
    });
    app.use('/api/v1', createCockpitRoutes({
      ticketService,
      taskStore: { list: async () => [], get: async () => null },
      messageStore: { getByTask: async () => [] },
      workspaceService: { getWorkspace: async () => null },
    } as never));
    return app;
  }

  it('serves the recorded escalation reason on the escalated ticket it belongs to', async () => {
    const service = new TicketService(new InMemoryTicketStore());
    const ticketId = await escalateTicket(service, {
      reason: 'manifest_worker_dispatch_failed',
      source: 'dispatch-manifest-worker',
      message: 'authorization_recorded_delegation_required',
    });

    const server = appFor(service).listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tickets/${ticketId}/activity`);
    const body = await response.json() as { ticket?: { escalation?: Record<string, unknown> | null } };

    expect(response.status).toBe(200);
    expect(body.ticket?.escalation).toMatchObject({
      reason: 'manifest_worker_dispatch_failed',
      source: 'dispatch-manifest-worker',
      nextAction: 'operator_review_required',
    });
  });

  it('leaves the escalation null on a ticket that is not escalated', async () => {
    const service = new TicketService(new InMemoryTicketStore());
    const ticket = await service.createTicket({
      title: 'Ordinary approved ticket',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: OWNER_SUB,
    });

    const server = appFor(service).listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tickets/${ticket.ticketId}/activity`);
    const body = await response.json() as { ticket?: { escalation?: unknown } };

    expect(response.status).toBe(200);
    expect(body.ticket?.escalation).toBeNull();
  });
});

describe('cockpit escalation record precedence', () => {
  const recorded = { reason: 'manifest_worker_dispatch_failed', source: 'dispatch-manifest-worker' };
  const durable = { reason: 'pipeline_work_items_failed', retryClass: 'verification_exhausted' };

  it('prefers the richer durable swarm record when it names a reason', () => {
    expect(selectEscalationDetail(recorded, durable)).toBe(durable);
  });

  it('keeps the recorded transition detail when the durable lookup found nothing', () => {
    // The regression: this used to be an unconditional assignment, so a null here
    // erased a reason the payload already carried.
    expect(selectEscalationDetail(recorded, null)).toBe(recorded);
  });

  it('reports nothing when neither record exists', () => {
    expect(selectEscalationDetail(null, null)).toBeNull();
    expect(selectEscalationDetail(undefined, undefined)).toBeNull();
  });
});
