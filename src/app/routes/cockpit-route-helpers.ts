/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted helper functions from cockpit-routes.ts to comply with 1000-line hard cap
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added work-item activity helpers so cockpit ticket detail can show swarm execution progress without task/message links
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserved child hierarchy across project filters and delegated work-item-backed child timeline correlation to dedicated cockpit helper module
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added paused/cancelled cockpit state mapping so task-backed fallback tickets and internal tickets display operator lifecycle controls consistently
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Removed ticket cost rollup utilities into cockpit-cost-route-helpers.ts to bring this route helper back under the file-size limit
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Switched child ticket cost rollups to prefer direct chat_tasks aggregation so parent activity views include per-agent usage missed by task-store-only rollups
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Expanded child ticket fallback aggregation to include every linked task so per-bot rollups stay complete in localhost memory-backed runs
 */

import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, normalizeOshalTicketState } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';
import {
  buildWorkItemTimelineEntries,
  deriveOshalTicketStateFromWorkItems,
  readWorkItemsForInternalTicket,
} from './cockpit-work-item-helpers';
import {
  type CockpitAgentUsageStats,
  type CockpitModelUsageStats,
  mergeAgentUsageMaps,
  mergeModelUsageMaps,
  pickPrimaryModel,
  rollupTaskUsage,
} from './cockpit-cost-route-helpers';

const logger = createChildLogger({ module: 'cockpit-route-helpers' });

// ═══ AGENT / STATUS HELPERS ═══

/**
 * @description Reads an agent identifier from task data when present.
 * @param task - Task-like object from task store.
 * @returns Normalized agent identifier or undefined.
 */
