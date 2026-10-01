/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Simple chat kit (docs/architecture/simple-chat.md): one plain text screen drawn from an adapter the page supplies. The box sits at the bottom, the history above it, first-run help shows once per device and app, waiting and failure are rows in the history, and replies render as escape-first markdown with same-origin or https links only. The kit owns no endpoint. A page mounts it into an element or boots it full-page.
 * -----------------------------------------------------------------------------
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SimpleChat = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var HELP_KEY = 'oshal-simple-chat:help-dismissed:';
  var DEFAULT_ERROR = 'That did not work.';
  var EMPTY_ANSWER = 'No answer text was returned.';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * @description Resolve a link the assistant wrote to something this page may open: a path that stays on this
   * origin, or an absolute https URL (opened in a new tab). Anything else (javascript:, data:, protocol-relative,
   * a path that resolves off-origin) is refused, so a reply can never become a script or a silent redirect.
   * @param {string} href The href as written, already HTML-decoded.
   * @param {string} [origin] The page origin; defaults to location.origin.
   * @returns {{href: string, external: boolean}|null} The safe link, or null when it must stay text.
   */
  function safeHref(href, origin) {
    var raw = String(href || '').trim();
    if (/^https:\/\/[^\s<>"']+$/i.test(raw)) return { href: raw, external: true };
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charAt(1) === '\\') return null;
    var page = origin || (typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : 'https://local.invalid');
    try {
      var base = new URL(page), resolved = new URL(raw, base);
      if (resolved.origin !== base.origin) return null;
      return { href: resolved.pathname + resolved.search + resolved.hash, external: false };
    } catch (_) { return null; }
  }

  function anchor(label, link) {
    var attrs = link.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return '<a href="' + esc(link.href) + '"' + attrs + '>' + label + '</a>';
  }

  /** Bold, italics, [label](href) and bare https URLs over text that has NOT been escaped yet. */
  function formatSpan(text, origin) {
    var saved = [];
    var keep = function (html) { saved.push(html); return '\u0000' + (saved.length - 1) + '\u0000'; };
    // The placeholder byte is stripped from the reply first, so reply text can never name a saved link.
    var out = String(text).replace(/\u0000/g, '').replace(/\[([^\]\n]{1,200})\]\(([^\s()<>"']{1,500})\)/g, function (whole, label, href) {
      var link = safeHref(href, origin);
      return link ? keep(anchor(esc(label), link)) : whole;
    });
    out = out.replace(/https:\/\/[^\s<>"'()\u0000]{3,500}/g, function (url) {
      var trimmed = url.replace(/[.,;:!?]+$/, ''), link = safeHref(trimmed, origin);
      return link ? keep(anchor(esc(trimmed), link)) + url.slice(trimmed.length) : url;
    });
    out = esc(out)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
    return out.replace(/\u0000(\d+)\u0000/g, function (_, i) { return saved[Number(i)] || ''; });
  }

  /** Inline markdown for one line: `code` spans are literal, everything else is formatted. */
  function inline(line, origin) {
    return String(line).split('`').map(function (part, i) {
      return i % 2 ? '<code>' + esc(part) + '</code>' : formatSpan(part, origin);
    }).join('');
  }

  var LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+(.*)$/;

  function blockHtml(lines, origin) {
    if (lines.every(function (l) { return LIST_ITEM.test(l); })) {
      var ordered = /^\s*\d/.test(lines[0]), tag = ordered ? 'ol' : 'ul';
      return '<' + tag + '>' + lines.map(function (l) { return '<li>' + inline(l.match(LIST_ITEM)[2], origin) + '</li>'; }).join('') + '</' + tag + '>';
    }
    var heading = lines.length === 1 && lines[0].match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) return '<p class="sc-h"><strong>' + inline(heading[1], origin) + '</strong></p>';
    return '<p>' + lines.map(function (l) { return inline(l, origin); }).join('<br>') + '</p>';
  }

  /**
   * @description Render reply text as escape-first markdown: paragraphs, line breaks, bullet and numbered lists,
   * headings, fenced code, inline code, bold, italics and links. Every character from the reply is escaped before
   * any tag is emitted, so reply content cannot inject markup.
   * @param {string} text The reply text.
   * @param {string} [origin] The page origin used to keep relative links on this site.
   * @returns {string} Safe HTML; an empty string when the text is empty.
   */
  function renderMarkdown(text, origin) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var html = [], block = [], fence = null;
    var flush = function () { if (block.length) html.push(blockHtml(block, origin)); block = []; };
    lines.forEach(function (line) {
      if (/^\s*```/.test(line)) {
        if (fence) { html.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>'); fence = null; }
        else { flush(); fence = []; }
        return;
      }
      if (fence) { fence.push(line); return; }
      if (!line.trim()) { flush(); return; }
      block.push(line);
    });
    if (fence) html.push('<pre><code>' + esc(fence.join('\n')) + '</code></pre>');
    flush();
    return html.join('');
  }

  /** A history read that never answers must not leave the box disabled: after `ms` it counts as unavailable. */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { resolve({ ok: false, error: 'Your earlier conversation is taking too long to load.' }); }, ms);
      Promise.resolve(promise).then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function readFlag(key) { try { return window.localStorage.getItem(key) === '1'; } catch (_) { return false; } }
  function writeFlag(key) { try { window.localStorage.setItem(key, '1'); } catch (_) { /* device storage unavailable */ } }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** The slim header: title, Help, and the optional link to the full screen. */
  function buildHeader(opts) {
    var header = el('header', 'sc-header header-bar');
    header.appendChild(el('h1', 'sc-title', opts.title || 'Chat'));
    var help = el('button', 'sc-header-btn', 'Help');
    help.type = 'button'; help.setAttribute('data-action', 'help');
    header.appendChild(help);
    if (opts.fullHref) {
      var full = el('a', 'sc-header-btn sc-full', opts.fullLabel || 'Full screen');
      full.href = opts.fullHref;
      header.appendChild(full);
    }
    return header;
  }

  /** The first-run card: what this assistant does and example prompts that fill the box. */
  function buildHelp(opts) {
    var card = el('section', 'sc-help');
    card.setAttribute('aria-label', 'How this chat works');
    card.hidden = true;
    card.appendChild(el('h2', 'sc-help-title', opts.helpTitle || 'Welcome'));
    card.appendChild(el('p', 'sc-help-intro', opts.intro || 'Type a message in the box at the bottom and press Enter. Replies appear here, above the box.'));
    var list = el('div', 'sc-examples');
    (opts.examples || []).slice(0, 4).forEach(function (example) {
      var b = el('button', 'sc-example', example);
      b.type = 'button'; b.setAttribute('data-example', example);
      list.appendChild(b);
    });
    if (list.childNodes.length) {
      card.appendChild(el('p', 'sc-help-try', 'Try one of these:'));
      card.appendChild(list);
    }
    var done = el('button', 'sc-help-done', 'Got it');
    done.type = 'button'; done.setAttribute('data-action', 'dismiss-help');
    card.appendChild(done);
    return card;
  }

  function buildComposer(opts) {
    var form = el('form', 'sc-composer');
    var inner = el('div', 'sc-composer-inner');
    var label = el('label', 'sc-sr', 'Message');
    var input = el('textarea', 'sc-input');
    input.id = opts.inputId || 'sc-input'; label.htmlFor = input.id;
    input.rows = 1; input.placeholder = opts.placeholder || 'Type a message';
    input.setAttribute('autocomplete', 'off');
    var send = el('button', 'sc-send', 'Send');
    send.type = 'submit';
    inner.appendChild(label); inner.appendChild(input); inner.appendChild(send);
    form.appendChild(inner);
    return { form: form, input: input, send: send };
  }

  /** Links an answer carries (application handoffs, files, a visual) as safe anchors. */
  function linksRow(links, origin) {
    var row = el('div', 'sc-links');
    (links || []).forEach(function (l) {
      var link = l && safeHref(l.href, origin);
      if (!link) return;
      var a = el('a', 'sc-link', String(l.label || l.href));
      a.href = link.href;
      if (link.external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      if (l.download) a.setAttribute('download', '');
      row.appendChild(a);
    });
    return row.childNodes.length ? row : null;
  }

  /** One history row. `user` and `note` are plain text; `assistant` and `error` carry their own content. */
  function turnNode(kind, text, extras, origin) {
    var row = el('div', 'sc-turn sc-' + kind);
    row.setAttribute('data-role', kind);
    var bubble = el('div', 'sc-bubble');
    if (kind === 'assistant') {
      var html = renderMarkdown(text, origin);
      if (html) bubble.innerHTML = html;
      else { bubble.classList.add('sc-empty'); bubble.textContent = EMPTY_ANSWER; }
    } else {
      bubble.textContent = String(text == null ? '' : text);
    }
    row.appendChild(bubble);
    var links = extras && linksRow(extras.links, origin);
    if (links) row.appendChild(links);
    if (extras && extras.note) row.appendChild(el('div', 'sc-note-line', String(extras.note)));
    return row;
  }

  /**
   * @description Mount a simple chat into an element. The adapter owns every request: `send(text, ui)` resolves to
   * `{ ok: true, text, links?, note? }` or `{ ok: false, error }` (a rejected promise counts as a failure), and the
   * optional `history()` resolves to `{ ok, turns: [{ role: 'user'|'assistant'|'note', text, links?, note? }], error? }`.
   * @param {HTMLElement} container Where the chat is drawn; it fills the element.
   * @param {object} opts The adapter and copy: appId, title, intro, examples, placeholder, fullHref, fullLabel, send, history.
   * @returns {{ addTurn: Function, submit: Function, showHelp: Function, hideHelp: Function, ready: Promise<void>, element: HTMLElement }} The controller.
   */
  function mount(container, opts) {
    var options = opts || {}, origin = options.origin;
    var helpKey = HELP_KEY + String(options.appId || 'default');
    var state = { turns: 0, busy: false };
    var shell = el('div', 'sc');
    var header = buildHeader(options), main = el('main', 'sc-main');
    var log = el('div', 'sc-log');
    log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-label', 'Conversation');
    var help = buildHelp(options), composer = buildComposer(options);
    main.appendChild(log); main.appendChild(help);
    shell.appendChild(header); shell.appendChild(main); shell.appendChild(composer.form);
    container.innerHTML = ''; container.appendChild(shell);

    function scrollToEnd() { main.scrollTop = main.scrollHeight; }
    function setBusy(busy) {
      state.busy = busy; composer.input.disabled = busy; composer.send.disabled = busy;
      shell.classList.toggle('is-busy', busy);
    }
    function addTurn(kind, text, extras) {
      var row = turnNode(kind, text, extras, origin);
      log.appendChild(row);
      if (kind === 'user' || kind === 'assistant') state.turns++;
      scrollToEnd();
      return row;
    }
    function showHelp() { help.hidden = false; scrollToEnd(); }
    function hideHelp(dismiss) { help.hidden = true; if (dismiss) writeFlag(helpKey); }
    function refreshHelp() { if (!state.turns && !readFlag(helpKey)) showHelp(); else help.hidden = true; }
    function autosize() {
      composer.input.style.height = 'auto';
      composer.input.style.height = Math.min(composer.input.scrollHeight, 160) + 'px';
    }

    async function submit(text) {
      var value = String(text == null ? composer.input.value : text).trim();
      if (!value || state.busy || typeof options.send !== 'function') return false;
      hideHelp(true);
      composer.input.value = ''; autosize();
      addTurn('user', value);
      var thinking = addTurn('thinking', 'Thinking…');
      setBusy(true);
      var reply;
      var ui = { progress: function (label) { thinking.querySelector('.sc-bubble').textContent = String(label || 'Thinking…'); } };
      try { reply = await options.send(value, ui); } catch (err) { reply = { ok: false, error: err && err.message ? err.message : DEFAULT_ERROR }; }
      thinking.remove();
      setBusy(false);
      if (reply && reply.ok !== false) addTurn('assistant', reply.text, reply);
      else addTurn('error', (reply && reply.error) || DEFAULT_ERROR);
      composer.input.focus();
      return true;
    }

    async function loadHistory() {
      if (typeof options.history !== 'function') { refreshHelp(); return; }
      setBusy(true);
      var loading = addTurn('note', 'Loading your conversation…');
      var result;
      try { result = await withTimeout(options.history(), options.historyTimeoutMs || 15000); } catch (_) { result = { ok: false }; }
      loading.remove();
      setBusy(false);
      if (!result || result.ok === false) addTurn('note', (result && result.error) || 'Your earlier conversation could not be loaded.');
      ((result && result.turns) || []).forEach(function (t) {
        var kind = t.role === 'user' ? 'user' : t.role === 'note' ? 'note' : 'assistant';
        addTurn(kind, t.text, t);
      });
      refreshHelp();
      scrollToEnd();
    }

    composer.form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    composer.input.addEventListener('input', autosize);
    composer.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    shell.addEventListener('click', function (e) {
      var target = e.target && e.target.closest ? e.target.closest('[data-action],[data-example]') : null;
      if (!target) return;
      if (target.getAttribute('data-example')) { composer.input.value = target.getAttribute('data-example'); autosize(); composer.input.focus(); return; }
      var action = target.getAttribute('data-action');
      if (action === 'help') { if (help.hidden) showHelp(); else hideHelp(false); }
      if (action === 'dismiss-help') { hideHelp(true); composer.input.focus(); }
    });

    var ready = loadHistory().then(function () { composer.input.focus(); });
    return { addTurn: addTurn, submit: submit, showHelp: showHelp, hideHelp: hideHelp, ready: ready, element: shell };
  }

  /**
   * @description True when the page was opened in the simple layout (`?layout=simple`). Pages that keep a full
   * screen by default use this to decide whether to boot the kit instead of starting their own UI.
   * @returns {boolean} Whether the simple layout was requested.
   */
  function active() {
    try { return new URLSearchParams(location.search).get('layout') === 'simple'; } catch (_) { return false; }
  }

  /**
   * @description Take over the whole page with a simple chat: marks `<html data-layout="simple">` (the stylesheet then
   * hides everything else in the body) and mounts into `#sc-root`, creating it when absent.
   * @param {object} opts As for mount().
   * @returns {object} The controller from mount().
   */
  function boot(opts) {
    document.documentElement.setAttribute('data-layout', 'simple');
    var rootEl = document.getElementById('sc-root');
    if (!rootEl) { rootEl = el('div'); rootEl.id = 'sc-root'; document.body.appendChild(rootEl); }
    return mount(rootEl, opts);
  }

  return { mount: mount, boot: boot, active: active, renderMarkdown: renderMarkdown, safeHref: safeHref };
});
