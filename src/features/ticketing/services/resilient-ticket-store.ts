/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added resilient ticket store wrapper that falls back to in-memory persistence during MOCK_OIDC localhost runs when Postgres is unavailable
 */

import type { Pool } from 'pg';
import type {
  ITicketStore,
  TicketStatusHistoryRecord,
  TicketStatusMetadata,
  TicketStatusUpdateContext,
  CreateInternalTicketInput,
  InternalTicket,
  TicketTaskLink,
  TicketTaskLinkRole,
  TicketWorkspaceLink,
  OshalTicketState,
} from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { InMemoryTicketStore } from './in-memory-ticket-store';
import { PostgresTicketStore } from './ticket-store-postgres';

const logger = createChildLogger({ module: 'ResilientTicketStore' });

/**
 * @description Ticket persistence wrapper that keeps localhost MOCK_OIDC flows working without Postgres.
 */
export class ResilientTicketStore implements ITicketStore {
  private readonly pool: Pool;

  private primary: PostgresTicketStore | null = null;

  private readonly fallback = new InMemoryTicketStore();

  private persistentMode = true;

  private readonly allowMemoryFallback: boolean;

  constructor(pool: Pool, allowMemoryFallback = isMockOidcEnabled()) {
    this.pool = pool;
    this.allowMemoryFallback = allowMemoryFallback;
  }

  /**
   * @description Creates a ticket using Postgres when available, else memory fallback.
   * @param input - Ticket creation input.
   * @returns Created ticket.
   */
  async create(input: CreateInternalTicketInput): Promise<InternalTicket> {
    return this.execute('create', (store) => store.create(input), () => this.fallback.create(input));
  }

  /**
   * @description Gets a ticket by id.
   * @param ticketId - Ticket identifier.
   * @returns Ticket or null.
   */
  async get(ticketId: string): Promise<InternalTicket | null> {
    return this.execute('get', (store) => store.get(ticketId), () => this.fallback.get(ticketId));
  }

  /**
   * @description Gets a ticket by external id.
   * @param externalProvider - External provider key.
   * @param externalId - Provider-native id.
   * @returns Ticket or null.
   */
  async getByExternalId(externalProvider: string, externalId: string): Promise<InternalTicket | null> {
    return this.execute(
      'getByExternalId',
      (store) => store.getByExternalId(externalProvider, externalId),
      () => this.fallback.getByExternalId(externalProvider, externalId),
    );
  }

  async findActiveByMetadataKey(key: string, value: string): Promise<InternalTicket | null> {
    return this.execute(
      'findActiveByMetadataKey',
      (store) => store.findActiveByMetadataKey(key, value),
      () => this.fallback.findActiveByMetadataKey(key, value),
    );
  }

  /**
   * @description Updates one ticket status.
   * @param ticketId - Ticket identifier.
   * @param status - New status.
   */
  async updateStatus(
    ticketId: string,
    status: OshalTicketState,
    context?: TicketStatusUpdateContext,
  ): Promise<void> {
    await this.execute(
      'updateStatus',
      (store) => store.updateStatus(ticketId, status, context),
      () => this.fallback.updateStatus(ticketId, status, context),
    );
  }

  /**
   * @description Updates one ticket record.
   * @param ticketId - Ticket identifier.
   * @param updates - Partial field updates.
   */
  async update(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt'>>): Promise<void> {
    await this.execute('update', (store) => store.update(ticketId, updates), () => this.fallback.update(ticketId, updates));
  }

  /**
   * @description Deletes one ticket.
   * @param ticketId - Ticket identifier.
   */
  async delete(ticketId: string): Promise<void> {
    await this.execute('delete', (store) => store.delete(ticketId), () => this.fallback.delete(ticketId));
  }

  /**
   * @description Lists tickets with optional filters.
   * @param options - List filters.
   * @returns Matching tickets.
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
    return this.execute('list', (store) => store.list(options), () => this.fallback.list(options));
  }

  /**
   * @description Links a task to a ticket.
   * @param ticketId - Ticket identifier.
   * @param taskId - Task identifier.
   * @param role - Link role.
   */
  async linkTask(ticketId: string, taskId: string, role?: TicketTaskLinkRole): Promise<void> {
    await this.execute('linkTask', (store) => store.linkTask(ticketId, taskId, role), () => this.fallback.linkTask(ticketId, taskId, role));
  }

  /**
   * @description Unlinks a task from a ticket.
   * @param ticketId - Ticket identifier.
   * @param taskId - Task identifier.
   */
  async unlinkTask(ticketId: string, taskId: string): Promise<void> {
    await this.execute('unlinkTask', (store) => store.unlinkTask(ticketId, taskId), () => this.fallback.unlinkTask(ticketId, taskId));
  }

  /**
   * @description Reads task links for one ticket.
   * @param ticketId - Ticket identifier.
   * @returns Ticket-task links.
   */
  async getTaskLinks(ticketId: string): Promise<TicketTaskLink[]> {
    return this.execute('getTaskLinks', (store) => store.getTaskLinks(ticketId), () => this.fallback.getTaskLinks(ticketId));
  }

  /**
   * @description Reads ticket links for one task.
   * @param taskId - Task identifier.
   * @returns Ticket links.
   */
  async getTicketLinksForTask(taskId: string): Promise<TicketTaskLink[]> {
    return this.execute('getTicketLinksForTask', (store) => store.getTicketLinksForTask(taskId), () => this.fallback.getTicketLinksForTask(taskId));
  }