export function readTaskAgentId(task: any): string | undefined {
  const candidate = task?.assignee || task?.agentId || task?.assignedAgentId;
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const normalized = candidate.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * @description Maps internal task status to cockpit-compatible ticket status.
 * @param status - Internal task status string
 * @returns Normalized status for cockpit display
 */
export function mapTaskStatus(status: string | undefined): string {
  switch (status) {
    case 'active':
    case 'processing':
    case 'running':
    case 'in_progress':
      return 'In Progress';
    case 'paused':
      return 'Paused';
    case 'completed':
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
    case 'error':
      return 'Failed';
    case 'pending':
    case 'queued':
      return 'Todo';
    case 'review':
    case 'in_review':
    case 'waiting_for_input':
      return 'In Review';
    default:
      return 'Backlog';
  }
}

/**
 * @description Maps OSHAL ticket state to cockpit display state.
 * @param status - Internal OSHAL ticket status
 * @returns Cockpit-compatible display state
 */
export function mapOshalTicketStateToCockpitState(status: string | undefined): string {
  const normalized = normalizeOshalTicketState(status);
  switch (normalized) {
    case 'approved':
      return 'Todo';
    case 'approval_required':
      return 'Approval Required';
    case 'customer_action':
      return 'Customer Action';
    case 'complete':
      return 'Done';
    case 'escalated':
      return 'In Review';
    case 'paused':
      return 'Paused';
    case 'cancelled':
      return 'Cancelled';
    case 'in_process_discovery':
    case 'in_process_design':
    case 'in_process_build':
    case 'in_process_deploy':
    case 'in_process_test':
    case 'in_process_release':
      return 'In Progress';
    case 'backlog':
    default:
      return 'Backlog';
  }
}

// ═══ LINK / WORKSPACE SELECTORS ═══

/**
 * @description Selects the primary task ID from ticket-task links.
 * @param links - Array of link objects
 * @returns Primary task ID or null
 */
export function selectPrimaryTaskId(links: Array<{ taskId?: string; role?: string }>): string | null {
  if (!Array.isArray(links) || links.length === 0) {
    return null;
  }
  const primary = links.find((link) => link?.taskId && link.role === 'primary');
  if (primary?.taskId) {
    return primary.taskId;
  }
  const first = links.find((link) => link?.taskId);
  return first?.taskId ?? null;
}

/**
 * @description Selects a workspace ID from workspace links.
 * @param links - Array of workspace link objects
 * @returns First valid workspace ID or null
 */
export function selectWorkspaceId(links: Array<{ workspaceId?: string }>): string | null {
  if (!Array.isArray(links) || links.length === 0) {
    return null;
  }
  const first = links.find((link) => typeof link?.workspaceId === 'string' && link.workspaceId.length > 0);
  return first?.workspaceId ?? null;
}

/**
 * @description Builds a workspace display path from a workspace ID.
 * @param workspaceId - Workspace identifier
 * @returns Display path or undefined
 */
export function buildWorkspacePathFromWorkspaceId(workspaceId: string | null): string | undefined {
  if (!workspaceId) {
    return undefined;
  }
  return `/app/workspace/${workspaceId}`;
}

/**
 * @description Normalizes a workspace path for cockpit display.
 * @param workspacePath - Raw workspace path
 * @returns Normalized display path
 */
export function normalizeWorkspaceDisplayPath(workspacePath?: string | null): string | undefined {
  const normalizedValue = String(workspacePath || '').trim().replace(/\\/g, '/');
  if (!normalizedValue) {
    return undefined;
  }
  if (normalizedValue === 'workspace' || normalizedValue === '/workspace') {
    return '/app/workspace';
  }
  if (normalizedValue === '/app/workspace') {
    return normalizedValue;
  }
  if (normalizedValue.startsWith('/app/workspace/')) {
    return normalizedValue;
  }
  if (normalizedValue.startsWith('workspace/')) {
    return `/app/${normalizedValue}`;
  }
  if (normalizedValue.startsWith('/workspace/')) {
    return `/app${normalizedValue}`;
  }
  const workspaceMarker = normalizedValue.lastIndexOf('/workspace/');
  if (workspaceMarker >= 0) {
    return `/app/workspace/${normalizedValue.slice(workspaceMarker + '/workspace/'.length)}`;
  }
  if (normalizedValue.startsWith('/')) {
    return `/app/workspace/${path.basename(normalizedValue)}`;
  }
  return `/app/workspace/${normalizedValue.replace(/^\/+/, '')}`;
}

// ═══ HIERARCHY BUILDERS ═══

/**
 * @description Builds internal ticket hierarchy for cockpit display.
 * @param tickets - Array of internal ticket records
 * @param requestedProjectId - Optional project filter
 * @returns Hierarchical array of ticket nodes
 */
export function buildInternalTicketHierarchy(
  tickets: Array<Record<string, unknown>>,
  requestedProjectId?: string,
): Array<Record<string, unknown>> {
  const includedTicketIds = resolveIncludedInternalTicketIds(tickets, requestedProjectId);
  const filtered = tickets.filter((ticket) => includedTicketIds.has(readOptionalString(ticket.ticketId) || ''));
  const nodeMap = new Map<string, Record<string, unknown>>();
  const roots: Array<Record<string, unknown>> = [];

  filtered.forEach((ticket) => {
    const metadata = readRecord(ticket.metadata);
    // Dual-read the queue (was project): queue* keys win, fall back to legacy project*.
    const project = buildProjectSelection(
      readOptionalString(metadata.queueName) || readOptionalString(metadata.queue)
        || readOptionalString(metadata.projectName) || readOptionalString(metadata.project),
      readOptionalString(metadata.queueId) || readOptionalString(metadata.projectId),
      readOptionalString(metadata.queueIdentifier) || readOptionalString(metadata.projectIdentifier),
      readOptionalString(metadata.workspaceSlug),
    );
    const ticketId = readOptionalString(ticket.ticketId) || '';
    nodeMap.set(ticketId, {
      id: ticketId,
      ticketId,
      sequenceId: ticketId.substring(0, 8),
      uuid: ticketId,
      name: readOptionalString(ticket.title) || `Ticket ${ticketId.substring(0, 8)}`,
      description: readOptionalString(ticket.description) || '',
      status: mapOshalTicketStateToCockpitState(readOptionalString(ticket.status) || ''),
      state: mapOshalTicketStateToCockpitState(readOptionalString(ticket.status) || ''),
      rawStatus: readOptionalString(ticket.status) || '',
      stateGroup: readOptionalString(ticket.stateGroup) || '',
      executionPhase: readOptionalString(ticket.executionPhase) || null,
      priority: readOptionalString(ticket.priority) || 'none',
      folder: project.name,
      project: project.name,
      projectId: project.projectId,
      project_identifier: project.identifier,
      // Canonical queue fields (an app IS a queue) — what the cockpit groups/filters by.
      queue: project.name,
      queueId: project.projectId,
      targetBot: readOptionalString(metadata.targetBot) || null,
      workspaceSlug: project.workspaceSlug,
      assignee: readOptionalString(ticket.assignedAgentId) || null,
      created_at: readOptionalString(ticket.createdAt) || new Date().toISOString(),
      updated_at: readOptionalString(ticket.updatedAt) || new Date().toISOString(),
      estimatedCost: readOptionalNumber(metadata.estimatedCost) || readOptionalNumber(metadata.totalCost) || 0,
      actualCost: readOptionalNumber(metadata.actualCost) || readOptionalNumber(metadata.cost) || 0,
      labels: Array.isArray(ticket.labels) ? ticket.labels : [],
      parentId: readOptionalString(ticket.parentTicketId) || null,
      parent_id: readOptionalString(ticket.parentTicketId) || null,
      children: [],
    });
  });

  nodeMap.forEach((node) => {
    const parentId = readOptionalString(node.parentId);
    if (parentId && nodeMap.has(parentId)) {
      readChildren(nodeMap.get(parentId)).push(node);
      return;
    }
    roots.push(node);
  });

  roots.sort(sortTicketNodes);
  roots.forEach(sortTicketChildren);
  return roots;
}

/**
 * @description Builds task hierarchy for cockpit display (fallback when no internal tickets).
 * @param tasks - Array of task records
 * @param requestedProjectId - Optional project filter
 * @returns Hierarchical array of task nodes
 */
export function buildTaskHierarchy(
  tasks: Array<Record<string, unknown>>,
  requestedProjectId?: string,
): Array<Record<string, unknown>> {
  const filtered = tasks.filter((task) => matchesRequestedProject(readRecord(task.metadata), requestedProjectId));
  const nodeMap = new Map<string, Record<string, unknown>>();
  const roots: Array<Record<string, unknown>> = [];

  filtered.forEach((task) => {
    const metadata = readRecord(task.metadata);
    const project = buildProjectSelectionFromTask(task);
    const taskId = readOptionalString(task.taskId) || '';
    const parentId = readOptionalString(metadata.parentId)
      || readOptionalString(metadata.parent_id)
      || readOptionalString(metadata.parentTaskId)
      || readOptionalString(metadata.parent_task_id)
      || null;
    nodeMap.set(taskId, {
      id: taskId,
      ticketId: taskId,
      sequenceId: readOptionalString(metadata.sequenceId) || readOptionalString(metadata.sequence_id) || taskId.substring(0, 8),
      uuid: taskId,
      name: readOptionalString(task.name) || readOptionalString(task.title) || `Task ${taskId.substring(0, 8)}`,
      description: readOptionalString(metadata.description) || readOptionalString(task.description) || '',
      status: mapTaskStatus(readOptionalString(task.status) || ''),
      state: mapTaskStatus(readOptionalString(task.status) || ''),
      rawStatus: readOptionalString(task.status) || '',
      priority: readOptionalString(metadata.priority) || readOptionalString(task.priority) || 'none',
      folder: project.name,
      project: project.name,
      projectId: project.projectId,
      project_identifier: project.identifier,
      workspaceSlug: project.workspaceSlug,
      assignee: readOptionalString(task.assignee) || readOptionalString(task.agentId) || null,
      created_at: readOptionalString(task.createdAt) || readOptionalString(task.created_at) || new Date().toISOString(),
      updated_at: readOptionalString(task.updatedAt) || readOptionalString(task.updated_at) || new Date().toISOString(),
      estimatedCost: Number(task.estimatedCost || task.totalCost || 0),
      actualCost: Number(task.actualCost || task.totalCost || 0),
      labels: Array.isArray(task.labels) ? task.labels : [],
      parentId,
      parent_id: parentId,
      children: [],
    });
  });

  nodeMap.forEach((node) => {
    const parentId = readOptionalString(node.parentId);
    if (parentId && nodeMap.has(parentId)) {
      readChildren(nodeMap.get(parentId)).push(node);
      return;
    }
    roots.push(node);
  });

  roots.sort(sortTicketNodes);
  roots.forEach(sortTicketChildren);
  return roots;
}

// ═══ PROJECT SELECTION ═══

/**
 * @description Builds project selection from task metadata.
 * @param task - Task record
 * @returns Project selection object
 */
export function buildProjectSelectionFromTask(task: Record<string, unknown>) {
  const metadata = readRecord(task.metadata);
  return buildProjectSelection(
    readOptionalString(task.project) || readOptionalString(metadata.project),
    readOptionalString(metadata.projectId) || readOptionalString(metadata.project_id),
    readOptionalString(metadata.projectIdentifier) || readOptionalString(metadata.project_identifier),
    readOptionalString(metadata.workspaceSlug) || readOptionalString(metadata.workspace_slug),
  );
}

/**
 * @description Builds a normalized project selection object from metadata fields.
 * @param projectName - Project display name
 * @param projectId - Project identifier
 * @param projectIdentifier - Project slug identifier
 * @param workspaceSlug - Workspace slug
 * @returns Normalized project selection
 */
export function buildProjectSelection(
  projectName?: string | null,
  projectId?: string | null,
  projectIdentifier?: string | null,
  workspaceSlug?: string | null,
) {
  const name = projectName || DEFAULT_PROJECT_NAME;
  const resolvedProjectId = projectId || slugify(name) || DEFAULT_PROJECT_ID;
  return {
    id: resolvedProjectId,
    name,
    identifier: projectIdentifier || slugify(name) || DEFAULT_PROJECT_ID,
    projectId: resolvedProjectId,
    workspaceSlug: workspaceSlug || slugify(name) || DEFAULT_PROJECT_ID,
  };
}

/**
 * @description Checks if ticket metadata matches a requested project filter.
 * @param metadata - Ticket metadata
 * @param requestedProjectId - Project ID to filter by
 * @returns True if matches or no filter applied
 */
export function matchesRequestedProject(metadata: Record<string, unknown>, requestedProjectId?: string): boolean {
  if (!requestedProjectId) {
    return true;
  }
  // Dual-read the queue id (was project id): queue* wins, fall back to legacy project*.
  const projectId = readOptionalString(metadata.queueId)
    || readOptionalString(metadata.projectId)
    || readOptionalString(metadata.project_id)
    || slugify(readOptionalString(metadata.queueName) || readOptionalString(metadata.project) || DEFAULT_PROJECT_NAME)
    || DEFAULT_PROJECT_ID;
  return projectId === requestedProjectId;
}

// ═══ GENERIC UTILITIES ═══

/**
 * @description Safely reads children array from a node.
 * @param node - Node object
 * @returns Mutable children array
 */
export function readChildren(node: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!node) {
    return [];
  }
  if (!Array.isArray(node.children)) {
    node.children = [];
  }
  return node.children as Array<Record<string, unknown>>;
}

