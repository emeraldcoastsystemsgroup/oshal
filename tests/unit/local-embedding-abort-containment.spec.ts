/**
 * Guard: an abort inside the local embedding runtime cannot take the api down.
 *
 * The api embeds on onnxruntime-web's wasm (Dockerfile.oshal shims onnxruntime-node to
 * it on musl). Emscripten's abort() prints `Aborted(` to stderr, sets ABORT and throws a
 * WebAssembly.RuntimeError from inside the wasm frame that hit it. Awaited under
 * try/catch that error is an ordinary rejection; unawaited, with the runtime's own
 * rethrow listeners in place, it is the exit-7 crash the api showed. The containment
 * has three layers and each is measured here against the real runtime:
 *   1. the rethrow listeners are stripped (onnx-global-rethrow-handlers.spec.ts);
 *   2. embed() awaits every inference under try/catch and returns null;
 *   3. after an abort the service goes unavailable for the process - the heap behind
 *      a runtime with ABORT set is not trusted - and the log names the caller and the
 *      input size instead of the backend's output.
 *
 * The host cases drive the real onnxruntime-web runtime with the real quantized
 * MiniLM that @xenova/transformers caches after its first download (the npm package does
 * not ship the weights, so a fresh checkout fails these cases loudly on the fixture's
 * existsSync assert until the cache exists), raising the runtime's OWN abort import from
 * inside a wasm frame mid-run (tests/fixtures/onnx-abort-hook.ts). The uncontained
 * control proves the abort is real and lethal when nothing traps it, so a runtime
 * that stops aborting fails this suite instead of passing it vacuously. The image
 * cases run the real embed() inside oshal-bot:latest. The one scoped double is the
 * extractor in the service-policy cases - see docs/governance/real-boundary-regression-audit.md.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the abort classifier against a real WebAssembly.RuntimeError, the bounded caller/size log payload, the service's sticky-after-abort policy, the real-runtime host child in contained and uncontained modes, and the in-image embed() case.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two review corrections: the model is cached after a download rather than shipped in the package (the case name said "ships"), and a new case pins that a call ALREADY IN FLIGHT degrades when another caller aborts the runtime. The sticky flag was checked only at the entry to embed(), so a multi-batch call kept awaiting an aborted extractor - which answers with a tensor instead of throwing - and handed those vectors to ingest.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeEmbeddingFailure,
  isRuntimeAbort,
  localEmbeddings,
} from '@/features/rag/services/local-embedding-service';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHILD = path.join('tests', 'fixtures', 'onnx-abort-child.ts');
const IMAGE_PROBE = path.join(REPO_ROOT, 'tests', 'fixtures', 'onnx-abort-image-probe.ts');
const HOOK = path.join(REPO_ROOT, 'tests', 'fixtures', 'onnx-abort-hook.ts');
const MODEL = path.join(REPO_ROOT, 'node_modules', '@xenova', 'transformers', '.cache', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx');
const IMAGE = 'oshal-bot:latest';
const CHILD_TIMEOUT_MS = 180_000;
const IMAGE_TIMEOUT_MS = 600_000;
/** The crash this guards against put ~548 KB of bundle on stderr; a contained abort prints one marker. */
const STDERR_CEILING_BYTES = 8_192;

interface ChildRun {
  status: number | null;
  stderr: string;
  stderrBytes: number;
  probes: Record<string, any>;
}

/**
 * @returns How many times Emscripten's own bare `Aborted()` line appears on stderr.
 * transformers.js echoes the message once more inside its own "An error occurred
 * during model execution" line, so the count is of the runtime's line, not the substring.
 */
function bareAbortMarkers(stderr: string): number {
  return stderr.split(/\r?\n/).filter((line) => line.trim() === 'Aborted()').length;
}

/** @returns The JSON probe lines of a child's stdout keyed by stage. */
function parseProbes(stdout: string): Record<string, any> {
  const probes: Record<string, any> = {};
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.probe) probes[parsed.probe] = parsed;
    } catch {
      // The pino logger's own stdout lines are not probes.
    }
  }
  return probes;
}

