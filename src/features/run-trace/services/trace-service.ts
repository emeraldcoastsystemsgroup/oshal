/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial run-trace read-model: TraceService.getTrace assembles ONE time-ordered waterfall for a ticket (ticket -> phase spans from ticket_status_history -> bot spans from ticket_task_links+chat_tasks -> per-LLM-call spans from the oshal_cost_events ledger) purely from data ALREADY persisted — no new correlation-id instrumentation across the controller/bot boundary. Totals.costUsd sums the SAME ticket->ticket_task_links->oshal_cost_events join the cost-governance budget uses, so a trace total agrees with the budget + cockpit ticket-cost rollups. Caller-scoped: a non-operator sees only a ticket they own (owner_sub); anything else returns null so a ticket id is never oracle-able (no existence leak).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | llm-call spans surface the ledger's new token split + duration (migration 090; BACKLOG: traces showed per-call cost but not tokens/durations). mapLlmSpan stops hard-coding tokens/durationMs to undefined/null and populates them when the row carries them; pre-090 rows (NULL columns) keep the old shape, so backward compat is by-value, not by-branch. loadLlmSpans selects e.* so a DB that predates 090 doesn't fail the query and silently drop every llm-call span. Totals are unchanged on purpose: totals.tokens still sums bot (chat_tasks) spans because ledger rows mirror the SAME tokens the rollup accumulates — summing both would double-count.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'run-trace-service' });

/** @description The three timeline row kinds, nested conceptually phase > bot > llm-call. */
export type TraceSpanKind = 'phase' | 'bot' | 'llm-call';

/**
 * @description One waterfall row. Optional numeric fields are OMITTED (not zeroed) when the
 * underlying data never recorded them — e.g. an oshal_cost_events row written before
 * migration 090 carries no token split or duration, so its llm-call span reports
 * costUsd/model but leaves tokens/durationMs undefined rather than fabricating a number.
 * Post-090 rows populate both when the producer measured them.
 */
export interface TraceSpan {
  kind: TraceSpanKind;
  label: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd?: number;
  tokens?: number;
  model?: string;
  provider?: string;
  agentId?: string;
}

/** @description The ticket header the trace hangs off. */
export interface TraceTicket {
  id: string;
  type: string;
  status: string;
  owner: string | null;
  created: string;
}

/**
 * @description Roll-up footer. costUsd is the ledger sum over the ticket's linked tasks (matches
 * the budget ticket query); tokens is the chat_tasks token sum — deliberately NOT the ledger's
 * per-event splits (090), because ledger rows mirror the same tokens the chat_tasks rollup
 * accumulates and summing both would double-count; llmCalls counts ledger rows; wallMs spans
 * ticket creation to the latest recorded activity.
 */
export interface TraceTotals {
  costUsd: number;
  tokens: number;
  llmCalls: number;
  wallMs: number;
}

/** @description The full assembled trace returned to the route/surface. */
export interface RunTrace {
  ticket: TraceTicket;
  spans: TraceSpan[];
  totals: TraceTotals;
}

/** UUID shape guard — tickets.ticket_id is UUID; a non-UUID id can never match, so short-circuit. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TicketRow {
  ticket_id: string;
  ticket_type: string | null;
  status: string | null;
  owner_sub: string | null;
  title: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}
interface StatusRow { to_status: string | null; from_status: string | null; created_at: string | Date }
interface BotRow {
  task_id: string; agent_id: string | null; agent_name: string | null; provider_id: string | null;
  total_input_tokens: number | string | null; total_output_tokens: number | string | null;
  total_cost: number | string | null; usage_by_model: unknown; created_at: string | Date; updated_at: string | Date;
}
interface LlmRow {
  ts: string | Date; agent_id: string | null; provider_id: string | null; model_id: string | null; cost_usd: number | string | null;
  /** 090 columns — absent (pre-090 DB) or NULL (event predates 090 / producer didn't know). */
  input_tokens?: number | string | null; output_tokens?: number | string | null; duration_ms?: number | string | null;
}

