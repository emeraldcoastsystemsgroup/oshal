/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial TicketService with state transitions, linking, and business logic orchestration
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Defaulted new internal tickets onto canonical project metadata so root tickets always land in the Default project unless explicitly assigned
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added paused and cancelled transition rules so rebuilt runtimes can expose operator lifecycle controls without TypeScript build failures
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: added getStatusHistory delegation and actor-aware updateStatusAs for cockpit-driven transitions
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | VALID_TRANSITIONS: allow in_process_discovery → customer_action — the incident-rca Mode A/B disposition was rejected here, silently downgrading proposed-solution/human-action incidents to 'escalated' via the pipeline's catch (found by the 2026-07-08 adversarial double-check, live-proven against the running DB)
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Queue DLQ (migration 081): 'dead_letter' reachable from approved / every dispatchable in_process_* phase / approval_required / escalated (the two quarantine triggers are a dispatch-failure mid-flight and the Nth escalation cycle), leaves only via operator requeue (approved) or backlog/cancelled. buildStatusTransitionMetadata backstops dead_letter transitions with reason/source/nextAction the same way it already backstops escalations, so a reason-less quarantine is structurally impossible.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 graph ingestion: createTicket and assignAgent now emit sanitized ticket-created / agent-assigned events onto the shared ticketEvents bus (ids/title/status only — never the description), giving the swarm operational graph an observable lifecycle seam without instrumenting call sites. Status transitions were already emitted by the stores.
 */

import {
  applyDerivedQueueMetadata,
  type ITicketStore,
  type TicketStatusHistoryRecord,
  type TicketStatusMetadata,
  type InternalTicket,
  type CreateInternalTicketInput,
  type TicketTaskLink,
  type TicketTaskLinkRole,
  type TicketWorkspaceLink,
  type OshalTicketState,
} from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { ticketEvents } from '@/shared/ticket-events';

const logger = createChildLogger({ module: 'TicketService' });

/**
 * @description External providers whose incident tickets auto-approve (skip the
 * front approval gate) because they are pre-validated monitoring alarms. The
 * approve-or-close gate then lands at the end of the incident-rca pipeline.
 */
const TRUSTED_ALERT_PROVIDERS = new Set(['prometheus', 'alertmanager']);

/**
 * @description Valid state transitions for the OshalTicketState lifecycle.
 */
const VALID_TRANSITIONS: Record<OshalTicketState, Set<OshalTicketState>> = {
  backlog: new Set(['approved', 'escalated', 'paused', 'cancelled']),
  approved: new Set(['in_process_discovery', 'in_process_design', 'in_process_build', 'backlog', 'escalated', 'dead_letter', 'paused', 'cancelled', 'complete']),
  // Chat-ticket lifecycle: an open conversation that only ever closes (X → complete / cancelled),
  // pauses, or returns to backlog. It is never dispatched, so no in_process_* phase transitions.
  in_process: new Set(['complete', 'cancelled', 'paused', 'backlog']),
  // BUG-FIX 2026-07-08 (double-check session): added customer_action — the incident-rca pipeline's
  // Mode A/B disposition IS in_process_discovery → customer_action (INCIDENT_MODE_DISPOSITION via
  // finalizeIncidentByMode and the Argo finalize-incident hook). It was missing here while every
  // later in_process_* phase allows it, so mode-A/B incidents threw Invalid state transition and
  // the in-process pipeline's catch silently downgraded them to 'escalated' (live
  // ticket_status_history confirmed customer_action had only ever been reached from in_process_build).
  // Queue DLQ: every dispatchable in_process_* phase can quarantine to dead_letter — the
  // DeadLetterService trips mid-flight (the ticket is still in its dispatch entry state
  // when the Nth dispatch failure is recorded, before any rollback to approved).
  in_process_discovery: new Set(['approval_required', 'in_process_build', 'approved', 'customer_action', 'escalated', 'dead_letter', 'complete', 'paused', 'cancelled']),
  in_process_design: new Set(['approval_required', 'in_process_build', 'customer_action', 'escalated', 'dead_letter', 'approved', 'complete', 'paused', 'cancelled']),
  in_process_build: new Set(['approved', 'in_process_deploy', 'in_process_test', 'customer_action', 'complete', 'escalated', 'dead_letter', 'in_process_discovery', 'paused', 'cancelled']),
  in_process_deploy: new Set(['approved', 'in_process_test', 'in_process_build', 'customer_action', 'complete', 'escalated', 'dead_letter', 'paused', 'cancelled']),
  in_process_test: new Set(['approved', 'in_process_release', 'in_process_build', 'customer_action', 'complete', 'escalated', 'dead_letter', 'paused', 'cancelled']),
  in_process_release: new Set(['approved', 'complete', 'in_process_test', 'customer_action', 'escalated', 'dead_letter', 'paused', 'cancelled']),
  // BUG-FIX Session 35: Added customer_action — parent assembly transitions approval_required→customer_action
  // when all children complete. Missing transition caused InvalidStateTransition error on every sweep cycle.
  approval_required: new Set(['in_process_build', 'approved', 'customer_action', 'escalated', 'dead_letter', 'paused', 'cancelled']),
  customer_action: new Set(['approved', 'in_process_discovery', 'in_process_design', 'in_process_build', 'in_process_test', 'escalated', 'complete', 'paused', 'cancelled']),
  complete: new Set(['backlog']),
  // escalated → dead_letter is the poison-loop quarantine: the Nth system escalation cycle
  // (BACKLOG "Build phase auto-escalates") parks the ticket terminally instead of cycling.
  escalated: new Set(['backlog', 'approved', 'in_process_discovery', 'approval_required', 'in_process_design', 'in_process_build', 'dead_letter', 'paused', 'cancelled', 'complete']),
  // DLQ exit paths: operator requeue (approved, attempts reset), triage restart (backlog),
  // or abandonment (cancelled). Never back to an in_process_* phase directly.
  dead_letter: new Set(['approved', 'backlog', 'cancelled']),
  paused: new Set(['approved', 'approval_required', 'backlog', 'escalated', 'cancelled']),
  cancelled: new Set(['backlog']),
};

