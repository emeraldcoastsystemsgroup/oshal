/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local sentence embeddings (transformers.js all-MiniLM-L6-v2) so RagService can do real vector retrieval on the existing Chroma 0.4.24 (whose REST /query rejects query_texts — everything was falling back to BM25). Fully local + free per the self-host ethos; fail-open: any load/inference failure returns null and retrieval degrades to lexical, never breaks.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Strip the ONNX runtime's process-global rethrow listeners once the model load settles. onnxruntime-web's Emscripten Node shell appends `process.on('unhandledRejection', t => { throw t })` and a matching `uncaughtException` rethrow the moment the wasm initialises, BEHIND installProcessCrashGuards — from that instant a stray rejection anywhere in the controller (not just in RAG) was rethrown into an uncaught exception, rethrown again, and killed the api with exit 7 and ~548 KB of minified bundle on stderr, before the crash guards' 250 ms log flush. Measured: exit 7 / 548,709 bytes without the strip, exit 0 / 54 bytes with it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Contain an Emscripten abort raised inside the wasm runtime mid-inference. The abort is a WebAssembly.RuntimeError that the awaited call already surfaced to the catch, but the catch treated it like any transient error: it logged only a text count, named no caller, and left the runtime — which has ABORT set and an undefined heap after it — armed for the next call. Now an abort makes the service unavailable for the process, the same degrade a failed model load takes, and every inference failure logs the caller, the input size (count, total and longest chars, failing batch) and a bounded error summary instead of whatever the backend printed.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Two review findings. `WebAssembly` is a lib.dom/lib.webworker global and the server build compiles with lib ES2022 + types node, so naming it broke `npm run typecheck` and would have broken the image build (Dockerfile.oshal runs that tsconfig with no noEmitOnError); the constructor is read off globalThis instead. And the sticky degrade only guarded the ENTRY to embed(): a multi-batch call already in flight kept awaiting the extractor after another caller aborted the runtime, and an aborted runtime answers with a tensor rather than throwing, so ingest would persist vectors from a heap with ABORT set. The flag is re-checked before every batch.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2: the inline workspace-root chain here resolves through resolveSharedWorkspaceRoot() like every other site. It read ONE of the six. The undefined-when-absent branch is KEPT and is the reason for the presence check: with no shared mount the library must fall back to its own default cache, not to a directory this process invented under cwd.
 */

