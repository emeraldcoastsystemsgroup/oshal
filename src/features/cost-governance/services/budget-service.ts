/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial cost-governance BudgetService — DB-backed daily USD spend caps per user/app/ticket scope (oshal_budgets) enforced pre-dispatch, plus a runaway-loop kill switch (countRecentExecutions over ticket_task_links). Fail-OPEN on infra gaps (missing table / DB down never bricks dispatch); fail-CLOSED with an oshal_budget_events audit row + operator notification when a HARD cap is definitively exceeded. Soft caps warn only. Distinct from the env-var llm-provider governance BudgetService (055): this one is operator/user-editable at runtime via /api/budgets.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes (gap-list build): (1) operator-set caps are now tamper-proof — setBudget writes set_by_operator, and a non-operator's self-scope upsert is conditional on set_by_operator=FALSE, so a capped user can no longer raise/disable an operator-imposed hard cap on themselves. (2) Windowed spend now sums the per-event oshal_cost_events ledger instead of chat_tasks rows filtered by updated_at — the old read attributed a task's LIFETIME total_cost to "today" whenever any event touched the row inside the window (blocking on phantom spend) and dropped stale-but-real per-ticket spend. (3) recordEvent dedupes: one audit row + one operator notification per (scope, action) per OSHAL_BUDGET_EVENT_COOLDOWN_MIN (default 30) — a sustained breach re-checked every poll cycle no longer floods oshal_budget_events or spams notification transports.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Ops-rails read surface: listRecentEvents() reads the oshal_budget_events enforcement trail newest-first (bounded limit), and getBudgetState() composes the operator governance snapshot — every cap with its trailing-window spend attached + the recent enforcement events — for the operator-only GET /api/budgets/state read rail. Both are read-only and fail-open (empty list on any infra gap, logged WARN), never mutate, and never enforce.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { notifyOperator } from '@/features/notifications';

const logger = createChildLogger({ module: 'cost-governance-budget-service' });

/**
 * @description Budget scope dimensions. scope_key semantics:
 *  - 'user'   : the end-user's OIDC sub (spend read from chat_tasks.owner_sub).
 *  - 'app'    : the app's manifest ticketType (spend joined via ticket_task_links -> tickets.ticket_type).
 *  - 'ticket' : a single tickets.ticket_id (spend joined via ticket_task_links).
 */
export type BudgetScopeType = 'user' | 'app' | 'ticket';

/** @description The three scope types, exported so routes validate input against the same source of truth. */
export const BUDGET_SCOPE_TYPES: readonly BudgetScopeType[] = ['user', 'app', 'ticket'] as const;

/**
 * @description One budget row from oshal_budgets, camel-cased for callers.
 */
