/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A2A outbound cost stamper (Plan F item 3). Composition-root sink for A2AHarnessAdapter cost events. Remote-REPORTED usage deliberately does NOT get re-billed here — it rides HarnessResult.usage into the existing recordCost/recordUsage pipelines under the bot's agent_id, and writing it again would double-count chat_tasks exactly like record-cost.ts documents for the Argo run marker. What CANNOT ride that path is the honesty marker: when the remote reported NO usage, this stamper writes a zero-cost chat_tasks marker row (requestCount 0) and stamps metadata.costUnknown=true so "unknown remote cost" is queryable instead of silently indistinguishable from free.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: HarnessResult only carries token counts, never a dollar figure — so a remote agent's reported totalCostUsd was NEVER riding the "existing recordCost pipeline" the way the header above claims; HarnessLLMBridge inherits LLMService's base $0 calculateCost() and usage-cost-resolver.ts has no fallback pricing for provider 'a2a', so a real invoiced cost landed in chat_tasks as a clean, unflagged $0. Added stampReportedCost(): a dollar-only supplemental row (inputTokens/outputTokens/requestCount all 0, so the generic token pipeline's merge-by-taskId still owns token counting and request counting exactly once) that persists event.totalCost and marks metadata.costSource='a2a-remote-reported' for queryability, mirroring the costUnknown marker's shape.
 */

import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { CostTrackingService } from '@/features/operational-intelligence';
import { createOptionalPostgresPool } from '@/shared/services/database';
import type { A2ACostEvent, A2ARecordCostFn } from '@/features/llm-provider';

const logger = createChildLogger({ module: 'a2a-cost-stamper' });

/** Lazily-created shared pool — one per process, first a2a cost event pays the connect. */
let sharedPool: Pool | null | undefined;

/** @returns The process-shared stamper pool (null when Postgres is not configured). */
function resolvePool(): Pool | null {
  if (sharedPool === undefined) {
    sharedPool = createOptionalPostgresPool('a2a-cost-stamper');
  }
  return sharedPool;
}

/**
 * @description Test seam: resets the module-level pool cache so unit tests can
 * exercise the "no database" and "database present" branches independently.
 * @param pool - Replacement pool, null for "no DB", or undefined to re-resolve lazily.
 * @returns Nothing.
 */
export function resetA2ACostStamperPool(pool?: Pool | null): void {
  sharedPool = pool;
}

/**
 * @description Persists a supplemental chat_tasks row for an A2ACostEvent and
 * stamps a queryable metadata marker, additively merging with any row the
 * generic execution pipeline already wrote for the same taskId (chat_tasks
 * upserts by taskId and SUMS tokens/cost/requestCount on conflict — see
 * `persistCostEvent` in cost-tracking-service.ts).
 * @param pool - Live Postgres pool (caller already confirmed it's non-null).
 * @param event - The a2a cost event driving this stamp.
 * @param costFields - The token/cost/requestCount contribution THIS stamp adds.
 * @param metadataExtra - Provenance fields merged into chat_tasks.metadata.
 * @returns Resolves once both the cost row and the metadata stamp are written.
 */
async function persistStamp(
  pool: Pool,
  event: A2ACostEvent,
  costFields: { inputTokens: number; outputTokens: number; inputCost: number; outputCost: number; totalCost: number; requestCount: number },
  metadataExtra: Record<string, unknown>,
): Promise<void> {
  await new CostTrackingService(pool).recordCost({
    taskId: event.taskId,
    agentId: event.agentId,
    providerId: event.providerId,
    modelId: event.modelId,
    currency: event.currency,
    estimated: false,
    ...costFields,
  });
  await pool.query(
    `UPDATE chat_tasks
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
      WHERE task_id = $1`,
    [event.taskId, JSON.stringify({ ...metadataExtra, remoteEndpointHost: event.remoteEndpointHost })],
  );
}

