/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Reciprocal-rank fusion for hybrid retrieval: merges the vector and BM25 result lists by rank (k=60), so semantic and lexical evidence both count without score-scale gymnastics. Pure function — unit-tested directly.
 */

// Type-only import — erased at compile time, so the rag-service ↔ fusion cycle is harmless.
import type { RagSearchResult } from './rag-service';

/** Standard RRF dampening constant — rank 0 scores 1/60, rank 9 scores 1/69. */
const RRF_K = 60;

/**
 * @description Merge ranked result lists with reciprocal-rank fusion:
 * score(doc) = Σ over lists 1/(k + rank). Rank-based fusion sidesteps the
 * incomparable score scales of cosine distance vs BM25; a document found by
 * BOTH retrievers outranks one found by either alone. Result `score` becomes
 * the RRF score; text/metadata are taken from the first list that saw the doc.
 *
 * @param lists - Ranked result lists (best first). Empty/missing lists are skipped.
 * @returns Fused results, best first.
 */
export function reciprocalRankFusion(...lists: Array<RagSearchResult[] | null | undefined>): RagSearchResult[] {
  const fused = new Map<string, RagSearchResult & { score: number }>();
  for (const list of lists) {
    if (!list?.length) continue;
    list.forEach((r, rank) => {
      const contribution = 1 / (RRF_K + rank);
      const existing = fused.get(r.id);
      if (existing) existing.score += contribution;
      else fused.set(r.id, { ...r, score: contribution });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}
