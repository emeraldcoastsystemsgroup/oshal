import type { Pool } from 'pg';
import type { Request, Response } from 'express';
import type { InternalTicket, TicketStatusHistoryRecord } from '@/entities/ticket';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'cockpit-queue-health-route' });

const DEFAULT_TICKET_LIMIT = 1000;
const MAX_TICKET_LIMIT = 5000;
const DEFAULT_APPROVED_STALE_MINUTES = 10;
const DEFAULT_IN_PROCESS_STALE_MINUTES = 60;

const IN_PROCESS_STATUSES = new Set([
  'in_process',
  'in_process_discovery',
  'in_process_design',
  'in_process_build',
  'in_process_deploy',
  'in_process_test',
  'in_process_release',
]);
const TERMINAL_STATUSES = new Set(['complete', 'cancelled']);

interface TicketServiceLike {
  listTickets(options?: {
    ownerSub?: string;
    limit?: number;
    offset?: number;
  }): Promise<InternalTicket[]>;
  getStatusHistory(ticketId: string, limit?: number): Promise<TicketStatusHistoryRecord[]>;
}

export interface WorkItemQueueSnapshot {
  available: boolean;
  byStatus: Record<string, number>;
  stalePending: number;
  staleExecuting: number;
  historicalRoutingFailed: number;
  routingFailed: number;
  oldestPendingAgeMinutes: number | null;
  newestUpdateAt: string | null;
  error?: string;
}

export interface QueueHealthOptions {
  ownerSub?: string;
  scope: 'mine' | 'all' | 'anonymous';
  now?: Date;
  ticketLimit?: number;
  approvedStaleMinutes?: number;
  inProcessStaleMinutes?: number;
  workItems?: WorkItemQueueSnapshot;
}

export interface QueueHealthSummary {
  scope: 'mine' | 'all' | 'anonymous';
  ownerSub: string | null;
  generatedAt: string;
  status: 'healthy' | 'degraded' | 'blocked';
  thresholds: {
    approvedStaleMinutes: number;
    inProcessStaleMinutes: number;
  };
  totals: {
    ticketsScanned: number;
    backlog: number;
    staleBacklog: number;
    approved: number;
    inProcess: number;
    escalated: number;
    complete: number;
    staleApproved: number;
    staleInProcess: number;
    buildOpen: number;
    buildEscalated: number;
    providerRuntimeStalled: number;
    unassignedEscalated: number;
    escalatedMissingReason: number;
    escalatedMissingSource: number;
  };
  oldest: {
    approvedAgeMinutes: number | null;
    inProcessAgeMinutes: number | null;
  };
  workItems: WorkItemQueueSnapshot;
  recentBlockers: Array<{
    ticketId: string;
    title: string;
    status: string;
    ticketType: string;
    ageMinutes: number;
    reason: string;
  }>;
  actions: string[];
}

