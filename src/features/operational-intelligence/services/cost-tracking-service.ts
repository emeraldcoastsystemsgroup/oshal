/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added CostTrackingService — token/cost tracking per provider/agent/ticket (WS-7 #1)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Persist per-model swarm usage rollups into chat_tasks, upsert missing swarm task rows, and rebuild DB summaries from usage_by_model
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added direct per-ticket cost summary query with per-agent and per-model aggregation for cockpit ticket activity rollups
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | persistCostEvent additionally appends ONE oshal_cost_events ledger row per cost event (migration 078). chat_tasks accumulates a task's lifetime totals, which makes it unusable for time-windowed reads — cost-governance daily budget caps were attributing a long-lived task's whole history to the trailing 24h. The ledger write is independently non-fatal (table may predate the migration) so the chat_tasks rollup is never lost to a missing ledger table.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Ledger rows now carry the token split + call duration (migration 090; BACKLOG: traces show per-call cost but not tokens/durations). appendCostLedgerRow was dropping event.inputTokens/outputTokens — numbers every producer already supplies for the chat_tasks rollup — and CostEvent had no duration field even though the execution handlers measure one. New optional CostEvent.durationMs threads through; a 42703 undefined-column error (DB predates 090) falls back to the legacy 6-column insert so the cost row is never lost to the new columns.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { ModelUsageStats } from '@/shared/types';

const logger = createChildLogger({ module: 'cost-tracking-service' });

/**
 * @description Cost event recorded after each LLM call.
 */
export interface CostEvent {
  taskId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  ticketExternalId?: string;
  swarmRunId?: string;
  estimated?: boolean;
  requestCount?: number;
  /** End-user (OIDC sub) this cost is attributable to, for per-owner budget
   *  enforcement (model-gateway Phase 2). Undefined for system/swarm tasks. */
  ownerSub?: string;
  /** Wall-clock duration (ms) of the LLM execution this event bills, when the
   *  producer measured one. Undefined when no call was timed (e.g. marker rows) —
   *  the ledger stores NULL, never a fabricated 0. */
  durationMs?: number;
}

/**
 * @description Aggregated cost summary for a query scope.
 */
export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  currency: string;
  byAgent: Record<string, { cost: number; tokens: number; requests: number }>;
  byModel: Record<string, { cost: number; tokens: number; requests: number }>;
  byProvider: Record<string, { cost: number; tokens: number; requests: number }>;
}

/**
 * @description Aggregated ticket cost contribution for one agent.
 */
export interface TicketAgentCostSummary {
  agentId: string;
  providerId?: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
}

/**
 * @description Aggregated ticket-level cost summary across all linked chat tasks.
 */
export interface TicketCostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  currency: string;
  usageByAgent: Record<string, TicketAgentCostSummary>;
  usageByModel: Record<string, ModelUsageStats>;
  childTicketCount?: number;
  taskCount?: number;
  costMode?: 'actual' | 'estimated' | 'unknown';
}

/**
 * @description CostTrackingService — activates the usage_metrics path from chat_tasks.
 *
 * Writes cost events from LLM execution into chat_tasks (existing schema) and
 * provides aggregation queries for operator visibility. Also maintains an in-memory
 * running total for fast lookups without DB round-trips.
 */
export class CostTrackingService {
  private readonly pool: Pool | null;
  private readonly events: CostEvent[] = [];
  private runningTotal = 0;

  constructor(pool: Pool | null = null) {
    this.pool = pool;
  }

  /**
   * @description Record a cost event from an LLM execution.
   * Persists to chat_tasks if pool is available, always tracks in memory.
   */
  async recordCost(event: CostEvent): Promise<void> {
    this.events.push(event);
    this.runningTotal += event.totalCost;

    if (this.pool) {
      try {
        await this.persistCostEvent(event);
      } catch (err) {
        logger.warn({ err, taskId: event.taskId }, 'Failed to persist cost to chat_tasks — recorded in memory only');
      }
    }

    logger.info(
      { agentId: event.agentId, model: event.modelId, cost: event.totalCost, tokens: event.inputTokens + event.outputTokens },
      'Cost event recorded',
    );
  }

