/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live authenticated proof for the ADR-067 connector marketplace.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Tighten KPI assertions so the live proof does not fail on duplicate copy text.
 */

/**
 * @description
 * Read-only live proof that the operator cockpit exposes the connector marketplace
 * and that the authenticated browser can reach the marketplace API.
 */
import { test, expect } from './fixtures';
import { openCockpit, openTool } from './helpers';

type MarketplacePayload = {
  success?: boolean;
  data?: {
    totals?: {
      entries?: number;
      enabled?: number;
      available?: number;
      blocked?: number;
      writeCapable?: number;
    };
    entries?: Array<{ id?: string; installState?: string; audit?: { pass?: boolean } }>;
  };
};

test('connectors surface renders authenticated marketplace evidence', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await openCockpit(page);
  await openTool(page, 'connectors');

  const surface = page.locator('.connector-view').first();
  await expect(surface, 'Connectors should render the marketplace surface').toBeVisible({ timeout: 90_000 });
  await expect(surface.getByText('Connectors')).toBeVisible();
  await expect(surface.locator('.connector-kpi-label', { hasText: /^Catalog$/ })).toBeVisible();
  await expect(surface.locator('.connector-kpi-label', { hasText: /^Enabled$/ })).toBeVisible();
  await expect(surface.locator('.connector-kpi-label', { hasText: /^Write-capable$/ })).toBeVisible();
  await expect(page.locator('.connector-card').first()).toBeVisible({ timeout: 90_000 });

  const api = await page.evaluate(async () => {
    const res = await fetch('/api/connectors/marketplace', { credentials: 'same-origin' });
    const payload = await res.json().catch(async () => ({ raw: await res.text() }));
    return { status: res.status, payload };
  }) as { status: number; payload: MarketplacePayload };

  expect(api.status, 'connector marketplace API should be reachable in the signed-in browser session').toBe(200);
  expect(api.payload.success).toBe(true);
  expect(api.payload.data?.totals?.entries).toBeGreaterThanOrEqual(40);
  expect(api.payload.data?.entries?.length).toBe(api.payload.data?.totals?.entries);
  expect(api.payload.data?.totals?.blocked ?? 0).toBe(0);

  await testInfo.attach('connector-marketplace-surface', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await testInfo.attach('connector-marketplace-api.json', {
    body: JSON.stringify(api.payload, null, 2),
    contentType: 'application/json',
  });
});