function sortTicketChildren(node: Record<string, unknown>): void {
  const children = readChildren(node);
  children.sort(sortTicketNodes);
  children.forEach(sortTicketChildren);
}

function sortTicketNodes(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftTime = Date.parse(readOptionalString(left.created_at) || '');
  const rightTime = Date.parse(readOptionalString(right.created_at) || '');
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return (readOptionalString(left.name) || '').localeCompare(readOptionalString(right.name) || '');
}

/**
 * @description Safely reads an object, returning empty object for non-object values.
 * @param value - Unknown value
 * @returns Record or empty object
 */
export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * @description Converts a string to a URL-safe slug.
 * @param value - Input string
 * @returns Slugified string
 */
export function slugify(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'unassigned';
}

/**
 * @description Safely reads a string value, returning undefined for empty or non-string.
 * @param value - Unknown value
 * @returns Trimmed string or undefined
 */
export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @description Safely reads a numeric value, returning undefined for invalid inputs.
 * @param value - Unknown value
 * @returns Finite number or undefined
 */
export function readOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ═══ ASYNC DATA ACCESS HELPERS ═══

/**
 * @description Reads ticket-task links for activity display.
 * @param ctx - Application context
 * @param ticketId - Ticket ID
 * @returns Array of link objects
 */
export async function readTicketTaskLinks(
  ctx: AppContext,
  ticketId: string,
): Promise<Array<{ taskId?: string; role?: string }>> {
  try {
    const links = await ctx.ticketService.getTasksForTicket(ticketId);
    return Array.isArray(links) ? links : [];
  } catch (error) {
    logger.warn({ err: error, ticketId }, 'Failed to read ticket task links for activity');
    return [];
  }
}

