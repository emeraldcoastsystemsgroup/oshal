/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added shared usage-cost resolver so task and swarm telemetry can estimate cost from model pricing when providers return $0 despite reporting token usage
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add gpt-4.5 to Codex fallback pricing; add Claude family substring match so claude-sonnet-4-5-20250929 etc. resolve to pricing without exact-key maintenance
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Canonicalize harness provider ids (harness:codex-cli, cline-cli, harness:claude-code-cli) to their underlying service before fallback pricing lookup so gpt-5.3-codex and claude-sonnet variants resolve to cost instead of $0.
 */

import type { CostResult, TokenUsage } from './llm-service';
import type { ModelPricing } from './provider-registry';
import { ProviderRegistry } from './provider-registry';

const providerRegistry = new ProviderRegistry();

const CLAUDE_CODE_FALLBACK_PRICING: Record<string, ModelPricing> = {
  sonnet: { inputPerMillion: 3, outputPerMillion: 15 },
  opus: { inputPerMillion: 15, outputPerMillion: 75 },
  haiku: { inputPerMillion: 1, outputPerMillion: 5 },
};

const CODEX_FALLBACK_PRICING: Record<string, ModelPricing> = {
  'gpt-5.4': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-5.3-codex': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-5.2-codex': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-5.1-codex-max': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-5.1-codex-mini': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-5.2': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-5.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-5': { inputPerMillion: 2, outputPerMillion: 8 },
  // GPT-4.5 (preview pricing estimate)
  'gpt-4.5': { inputPerMillion: 75, outputPerMillion: 150 },
  'gpt-4.5-preview': { inputPerMillion: 75, outputPerMillion: 150 },
};

/**
 * @description Cost result enriched with provenance so callers (telemetry) can
 * distinguish provider-reported actual cost from estimated cost and know which
 * pricing source produced it.
 */
export interface ResolvedUsageCost extends CostResult {
  estimated: boolean;
  costMode: 'actual' | 'estimated' | 'unknown';
  pricingSource: 'provider' | 'provider-registry' | 'fallback-map' | 'none';
}

/**
 * @description Input bundle for {@link resolveUsageCost}: the provider-reported
 * cost plus the token usage and provider/model identifiers needed to look up
 * fallback pricing when the reported cost is zero.
 */
export interface UsageCostResolverInput {
  providerCost: CostResult;
  usage: TokenUsage;
  providerId?: string;
  modelId?: string;
}

/**
 * @description Resolve request cost, preferring provider-reported cost and
 * falling back to model pricing estimates when tokens are present but cost is $0.
 */
export function resolveUsageCost(input: UsageCostResolverInput): ResolvedUsageCost {
  const providerCost = normalizeCost(input.providerCost);
  const inputTokens = normalizeCount(input.usage.inputTokens);
  const outputTokens = normalizeCount(input.usage.outputTokens);

  if (providerCost.totalCost > 0 || (inputTokens === 0 && outputTokens === 0)) {
    return {
      ...providerCost,
      estimated: false,
      costMode: providerCost.totalCost > 0 ? 'actual' : 'unknown',
      pricingSource: providerCost.totalCost > 0 ? 'provider' : 'none',
    };
  }

  const providerId = normalizeKey(input.providerId);
  const modelId = normalizeKey(input.modelId);
  const pricing = findPricing(providerId, modelId);
  if (!pricing) {
    return {
      ...providerCost,
      estimated: false,
      costMode: 'unknown',
      pricingSource: 'none',
    };
  }

  const estimatedCost = calculateCostFromPricing(input.usage, pricing.pricing);
  return {
    ...estimatedCost,
    estimated: true,
    costMode: 'estimated',
    pricingSource: pricing.source,
  };
}

function findPricing(
  providerId: string,
  modelId: string,
): { pricing: ModelPricing; source: 'provider-registry' | 'fallback-map' } | null {
  const providerPricing = findProviderRegistryPricing(providerId, modelId);
  if (providerPricing) {
    return { pricing: providerPricing, source: 'provider-registry' };
  }

  const fallbackPricing = findFallbackPricing(providerId, modelId);
  if (fallbackPricing) {
    return { pricing: fallbackPricing, source: 'fallback-map' };
  }

  const globalPricing = findAnyProviderPricing(modelId);
  if (globalPricing) {
    return { pricing: globalPricing, source: 'provider-registry' };
  }

  return null;
}