/**
 * @description Runs the host child under tsx with the given abort mode.
 * @param mode - `contained` (awaited under try/catch, listeners stripped) or `uncontained`.
 * @returns Exit status, stderr and the probe lines.
 */
function runChild(mode: string): ChildRun {
  const env = { ...process.env, ONNX_ABORT_CHILD_MODE: mode, NODE_ENV: 'test' };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [require.resolve('tsx/cli'), CHILD], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  const stderr = run.stderr || '';
  return { status: run.status, stderr, stderrBytes: Buffer.byteLength(stderr), probes: parseProbes(run.stdout || '') };
}

describe('isRuntimeAbort', () => {
  it('recognises the WebAssembly.RuntimeError Emscripten abort() throws', () => {
    expect(isRuntimeAbort(new WebAssembly.RuntimeError('Aborted(). Build with -sASSERTIONS for more info.'))).toBe(true);
  });

  it('recognises the Aborted( marker on an ordinary Error', () => {
    expect(isRuntimeAbort(new Error('Aborted(native code called abort())'))).toBe(true);
  });

  it('does not classify a transient backend error or a non-error as an abort', () => {
    expect(isRuntimeAbort(new Error('input tensor rank mismatch'))).toBe(false);
    expect(isRuntimeAbort('aborted download')).toBe(false);
  });

  it('classifies a bare wasm trap - no Aborted( marker - by its constructor, not its message', () => {
    // This is the branch the server-tsconfig fix rewrote. Every other case here also carries the
    // marker, so the regex fallback alone satisfied them: killing the constructor check left the
    // suite green while `unreachable` and an out-of-bounds trap would be treated as transient and
    // the aborted runtime re-armed.
    expect(isRuntimeAbort(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
    expect(isRuntimeAbort(new WebAssembly.RuntimeError('memory access out of bounds'))).toBe(true);
    expect(isRuntimeAbort(new WebAssembly.CompileError('bad magic')), 'a compile error is not a runtime abort').toBe(false);
  });
});

describe('describeEmbeddingFailure', () => {
  it('names the caller and sizes the input, including the batch that was in flight', () => {
    const texts = ['ab', 'cdef', 'g'];
    const failure = describeEmbeddingFailure(new Error('boom'), texts, 'rag-service.ingest', 32);
    expect(failure).toMatchObject({ caller: 'rag-service.ingest', count: 3, chars: 7, maxChars: 4, batchStart: 32, batchSize: 32, abort: false });
    expect(failure.error).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('bounds the error text so a backend that prints its bundle cannot reach the log', () => {
    const huge = new Error('x'.repeat(600_000));
    huge.stack = Array.from({ length: 5_000 }, (_, i) => `    at frame${i} (bundle.js:6:${i})`).join('\n');
    const failure = describeEmbeddingFailure(huge, ['t'], 'probe', 0);
    expect(failure.error.message.length).toBeLessThanOrEqual(600);
    expect(failure.error.stack.split('\n').length).toBeLessThanOrEqual(6);
    expect(failure.error.stack.length).toBeLessThanOrEqual(1_200);
  });
});

describe('localEmbeddings after an inference failure (extractor doubled; the runtime cases below are the real companion)', () => {
  const svc = localEmbeddings as any;
  const saved = { extractor: svc.extractor, loading: svc.loading, unavailable: svc.unavailable, flag: process.env.RAG_LOCAL_EMBEDDINGS };
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    svc.unavailable = false;
    svc.loading = null;
    delete process.env.RAG_LOCAL_EMBEDDINGS;
  });

  afterEach(() => {
    svc.extractor = saved.extractor;
    svc.loading = saved.loading;
    svc.unavailable = saved.unavailable;
    if (saved.flag === undefined) delete process.env.RAG_LOCAL_EMBEDDINGS;
    else process.env.RAG_LOCAL_EMBEDDINGS = saved.flag;
  });

  /** An extractor that throws `err` once, then answers with a one-row vector. */
  function throwingOnce(err: unknown): (texts: string[]) => Promise<{ tolist(): number[][] }> {
    return async (texts) => {
      calls += 1;
      if (calls === 1) throw err;
      return { tolist: () => texts.map(() => [0.5, 0.5]) };
    };
  }

  it('a transient error costs one call: null now, the next call reaches the extractor again', async () => {
    svc.extractor = throwingOnce(new Error('input tensor rank mismatch'));
    expect(await localEmbeddings.embed(['a'], 'spec')).toBeNull();
    expect(await localEmbeddings.embed(['a'], 'spec')).toEqual([[0.5, 0.5]]);
    expect(calls).toBe(2);
    expect(svc.unavailable).toBe(false);
  });

  it('a runtime abort makes the service unavailable for the process: null, and the extractor is never re-entered', async () => {
    svc.extractor = throwingOnce(new WebAssembly.RuntimeError('Aborted(). Build with -sASSERTIONS for more info.'));
    expect(await localEmbeddings.embed(['a', 'b'], 'spec')).toBeNull();
    expect(svc.unavailable).toBe(true);
    expect(svc.extractor).toBeNull();
    expect(await localEmbeddings.embed(['a'], 'spec')).toBeNull();
    expect(calls).toBe(1);
  });

  it('a call already in flight degrades too: another caller aborts the runtime between batches', async () => {
    // The entry check cannot see an abort that happens mid-call, and an aborted runtime does NOT
    // throw - it answers with a tensor from a heap with ABORT set. Without the per-batch re-check
    // this call returned real-looking vectors that rag-service.ingest would have persisted.
    const BATCHES = 3;
    const texts = Array.from({ length: 32 * BATCHES }, (_, i) => 'text-' + i);
    let released: (() => void) | null = null;
    const firstBatchHeld = new Promise<void>((resolve) => { released = resolve; });
    let batches = 0;
    svc.extractor = async (slice: string[]) => {
      batches += 1;
      calls += 1;
      if (batches === 1) await firstBatchHeld; // hold batch 0 open, as a long ingest does
      return { tolist: () => slice.map(() => [0.5, 0.5]) };
    };
    const inFlight = localEmbeddings.embed(texts, 'rag-service.ingest');
    await new Promise((tick) => setImmediate(tick));
    // Another caller aborts the shared runtime while batch 0 is still open.
    svc.unavailable = true;
    svc.extractor = null;
    released!();
    expect(await inFlight, 'the in-flight call returned vectors from an aborted runtime').toBeNull();
    expect(batches, 'it must not start another batch after the abort').toBe(1);
  });
});

describe('the real onnxruntime-web runtime aborting mid-inference (host child, real quantized MiniLM)', () => {
  it('has cached the model this case needs', () => {
    expect(existsSync(MODEL), `expected ${MODEL}`).toBe(true);
  });

  it('contained: the abort is a catchable WebAssembly.RuntimeError, one marker on stderr, and the process is still serving', () => {
    const run = runChild('contained');
    expect(run.status, run.stderr.slice(0, 400)).toBe(0);
    expect(run.probes['run-ok']?.dims, 'the real model ran before the abort').toEqual([1, 3, 384]);
    expect(run.probes['abort-caught'], 'the armed run must have aborted').toBeDefined();
    expect(run.probes['abort-caught'].isRuntimeError).toBe(true);
    expect(run.probes['abort-caught'].message).toContain('Aborted(');
    expect(run.probes['abort-caught'].abortsRaised).toBe(1);
    expect(run.probes.survived.counts).toEqual(run.probes.baseline.counts);
    expect(bareAbortMarkers(run.stderr), 'the runtime prints its marker exactly once').toBe(1);
    expect(run.stderrBytes).toBeLessThan(STDERR_CEILING_BYTES);
  });

  it('uncontained control: the same abort left unawaited with the runtime listeners in place kills the process', () => {
    const run = runChild('uncontained');
    expect(run.probes['run-ok']?.dims).toEqual([1, 3, 384]);
    expect(run.probes.session.counts.uncaughtException, 'the runtime registered its rethrow pair').toBe(run.probes.baseline.counts.uncaughtException + 1);
    expect(run.status, 'the runtime no longer aborts or no longer kills - re-derive this guard').not.toBe(0);
    expect(run.probes.survived).toBeUndefined();
    expect(run.stderr).toContain('Aborted(');
  });
});

/** @returns Whether docker answers and oshal-bot:latest exists locally. */
function imageAvailable(): boolean {
  const run = spawnSync('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 60_000 });
  return run.status === 0;
}

/** @returns The compose workspace volume that caches the model, when it exists. */
function modelCacheVolume(): string | null {
  const run = spawnSync('docker', ['volume', 'inspect', 'oshal-local_oshal_workspace'], { encoding: 'utf8', timeout: 60_000 });
  return run.status === 0 ? 'oshal-local_oshal_workspace' : null;
}

describe.skipIf(!imageAvailable())(`the real embed() inside ${IMAGE} (requires the built image)`, () => {
  /**
   * @description Runs the in-image probe with this working tree's service and the
   * hook fixture mounted over the image's copies, so the case tests the tree, not
   * whichever build the image happens to be.
   * @returns Exit status, stderr and the probe lines.
   */
  function runImageProbe(): ChildRun {
    const posix = (p: string): string => p.replace(/\\/g, '/');
    const args = ['run', '--rm', '--memory=1500m'];
    for (const rel of ['onnx-process-guards.ts', 'local-embedding-service.ts']) {
      args.push('-v', `${posix(path.join(REPO_ROOT, 'src', 'features', 'rag', 'services', rel))}:/app/src/features/rag/services/${rel}:ro`);
    }
    args.push('-v', `${posix(HOOK)}:/app/tests/fixtures/onnx-abort-hook.ts:ro`);
    args.push('-v', `${posix(IMAGE_PROBE)}:/app/tests/fixtures/onnx-abort-image-probe.ts:ro`);
    const cacheVolume = modelCacheVolume();
    if (cacheVolume) args.push('-v', `${cacheVolume}:/cache-src:ro`);
    args.push('-e', 'TRANSFORMERS_CACHE=/cache', '-e', 'NODE_ENV=test', '--entrypoint', 'sh', IMAGE, '-c',
      'mkdir -p /cache && cp -r /cache-src/.transformers-cache/. /cache/ 2>/dev/null; '
      + 'cd /app && npx tsx --tsconfig tsconfig.server.json tests/fixtures/onnx-abort-image-probe.ts');
    const run = spawnSync('docker', args, { encoding: 'utf8', timeout: IMAGE_TIMEOUT_MS });
    const stderr = run.stderr || '';
    return { status: run.status, stderr, stderrBytes: Buffer.byteLength(stderr), probes: parseProbes(run.stdout || '') };
  }

  it('an abort mid-inference returns null, is not re-entered, is logged with caller and input size, and the process survives', () => {
    const run = runImageProbe();
    expect(run.status, run.stderr.slice(0, 400)).toBe(0);
    expect(run.probes['after-load'].dims, 'the real load() and model worked before the abort').toBe(384);
    expect(run.probes['after-abort'].abortsRaised, 'the armed call must have aborted the runtime').toBe(1);
    expect(run.probes['after-abort'].rows).toBeNull();
    expect(run.probes['after-abort-retry'].rows).toBeNull();
    expect(run.probes['after-abort-retry'].importCalls, 'the dead runtime must not be re-entered').toBe(0);
    const line = run.probes['log-line'].line;
    expect(line, 'the service must have logged the abort').not.toBeNull();
    expect(line).toMatchObject({ module: 'local-embedding-service', caller: 'probe', count: 1, abort: true });
    expect(line.chars).toBeGreaterThan(1);
    expect(String(line.error?.message)).toContain('Aborted(');
    expect(run.probes.survived.counts).toEqual(run.probes.baseline.counts);
    expect(bareAbortMarkers(run.stderr), 'the runtime prints its marker exactly once').toBe(1);
    expect(run.stderrBytes).toBeLessThan(STDERR_CEILING_BYTES);
  }, IMAGE_TIMEOUT_MS);
});
