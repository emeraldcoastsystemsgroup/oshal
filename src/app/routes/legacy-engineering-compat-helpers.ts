/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A4/TD-15: Extracted pure utility functions from legacy-engineering-compat-routes.ts (1082 → <1000 decomposition)
 */
import type { ModelUsageStats, StoredTask } from '@/shared/types';
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '@/entities/ticket';

const TASK_STATUS_ACTIVE = new Set(['active', 'processing', 'waiting_for_input']);

/**
 * @description Set of task statuses considered "active" for load and dispatch calculations.
 */
export { TASK_STATUS_ACTIVE };

/** @description Status string representing a routing failure on a work item. */
export const ROUTING_FAILED_STATUS = 'routing_failed';

/**
 * @description Extracts a lifecycle target container name from a request body or query object.
 */
export function readLifecycleTarget(body: unknown): string {
  if (!body || typeof body !== 'object') {
    throw new Error('Bot target is required');
  }

  const record = body as Record<string, unknown>;
  const value = record.containerName ?? record.container ?? record.service ?? record.botName;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Bot target is required');
  }

  return value.trim();
}

/**
 * @description Safely casts an unknown value to a string-keyed record.
 */
export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * @description Reads an unknown value as a trimmed string, or returns undefined.
 */
export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @description Reads an unknown value as a finite number, or returns undefined.
 */
export function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * @description Returns the later of two ISO timestamps, or whichever is defined.
 */
export function chooseLatestTimestamp(
  currentIso: string | undefined,
  candidateIso: string | undefined,
): string | undefined {
  if (!candidateIso) {
    return currentIso;
  }
  if (!currentIso) {
    return candidateIso;
  }
  return new Date(candidateIso).getTime() >= new Date(currentIso).getTime()
    ? candidateIso
    : currentIso;
}

/**
 * @description Validates that a proxy health-check target is an allowed origin.
 */
export function isAllowedHealthTarget(target: string): boolean {
  return (
    target.startsWith('http://localhost:') ||
    target.startsWith('http://127.0.0.1:') ||
    target.startsWith('http://swarm-') ||
    target.startsWith('http://oshal-')
  );
}

/**
 * @description Attempts to parse a string as JSON; falls back to a status wrapper.
 */
export function parseJsonOrFallback(payload: string, ok: boolean): unknown {
  try {
    return JSON.parse(payload);
  } catch (_error) {
    return {
      status: ok ? 'ok' : 'error',
      raw: payload,
    };
  }
}

/**
 * @description Converts a ticket state slug to a human-readable label.
 */
