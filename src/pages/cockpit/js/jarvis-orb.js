/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the global Jarvis orb and super-admin diagnostics reveal.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fit the assistant panel within mobile safe areas and dynamic viewport height.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Honor manifest-driven assistant suppression before or after profile resolution and restore the orb for non-immersive apps.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Tolerant JSON parsing on the super-admin self-edit calls: startSession/commit called r.json() raw, so any HTML reply (proxy 502 page, unmounted route's HTML 404) surfaced to the operator as `SyntaxError: Unexpected token '<' … <!DOCTYPE`. parseJsonResponse() reads text, tries JSON, and falls back to a readable {error} so the pane always shows "HTTP <status> — server returned a non-JSON response" instead of doctype vomit.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Expand/restore control on the panel header. A user reported being unable to read an assistant answer: the docked panel is 400px wide, which is a phone-width reading column on a desktop monitor, and browser zoom does not help because the panel is sized by THIS document, not by the iframe's content. Expanded reuses the same pinned safe-area geometry the phone rule already proves, so the docked size and the mobile dynamic-viewport fix (entry 2) are untouched, and no Fullscreen API delegation is needed. The choice persists, and Escape restores before it closes.
 */

/**
 * Jarvis Orb — the global assistant on every cockpit page
 * -----------------------------------------------------------------------------
 * A single floating Jarvis bubble that lives in the cockpit SHELL (not the swapped
 * app iframes), so it is present on every ?app= and survives every ribbon switch.
 * Floating assistant bubble (the sanctioned shell-overlay pattern): IIFE, guarded,
 * scoped styles, lazy iframe. Unlike LM it is ADDITIVE — it never hides the chat rail.
 *
 * The panel embeds the existing auth-gated /api/jarvis/ surface, so no new chat
 * backend is required. When the server reports the signed-in caller is a super-admin
 * (GET /api/dev-console/access), the orb reveals a read-only "Dev diagnostics" pane
 * over the Developer Console endpoints. The reveal is a convenience only — every
 * dev-console endpoint enforces the super-admin double-gate server-side, so a forged
 * button reaches nothing (ADR-077).
 *
 * Bind-mounted (src/pages) so it hot-swaps on refresh with no rebuild.
 *
 */

(function () {
  var fullJarvisSurface = false;
  try {
    if (window.top !== window.self) return; // shell only — never inside an embedded surface
    var params = new URLSearchParams(window.location.search);
    var app = params.get('app') || params.get('profile');
    // The full Jarvis surface owns its own assistant already.
    fullJarvisSurface = app === 'jarvis';
  } catch (e) { return; }

  var JARVIS_URL = '/api/jarvis/';
  var ASSISTANT_HIDDEN_ATTR = 'data-oshal-assistant-hidden';
  var ASSISTANT_VISIBILITY_EVENT = 'oshal:assistant-visibility';

  function assistantIsHidden() {
    return fullJarvisSurface
      || document.documentElement.getAttribute(ASSISTANT_HIDDEN_ATTR) === 'true';
  }

  function removeOrb() {
    var fab = document.getElementById('jarvisOrbFab');
    var panel = document.getElementById('jarvisOrbPanel');
    if (fab) fab.remove();
    if (panel) panel.remove();
  }

  function scheduleInit() {
    if (assistantIsHidden()) { removeOrb(); return; }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }

  // app.js publishes both a durable attribute (profile may resolve first) and
  // this event (orb may resolve first). Keep the listener alive after removing
  // the nodes so switching to a non-immersive profile can recreate the orb.
  window.addEventListener(ASSISTANT_VISIBILITY_EVENT, function (event) {
    var hidden = !!(event && event.detail && event.detail.hidden);
    if (hidden || assistantIsHidden()) removeOrb();
    else scheduleInit();
  });

  function injectStyles() {
    if (document.getElementById('jarvisOrbStyles')) return;
    var css = ''
      + '#jarvisOrbFab {'
      + '  position: fixed; right: calc(22px + env(safe-area-inset-right, 0px)); bottom: calc(22px + env(safe-area-inset-bottom, 0px)); z-index: 2147483000;'
      + '  width: 60px; height: 60px; border-radius: 50%; cursor: pointer; border: none; padding: 0;'
      + '  background: radial-gradient(circle at 32% 28%, #5eead4, #14b8a6 42%, #0f766e 100%);'
      + '  box-shadow: 0 10px 26px -8px rgba(13,148,136,.6), 0 0 0 4px rgba(45,212,191,.14);'
      + '  display: flex; align-items: center; justify-content: center;'
      + '  transition: transform .15s ease, box-shadow .15s ease; }'
      + '#jarvisOrbFab:hover { transform: translateY(-2px) scale(1.06); box-shadow: 0 14px 30px -8px rgba(13,148,136,.7), 0 0 0 5px rgba(45,212,191,.22); }'
      + '#jarvisOrbFab:focus-visible { outline: 3px solid #99f6e4; outline-offset: 3px; }'
      + '#jarvisOrbFab svg { width: 30px; height: 30px; }'
      + '#jarvisOrbFab .jorb-badge {'
      + '  position: absolute; top: -4px; right: -4px; background: #f59e0b; color: #1a1205;'
      + '  font: 700 10px/1 ui-monospace, monospace; letter-spacing: .04em; padding: 4px 5px; border-radius: 999px;'
      + '  box-shadow: 0 2px 5px rgba(0,0,0,.4); display: none; }'
      + '#jarvisOrbFab.is-admin .jorb-badge { display: block; }'
      + '@media (prefers-reduced-motion: no-preference) {'
      + '  #jarvisOrbFab::after { content:""; position:absolute; inset:-3px; border-radius:50%;'
      + '    box-shadow:0 0 0 2px rgba(45,212,191,.35); animation: jorbPulse 2.8s ease-out infinite; }'
      + '  @keyframes jorbPulse { 0%{opacity:.7; transform:scale(1)} 100%{opacity:0; transform:scale(1.35)} } }'
      + '#jarvisOrbPanel {'
      + '  position: fixed; right: 22px; bottom: 94px; z-index: 2147483000;'
      + '  width: min(400px, calc(100vw - 32px)); height: min(640px, calc(100vh - 130px));'
      + '  height: min(640px, calc(100dvh - 130px));' // dvh accounts for the mobile URL bar; overrides the vh fallback where supported
      + '  background: #0b1622; border: 1px solid rgba(45,212,191,.22); border-radius: 18px;'
      + '  box-shadow: 0 28px 64px -16px rgba(0,0,0,.7); overflow: hidden;'
      + '  display: none; flex-direction: column; }'
      + '#jarvisOrbPanel.open { display: flex; }'
      // Expanded reuses the SAME pinned-inset geometry the phone rule below already proves out,
      // just at every width. Deliberately a CSS class and not the Fullscreen API: the orb lives in
      // the cockpit's top document, so this needs no allow="fullscreen" delegation on the iframe,
      // no cockpit-view-controller change, and it cannot re-open the URL-bar/dvh bug that change
      // log entry 2 exists to fix. The docked 400x640 rule above is untouched.
      + '#jarvisOrbPanel.wide {'
      + '  left: max(16px, env(safe-area-inset-left, 0px)); right: max(16px, env(safe-area-inset-right, 0px));'
      + '  top: max(16px, env(safe-area-inset-top, 0px)); bottom: max(16px, env(safe-area-inset-bottom, 0px));'
      + '  width: auto; height: auto; max-height: none; }'
      + '#jarvisOrbHead {'
      + '  display: flex; align-items: center; gap: 10px; padding: 11px 14px;'
      + '  background: linear-gradient(135deg,#0f766e,#155e75); color: #ecfeff; flex: none; }'
      + '#jarvisOrbHead .mk { width: 26px; height: 26px; }'
      + '#jarvisOrbHead .t { font-weight: 800; font-size: 14px; line-height: 1.1; }'
      + '#jarvisOrbHead .s { font-size: 11px; opacity: .82; }'
      + '#jarvisOrbHead .chip {'
      + '  font: 700 9.5px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase;'
      + '  background: rgba(245,158,11,.2); color: #fde68a; border: 1px solid rgba(245,158,11,.5);'
      + '  padding: 4px 7px; border-radius: 999px; display: none; }'
      + '#jarvisOrbHead.is-admin .chip { display: inline-block; }'
      + '#jarvisOrbHead .spacer { margin-left: auto; }'
      + '#jarvisOrbHead button {'
      + '  background: rgba(255,255,255,.16); border: none; color: #ecfeff; width: 28px; height: 28px;'
      + '  border-radius: 8px; cursor: pointer; font-size: 15px; line-height: 1; margin-left: 6px; }'
      + '#jarvisOrbHead button:hover { background: rgba(255,255,255,.3); }'
      + '#jarvisOrbHead button.dev { width: auto; padding: 0 9px; font: 700 11px/28px ui-monospace, monospace; display: none; }'
      + '#jarvisOrbHead.is-admin button.dev { display: inline-block; }'
      + '#jarvisOrbHead button.dev.active { background: #f59e0b; color: #1a1205; }'
      + '#jarvisOrbBody { flex: 1; position: relative; background: #0b1622; }'
      + '#jarvisOrbBody iframe { position:absolute; inset:0; width: 100%; height: 100%; border: 0; background: #0b1622; }'
      + '#jarvisOrbDev {'
      + '  position: absolute; inset: 0; overflow: auto; padding: 16px; display: none;'
      + '  color: #cbd5e1; font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }'
      + '#jarvisOrbDev.show { display: block; }'
      + '#jarvisOrbDev h4 { margin: 0 0 8px; color: #5eead4; font: 700 11px/1 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; }'
      + '#jarvisOrbDev .card { background: #0f1d2c; border: 1px solid rgba(148,163,184,.16); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; white-space: pre-wrap; word-break: break-word; }'
      + '#jarvisOrbDev .muted { color: #64748b; }'
      + '#jarvisOrbDev button.refresh { background: #14b8a6; color: #042f2e; border: none; border-radius: 8px; padding: 7px 12px; font: 700 12px ui-monospace, monospace; cursor: pointer; }'
      + '#jarvisOrbDev textarea { width: 100%; box-sizing: border-box; background: #0a1622; color: #cbd5e1; border: 1px solid rgba(148,163,184,.2); border-radius: 8px; padding: 8px; font: 12px ui-monospace, monospace; resize: vertical; }'
      + '#jarvisOrbDev .row { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }'
      + '#jarvisOrbDev .row button { border: none; border-radius: 8px; padding: 7px 12px; font: 700 12px ui-monospace, monospace; cursor: pointer; }'
      + '#jarvisOrbDev .btn-demo { background: #14b8a6; color: #042f2e; }'
      + '#jarvisOrbDev .btn-agent { background: #6366f1; color: #eef2ff; }'
      + '#jarvisOrbDev .btn-approve { background: #22c55e; color: #052e12; }'
      + '#jarvisOrbDev .btn-discard { background: #3f1d1d; color: #fca5a5; border: 1px solid rgba(248,113,113,.4); }'
      + '#jarvisOrbDev .btn-ghost { background: transparent; color: #64748b; border: 1px solid rgba(148,163,184,.25); }'
      + '#jarvisOrbDev .logline { padding: 1px 0; white-space: pre-wrap; word-break: break-word; }'
      + '#jarvisOrbDev .logline.status { color: #93c5fd; }'
      + '#jarvisOrbDev .logline.ok { color: #5eead4; }'
      + '#jarvisOrbDev .logline.error { color: #fca5a5; }'
      + '#jarvisOrbDev .logline.ready { color: #fde68a; font-weight: 700; }'
      + '#jarvisOrbDev .logline.chunk { color: #cbd5e1; opacity: .85; }'
      + '#jarvisOrbDev .diff { max-height: 240px; overflow: auto; background: #0a1622; border: 1px solid rgba(148,163,184,.16); border-radius: 8px; padding: 8px; font: 11px ui-monospace, monospace; white-space: pre; margin: 8px 0; }'
      + '#jarvisOrbDev .diff .add { color: #86efac; }'
      + '#jarvisOrbDev .diff .del { color: #fca5a5; }'
      // On phones, pin the panel between the top and bottom safe-area insets so it ALWAYS fits
      // the visible viewport — clearing the notch/status bar and the gesture nav bar, and never
      // sliding the chat input under the URL bar the way a 100vh height did (viewport-fit=cover).
      + '@media (max-width: 520px) { #jarvisOrbPanel {'
      + '  left: 8px; right: 8px; width: auto; height: auto; max-height: none;'
      + '  top: calc(env(safe-area-inset-top, 0px) + 10px);'
      + '  bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);'
      + '  border-radius: 16px; }'
      // Under 520px the panel already fills the screen, so an Expand button would do nothing.
      + '  #jarvisOrbHead button.expand { display: none; } }';
    var style = document.createElement('style');
    style.id = 'jarvisOrbStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  var ORB_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2z" fill="#ecfeff"/><circle cx="18.5" cy="16.5" r="1.6" fill="#a7f3d0"/><circle cx="6.2" cy="17.5" r="1.1" fill="#a7f3d0"/></svg>';

  function init() {
    if (assistantIsHidden()) { removeOrb(); return; }
    if (document.getElementById('jarvisOrbFab')) return;
    injectStyles();

    var fab = document.createElement('button');
    fab.id = 'jarvisOrbFab';
    fab.type = 'button';
    fab.title = 'Ask Jarvis';
    fab.setAttribute('aria-label', 'Ask Jarvis');
    fab.innerHTML = ORB_SVG + '<span class="jorb-badge" title="Super-admin">DEV</span>';

    var panel = document.createElement('div');
    panel.id = 'jarvisOrbPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Jarvis assistant');
    panel.innerHTML =
      '<div id="jarvisOrbHead">'
      + '<span class="mk">' + ORB_SVG + '</span>'
      + '<div><div class="t">Jarvis</div><div class="s">Your assistant, everywhere</div></div>'
      + '<span class="chip" title="You are signed in as a super-admin">super-admin</span>'
      + '<span class="spacer"></span>'
      + '<button type="button" class="dev" id="jarvisOrbDevToggle" title="Developer diagnostics">Dev</button>'
      + '<button type="button" class="expand" id="jarvisOrbExpand" title="Expand" aria-label="Expand the assistant panel" aria-pressed="false">&#10530;</button>'
      + '<button type="button" id="jarvisOrbClose" title="Close" aria-label="Close">&times;</button>'
      + '</div>'
      + '<div id="jarvisOrbBody"><div id="jarvisOrbDev"></div></div>';

    var body = panel.querySelector('#jarvisOrbBody');
    var devPane = panel.querySelector('#jarvisOrbDev');
    var devToggle = panel.querySelector('#jarvisOrbDevToggle');
    var loaded = false;

    function open() {
      if (!loaded) {
        var f = document.createElement('iframe');
        f.title = 'Jarvis';
        f.setAttribute('allow', 'microphone');
        f.src = JARVIS_URL;
        body.insertBefore(f, devPane);
        loaded = true;
      }
      panel.classList.add('open');
      fab.style.display = 'none';
    }
    function close() { panel.classList.remove('open'); fab.style.display = ''; }

    // The docked panel is 400px wide, which is a phone-width reading column on a desktop monitor.
    // A reader who needs the room needs it EVERY time, so the choice is remembered rather than
    // re-made on each open. Never throws — storage may be unavailable in a sandboxed frame.
    var WIDE_KEY = 'jarvis-orb-wide';
    function wideSaved() {
      try { return localStorage.getItem(WIDE_KEY) === '1'; } catch (_) { return false; }
    }
    function applyWide(on) {
      panel.classList.toggle('wide', !!on);
      var btn = panel.querySelector('#jarvisOrbExpand');
      if (btn) {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('title', on ? 'Restore' : 'Expand');
        btn.setAttribute('aria-label', on ? 'Restore the assistant panel' : 'Expand the assistant panel');
        btn.innerHTML = on ? '&#10532;' : '&#10530;';
      }
    }
    applyWide(wideSaved());

    fab.addEventListener('click', open);
    panel.addEventListener('click', function (e) {
      if (!e.target) return;
      if (e.target.id === 'jarvisOrbClose') { close(); return; }
      if (e.target.id === 'jarvisOrbExpand') {
        var next = !panel.classList.contains('wide');
        try { localStorage.setItem(WIDE_KEY, next ? '1' : '0'); } catch (_) {}
        applyWide(next);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !panel.classList.contains('open')) return;
      // Escape steps back one level — restore first, close only when already docked. Closing an
      // expanded panel outright would lose the answer the reader expanded in order to read.
      if (panel.classList.contains('wide')) {
        try { localStorage.setItem(WIDE_KEY, '0'); } catch (_) {}
        applyWide(false);
        return;
      }
      close();
    });

    if (devToggle) {
      devToggle.addEventListener('click', function () {
        var showing = devPane.classList.toggle('show');
        devToggle.classList.toggle('active', showing);
        if (showing) renderDevPane(devPane);
      });
    }

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    // Ask the server whether THIS caller is a super-admin; reveal the Dev affordance only
    // if so. Cosmetic only — the endpoints enforce the gate regardless.
    fetch('/api/dev-console/access', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.superAdmin) {
          fab.classList.add('is-admin');
          var head = panel.querySelector('#jarvisOrbHead');
          if (head) head.classList.add('is-admin');
        }
      })
      .catch(function () {});
  }

  // ── Self-edit session UI (Phase 2): instruction → sandboxed agent → live thought-chain →
  //    reviewable diff → Approve/Discard. Every action is super-admin-gated server-side. ──────
  function renderDevPane(pane) {
    pane.innerHTML =
      '<h4>Self-edit session</h4>'
      + '<textarea id="jorbInstruction" rows="3" placeholder="Describe the change for the agent. Demo mode ignores this and makes a safe, no-op edit to prove the loop end to end."></textarea>'
      + '<div class="row">'
      + '<button type="button" class="btn-demo" id="jorbRunDemo">Run demo</button>'
      + '<button type="button" class="btn-agent" id="jorbRunAgent">Run agent</button>'
      + '<button type="button" class="btn-ghost" id="jorbDiag">Diagnostics</button>'
      + '</div>'
      + '<div id="jorbRunOut"><p class="muted">Runs in an isolated container on a dev-session branch. Nothing reaches main until you approve.</p></div>';
    pane.querySelector('#jorbRunDemo').addEventListener('click', function () { startSession('demo'); });
    pane.querySelector('#jorbRunAgent').addEventListener('click', function () { startSession('agent'); });
    pane.querySelector('#jorbDiag').addEventListener('click', function () { loadDiagnostics(pane); });
  }

  // Parse a Response that SHOULD be JSON but may be an HTML error page (a proxy 502 page,
  // or an unmounted route's HTML 404). Never lets "<!DOCTYPE …" reach the operator as a
  // raw SyntaxError — a non-JSON body becomes a readable {error} instead.
  function parseJsonResponse(r) {
    return r.text().then(function (t) {
      try { return JSON.parse(t); }
      catch (e) { return { error: 'HTTP ' + r.status + ' — server returned a non-JSON response' }; }
    });
  }

  function startSession(mode) {
    var instruction = (document.getElementById('jorbInstruction') || {}).value || '';
    var out = document.getElementById('jorbRunOut');
    if (out._es) { try { out._es.close(); } catch (e) {} }
    out.innerHTML = '<div class="card" id="jorbLog" style="max-height:220px;overflow:auto;"></div>';
    var logEl = document.getElementById('jorbLog');
    appendLog(logEl, 'status', 'Starting ' + mode + ' session…');
    fetch('/api/dev-console/sessions', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode, instruction: instruction }),
    }).then(function (r) { return parseJsonResponse(r).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j.sessionId) { appendLog(logEl, 'error', (res.j && (res.j.error || res.j.reason)) || 'failed to start'); return; }
        streamSession(res.j.sessionId, out, logEl);
      }).catch(function (e) { appendLog(logEl, 'error', String(e)); });
  }

  function streamSession(sessionId, out, logEl) {
    var es = new EventSource('/api/dev-console/sessions/' + encodeURIComponent(sessionId) + '/stream');
    out._es = es;
    es.onmessage = function (ev) {
      var f; try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.type === 'agent-output') { appendLog(logEl, 'chunk', (f.data && f.data.chunk) || ''); }
      else if (f.type === 'diff') { renderDiff(out, f.data); }
      else if (f.type === 'verify') { appendLog(logEl, (f.data && f.data.passed) ? 'ok' : 'error', f.message); }
      else if (f.type === 'ready') { appendLog(logEl, 'ready', f.message); showApproval(out, sessionId, !!(f.data && f.data.canCommit)); }
      else if (f.type === 'committed') { appendLog(logEl, 'ok', 'Committed ' + String((f.data && f.data.sha) || '').slice(0, 8) + ' on ' + (f.data && f.data.branch)); es.close(); }
      else if (f.type === 'discarded') { appendLog(logEl, 'status', 'Discarded.'); es.close(); }
      else if (f.type === 'error') { appendLog(logEl, 'error', f.message || 'error'); es.close(); }
      else if (f.message) { appendLog(logEl, 'status', f.message); }
    };
    es.onerror = function () { /* SSE auto-reconnects; terminal frames close() explicitly */ };
  }

  function showApproval(out, sessionId, canCommit) {
    var box = document.createElement('div');
    box.className = 'row';
    box.innerHTML = (canCommit
      ? '<button type="button" class="btn-approve" id="jorbApprove">Approve &amp; commit</button>'
      : '<span class="muted">Commit blocked (typecheck failed or no changes).</span>')
      + '<button type="button" class="btn-discard" id="jorbDiscard">Discard</button>';
    out.appendChild(box);
    var approve = box.querySelector('#jorbApprove');
    if (approve) approve.addEventListener('click', function () {
      approve.disabled = true;
      fetch('/api/dev-console/sessions/' + encodeURIComponent(sessionId) + '/commit', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'dev-console: approved edit' }),
      }).then(parseJsonResponse).then(function (j) {
        if (!j.ok) { appendLog(document.getElementById('jorbLog'), 'error', j.error || 'commit failed'); approve.disabled = false; }
      });
    });
    var discard = box.querySelector('#jorbDiscard');
    if (discard) discard.addEventListener('click', function () {
      fetch('/api/dev-console/sessions/' + encodeURIComponent(sessionId) + '/discard', { method: 'POST', credentials: 'same-origin' });
    });
  }

  function renderDiff(out, data) {
    var existing = out.querySelector('#jorbDiff');
    var head = out.querySelector('#jorbDiffHead');
    if (!head) {
      head = document.createElement('div'); head.id = 'jorbDiffHead'; head.className = 'muted';
      out.appendChild(head);
    }
    head.textContent = 'Proposed diff (' + ((data && data.files && data.files.length) || 0) + ' file(s)):';
    var el = existing || document.createElement('div');
    el.id = 'jorbDiff'; el.className = 'diff';
    el.innerHTML = String((data && data.patch) || '').split('\n').slice(0, 500).map(function (l) {
      var c = l.charAt(0) === '+' && l.charAt(1) !== '+' ? 'add' : (l.charAt(0) === '-' && l.charAt(1) !== '-' ? 'del' : '');
      return c ? '<span class="' + c + '">' + escapeHtml(l) + '</span>' : escapeHtml(l);
    }).join('\n');
    if (!existing) out.appendChild(el);
  }

  function appendLog(logEl, cls, text) {
    if (!logEl) return;
    var line = document.createElement('div');
    line.className = 'logline ' + cls;
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function loadDiagnostics(pane) {
    pane.innerHTML = '<p class="muted">Loading diagnostics&hellip;</p>';
    Promise.all([
      fetch('/api/dev-console/status', { credentials: 'same-origin' }).then(readJson),
      fetch('/api/dev-console/health-snapshot', { credentials: 'same-origin' }).then(readJson),
    ]).then(function (parts) {
      var status = parts[0], health = parts[1];
      pane.innerHTML =
        '<button type="button" class="refresh" id="jarvisOrbRefresh">Refresh</button>'
        + '<h4>Console status</h4><div class="card">' + fmt(status) + '</div>'
        + '<h4>Job health (recent)</h4><div class="card">' + fmt(health) + '</div>'
        + '<p class="muted">Read-only diagnostics. Editing &amp; recovery arrive in later phases.</p>';
      var btn = pane.querySelector('#jarvisOrbRefresh');
      if (btn) btn.addEventListener('click', function () { loadDiagnostics(pane); });
    });
  }

  function readJson(r) {
    return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; })
      .catch(function () { return { ok: r.ok, status: r.status, body: null }; });
  }

  function fmt(res) {
    if (!res) return '<span class="muted">no response</span>';
    if (!res.ok) return '<span class="muted">' + res.status + ' — ' + escapeHtml((res.body && res.body.reason) || (res.body && res.body.error) || 'unavailable') + '</span>';
    return escapeHtml(JSON.stringify(res.body, null, 2));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; });
  }

  scheduleInit();
})();
