/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — sentence-aware text chunker
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added tiered multi-scale chunking strategy with overlap profiles and deduplication
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'chunker' });

/**
 * @description Configuration for the text chunking strategy.
 */
export interface ChunkerConfig {
  /** Maximum characters per chunk (default 500). */
  chunkSize?: number;
  /** Overlap characters between consecutive chunks (default 50). */
  chunkOverlap?: number;
  /** Chunking strategy. `tiered` emits multi-scale chunks (coarse/standard/fine). */
  strategy?: 'sentence' | 'tiered';
  /** Per-tier chunk sizes for `tiered` strategy. */
  tierSizes?: number[];
  /** Per-tier overlap sizes for `tiered` strategy. */
  tierOverlaps?: number[];
}

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_CHUNK_OVERLAP = 50;
const DEFAULT_TIER_SIZES = [1200, 700, 350];
const DEFAULT_TIER_OVERLAPS = [180, 100, 60];

/**
 * @description Splits text into sentence-aware chunks with configurable
 * size and overlap. Ported from any-bot KnowledgeBootstrap chunking strategy.
 *
 * @param text - Raw text to chunk.
 * @param config - Optional chunking configuration.
 * @returns Array of text chunks.
 */
export function chunkText(text: string, config: ChunkerConfig = {}): string[] {
  const normalized = normalizeText(text);
  if (!normalized) {
    logger.warn('chunkText called with empty text');
    return [];
  }

  const sentences = splitSentences(normalized);
  const strategy = config.strategy === 'tiered' ? 'tiered' : 'sentence';
  const chunks = strategy === 'tiered'
    ? chunkTiered(sentences, config)
    : chunkSingleTier(sentences, config.chunkSize ?? DEFAULT_CHUNK_SIZE, config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP);

  logger.info(
    {
      strategy,
      chunkCount: chunks.length,
      inputLength: normalized.length,
      chunkSize: config.chunkSize ?? DEFAULT_CHUNK_SIZE,
      chunkOverlap: config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
    },
    'Text chunked',
  );
  return chunks;
}

/**
 * @description Normalizes raw text for chunking.
 *
 * @param text - Raw text payload.
 * @returns Trimmed text or empty string.
 */
function normalizeText(text: string): string {
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * @description Splits text into sentence-like segments.
 *
 * @param text - Normalized text payload.
 * @returns Ordered sentence segments.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * @description Performs single-tier sentence-aware chunking.
 *
 * @param sentences - Ordered sentence segments.
 * @param chunkSize - Maximum chunk size.
 * @param chunkOverlap - Overlap size between chunks.
 * @returns Ordered chunks.
 */
function chunkSingleTier(sentences: string[], chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = buildOverlapPrefix(current, chunkOverlap, sentence);
      continue;
    }
    current = candidate;
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * @description Performs 3-tier (or custom tier) chunking and deduplicates output.
 *
 * @param sentences - Ordered sentence segments.
 * @param config - Chunker configuration.
 * @returns Multi-scale deduplicated chunks.
 */
function chunkTiered(sentences: string[], config: ChunkerConfig): string[] {
  const sizes = readTierValues(config.tierSizes, DEFAULT_TIER_SIZES);
  const overlaps = readTierValues(config.tierOverlaps, DEFAULT_TIER_OVERLAPS);
  const chunkSet = new Set<string>();
  const ordered: string[] = [];

  for (let index = 0; index < sizes.length; index += 1) {
    const chunks = chunkSingleTier(sentences, sizes[index], overlaps[index] ?? DEFAULT_CHUNK_OVERLAP);
    for (const chunk of chunks) {
      if (!chunkSet.has(chunk)) {
        chunkSet.add(chunk);
        ordered.push(chunk);
      }
    }
  }

  logger.info({ tiers: sizes.length, chunkCount: ordered.length }, 'Tiered chunking complete');
  return ordered;
}

/**
 * @description Builds overlap-prefixed carry-over content.
 *
 * @param current - Current chunk content.
 * @param chunkOverlap - Desired overlap characters.
 * @param sentence - Incoming sentence.
 * @returns Next chunk seed.
 */
function buildOverlapPrefix(current: string, chunkOverlap: number, sentence: string): string {
  const safeOverlap = Math.max(0, Math.trunc(chunkOverlap));
  if (safeOverlap === 0) {
    return sentence;
  }
  const overlap = current.slice(-safeOverlap).trim();
  return overlap.length > 0 ? `${overlap} ${sentence}` : sentence;
}

/**
 * @description Normalizes tier size/overlap arrays.
 *
 * @param provided - Optional user-provided tier values.
 * @param fallback - Fallback tier values.
 * @returns Normalized positive values.
 */
function readTierValues(provided: number[] | undefined, fallback: number[]): number[] {
  if (!Array.isArray(provided) || provided.length === 0) {
    return fallback;
  }
  const normalized = provided
    .map((value) => Math.max(1, Math.trunc(value)))
    .filter((value) => Number.isFinite(value));
  return normalized.length > 0 ? normalized : fallback;
}
