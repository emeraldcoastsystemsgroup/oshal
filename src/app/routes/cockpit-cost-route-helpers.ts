/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit ticket cost and usage rollup helpers from cockpit-route-helpers.ts to satisfy governance decomposition requirements and support per-agent ticket cost breakdowns
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-estimate totalCost from model pricing at read time when persisted value is 0 but tokens are present (codex subscription returns no cost, etc.)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CockpitAgentUsageStats carries providerId, so the cockpit's "Provider" column stops rendering an em dash for every bot. The renderer at ticket-view-cost-renderer.js:51 has always read `bot.providerId || '-'` under a `<th>Provider</th>`, but the type never had the field and the rollup dropped it - the column was structurally dead, not empty for want of data. chat_tasks.provider_id is populated (896 live rows across openai-codex, claude-code, cline-cli, byo-llm, image-provider:openrouter and deterministic-provider) and the task store already maps it to providerId, so this only stops discarding it. A merge that spans two providers resolves to 'mixed' rather than keeping whichever arrived first, because one bot can legitimately run on more than one across tasks.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Each bot row also carries costUnitLabel, so the cockpit's Est. Cost column stops adding three different units as if they were one. ADR-127: a CLI turn's cost_usd is a subscription price-equivalent and a BYO turn records $0 by design, so a column that sums them beside real metered spend is not a spend figure. Reuses the existing classifyCostUnit/COST_UNIT_LABELS that /api/budgets/spend already reports by, rather than inventing a second classification. The label is null - not defaulted - for an ABSENT or 'mixed' provider. It is NOT null for an unrecognised-but-present id: classifyCostUnit answers 'billed' for those deliberately, so a CLI provider added to the harness union but not to its price-equivalent set still reads as real metered money here, exactly as antigravity-cli once did. That is a cost-unit.ts concern, named in deriveCostUnitLabel's doc rather than papered over in a display helper.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Two corrections of record. The JSDoc above deriveCostUnitLabel actually documented mergeProviderId - two parameters it does not have and a return value it never produces - so an exported member had no doc of its own and mergeProviderId had none at all. And the claim that the label is null for an "unknown" provider was false: it is null for an ABSENT provider and for the 'mixed' sentinel, while an unrecognised-but-PRESENT id is labelled 'billed', which is classifyCostUnit's deliberate conservative default. Saying "unknown" turned that default into a guarantee this code does not make.
 */

import { resolveUsageCost } from '@/features/llm-provider';
import { classifyCostUnit, COST_UNIT_LABELS } from '@/features/cost-governance';

/** Sentinel provider for a bot whose spend spans more than one provider. */
export const MIXED_PROVIDER = 'mixed';

/**
 * @description Normalized usage totals for one model in cockpit ticket cost views.
 */
export type CockpitModelUsageStats = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  requestCount: number;
};

/**
 * @description Normalized usage totals for one contributing agent in cockpit ticket cost views.
 */
export type CockpitAgentUsageStats = {
  agentId: string;
  agentName: string;
  /** Provider the bot's spend was booked against, for the cockpit's "Provider" column.
   *  `null` means the source row had no provider_id, which the renderer shows as an em dash.
   *  'mixed' when a merge spans two different providers - one bot CAN run on more than one
   *  across tasks, and collapsing that to whichever arrived first would be a quiet lie. */
  providerId: string | null;
  /** ADR-127 unit the `totalCost` figure is expressed in, already rendered as an operator-facing
   *  label. `null` when the provider is ABSENT, or when the row merged across providers - in
   *  neither case can a single unit be named, and classifyCostUnit would answer 'billed' for
   *  both, which reads as real money and may be neither.
   *
   *  "Absent" includes the direct cost summary's UNKNOWN_PROVIDER sentinel, which is the literal
   *  string 'unknown' and therefore truthy: it is mapped back to null where that summary is read,
   *  because otherwise it reads here as a present provider and gets labelled.
   *
   *  An unrecognised-but-PRESENT id is still labelled 'billed', which is classifyCostUnit's
   *  deliberate conservative default rather than a claim this helper makes. See
   *  deriveCostUnitLabel for why correcting that belongs in cost-unit.ts. */
  costUnitLabel: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  totalRequests: number;
};

