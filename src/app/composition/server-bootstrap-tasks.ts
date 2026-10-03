/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (BACKLOG #1788): post-bootstrap installs (provider-switch snapshot, swarm-app auto-load with retry, wiring audit, demo seeding, and package routes settled state tracking) behind waitForBootstrapComplete().
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Register the provider-switch installation promise synchronously before detaching it so canonical dispatch waits for persisted rows instead of racing onto the registry literal.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: install the capability swarm-row snapshot after the database bootstrap, beside the provider-switch snapshot, so a swarm text-to-speech, speech-to-text, image or video row an operator writes moves the next call with no restart.
 * -----------------------------------------------------------------------------
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { waitForBootstrapComplete } from './app-runtime-factory';
import { ProviderSwitchStore } from '@/features/agent-management';
import {
  installProviderSwitchSnapshot,
  trackProviderSwitchSnapshotInstallation,
} from './provider-switch-runtime';
import { HARNESS_FACTORIES } from './provider-runtime';
import { installCapabilityProviderRows } from './capability-provider-runtime';
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
  // Read once after the bootstrap so the table exists, then refresh on a timer. Register the
  // pending read before detaching it: canonical dispatch must not mistake "not loaded yet" for
  // "no row" and execute a divergent registry provider during the boot window.
  if (options.pool) {
    const switchPool = options.pool;
    const installation = runWithSystemIdentity(() => waitForBootstrapComplete().then(() => installProviderSwitchSnapshot(
      new ProviderSwitchStore(switchPool), Object.keys(HARNESS_FACTORIES),
    )));
    trackProviderSwitchSnapshotInstallation(installation);
    void installation.catch((err: unknown) => {
      logger.error({ err }, 'Provider switch snapshot first read failed — canonical dispatch remains unavailable until the periodic refresh succeeds');
    });
    // The capability swarm rows (ADR-173, migration 183): read once the bootstrap has created the
    // table, then refreshed on a timer and after every operator write.
    void runWithSystemIdentity(() => waitForBootstrapComplete().then(() => installCapabilityProviderRows(switchPool)))
      .catch((err: unknown) => {
        logger.error({ err }, 'Capability row snapshot install failed — capability calls refuse until it is installed');
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