/**
 * @description Stamps the honesty marker for a costUnknown event: a zero-cost,
 * zero-request chat_tasks row plus `metadata.costUnknown=true` so "the remote
 * reported nothing" is queryable instead of silently indistinguishable from
 * "the remote reported a real $0".
 * @param pool - Live Postgres pool.
 * @param event - The costUnknown a2a cost event.
 * @returns Resolves once the marker is persisted.
 */
async function stampCostUnknownMarker(pool: Pool, event: A2ACostEvent): Promise<void> {
  await persistStamp(
    pool,
    event,
    { inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, requestCount: 0 },
    { costUnknown: true, costSource: 'a2a-remote' },
  );
  logger.info(
    { taskId: event.taskId, agentId: event.agentId, remoteEndpointHost: event.remoteEndpointHost },
    'a2a costUnknown marker stamped on chat_tasks',
  );
}

/**
 * @description Stamps a remote agent's REPORTED dollar cost. `HarnessResult`
 * only carries token counts (no cost field), so a real invoiced totalCostUsd
 * has no other path into chat_tasks — the generic execution pipeline resolves
 * it to $0 (HarnessLLMBridge inherits the base $0 `calculateCost()`, and
 * usage-cost-resolver.ts has no fallback pricing entry for provider 'a2a').
 * Token counts and requestCount stay 0 here on purpose: the generic pipeline
 * already counts the 1 real request and its real tokens for this taskId, and
 * chat_tasks additively merges by taskId, so this is a dollar-only top-up, not
 * a duplicate request.
 * @param pool - Live Postgres pool.
 * @param event - The cost-known a2a cost event (event.totalCost > 0).
 * @returns Resolves once the reported cost is persisted.
 */
async function stampReportedCost(pool: Pool, event: A2ACostEvent): Promise<void> {
  await persistStamp(
    pool,
    event,
    { inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: event.totalCost, totalCost: event.totalCost, requestCount: 0 },
    { costSource: 'a2a-remote-reported' },
  );
  logger.info(
    { taskId: event.taskId, agentId: event.agentId, totalCost: event.totalCost, remoteEndpointHost: event.remoteEndpointHost },
    'a2a remote-reported cost stamped on chat_tasks',
  );
}

/**
 * @description Builds the A2ARecordCostFn the a2a harness factory injects.
 *
 * Two honesty markers, one dispatch: when the remote reported NO usage at all
 * (`costUnknown`), stamp the zero-cost "unknown" marker. When the remote
 * reported usage but no dollar cost (a genuinely free call), there is nothing
 * to bill — token counts already ride the generic pipeline. When the remote
 * reported a real dollar cost, stamp it (see `stampReportedCost` for why that
 * dollar figure has no other path into chat_tasks).
 *
 * @returns A cost-event sink safe to call on every a2a run; degrades to a
 * logged no-op when Postgres is not configured.
 */
export function createA2ACostStamper(): A2ARecordCostFn {
  return async (event: A2ACostEvent): Promise<void> => {
    if (!event.costUnknown && event.totalCost <= 0) {
      logger.debug(
        { taskId: event.taskId, agentId: event.agentId },
        'a2a cost event carries reported usage with no dollar figure — token counts ride the usage pipeline, nothing to bill',
      );
      return;
    }

    const pool = resolvePool();
    if (!pool) {
      logger.warn(
        { taskId: event.taskId, agentId: event.agentId, costUnknown: event.costUnknown },
        'a2a cost stamp skipped — no Postgres configured (visible skip, not silent)',
      );
      return;
    }

    try {
      if (event.costUnknown) {
        await stampCostUnknownMarker(pool, event);
      } else {
        await stampReportedCost(pool, event);
      }
    } catch (err) {
      logger.error(
        { err, taskId: event.taskId, agentId: event.agentId, costUnknown: event.costUnknown },
        'a2a cost stamp failed — non-blocking',
      );
    }
  };
}