/**
 * @description Aggregated task usage summary used by cockpit ticket detail routes.
 */
export type TaskUsageSummary = {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  usageByModel: Record<string, CockpitModelUsageStats>;
  usageByAgent: Record<string, CockpitAgentUsageStats>;
  modelId: string | null;
};

/**
 * @description Normalizes a usage-by-model payload into numeric cockpit-friendly values.
 * @param value - Raw usage-by-model payload.
 * @returns Normalized model usage map.
 */
export function normalizeUsageByModel(value: unknown): Record<string, CockpitModelUsageStats> {
  const normalized: Record<string, CockpitModelUsageStats> = {};
  const record = readRecord(value);

  Object.entries(record).forEach(([modelId, stats]) => {
    if (!modelId) {
      return;
    }

    const usageRecord = readRecord(stats);
    const inputTokens  = readOptionalNumber(usageRecord.inputTokens) || 0;
    const outputTokens = readOptionalNumber(usageRecord.outputTokens) || 0;
    const totalTokens  = readOptionalNumber(usageRecord.totalTokens) || (inputTokens + outputTokens);
    let inputCost      = readOptionalNumber(usageRecord.inputCost) || 0;
    let outputCost     = readOptionalNumber(usageRecord.outputCost) || 0;
    let totalCost      = readOptionalNumber(usageRecord.totalCost) || 0;

    // If persisted cost is $0 but tokens exist, fall back to model-pricing estimate.
    // This covers codex subscription (no server cost), claude-code OAuth (no per-request
    // cost reported), and any other provider that zeros cost but reports usage.
    if (totalCost === 0 && (inputTokens > 0 || outputTokens > 0)) {
      const est = resolveUsageCost({
        providerCost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
        usage: { inputTokens, outputTokens, totalTokens },
        modelId,
      });
      if (est.totalCost > 0) {
        inputCost  = est.inputCost;
        outputCost = est.outputCost;
        totalCost  = est.totalCost;
      }
    }

    normalized[modelId] = {
      inputTokens,
      outputTokens,
      totalTokens,
      inputCost,
      outputCost,
      totalCost,
      requestCount: readOptionalNumber(usageRecord.requestCount) || 0,
    };
  });

  return normalized;
}

/**
 * @description Merges two usage-by-model maps into one aggregate map.
 * @param base - Existing usage map.
 * @param incoming - Additional usage map.
 * @returns Merged model usage map.
 */
export function mergeModelUsageMaps(
  base: Record<string, CockpitModelUsageStats>,
  incoming: Record<string, CockpitModelUsageStats>,
): Record<string, CockpitModelUsageStats> {
  const merged: Record<string, CockpitModelUsageStats> = { ...base };

  Object.entries(incoming).forEach(([modelId, stats]) => {
    const current = merged[modelId] || createEmptyModelUsage();
    merged[modelId] = {
      inputTokens: current.inputTokens + (readOptionalNumber(stats.inputTokens) || 0),
      outputTokens: current.outputTokens + (readOptionalNumber(stats.outputTokens) || 0),
      totalTokens: current.totalTokens + (readOptionalNumber(stats.totalTokens) || 0),
      inputCost: current.inputCost + (readOptionalNumber(stats.inputCost) || 0),
      outputCost: current.outputCost + (readOptionalNumber(stats.outputCost) || 0),
      totalCost: current.totalCost + (readOptionalNumber(stats.totalCost) || 0),
      requestCount: current.requestCount + (readOptionalNumber(stats.requestCount) || 0),
    };
  });

  return merged;
}

/**
 * @description Merges two usage-by-agent maps into one aggregate map.
 * @param base - Existing agent usage map.
 * @param incoming - Additional agent usage map.
 * @returns Merged agent usage map.
 */
