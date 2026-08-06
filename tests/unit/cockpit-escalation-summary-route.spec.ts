/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard escalation summary aggregation plus exact caller scoping so whitespace-bearing subjects cannot become an unscoped system read.
 */

import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import {
  buildEscalationSummary,
  handleGetCockpitEscalationSummary,
} from '../../src/app/routes/cockpit-escalation-summary-route';

describe('cockpit escalation summary route helpers', () => {
  it('summarizes escalation metadata quality and respects owner scoping', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const complete = await service.createTicket({
      title: 'Complete with clean escalation',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    });
    await service.updateStatusAs(complete.ticketId, 'escalated', 'test-lab', 'Test Lab', {
      reason: 'verification_exhausted',
      source: 'ai-test-lab',
      severity: 'high',
    });
    await service.updateStatusAs(complete.ticketId, 'complete', 'operator', 'Operator');

    const legacy = await service.createTicket({
      title: 'Legacy messy escalation',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-a',
    });
    await store.updateStatus(legacy.ticketId, 'escalated', {
      changedBy: 'system',
      changedByLabel: 'System',
      metadata: {},
    });

    const otherUser = await service.createTicket({
      title: 'Other user escalation',
      ticketType: 'build',
      status: 'approved',
      priority: 'medium',
      labels: [],
      ownerSub: 'user-b',
    });
    await service.updateStatusAs(otherUser.ticketId, 'escalated', 'system', 'System', {
      reason: 'not_visible_to_user_a',
      source: 'other',
    });

    const summary = await buildEscalationSummary(service, {
      ownerSub: 'user-a',
      scope: 'mine',
    });

    expect(summary.totals.ticketsScanned).toBe(2);
    expect(summary.totals.currentEscalated).toBe(1);
    expect(summary.totals.terminalAfterEscalation).toBe(1);
    expect(summary.totals.escalationEvents).toBe(2);
    expect(summary.metadataQuality.withReason).toBe(1);
    expect(summary.metadataQuality.missingReason).toBe(1);
    expect(summary.metadataQuality.legacyWithoutMetadata).toBe(1);
    expect(summary.topReasons).toContainEqual({ reason: 'verification_exhausted', count: 1 });
    expect(summary.topReasons).toContainEqual({ reason: 'unspecified', count: 1 });
    expect(summary.recent.map((entry) => entry.title)).not.toContain('Other user escalation');
    expect(summary.actions.join(' ')).toContain('Backfill legacy escalation rows');
  });

  it('scopes authenticated case/whitespace subjects exactly instead of using the system view', async () => {
    const listTickets = vi.fn(async () => []);
    const handler = handleGetCockpitEscalationSummary({
      ticketService: { listTickets, getStatusHistory: vi.fn(async () => []) },
    } as never);

    for (const ownerSub of [' Auth0|Case-Owner ']) {
      let body: unknown;
      const req = { oidc: { user: { sub: ownerSub } }, query: {} } as unknown as Request;
      const res = {
        json: vi.fn((value: unknown) => { body = value; return res; }),
        status: vi.fn(() => res),
      } as unknown as Response;

      await handler(req, res);

      expect(listTickets).toHaveBeenLastCalledWith({ limit: 1000, ownerSub });
      expect(body).toEqual(expect.objectContaining({
        success: true,
        data: expect.objectContaining({ scope: 'mine', ownerSub }),
      }));
    }

    const blankReq = { oidc: { user: { sub: '   ' } }, query: {} } as unknown as Request;
    const blankRes = {
      json: vi.fn(() => blankRes),
      status: vi.fn(() => blankRes),
    } as unknown as Response;
    await handler(blankReq, blankRes);
    expect(blankRes.status).toHaveBeenCalledWith(500);
    expect(listTickets).toHaveBeenCalledTimes(1);
  });
});
