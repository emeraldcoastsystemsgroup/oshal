import { test, expect } from '@playwright/test';
test('operations view debug', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  await page.goto('/cockpit/');
  await page.locator('.ribbon-btn[data-view="operations"]').click();
  await page.waitForTimeout(5000);
  const bodyHTML = await page.locator('.ops-body, #opsBody').first().innerHTML().catch(() => 'NOT_FOUND');
  const viewHTML = await page.locator('.ops-view').first().innerHTML().catch(() => 'NOT_FOUND');
  console.log('=== OPS VIEW LENGTH:', viewHTML.length);
  console.log('=== OPS BODY LENGTH:', bodyHTML.length);
  console.log('=== HAS KPI:', bodyHTML.includes('ops-kpi'));
  console.log('=== HAS LOADING:', bodyHTML.includes('ops-loading'));
  console.log('=== CONSOLE ERRORS:', errors.length, errors.slice(0, 3).join(' | '));
  console.log('=== BODY PREVIEW:', bodyHTML.slice(0, 300));
  expect(viewHTML.length).toBeGreaterThan(10);
});
