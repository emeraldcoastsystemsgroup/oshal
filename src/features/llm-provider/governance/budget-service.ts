/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | NEW: additive, off-by-default LLM budget service (spend caps per scope). Reads current spend READ-ONLY via the existing CostTrackingService; never mutates cost data. When OSHAL_LLM_BUDGETS is off, every check returns allowed:true (zero behavior change).
 */

/**
 * @description
 * Budget enforcement for LLM calls. This layer is ADDITIVE and OFF BY DEFAULT.
 *
 * When `OSHAL_LLM_BUDGETS` is unset or off, {@link checkBudget} ALWAYS returns
 * `allowed: true` with `remainingUsd: Infinity` so merging this file changes
 * nothing. A maintainer opts in by setting `OSHAL_LLM_BUDGETS=on` and one or
 * more cap env vars (see {@link BudgetConfig}).
 *
 * Current spend is read READ-ONLY through the existing
 * {@link CostTrackingService.queryCostFromDB} query. This file NEVER writes to
 * chat_tasks or mutates any cost record. A small in-memory cache (default 30s)
 * avoids hammering the DB on every call.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { CostTrackingService } from '@/features/operational-intelligence';

const logger = createChildLogger({ module: 'budget-service' });

/**
 * @description Budget scope dimensions. A budget cap is keyed by (scope, key).
 *  - 'global'    : one shared cap across the whole deployment (key is ignored).
 *  - 'owner_sub' : per end-user (OIDC sub) cap; key = owner sub.
 *  - 'bot'       : per-bot / per-agent cap; key = agentId.
 *  - 'day'       : a daily global window cap; key = ISO date (YYYY-MM-DD).
 */
export type BudgetScope = 'global' | 'owner_sub' | 'bot' | 'day';

/**
 * @description Input for a single budget check.
 */
export interface BudgetCheckInput {
  scope: BudgetScope;
  key: string;
  /** Estimated USD cost of the call about to be made (>= 0). */
  projectedCostUsd: number;
}

/**
 * @description Result of a budget check.
 *  - allowed       : whether the call may proceed under the cap.
 *  - remainingUsd  : USD headroom left under the cap AFTER the projected cost
 *                    (Infinity when enforcement is off or no cap is configured).
 *  - reason        : machine-readable explanation.
 */
export interface BudgetCheckResult {
  allowed: boolean;
  remainingUsd: number;
  reason:
    | 'enforcement-off'
    | 'no-cap-configured'
    | 'within-cap'
    | 'over-cap'
    | 'cost-query-unavailable';
  capUsd?: number;
  spentUsd?: number;
  scope?: BudgetScope;
  key?: string;
}

/**
 * @description Resolved budget caps + cache window read from env.
 */
export interface BudgetConfig {
  enabled: boolean;
  globalDailyUsd: number | null;
  perOwnerDailyUsd: number | null;
  perBotDailyUsd: number | null;
  /** Cache TTL in milliseconds for spend lookups. */
  cacheTtlMs: number;
}

/**
 * @description Reads the budget configuration from the environment.
 *
 * Off by default: enforcement only engages when OSHAL_LLM_BUDGETS is a truthy
 * flag ('on'|'true'|'1'|'yes'|'enabled'). Caps are optional; an unset cap means
 * "no limit for that scope".
 *
 * Recognized env vars:
 *  - OSHAL_LLM_BUDGETS               : master switch (off by default)
 *  - OSHAL_BUDGET_GLOBAL_DAILY_USD   : global + day scope cap
 *  - OSHAL_BUDGET_PER_OWNER_DAILY_USD: per owner_sub cap
 *  - OSHAL_BUDGET_PER_BOT_DAILY_USD  : per bot cap
 *  - OSHAL_BUDGET_CACHE_TTL_MS       : spend cache TTL (default 30000)
 *
 * @param env - Environment bag (defaults to process.env). Injectable for tests.
 * @returns Resolved {@link BudgetConfig}.
 */
export function readBudgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  return {
    enabled: isEnforcementOn(env.OSHAL_LLM_BUDGETS),
    globalDailyUsd: parseUsdCap(env.OSHAL_BUDGET_GLOBAL_DAILY_USD),
    perOwnerDailyUsd: parseUsdCap(env.OSHAL_BUDGET_PER_OWNER_DAILY_USD),
    perBotDailyUsd: parseUsdCap(env.OSHAL_BUDGET_PER_BOT_DAILY_USD),
    cacheTtlMs: parseTtl(env.OSHAL_BUDGET_CACHE_TTL_MS, 30_000),
  };
}

/**
 * @description Returns the always-allow result used whenever enforcement is off
 * or no cap applies. Centralized so the off-path is provably the current
 * behavior (allowed, unlimited headroom).
 */
function allowUnlimited(reason: BudgetCheckResult['reason']): BudgetCheckResult {
  return { allowed: true, remainingUsd: Number.POSITIVE_INFINITY, reason };
}

interface CacheEntry {
  expiresAt: number;
  spentUsd: number;
}

/**
 * @description Budget service. Holds a read-only cost reader + a small spend
 * cache. Construct once and reuse; the cache is keyed by (scope|key|date).
 */
