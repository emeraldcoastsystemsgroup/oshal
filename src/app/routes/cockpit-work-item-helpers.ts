/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: B2 fix — deriveRootWorkItemStatus no longer regresses to 'approved' when completed items exist alongside pending duplicates. Added routing_failed handling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added routing-failure timeline entries so cockpit activity surfaces watchdog/circuit-breaker failures to operators
 * -----------------------------------------------------------------------------
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit work-item correlation helpers so hierarchy, child detail, and activity timeline can render persisted swarm execution data
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fixed ticket hierarchy state projection so root tickets do not inherit planning completion as terminal state and escalated child work-items surface honestly
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Projected assignedAgentId from correlated work items so cockpit calendar bot filters can see child-ticket ownership when tickets were created without a persisted assignee
 */

import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'cockpit-work-item-helpers' });

type WorkItemRepositoryLike = {
  listRecent?: (limit?: number) => Promise<unknown[]>;
  findByExternalIdAnyProvider?: (externalId: string) => Promise<unknown[]>;
};

type WorkItemTimelineSource = {
  sourceTicketId?: string;
  sourceTicketName?: string;
  sourceSequenceId?: string;
};

/**
 * @description Reads recent persisted swarm work items so cockpit hierarchy responses can reflect
 * execution-backed state instead of stale internal placeholder statuses.
 * @param ctx - Application context
 * @param limit - Maximum number of recent work items to load
 * @returns Recent swarm work items, newest first according to repository ordering
 */
export async function readRecentWorkItems(
  ctx: AppContext,
  limit = 1000,
): Promise<Array<Record<string, unknown>>> {
  try {
    const repository = readWorkItemRepository(ctx);
    if (!repository?.listRecent) {
      return [];
    }
    const items = await repository.listRecent(limit);
    return Array.isArray(items) ? items as Array<Record<string, unknown>> : [];
  } catch (error) {
    logger.warn({ err: error, limit }, 'Failed to read recent swarm work items for cockpit hierarchy');
    return [];
  }
}

/**
 * @description Reads persisted swarm work items for a ticket using the ticket identifier as the
 * work-item external id.
 * @param ctx - Application context
 * @param ticketId - Ticket identifier used as work-item external id
 * @returns Array of work items from the swarm repository
 */
export async function readWorkItemsForTicket(
  ctx: AppContext,
  ticketId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const repository = readWorkItemRepository(ctx);
    if (!repository?.findByExternalIdAnyProvider) {
      return [];
    }
    const items = await repository.findByExternalIdAnyProvider(ticketId);
    return Array.isArray(items) ? items as Array<Record<string, unknown>> : [];
  } catch (error) {
    logger.warn({ err: error, ticketId }, 'Failed to read swarm work items for cockpit activity');
    return [];
  }
}

/**
 * @description Resolves work items for an internal ticket, including child-ticket correlation via
 * parent ticket work-unit ids and second-level subtask external ids when available.
 * @param ctx - Application context
 * @param ticket - Internal ticket-like object
 * @returns Correlated work items for the selected ticket
 */
export async function readWorkItemsForInternalTicket(
  ctx: AppContext,
  ticket: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const ticketId = readOptionalString(ticket.ticketId) || readOptionalString(ticket.id);
  const metadata = readRecord(ticket.metadata);
  const unitId = readOptionalString(metadata.unitId) || readOptionalString(metadata.unit_id);
  const parentTicketId = readOptionalString(ticket.parentTicketId)
    || readOptionalString(ticket.parent_ticket_id)
    || readOptionalString(ticket.parentId)
    || readOptionalString(ticket.parent_id);

  const directItems = ticketId ? await readWorkItemsForTicket(ctx, ticketId) : [];
  const parentItems = parentTicketId ? await readWorkItemsForTicket(ctx, parentTicketId) : [];
  const matchedParentItems = unitId
    ? parentItems.filter((item) => readWorkItemUnitId(item) === unitId)
    : [];
  const subtaskItems = unitId ? await readWorkItemsForTicket(ctx, unitId) : [];

  return dedupeWorkItems([...directItems, ...matchedParentItems, ...subtaskItems]);
}

