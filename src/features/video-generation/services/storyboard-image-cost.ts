/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Canonical cost capture for storyboard/portrait image generation. Image spend previously lived only in the vendor's dashboard — invisible to chat_tasks / oshal_cost_events, so budgets and run traces under-counted. Part of the media-generation kernel skill so installed app packages (Portrait Studio) can record spend WITHOUT importing operational-intelligence directly (kernel-skills doctrine: packages import only declared skill modules).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cost observability (migration 090): optional StoryboardImageCostEvent.durationMs passes a caller-measured generation duration through to the per-call ledger row; callers that don't time the call omit it and the ledger stores NULL.
 */
/**
 * @description Record one image-generation spend event in the canonical cost stores.
 *
 * Writes through {@link CostTrackingService} so the event lands in BOTH places the platform
 * reads: `chat_tasks` (lifetime rollup per task — the canonical $-cost table) and
 * `oshal_cost_events` (the per-event ledger daily budget caps sum). Failures are logged and
 * swallowed — cost capture must never break a generation that already succeeded.
 *
 * @module features/video-generation/services/storyboard-image-cost
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { CostTrackingService } from '@/features/operational-intelligence';

const logger = createChildLogger({ module: 'storyboard-image-cost' });

/** @description One image-generation spend event, attributed to a bot and an end user. */
export interface StoryboardImageCostEvent {
  /** Unique task id for the rollup row (e.g. `portrait-<uuid>` — one per generation). */
  taskId: string;
  /** The accountable bot (agents table id) this generation ran under. */
  agentId: string;
  /** End user the spend is attributable to (per-owner budget enforcement), or null for system work. */
  ownerSub: string | null;
  /** Provider tag, e.g. `image-provider:openrouter`. */
  providerId: string;
  /** Concrete model that produced the image. */
  model: string;
  /** Vendor-reported cost in USD for this one image. */
  costUsd: number;
  /** Measured wall-clock duration (ms) of the generation call, when the caller timed it
   *  (090 ledger observability). Omit rather than fabricate. */
  durationMs?: number;
}

/**
 * @description Persist an image-generation cost event to chat_tasks + oshal_cost_events.
 * @param pool - The api's pg pool (packages: `ctx.pool`).
 * @param event - The spend event.
 * @returns Resolves when recorded (or the failure has been logged) — never throws.
 */
export async function recordStoryboardImageCost(pool: Pool, event: StoryboardImageCostEvent): Promise<void> {
  try {
    await new CostTrackingService(pool).recordCost({
      taskId: event.taskId,
      agentId: event.agentId,
      providerId: event.providerId,
      modelId: event.model,
      inputTokens: 0,
      outputTokens: 0,
      inputCost: 0,
      outputCost: event.costUsd,
      totalCost: event.costUsd,
      currency: 'USD',
      requestCount: 1,
      ownerSub: event.ownerSub ?? undefined,
      durationMs: event.durationMs,
    });
    logger.info({ taskId: event.taskId, providerId: event.providerId, model: event.model, costUsd: event.costUsd }, 'image generation cost recorded');
  } catch (err) {
    logger.error({ err, taskId: event.taskId }, 'image cost capture failed — the generation itself is unaffected');
  }
}
