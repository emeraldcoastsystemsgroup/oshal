/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Generic "create a workflow ticket on a
 *   schedule" dispatch branch. A schedule whose taskType is `workflow:<ticketType>`
 *   does ONE thing each fire: create a ticket of <ticketType>. The queue-manager
 *   promotes it (autoStart workflows) and the workflow engine runs the stages.
 *   This is the cron→ticket trigger for authored workflows (e.g. daily-trade-recap),
 *   keeping the cron's job tiny and the workflow in charge of the actual work.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Preserve the unique active verified owner namespace on schedule-born tickets and refuse unresolved owners before creation.
 */

import type { AppContext } from './composition-root';
import type { ScheduleDispatchResult, ScheduleRecord } from '@/features/scheduling';
import { createChildLogger } from '@/shared/logger';
import { PrincipalDirectoryStore } from '@/features/principal-directory';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';

const logger = createChildLogger({ module: 'workflow-ticket-schedule' });

const PREFIX = 'workflow:';

/** A schedule whose only job is to create a workflow ticket. taskType = `workflow:<ticketType>`. */
export function isWorkflowTicketSchedule(taskType: string): boolean {
  return typeof taskType === 'string' && taskType.startsWith(PREFIX);
}

/**
 * @description Create a ticket of the embedded workflow ticketType. autoStart workflows
 * self-promote backlog→approved on the next poll, then the graph engine dispatches stages.
 */
export async function dispatchWorkflowTicketSchedule(
  ctx: AppContext,
  schedule: ScheduleRecord,
): Promise<ScheduleDispatchResult> {
  const ticketType = schedule.taskType.slice(PREFIX.length).trim();
  if (!ticketType) {
    return { success: false, scheduleId: schedule.id, error: 'workflow schedule missing ticketType after "workflow:"' };
  }

  const taskData = (schedule.taskData ?? {}) as Record<string, unknown>;
  const prompt = typeof taskData.prompt === 'string' ? taskData.prompt : '';
  const titleRaw = typeof taskData.title === 'string' && taskData.title.trim() ? taskData.title.trim() : ticketType;
  const firedAt = new Date().toISOString();

  try {
    // Legacy schedules persisted only a subject. Never guess a provider or choose
    // among colliding namespaces, including a previously disabled namespace.
    const owner = schedule.ownerSub
      ? await new PrincipalDirectoryStore(ctx.pool).getUniqueActiveBySub(schedule.ownerSub)
      : null;
    if (schedule.ownerSub && !owner) {
      return { success: false, scheduleId: schedule.id,
        error: 'Workflow schedule requires an unambiguous active verified owner principal' };
    }
    const ticket = await ctx.ticketService.createTicket({
      title: `${titleRaw} — scheduled ${firedAt.slice(0, 10)}`,
      ticketType,
      description: prompt,
      status: 'backlog', // autoStart workflows promote to approved on the next poll cycle
      priority: 'medium',
      labels: [],
      workspaceId: null,
      assignedAgentId: null,
      parentTicketId: null,
      externalProvider: null,
      externalId: null,
      externalUrl: null,
      ownerSub: schedule.ownerSub ?? null,
      metadata: { source: 'schedule', scheduleId: schedule.id, firedAt, workflowTrigger: true, ticketType,
        ...(owner ? { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: owner.issuer } : {}),
      },
    });
    logger.info({ scheduleId: schedule.id, ticketId: ticket.ticketId, ticketType }, 'Workflow ticket created by schedule');
    return { success: true, scheduleId: schedule.id, taskId: ticket.ticketId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, scheduleId: schedule.id, ticketType }, 'Failed to create workflow ticket from schedule');
    return { success: false, scheduleId: schedule.id, error: msg };
  }
}
