/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Authorize each activity contributor before reading messages or aggregating costs.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { InternalTicket } from '@/entities/ticket';
import type { StoredTask } from '@/shared/types';
import { PROTECTED_RESULT_EXECUTIONS, readProtectedResultExecutions } from '@/shared/protected-results';
import { canReadCockpitTask, canReadCockpitTicket, canReadCockpitResult } from './cockpit-resource-access';
import { readTasksForTicket, readTaskMessages, buildTimelineEntry, mapOshalTicketStateToCockpitState,
  readTicketTaskLinks, readRecord, readOptionalString, type collectChildTimelines } from './cockpit-route-helpers';
import { rollupTaskUsage, mergeModelUsageMaps, mergeAgentUsageMaps } from './cockpit-cost-route-helpers';
import { readWorkItemsForInternalTicket, deriveOshalTicketStateFromWorkItems, buildWorkItemTimelineEntries } from './cockpit-work-item-helpers';

/** @description Caller-visible child timeline, metadata and admitted task usage. */
type ChildActivity = Awaited<ReturnType<typeof collectChildTimelines>>;

/** @description Load and admit canonical contributing tasks. @param ctx Runtime. @param req Caller. @param id Ticket. @param preferred Link IDs. @returns Readable canonical tasks. */
export async function readVisibleActivityTasks(ctx: AppContext, req: Request, id: string, preferred: string[] = [id]) {
  const candidates = await readTasksForTicket(ctx, id, preferred);
  const admitted = await Promise.all(candidates.map(async candidate => {
    if (typeof candidate.taskId !== 'string') return null;
    const task = await ctx.taskStore.get(candidate.taskId);
    return task && await canReadCockpitTask(ctx, req, task) ? task : null;
  }));
  return admitted.filter((task): task is NonNullable<typeof task> => task !== null);
}

/** @description Create a bounded empty child rollup. @returns Empty activity. */
export function emptyChildActivity(): ChildActivity {
  return { entries: [], children: [], totalChildCost: 0, totalChildInputTokens: 0,
    totalChildOutputTokens: 0, totalChildTokens: 0, totalChildRequests: 0, usageByModel: {}, usageByAgent: {} };
}

/** @description Merge only admitted task usage into the child rollup. @param result Accumulator. @param tasks Admitted tasks. @returns No value. */
function addUsage(result: ChildActivity, tasks: Awaited<ReturnType<typeof readVisibleActivityTasks>>): void {
  const usage = rollupTaskUsage(tasks);
  result.totalChildCost += usage.totalCost; result.totalChildInputTokens += usage.totalInputTokens;
  result.totalChildOutputTokens += usage.totalOutputTokens; result.totalChildTokens += usage.totalTokens;
  result.totalChildRequests += usage.totalRequests;
  result.usageByModel = mergeModelUsageMaps(result.usageByModel, usage.usageByModel);
  result.usageByAgent = mergeAgentUsageMaps(result.usageByAgent, usage.usageByAgent);
}

/** @description Read child activity after each ticket and task is admitted. @param ctx Runtime. @param req Caller. @param parent Root ID. @returns Caller-visible child activity and costs. */
export async function collectVisibleChildActivity(ctx: AppContext, req: Request, parent: string): Promise<ChildActivity> {
  const result = emptyChildActivity();
  for (const child of await ctx.ticketService.listTickets({ parentTicketId: parent })) {
    if (!await canReadCockpitTicket(ctx, req, child)) continue;
    const links = await readTicketTaskLinks(ctx, child.ticketId);
    const ids = links.flatMap(link => link.taskId ? [link.taskId] : []);
    const tasks = await readVisibleActivityTasks(ctx, req, child.ticketId, [...ids, child.ticketId]);
    const messages = tasks[0] ? await readTaskMessages(ctx, tasks[0].taskId, child.ticketId) : [];
    const work = messages.length ? [] : await readVisibleActivityWorkItems(ctx, req, child);
    const source = { sourceTicketId: child.ticketId, sourceTicketName: child.title,
      sourceSequenceId: child.ticketId.substring(0, 8) };
    result.entries.push(...(messages.length ? messages.map(message => ({ ...buildTimelineEntry(message), ...source }))
      : buildWorkItemTimelineEntries(work, source)));
    result.children.push({ id: child.ticketId, sequenceId: source.sourceSequenceId, name: child.title,
      status: mapOshalTicketStateToCockpitState(deriveOshalTicketStateFromWorkItems(work) || child.status),
      assignee: child.assignedAgentId || null });
    addUsage(result, tasks);
  }
  return result;
}

