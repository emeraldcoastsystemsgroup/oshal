/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from queue-manager-service.ts (1000-line cap decomposition): the poll-cycle sweep/recovery loops — auto-start backlog promotion, parent-state dispatch gate, stale-parent assembly sweep, deferred/orphaned ticket recovery, and child-ticket reconciliation from terminal work-items. Free functions with an explicit QueueSweepDeps interface (mirrors the dispatch-manifest-worker pattern) so QueueManagerService keeps thin private delegators and its unit-test surface. terminalChildStatusForParentState is re-exported through queue-manager-service for back-compat.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Queue DLQ: a dead_letter parent parks its approved children in 'escalated' (same treatment as an escalated parent) so quarantining a poison root doesn't leave dispatchable orphans.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (DLQ child wedge): the orphan-sweep allTerminal predicate now counts 'dead_letter' as terminal, so a parent whose children are all terminal (including a quarantined child) triggers assembly/escalation-propagation instead of wedging in an active state with no recovery sweep.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Kept GitHub request-only intake tickets in backlog even when their ticket type maps to an auto-start workflow.
 */

import { type OshalTicketState, type InternalTicket } from '@/entities/ticket';
import type { TicketService } from '@/features/ticketing';
import type { WorkItemRepository } from '@/entities/work-item';
import { createChildLogger } from '@/shared/logger';
import type { ParentAssemblyService } from './parent-assembly-service';
import type { SwarmTicketProcessingService } from './swarm-ticket-processing-service';
import { MAX_DISPATCH_ATTEMPTS } from './queue-manager-dispatch-helpers';

const logger = createChildLogger({ module: 'queue-manager-sweeps' });

const PARENT_READY_FOR_CHILD_DISPATCH_STATES = new Set<OshalTicketState>([
  'in_process_build',
  'in_process_deploy',
  'in_process_test',
  'in_process_release',
  'customer_action',
  'complete',
  'approval_required',
  'approved',
]);

const WORK_ITEM_RECONCILABLE_CHILD_STATES = new Set<OshalTicketState>([
  'approved',
  'in_process_discovery',
  'in_process_design',
  'in_process_build',
  'in_process_deploy',
  'in_process_test',
  'in_process_release',
  'customer_action',
]);

const ACTIVE_WORK_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'executing',
  'in-progress',
  'subtask-pending',
  'subtask-assigned',
  'subtask-executing',
  'routing_failed',
]);

function isGitHubRequestOnlyTicket(ticket: InternalTicket): boolean {
  const githubTicket = ticket.metadata.githubTicket;
  return githubTicket !== null
    && typeof githubTicket === 'object'
    && (githubTicket as Record<string, unknown>).requestMode === 'request-only';
}

/**
 * @description Maps a terminal parent ticket state to the terminal state its approved
 * children should be parked in (escalated/cancelled), or null when the parent state
 * is not terminal for children.
 * @param parentStatus - Current parent ticket state.
 * @returns The terminal child state, or null.
 */
export function terminalChildStatusForParentState(parentStatus: OshalTicketState): OshalTicketState | null {
  if (parentStatus === 'escalated') return 'escalated';
  // A DLQ-quarantined parent is poison — its children must not keep dispatching. They park
  // as 'escalated' (operator-review), NOT dead_letter: only the DeadLetterService's own
  // attempt policy may quarantine, so the DLQ view stays a truthful per-ticket record.
  if (parentStatus === 'dead_letter') return 'escalated';
  if (parentStatus === 'cancelled') return 'cancelled';
  return null;
}

function hasTerminalWorkItemResult(item: WorkItemTerminalSnapshot): boolean {
  return (isCompletedWorkItemResult(item) || isFailedWorkItemResult(item))
    && item.executionOutput != null;
}

function isCompletedWorkItemResult(item: WorkItemTerminalSnapshot): boolean {
  return item.status === 'completed' || item.status === 'subtask-completed';
}

function isFailedWorkItemResult(item: WorkItemTerminalSnapshot): boolean {
  return item.status === 'failed' || item.status === 'subtask-failed' || item.status === 'escalated';
}

