/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared LLM-judge verdict primitives: grade input/verdict types, robust JSON extraction, rubric-dimension mapping, the judge prompt, and the deterministic lexical fallback lane (Jaccard proxy borrowed from token-chase's determinism-verdict — duplicated, not imported, because FSD forbids same-layer cross-slice imports). Pure functions only so the whole contract is unit-testable with zero LLM cost.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: lexicalFallbackGrade takes attemptsConsumed so verdicts degraded AFTER real LLM invocations (twice-malformed / mid-retry throw) report the true attempt count instead of a hardcoded 0 — verdict.attempts previously undercounted judge spend/retry rate on those paths.
 */

/**
 * @description The input contract for one grading request. Consumers (the /api/judge route,
 * token-chase optimizer step 4, persona evals) all speak this shape so there is exactly ONE
 * grading service on the platform instead of per-consumer ad-hoc judges.
 */
export interface JudgeGradeInput {
  /** What the graded output was supposed to accomplish (the original task/prompt). */
  task: string;
  /** The candidate output being graded. */
  output: string;
  /** Rubric criteria — each becomes a named dimension in the verdict. */
  rubric: string[];
  /** Optional gold/reference answer; when present it anchors both lanes' scoring. */
  reference?: string;
}

/**
 * @description Which lane produced the verdict. `llm` = the quality-judge concierge bot graded
 * it; `lexical-fallback` = the deterministic Jaccard proxy ran because the LLM lane was
 * unavailable (FORCE_LLM_PROVIDER=noop, bot unreachable, or twice-malformed output). Consumers
 * and tests MUST be able to tell the lanes apart, so the flag is part of the contract.
 */
export type JudgeMode = 'llm' | 'lexical-fallback';

/**
 * @description A validated grading verdict. Scores are always integers clamped to 0..100 and
 * `dimensions` always carries exactly one entry per rubric criterion (mapped from whatever keys
 * the model actually emitted), so downstream aggregation never has to defend against a
 * free-form judge reply.
 */
export interface JudgeVerdict {
  /** Overall quality score, 0..100. */
  score: number;
  /** Per-rubric-criterion scores, keyed by the EXACT criterion strings from the input. */
  dimensions: Record<string, number>;
  /** Why the judge scored it this way (or how the fallback computed it). */
  rationale: string;
  /** Which lane produced this verdict — see {@link JudgeMode}. */
  mode: JudgeMode;
  /**
   * How many LLM attempts were consumed producing (or attempting to produce) this verdict.
   * 0 when the lexical lane ran directly (noop provider / no invoker); on degraded fallbacks
   * it still counts the real LLM invocations burned before degrading (e.g. 2 after a
   * twice-malformed reply), so spend/retry auditing off this field stays accurate.
   */
  attempts: number;
}

/**
 * @description Clamp any candidate score into the 0..100 integer contract. Non-finite input
 * (the model emitted "high"/null/NaN) becomes null so callers can distinguish "bad value"
 * from "legitimately zero".
 * @param value - Raw score candidate from the model reply.
 * @returns The clamped integer score, or null when the value is not a usable number.
 */
export function clampScore(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * @description Pull the first JSON object out of an LLM reply. Tolerates a ```json fenced
 * block and surrounding prose (same battle-tested extraction shape as the concierge envelope
 * parser, re-owned here because features may not import from the app layer). Returns null on
 * anything unusable so the caller can retry or fall back — never throws.
 * @param text - The raw model reply.
 * @returns The parsed object, or null when no valid JSON object is present.
 */
export function extractJudgeJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Lowercase + strip non-alphanumerics so "Factual Accuracy" matches "factual_accuracy" / "factual-accuracy". */
function slugKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * @description Map whatever dimension keys the model actually emitted onto the caller's exact
 * rubric criterion strings. The model routinely re-cases, snake_cases, or truncates criterion
 * names — consumers must not have to chase that, so matching is exact → case-insensitive →
 * slugified, and any criterion the model skipped inherits the overall score (the least-surprise
 * default: absent evidence, the dimension is as good as the whole).
 * @param rubric - The caller's rubric criteria (verdict keys come from HERE, verbatim).
 * @param rawDimensions - The `dimensions` object from the model reply (may be malformed/partial).
 * @param overallScore - The validated overall score used to fill unmapped criteria.
 * @returns One clamped score per rubric criterion, keyed by the original criterion strings.
 */
export function mapRubricDimensions(
  rubric: string[],
  rawDimensions: unknown,
  overallScore: number,
): Record<string, number> {
  const raw = rawDimensions && typeof rawDimensions === 'object' && !Array.isArray(rawDimensions)
    ? (rawDimensions as Record<string, unknown>)
    : {};
  const bySlug = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) bySlug.set(slugKey(k), v);

  const mapped: Record<string, number> = {};
  for (const criterion of rubric) {
    const candidate = Object.prototype.hasOwnProperty.call(raw, criterion)
      ? raw[criterion]
      : bySlug.get(slugKey(criterion));
    mapped[criterion] = clampScore(candidate) ?? overallScore;
  }
  return mapped;
}

/**
 * @description Splits text into a lowercased whitespace-delimited token set. Same tokenization
 * as token-chase's determinism proxy so the two lexical lanes score comparably.
 * @param text - Text to tokenize.
 * @returns A Set of distinct lowercased tokens (empty for blank input).
 */
function tokenSet(text: string): Set<string> {
  const trimmed = (text ?? '').trim().toLowerCase();
  if (trimmed.length === 0) return new Set();
  return new Set(trimmed.split(/\s+/));
}

/**
 * @description Jaccard similarity (|A∩B| / |A∪B|) between two token sets — the token-chase
 * lexical proxy (determinism-verdict.ts), duplicated here because FSD forbids importing a
 * sibling feature slice. Two empty sets are defined identical (1).
 * @param a - First token set.
 * @param b - Second token set.
 * @returns Similarity in [0,1].
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * @description The deterministic no-LLM grading lane. With a reference the overall score is the
 * output↔reference Jaccard similarity (the exact token-chase proxy); without one it is the mean
 * of the per-criterion coverages. Each rubric dimension scores the fraction of that criterion's
 * tokens present in the output — a crude but repeatable signal of whether the output even talks
 * about the criterion. Runs when FORCE_LLM_PROVIDER=noop or the judge bot is unavailable, so
 * tests and free-tier flows still get a stable, comparable verdict — flagged
 * `mode:'lexical-fallback'` so nobody mistakes it for a real judgement.
 * @param input - The grade input (same contract as the LLM lane).
 * @param reason - Why the fallback ran (surfaces verbatim in the rationale for observability).
 * @param attemptsConsumed - Real LLM invocations burned before degrading here (0 when the
 * lexical lane ran directly) — kept honest so verdict.attempts never under-reports judge spend.
 * @returns A fully-populated deterministic verdict.
 */
export function lexicalFallbackGrade(
  input: JudgeGradeInput,
  reason: string,
  attemptsConsumed = 0,
): JudgeVerdict {
  const outputTokens = tokenSet(input.output);
  const dimensions: Record<string, number> = {};
  for (const criterion of input.rubric) {
    const critTokens = tokenSet(criterion);
    if (critTokens.size === 0) { dimensions[criterion] = 0; continue; }
    let hit = 0;
    for (const t of critTokens) if (outputTokens.has(t)) hit += 1;
    dimensions[criterion] = Math.round((hit / critTokens.size) * 100);
  }

  let score: number;
  let basis: string;
  if (typeof input.reference === 'string' && input.reference.trim().length > 0) {
    score = Math.round(jaccardSimilarity(outputTokens, tokenSet(input.reference)) * 100);
    basis = 'overall = Jaccard token-set similarity of output vs reference';
  } else if (input.rubric.length > 0) {
    const vals = Object.values(dimensions);
    score = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
    basis = 'overall = mean of per-criterion token coverage (no reference provided)';
  } else {
    score = 0;
    basis = 'no reference and no rubric — nothing to measure';
  }

  return {
    score,
    dimensions,
    rationale: `Deterministic lexical fallback (${reason}). ${basis}; each dimension = fraction of the criterion's tokens present in the output. This is a lexical proxy, not a semantic judgement.`,
    mode: 'lexical-fallback',
    attempts: attemptsConsumed,
  };
}

