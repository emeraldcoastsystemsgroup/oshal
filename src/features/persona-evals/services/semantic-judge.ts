/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Semantic (rubric) judge for persona regression evals. Grades output 0-100 against the assertion's rubric via the injected LLMService — the same judging shape the ADR-063 golden loop uses. Under a noop lane the judge is declared incapable and semantic assertions are SKIPPED with notice; an unparseable judge reply is an ERROR, never a default pass.
 */

import { createChildLogger } from '@/shared/logger';
import type { LLMService } from '@/features/llm-provider';

const logger = createChildLogger({ module: 'persona-eval-semantic-judge' });

/**
 * @description Result of one rubric grading. Exactly one of `score` / `error` is set —
 * ambiguity here would let a broken judge masquerade as a verdict.
 */
export interface RubricGrade {
  /** Judge score 0-100 when grading succeeded. */
  score?: number;
  /** Why the grade could not be produced (judge failed / reply unparseable). */
  error?: string;
}

/**
 * @description Decides whether an execution lane can grade semantic rubric assertions. The
 * noop lane mirrors input back — grading with it would manufacture meaningless scores, so
 * it is declared incapable and semantic assertions are skipped-with-notice instead of judged.
 * @param service - The lane's LLMService.
 * @returns True when the lane is a real LLM that can act as a judge.
 */
export function isSemanticCapable(service: LLMService): boolean {
  const name = service.getProviderName().toLowerCase();
  return !name.includes('noop');
}

/**
 * @description Grades the persona's output against a rubric, 0-100, using the judge lane.
 * Mirrors the ADR-063 golden-loop judge contract: strict QA judge, JSON-only `{"score": n}`
 * reply, robustly extracted. Any failure to obtain a numeric score is returned as an error —
 * the caller records the assertion as ERROR, never as a pass.
 * @param judgeService - A semantic-capable LLMService to act as the judge.
 * @param args - The rubric, the original task prompt (context), and the persona's output.
 * @returns The grade or a descriptive error.
 */
export async function gradeRubric(
  judgeService: LLMService,
  args: { rubric: string; taskPrompt: string; output: string },
): Promise<RubricGrade> {
  const prompt = [
    'You are a strict QA judge for an AI persona regression test. Score how well the RESPONSE',
    'satisfies the RUBRIC, 0-100. 100 = fully satisfies; 0 = entirely fails. Judge ONLY against',
    'the rubric — not style preferences outside it.',
    '',
    `RUBRIC: ${args.rubric}`,
    '',
    'THE TASK THE PERSONA WAS GIVEN:',
    args.taskPrompt.slice(0, 4000),
    '',
    'RESPONSE:',
    args.output.slice(0, 6000),
    '',
    'Reply with ONLY a JSON object: {"score": <0-100>}',
  ].join('\n');

  try {
    const res = await judgeService.sendRequest({
      messages: [{ role: 'user', content: prompt }],
      interactionMode: 'task',
      maxTokens: 200,
    });
    const text = res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    const score = parseJudgeScore(text);
    if (score === null) {
      logger.warn({ reply: text.slice(0, 200) }, 'Semantic judge reply did not contain a parseable score');
      return { error: `judge reply had no parseable {"score": n} (got: "${text.slice(0, 120)}")` };
    }
    return { score };
  } catch (err) {
    logger.error({ err }, 'Semantic judge call failed');
    return { error: `judge call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * @description Extracts a 0-100 score from the judge's reply text. Accepts the strict
 * `{"score": n}` shape anywhere in the reply, clamps to range, and rejects non-numeric output.
 * Exported for unit tests.
 * @param text - The judge's raw reply.
 * @returns Score 0-100, or null when nothing parseable was found.
 */
export function parseJudgeScore(text: string): number | null {
  const m = text.match(/\{[^{}]*"score"[^{}]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { score?: unknown };
    const n = Number(parsed.score);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  } catch {
    return null;
  }
}
