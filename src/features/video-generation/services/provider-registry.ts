/**
 * Video generation provider registry + router (ADR-070). Holds the pluggable VideoGenProviders and
 * resolves the ordered candidate list for a job type — FREE providers first, paid last. Mirrors the
 * TTS provider registry's singleton pattern.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial provider registry + free-first router for the multi-provider video platform.
 *
 * @module video-generation/services/provider-registry
 */

import { createChildLogger } from '@/shared/logger';
import type { VideoGenProvider, VideoJobType } from '../types';

const logger = createChildLogger({ module: 'video-provider-registry' });

/**
 * @description Registry of video generation providers. Register providers at composition time;
 * the router returns free-first candidates per job type for the generation loop.
 */
export class VideoProviderRegistry {
  private providers = new Map<string, VideoGenProvider>();

  /** Register (or replace) a provider by id. */
  register(provider: VideoGenProvider): void {
    this.providers.set(provider.id, provider);
    logger.info({ id: provider.id, costClass: provider.costClass, jobTypes: provider.jobTypes }, 'video provider registered');
  }

  /** Look up a provider by id. */
  get(id: string): VideoGenProvider | undefined {
    return this.providers.get(id);
  }

  /** All registered providers. */
  list(): VideoGenProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * @description Ordered candidate providers for a job type — FREE first (stable insertion order
   * within a cost class), paid last. Does not check availability (the loop probes).
   * @param jobType - the job type to route
   * @returns candidate providers, free before paid
   */
  candidatesFor(jobType: VideoJobType): VideoGenProvider[] {
    const matches = this.list().filter((p) => p.jobTypes.includes(jobType));
    const free = matches.filter((p) => p.costClass === 'free');
    const paid = matches.filter((p) => p.costClass === 'paid');
    return [...free, ...paid];
  }

  /** The cheapest available PAID provider for a job type (for the escalation estimate). */
  async cheapestPaid(jobType: VideoJobType, spec: Parameters<VideoGenProvider['estimateCost']>[0]): Promise<{ provider: VideoGenProvider; estimatedCostUsd: number } | null> {
    const paid = this.candidatesFor(jobType).filter((p) => p.costClass === 'paid');
    const priced: Array<{ provider: VideoGenProvider; estimatedCostUsd: number }> = [];
    for (const provider of paid) {
      const status = await provider.probe().catch(() => ({ available: false, providerId: provider.id }));
      if (status.available) priced.push({ provider, estimatedCostUsd: provider.estimateCost(spec) });
    }
    priced.sort((a, b) => a.estimatedCostUsd - b.estimatedCostUsd);
    return priced[0] ?? null;
  }
}

let singleton: VideoProviderRegistry | undefined;

/** Lazy singleton accessor (kept as a function so tests can reset). */
export function getVideoProviderRegistry(): VideoProviderRegistry {
  if (!singleton) singleton = new VideoProviderRegistry();
  return singleton;
}

/** Reset the singleton — tests only. */
export function resetVideoProviderRegistryForTesting(): void {
  singleton = undefined;
}