export class BudgetService {
  private readonly costReader: CostTrackingService;
  private readonly config: BudgetConfig;
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * @param pool - Postgres pool (read-only use). Pass null to run with no DB,
   *   in which case spend reads return unavailable and (when enforcement is on)
   *   the check fails open to allowed:true so governance never blocks on a DB
   *   outage. Enforcement-off short-circuits before any DB access.
   * @param config - Optional pre-resolved config (defaults to env).
   * @param clock - Injectable clock for tests.
   */
  constructor(
    pool: Pool | null = null,
    config: BudgetConfig = readBudgetConfig(),
    private readonly clock: () => number = () => Date.now(),
  ) {
    // CostTrackingService is used READ-ONLY here (queryCostFromDB). We never
    // call recordCost from the governance layer.
    this.costReader = new CostTrackingService(pool);
    this.config = config;
  }

  /**
   * @description Returns the active config (caps + enforcement flag) for status
   * surfaces. Pure read; no DB access.
   */
  getConfig(): BudgetConfig {
    return this.config;
  }

  /**
   * @description Resolves the configured cap (USD) for a scope, or null when no
   * cap applies to that scope.
   */
  capForScope(scope: BudgetScope): number | null {
    switch (scope) {
      case 'global':
      case 'day':
        return this.config.globalDailyUsd;
      case 'owner_sub':
        return this.config.perOwnerDailyUsd;
      case 'bot':
        return this.config.perBotDailyUsd;
      default:
        return null;
    }
  }

  /**
   * @description Reads today's spend for a scope/key READ-ONLY, with caching.
   *
   * Global/day scopes sum all of today's spend. The owner_sub scope reads ONLY
   * that user's attributed spend via a server-side filter on chat_tasks.owner_sub
   * (Phase 2). The bot scope buckets the daily total client-side by agent_id.
   *
   * @returns Spent USD today, or null when the cost query is unavailable.
   */
  async readTodaySpendUsd(scope: BudgetScope, key: string): Promise<number | null> {
    const dayKey = todayKey(this.clock());
    const cacheKey = `${scope}|${key}|${dayKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.clock()) {
      return cached.spentUsd;
    }

    const since = startOfUtcDay(this.clock());
    // Per-owner caps read only this user's rows (server-side filter); other
    // scopes read the daily total and bucket client-side where needed.
    const ownerFilter = scope === 'owner_sub' && key ? { ownerSub: key } : undefined;
    const summary = await this.costReader.queryCostFromDB(since, undefined, ownerFilter);
    if (!summary) {
      return null;
    }

    let spentUsd = summary.totalCost;
    if (scope === 'bot' && key) {
      // chat_tasks rolls up by agent_id; use the per-agent bucket when present.
      spentUsd = summary.byAgent[key]?.cost ?? 0;
    }

    this.cache.set(cacheKey, {
      spentUsd,
      expiresAt: this.clock() + this.config.cacheTtlMs,
    });
    return spentUsd;
  }

  /**
   * @description Checks a projected call against the configured cap for its
   * scope. OFF BY DEFAULT: returns allowed:true when enforcement is off or the
   * scope has no configured cap.
   *
   * @param input - scope, key, and projected USD cost.
   * @returns {@link BudgetCheckResult}.
   */
  async checkBudget(input: BudgetCheckInput): Promise<BudgetCheckResult> {
    // ── Off path: provably current behavior ──────────────────────────────────
    if (!this.config.enabled) {
      return allowUnlimited('enforcement-off');
    }

    const cap = this.capForScope(input.scope);
    if (cap === null) {
      return allowUnlimited('no-cap-configured');
    }

    const projected = Number.isFinite(input.projectedCostUsd) && input.projectedCostUsd > 0
      ? input.projectedCostUsd
      : 0;

    const spent = await this.readTodaySpendUsd(input.scope, input.key);
    if (spent === null) {
      // Fail OPEN on a cost-query outage so governance never hard-blocks the
      // platform when the DB is unreachable. Logged for operator visibility.
      logger.warn(
        { scope: input.scope, key: input.key },
        'Budget check could not read spend (cost query unavailable) — failing open (allowed)',
      );
      return { ...allowUnlimited('cost-query-unavailable'), capUsd: cap, scope: input.scope, key: input.key };
    }

    const projectedTotal = spent + projected;
    const remainingUsd = cap - projectedTotal;
    const allowed = projectedTotal <= cap;

    if (!allowed) {
      logger.info(
        { scope: input.scope, key: input.key, capUsd: cap, spentUsd: spent, projected },
        'Budget check DENIED — projected spend exceeds cap',
      );
    }

    return {
      allowed,
      remainingUsd,
      reason: allowed ? 'within-cap' : 'over-cap',
      capUsd: cap,
      spentUsd: spent,
      scope: input.scope,
      key: input.key,
    };
  }

  /** @description Clears the spend cache (test/operator hook). */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * @description Module-level convenience wrapper around a lazily-constructed
 * {@link BudgetService}. Useful for call sites that do not hold a pool.
 *
 * Off by default: with no pool and enforcement off, this returns allowed:true
 * immediately without touching a DB.
 */
let defaultService: BudgetService | null = null;
export function checkBudget(
  input: BudgetCheckInput,
  pool: Pool | null = null,
): Promise<BudgetCheckResult> {
  if (!defaultService) {
    defaultService = new BudgetService(pool);
  }
  return defaultService.checkBudget(input);
}

/** @description Resets the module-level service (test hook). */
export function __resetDefaultBudgetService(): void {
  defaultService = null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function isEnforcementOn(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  return ['on', 'true', '1', 'yes', 'enabled'].includes(value.trim().toLowerCase());
}

function parseUsdCap(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseTtl(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function startOfUtcDay(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function todayKey(nowMs: number): string {
  return startOfUtcDay(nowMs).toISOString().slice(0, 10);
}