/**
 * @description Orchestrates ticket lifecycle: creation, state transitions, linking to tasks and workspaces.
 */
export class TicketService {
  /**
   * @param ticketStore - Persistence for ticket records.
   * @param workspaceService - Optional. When provided, deleteTicket cascades
   *   to the linked workspace (DB row + disk directory). Without it, ticket
   *   deletion leaves orphan workspaces on disk and in the workspaces table.
   */
  constructor(
    private readonly ticketStore: ITicketStore,
    private readonly workspaceService?: { deleteWorkspace(id: string): Promise<void> },
  ) {}

  /**
   * @description Creates a new internal ticket.
   * @param input - Ticket creation input
   * @returns The created ticket record
   */
  async createTicket(input: CreateInternalTicketInput): Promise<InternalTicket> {
    // Incident tickets require operator approval — EXCEPT those sourced from a
    // trusted monitoring platform. Prometheus/Alertmanager alerts are pre-validated
    // alarms, so they auto-approve and flow straight through the incident-rca
    // pipeline. The human-in-the-loop gate then happens at the END of the pipeline
    // (approve-or-close the proposed remediation) rather than the front.
    const isTrustedAlertSource =
      input.ticketType === 'incident' &&
      input.externalProvider != null &&
      TRUSTED_ALERT_PROVIDERS.has(input.externalProvider);
    const resolvedStatus = (input.ticketType === 'incident' && !isTrustedAlertSource)
      ? 'approval_required'
      : (input.status ?? 'backlog');
    // Classify the ticket into its proper queue (application) instead of dumping it
    // into "Default". An explicit queueId already on the metadata (e.g. chat rows
    // written as queue=chat) is respected; otherwise the ticketType maps to its
    // owning app queue. This is the single point that reclassifies every creation
    // path that flows through the service.
    const metadata = applyDerivedQueueMetadata(input.metadata ?? {}, {
      ticketType: input.ticketType,
      metadata: input.metadata ?? {},
    });
    logger.info(
      { title: input.title, ticketType: input.ticketType, status: resolvedStatus, queueId: metadata.queueId },
      'Creating ticket',
    );
    const ticket = await this.ticketStore.create({
      ...input,
      status: resolvedStatus,
      metadata,
    });
    logger.info({ ticketId: ticket.ticketId }, 'Ticket created');
    // Sanitized lifecycle broadcast (ADR-045 swarm operational graph, SSE-style consumers).
    // Ids/title/status only — the description deliberately never rides the bus.
    ticketEvents.emitTicketCreated({
      ticketId: ticket.ticketId,
      title: (ticket.title || '').slice(0, 140),
      ticketType: ticket.ticketType,
      status: ticket.status,
      assignedAgentId: ticket.assignedAgentId ?? null,
      parentTicketId: ticket.parentTicketId ?? null,
      timestamp: ticket.createdAt || new Date().toISOString(),
    });
    return ticket;
  }

