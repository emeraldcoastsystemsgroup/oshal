/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the child dispatch gate (queue-manager-sweeps.ts). Runs the real isDispatchBlockedByParentState over the real TicketService transition table and the real ParentAssemblyService, on the in-memory ticket store. Proves siblings are released one at a time in planning order (including while an earlier sibling is still in flight), that a child owned by someone other than its parent's owner is cancelled and never escalates the parent, that unordered children are not held, and that an escalated earlier sibling parks the waiting child through the parent.
 */

import { describe, expect, it } from 'vitest';
import { CreateInternalTicketSchema, type OshalTicketState } from '../../src/entities/ticket';
import type { InternalTicket } from '../../src/entities/ticket/internal-ticket';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';
import { TicketService } from '../../src/features/ticketing/services/ticket-service';
import { ParentAssemblyService } from '../../src/features/swarm-orchestration/services/parent-assembly-service';
import {
  isDispatchBlockedByParentState,
  type QueueSweepDeps,
} from '../../src/features/swarm-orchestration/services/queue-manager-sweeps';

const OWNER = 'gate-owner-sub';
const OTHER = 'gate-other-sub';

/** The real gate over the real ticket service and assembly, on the in-memory store. */
function setup() {
  const ticketService = new TicketService(new InMemoryTicketStore());
  const activeTicketIds = new Set<string>();
  const deps: QueueSweepDeps = {
    ticketService,
    parentAssemblyService: new ParentAssemblyService(ticketService),
    activeTicketIds,
    recoveredTicketIds: new Set(),
    dispatchCounts: new Map(),
    swarmProcessingService: { getRuntimeReadiness: async () => ({ ready: true }) } as never,
  };
  return { ticketService, deps, activeTicketIds };
}

/**
 * @description A planned root parked at approval_required and its children, as planning leaves them.
 * @param ticketService - The ticket service.
 * @param children - Each child's status, owner and planning index (null for none).
 * @returns The parent and the children in the given order.
 */
async function family(
  ticketService: TicketService,
  children: Array<{ status: OshalTicketState; ownerSub?: string; subtaskIndex: number | null }>,
): Promise<{ parent: InternalTicket; kids: InternalTicket[] }> {
  const parent = await ticketService.createTicket(CreateInternalTicketSchema.parse({
    title: 'Planned root', description: 'root', ticketType: 'build', status: 'approval_required', ownerSub: OWNER, metadata: {},
  }));
  const kids: InternalTicket[] = [];
  for (const [i, child] of children.entries()) {
    kids.push(await ticketService.createTicket(CreateInternalTicketSchema.parse({
      title: `Subtask ${i + 1}`, description: 'child', ticketType: 'build', status: child.status,
      parentTicketId: parent.ticketId, ownerSub: child.ownerSub ?? OWNER,
      metadata: child.subtaskIndex === null ? { depth: 1 } : { depth: 1, subtaskIndex: child.subtaskIndex, subtaskCount: children.length },
    })));
  }
  return { parent, kids };
}

async function statusOf(ticketService: TicketService, ticketId: string) {
  return (await ticketService.getTicket(ticketId))?.status;
}

describe('build child dispatch gate: owner continuity and one sibling at a time', () => {
  it.each(['approved', 'in_process_build'] as const)('holds child 2 while child 1 is %s', async (firstStatus) => {
    const { ticketService, deps } = setup();
    const { kids } = await family(ticketService, [
      { status: firstStatus, subtaskIndex: 1 }, { status: 'approved', subtaskIndex: 2 },
    ]);
    expect(await isDispatchBlockedByParentState(kids[0], deps)).toBe(false);
    expect(await isDispatchBlockedByParentState(kids[1], deps)).toBe(true);
    expect(await statusOf(ticketService, kids[1].ticketId)).toBe('approved');
  });

  it('holds child 2 while child 1 reads complete but is still in flight', async () => {
    const { ticketService, deps, activeTicketIds } = setup();
    const { kids } = await family(ticketService, [
      { status: 'complete', subtaskIndex: 1 }, { status: 'approved', subtaskIndex: 2 },
    ]);
    activeTicketIds.add(kids[0].ticketId);
    expect(await isDispatchBlockedByParentState(kids[1], deps)).toBe(true);
  });

  it('releases child 2 once child 1 is complete and no longer in flight', async () => {
    const { ticketService, deps } = setup();
    const { kids } = await family(ticketService, [
      { status: 'complete', subtaskIndex: 1 }, { status: 'approved', subtaskIndex: 2 },
    ]);
    expect(await isDispatchBlockedByParentState(kids[1], deps)).toBe(false);
  });

  it('cancels a child owned by someone else, never dispatches it, and does not escalate the parent', async () => {
    const { ticketService, deps } = setup();
    const { parent, kids } = await family(ticketService, [
      { status: 'complete', subtaskIndex: 1 }, { status: 'approved', ownerSub: OTHER, subtaskIndex: 2 },
    ]);
    expect(await isDispatchBlockedByParentState(kids[1], deps)).toBe(true);
    const foreign = await ticketService.getTicket(kids[1].ticketId);
    expect(foreign?.status).toBe('cancelled');
    expect(JSON.stringify(foreign?.metadata)).toContain('child_owner_mismatch');

    await deps.parentAssemblyService.checkAndAssemble(parent.ticketId);
    expect(await statusOf(ticketService, parent.ticketId)).not.toBe('escalated');
  });

  it('does not hold children that carry no planning order', async () => {
    const { ticketService, deps } = setup();
    const { kids } = await family(ticketService, [
      { status: 'in_process_build', subtaskIndex: null }, { status: 'approved', subtaskIndex: null },
    ]);
    expect(await isDispatchBlockedByParentState(kids[1], deps)).toBe(false);
  });

  it('an escalated earlier sibling escalates the parent, and the waiting child is then parked', async () => {
    const { ticketService, deps } = setup();
    const { parent, kids } = await family(ticketService, [
      { status: 'escalated', subtaskIndex: 1 }, { status: 'approved', subtaskIndex: 2 },
    ]);
    expect(await isDispatchBlockedByParentState(kids[1], deps)).toBe(true);

    await deps.parentAssemblyService.checkAndAssemble(parent.ticketId);
    expect(await statusOf(ticketService, parent.ticketId)).toBe('escalated');
    expect(await isDispatchBlockedByParentState(kids[1], deps)).toBe(true);
    expect(await statusOf(ticketService, kids[1].ticketId)).toBe('escalated');
  });
});