export function mergeAgentUsageMaps(
  base: Record<string, CockpitAgentUsageStats>,
  incoming: Record<string, CockpitAgentUsageStats>,
): Record<string, CockpitAgentUsageStats> {
  const merged: Record<string, CockpitAgentUsageStats> = { ...base };

  Object.entries(incoming).forEach(([agentId, stats]) => {
    const current = merged[agentId] || createEmptyAgentUsage(agentId, stats.agentName);
    const mergedProviderId = mergeProviderId(current.providerId, stats.providerId);
    merged[agentId] = {
      agentId,
      agentName: stats.agentName || current.agentName || agentId,
      providerId: mergedProviderId,
      // Derived from the MERGED provider, never merged on its own: a label and a provider that
      // disagree would be worse than no label at all.
      costUnitLabel: deriveCostUnitLabel(mergedProviderId),
      totalInputTokens: current.totalInputTokens + (readOptionalNumber(stats.totalInputTokens) || 0),
      totalOutputTokens: current.totalOutputTokens + (readOptionalNumber(stats.totalOutputTokens) || 0),
      totalTokens: current.totalTokens + (readOptionalNumber(stats.totalTokens) || 0),
      totalCost: current.totalCost + (readOptionalNumber(stats.totalCost) || 0),
      totalRequests: current.totalRequests + (readOptionalNumber(stats.totalRequests) || 0),
    };
  });

  return merged;
}

/**
 * @description Picks the model with the greatest token volume from a usage map.
 * @param usageByModel - Usage-by-model map.
 * @returns Primary model identifier or null.
 */
export function pickPrimaryModel(usageByModel: Record<string, CockpitModelUsageStats>): string | null {
  const ranked = Object.entries(usageByModel).sort((left, right) => right[1].totalTokens - left[1].totalTokens);
  return ranked[0]?.[0] || null;
}

/**
 * @description Builds a normalized usage summary from one task-like record.
 * @param task - Task-like record.
 * @returns Usage summary for the provided task.
 */
export function readTaskUsageSummary(task: Record<string, unknown> | null | undefined): TaskUsageSummary {
  const usageByModel = normalizeUsageByModel(task?.usageByModel);
  const usageTotals = Object.values(usageByModel).reduce((acc, stats) => ({
    totalCost: acc.totalCost + stats.totalCost,
    totalInputTokens: acc.totalInputTokens + stats.inputTokens,
    totalOutputTokens: acc.totalOutputTokens + stats.outputTokens,
    totalRequests: acc.totalRequests + stats.requestCount,
  }), {
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalRequests: 0,
  });
  const totalInputTokens = readOptionalNumber(task?.totalInputTokens) || usageTotals.totalInputTokens;
  const totalOutputTokens = readOptionalNumber(task?.totalOutputTokens) || usageTotals.totalOutputTokens;
  const totalTokens = readOptionalNumber(task?.totalTokens) || (totalInputTokens + totalOutputTokens);
  const totalCost = readOptionalNumber(task?.totalCost)
    || readOptionalNumber(task?.actualCost)
    || readOptionalNumber(task?.estimatedCost)
    || usageTotals.totalCost;
  const totalRequests = readOptionalNumber(task?.totalRequests) || usageTotals.totalRequests;
  const usageByAgent = buildTaskAgentUsage(task, totalInputTokens, totalOutputTokens, totalTokens, totalCost, totalRequests);

  return {
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalRequests,
    usageByModel,
    usageByAgent,
    modelId: pickPrimaryModel(usageByModel),
  };
}

/**
 * @description Aggregates usage summaries from multiple task-like records.
 * @param tasks - Task-like records.
 * @returns Aggregated usage summary.
 */
export function rollupTaskUsage(tasks: Array<Record<string, unknown>>): TaskUsageSummary {
  return tasks.reduce<TaskUsageSummary>((acc, task) => {
    const summary = readTaskUsageSummary(task);
    const usageByModel = mergeModelUsageMaps(acc.usageByModel, summary.usageByModel);
    const usageByAgent = mergeAgentUsageMaps(acc.usageByAgent, summary.usageByAgent);

    return {
      totalCost: acc.totalCost + summary.totalCost,
      totalInputTokens: acc.totalInputTokens + summary.totalInputTokens,
      totalOutputTokens: acc.totalOutputTokens + summary.totalOutputTokens,
      totalTokens: acc.totalTokens + summary.totalTokens,
      totalRequests: acc.totalRequests + summary.totalRequests,
      usageByModel,
      usageByAgent,
      modelId: pickPrimaryModel(usageByModel),
    };
  }, createEmptyTaskUsageSummary());
}

