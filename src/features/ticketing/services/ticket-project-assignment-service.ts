/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added root-ticket project assignment service so project moves propagate across descendant tickets and linked tasks without changing shared workspace ownership
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized historical Change Log attribution to the mandated project author identifier
 */

import type { InternalTicket } from '@/entities/ticket';
import {
  type CanonicalTicketProject,
  type TicketProjectAssignmentInput,
  mergeTicketProjectMetadata,
  resolveCanonicalTicketProject,
} from '@/entities/ticket';
import type { ITaskStore } from '@/entities/task';
import type { StoredTask } from '@/shared/types';
import { createChildLogger } from '@/shared/logger';
import type { TicketService } from './ticket-service';

const logger = createChildLogger({ module: 'ticket-project-assignment-service' });

/**
 * @description Result payload describing one completed root-ticket project move.
 */
export interface TicketProjectAssignmentResult {
  project: CanonicalTicketProject;
  rootTicketId: string;
  updatedTicketIds: string[];
  updatedTaskIds: string[];
  preservedWorkspaceId: string | null;
}

/**
 * @description Coordinates root-ticket project ownership changes across descendant tickets and linked tasks.
 */
export class TicketProjectAssignmentService {
  constructor(
    private readonly ticketService: TicketService,
    private readonly taskStore: ITaskStore,
  ) {}

  /**
   * @description Moves a root ticket and its descendant tree into a canonical project bucket while preserving the shared workspace link.
   * @param ticketId - Root ticket identifier.
   * @param input - Target project assignment input.
   * @returns Summary of the applied project move.
   */
  async moveRootTicketToProject(
    ticketId: string,
    input: TicketProjectAssignmentInput,
  ): Promise<TicketProjectAssignmentResult> {
    const startedAt = Date.now();
    logger.info({ ticketId, input }, 'Root-ticket project move requested');

    const rootTicket = await this.requireRootTicket(ticketId);
    const project = resolveCanonicalTicketProject(input);
    const tickets = await this.collectTicketTree(rootTicket.ticketId);
    const updatedTicketIds = await this.updateTicketsForProject(tickets, project);
    const updatedTaskIds = await this.updateLinkedTasksForProject(tickets, project);

    logger.info({
      ticketId,
      projectId: project.projectId,
      updatedTicketCount: updatedTicketIds.length,
      updatedTaskCount: updatedTaskIds.length,
      durationMs: Date.now() - startedAt,
    }, 'Root-ticket project move completed');

    return {
      project,
      rootTicketId: rootTicket.ticketId,
      updatedTicketIds,
      updatedTaskIds,
      preservedWorkspaceId: rootTicket.workspaceId,
    };
  }

  private async requireRootTicket(ticketId: string): Promise<InternalTicket> {
    const ticket = await this.ticketService.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    if (ticket.parentTicketId) {
      throw new Error('Only root tickets can move projects');
    }
    return ticket;
  }

  private async collectTicketTree(rootTicketId: string): Promise<InternalTicket[]> {
    const tickets: InternalTicket[] = [];
    const queue = [rootTicketId];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId || seen.has(currentId)) {
        continue;
      }
      seen.add(currentId);

      const current = await this.ticketService.getTicket(currentId);
      if (!current) {
        continue;
      }
      tickets.push(current);

      const children = await this.ticketService.listTickets({ parentTicketId: current.ticketId, limit: 500 });
      children.forEach((child) => {
        if (!seen.has(child.ticketId)) {
          queue.push(child.ticketId);
        }
      });
    }

    return tickets;
  }

  private async updateTicketsForProject(
    tickets: InternalTicket[],
    project: CanonicalTicketProject,
  ): Promise<string[]> {
    const updatedTicketIds: string[] = [];

    for (const ticket of tickets) {
      await this.ticketService.updateTicket(ticket.ticketId, {
        metadata: mergeTicketProjectMetadata(ticket.metadata, project),
      });
      updatedTicketIds.push(ticket.ticketId);
    }

    return updatedTicketIds;
  }

  private async updateLinkedTasksForProject(
    tickets: InternalTicket[],
    project: CanonicalTicketProject,
  ): Promise<string[]> {
    const updatedTaskIds: string[] = [];
    const seenTaskIds = new Set<string>();

    for (const ticket of tickets) {
      const links = await this.ticketService.getTasksForTicket(ticket.ticketId);
      for (const link of links) {
        if (!link.taskId || seenTaskIds.has(link.taskId)) {
          continue;
        }
        seenTaskIds.add(link.taskId);
        const task = await this.taskStore.get(link.taskId);
        if (!task) {
          logger.warn({ ticketId: ticket.ticketId, taskId: link.taskId }, 'Linked task missing during project propagation');
          continue;
        }
        await this.taskStore.replace(this.buildUpdatedTask(task, project));
        updatedTaskIds.push(link.taskId);
      }
    }

    return updatedTaskIds;
  }

  private buildUpdatedTask(task: StoredTask, project: CanonicalTicketProject): StoredTask {
    return {
      ...task,
      metadata: mergeTicketProjectMetadata(task.metadata || {}, project),
      updatedAt: new Date().toISOString(),
    };
  }
}
