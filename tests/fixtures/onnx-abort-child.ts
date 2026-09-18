/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Host child for the embedding-abort containment guard. Real crash guards, the real onnxruntime-web wasm runtime, the real quantized MiniLM that @xenova/transformers ships in its cache, and the runtime's own abort raised from inside a wasm frame in the middle of a real run. `contained` mode awaits the run under try/catch (the shape embed() uses) and proves the process is still serving afterwards; `uncontained` mode leaves the aborting run unawaited with the runtime's rethrow listeners in place, which is the exit-7 signature the api showed — the control that proves the abort is real and lethal when nothing traps it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Correct the model provenance: @xenova/transformers does not ship the quantized MiniLM (its package `files` list is src/dist/types); the weights are downloaded once and cached under the package, so a fresh checkout fails this guard loudly until the cache exists.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { snapshotProcessGuards, stripRethrowGuards } from '@/features/rag/services/onnx-process-guards';
import { installAbortHook } from './onnx-abort-hook';

/** Emits one JSON line on fd 1 that the spec parses. */
function report(stage: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ probe: stage, ...extra })}\n`);
}

/** @returns Current listener counts for the two events the ONNX shell hijacks. */
function counts(): { unhandledRejection: number; uncaughtException: number } {
  return {
    unhandledRejection: process.listeners('unhandledRejection').length,
    uncaughtException: process.listeners('uncaughtException').length,
  };
}

/**
 * @returns The quantized all-MiniLM-L6-v2 cached under @xenova/transformers after its first
 * download. The npm package does NOT ship the weights (its `files` list is src/dist/types), so on
 * a fresh `npm ci` checkout this path does not exist yet and the cases fail loudly on the
 * existsSync assert rather than skipping - a skipped guard is a guard that does not exist.
 */
function modelPath(): string {
  const pkg = path.dirname(require.resolve('@xenova/transformers/package.json'));
  return path.join(pkg, '.cache', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx');
}

/** @returns A one-sentence feed for the model: [CLS] hello [SEP] with mask and segment ids. */
function feeds(ort: any): Record<string, unknown> {
  const dims = [1, 3];
  return {
    input_ids: new ort.Tensor('int64', BigInt64Array.from([101n, 7592n, 102n]), dims),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from([1n, 1n, 1n]), dims),
    token_type_ids: new ort.Tensor('int64', BigInt64Array.from([0n, 0n, 0n]), dims),
  };
}

/** Summarise a thrown value the way the spec wants to see it. */
function describe(err: unknown): Record<string, unknown> {
  return {
    isRuntimeError: err instanceof WebAssembly.RuntimeError,
    name: err instanceof Error ? err.name : typeof err,
    message: String(err instanceof Error ? err.message : err).slice(0, 200),
  };
}

async function main(): Promise<void> {
  const mode = process.env.ONNX_ABORT_CHILD_MODE || 'contained';
  installProcessCrashGuards('onnx-abort-probe');
  const snapshot = snapshotProcessGuards();
  const hook = installAbortHook();
  report('baseline', { mode, counts: counts() });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ort = require('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(modelPath())));
  if (mode === 'contained') stripRethrowGuards(snapshot);
  report('session', { abortKey: hook.abortKey, counts: counts() });

  const ok = await session.run(feeds(ort));
  report('run-ok', { dims: ok.last_hidden_state.dims, importCalls: hook.importCalls() });

  hook.arm();
  if (mode === 'uncontained') {
    // Nothing awaits it and nothing catches it: an unhandled rejection with the
    // runtime's rethrow listeners still installed - the api's exit-7 shape.
    void session.run(feeds(ort));
  } else {
    try {
      await session.run(feeds(ort));
      report('abort-not-raised');
    } catch (err) {
      report('abort-caught', { ...describe(err), abortsRaised: hook.abortsRaised() });
    }
    // What the runtime does when asked again after its own abort - measured, not assumed.
    try {
      const again = await session.run(feeds(ort));
      report('after-abort-run', { threw: false, dims: again.last_hidden_state.dims });
    } catch (err) {
      report('after-abort-run', { threw: true, ...describe(err) });
    }
  }

  setTimeout(() => {
    report('survived', { counts: counts(), abortsRaised: hook.abortsRaised() });
    process.exit(0);
  }, 500);
}

void main();
