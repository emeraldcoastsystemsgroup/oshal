/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the shared quality-judge grading service: robust JSON extraction, rubric-dimension mapping (exact/case/slug + missing-fill), the deterministic lexical fallback lane (noop provider, no invoker, invoke error, twice-malformed), the one-retry contract, and route body validation. Zero LLM cost — the brain is a fake invoker.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix coverage: degraded fallback verdicts now report the REAL LLM attempts consumed — assert attempts:2 after twice-malformed, attempts:1 after a first-invocation throw, and attempts:0 only when the lexical lane ran directly.
 */

import { describe, expect, it } from 'vitest';
import {
  JudgeService,
  buildJudgePrompt,
  clampScore,
  extractJudgeJson,
  jaccardSimilarity,
  lexicalFallbackGrade,
  mapRubricDimensions,
  validateLlmVerdict,
  type JudgeGradeInput,
} from '../../src/features/quality-judge';
import { parseGradeBody } from '../../src/app/routes/judge-routes';

const INPUT: JudgeGradeInput = {
  task: 'Summarize the incident report',
  output: 'The database ran out of disk space causing the outage.',
  rubric: ['Factual Accuracy', 'Completeness'],
};

describe('quality-judge JSON extraction', () => {
  it('parses a bare JSON verdict', () => {
    const o = extractJudgeJson('{"score": 88, "dimensions": {}, "rationale": "solid"}');
    expect(o).toMatchObject({ score: 88, rationale: 'solid' });
  });

  it('parses a fenced verdict wrapped in prose', () => {
    const text = 'Here is my grade:\n```json\n{"score": 42, "dimensions": {"Factual Accuracy": 40}, "rationale": "gaps"}\n```\nHope that helps!';
    const o = extractJudgeJson(text);
    expect(o).toMatchObject({ score: 42 });
    expect((o!.dimensions as any)['Factual Accuracy']).toBe(40);
  });

  it('returns null for prose, arrays, and malformed JSON', () => {
    expect(extractJudgeJson('I would give this a 7/10.')).toBeNull();
    expect(extractJudgeJson('[1,2,3]')).toBeNull();
    expect(extractJudgeJson('{"score": 88,')).toBeNull();
    expect(extractJudgeJson('')).toBeNull();
  });

  it('clamps scores into 0..100 integers and rejects non-numbers', () => {
    expect(clampScore(105)).toBe(100);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(87.6)).toBe(88);
    expect(clampScore('73')).toBe(73);
    expect(clampScore('high')).toBeNull();
    expect(clampScore(undefined)).toBeNull();
  });
});

describe('quality-judge rubric dimension mapping', () => {
  it('maps exact, case-insensitive, and slugified keys back to the verbatim rubric', () => {
    const dims = mapRubricDimensions(
      ['Factual Accuracy', 'Completeness', 'Tone'],
      { 'Factual Accuracy': 90, completeness: 70, tone: 55 },
      60,
    );
    expect(dims).toEqual({ 'Factual Accuracy': 90, Completeness: 70, Tone: 55 });
  });

  it('maps snake_case model keys onto spaced rubric criteria', () => {
    const dims = mapRubricDimensions(['Factual Accuracy'], { factual_accuracy: 81 }, 50);
    expect(dims).toEqual({ 'Factual Accuracy': 81 });
  });

  it('fills criteria the model skipped with the overall score and survives garbage', () => {
    expect(mapRubricDimensions(['A', 'B'], { A: 90 }, 66)).toEqual({ A: 90, B: 66 });
    expect(mapRubricDimensions(['A'], 'not-an-object', 40)).toEqual({ A: 40 });
    expect(mapRubricDimensions(['A'], { A: 'excellent' }, 40)).toEqual({ A: 40 });
  });

  it('validateLlmVerdict repairs trimmings but rejects a missing score', () => {
    const ok = validateLlmVerdict({ score: 77, dimensions: { a: 70 }, rationale: '' }, ['a'], 1);
    expect(ok).toMatchObject({ score: 77, mode: 'llm', attempts: 1, dimensions: { a: 70 } });
    expect(ok!.rationale.length).toBeGreaterThan(0);
    expect(validateLlmVerdict({ dimensions: {}, rationale: 'no score' }, ['a'], 1)).toBeNull();
    expect(validateLlmVerdict(null, ['a'], 1)).toBeNull();
  });
});

describe('quality-judge lexical fallback lane', () => {
  it('scores identical output/reference as 100 via the Jaccard proxy', () => {
    const v = lexicalFallbackGrade({ ...INPUT, reference: INPUT.output }, 'test');
    expect(v.mode).toBe('lexical-fallback');
    expect(v.score).toBe(100);
    expect(v.attempts).toBe(0);
    expect(v.rationale).toContain('lexical');
  });

  it('scores disjoint output/reference as 0 and keys dimensions off the rubric verbatim', () => {
    const v = lexicalFallbackGrade({ task: 't', output: 'alpha beta', rubric: ['gamma delta'], reference: 'epsilon zeta' }, 'test');
    expect(v.score).toBe(0);
    expect(Object.keys(v.dimensions)).toEqual(['gamma delta']);
    expect(v.dimensions['gamma delta']).toBe(0);
  });

  it('without a reference the overall score is the mean of criterion coverages', () => {
    const v = lexicalFallbackGrade(
      { task: 't', output: 'the database disk space outage', rubric: ['database disk', 'network latency'] },
      'test',
    );
    expect(v.dimensions['database disk']).toBe(100); // both tokens present
    expect(v.dimensions['network latency']).toBe(0); // neither token present
    expect(v.score).toBe(50);
  });

  it('jaccardSimilarity matches the token-chase proxy contract (empty sets identical)', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 6);
  });
});