import { resolve } from 'path';
import { createChildLogger } from '@/shared/logger';
import { snapshotProcessGuards, stripRethrowGuards } from './onnx-process-guards';
import { hasConfiguredWorkspaceRoot, resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

const logger = createChildLogger({ module: 'local-embedding-service' });

/** The transformers.js-converted MiniLM — 384-dim, ~90MB, cached after first download. */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
/** Bound per-call batch size so a whole textbook ingest can't balloon memory. */
const BATCH_SIZE = 32;
/** Bound on the backend error text that reaches the log — the crash that motivated this put 548 KB of bundle on stderr. */
const ERROR_TEXT_LIMIT = 600;
/** Stack frames kept: enough to name the frame that raised, never enough to reproduce a bundle dump. */
const STACK_FRAME_LIMIT = 6;

type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * @description The sized description of one failed embed() call — what the log
 * carries so the operator can tell which caller, with how much input, drove the
 * backend into an error, without the backend's own output.
 */
export interface EmbeddingFailure {
  /** The caller label the call site passed (e.g. `rag-service.ingest`). */
  caller: string;
  /** How many texts the call carried. */
  count: number;
  /** Total characters across all texts. */
  chars: number;
  /** The longest single text, in characters. */
  maxChars: number;
  /** Index of the first text in the batch that was in flight when the error surfaced. */
  batchStart: number;
  /** The batch bound, so batchStart can be read as a batch number. */
  batchSize: number;
  /** True when the error is the wasm runtime aborting, which leaves it unusable. */
  abort: boolean;
  /** A bounded summary of the error: name, message and the first few frames. */
  error: { name: string; message: string; stack: string };
}

/**
 * @description True when an inference error is the Emscripten runtime aborting
 * — either the `WebAssembly.RuntimeError` its `abort()` throws (also the class a
 * wasm trap such as `unreachable` throws) or an error carrying the `Aborted(`
 * marker Emscripten prints. After either the runtime has `ABORT` set and its
 * heap cannot be trusted, which is why the caller treats it as sticky rather
 * than as one bad call.
 * @param err - Whatever the awaited extractor call threw.
 * @returns Whether the backend runtime itself aborted.
 */
export function isRuntimeAbort(err: unknown): boolean {
  // `WebAssembly` is declared in lib.dom/lib.webworker, and the server build compiles with
  // lib ES2022 + types node - naming it directly does not compile there, and the image build
  // runs exactly that tsconfig with no noEmitOnError. The constructor is read off globalThis
  // instead, which is the same check at runtime and compiles under both configs.
  const runtimeErrorCtor = (globalThis as { WebAssembly?: { RuntimeError?: unknown } })
    .WebAssembly?.RuntimeError;
  if (typeof runtimeErrorCtor === 'function' && err instanceof (runtimeErrorCtor as new () => Error)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\bAborted\(/.test(message);
}

/**
 * @description Builds the sized, bounded log payload for a failed embed() call.
 * Pure so the shape is testable without a backend: the input size is measured
 * from the texts, and the error is summarised to a bounded name, message and a
 * handful of frames.
 * @param err - Whatever the awaited extractor call threw.
 * @param texts - The full input to the embed() call.
 * @param caller - The caller label the call site passed.
 * @param batchStart - Index of the first text in the batch that was in flight.
 * @returns The payload embed() logs.
 */
export function describeEmbeddingFailure(err: unknown, texts: string[], caller: string, batchStart: number): EmbeddingFailure {
  let chars = 0;
  let maxChars = 0;
  for (const text of texts) {
    const len = typeof text === 'string' ? text.length : 0;
    chars += len;
    if (len > maxChars) maxChars = len;
  }
  const asError = err instanceof Error ? err : null;
  const message = (asError ? asError.message : String(err)).slice(0, ERROR_TEXT_LIMIT);
  const stack = (asError?.stack || '').split('\n').slice(0, STACK_FRAME_LIMIT).join('\n').slice(0, ERROR_TEXT_LIMIT * 2);
  return {
    caller,
    count: texts.length,
    chars,
    maxChars,
    batchStart,
    batchSize: BATCH_SIZE,
    abort: isRuntimeAbort(err),
    error: { name: asError ? asError.name : typeof err, message, stack },
  };
}

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
  /** Sticky after a failed load or a runtime abort: don't re-enter a dead backend on every query. */
  private unavailable = false;

  /** @returns False when explicitly disabled via RAG_LOCAL_EMBEDDINGS=0/false/off. */
  isEnabled(): boolean {
    const flag = (process.env.RAG_LOCAL_EMBEDDINGS || '').trim().toLowerCase();
    return !['0', 'false', 'off'].includes(flag);
  }

  /**
   * @description Embed texts into normalized 384-dim vectors (cosine-ready).
   * @param texts - The strings to embed.
   * @param caller - Who is asking (e.g. `rag-service.ingest`), named in the log
   * when the backend fails so a crash is attributable to a call site and its input.
   * @returns One vector per input, or null when embeddings are unavailable
   * (disabled, model failed to load, backend aborted, or inference errored) —
   * callers fall back.
   */
  async embed(texts: string[], caller = 'unknown'): Promise<number[][] | null> {
    if (!texts.length) return [];
    if (!this.isEnabled() || this.unavailable) return null;
    const extractor = await this.getExtractor();
    if (!extractor) return null;
    let batchStart = 0;
    try {
      const out: number[][] = [];
      for (; batchStart < texts.length; batchStart += BATCH_SIZE) {
        // Another caller can abort the shared runtime between batches. The entry check above
        // cannot see that, and the aborted runtime does NOT throw - it answers with a tensor
        // from a heap with ABORT set, which ingest would persist as real vectors. Re-check
        // before every batch so an in-flight call degrades with everyone else.
        if (this.unavailable) {
          return this.degradeAfterFailure(
            new Error('Aborted(): the embedding runtime went unavailable while this call was in flight'),
            texts, caller, batchStart,
          );
        }
        const tensor = await extractor(texts.slice(batchStart, batchStart + BATCH_SIZE), { pooling: 'mean', normalize: true });
        out.push(...tensor.tolist());
      }
      return out;
    } catch (err) {
      return this.degradeAfterFailure(err, texts, caller, batchStart);
    }
  }

  /**
   * @description Turns an inference error into the null the callers fall back on,
   * logging who asked and how much input was in flight. A transient error costs
   * only this call; a runtime abort leaves the wasm runtime with `ABORT` set and
   * an undefined heap, so the service goes unavailable for the rest of the
   * process — the same degrade a failed model load already takes — rather than
   * handing the next caller a dead backend.
   */
  private degradeAfterFailure(err: unknown, texts: string[], caller: string, batchStart: number): null {
    const failure = describeEmbeddingFailure(err, texts, caller, batchStart);
    if (!failure.abort) {
      logger.error(failure, 'Local embedding inference failed — this call falls back to lexical');
      return null;
    }
    this.unavailable = true;
    this.extractor = null;
    this.loading = null;
    logger.error(
      failure,
      'Local embedding runtime aborted mid-inference — embeddings unavailable for this process, retrieval stays lexical (the same degrade as a failed model load)',
    );
    return null;
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
    // Capture the process-global crash-guard listeners BEFORE anything can pull in
    // the ONNX runtime: its Emscripten Node shell appends two rethrow listeners at
    // wasm init that make any stray rejection in the whole process fatal. The strip
    // in `finally` removes exactly those and nothing the api installed itself.
    const guards = snapshotProcessGuards();
    try {
      // @xenova/transformers is ESM-only and this codebase compiles CommonJS —
      // the Function wrapper keeps tsc from down-compiling import() to require().
      const mod = await (Function('return import("@xenova/transformers")')() as Promise<any>);
      // Persist the model cache in the shared workspace volume so container
      // recreates don't re-download; env TRANSFORMERS_CACHE overrides.
      const cacheDir = process.env.TRANSFORMERS_CACHE
        || (hasConfiguredWorkspaceRoot() ? resolve(resolveSharedWorkspaceRoot(), '.transformers-cache') : undefined);
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
    } finally {
      // Both paths register the listeners: a failing InferenceSession.create arms
      // them just as a successful one does, so the strip belongs here rather than
      // only on the success path.
      stripRethrowGuards(guards);
    }
  }
}

/** Process-wide singleton: the model is heavyweight, load it once. */
export const localEmbeddings = new LocalEmbeddingService();