export interface BudgetRecord {
  id: number;
  scopeType: BudgetScopeType;
  scopeKey: string;
  dailyUsd: number;
  hard: boolean;
  enabled: boolean;
  /** TRUE when an operator wrote the row — the scoped user can see it but cannot modify it. */
  setByOperator: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * @description Who is asking. Routes derive this from the validated OIDC session
 * (getCaller + isOperator) — the service never trusts a body-supplied identity.
 */
export interface BudgetCaller {
  sub: string | null;
  operator: boolean;
}

/**
 * @description Input for creating/updating a budget (upsert on scope_type+scope_key).
 */
export interface SetBudgetInput {
  scopeType: BudgetScopeType;
  scopeKey: string;
  dailyUsd: number;
  hard: boolean;
  enabled: boolean;
}

/**
 * @description Result of setBudget. Result-object (not throw) so route handlers map
 * authorization/infra outcomes to HTTP statuses without exception control flow.
 */
export type SetBudgetResult =
  | { ok: true; budget: BudgetRecord }
  | { ok: false; error: 'forbidden' | 'unavailable' };

/**
 * @description The pre-dispatch verdict.
 *  - allowed  : false ONLY when a HARD cap (or the runaway kill switch) definitively tripped.
 *  - softWarn : true when a soft cap is exceeded — caller may surface it but must proceed.
 *  - reason   : machine-readable decision code for logs/UX.
 *  - spend/cap: the numbers behind the tripping (or nearest) budget, when known.
 */
export interface BudgetDecision {
  allowed: boolean;
  softWarn: boolean;
  reason:
    | 'no-budgets'
    | 'within-cap'
    | 'soft-cap-exceeded'
    | 'hard-cap-exceeded'
    | 'runaway-halt'
    | 'budgets-unavailable';
  spend?: number;
  cap?: number;
  scopeType?: BudgetScopeType;
  scopeKey?: string;
}

/**
 * @description One append-only enforcement/audit row from oshal_budget_events, camel-cased —
 * the WHY behind a refused/halted dispatch that the operator read rail surfaces. Never carries
 * secrets: `detail` holds reason codes + ids only (the migration's own contract).
 */
export interface BudgetEventRecord {
  id: number;
  scopeType: string;
  scopeKey: string;
  spendUsd: number;
  capUsd: number;
  action: string;
  detail: Record<string, unknown> | null;
  ts: string;
}

/**
 * @description A budget cap with its trailing-window spend attached — the row shape of the
 * operator governance snapshot. `spendUsd` is null when spend could not be read (fail-open).
 */
export interface BudgetStateRow extends BudgetRecord {
  spendUsd: number | null;
}

/**
 * @description The read-only operator governance snapshot: every cap (with spend) plus the
 * recent enforcement events. Returned by getBudgetState for GET /api/budgets/state.
 */
export interface BudgetGovernanceState {
  budgets: BudgetStateRow[];
  events: BudgetEventRecord[];
  windowHours: number;
}

/**
 * @description Runaway-detector knobs, resolved from env at check time so operators can
 * retune without a restart. Defaults: 25 executions in 30 minutes halts a ticket.
 * @param env - Environment bag (injectable for tests).
 * @returns The resolved max executions + window minutes.
 */
export function readRunawayConfig(env: NodeJS.ProcessEnv = process.env): { max: number; windowMin: number } {
  return {
    max: parsePositiveInt(env.OSHAL_BUDGET_RUNAWAY_MAX, 25),
    windowMin: parsePositiveInt(env.OSHAL_BUDGET_RUNAWAY_WINDOW_MIN, 30),
  };
}

/**
 * @description Anti-flood cooldown for enforcement audit rows + operator notifications.
 * A blocked ticket is deliberately re-checked every poll cycle (it stays approved), so
 * without a cooldown a sustained hard breach would append an oshal_budget_events row and
 * fire a notification every ~60s until the spend window drains. One row + one alert per
 * (scope, action) per cooldown is the intended signal. Resolved at write time so operators
 * can retune without a restart.
 * @param env - Environment bag (injectable for tests).
 * @returns Cooldown in whole minutes (default 30).
 */
export function readEventCooldownMin(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.OSHAL_BUDGET_EVENT_COOLDOWN_MIN, 30);
}

/** @description Optional injection points (notification hook, env) — defaulted in production. */
export interface BudgetServiceOptions {
  /** Outbound alert hook; defaults to the pluggable notifications harness (no-op when unconfigured). */
  notify?: (text: string) => Promise<unknown>;
  /** Environment bag for the runaway knobs; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * @description DB-backed spend-budget governance. Reads chat_tasks (the canonical per-call
 * cost ledger recordCost writes) READ-ONLY for spend, oshal_budgets for caps, and appends
 * to oshal_budget_events on enforcement actions. Semantics: fail-OPEN when the budget
 * infrastructure is missing/unreachable (an infra gap must never brick dispatch);
 * fail-CLOSED only when a HARD cap is definitively exceeded on a successful read.
 */
export class BudgetService {
  private readonly pool: Pool | null;
  private readonly notify: (text: string) => Promise<unknown>;
  private readonly env: NodeJS.ProcessEnv;

  /**
   * @description Constructs the service.
   * @param pool - Postgres pool; pass null to run degraded (every check fails open with a WARN).
   * @param options - Optional notification hook + env bag overrides (tests).
   */
  constructor(pool: Pool | null = null, options: BudgetServiceOptions = {}) {
    this.pool = pool;
    this.notify = options.notify ?? ((text: string) => notifyOperator({ text }));
    this.env = options.env ?? process.env;
  }

