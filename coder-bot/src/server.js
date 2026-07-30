/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local HTTP surface on Node's built-in `http` with no framework, so the whole tool installs with zero dependencies and its entire attack surface is readable in one file. The listener binds 127.0.0.1 explicitly — not 0.0.0.0 — because these routes can photograph the screen and drive the mouse, and that must never be reachable from the network; combined with the absence of any control-plane link, the process has no remote caller by construction. The routes are unauthenticated BY DESIGN and that is only sound because of the loopback bind: never widen the bind address without adding authentication first. Three other guards are deliberate: `exclusive()` serializes screen/chat/control work so two callers cannot drive the cursor at once or interleave captures, the body reader caps at 1 MB and destroys the request so an unauthenticated POST cannot exhaust memory, and `serveFile` resolves paths and confines them to public/ so `..` cannot read the operator's disk. Static-file serving is limited to a small MIME allowlist for the same reason.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { CoderAssistant } = require('./assistant');
const { LiveContext } = require('./live-context');
const { ProactiveMonitor } = require('./proactive');

/**
 * @description Loopback port the local UI is served on, overridable with `CODER_BOT_PORT`.
 *
 * A fixed default so the bookmark and the launcher agree; overridable because 8076 may already be taken
 * on a developer's box. Tests pass 0 to get an ephemeral port rather than colliding with a running
 * instance.
 */
const DEFAULT_PORT = Number(process.env.CODER_BOT_PORT || 8076);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * @description Write a JSON response with an explicit length and no-store caching.
 * @param {import('http').ServerResponse} response The response.
 * @param {number} status HTTP status.
 * @param {object} body Serializable payload.
 * @returns {void} `no-store` because every payload here describes the user's screen or conversation and
 * has no business sitting in a cache.
 */
function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  response.end(data);
}

/**
 * @description Read and parse a JSON request body, refusing oversized ones.
 *
 * The 1 MB cap rejects AND destroys the request rather than merely stopping the read, so an
 * unauthenticated client cannot keep streaming into a buffer this process is still holding. An empty body
 * resolves to `{}` because several routes take only optional fields.
 *
 * @param {import('http').IncomingMessage} request The request.
 * @returns {Promise<object>} Parsed body.
 * @throws {Error} On a body over 1 MB or invalid JSON.
 */
function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
      if (body.length > 1_000_000) {
        reject(new Error('request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
  });
}

/**
 * @description Serve a file from public/, and nothing outside it.
 *
 * `path.resolve` collapses `..` first and the result must sit under public/, so a crafted URL cannot walk
 * out into the operator's home directory — the whole point, given this process runs with the user's full
 * privileges. Unknown extensions fall back to `application/octet-stream` rather than being guessed, so a
 * stray file can never be served as executable script.
 *
 * @param {import('http').ServerResponse} response The response.
 * @param {string} pathname Request path; `/` maps to index.html.
 * @returns {void} 403 on an escape attempt, 404 when absent or not a regular file.
 */
function serveFile(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    response.writeHead(403);
    return response.end('forbidden');
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    return response.end('not found');
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(response);
}

/**
 * @description Decide whether a chat message is really asking for a screen capture.
 *
 * Exists for the dictated case: someone says "okay, what do you see?" and expects the bot to look, not to
 * answer as if it already had. The patterns are kept narrow and anchored to explicit looking-at-my-screen
 * phrasing, because the failure mode to avoid is capturing the screen for a question that never asked for
 * it — an unexpected screenshot is a privacy surprise, so ambiguity resolves to plain chat.
 *
 * @param {string} message The user's message.
 * @returns {boolean} True to route to screen capture instead of chat.
 */
function isScreenshotRequest(message) {
  return /\b(?:screen\s*shot|screenshot|what (?:can|do) you see|look at (?:my|the|this) screen|read (?:my|the|this) screen|you take (?:a )?screen)/i
    .test(String(message || ''));
}

/**
 * @description Build and start the local server, the assistant, and the proactive monitor.
 *
 * One function owns the whole wiring so there is a single place where the loopback bind, the shared
 * single-flight lock, and the monitor's veto predicate meet — the monitor is given
 * `!state.busy && !state.controlActive` so background screen assessment always yields to whatever the user
 * is actively doing. The assistant's event stream is fanned out over SSE (rather than polled) because a
 * control run has to be watchable in real time for Stop to be meaningful. Starting the monitor inside the
 * `listen` callback means nothing captures the screen until the UI is actually reachable, and the `close`
 * handler stops it so the process can exit.
 *
 * @param {object} [options] Server options.
 * @param {number} [options.port=DEFAULT_PORT] Port to bind on 127.0.0.1; 0 for an ephemeral port.
 * @param {boolean} [options.open=false] Print the open-in-browser hint. It only hints: actually opening a
 * browser is the launcher's job, which is what keeps this dependency-free.
 * @returns {{server: import('http').Server, assistant: object, proactive: object, state: object}} Live
 * handles, returned so tests can drive and close the server without a global.
 */
