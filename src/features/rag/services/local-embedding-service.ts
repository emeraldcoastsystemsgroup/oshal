/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local sentence embeddings (transformers.js all-MiniLM-L6-v2) so RagService can do real vector retrieval on the existing Chroma 0.4.24 (whose REST /query rejects query_texts — everything was falling back to BM25). Fully local + free per the self-host ethos; fail-open: any load/inference failure returns null and retrieval degrades to lexical, never breaks.
 */

import { resolve } from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'local-embedding-service' });

/** The transformers.js-converted MiniLM — 384-dim, ~90MB, cached after first download. */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
/** Bound per-call batch size so a whole textbook ingest can't balloon memory. */
const BATCH_SIZE = 32;

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * @description Lazy singleton around a local MiniLM feature-extraction pipeline.
 * The model loads on first use (downloaded once into a persistent cache dir, WASM
 * backend so it also runs on alpine/musl where onnxruntime-node's native binding
 * can't). Every failure path returns null instead of throwing — callers treat
 * null as "no vectors available" and fall back to lexical scoring.
 */
class LocalEmbeddingService {
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor | null> | null = null;
  /** Sticky after a failed load: don't re-pay a doomed model load on every query. */
  private unavailable = false;

  /** @returns False when explicitly disabled via RAG_LOCAL_EMBEDDINGS=0/false/off. */
  isEnabled(): boolean {
    const flag = (process.env.RAG_LOCAL_EMBEDDINGS || '').trim().toLowerCase();
    return !['0', 'false', 'off'].includes(flag);
  }

  /**
   * @description Embed texts into normalized 384-dim vectors (cosine-ready).
   * @param texts - The strings to embed.
   * @returns One vector per input, or null when embeddings are unavailable
   * (disabled, model failed to load, or inference errored) — callers fall back.
   */
  async embed(texts: string[]): Promise<number[][] | null> {
    if (!texts.length) return [];
    if (!this.isEnabled() || this.unavailable) return null;
    const extractor = await this.getExtractor();
    if (!extractor) return null;
    try {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const tensor = await extractor(texts.slice(i, i + BATCH_SIZE), { pooling: 'mean', normalize: true });
        out.push(...tensor.tolist());
      }
      return out;
    } catch (err) {
      logger.error({ err, count: texts.length }, 'Local embedding inference failed — falling back to lexical');
      return null;
    }
  }

  private getExtractor(): Promise<FeatureExtractor | null> {
    if (this.extractor) return Promise.resolve(this.extractor);
    if (!this.loading) {
      this.loading = this.load();
    }
    return this.loading;
  }

  private async load(): Promise<FeatureExtractor | null> {
    const started = Date.now();
    try {
      // @xenova/transformers is ESM-only and this codebase compiles CommonJS —
      // the Function wrapper keeps tsc from down-compiling import() to require().
      const mod = await (Function('return import("@xenova/transformers")')() as Promise<any>);
      // Persist the model cache in the shared workspace volume so container
      // recreates don't re-download; env TRANSFORMERS_CACHE overrides.
      const cacheDir = process.env.TRANSFORMERS_CACHE
        || (process.env.CLINE_WORKSPACE_ROOT ? resolve(process.env.CLINE_WORKSPACE_ROOT, '.transformers-cache') : undefined);
      if (cacheDir) mod.env.cacheDir = cacheDir;
      // In the alpine image onnxruntime-node is shimmed to onnxruntime-web
      // (Dockerfile.oshal — glibc natives fail on musl; with gcompat they SEGFAULT).
      // ort-web's threaded WASM needs the browser Worker API, absent in Node, and
      // hangs session init — single-thread it. Guarded: the native backend on a
      // dev host has no .wasm env and must not be poked.
      if (mod.env?.backends?.onnx?.wasm) mod.env.backends.onnx.wasm.numThreads = 1;
      const pipe = await mod.pipeline('feature-extraction', MODEL_ID);
      this.extractor = pipe as FeatureExtractor;
      logger.info({ model: MODEL_ID, cacheDir, ms: Date.now() - started }, 'Local embedding model ready');
      return this.extractor;
    } catch (err) {
      this.unavailable = true;
      logger.warn({ err, model: MODEL_ID, ms: Date.now() - started }, 'Local embedding model unavailable — RAG stays lexical-only for this process');
      return null;
    }
  }
}

/** Process-wide singleton: the model is heavyweight, load it once. */
export const localEmbeddings = new LocalEmbeddingService();