export async function buildQueueHealthSummary(
  ticketService: TicketServiceLike,
  options: QueueHealthOptions,
): Promise<QueueHealthSummary> {
  const now = options.now ?? new Date();
  const ticketLimit = clampInt(options.ticketLimit, DEFAULT_TICKET_LIMIT, MAX_TICKET_LIMIT);
  const approvedStaleMinutes = clampInt(options.approvedStaleMinutes, DEFAULT_APPROVED_STALE_MINUTES, 24 * 60);
  const inProcessStaleMinutes = clampInt(options.inProcessStaleMinutes, DEFAULT_IN_PROCESS_STALE_MINUTES, 24 * 60);
  const tickets = await ticketService.listTickets({
    ownerSub: options.ownerSub,
    limit: ticketLimit,
  });

  let approved = 0;
  let backlog = 0;
  let staleBacklog = 0;
  let inProcess = 0;
  let escalated = 0;
  let complete = 0;
  let staleApproved = 0;
  let staleInProcess = 0;
  let buildOpen = 0;
  let buildEscalated = 0;
  let providerRuntimeStalled = 0;
  let unassignedEscalated = 0;
  let escalatedMissingReason = 0;
  let escalatedMissingSource = 0;
  let oldestApprovedAgeMinutes: number | null = null;
  let oldestInProcessAgeMinutes: number | null = null;
  const recentBlockers: QueueHealthSummary['recentBlockers'] = [];

  for (const ticket of tickets) {
    const age = ageMinutes(ticket.updatedAt || ticket.createdAt, now);
    const ticketType = ticket.ticketType || 'build';
    if (ticket.status === 'backlog') {
      backlog += 1;
      if (age >= approvedStaleMinutes) {
        staleBacklog += 1;
        recentBlockers.push({
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
          ticketType,
          ageMinutes: age,
          reason: 'backlog_waiting_for_approval',
        });
      }
    }

    if (ticket.status === 'approved') {
      approved += 1;
      oldestApprovedAgeMinutes = maxNullable(oldestApprovedAgeMinutes, age);
      if (age >= approvedStaleMinutes) {
        staleApproved += 1;
        recentBlockers.push({
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
          ticketType,
          ageMinutes: age,
          reason: 'approved_not_picked_up',
        });
      }
    }

    if (IN_PROCESS_STATUSES.has(ticket.status)) {
      inProcess += 1;
      if (!isNonBlockingChatThread(ticket)) {
        oldestInProcessAgeMinutes = maxNullable(oldestInProcessAgeMinutes, age);
        if (age >= inProcessStaleMinutes) {
          staleInProcess += 1;
          recentBlockers.push({
            ticketId: ticket.ticketId,
            title: ticket.title,
            status: ticket.status,
            ticketType,
            ageMinutes: age,
            reason: 'in_process_stale',
          });
        }
      }
    }

    if (ticket.status === 'escalated') {
      escalated += 1;
      if (!ticket.assignedAgentId) {
        unassignedEscalated += 1;
      }
      if (ticketType === 'build') {
        buildEscalated += 1;
      }
      const latestEscalation = await latestEscalationRow(ticketService, ticket.ticketId);
      const metadata = {
        ...safeRecord(ticket.metadata),
        ...safeRecord(latestEscalation?.metadata),
      };
      const reason = readMetadataString(metadata, ['reason', 'escalation.reason', 'message']);
      const source = readMetadataString(metadata, ['source', 'trigger', 'origin', 'escalation.source']);
      const failureClass = readMetadataString(metadata, ['failureClass', 'failure.class']);
      if (failureClass === 'provider_runtime_stall') {
        providerRuntimeStalled += 1;
      }
      if (!reason) {
        escalatedMissingReason += 1;
      }
      if (!source) {
        escalatedMissingSource += 1;
      }
      recentBlockers.push({
        ticketId: ticket.ticketId,
        title: ticket.title,
        status: ticket.status,
        ticketType,
        ageMinutes: age,
        reason: failureClass === 'provider_runtime_stall' ? 'provider_runtime_stall' : (reason || 'escalated_without_reason'),
      });
    }

    if (ticket.status === 'complete') {
      complete += 1;
    }

    if (ticketType === 'build' && !TERMINAL_STATUSES.has(ticket.status)) {
      buildOpen += 1;
    }
  }

  recentBlockers.sort((left, right) => right.ageMinutes - left.ageMinutes);

  const workItems = options.workItems ?? emptyWorkItemSnapshot();
  const status = resolveHealthStatus({
    staleBacklog,
    staleApproved,
    staleInProcess,
    buildEscalated,
    providerRuntimeStalled,
    unassignedEscalated,
    escalatedMissingReason,
    workItems,
  });
  const actions = buildActions({
    staleBacklog,
    staleApproved,
    staleInProcess,
    buildEscalated,
    providerRuntimeStalled,
    unassignedEscalated,
    escalatedMissingReason,
    escalatedMissingSource,
    workItems,
  });

  return {
    scope: options.scope,
    ownerSub: options.ownerSub ?? null,
    generatedAt: now.toISOString(),
    status,
    thresholds: { approvedStaleMinutes, inProcessStaleMinutes },
    totals: {
      ticketsScanned: tickets.length,
      backlog,
      staleBacklog,
      approved,
      inProcess,
      escalated,
      complete,
      staleApproved,
      staleInProcess,
      buildOpen,
      buildEscalated,
      providerRuntimeStalled,
      unassignedEscalated,
      escalatedMissingReason,
      escalatedMissingSource,
    },
    oldest: {
      approvedAgeMinutes: oldestApprovedAgeMinutes,
      inProcessAgeMinutes: oldestInProcessAgeMinutes,
    },
    workItems,
    recentBlockers: recentBlockers.slice(0, 25),
    actions,
  };
}

/**
 * @description GET /api/v1/metrics/queue-health.
 */