function start({ port = DEFAULT_PORT, open = false } = {}) {
  const clients = new Set();
  const state = { busy: null, controlActive: false };
  const liveContext = new LiveContext();
  let voiceAssessing = false;
  const emit = (event) => {
    const payload = `data: ${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n\n`;
    for (const response of clients) response.write(payload);
  };
  const assistant = new CoderAssistant({
    onEvent: (event) => {
      if (event.type === 'control-start') state.controlActive = true;
      if (event.type === 'control-end' || event.type === 'control-aborted') state.controlActive = false;
      emit(event);
    },
  });
  const proactive = new ProactiveMonitor({
    assistant,
    onEvent: emit,
    shouldRun: () => !state.busy && !state.controlActive,
    getContext: () => liveContext.snapshot(),
  });

  /**
   * @description Assess buffered speech until nothing is pending, one pass at a time.
   *
   * Loops on `hasPending()` behind a single-runner flag instead of assessing per POST: `/api/context` is
   * fed every five seconds by the browser, and a model call takes longer than that, so a per-request
   * model call would queue an ever-growing backlog. Draining collapses everything said during a slow pass
   * into the next one. Failures are recorded as the assessment result so the loop terminates rather than
   * retrying the same transcript forever.
   *
   * @returns {Promise<void>} Always resolves; errors surface as `voice-error` events.
   */
  async function drainVoiceContext() {
    if (voiceAssessing) return;
    voiceAssessing = true;
    try {
      while (liveContext.hasPending()) {
        const version = liveContext.version;
        const transcript = liveContext.recentText();
        emit({ type: 'voice-assessing', version, transcript });
        try {
          const insight = await assistant.chat(
            `Assess this rolling five-second microphone transcript as live coding context. It may contain speech-recognition mistakes. Infer the likely goal, identify any issue, and recommend the next logical step:\n\n${transcript}`,
            [],
          );
          liveContext.markAssessed(version, insight);
          emit({ type: 'voice-suggestion', version, transcript, text: insight });
        } catch (error) {
          liveContext.markAssessed(version, `Text assessment failed: ${String(error.message || error)}`);
          emit({ type: 'voice-error', error: String(error.message || error) });
        }
      }
    } finally {
      voiceAssessing = false;
      emit({ type: 'voice-state', assessing: false, context: liveContext.snapshot() });
    }
  }

  /**
   * @description Single-flight lock around every screen, chat, and control operation.
   *
   * Rejects rather than queues, and that is the safety-relevant choice: these operations move a real cursor
   * and photograph a real screen, so a request that arrives during one must be refused outright — a queued
   * second control run would execute later against a screen nobody looked at. Also what keeps the proactive
   * monitor out of the way of an interactive request. The `finally` guarantees the lock is released even on
   * failure, so one error cannot leave the tool permanently "busy".
   *
   * @param {string} kind Human-readable description of the work, echoed to the UI as busy state.
   * @param {Function} operation The async work to run under the lock.
   * @returns {Promise<*>} Whatever the operation resolves to.
   * @throws {Error} With `status` 409 when something else already holds the lock.
   */
  async function exclusive(kind, operation) {
    if (state.busy) {
      const error = new Error(`Coder Bot is already ${state.busy}.`);
      error.status = 409;
      throw error;
    }
    state.busy = kind;
    emit({ type: 'busy', busy: kind });
    try {
      return await operation();
    } finally {
      state.busy = null;
      emit({ type: 'busy', busy: null });
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(response, 200, {
          ...state,
          listeningSupported: true,
          localOnly: true,
          proactive: proactive.snapshot(),
          alwaysListening: {
            assessing: voiceAssessing,
            context: liveContext.snapshot(),
          },
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        response.write(`data: ${JSON.stringify({ type: 'connected', ...state })}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJson(request);
        const text = String(body.message || '').trim();
        if (!text) return sendJson(response, 400, { error: 'Say or type a coding question.' });
        if (isScreenshotRequest(text)) {
          const result = await exclusive('reading the screen', () => assistant.readScreen({
            question: text,
            delayMs: body.delayMs ?? 1500,
          }));
          return sendJson(response, 200, result);
        }
        const answer = await exclusive('answering', () => assistant.chat(text, Array.isArray(body.history) ? body.history : []));
        return sendJson(response, 200, { text: answer });
      }
      if (request.method === 'POST' && url.pathname === '/api/screen') {
        const body = await readJson(request);
        const result = await exclusive('reading the screen', () => assistant.readScreen({
          question: body.question,
          delayMs: body.delayMs ?? process.env.CODER_BOT_CAPTURE_DELAY_MS ?? 3000,
        }));
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/operate') {
        const body = await readJson(request);
        const goal = String(body.goal || '').trim();
        if (!goal) return sendJson(response, 400, { error: 'Describe what the bot should do on screen.' });
        const result = await exclusive('controlling the screen', () => assistant.operate(goal));
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/control') {
        const body = await readJson(request);
        return sendJson(response, 200, assistant.control(body.action));
      }
      if (request.method === 'POST' && url.pathname === '/api/proactive') {
        const body = await readJson(request);
        return sendJson(response, 200, proactive.setEnabled(body.enabled));
      }
      if (request.method === 'POST' && url.pathname === '/api/context') {
        const body = await readJson(request);
        const context = liveContext.add(body.text, body.capturedAt);
        setImmediate(() => drainVoiceContext());
        return sendJson(response, 202, { accepted: true, context });
      }
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return serveFile(response, url.pathname);
      }
      response.writeHead(404);
      response.end('not found');
    } catch (error) {
      sendJson(response, error.status || 500, { error: String(error.message || error) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' ? address.port : port;
    console.log(`Coder Bot is ready at http://127.0.0.1:${actualPort}`);
    if (open) {
      // Opening is handled by the launcher so the server stays dependency-free.
      console.log('Open that local address in Chrome or Edge.');
    }
    proactive.start();
  });
  server.on('close', () => proactive.stop());
  return { server, assistant, proactive, state };
}

if (require.main === module) start();

module.exports = { DEFAULT_PORT, isScreenshotRequest, start };
