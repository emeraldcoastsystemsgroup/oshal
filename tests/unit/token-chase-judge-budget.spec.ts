/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the per-run JUDGE spend cap (BACKLOG "per-run judge budget cap"): TOKEN_CHASE_JUDGE_BUDGET_USD is finite by default with NO unlimited arm, the gate is consulted BEFORE each judge call and stops grading EXACTLY at breach (>= cap blocks, including exactly-at-cap; once tripped it stays tripped), the run is marked partially graded HONESTLY (graded/skipped split + partiallyGraded in the status — replay/persistence continue, only grading stops), a failing spend probe fails OPEN at that reading while known spend still enforces the cap (fail-closed on the cap, fail-open on infra), and a full grading-loop simulation over runSavings proves the loop keeps replaying frames after the judge budget trips.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  TokenChaseJudgeBudget,
  readTokenChaseJudgeBudgetUsd,
  DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD,
} from '../../src/features/token-chase/services/token-chase-judge-budget';
import { TokenChaseOptimizeService, type VariantReplayResult } from '../../src/features/token-chase/services/token-chase-optimize-service';
import type { TokenChaseReadService, TokenChaseAccess } from '../../src/features/token-chase/services/token-chase-read-service';
import type { BotNodeClient } from '../../src/features/agent-management';

