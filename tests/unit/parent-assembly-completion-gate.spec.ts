/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression gate for the parent-completes-early bug (backlog item from commit 494e90ff): reproduces the post-build-gate re-dispatch race where dispatchTicket marked a decomposed parent 'complete' from its OWN pipeline result (planningDecomposition undefined skips both Step-7 early returns) while children were still building — and 'complete' only transitions to 'backlog', wedging the parent out of assembly/escalation forever. Asserts the completion gate defers to parent assembly: in-flight child → parent stays active (on dispatch AND on the stale-parent sweep), all-terminal children → assembled to customer_action, failed child → existing escalation rollup, childless root → still completes from its own result.
 */

import { describe, expect, it } from 'vitest';
import type { InternalTicket } from '../../src/entities/ticket/internal-ticket';
import type { OshalTicketState } from '../../src/entities/ticket';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';
import { TicketService } from '../../src/features/ticketing/services/ticket-service';
import { QueueManagerService } from '../../src/features/swarm-orchestration/services/queue-manager-service';

describe('parent assembly completion gate (parent-completes-early regression)', () => {
  it('does not complete a parent with an in-flight child — neither on dispatch nor on the sweep', async () => {
    const { ticketService, queueManager } = buildQueueManager();
    const parent = await createTicket(ticketService, 'Parent build', 'approved');
    await createTicket(ticketService, 'Child done', 'complete', parent.ticketId);
    await createTicket(ticketService, 'Child building', 'in_process_build', parent.ticketId);

    // The racing sequence: the build gate released the parent back to approved, the poll
    // cycle re-claimed it (children exist → in_process_build entry, no re-planning), and
    // its own pipeline pass returned a phase result with no planningDecomposition.
    await dispatchTicket(queueManager, parent);

    await expect(ticketService.getTicket(parent.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'in_process_build' }),
    );

    // The stale-parent assembly sweep must not complete it either while a child is in flight.
    await callSweepStaleParents(queueManager);
    await expect(ticketService.getTicket(parent.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'in_process_build' }),
    );
  });

  it('assembles the parent to customer_action when every child is terminal', async () => {
    const { ticketService, queueManager } = buildQueueManager();
    const parent = await createTicket(ticketService, 'Parent build', 'approved');
    await createTicket(ticketService, 'Child one', 'complete', parent.ticketId);
    await createTicket(ticketService, 'Child two', 'complete', parent.ticketId);

    await dispatchTicket(queueManager, parent);

    // Assembly (customer_action) is the terminal state for a decomposed parent — never the
    // pipeline's own 'complete', which would bypass the assembly summary and rollup semantics.
    await expect(ticketService.getTicket(parent.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'customer_action' }),
    );
  });

  it('rolls a failed child up to an escalated parent per the existing escalation semantics', async () => {
    const { ticketService, queueManager } = buildQueueManager();
    const parent = await createTicket(ticketService, 'Parent build', 'approved');
    await createTicket(ticketService, 'Child done', 'complete', parent.ticketId);
    await createTicket(ticketService, 'Child failed', 'escalated', parent.ticketId);

    await dispatchTicket(queueManager, parent);

    await expect(ticketService.getTicket(parent.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'escalated' }),
    );
  });

  it('still completes a childless root from its own pipeline result', async () => {
    const { ticketService, queueManager } = buildQueueManager();
    const root = await createTicket(ticketService, 'Standalone build', 'approved');

    await dispatchTicket(queueManager, root);

    await expect(ticketService.getTicket(root.ticketId)).resolves.toEqual(
      expect.objectContaining({ status: 'complete' }),
    );
  });
});

/**
 * @description Builds a QueueManagerService over an in-memory ticket store with a fake swarm
 * pipeline (no docker, no LLM). Pipeline deps are deliberately omitted: that skips workspace
 * creation and Step-7 child creation, reproducing exactly the re-dispatch pass where
 * planningDecomposition is undefined and control falls through to the completion write.
 * @param processed - The fake pipeline's processed entries (a bare phase result by default).
 * @returns The ticket service and queue manager under test.
 */
function buildQueueManager(
  processed: Array<Record<string, unknown>> = [{ selectedAgentId: 'agent-worker-1' }],
): { ticketService: TicketService; queueManager: QueueManagerService } {
  const ticketService = new TicketService(new InMemoryTicketStore());
  const swarmProcessingService = {
    async getRuntimeReadiness() {
      return { ready: true };
    },
    async processTickets() {
      return { processedCount: processed.length, processed };
    },
  } as never;
  const queueManager = new QueueManagerService(ticketService, swarmProcessingService);
  return { ticketService, queueManager };
}

/**
 * @description Creates a ticket fixture in the given lifecycle state.
 * @param ticketService - Ticket service backing the test.
 * @param title - Ticket title.
 * @param status - Initial lifecycle state.
 * @param parentTicketId - Optional parent linkage for child fixtures.
 * @returns The created ticket.
 */
async function createTicket(
  ticketService: TicketService,
  title: string,
  status: OshalTicketState,
  parentTicketId?: string,
): Promise<InternalTicket> {
  return ticketService.createTicket({
    title,
    description: `${title} — completion-gate regression fixture.`,
    status,
    parentTicketId,
    metadata: {},
  });
}

/**
 * @description Invokes the queue manager's private dispatchTicket (the swarm build path).
 * @param queueManager - Service under test.
 * @param ticket - Approved ticket to dispatch.
 * @returns Resolves when the dispatch pass finishes.
 */
async function dispatchTicket(queueManager: QueueManagerService, ticket: InternalTicket): Promise<void> {
  await (queueManager as unknown as { dispatchTicket(t: InternalTicket): Promise<void> }).dispatchTicket(ticket);
}

/**
 * @description Invokes the queue manager's private stale-parent assembly sweep.
 * @param queueManager - Service under test.
 * @returns Resolves when the sweep finishes.
 */
async function callSweepStaleParents(queueManager: QueueManagerService): Promise<void> {
  await (queueManager as unknown as { sweepStaleParents(): Promise<void> }).sweepStaleParents();
}