/**
 * @description Builds a per-agent rollup from task-like records.
 * @param tasks - Task-like records.
 * @returns Aggregated usage-by-agent map.
 */
export function rollupTaskUsageByAgent(tasks: Array<Record<string, unknown>>): Record<string, CockpitAgentUsageStats> {
  return rollupTaskUsage(tasks).usageByAgent;
}

function buildTaskAgentUsage(
  task: Record<string, unknown> | null | undefined,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalTokens: number,
  totalCost: number,
  totalRequests: number,
): Record<string, CockpitAgentUsageStats> {
  const agentId = readOptionalIdentifier(task?.agentId)
    || readOptionalIdentifier(task?.assignee)
    || readOptionalIdentifier(task?.assignedAgentId);

  if (!agentId) {
    return {};
  }

  const taskProviderId = readOptionalIdentifier(task?.providerId) ?? null;

  return {
    [agentId]: {
      agentId,
      agentName: agentId,
      // chat_tasks.provider_id, mapped to camelCase by the task store. Live rows carry
      // openai-codex / claude-code / cline-cli / byo-llm / image-provider:* / deterministic-provider.
      providerId: taskProviderId,
      costUnitLabel: deriveCostUnitLabel(taskProviderId),
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCost,
      totalRequests,
    },
  };
}

function createEmptyTaskUsageSummary(): TaskUsageSummary {
  return {
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalRequests: 0,
    usageByModel: {},
    usageByAgent: {},
    modelId: null,
  };
}

function createEmptyModelUsage(): CockpitModelUsageStats {
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

/**
 * @description Names the ADR-127 unit a bot row's cost figure is expressed in, for display.
 * @param providerId - The row's merged provider id, the 'mixed' sentinel, or null when absent.
 * @returns The operator-facing unit label, or null when no single unit can be named.
 *
 * Returns null for an ABSENT provider and for the 'mixed' sentinel. Callers reading the direct
 * cost summary must map its UNKNOWN_PROVIDER sentinel to null first — it is the literal string
 * 'unknown', so it arrives here looking like a provider and would be labelled 'billed'. It does
 * NOT return null for an unrecognised-but-present id: `classifyCostUnit` answers 'billed' for anything outside its
 * known sets, deliberately, because the metered reading is the conservative one for a budget
 * surface. So a CLI provider added to the harness union but not to PRICE_EQUIVALENT_PROVIDERS
 * will read here as real metered money until it is added - which has happened before, and is
 * recorded in cost-unit.ts's own Change Log for `antigravity-cli`. Fixing that belongs in
 * cost-unit.ts, next to the sets, not in a display helper that would then disagree with the
 * budget caps.
 */
export function deriveCostUnitLabel(providerId: string | null): string | null {
  if (!providerId || providerId === MIXED_PROVIDER) return null;
  return COST_UNIT_LABELS[classifyCostUnit(providerId)];
}

/**
 * @description Combines two provider labels for one bot without inventing a winner.
 * @param current - Provider already accumulated for this bot, or null when absent.
 * @param incoming - Provider on the row being merged in, or null when absent.
 * @returns The shared provider, the known one when only one side has it, or 'mixed' when they
 *          genuinely differ - a bot may span providers across tasks and the column must say so.
 */
function mergeProviderId(current: string | null, incoming: string | null): string | null {
  if (!current) return incoming ?? null;
  if (!incoming || incoming === current) return current;
  return MIXED_PROVIDER;
}

function createEmptyAgentUsage(agentId: string, agentName = agentId): CockpitAgentUsageStats {
  return {
    agentId,
    agentName,
    providerId: null,
    costUnitLabel: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalRequests: 0,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readOptionalIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}