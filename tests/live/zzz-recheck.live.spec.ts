/**
 * Targeted re-check: the surfaces that looked blank/stuck in the full sweep,
 * given a longer settle to rule out screenshot-timing under host load — plus a
 * PROPER Jarvis UI chat turn (click "Type", send a message, wait for the reply).
 * Read-only.
 */
import { test, expect } from './_attach-noprune';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasTool, openCockpit, openTool, surfaceFrame } from './helpers';

const SHOTS = path.resolve('_walkthrough-shots');
fs.mkdirSync(SHOTS, { recursive: true });
async function save(page: any, name: string) {
  const buf = await page.screenshot().catch(() => null);
  if (buf) fs.writeFileSync(path.join(SHOTS, name + '.png'), buf);
  console.log(`[recheck] ${name}.png`);
}

test('recheck blank/stuck surfaces with longer settle + jarvis UI chat', async ({ page }) => {
  test.setTimeout(600_000);
  await openCockpit(page);

  for (const [id, name] of [
    ['tool-finance-home', 'recheck-finance2'],
  ] as Array<[string, string]>) {
    // Finance is a store package (ADR-085) — skip when its tile isn't on this deployment.
    if (!(await hasTool(page, id))) { console.log(`[recheck] ${name} skipped — ${id} absent`); continue; }
    try {
      await openTool(page, id);
      await page.waitForTimeout(9_000); // generous settle for async list/canvas loads
      await save(page, name);
    } catch (e) { console.log(`[recheck] ${name} FAILED: ${String(e).split('\n')[0]}`); }
  }

  // ---- Jarvis UI chat: reveal the text box ("Type"), send, wait for reply. ----
  try {
    await openTool(page, 'tool-jarvis-home');
    await page.waitForTimeout(1_500);
    // Reveal the text input — the orb home hides it behind a "Type" control.
    const typeBtn = page.getByText(/^\s*Type\s*$/i).first();
    if (await typeBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await typeBtn.click().catch(() => {});
      await page.waitForTimeout(1_000);
    } else {
      // Dump the controls near the orb so we can see the real selectors.
      const labels = await page.locator('button, [role="button"], a').evaluateAll(
        (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 24).slice(0, 40),
      ).catch(() => []);
      console.log('[recheck] jarvis controls: ' + JSON.stringify(labels));
    }
    const box = page.locator('textarea:visible, input[type="text"]:visible').first();
    if (await box.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await box.click().catch(() => {});
      await box.fill('In one sentence, what can you do? Do not start any task.').catch(() => {});
      await save(page, 'recheck-jarvis-typed');
      // submit: Enter, or a Send button
      await box.press('Enter').catch(() => {});
      const sendBtn = page.getByRole('button', { name: /send/i }).first();
      if (await sendBtn.isVisible({ timeout: 1_500 }).catch(() => false)) await sendBtn.click().catch(() => {});
      await page.waitForTimeout(20_000); // let the LLM answer end-to-end
      await save(page, 'recheck-jarvis-reply');
    } else {
      console.log('[recheck] jarvis: text box never appeared');
      await save(page, 'recheck-jarvis-noinput');
    }
  } catch (e) { console.log('[recheck] jarvis FAILED: ' + String(e).split('\n')[0]); }

  expect(true).toBeTruthy();
});
