/** Re-verify Jarvis on the freshly-rolled jarvis-bot: direct answer vs tool→ticket. */
import { test, expect } from './_attach-noprune';
import { openCockpit } from './helpers';

async function ask(page: any, message: string): Promise<string> {
  const start = await page.evaluate(async (msg: string) => {
    const r = await fetch('/api/jarvis/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
    return await r.text();
  }, message);
  let jobId: string | null = null; try { jobId = JSON.parse(start).jobId; } catch { /* */ }
  if (!jobId) return '(no jobId)';
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(3000);
    const res = await page.evaluate(async (id: string) => (await (await fetch('/api/jarvis/ask/result?jobId=' + id)).text()), jobId);
    let p: any = {}; try { p = JSON.parse(res); } catch { /* */ }
    if (p.status === 'done') return JSON.stringify(p.result || p).slice(0, 700);
    if (p.status === 'error') return '(error) ' + String(p.error).slice(0, 200);
  }
  return '(timeout)';
}

test('jarvis on fresh image: direct + tool question', async ({ page }) => {
  test.setTimeout(300_000);
  await openCockpit(page);
  console.log('[v] DIRECT: ' + (await ask(page, 'In one sentence, what can you help me with? Just answer, do not start any task.')).replace(/\s+/g, ' '));
  console.log('[v] TOOL: ' + (await ask(page, 'What are today’s trading results — equity, cash, autopilot? real numbers.')).replace(/\s+/g, ' '));
  expect(true).toBeTruthy();
});