/**
 * @description Derives an OSHAL-compatible runtime state from persisted swarm work-item statuses.
 * This lets cockpit hierarchy/detail surfaces reflect actual swarm execution progress for child
 * tickets that are represented by internal placeholders.
 * @param workItems - Correlated swarm work items
 * @returns Best-fit OSHAL ticket state or undefined when no signal is available
 */
export function deriveOshalTicketStateFromWorkItems(
  workItems: Array<Record<string, unknown>>,
): 'approved' | 'in_process_build' | 'complete' | 'escalated' | undefined {
  const statuses = workItems
    .map((workItem) => readOptionalString(workItem.status))
    .filter((status): status is string => Boolean(status));

  if (statuses.length === 0) {
    return undefined;
  }

  if (statuses.some((status) => status === 'escalated' || status === 'failed' || status === 'subtask-failed')) {
    return 'escalated';
  }

  if (statuses.some((status) => [
    'assigned',
    'executing',
    'in-review',
    'subtask-assigned',
    'subtask-executing',
  ].includes(status))) {
    return 'in_process_build';
  }

  // B2 fix: handle routing_failed as escalation signal
  if (statuses.some((status) => status === 'routing_failed')) {
    return 'escalated';
  }

  // B2 fix: Only return 'approved' when ALL items are pending.
  // Previously, if ANY item was pending, returned 'approved' — this caused state
  // regression when completed items existed alongside duplicate pending items.
  const allPending = statuses.every((status) => status === 'pending' || status === 'subtask-pending');
  if (allPending) {
    return 'approved';
  }

  if (statuses.every((status) => status === 'completed' || status === 'subtask-completed')) {
    return 'complete';
  }

  return undefined;
}

/**
 * @description B3: Derives the parent ticket status from aggregate child statuses.
 * Rules:
 *   - If any child is in_progress/executing/assigned → parent is 'in_progress'
 *   - If all children are completed → parent is 'in_review'
 *   - If any child is failed/escalated/routing_failed and none are in_progress → parent is 'needs_attention'
 *   - Never allows parent to stay at 'approved' when children have advanced
 * @param childStatuses - Array of child ticket/work-item status strings
 * @returns Derived parent status
 */
export function rollupChildStatus(childStatuses: string[]): string {
  if (childStatuses.length === 0) return 'pending';

  const hasActive = childStatuses.some(
    (s) => s === 'assigned' || s === 'executing' || s === 'in_progress' || s === 'in_process_design',
  );
  if (hasActive) return 'in_progress';

  const allCompleted = childStatuses.every((s) => s === 'completed' || s === 'complete');
  if (allCompleted) return 'in_review';

  const hasFailure = childStatuses.some(
    (s) => s === 'failed' || s === 'escalated' || s === 'routing_failed',
  );
  if (hasFailure) return 'needs_attention';

  const hasReview = childStatuses.some((s) => s === 'in-review' || s === 'in_review');
  if (hasReview) return 'in_review';

  const allPending = childStatuses.every(
    (s) => s === 'pending' || s === 'approved' || s === 'backlog',
  );
  if (allPending) return 'approved';

  return 'in_progress';
}

/**
 * @description Applies swarm work-item-backed runtime states to internal tickets before the
 * hierarchy tree is built, ensuring child rows do not appear stuck in backlog when swarm work is
 * already in progress or complete.
 * @param tickets - Internal tickets to decorate
 * @param workItems - Recent swarm work items used for correlation
 * @returns Ticket-like records with runtime status overrides when correlation is available
 */