  /**
   * @description Get aggregated cost summary from in-memory events.
   * @param filter - Optional filter by agentId, providerId, or time range
   * @returns Aggregated cost summary
   */
  getSummary(filter?: { agentId?: string; providerId?: string; since?: Date }): CostSummary {
    let filtered = this.events;
    if (filter?.agentId) filtered = filtered.filter((e) => e.agentId === filter.agentId);
    if (filter?.providerId) filtered = filtered.filter((e) => e.providerId === filter.providerId);

    const summary: CostSummary = {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: filtered.length,
      currency: 'USD',
      byAgent: {},
      byModel: {},
      byProvider: {},
    };

    for (const e of filtered) {
      summary.totalCost += e.totalCost;
      summary.totalInputTokens += e.inputTokens;
      summary.totalOutputTokens += e.outputTokens;

      accumulate(summary.byAgent, e.agentId, {
        cost: e.totalCost,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
      });
      accumulate(summary.byModel, e.modelId, {
        cost: e.totalCost,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
      });
      accumulate(summary.byProvider, e.providerId, {
        cost: e.totalCost,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
      });
    }

    return summary;
  }

  /**
   * @description Get running cost total (fast, no DB).
   */
  getRunningTotal(): number {
    return this.runningTotal;
  }

  /**
   * @description Get recent cost events (last N).
   */
  getRecentEvents(limit = 50): CostEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * @description Query cost summary from database for a time range, optionally
   * scoped to a single owner (OIDC sub). When `filter.ownerSub` is provided the
   * totals reflect ONLY that user's attributed spend — the read path behind
   * per-owner budget enforcement (model-gateway Phase 2).
   */
  async queryCostFromDB(
    since?: Date,
    until?: Date,
    filter?: { ownerSub?: string },
  ): Promise<CostSummary | null> {
    if (!this.pool) return null;
    try {
      const result = await this.pool.query(
        `SELECT
          agent_id,
          provider_id,
          total_cost,
          total_input_tokens,
          total_output_tokens,
          total_requests,
          usage_by_model
        FROM chat_tasks
        WHERE ($1::timestamptz IS NULL OR updated_at >= $1)
          AND ($2::timestamptz IS NULL OR updated_at <= $2)
          AND ($3::text IS NULL OR owner_sub = $3)`,
        [since?.toISOString() ?? null, until?.toISOString() ?? null, filter?.ownerSub ?? null],
      );

      const summary: CostSummary = {
        totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
        totalRequests: 0, currency: 'USD', byAgent: {}, byModel: {}, byProvider: {},
      };

      for (const row of result.rows) {
        const agentId = row.agent_id || 'unknown';
        const providerId = row.provider_id || 'unknown';
        const totalCost = normalizeAmount(row.total_cost);
        const totalInputTokens = normalizeCount(row.total_input_tokens);
        const totalOutputTokens = normalizeCount(row.total_output_tokens);
        const totalRequests = normalizeCount(row.total_requests);

        summary.totalCost += totalCost;
        summary.totalInputTokens += totalInputTokens;
        summary.totalOutputTokens += totalOutputTokens;
        summary.totalRequests += totalRequests;

        accumulate(summary.byAgent, agentId, {
          cost: totalCost,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          requests: totalRequests,
        });
        accumulate(summary.byProvider, providerId, {
          cost: totalCost,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          requests: totalRequests,
        });

        const byModel = parseUsageByModel(row.usage_by_model);
        for (const [modelId, usage] of Object.entries(byModel)) {
          accumulate(summary.byModel, modelId, {
            cost: normalizeAmount(usage.totalCost),
            inputTokens: normalizeCount(usage.inputTokens),
            outputTokens: normalizeCount(usage.outputTokens),
            requests: normalizeCount(usage.requestCount),
          });
        }
      }

      return summary;
    } catch (err) {
      logger.warn({ err }, 'Failed to query cost from database');
      return null;
    }
  }