function hasExhaustedRoutingFailure(item: WorkItemTerminalSnapshot): boolean {
  const metadata = item.metadata && typeof item.metadata === 'object'
    ? item.metadata as Record<string, unknown>
    : {};
  return item.status === 'routing_failed' && metadata.routingRetryExhausted === true;
}

interface WorkItemTerminalSnapshot {
  workItemId: string;
  status: string;
  executionOutput?: unknown;
  metadata?: unknown;
}

/**
 * @description Queue-manager state and services the sweep loops operate on.
 * Lifted to an explicit interface so QueueManagerService doesn't expose its
 * private state to free functions (same pattern as ManifestWorkerDispatchDeps).
 */
export interface QueueSweepDeps {
  /** Persistent ticket store used to query and transition tickets. */
  ticketService: TicketService;
  /** Parent-assembly checker invoked when children reach terminal states. */
  parentAssemblyService: ParentAssemblyService;
  /** Optional work-item repository for terminal-state reconciliation. */
  workItemRepository?: WorkItemRepository;
  /** In-flight dispatch tracking — caller's own Set, read by the sweeps. */
  activeTicketIds: Set<string>;
  /** Tickets already recovered by sweepDeferredTickets — prevents bounce loops. Mutated by this module. */
  recoveredTicketIds: Set<string>;
  /** Per-ticket dispatch attempt counts (circuit breaker), read by the sweeps. */
  dispatchCounts: Map<string, number>;
  /** Runtime readiness probe — deferred recovery only runs when the swarm runtime is ready. */
  swarmProcessingService: Pick<SwarmTicketProcessingService, 'getRuntimeReadiness'>;
}

/**
 * @description Promote backlog tickets whose ticketType maps to an auto-start workflow into
 * 'approved', so a published auto-start workflow runs on arrival without a manual approval gate.
 * Skips the backlog query entirely when no auto-start workflow is registered (the common case).
 * Human-in-the-loop for these workflows lives in their graph's approval-gate nodes, not here.
 * GitHub request-only intake is an explicit exception: those tickets remain in backlog for
 * operator triage even when their ticket type also has an auto-start workflow.
 * @param deps - Queue sweep dependencies.
 * @returns Resolves when the sweep completes (failures are logged, never thrown).
 */
export async function sweepAutoStartTickets(deps: QueueSweepDeps): Promise<void> {
  try {
    const { WorkflowPipelineRegistry } = await import('./workflow-pipeline-registry.js');
    const registry = WorkflowPipelineRegistry.getInstance();
    const autoStartTypes = new Set(
      registry.listAll().filter((e) => e.workflow.autoStart === true).map((e) => e.workflow.ticketType),
    );
    if (autoStartTypes.size === 0) return; // nothing to promote — skip the backlog query

    const backlog = await deps.ticketService.listTickets({ status: 'backlog' });
    for (const ticket of backlog) {
      const ticketType = (ticket as Record<string, unknown>).ticketType as string | undefined;
      if (!ticketType || !autoStartTypes.has(ticketType)) continue;
      if (isGitHubRequestOnlyTicket(ticket)) continue;
      try {
        await deps.ticketService.updateStatus(ticket.ticketId, 'approved', {
          reason: 'auto_start_workflow',
          source: 'queue-manager-autostart',
          ticketType,
        });
        logger.info({ ticketId: ticket.ticketId, ticketType }, 'Auto-start workflow — promoted backlog ticket to approved');
      } catch (err) {
        logger.warn({ err, ticketId: ticket.ticketId, ticketType }, 'Failed to auto-approve auto-start ticket');
      }
    }
  } catch (err) {
    logger.error({ err }, 'sweepAutoStartTickets failed — continuing poll');
  }
}

/**
 * @description Blocks approved child tickets from auto-dispatching until the parent
 * has cleared discovery/planning and explicitly entered build.
 * @param ticket - The approved candidate ticket.
 * @param deps - Queue sweep dependencies.
 * @returns True when the child must not dispatch yet (or was parked terminal).
 */
