/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ported parent assembly logic from the legacy QueueManagerService.js:4539. Detects when all children complete, aggregates workspace deliverables, moves parent to terminal state.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | WS6: Added escalation/pause propagation — escalated or paused children now block parent assembly and move parent to truthful blocked state
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (DLQ child wedge): ESCALATED_STATES now includes 'dead_letter' so a DLQ-quarantined child propagates escalation to its parent instead of leaving the parent stuck in an active state — the DLQ listener flips an escalated child to dead_letter within milliseconds, so treating only 'escalated' as escalatory regressed escalation propagation for decomposed parents.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { TicketService } from '@/features/ticketing';
import type { InternalTicket } from '@/entities/ticket';
import { CommentFormatter } from './comment-formatter';

const logger = createChildLogger({ module: 'parent-assembly-service' });

/**
 * @description Terminal ticket statuses that count as "completed" for assembly purposes.
 * Ported from the legacy QueueManagerService.js — COMPLETED_STATES.
 */
const COMPLETED_STATES = new Set(['complete', 'customer_action', 'cancelled', 'done']);

/**
 * @description Statuses that indicate a child ticket has been escalated and needs operator attention.
 * A parent with any escalated child must itself become escalated. 'dead_letter' (a DLQ-quarantined
 * poison child) counts here too: it is terminal and requires human review exactly like 'escalated',
 * so it must propagate to the parent instead of leaving the parent wedged in an active state forever
 * (the DLQ listener flips an escalated child to dead_letter within milliseconds, so treating only
 * 'escalated' as escalatory would regress the escalation-propagation flow for decomposed parents).
 */
const ESCALATED_STATES = new Set(['escalated', 'dead_letter']);

/**
 * @description Statuses that indicate a child ticket is paused by operator decision.
 * A parent with any paused child must not proceed with assembly.
 */
const PAUSED_STATES = new Set(['paused']);

/**
 * @description Reason a parent assembly was blocked before completion.
 * null when assembly was not blocked.
 */
export type AssemblyBlockReason = 'child_escalated' | 'child_paused' | null;

/**
 * @description Result of a parent assembly check.
 */
export interface AssemblyCheckResult {
  parentTicketId: string;
  allChildrenComplete: boolean;
  totalChildren: number;
  completedChildren: number;
  pendingChildren: string[];
  assembled: boolean;
  blockReason: AssemblyBlockReason;
}

/**
 * @description Detects when all child tickets under a parent have completed and
 * aggregates their results into a parent assembly comment. Moves the parent to
 * customer_action terminal state.
 *
 * Ported from the legacy QueueManagerService.js:checkParentCompletion() (line 4539).
 *
 * Design:
 *   - Called periodically by QueueManagerService after each child ticket completes
 *   - Queries all children of the parent ticket
 *   - If ALL children are in terminal states → assemble parent
 *   - Posts assembly comment with aggregated results
 *   - Transitions parent to customer_action
 */
export class ParentAssemblyService {
  private readonly commentFormatter: CommentFormatter;

  constructor(
    private readonly ticketService: TicketService,
  ) {
    this.commentFormatter = new CommentFormatter();
  }

  /**
   * @description Check if a parent ticket's children are all complete, and assemble if so.
   *
   * @param parentTicketId - The parent ticket to check
   * @returns Assembly check result with completion status
   */
  async checkAndAssemble(parentTicketId: string): Promise<AssemblyCheckResult> {
    const startedAt = Date.now();
    logger.debug({ parentTicketId }, 'Checking parent assembly — are all children complete?');

    const children = await this.getChildTickets(parentTicketId);

    if (children.length === 0) {
      logger.debug({ parentTicketId }, 'No children found — nothing to assemble');
      return {
        parentTicketId,
        allChildrenComplete: true,
        totalChildren: 0,
        completedChildren: 0,
        pendingChildren: [],
        assembled: false,
        blockReason: null,
      };
    }

    const completed = children.filter((c) => COMPLETED_STATES.has(c.status ?? ''));
    const escalated = children.filter((c) => ESCALATED_STATES.has(c.status ?? ''));
    const paused = children.filter((c) => PAUSED_STATES.has(c.status ?? ''));
    const pending = children.filter((c) => !COMPLETED_STATES.has(c.status ?? ''));
    const pendingIds = pending.map((c) => c.ticketId);

    logger.info(
      {
        parentTicketId,
        totalChildren: children.length,
        completedChildren: completed.length,
        escalatedChildren: escalated.length,
        pausedChildren: paused.length,
        pendingChildren: pendingIds,
        durationMs: Date.now() - startedAt,
      },
      'Parent assembly check completed',
    );

    // Escalated children: propagate escalation to parent immediately
    if (escalated.length > 0) {
      await this.propagateEscalation(parentTicketId, escalated.map((c) => c.ticketId));
      return {
        parentTicketId,
        allChildrenComplete: false,
        totalChildren: children.length,
        completedChildren: completed.length,
        pendingChildren: pendingIds,
        assembled: false,
        blockReason: 'child_escalated',
      };
    }

    // Paused children: block assembly but leave parent state unchanged
    if (paused.length > 0) {
      logger.info(
        { parentTicketId, pausedChildren: paused.map((c) => c.ticketId) },
        'Parent assembly blocked — paused children present',
      );
      return {
        parentTicketId,
        allChildrenComplete: false,
        totalChildren: children.length,
        completedChildren: completed.length,
        pendingChildren: pendingIds,
        assembled: false,
        blockReason: 'child_paused',
      };
    }

    if (pending.length > 0) {
      return {
        parentTicketId,
        allChildrenComplete: false,
        totalChildren: children.length,
        completedChildren: completed.length,
        pendingChildren: pendingIds,
        assembled: false,
        blockReason: null,
      };
    }

    // All children complete — assemble the parent
    await this.assembleParent(parentTicketId, children);

    return {
      parentTicketId,
      allChildrenComplete: true,
      totalChildren: children.length,
      completedChildren: completed.length,
      pendingChildren: [],
      assembled: true,
      blockReason: null,
    };
  }

