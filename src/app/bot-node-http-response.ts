/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve authoritative provider-config source, reconciliation action, and version in the controller-facing bot-node response.
 */

import type { EnvelopeExecutionResult } from '@/features/swarm-orchestration';

export interface BotNodeHttpResponseOptions {
  durationMs: number;
  taskId: string;
  defaultModel: string;
  defaultProvider: string;
}

/**
 * Builds the controller-facing BotNodeResponse without flattening away structured
 * provider evidence captured by the trusted bot runtime.
 */
export function buildBotNodeHttpResponse(
  result: EnvelopeExecutionResult,
  options: BotNodeHttpResponseOptions,
): Record<string, unknown> {
  const output = (result.output ?? {}) as Record<string, unknown>;
  const usage = (output.usage ?? {}) as Record<string, number>;
  const providerConfigSource = output.providerConfigSource === 'authoritative-dispatch'
    || output.providerConfigSource === 'runtime-default'
    || output.providerConfigSource === 'byo-request'
    || output.providerConfigSource === 'deterministic-intent'
    ? output.providerConfigSource
    : undefined;
  const providerConfigAction = output.providerConfigAction === 'absent'
    || output.providerConfigAction === 'match'
    || output.providerConfigAction === 'corrected'
    ? output.providerConfigAction
    : undefined;
  const rawConfigVersion = output.providerConfigVersion;
  const hasConfigVersion = rawConfigVersion === null
    || (typeof rawConfigVersion === 'number' && Number.isFinite(rawConfigVersion));
  return {
    success: result.success,
    response: typeof output.response === 'string' ? output.response : '',
    usage: {
      inputTokens: Number(usage.inputTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
      totalTokens: Number(usage.totalTokens || 0),
      cacheReadTokens: Number(usage.cacheReadTokens || 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens || 0),
    },
    cost: Number((output.cost as number) || 0),
    model: normalizeRuntimeIdentity(output.model, 256) ?? options.defaultModel,
    provider: normalizeRuntimeIdentity(output.provider, 128) ?? options.defaultProvider,
    providerRecords: Array.isArray(output.providerRecords)
      ? output.providerRecords.filter((record) => record && typeof record === 'object').slice(0, 8)
      : [],
    durationMs: options.durationMs,
    taskId: options.taskId,
    error: result.error,
    ...(providerConfigSource ? { providerConfigSource } : {}),
    ...(providerConfigAction ? { providerConfigAction } : {}),
    ...(hasConfigVersion ? { providerConfigVersion: rawConfigVersion } : {}),
  };
}

function normalizeRuntimeIdentity(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}
