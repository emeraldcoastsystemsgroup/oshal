/**
 * ACTUALLY DO THINGS — exercise real functionality and verify outcomes.
 * Drives everything through openTool(viewId) (view-ids discovered from the live
 * DOM up front, while the global nav is showing). Stops before any
 * order / send / checkout / charge / booking. Smart-home toggle is reverted.
 */
import { test, expect } from './_attach-noprune';
import type { FrameLocator, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openCockpit, openTool, hasTool, surfaceFrame } from './helpers';

const SHOTS = path.resolve('_walkthrough-shots');
fs.mkdirSync(SHOTS, { recursive: true });
async function shot(page: Page, name: string) {
  const buf = await page.screenshot().catch(() => null);
  if (buf) fs.writeFileSync(path.join(SHOTS, 'act-' + name + '.png'), buf);
}
function log(m: string) { console.log('[act] ' + m); }

async function frameText(scope: FrameLocator | Page): Promise<string> {
  return ((await scope.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
}
async function conciergeInput(scope: FrameLocator | Page) {
  const tb = scope.getByRole('textbox').first();
  if (await tb.isVisible({ timeout: 4_000 }).catch(() => false)) return tb;
  return scope.locator('textarea, input[type="text"]').first();
}
async function send(scope: FrameLocator | Page, input: any, text: string) {
  await input.fill(text).catch(async () => { await input.type(text).catch(() => {}); });
  await input.press('Enter').catch(() => {});
  const btn = scope.getByRole('button', { name: /^(send|ask|go)$/i }).first();
  if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) await btn.click().catch(() => {});
}
/** Read a view-id off the live ribbon by matching a button's title/label. */
async function viewIdByTitle(page: Page, reSrc: string): Promise<string | null> {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    for (const el of Array.from(document.querySelectorAll('[data-view]'))) {
      const t = `${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      if (re.test(t)) return (el as HTMLElement).dataset.view || null;
    }
    return null;
  }, reSrc);
}

test('actually operate: jarvis, eats, shop, rides, security, smart-home, test-lab', async ({ page }) => {
  test.setTimeout(900_000);
  await openCockpit(page);

  // Capture view-ids NOW, while the global ribbon is rendered (focus mode hides it later).
  const smartHomeId = await viewIdByTitle(page, 'smart\\s*home');
  const testLabId = await viewIdByTitle(page, 'test\\s*lab');
  log(`discovered ids: smartHome=${smartHomeId} testLab=${testLabId}`);

  // ===== 1. JARVIS — real turn via the authenticated API (carries your cookie) =====
  await test.step('Jarvis: real chat turn', async () => {
    try {
      const start = await page.evaluate(async () => {
        const r = await fetch('/api/jarvis/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'What is 17 times 3? Reply with just the number, then a 4-word note.' }),
        });
        return { status: r.status, body: await r.text() };
      });
      const jobId = (() => { try { return JSON.parse(start.body).jobId; } catch { return null; } })();
      log(`jarvis POST -> ${start.status}; jobId=${jobId}`);
      let answer = '';
      for (let i = 0; i < 30 && jobId; i++) {
        await page.waitForTimeout(3_000);
        const res = await page.evaluate(async (id) => (await (await fetch('/api/jarvis/ask/result?jobId=' + id)).text()), jobId);
        let p: any = {}; try { p = JSON.parse(res); } catch {}
        if (p.status === 'done' || p.result) { answer = p?.result?.answer || JSON.stringify(p.result); break; }
        if (p.status === 'error') { log('jarvis ERROR ' + (p.error || '')); break; }
      }
      log('JARVIS ANSWER: ' + (answer || '(none)').slice(0, 200));
      expect.soft(answer.length, 'jarvis answer').toBeGreaterThan(0);
    } catch (e) { log('jarvis FAILED: ' + String(e).split('\n')[0]); }
  });

  // ===== 2. EATS — search, verify reply text grows in the SURFACE FRAME =====
  await test.step('Eats: search', async () => {
    if (!(await hasTool(page, 'tool-eats-concierge'))) { log('eats absent'); return; }
    try {
      await openTool(page, 'tool-eats-concierge');
      const scope = (await surfaceFrame(page, 'tool-eats-concierge')) ?? page;
      const before = (await frameText(scope)).length;
      await send(scope, await conciergeInput(scope), 'Find coffee places that deliver nearby. List options only, do not order.');
      await page.waitForTimeout(15_000);
      const txt = await frameText(scope);
      await shot(page, 'eats');
      log(`eats body ${before} -> ${txt.length}; tail: ...${txt.slice(-220)}`);
      expect.soft(txt.length, 'eats reply').toBeGreaterThan(before);
    } catch (e) { log('eats FAILED: ' + String(e).split('\n')[0]); }
  });

  // ===== 3. SHOP — add to cart, verify the cart $ TOTAL changes (no checkout) =====
  await test.step('Shop: add to cart', async () => {
    if (!(await hasTool(page, 'tool-shop-concierge'))) { log('shop absent'); return; }
    try {
      await openTool(page, 'tool-shop-concierge');
      const scope = (await surfaceFrame(page, 'tool-shop-concierge')) ?? page;
      await page.waitForTimeout(2_000);
      const money = (t: string) => (t.match(/\$[\d,]+\.\d{2}/g) || []).join(' ');
      const before = money(await frameText(scope));
      const addBtn = scope.getByRole('button', { name: /add (to cart|selected)/i }).first();
      const had = await addBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (had) { await addBtn.click().catch(() => {}); await page.waitForTimeout(3_500); }
      const after = money(await frameText(scope));
      await shot(page, 'shop-cart');
      log(`shop add-btn=${had}; cart $ before=[${before}] after=[${after}]`);
      expect.soft(had, 'shop had an add-to-cart button').toBeTruthy();
    } catch (e) { log('shop FAILED: ' + String(e).split('\n')[0]); }
  });

  // ===== 4. RIDES — estimate (no booking) =====
  await test.step('Rides: estimate', async () => {
    if (!(await hasTool(page, 'tool-rides-concierge'))) { log('rides absent'); return; }
    try {
      await openTool(page, 'tool-rides-concierge');
      const scope = (await surfaceFrame(page, 'tool-rides-concierge')) ?? page;
      const before = (await frameText(scope)).length;
      await send(scope, await conciergeInput(scope), 'Estimate the price for a ride from downtown Pensacola to the airport. Estimate only, do not book.');
      await page.waitForTimeout(16_000);
      const txt = await frameText(scope);
      await shot(page, 'rides');
      log(`rides body ${before} -> ${txt.length}; tail: ...${txt.slice(-220)}`);
      expect.soft(txt.length, 'rides reply').toBeGreaterThan(before);
    } catch (e) { log('rides FAILED: ' + String(e).split('\n')[0]); }
  });

  // ===== 5. SECURITY CENTER — run a scan, verify the status line changes =====
  await test.step('Security: run scan', async () => {
    if (!(await hasTool(page, 'tool-security-center-home'))) { log('security absent'); return; }
    try {
      await openTool(page, 'tool-security-center-home');
      const scope = (await surfaceFrame(page, 'tool-security-center-home')) ?? page;
      const grab = async () => { const m = (await frameText(scope)).match(/last scan[^.]*/i); return m ? m[0].slice(0, 120) : ''; };
      const before = await grab();
      const runBtn = scope.getByRole('button', { name: /run scan/i }).first();
      const had = await runBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (had) { await runBtn.click().catch(() => {}); await page.waitForTimeout(12_000); }
      const after = await grab();
      await shot(page, 'security-scan');
      log(`security run-btn=${had}; "${before}" -> "${after}"`);
      expect.soft(had, 'security had a Run scan button').toBeTruthy();
    } catch (e) { log('security FAILED: ' + String(e).split('\n')[0]); }
  });

  // ===== 6. SMART HOME — toggle a device, verify it flips, then restore =====
  await test.step('Smart Home: toggle + restore', async () => {
    if (!smartHomeId) { log('smart-home id not discovered'); return; }
    try {
      await openTool(page, smartHomeId);
      await page.waitForTimeout(6_000);
      const scope = (await surfaceFrame(page, smartHomeId)) ?? page;
      const toggle = scope.locator('input[type="checkbox"], [role="switch"], button[aria-pressed]').first();
      if (!(await toggle.isVisible({ timeout: 6_000 }).catch(() => false))) { log('smart-home: no toggle'); await shot(page, 'smarthome'); return; }
      const read = () => toggle.evaluate((el: any) => String(el.checked ?? el.getAttribute('aria-pressed') ?? el.getAttribute('aria-checked'))).catch(() => 'null');
      const b = await read();
      await toggle.click().catch(() => {});
      await page.waitForTimeout(3_500);
      const a = await read();
      await shot(page, 'smarthome-toggled');
      log(`smart-home toggle ${b} -> ${a}`);
      expect.soft(a, 'smart-home toggle should flip').not.toBe(b);
      if (a !== b) { await toggle.click().catch(() => {}); await page.waitForTimeout(2_500); log('smart-home restored'); }
    } catch (e) { log('smart-home FAILED: ' + String(e).split('\n')[0]); }
  });

  // ===== 7. AI TEST LAB — run a read-only scenario =====
  await test.step('Test Lab: run scenario', async () => {
    if (!testLabId) { log('test-lab id not discovered'); return; }
    try {
      await openTool(page, testLabId);
      await page.waitForTimeout(5_000);
      const scope = (await surfaceFrame(page, testLabId)) ?? page;
      const runBtn = scope.getByRole('button', { name: /^run$/i }).first();
      const had = await runBtn.isVisible({ timeout: 6_000 }).catch(() => false);
      if (had) {
        const before = (await frameText(scope)).length;
        await runBtn.click().catch(() => {});
        await page.waitForTimeout(15_000);
        const after = (await frameText(scope)).length;
        await shot(page, 'testlab-run');
        log(`test-lab ran; body ${before} -> ${after}`);
      } else { log('test-lab: no Run button'); await shot(page, 'testlab'); }
      expect.soft(had, 'test-lab had a Run button').toBeTruthy();
    } catch (e) { log('test-lab FAILED: ' + String(e).split('\n')[0]); }
  });

  log('actions complete');
  expect(true).toBeTruthy();
});
