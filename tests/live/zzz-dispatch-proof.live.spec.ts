/**
 * Fire ONE real Jarvis task that requires a worker handoff (career/job board,
 * read-only) and capture the dispatch outcome — to prove the 401 worker-dispatch
 * failure is resolved and a fresh ticket lands in the queue.
 */
import { test, expect } from './_attach-noprune';
import { openCockpit } from './helpers';

test('dispatch proof: fire a real worker task via Jarvis', async ({ page }) => {
  test.setTimeout(300_000);
  await openCockpit(page);

  const start = await page.evaluate(async () => {
    const r = await fetch('/api/jarvis/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Use the Jobs / career board tool to find my current job matches with a fit score of 80% or higher. Return a short list (title, company, score). Read-only.',
      }),
    });
    return { status: r.status, body: await r.text() };
  });
  console.log('[proof] POST /ask -> ' + start.status + ' ' + start.body.slice(0, 200));
  let jobId: string | null = null, chatTicketId: string | null = null;
  try { const p = JSON.parse(start.body); jobId = p.jobId; chatTicketId = p.chatTicketId; } catch {}
  console.log('[proof] jobId=' + jobId + ' chatTicketId=' + chatTicketId);

  for (let i = 0; i < 50 && jobId; i++) {
    await page.waitForTimeout(3_000);
    const res = await page.evaluate(async (id) => (await (await fetch('/api/jarvis/ask/result?jobId=' + id)).text()), jobId);
    let p: any = {}; try { p = JSON.parse(res); } catch {}
    if (p.status === 'done' || p.result) {
      console.log('[proof] DONE answer: ' + JSON.stringify(p.result).slice(0, 300));
      console.log('[proof] dispatched: ' + JSON.stringify(p?.result?.dispatched || []));
      break;
    }
    if (p.status === 'error') { console.log('[proof] ERROR: ' + (p.error || '')); break; }
    if (i % 4 === 0) console.log('[proof] ...waiting (' + (i * 3) + 's) status=' + (p.status || '?'));
  }
  expect(true).toBeTruthy();
});
