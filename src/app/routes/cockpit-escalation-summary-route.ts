import type { Request, Response } from 'express';
import type { AppContext } from '../composition-root';
import type { InternalTicket, TicketStatusHistoryRecord } from '@/entities/ticket';
import { isOperator } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'cockpit-escalation-summary-route' });

const DEFAULT_TICKET_LIMIT = 1000;
const MAX_TICKET_LIMIT = 5000;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

interface TicketServiceLike {
  listTickets(options?: {
    status?: string;
    ownerSub?: string;
    limit?: number;
    offset?: number;
  }): Promise<InternalTicket[]>;
  getStatusHistory(ticketId: string, limit?: number): Promise<TicketStatusHistoryRecord[]>;
}

export interface EscalationSummaryOptions {
  ownerSub?: string;
  scope: 'mine' | 'all' | 'system';
  ticketLimit?: number;
  historyLimit?: number;
}

export interface EscalationSummary {
  scope: 'mine' | 'all' | 'system';
  ownerSub: string | null;
  generatedAt: string;
  totals: {
    ticketsScanned: number;
    currentEscalated: number;
    ticketsWithEscalationHistory: number;
    escalationEvents: number;
    openEscalations: number;
    terminalAfterEscalation: number;
  };
  metadataQuality: {
    withReason: number;
    missingReason: number;
    withSource: number;
    missingSource: number;
    legacyWithoutMetadata: number;
    reasonCoveragePct: number;
    sourceCoveragePct: number;
  };
  topReasons: Array<{ reason: string; count: number }>;
  recent: Array<{
    ticketId: string;
    title: string;
    status: string;
    reason: string | null;
    source: string | null;
    severity: string | null;
    changedBy: string;
    changedByLabel: string;
    createdAt: string;
  }>;
  actions: string[];
}

/**
 * @description Builds an operator-quality escalation hygiene summary from current tickets
 * and their status history. This deliberately reports legacy/missing metadata instead
 * of trying to hide old messy records.
 */
