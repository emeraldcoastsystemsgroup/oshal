/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit ticket activity route handling from cockpit-routes.ts and added direct per-agent ticket cost aggregation for cockpit detail views
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added external ticket identifiers to activity payloads so escalated cockpit tickets can look up durable swarm escalation records while keeping bot cost rollups intact
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Expanded ticket activity fallback aggregation to include every linked task so MOCK_OIDC localhost rollups show all contributing bots even when direct Postgres cost queries are unavailable
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fixed cockpit ticket activity workspace wiring so artifact browsing points at the shared root ticket workspace instead of task-scoped linked task IDs
 */

import type { Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { canAccessResource } from '@/shared/middleware/authz';
import type { AppContext } from '../composition-root';
import {
  type CockpitAgentUsageStats,
  mergeAgentUsageMaps,
  mergeModelUsageMaps,
  normalizeUsageByModel,
  pickPrimaryModel,
  rollupTaskUsage,
} from './cockpit-cost-route-helpers';
import {
  buildProjectSelection,
  buildProjectSelectionFromTask,
  buildLifecycleTimelineEntry,
  buildTimelineEntry,
  buildWorkspacePathFromWorkspaceId,
  collectChildTimelines,
  ensureTimelineHasLifecycleEvent,
  mapOshalTicketStateToCockpitState,
  mapTaskStatus,
  normalizeWorkspaceDisplayPath,
  readOptionalNumber,
  readOptionalString,
  readTaskAgentId,
  readTaskMessages,
  readTasksForTicket,
  readTicketTaskLinks,
  readTicketWorkspaceLinks,
  selectPrimaryTaskId,
  selectWorkspaceId,
} from './cockpit-route-helpers';
import {
  buildWorkItemTimelineEntries,
  deriveOshalTicketStateFromWorkItems,
  readWorkItemsForInternalTicket,
} from './cockpit-work-item-helpers';
import { getActiveRegistry } from '../extensions/swarm/swarm-bot-registry';
const SWARM_BOT_REGISTRY = getActiveRegistry();

const logger = createChildLogger({ module: 'cockpit-ticket-activity-route' });

/**
 * @description Creates the cockpit ticket activity route handler.
 * @param ctx - Application context.
 * @returns Express request handler for GET /api/v1/tickets/:ticketId/activity.
 */
export function handleGetCockpitTicketActivity(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { ticketId } = req.params;
      logger.info({ ticketId }, 'GET /api/v1/tickets/:ticketId/activity');

      const internalTicket = await ctx.ticketService.getTicket(ticketId as string);
      if (internalTicket) {
        if (!canAccessResource(req, internalTicket.ownerSub ?? null)) {
          res.status(404).json({ success: false, error: 'Ticket not found' });
          return;
        }
        res.json(await buildInternalTicketActivityPayload(ctx, ticketId as string, internalTicket));
        return;
      }

      const fallbackPayload = await buildFallbackTaskActivityPayload(ctx, req, ticketId as string);
      if (!fallbackPayload) {
        res.status(404).json({ success: false, error: 'Ticket not found' });
        return;
      }

      res.json(fallbackPayload);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get ticket activity');
      res.status(500).json({ success: false, error: 'Failed to load ticket activity' });
    }
  };
}