/** @description Admit work-item output through canonical ticket/task bindings, including child unit correlation. @param ctx Runtime. @param req Caller. @param ticket Admitted ticket. @returns Readable work items. */
export async function readVisibleActivityWorkItems(ctx: AppContext, req: Request, ticket: InternalTicket) {
  const items = await readWorkItemsForInternalTicket(ctx, ticket as unknown as Record<string, unknown>);
  if (!items.length) return [];
  const children = await ctx.ticketService.listTickets({ parentTicketId: ticket.ticketId });
  const admitted: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const externalId = readOptionalString(item.externalId) || readOptionalString(item.external_id);
    const unitId = readOptionalString(item.unitId) || readOptionalString(item.unit_id);
    const child = children.find(row => unitId && (row.metadata.unitId === unitId || row.metadata.unit_id === unitId));
    if (child && externalId !== ticket.ticketId && externalId !== child.ticketId) continue;
    const source = child || (externalId ? await ctx.ticketService.getTicket(externalId) : null);
    if (!source || !await canReadCockpitTicket(ctx, req, source)) continue;
    const metadata = readRecord(item.metadata);
    const taskId = readOptionalString(metadata.taskId) || readOptionalString(metadata.task_id) || source.ticketId;
    const task = await ctx.taskStore.get(taskId);
    if (task && !await canReadCockpitTask(ctx, req, task)) continue;
    if (!await canReadWorkOutput(ctx, req, item, source, task, taskId)) continue;
    admitted.push(item);
  }
  return admitted;
}

/** @description Keep all recorded execution/agent provenance when checking correlated work output. @param ctx Runtime. @param req Caller. @param item Persisted work. @param source Bound ticket. @param task Canonical task. @param taskId Result destination. @returns Output read admission. */
async function canReadWorkOutput(ctx: AppContext, req: Request, item: Record<string, unknown>, source: InternalTicket, task: StoredTask | null, taskId: string): Promise<boolean> {
  try {
    const output = readRecord(item.executionOutput ?? item.execution_output);
    const verification = readRecord(item.verificationResult ?? item.verification_result);
    const provenance = [readRecord(item.metadata), output, readRecord(output.output), verification, readRecord(verification.output)];
    const executions = [...readProtectedResultExecutions(task?.metadata), ...provenance.flatMap(row => [
      ...readProtectedResultExecutions(row), ...[row.applicationExecutionId, row.application_execution_id]
        .filter((id): id is string => typeof id === 'string' && !!id),
    ])];
    const agents = [...new Set([item.assignedAgentId, item.assigned_agent_id,
      ...provenance.flatMap(row => [row.agentId, row.agent_id])]
      .filter((id): id is string => typeof id === 'string' && !!id))];
    const metadata = { ...readRecord(item.metadata), ...task?.metadata,
      ...(executions.length ? { [PROTECTED_RESULT_EXECUTIONS]: [...new Set(executions)] } : {}) };
    for (const agentId of agents.length ? agents : [undefined]) {
      if (!await canReadCockpitResult(ctx, req, { taskId, ownerSub: source.ownerSub, agentId, metadata })) return false;
    }
    return true;
  } catch { return false; }
}
