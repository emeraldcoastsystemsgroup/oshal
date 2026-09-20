/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CV-2 and CV-3, which are one principle stated by the operator: "if a ticket is generated it should follow the workflow associated with a ticket". CV-2 - createTicket forced 'approval_required' on every incident whose externalProvider was outside a hardcoded two-name trust list, silently overriding the caller; the cockpit route asks for 'backlog' or 'approved' and its own validStatuses list does not contain the status it was actually getting back. The front gate belongs to the workflow (autoStart present starts approved, absent waits at the front - proven by queue-manager-autostart-sweep.spec.ts), not to a provider-trust check inside the ticket service. CV-3 - a ticket whose planner returned zero work units was parked at approval_required forever with nobody told anything was wrong; it now escalates, naming its reason from a CLOSED vocabulary so this does not become a sixth meaning of a status the way it was a fourth meaning of approval_required. The last case pins the two vocabularies disjoint: a reason string that meant both a hold and an escalation would be the "one word, five meanings" defect CKR-16 exists for.
 */

import { describe, expect, it } from 'vitest';
import type { InternalTicket } from '../../src/entities/ticket';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';
import {
  TicketService,
  APPROVAL_REQUIRED_REASONS,
  ESCALATION_REASONS,
} from '../../src/features/ticketing/services/ticket-service';
import { QueueManagerService } from '../../src/features/swarm-orchestration/services/queue-manager-service';

/** The status the cockpit toolbar route (cockpit-routes.ts) is willing to ask for and to render. */
const COCKPIT_VALID_STATUSES = ['backlog', 'approved'] as const;

describe('CV-2 — a ticket enters at the status its workflow says, not one createTicket forces', () => {
  it('an incident from an UNTRUSTED provider is not forced to approval_required', async () => {
    // The defect exactly: `externalProvider` outside {prometheus, alertmanager} used to be
    // rewritten to approval_required regardless of what the caller asked for.
    const tickets = new TicketService(new InMemoryTicketStore());
    const ticket = await tickets.createTicket({
      title: 'an alert nobody vouched for',
      ticketType: 'incident',
      description: 'arrived from a provider outside the old trust list',
      status: 'backlog',
      externalProvider: 'some-third-party-monitor',
      metadata: {},
    });

    expect(ticket.status, 'createTicket overrode the caller for an untrusted provider').toBe('backlog');
    expect(COCKPIT_VALID_STATUSES).toContain(ticket.status);
  });

  it('a trusted provider gets no different treatment — the distinction is gone, not inverted', async () => {
    // Deleting the override must not leave the trust list working in the other direction.
    const tickets = new TicketService(new InMemoryTicketStore());
    const trusted = await tickets.createTicket({
      title: 'a prometheus alarm', ticketType: 'incident', description: 'x',
      status: 'backlog', externalProvider: 'prometheus', metadata: {},
    });
    const untrusted = await tickets.createTicket({
      title: 'the same alarm from elsewhere', ticketType: 'incident', description: 'x',
      status: 'backlog', externalProvider: 'some-third-party-monitor', metadata: {},
    });

    expect(trusted.status).toBe(untrusted.status);
  });

  it('the route receives the status it asked for, for every status it is willing to ask for', async () => {
    // cockpit-routes.ts believes it created what its validStatuses list allows. Before the fix it
    // was handed back a status that list does not contain, for the highest-volume ticket type.
    const tickets = new TicketService(new InMemoryTicketStore());
    for (const status of COCKPIT_VALID_STATUSES) {
      const ticket = await tickets.createTicket({
        title: `incident at ${status}`, ticketType: 'incident', description: 'x',
        status, externalProvider: 'some-third-party-monitor', metadata: {},
      });
      expect(ticket.status).toBe(status);
    }
  });

  it('a caller that explicitly asks for approval_required still gets the CKR-12 reason backstop', async () => {
    // Removing the override must not remove the creation backstop underneath it: a ticket CREATED
    // in the state never transitions into it, so buildStatusTransitionMetadata never sees it.
    const tickets = new TicketService(new InMemoryTicketStore());
    const ticket = await tickets.createTicket({
      title: 'held at intake on purpose', ticketType: 'incident', description: 'x',
      status: 'approval_required', externalProvider: 'some-third-party-monitor', metadata: {},
    });

    const metadata = (ticket.metadata ?? {}) as Record<string, unknown>;
    expect(ticket.status).toBe('approval_required');
    expect(metadata.reason).toBe('incident_intake_triage');
    expect(metadata.nextAction).toBe('operator_approve_to_dispatch');
  });
});

