/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verifies Type filter dropdown drives /api/v1/tickets/hierarchy?type=...
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

test.describe('Cockpit — Tickets Type filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await page.locator('.ribbon-btn[data-view="tickets"]').click();
    await page.waitForTimeout(500);
  });

  test('toolbar exposes Type filter with the current ticket types', async ({ page }) => {
    const typeFilter = page.locator('#tvTypeFilter');
    await expect(typeFilter).toBeVisible();
    const optionValues = await typeFilter.locator('option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value),
    );
    expect(optionValues).toEqual(['all', 'build', 'incident']);
  });

  test('selecting Incident calls /api/v1/tickets/hierarchy with ?type=incident', async ({ page }) => {
    const requestPromise = page.waitForRequest((r) =>
      r.url().includes('/api/v1/tickets/hierarchy') && r.url().includes('type=incident'),
    );
    await page.locator('#tvTypeFilter').selectOption('incident');
    const req = await requestPromise;
    expect(req.url()).toContain('type=incident');
  });
});
