/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Data-model explorer page orchestration: loads the operator-only snapshot, drives the four views (apps & integrations, tables, shared objects, other stores), search, filters and the detail panel, and keeps the URL (?view=&app=&table=&focus=&depth=&q=) authoritative so any view is bookmarkable. Re-lays out the graph only when its scope changes; a selection change is a highlight, not a redraw.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the view on screen - Mermaid, SVG or scoped JSON - from the snapshot already in the page, so a scope can reach an ADR or a PR without a screenshot and without a second server call. A refusal names its reason instead of writing an unusable file.
 */

import { indexSnapshot, appGraph, tableGraph, parseViewState, serializeViewState, searchModel, ownerLabel, CORE_OWNER } from './model-index.js';
import { toMermaid, toScopedJson, serializeGraphSvg, exportFilename, downloadText } from './export-view.js';
import { layoutGraph } from './layout.js';
import { createGraphView } from './graph-view.js';
import { renderDetail, h } from './detail-panel.js';
import { renderSharedList, renderStores } from './lists-view.js';
import { createUiLogger, serializeUiError } from '../../shared/ui-debug.js';

const logger = createUiLogger('data-model');
const API = '/api/admin/data-model';
const $ = (id) => document.getElementById(id);
const els = {
  banner: $('banner'), tabs: [...document.querySelectorAll('[data-view]')], svg: $('graph'), listArea: $('listArea'),
  detail: $('detail'), sideList: $('sideList'), stats: $('stats'), search: $('search'), results: $('results'),
  refresh: $('refresh'), fit: $('fit'), owner: $('ownerSelect'), depth: $('depthSelect'), isolated: $('showIsolated'),
  kinds: [...document.querySelectorAll('[data-kind]')], appsControls: $('appsControls'), tablesControls: $('tablesControls'),
  exportBtn: $('exportBtn'), exportMenu: $('exportMenu'), exportNote: $('exportNote'), exportPreview: $('exportPreview'),
  exportItems: [...document.querySelectorAll('[data-export]')],
};
const app = { state: parseViewState(window.location.search), model: null, stores: null, drawnKey: '' };

/**
 * @description Show a status line (loading, error, access explanation); empty text hides it.
 * @param {string} text - message
 * @param {string} [tone] - info | error
 * @returns {void}
 */
function setBanner(text, tone = 'info') {
  els.banner.textContent = text;
  els.banner.dataset.tone = tone;
  els.banner.hidden = !text;
}

/** Write the current state to the URL without adding a history entry. */
const syncUrl = () => window.history.replaceState(null, '', serializeViewState(app.state));

/** Which link kinds the Apps view currently shows. */
const checkedKinds = () => els.kinds.filter((k) => k.checked).map((k) => k.dataset.kind);

/**
 * @description The graph for the current view, and a key that changes only when its scope does.
 * @returns {{graph: object, key: string}} graph and scope key
 */
function currentGraph() {
  const { state, model } = app;
  if (state.view === 'tables') {
    const owner = state.app || CORE_OWNER;
    return { graph: tableGraph(model, { owner, focus: state.focus, depth: state.depth }), key: `tables|${owner}|${state.focus}|${state.depth}` };
  }
  if (state.view === 'shared') return { graph: appGraph(model.snap, { kinds: ['shared-table', 'foreign-key'] }), key: 'shared' };
  const kinds = checkedKinds();
  return { graph: appGraph(model.snap, { showIsolated: els.isolated.checked, kinds }), key: `apps|${els.isolated.checked}|${kinds.join(',')}` };
}

/**
 * @description The id to highlight in the graph for the current selection.
 * @returns {string|null} node id
 */
function selectedId() {
  const { state } = app;
  if (state.view === 'tables') return state.table || null;
  return state.app || null;
}

/**
 * @description Draw the graph (or the stores list) for the current view.
 * @returns {void}
 */
function draw() {
  const stores = app.state.view === 'stores';
  els.svg.hidden = stores; els.fit.hidden = stores; els.listArea.hidden = !stores;
  if (stores) { renderStores(els.listArea, app.model.snap, app.stores, actions); return; }
  const { graph, key } = currentGraph();
  if (key !== app.drawnKey) {
    app.view.render(graph, layoutGraph(graph.nodes, graph.edges, { width: 1200, height: 800 }));
    app.view.fit();
    app.drawnKey = key;
  }
  app.view.highlight(selectedId());
}

/**
 * @description Side panel: stats for Apps, the shared list for Shared, scope text for Tables.
 * @returns {void}
 */
