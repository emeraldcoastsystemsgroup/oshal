/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin hybrid-retrieval behavior: RRF fuses vector+BM25 by rank (both-retriever docs outrank single-retriever ones), one-sided/empty inputs pass through, and the local embedder honors the RAG_LOCAL_EMBEDDINGS kill switch by returning null (the lexical-only fallback signal).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../../src/features/rag/services/hybrid-fusion';
import { localEmbeddings } from '../../src/features/rag/services/local-embedding-service';
import type { RagSearchResult } from '../../src/features/rag/services/rag-service';

function hit(id: string, score: number): RagSearchResult {
  return { id, text: `text-${id}`, metadata: { src: id }, score, collection: 'c' };
}

describe('reciprocalRankFusion', () => {
  it('ranks a document found by BOTH retrievers above single-retriever documents', () => {
    const vector = [hit('both', 0.9), hit('vec-only', 0.8)];
    const lexical = [hit('lex-only', 12.0), hit('both', 3.0)];
    const fused = reciprocalRankFusion(vector, lexical);
    expect(fused[0].id).toBe('both'); // 1/60 + 1/61 beats any single 1/60
    expect(fused.map((r) => r.id).sort()).toEqual(['both', 'lex-only', 'vec-only']);
    // Raw scores from incomparable scales must not leak through — RRF scores are small fractions.
    expect(fused[0].score).toBeLessThan(1);
  });

  it('preserves rank order within a single list and passes empty/null lists through', () => {
    const only = [hit('a', 0.9), hit('b', 0.5), hit('c', 0.1)];
    expect(reciprocalRankFusion(only, []).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(reciprocalRankFusion(null, only, undefined).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(reciprocalRankFusion([], null)).toEqual([]);
  });

  it('keeps text/metadata from the first list that saw the document', () => {
    const vector = [{ ...hit('x', 0.9), text: 'vector-text' }];
    const lexical = [{ ...hit('x', 5.0), text: 'lexical-text' }];
    expect(reciprocalRankFusion(vector, lexical)[0].text).toBe('vector-text');
  });
});

describe('localEmbeddings kill switch', () => {
  afterEach(() => { delete process.env.RAG_LOCAL_EMBEDDINGS; });

  it('returns null (the lexical-only signal) when RAG_LOCAL_EMBEDDINGS=0 — without loading the model', async () => {
    process.env.RAG_LOCAL_EMBEDDINGS = '0';
    expect(localEmbeddings.isEnabled()).toBe(false);
    expect(await localEmbeddings.embed(['anything'])).toBeNull();
  });

  it('returns [] for empty input regardless of state', async () => {
    process.env.RAG_LOCAL_EMBEDDINGS = '0';
    expect(await localEmbeddings.embed([])).toEqual([]);
  });
});
