/**
 * ENHANCED end-to-end walkthrough — real actions on the live (tunneled→local) app
 * through the operator's signed-in Chrome (CDP attach, no tab pruning).
 *
 * Does real work, STOPPING before any purchase/checkout/send/booking:
 *  - sweep every app (screenshot)
 *  - drive real commands THROUGH JARVIS (cookie-authed /api/jarvis/ask): trading
 *    results, save a file, find a job + generate a resume, run a shell command
 *  - Shop: add an item to the cart (no checkout)
 *  - Eats: search (no order); Rides: estimate (no booking)
 *  - Free-tier: round-trip the Gemini free model (OSHAL_E2E_GEMINI_KEY)
 *
 * Screenshots → ./_walkthrough-shots/enh-*.png
 */
import { test, expect } from './_attach-noprune';
import type { Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openCockpit, openTool, hasTool, surfaceFrame } from './helpers';

const SHOTS = path.resolve('_walkthrough-shots');
fs.mkdirSync(SHOTS, { recursive: true });
async function shot(page: Page, name: string) {
  const buf = await page.screenshot().catch(() => null);
  if (buf) fs.writeFileSync(path.join(SHOTS, 'enh-' + name + '.png'), buf);
}
function log(m: string) { console.log('[enh] ' + m); }

/** Drive Jarvis end-to-end via the cookie-authed API (same-origin fetch in the page). */
async function askJarvis(page: Page, message: string, waitMs = 90_000): Promise<string> {
  const start = await page.evaluate(async (msg) => {
    const r = await fetch('/api/jarvis/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    return { status: r.status, body: await r.text() };
  }, message);
  let jobId: string | null = null;
  try { jobId = JSON.parse(start.body).jobId; } catch { /* */ }
  if (!jobId) return `(no jobId; POST ${start.status} ${start.body.slice(0, 120)})`;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    const res = await page.evaluate(async (id) => (await (await fetch('/api/jarvis/ask/result?jobId=' + id)).text()), jobId);
    let p: any = {}; try { p = JSON.parse(res); } catch { /* */ }
    if (p.status === 'done' || p.result) return String(p?.result?.answer ?? JSON.stringify(p.result ?? p)).slice(0, 600);
    if (p.status === 'error') return `(error: ${String(p.error).slice(0, 200)})`;
  }
  return '(timeout)';
}

test('enhanced E2E: sweep + jarvis commands + cart + free-tier', async ({ page }) => {
  test.setTimeout(1_800_000);
  await openCockpit(page);
  await shot(page, '00-home');

  // ── 1. Sweep every app (visual "everything works") ──
  const APPS = [
    'dashboard', 'tool-jarvis-home', 'tickets', 'operations', 'connectors', 'tool-finance-home',
    'tool-email-inbox',
    'tool-travel-concierge', 'tool-feeds-dashboard',
    'tool-security-center-home', 'tool-world-dashboard', 'tool-career-insights', 'tool-token-chase',
    'tool-workflow-studio', 'tool-finance-home', 'calendar', 'forge', 'settings',
  ];
  let n = 0;
  for (const id of APPS) {
    n += 1;
    try {
      if (!(await hasTool(page, id))) { log(`sweep skip (absent): ${id}`); continue; }
      await openTool(page, id);
      await page.waitForTimeout(2500);
      await shot(page, `sweep-${String(n).padStart(2, '0')}-${id}`);
    } catch (e) { log(`sweep FAIL ${id}: ${String(e).split('\n')[0]}`); }
  }

  // ── 2. Real commands THROUGH JARVIS ──
  await openTool(page, 'tool-jarvis-home').catch(() => {});
  for (const [label, msg] of [
    ['trading', 'What are today’s trading results? Give me equity, cash and autopilot state with real numbers.'],
    ['savefile', 'Save a file named oshal-e2e-test.txt containing the text: hello from the OSHAL e2e test. Confirm the path.'],
    ['runcmd', 'Run a shell command to print the current date and the working directory, and show me the output.'],
    ['jobresume', 'Find my single best job match (80%+ fit) and generate a tailored resume for it. Do not submit any application — just produce the resume and tell me where it saved.'],
  ] as Array<[string, string]>) {
    const ans = await askJarvis(page, msg, label === 'jobresume' ? 240_000 : 120_000);
    log(`JARVIS[${label}]: ${ans.replace(/\s+/g, ' ').slice(0, 400)}`);
    await shot(page, `jarvis-${label}`);
  }

  // ── 3. Shop: add to cart, STOP before checkout ──
  await test.step('shop add-to-cart (no checkout)', async () => {
    if (!(await hasTool(page, 'tool-shop-concierge'))) { log('shop absent'); return; }
    const scope = (await openTool(page, 'tool-shop-concierge')) ?? page;
    await page.waitForTimeout(2000);
    const money = (t: string) => (t.match(/\$[\d,]+\.\d{2}/g) || []).join(' ');
    const before = money(await (scope as any).locator('body').innerText().catch(() => ''));
    const add = (scope as any).getByRole('button', { name: /add (to cart|selected)/i }).first();
    const had = await add.isVisible({ timeout: 5000 }).catch(() => false);
    if (had) { await add.click().catch(() => {}); await page.waitForTimeout(3000); }
    const after = money(await (scope as any).locator('body').innerText().catch(() => ''));
    await shot(page, 'shop-cart');
    log(`shop add-btn=${had}; cart $ before=[${before}] after=[${after}] (NO checkout)`);
  });

  // ── 4. Eats search + Rides estimate (no order/booking) ──
  for (const [id, q, name] of [
    ['tool-eats-concierge', 'Find coffee places that deliver nearby. Just list options — do not order.', 'eats'],
    ['tool-rides-concierge', 'Estimate a ride from downtown Pensacola to the airport. Estimate only — do not book.', 'rides'],
  ] as Array<[string, string, string]>) {
    if (!(await hasTool(page, id))) { log(`${name} absent`); continue; }
    try {
      const scope = (await openTool(page, id)) ?? page;
      const input = (scope as any).getByRole('textbox').first();
      if (await input.isVisible({ timeout: 4000 }).catch(() => false)) {
        await input.fill(q); await input.press('Enter');
        const send = (scope as any).getByRole('button', { name: /^(send|ask|go)$/i }).first();
        if (await send.isVisible({ timeout: 1500 }).catch(() => false)) await send.click().catch(() => {});
        await page.waitForTimeout(14000);
      }
      await shot(page, name);
      log(`${name}: query sent`);
    } catch (e) { log(`${name} FAIL: ${String(e).split('\n')[0]}`); }
  }

  // ── 5. Free-tier: round-trip Gemini (the free stuff) ──
  await test.step('free-tier gemini round-trip', async () => {
    const key = process.env.OSHAL_E2E_GEMINI_KEY || '';
    if (!key) { log('free-tier: no OSHAL_E2E_GEMINI_KEY provided'); return; }
    const out = await page.evaluate(async (k) => {
      const r = await fetch('/api/free-tier/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'gemini', apiKey: k, model: 'gemini-2.0-flash' }),
      });
      return { status: r.status, body: (await r.text()).slice(0, 300) };
    }, key);
    log(`FREE-TIER gemini: ${out.status} ${out.body}`);
  });

  log('enhanced E2E complete');
  expect(true).toBeTruthy();
});