export function humanizeTicketState(state: string): string {
  return state
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * @description Converts a task state slug to a human-readable label.
 */
export function humanizeTaskState(state: string): string {
  return state
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * @description Maps an OSHAL ticket status to the legacy state group enum.
 */
export function mapOshalStateToLegacyGroup(
  state: string,
): 'unstarted' | 'started' | 'done' | 'cancelled' {
  if (state === 'complete') {
    return 'done';
  }
  if (state === 'approval_required') {
    return 'started';
  }
  if (state === 'backlog' || state === 'approved') {
    return 'unstarted';
  }
  return 'started';
}

/**
 * @description Maps a task status to the legacy state group enum.
 */
export function mapTaskStateToLegacyGroup(
  state: string,
): 'unstarted' | 'started' | 'done' | 'cancelled' {
  if (state === 'completed') {
    return 'done';
  }
  if (state === 'failed' || state === 'cancelled') {
    return 'cancelled';
  }
  if (state === 'created') {
    return 'unstarted';
  }
  return 'started';
}

/**
 * @description Parses an integer from an unknown value, returning 0 for non-positive or invalid inputs.
 */
export function normalizeModelUsageNumber(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Parses a float from an unknown value, returning 0 for non-positive or invalid inputs.
 */
export function normalizeModelUsageFloat(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Safely casts a raw value to a model usage record map.
 */
export function normalizeUsageByModel(
  rawValue: unknown,
): Record<string, ModelUsageStats> {
  if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue as Record<string, ModelUsageStats>;
  }
  return {};
}

/**
 * @description Creates a zero-valued ModelUsageStats record.
 */
export function createEmptyModelUsage(): ModelUsageStats {
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
 * @description Merges two model-keyed usage maps by summing all numeric fields.
 */
export function mergeModelUsageMaps(
  base: Record<string, ModelUsageStats>,
  incoming: Record<string, ModelUsageStats>,
): Record<string, ModelUsageStats> {
  const merged: Record<string, ModelUsageStats> = { ...base };
  Object.entries(incoming).forEach(([modelId, stats]) => {
    const current = merged[modelId] || createEmptyModelUsage();
    merged[modelId] = {
      inputTokens:
        normalizeModelUsageNumber(current.inputTokens) +
        normalizeModelUsageNumber(stats.inputTokens),
      outputTokens:
        normalizeModelUsageNumber(current.outputTokens) +
        normalizeModelUsageNumber(stats.outputTokens),
      totalTokens:
        normalizeModelUsageNumber(current.totalTokens) +
        normalizeModelUsageNumber(stats.totalTokens),
      inputCost:
        normalizeModelUsageFloat(current.inputCost) +
        normalizeModelUsageFloat(stats.inputCost),
      outputCost:
        normalizeModelUsageFloat(current.outputCost) +
        normalizeModelUsageFloat(stats.outputCost),
      totalCost:
        normalizeModelUsageFloat(current.totalCost) +
        normalizeModelUsageFloat(stats.totalCost),
      requestCount:
        normalizeModelUsageNumber(current.requestCount) +
        normalizeModelUsageNumber(stats.requestCount),
    };
  });
  return merged;
}

/**
 * @description Sums total tokens from a task, using the composite fallback if the scalar is absent.
 */
export function readTaskTotalTokens(task: StoredTask): number {
  return (
    readOptionalNumber(task.totalTokens) ||
    0 ||
    (readOptionalNumber(task.totalInputTokens) || 0) +
      (readOptionalNumber(task.totalOutputTokens) || 0)
  );
}

/**
 * @description Extracts a ticket ID from task metadata, checking both field name conventions.
 */
export function readTaskTicketId(task: StoredTask): string | null {
  return (
    readOptionalString(task.metadata?.ticketId) ||
    readOptionalString(task.metadata?.externalId) ||
    null
  );
}

/**
 * @description Resolves a project ID and name from task metadata, falling back to defaults.
 */
export function resolveProjectSelection(
  task: StoredTask,
): { projectId: string; projectName: string } {
  const projectName =
    readOptionalString(task.metadata?.projectName) ||
    readOptionalString(task.metadata?.project) ||
    DEFAULT_PROJECT_NAME;
  const projectId =
    readOptionalString(task.metadata?.projectId) ||
    readOptionalString(task.metadata?.project_id) ||
    slugifyCompat(projectName) ||
    DEFAULT_PROJECT_ID;
  return { projectId, projectName };
}

/**
 * @description Picks the model with the highest total token count from a usage map.
 */
export function pickPrimaryModel(
  usageByModel: Record<string, ModelUsageStats>,
): string | null {
  const ranked = Object.entries(usageByModel).sort(
    (left, right) =>
      normalizeModelUsageNumber(right[1].totalTokens) -
      normalizeModelUsageNumber(left[1].totalTokens),
  );
  return ranked[0]?.[0] || null;
}

/**
 * @description Returns the task's primary model or the previously chosen model.
 */
export function pickLatestModel(
  currentModel: string | null | undefined,
  task: StoredTask,
): string | null {
  const taskModel = pickPrimaryModel(normalizeUsageByModel(task.usageByModel));
  return taskModel || currentModel || null;
}

/**
 * @description URL-safe slug from a freeform string.
 */
export function slugifyCompat(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