/**
 * @description Reads ticket-workspace links for workspace display.
 * @param ctx - Application context
 * @param ticketId - Ticket ID
 * @returns Array of workspace link objects
 */
export async function readTicketWorkspaceLinks(
  ctx: AppContext,
  ticketId: string,
): Promise<Array<{ workspaceId?: string }>> {
  try {
    const links = await ctx.ticketService.getWorkspacesForTicket(ticketId);
    return Array.isArray(links) ? links : [];
  } catch (error) {
    logger.warn({ err: error, ticketId }, 'Failed to read ticket workspace links for activity');
    return [];
  }
}

/**
 * @description Reads a task by ID with error handling.
 * @param ctx - Application context
 * @param taskId - Task ID
 * @param reason - Debug reason for the lookup
 * @returns Task object or null
 */
export async function readTaskById(
  ctx: AppContext,
  taskId: string,
  reason: string,
): Promise<any | null> {
  try {
    return await ctx.taskStore.get(taskId);
  } catch (error) {
    logger.warn({ err: error, taskId, reason }, 'Task lookup failed');
    return null;
  }
}

/**
 * @description Reads tasks associated with a ticket, preferring explicit task ids and then metadata matches.
 * @param ctx - Application context
 * @param ticketId - Ticket ID
 * @param preferredTaskIds - Task ids to resolve first
 * @returns Ordered unique task list
 */