  /**
   * @description Links a workspace to a ticket.
   * @param ticketId - Ticket identifier.
   * @param workspaceId - Workspace identifier.
   */
  async linkWorkspace(ticketId: string, workspaceId: string): Promise<void> {
    await this.execute('linkWorkspace', (store) => store.linkWorkspace(ticketId, workspaceId), () => this.fallback.linkWorkspace(ticketId, workspaceId));
  }

  /**
   * @description Unlinks a workspace from a ticket.
   * @param ticketId - Ticket identifier.
   * @param workspaceId - Workspace identifier.
   */
  async unlinkWorkspace(ticketId: string, workspaceId: string): Promise<void> {
    await this.execute('unlinkWorkspace', (store) => store.unlinkWorkspace(ticketId, workspaceId), () => this.fallback.unlinkWorkspace(ticketId, workspaceId));
  }

  /**
   * @description Reads workspace links for one ticket.
   * @param ticketId - Ticket identifier.
   * @returns Workspace links.
   */
  async getWorkspaceLinks(ticketId: string): Promise<TicketWorkspaceLink[]> {
    return this.execute('getWorkspaceLinks', (store) => store.getWorkspaceLinks(ticketId), () => this.fallback.getWorkspaceLinks(ticketId));
  }

  async assignAgent(ticketId: string, agentId: string, role?: string, phase?: string): Promise<void> {
    await this.execute('assignAgent', (store) => store.assignAgent(ticketId, agentId, role, phase), () => this.fallback.assignAgent(ticketId, agentId, role, phase));
  }

  /**
   * @description Lists tickets belonging to one workspace.
   * @param workspaceId - Workspace identifier.
   * @returns Matching tickets.
   */
  async getTicketsByWorkspace(workspaceId: string): Promise<InternalTicket[]> {
    return this.execute('getTicketsByWorkspace', (store) => store.getTicketsByWorkspace(workspaceId), () => this.fallback.getTicketsByWorkspace(workspaceId));
  }

  /**
   * @description Reads status history for one ticket.
   * @param ticketId - Ticket identifier.
   * @param limit - Max entries.
   * @returns Status history rows.
   */
  async getStatusHistory(ticketId: string, limit?: number): Promise<TicketStatusHistoryRecord[]> {
    return this.execute('getStatusHistory', (store) => store.getStatusHistory(ticketId, limit), () => this.fallback.getStatusHistory(ticketId, limit));
  }

  /**
   * @description Records a status history row.
   * @param ticketId - Ticket identifier.
   * @param fromStatus - Previous status.
   * @param toStatus - New status.
   * @param changedBy - Actor identifier.
   * @param changedByLabel - Human-readable actor label.
   */
  async recordStatusHistory(
    ticketId: string,
    fromStatus: string | null,
    toStatus: string,
    changedBy: string,
    changedByLabel: string,
    metadata?: TicketStatusMetadata,
  ): Promise<void> {
    await this.execute(
      'recordStatusHistory',
      (store) => store.recordStatusHistory(ticketId, fromStatus, toStatus, changedBy, changedByLabel, metadata),
      () => this.fallback.recordStatusHistory(ticketId, fromStatus, toStatus, changedBy, changedByLabel, metadata),
    );
  }

  private async execute<T>(
    operation: string,
    primaryAction: (store: PostgresTicketStore) => Promise<T>,
    fallbackAction: () => Promise<T>,
  ): Promise<T> {
    if (!this.persistentMode) {
      // Not yet in persistent mode — try Postgres, fall back to memory on failure
      try {
        const result = await primaryAction(this.getPrimaryStore());
        // Success! Lock into Postgres permanently
        this.persistentMode = true;
        logger.info({ operation }, 'Postgres connection established — ticket persistence locked to Postgres');
        return result;
      } catch (error) {
        if (!this.allowMemoryFallback || !isDatabaseConnectionFailure(error)) {
          throw error;
        }
        // Reset primary so next call creates a fresh PostgresTicketStore
        this.primary = null;
        logger.warn({ err: error, operation }, 'Postgres not ready — using in-memory fallback (will retry next call)');
        return fallbackAction();
      }
    }

    // Already locked to Postgres — no fallback
    return primaryAction(this.getPrimaryStore());
  }

  private getPrimaryStore(): PostgresTicketStore {
    if (!this.primary) {
      this.primary = new PostgresTicketStore(this.pool);
    }
    return this.primary;
  }
}

function isMockOidcEnabled(): boolean {
  const value = (process.env.MOCK_OIDC ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function isDatabaseConnectionFailure(error: unknown): boolean {
  const code = readErrorCode(error);
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(code)) {
    return true;
  }

  const message = readErrorMessage(error).toLowerCase();
  if (
    message.includes('connect econnrefused')
    || message.includes('connection terminated unexpectedly')
    || message.includes('database system is starting up')
    || message.includes('failed to connect')
  ) {
    return true;
  }

  const nestedErrors = readAggregateErrors(error);
  return nestedErrors.some((nestedError) => isDatabaseConnectionFailure(nestedError));
}

function readErrorCode(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === 'string'
    ? ((error as { code: string }).code)
    : '';
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function readAggregateErrors(error: unknown): unknown[] {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors;
  }

  const aggregateErrors = (error as { aggregateErrors?: unknown[] })?.aggregateErrors;
  return Array.isArray(aggregateErrors) ? aggregateErrors : [];
}