/**
 * @description Read-model that reconstructs a run's timeline from already-persisted rows. It is
 * intentionally read-only and additive — it introduces no writes and no cross-boundary correlation
 * ids; every span comes from a table the controller/bot path already fills (tickets,
 * ticket_status_history, ticket_task_links, chat_tasks, oshal_cost_events, agents).
 */
export class TraceService {
  private readonly pool: Pool | null;

  /**
   * @description Constructs the service.
   * @param pool - Postgres pool; null runs degraded (getTrace resolves null with a WARN, never throws).
   */
  constructor(pool: Pool | null = null) {
    this.pool = pool;
  }

  /**
   * @description Assembles the waterfall for one ticket, caller-scoped. Loads the ticket first and
   * authorizes on owner_sub (operator sees any) BEFORE reading any child rows, so a caller who does
   * not own the ticket gets the SAME null as a missing ticket — the id is never confirmed to exist.
   * @param ticketId - The tickets.ticket_id to trace.
   * @param callerSub - The validated OIDC sub of the requester (never trusted from the body).
   * @param isOperator - Whether the requester is on the operator allowlist (may trace any ticket).
   * @returns The assembled trace, or null when the ticket is missing, not the caller's, or the id is malformed.
   */
  async getTrace(ticketId: string, callerSub: string | null, isOperator: boolean): Promise<RunTrace | null> {
    if (!this.pool || !UUID_RE.test(ticketId)) return null;
    const ticket = await this.loadTicket(ticketId);
    if (!ticket) return null;
    if (!isOperator && (ticket.owner_sub === null || ticket.owner_sub !== callerSub)) {
      logger.info({ ticketId, callerSub }, 'getTrace: caller not owner + not operator — returning not-found-or-not-yours');
      return null;
    }
    const [phaseSpans, botSpans, llmSpans] = await Promise.all([
      this.loadPhaseSpans(ticketId, ticket),
      this.loadBotSpans(ticketId),
      this.loadLlmSpans(ticketId),
    ]);
    const spans = orderSpans([...phaseSpans, ...botSpans, ...llmSpans]);
    return {
      ticket: mapTicketHeader(ticket),
      spans,
      totals: computeTotals(ticket, botSpans, llmSpans),
    };
  }

  /** @description Loads the ticket header row, or null when absent / unreadable (fail-safe). */
  private async loadTicket(ticketId: string): Promise<TicketRow | null> {
    try {
      const result = await this.pool!.query<TicketRow>(
        `SELECT ticket_id, ticket_type, status, owner_sub, title, created_at, updated_at
           FROM tickets WHERE ticket_id = $1`,
        [ticketId],
      );
      return result.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, ticketId }, 'loadTicket: query failed');
      return null;
    }
  }

  /**
   * @description Derives phase spans from ticket_status_history (the real status-transition log).
   * Each transition opens a span that closes at the NEXT transition (or the ticket's last-updated
   * time for the final one). No history rows => no phase spans; a span is never fabricated.
   */
  private async loadPhaseSpans(ticketId: string, ticket: TicketRow): Promise<TraceSpan[]> {
    try {
      const result = await this.pool!.query<StatusRow>(
        `SELECT from_status, to_status, created_at
           FROM ticket_status_history WHERE ticket_id = $1 ORDER BY created_at ASC`,
        [ticketId],
      );
      return buildPhaseSpans(result.rows, toIso(ticket.updated_at));
    } catch (err) {
      logger.error({ err, ticketId }, 'loadPhaseSpans: query failed — returning no phase spans');
      return [];
    }
  }

  /**
   * @description Loads one bot span per chat_tasks row linked to the ticket. A task is a bot
   * execution: it carries the real token split, accumulated cost, and a wall span (created->updated),
   * labelled with the agent's name when the agents row resolves.
   */
  private async loadBotSpans(ticketId: string): Promise<TraceSpan[]> {
    try {
      const result = await this.pool!.query<BotRow>(
        `SELECT ct.task_id, ct.agent_id, a.name AS agent_name, ct.provider_id,
                ct.total_input_tokens, ct.total_output_tokens, ct.total_cost,
                ct.usage_by_model, ct.created_at, ct.updated_at
           FROM ticket_task_links ttl
           JOIN chat_tasks ct ON ct.task_id = ttl.task_id
           LEFT JOIN agents a ON a.agent_id::text = ct.agent_id
          WHERE ttl.ticket_id = $1
          ORDER BY ct.created_at ASC`,
        [ticketId],
      );
      return result.rows.map(mapBotSpan);
    } catch (err) {
      logger.error({ err, ticketId }, 'loadBotSpans: query failed — returning no bot spans');
      return [];
    }
  }

  /**
   * @description Loads one llm-call span per oshal_cost_events ledger row for the ticket's tasks —
   * the SAME ticket->ticket_task_links->oshal_cost_events join the budget ticket-spend query uses,
   * so per-call costs sum to the trace total AND to the budget number. Post-090 rows carry a
   * per-event token split + measured duration; pre-090 rows (or events whose producer didn't
   * know) leave those NULL and the span omits them. Selecting e.* (not named columns) is
   * deliberate: a DB that predates migration 090 must not fail this query — that would
   * silently drop EVERY llm-call span instead of just the new fields.
   */
  private async loadLlmSpans(ticketId: string): Promise<TraceSpan[]> {
    try {
      const result = await this.pool!.query<LlmRow>(
        `SELECT e.*
           FROM ticket_task_links ttl
           JOIN oshal_cost_events e ON e.task_id = ttl.task_id
          WHERE ttl.ticket_id = $1
          ORDER BY e.ts ASC`,
        [ticketId],
      );
      return result.rows.map(mapLlmSpan);
    } catch (err) {
      logger.error({ err, ticketId }, 'loadLlmSpans: query failed — returning no llm-call spans');
      return [];
    }
  }
}