describe('CV-3 — a plan that produced nothing escalates instead of parking forever', () => {
  it('an empty planningDecomposition escalates, naming planner_returned_no_work', async () => {
    const { ticketService, queueManager } = buildQueueManager([
      { selectedAgentId: 'agent-worker-1', planningDecomposition: [] },
    ]);
    const ticket = await createRootTicket(ticketService, 'nothing came back');

    await dispatchTicket(queueManager, ticket);

    const stored = await ticketService.getTicket(ticket.ticketId);
    const metadata = (stored?.metadata ?? {}) as Record<string, unknown>;
    expect(stored?.status, 'an empty plan used to park at approval_required with no exit').toBe('escalated');
    expect(metadata.reason).toBe('planner_returned_no_work');
    expect(Object.keys(ESCALATION_REASONS), 'the reason is outside the closed vocabulary')
      .toContain(String(metadata.reason));
    expect(metadata.nextAction).toBe('operator_review_plan');
  });

  it('a plan that DID produce work units is untouched — the change cannot degenerate into always-escalate', async () => {
    const { ticketService, queueManager } = buildQueueManager([
      {
        selectedAgentId: 'agent-worker-1',
        planningDecomposition: [{ title: 'a real work unit', description: 'do the thing' }],
      },
    ]);
    const ticket = await createRootTicket(ticketService, 'a plan with work in it');

    await dispatchTicket(queueManager, ticket);

    const stored = await ticketService.getTicket(ticket.ticketId);
    expect(stored?.status).not.toBe('escalated');
  });
});

describe('the two reason vocabularies stay disjoint', () => {
  it('no reason string means both "held for approval" and "escalated"', () => {
    // CKR-16 is the entry about one word carrying five meanings. A reason that appears in both
    // tables would be exactly that defect, and it is the shape this change could have created:
    // planner_returned_no_work moved from one table to the other.
    const shared = Object.keys(ESCALATION_REASONS)
      .filter((reason) => reason in APPROVAL_REQUIRED_REASONS);
    expect(shared, 'a reason that means two different statuses').toEqual([]);
  });

  it('planner_returned_no_work is an escalation reason now, and only that', () => {
    expect(Object.keys(ESCALATION_REASONS)).toContain('planner_returned_no_work');
    expect(Object.keys(APPROVAL_REQUIRED_REASONS)).not.toContain('planner_returned_no_work');
  });
});

/**
 * @description Builds a QueueManagerService over an in-memory store with the swarm pipeline
 * doubled at its own seam — the LLM boundary — and everything else real. Pipeline deps are
 * present because the empty-decomposition branch is guarded on them; the task-folder writes are
 * the only thing stubbed inside them, since this spec is about the ticket's status, not its files.
 * @param processed - What the doubled pipeline returns for the single work item.
 * @returns The ticket service and the queue manager under test.
 */
function buildQueueManager(
  processed: Array<Record<string, unknown>>,
): { ticketService: TicketService; queueManager: QueueManagerService } {
  const ticketService = new TicketService(new InMemoryTicketStore());
  const swarmProcessingService = {
    async getRuntimeReadiness() { return { ready: true }; },
    async processTickets() { return { processedCount: processed.length, processed }; },
  } as never;
  const pipelineDeps = {
    taskFolderService: {
      createTaskFolder: () => '/tmp/cv3-fixture',
      getFolderPath: () => '/tmp/cv3-fixture',
      updateMeta() { /* no disk in a unit spec */ },
      writeBotContext() { /* no disk in a unit spec */ },
      writeDeliverable() { /* no disk in a unit spec */ },
      writeHandover() { /* no disk in a unit spec */ },
      appendRoutingDecision() { /* no disk in a unit spec */ },
    },
    resolveAgentIdByName: async () => undefined,
  } as never;
  const queueManager = new QueueManagerService(ticketService, swarmProcessingService, pipelineDeps);
  return { ticketService, queueManager };
}

/**
 * @description Creates a root (parentless) build ticket already approved, which is the state the
 * poll cycle dispatches from.
 * @param ticketService - The service backing the spec.
 * @param title - Ticket title.
 * @returns The created ticket.
 */
async function createRootTicket(ticketService: TicketService, title: string): Promise<InternalTicket> {
  return ticketService.createTicket({
    title, ticketType: 'build', description: `${title} — CV-3 fixture.`,
    status: 'approved', metadata: {},
  });
}

/**
 * @description Invokes the queue manager's private dispatchTicket — the real swarm/build path.
 * @param queueManager - Service under test.
 * @param ticket - The approved ticket to dispatch.
 * @returns Resolves when the dispatch pass finishes.
 */
async function dispatchTicket(queueManager: QueueManagerService, ticket: InternalTicket): Promise<void> {
  await (queueManager as unknown as { dispatchTicket(t: InternalTicket): Promise<void> }).dispatchTicket(ticket);
}
