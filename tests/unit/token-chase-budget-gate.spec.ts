/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Token Chase spend cap (BACKLOG "per-run judge budget cap"): the TOKEN_CHASE_BUDGET_USD knob is finite by default (no unlimited arm), an exhausted budget — proven against the REAL cost-governance BudgetService over a fake pg pool serving a tripped hard cap — stops runSavings before a single round fires (clean stop + status, no throw), an under-budget run proceeds through every frame, the per-run env cap halts a chase mid-run once accumulated measured spend crosses it, a failing governance probe fails OPEN, and a caller that passes no gate still gets the default finite ceiling.
 */

import { describe, expect, it, vi } from 'vitest';
import { TokenChaseOptimizeService, type VariantReplayResult } from '../../src/features/token-chase/services/token-chase-optimize-service';
import {
  TokenChaseBudgetGate,
  readTokenChaseBudgetUsd,
  DEFAULT_TOKEN_CHASE_BUDGET_USD,
} from '../../src/features/token-chase/services/token-chase-budget-gate';
import type { TokenChaseReadService, TokenChaseAccess } from '../../src/features/token-chase/services/token-chase-read-service';
import type { BotNodeClient } from '../../src/features/agent-management';
import { BudgetService } from '../../src/features/cost-governance';
import type { Pool } from 'pg';

const ACCESS: TokenChaseAccess = { callerSub: 'user-1', isAdmin: false };