describe('TOKEN_CHASE_JUDGE_BUDGET_USD knob', () => {
  it('defaults to a finite positive cap', () => {
    expect(DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD)).toBe(true);
    expect(readTokenChaseJudgeBudgetUsd({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD);
  });

  it('honors a valid override and refuses the unlimited arm (0 / negative / garbage → default)', () => {
    expect(readTokenChaseJudgeBudgetUsd({ TOKEN_CHASE_JUDGE_BUDGET_USD: '2.5' } as NodeJS.ProcessEnv)).toBe(2.5);
    expect(readTokenChaseJudgeBudgetUsd({ TOKEN_CHASE_JUDGE_BUDGET_USD: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD);
    expect(readTokenChaseJudgeBudgetUsd({ TOKEN_CHASE_JUDGE_BUDGET_USD: '-3' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD);
    expect(readTokenChaseJudgeBudgetUsd({ TOKEN_CHASE_JUDGE_BUDGET_USD: 'unlimited' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD);
  });
});

describe('TokenChaseJudgeBudget — the pre-call hard ceiling', () => {
  it('allows judge calls under the cap and blocks EXACTLY at breach (>= cap, including exactly-at)', async () => {
    let ledger = 0;
    const budget = new TokenChaseJudgeBudget({ capUsd: 0.05, spendProbe: async () => ledger });

    expect((await budget.beforeJudgeCall()).allowed).toBe(true); // spend 0
    ledger = 0.03;
    expect((await budget.beforeJudgeCall()).allowed).toBe(true); // 0.03 < 0.05
    ledger = 0.05;
    const atCap = await budget.beforeJudgeCall(); // exactly at cap → fail-closed
    expect(atCap.allowed).toBe(false);
    expect(atCap.spentUsd).toBe(0.05);
  });

  it('stays tripped once breached — a later cheaper probe reading never un-trips the run', async () => {
    let ledger = 10;
    const budget = new TokenChaseJudgeBudget({ capUsd: 1, spendProbe: async () => ledger });
    expect((await budget.beforeJudgeCall()).allowed).toBe(false);
    ledger = 0; // probe now claims $0 — the trip is monotonic for the run
    expect((await budget.beforeJudgeCall()).allowed).toBe(false);
    expect(budget.status().exhausted).toBe(true);
  });

  it('marks the run partially graded honestly via the graded/skipped split', async () => {
    const budget = new TokenChaseJudgeBudget({ capUsd: 1 });
    budget.noteGraded();
    budget.noteGraded();
    budget.noteSkipped();
    const status = budget.status();
    expect(status.gradedFrames).toBe(2);
    expect(status.skippedFrames).toBe(1);
    expect(status.partiallyGraded).toBe(true);
    // A fully-graded run is NOT marked partial.
    const clean = new TokenChaseJudgeBudget({ capUsd: 1 });
    clean.noteGraded();
    expect(clean.status().partiallyGraded).toBe(false);
  });

  it('fails OPEN on a broken spend probe (infra) while known spend still enforces the cap', async () => {
    const budget = new TokenChaseJudgeBudget({ capUsd: 0.05, spendProbe: async () => { throw new Error('db down'); } });
    expect((await budget.beforeJudgeCall()).allowed).toBe(true); // probe failure ≠ blocked
    budget.record(0.06); // directly-measured spend crosses the cap
    expect((await budget.beforeJudgeCall()).allowed).toBe(false); // fail-closed on the cap
  });

  it('record() ignores non-finite and non-positive values', async () => {
    const budget = new TokenChaseJudgeBudget({ capUsd: 1 });
    budget.record(Number.NaN);
    budget.record(-5);
    budget.record(0);
    expect(budget.status().spentUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Grading-loop simulation: the savings loop keeps REPLAYING and PERSISTING after
// the judge budget trips — only GRADING stops, and the stop lands exactly at breach.
// ---------------------------------------------------------------------------

const ACCESS: TokenChaseAccess = { callerSub: 'user-1', isAdmin: false };

function fakeReader(): TokenChaseReadService {
  return { getFrames: async () => [{ seq: 1 }, { seq: 2 }, { seq: 3 }] } as unknown as TokenChaseReadService;
}

function stubbedService(): TokenChaseOptimizeService {
  const service = new TokenChaseOptimizeService(fakeReader(), {} as unknown as BotNodeClient);
  vi.spyOn(service, 'replayVariant').mockImplementation(async (runId: string, seq: number): Promise<VariantReplayResult> => ({
    runId,
    seq,
    status: 'equivalent',
    reason: null,
    baseline: {
      label: 'baseline', model: 'claude-sonnet-4-6', provider: 'harness:claude-code-cli',
      tokensIn: 1000, tokensOut: 200, costUsd: 0.1, costEstimated: false, latencyMs: 1500, preview: 'baseline',
    },
    variant: {
      label: 'cheap lane', model: 'llama-free', provider: 'framework:openrouter',
      tokensIn: 1000, tokensOut: 200, costUsd: 0, costEstimated: false, latencyMs: 900, preview: 'variant',
    },
    diff: { costDeltaUsd: -0.1, costPct: -100, latencyDeltaMs: -600, accuracy: 0.97, equivalent: true },
    tier: 'equivalent-cheaper',
    meta: { queryType: 'test', complexity: 'low', harness: 'harness:claude-code-cli', tools: [] },
  }) as never);
  return service;
}

describe('grading loop under the judge budget (runSavings integration)', () => {
  it('stops grading exactly at breach but keeps replaying + persisting the remaining frames', async () => {
    const judgeCostPerCall = 0.03;
    let judgeLedger = 0;
    const judgeBudget = new TokenChaseJudgeBudget({ capUsd: 0.05, spendProbe: async () => judgeLedger });

    const judgeCalls: number[] = [];
    const persisted: Array<{ seq: number; graded: boolean }> = [];
    // Mirrors the route's onObservation closure: consult the budget BEFORE the judge call;
    // an exhausted budget persists the observation ungraded instead of spending.
    const onObservation = async (result: VariantReplayResult): Promise<void> => {
      const verdict = await judgeBudget.beforeJudgeCall();
      if (!verdict.allowed) {
        persisted.push({ seq: result.seq, graded: false });
        judgeBudget.noteSkipped();
        return;
      }
      judgeCalls.push(result.seq);
      judgeLedger += judgeCostPerCall; // the judge call's real cost lands in the ledger
      persisted.push({ seq: result.seq, graded: true });
      judgeBudget.noteGraded();
    };

    const service = stubbedService();
    const { results } = await service.runSavings('run-1', { label: 'cheap lane' }, ACCESS, onObservation);

    // Every frame replayed and persisted — the loop itself never stops for the JUDGE cap.
    expect(results).toHaveLength(3);
    expect(persisted.map((p) => p.seq)).toEqual([1, 2, 3]);
    // Judge calls: frame 1 (spend 0), frame 2 (spend .03 < .05), frame 3 blocked (.06 >= .05).
    expect(judgeCalls).toEqual([1, 2]);
    expect(persisted[2]).toEqual({ seq: 3, graded: false });

    const status = judgeBudget.status();
    expect(status.exhausted).toBe(true);
    expect(status.gradedFrames).toBe(2);
    expect(status.skippedFrames).toBe(1);
    expect(status.partiallyGraded).toBe(true); // the run is marked partial — never silent
  });
});