  /**
   * @description Query a complete ticket-level cost summary directly from linked chat_tasks rows.
   * @param ticketId - Ticket identifier used by ticket_task_links.
   * @returns Aggregated ticket cost summary or null when the database is unavailable.
   */
  async queryCostByTicket(ticketId: string): Promise<TicketCostSummary | null> {
    if (!this.pool) return null;

    const startedAt = Date.now();
    logger.info({ ticketId }, 'Querying ticket cost summary');

    try {
      const result = await this.pool.query(
        `SELECT
          ct.agent_id,
          ct.provider_id,
          ct.total_cost,
          ct.total_input_tokens,
          ct.total_output_tokens,
          ct.total_requests,
          ct.cost_currency,
          ct.usage_by_model
        FROM ticket_task_links ttl
        JOIN chat_tasks ct ON ct.task_id = ttl.task_id
        WHERE ttl.ticket_id = $1
        ORDER BY ttl.created_at ASC`,
        [ticketId],
      );

      const summary: TicketCostSummary = {
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalRequests: 0,
        currency: 'USD',
        usageByAgent: {},
        usageByModel: {},
      };

      for (const row of result.rows) {
        const agentId = normalizeIdentifier(row.agent_id);
        const providerId = normalizeIdentifier(row.provider_id);
        const totalCost = normalizeAmount(row.total_cost);
        const totalInputTokens = normalizeCount(row.total_input_tokens);
        const totalOutputTokens = normalizeCount(row.total_output_tokens);
        const totalRequests = normalizeCount(row.total_requests);
        const totalTokens = totalInputTokens + totalOutputTokens;

        summary.totalCost += totalCost;
        summary.totalInputTokens += totalInputTokens;
        summary.totalOutputTokens += totalOutputTokens;
        summary.totalTokens += totalTokens;
        summary.totalRequests += totalRequests;
        summary.currency = normalizeCurrency(row.cost_currency) || summary.currency;

        const existingAgentSummary = summary.usageByAgent[agentId] || {
          agentId,
          providerId: '',
          totalCost: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          totalRequests: 0,
        };

        summary.usageByAgent[agentId] = {
          agentId,
          providerId: providerId || existingAgentSummary.providerId || '',
          totalCost: existingAgentSummary.totalCost + totalCost,
          totalInputTokens: existingAgentSummary.totalInputTokens + totalInputTokens,
          totalOutputTokens: existingAgentSummary.totalOutputTokens + totalOutputTokens,
          totalTokens: existingAgentSummary.totalTokens + totalTokens,
          totalRequests: existingAgentSummary.totalRequests + totalRequests,
        };

        summary.usageByModel = mergeUsageByModel(summary.usageByModel, parseUsageByModel(row.usage_by_model));
      }

      logger.info(
        {
          ticketId,
          rowCount: result.rowCount,
          totalCost: summary.totalCost,
          totalTokens: summary.totalTokens,
          durationMs: Date.now() - startedAt,
        },
        'Ticket cost summary queried',
      );
      return summary;
    } catch (err) {
      logger.warn({ err, ticketId, durationMs: Date.now() - startedAt }, 'Failed to query ticket cost summary');
      return null;
    }
  }

  /**
   * @description Query cost for a ticket and ALL its descendants (recursive tree).
   * Uses ticket_cost_rollup_with_children view when available, falls back to single-ticket query.
   * @param rootTicketId - Root ticket UUID
   * @returns Aggregated cost summary across the full ticket tree, or null
   */
  async queryCostByTicketTree(rootTicketId: string): Promise<TicketCostSummary | null> {
    if (!this.pool) return null;
    try {
      const result = await this.pool.query(
        `SELECT total_cost, total_tokens, total_requests, task_count, agent_count, child_ticket_count
         FROM ticket_cost_rollup_with_children
         WHERE ticket_id = $1`,
        [rootTicketId],
      );
      if (result.rows.length === 0) return this.queryCostByTicket(rootTicketId);
      const row = result.rows[0];
      return {
        totalCost: Number(row.total_cost) || 0,
        totalInputTokens: 0, // View doesn't split input/output — use direct query for detail
        totalOutputTokens: 0,
        totalTokens: Number(row.total_tokens) || 0,
        totalRequests: Number(row.total_requests) || 0,
        currency: 'USD',
        usageByAgent: {},
        usageByModel: {},
        childTicketCount: Number(row.child_ticket_count) || 0,
        taskCount: Number(row.task_count) || 0,
      };
    } catch (err) {
      logger.warn({ err, rootTicketId }, 'Recursive cost query failed — falling back to single ticket');
      return this.queryCostByTicket(rootTicketId);
    }
  }

