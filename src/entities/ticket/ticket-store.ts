/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ITicketStore interface for ticket CRUD and linking operations
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: added getStatusHistory to interface
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): added findLatestByMetadataKey — the consolidation stage needs the NEWEST ticket for an incident key in ANY status (open ⇒ consolidate the refire onto it; terminal ⇒ open a recurrence-linked successor, FR-C5), which findActiveByMetadataKey (oldest-first, cancelled-only exclusion) cannot answer
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Add expected-state and atomic dead-letter context to status writes so PostgreSQL can commit ticket, task, history and exact refusal evidence together.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Give expected-state compare-and-set failures a shared typed contract so services can distinguish a lost race from unrelated persistence failures without parsing error text.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Add the reverse atomic dead-letter requeue mutation so ticket/history release and DLQ counter/evidence reset share one locked transaction.
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
   * @description Find the MOST RECENTLY CREATED ticket whose `metadata.<key>` equals the
   * given value, in ANY status (terminal included). The alert-triage consolidation stage
   * (ADR-119 P1) uses this to decide between updating the open incident ticket for an
   * incident key and opening a recurrence-linked successor after the prior one went terminal.
   * @param key - Metadata field name.
   * @param value - Metadata value to match exactly.
   * @returns Newest matching ticket record or null.
   */
  findLatestByMetadataKey(key: string, value: string): Promise<InternalTicket | null>;

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

/**
 * An expected-status compare-and-set lost to another committed transition.
 * Stores throw this exact type only after reading the current persisted/in-memory status.
 */
export class TicketStatusConflictError extends Error {
  readonly name = 'TicketStatusConflictError';

  constructor(
    public readonly ticketId: string,
    public readonly expectedStatus: OshalTicketState,
    public readonly actualStatus: OshalTicketState,
  ) {
    super(
      `Ticket status changed concurrently: expected ${expectedStatus}, found ${actualStatus} for ${ticketId}`,
    );
  }
}

/**
 * One DLQ mutation that must commit in the same transaction as a dead_letter status change.
 * `reason` is the stable machine code; `lastError` is the exact safe human-readable message;
 * `remedy` is present only when a reviewed operator action exists.
 */
export interface TicketDeadLetterMutation {
  reason: string;
  lastError: string | null;
  remedy?: string | null;
  attempts: number;
}

/** The operator audit fact persisted while atomically releasing one quarantined DLQ row. */
export interface TicketDeadLetterRequeueMutation {
  requeuedBy: string;
}

export interface TicketStatusUpdateContext {
  changedBy?: string;
  changedByLabel?: string;
  metadata?: TicketStatusMetadata;
  /** Locked state expected from TicketService's validated read; closes the pre-read race. */
  expectedStatus?: OshalTicketState;
  /** Optional DLQ upsert/marker committed with ticket, linked-task and history writes. */
  deadLetter?: TicketDeadLetterMutation;
  /** Optional quarantined DLQ reset committed with a dead_letter -> approved transition. */
  deadLetterRequeue?: TicketDeadLetterRequeueMutation;
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
