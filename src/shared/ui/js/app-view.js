/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared audience-view kit (ADR-164 D6): a store page renders its family or company view from one declarative model (hero, stats, tiles, lists, tables, progress, timeline) over the tokens the skin paints, so every application in a Home or Business assembly shares one grammar per audience. The audience is read from `?audience=` as a request the page may honour (D5), never authority: data still comes from the page's own routes under the caller's session. Every view keeps one escape to the full application in the cockpit.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Date-only strings (YYYY-MM-DD, what pay dates, statement dates and transaction dates arrive as) format as that calendar day: `new Date('2026-09-15')` is UTC midnight, which the reader's local zone west of Greenwich showed as Sep 14 in every table.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The hero, headings and escape are neutral elements with heading roles: a page's own `header { ... }` / `h1 { ... }` rules boxed the CAD Studio hero, and a shared view must not inherit the host page's tag styling.
 * -----------------------------------------------------------------------------
 *
 * Usage (in a store page, after the theme bootstrap):
 *   <link rel="stylesheet" href="/shared/ui/css/app-view.css"><script src="/shared/ui/js/app-view.js"></script>
 *   AppView.boot({ app: 'finance', full: init, audiences: { family: buildFamily, company: buildCompany } });
 * A builder receives { audience, root, refresh, app } and returns (or resolves) a model:
 *   { kicker, title, lede, actions:[{label, href|onClick, primary}], stats:[{label, value, hint, tone}],
 *     sections:[{kind:'tiles'|'list'|'table'|'progress'|'timeline'|'custom', title, items|columns+rows|render, empty}],
 *     escape:{label, href} }
 * Everything is built with DOM nodes and textContent: model strings are never parsed as HTML.
 */
