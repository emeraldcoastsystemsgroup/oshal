/**
 * Webhook handlers + production dedup store (ADR-065 Phase 3).
 *
 * Phase 2 gave the ingress core (verify + dispatch) with an in-memory SeenStore. This wires the two
 * production pieces:
 *   1. `ticketingWebhookHandler` — turns a verified webhook event into a swarm ticket, the same way
 *      the Alertmanager route opens incident tickets, but generic over (provider, event) + a mapper.
 *   2. `dbSeenStore` — a cross-replica dedup store backed by a tiny table, injectable via a `query`
 *      function so it's testable without a live database.
 *
 * Both are decoupled (no direct pg/TicketService import) — callers pass a minimal interface — so this
 * module unit-tests offline and doesn't drag the whole controller into the runtime.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 Phase 3. Additive.
 * -----------------------------------------------------------------------------
 * @module connectors/webhooks/webhook-handlers
 */

import type { SeenStore, WebhookEvent } from './webhook-ingress';

/** The slice of the ticket service this handler needs (keeps the runtime decoupled). */
export interface TicketSink {
  createTicket(input: {
    title: string;
    ticketType: string;
    description: string;
    externalProvider: string;
    externalId: string;
    labels: string[];
    metadata: Record<string, unknown>;
  }): Promise<{ ticketId: string }>;
}

/** Map a verified webhook event to the ticket fields. Return null to ACK without creating a ticket. */
export type WebhookTicketMapper = (e: WebhookEvent) => {
  title: string;
  ticketType: string;
  description: string;
  labels?: string[];
} | null;

/**
 * Build an onEvent handler that opens a ticket per verified event. Dedup is handled upstream by the
 * ingress SeenStore (delivery id); the externalId here gives a second, ticket-level idempotency anchor.
 */
export function ticketingWebhookHandler(sink: TicketSink, map: WebhookTicketMapper): (e: WebhookEvent) => Promise<void> {
  return async (e) => {
    const mapped = map(e);
    if (!mapped) return;
    await sink.createTicket({
      title: mapped.title,
      ticketType: mapped.ticketType,
      description: mapped.description,
      externalProvider: e.provider,
      externalId: e.deliveryId,
      labels: ['webhook', `provider:${e.provider}`, `event:${e.event}`, ...(mapped.labels || [])],
      metadata: { source: 'webhook', provider: e.provider, event: e.event, deliveryId: e.deliveryId, payload: e.payload },
    });
  };
}

/** Minimal async query interface (pg Pool.query is compatible). */
export type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * A cross-replica dedup store backed by a small table:
 *   CREATE TABLE IF NOT EXISTS oshal_webhook_deliveries (delivery_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ DEFAULT NOW());
 * `has` checks existence; `add` inserts ON CONFLICT DO NOTHING (so two replicas racing the same
 * delivery both stay correct). Injectable `query` keeps it unit-testable.
 */
export function dbSeenStore(query: QueryFn, table = 'oshal_webhook_deliveries'): SeenStore {
  return {
    has: async (id) => {
      const { rows } = await query(`SELECT 1 FROM ${table} WHERE delivery_id = $1 LIMIT 1`, [id]);
      return rows.length > 0;
    },
    add: async (id) => {
      await query(`INSERT INTO ${table} (delivery_id) VALUES ($1) ON CONFLICT (delivery_id) DO NOTHING`, [id]);
    },
  };
}
