/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1 gateway wiring: provider decorator that
 *                                       runs the governance gate before delegating, applies
 *                                       cost-aware model downshift, denies on budget/quota,
 *                                       and records actual usage post-call. Mirrors the
 *                                       TokenCapturingProvider decorator idiom.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  LLMService,
  type SendRequestOptions,
  type LLMResponse,
  type TokenUsage,
  type CostResult,
} from './llm-service';
import {
  gateLlmCall,
  recordGateUsage,
  estimateProjectedCostUsd,
  estimateInputTokensFromText,
} from '../governance/gate';
import type { BudgetScope } from '../governance/budget-service';

const logger = createChildLogger({ module: 'governed-provider' });

/**
 * @description Derive the budget/quota (scope, key) for a request. Prefer the
 * end-user (owner_sub) so per-user caps apply; fall back to the bot/agent, then
 * a deployment-wide global bucket. Cheap, deterministic, no I/O.
 */
function deriveScope(options: SendRequestOptions): { scope: BudgetScope; key: string } {
  if (options.userSub) return { scope: 'owner_sub', key: options.userSub };
  if (options.agentId) return { scope: 'bot', key: options.agentId };
  return { scope: 'global', key: 'global' };
}

/**
 * @description Decorator around any {@link LLMService} that enforces the model
 * gateway (budget caps, quotas, cost-aware downshift) on the way in and records
 * actual token usage against the shared quota window on the way out.
 *
 * Off by default: when `OSHAL_LLM_BUDGETS` is unset the gate short-circuits to
 * "allowed, model unchanged" before any service is constructed or the DB is
 * touched, so wrapping a provider is a no-op until enforcement is enabled.
 *
 * Applied once at the composition root (createProviderResolver) so every
 * in-process dispatch path (PM bot, chat orchestration) is covered without
 * per-call-site wiring.
 */
export class GovernedProvider extends LLMService {
  private readonly delegate: LLMService;
  private readonly pool: Pool | null;

  constructor(delegate: LLMService, pool: Pool | null = null) {
    super(delegate.getProviderName(), {});
    this.delegate = delegate;
    this.pool = pool;
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    const { scope, key } = deriveScope(options);
    const requestedModel = options.model ?? '';

    const inputTokens = estimateInputTokensFromText([
      options.systemPrompt,
      ...options.messages.map((m) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ),
    ]);
    const projectedCostUsd = estimateProjectedCostUsd({
      providerId: options.providerId ?? this.getProviderName(),
      modelId: requestedModel,
      inputTokens,
      outputTokens: options.maxTokens ?? 1024,
    });

    const decision = await gateLlmCall(
      { requestedModel, scope, key, projectedCostUsd },
      this.pool,
    );

    if (!decision.allowed) {
      logger.info({ scope, key, reason: decision.reason }, 'LLM call denied by governance gate');
      throw new Error(`LLM call denied by governance gate (${decision.reason})`);
    }

    // Apply a cost-aware downshift only when the gate actually changed the model
    // (never overwrite with an empty requestedModel on the off-path).
    const effectiveOptions =
      decision.downshiftedFrom && decision.model && decision.model !== requestedModel
        ? { ...options, model: decision.model }
        : options;

    if (effectiveOptions !== options) {
      logger.info(
        { scope, key, from: decision.downshiftedFrom, to: decision.model },
        'Governance gate downshifted model',
      );
    }

    const response = await this.delegate.sendRequest(effectiveOptions);

    // Record ACTUAL usage against the shared quota window (single consumption
    // point for this path). No-op cost-wise when enforcement is off.
    const totalTokens =
      (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);
    recordGateUsage(scope, key, totalTokens);

    return response;
  }

  override calculateCost(usage: TokenUsage): CostResult {
    return this.delegate.calculateCost(usage);
  }

  override getProviderName(): string {
    return this.delegate.getProviderName();
  }
}
