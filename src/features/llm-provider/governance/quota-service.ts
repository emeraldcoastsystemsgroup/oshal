/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | NEW: additive, off-by-default request-count + token quota service (sliding window, in-memory). Unlimited when OSHAL_LLM_BUDGETS is off (zero behavior change).
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Point doc comment at docs/architecture/model-gateway.md (docs consolidation follow-up)
 */

/**
 * @description
 * Request-count and token quotas per (scope, key) over a sliding time window.
 * ADDITIVE and OFF BY DEFAULT: when `OSHAL_LLM_BUDGETS` is off (or no quota
 * caps are configured), {@link QuotaService.checkQuota} always returns
 * `allowed: true` and {@link QuotaService.recordUsage} is a no-op cost-wise.
 *
 * Storage is in-memory (per-process sliding window). For multi-replica
 * deployments a shared store (e.g. Redis sorted sets keyed by `scope:key`,
 * trimmed by window) would replace the in-memory map; the public surface here
 * is intentionally store-agnostic so a Redis-backed implementation can be
 * dropped in behind the same methods. See README and docs/architecture/model-gateway.md.
 */

import { createChildLogger } from '@/shared/logger';
import type { BudgetScope } from './budget-service';

const logger = createChildLogger({ module: 'quota-service' });

/** @description Quota scope mirrors {@link BudgetScope}. */
export type QuotaScope = BudgetScope;

/** @description Input identifying the (scope, key) bucket to check. */
export interface QuotaCheckInput {
  scope: QuotaScope;
  key: string;
}

/** @description Input recording consumption against a (scope, key) bucket. */
export interface QuotaUsageInput {
  scope: QuotaScope;
  key: string;
  /** Tokens consumed by the call (input + output). Optional; defaults to 0. */
  tokens?: number;
  /** Request units consumed (defaults to 1). */
  requests?: number;
}

/** @description Result of a quota check. */
export interface QuotaCheckResult {
  allowed: boolean;
  reason:
    | 'enforcement-off'
    | 'no-quota-configured'
    | 'within-quota'
    | 'request-quota-exceeded'
    | 'token-quota-exceeded';
  windowMs: number;
  requestsInWindow: number;
  tokensInWindow: number;
  maxRequests: number | null;
  maxTokens: number | null;
}

/** @description Resolved quota configuration from env. */
export interface QuotaConfig {
  enabled: boolean;
  windowMs: number;
  maxRequestsPerWindow: number | null;
  maxTokensPerWindow: number | null;
}

/**
 * @description Reads the quota configuration from the environment.
 *
 * Off by default: gated behind OSHAL_LLM_BUDGETS (shared master switch with the
 * budget service). Quota caps are optional; unset means unlimited.
 *
 * Recognized env vars:
 *  - OSHAL_LLM_BUDGETS                 : master switch (off by default)
 *  - OSHAL_QUOTA_WINDOW_MS             : sliding window length (default 60000)
 *  - OSHAL_QUOTA_MAX_REQUESTS          : max requests per window (per scope/key)
 *  - OSHAL_QUOTA_MAX_TOKENS            : max tokens per window (per scope/key)
 *
 * @param env - Environment bag (defaults to process.env). Injectable for tests.
 */
export function readQuotaConfig(env: NodeJS.ProcessEnv = process.env): QuotaConfig {
  return {
    enabled: isEnforcementOn(env.OSHAL_LLM_BUDGETS),
    windowMs: parsePositiveInt(env.OSHAL_QUOTA_WINDOW_MS, 60_000),
    maxRequestsPerWindow: parseCap(env.OSHAL_QUOTA_MAX_REQUESTS),
    maxTokensPerWindow: parseCap(env.OSHAL_QUOTA_MAX_TOKENS),
  };
}

interface UsageRecord {
  ts: number;
  tokens: number;
  requests: number;
}

/**
 * @description Sliding-window quota service. In-memory; per-process.
 */
export class QuotaService {
  private readonly config: QuotaConfig;
  private readonly buckets = new Map<string, UsageRecord[]>();

  constructor(
    config: QuotaConfig = readQuotaConfig(),
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.config = config;
  }

  /** @description Returns the active quota config for status surfaces. */
  getConfig(): QuotaConfig {
    return this.config;
  }