describe('JudgeService lane selection + retry', () => {
  it('takes the lexical lane when FORCE_LLM_PROVIDER=noop without touching the invoker', async () => {
    let calls = 0;
    const judge = new JudgeService({ invoker: async () => { calls += 1; return '{"score":99}'; }, forceProvider: 'noop' });
    const v = await judge.grade(INPUT);
    expect(v.mode).toBe('lexical-fallback');
    expect(calls).toBe(0);
  });

  it('takes the lexical lane when no invoker is wired (bot unavailable)', async () => {
    const judge = new JudgeService({ invoker: null, forceProvider: 'claude-code' });
    const v = await judge.grade(INPUT);
    expect(v.mode).toBe('lexical-fallback');
    expect(v.rationale).toContain('unavailable');
  });

  it('returns a validated llm verdict on a clean first reply', async () => {
    const judge = new JudgeService({
      forceProvider: 'claude-code',
      invoker: async () => '```json\n{"score": 84, "dimensions": {"factual_accuracy": 90, "Completeness": 78}, "rationale": "Accurate root cause; missing timeline."}\n```',
    });
    const v = await judge.grade(INPUT);
    expect(v).toMatchObject({
      mode: 'llm',
      score: 84,
      attempts: 1,
      dimensions: { 'Factual Accuracy': 90, Completeness: 78 },
    });
  });

  it('retries exactly once on malformed output and succeeds on the corrective attempt', async () => {
    const prompts: string[] = [];
    const replies = ['Sorry, I would rate it quite highly!', '{"score": 61, "dimensions": {}, "rationale": "ok"}'];
    const judge = new JudgeService({
      forceProvider: 'claude-code',
      invoker: async (_taskId, prompt) => { prompts.push(prompt); return replies[prompts.length - 1]; },
    });
    const v = await judge.grade(INPUT);
    expect(v).toMatchObject({ mode: 'llm', score: 61, attempts: 2 });
    // Every skipped dimension inherits the overall score.
    expect(v.dimensions).toEqual({ 'Factual Accuracy': 61, Completeness: 61 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('attempt 2 of 2');
  });

  it('falls back lexically (flagged) after two malformed replies, reporting BOTH consumed attempts', async () => {
    let calls = 0;
    const judge = new JudgeService({ forceProvider: 'claude-code', invoker: async () => { calls += 1; return 'not json'; } });
    const v = await judge.grade(INPUT);
    expect(calls).toBe(2);
    expect(v.mode).toBe('lexical-fallback');
    expect(v.attempts).toBe(2); // 2 real LLM calls were billed — the verdict must not report 0
    expect(v.rationale).toContain('malformed');
  });

  it('falls back lexically (flagged) when the bot invocation throws, counting the started attempt', async () => {
    const judge = new JudgeService({ forceProvider: 'claude-code', invoker: async () => { throw new Error('bot down'); } });
    const v = await judge.grade(INPUT);
    expect(v.mode).toBe('lexical-fallback');
    expect(v.attempts).toBe(1); // first invocation was started before the throw
    expect(v.rationale).toContain('invocation failed');
  });

  it('reports attempts:2 when the corrective retry itself throws', async () => {
    let calls = 0;
    const judge = new JudgeService({
      forceProvider: 'claude-code',
      invoker: async () => { calls += 1; if (calls === 2) throw new Error('bot down'); return 'not json'; },
    });
    const v = await judge.grade(INPUT);
    expect(v.mode).toBe('lexical-fallback');
    expect(v.attempts).toBe(2);
  });

  it('buildJudgePrompt pins the pure-JSON contract, rubric, and reference', () => {
    const p = buildJudgePrompt({ ...INPUT, reference: 'Disk exhaustion took the DB down.' });
    expect(p).toContain('ONLY one JSON object');
    expect(p).toContain('1. Factual Accuracy');
    expect(p).toContain('2. Completeness');
    expect(p).toContain('REFERENCE ANSWER');
    expect(buildJudgePrompt(INPUT)).not.toContain('REFERENCE ANSWER');
  });
});

describe('POST /api/judge body validation', () => {
  it('accepts a well-formed body and strips a blank reference', () => {
    const ok = parseGradeBody({ task: 't', output: 'o', rubric: ['a'], reference: '   ' });
    expect(ok.error).toBeUndefined();
    expect(ok.input).toEqual({ task: 't', output: 'o', rubric: ['a'] });
  });

  it('rejects a missing task/output, empty rubric, and non-string criteria', () => {
    expect(parseGradeBody({ output: 'o', rubric: ['a'] }).error).toContain('task');
    expect(parseGradeBody({ task: 't', rubric: ['a'] }).error).toContain('output');
    expect(parseGradeBody({ task: 't', output: 'o', rubric: [] }).error).toContain('rubric');
    expect(parseGradeBody({ task: 't', output: 'o', rubric: ['a', 7] }).error).toContain('rubric');
    expect(parseGradeBody({ task: 't', output: 'o', rubric: ['a'], reference: 9 }).error).toContain('reference');
  });
});