export async function readTasksForTicket(
  ctx: AppContext,
  ticketId: string,
  preferredTaskIds: string[] = [],
): Promise<Array<Record<string, unknown>>> {
  const orderedTasks: Array<Record<string, unknown>> = [];
  const seenTaskIds = new Set<string>();
  const candidateIds = preferredTaskIds
    .map((value) => readOptionalString(value))
    .filter((value): value is string => Boolean(value));

  for (const taskId of candidateIds) {
    const task = await readTaskById(ctx, taskId, 'ticket activity preferred task lookup');
    const normalizedTaskId = readOptionalString(task?.taskId);
    if (!task || !normalizedTaskId || seenTaskIds.has(normalizedTaskId)) {
      continue;
    }
    seenTaskIds.add(normalizedTaskId);
    orderedTasks.push(task as Record<string, unknown>);
  }

  try {
    const tasks = await ctx.taskStore.list({ limit: 1000 });
    for (const task of tasks as Array<Record<string, unknown>>) {
      const taskId = readOptionalString(task.taskId);
      const metadata = readRecord(task.metadata);
      const linkedTicketId = readOptionalString(metadata.ticketId) || readOptionalString(metadata.ticket_id);
      const matchesTicket = taskId === ticketId || linkedTicketId === ticketId;
      if (!matchesTicket || !taskId || seenTaskIds.has(taskId)) {
        continue;
      }
      seenTaskIds.add(taskId);
      orderedTasks.push(task);
    }
  } catch (error) {
    logger.warn({ err: error, ticketId }, 'Ticket activity metadata task lookup failed');
  }

  return orderedTasks;
}

/**
 * @description Reads task messages with error handling.
 * @param ctx - Application context
 * @param taskId - Task ID
 * @param ticketId - Parent ticket ID (for logging)
 * @returns Array of messages
 */
export async function readTaskMessages(
  ctx: AppContext,
  taskId: string,
  ticketId: string,
): Promise<any[]> {
  try {
    return await ctx.messageStore.getByTask(taskId);
  } catch (error) {
    logger.warn({ err: error, taskId, ticketId }, 'Message lookup failed for ticket activity');
    return [];
  }
}

// ═══ TIMELINE BUILDERS ═══

/**
 * @description Builds a timeline entry from a message object.
 * @param message - Message-like object
 * @returns Normalized timeline entry
 */
