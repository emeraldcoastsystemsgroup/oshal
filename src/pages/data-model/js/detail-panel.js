/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Detail panel for the data-model explorer: a table/view (owners, declaring files, RLS row scope, every column with its key roles, FKs out and references in) or an app (its tables, views and SQLite tables, integrations in/out by kind, kernel skills, RAG collections, routes). Built with DOM APIs and textContent only - table, column and comment text come from the database and manifests, so nothing is ever parsed as HTML.
 */

import { ownerColor, ownerLabel } from './model-index.js';

/**
 * @description Tiny element builder (textContent only; children may be nodes or strings).
 * @param {string} tag - element name
 * @param {object} [attrs] - attributes; `class` and `data-*` supported
 * @param {...(Node|string|null)} children - children
 * @returns {HTMLElement} element
 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

/**
 * @description A navigation link rendered as a button (keyboard-reachable).
 * @param {string} label - text
 * @param {Function} onClick - action
 * @param {string} [cls] - extra class
 * @returns {HTMLButtonElement} button
 */
function navLink(label, onClick, cls = '') {
  const b = h('button', { type: 'button', class: `nav-link ${cls}`.trim() }, label);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @description An owner chip that opens the owner's detail.
 * @param {string} owner - owner id
 * @param {object} actions - `{openApp}`
 * @returns {HTMLElement} chip
 */
function ownerChip(owner, actions) {
  const chip = navLink(ownerLabel(owner), () => actions.openApp(owner), 'chip');
  chip.style.setProperty('--chip', ownerColor(owner));
  return chip;
}

/**
 * @description A labelled section, omitted when it has no content.
 * @param {string} title - heading
 * @param {Node|Node[]|null} body - content
 * @returns {HTMLElement|null} section
 */
function section(title, body) {
  const items = [body].flat().filter(Boolean);
  return items.length ? h('section', { class: 'detail-section' }, h('h3', {}, title), ...items) : null;
}

/**
 * @description Key roles of one column (PK / FK / UK / owner).
 * @param {object} rel - relation
 * @param {string} col - column name
 * @returns {string} roles
 */
function columnRoles(rel, col) {
  const roles = [];
  if (rel.primaryKey.includes(col)) roles.push('PK');
  if (rel.foreignKeys.some((f) => f.columns.includes(col))) roles.push('FK');
  if (rel.uniques.some((u) => u.length === 1 && u[0] === col)) roles.push('UK');
  if (rel.access && rel.access.ownerColumns.includes(col)) roles.push('owner');
  return roles.join(' ');
}

/**
 * @description The columns table for a relation.
 * @param {object} rel - relation
 * @returns {HTMLTableElement} table
 */
function columnsTable(rel) {
  const head = h('tr', {}, h('th', {}, 'Column'), h('th', {}, 'Type'), h('th', {}, 'Null'), h('th', {}, 'Default'), h('th', {}, 'Keys'));
  const rows = rel.columns.map((c) => h('tr', {}, h('td', { class: 'mono' }, c.name), h('td', { class: 'mono' }, c.type),
    h('td', {}, c.nullable ? 'yes' : 'no'), h('td', { class: 'mono' }, c.default || ''), h('td', {}, columnRoles(rel, c.name))));
  return h('div', { class: 'table-scroll' }, h('table', { class: 'columns' }, h('thead', {}, head), h('tbody', {}, ...rows)));
}

/**
 * @description Render a table or view.
 * @param {HTMLElement} el - container
 * @param {object} rel - relation
 * @param {object} index - model index
 * @param {object} actions - navigation actions
 * @returns {void}
 */
function renderRelation(el, rel, index, actions) {
  const badges = [rel.kind, rel.database, rel.access ? `RLS ${rel.access.state}` : null, rel.owners.length > 1 ? 'shared' : null, rel.owners.length ? null : 'unowned']
    .filter(Boolean).map((b) => h('span', { class: `badge badge--${String(b).split(' ')[0]}` }, b));
  const out = (index.fkOut.get(rel.name) || []).map((l) => h('li', {}, `${l.columns.join(', ')} → `, navLink(l.refTable, () => actions.openTable(l.refTable))));
  const inbound = (index.fkIn.get(rel.name) || []).map((l) => h('li', {}, navLink(l.table, () => actions.openTable(l.table)), ` (${l.columns.join(', ')})`));
  const files = Object.entries(rel.definers || {}).map(([owner, list]) => h('li', {}, h('strong', {}, `${ownerLabel(owner)}: `), list.join(', ')));
  el.replaceChildren(
    h('header', { class: 'detail-head' }, h('h2', { class: 'mono' }, rel.name), h('div', { class: 'badges' }, ...badges)),
    rel.comment ? h('p', { class: 'muted' }, rel.comment) : null,
    h('div', { class: 'detail-actions' }, navLink('Show FK neighbourhood', () => actions.focusTable(rel.name), 'primary')),
    section('Owners', rel.owners.length ? h('div', { class: 'chips' }, ...rel.owners.map((o) => ownerChip(o, actions))) : h('p', { class: 'muted' }, 'No scanned source declares this relation.')),
    section('Row access', rel.access && rel.access.scopes.length ? h('ul', {}, ...rel.access.scopes.map((s) => h('li', {}, s))) : null),
    section('Defined in', files.length ? h('ul', { class: 'mono small' }, ...files) : null),
    section(`Columns (${rel.columns.length})`, columnsTable(rel)),
    section('References', out.length ? h('ul', {}, ...out) : null),
    section('Referenced by', inbound.length ? h('ul', {}, ...inbound) : null),
  );
}

/**
 * @description Integration lines touching one app, grouped by direction.
 * @param {object} index - model index
 * @param {string} name - app name
 * @param {object} actions - navigation actions
 * @returns {{outbound: HTMLElement[], inbound: HTMLElement[]}} list items
 */
function integrationItems(index, name, actions) {
  const item = (other, e) => h('li', {}, h('span', { class: `kind kind--${e.kind}` }, e.kind), ' ', navLink(ownerLabel(other), () => actions.openApp(other)), h('span', { class: 'muted' }, ` ${e.label}`));
  const edges = index.snap.integrations;
  return {
    outbound: edges.filter((e) => e.from === name).map((e) => item(e.to, e)),
    inbound: edges.filter((e) => e.to === name).map((e) => item(e.from, e)),
  };
}

/**
 * @description Render an app (or core).
 * @param {HTMLElement} el - container
 * @param {object} app - app node
 * @param {object} index - model index
 * @param {object} actions - navigation actions
 * @returns {void}
 */
function renderApp(el, app, index, actions) {
  const { outbound, inbound } = integrationItems(index, app.name, actions);
  const tableLinks = (names) => (names.length ? h('div', { class: 'link-list' }, ...names.map((n) => navLink(n, () => actions.openTable(n), 'mono'))) : null);
  const meta = [app.kind, app.status, app.version && `v${app.version}`, app.suite].filter(Boolean).map((m) => h('span', { class: 'badge' }, m));
  el.replaceChildren(
    h('header', { class: 'detail-head' }, h('h2', {}, app.displayName), h('p', { class: 'mono muted' }, ownerLabel(app.name)), h('div', { class: 'badges' }, ...meta)),
    h('div', { class: 'detail-actions' }, navLink('Show its tables', () => actions.showAppTables(app.name), 'primary')),
    section(`Tables (${app.tables.length})`, tableLinks(app.tables)),
    section(`Views (${app.views.length})`, tableLinks(app.views)),
    section(`SQLite tables (${app.sqliteTables.length})`, app.sqliteTables.length ? h('p', { class: 'mono small' }, app.sqliteTables.join(', ')) : null),
    section('Integrations out', outbound.length ? h('ul', {}, ...outbound) : null),
    section('Integrations in', inbound.length ? h('ul', {}, ...inbound) : null),
    section('Kernel skills (uses)', app.uses.length ? h('p', { class: 'mono small' }, app.uses.join(', ')) : null),
    section('RAG collections', app.ragCollections.length ? h('p', { class: 'mono small' }, app.ragCollections.join(', ')) : null),
    section('Routes', app.routes.length ? h('p', { class: 'mono small' }, app.routes.join(', ')) : null),
  );
}

/**
 * @description Render the current selection, or a prompt when nothing is selected.
 * @param {HTMLElement} el - container
 * @param {{type: string, name: string}|null} selection - what is selected
 * @param {object} index - model index
 * @param {object} actions - `{openTable, openApp, focusTable, showAppTables}`
 * @returns {void}
 */
export function renderDetail(el, selection, index, actions) {
  if (selection && selection.type === 'app' && index.apps.has(selection.name)) return renderApp(el, index.apps.get(selection.name), index, actions);
  if (selection && index.relations.has(selection.name)) return renderRelation(el, index.relations.get(selection.name), index, actions);
  el.replaceChildren(h('p', { class: 'muted' }, 'Select a node, a search result or a list entry to see its details.'));
  return undefined;
}
