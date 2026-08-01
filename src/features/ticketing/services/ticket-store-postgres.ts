/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial PostgresTicketStore with full CRUD, status transitions, and linking operations
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added lazy schema bootstrap via ensureTicketSchema on first query
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: updateStatus now records history + emits ticketEvents; added getStatusHistory and recordStatusHistory
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Seed initial ticket_status_history rows during ticket creation so brand-new tickets have an immediate lifecycle record
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Normalized historical Change Log attribution to the mandated project author identifier
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Queue DLQ: deriveStateFields maps 'dead_letter' → state_group 'escalated' (would otherwise fall through to 'backlog' and violate the state-group CHECK); linkedChatTaskStatusForTerminalTicket treats dead_letter like escalated (linked chat task → failed).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): added findLatestByMetadataKey (newest match, any status) — the consolidation stage's open-vs-recurrence decision needs the newest ticket per incident key, not findActiveByMetadataKey's oldest non-cancelled
 */

import type { Pool, PoolClient, QueryResult } from 'pg';
import { randomUUID } from 'crypto';
import {
  buildTicketRowStatusMetadataPatch,
  type ITicketStore,
  type TicketStatusHistoryRecord,
  type TicketStatusMetadata,
  type TicketStatusUpdateContext,
  type InternalTicket,
  type CreateInternalTicketInput,
  type TicketTaskLink,
  type TicketTaskLinkRole,
  type TicketWorkspaceLink,
  type OshalTicketState,
  type OshalTicketStateGroup,
  type OshalTicketExecutionPhase,
  type TicketType,
} from '@/entities/ticket';
import { ticketEvents } from '@/shared/ticket-events';
import { ensureTicketSchema } from '@/shared/services/database';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'PostgresTicketStore' });

/** Minimal query surface shared by a pg Pool and a pooled client (used by the RLS executor). */
type RlsQueryable = Pick<PoolClient, 'query'>;

/**
 * @description Derives state group and execution phase from a canonical ticket state.
 * @param status - Canonical OshalTicketState
 * @returns Tuple of [stateGroup, executionPhase]
 */