/**
 * @description Build the grading prompt for the quality-judge concierge. Self-contained (task,
 * output, rubric, optional reference, and the strict pure-JSON reply contract) so the verdict is
 * parseable regardless of what conversational context the harness adds. Mirrors the persona's
 * output contract in ai-lab/bot-personas/quality-judge.yaml — keep the two in sync.
 * @param input - The grade input.
 * @returns The full prompt text handed to the judge bot.
 */
export function buildJudgePrompt(input: JudgeGradeInput): string {
  const rubricLines = input.rubric.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const dimsExample = input.rubric.map((c) => `"${c.replace(/"/g, '\\"')}": <0-100>`).join(', ');
  return [
    'You are the OSHAL quality judge. Grade the OUTPUT below against the TASK and the RUBRIC.',
    'Be strict and evidence-based: cite what the output did or failed to do. Do not reward length or confident tone.',
    '',
    `TASK:\n${input.task}`,
    '',
    `OUTPUT TO GRADE:\n${input.output}`,
    '',
    `RUBRIC (score EACH criterion 0-100):\n${rubricLines}`,
    ...(input.reference && input.reference.trim()
      ? ['', `REFERENCE ANSWER (gold standard — grade the output against it):\n${input.reference}`]
      : []),
    '',
    'Reply with ONLY one JSON object — no prose, no markdown fences, nothing before or after it:',
    `{ "score": <overall 0-100>, "dimensions": { ${dimsExample} }, "rationale": "<2-4 sentences of evidence-based justification>" }`,
    'The dimensions keys MUST be the rubric criteria verbatim. All scores are integers 0-100.',
  ].join('\n');
}

/**
 * @description Validate a parsed model reply into a verdict. Fails (null) when there is no
 * usable overall score — the caller then retries or falls back. Dimensions and rationale are
 * repaired rather than rejected (missing dimension → overall score; missing rationale → a
 * stub noting the omission) because a usable score with sloppy trimmings is still a verdict.
 * @param parsed - The object extracted from the model reply (or null when extraction failed).
 * @param rubric - The caller's rubric criteria for dimension mapping.
 * @param attempts - How many LLM attempts were consumed producing this reply.
 * @returns The validated verdict, or null when the reply carries no usable score.
 */
export function validateLlmVerdict(
  parsed: Record<string, unknown> | null,
  rubric: string[],
  attempts: number,
): JudgeVerdict | null {
  if (!parsed) return null;
  const score = clampScore(parsed.score);
  if (score === null) return null;
  const rationale = typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0
    ? parsed.rationale.trim()
    : 'Judge returned a score without a rationale.';
  return {
    score,
    dimensions: mapRubricDimensions(rubric, parsed.dimensions, score),
    rationale,
    mode: 'llm',
    attempts,
  };
}
