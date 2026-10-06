/**
 * Cost-governance services barrel.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial services barrel for the cost-governance slice.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export readEventCooldownMin (audit/notification anti-flood knob) + upsertBudgetSqlFor (operator-lock upsert) from the review fixes.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Re-export the ops-rails read types (BudgetEventRecord/BudgetStateRow/BudgetGovernanceState) for the operator GET /api/budgets/state surface.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export RemoveBudgetInput / RemoveBudgetResult (ADR-174 Amendment B, step B5-5).
 *
 * @module features/cost-governance/services
 */
export {
  BudgetService,
  readRunawayConfig,
  readEventCooldownMin,
  spendSqlFor,
  spendByProviderSqlFor,
  upsertBudgetSqlFor,
  BUDGET_SCOPE_TYPES,
  type BudgetScopeType,
  type BudgetRecord,
  type BudgetCaller,
  type SetBudgetInput,
  type SetBudgetResult,
  type RemoveBudgetInput,
  type RemoveBudgetResult,
  RemovedBudget,
  type BudgetDecision,
  type BudgetServiceOptions,
  type BudgetEventRecord,
  type BudgetStateRow,
  type BudgetGovernanceState,
} from './budget-service';
export {
  classifyCostUnit,
  splitSpendByUnit,
  COST_UNIT_LABELS,
  type CostUnit,
  type SpendByUnit,
} from './cost-unit';
