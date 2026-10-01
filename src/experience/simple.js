/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | /simple (docs/architecture/simple-chat.md): the simple chat kit over the caller's Jarvis thread. It uses the endpoints and the device session key the shells already use (POST /api/jarvis/ask, GET /api/jarvis/ask/result, GET /api/jarvis/history, localStorage jarvisSessionId), so it is the same conversation as the Jarvis page and the shells. It adds no route and edits no existing screen.
 * -----------------------------------------------------------------------------
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && root.SimpleChat) api.start(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var SESSION_KEY = 'jarvisSessionId';
  var POLL_MS = 1500, MAX_POLLS = 200, SLOW_AFTER = 20;
  var VISUAL_LINK = { label: 'Open Jarvis to see the picture', href: '/api/jarvis/' };

  function uuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (_) { /* fall through */ }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function sessionId(storage) {
    try { var s = storage.getItem(SESSION_KEY); if (!s) { s = 'jarvis-' + uuid(); storage.setItem(SESSION_KEY, s); } return s; }
    catch (_) { return 'jarvis-' + Date.now(); }
  }
  function rollSession(storage) {
    var s = 'jarvis-' + uuid();
    try { storage.setItem(SESSION_KEY, s); } catch (_) { /* device storage unavailable */ }
    return s;
  }

  async function request(fetchImpl, path, method, payload) {
    try {
      var headers = payload === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' };
      var res = await fetchImpl(path, { method: method || 'GET', credentials: 'same-origin', headers: headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
      var body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      return { ok: res.ok, status: res.status, body: body };
    } catch (_) { return { ok: false, status: 0, body: null }; }
  }

  function refusal(r) {
    if (r.status === 0) return 'The swarm could not be reached.';
    if (r.status === 401) return 'You are signed out. Sign in again, then send your message.';
    var body = r.body || {};
    return String(body.message || body.error || ('The assistant answered HTTP ' + r.status + '.'));
  }

  /** The links an answer carries: each application handoff, each downloadable file, and its visual. */
  function answerLinks(d) {
    var links = [];
    (Array.isArray(d.handoffs) ? d.handoffs : []).forEach(function (h) {
      if (h && typeof h.deepLink === 'string') links.push({ label: 'Open ' + String(h.name || 'application') + ' ↗', href: h.deepLink });
    });
    (Array.isArray(d.files) ? d.files : []).forEach(function (f) {
      var href = f && (f.downloadUrl || f.url);
      if (typeof href === 'string' && href.indexOf('/api/') === 0) links.push({ label: '↓ ' + String(f.name || 'file'), href: href, download: true });
    });
    if (d.visual) links.push(VISUAL_LINK);
    return links;
  }

  function finish(d) {
    if (d.status === 'expired') return { ok: false, error: 'That request expired before an answer arrived.' };
    if (d.status === 'error') return { ok: false, error: String(d.error || 'That did not work.') };
    return { ok: true, text: String(d.answer || ''), links: answerLinks(d) };
  }

  /**
   * @description The Jarvis adapter for the simple chat kit: history and send over the caller's own Jarvis thread.
   * @param {{ fetch: Function, storage: Storage, sleep?: Function, pollMs?: number }} env Injected so a test can drive it.
   * @returns {{ history: Function, send: Function }} The kit adapter.
   */
  function createAdapter(env) {
    var fetchImpl = env.fetch, storage = env.storage;
    var sleep = env.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var pollMs = env.pollMs || POLL_MS;

    async function history() {
      var r = await request(fetchImpl, '/api/jarvis/history?sessionId=' + encodeURIComponent(sessionId(storage)));
      if (!r.ok || !r.body) return { ok: false, error: r.status === 401 ? refusal(r) : 'Your earlier conversation could not be loaded.' };
      var turns = (Array.isArray(r.body.turns) ? r.body.turns : []).map(function (t) {
        return { role: t.role === 'user' ? 'user' : 'assistant', text: String(t.text || ''), links: t.visual ? [VISUAL_LINK] : [] };
      });
      return { ok: true, turns: turns };
    }

    async function post(text) {
      var r = await request(fetchImpl, '/api/jarvis/ask', 'POST', { message: text, sessionId: sessionId(storage) });
      if (r.status === 404 && r.body && r.body.error === 'session_not_found') {
        r = await request(fetchImpl, '/api/jarvis/ask', 'POST', { message: text, sessionId: rollSession(storage) });
      }
      return r;
    }

    async function send(text, ui) {
      var r = await post(text);
      if (!r.ok || !r.body || !r.body.jobId) return { ok: false, error: refusal(r) };
      var jobId = encodeURIComponent(r.body.jobId);
      for (var i = 0; i < MAX_POLLS; i++) {
        await sleep(pollMs);
        var p = await request(fetchImpl, '/api/jarvis/ask/result?jobId=' + jobId);
        var d = p.ok && p.body ? p.body : null;
        if (d && d.status && d.status !== 'pending') return finish(d);
        if (i === SLOW_AFTER && ui && ui.progress) ui.progress('Still working on it');
      }
      return { ok: false, error: 'This is taking unusually long. It may still finish; check Jarvis later.' };
    }

    return { history: history, send: send };
  }

  /**
   * @description Boot the page: the kit full-page over the Jarvis adapter, with first-run help and examples.
   * @param {Window} win The page window.
   * @returns {object} The kit controller.
   */
  function start(win) {
    var adapter = createAdapter({ fetch: win.fetch.bind(win), storage: win.localStorage });
    return win.SimpleChat.boot({
      appId: 'jarvis-simple',
      title: 'Jarvis',
      helpTitle: 'Welcome to simple chat',
      intro: 'Type what you need in the box at the bottom and press Enter. Jarvis answers here, and your conversation stays above the box. Shift+Enter starts a new line.',
      examples: ['What can you help me with?', 'What is on my calendar today?', 'Give me a short summary of my open work.'],
      placeholder: 'Message Jarvis',
      fullHref: '/api/jarvis/',
      fullLabel: 'Full Jarvis',
      history: adapter.history,
      send: adapter.send
    });
  }

  return { createAdapter: createAdapter, start: start, finish: finish };
});
