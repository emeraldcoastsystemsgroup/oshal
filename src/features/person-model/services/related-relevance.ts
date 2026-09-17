/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 3 follow-up: the relevance floor for "possibly related" recall hits. The retrieval engine fuses its vector and lexical legs by RECIPROCAL RANK, so a fused score says where a chunk placed, not how close it is — and when the store holds fewer chunks than the fetch bound, every chunk places. The 2026-09-12 live proof returned "Can we order pizza tonight" beside two real volleyball paraphrases at an indistinguishable 1/60-vs-1/63. This module scores each candidate against the recall query on the SAME MiniLM the projection embedded with, and drops anything under a cosine floor, so the related list is evidence rather than the store's contents in rank order. The exact count never passes through here.
 */

import { localEmbeddings } from '@/features/rag';
import { createChildLogger } from '@/shared/logger';
import type { RelatedReceipt } from './person-model-types';

const logger = createChildLogger({ module: 'person-model-relevance' });

/**
 * Cosine floor a "possibly related" hit must clear against the recall query on
 * all-MiniLM-L6-v2 (the model the semantic projection embeds with). Measured on the
 * ADR-100 live-proof corpus for the query "volleyball": the two true paraphrases score
 * 0.404 and 0.238, the off-topic "Can we order pizza tonight" 0.177, and lines with no
 * relationship at all ("The car needs an oil change", "I have a dentist appointment on
 * Tuesday") score below zero. 0.2 sits in the gap between "no relationship" and "some
 * relationship" on this model rather than being fitted to one pair, and
 * PERSON_MODEL_RELATED_SIMILARITY_FLOOR retunes it for a corpus that disagrees.
 */
export const DEFAULT_RELATED_SIMILARITY_FLOOR = 0.2;

/** A related hit before it has been scored — what the retrieval leg hands over. */
export type RelatedCandidate = Omit<RelatedReceipt, 'similarity'>;

/**
 * @description Reads the configured cosine floor, falling back to the measured default.
 * A value outside 0..1 is a misconfiguration, not an instruction: it is logged and the
 * default stands, because a floor above 1 would silently empty every related list and a
 * negative one would silently restore the noise this floor exists to remove.
 * @returns The cosine floor in 0..1.
 */
export function relatedSimilarityFloor(): number {
  const raw = (process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR || '').trim();
  if (!raw) return DEFAULT_RELATED_SIMILARITY_FLOOR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    logger.warn({ operation: 'relatedSimilarityFloor', raw }, 'PERSON_MODEL_RELATED_SIMILARITY_FLOOR is not a number in 0..1 — keeping the default floor');
    return DEFAULT_RELATED_SIMILARITY_FLOOR;
  }
  return parsed;
}

/**
 * @description Cosine similarity of two embeddings. MiniLM already returns unit vectors,
 * but the magnitudes are divided out anyway so a future un-normalised embedder cannot
 * quietly change what the floor means.
 * @param a - First vector.
 * @param b - Second vector, same dimensionality.
 * @returns Cosine in -1..1; 0 for mismatched or degenerate input.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * @description Scores each text against the query in ONE embedder call (query first,
 * candidates after), so a related list costs one extra inference rather than one per hit.
 * @param query - The recall topic terms, exactly as the retrieval leg used them.
 * @param texts - Candidate transcript lines.
 * @returns One cosine per text, or null when the embedder is unavailable.
 */
export async function scoreAgainstQuery(query: string, texts: readonly string[]): Promise<number[] | null> {
  if (texts.length === 0) return [];
  const vectors = await localEmbeddings.embed([query, ...texts]);
  if (!vectors || vectors.length !== texts.length + 1) {
    logger.warn({ operation: 'scoreAgainstQuery', candidates: texts.length }, 'embedder returned no vectors — related hits cannot be scored');
    return null;
  }
  const [queryVector, ...candidateVectors] = vectors;
  return candidateVectors.map((vector) => cosineSimilarity(queryVector, vector));
}

/**
 * @description Drops candidates that do not clear the cosine floor against the query and
 * returns the survivors genuinely best-first — by measured similarity, not by the fused
 * rank, which carries no distance information. Returns null when the candidates could not
 * be scored at all: "possibly related" is a semantic claim, so an unscored list is not
 * published as one.
 * @param query - The recall topic terms.
 * @param candidates - Related hits from the retrieval leg.
 * @param floor - Cosine floor (defaults to the configured one).
 * @returns Scored survivors, most similar first; null when scoring was impossible.
 */
export async function applyRelevanceFloor(
  query: string, candidates: readonly RelatedCandidate[], floor = relatedSimilarityFloor(),
): Promise<RelatedReceipt[] | null> {
  if (candidates.length === 0) return [];
  const similarities = await scoreAgainstQuery(query, candidates.map((candidate) => candidate.quote));
  if (!similarities) return null;
  const kept = candidates
    .map((candidate, index) => ({ ...candidate, similarity: similarities[index] }))
    .filter((candidate) => candidate.similarity >= floor)
    .sort((a, b) => b.similarity - a.similarity);
  if (kept.length < candidates.length) {
    logger.info({ operation: 'applyRelevanceFloor', floor, considered: candidates.length, kept: kept.length }, 'related hits below the relevance floor dropped');
  }
  return kept;
}