async function buildInternalTicketActivityPayload(
  ctx: AppContext,
  ticketId: string,
  internalTicket: any,
): Promise<Record<string, unknown>> {
  const taskLinks = await readTicketTaskLinks(ctx, ticketId);
  const primaryTaskId = selectPrimaryTaskId(taskLinks);
  const linkedTaskIds = readLinkedTaskIds(taskLinks);
  const linkedTasks = await readTasksForTicket(
    ctx,
    ticketId,
    linkedTaskIds.length > 0 ? [...linkedTaskIds, ticketId] : [ticketId],
  );
  const linkedTask = linkedTasks[0] || null;
  const resolvedTaskId = readOptionalString(linkedTask?.taskId) || primaryTaskId || null;
  const messages = resolvedTaskId
    ? await readTaskMessages(ctx, resolvedTaskId, ticketId)
    : [];
  const workItems = messages.length === 0
    ? await readWorkItemsForInternalTicket(ctx, internalTicket as Record<string, unknown>)
    : [];
  const runtimeStatus = deriveOshalTicketStateFromWorkItems(workItems);
  const timeline = ensureTimelineHasLifecycleEvent(
    messages.length > 0
      ? messages.map((message: any) => buildTimelineEntry(message))
      : buildWorkItemTimelineEntries(workItems),
    buildLifecycleTimelineEntry({
      id: internalTicket.ticketId,
      title: internalTicket.title,
      description: internalTicket.description,
      createdAt: internalTicket.createdAt,
      actor: internalTicket.assignedAgentId || 'system',
      type: 'ticket',
    }),
  );
  const workspaceLinks = await readTicketWorkspaceLinks(ctx, ticketId);
  const inheritedWorkspaceLinks = workspaceLinks.length === 0 && internalTicket.parentTicketId
    ? await readTicketWorkspaceLinks(ctx, internalTicket.parentTicketId)
    : [];
  const workspaceId = selectWorkspaceId(workspaceLinks.length > 0 ? workspaceLinks : inheritedWorkspaceLinks);
  const cockpitState = mapOshalTicketStateToCockpitState(runtimeStatus || internalTicket.status);
  const workspaceLookupId = await resolveRootWorkspaceTicketId(ctx, internalTicket);
  const workspacePath = await resolveWorkspaceDisplayPath(ctx, workspaceId, linkedTask, workspaceLookupId);
  const directOwnUsage = await readDirectTicketUsageSummary(ctx, ticketId);
  const ownUsage = directOwnUsage || rollupTaskUsage(linkedTasks);
  const ticketProject = buildProjectSelection(
    readOptionalString(internalTicket?.metadata?.projectName) || readOptionalString(internalTicket?.metadata?.project),
    readOptionalString(internalTicket?.metadata?.projectId) || readOptionalString(internalTicket?.metadata?.project_id),
    readOptionalString(internalTicket?.metadata?.projectIdentifier) || readOptionalString(internalTicket?.metadata?.project_identifier),
    readOptionalString(internalTicket?.metadata?.workspaceSlug) || readOptionalString(internalTicket?.metadata?.workspace_slug),
  );

  const isRoot = !internalTicket.parentTicketId;
  const childRollup = isRoot
    ? await collectChildTimelines(ctx, ticketId)
    : {
      entries: [],
      children: [],
      totalChildCost: 0,
      totalChildInputTokens: 0,
      totalChildOutputTokens: 0,
      totalChildTokens: 0,
      totalChildRequests: 0,
      usageByModel: {},
      usageByAgent: {},
    };
  const mergedTimeline = isRoot && childRollup.entries.length > 0
    ? [...timeline, ...childRollup.entries]
    : timeline;
  const totalUsageByModel = mergeModelUsageMaps(ownUsage.usageByModel, childRollup.usageByModel);
  const totalUsageByAgent = applyAgentNames(
    mergeAgentUsageMaps(ownUsage.usageByAgent, childRollup.usageByAgent),
  );
  const contributingBots = sortContributingBots(totalUsageByAgent);
  const totalCost = ownUsage.totalCost + childRollup.totalChildCost;
  const totalInputTokens = ownUsage.totalInputTokens + childRollup.totalChildInputTokens;
  const totalOutputTokens = ownUsage.totalOutputTokens + childRollup.totalChildOutputTokens;
  const totalTokens = ownUsage.totalTokens + childRollup.totalChildTokens;
  const totalRequests = ownUsage.totalRequests + childRollup.totalChildRequests;

  return {
    success: true,
    ticket: {
      id: internalTicket.ticketId,
      externalId: readOptionalString(internalTicket.externalId)
        || readOptionalString(internalTicket.external_id)
        || readOptionalString(internalTicket.externalId)
        || internalTicket.ticketId,
      name: internalTicket.title || `Ticket ${internalTicket.ticketId?.substring(0, 8)}`,
      sequenceId: internalTicket.ticketId?.substring(0, 8),
      status: cockpitState,
      state: cockpitState,
      rawStatus: runtimeStatus || internalTicket.status,
      description: internalTicket.description || '',
      assignee: internalTicket.assignedAgentId || null,
      parentId: internalTicket.parentTicketId || null,
      children: childRollup.children,
      created_at: internalTicket.createdAt || new Date().toISOString(),
      updated_at: internalTicket.updatedAt || new Date().toISOString(),
      estimatedCost: totalCost,
      actualCost: totalCost,
      project: ticketProject.name,
      projectId: ticketProject.projectId,
      projectIdentifier: ticketProject.identifier,
      workspaceSlug: ticketProject.workspaceSlug,
      workspaceTaskId: workspaceLookupId || undefined,
      workspacePath,
    },
    cost: {
      ticketId: internalTicket.ticketId,
      projectId: ticketProject.projectId,
      projectName: ticketProject.name,
      estimatedCost: totalCost,
      actualCost: totalCost,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalRequests,
      usageByModel: totalUsageByModel,
      usageByAgent: totalUsageByAgent,
      contributingBots,
      modelId: pickPrimaryModel(totalUsageByModel),
    },
    timeline: mergedTimeline,
    messageCount: (messages.length > 0 ? messages.length : workItems.length) + childRollup.entries.length,
  };
}