// ── pure helpers (exported for unit tests) ──────────────────────────────────

/**
 * @description Builds phase spans from ordered status-transition rows. Each row's `to_status` is
 * the phase entered; the span runs to the next row's timestamp (or `fallbackEnd` for the last).
 * @param rows - Status-history rows in ascending created_at order.
 * @param fallbackEnd - ISO end for the final open phase (the ticket's last-updated time).
 * @returns Ordered phase spans (empty when there is no history).
 */
export function buildPhaseSpans(rows: StatusRow[], fallbackEnd: string): TraceSpan[] {
  return rows.map((row, i) => {
    const startedAt = toIso(row.created_at);
    const endedAt = i + 1 < rows.length ? toIso(rows[i + 1].created_at) : fallbackEnd;
    return {
      kind: 'phase' as const,
      label: String(row.to_status ?? 'unknown'),
      startedAt,
      endedAt,
      durationMs: spanMs(startedAt, endedAt),
    };
  });
}

/**
 * @description Maps a linked chat_tasks row to a bot span. Cost + tokens are the row's accumulated
 * totals (real per-bot numbers); the model is the primary key of usage_by_model when present.
 * @param row - The joined chat_tasks + agents row.
 * @returns The bot span.
 */
export function mapBotSpan(row: BotRow): TraceSpan {
  const startedAt = toIso(row.created_at);
  const endedAt = toIso(row.updated_at);
  const tokens = num(row.total_input_tokens) + num(row.total_output_tokens);
  return {
    kind: 'bot',
    label: (row.agent_name && row.agent_name.trim()) || row.agent_id || row.task_id,
    startedAt,
    endedAt,
    durationMs: spanMs(startedAt, endedAt),
    costUsd: amount(row.total_cost),
    tokens,
    model: primaryModel(row.usage_by_model),
    provider: row.provider_id ?? undefined,
    agentId: row.agent_id ?? undefined,
  };
}

/**
 * @description Maps a ledger row to a point-in-time llm-call span. The event timestamp stays the
 * span anchor (endedAt stays null — the row is recorded once, at cost time), but the 090 columns
 * ride along when present: tokens is the row's input+output split and durationMs the producer's
 * measured wall-clock. Pre-090 rows (or events whose producer didn't know) carry NULLs and the
 * span keeps the original shape — tokens undefined, durationMs null — never a fabricated 0.
 * @param row - The oshal_cost_events row.
 * @returns The llm-call span.
 */
