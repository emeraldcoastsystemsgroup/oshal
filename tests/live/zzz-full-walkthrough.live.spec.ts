/**
 * FULL read-only UI walkthrough on the real hosted app, driven through the
 * operator's own signed-in Chrome (CDP attach, no tab pruning).
 *
 * Sweeps EVERY ribbon app (screenshot each), then does deeper read-only
 * interactions on the apps the operator named: Jarvis, Rides, Eats, Shop, Email.
 * Read-only: it types queries and opens screens but STOPS before any
 * send / order / checkout / charge. Screenshots are written to
 * ./_walkthrough-shots/NN-*.png so they can be reviewed frame by frame.
 */
import { test, expect } from './_attach-noprune';
import type { FrameLocator, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  openCockpit, openTool, hasTool, hasSurfaceError, surfaceFrame,
} from './helpers';

// Enumerate apps by known view-id (the shared listRibbonTools() helper is broken:
// its evaluateAll closure references Node-scope fns, throwing in the browser).
const APPS: Array<{ id: string; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'tool-jarvis-home', label: 'Jarvis' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'operations', label: 'Operations' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'tool-finance-home', label: 'Finance' },
  { id: 'tool-email-inbox', label: 'Email' },
  { id: 'tool-travel-concierge', label: 'Travel' },
  { id: 'tool-feeds-dashboard', label: 'Feeds' },
  { id: 'tool-security-center-home', label: 'Security Center' },
  { id: 'tool-world-dashboard', label: 'World Intelligence' },
  { id: 'tool-career-insights', label: 'Career Insights' },
  { id: 'tool-token-chase', label: 'Optimizer' },
  { id: 'tool-workflow-studio', label: 'Workflow Studio' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'addressbook', label: 'Address Book' },
  { id: 'chat', label: 'Swarm Messages' },
  { id: 'forge', label: 'Bot Forge' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];

const SHOTS = path.resolve('_walkthrough-shots');
fs.mkdirSync(SHOTS, { recursive: true });
let N = 0;
async function shot(page: Page, label: string, testInfo: any): Promise<void> {
  N += 1;
  const safe = String(N).padStart(2, '0') + '-' + label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = path.join(SHOTS, safe + '.png');
  const buf = await page.screenshot({ fullPage: false }).catch(() => null);
  if (buf) { fs.writeFileSync(file, buf); await testInfo.attach(label, { body: buf, contentType: 'image/png' }); }
  // eslint-disable-next-line no-console
  console.log(`[shot] ${safe}.png  (${label})`);
}

/** Concierge text input — inside the app iframe if present, else inline on the page. */
async function conciergeInput(page: Page, frame: FrameLocator | null) {
  if (frame) {
    const inFrame = frame.getByRole('textbox').first();
    if (await inFrame.isVisible({ timeout: 4_000 }).catch(() => false)) return inFrame;
    const ta = frame.locator('textarea, input[type="text"]').first();
    if (await ta.isVisible({ timeout: 2_000 }).catch(() => false)) return ta;
  }
  const onPage = page.getByRole('textbox').first();
  if (await onPage.isVisible({ timeout: 3_000 }).catch(() => false)) return onPage;
  return page.locator('textarea, input[type="text"]').first();
}

/** Type a prompt into a concierge and wait for SOME reply text to appear. Read-only. */
async function ask(page: Page, frame: FrameLocator | null, prompt: string): Promise<void> {
  const input = await conciergeInput(page, frame);
  if (!(await input.isVisible({ timeout: 4_000 }).catch(() => false))) {
    console.log(`[ask] no input found for: ${prompt.slice(0, 40)}`);
    return;
  }
  await input.click().catch(() => {});
  await input.fill(prompt).catch(async () => { await input.type(prompt).catch(() => {}); });
  await input.press('Enter').catch(() => {});
  // Give the bot/LLM time to answer; we don't assert content, just let a reply render.
  await page.waitForTimeout(12_000);
}

