/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ITicketStore interface for ticket CRUD and linking operations
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: added getStatusHistory to interface
 */

import type { OshalTicketState } from './types';
import type {
  InternalTicket,
  CreateInternalTicketInput,
  TicketTaskLink,
  TicketTaskLinkRole,
  TicketWorkspaceLink,
} from './internal-ticket';

/**
 * @description Interface for ticket persistence operations.
 * Implementations may use PostgreSQL or in-memory storage.
 * Covers ticket CRUD, status transitions, and ticket↔task/workspace linking.
 */
export interface ITicketStore {
  /**
   * @description Create a new internal ticket.
   * @param input - Ticket creation input
   * @returns The created ticket record
   */
  create(input: CreateInternalTicketInput): Promise<InternalTicket>;

  /**
   * @description Get a ticket by ID.
   * @param ticketId - Ticket identifier (UUID)
   * @returns Ticket record or null
   */
  get(ticketId: string): Promise<InternalTicket | null>;

  /**
   * @description Get a ticket by its external provider and external ID.
   * @param externalProvider - Provider name (e.g., 'plane', 'github')
   * @param externalId - Provider-native identifier
   * @returns Ticket record or null
   */
  getByExternalId(externalProvider: string, externalId: string): Promise<InternalTicket | null>;

  /**
   * @description Find a non-cancelled ticket whose `metadata.<key>` equals the given value.
   * Used by intake paths (e.g. the retired staged-item intake's metadata dedupe key) to catch duplicate
   * upstream events that have different external ids but represent the same underlying incident.
   * Matches tickets in any status EXCEPT 'cancelled'. Returns the first match if multiple exist.
   * @param key - Metadata field name.
   * @param value - Metadata value to match exactly.
   * @returns Ticket record or null.
   */
  findActiveByMetadataKey(key: string, value: string): Promise<InternalTicket | null>;

  /**
   * @description Update a ticket's status and derived state group / execution phase.
   * @param ticketId - Ticket identifier
   * @param status - New OshalTicketState
   */
  updateStatus(ticketId: string, status: OshalTicketState, context?: TicketStatusUpdateContext): Promise<void>;

  /**
   * @description Partial update of ticket fields (title, description, priority, labels, etc.).
   * @param ticketId - Ticket identifier
   * @param updates - Partial ticket fields to update
   */
  update(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt'>>): Promise<void>;

  /**
   * @description Delete a ticket and cascade-delete its links.
   * @param ticketId - Ticket identifier
   */
  delete(ticketId: string): Promise<void>;

  /**
   * @description List tickets with optional filtering.
   * @param options - Filter options
   * @returns Array of matching tickets
   */
  list(options?: {
    status?: OshalTicketState;
    workspaceId?: string;
    assignedAgentId?: string;
    parentTicketId?: string | null;
    ticketType?: string;
    /** Scope to a single owner's tickets (OIDC `sub`) for per-user isolation. */
    ownerSub?: string;
    limit?: number;
    offset?: number;
  }): Promise<InternalTicket[]>;

  /**
   * @description Link a task to a ticket.
   * @param ticketId - Ticket identifier
   * @param taskId - Task identifier (chat_tasks.task_id)
   * @param role - Link role (primary, review, subtask)
   */
  linkTask(ticketId: string, taskId: string, role?: TicketTaskLinkRole): Promise<void>;

  /**
   * @description Unlink a task from a ticket.
   * @param ticketId - Ticket identifier
   * @param taskId - Task identifier
   */
  unlinkTask(ticketId: string, taskId: string): Promise<void>;

  /**
   * @description Get all task links for a ticket.
   * @param ticketId - Ticket identifier
   * @returns Array of ticket-task links
   */
  getTaskLinks(ticketId: string): Promise<TicketTaskLink[]>;

  /**
   * @description Get all ticket links for a task.
   * @param taskId - Task identifier
   * @returns Array of ticket-task links
   */
  getTicketLinksForTask(taskId: string): Promise<TicketTaskLink[]>;

  /**
   * @description Link a workspace to a ticket.
   * @param ticketId - Ticket identifier
   * @param workspaceId - Workspace identifier
   */
  linkWorkspace(ticketId: string, workspaceId: string): Promise<void>;

  /**
   * @description Unlink a workspace from a ticket.
   * @param ticketId - Ticket identifier
   * @param workspaceId - Workspace identifier
   */
  unlinkWorkspace(ticketId: string, workspaceId: string): Promise<void>;

  /**
   * @description Record an agent assignment to a ticket (idempotent upsert).
   * @param ticketId - Ticket identifier
   * @param agentId - Agent identifier
   * @param role - Assignment role
   * @param phase - Optional phase
   */
  assignAgent(ticketId: string, agentId: string, role?: string, phase?: string): Promise<void>;

  /**
   * @description Get all workspace links for a ticket.
   * @param ticketId - Ticket identifier
   * @returns Array of ticket-workspace links
   */
  getWorkspaceLinks(ticketId: string): Promise<TicketWorkspaceLink[]>;

  /**
   * @description Get all tickets linked to a workspace.
   * @param workspaceId - Workspace identifier
   * @returns Array of tickets
   */
  getTicketsByWorkspace(workspaceId: string): Promise<InternalTicket[]>;

  /**
   * @description Returns the status transition history for a ticket, newest first.
   * @param ticketId - Ticket identifier
   * @param limit - Max entries to return (default 50)
   * @returns Array of status history records
   */
  getStatusHistory(ticketId: string, limit?: number): Promise<TicketStatusHistoryRecord[]>;

  /**
   * @description Records a status transition in the history table.
   * @param ticketId - Ticket identifier
   * @param fromStatus - Previous status (null for initial creation)
   * @param toStatus - New status
   * @param changedBy - Actor identifier ('system', 'user', or agent ID)
   * @param changedByLabel - Human-readable actor label
   */
  recordStatusHistory(
    ticketId: string,
    fromStatus: string | null,
    toStatus: string,
    changedBy: string,
    changedByLabel: string,
    metadata?: TicketStatusMetadata,
  ): Promise<void>;
}

export type TicketStatusMetadata = Record<string, unknown>;

export interface TicketStatusUpdateContext {
  changedBy?: string;
  changedByLabel?: string;
  metadata?: TicketStatusMetadata;
}

/**
 * @description One row from the ticket_status_history table.
 */
export interface TicketStatusHistoryRecord {
  id: string;
  ticketId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  changedByLabel: string;
  metadata: TicketStatusMetadata;
  createdAt: string;
}
