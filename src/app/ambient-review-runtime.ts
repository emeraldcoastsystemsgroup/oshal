/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the controller-side local-time daily review scheduler and confirmation-question delivery into the existing user-model suggestion inbox.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ran the daily-review sweep under runWithSystemIdentity — a cross-owner background sweep that writes the FORCE-RLS ambient_daily_reviews table; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 */

import type { Pool } from 'pg';
import {
  ambientListeningFor,
  type AmbientActionSuggestion,
  type AmbientListeningServiceContract,
} from '@/features/ambient-listening';
import { userModelFor } from '@/features/user-model';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';

const logger = createChildLogger({ module: 'ambient-review-runtime' });
const DEFAULT_SWEEP_MS = 60_000;
const timers = new WeakMap<Pool, NodeJS.Timeout>();

/** @description Proposal sink used by the background review scheduler. */
export type AmbientReviewProposalSink = (
  userSub: string,
  suggestion: AmbientActionSuggestion,
) => Promise<void>;

/**
 * @description Runs one due-review sweep and queues confirmation questions only.
 * @param service - Ambient persistence/review service.
 * @param sink - Owner-scoped proposal inbox sink.
 * @param now - Sweep instant, injectable for tests.
 * @returns Counts of reviews created, proposals queued, and actions executed (always zero).
 */
export async function runAmbientReviewSweep(
  service: AmbientListeningServiceContract,
  sink: AmbientReviewProposalSink,
  now = new Date(),
): Promise<{ reviewsCreated: number; proposalsQueued: number; actionsExecuted: 0 }> {
  const reviews = await service.reviewDueDays(now);
  let proposalsQueued = 0;
  for (const entry of reviews) {
    const results = await Promise.allSettled(
      entry.review.suggestions.map((suggestion) => sink(entry.userSub, suggestion)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') proposalsQueued += 1;
      else logger.error({ err: result.reason }, 'Scheduled ambient proposal could not be queued');
    }
  }
  return { reviewsCreated: reviews.length, proposalsQueued, actionsExecuted: 0 };
}

/**
 * @description Starts one unref'd process scheduler per pool. Reviews use each owner's configured
 * IANA time zone and HH:mm; disabling daily review or follow-up suggestions is honored by service.
 * @param pool - Shared GUC-aware Postgres pool.
 * @returns Void after the singleton scheduler is registered.
 */
export function startAmbientReviewRuntime(pool: Pool): void {
  if (timers.has(pool)) return;
  const service = ambientListeningFor(pool);
  const sink = proposalSink(pool);
  const sweep = () => {
    void runWithSystemIdentity(() => runAmbientReviewSweep(service, sink)).then((result) => {
      if (result.reviewsCreated > 0) logger.info(result, 'Scheduled ambient daily reviews completed');
    }).catch((error: unknown) => {
      logger.error({ err: error }, 'Scheduled ambient daily review sweep failed');
    });
  };
  const timer = setInterval(sweep, readSweepInterval());
  timer.unref();
  timers.set(pool, timer);
  registerShutdownHook('ambient-daily-review', () => clearInterval(timer));
}

function proposalSink(pool: Pool): AmbientReviewProposalSink {
  return async (userSub, suggestion) => {
    const kind = suggestion.kind === 'reminder'
      ? 'ambient-reminder'
      : suggestion.kind === 'task' ? 'ambient-task' : 'ambient-follow-up';
    await userModelFor(pool).proposeSuggestion(userSub, { kind, message: suggestion.prompt });
  };
}

function readSweepInterval(): number {
  const configured = Number(process.env.AMBIENT_REVIEW_SWEEP_MS ?? DEFAULT_SWEEP_MS);
  if (!Number.isFinite(configured)) return DEFAULT_SWEEP_MS;
  return Math.min(86_400_000, Math.max(15_000, Math.floor(configured)));
}