export function applyWorkItemStatesToInternalTickets(
  tickets: Array<Record<string, unknown>>,
  workItems: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (tickets.length === 0 || workItems.length === 0) {
    return tickets;
  }

  const workItemsByExternalId = new Map<string, Array<Record<string, unknown>>>();
  for (const workItem of workItems) {
    const externalId = readOptionalString(workItem.externalId) || readOptionalString(workItem.external_id);
    if (!externalId) {
      continue;
    }
    const existing = workItemsByExternalId.get(externalId) ?? [];
    existing.push(workItem);
    workItemsByExternalId.set(externalId, existing);
  }

  return tickets.map((ticket) => {
    const ticketId = readOptionalString(ticket.ticketId) || '';
    const parentTicketId = readOptionalString(ticket.parentTicketId);
    const metadata = readRecord(ticket.metadata);
    const unitId = readOptionalString(metadata.unitId) || readOptionalString(metadata.unit_id);

    const directItems = workItemsByExternalId.get(ticketId) ?? [];
    const parentItems = parentTicketId ? (workItemsByExternalId.get(parentTicketId) ?? []) : [];
    const matchedParentItems = unitId
      ? parentItems.filter((workItem) => readWorkItemUnitId(workItem) === unitId)
      : [];
    const subtaskItems = unitId ? (workItemsByExternalId.get(unitId) ?? []) : [];
    const correlatedItems = dedupeWorkItems([...directItems, ...matchedParentItems, ...subtaskItems]);
    const derivedStatus = deriveOshalTicketStateFromWorkItems(correlatedItems);
    const derivedAgentId = readAssignedAgentIdFromWorkItems(correlatedItems);

    if (!derivedStatus && !derivedAgentId) {
      return ticket;
    }

    const projectedTicket = derivedAgentId && !readOptionalString(ticket.assignedAgentId)
      ? { ...ticket, assignedAgentId: derivedAgentId }
      : ticket;

    if (!derivedStatus) {
      return projectedTicket;
    }

    const isChildTicket = Boolean(parentTicketId);
    if (!isChildTicket) {
      return projectedTicket;
    }

    const latestWorkItemTimestamp = readLatestWorkItemTimestamp(correlatedItems);
    const ticketTimestamp = readTimestamp(
      readOptionalString(projectedTicket.updatedAt)
      || readOptionalString(projectedTicket.updated_at)
      || readOptionalString(projectedTicket.createdAt)
      || readOptionalString(projectedTicket.created_at),
    );

    if (latestWorkItemTimestamp <= ticketTimestamp) {
      return projectedTicket;
    }

    const projectedState = projectTicketStateFields(derivedStatus);

    return {
      ...projectedTicket,
      status: projectedState.status,
      stateGroup: projectedState.stateGroup,
      executionPhase: projectedState.executionPhase,
    };
  });
}

/**
 * @description Reads the latest assigned agent id from correlated work items when ticket persistence lacks one.
 * @param workItems - Correlated work items for a ticket.
 * @returns Latest non-empty assigned agent identifier.
 */
function readAssignedAgentIdFromWorkItems(workItems: Array<Record<string, unknown>>): string | undefined {
  let latestAgentId: string | undefined;
  let latestTimestamp = 0;

  workItems.forEach((workItem) => {
    const agentId = readOptionalString(workItem.assignedAgentId)
      || readOptionalString(workItem.assigned_agent_id)
      || readOptionalString(workItem.agentId)
      || readOptionalString(workItem.agent_id);
    if (!agentId) {
      return;
    }

    const timestamp = readWorkItemTimestamp(workItem);
    if (!latestAgentId || timestamp >= latestTimestamp) {
      latestAgentId = agentId;
      latestTimestamp = timestamp;
    }
  });

  return latestAgentId;
}

/**
 * @description Projects ticket state-group/execution-phase fields from a derived OSHAL status.
 * @param status - Derived OSHAL ticket state
 * @returns State fields aligned with ticket persistence rules
 */
