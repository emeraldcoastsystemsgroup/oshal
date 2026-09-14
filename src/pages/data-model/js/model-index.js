/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pure model for the data-model explorer page: indexes the snapshot, builds the app-integration graph and the table graph (an owner's tables, or a table's FK neighbourhood), lists shared objects, searches, and round-trips view state through the URL. No DOM - tests/unit/data-model-page-model.spec.ts imports it directly.
 */

export const CORE_OWNER = '@core';
export const VIEWS = ['apps', 'tables', 'shared', 'stores'];
export const EDGE_KINDS = ['context-offer', 'artifact', 'dependency', 'group-member', 'shared-table', 'foreign-key'];

/**
 * @description Stable colour per owner (core fixed; apps hashed onto the hue wheel).
 * @param {string} owner - owner id
 * @returns {string} an hsl() colour
 */
export function ownerColor(owner) {
  if (owner === CORE_OWNER) return 'hsl(212 70% 58%)';
  if (!owner) return 'hsl(0 0% 55%)';
  let h = 0;
  for (const ch of owner) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 56%)`;
}

/**
 * @description Label for an owner id.
 * @param {string} owner - owner id
 * @returns {string} display label
 */
export function ownerLabel(owner) {
  return owner === CORE_OWNER ? 'core' : owner || 'unowned';
}

/**
 * @description Index a snapshot for fast lookups: relations by name, apps by name, FK adjacency.
 * @param {object} snap - the /api/admin/data-model payload
 * @returns {object} index
 */
export function indexSnapshot(snap) {
  const relations = new Map();
  for (const r of [...snap.tables, ...snap.views]) relations.set(r.name, r);
  const apps = new Map(snap.apps.map((a) => [a.name, a]));
  const fkOut = new Map();
  const fkIn = new Map();
  for (const t of snap.tables) {
    for (const fk of t.foreignKeys) {
      const link = { table: t.name, columns: fk.columns, refTable: fk.refTable, refColumns: fk.refColumns };
      if (!fkOut.has(t.name)) fkOut.set(t.name, []);
      fkOut.get(t.name).push(link);
      if (!fkIn.has(fk.refTable)) fkIn.set(fk.refTable, []);
      fkIn.get(fk.refTable).push(link);
    }
  }
  return { snap, relations, apps, fkOut, fkIn };
}

/**
 * @description The app-integration graph: owners as nodes, declared/database links as edges.
 * @param {object} snap - snapshot
 * @param {{showIsolated?: boolean, kinds?: string[]}} [opts] - filters
 * @returns {{nodes: object[], edges: object[]}} graph
 */
export function appGraph(snap, opts = {}) {
  const kinds = new Set(opts.kinds || EDGE_KINDS);
  const edges = snap.integrations.filter((e) => kinds.has(e.kind))
    .map((e) => ({ source: e.from, target: e.to, kind: e.kind, label: e.label }));
  const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
  const nodes = snap.apps
    .filter((a) => opts.showIsolated || linked.has(a.name) || a.tables.length || a.name === CORE_OWNER)
    .map((a) => ({ id: a.name, label: a.name === CORE_OWNER ? 'core' : a.name, type: a.kind, owner: a.name, size: Math.min(28, 8 + Math.sqrt(a.tables.length) * 2.2) }));
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

/**
 * @description Breadth-first FK neighbourhood of a table (both directions).
 * @param {object} index - from indexSnapshot
 * @param {string} focus - table name
 * @param {number} depth - hops
 * @returns {Set<string>} table names within `depth` hops, focus included
 */
export function neighbourhood(index, focus, depth) {
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth; d += 1) {
    const next = [];
    for (const name of frontier) {
      const links = [...(index.fkOut.get(name) || []).map((l) => l.refTable), ...(index.fkIn.get(name) || []).map((l) => l.table)];
      for (const n of links) if (!seen.has(n)) { seen.add(n); next.push(n); }
    }
    frontier = next;
  }
  return seen;
}

/**
 * @description The table graph: a table's FK neighbourhood (when `focus` is set) or one owner's
 * relations plus the tables their FKs reach (drawn as external).
 * @param {object} index - from indexSnapshot
 * @param {{owner?: string, focus?: string, depth?: number}} scope - what to draw
 * @returns {{nodes: object[], edges: object[]}} graph
 */
export function tableGraph(index, scope) {
  let names;
  if (scope.focus && index.relations.has(scope.focus)) names = neighbourhood(index, scope.focus, scope.depth || 1);
  else {
    const owner = scope.owner || CORE_OWNER;
    names = new Set([...index.relations.values()].filter((r) => r.owners.includes(owner)).map((r) => r.name));
    for (const n of [...names]) for (const l of index.fkOut.get(n) || []) names.add(l.refTable);
  }
  const home = scope.focus ? null : (scope.owner || CORE_OWNER);
  const nodes = [...names].filter((n) => index.relations.has(n)).map((n) => {
    const r = index.relations.get(n);
    return { id: n, label: n, type: r.kind, owner: r.owners[0] || '', shared: r.owners.length > 1, external: home !== null && !r.owners.includes(home), size: Math.min(18, 6 + Math.sqrt(r.columns.length) * 1.6) };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const n of ids) for (const l of index.fkOut.get(n) || []) if (ids.has(l.refTable)) edges.push({ source: n, target: l.refTable, kind: 'foreign-key', label: l.columns.join(', ') });
  return { nodes, edges };
}

/**
 * @description Objects that span owners: tables more than one owner declares, and FKs crossing an
 * owner boundary.
 * @param {object} snap - snapshot
 * @returns {{sharedTables: object[], crossFks: object[]}} lists
 */
export function sharedObjects(snap) {
  const ownersOf = new Map(snap.tables.map((t) => [t.name, t.owners]));
  const sharedTables = snap.tables.filter((t) => t.owners.length > 1).map((t) => ({ name: t.name, owners: t.owners }));
  const crossFks = [];
  for (const t of snap.tables) {
    for (const fk of t.foreignKeys) {
      const parents = ownersOf.get(fk.refTable) || [];
      if (t.owners.length && parents.length && !t.owners.some((o) => parents.includes(o))) {
        crossFks.push({ table: t.name, columns: fk.columns, refTable: fk.refTable, from: t.owners, to: parents });
      }
    }
  }
  return { sharedTables, crossFks };
}

/**
 * @description Search relations, columns and apps by substring (case-insensitive).
 * @param {object} index - from indexSnapshot
 * @param {string} q - query
 * @param {number} [limit] - max results
 * @returns {object[]} results `{type, name, detail}`
 */
export function searchModel(index, q, limit = 40) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const a of index.apps.values()) if (a.name.toLowerCase().includes(needle) || String(a.displayName).toLowerCase().includes(needle)) out.push({ type: 'app', name: a.name, detail: `${a.tables.length} tables` });
  for (const r of index.relations.values()) {
    if (r.name.includes(needle)) out.push({ type: r.kind, name: r.name, detail: r.owners.map(ownerLabel).join(', ') || 'unowned' });
    else {
      const col = r.columns.find((c) => c.name.toLowerCase().includes(needle));
      if (col) out.push({ type: r.kind, name: r.name, detail: `column ${col.name}` });
    }
  }
  return out.slice(0, limit);
}

/**
 * @description Read view state from a URL query string. `focus` draws a table's FK
 * neighbourhood `depth` hops out (1-3) instead of an owner's tables.
 * @param {string} search - e.g. `?view=tables&app=career-hunter&table=career_postings`
 * @returns {{view: string, app: string, table: string, focus: string, depth: number, q: string}} state
 */
export function parseViewState(search) {
  const p = new URLSearchParams(search || '');
  const view = VIEWS.includes(p.get('view')) ? p.get('view') : 'apps';
  const depth = Math.min(3, Math.max(1, Number.parseInt(p.get('depth') || '1', 10) || 1));
  return { view, app: p.get('app') || '', table: p.get('table') || '', focus: p.get('focus') || '', depth, q: p.get('q') || '' };
}

/**
 * @description Write view state back to a query string (empty fields omitted).
 * @param {{view: string, app?: string, table?: string, focus?: string, depth?: number, q?: string}} state - state
 * @returns {string} query string beginning with `?`
 */
export function serializeViewState(state) {
  const p = new URLSearchParams();
  p.set('view', state.view);
  for (const k of ['app', 'table', 'focus', 'q']) if (state[k]) p.set(k, state[k]);
  if (state.focus && state.depth > 1) p.set('depth', String(state.depth));
  return `?${p.toString()}`;
}