async function buildFallbackTaskActivityPayload(
  ctx: AppContext,
  req: Request,
  ticketId: string,
): Promise<Record<string, unknown> | null> {
  const fallbackTasks = await readTasksForTicket(ctx, ticketId, [ticketId]);
  const task = fallbackTasks[0] || null;
  if (!task) {
    return null;
  }
  if (!canAccessResource(req, readOptionalString(task.ownerSub) ?? null)) {
    return null;
  }

  let messages: any[] = [];
  try {
    messages = await ctx.messageStore.getByTask(ticketId);
  } catch (error) {
    logger.warn({ err: error, ticketId }, 'Task message lookup failed for activity fallback');
  }

  const timeline = ensureTimelineHasLifecycleEvent(
    messages.map((message: any) => buildTimelineEntry(message)),
    buildLifecycleTimelineEntry({
      id: readOptionalString(task.taskId) || ticketId,
      title: readOptionalString(task.name) || readOptionalString(task.title) || '',
      description: readOptionalString(task.description) || '',
      createdAt: readOptionalString(task.createdAt),
      actor: readTaskAgentId(task) || 'system',
      type: 'task',
    }),
  );
  const taskUsage = rollupTaskUsage(fallbackTasks);
  const usageByAgent = applyAgentNames(taskUsage.usageByAgent);
  const contributingBots = sortContributingBots(usageByAgent);
  const taskProject = buildProjectSelectionFromTask(task as Record<string, unknown>);

  return {
    success: true,
    ticket: {
      id: readOptionalString(task.taskId) || ticketId,
      externalId: readOptionalString(task.externalId)
        || readOptionalString(task.external_id)
        || readOptionalString(task.taskId)
        || ticketId,
      name: readOptionalString(task.name) || readOptionalString(task.title) || `Task ${(readOptionalString(task.taskId) || ticketId).substring(0, 8)}`,
      status: mapTaskStatus(readOptionalString(task.status)),
      state: mapTaskStatus(readOptionalString(task.status)),
      rawStatus: readOptionalString(task.status) || '',
      description: readOptionalString(task.description) || '',
      created_at: readOptionalString(task.createdAt) || new Date().toISOString(),
      updated_at: readOptionalString(task.updatedAt) || new Date().toISOString(),
      estimatedCost: taskUsage.totalCost,
      actualCost: taskUsage.totalCost,
      project: taskProject.name,
      projectId: taskProject.projectId,
      projectIdentifier: taskProject.identifier,
      workspaceSlug: taskProject.workspaceSlug,
    },
    cost: {
      ticketId: task.taskId,
      projectId: taskProject.projectId,
      projectName: taskProject.name,
      estimatedCost: taskUsage.totalCost,
      actualCost: taskUsage.totalCost,
      totalCost: taskUsage.totalCost,
      totalInputTokens: taskUsage.totalInputTokens,
      totalOutputTokens: taskUsage.totalOutputTokens,
      totalTokens: taskUsage.totalTokens,
      totalRequests: taskUsage.totalRequests,
      usageByModel: taskUsage.usageByModel,
      usageByAgent,
      contributingBots,
      modelId: taskUsage.modelId,
    },
    timeline,
    messageCount: messages.length,
  };
}