function renderSide() {
  const { state, model } = app;
  els.appsControls.hidden = state.view !== 'apps';
  els.tablesControls.hidden = state.view !== 'tables';
  if (state.view === 'shared') { renderSharedList(els.sideList, model.snap, actions); return; }
  if (state.view === 'tables') {
    const scope = state.focus ? `FK neighbourhood of ${state.focus}, ${state.depth} hop${state.depth > 1 ? 's' : ''}.` : `Relations declared by ${ownerLabel(state.app || CORE_OWNER)}; tables their foreign keys reach are drawn hollow.`;
    els.sideList.replaceChildren(h('p', { class: 'muted' }, scope), h('p', { class: 'muted' }, 'Double-click a table to walk its foreign keys.'));
    return;
  }
  els.sideList.replaceChildren(h('p', { class: 'muted' }, 'Double-click an app to open its tables. Edge colours show why two owners are connected.'));
}

/**
 * @description Re-render everything that depends on state; sync controls and the URL.
 * @returns {void}
 */
function render() {
  if (!app.model) return;
  els.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === app.state.view)));
  els.owner.value = app.state.app || CORE_OWNER;
  els.depth.value = String(app.state.depth);
  renderSide();
  draw();
  const s = app.state;
  const selection = s.table ? { type: 'table', name: s.table } : s.app ? { type: 'app', name: s.app } : null;
  renderDetail(els.detail, selection, app.model, actions);
  syncUrl();
}

/** Navigation actions shared by the graph, detail panel, lists and search. */
const actions = {
  openTable(name) {
    const rel = app.model.relations.get(name);
    if (app.state.view !== 'tables') Object.assign(app.state, { view: 'tables', focus: '', app: rel && rel.owners[0] ? rel.owners[0] : CORE_OWNER });
    app.state.table = name;
    render();
  },
  openApp(name) { Object.assign(app.state, { app: name, table: '' }); if (app.state.view === 'tables') app.state.focus = ''; render(); },
  focusTable(name) { Object.assign(app.state, { view: 'tables', focus: name, table: name }); render(); },
  showAppTables(name) { Object.assign(app.state, { view: 'tables', app: name, focus: '', table: '' }); render(); },
};

/** Graph callbacks: select on click, open on double-click, clear on empty-canvas click. */
const graphHandlers = {
  onSelect(node) {
    if (node.type === 'table' || node.type === 'view') app.state.table = node.id;
    else Object.assign(app.state, { app: node.id, table: '' });
    render();
  },
  onOpen(node) { if (node.type === 'table' || node.type === 'view') actions.focusTable(node.id); else actions.showAppTables(node.id); },
  onBackground() { app.state.table = ''; if (app.state.view !== 'tables') app.state.app = ''; render(); },
};

/**
 * @description Fill the owner selector with core plus every app that owns a relation.
 * @returns {void}
 */
function fillOwners() {
  const owners = app.model.snap.apps.filter((a) => a.name === CORE_OWNER || a.tables.length || a.views.length);
  els.owner.replaceChildren(...owners.map((a) => h('option', { value: a.name }, `${ownerLabel(a.name)} (${a.tables.length + a.views.length})`)));
}

/**
 * @description Render search results for the current query.
 * @returns {void}
 */
function renderResults() {
  app.state.q = els.search.value;
  const results = searchModel(app.model, app.state.q);
  els.results.hidden = !results.length;
  els.results.replaceChildren(...results.map((r) => {
    const b = h('button', { type: 'button', class: 'result' }, h('span', { class: `kind kind--${r.type}` }, r.type), ' ', h('span', { class: 'mono' }, ownerLabel(r.name)), h('span', { class: 'muted' }, ` ${r.detail}`));
    b.addEventListener('click', () => { els.results.hidden = true; if (r.type === 'app') actions.openApp(r.name); else actions.openTable(r.name); });
    return b;
  }));
  syncUrl();
}

/**
 * @description Explain a failed load in words the reader can act on.
 * @param {number} status - HTTP status
 * @returns {string} message
 */
function failureText(status) {
  if (status === 401) return 'Your session has ended. Sign in again to use the data-model explorer.';
  if (status === 403) return 'The data-model explorer is operator-only: it lists every installed app\'s tables and row-level-security rules. Ask an operator for access.';
  if (status === 503) return 'The platform database is not configured in this process.';
  return `The data model could not be read (HTTP ${status}). The server log has the detail.`;
}

/**
 * @description Load the snapshot (and, in the background, the store inventories).
 * @param {boolean} refresh - bypass the server cache
 * @returns {Promise<void>}
 */