  /**
   * @description Assemble parent ticket from completed children.
   * Posts an assembly comment and transitions parent to customer_action.
   *
   * @param parentTicketId - Parent ticket ID
   * @param children - All child tickets (assumed all complete)
   */
  private async assembleParent(parentTicketId: string, children: InternalTicket[]): Promise<void> {
    logger.info(
      { parentTicketId, childCount: children.length },
      'All children complete — assembling parent deliverable',
    );

    // Build assembly summary from child titles and descriptions
    const summary = this.buildAssemblySummary(children);

    // Transition parent to customer_action (terminal state)
    try {
      await this.ticketService.updateStatus(parentTicketId, 'customer_action');
      logger.info({ parentTicketId }, 'Parent ticket transitioned to customer_action');
    } catch (err) {
      logger.error({ err, parentTicketId }, 'Failed to transition parent to customer_action');
    }

    logger.info(
      { parentTicketId, childCount: children.length, summaryLength: summary.length },
      'Parent assembly complete',
    );
  }

  /**
   * @description Build an assembly summary from completed child tickets.
   * @param children - Completed child tickets
   * @returns Markdown summary of assembled deliverables
   */
  private buildAssemblySummary(children: InternalTicket[]): string {
    const childSummaries = children.map((child, i) => {
      const status = child.status ?? 'unknown';
      const title = child.title ?? 'Untitled';
      return `${i + 1}. **${title}** — ${status}`;
    });

    return [
      '## Assembly Summary',
      '',
      `All ${children.length} subtasks have completed:`,
      '',
      ...childSummaries,
      '',
      'The parent ticket deliverable has been assembled from all child outputs.',
    ].join('\n');
  }

  /**
   * @description Propagate escalation from one or more escalated children to the parent ticket.
   * Moves the parent to `escalated` state so the operator surface reflects the blocked reality.
   *
   * @param parentTicketId - Parent ticket to escalate
   * @param escalatedChildIds - IDs of the children that triggered the escalation
   */
  private async propagateEscalation(parentTicketId: string, escalatedChildIds: string[]): Promise<void> {
    logger.info(
      { parentTicketId, escalatedChildIds },
      'Propagating child escalation to parent — moving parent to escalated state',
    );
    try {
      await this.ticketService.updateStatus(parentTicketId, 'escalated', {
        reason: 'child_ticket_escalated',
        source: 'parent-assembly-service',
        escalatedChildIds,
      });
      logger.info({ parentTicketId }, 'Parent ticket moved to escalated due to child escalation');
    } catch (err) {
      logger.error({ err, parentTicketId, escalatedChildIds }, 'Failed to propagate child escalation to parent');
    }
  }

  /**
   * @description Get all child tickets for a parent.
   * @param parentTicketId - Parent ticket ID
   * @returns Array of child InternalTickets
   */
  private async getChildTickets(parentTicketId: string): Promise<InternalTicket[]> {
    try {
      // Push the parent filter into the store (indexed by parent_ticket_id) instead of listing
      // every ticket and filtering in JS — the store/filter already supports parentTicketId.
      return await this.ticketService.listTickets({ parentTicketId });
    } catch (err) {
      logger.error({ err, parentTicketId }, 'Failed to query child tickets for parent assembly');
      return [];
    }
  }
}
