/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145 D9: the cross-app Home view. One card per installed group/app showing what happened (the app's own summary probe, or its jarvis_tasks when it declares none) and what still needs you (its readiness probes). Every probe is asked HERE, in the signed-in user's own session — core never impersonates the caller and never reads an app's tables.
 */

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
    container.innerHTML = `
      <div class="apps-home">
        <header class="apps-home-head">
          <h2>Home</h2>
          <p>What is going on across your applications, and what still needs you.</p>
          <button type="button" id="appsHomeRefresh">Refresh</button>
        </header>
        <div class="apps-home-grid" id="appsHomeGrid">
          <p class="apps-home-loading">Loading your applications…</p>
        </div>
      </div>`;
    container.querySelector('#appsHomeRefresh')?.addEventListener('click', () => { void this.render(container); });
    const grid = container.querySelector('#appsHomeGrid');

    const plan = await askProbe('/api/swarm/apps/home-plan');
    const entries = plan.ok && Array.isArray(plan.body?.apps) ? plan.body.apps : [];
    if (!entries.length) {
      grid.innerHTML = `<p class="apps-home-loading">No installed applications reported anything.${
        plan.ok ? '' : ' The application list could not be read.'}</p>`;
      return;
    }
    this.entries = entries;

    // The fallback source is ONE session-scoped read, shared by every card (core #305 titles).
    const tasks = await askProbe('/api/jarvis/tasks');
    const byPrefix = groupTasksByAppPrefix(tasks.ok ? (tasks.body?.tasks || tasks.body || []) : []);

    // Sectioned by ADR-097 suite — the sidebar's own shelves, rendered as tiles.
    grid.innerHTML = sectionBySuite(entries).map((shelf) => `
      <section class="apps-home-shelf">
        <h3 class="apps-home-shelf-label">${esc(shelf.label)}</h3>
        <div class="apps-home-tiles-grid">${shelf.entries.map((e) => this.skeleton(e)).join('')}</div>
      </section>`).join('');
    grid.addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-open]');
      if (target) this.navigateToView(`tool-${target.getAttribute('data-open')}`);
    });

    const jobs = entries.map((entry) => async () => {
      const card = await this.loadCard(entry, byPrefix);
      const host = grid.querySelector(`[data-card="${CSS.escape(entry.name)}"]`);
      if (host) host.innerHTML = card;
    });
    await pooled(jobs, MAX_IN_FLIGHT);
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
      <h3>${esc(entry.displayName)}</h3>${badge}${open}</header>`;
  }

  /**
   * @description Ask one card's probes in the viewer's session and render its body.
   * @param {object} entry - One plan entry.
   * @param {Map<string, Array<object>>} byPrefix - Jarvis tasks grouped by app-name prefix.
   * @returns {Promise<string>} The card's full HTML.
   */
  async loadCard(entry, byPrefix) {
    const summaryJobs = entry.summary.map((probe) => async () => ({ probe, res: await askProbe(probe.path) }));
    const todoJobs = entry.todos.map((todo) => async () => ({ todo, res: await askProbe(todo.path) }));
    const [summaries, todos] = await Promise.all([
      pooled(summaryJobs, MAX_IN_FLIGHT),
      pooled(todoJobs, MAX_IN_FLIGHT),
    ]);

    const tiles = [];
    const items = [];
    let anyChecked = false;
    for (const settled of summaries) {
      if (!settled || !settled.res.ok) continue;
      const { probe, res } = settled;
      if (probe.tilesPointer) {
        const at = atPointer(res.body, probe.tilesPointer);
        if (at.found && Array.isArray(at.value)) {
          anyChecked = true;
          for (const t of at.value.slice(0, MAX_TILES)) {
            if (t && typeof t.label === 'string' && typeof t.value === 'string') {
              tiles.push({ label: t.label, value: t.value, tone: tone(t.tone) });
            }
          }
        }
      }
      if (probe.itemsPointer) {
        const at = atPointer(res.body, probe.itemsPointer);
        if (at.found && Array.isArray(at.value)) {
          anyChecked = true;
          for (const it of at.value.slice(0, MAX_ITEMS)) {
            if (it && typeof it.text === 'string') {
              items.push({ text: it.text, tone: tone(it.tone), fix: typeof it.fix === 'string' ? it.fix : undefined });
            }
          }
        }
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
    return `${this.cardHead(entry)}${this.body({ tiles, items, open, done, total, uncheckable, fallback, anyChecked })}`;
  }

  /** Relative age for a fallback item, so a month-old task never reads like this morning's. */
  age(iso) {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (!Number.isFinite(days)) return '';
    if (days <= 0) return ' · today';
    return days === 1 ? ' · 1 day ago' : ` · ${days} days ago`;
  }

  body({ tiles, items, open, done, total, uncheckable, fallback, anyChecked }) {
    const parts = [];

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
