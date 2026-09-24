/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (BACKLOG #1788): post-bootstrap installs (provider-switch snapshot, swarm-app auto-load with retry, wiring audit, demo seeding, and package routes settled state tracking) behind waitForBootstrapComplete().
 * -----------------------------------------------------------------------------
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { waitForBootstrapComplete } from './app-runtime-factory';
import { ProviderSwitchStore } from '@/features/agent-management';
import { installProviderSwitchSnapshot } from './provider-switch-runtime';
import { HARNESS_FACTORIES } from './provider-runtime';
import { auditSwarmBotWiring } from '@/app/extensions/swarm/validate-swarm-wiring';
import { seedDemoData, shouldSeedDemoData } from '@/features/demo-mode';
import type { SwarmAppService } from '@/features/swarm-apps';

const defaultLogger = createChildLogger({ module: 'server-bootstrap-tasks' });

export interface ServerBootstrapTasksOptions {
  pool?: Pool;
  swarmAppService: SwarmAppService;
  logger?: any;
}

export interface ServerBootstrapTasksHandle {
  arePackageRoutesSettled: () => boolean;
  isBootWindowSettledOrExpired: () => boolean;
}

/**
 * @description Runs background server bootstrap tasks behind database bootstrap completion.
 * Installs the LLM provider switch snapshot, triggers swarm manifest auto-loading, runs
 * the bot wiring audit, and seeds demo data when enabled.
 */
export function runServerBootstrapTasks(options: ServerBootstrapTasksOptions): ServerBootstrapTasksHandle {
  const logger = options.logger ?? defaultLogger;
  let packageRoutesSettled = false;
  const bootWindowDeadline = Date.now() + Number(process.env.OSHAL_API_BOOT_WINDOW_MS ?? 180_000);

  // The LLM provider switch rows (migration 147): per-bot row > fleet default > registry literal.
  // Read once after the bootstrap so the table exists, then refreshed on a timer. Until the first
  // read lands every bot resolves from the registry literal — the no-row case, unchanged.
  if (options.pool) {
    const switchPool = options.pool;
    void runWithSystemIdentity(() => waitForBootstrapComplete().then(() => installProviderSwitchSnapshot(
      new ProviderSwitchStore(switchPool), Object.keys(HARNESS_FACTORIES),
    ))).catch((err: unknown) => {
      logger.error({ err }, 'Provider switch snapshot could not be installed — bots resolve from the registry literal');
    });
  }

  void runWithSystemIdentity(() => waitForBootstrapComplete().then((migrated: boolean) => {
    if (!migrated) logger.warn('Swarm app auto-load proceeding without confirmed DB bootstrap completion');
    return options.swarmAppService.autoLoadAllWithRetry();
  }).then(async () => {
    // Package routes are as mounted as they will get: the final /api fallback may now answer
    // a hard 404 instead of the boot-window 503 (see createApiFallbackHandler below). Flipped
    // BEFORE the wiring audit + demo seed — those don't mount routes.
    packageRoutesSettled = true;
    // Fail-loud guard: a manifest bot with no endpoint-registry entry compiles green but throws at
    // execute time (the "compiles-but-fails" trap). Audit after load so any gap is screamed at boot.
    await auditSwarmBotWiring(options.swarmAppService);
    // Demo-mode seeding runs AFTER manifests load so per-row dynamic UIs
    // (class icons) register against the same in-memory tool registry
    // that the LM manifest just populated.
    if (shouldSeedDemoData() && options.pool) {
      const summary = await seedDemoData(options.pool);
      logger.info({ summary }, 'Demo-mode seed summary');
    }
  }).catch((err: unknown) => {
    // Fail open to real 404s: autoLoadAllWithRetry has exhausted its retries, so routes that
    // aren't mounted now are not coming — a permanent 503 here would mask genuine misses.
    packageRoutesSettled = true;
    logger.error({ err }, 'Swarm app auto-load failed during boot (non-fatal)');
  }));

  return {
    arePackageRoutesSettled: () => packageRoutesSettled,
    isBootWindowSettledOrExpired: () => packageRoutesSettled || Date.now() >= bootWindowDeadline,
  };
}