export async function isDispatchBlockedByParentState(ticket: InternalTicket, deps: QueueSweepDeps): Promise<boolean> {
  if (!ticket.parentTicketId) {
    return false;
  }

  const parent = await deps.ticketService.getTicket(ticket.parentTicketId);
  if (!parent) {
    return false;
  }

  if (PARENT_READY_FOR_CHILD_DISPATCH_STATES.has(parent.status)) {
    return false;
  }

  const terminalChildStatus = terminalChildStatusForParentState(parent.status);
  if (terminalChildStatus) {
    logger.warn(
      {
        ticketId: ticket.ticketId,
        parentTicketId: parent.ticketId,
        parentStatus: parent.status,
        childStatus: terminalChildStatus,
      },
      'Approved child ticket is blocked by terminal parent state - parking child',
    );
    await deps.ticketService.updateStatus(ticket.ticketId, terminalChildStatus, {
      reason: 'parent_terminal_state',
      source: 'queue-parent-gate',
      parentTicketId: parent.ticketId,
      parentStatus: parent.status,
    }).catch((err) => {
      logger.error(
        { err, ticketId: ticket.ticketId, parentTicketId: parent.ticketId, childStatus: terminalChildStatus },
        'Failed to park approved child ticket blocked by terminal parent state',
      );
    });
    return true;
  }

  logger.info(
    { ticketId: ticket.ticketId, parentTicketId: parent.ticketId, parentStatus: parent.status },
    'Approved child ticket is waiting on parent build approval',
  );
  return true;
}

/**
 * @description Sweep for parent tickets in active orchestration states whose children are all done.
 * This catches the race condition where assembly ran mid-cycle before the last child committed.
 * @param deps - Queue sweep dependencies.
 * @returns Resolves when the sweep completes (failures are logged, never thrown).
 */
