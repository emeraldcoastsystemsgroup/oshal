/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shutdown-hook registry so the controller's SIGTERM/SIGINT handlers can close pools, stop the queue manager, and disconnect transports before exit (2026-07-05 leak audit: the controller previously logged and force-exited without closing anything, while bot-node-server.ts shut down correctly)
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'shutdown-hooks' });

type ShutdownHook = { name: string; fn: () => void | Promise<void> };

const hooks: ShutdownHook[] = [];
let draining = false;

/**
 * @description Registers a named cleanup hook to run on SIGTERM/SIGINT before the
 * process exits. Composition code registers pool.end(); the swarm extension registers
 * queueManagerService.stop(); etc. Hooks run concurrently and each failure is logged,
 * never thrown — the signal handler's force-exit timer remains the backstop.
 * @param name Short identifier used in shutdown logs.
 * @param fn Cleanup function; may return a promise.
 * @returns void
 */
export function registerShutdownHook(name: string, fn: () => void | Promise<void>): void {
  hooks.push({ name, fn });
}

/**
 * @description Runs every registered hook once (idempotent — repeated signals don't
 * re-run hooks) and resolves when all have settled. Individual hook errors are logged
 * at ERROR and swallowed so one bad hook can't block the rest of shutdown.
 * @returns Promise that resolves when all hooks have settled.
 */
export async function runShutdownHooks(): Promise<void> {
  if (draining) return;
  draining = true;
  if (hooks.length === 0) return;
  logger.info({ count: hooks.length, names: hooks.map((h) => h.name) }, 'Running shutdown hooks');
  await Promise.allSettled(
    hooks.map(async (h) => {
      try {
        await h.fn();
        logger.info({ hook: h.name }, 'shutdown hook completed');
      } catch (err) {
        logger.error({ err, hook: h.name }, 'shutdown hook failed');
      }
    }),
  );
}
