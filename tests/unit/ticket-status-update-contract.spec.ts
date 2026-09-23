/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Pin expected-status and atomic-DLQ behavior across the in-memory store and TicketService's narrowly idempotent typed-conflict recovery.
 */

import { describe, expect, it, vi } from 'vitest';
import { TicketStatusConflictError } from '@/entities/ticket';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';

async function approvedFixture(): Promise<{
  store: InMemoryTicketStore;
  service: TicketService;
  ticketId: string;
}> {
  const store = new InMemoryTicketStore();
  const ticket = await store.create({
    title: 'Ticket status context fixture',
    ticketType: 'task',
    status: 'approved',
    priority: 'medium',
    labels: [],
    metadata: {},
  });
  return { store, service: new TicketService(store), ticketId: ticket.ticketId };
}

const deadLetter = {
  reason: 'authorization_fixture_refused',
  lastError: 'authorization_fixture_refused: fixture detail',
  remedy: 'Repair the fixture authority and retry.',
  attempts: 1,
};

describe('ticket status update context contract', () => {
  it('accepts a matching in-memory expected status', async () => {
    const { store, ticketId } = await approvedFixture();

    await store.updateStatus(ticketId, 'in_process_discovery', { expectedStatus: 'approved' });

    expect(await store.get(ticketId)).toMatchObject({ status: 'in_process_discovery' });
  });

  it('rejects a stale in-memory expected status without mutating ticket or history', async () => {
    const { store, ticketId } = await approvedFixture();
    const beforeHistory = await store.getStatusHistory(ticketId);

    const update = store.updateStatus(ticketId, 'in_process_discovery', {
      expectedStatus: 'backlog',
    });

    await expect(update).rejects.toMatchObject({
      name: 'TicketStatusConflictError',
      ticketId,
      expectedStatus: 'backlog',
      actualStatus: 'approved',
    });
    await expect(update).rejects.toBeInstanceOf(TicketStatusConflictError);
    expect(await store.get(ticketId)).toMatchObject({ status: 'approved' });
    expect(await store.getStatusHistory(ticketId)).toEqual(beforeHistory);
  });

  it('rejects an atomic dead-letter context in memory without claiming a terminal write', async () => {
    const { store, ticketId } = await approvedFixture();
    const beforeHistory = await store.getStatusHistory(ticketId);

    await expect(store.updateStatus(ticketId, 'dead_letter', {
      expectedStatus: 'approved',
      deadLetter,
    })).rejects.toThrow('InMemoryTicketStore cannot persist an atomic dead-letter mutation');

    expect(await store.get(ticketId)).toMatchObject({ status: 'approved' });
    expect(await store.getStatusHistory(ticketId)).toEqual(beforeHistory);
  });

  it('rejects an atomic dead-letter requeue context in memory without claiming a release', async () => {
    const { store, ticketId } = await approvedFixture();
    await store.updateStatus(ticketId, 'dead_letter', { expectedStatus: 'approved' });
    const beforeHistory = await store.getStatusHistory(ticketId);

    await expect(store.updateStatus(ticketId, 'approved', {
      expectedStatus: 'dead_letter',
      deadLetterRequeue: { requeuedBy: 'fixture-operator' },
    })).rejects.toThrow('InMemoryTicketStore cannot persist an atomic dead-letter requeue mutation');

    expect(await store.get(ticketId)).toMatchObject({ status: 'dead_letter' });
    expect(await store.getStatusHistory(ticketId)).toEqual(beforeHistory);
  });

  it('returns false only when a typed conflict re-read proves another caller committed dead-letter', async () => {
    const { store, service, ticketId } = await approvedFixture();
    const updateStatus = store.updateStatus.bind(store);
    const conflict = new TicketStatusConflictError(ticketId, 'approved', 'dead_letter');
    vi.spyOn(store, 'updateStatus').mockImplementationOnce(async () => {
      await updateStatus(ticketId, 'dead_letter', { expectedStatus: 'approved' });
      throw conflict;
    });

    await expect(service.quarantineToDeadLetter(ticketId, deadLetter)).resolves.toBe(false);
    expect(await store.get(ticketId)).toMatchObject({ status: 'dead_letter' });
  });

  it('rethrows typed conflicts whose confirming re-read is not dead-letter', async () => {
    const { store, service, ticketId } = await approvedFixture();
    const updateStatus = store.updateStatus.bind(store);
    const conflict = new TicketStatusConflictError(ticketId, 'approved', 'escalated');
    vi.spyOn(store, 'updateStatus').mockImplementationOnce(async () => {
      await updateStatus(ticketId, 'escalated', { expectedStatus: 'approved' });
      throw conflict;
    });

    await expect(service.quarantineToDeadLetter(ticketId, deadLetter)).rejects.toBe(conflict);
    expect(await store.get(ticketId)).toMatchObject({ status: 'escalated' });
  });

  it('does not swallow unrelated persistence failures', async () => {
    const { store, service, ticketId } = await approvedFixture();
    const outage = new Error('fixture database unavailable');
    vi.spyOn(store, 'updateStatus').mockRejectedValueOnce(outage);

    await expect(service.quarantineToDeadLetter(ticketId, deadLetter)).rejects.toBe(outage);
    expect(await store.get(ticketId)).toMatchObject({ status: 'approved' });
  });
});
