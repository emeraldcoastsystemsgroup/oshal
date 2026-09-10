/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145 D9: the cross-app Home view. One card per installed group/app showing what happened (the app's own summary probe, or its jarvis_tasks when it declares none) and what still needs you (its readiness probes). Every probe is asked HERE, in the signed-in user's own session — core never impersonates the caller and never reads an app's tables.
 * Home customization | Codex | Add saved display choices, stable metric catalogs, and traceable suite/page highlights.
 */
import { ordered, move, catalog, selected, highlights } from './app-home-model.js';


/**
 * ADR-097 suite shelves — the grouping axis for this view (operator, 2026-09-09: "the groups are
 * the suites"). Order and labels are kept identical to the installed/Discover list in
 * src/pages/applications/index.html; if you change one, change both.
 */
export const SUITES = [
  ['platform', 'Platform'],
  ['ai-productivity', 'AI Productivity'],
  ['ai-knowledge', 'AI Knowledge'],
  ['ai-finance', 'AI Finance'],
  ['ai-creative', 'AI Creative'],
  ['ai-home', 'AI Home & Lifestyle'],
  ['ai-engineering', 'AI Engineering'],
];

/** ADR-145 D7: never open more than this many probes at once — a box can run 59 active apps. */
const MAX_IN_FLIGHT = 6;
/** ADR-145 D7: a probe that does not answer in this long renders "can't check", not a fact. */
const PROBE_TIMEOUT_MS = 3000;
/** How many recent jarvis_tasks stand in for an app that declares no summary probe. */
const FALLBACK_ITEMS = 3;

/** Bounds copied from the server contract so the view degrades identically on a bad payload. */
const MAX_TILES = 4;
const MAX_ITEMS = 5;

/**
 * @description Resolve an RFC 6901 pointer, reporting whether the location exists at all, so a
 * missing location is distinguishable from a present `null` and renders "can't check".
 * @param {unknown} value - Document to resolve against.
 * @param {string} pointer - RFC 6901 pointer.
 * @returns {{found: boolean, value?: unknown}} Whether it resolved, and to what.
 */
export function atPointer(value, pointer) {
  if (pointer === '') return { found: true, value };
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { found: false };
  let cursor = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object') return { found: false };
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(key)) return { found: false };
      const idx = Number(key);
      if (idx >= cursor.length) return { found: false };
      cursor = cursor[idx];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return { found: false };
    cursor = cursor[key];
  }
  return { found: true, value: cursor };
}

/** A wrong or absent tone becomes neutral — it must never ESCALATE (ADR-145 D2). */
function tone(value) {
  return value === 'good' || value === 'warn' ? value : 'neutral';
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * @description Group a user's jarvis_tasks rows by the `App: …` title prefix (the core #305
 * convention), so an app that declares no summary probe still has something to report.
 * @param {Array<object>} rows - Rows from GET /api/jarvis/tasks.
 * @returns {Map<string, Array<object>>} Lowercased prefix to its most recent rows.
 */
export function groupTasksByAppPrefix(rows) {
  const byPrefix = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const match = /^([^:]{1,40}):\s+/.exec(String(row?.title || ''));
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(row);
  }
  return byPrefix;
}

/**
 * @description Section plan entries onto the ADR-097 suite shelves, in the shared shelf order.
 * A suite with no installed app is omitted entirely; anything carrying an unknown or missing
 * suite lands in a trailing "Other" shelf rather than being dropped, so a package can never
 * disappear from the page by mis-declaring one field.
 * @param {Array<object>} entries - Plan entries from GET /api/swarm/apps/home-plan.
 * @returns {Array<{key: string, label: string, entries: Array<object>}>} Non-empty shelves, in order.
 */
export function sectionBySuite(entries) {
  const known = new Set(SUITES.map(([key]) => key));
  const buckets = new Map(SUITES.map(([key]) => [key, []]));
  const other = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry && known.has(entry.suite)) buckets.get(entry.suite).push(entry);
    else if (entry) other.push(entry);
  }
  const shelves = SUITES
    .filter(([key]) => buckets.get(key).length)
    .map(([key, label]) => ({ key, label, entries: buckets.get(key) }));
  if (other.length) shelves.push({ key: 'other', label: 'Other', entries: other });
  return shelves;
}