  private async persistCostEvent(event: CostEvent): Promise<void> {
    const existingResult = await this.pool!.query<TaskCostRow>(
      `SELECT
        task_id,
        title,
        status,
        processing_mode,
        agent_id,
        provider_id,
        message_count,
        turn_count,
        total_input_tokens,
        total_output_tokens,
        total_input_cost,
        total_output_cost,
        total_cost,
        total_requests,
        cost_currency,
        usage_by_model,
        metadata,
        owner_sub,
        created_at
      FROM chat_tasks
      WHERE task_id = $1
      LIMIT 1`,
      [event.taskId],
    );

    const eventUsageByModel = buildUsageByModel(event);
    if (existingResult.rows.length === 0) {
      await this.pool!.query(
        `INSERT INTO chat_tasks (
          task_id, title, status, processing_mode, agent_id, provider_id,
          message_count, turn_count, total_input_tokens, total_output_tokens,
          total_input_cost, total_output_cost, total_cost, total_requests,
          cost_currency, usage_by_model, metadata, owner_sub, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16::jsonb, $17::jsonb, $18, NOW(), NOW()
        )`,
        [
          event.taskId,
          event.ticketExternalId || event.taskId,
          'processing',
          'agentic',
          event.agentId,
          event.providerId,
          0,
          0,
          event.inputTokens,
          event.outputTokens,
          event.inputCost,
          event.outputCost,
          event.totalCost,
          event.requestCount ?? 1,
          event.currency || 'USD',
          JSON.stringify(eventUsageByModel),
          JSON.stringify({}),
          event.ownerSub ?? null,
        ],
      );
      await this.appendCostLedgerRow(event, event.ownerSub ?? null);
      return;
    }

    const existing = existingResult.rows[0];
    const mergedUsageByModel = mergeUsageByModel(parseUsageByModel(existing.usage_by_model), eventUsageByModel);
    await this.pool!.query(
      `UPDATE chat_tasks
      SET
        agent_id = $2,
        provider_id = $3,
        total_input_tokens = $4,
        total_output_tokens = $5,
        total_input_cost = $6,
        total_output_cost = $7,
        total_cost = $8,
        total_requests = $9,
        cost_currency = $10,
        usage_by_model = $11::jsonb,
        owner_sub = COALESCE(owner_sub, $12),
        updated_at = NOW()
      WHERE task_id = $1`,
      [
        event.taskId,
        existing.agent_id || event.agentId,
        existing.provider_id || event.providerId,
        normalizeCount(existing.total_input_tokens) + event.inputTokens,
        normalizeCount(existing.total_output_tokens) + event.outputTokens,
        normalizeAmount(existing.total_input_cost) + event.inputCost,
        normalizeAmount(existing.total_output_cost) + event.outputCost,
        normalizeAmount(existing.total_cost) + event.totalCost,
        normalizeCount(existing.total_requests) + (event.requestCount ?? 1),
        existing.cost_currency || event.currency || 'USD',
        JSON.stringify(mergedUsageByModel),
        event.ownerSub ?? null,
      ],
    );
    await this.appendCostLedgerRow(event, event.ownerSub ?? existing.owner_sub ?? null);
  }

  /**
   * @description Appends this event's cost to the oshal_cost_events per-event ledger — the
   * table time-windowed reads (daily budget caps) sum. chat_tasks can't serve that read: it
   * accumulates a task's LIFETIME totals with updated_at bumped per event, so a trailing-24h
   * filter attributes old spend to today. Also lands THIS event's token split + call duration
   * (migration 090) so a run trace can show tokens/latency per llm-call, not just dollars.
   * Independently non-fatal on purpose: the ledger table ships in migration 078, and a
   * deployment that hasn't applied it yet must still get its chat_tasks rollup (budget
   * enforcement fails open without the ledger). A DB that HAS the table but predates the
   * 090 columns (42703 undefined_column) retries the legacy 6-column insert — the new
   * observability fields must never cost us the cost row itself.
   * @param event - The cost event just persisted to chat_tasks.
   * @param ownerSub - Accountable end-user sub, falling back to the task row's existing owner.
   * @returns Resolves once the ledger row is written or the failure is logged.
   */
  private async appendCostLedgerRow(event: CostEvent, ownerSub: string | null): Promise<void> {
    try {
      await this.pool!.query(
        `INSERT INTO oshal_cost_events
           (task_id, owner_sub, agent_id, provider_id, model_id, cost_usd, input_tokens, output_tokens, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.taskId, ownerSub, event.agentId, event.providerId, event.modelId, event.totalCost,
          normalizeCount(event.inputTokens), normalizeCount(event.outputTokens), normalizeDurationMs(event.durationMs),
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '42703') {
        await this.appendLegacyCostLedgerRow(event, ownerSub);
        return;
      }
      logger.warn(
        { err, taskId: event.taskId },
        'Failed to append oshal_cost_events ledger row — windowed budget spend will not see this event',
      );
    }
  }

  /**
   * @description Pre-090 fallback: the ledger table exists but lacks the token/duration
   * columns, so write the original 6-column row rather than losing the cost event entirely.
   * @param event - The cost event just persisted to chat_tasks.
   * @param ownerSub - Accountable end-user sub resolved by the caller.
   * @returns Resolves once the legacy row is written or the failure is logged.
   */
  private async appendLegacyCostLedgerRow(event: CostEvent, ownerSub: string | null): Promise<void> {
    try {
      await this.pool!.query(
        `INSERT INTO oshal_cost_events (task_id, owner_sub, agent_id, provider_id, model_id, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [event.taskId, ownerSub, event.agentId, event.providerId, event.modelId, event.totalCost],
      );
      logger.warn(
        { taskId: event.taskId },
        'oshal_cost_events lacks the 090 token/duration columns — wrote the legacy row; apply migration 090',
      );
    } catch (err) {
      logger.warn(
        { err, taskId: event.taskId },
        'Failed to append oshal_cost_events ledger row — windowed budget spend will not see this event',
      );
    }
  }
}

function accumulate(
  map: Record<string, { cost: number; tokens: number; requests: number }>,
  key: string,
  event: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    requests?: number;
  },
): void {
  if (!map[key]) map[key] = { cost: 0, tokens: 0, requests: 0 };
  map[key].cost += event.cost;
  map[key].tokens += event.inputTokens + event.outputTokens;
  map[key].requests += event.requests ?? 1;
}