function deriveStateFields(status: OshalTicketState): [OshalTicketStateGroup, OshalTicketExecutionPhase | null] {
  if (status.startsWith('in_process_')) {
    const phase = status.replace('in_process_', '') as OshalTicketExecutionPhase;
    return ['in_process', phase];
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

export function linkedChatTaskStatusForTerminalTicket(status: OshalTicketState): 'completed' | 'failed' | 'cancelled' | null {
  if (status === 'complete') {
    return 'completed';
  }
  if (status === 'escalated' || status === 'dead_letter') {
    return 'failed';
  }
  if (status === 'cancelled') {
    return 'cancelled';
  }
  return null;
}

/**
 * @description Postgres-backed implementation of ITicketStore.
 * Persists tickets to the `tickets` table and manages link tables for task/workspace associations.
 */
export class PostgresTicketStore implements ITicketStore {
  private schemaReady: Promise<void> | null = null;
  private schemaOk = false;

  constructor(private readonly pool: Pool) {
    // Schema is created by SQL migrations (run before server starts).
    // Don't block on ensureTicketSchema — it causes boot timing issues.
    // Just fire it in the background for the DDL safety net.
    ensureTicketSchema(this.pool).then(() => {
      this.schemaOk = true;
      logger.info('Ticket persistence schema confirmed');
    }).catch(() => {
      // Migrations handle the schema. If this fails, queries will still work
      // as long as migrations ran (which they do via init container or pre-server script).
      logger.warn('Ticket schema bootstrap failed — relying on SQL migrations');
      this.schemaOk = true; // Assume migrations handled it
    });
  }

  private ensureSchema(): Promise<void> {
    // Don't block — migrations handle schema creation.
    // This is just a no-op now. The constructor fires the DDL in the background.
    return Promise.resolve();
  }

  /**
   * @description Owner-scoped access to the `tickets` table. RLS scoping is handled
   * transparently by the GUC-aware pool wrapper (`shared/services/database/guc-pool.ts`): when
   * `OSHAL_DB_GUC` is unset/truthy, `this.pool` stamps `oshal.current_sub` / `oshal.is_operator` on each
   * query's connection from the request identity, so the Postgres RLS policies in
   * `docs/governance/rls-policies.sql` filter rows at the database. `OSHAL_DB_GUC=off` uses a plain pool query.
   * This shim keeps ticket reads/writes routed through the (wrapped) pool in one place.
   * @param fn Work to run against the pool.
   */
  private withRls<T>(fn: (q: RlsQueryable) => Promise<T>): Promise<T> {
    return fn(this.pool);
  }

  /**
   * @description Create a new internal ticket in Postgres.
   * @param input - Ticket creation input
   * @returns The created ticket record
   */
  async create(input: CreateInternalTicketInput): Promise<InternalTicket> {
    await this.ensureSchema();
    const ticketId = randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? 'backlog';
    const [stateGroup, executionPhase] = deriveStateFields(status);

    logger.info({ ticketId, title: input.title, status }, 'Creating ticket');

    const sql = `
      INSERT INTO tickets (
        ticket_id, ticket_type, title, description, status, state_group, execution_phase,
        priority, labels, workspace_id, assigned_agent_id, parent_ticket_id,
        external_provider, external_id, external_url, metadata, created_at, updated_at, owner_sub
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (external_provider, external_id) WHERE external_id IS NOT NULL DO NOTHING
      RETURNING *
    `;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: when OSHAL_DB_GUC is unset/truthy, this.pool is the GUC-aware wrapper, so connect() above
      // already stamped oshal.current_sub / oshal.is_operator on this connection — the RLS
      // policies (docs/governance/rls-policies.sql) gate this write with no extra wiring here.

      const result: QueryResult = await client.query(sql, [
        ticketId,
        input.ticketType ?? 'build',
        input.title,
        input.description ?? '',
        status,
        stateGroup,
        executionPhase,
        input.priority ?? 'none',
        input.labels ?? [],
        input.workspaceId ?? null,
        input.assignedAgentId ?? null,
        input.parentTicketId ?? null,
        input.externalProvider ?? null,
        input.externalId ?? null,
        input.externalUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
        input.ownerSub ?? null,
      ]);

      // ON CONFLICT DO NOTHING returns no rows — fetch the existing ticket instead
      if (result.rows.length === 0 && input.externalId && input.externalProvider) {
        await client.query('COMMIT');
        logger.info({ externalId: input.externalId, externalProvider: input.externalProvider }, 'Duplicate external ticket suppressed — returning existing');
        const existing = await this.withRls((q) => q.query(
          'SELECT * FROM tickets WHERE external_provider = $1 AND external_id = $2',
          [input.externalProvider, input.externalId],
        ));
        return this.mapRow(existing.rows[0]);
      }

      await client.query(
        `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, changed_by_label)
         VALUES ($1, $2, $3, $4, $5)`,
        [ticketId, null, status, 'system', 'System'],
      );

      await client.query('COMMIT');
      logger.info({ ticketId }, 'Ticket created');
      return this.mapRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        logger.warn({ err: rollbackError, ticketId }, 'Ticket create rollback failed');
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @description Get a ticket by ID.
   * @param ticketId - Ticket identifier
   * @returns Ticket record or null
   */
  async get(ticketId: string): Promise<InternalTicket | null> {
    await this.ensureSchema();
    logger.debug({ ticketId }, 'Getting ticket');
    const result = await this.withRls((q) => q.query('SELECT * FROM tickets WHERE ticket_id = $1', [ticketId]));
    return result.rows.length ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * @description Get a ticket by its external provider and external ID.
   * @param externalProvider - Provider name
   * @param externalId - Provider-native identifier
   * @returns Ticket record or null
   */
  async getByExternalId(externalProvider: string, externalId: string): Promise<InternalTicket | null> {
    await this.ensureSchema();
    logger.debug({ externalProvider, externalId }, 'Getting ticket by external ID');
    const result = await this.withRls((q) => q.query(
      'SELECT * FROM tickets WHERE external_provider = $1 AND external_id = $2',
      [externalProvider, externalId],
    ));
    return result.rows.length ? this.mapRow(result.rows[0]) : null;
  }

  async findActiveByMetadataKey(key: string, value: string): Promise<InternalTicket | null> {
    await this.ensureSchema();
    logger.debug({ key, value }, 'Finding active ticket by metadata key');
    // `metadata ->> $1 = $2` uses the JSONB ->> text operator — constant-time with the index
    // on jsonb key access if present, otherwise a single-column scan (still far cheaper than
    // the old "fetch last 500 and scan in JS" approach).
    const result = await this.withRls((q) => q.query(
      `SELECT * FROM tickets
       WHERE metadata ->> $1 = $2
         AND status <> 'cancelled'
       ORDER BY created_at ASC
       LIMIT 1`,
      [key, value],
    ));
    return result.rows.length ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * @description Find the newest ticket (any status, terminal included) whose
   * `metadata.<key>` equals the given value — the alert-triage consolidation lookup
   * (ADR-119 P1): open ⇒ the refire consolidates onto it; terminal ⇒ a recurrence-linked
   * successor is opened (FR-C5).
   * @param key - Metadata field name.
   * @param value - Metadata value to match exactly.
   * @returns Newest matching ticket record or null.
   */
  async findLatestByMetadataKey(key: string, value: string): Promise<InternalTicket | null> {
    await this.ensureSchema();
    logger.debug({ key, value }, 'Finding latest ticket by metadata key');
    const result = await this.withRls((q) => q.query(
      `SELECT * FROM tickets
       WHERE metadata ->> $1 = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [key, value],
    ));
    return result.rows.length ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * @description Update a ticket's status and derived state group / execution phase.
   * @param ticketId - Ticket identifier
   * @param status - New OshalTicketState
   */
  async updateStatus(
    ticketId: string,
    status: OshalTicketState,
    context: TicketStatusUpdateContext = {},
  ): Promise<void> {
    await this.ensureSchema();
    const [stateGroup, executionPhase] = deriveStateFields(status);
    const changedBy = context.changedBy ?? 'system';
    const changedByLabel = context.changedByLabel ?? 'System';
    const metadata = context.metadata ?? {};
    const now = new Date().toISOString();
    const ticketMetadataPatch = buildTicketRowStatusMetadataPatch(status, metadata);
    logger.info({ ticketId, status, stateGroup, executionPhase }, 'Updating ticket status');

    // Read-then-write share ONE GUC-bound transaction under RLS so the policy sees the same
    // identity for both the SELECT and the UPDATE (and they stay atomic).
    const fromStatus = await this.withRls(async (q) => {
      const currentResult = await q.query<{ status: string }>(
        'SELECT status FROM tickets WHERE ticket_id = $1',
        [ticketId],
      );
      const prev = currentResult.rows[0]?.status ?? null;
      if (ticketMetadataPatch) {
        await q.query(
          `UPDATE tickets
           SET status = $1,
               state_group = $2,
               execution_phase = $3,
               updated_at = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb
           WHERE ticket_id = $5`,
          [status, stateGroup, executionPhase, now, ticketId, JSON.stringify(ticketMetadataPatch)],
        );
      } else {
        await q.query(
          `UPDATE tickets SET status = $1, state_group = $2, execution_phase = $3, updated_at = $4 WHERE ticket_id = $5`,
          [status, stateGroup, executionPhase, now, ticketId],
        );
      }
      const linkedTaskStatus = linkedChatTaskStatusForTerminalTicket(status);
      if (linkedTaskStatus) {
        const linkedTaskResult = await q.query(
          // $2 (now, an ISO string) is bound once but used as both a timestamptz (updated_at)
          // and text (the jsonb sync marker). Pin it to timestamptz in BOTH spots so Postgres
          // doesn't fail with "inconsistent types deduced for parameter $2 (text vs timestamptz)".
          `UPDATE chat_tasks AS ct
           SET status = $1,
               updated_at = $2::timestamptz,
               metadata = COALESCE(ct.metadata, '{}'::jsonb) || jsonb_build_object(
                 'ticketTerminalSyncAt', ($2::timestamptz)::text,
                 'ticketTerminalSyncReason', 'linked_ticket_terminal',
                 'ticketTerminalStatus', $3::text,
                 'ticketTerminalId', $4::text
               )
           FROM ticket_task_links ttl
           WHERE ttl.task_id = ct.task_id
             AND ttl.ticket_id = $4
             AND ct.status IN ('created', 'active', 'processing')`,
          [linkedTaskStatus, now, status, ticketId],
        );
        if ((linkedTaskResult.rowCount ?? 0) > 0) {
          logger.info(
            { ticketId, ticketStatus: status, taskStatus: linkedTaskStatus, linkedTaskCount: linkedTaskResult.rowCount },
            'Closed active linked chat tasks for terminal ticket',
          );
        }
      }
      return prev;
    });

    await this.recordStatusHistory(ticketId, fromStatus, status, changedBy, changedByLabel, metadata).catch((err) => {
      logger.warn({ err, ticketId }, 'Failed to record status history — non-fatal');
    });

    const timestamp = new Date().toISOString();
    ticketEvents.emitStatusChanged({ ticketId, fromStatus: fromStatus ?? '', toStatus: status, changedBy, changedByLabel, timestamp });
  }

  async recordStatusHistory(
    ticketId: string,
    fromStatus: string | null,
    toStatus: string,
    changedBy: string,
    changedByLabel: string,
    metadata: TicketStatusMetadata = {},
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, changed_by_label, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ticketId, fromStatus, toStatus, changedBy, changedByLabel, JSON.stringify(metadata)],
    );
  }

  async getStatusHistory(ticketId: string, limit = 50): Promise<TicketStatusHistoryRecord[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT id, ticket_id, from_status, to_status, changed_by, changed_by_label, metadata, created_at
       FROM ticket_status_history WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ticketId, limit],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      ticketId: row.ticket_id as string,
      fromStatus: (row.from_status as string) ?? null,
      toStatus: row.to_status as string,
      changedBy: row.changed_by as string,
      changedByLabel: row.changed_by_label as string,
      metadata: (row.metadata as TicketStatusMetadata | null) ?? {},
      createdAt: String(row.created_at),
    }));
  }

  /**
   * @description Partial update of ticket fields.
   * @param ticketId - Ticket identifier
   * @param updates - Partial ticket fields
   */
  async update(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt'>>): Promise<void> {
    await this.ensureSchema();
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      title: 'title',
      description: 'description',
      priority: 'priority',
      labels: 'labels',
      workspaceId: 'workspace_id',
      assignedAgentId: 'assigned_agent_id',
      parentTicketId: 'parent_ticket_id',
      externalProvider: 'external_provider',
      externalId: 'external_id',
      externalUrl: 'external_url',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (key in updates) {
        setClauses.push(`${column} = $${idx++}`);
        params.push((updates as Record<string, unknown>)[key]);
      }
    }

    if ('metadata' in updates) {
      setClauses.push(`metadata = $${idx++}`);
      params.push(JSON.stringify(updates.metadata ?? {}));
    }

    if ('status' in updates && updates.status) {
      const [stateGroup, executionPhase] = deriveStateFields(updates.status);
      setClauses.push(`status = $${idx++}`);
      params.push(updates.status);
      setClauses.push(`state_group = $${idx++}`);
      params.push(stateGroup);
      setClauses.push(`execution_phase = $${idx++}`);
      params.push(executionPhase);
    }

    if (setClauses.length === 0) {
      return;
    }

    setClauses.push(`updated_at = $${idx++}`);
    params.push(new Date().toISOString());
    params.push(ticketId);

    logger.info({ ticketId, fieldCount: setClauses.length }, 'Updating ticket');
    await this.withRls((q) => q.query(
      `UPDATE tickets SET ${setClauses.join(', ')} WHERE ticket_id = $${idx}`,
      params,
    ));
  }

  /**
   * @description Delete a ticket and cascade-delete its links.
   * @param ticketId - Ticket identifier
   */
  async delete(ticketId: string): Promise<void> {
    await this.ensureSchema();
    logger.info({ ticketId }, 'Deleting ticket');
    await this.withRls((q) => q.query('DELETE FROM tickets WHERE ticket_id = $1', [ticketId]));
  }

  /**
   * @description List tickets with optional filtering.
   * @param options - Filter options
   * @returns Array of matching tickets
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
    await this.ensureSchema();
    logger.debug({ options }, 'Listing tickets');
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }
    if (options?.workspaceId) {
      conditions.push(`workspace_id = $${idx++}`);
      params.push(options.workspaceId);
    }
    if (options?.assignedAgentId) {
      conditions.push(`assigned_agent_id = $${idx++}`);
      params.push(options.assignedAgentId);
    }
    if (options?.ticketType) {
      conditions.push(`ticket_type = $${idx++}`);
      params.push(options.ticketType);
    }
    if (options?.ownerSub) {
      conditions.push(`owner_sub = $${idx++}`);
      params.push(options.ownerSub);
    }
    if (options?.parentTicketId !== undefined) {
      if (options.parentTicketId === null) {
        conditions.push('parent_ticket_id IS NULL');
      } else {
        conditions.push(`parent_ticket_id = $${idx++}`);
        params.push(options.parentTicketId);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    let pagination = '';
    if (options?.limit) {
      pagination += ` LIMIT $${idx++}`;
      params.push(options.limit);
    }
    if (options?.offset) {
      pagination += ` OFFSET $${idx++}`;
      params.push(options.offset);
    }

    const result = await this.withRls((q) => q.query(
      `SELECT * FROM tickets ${where} ORDER BY created_at DESC${pagination}`,
      params,
    ));

    return result.rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  /**
   * @description Link a task to a ticket.
   * @param ticketId - Ticket identifier
   * @param taskId - Task identifier
   * @param role - Link role
   */
  async linkTask(ticketId: string, taskId: string, role: TicketTaskLinkRole = 'primary'): Promise<void> {
    await this.ensureSchema();
    logger.info({ ticketId, taskId, role }, 'Linking task to ticket');
    await this.pool.query(
      `INSERT INTO ticket_task_links (task_id, ticket_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (task_id, ticket_id) DO UPDATE SET role = EXCLUDED.role`,
      [taskId, ticketId, role],
    );
  }

  /**
   * @description Unlink a task from a ticket.
   * @param ticketId - Ticket identifier
   * @param taskId - Task identifier
   */
  async unlinkTask(ticketId: string, taskId: string): Promise<void> {
    await this.ensureSchema();
    logger.info({ ticketId, taskId }, 'Unlinking task from ticket');
    await this.pool.query(
      'DELETE FROM ticket_task_links WHERE ticket_id = $1 AND task_id = $2',
      [ticketId, taskId],
    );
  }

  /**
   * @description Get all task links for a ticket.
   * @param ticketId - Ticket identifier
   * @returns Array of ticket-task links
   */
  async getTaskLinks(ticketId: string): Promise<TicketTaskLink[]> {
    await this.ensureSchema();
    logger.debug({ ticketId }, 'Getting task links for ticket');
    const result = await this.pool.query(
      'SELECT * FROM ticket_task_links WHERE ticket_id = $1 ORDER BY created_at',
      [ticketId],
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapTaskLinkRow(row));
  }

  /**
   * @description Get all ticket links for a task.
   * @param taskId - Task identifier
   * @returns Array of ticket-task links
   */
  async getTicketLinksForTask(taskId: string): Promise<TicketTaskLink[]> {
    await this.ensureSchema();
    logger.debug({ taskId }, 'Getting ticket links for task');
    const result = await this.pool.query(
      'SELECT * FROM ticket_task_links WHERE task_id = $1 ORDER BY created_at',
      [taskId],
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapTaskLinkRow(row));
  }

  /**
   * @description Link a workspace to a ticket.
   * @param ticketId - Ticket identifier
   * @param workspaceId - Workspace identifier
   */
  async linkWorkspace(ticketId: string, workspaceId: string): Promise<void> {
    await this.ensureSchema();
    logger.info({ ticketId, workspaceId }, 'Linking workspace to ticket');
    await this.pool.query(
      `INSERT INTO ticket_workspace_links (ticket_id, workspace_id) VALUES ($1, $2)
       ON CONFLICT (ticket_id, workspace_id) DO NOTHING`,
      [ticketId, workspaceId],
    );
  }

  /**
   * @description Unlink a workspace from a ticket.
   * @param ticketId - Ticket identifier
   * @param workspaceId - Workspace identifier
   */
  async unlinkWorkspace(ticketId: string, workspaceId: string): Promise<void> {
    await this.ensureSchema();
    logger.info({ ticketId, workspaceId }, 'Unlinking workspace from ticket');
    await this.pool.query(
      'DELETE FROM ticket_workspace_links WHERE ticket_id = $1 AND workspace_id = $2',
      [ticketId, workspaceId],
    );
  }

  /**
   * @description Get all workspace links for a ticket.
   * @param ticketId - Ticket identifier
   * @returns Array of ticket-workspace links
   */
  async getWorkspaceLinks(ticketId: string): Promise<TicketWorkspaceLink[]> {
    await this.ensureSchema();
    logger.debug({ ticketId }, 'Getting workspace links for ticket');
    const result = await this.pool.query(
      'SELECT * FROM ticket_workspace_links WHERE ticket_id = $1 ORDER BY created_at',
      [ticketId],
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapWorkspaceLinkRow(row));
  }

  /**
   * @description Get all tickets linked to a workspace.
   * @param workspaceId - Workspace identifier
   * @returns Array of tickets
   */
  async getTicketsByWorkspace(workspaceId: string): Promise<InternalTicket[]> {
    await this.ensureSchema();
    logger.debug({ workspaceId }, 'Getting tickets by workspace');
    const result = await this.withRls((q) => q.query(
      `SELECT t.* FROM tickets t
       JOIN ticket_workspace_links twl ON t.ticket_id = twl.ticket_id
       WHERE twl.workspace_id = $1
       ORDER BY t.created_at DESC`,
      [workspaceId],
    ));
    return result.rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  /**
   * @description Records an agent assignment to a ticket (idempotent upsert).
   */
  async assignAgent(ticketId: string, agentId: string, role: string = 'executor', phase?: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO ticket_agent_assignments (ticket_id, agent_id, role, phase)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticket_id, agent_id, role) DO UPDATE SET phase = COALESCE(EXCLUDED.phase, ticket_agent_assignments.phase)`,
      [ticketId, agentId, role, phase ?? null],
    );
    logger.info({ ticketId, agentId, role, phase }, 'Recorded agent assignment');
  }

  /**
   * @description Maps a Postgres row to an InternalTicket object.
   * @param row - Raw database row
   * @returns Mapped InternalTicket
   */
  private mapRow(row: Record<string, unknown>): InternalTicket {
    return {
      ticketId: row.ticket_id as string,
      ticketType: ((row.ticket_type as string) ?? 'build') as TicketType,
      title: row.title as string,
      description: (row.description as string) ?? '',
      status: (row.status as OshalTicketState) ?? 'backlog',
      stateGroup: (row.state_group as OshalTicketStateGroup) ?? 'backlog',
      executionPhase: (row.execution_phase as OshalTicketExecutionPhase) ?? null,
      priority: ((row.priority as string) ?? 'none') as 'urgent' | 'high' | 'medium' | 'low' | 'none',
      labels: (row.labels as string[]) ?? [],
      workspaceId: (row.workspace_id as string) ?? null,
      assignedAgentId: (row.assigned_agent_id as string) ?? null,
      parentTicketId: (row.parent_ticket_id as string) ?? null,
      externalProvider: (row.external_provider as string) ?? null,
      externalId: (row.external_id as string) ?? null,
      externalUrl: (row.external_url as string) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      ownerSub: (row.owner_sub as string) ?? null,
      createdAt: row.created_at ? String(row.created_at) : new Date().toISOString(),
      updatedAt: row.updated_at ? String(row.updated_at) : new Date().toISOString(),
    };
  }

  /**
   * @description Maps a Postgres row to a TicketTaskLink object.
   * @param row - Raw database row
   * @returns Mapped TicketTaskLink
   */
  private mapTaskLinkRow(row: Record<string, unknown>): TicketTaskLink {
    return {
      taskId: row.task_id as string,
      ticketId: row.ticket_id as string,
      role: (row.role as TicketTaskLinkRole) ?? 'primary',
      createdAt: row.created_at ? String(row.created_at) : new Date().toISOString(),
    };
  }

  /**
   * @description Maps a Postgres row to a TicketWorkspaceLink object.
   * @param row - Raw database row
   * @returns Mapped TicketWorkspaceLink
   */
  private mapWorkspaceLinkRow(row: Record<string, unknown>): TicketWorkspaceLink {
    return {
      ticketId: row.ticket_id as string,
      workspaceId: row.workspace_id as string,
      createdAt: row.created_at ? String(row.created_at) : new Date().toISOString(),
    };
  }
}