export async function sweepStaleParents(deps: QueueSweepDeps): Promise<void> {
  try {
    const discoveryTickets = await deps.ticketService.listTickets({ status: 'in_process_discovery' });
    const designTickets = await deps.ticketService.listTickets({ status: 'in_process_design' });
    const buildTickets = await deps.ticketService.listTickets({ status: 'in_process_build' });
    // BUG-FIX Session 35: Include approval_required parents — when build gate is opened
    // and children all complete, the parent sits in approval_required and assembly never
    // fired because this query excluded that state.
    const approvalRequiredTickets = await deps.ticketService.listTickets({ status: 'approval_required' });
    const parents = [...discoveryTickets, ...designTickets, ...buildTickets, ...approvalRequiredTickets].filter(
      (t) => !t.parentTicketId,
    );
    for (const parent of parents) {
      await reconcileChildTicketsFromWorkItems(parent.ticketId, deps);
      const result = await deps.parentAssemblyService.checkAndAssemble(parent.ticketId);
      if (result.assembled) {
        logger.info(
          { ticketId: parent.ticketId, childCount: result.totalChildren },
          'Stale parent assembled during sweep',
        );
      } else if (result.blockReason) {
        logger.info(
          { ticketId: parent.ticketId, blockReason: result.blockReason },
          'Stale parent sweep left parent blocked by child state',
        );
      } else if (result.totalChildren > 0 && result.completedChildren > 0) {
        // SP-8: Progressive state — parent shows in_process_build when children are actively executing
        try {
          await deps.ticketService.updateStatus(parent.ticketId, 'in_process_build');
          logger.info(
            { ticketId: parent.ticketId, completed: result.completedChildren, total: result.totalChildren },
            'SP-8: Parent promoted to in_process_build — children actively executing',
          );
        } catch { /* non-fatal — parent state is a projection, not a gate */ }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Parent assembly sweep failed — non-fatal');
  }
}

/**
 * @description Recover tickets stuck in a non-terminal dispatch state that this container isn't actively dispatching.
 * Handles two cases:
 *  1. Runtime was unavailable at dispatch time (original case).
 *  2. Container restarted and lost its in-memory activeTicketIds — tickets orphaned mid-pipeline.
 * Tickets with children that are all complete/escalated get routed to parent assembly.
 * Tickets without children get rolled back to approved for retry.
 * @param deps - Queue sweep dependencies.
 * @returns Resolves when the sweep completes (failures are logged, never thrown).
 */
export async function sweepDeferredTickets(deps: QueueSweepDeps): Promise<void> {
  try {
    const readiness = await deps.swarmProcessingService.getRuntimeReadiness();
    if (!readiness.ready) return; // Runtime still unavailable — don't retry yet

    const discoveryTickets = await deps.ticketService.listTickets({ status: 'in_process_discovery' });
    const designTickets = await deps.ticketService.listTickets({ status: 'in_process_design' });
    const buildTickets = await deps.ticketService.listTickets({ status: 'in_process_build' });
    const stagedTickets = [...discoveryTickets, ...designTickets, ...buildTickets];
    const allTickets = await deps.ticketService.listTickets({});

    // Build parent→children map for assembly check
    const childrenByParent = new Map<string, typeof allTickets>();
    for (const t of allTickets) {
      if (t.parentTicketId) {
        const siblings = childrenByParent.get(t.parentTicketId) ?? [];
        siblings.push(t);
        childrenByParent.set(t.parentTicketId, siblings);
      }
    }

    const SWEEP_GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 minutes — must exceed max PM planning time to avoid premature recovery

    for (const ticket of stagedTickets) {
      if (ticket.parentTicketId) {
        if (deps.activeTicketIds.has(ticket.ticketId)) continue; // Currently being dispatched by THIS container

        const updatedAt = ticket.updatedAt ? new Date(ticket.updatedAt).getTime() : 0;
        if (Date.now() - updatedAt < SWEEP_GRACE_PERIOD_MS) continue;

        if (deps.recoveredTicketIds.has(ticket.ticketId)) continue;

        const attempts = deps.dispatchCounts.get(ticket.ticketId) ?? 0;
        if (attempts >= MAX_DISPATCH_ATTEMPTS) {
          logger.warn({ ticketId: ticket.ticketId, attempts }, 'Deferred child ticket exceeded max attempts â€” escalating');
          await deps.ticketService.updateStatus(ticket.ticketId, 'escalated', {
            reason: 'deferred_child_max_attempts_exceeded',
            source: 'queue-manager-deferred-sweep',
            attempts,
            maxAttempts: MAX_DISPATCH_ATTEMPTS,
            parentTicketId: ticket.parentTicketId,
          });
          continue;
        }

        logger.info(
          { ticketId: ticket.ticketId, attempts, parentTicketId: ticket.parentTicketId },
          'Recovering orphaned child ticket â€” rolling back to approved for retry',
        );
        deps.recoveredTicketIds.add(ticket.ticketId);
        await deps.ticketService.updateStatus(ticket.ticketId, 'approved');
        continue;
      }
      if (ticket.parentTicketId) continue; // Child ticket — handled by parent assembly
      if (deps.activeTicketIds.has(ticket.ticketId)) continue; // Currently being dispatched by THIS container

      // Grace period: don't sweep tickets that entered discovery/planning recently.
      const updatedAt = ticket.updatedAt ? new Date(ticket.updatedAt).getTime() : 0;
      if (Date.now() - updatedAt < SWEEP_GRACE_PERIOD_MS) continue;

      // Check if this ticket has children
      const children = childrenByParent.get(ticket.ticketId) ?? [];
      if (children.length > 0) {
        // Has children — check if they're all terminal (complete/escalated/dead_letter/cancelled).
        // If so, trigger parent assembly. If not, children are still executing — leave alone.
        // 'dead_letter' (a DLQ-quarantined poison child) is terminal: excluding it would let a
        // single quarantined child wedge the parent in an active state with no sweep to recover it.
        const allTerminal = children.every((c) =>
          c.status === 'complete' || c.status === 'escalated'
          || c.status === 'dead_letter' || c.status === 'cancelled',
        );
        if (allTerminal) {
          logger.info(
            { ticketId: ticket.ticketId, childCount: children.length },
            'Orphaned parent with all terminal children — triggering parent assembly',
          );
          await deps.parentAssemblyService.checkAndAssemble(ticket.ticketId);
        }
        // Children still running — skip this ticket, let them finish.
        continue;
      }

      // No children, not active — this ticket is orphaned. Recover it.
      if (deps.recoveredTicketIds.has(ticket.ticketId)) continue; // Already recovered once — avoid bounce loop

      const attempts = deps.dispatchCounts.get(ticket.ticketId) ?? 0;
      if (attempts >= MAX_DISPATCH_ATTEMPTS) {
        logger.warn({ ticketId: ticket.ticketId, attempts }, 'Deferred ticket exceeded max attempts — escalating');
        await deps.ticketService.updateStatus(ticket.ticketId, 'escalated', {
          reason: 'deferred_ticket_max_attempts_exceeded',
          source: 'queue-manager-deferred-sweep',
          attempts,
          maxAttempts: MAX_DISPATCH_ATTEMPTS,
        });
        continue;
      }

      logger.info(
        { ticketId: ticket.ticketId, attempts },
        'Recovering orphaned ticket — rolling back to approved for retry',
      );
      deps.recoveredTicketIds.add(ticket.ticketId);
      await deps.ticketService.updateStatus(ticket.ticketId, 'approved');
    }
  } catch (err) {
    logger.warn({ err }, 'Deferred ticket sweep failed — non-fatal');
  }
}

/**
 * @description Reconciles child ticket lifecycle state from terminal work-items before parent assembly.
 * This closes the gap where a worker persisted execution output but a stale Redis/consumer path
 * skipped the ticket status update, leaving parent assembly waiting on already-finished children.
 * @param parentTicketId - The parent whose children are reconciled.
 * @param deps - Queue sweep dependencies.
 * @returns Count of child tickets whose status was updated.
 */
async function reconcileChildTicketsFromWorkItems(parentTicketId: string, deps: QueueSweepDeps): Promise<number> {
  const repository = deps.workItemRepository;
  if (!repository) {
    return 0;
  }

  const children = await deps.ticketService.listTickets({ parentTicketId });
  let reconciledCount = 0;

  for (const child of children) {
    if (!WORK_ITEM_RECONCILABLE_CHILD_STATES.has(child.status)) {
      continue;
    }

    let workItems: WorkItemTerminalSnapshot[];
    try {
      workItems = await repository.findByExternalIdAnyProvider(child.ticketId) as WorkItemTerminalSnapshot[];
    } catch (error) {
      logger.warn(
        { err: error, ticketId: child.ticketId, parentTicketId },
        'Work-item reconciliation lookup failed for child ticket',
      );
      continue;
    }

    const terminalItems = workItems.filter(hasTerminalWorkItemResult);
    const exhaustedRoutingFailure = workItems.find(hasExhaustedRoutingFailure);
    if (terminalItems.length === 0 && !exhaustedRoutingFailure) {
      continue;
    }

    const hasActiveWork = workItems.some((item) => ACTIVE_WORK_ITEM_STATUSES.has(item.status));
    const failedItem = terminalItems.find(isFailedWorkItemResult) ?? exhaustedRoutingFailure;
    const completedItem = terminalItems.find(isCompletedWorkItemResult);
    const nextStatus: OshalTicketState | null = failedItem
      ? 'escalated'
      : completedItem && !hasActiveWork
        ? 'complete'
        : null;

    if (!nextStatus) {
      continue;
    }

    try {
      await deps.ticketService.updateStatus(child.ticketId, nextStatus, {
        reason: nextStatus === 'complete'
          ? 'work_item_terminal_reconciliation'
          : 'work_item_failure_reconciliation',
        source: 'queue-manager-work-item-reconciliation',
        parentTicketId,
        workItemId: (failedItem ?? completedItem)?.workItemId,
        workItemStatus: (failedItem ?? completedItem)?.status,
      });
      reconciledCount += 1;
      logger.info(
        { ticketId: child.ticketId, parentTicketId, nextStatus },
        'Child ticket reconciled from terminal work-item state',
      );
    } catch (error) {
      logger.warn(
        { err: error, ticketId: child.ticketId, parentTicketId, nextStatus },
        'Failed to reconcile child ticket from work-item state',
      );
    }
  }

  if (reconciledCount > 0) {
    logger.info({ parentTicketId, reconciledCount }, 'Work-item reconciliation updated child tickets');
  }
  return reconciledCount;
}
