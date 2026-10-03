/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: the api-side seam for the capability swarm rows. Installs the one CapabilityRowSnapshot over the Postgres store at boot (after the database bootstrap, so migration 183's table exists), awaits its first read and starts its refresh timer, so every capability call reads the same rows and an operator write moves the next call with no restart (D6). A failed first read is logged and leaves the snapshot installed but unloaded: capability calls then refuse ("rows not read yet") rather than guess the seed, and the timer keeps retrying. Also holds the four capability adapters the operator route lists and validates against — the same adapters the voice and image calls resolve through.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  CapabilityRowSnapshot,
  installCapabilityRowSnapshot,
  type Capability,
  type CapabilityAdapter,
} from '@/shared/capability-providers';
import { CapabilitySwarmRowStore } from '@/features/capability-providers';
import {
  createSttCapabilityAdapter,
  createTtsCapabilityAdapter,
  getSTTProviderRegistry,
  getTTSProviderRegistry,
} from '@/features/voice-providers';
import { createImageCapabilityAdapter, createVideoCapabilityAdapter } from '@/features/video-generation';

const logger = createChildLogger({ module: 'capability-provider-runtime' });

let adapters: Readonly<Record<Capability, CapabilityAdapter>> | null = null;

/**
 * @description The four capability adapters, built once: text to speech and speech to text over
 * the process registries (read per call), images over the storyboard providers, video over the
 * built-in video providers.
 * @returns The adapters by capability.
 */
export function capabilityProviderAdapters(): Readonly<Record<Capability, CapabilityAdapter>> {
  if (!adapters) {
    adapters = Object.freeze({
      tts: createTtsCapabilityAdapter(() => getTTSProviderRegistry()),
      stt: createSttCapabilityAdapter(() => getSTTProviderRegistry()),
      image: createImageCapabilityAdapter(),
      video: createVideoCapabilityAdapter(),
    });
  }
  return adapters;
}

/**
 * @description Create, install and load the capability row snapshot over the swarm-row store.
 * Awaits the first read; a failure is logged and the snapshot stays installed (unloaded) with its
 * timer running, so a transient boot outage self-heals.
 * @param pool - The api's GUC-wrapped pool.
 * @returns The installed snapshot.
 */
export async function installCapabilityProviderRows(pool: Pool): Promise<CapabilityRowSnapshot> {
  const startedAt = Date.now();
  const snapshot = new CapabilityRowSnapshot(new CapabilitySwarmRowStore(pool));
  installCapabilityRowSnapshot(snapshot);
  await snapshot.refresh();
  snapshot.start();
  const status = snapshot.status();
  if (status.loaded) {
    logger.info({ rowCount: status.rowCount, durationMs: Date.now() - startedAt },
      'Capability row snapshot installed — explicit > user default > swarm row > seed');
  } else {
    logger.error({ lastError: status.lastError, durationMs: Date.now() - startedAt },
      'Capability row snapshot first read failed — capability calls refuse until the periodic refresh succeeds');
  }
  return snapshot;
}
