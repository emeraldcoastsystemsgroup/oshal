/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 2 (slice 1): pure determinism verdict for single-call no-edit replay (ADR-046)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile inline documentation after the step-4 judge shipped: this lexical comparison remains the cheap determinism prefilter, while promotion quality is independently LLM-judged and lexical-fallback grades are ineligible.
 */

/**
 * @description The classification a no-edit replay earns when its fresh response is compared to the
 * captured baseline. `deterministic` = byte-identical; `equivalent` = differs only within the
 * semantic tolerance (the gate still trusts it); `divergent` = drifted past tolerance — every
 * counterfactual built on this frame would be untrustworthy.
 */
export type DeterminismStatus = 'deterministic' | 'equivalent' | 'divergent';

/** @description The result of comparing a replayed response against its captured baseline. */
export interface DeterminismVerdict {
  status: DeterminismStatus;
  /** True only when the replay reproduced the baseline byte-for-byte. */
  byteExact: boolean;
  /** Jaccard token-set similarity in [0,1] (1 = identical token sets). */
  similarity: number;
  /** Whitespace-normalized token count of the baseline response. */
  baselineTokens: number;
  /** Whitespace-normalized token count of the replayed response. */
  replayTokens: number;
  /** Signed percent change in token count, replay vs baseline (rounded). */
  tokenDeltaPct: number;
}

/**
 * @description Similarity at or above this Jaccard score (but not byte-exact) is graded `equivalent`
 * rather than `divergent`. The spec calls for a semantic tolerance, not byte-equality, because
 * temperature>0 / provider drift means even a faithful replay rarely reproduces bytes exactly. A
 * separate LLM judge (ADR-046 step 4) now grades promotion quality; this lexical score remains the
 * cheap replay/determinism prefilter and is never sufficient by itself to promote a lane.
 */
export const EQUIVALENT_SIMILARITY_THRESHOLD = 0.85;

/**
 * @description Splits text into a lowercased whitespace-delimited token set for similarity scoring.
 * @param text - The response text to tokenize.
 * @returns A Set of distinct lowercased tokens (empty for blank input).
 */
function tokenSet(text: string): Set<string> {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return new Set();
  return new Set(trimmed.split(/\s+/));
}

/**
 * @description Jaccard similarity (|A∩B| / |A∪B|) between two token sets. Two empty sets are
 * defined as identical (1) so an empty baseline reproduced as empty grades deterministic.
 * @param a - First token set.
 * @param b - Second token set.
 * @returns Similarity in [0,1].
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * @description Grades a no-edit replay against its captured baseline. Byte-identical output is
 * `deterministic`; otherwise the token-set Jaccard similarity decides `equivalent` (≥ threshold)
 * vs `divergent`. This is the determinism gate's verdict — pure and side-effect free so it is
 * unit-testable without the stack or any LLM cost.
 * @param baseline - The captured baseline response content.
 * @param replay - The freshly replayed response content.
 * @returns The determinism verdict with similarity and token-delta evidence.
 */
export function assessDeterminism(baseline: string, replay: string): DeterminismVerdict {
  const base = baseline ?? '';
  const fresh = replay ?? '';
  const byteExact = base === fresh;
  const baseTokens = tokenSet(base);
  const replayTokens = tokenSet(fresh);
  const similarity = byteExact ? 1 : jaccard(baseTokens, replayTokens);
  const status: DeterminismStatus = byteExact
    ? 'deterministic'
    : similarity >= EQUIVALENT_SIMILARITY_THRESHOLD
      ? 'equivalent'
      : 'divergent';
  const tokenDeltaPct = baseTokens.size === 0
    ? (replayTokens.size === 0 ? 0 : 100)
    : Math.round(((replayTokens.size - baseTokens.size) / baseTokens.size) * 100);
  return {
    status,
    byteExact,
    similarity: Math.round(similarity * 1000) / 1000,
    baselineTokens: baseTokens.size,
    replayTokens: replayTokens.size,
    tokenDeltaPct,
  };
}