  /**
   * @description Checks whether the (scope, key) bucket has headroom in the
   * current sliding window. OFF BY DEFAULT: returns allowed:true when
   * enforcement is off or no quota caps are configured.
   */
  checkQuota(input: QuotaCheckInput): QuotaCheckResult {
    const { maxRequestsPerWindow, maxTokensPerWindow, windowMs } = this.config;

    if (!this.config.enabled) {
      return this.unlimited('enforcement-off');
    }
    if (maxRequestsPerWindow === null && maxTokensPerWindow === null) {
      return this.unlimited('no-quota-configured');
    }

    const { requests, tokens } = this.windowTotals(this.bucketKey(input.scope, input.key));

    if (maxRequestsPerWindow !== null && requests >= maxRequestsPerWindow) {
      logger.info({ scope: input.scope, key: input.key, requests, maxRequestsPerWindow }, 'Quota DENIED — request count exceeded');
      return {
        allowed: false,
        reason: 'request-quota-exceeded',
        windowMs,
        requestsInWindow: requests,
        tokensInWindow: tokens,
        maxRequests: maxRequestsPerWindow,
        maxTokens: maxTokensPerWindow,
      };
    }

    if (maxTokensPerWindow !== null && tokens >= maxTokensPerWindow) {
      logger.info({ scope: input.scope, key: input.key, tokens, maxTokensPerWindow }, 'Quota DENIED — token count exceeded');
      return {
        allowed: false,
        reason: 'token-quota-exceeded',
        windowMs,
        requestsInWindow: requests,
        tokensInWindow: tokens,
        maxRequests: maxRequestsPerWindow,
        maxTokens: maxTokensPerWindow,
      };
    }

    return {
      allowed: true,
      reason: 'within-quota',
      windowMs,
      requestsInWindow: requests,
      tokensInWindow: tokens,
      maxRequests: maxRequestsPerWindow,
      maxTokens: maxTokensPerWindow,
    };
  }

  /**
   * @description Records consumption against a (scope, key) bucket. When
   * enforcement is off this is a no-op (we do not accumulate windows we will
   * never read), keeping the off-path free of side effects.
   */
  recordUsage(input: QuotaUsageInput): void {
    if (!this.config.enabled) {
      return;
    }
    const key = this.bucketKey(input.scope, input.key);
    const records = this.buckets.get(key) ?? [];
    records.push({
      ts: this.clock(),
      tokens: Number.isFinite(input.tokens) && (input.tokens ?? 0) > 0 ? (input.tokens as number) : 0,
      requests: Number.isFinite(input.requests) && (input.requests ?? 0) > 0 ? (input.requests as number) : 1,
    });
    this.buckets.set(key, this.prune(records));
  }

  /** @description Clears all buckets (test/operator hook). */
  reset(): void {
    this.buckets.clear();
  }

  private bucketKey(scope: QuotaScope, key: string): string {
    return `${scope}|${key || '*'}`;
  }

  private windowTotals(bucketKey: string): { requests: number; tokens: number } {
    const records = this.prune(this.buckets.get(bucketKey) ?? []);
    this.buckets.set(bucketKey, records);
    let requests = 0;
    let tokens = 0;
    for (const r of records) {
      requests += r.requests;
      tokens += r.tokens;
    }
    return { requests, tokens };
  }

  private prune(records: UsageRecord[]): UsageRecord[] {
    const cutoff = this.clock() - this.config.windowMs;
    return records.filter((r) => r.ts > cutoff);
  }

  private unlimited(reason: QuotaCheckResult['reason']): QuotaCheckResult {
    return {
      allowed: true,
      reason,
      windowMs: this.config.windowMs,
      requestsInWindow: 0,
      tokensInWindow: 0,
      maxRequests: this.config.maxRequestsPerWindow,
      maxTokens: this.config.maxTokensPerWindow,
    };
  }
}

/**
 * @description Module-level convenience service so callers without their own
 * instance can `checkQuota` / `recordUsage` directly. Off by default.
 */
let defaultService: QuotaService | null = null;

export function checkQuota(input: QuotaCheckInput): QuotaCheckResult {
  if (!defaultService) defaultService = new QuotaService();
  return defaultService.checkQuota(input);
}

export function recordUsage(input: QuotaUsageInput): void {
  if (!defaultService) defaultService = new QuotaService();
  defaultService.recordUsage(input);
}

/** @description Resets the module-level service (test hook). */
export function __resetDefaultQuotaService(): void {
  defaultService = null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function isEnforcementOn(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  return ['on', 'true', '1', 'yes', 'enabled'].includes(value.trim().toLowerCase());
}

function parseCap(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
