/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical ticket-state projection logic for lifecycle-driven Plane updates
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Realigned lifecycle projection with legacy queue-manager planning, execution, testing, and delivery semantics
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Updated cycle names from 5-cycle to 7-phase lifecycle model
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Aligned fully completed swarm lifecycle projection with canonical complete terminal state
 */

import type { ExternalWorkItem, OshalTicketState } from '@/entities/ticket';
import type { SwarmTicketCycle, SwarmTicketLifecycleSnapshot } from './ticket-cycle-state-machine';
import type { TicketWritebackStatus } from './ticket-writeback-adapter';

/**
 * @description Resolves canonical OSHAL ticket-state projections from orchestration lifecycle events.
 */
export class TicketStateProjectionService {
  /**
   * @description Projects an optional target ticket state for a lifecycle update.
   * @param item - Ticket being processed
   * @param cycle - Lifecycle cycle emitting the update
   * @param status - Lifecycle status for the update
   * @param lifecycle - Current lifecycle snapshot
   * @returns Canonical target state or null when no state transition should occur
   */
  project(
    item: ExternalWorkItem,
    cycle: SwarmTicketCycle,
    status: TicketWritebackStatus,
    lifecycle: SwarmTicketLifecycleSnapshot,
  ): OshalTicketState | null {
    if (status === 'failed') {
      return 'escalated';
    }

    if (shouldApproveTicket(item.workflow.stateKey, cycle, status)) {
      return 'approved';
    }

    if (isDesignCycle(cycle) && isProjectedInProcessStatus(status)) {
      return 'in_process_discovery';
    }

    if (cycle === 'execution' && status === 'in_progress') {
      return 'in_process_build';
    }

    if (cycle === 'execution' && status === 'completed') {
      return 'in_process_test';
    }

    if (shouldMoveToRelease(cycle, status, lifecycle)) {
      return 'in_process_release';
    }

    return null;
  }

  /**
   * @description Projects the final complete state after lifecycle completion.
   * @param lifecycle - Final lifecycle snapshot
   * @returns Canonical terminal state or null when the lifecycle is still active
   */
  projectFinalState(lifecycle: SwarmTicketLifecycleSnapshot): OshalTicketState | null {
    if (lifecycle.overallStatus !== 'completed') {
      return null;
    }

    return 'complete';
  }
}

/**
 * @description Returns whether intake completion should approve a backlog ticket.
 */
function shouldApproveTicket(
  state: OshalTicketState,
  cycle: SwarmTicketCycle,
  status: TicketWritebackStatus,
): boolean {
  return cycle === 'intake' && status === 'completed' && state === 'backlog';
}

/**
 * @description Returns whether a lifecycle cycle represents planning or design work.
 */
function isDesignCycle(cycle: SwarmTicketCycle): boolean {
  return cycle === 'planning' || cycle === 'specialist_input';
}

/**
 * @description Returns whether a lifecycle status should project into an in-process state.
 */
function isProjectedInProcessStatus(status: TicketWritebackStatus): boolean {
  return status === 'in_progress' || status === 'completed';
}

/**
 * @description Returns whether delivery completion should enter release packaging.
 */
function shouldMoveToRelease(
  cycle: SwarmTicketCycle,
  status: TicketWritebackStatus,
  lifecycle: SwarmTicketLifecycleSnapshot,
): boolean {
  return cycle === 'delivery' &&
    status === 'completed' &&
    lifecycle.overallStatus === 'completed';
}
