/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cockpit URL follows PLAYWRIGHT_PORT (inline read — a plain .mjs script cannot import the TS tests/helpers/test-origins helper) instead of a hardcoded localhost:3456 (byte-identical under the default env)
 */

import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', err => errors.push('PAGE_ERROR: ' + err.message));

const baseOrigin = `http://localhost:${process.env.PLAYWRIGHT_PORT ?? '3456'}`;

try {
  await page.goto(`${baseOrigin}/cockpit/`, { waitUntil: 'networkidle', timeout: 15000 });
} catch (e) {
  errors.push('NAVIGATE: ' + e.message);
}

const ticketRows = await page.locator('.ticket-row').count();
console.log('ticket_rows:', ticketRows);

const chevrons = await page.locator('.expand-chevron').count();
console.log('expand_chevrons:', chevrons);

const childContainers = await page.locator('.ticket-children-rows').count();
console.log('child_containers:', childContainers);

if (chevrons > 0) {
  await page.locator('.expand-chevron').first().click();
  await page.waitForTimeout(500);
  const expandedChildren = await page.locator('.ticket-children-rows.expanded').count();
  console.log('expanded_after_click:', expandedChildren);
  const newRows = await page.locator('.ticket-row').count();
  console.log('rows_after_expand:', newRows);
}

// Check if selecting a child works
const childRows = await page.locator('.ticket-children-rows .ticket-row').count();
console.log('child_rows_visible:', childRows);
if (childRows > 0) {
  await page.locator('.ticket-children-rows .ticket-row').first().click();
  await page.waitForTimeout(2000);
  const detailPane = await page.locator('#tvDetailPane').innerHTML();
  const hasLoading = detailPane.includes('ph-spinner');
  const hasDetail = detailPane.includes('td-header');
  const hasError = detailPane.includes('error') || detailPane.includes('warning');
  console.log('child_select: loading=' + hasLoading + ' detail=' + hasDetail + ' error=' + hasError);
}

console.log('errors:', JSON.stringify(errors.slice(0, 10)));
await browser.close();