/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | List views for the data-model explorer: "Shared objects" (tables more than one owner declares, and foreign keys that cross an owner boundary) and "Other stores" (the time-series catalog, SQLite tables parsed from source, declared-but-absent tables, unowned relations, and the ArangoDB / ChromaDB / Redis inventories). textContent only.
 */

import { h } from './detail-panel.js';
import { ownerLabel, sharedObjects } from './model-index.js';

/**
 * @description A clickable relation name.
 * @param {string} name - relation
 * @param {object} actions - `{openTable}`
 * @returns {HTMLButtonElement} link
 */
function relLink(name, actions) {
  const b = h('button', { type: 'button', class: 'nav-link mono' }, name);
  b.addEventListener('click', () => actions.openTable(name));
  return b;
}

/**
 * @description A store card.
 * @param {string} title - heading
 * @param {string} status - ok | not-configured | unreachable | info
 * @param {string} detail - summary line
 * @param {...Node} body - content
 * @returns {HTMLElement} card
 */
function card(title, status, detail, ...body) {
  return h('article', { class: `store-card store-card--${status}` }, h('header', {}, h('h3', {}, title), h('span', { class: `badge badge--${status}` }, status)), h('p', { class: 'muted' }, detail), ...body);
}

/**
 * @description Render the shared-objects list.
 * @param {HTMLElement} el - container
 * @param {object} snap - snapshot
 * @param {object} actions - navigation actions
 * @returns {void}
 */
export function renderSharedList(el, snap, actions) {
  const { sharedTables, crossFks } = sharedObjects(snap);
  const shared = sharedTables.map((t) => h('li', {}, relLink(t.name, actions), h('span', { class: 'muted' }, ` declared by ${t.owners.map(ownerLabel).join(', ')}`)));
  const fks = crossFks.map((f) => h('li', {}, relLink(f.table, actions), ` (${f.columns.join(', ')}) → `, relLink(f.refTable, actions),
    h('span', { class: 'muted' }, ` ${f.from.map(ownerLabel).join('/')} → ${f.to.map(ownerLabel).join('/')}`)));
  el.replaceChildren(
    h('h2', {}, 'Shared objects'),
    h('p', { class: 'muted' }, 'The graph shows owners joined by shared tables and by foreign keys that cross an owner boundary. Integration declarations are on the Apps view.'),
    h('h3', {}, `Tables declared by more than one owner (${shared.length})`),
    shared.length ? h('ul', {}, ...shared) : h('p', { class: 'muted' }, 'None.'),
    h('h3', {}, `Foreign keys across owners (${fks.length})`),
    fks.length ? h('ul', {}, ...fks) : h('p', { class: 'muted' }, 'None.'),
  );
}

/**
 * @description Card for a parsed declaration list (SQLite or declared-but-absent).
 * @param {string} title - heading
 * @param {string} detail - explanation
 * @param {object[]} rels - DeclaredRelation list
 * @returns {HTMLElement} card
 */
function declaredCard(title, detail, rels) {
  const rows = rels.map((r) => h('details', {}, h('summary', {}, h('span', { class: 'mono' }, r.name), h('span', { class: 'muted' }, ` ${ownerLabel(r.owner)} · ${r.files.join(', ')}`)),
    h('p', { class: 'mono small' }, r.columns.map((c) => `${c.name} ${c.type}`).join(' · '))));
  return card(title, 'info', detail, ...(rows.length ? rows : [h('p', { class: 'muted' }, 'None.')]));
}

/**
 * @description Card for a store inventory from /api/admin/data-model/stores.
 * @param {object} inv - StoreInventory
 * @returns {HTMLElement} card
 */
function inventoryCard(inv) {
  const body = [];
  for (const db of inv.databases || []) body.push(h('details', {}, h('summary', {}, h('span', { class: 'mono' }, db.name), h('span', { class: 'muted' }, ` ${db.collections.length} collections`)), h('p', { class: 'mono small' }, db.collections.map((c) => `${c.name}: ${c.count ?? '?'}`).join(' · '))));
  if (inv.collections) body.push(h('ul', { class: 'mono small' }, ...inv.collections.map((c) => h('li', {}, `${c.name}: ${c.count ?? '?'}`))));
  if (inv.families) body.push(h('ul', { class: 'mono small' }, ...inv.families.map((f) => h('li', {}, `${f.prefix}  ${f.keys} keys  (${Object.entries(f.types).map(([t, n]) => `${t}×${n}`).join(', ')})`))));
  return card(`${inv.engine} (${inv.store})`, inv.status, inv.detail, ...body);
}

/**
 * @description Render the other-stores view.
 * @param {HTMLElement} el - container
 * @param {object} snap - snapshot
 * @param {object[]|null} stores - store inventories, null while loading
 * @param {object} actions - navigation actions
 * @returns {void}
 */
export function renderStores(el, snap, stores, actions) {
  const ts = [...snap.tables, ...snap.views].filter((r) => r.database !== snap.database);
  const tsCard = card('Other Postgres databases', ts.length ? 'ok' : 'info', ts.length ? `${ts.length} relations outside ${snap.database} (e.g. the TimescaleDB store).` : 'No other Postgres database is configured.',
    h('div', { class: 'link-list' }, ...ts.map((r) => relLink(r.name, actions))));
  const unowned = card('Unowned live relations', snap.unowned.length ? 'unreachable' : 'ok', snap.unowned.length ? 'Live in a database, but no scanned source declares them.' : 'Every live relation is declared by core or an installed app.',
    ...(snap.unowned.length ? [h('p', { class: 'mono small' }, snap.unowned.join(', '))] : []));
  el.replaceChildren(
    h('h2', {}, 'Other stores'),
    h('div', { class: 'store-grid' },
      tsCard,
      ...(stores ? stores.map(inventoryCard) : [card('Graph, vector and cache stores', 'info', 'Loading…')]),
      declaredCard('SQLite tables', 'Declared against a SQLite driver; columns parsed from the statement as written.', snap.sqlite),
      declaredCard('Declared, not present', 'A CREATE TABLE exists in source but the table is not in any reference database.', snap.declaredAbsent),
      unowned),
  );
}