export function mapLlmSpan(row: LlmRow): TraceSpan {
  const startedAt = toIso(row.ts);
  const tokens = num(row.input_tokens) + num(row.output_tokens);
  const durationMs = num(row.duration_ms);
  return {
    kind: 'llm-call',
    label: String(row.model_id ?? 'llm-call'),
    startedAt,
    endedAt: null,
    durationMs: durationMs > 0 ? durationMs : null,
    costUsd: amount(row.cost_usd),
    ...(tokens > 0 ? { tokens } : {}),
    model: row.model_id ?? undefined,
    provider: row.provider_id ?? undefined,
    agentId: row.agent_id ?? undefined,
  };
}

/**
 * @description Computes the roll-up footer. costUsd sums the ledger (llm-call) spans so it equals
 * the budget ticket query; tokens sums the bot spans (llm-call token splits mirror the same
 * chat_tasks-accumulated tokens, so summing both would double-count); wallMs runs from
 * ticket creation to the latest activity across the ticket and all spans.
 * @param ticket - The ticket header row.
 * @param botSpans - The assembled bot spans (token source).
 * @param llmSpans - The assembled llm-call spans (cost source + call count).
 * @returns The totals footer.
 */
export function computeTotals(ticket: TicketRow, botSpans: TraceSpan[], llmSpans: TraceSpan[]): TraceTotals {
  const costUsd = round6(llmSpans.reduce((sum, s) => sum + (s.costUsd ?? 0), 0));
  const tokens = botSpans.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
  const createdMs = Date.parse(toIso(ticket.created_at));
  const latestMs = latestActivityMs(ticket, botSpans, llmSpans);
  return {
    costUsd,
    tokens,
    llmCalls: llmSpans.length,
    wallMs: Number.isFinite(createdMs) && latestMs > createdMs ? latestMs - createdMs : 0,
  };
}

/** @description Latest timestamp across the ticket's updated_at and every span boundary, in ms. */
function latestActivityMs(ticket: TicketRow, botSpans: TraceSpan[], llmSpans: TraceSpan[]): number {
  const candidates = [Date.parse(toIso(ticket.updated_at))];
  for (const s of [...botSpans, ...llmSpans]) {
    candidates.push(Date.parse(s.endedAt ?? s.startedAt));
  }
  return Math.max(...candidates.filter((n) => Number.isFinite(n)));
}

/** @description Stable time-order for the merged waterfall; ties break phase < bot < llm-call. */
function orderSpans(spans: TraceSpan[]): TraceSpan[] {
  const rank: Record<TraceSpanKind, number> = { phase: 0, bot: 1, 'llm-call': 2 };
  return [...spans].sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    if (ta !== tb) return ta - tb;
    return rank[a.kind] - rank[b.kind];
  });
}

/** @description Projects the ticket header for the API/surface. */
function mapTicketHeader(ticket: TicketRow): TraceTicket {
  return {
    id: ticket.ticket_id,
    type: ticket.ticket_type ?? 'build',
    status: ticket.status ?? 'unknown',
    owner: ticket.owner_sub,
    created: toIso(ticket.created_at),
  };
}

/** @description The primary model id from a usage_by_model map (object or JSON string), else undefined. */
function primaryModel(raw: unknown): string | undefined {
  let obj: unknown = raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try { obj = JSON.parse(raw); } catch { return undefined; }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const keys = Object.keys(obj as Record<string, unknown>);
    return keys.length > 0 ? keys[0] : undefined;
  }
  return undefined;
}

/** @description Normalizes a pg timestamp (Date or string) to an ISO string. */
function toIso(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date(0).toISOString();
}

/** @description Whole-millisecond span between two ISO instants, or null when unparseable. */
function spanMs(startIso: string, endIso: string): number | null {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/** @description Parses a pg integer-ish value, flooring negatives/garbage to 0. */
function num(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** @description Parses a pg numeric-ish money value, flooring negatives/garbage to 0. */
function amount(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** @description Rounds to 6 dp so summed micro-costs don't carry float noise into the total. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
