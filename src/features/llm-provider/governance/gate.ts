/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1 gateway wiring: process-wide shared
 *                                       governance gate (shared Quota/Budget singletons),
 *                                       projected-cost estimator, post-call usage recorder.
 */

import type { Pool } from 'pg';
import {
  governLlmCall,
  type GovernLlmCallInput,
  type GovernLlmCallResult,
} from './index';
import { QuotaService } from './quota-service';
import { BudgetService, type BudgetScope } from './budget-service';
import { resolveUsageCost } from '../services/usage-cost-resolver';
import type { CostResult, TokenUsage } from '../services/llm-service';

/**
 * @description Why a shared gate exists.
 *
 * `governLlmCall` default-constructs a fresh {@link QuotaService} on every call
 * (see governance/index.ts), which resets the sliding window each time and makes
 * request/token quotas un-enforceable. The sliding window is in-memory per
 * process, so the ONLY way it accumulates is if every dispatch site reuses the
 * SAME instance. This module owns that per-process instance and injects it into
 * `governLlmCall`, and exposes {@link recordGateUsage} so call sites record
 * actual consumption against the same window after the response returns.
 *
 * Budget reads are read-only (DB spend), so the {@link BudgetService} is also
 * shared to reuse its small spend cache.
 *
 * Off by default: when `OSHAL_LLM_BUDGETS` is unset, `governLlmCall`
 * short-circuits before touching these services (allowed, model unchanged).
 */

let sharedQuota: QuotaService | null = null;
let sharedBudget: BudgetService | null = null;
let sharedBudgetPool: Pool | null = null;

function quota(): QuotaService {
  if (!sharedQuota) sharedQuota = new QuotaService();
  return sharedQuota;
}

function budget(pool: Pool | null): BudgetService {
  // Rebuild if a real pool arrives after a null bootstrap (the budget service
  // binds its read-only cost reader to a single pool at construction).
  if (!sharedBudget || (pool && pool !== sharedBudgetPool)) {
    sharedBudget = new BudgetService(pool);
    sharedBudgetPool = pool;
  }
  return sharedBudget;
}

/**
 * @description Process-wide governance gate. Call immediately before resolving
 * the runtime model/provider for an LLM request. Returns the (possibly
 * downshifted) model plus an allow/deny decision.
 *
 * @param input - {@link GovernLlmCallInput} (requestedModel, scope, key, projectedCostUsd).
 * @param pool  - Postgres pool for read-only spend reads (null = no DB, fails open).
 */
export async function gateLlmCall(
  input: GovernLlmCallInput,
  pool: Pool | null = null,
): Promise<GovernLlmCallResult> {
  return governLlmCall(input, {
    pool,
    quotaService: quota(),
    budgetService: budget(pool),
  });
}

/**
 * @description Record actual consumption against the shared quota window AFTER a
 * call completes. No-op (cost-wise) when enforcement is off. Call exactly once
 * per LLM call, with the real token total from the provider response.
 */
export function recordGateUsage(scope: BudgetScope, key: string, tokens: number): void {
  quota().recordUsage({ scope, key, tokens, requests: 1 });
}

const ZERO_COST: CostResult = { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };

/**
 * @description Estimate the USD cost of a call BEFORE making it, so the budget
 * gate can pre-emptively deny/downshift. Reuses the single pricing source of
 * truth ({@link resolveUsageCost}). Returns 0 when pricing is unknown — the
 * budget gate still enforces on already-spent vs cap, just not pre-emptively.
 */
export function estimateProjectedCostUsd(args: {
  providerId?: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const usage: TokenUsage = { inputTokens: args.inputTokens, outputTokens: args.outputTokens };
  const resolved = resolveUsageCost({
    providerCost: ZERO_COST,
    usage,
    providerId: args.providerId,
    modelId: args.modelId,
  });
  return resolved.totalCost;
}

/**
 * @description Rough input-token estimate from message + system prompt text
 * (~4 chars/token). Used only to size the projected-cost estimate; the actual
 * token count from the provider response is what gets recorded post-call.
 */
export function estimateInputTokensFromText(parts: Array<string | undefined>): number {
  let chars = 0;
  for (const p of parts) chars += p ? p.length : 0;
  return Math.ceil(chars / 4);
}
