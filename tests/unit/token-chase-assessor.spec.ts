/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 4 unit tests: assessor grade-input contract (rubric/reference/output), verdict→assessment mapping, honest lexical degradation on a throwing grader, and the corpus persistence shape (judge columns present with an assessment, NULL without — additive, older callers unchanged).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  assessVariantQuality,
  frameIdOf,
  TOKEN_CHASE_RUBRIC,
  type AssessorGradeInput,
  type AssessorVerdict,
  type JudgeAssessment,
} from '../../src/features/token-chase/services/token-chase-assessor';
import { recordOptimizerObservation } from '../../src/features/token-chase/services/token-chase-corpus-service';
import type { VariantReplayResult } from '../../src/features/token-chase/services/token-chase-optimize-service';

/** A fully-graded variant replay result (equivalent-cheaper swap) for assessor tests. */
function gradedResult(overrides: Partial<VariantReplayResult> = {}): VariantReplayResult {
  return {
    runId: 'run-7',
    seq: 3,
    status: 'equivalent',
    reason: null,
    baseline: {
      label: 'baseline', model: 'claude-sonnet-4-6', provider: 'harness:claude-code-cli',
      tokensIn: 1000, tokensOut: 200, costUsd: 0.1, costEstimated: false, latencyMs: 1500,
      preview: 'The root cause is a failed disk on node three.',
    },
    variant: {
      label: 'cheap lane', model: 'llama3', provider: 'ollama',
      tokensIn: 1000, tokensOut: 190, costUsd: 0.0, costEstimated: false, latencyMs: 700,
      preview: 'Root cause: failed disk on node three.',
    },
    diff: { costDeltaUsd: -0.1, costPct: -100, latencyDeltaMs: -800, accuracy: 0.62, equivalent: false },
    tier: 'equivalent-cheaper',
    meta: { queryType: 'incident-rca', complexity: 'medium', harness: 'harness:claude-code-cli', tools: [] },
    ...overrides,
  } as VariantReplayResult;
}

describe('token-chase assessor (step 4)', () => {
  it('grades the variant against the baseline with the token-chase rubric', async () => {
    let seen: AssessorGradeInput | null = null;
    const grader = async (input: AssessorGradeInput): Promise<AssessorVerdict> => {
      seen = input;
      return {
        score: 91,
        dimensions: {
          'faithfulness to the baseline deliverable': 95,
          'completeness': 90,
          'format contract': 88,
        },
        rationale: 'Same conclusion, terser format.',
        mode: 'llm',
        attempts: 1,
      };
    };

    const result = gradedResult();
    const assessment = await assessVariantQuality(grader, result);

    // The grade input contract: variant output graded against the baseline reference.
    expect(seen).not.toBeNull();
    expect(seen!.output).toBe(result.variant!.preview);
    expect(seen!.reference).toBe(result.baseline!.preview);
    expect(seen!.rubric).toEqual([...TOKEN_CHASE_RUBRIC]);
    expect(seen!.task).toContain('run-7');
    expect(seen!.task).toContain('incident-rca');

    // The persisted step-4 shape.
    expect(assessment).toMatchObject({
      frameId: 'run-7#3',
      runId: 'run-7',
      seq: 3,
      variantLabel: 'cheap lane',
      judgeScore: 91,
      mode: 'llm',
      jaccardAccuracy: 0.62,
    });
    expect(assessment!.dimensions['completeness']).toBe(90);
    expect(frameIdOf('run-7', 3)).toBe('run-7#3');
  });

  it('returns null for an ungraded result (nothing to judge)', async () => {
    const grader = vi.fn();
    const ungraded = gradedResult({ variant: null, diff: null, tier: null });
    expect(await assessVariantQuality(grader as never, ungraded)).toBeNull();
    expect(grader).not.toHaveBeenCalled();
  });

  it('degrades HONESTLY to a lexical-fallback assessment when the grader throws', async () => {
    const grader = async (): Promise<AssessorVerdict> => { throw new Error('judge exploded'); };
    const assessment = await assessVariantQuality(grader, gradedResult());

    expect(assessment).not.toBeNull();
    expect(assessment!.mode).toBe('lexical-fallback'); // never masquerades as an llm judgement
    expect(assessment!.judgeScore).toBe(62);           // round(jaccard 0.62 * 100)
    expect(assessment!.jaccardAccuracy).toBe(0.62);
    for (const criterion of TOKEN_CHASE_RUBRIC) {
      expect(assessment!.dimensions[criterion]).toBe(62);
    }
    expect(assessment!.rationale).toContain('NOT a semantic judgement');
  });
});

describe('corpus persistence shape (step 4, additive)', () => {
  /** Captures every SQL call; the INSERT is the one whose params we assert on. */
  function mockPool() {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    return {
      calls,
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      }),
    };
  }

  const insertOf = (calls: Array<{ sql: string; params?: unknown[] }>) =>
    calls.find((c) => c.sql.trim().toUpperCase().startsWith('INSERT'));

  it('persists judgeScore, dimensions JSON, and mode alongside the Jaccard grade', async () => {
    const pool = mockPool();
    const result = gradedResult();
    const assessment: JudgeAssessment = {
      frameId: 'run-7#3', runId: 'run-7', seq: 3, variantLabel: 'cheap lane',
      judgeScore: 91,
      dimensions: { 'faithfulness to the baseline deliverable': 95, 'completeness': 90, 'format contract': 88 },
      mode: 'llm',
      rationale: 'Same conclusion.',
      jaccardAccuracy: 0.62,
    };

    await recordOptimizerObservation(pool, 'user-1', result, assessment);

    const insert = insertOf(pool.calls);
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('judge_score');
    expect(insert!.sql).toContain('judge_dimensions');
    expect(insert!.sql).toContain('judge_mode');
    const p = insert!.params!;
    expect(p).toHaveLength(22);
    expect(p[19]).toBe(91);                                   // judge_score
    expect(JSON.parse(String(p[20]))).toEqual(assessment.dimensions); // judge_dimensions JSONB
    expect(p[21]).toBe('llm');                                // judge_mode
    // The lexical Jaccard grade stays as the comparison column ($14 = accuracy).
    expect(p[13]).toBe(0.62);
  });

  it('leaves the judge columns NULL when no assessment is supplied (older callers unchanged)', async () => {
    const pool = mockPool();
    await recordOptimizerObservation(pool, 'user-1', gradedResult());

    const insert = insertOf(pool.calls);
    expect(insert).toBeDefined();
    const p = insert!.params!;
    expect(p).toHaveLength(22);
    expect(p[19]).toBeNull();
    expect(p[20]).toBeNull();
    expect(p[21]).toBeNull();
  });
});
