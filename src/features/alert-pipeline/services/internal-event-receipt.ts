/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Atomic, durable idempotency for normalized internal alerts without fabricated webhook envelopes.
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { PIPELINE_OWNER_SUB } from './alert-pipeline-types';
import type { NormalizedAlertInput } from './envelope-store';
import { validateInternalEvent } from './internal-event-validation';

const logger = createChildLogger({ module: 'internal-alert-receipt' });

/** Normalized producer input, not a transport envelope. No HTTP route accepts this contract. */
export interface InternalEventInput {
  source: string;
  /** Stable across polls/restarts; a new occurrence must have a new key. */
  producerKey: string;
  event: NormalizedAlertInput;
}

/** A retained receipt can outlive its event's normal retention period. */
export interface InternalEventResult {
  created: boolean;
  eventId: string | null;
}

type EventWriter = (client: PoolClient, input: InternalEventInput) => Promise<string>;
type Receipt = { payload_hash: string; event_id: string | null };

/** Sort only the two maps; all other fields are constructed in a fixed order by validation. */
function payloadHash(event: NormalizedAlertInput): string {
  const sorted = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({
    ...event, labels: sorted(event.labels), annotations: sorted(event.annotations),
  })).digest('hex');
}

/** Claim and event are one transaction; a failed writer never consumes the producer key. */
async function claimReceipt(client: PoolClient, input: InternalEventInput, write: EventWriter): Promise<InternalEventResult> {
  const key = [PIPELINE_OWNER_SUB, input.source, input.producerKey];
  const hash = payloadHash(input.event);
  const claimed = await client.query(`INSERT INTO oshal_alert_producer_receipt
    (owner_sub, source, producer_key, payload_hash) VALUES ($1, $2, $3, $4)
    ON CONFLICT (owner_sub, source, producer_key) DO NOTHING RETURNING producer_key`, [...key, hash]);
  if (claimed.rowCount === 0) {
    const existing = await client.query<Receipt>(`SELECT payload_hash, event_id FROM oshal_alert_producer_receipt
      WHERE owner_sub = $1 AND source = $2 AND producer_key = $3`, key);
    if (!existing.rows[0] || existing.rows[0].payload_hash !== hash) {
      throw Object.assign(new Error('Internal alert producer key was reused with different content.'), { code: 'ALERT_PRODUCER_CONFLICT' });
    }
    return { created: false, eventId: existing.rows[0].event_id };
  }
  const eventId = await write(client, input);
  await client.query(`UPDATE oshal_alert_producer_receipt SET event_id = $4
    WHERE owner_sub = $1 AND source = $2 AND producer_key = $3`, [...key, eventId]);
  return { created: true, eventId };
}

/**
 * @description Land one internal occurrence exactly once, including across concurrent replicas.
 * The receipt survives event retention; changing a key's content is an error, not silent loss.
 * @param pool - Caller-scoped pipeline pool; this helper never elevates database identity.
 * @param input - Stable producer occurrence and its normalized event.
 * @param write - Existing event insertion on the SAME transaction connection.
 * @returns The original event id, or null if retention has removed that event.
 */
export async function withInternalEventReceipt(pool: Pool, input: InternalEventInput, write: EventWriter): Promise<InternalEventResult> {
  const validated = validateInternalEvent(input);
  const started = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await claimReceipt(client, validated, write);
    await client.query('COMMIT');
    logger.info({ source: validated.source, ...result, durationMs: Date.now() - started }, 'Internal alert landed');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { logger.error({ err: rollbackError }, 'Internal alert rollback failed'); }
    logger.error({ err: error, source: validated.source }, 'Internal alert landing failed');
    throw error;
  } finally {
    client.release();
  }
}
