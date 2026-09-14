/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live-box validation for the Jarvis refused-thread recovery (docs/runbooks/jarvis-couldnt-do-that-just-now.md): statuses and safe bodies only, never a token, secret or subject.
 */
// Live-box probe, run INSIDE oshal-local-api on loopback. Mints a time-boxed PAT for the operator,
// asks on a thread owned by SOMEONE ELSE (ownership fails before any write: 404 session_not_found,
// zero side effects), reads the briefing client through the real route, then revokes the PAT by id.
// Prints statuses and safe bodies only — never the token, the secret, or the subject.
const base = 'http://127.0.0.1:' + (process.env.PORT || '5000');
const rawFetch = globalThis.fetch;
const fetch = (url, init = {}) => rawFetch(url, { ...init, signal: AbortSignal.timeout(20000) });
const secret = process.env.SWARM_SERVICE_SECRET;
const sub = process.env.PROBE_SUB;
const thread = process.env.PROBE_THREAD;
(async () => {
  const out = {};
  if (!secret || !sub || !thread) { console.log(JSON.stringify({ error: 'probe inputs missing', haveSecret: !!secret, haveSub: !!sub, haveThread: !!thread })); return; }
  const mint = await fetch(base + '/api/cli-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': secret, 'x-oshal-user-sub': sub },
    body: JSON.stringify({ label: 'jarvis-ask-probe-56e3d403' }),
  });
  const minted = await mint.json().catch(() => ({}));
  out.mint = { status: mint.status, id: minted.id, bootstrap: minted.bootstrap, expiresAt: minted.expiresAt, error: minted.error };
  if (!minted.token) { console.log(JSON.stringify(out, null, 1)); return; }
  const h = { authorization: 'Bearer ' + minted.token };
  try {
    const who = await fetch(base + '/api/cli-tokens/whoami', { headers: h });
    const whoBody = await who.json().catch(() => ({}));
    out.whoami = { status: who.status, subMatchesOperator: whoBody.sub === sub, issuer: whoBody.issuer ?? whoBody.iss ?? null };
    const ask = await fetch(base + '/api/jarvis/ask', {
      method: 'POST', headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'probe on a thread this caller does not own (must not run)', sessionId: thread }),
    });
    out.askForeignThread = { status: ask.status, body: (await ask.text()).slice(0, 200) };
    const js = await fetch(base + '/api/jarvis/briefings/client.js', { headers: h });
    out.briefingClient = { status: js.status, contentType: js.headers.get('content-type'), bodyHead: (await js.text()).slice(0, 100) };
  } finally {
    const rev = await fetch(base + '/api/cli-tokens/' + minted.id, { method: 'DELETE', headers: h });
    out.revoke = { status: rev.status, body: (await rev.text()).slice(0, 80) };
  }
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.log('probe error: ' + e.message); process.exit(1); });
