/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard-per-fix for the RCA no-mock remediation: the engine must NEVER emit the old placeholder shape (category 'pending', likelihood 0, confidence 0.1 — the mock signature the 2026-07-18 sweep flagged). Proves: a real bot verdict parses through verbatim (including prose-wrapped JSON), a failed dispatch / non-JSON / invalid-shape verdict raises RcaEngineUnavailableError instead of degrading to fake results, RCA_ENGINE_MODE=disabled raises RcaEngineDisabledError, and numeric fields clamp to [0,1].
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  RcaEngine,
  RcaEngineDisabledError,
  RcaEngineUnavailableError,
} from '../../src/features/rca-analysis/services/rca-engine';
import type { RcaAnalysisRequest, RcaAnalysisResult } from '../../src/shared/types';

const REQUEST: RcaAnalysisRequest = {
  incidentId: 'INC-1001',
  description: 'API pods crash-looping after the 14:00 deploy',
  method: 'five-whys',
};

const VALID_VERDICT = JSON.stringify({
  rootCauses: [
    {
      description: 'Deploy shipped a migration that renamed a column the old pods still query',
      category: 'process',
      likelihood: 0.85,
      evidence: ['why-1: pods crash on SELECT', 'why-2: column missing', 'why-3: migration not backward-compatible'],
    },
  ],
  recommendations: [
    { action: 'Adopt expand-contract migrations', priority: 'high', estimatedEffort: '1 sprint', expectedImpact: 'Zero-downtime deploys' },
  ],
  confidence: 0.8,
});

/** The retired mock signature: any result matching this means the stub returned. */
function isPlaceholderShape(result: RcaAnalysisResult): boolean {
  return result.rootCauses.some(
    (c) => c.category === 'pending' || /analysis pending for:/i.test(c.description),
  ) || (result.confidence === 0.1 && result.rootCauses.every((c) => c.likelihood === 0));
}

afterEach(() => {
  delete process.env.RCA_ENGINE_MODE;
});

describe('RcaEngine (no-mock remediation guard)', () => {
  it('returns the bot verdict verbatim — never the placeholder shape', async () => {
    const engine = new RcaEngine(async () => VALID_VERDICT);
    const result = await engine.analyze(REQUEST);
    expect(result.rootCauses).toHaveLength(1);
    expect(result.rootCauses[0].category).toBe('process');
    expect(result.rootCauses[0].likelihood).toBeCloseTo(0.85);
    expect(result.confidence).toBeCloseTo(0.8);
    expect(isPlaceholderShape(result)).toBe(false);
  });

  it('parses a verdict wrapped in prose (bots sometimes narrate around the JSON)', async () => {
    const engine = new RcaEngine(async () => `Here is my analysis:\n${VALID_VERDICT}\nLet me know if you need more.`);
    const result = await engine.analyze(REQUEST);
    expect(result.rootCauses[0].description).toMatch(/migration/);
    expect(isPlaceholderShape(result)).toBe(false);
  });

  it('raises RcaEngineUnavailableError when the bot dispatch fails — no fake fallback', async () => {
    const engine = new RcaEngine(async () => {
      throw new Error('Bot node returned 502: upstream unreachable');
    });
    await expect(engine.analyze(REQUEST)).rejects.toBeInstanceOf(RcaEngineUnavailableError);
  });

  it('raises RcaEngineUnavailableError on a non-JSON verdict — no fake fallback', async () => {
    const engine = new RcaEngine(async () => 'I could not complete the analysis, sorry.');
    await expect(engine.analyze(REQUEST)).rejects.toBeInstanceOf(RcaEngineUnavailableError);
  });

  it('raises RcaEngineUnavailableError on valid JSON with no usable rootCauses — no fake fallback', async () => {
    const engine = new RcaEngine(async () => JSON.stringify({ rootCauses: [], recommendations: [], confidence: 0.9 }));
    await expect(engine.analyze(REQUEST)).rejects.toBeInstanceOf(RcaEngineUnavailableError);
  });

  it('raises RcaEngineUnavailableError when constructed without an executor', async () => {
    const engine = new RcaEngine();
    await expect(engine.analyze(REQUEST)).rejects.toBeInstanceOf(RcaEngineUnavailableError);
  });

  it('raises RcaEngineDisabledError under RCA_ENGINE_MODE=disabled', async () => {
    process.env.RCA_ENGINE_MODE = 'disabled';
    const engine = new RcaEngine(async () => VALID_VERDICT);
    await expect(engine.analyze(REQUEST)).rejects.toBeInstanceOf(RcaEngineDisabledError);
  });

  it('clamps out-of-range likelihood/confidence into [0,1] and defaults junk recommendation fields', async () => {
    const engine = new RcaEngine(async () => JSON.stringify({
      rootCauses: [{ description: 'Overloaded queue', category: 'technology', likelihood: 7, evidence: 'not-an-array' }],
      recommendations: [{ action: 'Scale consumers', priority: 'urgent!!' }],
      confidence: -3,
    }));
    const result = await engine.analyze(REQUEST);
    expect(result.rootCauses[0].likelihood).toBe(1);
    expect(result.rootCauses[0].evidence).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.recommendations[0].priority).toBe('medium');
    expect(result.recommendations[0].estimatedEffort).toBe('unknown');
  });

  it('supports all three methods with method-specific prompts', async () => {
    const prompts: string[] = [];
    const engine = new RcaEngine(async (prompt) => {
      prompts.push(prompt);
      return VALID_VERDICT;
    });
    await engine.analyze({ ...REQUEST, method: 'five-whys' });
    await engine.analyze({ ...REQUEST, method: 'fishbone' });
    await engine.analyze({ ...REQUEST, method: 'fault-tree' });
    expect(prompts[0]).toMatch(/Five Whys/i);
    expect(prompts[1]).toMatch(/Ishikawa/i);
    expect(prompts[2]).toMatch(/Fault Tree/i);
    // Every prompt demands strict JSON so the parser stays deterministic.
    for (const p of prompts) expect(p).toMatch(/ONLY a single JSON object/);
  });
});
