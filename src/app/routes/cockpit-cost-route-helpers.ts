/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit ticket cost and usage rollup helpers from cockpit-route-helpers.ts to satisfy governance decomposition requirements and support per-agent ticket cost breakdowns
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-estimate totalCost from model pricing at read time when persisted value is 0 but tokens are present (codex subscription returns no cost, etc.)
 */

import { resolveUsageCost } from '@/features/llm-provider';

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
    merged[agentId] = {
      agentId,
      agentName: stats.agentName || current.agentName || agentId,
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

  return {
    [agentId]: {
      agentId,
      agentName: agentId,
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

function createEmptyAgentUsage(agentId: string, agentName = agentId): CockpitAgentUsageStats {
  return {
    agentId,
    agentName,
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