export function buildTimelineEntry(message: any): Record<string, unknown> {
  const text = readOptionalString(message?.text)
    || readOptionalString(message?.summary)
    || readOptionalString(message?.comment)
    || readOptionalString(message?.description)
    || readOptionalString(message?.action)
    || '';
  const role = readOptionalString(message?.role)
    || readOptionalString(message?.say)
    || readOptionalString(message?.author)
    || 'assistant';
  const timestamp = readOptionalString(message?.createdAt)
    || readOptionalString(message?.ts)
    || readOptionalString(message?.timestamp)
    || new Date().toISOString();
  const type = role === 'user' || role === 'user_feedback' ? 'user' : 'assistant';
  const author = role === 'user_feedback' ? 'user' : role;
  return {
    id: message?.messageId || message?.id || message?.ts || `${type}-${timestamp}`,
    type,
    text,
    summary: text,
    comment: text,
    description: text,
    action: text,
    timestamp,
    created_at: timestamp,
    author,
    actor: author === 'user' ? 'You' : author,
  };
}

/**
 * @description Builds a lifecycle timeline entry for ticket/task creation events.
 * @param input - Creation event metadata
 * @returns Lifecycle timeline entry
 */
export function buildLifecycleTimelineEntry(input: {
  id: string;
  title: string;
  description?: string;
  createdAt?: string;
  actor?: string;
  type: 'ticket' | 'task';
}): Record<string, unknown> {
  const safeTitle = readOptionalString(input.title) || input.id;
  const safeDescription = readOptionalString(input.description);
  const summary = input.type === 'ticket'
    ? `Ticket created: ${safeTitle}`
    : `Task created: ${safeTitle}`;
  const description = safeDescription ? `${summary}. ${safeDescription}` : summary;
  const timestamp = readOptionalString(input.createdAt) || new Date().toISOString();

  return {
    id: `${input.type}-created-${input.id}`,
    type: 'system',
    text: description,
    summary,
    comment: summary,
    description,
    action: summary,
    timestamp,
    created_at: timestamp,
    author: 'system',
    actor: input.actor || 'system',
  };
}

/**
 * @description Ensures timeline has at least one lifecycle event entry.
 * @param timeline - Existing timeline entries
 * @param lifecycleEntry - Fallback lifecycle entry
 * @returns Timeline with at least one entry
 */
export function ensureTimelineHasLifecycleEvent(
  timeline: Array<Record<string, unknown>>,
  lifecycleEntry: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (timeline.length > 0) {
    return timeline;
  }
  return [lifecycleEntry];
}

/**
 * @description Collects timelines from all child tickets of a root ticket.
 * Each child entry is tagged with its source ticket so the cockpit feed can render provenance.
 * @param ctx - Application context
 * @param parentTicketId - Root ticket ID to collect children for
 * @returns Merged timeline entries, child metadata summaries, and aggregated child cost
 */
