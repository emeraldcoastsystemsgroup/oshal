/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Token Chase keep-winner bar (ADR-046, BACKLOG "auto keep-winner then re-baseline"): only LLM-judged frames may win (lexical-fallback and ungraded rows are structurally ineligible no matter how cheap — the honesty rule), the configurable quality bar and min-savings floor are enforced, a winner must be STRICTLY cheaper, selection is deterministic (max savings, judge-score tiebreak), threshold env parsing falls back sanely, and the TOKEN_CHASE_AUTO_PROMOTE gate is DEFAULT OFF.
 */

import { describe, expect, it } from 'vitest';
import {
  selectWinner,
  readKeepWinnerThresholds,
  isAutoPromoteEnabled,
  DEFAULT_PROMOTE_MIN_SAVINGS_USD,
} from '../../src/features/token-chase/services/token-chase-keep-winner';
import type { DebuggerObservation } from '../../src/features/token-chase/services/token-chase-corpus-service';

/** Builds one persisted observation with sensible defaults, overridable per test. */
function obs(over: Partial<DebuggerObservation>): DebuggerObservation {
  return {
    seq: 1,
    createdAt: '2026-07-24T00:00:00.000Z',
    baselineProvider: 'harness:claude-code-cli',
    baselineModel: 'claude-sonnet-4-6',
    baselineCostUsd: 0.1,
    variantProvider: 'framework:openrouter',
    variantModel: 'llama-3.3-70b:free',
    variantCostUsd: 0.0,
    costDeltaUsd: -0.1,
    latencyMs: 900,
    accuracy: 0.95,
    equivalent: true,
    tier: 'equivalent-cheaper',
    status: 'equivalent',
    queryType: 'summarize',
    harness: 'claude-code',
    judgeScore: 90,
    judgeMode: 'llm',
    ...over,
  };
}

const BAR = { minQuality: 80, minSavingsUsd: 0 };

describe('Token Chase keep-winner selection (the promotion quality bar)', () => {
  it('selects an llm-judged, at/above-bar, strictly-cheaper variant as the winner', () => {
    const { winner, rejected } = selectWinner([obs({})], BAR);
    expect(winner).not.toBeNull();
    expect(winner?.observation.variantModel).toBe('llama-3.3-70b:free');
    expect(winner?.savedUsd).toBeCloseTo(0.1, 6);
    expect(rejected).toHaveLength(0);
  });

  it('NEVER promotes a lexical-fallback-judged frame, no matter how cheap or high-scoring', () => {
    const { winner, rejected } = selectWinner(
      [obs({ judgeMode: 'lexical-fallback', judgeScore: 100, variantCostUsd: 0 })],
      BAR,
    );
    expect(winner).toBeNull();
    expect(rejected[0].reason).toBe('lexical-fallback-judged');
  });

  it('NEVER promotes an ungraded frame (null judge fields)', () => {
    const { winner, rejected } = selectWinner([obs({ judgeMode: null, judgeScore: null })], BAR);
    expect(winner).toBeNull();
    expect(rejected[0].reason).toBe('ungraded');
  });

  it('rejects a frame below the quality bar and accepts one exactly at it', () => {
    const below = selectWinner([obs({ judgeScore: 79 })], BAR);
    expect(below.winner).toBeNull();
    expect(below.rejected[0].reason).toBe('below-quality-bar');
    const atBar = selectWinner([obs({ judgeScore: 80 })], BAR);
    expect(atBar.winner).not.toBeNull();
  });

  it('rejects a variant that is not strictly cheaper (equal or pricier)', () => {
    const equal = selectWinner([obs({ variantCostUsd: 0.1 })], BAR);
    expect(equal.winner).toBeNull();
    expect(equal.rejected[0].reason).toBe('below-min-savings');
    const pricier = selectWinner([obs({ variantCostUsd: 0.2 })], BAR);
    expect(pricier.winner).toBeNull();
    expect(pricier.rejected[0].reason).toBe('below-min-savings');
  });

  it('enforces the min-savings floor on top of strictly-cheaper', () => {
    const { winner, rejected } = selectWinner(
      [obs({ variantCostUsd: 0.095 })], // saves $0.005
      { minQuality: 80, minSavingsUsd: 0.01 },
    );
    expect(winner).toBeNull();
    expect(rejected[0].reason).toBe('below-min-savings');
  });

  it('rejects rows with a missing cost pair or missing variant model', () => {
    const noCost = selectWinner([obs({ baselineCostUsd: null })], BAR);
    expect(noCost.rejected[0].reason).toBe('missing-cost-pair');
    const noModel = selectWinner([obs({ variantModel: null })], BAR);
    expect(noModel.rejected[0].reason).toBe('missing-variant-model');
  });

  it('picks the largest savings, breaking ties on the higher judge score — deterministically', () => {
    const a = obs({ variantModel: 'model-a', variantCostUsd: 0.05, judgeScore: 85 }); // saves .05
    const b = obs({ variantModel: 'model-b', variantCostUsd: 0.01, judgeScore: 82 }); // saves .09 → wins
    const c = obs({ variantModel: 'model-c', variantCostUsd: 0.01, judgeScore: 95 }); // saves .09, higher score → beats b
    expect(selectWinner([a, b], BAR).winner?.observation.variantModel).toBe('model-b');
    expect(selectWinner([a, b, c], BAR).winner?.observation.variantModel).toBe('model-c');
    // Order-independence: same winner regardless of input order.
    expect(selectWinner([c, a, b], BAR).winner?.observation.variantModel).toBe('model-c');
  });
});

