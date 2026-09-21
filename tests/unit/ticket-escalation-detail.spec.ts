/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard that an escalation reason recorded by a status transition survives all the way to the cockpit activity payload: derived from a real TicketService escalation (not a hand-built row), read back over the real HTTP route, and still null when no reason was ever recorded. Also pins selectEscalationDetail so an empty durable swarm_escalations lookup cannot erase it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard that a ticket escalated more than once is dated by its CURRENT escalation: the payload carries escalatedAt over the real route even when that escalation recorded no reason, and selectEscalationDetail discards a durable record written for an earlier run rather than presenting it as the current explanation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-163 D3 flipped the precedence these cases pinned: the canonical transition detail now explains an escalation and the run-scoped swarm_escalations record enriches it, instead of the run record winning outright whenever it named a reason. The two cases are rewritten to assert the merged shape — the canonical reason AND the run record's retryClass, which the old single-record assertions could not both check — not relaxed.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveTicketEscalationDetail, readTicketEscalatedAt } from '../../src/entities/ticket';
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

/**
 * @description Builds one status-history row with an exact date, so escalation ordering can
 * be asserted without depending on how fast the in-memory store stamps consecutive writes.
 * @param id - Row identifier.
 * @param fromStatus - Status the transition left.
 * @param toStatus - Status the transition landed on.
 * @param metadata - Transition metadata.
 * @param createdAt - Row timestamp.
 * @returns A status-history row.
 */
