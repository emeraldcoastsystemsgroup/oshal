/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added in-memory ticket store fallback so MOCK_OIDC localhost flows can create, link, and inspect internal tickets without Postgres
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Queue DLQ: deriveStateFields maps 'dead_letter' → state_group 'escalated' (parity with the Postgres store so MOCK_OIDC flows behave identically).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): added findLatestByMetadataKey (newest match, any status; same-millisecond ties broken by insertion order) — parity with the Postgres consolidation lookup
 */

import { randomUUID } from 'crypto';
import {
  buildTicketRowStatusMetadataPatch,
  type ITicketStore,
  type TicketStatusHistoryRecord,
  type TicketStatusMetadata,
  type TicketStatusUpdateContext,
  type CreateInternalTicketInput,
  type InternalTicket,
  type TicketTaskLink,
  type TicketTaskLinkRole,
  type TicketWorkspaceLink,
  type OshalTicketExecutionPhase,
  type OshalTicketState,
  type OshalTicketStateGroup,
} from '@/entities/ticket';
import { ticketEvents } from '@/shared/ticket-events';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'InMemoryTicketStore' });

/**
 * @description In-memory ticket persistence used when local MOCK_OIDC development runs without Postgres.
 */
export class InMemoryTicketStore implements ITicketStore {
  private readonly tickets = new Map<string, InternalTicket>();

  private readonly taskLinksByTicket = new Map<string, TicketTaskLink[]>();

  private readonly workspaceLinksByTicket = new Map<string, TicketWorkspaceLink[]>();

  private readonly statusHistoryByTicket = new Map<string, TicketStatusHistoryRecord[]>();