  /**
   * @description Opens a workflow-less CHAT-ticket for a direct bot-chat thread and links it to
   * the thread's task. The ticket lands in the "Chat" queue (the canonical queue* metadata the
   * board already buckets + filters by), targeted at the chatting bot, and stays `in_process`
   * (never `approved`) so the QueueManager never dispatches it — it just tracks the conversation
   * on the board until the user closes it (X → `complete`). One per thread; callers guard re-open.
   *
   * @param input - taskId (thread), ownerSub (user), agentId (target bot uuid), text (first msg),
   *   and optional targetBot name + queue identity (defaults to the shared Chat queue).
   * @returns The created chat-ticket.
   */
  async openChatTicket(input: {
    taskId: string;
    ownerSub: string;
    agentId?: string | null;
    text: string;
    targetBot?: string | null;
    queueId?: string;
    queueName?: string;
    queueIdentifier?: string;
  }): Promise<InternalTicket> {
    const queueId = input.queueId ?? 'chat';
    const queueName = input.queueName ?? 'Chat';
    const queueIdentifier = input.queueIdentifier ?? 'CHAT';
    const title = (input.text || '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'New chat';
    const ticket = await this.createTicket({
      title,
      ticketType: 'chat',
      description: (input.text || '').slice(0, 2000),
      status: 'in_process',
      priority: 'none',
      labels: [],
      workspaceId: null,
      assignedAgentId: input.agentId ?? null,
      parentTicketId: null,
      externalProvider: null,
      externalId: null,
      externalUrl: null,
      ownerSub: input.ownerSub,
      // queue* are read by mergeTicketQueueMetadata (createTicket) → canonical Chat queue; the
      // extra keys (origin/targetBot/kind/taskId) are preserved (spread) for the board's filters.
      metadata: {
        origin: 'bot-chat',
        queueId, queueName, queueIdentifier,
        targetBot: input.targetBot ?? null,
        kind: 'chat-thread',
        taskId: input.taskId,
      },
    });
    await this.linkTask(ticket.ticketId, input.taskId, 'primary');
    logger.info({ ticketId: ticket.ticketId, taskId: input.taskId, queueId }, 'Opened chat-ticket for thread');
    return ticket;
  }

  /**
   * @description Gets a ticket by ID.
   * @param ticketId - Ticket identifier
   * @returns Ticket record or null
   */
  async getTicket(ticketId: string): Promise<InternalTicket | null> {
    return this.ticketStore.get(ticketId);
  }

  /**
   * @description Gets a ticket by external provider and ID.
   * @param externalProvider - Provider name
   * @param externalId - Provider-native ID
   * @returns Ticket record or null
   */
  async getTicketByExternalId(externalProvider: string, externalId: string): Promise<InternalTicket | null> {
    return this.ticketStore.getByExternalId(externalProvider, externalId);
  }

  /**
   * @description Finds a non-cancelled ticket whose `metadata.<key>` equals the given value.
   * Lets an alert-intake path dedupe by a metadata dedupe key when an upstream platform
   * re-emits the same incident under a new external id.
   * @param key - Metadata field name.
   * @param value - Metadata value to match exactly.
   * @returns Ticket record or null.
   */
  async findActiveTicketByMetadataKey(key: string, value: string): Promise<InternalTicket | null> {
    return this.ticketStore.findActiveByMetadataKey(key, value);
  }

  /**
   * @description Updates ticket status with transition validation.
   * @param ticketId - Ticket identifier
   * @param newStatus - Target OshalTicketState
   * @throws Error if transition is invalid or ticket not found
   */
  async updateStatus(
    ticketId: string,
    newStatus: OshalTicketState,
    metadata?: TicketStatusMetadata,
  ): Promise<void> {
    const ticket = await this.ticketStore.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    const current = ticket.status;
    if (current === newStatus) return;

    const allowed = VALID_TRANSITIONS[current];
    if (!allowed?.has(newStatus)) {
      throw new Error(`Invalid state transition: ${current} → ${newStatus} for ticket ${ticketId}`);
    }

    const transitionMetadata = buildStatusTransitionMetadata(ticketId, current, newStatus, metadata);
    logger.info({ ticketId, from: current, to: newStatus }, 'Transitioning ticket status');
    await this.ticketStore.updateStatus(ticketId, newStatus, { metadata: transitionMetadata });
  }

  /**
   * @description Updates ticket status with a known actor identity (e.g. cockpit user vs system).
   * Records history with the actor label and emits an SSE event with the correct actor.
   * @param ticketId - Ticket identifier
   * @param newStatus - Target OshalTicketState
   * @param changedBy - Actor identifier
   * @param changedByLabel - Human-readable actor label
   */
  async updateStatusAs(
    ticketId: string,
    newStatus: OshalTicketState,
    changedBy: string,
    changedByLabel: string,
    metadata?: TicketStatusMetadata,
  ): Promise<void> {
    const ticket = await this.ticketStore.get(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    const current = ticket.status;
    if (current === newStatus) return;

    const allowed = VALID_TRANSITIONS[current];
    if (!allowed?.has(newStatus)) throw new Error(`Invalid state transition: ${current} → ${newStatus}`);

    const transitionMetadata = buildStatusTransitionMetadata(ticketId, current, newStatus, metadata, changedBy);
    logger.info({ ticketId, from: current, to: newStatus, changedBy }, 'Transitioning ticket status (actor-aware)');
    await this.ticketStore.updateStatus(ticketId, newStatus, { changedBy, changedByLabel, metadata: transitionMetadata });
  }

  /**
   * @description Returns the status transition history for a ticket.
   * @param ticketId - Ticket identifier
   * @param limit - Max entries (default 50)
   * @returns Array of status history records newest-first
   */
  async getStatusHistory(ticketId: string, limit?: number): Promise<TicketStatusHistoryRecord[]> {
    return this.ticketStore.getStatusHistory(ticketId, limit);
  }

  /**
   * @description Records an internal ticket activity note without changing the ticket status.
   * Used for worker heartbeats/provider diagnostics so long-running executions leave an
   * operator-visible trail even when the final state has not changed yet.
   */
  async recordActivity(ticketId: string, metadata: TicketStatusMetadata): Promise<void> {
    const ticket = await this.ticketStore.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    const changedBy = readNonEmptyString(metadata.agentId) ?? readNonEmptyString(metadata.changedBy) ?? 'system';
    const changedByLabel = readNonEmptyString(metadata.agentName) ?? readNonEmptyString(metadata.changedByLabel) ?? 'Swarm Worker';
    await this.ticketStore.recordStatusHistory(ticketId, ticket.status, ticket.status, changedBy, changedByLabel, {
      ...metadata,
      internalActivity: true,
      currentStatus: ticket.status,
    });
  }

  /**
   * @description Partially updates ticket fields (not status).
   * @param ticketId - Ticket identifier
   * @param updates - Partial ticket fields
   */
  async updateTicket(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt' | 'status'>>): Promise<void> {
    logger.info({ ticketId }, 'Updating ticket fields');
    await this.ticketStore.update(ticketId, updates);
  }

  /**
   * @description Deletes a ticket and cascades to its workspace (DB row +
   * disk directory) if a WorkspaceService was injected. Without the cascade
   * dependency, only the ticket row is removed and a warning is logged so
   * operators know orphans may accumulate.
   * @param ticketId - Ticket identifier
   */
  async deleteTicket(ticketId: string): Promise<void> {
    logger.info({ ticketId }, 'Deleting ticket');
    // Read the workspace link BEFORE deleting the ticket row.
    const ticket = await this.ticketStore.get(ticketId);
    const workspaceId = ticket?.workspaceId;

    await this.ticketStore.delete(ticketId);

    if (workspaceId && this.workspaceService) {
      try {
        await this.workspaceService.deleteWorkspace(workspaceId);
      } catch (err) {
        logger.warn({ err, ticketId, workspaceId }, 'Workspace cascade-delete failed — orphan possible');
      }
    } else if (workspaceId) {
      logger.warn(
        { ticketId, workspaceId },
        'TicketService has no WorkspaceService — workspace orphan left behind',
      );
    }
  }

  /**
   * @description Lists tickets with optional filtering.
   * @param options - Filter options
   * @returns Array of tickets
   */
  async listTickets(options?: Parameters<ITicketStore['list']>[0]): Promise<InternalTicket[]> {
    return this.ticketStore.list(options);
  }

  /**
   * @description Links a task to a ticket.
   * @param ticketId - Ticket identifier
   * @param taskId - Task identifier
   * @param role - Link role
   */
  async linkTask(ticketId: string, taskId: string, role: TicketTaskLinkRole = 'primary'): Promise<void> {
    logger.info({ ticketId, taskId, role }, 'Linking task to ticket');
    await this.ticketStore.linkTask(ticketId, taskId, role);
  }

  /**
   * @description Links a workspace to a ticket.
   * @param ticketId - Ticket identifier
   * @param workspaceId - Workspace identifier
   */
  async linkWorkspace(ticketId: string, workspaceId: string): Promise<void> {
    logger.info({ ticketId, workspaceId }, 'Linking workspace to ticket');
    await this.ticketStore.linkWorkspace(ticketId, workspaceId);
  }

  /**
   * @description Records an agent assignment to a ticket. Supports multiple agents per ticket.
   * Uses upsert so duplicate assignments are idempotent.
   * @param ticketId - Ticket identifier
   * @param agentId - Agent identifier
   * @param role - Assignment role (e.g. 'architect', 'executor', 'reviewer')
   * @param phase - Optional phase identifier
   */
  async assignAgent(ticketId: string, agentId: string, role: string = 'executor', phase?: string): Promise<void> {
    logger.info({ ticketId, agentId, role, phase }, 'Recording agent assignment to ticket');
    await this.ticketStore.assignAgent(ticketId, agentId, role, phase);
    // Lifecycle broadcast for the swarm operational graph (ADR-045) — ids only.
    ticketEvents.emitAgentAssigned({ ticketId, agentId, role, phase, timestamp: new Date().toISOString() });
  }

  /**
   * @description Returns all tickets for a workspace.
   * @param workspaceId - Workspace identifier
   * @returns Array of tickets
   */
  async getTicketsByWorkspace(workspaceId: string): Promise<InternalTicket[]> {
    return this.ticketStore.getTicketsByWorkspace(workspaceId);
  }

  /**
   * @description Returns all tasks linked to a ticket.
   * @param ticketId - Ticket identifier
   * @returns Array of task links
   */
  async getTasksForTicket(ticketId: string): Promise<TicketTaskLink[]> {
    return this.ticketStore.getTaskLinks(ticketId);
  }

  /**
   * @description Returns all workspace links for a ticket.
   * @param ticketId - Ticket identifier
   * @returns Array of workspace links
   */
  async getWorkspacesForTicket(ticketId: string): Promise<TicketWorkspaceLink[]> {
    return this.ticketStore.getWorkspaceLinks(ticketId);
  }

  /**
   * @description Returns all ticket links for a task.
   * @param taskId - Task identifier
   * @returns Array of ticket-task links
   */
  async getTicketLinksForTask(taskId: string): Promise<TicketTaskLink[]> {
    return this.ticketStore.getTicketLinksForTask(taskId);
  }
}

function buildStatusTransitionMetadata(
  ticketId: string,
  fromStatus: OshalTicketState,
  toStatus: OshalTicketState,
  metadata?: TicketStatusMetadata,
  changedBy?: string,
): TicketStatusMetadata {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  // DLQ quarantine backstop — same discipline as escalations: a dead_letter transition
  // without a reason/source is structurally impossible, so the operator DLQ view always
  // has a debuggable "why" (BACKLOG "Build phase auto-escalates" (b) parity).
  if (toStatus === 'dead_letter') {
    return {
      ...base,
      reason: readNonEmptyString(base.reason) ?? 'unspecified_dead_letter',
      source: readNonEmptyString(base.source) ?? 'ticket-service',
      severity: readNonEmptyString(base.severity) ?? 'high',
      nextAction: readNonEmptyString(base.nextAction) ?? 'operator_requeue_or_cancel',
      previousStatus: readNonEmptyString(base.previousStatus) ?? fromStatus,
      ticketId: readNonEmptyString(base.ticketId) ?? ticketId,
      quarantinedAt: readNonEmptyString(base.quarantinedAt) ?? new Date().toISOString(),
      ...(changedBy ? { changedBy } : {}),
    };
  }
  if (toStatus !== 'escalated') {
    return base;
  }

  return {
    ...base,
    reason: readNonEmptyString(base.reason) ?? 'unspecified_escalation',
    source: readNonEmptyString(base.source) ?? 'ticket-service',
    severity: readNonEmptyString(base.severity) ?? 'medium',
    nextAction: readNonEmptyString(base.nextAction) ?? 'operator_review_required',
    previousStatus: readNonEmptyString(base.previousStatus) ?? fromStatus,
    ticketId: readNonEmptyString(base.ticketId) ?? ticketId,
    escalatedAt: readNonEmptyString(base.escalatedAt) ?? new Date().toISOString(),
    ...(changedBy ? { changedBy } : {}),
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
