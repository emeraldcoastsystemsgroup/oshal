/**
 * Free-first generation loop (ADR-070) — the heart of the multi-provider Video Studio. Runs the FREE
 * providers for a job type (up to N "different ways", in parallel), judges their output, and:
 *  - if a free result passes → returns `done` at $0;
 *  - if none pass → returns `needs-approval` with the cheapest paid provider + a cost estimate (the
 *    ticket layer parks at `approval_required`; the paid provider runs only after the human approves);
 *  - if nothing free passed and no paid escalation exists → `failed`.
 * Paid providers are NEVER run here — only proposed. This is Token Chase (ADR-046) for media.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial free-first/judge/escalate loop for the multi-provider video platform.
 *
 * @module video-generation/services/generation-loop
 */

import { createChildLogger } from '@/shared/logger';
import type { GenResult, LoopAttempt, LoopOutcome, VideoGenProvider, VideoJobSpec, VideoJudge } from '../types';
import type { VideoProviderRegistry } from './provider-registry';

const logger = createChildLogger({ module: 'video-generation-loop' });

/** Options controlling the loop. */
export interface LoopOptions {
  /** Max free providers to try in parallel (the "3 different ways"). Default 3. */
  maxFree?: number;
}

/** Run one free provider and judge its output; never throws (failures become a failed attempt). */
async function tryProvider(
  provider: VideoGenProvider,
  spec: VideoJobSpec,
  judge: VideoJudge,
): Promise<{ attempt: LoopAttempt; result?: GenResult }> {
  try {
    const result = await provider.generate(spec);
    const verdict = await judge(spec, result);
    return {
      attempt: { providerId: provider.id, costClass: provider.costClass, passed: verdict.pass, score: verdict.score },
      result: verdict.pass ? result : undefined,
    };
  } catch (err) {
    return { attempt: { providerId: provider.id, costClass: provider.costClass, passed: false, error: (err as Error).message } };
  }
}

/** The available free providers for the spec's job type, capped at maxFree. */
async function availableFreeProviders(registry: VideoProviderRegistry, spec: VideoJobSpec, maxFree: number): Promise<VideoGenProvider[]> {
  const free = registry.candidatesFor(spec.jobType).filter((p) => p.costClass === 'free');
  const usable: VideoGenProvider[] = [];
  for (const p of free) {
    const status = await p.probe().catch(() => ({ available: false, providerId: p.id }));
    if (status.available) usable.push(p);
    if (usable.length >= maxFree) break;
  }
  return usable;
}

/**
 * @description Run the free-first loop for a job spec.
 * @param spec - the generation request (carries jobType + inputs)
 * @param registry - the provider registry
 * @param judge - quality gate applied to each free result
 * @param opts - loop options (maxFree)
 * @returns a LoopOutcome: done (free passed) | needs-approval (paid escalation) | failed
 */
export async function runFreeFirstLoop(
  spec: VideoJobSpec,
  registry: VideoProviderRegistry,
  judge: VideoJudge,
  opts: LoopOptions = {},
): Promise<LoopOutcome> {
  const maxFree = opts.maxFree ?? 3;
  const freeProviders = await availableFreeProviders(registry, spec, maxFree);
  logger.info({ jobType: spec.jobType, freeProviders: freeProviders.map((p) => p.id) }, 'free-first loop start');

  const tried = await Promise.all(freeProviders.map((p) => tryProvider(p, spec, judge)));
  const attempts: LoopAttempt[] = tried.map((t) => t.attempt);

  // Best passing free result (highest score; first wins on ties / no score).
  const passed = tried.filter((t) => t.result).sort((a, b) => (b.attempt.score ?? 0) - (a.attempt.score ?? 0));
  if (passed[0]?.result) {
    logger.info({ winner: passed[0].attempt.providerId }, 'free-first loop: free provider passed');
    return { status: 'done', result: passed[0].result, attempts };
  }

  // No free result passed — propose the cheapest available paid escalation (do NOT run it).
  const escalation = await registry.cheapestPaid(spec.jobType, spec);
  if (escalation) {
    logger.info({ providerId: escalation.provider.id, estimatedCostUsd: escalation.estimatedCostUsd }, 'free-first loop: escalation proposed');
    return { status: 'needs-approval', escalation: { providerId: escalation.provider.id, estimatedCostUsd: escalation.estimatedCostUsd }, attempts };
  }

  logger.warn({ jobType: spec.jobType }, 'free-first loop: no free pass and no paid escalation');
  return { status: 'failed', attempts };
}
