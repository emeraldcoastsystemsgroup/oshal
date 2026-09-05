/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 1: the ONE shared "Send to…" component every surface loads (served at /api/artifacts/send-to.js). window.oshalSendTo(meta, anchorEl) fetches the caller-scoped menu for the artifact's MIME type, mints an owner-bound handle on pick, then dispatches: open mode navigates the TOP window to /cockpit/?app=<name>&artifact=<ref> (the shell forwards the ref to the surface iframe — D4a), post mode POSTs {ref} to the destination's own auth-gated endpoint and shows the outcome inline. Self-contained styling; Esc/outside-click dismiss; no framework dependencies so any classic-script surface can use it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 2 (Amendment B): overlay dispatch — a kernel-registered action carrying `overlay` opens that page in an in-place iframe modal with the ref (no navigation, the source surface keeps its state). First user: the "Email it…" compose built-in.
 */

(function () {
  'use strict';

  var OPEN_MENU = null;

  function closeMenu() {
    if (OPEN_MENU && OPEN_MENU.parentNode) OPEN_MENU.parentNode.removeChild(OPEN_MENU);
    OPEN_MENU = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onOutside(e) { if (OPEN_MENU && !OPEN_MENU.contains(e.target)) closeMenu(); }
  function onKey(e) { if (e.key === 'Escape') closeMenu(); }

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (text) n.textContent = text;
    return n;
  }

  function menuShell(anchorEl) {
    var m = el('div',
      'position:fixed;z-index:9999;min-width:230px;max-width:320px;background:#151b23;color:#dbe4ee;' +
      'border:1px solid #2a3644;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.5);' +
      'padding:6px;font:13px system-ui,sans-serif;');
    var r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    var top = r ? Math.min(window.innerHeight - 60, r.bottom + 6) : window.innerHeight / 3;
    var left = r ? Math.min(window.innerWidth - 260, Math.max(8, r.left)) : window.innerWidth / 2 - 130;
    m.style.top = top + 'px';
    m.style.left = left + 'px';
    return m;
  }

  function statusLine(menu, msg, isErr) {
    var s = menu.querySelector('[data-sendto-status]');
    if (!s) {
      s = el('div', 'padding:7px 9px;font-size:12px;color:#8fa1b3;');
      s.setAttribute('data-sendto-status', '1');
      menu.appendChild(s);
    }
    s.textContent = msg;
    s.style.color = isErr ? '#ff7a7a' : '#8fa1b3';
  }

  function mintHandle(meta) {
    return fetch('/api/artifacts/handles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: meta.source, type: meta.type, name: meta.name || '' })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('mint failed (' + r.status + ')'));
        return j.ref;
      });
    });
  }

  /** Amendment B: open a kernel overlay page in an in-place iframe modal — the source surface
   *  keeps its state (no navigation). The page reads ?artifact= like any destination. */
  function openOverlay(url) {
    var wrap = el('div', 'position:fixed;inset:0;z-index:9998;background:rgba(4,8,12,.7);display:flex;align-items:center;justify-content:center;padding:20px;');
    var box = el('div', 'position:relative;width:min(520px,96vw);background:#0f141a;border:1px solid #2a3644;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.6);');
    var x = el('button', 'position:absolute;top:8px;right:10px;z-index:1;background:rgba(0,0,0,.5);color:#dbe4ee;border:0;border-radius:7px;padding:3px 9px;cursor:pointer;font:13px system-ui,sans-serif;', '✕');
    var f = document.createElement('iframe');
    f.src = url;
    f.style.cssText = 'width:100%;height:min(560px,88vh);border:0;display:block;';
    x.onclick = function () { wrap.remove(); };
    wrap.onclick = function (e2) { if (e2.target === wrap) wrap.remove(); };
    box.appendChild(x); box.appendChild(f); wrap.appendChild(box);
    document.body.appendChild(wrap);
  }

  function dispatch(menu, meta, action) {
    statusLine(menu, 'Preparing…');
    mintHandle(meta).then(function (ref) {
      if (action.overlay) {
        closeMenu();
        openOverlay(action.overlay + (action.overlay.indexOf('?') >= 0 ? '&' : '?') + 'artifact=' + encodeURIComponent(ref));
        return;
      }
      if (action.mode === 'open') {
        // D4a: navigate the SHELL, not this iframe — the cockpit forwards artifact= to the
        // destination surface. Same-origin, so window.top is reachable.
        var target = '/cockpit/?app=' + encodeURIComponent(action.app) + '&artifact=' + encodeURIComponent(ref);
        try { (window.top || window).location.href = target; }
        catch (e) { window.location.href = target; }
        return;
      }
      statusLine(menu, 'Sending…');
      return fetch(action.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: ref })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.message || j.error || ('failed (' + r.status + ')'));
          statusLine(menu, '✓ ' + (j.message || 'Done'));
          setTimeout(closeMenu, 1600);
        });
      });
    }).catch(function (e) {
      statusLine(menu, e && e.message ? e.message : 'Send failed', true);
    });
  }

  /**
   * Open the "Send to…" menu for one artifact.
   * meta: { type: 'image/png', name: 'portrait.png', source: '/api/<app>/<owner-scoped serve path>' }
   * anchorEl: the button/element the menu should appear near (optional).
   */
  window.oshalSendTo = function (meta, anchorEl) {
    closeMenu();
    if (!meta || !meta.type || !meta.source) return;
    var menu = menuShell(anchorEl);
    OPEN_MENU = menu;
    menu.appendChild(el('div', 'padding:5px 9px 7px;font-weight:600;font-size:12px;color:#8fa1b3;', 'Send to…'));
    statusLine(menu, 'Looking up destinations…');
    document.body.appendChild(menu);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);

    fetch('/api/artifacts/actions?type=' + encodeURIComponent(meta.type))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!OPEN_MENU) return;
        var actions = (j && j.actions) || [];
        if (!actions.length) { statusLine(menu, 'Nothing accepts ' + meta.type + ' yet.'); return; }
        statusLine(menu, '');
        actions.forEach(function (a) {
          var b = el('button',
            'display:block;width:100%;text-align:left;background:none;border:0;color:#dbe4ee;' +
            'padding:8px 9px;border-radius:7px;cursor:pointer;font:13px system-ui,sans-serif;');
          b.textContent = (a.icon ? a.icon + ' ' : '') + a.label;
          b.onmouseenter = function () { b.style.background = '#22303f'; };
          b.onmouseleave = function () { b.style.background = 'none'; };
          b.onclick = function () { dispatch(menu, meta, a); };
          menu.insertBefore(b, menu.querySelector('[data-sendto-status]'));
        });
      })
      .catch(function () { if (OPEN_MENU) statusLine(menu, 'Could not load destinations.', true); });
  };
})();