describe('keep-winner threshold + auto-mode env knobs', () => {
  it('defaults to the judged-report bar (80) and a zero min-savings floor', () => {
    const t = readKeepWinnerThresholds({} as NodeJS.ProcessEnv);
    expect(t.minQuality).toBe(80);
    expect(t.minSavingsUsd).toBe(DEFAULT_PROMOTE_MIN_SAVINGS_USD);
  });

  it('honors TOKEN_CHASE_PROMOTE_MIN_QUALITY, falls back to TOKEN_CHASE_JUDGE_BAR, rejects garbage', () => {
    expect(readKeepWinnerThresholds({ TOKEN_CHASE_PROMOTE_MIN_QUALITY: '95' } as NodeJS.ProcessEnv).minQuality).toBe(95);
    expect(readKeepWinnerThresholds({ TOKEN_CHASE_JUDGE_BAR: '70' } as NodeJS.ProcessEnv).minQuality).toBe(70);
    expect(readKeepWinnerThresholds({ TOKEN_CHASE_PROMOTE_MIN_QUALITY: '150' } as NodeJS.ProcessEnv).minQuality).toBe(80);
    expect(readKeepWinnerThresholds({ TOKEN_CHASE_PROMOTE_MIN_QUALITY: 'garbage' } as NodeJS.ProcessEnv).minQuality).toBe(80);
  });

  it('honors TOKEN_CHASE_PROMOTE_MIN_SAVINGS_USD and rejects negatives/garbage', () => {
    expect(readKeepWinnerThresholds({ TOKEN_CHASE_PROMOTE_MIN_SAVINGS_USD: '0.02' } as NodeJS.ProcessEnv).minSavingsUsd).toBe(0.02);
    expect(readKeepWinnerThresholds({ TOKEN_CHASE_PROMOTE_MIN_SAVINGS_USD: '-1' } as NodeJS.ProcessEnv).minSavingsUsd).toBe(0);
    expect(readKeepWinnerThresholds({ TOKEN_CHASE_PROMOTE_MIN_SAVINGS_USD: 'nope' } as NodeJS.ProcessEnv).minSavingsUsd).toBe(0);
  });

  it('auto-promote is DEFAULT OFF — only the explicit opt-in values enable it', () => {
    expect(isAutoPromoteEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isAutoPromoteEnabled({ TOKEN_CHASE_AUTO_PROMOTE: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAutoPromoteEnabled({ TOKEN_CHASE_AUTO_PROMOTE: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAutoPromoteEnabled({ TOKEN_CHASE_AUTO_PROMOTE: 'yes' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAutoPromoteEnabled({ TOKEN_CHASE_AUTO_PROMOTE: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAutoPromoteEnabled({ TOKEN_CHASE_AUTO_PROMOTE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAutoPromoteEnabled({ TOKEN_CHASE_AUTO_PROMOTE: ' TRUE ' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAutoPromoteEnabled({ TOKEN_CHASE_AUTO_PROMOTE: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