async function readDirectTicketUsageSummary(
  ctx: AppContext,
  ticketId: string,
): Promise<null | {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  usageByModel: Record<string, ReturnType<typeof normalizeUsageByModel>[string]>;
  usageByAgent: Record<string, CockpitAgentUsageStats>;
  modelId: string | null;
}> {
  try {
    const summary = await ctx.swarm?.costTrackingService?.queryCostByTicket(ticketId);
    if (!summary || !hasCostData(summary)) {
      return null;
    }

    const usageByModel = normalizeUsageByModel(summary.usageByModel);
    const usageByAgent = normalizeDirectUsageByAgent(summary.usageByAgent);

    // Per-model totalCost may have been estimated from fallback pricing inside
    // normalizeUsageByModel. Sum those so the ticket-level total reflects the estimate
    // instead of the persisted $0 value.
    const estimatedTotalFromModels = Object.values(usageByModel)
      .reduce((sum, stats) => sum + (stats.totalCost || 0), 0);
    const rawTotalCost = readOptionalNumber(summary.totalCost) || 0;
    const totalCost = rawTotalCost > 0 ? rawTotalCost : estimatedTotalFromModels;

    // Backfill agent-level cost when it was persisted as 0: proportionally distribute
    // the ticket totalCost across agents by their share of total tokens.
    const totalTokensAcrossAgents = Object.values(usageByAgent)
      .reduce((sum, stats) => sum + (stats.totalTokens || 0), 0);
    if (totalCost > 0 && totalTokensAcrossAgents > 0) {
      Object.values(usageByAgent).forEach((stats) => {
        if (!stats.totalCost && stats.totalTokens > 0) {
          stats.totalCost = totalCost * (stats.totalTokens / totalTokensAcrossAgents);
        }
      });
    }

    return {
      totalCost,
      totalInputTokens: readOptionalNumber(summary.totalInputTokens) || 0,
      totalOutputTokens: readOptionalNumber(summary.totalOutputTokens) || 0,
      totalTokens: readOptionalNumber(summary.totalTokens) || 0,
      totalRequests: readOptionalNumber(summary.totalRequests) || 0,
      usageByModel,
      usageByAgent,
      modelId: pickPrimaryModel(usageByModel),
    };
  } catch (error) {
    logger.warn({ err: error, ticketId }, 'Direct ticket cost rollup failed for activity route');
    return null;
  }
}

function hasCostData(summary: any): boolean {
  return (readOptionalNumber(summary?.totalCost) || 0) > 0
    || (readOptionalNumber(summary?.totalTokens) || 0) > 0
    || (readOptionalNumber(summary?.totalRequests) || 0) > 0
    || Object.keys(summary?.usageByModel || {}).length > 0
    || Object.keys(summary?.usageByAgent || {}).length > 0;
}