/** Run `jobs` with bounded concurrency; every job resolves (never rejects). */
async function pooled(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = new Array(Math.min(limit, jobs.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      try { results[i] = await jobs[i](); } catch { results[i] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetch JSON in the viewer's own session, with a timeout. Never throws. */
async function askProbe(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AppsHomeView — the cockpit's cross-app landing page (ADR-145 D9).
 *
 * @description Renders one card per installed group/app: its headline tiles and line items from
 * the app's own `summary:` probe (or its recent Jarvis tasks when it declares none), plus the
 * setup steps still outstanding from its `readiness:` probes. Each card degrades on its own — a
 * slow or broken app shows "can't check" and never blocks another card.
 */
export class AppsHomeView {
  /**
   * @description Wire up the shell callbacks the cards need.
   * @param {object} deps - Injected collaborators.
   * @param {Function} deps.navigateToView - Switch the cockpit to a view id (e.g. `tool-foo`).
   * @param {Function} [deps.showToast] - Transient notification callback.
   */
  constructor({ navigateToView, showToast } = {}) {
    this.navigateToView = navigateToView || (() => {});
    this.showToast = showToast || (() => {});
    this.entries = [];
  }

  /**
   * @description Paint the shell, load the plan, then probe every app concurrently (bounded) and
   * render each card as its answers land.
   * @param {HTMLElement} container - Host element; its innerHTML is replaced.
   * @returns {Promise<void>} Resolves once every card has settled.
   */
  async render(container) {
    this.container = container;
    const generation = (this.generation || 0) + 1;
    this.generation = generation;
    this.cards = new Map();
    this.editor = null;
    container.innerHTML = '<div class="apps-home"><p role="status">Loading your applications...</p></div>';
    const [plan, prefs, tasks] = await Promise.all([
      askProbe('/api/swarm/apps/home-plan'), askProbe('/api/home/preferences'), askProbe('/api/jarvis/tasks'),
    ]);
    if (generation !== this.generation) return;
    this.entries = plan.ok && Array.isArray(plan.body?.apps) ? plan.body.apps : [];
    this.preferences = prefs.ok ? prefs.body.preferences : { version: 1 };
    this.revision = prefs.ok ? prefs.body.revision : 0;
    this.canSave = prefs.ok;
    this.notice = !prefs.ok ? 'Display settings could not be loaded. Refresh to try again; editing is unavailable.' : '';
    if (!plan.ok) this.notice = 'The application list could not be read. Refresh to try again.';
    this.byPrefix = groupTasksByAppPrefix(tasks.ok ? (tasks.body?.tasks || tasks.body || []) : []);
    this.draw();
    // One shared queue caps ALL requests, including group members and repeated readiness paths.
    const paths = [...new Set(this.entries.flatMap(e => [...e.summary, ...e.todos].map(p => p.path)))];
    const responses = new Map();
    await pooled(paths.map(path => async () => { responses.set(path, await askProbe(path)); }), MAX_IN_FLIGHT);
    if (generation !== this.generation) return;
    for (const entry of this.entries) await this.loadCard(entry, this.byPrefix, responses);
    this.draw();
  }

  /** Render the saved layout without refetching or mutating any app's data. */
  draw() {
    const scroll = this.container.querySelector('dialog')?.scrollTop || 0;
    const p = this.preferences;
    const shelves = ordered(sectionBySuite(this.entries), p.suiteOrder, s => s.key);
    const visible = shelves.filter(s => !(p.hiddenSuites || []).includes(s.key)).map(s => ({ ...s,
      entries: ordered(s.entries, p.appOrder, e => e.name).filter(e => !(p.hiddenApps || []).includes(e.name)),
    }));
    const top = visible.flatMap(s => highlights(s.entries, this.cards, p).slice(0, 3))
      .sort((a, b) => Number(b.tone === 'warn') - Number(a.tone === 'warn')).slice(0, 5);
    this.container.innerHTML = `<div class="apps-home">
      <header class="apps-home-head"><h2>Home</h2><p>Your applications, your overview.</p>
        <div class="apps-home-head-actions"><button data-action="refresh">Refresh</button><button data-action="customize" ${!this.canSave ? 'disabled' : ''}>Customize</button></div></header>
      ${this.notice ? `<p role="status" class="apps-home-notice">${esc(this.notice)}</p>` : ''}
      ${top.length ? `<section class="apps-home-highlights"><h3>Highlights</h3>${this.highlightHtml(top)}</section>` : ''}
      <div class="apps-home-grid">${visible.map(shelf => `<section class="apps-home-shelf">
        <header class="apps-home-shelf-head"><h3>${esc(shelf.label)}</h3><button data-action="collapse" data-id="${esc(shelf.key)}" aria-expanded="${!(p.collapsedSuites || []).includes(shelf.key)}" ${!this.canSave ? 'disabled' : ''}>${(p.collapsedSuites || []).includes(shelf.key) ? 'Expand' : 'Collapse'}</button></header>
        ${this.highlightHtml(highlights(shelf.entries, this.cards, p).slice(0, 3))}
        ${(p.collapsedSuites || []).includes(shelf.key) ? '' : `<div class="apps-home-tiles-grid">${shelf.entries.map(entry => {
          const data = this.cards.get(entry.name), pref = p.cards?.[entry.name] || {};
          return `<section class="apps-home-card ${pref.compact ? 'is-compact' : ''}" data-card="${esc(entry.name)}">${this.cardHead(entry)}${data ? this.body(selected(data, pref)) : '<p class="apps-home-loading">Checking...</p>'}</section>`;
        }).join('')}</div>`}</section>`).join('')}</div>
      ${!visible.some(s => s.entries.length) ? '<p>No boxes are visible. Use Customize to show your applications.</p>' : ''}
      ${this.editor ? this.editorHtml(shelves) : ''}</div>`;
    this.container.onclick = ev => { void this.handleClick(ev); };
    this.container.onchange = ev => { void this.handleChange(ev); };
    const dialog = this.container.querySelector('dialog');
    if (dialog) {
      dialog.showModal(); dialog.scrollTop = scroll;
      if (!this.saving && this.restoreFocus) { dialog.querySelector(this.restoreFocus)?.focus({ preventScroll: true }); this.restoreFocus = null; }
      dialog.addEventListener('close', () => { this.editor = null; });
    }
  }

  highlightHtml(rows) {
    return rows.length ? `<ul class="apps-home-highlights-list">${rows.map(row => `<li class="tone-${tone(row.tone)}"><strong>${esc(row.displayName)}</strong> <span>${esc(row.text)}</span>${row.fix ? `<button data-open="${esc(row.fix)}">Open</button>` : ''}</li>`).join('')}</ul>` : '';
  }

  arrows(kind, id, at, length) {
    return `<span class="apps-home-order"><button data-action="move" data-kind="${kind}" data-id="${esc(id)}" data-delta="-1" aria-label="Move ${esc(id)} up" ${at === 0 || this.saving ? 'disabled' : ''}>Up</button><button data-action="move" data-kind="${kind}" data-id="${esc(id)}" data-delta="1" aria-label="Move ${esc(id)} down" ${at === length - 1 || this.saving ? 'disabled' : ''}>Down</button></span>`;
  }

  editorHtml(shelves) {
    const e = this.editor, p = this.preferences;
    let content;
    if (e.type === 'layout') {
      content = shelves.map((s, at) => `<section class="apps-home-edit-group"><div class="apps-home-edit-row"><label><input type="checkbox" data-choice="suite" data-id="${esc(s.key)}" ${!(p.hiddenSuites || []).includes(s.key) ? 'checked' : ''}> ${esc(s.label)}</label>${this.arrows('suite', s.key, at, shelves.length)}</div>
        ${ordered(s.entries, p.appOrder, x => x.name).map((a, index, list) => `<div class="apps-home-edit-row"><label><input type="checkbox" data-choice="app" data-id="${esc(a.name)}" ${!(p.hiddenApps || []).includes(a.name) ? 'checked' : ''}> ${esc(a.displayName)}</label>${this.arrows('app', a.name, index, list.length)}</div>`).join('')}</section>`).join('');
    } else {
      const pref = p.cards?.[e.name] || {}, data = this.cards.get(e.name);
      const metrics = ordered((data?.tiles || []).filter(t => t.id), pref.metricOrder);
      const shown = new Set(selected(data || { tiles: [], items: [], open: [] }, pref).tiles.map(t => t.id));
      content = metrics.map((m, at) => `<div class="apps-home-edit-row"><label><input type="checkbox" data-choice="metric" data-id="${esc(m.id)}" ${shown.has(m.id) ? 'checked' : ''}> ${esc(m.label)}</label>${this.arrows('metric', m.id, at, metrics.length)}</div>`).join('')
        || '<p>This app has not provided selectable data points yet. Its display options are still available.</p>';
      content += [['compact', 'Compact box', pref.compact === true], ['showItems', 'Show updates', pref.showItems !== false], ['showSetup', 'Show setup steps', pref.showSetup !== false]].map(([key, label, checked]) => `<p><label><input type="checkbox" data-choice="card" data-id="${key}" ${checked ? 'checked' : ''}> ${label}</label></p>`).join('');
    }
    return `<dialog class="apps-home-editor" aria-labelledby="homeEditTitle"><header><h2 id="homeEditTitle">${e.type === 'layout' ? 'Customize Home' : esc(this.entries.find(a => a.name === e.name)?.displayName)}</h2><button data-action="close">Done</button></header><p role="status">${this.saving ? 'Saving...' : esc(this.notice || 'Changes save to your account.')}</p><fieldset ${this.saving ? 'disabled' : ''}>${content}</fieldset><button data-action="reset" ${this.saving ? 'disabled' : ''}>Restore ${e.type === 'layout' ? 'all defaults' : 'box defaults'}</button></dialog>`;
  }

  async save(next) {
    if (!this.canSave || this.saving) return;
    const active = this.container.ownerDocument.activeElement;
    if (active?.dataset.choice) this.restoreFocus = `[data-choice="${CSS.escape(active.dataset.choice)}"][data-id="${CSS.escape(active.dataset.id)}"]`;
    else if (active?.dataset.action === 'move') this.restoreFocus = `[data-action="move"][data-id="${CSS.escape(active.dataset.id)}"][data-delta="${active.dataset.delta}"]`;
    this.saving = true;
    this.notice = '';
    this.draw();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let response;
      try { response = await fetch('/api/home/preferences', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: next, revision: this.revision }), signal: controller.signal }); }
      finally { clearTimeout(timer); }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save display settings.');
      this.preferences = result.preferences;
      this.revision = result.revision;
      this.notice = 'Display settings saved.';
    } catch (err) { this.notice = `${err.message} Your changes were not applied. Refresh before trying again.`; }
    finally { this.saving = false; this.draw(); }
  }

  async handleClick(ev) {
    const button = ev.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.open) { this.navigateToView(`tool-${button.dataset.open}`); return; }
    const { action, id, kind, delta } = button.dataset;
    if (action === 'refresh') { if (!this.saving) await this.render(this.container); return; }
    if (action === 'close') { this.editor = null; this.draw(); return; }
    if (action === 'customize' || action === 'edit') { this.editor = action === 'customize' ? { type: 'layout' } : { type: 'card', name: id }; this.draw(); return; }
    const next = structuredClone(this.preferences);
    if (action === 'reset') {
      if (this.editor?.type === 'card') { if (next.cards) delete next.cards[this.editor.name]; await this.save(next); }
      else await this.save({ version: 1 });
    } else if (action === 'collapse') {
      next.collapsedSuites = toggle(next.collapsedSuites, id); await this.save(next);
    } else if (action === 'move') {
      if (kind === 'suite') next.suiteOrder = move(ordered(sectionBySuite(this.entries), next.suiteOrder, s => s.key).map(s => s.key), id, Number(delta));
      else if (kind === 'app') {
        const suite = this.entries.find(a => a.name === id)?.suite;
        const group = ordered(this.entries.filter(a => a.suite === suite), next.appOrder, a => a.name).map(a => a.name);
        next.appOrder = [...move(group, id, Number(delta)), ...(next.appOrder || []).filter(a => !group.includes(a))];
      } else {
        next.cards ||= {}; next.cards[this.editor.name] ||= {};
        const card = next.cards[this.editor.name];
        card.metricOrder = move(ordered(this.cards.get(this.editor.name).tiles.filter(t => t.id), card.metricOrder).map(t => t.id), id, Number(delta));
      }
      await this.save(next);
    }
  }

  async handleChange(ev) {
    const { choice, id } = ev.target.dataset;
    if (!choice || this.saving) return;
    const next = structuredClone(this.preferences), checked = ev.target.checked;
    if (choice === 'app' || choice === 'suite') {
      const key = choice === 'app' ? 'hiddenApps' : 'hiddenSuites';
      next[key] = setHidden(next[key], id, !checked);
    } else {
      next.cards ||= {}; next.cards[this.editor.name] ||= {};
      const pref = next.cards[this.editor.name];
      if (choice === 'metric') {
        pref.hiddenMetrics = setHidden(pref.hiddenMetrics, id, !checked);
        pref.shownMetrics = setHidden(pref.shownMetrics, id, checked);
      } else pref[id] = checked;
    }
    await this.save(next);
  }

  /** The card shell rendered before its probes answer. */
  skeleton(entry) {
    return `<section class="apps-home-card" data-card="${esc(entry.name)}">${this.cardHead(entry)}
      <p class="apps-home-loading">Checking…</p></section>`;
  }

  cardHead(entry) {
    const open = entry.firstSurface
      ? `<button type="button" class="apps-home-open" data-open="${esc(entry.firstSurface)}">Open</button>`
      : '';
    const badge = entry.kind === 'group'
      ? `<span class="apps-home-badge">${entry.members.length} apps</span>` : '';
    return `<header class="apps-home-card-head">
      <h3>${esc(entry.displayName)}</h3>${badge}${open}<button data-action="edit" data-id="${esc(entry.name)}" ${!this.canSave ? 'disabled' : ''}>Edit</button></header>`;
  }

  /**
   * @description Ask one card's probes in the viewer's session and render its body.
   * @param {object} entry - One plan entry.
   * @param {Map<string, Array<object>>} byPrefix - Jarvis tasks grouped by app-name prefix.
   * @returns {Promise<string>} The card's full HTML.
   */
  async loadCard(entry, byPrefix, responses) {
    const summaryJobs = entry.summary.map((probe) => async () => ({ probe, res: (responses ? responses.get(probe.path) : await askProbe(probe.path)) }));
    const todoJobs = entry.todos.map((todo) => async () => ({ todo, res: (responses ? responses.get(todo.path) : await askProbe(todo.path)) }));
    const [summaries, todos] = await Promise.all([
      pooled(summaryJobs, MAX_IN_FLIGHT),
      pooled(todoJobs, MAX_IN_FLIGHT),
    ]);

    const tiles = [];
    const items = [];
    let anyChecked = false;
    let summaryErrors = 0;
    for (const settled of summaries) {
      if (!settled || !settled.res?.ok) { summaryErrors++; continue; }
      const { probe, res } = settled;
      const metricPointer = probe.metricsPointer || probe.tilesPointer;
      if (metricPointer) {
        const at = atPointer(res.body, metricPointer);
        if (at.found && Array.isArray(at.value)) {
          anyChecked = true;
          if (probe.metricsPointer) tiles.push(...catalog(at.value, probe.app));
          else for (const t of at.value.slice(0, MAX_TILES)) {
            if (t && typeof t.label === 'string' && typeof t.value === 'string') tiles.push({ label: t.label.slice(0, 24), value: t.value.slice(0, 16), tone: tone(t.tone) });
          }
        } else summaryErrors++;
      }
      if (probe.itemsPointer) {
        const at = atPointer(res.body, probe.itemsPointer);
        if (at.found && Array.isArray(at.value)) {
          anyChecked = true;
          for (const it of at.value.slice(0, MAX_ITEMS)) {
            if (it && typeof it.text === 'string') {
              items.push({ metricId: typeof it.metricId === 'string' ? `${probe.app}/${it.metricId}` : undefined, text: it.text.slice(0, 120), tone: tone(it.tone), fix: (probe.surfaces || []).includes(it.fix) ? it.fix : undefined });
            }
          }
        } else summaryErrors++;
      }
    }

    // No declared summary (or it could not be read) → the app's own recent Jarvis work.
    let fallback = false;
    if (!anyChecked) {
      const rows = byPrefix.get(String(entry.displayName).toLowerCase()) || byPrefix.get(String(entry.name).toLowerCase()) || [];
      for (const row of rows.slice(0, FALLBACK_ITEMS)) {
        fallback = true;
        const when = row.created_at ? this.age(row.created_at) : '';
        items.push({ text: `${String(row.title).replace(/^[^:]{1,40}:\s+/, '')}${when}`, tone: row.status === 'error' ? 'warn' : 'neutral' });
      }
    }

    const open = [];
    let done = 0;
    let uncheckable = 0;
    for (const settled of todos) {
      if (!settled) { uncheckable++; continue; }
      const { todo, res } = settled;
      if (!res.ok) { uncheckable++; continue; }
      const at = atPointer(res.body, todo.readyPointer);
      if (!at.found || typeof at.value !== 'boolean') { uncheckable++; continue; }
      if (at.value === true) { done++; continue; }
      const detail = todo.detailPointer ? atPointer(res.body, todo.detailPointer) : { found: false };
      open.push({
        label: todo.label,
        detail: detail.found && typeof detail.value === 'string' ? detail.value : '',
        fix: todo.fix,
      });
    }

    const total = entry.todos.length;
    const data = { tiles, items, open, done, total, uncheckable, fallback, anyChecked, summaryErrors };
    this.cards?.set(entry.name, data);
    return `${this.cardHead(entry)}${this.body(data)}`;
  }

  /** Relative age for a fallback item, so a month-old task never reads like this morning's. */
  age(iso) {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (!Number.isFinite(days)) return '';
    if (days <= 0) return ' · today';
    return days === 1 ? ' · 1 day ago' : ` · ${days} days ago`;
  }

  body({ tiles, items, open, done, total, uncheckable, fallback, anyChecked, summaryErrors = 0 }) {
    const parts = [];
    if (summaryErrors) parts.push(`<p class="apps-home-notice">${summaryErrors} summary source(s) cannot be checked. Available facts are shown below.</p>`);

    if (tiles.length) {
      parts.push(`<div class="apps-home-tiles">${tiles.map((t) => `
        <div class="apps-home-tile tone-${t.tone}">
          <span class="apps-home-tile-label">${esc(t.label)}</span>
          <strong>${esc(t.value)}</strong>
        </div>`).join('')}</div>`);
    }

    if (items.length) {
      parts.push(`<ul class="apps-home-items">${items.map((i) => `
        <li class="tone-${i.tone}"><span>${esc(i.text)}</span>${
          i.fix ? `<button type="button" class="apps-home-fix" data-open="${esc(i.fix)}">Open</button>` : ''
        }</li>`).join('')}</ul>`);
    }

    if (total > 0) {
      const label = `${done} of ${total} set up`;
      parts.push(`<div class="apps-home-todos">
        <div class="apps-home-progress"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></div>
        <p class="apps-home-count">${label}${uncheckable ? ` · ${uncheckable} can't be checked` : ''}</p>
        ${open.slice(0, MAX_ITEMS).map((o) => `
          <div class="apps-home-todo">
            <div><strong>${esc(o.label)}</strong>${o.detail ? `<span>${esc(o.detail)}</span>` : ''}</div>
            ${o.fix ? `<button type="button" class="apps-home-fix" data-open="${esc(o.fix)}">Fix</button>` : ''}
          </div>`).join('')}
      </div>`);
    }

    if (!parts.length) {
      // Honest empty state: say WHICH kind of nothing this is.
      parts.push(`<p class="apps-home-quiet">${
        anyChecked || fallback ? 'Nothing to report right now.' : 'This app does not report a status yet.'
      }</p>`);
    }
    return parts.join('');
  }
}

function setHidden(values = [], id, hidden) { return hidden ? [...new Set([...values, id])] : values.filter(v => v !== id); }
function toggle(values = [], id) { return setHidden(values, id, !values.includes(id)); }