  /**
   * @description Lists budgets visible to the caller. Operators see every row; a
   * non-operator sees ONLY their own 'user'-scope row (cross-user caps and app/ticket
   * caps are operator surface — they reveal other people's governance posture).
   * @param caller - Validated caller identity.
   * @returns Budget rows (empty on infra gap, logged WARN — listing must not 500 a cockpit).
   */
  async getBudgets(caller: BudgetCaller): Promise<BudgetRecord[]> {
    if (!this.pool) {
      logger.warn('getBudgets: no DB pool — returning empty list');
      return [];
    }
    try {
      const result = caller.operator
        ? await this.pool.query(`SELECT * FROM oshal_budgets ORDER BY scope_type, scope_key`)
        : await this.pool.query(
            `SELECT * FROM oshal_budgets WHERE scope_type = 'user' AND scope_key = $1`,
            [caller.sub ?? ''],
          );
      return result.rows.map(mapBudgetRow);
    } catch (err) {
      logger.warn({ err }, 'getBudgets: budgets table unreadable — returning empty list (fail-open)');
      return [];
    }
  }

  /**
   * @description Reads the append-only oshal_budget_events enforcement trail newest-first.
   * Operator-only surface (the caller — GET /api/budgets/state — is requiresOperator-gated),
   * so no per-user scoping is applied here. Fail-open: an empty list (logged WARN) on any
   * infra gap — a read rail must never 500 an operator cockpit.
   * @param limit - Max rows to return, clamped to 1..500 (default 50).
   * @returns Enforcement events newest-first (empty on no pool / query failure).
   */
  async listRecentEvents(limit = 50): Promise<BudgetEventRecord[]> {
    if (!this.pool) {
      logger.warn('listRecentEvents: no DB pool — returning empty events list');
      return [];
    }
    const capped = Math.min(500, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)));
    try {
      const result = await this.pool.query(
        `SELECT id, ts, scope_type, scope_key, spend_usd, cap_usd, action, detail
           FROM oshal_budget_events
          ORDER BY ts DESC
          LIMIT $1`,
        [capped],
      );
      return result.rows.map(mapBudgetEventRow);
    } catch (err) {
      logger.warn({ err }, 'listRecentEvents: oshal_budget_events unreadable — returning empty list (fail-open)');
      return [];
    }
  }

  /**
   * @description Composes the read-only operator governance snapshot: every budget cap with its
   * trailing-window spend attached, plus the recent enforcement events. Operator-only (the caller
   * route is requiresOperator-gated), so caps are read with operator scope. Fail-open throughout —
   * an unreadable spend attaches null rather than failing the whole read.
   * @param windowHours - Trailing spend window in whole hours (clamped 1..720, default 24).
   * @param eventLimit - Max enforcement events to include (clamped 1..500, default 50).
   * @returns The snapshot: caps+spend, recent events, and the resolved window.
   */
  async getBudgetState(windowHours = 24, eventLimit = 50): Promise<BudgetGovernanceState> {
    const hours = Math.min(720, Math.max(1, Math.floor(Number.isFinite(windowHours) ? windowHours : 24)));
    const caps = await this.getBudgets({ sub: null, operator: true });
    const budgets: BudgetStateRow[] = [];
    for (const cap of caps) {
      const spendUsd = await this.computeSpend(cap.scopeType, cap.scopeKey, hours);
      budgets.push({ ...cap, spendUsd });
    }
    const events = await this.listRecentEvents(eventLimit);
    return { budgets, events, windowHours: hours };
  }

  /**
   * @description Creates or updates a budget (upsert on scope_type+scope_key). An operator
   * may set any scope (the row is stamped set_by_operator=TRUE, taking ownership even of a
   * previously self-set cap); a non-operator may only set THEIR OWN 'user'-scope cap, and
   * ONLY while no operator owns that row — the self-service upsert is conditional on
   * set_by_operator=FALSE in the same statement, so a capped user can never raise, disable,
   * or overwrite an operator-imposed cap on themselves (no check-then-write race).
   * @param caller - Validated caller identity.
   * @param input - Scope + cap + flags.
   * @returns ok:true with the stored row, or ok:false with 'forbidden' | 'unavailable'.
   */
  async setBudget(caller: BudgetCaller, input: SetBudgetInput): Promise<SetBudgetResult> {
    const selfOnly = input.scopeType === 'user' && caller.sub !== null && input.scopeKey === caller.sub;
    if (!caller.operator && !selfOnly) {
      logger.warn(
        { sub: caller.sub, scopeType: input.scopeType },
        'setBudget: non-operator attempted a cross-scope budget write — denied',
      );
      return { ok: false, error: 'forbidden' };
    }
    if (!this.pool) {
      logger.warn('setBudget: no DB pool — budget store unavailable');
      return { ok: false, error: 'unavailable' };
    }
    try {
      const result = await this.pool.query(
        upsertBudgetSqlFor(caller.operator),
        [input.scopeType, input.scopeKey, input.dailyUsd, input.hard, input.enabled],
      );
      if (result.rows.length === 0) {
        // The conditional self-service update matched an operator-owned row and touched nothing.
        logger.warn(
          { sub: caller.sub, scopeType: input.scopeType, scopeKey: input.scopeKey },
          'setBudget: non-operator attempted to modify an operator-imposed cap — denied',
        );
        return { ok: false, error: 'forbidden' };
      }
      return { ok: true, budget: mapBudgetRow(result.rows[0]) };
    } catch (err) {
      logger.error({ err, scopeType: input.scopeType, scopeKey: input.scopeKey }, 'setBudget: upsert failed');
      return { ok: false, error: 'unavailable' };
    }
  }

  /**
   * @description Sums per-event ledger spend (oshal_cost_events) for a scope over a trailing
   * window. NOT read from chat_tasks: those rows accumulate a task's LIFETIME total_cost and
   * recordCost bumps updated_at on every event, so filtering them by updated_at attributes a
   * long-lived task's whole history to "today" (and drops stale-but-real per-ticket spend).
   * The ledger has one row per cost event stamped at event time — the correct daily number.
   * @param scopeType - Which dimension to sum.
   * @param scopeKey - The sub / ticketType / ticketId for that dimension.
   * @param windowHours - Trailing window size in whole hours (e.g. 24 for a daily cap).
   * @returns Spend in USD, or null when the query fails / no pool (caller fails open).
   */
  async computeSpend(scopeType: BudgetScopeType, scopeKey: string, windowHours: number): Promise<number | null> {
    if (!this.pool) return null;
    const hours = Math.max(1, Math.floor(windowHours));
    try {
      const result = await this.pool.query(spendSqlFor(scopeType), [scopeKey, hours]);
      return Number.parseFloat(String(result.rows[0]?.spend ?? 0)) || 0;
    } catch (err) {
      logger.warn({ err, scopeType, scopeKey }, 'computeSpend: spend query failed — returning null (fail-open)');
      return null;
    }
  }

  /**
   * @description Runaway detector input: how many distinct chat_tasks execution rows linked
   * to this ticket were touched (updated_at) inside the trailing window. A looping ticket
   * that re-dispatches every poll cycle mints/touches a task row per execution, so this
   * count climbing past OSHAL_BUDGET_RUNAWAY_MAX is the loop signature.
   * @param ticketId - The ticket under suspicion (ticket_task_links.ticket_id).
   * @param windowMin - Trailing window in whole minutes.
   * @returns The count, or null when the query fails / no pool (caller fails open).
   */
  async countRecentExecutions(ticketId: string, windowMin: number): Promise<number | null> {
    if (!this.pool) return null;
    const mins = Math.max(1, Math.floor(windowMin));
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*)::int AS n
           FROM ticket_task_links ttl
           JOIN chat_tasks ct ON ct.task_id = ttl.task_id
          WHERE ttl.ticket_id = $1
            AND ct.updated_at >= NOW() - make_interval(mins => $2::int)`,
        [ticketId, mins],
      );
      return Number.parseInt(String(result.rows[0]?.n ?? 0), 10) || 0;
    } catch (err) {
      logger.warn({ err, ticketId }, 'countRecentExecutions: query failed — returning null (fail-open)');
      return null;
    }
  }

  /**
   * @description THE pre-dispatch gate. Order: (1) runaway kill switch when a ticketId is
   * given — a definitive over-threshold execution count halts regardless of spend; (2) every
   * enabled budget matching the user/app/ticket scopes, each compared against its 24h spend.
   * A HARD cap definitively exceeded blocks (+ audit row + notification); soft caps only set
   * softWarn. Any infra failure (missing table, DB down, unreadable spend) fails OPEN with a
   * WARN — governance must never brick dispatch on an infra gap.
   * @param userSub - The accountable end-user's OIDC sub (chat_tasks.owner_sub), if known.
   * @param appId - The app scope key = the manifest ticketType, if the work belongs to an app.
   * @param ticketId - The ticket being dispatched, if any (enables ticket caps + runaway check).
   * @returns The decision (allowed / softWarn / reason / spend / cap).
   */
  async checkBudget(userSub: string | null, appId?: string | null, ticketId?: string | null): Promise<BudgetDecision> {
    const runaway = await this.checkRunaway(userSub, appId, ticketId ?? null);
    if (runaway) return runaway;

    const budgets = await this.loadMatchingBudgets(userSub, appId ?? null, ticketId ?? null);
    if (budgets === null) {
      logger.warn(
        { userSub, appId, ticketId },
        'checkBudget: budgets table missing/unreachable — failing OPEN (allowed)',
      );
      return { allowed: true, softWarn: false, reason: 'budgets-unavailable' };
    }
    if (budgets.length === 0) {
      return { allowed: true, softWarn: false, reason: 'no-budgets' };
    }
    return this.evaluateBudgets(budgets, { userSub, appId: appId ?? null, ticketId: ticketId ?? null });
  }

  /**
   * @description Runs the runaway kill switch for a ticket. Returns a halting decision when
   * the recent-execution count definitively exceeds the max; null when the check passes or
   * cannot be computed (fail-open).
   */
  private async checkRunaway(
    userSub: string | null,
    appId: string | null | undefined,
    ticketId: string | null,
  ): Promise<BudgetDecision | null> {
    if (!ticketId) return null;
    const { max, windowMin } = readRunawayConfig(this.env);
    const count = await this.countRecentExecutions(ticketId, windowMin);
    if (count === null || count < max) return null;

    logger.error(
      { ticketId, count, max, windowMin },
      'Runaway kill switch tripped — halting dispatch for ticket',
    );
    const freshEvent = await this.recordEvent('ticket', ticketId, count, max, 'halt', {
      reason: 'runaway-halt', userSub, appId: appId ?? null, windowMin,
    });
    if (freshEvent) {
      this.fireNotification(
        `OSHAL budget governance: runaway kill switch halted ticket ${ticketId} — ${count} executions in ${windowMin}min (max ${max}).`,
      );
    }
    return { allowed: false, softWarn: false, reason: 'runaway-halt', spend: count, cap: max, scopeType: 'ticket', scopeKey: ticketId };
  }

  /**
   * @description Loads every ENABLED budget row matching the given scope keys in one query.
   * Returns null when the table is missing/unreachable so the caller can fail open.
   */
  private async loadMatchingBudgets(
    userSub: string | null,
    appId: string | null,
    ticketId: string | null,
  ): Promise<BudgetRecord[] | null> {
    if (!this.pool) return null;
    try {
      const result = await this.pool.query(
        `SELECT * FROM oshal_budgets
          WHERE enabled = TRUE
            AND ((scope_type = 'user'   AND scope_key = $1)
              OR (scope_type = 'app'    AND scope_key = $2)
              OR (scope_type = 'ticket' AND scope_key = $3))`,
        [userSub ?? '', appId ?? '', ticketId ?? ''],
      );
      return result.rows.map(mapBudgetRow);
    } catch (err) {
      logger.warn({ err }, 'loadMatchingBudgets: query failed');
      return null;
    }
  }

  /**
   * @description Compares each matched budget to its 24h spend. First hard breach blocks;
   * soft breaches accumulate into softWarn. Ticket caps are checked before app before user
   * so the most specific breach is the one reported.
   */
  private async evaluateBudgets(
    budgets: BudgetRecord[],
    ids: { userSub: string | null; appId: string | null; ticketId: string | null },
  ): Promise<BudgetDecision> {
    const ordered = [...budgets].sort(
      (a, b) => scopeSpecificity(a.scopeType) - scopeSpecificity(b.scopeType),
    );
    let softBreach: BudgetDecision | null = null;

    for (const budget of ordered) {
      const spend = await this.computeSpend(budget.scopeType, budget.scopeKey, 24);
      if (spend === null) {
        logger.warn(
          { scopeType: budget.scopeType, scopeKey: budget.scopeKey },
          'evaluateBudgets: spend unreadable for a cap — skipping it (fail-open)',
        );
        continue;
      }
      if (spend < budget.dailyUsd) continue;

      if (budget.hard) {
        logger.error(
          { scopeType: budget.scopeType, scopeKey: budget.scopeKey, spend, cap: budget.dailyUsd },
          'HARD budget cap exceeded — blocking dispatch',
        );
        const freshEvent = await this.recordEvent(budget.scopeType, budget.scopeKey, spend, budget.dailyUsd, 'halt', {
          reason: 'hard-cap-exceeded', ...ids,
        });
        if (freshEvent) {
          this.fireNotification(
            `OSHAL budget governance: HARD daily cap $${budget.dailyUsd} exceeded for ${budget.scopeType}:${budget.scopeKey} (spend $${spend.toFixed(4)}). Dispatch blocked.`,
          );
        }
        return {
          allowed: false, softWarn: false, reason: 'hard-cap-exceeded',
          spend, cap: budget.dailyUsd, scopeType: budget.scopeType, scopeKey: budget.scopeKey,
        };
      }

      logger.warn(
        { scopeType: budget.scopeType, scopeKey: budget.scopeKey, spend, cap: budget.dailyUsd },
        'Soft budget cap exceeded — warning only, dispatch proceeds',
      );
      softBreach = softBreach ?? {
        allowed: true, softWarn: true, reason: 'soft-cap-exceeded',
        spend, cap: budget.dailyUsd, scopeType: budget.scopeType, scopeKey: budget.scopeKey,
      };
    }
    return softBreach ?? { allowed: true, softWarn: false, reason: 'within-cap' };
  }

  /**
   * @description Appends one enforcement-action audit row, DEDUPED in the same statement:
   * nothing is written while a row for the same (scope_type, scope_key, action) already
   * exists inside the cooldown window (readEventCooldownMin). A blocked ticket is re-checked
   * every poll cycle by design, so an unconditional insert would flood oshal_budget_events
   * (and, via the caller, the operator's notification transport) for the life of the breach.
   * The DB is the dedupe state, so it holds across processes and restarts. Non-fatal: an
   * audit write failure is logged at ERROR but never changes the governance decision.
   * @returns true when a row was actually inserted (caller should notify), false when
   * deduped inside the cooldown or the write failed.
   */
  private async recordEvent(
    scopeType: BudgetScopeType,
    scopeKey: string,
    spend: number,
    cap: number,
    action: 'breach' | 'halt',
    detail: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const result = await this.pool.query(
        `INSERT INTO oshal_budget_events (scope_type, scope_key, spend_usd, cap_usd, action, detail)
         SELECT $1, $2, $3, $4, $5, $6::jsonb
          WHERE NOT EXISTS (
                SELECT 1 FROM oshal_budget_events
                 WHERE scope_type = $1 AND scope_key = $2 AND action = $5
                   AND ts >= NOW() - make_interval(mins => $7::int))`,
        [scopeType, scopeKey, spend, cap, action, JSON.stringify(detail), readEventCooldownMin(this.env)],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      logger.error({ err, scopeType, scopeKey, action }, 'recordEvent: budget audit write failed (non-fatal)');
      return false;
    }
  }

  /**
   * @description Fire-and-forget operator notification via the pluggable notifications
   * harness — a transport that isn't configured is a logged no-op, never an error, so a
   * bare deployment simply doesn't alert.
   */
  private fireNotification(text: string): void {
    void this.notify(text).catch((err) => {
      logger.error({ err }, 'fireNotification: budget alert send failed (non-fatal)');
    });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * @description Per-scope spend SQL over the oshal_cost_events per-event ledger (one row per
 * recordCost event, stamped at event time — never a lifetime rollup). All three anchor on
 * the event's ts; app/ticket scopes attribute via ticket_task_links on the event's task_id,
 * the same linkage queryCostByTicket uses, so scope attribution agrees with cockpit rollups.
 * @param scopeType - Which dimension to sum.
 * @returns Parameterized SQL taking ($1 = scope key, $2 = trailing hours).
 */
export function spendSqlFor(scopeType: BudgetScopeType): string {
  switch (scopeType) {
    case 'user':
      return `SELECT COALESCE(SUM(cost_usd), 0) AS spend
                FROM oshal_cost_events
               WHERE owner_sub = $1
                 AND ts >= NOW() - make_interval(hours => $2::int)`;
    case 'ticket':
      return `SELECT COALESCE(SUM(e.cost_usd), 0) AS spend
                FROM ticket_task_links ttl
                JOIN oshal_cost_events e ON e.task_id = ttl.task_id
               WHERE ttl.ticket_id = $1
                 AND e.ts >= NOW() - make_interval(hours => $2::int)`;
    case 'app':
      return `SELECT COALESCE(SUM(e.cost_usd), 0) AS spend
                FROM tickets t
                JOIN ticket_task_links ttl ON ttl.ticket_id = t.ticket_id
                JOIN oshal_cost_events e ON e.task_id = ttl.task_id
               WHERE t.ticket_type = $1
                 AND e.ts >= NOW() - make_interval(hours => $2::int)`;
  }
}

/**
 * @description Builds the setBudget upsert for the caller class. Operator writes stamp
 * set_by_operator=TRUE (taking ownership, even of a previously self-set row). Self-service
 * writes stamp FALSE and their UPDATE arm carries `WHERE set_by_operator = FALSE`, so an
 * operator-owned row makes the whole statement a no-op returning zero rows — the caller
 * maps that to 'forbidden'. The guard lives inside the single upsert statement on purpose:
 * a separate read-then-write check would race a concurrent operator write.
 * @param operator - Whether the validated caller is on the operator allowlist.
 * @returns Parameterized SQL taking ($1..$5 = scope_type, scope_key, daily_usd, hard, enabled).
 */
export function upsertBudgetSqlFor(operator: boolean): string {
  if (operator) {
    return `INSERT INTO oshal_budgets (scope_type, scope_key, daily_usd, hard, enabled, set_by_operator)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            ON CONFLICT (scope_type, scope_key)
            DO UPDATE SET daily_usd = EXCLUDED.daily_usd, hard = EXCLUDED.hard,
                          enabled = EXCLUDED.enabled, set_by_operator = TRUE, updated_at = NOW()
            RETURNING *`;
  }
  return `INSERT INTO oshal_budgets (scope_type, scope_key, daily_usd, hard, enabled, set_by_operator)
          VALUES ($1, $2, $3, $4, $5, FALSE)
          ON CONFLICT (scope_type, scope_key)
          DO UPDATE SET daily_usd = EXCLUDED.daily_usd, hard = EXCLUDED.hard,
                        enabled = EXCLUDED.enabled, updated_at = NOW()
          WHERE oshal_budgets.set_by_operator = FALSE
          RETURNING *`;
}

/** Lower = more specific = evaluated (and reported) first. */
function scopeSpecificity(scopeType: BudgetScopeType): number {
  return scopeType === 'ticket' ? 0 : scopeType === 'app' ? 1 : 2;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface RawBudgetRow {
  id: number | string;
  scope_type: string;
  scope_key: string;
  daily_usd: number | string;
  hard: boolean;
  enabled: boolean;
  set_by_operator?: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

function mapBudgetRow(row: RawBudgetRow): BudgetRecord {
  return {
    id: Number(row.id),
    scopeType: row.scope_type as BudgetScopeType,
    scopeKey: row.scope_key,
    dailyUsd: Number.parseFloat(String(row.daily_usd)) || 0,
    hard: Boolean(row.hard),
    enabled: Boolean(row.enabled),
    setByOperator: Boolean(row.set_by_operator),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

interface RawBudgetEventRow {
  id: number | string;
  ts: string | Date;
  scope_type: string;
  scope_key: string;
  spend_usd: number | string;
  cap_usd: number | string;
  action: string;
  detail?: unknown;
}

/**
 * @description Maps a raw oshal_budget_events row to the camel-cased BudgetEventRecord. `detail`
 * is jsonb (already parsed by pg) — kept as an object, or null when absent/unparseable.
 * @param row - Raw event row from pg.
 * @returns The BudgetEventRecord.
 */
function mapBudgetEventRow(row: RawBudgetEventRow): BudgetEventRecord {
  const detail = row.detail && typeof row.detail === 'object' ? (row.detail as Record<string, unknown>) : null;
  return {
    id: Number(row.id),
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    scopeType: String(row.scope_type),
    scopeKey: String(row.scope_key),
    spendUsd: Number.parseFloat(String(row.spend_usd)) || 0,
    capUsd: Number.parseFloat(String(row.cap_usd)) || 0,
    action: String(row.action),
    detail,
  };
}
