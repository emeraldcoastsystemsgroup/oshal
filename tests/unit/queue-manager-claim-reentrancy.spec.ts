/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for one approved ticket being claimed once (queue-manager-service.ts). Drives the real QueueManagerService over the real TicketService on the in-memory store with a pipeline double that blocks until released. Proves: a poll tick that fires while a cycle is still running is skipped without a second approved query; two concurrent dispatches of one ticket run the pipeline once and keep the slot until the first finishes; a claim that loses to a concurrent status transition neither runs the pipeline nor rolls the ticket back. The live shape it guards: two ticks after an api stall claimed the same root, the loser's conflict rolled it back to approved mid-planning, a third claim planned it again, and the first round escalated it with "No active orchestration" (2026-10-02).
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';
import { TicketService } from '../../src/features/ticketing/services/ticket-service';
import { QueueManagerService } from '../../src/features/swarm-orchestration/services/queue-manager-service';
import { CreateInternalTicketSchema, TicketStatusConflictError } from '../../src/entities/ticket';

type Gate = { promise: Promise<void>; release: () => void };

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/**
 * @description The real queue manager over the real ticket service and a pipeline double that
 * records each dispatch and blocks until released, so a second claim can race the first.
 */
function build() {
  const ticketService = new TicketService(new InMemoryTicketStore());
  const blocker = gate();
  const dispatched: number[] = [];
  const swarmProcessingService = {
    async getRuntimeReadiness() { return { ready: true }; },
    async processTickets() {
      dispatched.push(Date.now());
      await blocker.promise;
      return { processedCount: 1, processed: [{ selectedAgentId: 'agent-worker-1' }] };
    },
  } as never;
  const queueManager = new QueueManagerService(ticketService, swarmProcessingService);
  return { ticketService, queueManager, blocker, dispatched };
}

const privateApi = (qm: QueueManagerService) => qm as unknown as {
  pollCycle(): Promise<void>;
  dispatchTicket(ticket: unknown): Promise<void>;
  rollbackTicket(ticketId: string, lastError?: string): Promise<void>;
  activeTicketIds: Set<string>;
};

/** Waits, a few milliseconds at a time, until the predicate holds or two seconds pass. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function approvedRoot(ticketService: TicketService) {
  return ticketService.createTicket(CreateInternalTicketSchema.parse({ title: 'Build a two-module CLI', ticketType: 'build', status: 'approved', metadata: {} }));
}

describe('one approved ticket is claimed once', () => {
  it('a poll tick that fires while a cycle is still running is skipped, without a second approved query', async () => {
    const { ticketService, queueManager, blocker, dispatched } = build();
    const root = await approvedRoot(ticketService);
    const listSpy = vi.spyOn(ticketService, 'listTickets');

    const api = privateApi(queueManager);
    const first = api.pollCycle();
    const second = api.pollCycle();
    await second;
    await first;
    // Dispatches are launched detached: wait for the one pipeline call, then let it finish.
    await waitFor(() => dispatched.length >= 1);
    const approvedQueries = listSpy.mock.calls.filter(([options]) => (options as { status?: string } | undefined)?.status === 'approved');
    expect(approvedQueries).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect((await ticketService.getTicket(root.ticketId))?.status).toBe('in_process_discovery');

    blocker.release();
    await waitFor(() => !api.activeTicketIds.has(root.ticketId));
    expect(dispatched).toHaveLength(1);
    expect((await ticketService.getTicket(root.ticketId))?.status).not.toBe('approved');
  });

  it('two concurrent dispatches of one ticket run the pipeline once and keep the slot until the first finishes', async () => {
    const { ticketService, queueManager, blocker, dispatched } = build();
    const root = await approvedRoot(ticketService);
    const api = privateApi(queueManager);

    const first = api.dispatchTicket(root);
    const second = api.dispatchTicket(root);
    await second;
    expect(api.activeTicketIds.has(root.ticketId)).toBe(true);
    await waitFor(() => dispatched.length >= 1);
    expect(dispatched).toHaveLength(1);
    expect((await ticketService.getTicket(root.ticketId))?.status).toBe('in_process_discovery');

    blocker.release();
    await first;
    expect(dispatched).toHaveLength(1);
    expect(api.activeTicketIds.has(root.ticketId)).toBe(false);
  });

  it('a claim that loses to a concurrent status transition runs nothing and rolls nothing back', async () => {
    const { ticketService, queueManager, dispatched } = build();
    const root = await approvedRoot(ticketService);
    const api = privateApi(queueManager);
    const rollback = vi.fn(async () => undefined);
    api.rollbackTicket = rollback;
    const realUpdate = ticketService.updateStatus.bind(ticketService);
    vi.spyOn(ticketService, 'updateStatus').mockImplementationOnce(async (ticketId: string) => {
      throw new TicketStatusConflictError(ticketId, 'approved', 'in_process_discovery');
    }).mockImplementation(realUpdate as never);

    await api.dispatchTicket(root);

    expect(dispatched).toHaveLength(0);
    expect(rollback).not.toHaveBeenCalled();
    expect((await ticketService.getTicket(root.ticketId))?.status).toBe('approved');
    expect(api.activeTicketIds.has(root.ticketId)).toBe(false);
  });
});
