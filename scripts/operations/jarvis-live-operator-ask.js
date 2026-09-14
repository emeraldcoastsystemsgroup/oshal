/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live-box validation for the Jarvis refused-thread recovery (docs/runbooks/jarvis-couldnt-do-that-just-now.md): statuses and safe bodies only, never a token, secret or subject.
 */
// Live-box product test, run INSIDE oshal-local-api on loopback: ask Jarvis the operator's actual
// question as the operator through a time-boxed PAT on a FRESH, clearly-labelled thread, poll the
// result as the same authenticated principal, print the answer, revoke the PAT by id.
// Prints statuses, the answer text and safe metadata only — never the token, secret or subject.
const base = 'http://127.0.0.1:' + (process.env.PORT || '5000');
const rawFetch = globalThis.fetch;
const fetch = (url, init = {}) => rawFetch(url, { ...init, signal: AbortSignal.timeout(20000) });
const secret = process.env.SWARM_SERVICE_SECRET;
const sub = process.env.PROBE_SUB;
const sessionId = process.env.PROBE_SESSION || 'jarvis-validate-56e3d403';
const message = process.env.PROBE_MESSAGE || 'How did I do in the stock market last week?';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const out = { sessionId, message };
  if (!secret || !sub) { console.log(JSON.stringify({ error: 'inputs missing', haveSecret: !!secret, haveSub: !!sub })); return; }
  const mint = await fetch(base + '/api/cli-tokens', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-secret': secret, 'x-oshal-user-sub': sub },
    body: JSON.stringify({ label: 'jarvis-operator-ask-56e3d403' }),
  });
  const minted = await mint.json().catch(() => ({}));
  out.mint = { status: mint.status, id: minted.id, error: minted.error };
  if (!minted.token) { console.log(JSON.stringify(out, null, 1)); return; }
  const h = { authorization: 'Bearer ' + minted.token };
  try {
    const started = Date.now();
    const ask = await fetch(base + '/api/jarvis/ask', {
      method: 'POST', headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    });
    const askBody = await ask.json().catch(() => ({}));
    out.ask = { status: ask.status, jobId: askBody.jobId, error: askBody.error };
    if (!askBody.jobId) { console.log(JSON.stringify(out, null, 1)); return; }
    let result = null;
    const pollDeadline = Date.now() + Number(process.env.PROBE_POLL_BUDGET_MS || 210000);
    while (Date.now() < pollDeadline) {
      await sleep(3000);
      const r = await fetch(base + '/api/jarvis/ask/result?jobId=' + encodeURIComponent(askBody.jobId), { headers: h });
      const body = await r.json().catch(() => ({}));
      if (r.status !== 200) { result = { pollStatus: r.status, body }; break; }
      if (body.status && body.status !== 'pending') { result = body; break; }
    }
    out.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (!result) out.result = { status: 'still pending after poll budget' };
    else out.result = {
      status: result.status ?? result.pollStatus, error: result.error,
      answer: typeof result.answer === 'string' ? result.answer.slice(0, 1500) : result.answer,
      handoffs: Array.isArray(result.handoffs) ? result.handoffs.length : undefined,
      body: result.body,
    };
  } finally {
    // Close the test thread's board ticket so the operator's board does not keep an open test card.
    try {
      const close = await fetch(base + '/api/jarvis/thread/close', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
      out.threadClose = { status: close.status };
    } catch (error) { out.threadClose = { error: error.message }; }
    const rev = await fetch(base + '/api/cli-tokens/' + minted.id, { method: 'DELETE', headers: h });
    out.revoke = { status: rev.status, body: (await rev.text()).slice(0, 60) };
  }
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.log('probe error: ' + e.message); process.exit(1); });