function projectTicketStateFields(
  status: 'approved' | 'in_process_build' | 'complete' | 'escalated',
): { status: string; stateGroup: string; executionPhase: string | null } {
  if (status.startsWith('in_process_')) {
    return {
      status,
      stateGroup: 'in_process',
      executionPhase: status.replace('in_process_', ''),
    };
  }

  return {
    status,
    stateGroup: status,
    executionPhase: null,
  };
}

/**
 * @description Returns the newest timestamp available across correlated work-items.
 * @param workItems - Correlated work-items used for runtime projection
 * @returns Unix timestamp in milliseconds, or zero when no timestamps are present
 */
function readLatestWorkItemTimestamp(workItems: Array<Record<string, unknown>>): number {
  return workItems.reduce((latest, workItem) => {
    const timestamp = readWorkItemTimestamp(workItem);
    return Math.max(latest, timestamp);
  }, 0);
}

/**
 * @description Reads the most relevant timestamp from a correlated work item.
 * @param workItem - Work-item record.
 * @returns Parsed timestamp in milliseconds.
 */
function readWorkItemTimestamp(workItem: Record<string, unknown>): number {
  return readTimestamp(
    readOptionalString(workItem.updatedAt)
    || readOptionalString(workItem.updated_at)
    || readOptionalString(workItem.createdAt)
    || readOptionalString(workItem.created_at),
  );
}

/**
 * @description Parses an ISO timestamp into milliseconds, returning zero on invalid input.
 * @param value - Optional ISO timestamp string
 * @returns Parsed timestamp in milliseconds or zero when invalid
 */
function readTimestamp(value?: string): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * @description Builds timeline entries from persisted swarm work items so the cockpit feed can show
 * assignment, completion, verification, and execution output even when task/message stores are unavailable.
 * @param workItems - Persisted work items for a ticket or child ticket
 * @param source - Optional child-ticket source metadata for grouped feed rendering
 * @returns Timeline entries ordered by work-item creation/update timestamps
 */
