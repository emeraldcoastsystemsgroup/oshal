/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. In-image probe for embedding-abort containment. Runs inside oshal-bot:latest, where Dockerfile.oshal shims onnxruntime-node to onnxruntime-web and the api actually embeds on wasm: real crash guards, the real localEmbeddings.embed() through the real load() and model, then the runtime's own abort raised from inside a wasm frame mid-inference. Reports whether embed() returned null, whether the next call re-entered the runtime, what the service logged (caller and input size), and whether the process is still serving.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
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
 * @description Reads back what local-embedding-service logged about the abort, from
 * the logger's own file transport (output/logs/<SERVICE_NAME>.log under cwd), so the
 * probe's report carries the real log line rather than a claim about it.
 * @returns The parsed line, or null when none was written.
 */
function abortLogLine(): Record<string, unknown> | null {
  const file = path.resolve(process.cwd(), 'output', 'logs', `${process.env.SERVICE_NAME || 'OSHAL'}.log`);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.includes('aborted mid-inference'));
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return { unparsable: lines[lines.length - 1].slice(0, 300) };
  }
}

async function main(): Promise<void> {
  installProcessCrashGuards('onnx-abort-image-probe');
  // Before the service is even imported: the hook must see the instantiation load() triggers.
  const hook = installAbortHook();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { localEmbeddings } = require('@/features/rag/services/local-embedding-service');
  report('baseline', { counts: counts() });

  const first = await localEmbeddings.embed(['x'], 'probe');
  report('after-load', { counts: counts(), abortKey: hook.abortKey, rows: first ? first.length : null, dims: first?.[0]?.length ?? null });

  hook.arm();
  const aborted = await localEmbeddings.embed(['a longer text so the input size in the log is not one character'], 'probe');
  report('after-abort', { rows: aborted ? aborted.length : null, abortsRaised: hook.abortsRaised() });

  hook.resetImportCalls();
  const retry = await localEmbeddings.embed(['z'], 'probe');
  report('after-abort-retry', { rows: retry ? retry.length : null, importCalls: hook.importCalls(), abortsRaised: hook.abortsRaised() });

  // Let the pino transport flush before the log file is read and the process exits.
  setTimeout(() => {
    report('log-line', { line: abortLogLine() });
    report('survived', { counts: counts() });
    process.exit(0);
  }, 1500);
}

void main();
