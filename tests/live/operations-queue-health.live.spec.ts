/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live authenticated proof for the Operations queue-health card.
 */

/**
 * @description
 * Read-only live proof that the operator cockpit shows queue/build truth without
 * log-diving. Attaches to the operator's already-signed-in Chrome via CDP.
 */
import { test, expect } from './fixtures';
import { openCockpit, openTool } from './helpers';

type QueueHealthPayload = {
  success?: boolean;
  data?: {
    status?: string;
    generatedAt?: string;
    totals?: Record<string, unknown>;
    workItems?: Record<string, unknown>;
    actions?: string[];
  };
  status?: string;
  generatedAt?: string;
  totals?: Record<string, unknown>;
  workItems?: Record<string, unknown>;
  actions?: string[];
};

test('operations surface renders authenticated queue health evidence', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await openCockpit(page);
  await openTool(page, 'operations');

  const card = page.locator('.ops-queue-card').first();
  await expect(card, 'Operations should render the queue-health card').toBeVisible({ timeout: 90_000 });
  await expect(card.getByText('Queue Health')).toBeVisible();
  await expect(card.locator('.ops-queue-status')).toHaveText(/healthy|degraded|blocked|unknown/i);

  const cardText = await card.innerText();
  expect(cardText).toMatch(/Approved/i);
  expect(cardText).toMatch(/In Process/i);
  expect(cardText).toMatch(/Build Open/i);
  expect(cardText).toMatch(/Routing Failed/i);

  const api = await page.evaluate(async () => {
    const res = await fetch('/api/v1/metrics/queue-health?scope=all', { credentials: 'same-origin' });
    const payload = await res.json().catch(async () => ({ raw: await res.text() }));
    return { status: res.status, payload };
  }) as { status: number; payload: QueueHealthPayload };

  expect(api.status, 'queue-health API should be reachable in the signed-in browser session').toBe(200);
  const data = api.payload.data || api.payload;
  expect(String(data.status || '')).toMatch(/healthy|degraded|blocked/i);
  expect(data.generatedAt).toBeTruthy();
  expect(data.totals).toBeTruthy();
  expect(data.workItems).toBeTruthy();

  await testInfo.attach('operations-queue-health-card', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await testInfo.attach('queue-health-api.json', {
    body: JSON.stringify(api.payload, null, 2),
    contentType: 'application/json',
  });
});