export async function collectChildTimelines(
  ctx: AppContext,
  parentTicketId: string,
): Promise<{
  entries: Array<Record<string, unknown>>;
  children: Array<Record<string, unknown>>;
  totalChildCost: number;
  totalChildInputTokens: number;
  totalChildOutputTokens: number;
  totalChildTokens: number;
  totalChildRequests: number;
  usageByModel: Record<string, CockpitModelUsageStats>;
  usageByAgent: Record<string, CockpitAgentUsageStats>;
}> {
  const childTickets = await ctx.ticketService.listTickets({ parentTicketId });
  const entries: Array<Record<string, unknown>> = [];
  const children: Array<Record<string, unknown>> = [];
  let totalChildCost = 0;
  let totalChildInputTokens = 0;
  let totalChildOutputTokens = 0;
  let totalChildTokens = 0;
  let totalChildRequests = 0;
  let usageByModel: Record<string, CockpitModelUsageStats> = {};
  let usageByAgent: Record<string, CockpitAgentUsageStats> = {};

  for (const child of childTickets) {
    const seq = child.ticketId?.substring(0, 8) || '';
    const childTaskLinks = await readTicketTaskLinks(ctx, child.ticketId);
    const childPrimaryTaskId = selectPrimaryTaskId(childTaskLinks);
    const childTaskIds = childTaskLinks
      .map((link) => readOptionalString(link.taskId))
      .filter((taskId): taskId is string => Boolean(taskId));
    const childTasks = await readTasksForTicket(
      ctx,
      child.ticketId,
      childTaskIds.length > 0 ? [...childTaskIds, child.ticketId] : (childPrimaryTaskId ? [childPrimaryTaskId, child.ticketId] : [child.ticketId]),
    );
    const childTask = childTasks[0] || null;
    const directChildCostSummary = await readTicketCostSummary(ctx, child.ticketId);
    const childUsage = directChildCostSummary
      ? buildUsageSummaryFromDirectCostSummary(directChildCostSummary)
      : rollupTaskUsage(childTasks);
    totalChildCost += childUsage.totalCost;
    totalChildInputTokens += childUsage.totalInputTokens;
    totalChildOutputTokens += childUsage.totalOutputTokens;
    totalChildTokens += childUsage.totalTokens;
    totalChildRequests += childUsage.totalRequests;
    usageByModel = mergeModelUsageMaps(usageByModel, childUsage.usageByModel);
    usageByAgent = mergeAgentUsageMaps(usageByAgent, childUsage.usageByAgent);

    const childMessages = childPrimaryTaskId
      ? await readTaskMessages(ctx, childPrimaryTaskId, child.ticketId)
      : [];
    const childWorkItems = childMessages.length === 0
      ? await readWorkItemsForInternalTicket(ctx, child as unknown as Record<string, unknown>)
      : [];
    const childRuntimeStatus = deriveOshalTicketStateFromWorkItems(childWorkItems);
    const childState = mapOshalTicketStateToCockpitState(childRuntimeStatus || child.status);
    const childAssignee = child.assignedAgentId
      || readOptionalString(childWorkItems[0]?.assignedAgentId)
      || readOptionalString(childWorkItems[0]?.assigned_agent_id)
      || null;

    children.push({
      id: child.ticketId,
      sequenceId: seq,
      name: child.title,
      status: childState,
      assignee: childAssignee,
    });

    if (childMessages.length > 0) {
      for (const msg of childMessages) {
        const entry = buildTimelineEntry(msg);
        entry.sourceTicketId = child.ticketId;
        entry.sourceTicketName = child.title;
        entry.sourceSequenceId = seq;
        entries.push(entry);
      }
      continue;
    }

    entries.push(...buildWorkItemTimelineEntries(childWorkItems, {
      sourceTicketId: child.ticketId,
      sourceTicketName: child.title,
      sourceSequenceId: seq,
    }));
  }

  logger.debug({
    parentTicketId,
    childCount: childTickets.length,
    entryCount: entries.length,
    totalChildCost,
    totalChildTokens,
  }, 'Child activity rollup collected');
  return {
    entries,
    children,
    totalChildCost,
    totalChildInputTokens,
    totalChildOutputTokens,
    totalChildTokens,
    totalChildRequests,
    usageByModel,
    usageByAgent,
  };
}

