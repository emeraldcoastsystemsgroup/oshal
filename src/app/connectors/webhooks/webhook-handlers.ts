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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Machine-write identity (BACKLOG "Machine-write identity", the class a2a-routes hit in July and the ADR-119 alert intake hit in August): a verified webhook is a MACHINE caller, and this handler was minting `tickets` rows with NO owner_sub at all. `tickets` carries the enforce-stage owner policy, so the row landed owner-less — invisible to every per-owner rail (RLS reads, "my tickets", budgets, DLQ attribution) and insertable only because the caller wrapped dispatch in the operator-stamped system sentinel. TicketSink.createTicket now REQUIRES an ownerSub and ticketingWebhookHandler takes an ownerSubFor(event) resolver — required, not optional, so a future caller cannot forget it the way this one did.
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
    /**
     * The synthetic machine sub that owns webhook-born work. REQUIRED: `tickets` is
     * owner-RLS'd (docs/governance/rls-policies-enforce.sql), and a NULL owner never
     * satisfies `owner_sub = current_setting('oshal.current_sub')` — so an omitted owner
     * is either a refused INSERT or an unattributable row, never a harmless default.
     */
    ownerSub: string;
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
 * Resolves the synthetic machine owner for one verified event. Kept as a function of the event
 * (not a constant) so each provider owns its own slice of webhook-born work — the same shape as
 * the A2A gateway's `ownerSubForA2aAgent(agentId)`.
 */
export type WebhookOwnerResolver = (e: WebhookEvent) => string;

/**
 * Build an onEvent handler that opens a ticket per verified event. Dedup is handled upstream by the
 * ingress SeenStore (delivery id); the externalId here gives a second, ticket-level idempotency anchor.
 *
 * `ownerSubFor` is a REQUIRED third parameter, deliberately. The two production instances of the
 * machine-write-identity defect (a2a-routes, the ADR-119 alert intake) both shipped because the owner
 * was simply absent and nothing demanded it; making it a required argument turns the omission into a
 * compile error instead of an owner-less row.
 */
export function ticketingWebhookHandler(
  sink: TicketSink,
  map: WebhookTicketMapper,
  ownerSubFor: WebhookOwnerResolver,
): (e: WebhookEvent) => Promise<void> {
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
      ownerSub: ownerSubFor(e),
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