export function handleGetCockpitQueueHealth(ctx: AppContext) {
  return async (req: Request, res: Response) => {
    try {
      const caller = getCaller(req).sub;
      const allowAll = req.query.scope === 'all' && isOperator(req);
      const ownerSub = allowAll ? undefined : caller ?? '__missing-caller__';
      const scope = allowAll ? 'all' : caller ? 'mine' : 'anonymous';
      const workItems = await queryWorkItemQueueSnapshot(ctx.pool, new Date());
      const summary = await buildQueueHealthSummary(ctx.ticketService, {
        ownerSub,
        scope,
        ticketLimit: parseOptionalInt(req.query.limit),
        approvedStaleMinutes: parseOptionalInt(req.query.approvedStaleMinutes),
        inProcessStaleMinutes: parseOptionalInt(req.query.inProcessStaleMinutes),
        workItems,
      });
      res.json({ success: true, data: summary });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build queue health summary');
      res.status(500).json({ success: false, error: 'Failed to build queue health summary' });
    }
  };
}

async function queryWorkItemQueueSnapshot(pool: Pool | null | undefined, now: Date): Promise<WorkItemQueueSnapshot> {
  if (!pool) {
    return emptyWorkItemSnapshot();
  }
  try {
    const result = await pool.query(`
      SELECT
        status,
        COUNT(*)::int AS count,
        MIN(updated_at) AS oldest_updated_at,
        MAX(updated_at) AS newest_updated_at
      FROM work_items
      GROUP BY status
    `);
    const byStatus: Record<string, number> = {};
    let oldestPendingAgeMinutes: number | null = null;
    let newestUpdateAt: string | null = null;
    for (const row of result.rows) {
      const status = String(row.status || 'unknown');
      const count = Number(row.count || 0);
      byStatus[status] = count;
      if (status === 'pending' || status === 'assigned' || status === 'subtask-pending' || status === 'subtask-assigned') {
        oldestPendingAgeMinutes = maxNullable(oldestPendingAgeMinutes, ageMinutes(row.oldest_updated_at, now));
      }
      const newest = asIso(row.newest_updated_at);
      if (newest && (!newestUpdateAt || Date.parse(newest) > Date.parse(newestUpdateAt))) {
        newestUpdateAt = newest;
      }
    }
    const routingResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE NOT (
            t.status IN ('complete', 'escalated', 'cancelled')
            OR (
              wi.metadata->>'routingRetrySuppressedReason' = 'terminal_ticket_status'
              AND wi.metadata->>'routingRetrySuppressedTicketStatus' IN ('complete', 'escalated', 'cancelled')
            )
          )
        )::int AS active,
        COUNT(*) FILTER (
          WHERE
            t.status IN ('complete', 'escalated', 'cancelled')
            OR (
              wi.metadata->>'routingRetrySuppressedReason' = 'terminal_ticket_status'
              AND wi.metadata->>'routingRetrySuppressedTicketStatus' IN ('complete', 'escalated', 'cancelled')
            )
        )::int AS historical
      FROM work_items wi
      LEFT JOIN tickets t ON t.ticket_id::text = wi.external_id
      WHERE wi.status = 'routing_failed'
    `);
    const activeRoutingFailed = Number(routingResult.rows[0]?.active ?? 0);
    const historicalRoutingFailed = Number(routingResult.rows[0]?.historical ?? 0);
    return {
      available: true,
      byStatus,
      stalePending: countStalePending(byStatus, oldestPendingAgeMinutes),
      staleExecuting: (byStatus.executing || 0) + (byStatus['subtask-executing'] || 0),
      historicalRoutingFailed,
      routingFailed: activeRoutingFailed,
      oldestPendingAgeMinutes,
      newestUpdateAt,
    };
  } catch (error) {
    logger.warn({ err: error }, 'work_items queue health query failed');
    return { ...emptyWorkItemSnapshot(), error: error instanceof Error ? error.message : String(error) };
  }
}

function emptyWorkItemSnapshot(): WorkItemQueueSnapshot {
  return {
    available: false,
    byStatus: {},
    stalePending: 0,
    staleExecuting: 0,
    historicalRoutingFailed: 0,
    routingFailed: 0,
    oldestPendingAgeMinutes: null,
    newestUpdateAt: null,
  };
}

function countStalePending(byStatus: Record<string, number>, oldestPendingAgeMinutes: number | null): number {
  if (oldestPendingAgeMinutes == null || oldestPendingAgeMinutes < DEFAULT_APPROVED_STALE_MINUTES) {
    return 0;
  }
  return (byStatus.pending || 0)
    + (byStatus.assigned || 0)
    + (byStatus['subtask-pending'] || 0)
    + (byStatus['subtask-assigned'] || 0);
}

function isNonBlockingChatThread(ticket: InternalTicket): boolean {
  if (ticket.ticketType !== 'chat') {
    return false;
  }
  const metadata = safeRecord(ticket.metadata);
  return metadata.kind === 'chat-thread' || metadata.origin === 'bot-chat' || typeof metadata.taskId === 'string';
}

async function latestEscalationRow(
  ticketService: TicketServiceLike,
  ticketId: string,
): Promise<TicketStatusHistoryRecord | null> {
  const history = await ticketService.getStatusHistory(ticketId, 25).catch((error) => {
    logger.warn({ err: error, ticketId }, 'Queue health history read failed');
    return [];
  });
  return history
    .filter((row) => row.toStatus === 'escalated')
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
}

function resolveHealthStatus(input: {
  staleBacklog: number;
  staleApproved: number;
  staleInProcess: number;
  buildEscalated: number;
  providerRuntimeStalled: number;
  unassignedEscalated: number;
  escalatedMissingReason: number;
  workItems: WorkItemQueueSnapshot;
}): QueueHealthSummary['status'] {
  if (
    input.staleApproved > 0
    || input.buildEscalated > 0
    || input.providerRuntimeStalled > 0
    || input.unassignedEscalated > 0
    || input.workItems.routingFailed > 0
    || input.workItems.stalePending > 0
  ) {
    return 'blocked';
  }
  if (
    input.staleBacklog > 0
    || input.staleInProcess > 0
    || input.escalatedMissingReason > 0
    || input.workItems.staleExecuting > 0
  ) {
    return 'degraded';
  }
  return 'healthy';
}

function buildActions(input: {
  staleBacklog: number;
  staleApproved: number;
  staleInProcess: number;
  buildEscalated: number;
  providerRuntimeStalled: number;
  unassignedEscalated: number;
  escalatedMissingReason: number;
  escalatedMissingSource: number;
  workItems: WorkItemQueueSnapshot;
}): string[] {
  const actions: string[] = [];
  if (input.providerRuntimeStalled > 0) {
    actions.push('Provider runtime is stalling: check Claude Code auth/session, restart affected bot runtimes, or route tickets to a healthy fallback provider such as Bedrock.');
  }
  if (input.unassignedEscalated > 0) {
    actions.push('Escalated tickets are unassigned: run the ticket-assignment repair dry-run and inspect manifest-worker capability/auth failures with no resolved agent.');
  }
  if (input.staleBacklog > 0) {
    actions.push('Backlog tickets are waiting for approval or intake policy: approve intentional work, cancel stale test items, or change the source to create approved tickets when auto-flow is expected.');
  }
  if (input.staleApproved > 0 || input.workItems.stalePending > 0) {
    actions.push('Queue pickup is stale: verify queue-manager/manifest-worker loops, Redis stream consumers, and bot-node reachability.');
  }
  if (input.staleInProcess > 0 || input.workItems.staleExecuting > 0) {
    actions.push('Work is stuck in progress: inspect worker logs and transition stuck tickets to escalated with metadata if no worker owns them.');
  }
  if (input.buildEscalated > 0) {
    actions.push('Build workflow is not healthy enough for the engineering score gate: run one fresh build ticket and require complete or metadata-rich escalation.');
  }
  if (input.escalatedMissingReason > 0 || input.escalatedMissingSource > 0) {
    actions.push('Backfill or quarantine legacy escalation rows missing reason/source before using dashboards as operator-grade evidence.');
  }
  if (input.workItems.routingFailed > 0) {
    actions.push('Routing failures exist in work_items: inspect phase-to-bot mapping and capability selector output.');
  }
  if (actions.length === 0) {
    actions.push('No stale queue blockers found in the scanned window; keep this endpoint in the evidence run.');
  }
  return actions;
}

function ageMinutes(value: unknown, now: Date): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 60000));
}

function maxNullable(current: number | null, next: number): number {
  return current == null ? next : Math.max(current, next);
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function parseOptionalInt(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readMetadataString(metadata: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(metadata, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asIso(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  return null;
}