function normalizeDirectUsageByAgent(value: unknown): Record<string, CockpitAgentUsageStats> {
  const normalized: Record<string, CockpitAgentUsageStats> = {};

  Object.entries(readRecord(value)).forEach(([agentId, stats]) => {
    const record = readRecord(stats);
    normalized[agentId] = {
      agentId,
      agentName: readOptionalString(record.agentName) || agentId,
      totalInputTokens: readOptionalNumber(record.totalInputTokens) || 0,
      totalOutputTokens: readOptionalNumber(record.totalOutputTokens) || 0,
      totalTokens: readOptionalNumber(record.totalTokens) || 0,
      totalCost: readOptionalNumber(record.totalCost) || 0,
      totalRequests: readOptionalNumber(record.totalRequests) || 0,
    };
  });

  return normalized;
}

function applyAgentNames(usageByAgent: Record<string, CockpitAgentUsageStats>): Record<string, CockpitAgentUsageStats> {
  const nameLookup = buildAgentNameLookup();
  const normalized: Record<string, CockpitAgentUsageStats> = {};

  Object.entries(usageByAgent).forEach(([agentId, stats]) => {
    const normalizedAgentId = readOptionalString(agentId) || readOptionalString(stats.agentId) || 'unknown';
    normalized[normalizedAgentId] = {
      ...stats,
      agentId: normalizedAgentId,
      agentName: nameLookup.get(normalizedAgentId)
        || nameLookup.get(readOptionalString(stats.agentName) || '')
        || readOptionalString(stats.agentName)
        || normalizedAgentId,
    };
  });

  return normalized;
}

function sortContributingBots(usageByAgent: Record<string, CockpitAgentUsageStats>): CockpitAgentUsageStats[] {
  return Object.values(usageByAgent).sort((left, right) => {
    if (right.totalCost !== left.totalCost) {
      return right.totalCost - left.totalCost;
    }
    if (right.totalTokens !== left.totalTokens) {
      return right.totalTokens - left.totalTokens;
    }
    return left.agentName.localeCompare(right.agentName);
  });
}

function buildAgentNameLookup(): Map<string, string> {
  const lookup = new Map<string, string>();

  SWARM_BOT_REGISTRY.forEach((bot) => {
    if (bot.agentId) {
      lookup.set(bot.agentId, bot.name);
    }
    lookup.set(bot.name, bot.name);
  });

  return lookup;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function resolveRootWorkspaceTicketId(
  ctx: AppContext,
  internalTicket: Record<string, unknown>,
): Promise<string> {
  let currentTicketId = readOptionalString(internalTicket.ticketId) || '';
  let currentParentId = readOptionalString(internalTicket.parentTicketId) || '';
  let depth = 0;

  while (currentParentId && depth < 12) {
    const parentTicket = await ctx.ticketService.getTicket(currentParentId);
    if (!parentTicket) {
      return currentParentId;
    }

    currentTicketId = parentTicket.ticketId;
    currentParentId = parentTicket.parentTicketId || '';
    depth += 1;
  }

  return currentTicketId || currentParentId || readOptionalString(internalTicket.parentTicketId) || '';
}

async function resolveWorkspaceDisplayPath(
  ctx: AppContext,
  workspaceId: string | null,
  linkedTask: Record<string, unknown> | null,
  workspaceLookupId: string,
): Promise<string | undefined> {
  const linkedWorkspace = workspaceId
    ? await ctx.workspaceService.getWorkspace(workspaceId)
    : null;
  const linkedTaskWorkspacePath = readOptionalString(readRecord(linkedTask?.metadata).workspacePath);

  return normalizeWorkspaceDisplayPath(
    readOptionalString(linkedWorkspace?.path)
      || linkedTaskWorkspacePath
      || (workspaceLookupId ? `/app/workspace/${workspaceLookupId}` : undefined)
      || buildWorkspacePathFromWorkspaceId(workspaceId),
  );
}

function readLinkedTaskIds(links: Array<{ taskId?: string; role?: string }>): string[] {
  return [...new Set(
    links
      .map((link) => readOptionalString(link?.taskId))
      .filter((taskId): taskId is string => Boolean(taskId)),
  )];
}