(function () {
  'use strict';

  /** The audience views a page may be asked for, with the shell each belongs to. */
  var AUDIENCES = { family: 'Home', company: 'Business', classroom: 'Classroom' };
  var ROOT_ID = 'av-root';
  var current = null;

  /** @returns {string|null} The requested audience from `?audience=`, or null when absent or unknown. */
  function audience() {
    try { var v = new URLSearchParams(window.location.search).get('audience'); return v && AUDIENCES[v] ? v : null; } catch (_) { return null; }
  }

  /** @returns {boolean} Whether this page is framed by a shell (an experience home or the cockpit). */
  function isHosted() { try { return !!window.parent && window.parent !== window; } catch (_) { return true; } }

  /** @returns {string|null} The audience view this page decided to render, once boot has run. */
  function active() { return current; }

  /**
   * @description Build an element. `attrs.text` sets textContent; `attrs.onClick` binds a click; other keys are attributes.
   * @param {string} tag
   * @param {object} [attrs]
   * @param {Array} [children] Elements, strings (text nodes) or falsy values (skipped).
   * @returns {HTMLElement}
   */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'onClick') node.addEventListener('click', value);
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  /** @returns {string} A currency amount for the reader's locale, or an em dash when the value is not a number. */
  function money(value, currency) {
    var n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n); } catch (_) { return String(n); }
  }

  /** @returns {string} A compact count (1,204 · 12.4k · 3.1M), or an em dash. */
  function num(value) {
    var n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    try { return new Intl.NumberFormat().format(n); } catch (_) { return String(n); }
  }

  /** @returns {string} A percentage for a 0..1 ratio (or a 0..100 number when `isPercent`). */
  function pct(value, isPercent) {
    var n = Number(value); if (!isFinite(n)) return '—';
    return Math.round(isPercent ? n : n * 100) + '%';
  }

  /** @returns {Date} A Date for a value; a date-only string (YYYY-MM-DD) is the reader's calendar day, not UTC midnight shifted into yesterday. */
  function toDate(value) {
    if (value instanceof Date) return value;
    var m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  }

  /** @returns {string} A short absolute date (Mar 4 · Mar 4, 2025 when not this year), or an em dash. */
  function date(value) {
    var d = toDate(value); if (!value || isNaN(d.getTime())) return '—';
    var opts = { month: 'short', day: 'numeric' }; if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    try { return d.toLocaleDateString(undefined, opts); } catch (_) { return d.toDateString(); }
  }

  /** @returns {string} A relative phrase (today · tomorrow · in 3 days · 2 h ago · Mar 4 beyond two weeks). */
  function when(value) {
    var d = toDate(value); if (!value || isNaN(d.getTime())) return '—';
    var dayOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), now = new Date();
    var diffMs = d.getTime() - now.getTime(), hours = Math.round(diffMs / 36e5);
    // A date-only value is a calendar day: compare days from the start of today, never hours.
    var days = dayOnly ? Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 864e5) : Math.round(diffMs / 864e5);
    if (!dayOnly && Math.abs(diffMs) < 36e5) return diffMs >= 0 ? 'soon' : 'just now';
    if (!dayOnly && Math.abs(hours) < 24) return hours > 0 ? 'in ' + hours + ' h' : Math.abs(hours) + ' h ago';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (Math.abs(days) <= 14) return days > 0 ? 'in ' + days + ' days' : Math.abs(days) + ' days ago';
    return date(d);
  }

  /** @description Leave the framed view for the full application: the top window navigates (same origin), a new tab otherwise. */
  function open(href) {
    try { window.top.location.assign(href); } catch (_) { window.open(href, '_blank', 'noopener'); }
  }

  /** @returns {{label: string, href: string}} The default escape for an application: its cockpit entry. */
  function escapeFor(app, label) {
    return { label: label || 'Open the full application in the cockpit', href: '/cockpit/?app=' + encodeURIComponent(app || '') };
  }

  function badge(text, tone) { return el('span', { class: 'av-badge' + (tone ? ' tone-' + tone : ''), text: text }); }

  function actionNode(a, extraClass) {
    var cls = (extraClass || 'av-btn') + (a.primary ? ' is-primary' : '');
    if (a.href && !a.onClick) return el('a', { class: cls, href: a.href, target: a.target || null, rel: a.target === '_blank' ? 'noopener' : null, text: a.label });
    return el('button', { class: cls, type: 'button', text: a.label, onClick: function (e) { e.preventDefault(); if (a.onClick) a.onClick(e); else if (a.href) window.location.assign(a.href); } });
  }

  function hero(m) {
    if (!m.title && !m.kicker && !m.lede && !(m.actions && m.actions.length)) return null;
    return el('div', { class: 'av-hero' }, [
      m.kicker ? el('div', { class: 'av-kicker', text: m.kicker }) : null,
      m.title ? el('div', { class: 'av-title', role: 'heading', 'aria-level': '1', text: m.title }) : null,
      m.lede ? el('p', { class: 'av-lede', text: m.lede }) : null,
      m.actions && m.actions.length ? el('div', { class: 'av-actions' }, m.actions.map(function (a) { return actionNode(a); })) : null
    ]);
  }

  function stats(items) {
    if (!items || !items.length) return null;
    return el('section', { class: 'av-stats', 'aria-label': 'At a glance' }, items.map(function (s) {
      return el('div', { class: 'av-stat' + (s.tone ? ' tone-' + s.tone : ''), 'data-stat': s.id || null }, [
        el('div', { class: 'av-stat-value', text: s.value === null || s.value === undefined || s.value === '' ? '—' : String(s.value) }),
        el('div', { class: 'av-stat-label', text: s.label || '' }),
        s.hint ? el('div', { class: 'av-stat-hint', text: s.hint }) : null
      ]);
    }));
  }

  function itemMeta(item) {
    return el('div', { class: 'av-item-meta' }, [item.meta ? el('span', { class: 'av-meta', text: item.meta }) : null, item.badge ? badge(item.badge, item.tone) : null]);
  }

  function clickable(node, item) {
    if (item.onClick || item.href) {
      node.classList.add('is-link'); node.setAttribute('tabindex', '0'); node.setAttribute('role', 'link');
      var go = function (e) { if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); if (item.onClick) item.onClick(e); else window.location.assign(item.href); };
      node.addEventListener('click', go); node.addEventListener('keydown', go);
    }
    return node;
  }

  function tiles(s) {
    return el('div', { class: 'av-tiles' }, s.items.map(function (t) {
      return clickable(el('article', { class: 'av-tile' + (t.tone ? ' tone-' + t.tone : '') }, [
        t.icon ? el('div', { class: 'av-tile-icon', text: t.icon, 'aria-hidden': 'true' }) : null,
        el('div', { class: 'av-tile-title', role: 'heading', 'aria-level': '3', text: t.title || '' }),
        t.text ? el('p', { class: 'av-tile-text', text: t.text }) : null,
        (t.meta || t.badge) ? itemMeta(t) : null
      ]), t);
    }));
  }

  function list(s) {
    return el('ul', { class: 'av-list' }, s.items.map(function (item) {
      return clickable(el('li', { class: 'av-item' + (item.tone ? ' tone-' + item.tone : '') }, [
        item.icon ? el('span', { class: 'av-item-icon', text: item.icon, 'aria-hidden': 'true' }) : null,
        el('div', { class: 'av-item-body' }, [el('div', { class: 'av-item-title', text: item.title || '' }), item.text ? el('div', { class: 'av-item-text', text: item.text }) : null]),
        (item.meta || item.badge) ? itemMeta(item) : null
      ]), item);
    }));
  }

  function table(s) {
    var head = el('tr', {}, (s.columns || []).map(function (c) { return el('th', { text: typeof c === 'string' ? c : c.label, class: c && c.align ? 'is-' + c.align : null }); }));
    var body = (s.rows || []).map(function (row) {
      var cells = Array.isArray(row) ? row : row.cells;
      var tr = el('tr', {}, cells.map(function (cell, i) {
        var col = s.columns && s.columns[i]; var tone = cell && typeof cell === 'object' ? cell.tone : null;
        return el('td', { class: [(col && col.align ? 'is-' + col.align : ''), (tone ? 'tone-' + tone : '')].join(' ').trim() || null, text: cell && typeof cell === 'object' ? cell.text : (cell === null || cell === undefined ? '' : String(cell)) });
      }));
      return Array.isArray(row) ? tr : clickable(tr, row);
    });
    return el('div', { class: 'av-table-wrap' }, [el('table', { class: 'av-table' }, [el('thead', {}, [head]), el('tbody', {}, body)])]);
  }

  function progress(s) {
    return el('div', { class: 'av-progress' }, s.items.map(function (p) {
      var ratio = Math.max(0, Math.min(1, Number(p.value) || 0));
      var bar = el('div', { class: 'av-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(ratio * 100)) }, [el('div', { class: 'av-bar-fill' + (p.tone ? ' tone-' + p.tone : '') })]);
      bar.firstChild.style.width = Math.round(ratio * 100) + '%';
      return el('div', { class: 'av-progress-row' }, [el('div', { class: 'av-progress-head' }, [el('span', { class: 'av-progress-label', text: p.label || '' }), el('span', { class: 'av-progress-text', text: p.text || pct(ratio) })]), bar]);
    }));
  }

  function timeline(s) {
    return el('ol', { class: 'av-timeline' }, s.items.map(function (t) {
      return el('li', { class: 'av-time' + (t.tone ? ' tone-' + t.tone : '') }, [
        el('div', { class: 'av-time-when', text: t.when || '' }),
        el('div', { class: 'av-time-body' }, [el('div', { class: 'av-time-title', text: t.title || '' }), t.text ? el('div', { class: 'av-time-text', text: t.text }) : null])
      ]);
    }));
  }

  var RENDERERS = { tiles: tiles, list: list, table: table, progress: progress, timeline: timeline };

  function section(s) {
    if (!s) return null;
    var hasItems = s.kind === 'table' ? (s.rows && s.rows.length) : s.kind === 'custom' ? true : (s.items && s.items.length);
    var body = hasItems && RENDERERS[s.kind] ? RENDERERS[s.kind](s) : s.kind === 'custom' ? el('div', { class: 'av-custom' }) : el('div', { class: 'av-empty', text: s.empty || 'Nothing here yet.' });
    var node = el('section', { class: 'av-section av-kind-' + (s.kind || 'custom') + (s.wide ? ' is-wide' : ''), 'data-section': s.id || null }, [
      (s.title || s.action) ? el('div', { class: 'av-section-head' }, [s.title ? el('div', { class: 'av-section-title', role: 'heading', 'aria-level': '2', text: s.title }) : null, s.action ? actionNode(s.action, 'av-link') : null]) : null,
      s.note ? el('p', { class: 'av-section-note', text: s.note }) : null,
      body
    ]);
    if (s.kind === 'custom' && typeof s.render === 'function') { try { s.render(body); } catch (e) { body.appendChild(el('div', { class: 'av-empty', text: 'This part could not be drawn.' })); } }
    return node;
  }

  function escapeNode(e) {
    if (!e || !e.href) return null;
    return el('div', { class: 'av-escape' }, [el('span', { class: 'av-escape-text', text: e.text || 'Looking for everything else?' }), el('a', { class: 'av-escape-link', href: e.href, text: e.label || 'Open the full application', onClick: function (ev) { ev.preventDefault(); open(e.href); } })]);
  }

  /**
   * @description Paint a model into a root (replacing what was there). The root gets `data-audience` so the CSS grammar of the audience applies.
   * @param {HTMLElement} root
   * @param {object} model
   * @param {string} [viewId] Defaults to the active view.
   */
  function mount(root, model, viewId) {
    model = model || {};
    root.className = 'av'; root.setAttribute('data-audience', viewId || model.audience || current || 'family');
    while (root.firstChild) root.removeChild(root.firstChild);
    [hero(model), stats(model.stats)].forEach(function (n) { if (n) root.appendChild(n); });
    var grid = el('div', { class: 'av-grid' }, (model.sections || []).map(section));
    if (grid.childNodes.length) root.appendChild(grid);
    var esc = escapeNode(model.escape); if (esc) root.appendChild(esc);
    return root;
  }

  /** @description Placeholder blocks while a builder loads, so a framed page never sits blank. */
  function skeleton(root, viewId) {
    root.className = 'av is-loading'; root.setAttribute('data-audience', viewId || current || 'family');
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(el('div', { class: 'av-skeleton', 'aria-busy': 'true' }, [el('div', { class: 'av-sk av-sk-title' }), el('div', { class: 'av-sk av-sk-line' }), el('div', { class: 'av-sk-row' }, [1, 2, 3].map(function () { return el('div', { class: 'av-sk av-sk-card' }); })), el('div', { class: 'av-sk av-sk-block' })]));
    return root;
  }

  /** @description A readable failure with the escape kept: the reader can always reach the full application. */
  function failure(root, error, escape, retry) {
    var message = error && error.message ? String(error.message) : 'This view could not load.';
    mount(root, { kicker: 'Not available right now', title: 'This view could not load', lede: message, actions: retry ? [{ label: 'Try again', onClick: retry, primary: true }] : [], escape: escape }, current || undefined);
    root.classList.add('is-error');
    return root;
  }

  function ensureRoot() {
    var root = document.getElementById(ROOT_ID);
    if (!root) { root = document.createElement('main'); root.id = ROOT_ID; document.body.insertBefore(root, document.body.firstChild); }
    return root;
  }

  function onReady(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true }); else fn(); }

  /**
   * @description Decide, synchronously, whether this page renders an audience view; paint it when the DOM is ready.
   * @param {{app?: string, full?: Function, audiences?: Object<string, Function>, escapeLabel?: string, title?: string}} spec
   * @returns {{audience: string, root: HTMLElement, refresh: Function, app: string}|null} The view context, or null when the full page runs.
   */
  function boot(spec) {
    spec = spec || {};
    var requested = audience(), builder = requested && spec.audiences ? spec.audiences[requested] : null;
    if (typeof builder !== 'function') { current = null; if (typeof spec.full === 'function') onReady(spec.full); return null; }
    current = requested;
    document.documentElement.setAttribute('data-audience', requested);
    if (spec.title) document.title = spec.title;
    var ctx = { audience: requested, root: null, app: spec.app || '', refresh: null };
    var run = function () {
      var escape = escapeFor(spec.app, spec.escapeLabel);
      return Promise.resolve().then(function () { return builder(ctx); }).then(function (model) {
        model = model || {}; if (!model.escape && spec.app) model.escape = escape;
        mount(ctx.root, model, requested); return model;
      }).catch(function (error) { failure(ctx.root, error, spec.app ? escape : null, run); });
    };
    ctx.refresh = run;
    onReady(function () { ctx.root = ensureRoot(); skeleton(ctx.root, requested); run(); });
    return ctx;
  }

  window.AppView = { AUDIENCES: AUDIENCES, audience: audience, active: active, isHosted: isHosted, boot: boot, mount: mount, skeleton: skeleton, failure: failure, el: el, badge: badge, money: money, num: num, pct: pct, date: date, when: when, open: open, escapeFor: escapeFor, toDate: toDate };
})();
