/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the controller's process-level crash guards into one shared installer and gave them to the runtimes that had none. server.ts has had these since the crash-guard pass; bot-node-server.ts — the runtime that owns ALL LLM execution, across every bot container — did not, so a single stray rejection killed a bot node silently with no log line, which is exactly the failure mode the controller's comment describes. Mirrors the 2026-07-05 shutdown-hooks audit, where the asymmetry ran the other way.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'process-crash-guards' });

/** Milliseconds allowed for the logger to flush before a fatal exit. */
const FLUSH_GRACE_MS = 250;

let installed = false;

/**
 * @description Installs process-level handlers for unhandled rejections and uncaught exceptions.
 *
 * Node 15+ terminates on an unhandled promise rejection with NO output. Without these handlers a
 * long-running service dies silently after a stray rejected Redis call, an SSE write to a closed
 * socket, a provider HTTP timeout nobody awaited — and under a container restart policy it comes
 * straight back up, so the only evidence is a restart count nobody is watching.
 *
 * A rejection logs at ERROR and the process stays alive: one orphaned promise is not a reason to
 * drop in-flight work. An uncaught exception means the process state can no longer be trusted, so
 * it logs and exits non-zero, letting the supervisor restart it cleanly — with a delay so the
 * logger can flush, since a diagnostic that dies with the process is worth nothing.
 *
 * Idempotent: repeated calls are ignored, so an entrypoint that both calls this and is imported by
 * a test does not stack duplicate handlers.
 *
 * @param runtime - Short name of the runtime being guarded, included in every log line so a crash
 *                  in a 30-container fleet is attributable to the right process.
 * @returns void
 */
export function installProcessCrashGuards(runtime: string): void {
  if (installed) {
    return;
  }
  installed = true;

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(
      {
        runtime,
        err: reason instanceof Error ? reason : new Error(String(reason)),
        promise: String(promise),
      },
      'UNHANDLED PROMISE REJECTION — process kept alive',
    );
  });

  process.on('uncaughtException', (error, origin) => {
    logger.error({ runtime, err: error, origin }, 'UNCAUGHT EXCEPTION — process will exit');
    setTimeout(() => process.exit(1), FLUSH_GRACE_MS);
  });
}

/**
 * @description Resets the install latch. Test-only — production installs exactly once per process.
 * @returns void
 */
export function resetProcessCrashGuardsForTest(): void {
  installed = false;
}
