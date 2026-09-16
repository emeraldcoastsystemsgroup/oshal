/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. In-image probe for the ONNX process-global rethrow-handler fix. Dockerfile.oshal replaces onnxruntime-node with a stub re-exporting onnxruntime-web, which is where the defect is created — so the fix has to be proven in the built image, not only on a dev host whose @xenova/transformers resolves to the native binding. Runs the real load() through localEmbeddings.embed(), then asserts the process is still survivable by raising a stray rejection.
 */

import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { localEmbeddings } from '@/features/rag/services/local-embedding-service';

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
 * @description Reads back the onnxruntime-node stub the Dockerfile writes, so the
 * probe's own output proves it exercised the shimmed wasm runtime and not a native
 * binding that never registers the listeners in the first place.
 * @returns The stub's source, or the reason it could not be read.
 */
function shimSource(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    return fs.readFileSync(require.resolve('onnxruntime-node'), 'utf8').trim();
  } catch (err) {
    return `unreadable: ${String(err)}`;
  }
}

async function main(): Promise<void> {
  installProcessCrashGuards('onnx-image-probe');
  report('baseline', { counts: counts(), shim: shimSource() });

  const vectors = await localEmbeddings.embed(['x']);
  report('after-load', {
    counts: counts(),
    rows: vectors ? vectors.length : null,
    dims: vectors && vectors[0] ? vectors[0].length : null,
  });

  // The stray rejection — nothing awaits it, exactly like an orphaned Redis call.
  Promise.reject(new Error('stray rejection from an unrelated lane'));

  setTimeout(() => {
    report('survived', { counts: counts() });
    process.exit(0);
  }, 500);
}

void main();