  /**
   * @description Creates a new internal ticket in memory.
   * @param input - Ticket creation input.
   * @returns Created internal ticket.
   */
  async create(input: CreateInternalTicketInput): Promise<InternalTicket> {
    const ticketId = randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? 'backlog';
    const [stateGroup, executionPhase] = deriveStateFields(status);
    const ticket: InternalTicket = {
      ticketId,
      ticketType: input.ticketType ?? 'build',
      title: input.title,
      description: input.description ?? '',
      status,
      stateGroup,
      executionPhase,
      priority: input.priority ?? 'none',
      labels: [...(input.labels ?? [])],
      workspaceId: input.workspaceId ?? null,
      assignedAgentId: input.assignedAgentId ?? null,
      parentTicketId: input.parentTicketId ?? null,
      externalProvider: input.externalProvider ?? null,
      externalId: input.externalId ?? null,
      externalUrl: input.externalUrl ?? null,
      metadata: cloneRecord(input.metadata ?? {}),
      ownerSub: input.ownerSub ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.tickets.set(ticketId, ticket);
    await this.recordStatusHistory(ticketId, null, status, 'system', 'System');
    logger.info({ ticketId, status }, 'Created ticket in memory');
    return cloneTicket(ticket);
  }

  /**
   * @description Gets a ticket by id.
   * @param ticketId - Ticket identifier.
   * @returns Ticket or null.
   */
  async get(ticketId: string): Promise<InternalTicket | null> {
    const ticket = this.tickets.get(ticketId) ?? null;
    logger.debug({ ticketId, found: Boolean(ticket) }, 'Read ticket from memory');
    return ticket ? cloneTicket(ticket) : null;
  }

  /**
   * @description Gets a ticket by provider-native id.
   * @param externalProvider - External provider key.
   * @param externalId - Provider-native ticket id.
   * @returns Ticket or null.
   */
  async getByExternalId(externalProvider: string, externalId: string): Promise<InternalTicket | null> {
    const match = Array.from(this.tickets.values()).find((ticket) => (
      ticket.externalProvider === externalProvider && ticket.externalId === externalId
    ));
    logger.debug({ externalProvider, externalId, found: Boolean(match) }, 'Read ticket by external id from memory');
    return match ? cloneTicket(match) : null;
  }

  async findActiveByMetadataKey(key: string, value: string): Promise<InternalTicket | null> {
    const candidates = Array.from(this.tickets.values())
      .filter((t) => t.status !== 'cancelled' && (t.metadata as Record<string, unknown> | undefined)?.[key] === value)
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const match = candidates[0];
    logger.debug({ key, value, found: Boolean(match) }, 'Find ticket by metadata key in memory');
    return match ? cloneTicket(match) : null;
  }

  /**
   * @description Finds the newest ticket (any status) whose `metadata.<key>` equals the
   * value — parity with the Postgres store's alert-triage consolidation lookup (ADR-119 P1).
   * Same-millisecond creations tie-break by insertion order, newest first.
   * @param key - Metadata field name.
   * @param value - Metadata value to match exactly.
   * @returns Newest matching ticket or null.
   */
  async findLatestByMetadataKey(key: string, value: string): Promise<InternalTicket | null> {
    const ordered = Array.from(this.tickets.values());
    const insertionIndex = new Map(ordered.map((t, i) => [t.ticketId, i]));
    const candidates = ordered
      .filter((t) => (t.metadata as Record<string, unknown> | undefined)?.[key] === value)
      .sort((a, b) => (
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        || ((insertionIndex.get(b.ticketId) ?? 0) - (insertionIndex.get(a.ticketId) ?? 0))
      ));
    const match = candidates[0];
    logger.debug({ key, value, found: Boolean(match) }, 'Find latest ticket by metadata key in memory');
    return match ? cloneTicket(match) : null;
  }

  /**
   * @description Updates a ticket lifecycle status and emits a ticket event.
   * @param ticketId - Ticket identifier.
   * @param status - New lifecycle state.
   */
  async updateStatus(
    ticketId: string,
    status: OshalTicketState,
    context: TicketStatusUpdateContext = {},
  ): Promise<void> {
    const existing = this.tickets.get(ticketId);
    if (!existing) {
      return;
    }

    const previousStatus = existing.status;
    const changedBy = context.changedBy ?? 'system';
    const changedByLabel = context.changedByLabel ?? 'System';
    const metadata = context.metadata ?? {};
    const metadataPatch = buildTicketRowStatusMetadataPatch(status, metadata);
    const [stateGroup, executionPhase] = deriveStateFields(status);
    existing.status = status;
    existing.stateGroup = stateGroup;
    existing.executionPhase = executionPhase;
    if (metadataPatch) {
      existing.metadata = { ...cloneRecord(existing.metadata), ...metadataPatch };
    }
    existing.updatedAt = new Date().toISOString();
    this.tickets.set(ticketId, existing);

    await this.recordStatusHistory(ticketId, previousStatus, status, changedBy, changedByLabel, metadata);
    ticketEvents.emitStatusChanged({
      ticketId,
      fromStatus: previousStatus,
      toStatus: status,
      changedBy,
      changedByLabel,
      timestamp: existing.updatedAt,
    });
    logger.info({ ticketId, fromStatus: previousStatus, toStatus: status }, 'Updated ticket status in memory');
  }

  /**
   * @description Partially updates one ticket record.
   * @param ticketId - Ticket identifier.
   * @param updates - Partial field updates.
   */
  async update(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt'>>): Promise<void> {
    const existing = this.tickets.get(ticketId);
    if (!existing) {
      return;
    }

    const merged: InternalTicket = {
      ...existing,
      ...updates,
      labels: 'labels' in updates ? [...(updates.labels ?? [])] : existing.labels,
      metadata: 'metadata' in updates ? cloneRecord(updates.metadata ?? {}) : cloneRecord(existing.metadata),
      updatedAt: new Date().toISOString(),
    };

    if (updates.status) {
      const [stateGroup, executionPhase] = deriveStateFields(updates.status);
      merged.stateGroup = stateGroup;
      merged.executionPhase = executionPhase;
    }

    this.tickets.set(ticketId, merged);
    logger.info({ ticketId }, 'Updated ticket fields in memory');
  }

  /**
   * @description Deletes a ticket and its in-memory links/history.
   * @param ticketId - Ticket identifier.
   */
  async delete(ticketId: string): Promise<void> {
    const deleted = this.tickets.delete(ticketId);
    this.taskLinksByTicket.delete(ticketId);
    this.workspaceLinksByTicket.delete(ticketId);
    this.statusHistoryByTicket.delete(ticketId);
    logger.info({ ticketId, deleted }, 'Deleted ticket from memory');
  }

  /**
   * @description Lists tickets with optional filters.
   * @param options - List filters.
   * @returns Matching tickets newest first.
   */
  async list(options?: {
    status?: OshalTicketState;
    workspaceId?: string;
    assignedAgentId?: string;
    parentTicketId?: string | null;
    ticketType?: string;
    ownerSub?: string;
    limit?: number;
    offset?: number;
  }): Promise<InternalTicket[]> {
    let results = Array.from(this.tickets.values());

    if (options?.status) {
      results = results.filter((ticket) => ticket.status === options.status);
    }
    if (options?.workspaceId) {
      results = results.filter((ticket) => ticket.workspaceId === options.workspaceId);
    }
    if (options?.assignedAgentId) {
      results = results.filter((ticket) => ticket.assignedAgentId === options.assignedAgentId);
    }
    if (options?.ticketType) {
      results = results.filter((ticket) => ticket.ticketType === options.ticketType);
    }
    if (options?.ownerSub) {
      results = results.filter((ticket) => ticket.ownerSub === options.ownerSub);
    }
    if (options?.parentTicketId !== undefined) {
      results = options.parentTicketId === null
        ? results.filter((ticket) => ticket.parentTicketId === null)
        : results.filter((ticket) => ticket.parentTicketId === options.parentTicketId);
    }

    results.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const offset = options?.offset && options.offset > 0 ? options.offset : 0;
    const limited = options?.limit && options.limit > 0
      ? results.slice(offset, offset + options.limit)
      : results.slice(offset);
    logger.debug({ count: limited.length }, 'Listed tickets from memory');
    return limited.map(cloneTicket);
  }

  /**
   * @description Links a task to a ticket.
   * @param ticketId - Ticket identifier.
   * @param taskId - Task identifier.
   * @param role - Link role.
   */
  async linkTask(ticketId: string, taskId: string, role: TicketTaskLinkRole = 'primary'): Promise<void> {
    const links = [...(this.taskLinksByTicket.get(ticketId) ?? [])];
    const existingIndex = links.findIndex((link) => link.taskId === taskId);
    const createdAt = existingIndex >= 0 ? links[existingIndex].createdAt : new Date().toISOString();
    const nextLink: TicketTaskLink = { taskId, ticketId, role, createdAt };

    if (existingIndex >= 0) {
      links[existingIndex] = nextLink;
    } else {
      links.push(nextLink);
    }

    links.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.taskLinksByTicket.set(ticketId, links);
    logger.info({ ticketId, taskId, role }, 'Linked task to ticket in memory');
  }

  /**
   * @description Unlinks a task from a ticket.
   * @param ticketId - Ticket identifier.
   * @param taskId - Task identifier.
   */
  async unlinkTask(ticketId: string, taskId: string): Promise<void> {
    const links = (this.taskLinksByTicket.get(ticketId) ?? []).filter((link) => link.taskId !== taskId);
    this.taskLinksByTicket.set(ticketId, links);
    logger.info({ ticketId, taskId }, 'Unlinked task from ticket in memory');
  }

  /**
   * @description Returns all task links for one ticket.
   * @param ticketId - Ticket identifier.
   * @returns Linked task records.
   */
  async getTaskLinks(ticketId: string): Promise<TicketTaskLink[]> {
    return [...(this.taskLinksByTicket.get(ticketId) ?? [])].map(cloneTaskLink);
  }

  /**
   * @description Returns all ticket links for one task.
   * @param taskId - Task identifier.
   * @returns Ticket links for the task.
   */
  async getTicketLinksForTask(taskId: string): Promise<TicketTaskLink[]> {
    const links = Array.from(this.taskLinksByTicket.values())
      .flat()
      .filter((link) => link.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return links.map(cloneTaskLink);
  }

  /**
   * @description Links a workspace to a ticket.
   * @param ticketId - Ticket identifier.
   * @param workspaceId - Workspace identifier.
   */
  async linkWorkspace(ticketId: string, workspaceId: string): Promise<void> {
    const links = [...(this.workspaceLinksByTicket.get(ticketId) ?? [])];
    const exists = links.some((link) => link.workspaceId === workspaceId);
    if (!exists) {
      links.push({ ticketId, workspaceId, createdAt: new Date().toISOString() });
      links.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      this.workspaceLinksByTicket.set(ticketId, links);
    }
    logger.info({ ticketId, workspaceId }, 'Linked workspace to ticket in memory');
  }

  /**
   * @description Unlinks a workspace from a ticket.
   * @param ticketId - Ticket identifier.
   * @param workspaceId - Workspace identifier.
   */
  async unlinkWorkspace(ticketId: string, workspaceId: string): Promise<void> {
    const links = (this.workspaceLinksByTicket.get(ticketId) ?? []).filter((link) => link.workspaceId !== workspaceId);
    this.workspaceLinksByTicket.set(ticketId, links);
    logger.info({ ticketId, workspaceId }, 'Unlinked workspace from ticket in memory');
  }

  /**
   * @description Returns workspace links for one ticket.
   * @param ticketId - Ticket identifier.
   * @returns Workspace links.
   */
  async getWorkspaceLinks(ticketId: string): Promise<TicketWorkspaceLink[]> {
    return [...(this.workspaceLinksByTicket.get(ticketId) ?? [])].map(cloneWorkspaceLink);
  }

  async assignAgent(_ticketId: string, _agentId: string, _role?: string, _phase?: string): Promise<void> {
    // In-memory store: no-op (agent assignments tracked in Postgres only)
  }

  /**
   * @description Lists tickets linked to one workspace.
   * @param workspaceId - Workspace identifier.
   * @returns Matching tickets.
   */
  async getTicketsByWorkspace(workspaceId: string): Promise<InternalTicket[]> {
    const ticketIds = Array.from(this.workspaceLinksByTicket.entries())
      .filter(([, links]) => links.some((link) => link.workspaceId === workspaceId))
      .map(([ticketId]) => ticketId);
    return ticketIds
      .map((ticketId) => this.tickets.get(ticketId))
      .filter((ticket): ticket is InternalTicket => Boolean(ticket))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneTicket);
  }

  /**
   * @description Returns status history newest first.
   * @param ticketId - Ticket identifier.
   * @param limit - Max number of entries.
   * @returns Status history rows.
   */
  async getStatusHistory(ticketId: string, limit = 50): Promise<TicketStatusHistoryRecord[]> {
    const entries = [...(this.statusHistoryByTicket.get(ticketId) ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(cloneStatusHistoryRecord);
    logger.debug({ ticketId, count: entries.length }, 'Read ticket status history from memory');
    return entries;
  }

  /**
   * @description Records one status transition in memory.
   * @param ticketId - Ticket identifier.
   * @param fromStatus - Previous status.
   * @param toStatus - Next status.
   * @param changedBy - Actor identifier.
   * @param changedByLabel - Human-readable actor label.
   */
  async recordStatusHistory(
    ticketId: string,
    fromStatus: string | null,
    toStatus: string,
    changedBy: string,
    changedByLabel: string,
    metadata: TicketStatusMetadata = {},
  ): Promise<void> {
    const history = [...(this.statusHistoryByTicket.get(ticketId) ?? [])];
    history.push({
      id: randomUUID(),
      ticketId,
      fromStatus,
      toStatus,
      changedBy,
      changedByLabel,
      metadata: cloneRecord(metadata),
      createdAt: new Date().toISOString(),
    });
    this.statusHistoryByTicket.set(ticketId, history);
  }
}

function deriveStateFields(status: OshalTicketState): [OshalTicketStateGroup, OshalTicketExecutionPhase | null] {
  if (status.startsWith('in_process_')) {
    return ['in_process', status.replace('in_process_', '') as OshalTicketExecutionPhase];
  }

  const directMap: Record<string, OshalTicketStateGroup> = {
    backlog: 'backlog',
    approved: 'approved',
    in_process: 'in_process',   // bare in_process (chat-tickets) — open, no execution phase
    approval_required: 'approval_required',
    customer_action: 'customer_action',
    complete: 'complete',
    escalated: 'escalated',
    dead_letter: 'escalated', // DLQ quarantine groups under escalated (no new state_group)
    paused: 'paused',
    cancelled: 'cancelled',
  };

  return [directMap[status] ?? 'backlog', null];
}

function cloneTicket(ticket: InternalTicket): InternalTicket {
  return {
    ...ticket,
    labels: [...ticket.labels],
    metadata: cloneRecord(ticket.metadata),
  };
}

function cloneTaskLink(link: TicketTaskLink): TicketTaskLink {
  return { ...link };
}

function cloneWorkspaceLink(link: TicketWorkspaceLink): TicketWorkspaceLink {
  return { ...link };
}

function cloneStatusHistoryRecord(record: TicketStatusHistoryRecord): TicketStatusHistoryRecord {
  return { ...record, metadata: cloneRecord(record.metadata) };
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return { ...value };
}
