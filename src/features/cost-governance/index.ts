/**
 * Cost-governance feature barrel — DB-backed spend budgets + the runaway-loop kill switch.
 *
 * chat_tasks records per-LLM-call cost (recordCost) but nothing enforced a ceiling. This
 * slice owns the enforcement layer: oshal_budgets caps per user/app/ticket scope, checked
 * pre-dispatch via `BudgetService.checkBudget`, audited in oshal_budget_events, surfaced
 * over /api/budgets. Fail-open on infra gaps; fail-closed only on a definitive HARD breach.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel for the cost-governance slice (spend budgets + runaway kill switch).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-export readEventCooldownMin + upsertBudgetSqlFor from the review fixes.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Re-export the ops-rails read types (BudgetEventRecord/BudgetStateRow/BudgetGovernanceState) for the operator GET /api/budgets/state surface.
 *
 * @module features/cost-governance
 */
export {
  BudgetService,
  readRunawayConfig,
  readEventCooldownMin,
  spendSqlFor,
  upsertBudgetSqlFor,
  BUDGET_SCOPE_TYPES,
  type BudgetScopeType,
  type BudgetRecord,
  type BudgetCaller,
  type SetBudgetInput,
  type SetBudgetResult,
  type BudgetDecision,
  type BudgetServiceOptions,
  type BudgetEventRecord,
  type BudgetStateRow,
  type BudgetGovernanceState,
} from './services';
