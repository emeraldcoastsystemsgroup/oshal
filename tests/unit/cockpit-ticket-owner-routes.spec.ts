/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards from the signed-in route review (2026-10-05): the cockpit's ticket delete, status history and reply, and the explorer's status history, answer only the ticket's owner (or the operator); another user's ticket reads as missing and is left unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateReadsFixture } from '../fixtures/cockpit-private-reads';

let f: Awaited<ReturnType<typeof privateReadsFixture>>;
beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'admin'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_ALLOW_LEGACY_UNOWNED', 'false'); f = await privateReadsFixture();
  Object.assign(f.ctx, { ticketInteractionService: { processInteraction: vi.fn(async () => ({ success: true, activityEntry: { text: 'reply' } })) } });
});
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); vi.unstubAllEnvs(); });

/** @description One request as a fixture user. */
function send(route: string, user: string, method = 'GET', body?: unknown) {
  return fetch(f.base + route, { method, headers: { 'x-fixture-user': user, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
const interactions = () => (f.ctx as unknown as { ticketInteractionService: { processInteraction: ReturnType<typeof vi.fn> } })
  .ticketInteractionService.processInteraction;

describe("another user's ticket reads as missing and is left unchanged", () => {
  it('refuses history, reply and delete, and the explorer status history', async () => {
    const { ticketId } = await f.ticket('alice');
    expect((await send(`/api/v1/tickets/${ticketId}/history`, 'bob')).status).toBe(404);
    expect((await send(`/api/v1/explorer/tickets/${ticketId}/status-history`, 'bob')).status).toBe(404);
    expect((await send(`/api/v1/tickets/${ticketId}/reply`, 'bob', 'POST', { text: 'not mine' })).status).toBe(404);
    expect(interactions()).not.toHaveBeenCalled();
    expect((await send(`/api/v1/tickets/${ticketId}`, 'bob', 'DELETE')).status).toBe(404);
    expect(await f.ctx.ticketService.getTicket(ticketId)).not.toBeNull();
    expect((await send('/api/v1/tickets/missing-ticket', 'bob', 'DELETE')).status).toBe(404);
  });
});

describe('the owner keeps every route', () => {
  it('reads history, replies and deletes their own ticket', async () => {
    const { ticketId } = await f.ticket('alice');
    expect((await send(`/api/v1/tickets/${ticketId}/history`, 'alice')).status).toBe(200);
    expect((await send(`/api/v1/explorer/tickets/${ticketId}/status-history`, 'alice')).status).toBe(200);
    expect((await send(`/api/v1/tickets/${ticketId}/reply`, 'alice', 'POST', { text: 'an update' })).status).toBe(200);
    expect(interactions()).toHaveBeenCalledWith(expect.objectContaining({ ticketId, text: 'an update' }));
    expect((await send(`/api/v1/tickets/${ticketId}`, 'alice', 'DELETE')).status).toBe(200);
    expect(await f.ctx.ticketService.getTicket(ticketId)).toBeNull();
  });
});