async function load(refresh) {
  setBanner(refresh ? 'Rebuilding the data model…' : 'Reading the data model…');
  const res = await fetch(`${API}${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) { logger.warn('data-model snapshot request failed', { status: res.status }); setBanner(failureText(res.status), 'error'); return; }
  app.model = indexSnapshot(await res.json());
  app.drawnKey = '';
  fillOwners();
  const snap = app.model.snap;
  els.stats.textContent = `${snap.tables.length} tables · ${snap.views.length} views · ${snap.apps.length - 1} apps · ${snap.integrations.length} links · ${snap.unowned.length} unowned · built ${new Date(snap.generatedAt).toLocaleString()}`;
  setBanner('');
  render();
  const storesRes = await fetch(`${API}/stores${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!storesRes.ok) logger.warn('data-model store inventory request failed', { status: storesRes.status });
  app.stores = storesRes.ok ? await storesRes.json() : [{ store: 'cache', engine: 'Store inventory', status: 'unreachable', detail: failureText(storesRes.status) }];
  if (app.state.view === 'stores') render();
}

/**
 * @description Report what an export did, or why it did nothing, inside the export menu.
 * @param {string} text - message
 * @param {string} [tone] - info | error
 * @returns {void}
 */
function setExportNote(text, tone = 'info') {
  els.exportNote.textContent = text;
  els.exportNote.dataset.tone = tone;
  els.exportNote.hidden = !text;
}

/**
 * @description The graph behind the current view, or null on a view that draws none.
 * @returns {object|null} graph
 */
function exportGraph() {
  return app.state.view === 'stores' ? null : currentGraph().graph;
}

/**
 * @description Copy the Mermaid block for the current view, and show it too: a browser that
 * refuses clipboard access still leaves the text selectable rather than failing silently.
 * @returns {Promise<void>}
 */
async function exportMermaid() {
  const text = toMermaid(app.model, app.state, exportGraph());
  els.exportPreview.textContent = text;
  els.exportPreview.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    setExportNote(`Copied ${text.split('\n').length} lines of Mermaid to the clipboard.`);
  } catch (err) {
    logger.warn('data-model mermaid clipboard copy refused', { error: serializeUiError(err) });
    setExportNote('The clipboard is blocked in this browser - select the block below and copy it.');
  }
}

/**
 * @description Export the current view in one format, entirely from the snapshot already loaded.
 * @param {string} format - mermaid | svg | json
 * @returns {Promise<void>}
 */
async function runExport(format) {
  if (!app.model) { setExportNote('The data model has not loaded, so there is nothing to export.', 'error'); return; }
  try {
    if (format === 'mermaid') { await exportMermaid(); return; }
    if (format === 'svg') {
      downloadText(exportFilename(app.state, 'svg'), 'image/svg+xml', serializeGraphSvg(els.svg, `oshal data model - ${app.state.view}`));
    } else {
      downloadText(exportFilename(app.state, 'json'), 'application/json', JSON.stringify(toScopedJson(app.model, app.state, exportGraph(), app.stores), null, 2));
    }
    setExportNote(`Downloaded ${exportFilename(app.state, format === 'svg' ? 'svg' : 'json')}.`);
  } catch (err) {
    logger.error('data-model export failed', { format, view: app.state.view, error: serializeUiError(err) });
    setExportNote(err.message, 'error');
  }
}

/**
 * @description Wire the export menu: open/close, and one handler per format.
 * @returns {void}
 */
function wireExport() {
  const close = () => { els.exportMenu.hidden = true; els.exportBtn.setAttribute('aria-expanded', 'false'); };
  els.exportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const open = els.exportMenu.hidden;
    els.exportMenu.hidden = !open;
    els.exportBtn.setAttribute('aria-expanded', String(open));
    if (open) { setExportNote(''); els.exportPreview.hidden = true; }
  });
  els.exportMenu.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  els.exportItems.forEach((b) => b.addEventListener('click', () => {
    runExport(b.dataset.export).catch((err) => logger.error('data-model export handler failed', { error: serializeUiError(err) }));
  }));
}

/**
 * @description Wire tabs, controls and search.
 * @returns {void}
 */
function wireControls() {
  els.tabs.forEach((t) => t.addEventListener('click', () => { app.state.view = t.dataset.view; render(); }));
  els.refresh.addEventListener('click', () => { load(true).catch((err) => { logger.error('data-model refresh failed', { error: serializeUiError(err) }); setBanner(`Refresh failed: ${err.message}`, 'error'); }); });
  els.fit.addEventListener('click', () => app.view.fit());
  els.owner.addEventListener('change', () => actions.showAppTables(els.owner.value));
  els.depth.addEventListener('change', () => { app.state.depth = Number(els.depth.value); render(); });
  els.isolated.addEventListener('change', render);
  els.kinds.forEach((k) => k.addEventListener('change', render));
  let timer;
  els.search.value = app.state.q;
  els.search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderResults, 150); });
  els.search.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { els.results.hidden = true; } });
}

app.view = createGraphView(els.svg, graphHandlers);
wireControls();
wireExport();
load(false).catch((err) => { logger.error('data-model bootstrap failed', { error: serializeUiError(err) }); setBanner(`The data model could not be read: ${err.message}`, 'error'); });
