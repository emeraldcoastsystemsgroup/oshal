# ADR-104: Cost governance — spend budgets + runaway kill switch

**Status:** Accepted (2026-07-16) — BUILT + DEPLOYED in the 2026-07-15/16 gap-list build.
Feature slice `src/features/cost-governance`, routes `/api/budgets`, migration `078-cost-governance.sql`
(`oshal_budgets`, `oshal_budget_events`). As-built: [platform-shared-services.md](../architecture/platform-shared-services.md).

## Context

`chat_tasks` / `oshal_cost_events` already *capture* per-LLM-call cost, but nothing *enforced* a
ceiling. Two real failure modes were unguarded:

- **Unbounded spend.** A user (or an app) could run up arbitrary LLM cost with no cap. This is the
  governance half that Token Chase (measure → optimize) never closed — you could prove a cheaper
  path but not *stop* an expensive one.
- **Runaway loops.** The stale-browser-tab loop-ticket hack (`REJECT_LOOP_TICKETS`) and the
  "build phase auto-escalates" bug both showed dispatch loops can mint work indefinitely. A cost
  ceiling is the backstop when a loop guard misses.

Constraints that shaped it: enforcement must **never brick dispatch on an infra gap** (a missing
table or a down DB must fail *open*, not take the swarm offline), spend math must **agree with the
cockpit cost rollups** (same joins, not a parallel estimate), and it must be **inert until an
operator sets caps** (no surprise blocking on first boot). It is deliberately distinct from the
older env-only `BudgetService` in `src/features/llm-provider/governance` (055, off-by-default).

## Decision

1. **DB-backed caps per scope.** `oshal_budgets` holds a daily USD cap per `user` / `app` (=
   `ticketType`, ADR-038) / `ticket` scope. A non-operator sets only their own `user` scope;
   operator (`OSHAL_OPERATOR_SUBS`/`_EMAILS`) sets any.
2. **Enforced at the two chokepoints.** `BudgetService.checkBudget` runs pre-dispatch in the queue
   manager and on the interactive `executeBotOrInline` path. Spend sums the same ledger joins the
   cost rollups use, so budget numbers and cockpit numbers agree.
3. **Fail-open on infra gap, fail-closed on a definite breach.** Missing table / DB down /
   unreadable spend → WARN + allow (never brick dispatch). A HARD cap or the runaway threshold
   definitively exceeded → block + one `oshal_budget_events` audit row + operator notification.
   Soft caps only set `softWarn`.
4. **Runaway kill switch.** `countRecentExecutions(ticketId, window)` trips at
   `OSHAL_BUDGET_RUNAWAY_MAX` (25) executions in `OSHAL_BUDGET_RUNAWAY_WINDOW_MIN` (30) — targeting
   *dispatch loops* (a task row per execution), not a single chatty task.

## Consequences

- **No budget rows = no enforcement.** Ships safe/inert; the operator must set real caps for it to
  bite (tracked as an operator follow-up).
- A hard breach writes one audit row + notification **per check while breached** (per poll cycle per
  blocked ticket); `OSHAL_BUDGET_EVENT_COOLDOWN_MIN` dedupes. If still noisy, widen later.
- Two `BudgetService` classes now exist in different slices (this one and the 055 env-only one) —
  alias on import if ever both are needed in one file.
- Cost governance is now the enforcement peer to Token Chase's measurement: capture → optimize →
  **govern**.
