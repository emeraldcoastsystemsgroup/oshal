/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | NEW: governance facade composing budget + quota + cost-aware routing into a single off-by-default pre-dispatch hook (governLlmCall).
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Update docs/ paths after docs directory consolidation
 */

/**
 * @description
 * Single entry point a maintainer calls BEFORE dispatching an LLM request.
 * Composes {@link BudgetService.checkBudget}, {@link QuotaService.checkQuota},
 * and {@link selectModel} into one decision.
 *
 * ADDITIVE and OFF BY DEFAULT: when `OSHAL_LLM_BUDGETS` is off (the default),
 * this returns `{ allowed: true, model: requestedModel, downshiftedFrom: null }`
 * with no DB access and no behavior change. A maintainer wires `governLlmCall`
 * into the dispatch path (see docs/architecture/model-gateway.md) and opts in via env.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  BudgetService,
  readBudgetConfig,
  type BudgetScope,
  type BudgetCheckResult,
} from './budget-service';
import {
  QuotaService,
  readQuotaConfig,
  type QuotaCheckResult,
} from './quota-service';
import { selectModel, readRoutingConfig, type SelectModelResult } from './fallback-routing';

const logger = createChildLogger({ module: 'llm-governance' });

export * from './budget-service';
export * from './quota-service';
export * from './fallback-routing';

/** @description Input for the composed governance decision. */
export interface GovernLlmCallInput {
  requestedModel: string;
  scope: BudgetScope;
  key: string;
  /** Estimated USD cost of the call about to be made (>= 0). */
  projectedCostUsd?: number;
  /** Free-form task difficulty hint, forwarded to routing. */
  taskHint?: string;
}

/** @description Composed governance decision. */
export interface GovernLlmCallResult {
  allowed: boolean;
  model: string;
  downshiftedFrom: string | null;
  reason: string;
  /** Sub-decisions, present when enforcement is engaged (useful for audit). */
  budget?: BudgetCheckResult;
  quota?: QuotaCheckResult;
  routing?: SelectModelResult;
}

/**
 * @description Returns whether ANY governance enforcement is engaged. When all
 * three sub-configs are off, the facade short-circuits to the current behavior
 * without constructing services or touching the DB.
 */
function anyEnforcementOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBudgetConfig(env).enabled
    || readQuotaConfig(env).enabled
    || readRoutingConfig(env).enabled;
}

/**
 * @description Governance facade. Call this immediately before resolving the
 * runtime model/provider for an LLM request.
 *
 * Decision order:
 *  1. Quota  — deny when the (scope,key) window quota is exhausted.
 *  2. Budget — deny when the projected spend would exceed the scope cap UNLESS
 *              cost-aware routing can downshift to a cheaper model that fits.
 *  3. Routing — downshift the model under budget pressure / policy.
 *
 * @param input - {@link GovernLlmCallInput}.
 * @param deps  - Optional injected services/pool (tests + DI). When omitted,
 *   module-default services are constructed lazily from env.
 * @returns {@link GovernLlmCallResult}.
 */
export async function governLlmCall(
  input: GovernLlmCallInput,
  deps: {
    pool?: Pool | null;
    budgetService?: BudgetService;
    quotaService?: QuotaService;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<GovernLlmCallResult> {
  const env = deps.env ?? process.env;

  // ── Off path: provably current behavior (allowed, model unchanged) ────────
  if (!anyEnforcementOn(env)) {
    return {
      allowed: true,
      model: input.requestedModel,
      downshiftedFrom: null,
      reason: 'enforcement-off',
    };
  }

  const budgetService = deps.budgetService ?? new BudgetService(deps.pool ?? null);
  const quotaService = deps.quotaService ?? new QuotaService();
  const projectedCostUsd = Number.isFinite(input.projectedCostUsd) && (input.projectedCostUsd ?? 0) > 0
    ? (input.projectedCostUsd as number)
    : 0;

  // 1) Quota gate (hard deny — quotas are not satisfiable by downshifting).
  const quota = quotaService.checkQuota({ scope: input.scope, key: input.key });
  if (!quota.allowed) {
    logger.info({ scope: input.scope, key: input.key, reason: quota.reason }, 'governLlmCall: denied by quota');
    return {
      allowed: false,
      model: input.requestedModel,
      downshiftedFrom: null,
      reason: `quota:${quota.reason}`,
      quota,
    };
  }

  // 2) Budget check at the requested model.
  const budget = await budgetService.checkBudget({
    scope: input.scope,
    key: input.key,
    projectedCostUsd,
  });

  // Compute budget pressure (spent / cap) to drive 'auto' routing.
  const budgetPressure = budget.capUsd && budget.capUsd > 0 && typeof budget.spentUsd === 'number'
    ? budget.spentUsd / budget.capUsd
    : undefined;

  // 3) Cost-aware routing — may downshift to a cheaper model under pressure.
  //    Thread the RESOLVED env into routing config so an injected env (tests, DI)
  //    is honored; selectModel otherwise reads the process-global env, which
  //    diverges from `env` whenever a caller passes deps.env.
  const routing = selectModel({
    requestedModel: input.requestedModel,
    scope: input.scope,
    key: input.key,
    taskHint: input.taskHint,
    budgetPressure,
    config: readRoutingConfig(env),
  });

  // If the budget allows the requested model, proceed (possibly with a
  // policy/pressure downshift that only saves money).
  if (budget.allowed) {
    return {
      allowed: true,
      model: routing.model,
      downshiftedFrom: routing.downshiftedFrom,
      reason: routing.downshiftedFrom ? `routing:${routing.reason}` : 'within-budget',
      budget,
      quota,
      routing,
    };
  }

  // Budget would be exceeded at the requested model. Prefer a downshift over a
  // hard denial when routing produced a cheaper model — surface the cheaper
  // model and allow, leaving the spend cap to catch persistent overruns at the
  // cheaper tier. If no cheaper model exists, deny.
  if (routing.downshiftedFrom) {
    logger.info(
      { scope: input.scope, key: input.key, from: routing.downshiftedFrom, to: routing.model },
      'governLlmCall: over budget at requested model — downshifting to cheaper model instead of denying',
    );
    return {
      allowed: true,
      model: routing.model,
      downshiftedFrom: routing.downshiftedFrom,
      reason: 'over-budget-downshifted',
      budget,
      quota,
      routing,
    };
  }

  logger.info({ scope: input.scope, key: input.key }, 'governLlmCall: denied by budget (no cheaper model available)');
  return {
    allowed: false,
    model: input.requestedModel,
    downshiftedFrom: null,
    reason: `budget:${budget.reason}`,
    budget,
    quota,
    routing,
  };
}