function buildHistoryRow(
  id: string,
  fromStatus: string,
  toStatus: string,
  metadata: Record<string, unknown>,
  createdAt: string,
) {
  return {
    id,
    ticketId: 't',
    fromStatus,
    toStatus,
    changedBy: 'system',
    changedByLabel: 'System',
    metadata,
    createdAt,
  };
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

  it('dates the current escalation even when that escalation recorded no reason', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Escalated, de-escalated, escalated again',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: OWNER_SUB,
    });
    await service.updateStatusAs(ticket.ticketId, 'escalated', 'system', 'System', {
      reason: 'Verification exhausted policy budget after attempt 2.',
    });
    await service.updateStatusAs(ticket.ticketId, 'approved', 'system', 'System', {});
    // The current escalation, recording nothing — the shape the operator's ticket is in.
    await store.updateStatus(ticket.ticketId, 'escalated', {
      changedBy: 'system',
      changedByLabel: 'System',
      metadata: {},
    });

    // The append-only history is what the operator's ticket is read from — its row metadata
    // carries no lastStatusTransition mirror, so history alone answers there.
    const history = await service.getStatusHistory(ticket.ticketId);
    const escalations = history.filter((row) => row.toStatus === 'escalated');
    const newest = escalations.reduce((a, b) => (Date.parse(a.createdAt) >= Date.parse(b.createdAt) ? a : b));

    expect(escalations).toHaveLength(2);
    // The newest escalating row recorded nothing, and the earlier row's reason is not
    // reachable through it...
    expect(deriveTicketEscalationDetail(history, null)).toBeNull();
    // ...but the escalation is still datable, which is what lets a reader judge other
    // records — and it is dated by the CURRENT escalation, not the one that closed.
    expect(readTicketEscalatedAt(history, null)).toBe(newest.createdAt);
  });

  it('dates from the newest escalating transition, not an earlier one', () => {
    const rows = [
      buildHistoryRow('1', 'approved', 'escalated', { reason: 'first_escalation' }, '2026-06-21T04:36:12.162Z'),
      buildHistoryRow('2', 'escalated', 'approved', {}, '2026-06-21T04:36:12.172Z'),
      buildHistoryRow('3', 'approved', 'escalated', {}, '2026-06-22T14:27:24.373Z'),
    ];

    expect(readTicketEscalatedAt(rows, null)).toBe('2026-06-22T14:27:24.373Z');
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

  it('dates the escalation over the route even when the escalation recorded no reason', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'Escalated with nothing recorded',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: OWNER_SUB,
    });
    await store.updateStatus(ticket.ticketId, 'escalated', {
      changedBy: 'system',
      changedByLabel: 'System',
      metadata: {},
    });

    const server = appFor(service).listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/tickets/${ticket.ticketId}/activity`);
    const body = await response.json() as { ticket?: { escalation?: unknown; escalatedAt?: unknown } };

    expect(response.status).toBe(200);
    // Nothing recorded, so no reason is invented — but the cockpit still learns WHEN,
    // which is the only thing that can disqualify a record left over from an earlier run.
    expect(body.ticket?.escalation).toBeNull();
    expect(typeof body.ticket?.escalatedAt).toBe('string');
    expect(Number.isFinite(Date.parse(String(body.ticket?.escalatedAt)))).toBe(true);
  });
});

describe('cockpit escalation record precedence', () => {
  const recorded = { reason: 'manifest_worker_dispatch_failed', source: 'dispatch-manifest-worker' };
  const durable = { reason: 'pipeline_work_items_failed', retryClass: 'verification_exhausted' };

  it('lets the canonical transition explain the escalation and the run record enrich it', () => {
    // ADR-163: swarm_escalations answers only escalations raised inside a swarm run, so it cannot
    // be what the panel asks first. It still contributes what only a run knows.
    const selected = selectEscalationDetail(recorded, durable);

    expect(selected?.reason).toBe('manifest_worker_dispatch_failed');
    expect(selected?.source).toBe('dispatch-manifest-worker');
    expect(selected?.retryClass, 'the attempt fields only the run record carries must survive the merge')
      .toBe('verification_exhausted');
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

  // Dates below are the operator's own rows for ticket 60cb33b5: a durable record from a
  // swarm run that ended on 06-21, and the escalation actually on screen, raised on 06-22.
  const EARLIER_RUN_RECORD = {
    reason: 'Verification exhausted policy budget after attempt 2.',
    target: 'human_review',
    retryClass: 'deterministic',
    createdAt: '2026-06-21T04:36:12.162Z',
  };
  const CURRENT_ESCALATION_AT = '2026-06-22T14:27:24.373Z';

  it('discards a durable record written before the current escalation', () => {
    expect(selectEscalationDetail(null, EARLIER_RUN_RECORD, CURRENT_ESCALATION_AT)).toBeNull();
  });

  it('keeps a durable record written for the escalation on screen', () => {
    // The durable row is written just AHEAD of the transition it causes; across all 24
    // pairs on the operator's database that lead is 8-59 ms, so a current record legitimately
    // predates the escalation it explains.
    const currentRecord = { ...EARLIER_RUN_RECORD, createdAt: '2026-06-22T14:27:24.361Z' };

    expect(selectEscalationDetail(null, currentRecord, CURRENT_ESCALATION_AT)).toBe(currentRecord);
  });

  it('keeps a durable record written after the escalation transition', () => {
    const laterRecord = { ...EARLIER_RUN_RECORD, createdAt: '2026-06-22T14:27:25.500Z' };

    expect(selectEscalationDetail(null, laterRecord, CURRENT_ESCALATION_AT)).toBe(laterRecord);
  });

  it('prefers the reason the current escalation recorded over an earlier run', () => {
    // The operator's ticket cf9419eb: its escalation recorded parent_terminal_state 13.6 s
    // after a verification run left a durable record behind and returned it to approved.
    // That 13.6 s is the SMALLEST stale gap on the box; every same-run pair leads by <60 ms.
    const currentDetail = {
      reason: 'parent_terminal_state',
      source: 'queue-parent-gate',
      createdAt: '2026-06-22T19:16:31.395Z',
    };
    const priorRecord = { ...EARLIER_RUN_RECORD, createdAt: '2026-06-22T19:16:17.811Z' };

    expect(selectEscalationDetail(currentDetail, priorRecord, currentDetail.createdAt)).toBe(currentDetail);
  });

  it('dates the escalation from the recorded detail when no escalatedAt is passed', () => {
    const currentDetail = { reason: 'parent_terminal_state', createdAt: '2026-06-22T19:16:31.395Z' };
    const priorRecord = { ...EARLIER_RUN_RECORD, createdAt: '2026-06-22T19:16:17.811Z' };

    expect(selectEscalationDetail(currentDetail, priorRecord)).toBe(currentDetail);
  });

  it('keeps an undatable durable record, having no evidence it is stale', () => {
    // Undatable is not evidence of staleness, so the run record is NOT discarded — its fields are
    // still there beside the canonical reason (ADR-163 D3 changed which one explains, not which
    // records survive).
    const selected = selectEscalationDetail(recorded, durable, CURRENT_ESCALATION_AT);

    expect(selected?.retryClass).toBe('verification_exhausted');
    expect(selected?.reason).toBe('manifest_worker_dispatch_failed');
  });
});
