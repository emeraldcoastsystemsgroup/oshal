/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the additive, off-by-default LLM budget + quota + governance facade. Asserts backward compat (off = always allow, model unchanged) and on-path deny/downshift.
 *
 * NOTE ON PATH: the task brief named tests/llm-budget.spec.ts. Top-level
 * tests/*.spec.ts are collected by Playwright (playwright.config.ts testDir
 * './tests', testIgnore 'tests/unit/**'), while vitest unit specs live in
 * tests/unit/**. These are pure vitest unit tests, so they are placed under
 * tests/unit/ to run with `npm run test:unit` and stay out of the Playwright
 * suite. Filename preserved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BudgetService,
  readBudgetConfig,
  type BudgetConfig,
} from '../../src/features/llm-provider/governance/budget-service';
import { QuotaService, type QuotaConfig } from '../../src/features/llm-provider/governance/quota-service';
import { governLlmCall } from '../../src/features/llm-provider/governance';

// A fake cost reader: BudgetService reads spend via CostTrackingService.queryCostFromDB.
// We avoid a DB by injecting a BudgetService whose readTodaySpendUsd is stubbed.
function budgetServiceWithSpend(config: BudgetConfig, spendUsd: number | null): BudgetService {
  const svc = new BudgetService(null, config);
  // Stub the read-only spend lookup so no DB is touched.
  (svc as unknown as { readTodaySpendUsd: () => Promise<number | null> }).readTodaySpendUsd = async () => spendUsd;
  return svc;
}

const OFF_BUDGET: BudgetConfig = {
  enabled: false,
  globalDailyUsd: null,
  perOwnerDailyUsd: null,
  perBotDailyUsd: null,
  cacheTtlMs: 0,
};

const OFF_QUOTA: QuotaConfig = {
  enabled: false,
  windowMs: 60_000,
  maxRequestsPerWindow: null,
  maxTokensPerWindow: null,
};

describe('readBudgetConfig — off by default', () => {
  it('is disabled when OSHAL_LLM_BUDGETS is unset', () => {
    expect(readBudgetConfig({}).enabled).toBe(false);
  });
  it('is disabled for explicit off values', () => {
    expect(readBudgetConfig({ OSHAL_LLM_BUDGETS: 'off' }).enabled).toBe(false);
    expect(readBudgetConfig({ OSHAL_LLM_BUDGETS: 'false' }).enabled).toBe(false);
  });
  it('engages only for truthy flags', () => {
    for (const v of ['on', 'true', '1', 'yes', 'enabled']) {
      expect(readBudgetConfig({ OSHAL_LLM_BUDGETS: v }).enabled).toBe(true);
    }
  });
  it('parses caps from env', () => {
    const cfg = readBudgetConfig({
      OSHAL_LLM_BUDGETS: 'on',
      OSHAL_BUDGET_GLOBAL_DAILY_USD: '50',
      OSHAL_BUDGET_PER_OWNER_DAILY_USD: '5',
      OSHAL_BUDGET_PER_BOT_DAILY_USD: '2.5',
    });
    expect(cfg.globalDailyUsd).toBe(50);
    expect(cfg.perOwnerDailyUsd).toBe(5);
    expect(cfg.perBotDailyUsd).toBe(2.5);
  });
});

describe('BudgetService.checkBudget — enforcement OFF = always allow (backward compat)', () => {
  it('allows with infinite headroom and never reads spend', async () => {
    const svc = new BudgetService(null, OFF_BUDGET);
    const res = await svc.checkBudget({ scope: 'global', key: '', projectedCostUsd: 9_999 });
    expect(res.allowed).toBe(true);
    expect(res.remainingUsd).toBe(Number.POSITIVE_INFINITY);
    expect(res.reason).toBe('enforcement-off');
  });
});

describe('BudgetService.checkBudget — enforcement ON', () => {
  const onConfig: BudgetConfig = { ...OFF_BUDGET, enabled: true, globalDailyUsd: 10 };

  it('allows when projected total stays within the cap', async () => {
    const svc = budgetServiceWithSpend(onConfig, 4);
    const res = await svc.checkBudget({ scope: 'global', key: '', projectedCostUsd: 2 });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe('within-cap');
    expect(res.remainingUsd).toBeCloseTo(4, 5); // 10 - (4 + 2)
  });

  it('denies when projected total exceeds the cap', async () => {
    const svc = budgetServiceWithSpend(onConfig, 9);
    const res = await svc.checkBudget({ scope: 'global', key: '', projectedCostUsd: 2 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('over-cap');
    expect(res.remainingUsd).toBeCloseTo(-1, 5);
  });

  it('allows when the scope has no configured cap', async () => {
    const svc = budgetServiceWithSpend({ ...onConfig, perBotDailyUsd: null }, 1000);
    const res = await svc.checkBudget({ scope: 'bot', key: 'agent-x', projectedCostUsd: 5 });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe('no-cap-configured');
  });

  it('fails OPEN when spend cannot be read (DB outage)', async () => {
    const svc = budgetServiceWithSpend(onConfig, null);
    const res = await svc.checkBudget({ scope: 'global', key: '', projectedCostUsd: 100 });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe('cost-query-unavailable');
  });
});

describe('QuotaService — off by default = unlimited', () => {
  it('always allows when disabled', () => {
    const q = new QuotaService(OFF_QUOTA);
    const r = q.checkQuota({ scope: 'owner_sub', key: 'u1' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('enforcement-off');
  });

  it('recordUsage is a no-op when disabled (window stays empty)', () => {
    const q = new QuotaService(OFF_QUOTA);
    q.recordUsage({ scope: 'owner_sub', key: 'u1', tokens: 10_000, requests: 5 });
    const r = q.checkQuota({ scope: 'owner_sub', key: 'u1' });
    expect(r.requestsInWindow).toBe(0);
    expect(r.tokensInWindow).toBe(0);
  });
});

describe('QuotaService — enforcement ON, sliding window', () => {
  let now = 1_000_000;
  const clock = () => now;
  const onConfig: QuotaConfig = {
    enabled: true,
    windowMs: 1_000,
    maxRequestsPerWindow: 2,
    maxTokensPerWindow: 1_000,
  };

  beforeEach(() => {
    now = 1_000_000;
  });

  it('denies once the request count is reached', () => {
    const q = new QuotaService(onConfig, clock);
    q.recordUsage({ scope: 'bot', key: 'b1' });
    q.recordUsage({ scope: 'bot', key: 'b1' });
    const r = q.checkQuota({ scope: 'bot', key: 'b1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('request-quota-exceeded');
  });

  it('denies once the token count is reached', () => {
    const q = new QuotaService({ ...onConfig, maxRequestsPerWindow: null }, clock);
    q.recordUsage({ scope: 'bot', key: 'b2', tokens: 1_000 });
    const r = q.checkQuota({ scope: 'bot', key: 'b2' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('token-quota-exceeded');
  });

  it('forgets usage that aged out of the window', () => {
    const q = new QuotaService(onConfig, clock);
    q.recordUsage({ scope: 'bot', key: 'b3' });
    q.recordUsage({ scope: 'bot', key: 'b3' });
    expect(q.checkQuota({ scope: 'bot', key: 'b3' }).allowed).toBe(false);
    now += 2_000; // slide past the window
    const r = q.checkQuota({ scope: 'bot', key: 'b3' });
    expect(r.allowed).toBe(true);
    expect(r.requestsInWindow).toBe(0);
  });
});

describe('governLlmCall facade — off by default', () => {
  it('returns allowed + model unchanged with no enforcement env', async () => {
    const res = await governLlmCall(
      { requestedModel: 'claude-opus-4-1', scope: 'global', key: '', projectedCostUsd: 100 },
      { env: {} },
    );
    expect(res.allowed).toBe(true);
    expect(res.model).toBe('claude-opus-4-1');
    expect(res.downshiftedFrom).toBeNull();
    expect(res.reason).toBe('enforcement-off');
  });
});

describe('governLlmCall facade — enforcement ON', () => {
  const env = {
    OSHAL_LLM_BUDGETS: 'on',
    OSHAL_BUDGET_GLOBAL_DAILY_USD: '10',
    OSHAL_ROUTING_POLICY: 'auto',
    OSHAL_ROUTING_NEAR_CAP_PCT: '0.85',
  } as NodeJS.ProcessEnv;

  it('denies via quota before any budget/routing work', async () => {
    const quota = new QuotaService({ enabled: true, windowMs: 1_000, maxRequestsPerWindow: 1, maxTokensPerWindow: null });
    quota.recordUsage({ scope: 'owner_sub', key: 'u1' });
    const res = await governLlmCall(
      { requestedModel: 'claude-sonnet-4-6', scope: 'owner_sub', key: 'u1' },
      { env, quotaService: quota, budgetService: budgetServiceWithSpend({ ...OFF_BUDGET, enabled: true, globalDailyUsd: 10 }, 0) },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('quota:');
  });

  it('downshifts rather than denies when over budget but a cheaper model exists', async () => {
    // Spent 9 of 10; a 5 dollar opus call would exceed. opus -> sonnet downshift.
    const budgetService = budgetServiceWithSpend({ ...OFF_BUDGET, enabled: true, globalDailyUsd: 10 }, 9);
    const res = await governLlmCall(
      { requestedModel: 'claude-opus-4-1', scope: 'global', key: '', projectedCostUsd: 5 },
      { env, budgetService },
    );
    expect(res.allowed).toBe(true);
    expect(res.model).toContain('sonnet');
    expect(res.downshiftedFrom).toBe('claude-opus-4-1');
    expect(res.reason).toBe('over-budget-downshifted');
  });

  it('denies when over budget and the requested model is already cheapest in family', async () => {
    const budgetService = budgetServiceWithSpend({ ...OFF_BUDGET, enabled: true, globalDailyUsd: 10 }, 9);
    const res = await governLlmCall(
      { requestedModel: 'claude-haiku-4', scope: 'global', key: '', projectedCostUsd: 5 },
      { env, budgetService },
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('budget:');
  });
});