/** A reader that serves three replayable frame summaries (runSavings only touches .seq). */
function fakeReader(): TokenChaseReadService {
  return {
    getFrames: async () => [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
  } as unknown as TokenChaseReadService;
}

/** An optimizer whose replayVariant is stubbed to a canned graded result costing `costUsd`. */
function stubbedService(costUsd: number): { service: TokenChaseOptimizeService; replaySpy: ReturnType<typeof vi.fn> } {
  const service = new TokenChaseOptimizeService(fakeReader(), {} as unknown as BotNodeClient);
  const replaySpy = vi.fn(async (runId: string, seq: number): Promise<VariantReplayResult> => ({
    runId,
    seq,
    status: 'equivalent',
    reason: null,
    baseline: {
      label: 'baseline', model: 'claude-sonnet-4-6', provider: 'harness:claude-code-cli',
      tokensIn: 1000, tokensOut: 200, costUsd: 0.1, costEstimated: false, latencyMs: 1500, preview: 'baseline',
    },
    variant: {
      label: 'cheap lane', model: 'gpt-5-mini', provider: 'openai',
      tokensIn: 1000, tokensOut: 200, costUsd, costEstimated: false, latencyMs: 900, preview: 'variant',
    },
    diff: { costDeltaUsd: costUsd - 0.1, costPct: -50, latencyDeltaMs: -600, accuracy: 0.97, equivalent: true },
    tier: 'equivalent-cheaper',
    meta: { queryType: 'test', complexity: 'low', harness: 'harness:claude-code-cli', tools: [] },
  }));
  vi.spyOn(service, 'replayVariant').mockImplementation(replaySpy as never);
  return { service, replaySpy };
}

/**
 * A fake pg pool for the REAL cost-governance BudgetService: one enabled HARD user-scope cap of
 * $1/day, and a ledger spend of `spendUsd` — over the cap = the governance probe must block.
 */
function fakeBudgetPool(spendUsd: number): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM oshal_budgets')) {
        return {
          rows: [{
            id: 1, scope_type: 'user', scope_key: 'user-1', daily_usd: '1', hard: true,
            enabled: true, set_by_operator: true, created_at: new Date(), updated_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM oshal_cost_events')) {
        return { rows: [{ spend: String(spendUsd) }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO oshal_budget_events')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

/** Binds the real BudgetService over a fake pool as the gate's governance probe (the route's wiring). */
function gateOverPool(pool: Pool, capUsd?: number): TokenChaseBudgetGate {
  const budgetService = new BudgetService(pool, { notify: async () => undefined });
  return new TokenChaseBudgetGate({
    userSub: 'user-1',
    capUsd,
    governance: (sub) => budgetService.checkBudget(sub),
  });
}

describe('TOKEN_CHASE_BUDGET_USD knob', () => {
  it('defaults to a FINITE cap and rejects unlimited/invalid values', () => {
    expect(readTokenChaseBudgetUsd({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_BUDGET_USD);
    expect(Number.isFinite(DEFAULT_TOKEN_CHASE_BUDGET_USD)).toBe(true);
    expect(readTokenChaseBudgetUsd({ TOKEN_CHASE_BUDGET_USD: '7.5' } as NodeJS.ProcessEnv)).toBe(7.5);
    // No "0 = unlimited" arm — zero/negative/garbage all fall back to the finite default.
    expect(readTokenChaseBudgetUsd({ TOKEN_CHASE_BUDGET_USD: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_BUDGET_USD);
    expect(readTokenChaseBudgetUsd({ TOKEN_CHASE_BUDGET_USD: '-3' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_BUDGET_USD);
    expect(readTokenChaseBudgetUsd({ TOKEN_CHASE_BUDGET_USD: 'unlimited' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_BUDGET_USD);
  });

  it('record() ignores non-finite and non-positive spend', async () => {
    const gate = new TokenChaseBudgetGate({ capUsd: 1 });
    gate.record(Number.NaN);
    gate.record(-5);
    gate.record(0);
    gate.record(0.25);
    expect((await gate.check()).spentUsd).toBe(0.25);
  });
});

describe('token-chase spend gate over the savings loop', () => {
  it('an EXHAUSTED budget (real BudgetService, fake pool, tripped hard cap) stops the chase before any round fires', async () => {
    const { service, replaySpy } = stubbedService(0.04);
    const gate = gateOverPool(fakeBudgetPool(5)); // $5 spent >= $1 hard cap → governance blocks

    // Stops CLEANLY: resolves (no throw), zero replays, and the status says why.
    const { results, budget } = await service.runSavings('run-1', { label: 'cheap lane' }, ACCESS, undefined, gate);
    expect(replaySpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
    expect(budget.exhausted).toBe(true);
    expect(budget.reason).toBe('governance-blocked');
    expect(budget.governanceReason).toBe('hard-cap-exceeded');
  });

  it('an UNDER-budget run proceeds through every frame', async () => {
    const { service, replaySpy } = stubbedService(0.04);
    const gate = gateOverPool(fakeBudgetPool(0.01)); // $0.01 spent < $1 cap → allowed

    const { results, budget } = await service.runSavings('run-1', { label: 'cheap lane' }, ACCESS, undefined, gate);
    expect(replaySpy).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    expect(budget.exhausted).toBe(false);
    expect(budget.reason).toBe('within-cap');
    expect(budget.spentUsd).toBeCloseTo(0.12, 10); // 3 × $0.04 measured replay spend
  });

  it('the per-run env cap halts the chase mid-run once accumulated spend crosses it', async () => {
    const { service, replaySpy } = stubbedService(0.04);
    // Governance is happy; the RUN cap ($0.05) is what trips: after two $0.04 rounds
    // ($0.08 accumulated) the third check must refuse to spend.
    const gate = gateOverPool(fakeBudgetPool(0.01), 0.05);

    const { results, budget } = await service.runSavings('run-1', { label: 'cheap lane' }, ACCESS, undefined, gate);
    expect(replaySpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(budget.exhausted).toBe(true);
    expect(budget.reason).toBe('run-cap-exceeded');
    expect(budget.spentUsd).toBeCloseTo(0.08, 10);
    expect(budget.capUsd).toBe(0.05);
  });

  it('a failing governance probe fails OPEN (env cap still the ceiling)', async () => {
    const { service, replaySpy } = stubbedService(0.04);
    const gate = new TokenChaseBudgetGate({
      userSub: 'user-1',
      capUsd: 100,
      governance: async () => { throw new Error('budgets table missing'); },
    });

    const { results, budget } = await service.runSavings('run-1', { label: 'cheap lane' }, ACCESS, undefined, gate);
    expect(replaySpy).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    expect(budget.exhausted).toBe(false);
  });

  it('a caller that passes NO gate still gets the default finite ceiling', async () => {
    const { service } = stubbedService(0.04);
    const prior = process.env.TOKEN_CHASE_BUDGET_USD;
    delete process.env.TOKEN_CHASE_BUDGET_USD;
    try {
      const { budget } = await service.runSavings('run-1', { label: 'cheap lane' }, ACCESS);
      expect(Number.isFinite(budget.capUsd)).toBe(true);
      expect(budget.capUsd).toBe(DEFAULT_TOKEN_CHASE_BUDGET_USD);
    } finally {
      if (prior !== undefined) process.env.TOKEN_CHASE_BUDGET_USD = prior;
    }
  });
});
