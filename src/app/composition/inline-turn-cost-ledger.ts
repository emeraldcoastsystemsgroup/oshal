/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Binds the orchestrator's InlineTurnCostLedger port to CostTrackingService.recordLedgerEvent over the api's main pool. The pool is the GUC-stamped one, so a row written inside a request carries that request's sub and passes the FORCE-RLS policy on oshal_cost_events (migration 112) exactly as the bot-node ledger writes do; a row that disagrees with the connection identity is refused by Postgres and logged at ERROR by the service, never silently dropped.
 */

import type { Pool } from 'pg';
import { CostTrackingService } from '@/features/operational-intelligence';
import type { InlineTurnCostEvent, InlineTurnCostLedger } from '@/features/chat-orchestration';

/**
 * @description Builds the ledger the controller orchestrator appends each finished turn to.
 * One CostTrackingService per ledger: it holds no per-instance caches beyond the in-memory
 * event list, and the events it is handed already carry their own totals, so nothing here
 * re-counts or re-bills.
 * @param pool - The api's main pool (GUC-wrapped: the request identity stamps every query).
 * @returns The ledger port the orchestrator records through.
 */
export function createInlineTurnCostLedger(pool: Pool): InlineTurnCostLedger {
  const costTracking = new CostTrackingService(pool);
  return {
    async recordInlineTurn(events: readonly InlineTurnCostEvent[]): Promise<void> {
      for (const event of events) {
        await costTracking.recordLedgerEvent({
          taskId: event.taskId,
          // The ledger writer stores a blank agent id as NULL (the column is nullable).
          agentId: event.agentId ?? '',
          providerId: event.providerId,
          modelId: event.modelId,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          inputCost: event.inputCost,
          outputCost: event.outputCost,
          totalCost: event.totalCost,
          currency: event.currency,
          requestCount: event.requestCount,
          ...(event.ownerSub ? { ownerSub: event.ownerSub } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        });
      }
    },
  };
}
