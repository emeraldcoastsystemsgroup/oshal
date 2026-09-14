/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live-box validation for the Jarvis refused-thread recovery (docs/runbooks/jarvis-couldnt-do-that-just-now.md): statuses and safe bodies only, never a token, secret or subject.
 */
// Real end-to-end on the LIVE box in real Chromium: start a guest session (a real issuer,
// urn:oshal:guest), plant a legacy issuer-less Jarvis thread for that guest (the exact precondition
// of the operator's failure), bookmark it in localStorage like the page does, ask a question on the
// real Jarvis page, and record what the page and the server actually did.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const base = process.env.BASE || 'http://127.0.0.1:35457';
const outDir = process.env.OUT_DIR || '.';
const question = process.env.QUESTION || 'How did I do in the stock market last week?';
const legacyThread = 'jarvis-legacy-e2e-' + Date.now().toString(36);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function psql(sql) {
  return execFileSync('docker', ['exec', 'oshal-local-db', 'sh', '-c',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$PSQL_SQL"'], { env: { ...process.env, PSQL_SQL: sql }, encoding: 'utf8', timeout: 60000 }).trim();
}

(async () => {
  const out = { base, legacyThread, question, asks: [] };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('response', async r => {
    const req = r.request();
    if (req.method() === 'POST' && r.url().includes('/api/jarvis/ask') && !r.url().includes('/ask/')) {
      let body = ''; try { body = (await r.text()).slice(0, 160); } catch {}
      let sessionId; try { sessionId = JSON.parse(req.postData() || '{}').sessionId; } catch {}
      out.asks.push({ status: r.status(), sessionId, body });
    }
  });
  try {
    // 1. Guest session: POST the real start route; read the cookie straight off the response so a
    //    Domain attribute meant for the public host cannot make the loopback jar drop it.
    const start = await page.request.post(base + '/api/guest/start?next=/api/jarvis/', { maxRedirects: 0 });
    out.guestStart = { status: start.status(), location: start.headers()['location'] };
    const setCookie = start.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value);
    const guest = setCookie.map(v => v.split(';')[0]).find(v => v.startsWith('oshal_guest='));
    if (!guest) throw new Error('guest cookie not issued: ' + JSON.stringify(setCookie.map(v => v.slice(0, 40))));
    const host = new URL(base).hostname;
    await context.addCookies([{ name: 'oshal_guest', value: guest.slice('oshal_guest='.length), domain: host, path: '/' }]);
    const me = await page.request.get(base + '/api/auth/user');
    const meBody = await me.json().catch(() => ({}));
    const sub = meBody.sub || meBody.user?.sub;
    out.guest = { status: me.status(), subPrefix: String(sub || '').slice(0, 12), issuer: meBody.iss || meBody.user?.iss || meBody.issuer };
    if (!sub) throw new Error('guest identity not readable: ' + JSON.stringify(meBody).slice(0, 200));

    // 2. The precondition: a Jarvis thread this guest owns that carries NO issuer provenance
    //    (exactly what every thread created before 2026-09-11 looks like).
    psql(`insert into chat_tasks (task_id, title, status, processing_mode, agent_id, owner_sub, metadata, created_at, updated_at)
          values ('${legacyThread}', 'legacy e2e thread', 'active', 'agentic', 'a0000000-0000-0000-0000-000000000050', '${sub}',
                  '{"origin":"jarvis-chat"}'::jsonb, now() - interval '30 days', now() - interval '30 days')`);
    out.legacyRow = psql(`select task_id || ' issuer=' || coalesce(metadata->>'oshalOwnerPrincipalIssuer','<none>') from chat_tasks where task_id='${legacyThread}'`);

    // 3. Bookmark it the way the page does, then open the real page.
    await context.addInitScript(value => localStorage.setItem('jarvisSessionId', value), legacyThread);
    const nav = await page.goto(base + '/api/jarvis/?layout=compact', { waitUntil: 'domcontentloaded' });
    out.page = { status: nav?.status(), url: page.url() };
    await page.waitForFunction(() => typeof window.handleInput === 'function', null, { timeout: 30000 });
    out.bookmarkedBeforeAsk = await page.evaluate(() => localStorage.getItem('jarvisSessionId'));
    await page.locator('#typein').fill(question);
    await page.locator('#typer button').click();

    // 4. Watch the page: the server must refuse the legacy thread, the page must roll and resend.
    const started = Date.now();
    while (out.asks.length < 2 && Date.now() - started < 30000) await sleep(250);
    let answer = null, error = null;
    while (Date.now() - started < 240000) {
      const state = await page.evaluate(() => {
        const bubbles = Array.from(document.querySelectorAll('#convo .msg.bot .bx'));
        const last = bubbles[bubbles.length - 1];
        const text = last ? last.textContent.trim() : '';
        const err = last ? last.querySelector('.err') : null;
        return { text, err: err ? err.textContent : null, thinking: /Thinking…|starting a new chat/.test(text) };
      });
      if (state.err) { error = state.err; break; }
      if (state.text && !state.thinking) { answer = state.text; break; }
      await sleep(2000);
    }
    out.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    out.answer = answer ? answer.slice(0, 1200) : null;
    out.pageError = error;
    out.bookmarkedAfterAsk = await page.evaluate(() => localStorage.getItem('jarvisSessionId'));
    out.statusLine = await page.evaluate(() => (document.getElementById('status') || {}).textContent || null);
    await page.screenshot({ path: outDir + '/jarvis-guest-e2e.png', fullPage: true });
    if (out.bookmarkedAfterAsk && out.bookmarkedAfterAsk !== legacyThread) {
      out.newThreadRow = psql(`select task_id || ' owner_matches_guest=' || (owner_sub='${sub}') || ' issuer=' || coalesce(metadata->>'oshalOwnerPrincipalIssuer','<none>') || ' messages=' || message_count from chat_tasks where task_id='${out.bookmarkedAfterAsk}'`);
      out.newThreadTurns = psql(`select count(*) from chat_messages where task_id='${out.bookmarkedAfterAsk}'`);
    }
  } catch (e) {
    out.error = e.message;
    try { await page.screenshot({ path: outDir + '/jarvis-guest-e2e-error.png', fullPage: true }); } catch {}
  } finally {
    try { const end = await page.request.post(base + '/api/guest/end'); out.guestEnd = end.status(); } catch {}
    try { out.cleanupLegacyRow = psql(`delete from chat_tasks where task_id='${legacyThread}' returning task_id`); } catch (e) { out.cleanupLegacyRow = e.message; }
    await browser.close();
    writeFileSync(outDir + '/jarvis-guest-e2e.json', JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
  }
})();