export function buildWorkItemTimelineEntries(
  workItems: Array<Record<string, unknown>>,
  source: WorkItemTimelineSource = {},
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];

  for (const workItem of workItems) {
    const workItemId = readOptionalString(workItem.workItemId) || readOptionalString(workItem.work_item_id) || 'work-item';
    const title = readOptionalString(workItem.title) || workItemId;
    const assignedAgentId = readOptionalString(workItem.assignedAgentId) || readOptionalString(workItem.assigned_agent_id);
    const createdAt = readOptionalString(workItem.createdAt) || readOptionalString(workItem.created_at) || new Date().toISOString();
    const updatedAt = readOptionalString(workItem.updatedAt) || readOptionalString(workItem.updated_at) || createdAt;
    const status = readOptionalString(workItem.status) || 'unknown';
    const executionOutput = readRecord(workItem.executionOutput ?? workItem.execution_output);
    const nestedExecutionOutput = readRecord(executionOutput.output);
    const verificationResult = readRecord(workItem.verificationResult ?? workItem.verification_result);

    entries.push(withSource({
      id: `${workItemId}-created`,
      type: 'system',
      text: `Work item created: ${title}`,
      summary: `Work item created: ${title}`,
      timestamp: createdAt,
      created_at: createdAt,
      author: 'system',
      actor: 'swarm',
      status,
    }, source));

    if (assignedAgentId) {
      entries.push(withSource({
        id: `${workItemId}-assigned`,
        type: 'assistant',
        text: `Assigned to ${assignedAgentId}`,
        summary: `Assigned to ${assignedAgentId}`,
        timestamp: updatedAt,
        created_at: updatedAt,
        author: assignedAgentId,
        actor: assignedAgentId,
        status,
      }, source));
    }

    const outputText = readOptionalString(executionOutput.content)
      || readOptionalString(executionOutput.summary)
      || readOptionalString(executionOutput.text)
      || readOptionalString(executionOutput.error)
      || readOptionalString(nestedExecutionOutput.content)
      || readOptionalString(nestedExecutionOutput.summary)
      || readOptionalString(nestedExecutionOutput.text)
      || readOptionalString(nestedExecutionOutput.error);

    if (outputText) {
      const outputActor = readOptionalString(executionOutput.agentId)
        || readOptionalString(nestedExecutionOutput.agentId)
        || assignedAgentId
        || 'assistant';
      entries.push(withSource({
        id: `${workItemId}-output`,
        type: 'assistant',
        text: outputText,
        summary: outputText,
        timestamp: updatedAt,
        created_at: updatedAt,
        author: outputActor,
        actor: outputActor,
        status,
      }, source));
    }

    const verificationStatus = readOptionalString(verificationResult.status);
    const findings = Array.isArray(verificationResult.findings)
      ? verificationResult.findings.filter((value): value is string => typeof value === 'string')
      : [];
    if (verificationStatus) {
      const summary = verificationStatus === 'passed'
        ? `Verification passed${findings.length > 0 ? `: ${findings.join(', ')}` : ''}`
        : `Verification ${verificationStatus}${findings.length > 0 ? `: ${findings.join(', ')}` : ''}`;
      entries.push(withSource({
        id: `${workItemId}-verification`,
        type: verificationStatus === 'passed' ? 'system' : 'assistant',
        text: summary,
        summary,
        timestamp: updatedAt,
        created_at: updatedAt,
        author: 'verification',
        actor: 'verification',
        status,
      }, source));
    }

    if (status === 'routing_failed') {
      const metadata = readRecord(workItem.metadata);
      const routingFailure = readRecord(metadata.routingFailure);
      const reason = readOptionalString(routingFailure.reason) || 'routing watchdog detected a stale or unrecoverable dispatch';
      const staleMinutes = readOptionalNumber(routingFailure.staleMinutes);
      const summary = staleMinutes
        ? `Routing failed after ${staleMinutes} minute${staleMinutes === 1 ? '' : 's'}: ${reason}`
        : `Routing failed: ${reason}`;

      entries.push(withSource({
        id: `${workItemId}-routing-failed`,
        type: 'system',
        text: summary,
        summary,
        timestamp: updatedAt,
        created_at: updatedAt,
        author: 'routing-watchdog',
        actor: 'routing-watchdog',
        status,
      }, source));
    }
  }

  entries.sort((left, right) => {
    const leftTime = Date.parse(readOptionalString(left.created_at) || '');
    const rightTime = Date.parse(readOptionalString(right.created_at) || '');
    return safeTimestamp(leftTime) - safeTimestamp(rightTime);
  });

  return entries;
}

function readWorkItemRepository(ctx: AppContext): WorkItemRepositoryLike | undefined {
  return (ctx.swarm as { workItemRepository?: WorkItemRepositoryLike })?.workItemRepository;
}

function dedupeWorkItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const workItemId = readOptionalString(item.workItemId) || readOptionalString(item.work_item_id);
    const key = workItemId || JSON.stringify(item);
    if (!byId.has(key)) {
      byId.set(key, item);
    }
  }
  return Array.from(byId.values());
}

function withSource(
  entry: Record<string, unknown>,
  source: WorkItemTimelineSource,
): Record<string, unknown> {
  if (!source.sourceTicketId && !source.sourceSequenceId && !source.sourceTicketName) {
    return entry;
  }
  return {
    ...entry,
    ...(source.sourceTicketId ? { sourceTicketId: source.sourceTicketId } : {}),
    ...(source.sourceTicketName ? { sourceTicketName: source.sourceTicketName } : {}),
    ...(source.sourceSequenceId ? { sourceSequenceId: source.sourceSequenceId } : {}),
  };
}

function readWorkItemUnitId(workItem: Record<string, unknown>): string | undefined {
  return readOptionalString(workItem.unitId) || readOptionalString(workItem.unit_id);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function safeTimestamp(value: number): number {
  return Number.isNaN(value) ? 0 : value;
}