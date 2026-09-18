/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The inline chat turn's cost-ledger port. BudgetService sums oshal_cost_events for its trailing-window caps, and until now nothing on the controller-inline path wrote that table: the orchestrator's taskStore.recordUsage only bumps chat_tasks lifetime totals, so the HARD per-user cap at the executeBotOrInline chokepoint could never see the spend its own inline branch (or any cockpit chat turn) produced. Measured on the running box before this change: 384 owner-attributed inline tasks, 2276 requests, $162.06 in chat_tasks, 0 ledger rows. This module is the pure half — it turns one finished turn's TaskUsageSummary into per-model ledger events under the accountable owner — and the narrow interface the orchestrator records them through; the app layer binds it to CostTrackingService.
 */

import type { TaskUsageSummary } from '@/shared/types';

/** @description One ledger row's worth of a finished inline turn: this turn's spend only, never a running total. */
export interface InlineTurnCostEvent {
  /** The chat thread (chat_tasks.task_id) — the join key ticket/app budget scopes attribute through. */
  taskId: string;
  /** The bot that answered; null when the caller named none (the ledger stores NULL, never a made-up id). */
  agentId: string | null;
  /** The provider that ran the turn (LLMService.getProviderName()); what cost surfaces classify the unit by. */
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  requestCount: number;
  /** The accountable end-user; undefined only for a turn with no owner on the request or the thread. */
  ownerSub?: string;
  /** Wall-clock for the whole turn; only attached when the turn produced exactly one row. */
  durationMs?: number;
}

/** @description What the orchestrator needs from a ledger: append this turn's events under the owner. */
export interface InlineTurnCostLedger {
  recordInlineTurn(events: readonly InlineTurnCostEvent[]): Promise<void>;
}

/** @description The facts a finished turn supplies to {@link buildInlineTurnCostEvents}. */
export interface InlineTurnAttribution {
  taskId: string;
  agentId?: string;
  providerId: string;
  ownerSub?: string;
  durationMs: number;
}

/** The model key a summary carries when a provider reported usage but no model name. */
const UNKNOWN_MODEL = 'unknown';

/**
 * @description Turns a finished turn's usage summary into ledger events, one per model bucket,
 * so a multi-model agentic turn lands each model's own tokens and cost. A summary with no
 * requests, no tokens and no cost yields nothing — a turn that never reached a model must not
 * mint a $0 row that reads as a call. When the provider reported usage without a byModel split
 * (a bare summary), the totals land under one `unknown` model row rather than being dropped.
 * @param usage - The turn's usage summary as the orchestrator persisted it to chat_tasks.
 * @param attribution - Who ran it, on what, for whom, and how long the turn took.
 * @returns The events to append; empty when the turn carried no usage.
 */
export function buildInlineTurnCostEvents(
  usage: TaskUsageSummary | undefined,
  attribution: InlineTurnAttribution,
): InlineTurnCostEvent[] {
  if (!usage) return [];
  const base = {
    taskId: attribution.taskId,
    agentId: attribution.agentId?.trim() || null,
    providerId: attribution.providerId,
    currency: usage.currency || 'USD',
    ...(attribution.ownerSub ? { ownerSub: attribution.ownerSub } : {}),
  };
  const buckets = Object.entries(usage.byModel ?? {}).filter(([, stats]) => carriesUsage(stats));
  const events: InlineTurnCostEvent[] = buckets.map(([modelId, stats]) => ({
    ...base,
    modelId: modelId.trim() || UNKNOWN_MODEL,
    inputTokens: count(stats.inputTokens),
    outputTokens: count(stats.outputTokens),
    inputCost: amount(stats.inputCost),
    outputCost: amount(stats.outputCost),
    totalCost: amount(stats.totalCost),
    requestCount: count(stats.requestCount),
  }));
  if (events.length === 0 && carriesUsage(usage)) {
    events.push({
      ...base,
      modelId: UNKNOWN_MODEL,
      inputTokens: count(usage.inputTokens),
      outputTokens: count(usage.outputTokens),
      inputCost: amount(usage.inputCost),
      outputCost: amount(usage.outputCost),
      totalCost: amount(usage.totalCost),
      requestCount: count(usage.requestCount),
    });
  }
  if (events.length === 1 && attribution.durationMs > 0) {
    events[0].durationMs = Math.round(attribution.durationMs);
  }
  return events;
}

/** @description True when a bucket records at least one request, token or cent — i.e. a model ran. */
function carriesUsage(stats: { requestCount?: number; inputTokens?: number; outputTokens?: number; totalCost?: number }): boolean {
  return count(stats.requestCount) > 0 || count(stats.inputTokens) > 0
    || count(stats.outputTokens) > 0 || amount(stats.totalCost) > 0;
}

function count(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

function amount(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0;
}