function findProviderRegistryPricing(providerId: string, modelId: string): ModelPricing | null {
  if (!providerId || !modelId) {
    return null;
  }
  const provider = providerRegistry.get(providerId);
  const model = provider?.models.find((entry) => normalizeKey(entry.id) === modelId);
  if (!model) {
    return null;
  }
  return hasPaidPricing(model.pricing) ? model.pricing : null;
}

function findAnyProviderPricing(modelId: string): ModelPricing | null {
  if (!modelId) {
    return null;
  }
  for (const provider of providerRegistry.getAll()) {
    const model = provider.models.find((entry) => normalizeKey(entry.id) === modelId);
    if (model && hasPaidPricing(model.pricing)) {
      return model.pricing;
    }
  }
  return null;
}

function findFallbackPricing(providerId: string, modelId: string): ModelPricing | null {
  if (!modelId) {
    return null;
  }

  // Canonicalize harness-bridge provider ids to the underlying service so fallback lookup
  // still works when the caller passes e.g. `harness:codex-cli` instead of `openai-codex`.
  const canonical = canonicalizeProviderId(providerId);

  if (canonical === 'claude-code') {
    return CLAUDE_CODE_FALLBACK_PRICING[modelId]
      || CODEX_FALLBACK_PRICING[modelId]
      || findClaudeFamilyPricing(modelId)
      || null;
  }

  if (canonical === 'openai-codex') {
    return CODEX_FALLBACK_PRICING[modelId] || null;
  }

  // Last-resort model-name-only match so we never strand a cost when the model is known
  // (e.g. a new harness surface that hasn't been mapped here yet).
  return CODEX_FALLBACK_PRICING[modelId]
    || CLAUDE_CODE_FALLBACK_PRICING[modelId]
    || findClaudeFamilyPricing(modelId)
    || null;
}

/**
 * @description Maps harness / bridge provider ids to the underlying pricing bucket.
 * @param providerId - Raw provider id from {@link LLMService.getProviderName()}.
 * @returns Canonical pricing key: 'openai-codex', 'claude-code', or the raw id.
 */
function canonicalizeProviderId(providerId: string): string {
  if (!providerId) return providerId;
  // harness: prefix is used by HarnessLLMBridge (e.g. 'harness:codex-cli', 'harness:claude-code-cli')
  const stripped = providerId.startsWith('harness:') ? providerId.slice('harness:'.length) : providerId;
  if (stripped === 'codex-cli' || stripped === 'cline-cli' || stripped === 'openai-codex' || stripped === 'openai') return 'openai-codex';
  if (stripped === 'claude-code-cli' || stripped === 'claude-code' || stripped === 'anthropic') return 'claude-code';
  return stripped;
}

/**
 * @description Matches a full Claude model ID (e.g. claude-sonnet-4-5-20250929) to
 * its family pricing tier by substring. Avoids maintaining an exhaustive version list.
 */
function findClaudeFamilyPricing(modelId: string): ModelPricing | null {
  if (modelId.includes('opus')) return CLAUDE_CODE_FALLBACK_PRICING['opus'] ?? null;
  if (modelId.includes('sonnet')) return CLAUDE_CODE_FALLBACK_PRICING['sonnet'] ?? null;
  if (modelId.includes('haiku')) return CLAUDE_CODE_FALLBACK_PRICING['haiku'] ?? null;
  return null;
}

function calculateCostFromPricing(usage: TokenUsage, pricing: ModelPricing): CostResult {
  const inputTokens = normalizeCount(usage.inputTokens);
  const outputTokens = normalizeCount(usage.outputTokens);
  const inputCost = inputTokens * (pricing.inputPerMillion / 1_000_000);
  const outputCost = outputTokens * (pricing.outputPerMillion / 1_000_000);
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: 'USD',
  };
}

function hasPaidPricing(pricing: ModelPricing): boolean {
  return normalizeAmount(pricing.inputPerMillion) > 0 || normalizeAmount(pricing.outputPerMillion) > 0;
}

function normalizeCost(cost: CostResult): CostResult {
  return {
    inputCost: normalizeAmount(cost.inputCost),
    outputCost: normalizeAmount(cost.outputCost),
    totalCost: normalizeAmount(cost.totalCost),
    currency: typeof cost.currency === 'string' && cost.currency.trim().length > 0 ? cost.currency.trim() : 'USD',
  };
}

function normalizeCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeAmount(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
