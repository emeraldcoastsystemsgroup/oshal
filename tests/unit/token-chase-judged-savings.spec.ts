/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 4b unit tests: judged savings aggregation math over mock corpus rows — per-lane totals, the llm-verified vs lexical-proxy separation (the honesty rule, structurally), threshold behavior, pricier-swap non-banking, ungraded handling, and the empty-corpus shape.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateJudgedSavings,
  DEFAULT_JUDGE_QUALITY_BAR,
  type JudgedSavingsRow,
} from '../../src/features/token-chase/services/token-chase-judged-savings';

const row = (overrides: Partial<JudgedSavingsRow>): JudgedSavingsRow => ({
  baselineCostUsd: 0.10,
  variantCostUsd: 0.02,
  provider: 'ollama',
  model: 'llama3',
  judgeScore: 90,
  judgeMode: 'llm',
  ...overrides,
});

describe('token-chase judged savings aggregation (step 4b)', () => {
  it('separates llm-verified savings from lexical-proxy savings — never blended', () => {
    const rows: JudgedSavingsRow[] = [
      row({}),                                                     // llm, held → verified $0.08
      row({ judgeScore: 85, judgeMode: 'lexical-fallback' }),      // proxy, held → proxy $0.08, NOT verified
      row({ judgeScore: 40 }),                                     // llm, below bar → nothing banked
      row({ judgeScore: null, judgeMode: null }),                  // pre-step-4 row → ungraded
    ];
    const rep = aggregateJudgedSavings(rows, DEFAULT_JUDGE_QUALITY_BAR, 'all');

    expect(rep.observations).toBe(4);
    expect(rep.verifiedSavedUsd).toBeCloseTo(0.08, 6);   // ONLY the held llm frame
    expect(rep.verifiedFrames).toBe(1);
    expect(rep.lexicalProxySavedUsd).toBeCloseTo(0.08, 6); // proxy kept apart
    expect(rep.lexicalProxyFrames).toBe(1);
    expect(rep.ungradedFrames).toBe(1);
    // The raw total is context only: 4 frames × ($0.10 − $0.02).
    expect(rep.totals.baselineCostUsd).toBeCloseTo(0.40, 6);
    expect(rep.totals.variantCostUsd).toBeCloseTo(0.08, 6);
    expect(rep.totals.savedUsd).toBeCloseTo(0.32, 6);
    expect(rep.totals.savedPct).toBe(80);
  });

  it('applies the configurable quality bar (>= threshold counts as held)', () => {
    const rows = [row({ judgeScore: 80 }), row({ judgeScore: 79 })];

    const at80 = aggregateJudgedSavings(rows, 80, 'all');
    expect(at80.verifiedFrames).toBe(1); // exactly-at-bar holds
    expect(at80.verifiedSavedUsd).toBeCloseTo(0.08, 6);
    expect(at80.threshold).toBe(80);

    const at60 = aggregateJudgedSavings(rows, 60, 'all');
    expect(at60.verifiedFrames).toBe(2);
    expect(at60.verifiedSavedUsd).toBeCloseTo(0.16, 6);
  });

  it('never banks a pricier swap, even when quality held', () => {
    const rep = aggregateJudgedSavings(
      [row({ baselineCostUsd: 0.02, variantCostUsd: 0.05, judgeScore: 100 })],
      80,
      'all',
    );
    expect(rep.verifiedFrames).toBe(1);        // held the bar…
    expect(rep.verifiedSavedUsd).toBe(0);      // …but nothing saved to bank
    expect(rep.totals.savedUsd).toBeCloseTo(-0.03, 6);
  });

  it('groups by provider/model lane with per-lane math, largest baseline spend first', () => {
    const rows: JudgedSavingsRow[] = [
      row({}), row({}),                                                   // ollama/llama3: 2 frames
      row({ provider: 'openai-codex', model: 'gpt-5', baselineCostUsd: 0.50, variantCostUsd: 0.10 }),
      row({ provider: null, model: null, judgeScore: null, judgeMode: null, baselineCostUsd: null, variantCostUsd: null }),
    ];
    const rep = aggregateJudgedSavings(rows, 80, 'run', 'run-9');

    expect(rep.scope).toBe('run');
    expect(rep.runId).toBe('run-9');
    expect(rep.lanes.map((l) => l.lane)).toEqual(['openai-codex / gpt-5', 'ollama / llama3', 'unknown / unknown']);

    const gpt = rep.lanes[0];
    expect(gpt.frames).toBe(1);
    expect(gpt.savedUsd).toBeCloseTo(0.40, 6);
    expect(gpt.savedPct).toBe(80);
    expect(gpt.llm).toMatchObject({ frames: 1, qualityHeld: 1 });
    expect(gpt.llm.heldSavedUsd).toBeCloseTo(0.40, 6);
    expect(gpt.llm.heldSavedPct).toBe(80);

    const llama = rep.lanes[1];
    expect(llama.frames).toBe(2);
    expect(llama.baselineCostUsd).toBeCloseTo(0.20, 6);
    expect(llama.llm.heldSavedUsd).toBeCloseTo(0.16, 6);

    const unknown = rep.lanes[2];
    expect(unknown.ungraded).toBe(1);
    expect(unknown.savedPct).toBeNull(); // zero baseline — no percent claim
  });

  it('returns an all-zero report for an empty corpus', () => {
    const rep = aggregateJudgedSavings([], DEFAULT_JUDGE_QUALITY_BAR, 'all');
    expect(rep).toMatchObject({
      scope: 'all',
      observations: 0,
      verifiedSavedUsd: 0,
      verifiedFrames: 0,
      lexicalProxySavedUsd: 0,
      lexicalProxyFrames: 0,
      ungradedFrames: 0,
      currency: 'USD',
    });
    expect(rep.lanes).toEqual([]);
    expect(rep.totals).toEqual({ baselineCostUsd: 0, variantCostUsd: 0, savedUsd: 0, savedPct: null });
    expect(rep.runId).toBeUndefined();
  });
});
