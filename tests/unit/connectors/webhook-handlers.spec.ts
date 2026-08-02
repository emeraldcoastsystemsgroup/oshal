/**
 * Phase 3 webhook handlers + DB-backed dedup store conformance (ADR-065).
 *
 * Asserts a verified event opens a ticket via the generic mapper, the mapper can ACK-without-ticket,
 * and the dbSeenStore dedups correctly with an injected query fn (no live database).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ADR-065 Phase 3 conformance.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ownerSubFor is now a required argument (machine-write identity): the handler used to mint tickets with no owner at all, which on the owner-RLS tickets table means a refused INSERT under a stamped connection and an unattributable row under an operator one. The happy-path case asserts the resolved owner reaches the sink, and a new case pins that it is derived PER EVENT rather than baked in.
 *
 * @module tests/unit/connectors/webhook-handlers
 */
import { describe, it, expect, vi } from 'vitest';
import { ticketingWebhookHandler, dbSeenStore, type TicketSink } from '@/app/connectors/webhooks/webhook-handlers';
import { dispatchWebhook, inMemorySeenStore, type WebhookEvent, type WebhookEventSpec } from '@/app/connectors/webhooks/webhook-ingress';
import crypto from 'crypto';

const ev = (over: Partial<WebhookEvent> = {}): WebhookEvent => ({ provider: 'github', event: 'push', deliveryId: 'd1', payload: { ref: 'main' }, headers: {}, ...over });

describe('ticketingWebhookHandler', () => {
  it('opens a ticket from a verified event with provider/event labels + external anchor', async () => {
    const created: any[] = [];
    const sink: TicketSink = { createTicket: async (i) => { created.push(i); return { ticketId: 't1' }; } };
    const handler = ticketingWebhookHandler(
      sink,
      (e) => ({ title: `push on ${(e.payload as any).ref}`, ticketType: 'incident', description: 'x' }),
      (e) => `webhook:${e.provider}`,
    );
    await handler(ev());
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ externalProvider: 'github', externalId: 'd1', ticketType: 'incident' });
    expect(created[0].labels).toEqual(expect.arrayContaining(['webhook', 'provider:github', 'event:push']));
    // The half that was missing entirely: without an owner the row cannot satisfy the owner-RLS
    // WITH CHECK on tickets, so it is refused (or lands unattributable). See the machine-write
    // identity class gate, tests/unit/machine-write-identity.spec.ts.
    expect(created[0].ownerSub).toBe('webhook:github');
  });

  it('resolves the owner PER EVENT, so one provider secret cannot own another provider\u2019s tickets', async () => {
    const created: any[] = [];
    const sink: TicketSink = { createTicket: async (i) => { created.push(i); return { ticketId: 't1' }; } };
    const handler = ticketingWebhookHandler(
      sink,
      () => ({ title: 't', ticketType: 'incident', description: 'x' }),
      (e) => `webhook:${e.provider}`,
    );
    await handler(ev({ provider: 'github' }));
    await handler(ev({ provider: 'stripe', deliveryId: 'd2' }));
    expect(created.map((c) => c.ownerSub)).toEqual(['webhook:github', 'webhook:stripe']);
  });

  it('ACKs without a ticket when the mapper returns null', async () => {
    const sink: TicketSink = { createTicket: vi.fn() as any };
    const handler = ticketingWebhookHandler(sink, () => null, (e) => `webhook:${e.provider}`);
    await handler(ev());
    expect(sink.createTicket).not.toHaveBeenCalled();
  });
});

describe('dbSeenStore', () => {
  it('reports unseen then seen, and inserts ON CONFLICT DO NOTHING', async () => {
    const table = new Set<string>();
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      const id = params[0] as string;
      if (/SELECT/.test(sql)) return { rows: table.has(id) ? [{ '?column?': 1 }] : [] };
      if (/INSERT/.test(sql)) { table.add(id); return { rows: [] }; }
      return { rows: [] };
    });
    const store = dbSeenStore(query);
    expect(await store.has('x')).toBe(false);
    await store.add('x');
    expect(await store.has('x')).toBe(true);
    expect(query.mock.calls.some(([sql]) => /ON CONFLICT/.test(sql))).toBe(true);
  });

  it('integrates with dispatchWebhook for cross-replica dedup', async () => {
    const table = new Set<string>();
    const query = async (sql: string, params: unknown[]) => {
      const id = params[0] as string;
      if (/SELECT/.test(sql)) return { rows: table.has(id) ? [1] : [] };
      table.add(id); return { rows: [] };
    };
    const SECRET = 's';
    const body = JSON.stringify({ a: 1 });
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const events: WebhookEventSpec[] = [{ provider: 'github', event: 'push', verify: { type: 'hmac', header: 'X-Sig', secret: SECRET } }];
    const onEvent = vi.fn();
    const seen = dbSeenStore(query);
    const headers = { 'x-sig': sig, 'x-delivery-id': 'gh1' };
    await dispatchWebhook({ events, onEvent, seen }, { provider: 'github', event: 'push' }, body, headers);
    const replay = await dispatchWebhook({ events, onEvent, seen }, { provider: 'github', event: 'push' }, body, headers);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(replay.body.deduped).toBe(true);
  });
});

// keep inMemorySeenStore referenced so the import stays meaningful across refactors
void inMemorySeenStore;
