/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage to ensure brand-new cockpit tickets seed an initial status-history row immediately on creation
 */

import { expect, test } from '@playwright/test';

test.describe('Ticket Process History', () => {
  test('newly created cockpit tickets immediately expose an initial history row', async ({ request }) => {
    const suffix = Date.now().toString(36);

    const createResp = await request.post('/api/v1/tickets', {
      data: {
        title: `Process History Seed ${suffix}`,
        description: 'Verifies initial status history is created with the ticket.',
      },
    });
    expect(createResp.ok()).toBeTruthy();

    const createBody = await createResp.json();
    expect(createBody.success).toBe(true);
    expect(createBody.ticket?.ticketId).toBeTruthy();

    const ticketId = String(createBody.ticket.ticketId);
    const historyResp = await request.get(`/api/v1/tickets/${ticketId}/history`);
    expect(historyResp.ok()).toBeTruthy();

    const historyBody = await historyResp.json();
    expect(historyBody.success).toBe(true);
    expect(Array.isArray(historyBody.history)).toBe(true);
    expect(historyBody.history.length).toBeGreaterThan(0);

    const [initialEntry] = historyBody.history;
    expect(initialEntry.ticketId).toBe(ticketId);
    expect(initialEntry.fromStatus).toBeNull();
    expect(initialEntry.toStatus).toBe('approved');
    expect(initialEntry.changedBy).toBe('system');
    expect(initialEntry.changedByLabel).toBe('System');
  });
});
