/**
 * COMPLETE catalog sweep — drives every left-nav app by its visible label
 * (the hardcoded view-id list missed ~18 apps; the shared listRibbonTools()
 * helper is broken). Clicks each, settles, screenshots. Read-only.
 */
import { test, expect } from './_attach-noprune';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openCockpit } from './helpers';

const SHOTS = path.resolve('_walkthrough-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// Full catalog as read live from the nav (the buttons' accessible names).
const CATALOG = [

  'Job Board', 'Recruiters', 'Approvals', 'Insights', 'Career Settings',
  'Inbox', 'My Day (Summary)', 'Social', 'Smart Home (IoT)', 'Feeds',
  'World Intelligence', 'Intelligent Trades',
  'Travel',
  'AI Test Lab', 'Eval Wall', 'Cloud', 'DevOps + Vault', 'Security Center',
  'Identity Hub', 'Files', 'Presentations', 'Bot Forge', 'Workflow Studio',
  'Video Studio', 'Tickets', 'Calendar',
];

test('complete catalog sweep — every nav app', async ({ page }) => {
  test.setTimeout(900_000);
  await openCockpit(page);

  const empty: string[] = [];
  const missing: string[] = [];
  let n = 50; // continue numbering after the earlier sweep
  for (const label of CATALOG) {
    n += 1;
    const safe = String(n) + '-cat-' + label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    try {
      // Nav items are role=button with the label as accessible name.
      let btn = page.getByRole('button', { name: label, exact: true }).first();
      if (!(await btn.isVisible({ timeout: 2_000 }).catch(() => false))) {
        btn = page.getByTitle(label, { exact: true }).first();
      }
      if (!(await btn.isVisible({ timeout: 2_000 }).catch(() => false))) {
        missing.push(label); console.log(`[cat] not found: ${label}`); continue;
      }
      await btn.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      await page.waitForTimeout(5_500); // settle async loads under host load
      // crude "is the main panel empty?" check: very little text in the content area
      const txt = (await page.locator('main, .content, #content, body').first().innerText().catch(() => '')) || '';
      const buf = await page.screenshot().catch(() => null);
      if (buf) fs.writeFileSync(path.join(SHOTS, safe + '.png'), buf);
      const bodyLen = txt.replace(/\s+/g, ' ').trim().length;
      if (bodyLen < 120) empty.push(`${label}(${bodyLen})`);
      console.log(`[cat] ${safe}.png  bodyText=${bodyLen}`);
    } catch (e) {
      console.log(`[cat] ${label} FAILED: ${String(e).split('\n')[0]}`);
    }
  }
  console.log(`[cat] missing(${missing.length}): ${missing.join(', ') || 'none'}`);
  console.log(`[cat] looks-empty(${empty.length}): ${empty.join(', ') || 'none'}`);
  expect(true).toBeTruthy();
});