function resolveIncludedInternalTicketIds(
  tickets: Array<Record<string, unknown>>,
  requestedProjectId?: string,
): Set<string> {
  const ticketIds = tickets
    .map((ticket) => readOptionalString(ticket.ticketId))
    .filter((ticketId): ticketId is string => Boolean(ticketId));

  if (!requestedProjectId) {
    return new Set(ticketIds);
  }

  const included = new Set<string>();
  for (const ticket of tickets) {
    const ticketId = readOptionalString(ticket.ticketId);
    if (!ticketId) {
      continue;
    }
    if (matchesRequestedProject(readRecord(ticket.metadata), requestedProjectId)) {
      included.add(ticketId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const ticket of tickets) {
      const ticketId = readOptionalString(ticket.ticketId);
      const parentTicketId = readOptionalString(ticket.parentTicketId);
      if (!ticketId || !parentTicketId || included.has(ticketId) || !included.has(parentTicketId)) {
        continue;
      }
      included.add(ticketId);
      changed = true;
    }
  }

  return included;
}

/**
 * @description Deletes task messages during ticket cleanup.
 * @param ctx - Application context
 * @param taskId - Task ID whose messages should be deleted
 */
export async function deleteTaskMessages(ctx: AppContext, taskId: string): Promise<void> {
  try {
    await ctx.messageStore.deleteByTask(taskId);
  } catch (error) {
    logger.warn({ err: error, taskId }, 'Task message cleanup failed during ticket deletion');
  }
}

async function readTicketCostSummary(ctx: AppContext, ticketId: string): Promise<any | null> {
  try {
    return await ctx.swarm?.costTrackingService?.queryCostByTicket(ticketId);
  } catch (error) {
    logger.warn({ err: error, ticketId }, 'Direct ticket cost rollup failed for child activity');
    return null;
  }
}

function buildUsageSummaryFromDirectCostSummary(summary: any): {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  usageByModel: Record<string, CockpitModelUsageStats>;
  usageByAgent: Record<string, CockpitAgentUsageStats>;
  modelId: string | null;
} {
  const usageByModel = normalizeDirectUsageByModel(summary?.usageByModel);
  const usageByAgent = normalizeDirectUsageByAgent(summary?.usageByAgent);

  return {
    totalCost: readOptionalNumber(summary?.totalCost) || 0,
    totalInputTokens: readOptionalNumber(summary?.totalInputTokens) || 0,
    totalOutputTokens: readOptionalNumber(summary?.totalOutputTokens) || 0,
    totalTokens: readOptionalNumber(summary?.totalTokens) || 0,
    totalRequests: readOptionalNumber(summary?.totalRequests) || 0,
    usageByModel,
    usageByAgent,
    modelId: pickPrimaryModel(usageByModel),
  };
}

function normalizeDirectUsageByModel(value: unknown): Record<string, CockpitModelUsageStats> {
  const normalized: Record<string, CockpitModelUsageStats> = {};
  Object.entries(readRecord(value)).forEach(([modelId, stats]) => {
    const record = readRecord(stats);
    normalized[modelId] = {
      inputTokens: readOptionalNumber(record.inputTokens) || 0,
      outputTokens: readOptionalNumber(record.outputTokens) || 0,
      totalTokens: readOptionalNumber(record.totalTokens) || 0,
      inputCost: readOptionalNumber(record.inputCost) || 0,
      outputCost: readOptionalNumber(record.outputCost) || 0,
      totalCost: readOptionalNumber(record.totalCost) || 0,
      requestCount: readOptionalNumber(record.requestCount) || 0,
    };
  });
  return normalized;
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

// ═══ PROJECT REGISTRY ═══

/** @description Shape of a project entry in the file-based registry. */
export interface ProjectEntry {
  id: string;
  name: string;
  identifier: string;
  projectId: string;
  workspaceSlug: string;
  createdAt?: string;
  archived?: boolean;
}

/**
 * @description Resolves the project registry file path from the app context output directory.
 * @param ctx - Application context
 * @returns Absolute path to projects.json
 */
function resolveProjectRegistryPath(ctx: AppContext): string {
  const outputDir = (ctx as any).configOutputDir || process.env.CONFIG_OUTPUT_DIR || path.join(process.cwd(), 'output');
  return path.join(outputDir, 'projects.json');
}

/**
 * @description Loads the project registry from disk. Returns an empty Map if the file doesn't exist.
 * @param ctx - Application context
 * @returns Map of projectId → ProjectEntry
 */
export function loadProjectRegistry(ctx: AppContext): Map<string, ProjectEntry> {
  const filePath = resolveProjectRegistryPath(ctx);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entries: ProjectEntry[] = JSON.parse(raw);
      const map = new Map<string, ProjectEntry>();
      for (const entry of entries) {
        if (entry.id && !entry.archived) {
          map.set(entry.id, entry);
        }
      }
      return map;
    }
  } catch (error) {
    logger.warn({ err: error, filePath }, 'Failed to load project registry, starting fresh');
  }
  return new Map<string, ProjectEntry>();
}

/**
 * @description Saves the project registry to disk.
 * @param ctx - Application context
 * @param registry - Map of projectId → ProjectEntry
 */
export function saveProjectRegistry(ctx: AppContext, registry: Map<string, ProjectEntry>): void {
  const filePath = resolveProjectRegistryPath(ctx);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entries = Array.from(registry.values());
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8');
    logger.info({ filePath, count: entries.length }, 'Project registry saved');
  } catch (error) {
    logger.error({ err: error, filePath }, 'Failed to save project registry');
  }
}
