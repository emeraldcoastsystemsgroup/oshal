/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 4 (ADR-046): LLM-judge assessor over graded variant replays. Grades the variant output against the captured baseline via an INJECTED quality grader (the app layer wires @/features/quality-judge's JudgeService.grade in — FSD forbids same-layer feature imports, so the grader arrives as a narrow structural function, same pattern as JudgeBrainInvoker). Rubric = faithfulness to the baseline deliverable + completeness + format contract. Never throws: a failing grader degrades to an HONEST lexical assessment derived from the frame's Jaccard accuracy, flagged mode:'lexical-fallback' so judged and proxy scores are never blended.
 */

import { createChildLogger } from '@/shared/logger';
import type { VariantReplayResult } from './token-chase-optimize-service';

const logger = createChildLogger({ module: 'token-chase-assessor' });

/**
 * @description The token-chase grading rubric (ADR-046 step 4). Each criterion becomes a named
 * dimension in the verdict. Ordered by what a Tier-2 swap actually risks: did the cheaper lane
 * deliver the SAME deliverable (faithfulness), ALL of it (completeness), in the SAME shape the
 * downstream consumer expects (format contract). Exported so tests and the report can key
 * dimensions off the exact criterion strings.
 */
export const TOKEN_CHASE_RUBRIC: readonly string[] = [
  'faithfulness to the baseline deliverable',
  'completeness',
  'format contract',
];

/**
 * @description The grade request the assessor hands the injected grader. Structurally identical to
 * @/features/quality-judge's JudgeGradeInput ON PURPOSE: FSD forbids token-chase (a feature slice)
 * from importing the quality-judge slice directly, so the app layer binds JudgeService.grade and
 * passes it in — the shapes must line up without a nominal import.
 */
export interface AssessorGradeInput {
  /** What the graded output was supposed to accomplish. */
  task: string;
  /** The candidate output being graded (the variant lane's response). */
  output: string;
  /** Rubric criteria — each becomes a named dimension in the verdict. */
  rubric: string[];
  /** The gold/reference answer (the captured baseline response). */
  reference?: string;
}

/**
 * @description The verdict the injected grader returns — structurally identical to
 * @/features/quality-judge's JudgeVerdict (see {@link AssessorGradeInput} for why it is
 * re-declared rather than imported).
 */
export interface AssessorVerdict {
  /** Overall quality score, 0..100. */
  score: number;
  /** Per-rubric-criterion scores, keyed by the exact criterion strings. */
  dimensions: Record<string, number>;
  /** Why the judge scored it this way. */
  rationale: string;
  /** 'llm' = a real judgement; 'lexical-fallback' = deterministic proxy. NEVER blend the two. */
  mode: 'llm' | 'lexical-fallback';
  /** LLM attempts consumed (0 on the lexical lane). */
  attempts: number;
}

/**
 * @description The injected grading function. The app layer wires this to
 * `JudgeService.grade` (quality-judge concierge → chat_tasks cost capture); tests inject a fake
 * with zero LLM cost. It must follow the JudgeService contract: never throw, always return a
 * validated verdict — but the assessor still guards against a misbehaving injection.
 * @param input - The grade request.
 * @returns The validated verdict.
 */
export type QualityGrader = (input: AssessorGradeInput) => Promise<AssessorVerdict>;

/**
 * @description One frame's judged quality assessment — the step-4 shape persisted into the
 * optimizer corpus alongside the existing Jaccard grade (which stays as the comparison column).
 * `mode` is part of the contract so the savings report can keep llm-judged and lexical-fallback
 * numbers separate (the honesty rule).
 */
export interface JudgeAssessment {
  /** Stable frame identity: `${runId}#${seq}`. */
  frameId: string;
  runId: string;
  seq: number;
  /** The variant lane label the graded output came from (null when the result carried none). */
  variantLabel: string | null;
  /** Overall judge score, 0..100. */
  judgeScore: number;
  /** Per-rubric-criterion scores keyed by the TOKEN_CHASE_RUBRIC strings. */
  dimensions: Record<string, number>;
  /** Which lane produced the score — llm judgement vs deterministic lexical proxy. */
  mode: 'llm' | 'lexical-fallback';
  /** The judge's (or fallback's) justification. */
  rationale: string;
  /** The existing Jaccard accuracy for the same frame, kept as the comparison column. */
  jaccardAccuracy: number | null;
}

/**
 * @description Builds the stable frame identity used across the corpus and the report.
 * @param runId - The captured run id.
 * @param seq - The call sequence within the run.
 * @returns `${runId}#${seq}`.
 */
export function frameIdOf(runId: string, seq: number): string {
  return `${runId}#${seq}`;
}

/**
 * @description Builds the task statement the judge grades against. The replay result does not
 * carry the original prompt (frames store it; results carry previews), so the task anchors on the
 * captured call's coarse descriptors + the explicit goal — reproduce the baseline deliverable.
 * The reference answer (the baseline itself) does the heavy anchoring in both judge lanes.
 * @param result - The graded variant replay result.
 * @returns The task text for the grade request.
 */
function buildTask(result: VariantReplayResult): string {
  const kind = result.meta.queryType ?? 'unclassified';
  const harness = result.meta.harness ?? 'unknown harness';
  return [
    `Reproduce the captured baseline deliverable for run ${result.runId}, call #${result.seq}`,
    `(query type: ${kind}, baseline harness: ${harness}, complexity: ${result.meta.complexity}).`,
    'The output must carry the same facts, conclusions, and actionable content as the reference',
    'baseline, cover everything the baseline covers, and keep the same structural format',
    '(sections, lists, code blocks, JSON shape) so downstream consumers are unaffected.',
  ].join(' ');
}

/**
 * @description The honest degradation when the injected grader itself fails (it should never
 * throw, but the assessor must not let a misbehaving injection break persistence): derive a
 * deterministic assessment from the frame's existing Jaccard accuracy, flagged
 * `mode:'lexical-fallback'` so it can never masquerade as a judgement.
 * @param result - The graded variant replay result.
 * @param reason - Why the grader lane failed (surfaced verbatim in the rationale).
 * @returns The lexical-proxy assessment.
 */
function lexicalAssessment(result: VariantReplayResult, reason: string): JudgeAssessment {
  const accuracy = result.diff?.accuracy ?? null;
  const score = accuracy == null ? 0 : Math.min(100, Math.max(0, Math.round(accuracy * 100)));
  const dimensions: Record<string, number> = {};
  for (const criterion of TOKEN_CHASE_RUBRIC) dimensions[criterion] = score;
  return {
    frameId: frameIdOf(result.runId, result.seq),
    runId: result.runId,
    seq: result.seq,
    variantLabel: result.variant?.label ?? null,
    judgeScore: score,
    dimensions,
    mode: 'lexical-fallback',
    rationale: `Deterministic lexical proxy (${reason}): score = Jaccard similarity of the variant output to the captured baseline (${accuracy ?? 'unknown'}), applied uniformly to every rubric dimension. This is NOT a semantic judgement.`,
    jaccardAccuracy: accuracy,
  };
}

/**
 * @description Token Chase step 4: grade one variant replay's output against its captured
 * baseline via the injected quality grader (JudgeService.grade at runtime). Ungraded results
 * (excluded/errored frames with no variant output or no baseline) return null — there is nothing
 * to judge. Never throws; a failing grader degrades to {@link lexicalAssessment}.
 * @param grade - The injected grader (see {@link QualityGrader}).
 * @param result - The variant replay result to assess.
 * @returns The judged assessment, or null when the result carries nothing gradeable.
 */
export async function assessVariantQuality(
  grade: QualityGrader,
  result: VariantReplayResult,
): Promise<JudgeAssessment | null> {
  if (!result.variant || !result.baseline || !result.diff) return null;
  const started = Date.now();
  try {
    const verdict = await grade({
      task: buildTask(result),
      output: result.variant.preview,
      rubric: [...TOKEN_CHASE_RUBRIC],
      reference: result.baseline.preview,
    });
    logger.info(
      { runId: result.runId, seq: result.seq, mode: verdict.mode, score: verdict.score, durationMs: Date.now() - started },
      'Variant quality assessed',
    );
    return {
      frameId: frameIdOf(result.runId, result.seq),
      runId: result.runId,
      seq: result.seq,
      variantLabel: result.variant.label ?? null,
      judgeScore: verdict.score,
      dimensions: verdict.dimensions,
      mode: verdict.mode,
      rationale: verdict.rationale,
      jaccardAccuracy: result.diff.accuracy,
    };
  } catch (err) {
    logger.error(
      { err, stack: (err as Error)?.stack, runId: result.runId, seq: result.seq },
      'Injected quality grader threw — degrading to the lexical proxy assessment',
    );
    return lexicalAssessment(result, 'grader invocation failed');
  }
}