test('FULL read-only walkthrough: sweep every app + deep-test jarvis/rides/eats/shop/email', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  await openCockpit(page);
  await shot(page, 'cockpit-home-jarvis', testInfo);

  // ---- 1. Sweep EVERY app, screenshot each, record load errors. ----
  const broken: string[] = [];
  const missing: string[] = [];
  for (const tool of APPS) {
    await test.step(`open: ${tool.label}`, async () => {
      try {
        if (!(await hasTool(page, tool.id))) { missing.push(tool.label); console.log(`[sweep] not on profile: ${tool.label}`); return; }
        await openTool(page, tool.id);
        const errored = await hasSurfaceError(page);
        await shot(page, `app-${tool.label}`, testInfo);
        if (errored) broken.push(tool.label);
        expect.soft(errored, `${tool.label} surfaced an error`).toBeFalsy();
      } catch (err) {
        broken.push(`${tool.label} (${String(err).split('\n')[0]})`);
        console.log(`[sweep] FAILED ${tool.label}: ${String(err).split('\n')[0]}`);
      }
    });
  }
  console.log(`[sweep] missing(${missing.length}): ${missing.join(', ') || 'none'}`);
  console.log(broken.length ? `[sweep] needs attention(${broken.length}): ${broken.join(' | ')}` : '[sweep] all present apps opened clean');

  // ---- 2. Deep read-only interactions on the apps the operator named. ----
  // JARVIS — exercise the LLM end-to-end through the UI (this is the real "is it blocked" test).
  await test.step('deep: Jarvis chat (LLM end-to-end)', async () => {
    try {
      await openTool(page, 'tool-jarvis-home').catch(() => {});
      const f = await surfaceFrame(page, 'tool-jarvis-home');
      await ask(page, f, 'In one short sentence, what can you do? Do not start any task.');
      await shot(page, 'jarvis-reply', testInfo);
    } catch (e) { console.log('[deep] jarvis: ' + String(e).split('\n')[0]); }
  });

  // RIDES — ask for a price quote only; do NOT book.
  await test.step('deep: Rides quote (no booking)', async () => {
    if (!(await hasTool(page, 'tool-rides-concierge'))) { console.log('[deep] rides not on profile'); return; }
    try {
      const f = await openTool(page, 'tool-rides-concierge');
      await shot(page, 'rides-surface', testInfo);
      await ask(page, f, 'Give me a price estimate for a ride from downtown Pensacola to the airport. Just the estimate, do not book.');
      await shot(page, 'rides-quote', testInfo);
    } catch (e) { console.log('[deep] rides: ' + String(e).split('\n')[0]); }
  });

  // EATS — search only; do NOT order.
  await test.step('deep: Eats search (no order)', async () => {
    if (!(await hasTool(page, 'tool-eats-concierge'))) { console.log('[deep] eats not on profile'); return; }
    try {
      const f = await openTool(page, 'tool-eats-concierge');
      await shot(page, 'eats-surface', testInfo);
      await ask(page, f, 'Show me coffee places that deliver nearby. Just list options, do not order anything.');
      await shot(page, 'eats-results', testInfo);
    } catch (e) { console.log('[deep] eats: ' + String(e).split('\n')[0]); }
  });

  // SHOP — build a list / show options; do NOT checkout.
  await test.step('deep: Shop options (no checkout)', async () => {
    if (!(await hasTool(page, 'tool-shop-concierge'))) { console.log('[deep] shop not on profile'); return; }
    try {
      const f = await openTool(page, 'tool-shop-concierge');
      await shot(page, 'shop-surface', testInfo);
      await ask(page, f, 'Find the cheapest milk, eggs and bread and show me the options. Do not add to cart or check out.');
      await shot(page, 'shop-results', testInfo);
    } catch (e) { console.log('[deep] shop: ' + String(e).split('\n')[0]); }
  });

  // EMAIL — open inbox + read one message; do NOT compose/send.
  await test.step('deep: Email inbox (read-only)', async () => {
    if (!(await hasTool(page, 'tool-email-inbox'))) { console.log('[deep] email not on profile'); return; }
    try {
      const f = await openTool(page, 'tool-email-inbox');
      await shot(page, 'email-inbox', testInfo);
      const firstMsg = (f ?? page).locator('[role="listitem"], .email-row, .message-row, li').first();
      if (await firstMsg.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await firstMsg.click().catch(() => {});
        await page.waitForTimeout(2_500);
        await shot(page, 'email-open-message', testInfo);
      }
    } catch (e) { console.log('[deep] email: ' + String(e).split('\n')[0]); }
  });

  console.log(`[done] ${N} screenshots written to ${SHOTS}`);
});