interface TaskCostRow {
  task_id: string;
  title: string | null;
  status: string | null;
  processing_mode: string | null;
  agent_id: string | null;
  provider_id: string | null;
  message_count: number | string | null;
  turn_count: number | string | null;
  total_input_tokens: number | string | null;
  total_output_tokens: number | string | null;
  total_input_cost: number | string | null;
  total_output_cost: number | string | null;
  total_cost: number | string | null;
  total_requests: number | string | null;
  cost_currency: string | null;
  usage_by_model: Record<string, ModelUsageStats> | string | null;
  metadata: Record<string, unknown> | string | null;
  owner_sub: string | null;
  created_at: string | Date | null;
}

function buildUsageByModel(event: CostEvent): Record<string, ModelUsageStats> {
  return {
    [normalizeModelId(event.modelId)]: {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.inputTokens + event.outputTokens,
      inputCost: event.inputCost,
      outputCost: event.outputCost,
      totalCost: event.totalCost,
      requestCount: event.requestCount ?? 1,
    },
  };
}

function mergeUsageByModel(
  base: Record<string, ModelUsageStats>,
  incoming: Record<string, ModelUsageStats>,
): Record<string, ModelUsageStats> {
  const merged: Record<string, ModelUsageStats> = { ...base };
  for (const [model, stats] of Object.entries(incoming)) {
    const existing = merged[model] || createEmptyModelUsage();
    merged[model] = {
      inputTokens: normalizeCount(existing.inputTokens) + normalizeCount(stats.inputTokens),
      outputTokens: normalizeCount(existing.outputTokens) + normalizeCount(stats.outputTokens),
      totalTokens: normalizeCount(existing.totalTokens) + normalizeCount(stats.totalTokens),
      inputCost: normalizeAmount(existing.inputCost) + normalizeAmount(stats.inputCost),
      outputCost: normalizeAmount(existing.outputCost) + normalizeAmount(stats.outputCost),
      totalCost: normalizeAmount(existing.totalCost) + normalizeAmount(stats.totalCost),
      requestCount: normalizeCount(existing.requestCount) + normalizeCount(stats.requestCount),
    };
  }
  return merged;
}

function parseUsageByModel(rawValue: unknown): Record<string, ModelUsageStats> {
  if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue as Record<string, ModelUsageStats>;
  }

  if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, ModelUsageStats>;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to parse usage_by_model payload');
    }
  }

  return {};
}

function createEmptyModelUsage(): ModelUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    requestCount: 0,
  };
}

function normalizeCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Normalizes an optional measured duration for the ledger: a finite,
 * non-negative number rounds to whole ms; anything else becomes NULL — an unmeasured
 * duration must be stored as unknown, never as a fabricated 0.
 */
function normalizeDurationMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function normalizeAmount(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeModelId(modelId: string): string {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function normalizeIdentifier(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function normalizeCurrency(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : 'USD';
}
