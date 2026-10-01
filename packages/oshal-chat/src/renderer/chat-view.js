/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Simple chat window (Config -> Window: Simple chat, docs/architecture/simple-chat.md): the shared simple chat kit over the node's existing chat bridge (oshal.sendChat, the reply on oshal.onReply). History stays on this computer because the node's chat route has no history read. Swarm tasks this machine runs appear in the history as short notes. The orb window is untouched.
 * -----------------------------------------------------------------------------
 */

'use strict';

(function () {
  var HISTORY_KEY = 'oshalNodeSimpleChat';
  var MAX_TURNS = 200;
  var REPLY_TIMEOUT_MS = 10 * 60 * 1000;
  var chat = null;
  var pending = null;

  function valid(turn) {
    return turn && (turn.role === 'user' || turn.role === 'assistant' || turn.role === 'note') && typeof turn.text === 'string';
  }
  function readTurns() {
    try {
      var stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(stored) ? stored.filter(valid) : [];
    } catch (_) { return []; }
  }
  function remember(role, text) {
    var turns = readTurns();
    turns.push({ role: role, text: String(text), at: new Date().toISOString() });
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(turns.slice(-MAX_TURNS))); } catch (_) { /* device storage unavailable */ }
  }

  /** Resolve the turn that is waiting for its reply; false when none is waiting. */
  function settle(result) {
    if (!pending) return false;
    var waiting = pending;
    pending = null;
    clearTimeout(waiting.timer);
    waiting.resolve(result);
    return true;
  }

  /** The kit's send(): post the turn over the bridge and wait for the reply the poll loop delivers. */
  function sender(oshal) {
    return function (text) {
      remember('user', text);
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          settle({ ok: false, error: 'No reply yet. The swarm may still be working on it; try again in a moment.' });
        }, REPLY_TIMEOUT_MS);
        pending = { resolve: resolve, timer: timer };
        Promise.resolve().then(function () { return oshal.sendChat(text); }).catch(function (err) {
          settle({ ok: false, error: err && err.message ? err.message : String(err) });
        });
      });
    };
  }

  function workNote(ev) {
    var intent = String((ev && ev.intent) || 'a task');
    if (ev && ev.phase === 'claimed') return 'Running a swarm task on this computer: ' + intent;
    if (ev && ev.phase === 'completed') return 'Finished: ' + intent;
    return 'Failed: ' + intent + (ev && ev.error ? ' (' + ev.error + ')' : '');
  }

  window.OshalNodeChat = {
    /**
     * @description Draw the simple chat into the node window once; later calls return the same chat.
     * @param {HTMLElement} container The node's chat view element.
     * @param {object} oshal The preload bridge (sendChat is the only call the chat makes).
     * @returns {object} The kit controller.
     */
    start: function (container, oshal) {
      if (chat) return chat;
      chat = window.SimpleChat.mount(container, {
        appId: 'oshal-node',
        title: 'Chat',
        inputId: 'node-chat-input',
        helpTitle: 'Welcome',
        intro: 'Type what you need in the box at the bottom and press Enter. The swarm answers here, and your conversation stays above the box on this computer. Shift+Enter starts a new line.',
        examples: ['What can you help me with?', 'Summarize what changed in my swarm today.', 'Draft a short status update for my team.'],
        placeholder: 'Message the swarm',
        history: function () { return Promise.resolve({ ok: true, turns: readTurns() }); },
        send: sender(oshal)
      });
      return chat;
    },
    /**
     * @description Deliver a chat.reply from the swarm: it answers the waiting turn, or is added on its own when it
     * arrives after that turn stopped waiting.
     * @param {{success?: boolean, text?: string, error?: string}} reply The reply payload.
     * @returns {void}
     */
    reply: function (reply) {
      var result = reply && reply.success && reply.text
        ? { ok: true, text: String(reply.text) }
        : { ok: false, error: (reply && reply.error) || 'The bot returned an empty reply.' };
      if (result.ok) remember('assistant', result.text);
      if (!settle(result) && chat) chat.addTurn(result.ok ? 'assistant' : 'error', result.ok ? result.text : result.error);
    },
    /**
     * @description Add a swarm task this machine ran to the history as a short note.
     * @param {{phase: string, intent?: string, error?: string}} ev The worker event.
     * @returns {void}
     */
    work: function (ev) {
      var note = workNote(ev);
      remember('note', note);
      if (chat) chat.addTurn('note', note);
    }
  };
})();
