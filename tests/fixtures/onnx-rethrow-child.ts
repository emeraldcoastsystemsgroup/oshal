/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Child process for the ONNX process-global rethrow-handler guard. It reproduces the defect and applies the fix in ONE process, because that is the only place the two can be compared: the controller installs its crash guards, the ONNX wasm runtime appends its rethrow listeners behind them, and a stray rejection anywhere then kills the process. Driven by env so the spec can run it with and without the strip and compare exit code and stderr size.
 */

import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { snapshotProcessGuards, stripRethrowGuards } from '@/features/rag/services/onnx-process-guards';

/** Env-flag read that treats only '1' as on, so an empty var is off. */
const on = (name: string): boolean => process.env[name] === '1';

/** Bytes of junk that is not a valid ONNX protobuf — enough to reach wasm init. */
const NOT_A_MODEL = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/** Emits one JSON line on fd 1 that the spec parses. */
function report(stage: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ probe: stage, ...extra })}\n`);
}

/** @returns Current listener counts for the two hijacked process events. */
function counts(): { unhandledRejection: number; uncaughtException: number } {
  return {
    unhandledRejection: process.listeners('unhandledRejection').length,
    uncaughtException: process.listeners('uncaughtException').length,
  };
}

/**
 * @description Forces the ONNX wasm runtime to initialise by asking it to load bytes
 * that are not a model. Session creation fails, but initialisation — and therefore the
 * Emscripten shell's process.on registrations — has already happened by then. This is
 * the same registration path the real `pipeline()` load takes, without the 90 MB model
 * download.
 * @returns void
 */
async function initOnnxRuntime(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ort = require(process.env.ONNX_CHILD_ORT_MODULE || 'onnxruntime-web');
  if (ort.env?.wasm) ort.env.wasm.numThreads = 1;
  try {
    await ort.InferenceSession.create(NOT_A_MODEL);
    report('onnx-create-unexpectedly-resolved');
  } catch {
    report('onnx-create-rejected-as-expected');
  }
}

async function main(): Promise<void> {
  installProcessCrashGuards('onnx-rethrow-probe');
  const snapshot = snapshotProcessGuards();
  report('baseline', { counts: counts() });

  if (on('ONNX_CHILD_INIT')) {
    await initOnnxRuntime();
  }
  report('after-init', { counts: counts() });

  if (on('ONNX_CHILD_STRIP')) {
    const stripped = stripRethrowGuards(snapshot);
    report('after-strip', { counts: counts(), stripped });
  }

  // The stray rejection. Nothing in this process awaits it — exactly the shape of an
  // orphaned Redis call or an SSE write to a closed socket in the live api.
  Promise.reject(new Error('stray rejection from an unrelated lane'));

  // Long enough for Node to fire unhandledRejection and for anything it triggers to
  // play out. If the process is still alive by now, the rejection was survivable.
  setTimeout(() => {
    report('survived', { counts: counts() });
    process.exit(0);
  }, 500);
}

void main();
