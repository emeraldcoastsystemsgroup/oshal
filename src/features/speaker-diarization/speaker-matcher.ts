/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic normalized cosine matching and weighted centroid updates for speaker embeddings.
 */

/** @description A candidate centroid considered by the deterministic matcher. */
export interface SpeakerMatchCandidate {
  id: string;
  embedding: number[];
}

/** @description Best candidate returned by deterministic similarity ordering. */
export interface SpeakerBestMatch {
  id: string;
  similarity: number;
}

const MAX_EMBEDDING_DIMENSIONS = 4_096;

/** @description Versioned compile-time cosine floor for deterministic speaker matching. */
export const SPEAKER_MATCH_THRESHOLD = 0.82;

/** @description Minimum separation from the runner-up before a profile may be auto-attributed. */
export const SPEAKER_AMBIGUITY_MARGIN = 0.04;

/** @description Stricter similarity floor required before a remembered biometric centroid may move. */
export const SPEAKER_CENTROID_UPDATE_THRESHOLD = 0.90;

/**
 * @description Prevents profile drift by allowing centroid updates only for high-confidence matches.
 * @param similarity - Accepted profile cosine similarity.
 * @returns Whether the sample may update the stored centroid.
 */
export function shouldUpdateSpeakerCentroid(similarity: number): boolean {
  return Number.isFinite(similarity) && similarity >= SPEAKER_CENTROID_UPDATE_THRESHOLD;
}

/**
 * @description Validates and L2-normalizes a finite speaker embedding.
 * @param embedding - Untrusted numeric vector from a diarization sidecar.
 * @returns Unit vector suitable for cosine matching.
 */
export function normalizeSpeakerEmbedding(embedding: readonly number[]): number[] {
  if (!Array.isArray(embedding) || embedding.length < 2 || embedding.length > MAX_EMBEDDING_DIMENSIONS) {
    throw new Error(`speaker embedding must contain 2-${MAX_EMBEDDING_DIMENSIONS} dimensions`);
  }
  let squaredNorm = 0;
  const values = embedding.map((value) => {
    if (!Number.isFinite(value)) throw new Error('speaker embedding contains a non-finite value');
    squaredNorm += value * value;
    return value;
  });
  const norm = Math.sqrt(squaredNorm);
  if (norm <= Number.EPSILON) throw new Error('speaker embedding must have a non-zero norm');
  return values.map((value) => value / norm);
}

/**
 * @description Computes cosine similarity while rejecting mismatched dimensions.
 * @param left - First embedding.
 * @param right - Second embedding.
 * @returns Similarity from -1 through 1.
 */
export function cosineSpeakerSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error('speaker embeddings must have matching non-zero dimensions');
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm * rightNorm);
  if (denominator <= Number.EPSILON) throw new Error('speaker embedding must have a non-zero norm');
  return dot / denominator;
}

/**
 * @description Finds the highest cosine match with a stable id tie-break.
 * @param embedding - Incoming normalized vector.
 * @param candidates - Remembered profile centroids.
 * @param threshold - Minimum accepted cosine similarity.
 * @returns Best match or null when every candidate is below threshold.
 */
export function selectBestSpeakerMatch(
  embedding: readonly number[],
  candidates: readonly SpeakerMatchCandidate[],
  threshold: number,
): SpeakerBestMatch | null {
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
    throw new Error('speaker similarity threshold must be between -1 and 1');
  }
  const scored = candidates
    .filter((candidate) => candidate.embedding.length === embedding.length)
    .map((candidate) => ({ id: candidate.id, similarity: cosineSpeakerSimilarity(embedding, candidate.embedding) }))
    .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id));
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.similarity < threshold) return null;
  if (runnerUp && best.similarity - runnerUp.similarity < SPEAKER_AMBIGUITY_MARGIN) return null;
  return best;
}

/**
 * @description Updates a centroid with a weighted online mean and renormalizes it.
 * @param centroid - Existing profile centroid.
 * @param sampleCount - Number of samples already represented by the centroid.
 * @param sample - New speaker embedding.
 * @returns Updated unit centroid.
 */
export function updateSpeakerCentroid(
  centroid: readonly number[],
  sampleCount: number,
  sample: readonly number[],
): number[] {
  if (!Number.isInteger(sampleCount) || sampleCount < 1) throw new Error('sample count must be a positive integer');
  if (centroid.length !== sample.length) throw new Error('centroid and sample dimensions must match');
  const combined = centroid.map((value, index) => ((value * sampleCount) + sample[index]) / (sampleCount + 1));
  return normalizeSpeakerEmbedding(combined);
}