export async function buildEscalationSummary(
  ticketService: TicketServiceLike,
  options: EscalationSummaryOptions,
): Promise<EscalationSummary> {
  const ticketLimit = clampInt(options.ticketLimit, DEFAULT_TICKET_LIMIT, MAX_TICKET_LIMIT);
  const historyLimit = clampInt(options.historyLimit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  const tickets = await ticketService.listTickets({
    limit: ticketLimit,
    ownerSub: options.ownerSub,
  } as never);
  const histories = await mapWithConcurrency(tickets, 12, async (ticket) => ({
    ticket,
    history: await ticketService.getStatusHistory(ticket.ticketId, historyLimit).catch((error) => {
      logger.warn({ err: error, ticketId: ticket.ticketId }, 'Escalation summary history read failed');
      return [];
    }),
  }));

  let currentEscalated = 0;
  let escalationEvents = 0;
  let openEscalations = 0;
  let terminalAfterEscalation = 0;
  let withReason = 0;
  let withSource = 0;
  let legacyWithoutMetadata = 0;
  const ticketsWithHistory = new Set<string>();
  const reasons = new Map<string, number>();
  const recent: EscalationSummary['recent'] = [];

  for (const item of histories) {
    if (item.ticket.status === 'escalated') {
      currentEscalated += 1;
    }
    const escalationRows = item.history.filter((row) => row.toStatus === 'escalated');
    if (escalationRows.length > 0) {
      ticketsWithHistory.add(item.ticket.ticketId);
      if (isTerminalStatus(item.ticket.status)) {
        terminalAfterEscalation += 1;
      } else {
        openEscalations += 1;
      }
    }
    for (const row of escalationRows) {
      escalationEvents += 1;
      const metadata = safeRecord(row.metadata);
      const reason = readMetadataString(metadata, ['reason', 'escalation.reason', 'message']);
      const source = readMetadataString(metadata, ['source', 'trigger', 'origin', 'escalation.source']);
      const severity = readMetadataString(metadata, ['severity', 'priority', 'escalation.severity']);

      if (reason) {
        withReason += 1;
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      } else {
        reasons.set('unspecified', (reasons.get('unspecified') ?? 0) + 1);
      }
      if (source) {
        withSource += 1;
      }
      if (!reason || Object.keys(metadata).length === 0) {
        legacyWithoutMetadata += 1;
      }
      recent.push({
        ticketId: item.ticket.ticketId,
        title: item.ticket.title,
        status: item.ticket.status,
        reason,
        source,
        severity,
        changedBy: row.changedBy,
        changedByLabel: row.changedByLabel,
        createdAt: row.createdAt,
      });
    }
  }

  recent.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const topReasons = Array.from(reasons.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  const missingReason = escalationEvents - withReason;
  const missingSource = escalationEvents - withSource;
  const actions = buildRecommendedActions({
    currentEscalated,
    escalationEvents,
    missingReason,
    missingSource,
    legacyWithoutMetadata,
  });

  return {
    scope: options.scope,
    ownerSub: options.ownerSub ?? null,
    generatedAt: new Date().toISOString(),
    totals: {
      ticketsScanned: tickets.length,
      currentEscalated,
      ticketsWithEscalationHistory: ticketsWithHistory.size,
      escalationEvents,
      openEscalations,
      terminalAfterEscalation,
    },
    metadataQuality: {
      withReason,
      missingReason,
      withSource,
      missingSource,
      legacyWithoutMetadata,
      reasonCoveragePct: pct(withReason, escalationEvents),
      sourceCoveragePct: pct(withSource, escalationEvents),
    },
    topReasons,
    recent: recent.slice(0, 25),
    actions,
  };
}

/**
 * @description GET /api/v1/tickets/escalations/summary.
 */
export function handleGetCockpitEscalationSummary(ctx: AppContext) {
  return async (req: Request, res: Response) => {
    try {
      const caller = callerSub(req);
      const allowAll = req.query.scope === 'all' && isOperator(req);
      const ownerSub = allowAll || !caller ? undefined : caller;
      const scope = allowAll ? 'all' : caller ? 'mine' : 'system';
      const summary = await buildEscalationSummary(ctx.ticketService, {
        ownerSub,
        scope,
        ticketLimit: parseOptionalInt(req.query.limit),
        historyLimit: parseOptionalInt(req.query.historyLimit),
      });
      res.json({ success: true, data: summary });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build escalation summary');
      res.status(500).json({ success: false, error: 'Failed to build escalation summary' });
    }
  };
}

function callerSub(req: Request): string | undefined {
  const sub = (req as { oidc?: { user?: { sub?: unknown } } }).oidc?.user?.sub;
  return typeof sub === 'string' && sub.trim() ? sub : undefined;
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

function pct(count: number, total: number): number {
  if (total <= 0) {
    return 100;
  }
  return Math.round((count / total) * 1000) / 10;
}

function isTerminalStatus(status: string): boolean {
  return status === 'complete' || status === 'cancelled';
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

function readPath(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[key]
      : undefined
  ), value);
}

function buildRecommendedActions(input: {
  currentEscalated: number;
  escalationEvents: number;
  missingReason: number;
  missingSource: number;
  legacyWithoutMetadata: number;
}): string[] {
  const actions: string[] = [];
  if (input.currentEscalated > 0) {
    actions.push('Review open escalations and assign an owner/next action before the next queue sweep.');
  }
  if (input.legacyWithoutMetadata > 0) {
    actions.push('Backfill legacy escalation rows with at least reason, source, severity, and nextAction metadata.');
  }
  if (input.missingReason > 0 || input.missingSource > 0) {
    actions.push('Gate all new escalation writes on reason/source metadata so dashboards can group failures reliably.');
  }
  if (input.escalationEvents === 0) {
    actions.push('No escalation history found in the scanned window; run a live queue cycle before using this as an operator health signal.');
  }
  return actions;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}
