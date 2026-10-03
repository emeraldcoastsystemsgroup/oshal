/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b (D4): records text-to-speech and speech-to-text spend as image spend already is (recordStoryboardImageCost): one cost event through CostTrackingService, so it lands in chat_tasks (a lifetime rollup per capability, provider, caller, accountable bot and UTC day: the cost summary groups chat_tasks by agent_id and a rollup's agent_id is overwritten by each event, so one rollup per bot keeps each bot's spend its own) and oshal_cost_events (one ledger row per call, the rows windowed budget caps sum), carrying the accountable bot and the caller. The amount is the call's units times the offer row's unit price; a free provider records nothing; an unpriced call is recorded at zero, marked estimated, with the reason logged. A person's spend is written under the request identity the server established, so row-level security keeps it that person's row and a caller cannot book spend on someone else; spend with no person behind it (the system, or a legacy caller that named no one) is written as the swarm's own row under the system identity. A failed write is logged at ERROR and never breaks the call that succeeded.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { CostTrackingService } from '@/features/operational-intelligence';
import {
  CAPABILITY_PRICE_UNITS,
  capabilitySpendAmount,
  type CapabilitySpendEvent,
  type CapabilitySpendRecorder,
} from '@/shared/capability-providers';

const logger = createChildLogger({ module: 'capability-spend-recorder' });

/** The agent id a spend carries when the caller named no accountable bot (a legacy caller until S4). */
export const UNATTRIBUTED_CAPABILITY_AGENT = 'unattributed';

/**
 * @description The chat_tasks rollup one spend lands on: one row per capability, provider, caller,
 * accountable bot and UTC day (a person's subject is hashed, never written into the id).
 * @param event - The spend event.
 * @param now - The clock.
 * @returns The task id.
 */
export function capabilitySpendTaskId(
  event: Pick<CapabilitySpendEvent, 'capability' | 'providerId' | 'principal' | 'agentId'>,
  now: Date = new Date(),
): string {
  const owner = event.principal.kind === 'user'
    ? createHash('sha256').update(event.principal.sub).digest('hex').slice(0, 16)
    : event.principal.kind;
  const bot = event.agentId ?? UNATTRIBUTED_CAPABILITY_AGENT;
  return `capability-${event.capability}-${event.providerId}-${owner}-${bot}-${now.toISOString().slice(0, 10)}`;
}

/**
 * @description A recorder that writes each spend event to chat_tasks and oshal_cost_events.
 * @param pool - The api's GUC-wrapped pool.
 * @param deps - The cost store (default CostTrackingService over the pool) and the clock (tests).
 * @returns The recorder; it never throws.
 */
export function createCapabilitySpendRecorder(
  pool: Pool,
  deps: { cost?: Pick<CostTrackingService, 'recordCost'>; now?: () => Date } = {},
): CapabilitySpendRecorder {
  // One service per call, as recordStoryboardImageCost does: CostTrackingService keeps every event it
  // records in an in-memory list, so one instance for the process lifetime would grow with every call.
  const costStore = () => deps.cost ?? new CostTrackingService(pool);
  const now = deps.now ?? (() => new Date());
  return async (event) => {
    if (event.costClass === 'free') return;
    const amount = capabilitySpendAmount(event);
    const person = event.principal.kind === 'user' ? event.principal.sub : null;
    const write = () => costStore().recordCost({
      taskId: capabilitySpendTaskId(event, now()),
      agentId: event.agentId ?? UNATTRIBUTED_CAPABILITY_AGENT,
      providerId: `${event.capability}:${event.providerId}`,
      modelId: event.model ?? event.providerId,
      inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: amount.amountUsd, totalCost: amount.amountUsd,
      currency: 'USD', requestCount: 1, estimated: !amount.priced,
      ...(person ? { ownerSub: person } : {}),
      durationMs: event.durationMs,
    });
    try {
      // A person's row is written under the identity the request established (RLS keeps it theirs);
      // spend with no person behind it is the swarm's own row.
      if (person) await write(); else await runWithSystemIdentity(write);
      logger.info({
        capability: event.capability, providerId: event.providerId, agentId: event.agentId, appId: event.appId,
        ownerKind: event.principal.kind, units: event.units, unit: CAPABILITY_PRICE_UNITS[event.capability],
        unitPriceUsd: event.unitPriceUsd, amountUsd: amount.amountUsd, priced: amount.priced, unpricedReason: amount.unpricedReason,
      }, 'capability spend recorded');
    } catch (err) {
      logger.error({ err, capability: event.capability, providerId: event.providerId }, 'capability spend capture failed — the call itself is unaffected');
    }
  };
}
