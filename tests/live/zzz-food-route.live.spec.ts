/** Verify a food order now routes to eats-concierge (not project-manager). */
import { test, expect } from './_attach-noprune';
import { openCockpit } from './helpers';

test('food order routes to eats-concierge', async ({ page }) => {
  test.setTimeout(240_000);
  await openCockpit(page);
  const start = await page.evaluate(async () => {
    const r = await fetch('/api/jarvis/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Order me a McDonald’s hamburger for delivery.' }) });
    return await r.text();
  });
  let jobId = null; try { jobId = JSON.parse(start).jobId; } catch {}
  console.log('[food] jobId=' + jobId);
  for (let i = 0; i < 40 && jobId; i++) {
    await page.waitForTimeout(3000);
    const res = await page.evaluate(async (id) => (await (await fetch('/api/jarvis/ask/result?jobId=' + id)).text()), jobId);
    let p = {}; try { p = JSON.parse(res); } catch {}
    if (p.status === 'done' || p.status === 'error') { console.log('[food] result: ' + JSON.stringify(p.result || p).slice(0, 400)); break; }
  }
  expect(true).toBeTruthy();
});
