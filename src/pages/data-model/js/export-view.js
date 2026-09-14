/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Take the view on screen somewhere else: the current scope as a Mermaid block (erDiagram for tables, flowchart for the owner graph, the same shape scripts/schema-docs/render.js writes into the committed pages so a paste into markdown renders unchanged), as scoped JSON, and as a standalone SVG. Entirely client-side - the snapshot is already in the page, so nothing new is asked of the server and no scope can escape the operator gate that fetched it. Refuses by name when the view drew nothing, rather than emitting a diagram that will not parse.
 */

const TYPE_ALIASES = [
  [/^timestamp(\(\d+\))? with time zone/, 'timestamptz'],
  [/^timestamp(\(\d+\))? without time zone/, 'timestamp'],
  [/^time(\(\d+\))? with time zone/, 'timetz'],
  [/^character varying/i, 'varchar'],
  [/^character\b/i, 'char'],
  [/^double precision/i, 'float8'],
  [/^bit varying/i, 'varbit'],
];

/** Colours and strokes the page gets from data-model.css, frozen for a file that travels alone. */
const SVG_STYLE = `
  .edge { fill: none; stroke-width: 1.4; opacity: 0.55; }
  .edge.is-near { opacity: 1; stroke-width: 2.4; }
  .node circle { stroke: #0f1420; stroke-width: 1.5; }
  .node text { fill: #e6ebf5; font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; }
  .node--view circle { stroke-dasharray: 3 2; }
  .node--shared circle { stroke: #e5534b; stroke-width: 3; }
  .node--external circle { fill-opacity: 0.25; }
  .node--unowned circle { fill: #97a3b8; stroke-dasharray: 2 2; }
  .node--core text, .node--group text { font-weight: 600; }
  .node.is-dim { opacity: 1; }
  .edge--context-offer, .marker--context-offer { stroke: #b083f0; fill: #b083f0; }
  .edge--artifact, .marker--artifact { stroke: #3fb9a8; fill: #3fb9a8; }
  .edge--dependency, .marker--dependency { stroke: #d29922; fill: #d29922; }
  .edge--group-member, .marker--group-member { stroke: #8b949e; fill: #8b949e; }
  .edge--shared-table, .marker--shared-table { stroke: #e5534b; fill: #e5534b; }
  .edge--foreign-key, .marker--foreign-key { stroke: #5b9cf6; fill: #5b9cf6; }
`;

/**
 * @description Refusal carrying a reason a reader can act on; the page shows `message` verbatim
 * instead of downloading a file that would not parse or open.
 * @param {string} message - why nothing was exported
 * @returns {Error} an Error tagged `code: 'EXPORT_EMPTY'`
 */
export function exportRefusal(message) {
  return Object.assign(new Error(message), { code: 'EXPORT_EMPTY' });
}

/**
 * @description Reduce a Postgres/SQLite type to a Mermaid-legal attribute token. Kept identical to
 * the committed-docs generator so a block pasted beside a generated page reads the same.
 * @param {string} type - e.g. `timestamp with time zone`, `character varying(64)`, `text[]`
 * @returns {string} e.g. `timestamptz`, `varchar`, `text_array`
 */
export function mermaidType(type) {
  const raw = String(type || 'unknown').trim();
  const isArray = /\[\]$/.test(raw);
  let base = raw.replace(/\[\]$/, '');
  const alias = TYPE_ALIASES.find(([re]) => re.test(base));
  base = alias ? alias[1] : base.replace(/\(.*\)/, '');
  base = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  return isArray ? `${base}_array` : base;
}

/**
 * @description Make any identifier safe as a Mermaid entity or attribute name — a table named with
 * a dot or a leading digit would otherwise break the whole diagram, not just its own line.
 * @param {string} name - raw identifier
 * @returns {string} identifier of only [A-Za-z0-9_-], never digit-initial
 */
export function mermaidName(name) {
  const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '_');
  return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`;
}

/**
 * @description Text safe inside a double-quoted Mermaid label: one line, no quotes, bounded.
 * @param {string} text - raw label
 * @returns {string} label text
 */
function mermaidLabel(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/**
 * @description Which of a relation's columns carry a key role. Owner columns come from the
 * snapshot's own RLS summary rather than a second classifier, so the page cannot disagree with the
 * server about who owns a row.
 * @param {object} relation - a snapshot relation record
 * @returns {Map<string, string[]>} column -> roles among PK / FK / UK / owner
 */
function keyRoles(relation) {
  const roles = new Map();
  const add = (col, role) => { if (!roles.has(col)) roles.set(col, []); if (!roles.get(col).includes(role)) roles.get(col).push(role); };
  (relation.primaryKey || []).forEach((c) => add(c, 'PK'));
  (relation.foreignKeys || []).forEach((fk) => (fk.columns || []).forEach((c) => add(c, 'FK')));
  (relation.uniques || []).filter((u) => u.length === 1).forEach((u) => add(u[0], 'UK'));
  ((relation.access && relation.access.ownerColumns) || []).forEach((c) => add(c, 'owner'));
  return roles;
}

/**
 * @description Attribute lines for one entity: key columns only, so a forty-table scope stays
 * legible; a keyless relation still shows one column so its box is not empty.
 * @param {object} relation - a snapshot relation record
 * @returns {string[]} indented attribute lines
 */
function diagramAttributes(relation) {
  const roles = keyRoles(relation);
  const columns = relation.columns || [];
  const cols = columns.filter((c) => roles.has(c.name));
  const shown = cols.length ? cols : columns.slice(0, 1);
  return shown.map((c) => {
    const r = roles.get(c.name) || [];
    const keys = r.filter((x) => x !== 'owner').join(', ');
    const note = r.includes('owner') ? ' "owner"' : '';
    return `    ${mermaidType(c.type)} ${mermaidName(c.name)}${keys ? ` ${keys}` : ''}${note}`;
  });
}

/**
 * @description Relationship line for one foreign key, parent on the left. Cardinality is read from
 * the real column nullability and key set, not assumed.
 * @param {object} relation - child relation record
 * @param {object} fk - `{columns, refTable}`
 * @returns {string} e.g. `  tickets ||--o{ work_items : "ticket_id"`
 */
function relationshipLine(relation, fk) {
  const cols = fk.columns || [];
  const columns = relation.columns || [];
  const nullable = cols.some((c) => (columns.find((x) => x.name === c) || {}).nullable !== false);
  const unique = [relation.primaryKey || [], ...(relation.uniques || [])].some((k) => k.length === cols.length && cols.every((c) => k.includes(c)));
  return `  ${mermaidName(fk.refTable)} ${nullable ? '|o' : '||'}--${unique ? 'o|' : 'o{'} ${mermaidName(relation.name)} : "${cols.join(', ')}"`;
}

/**
 * @description A fenced `erDiagram` for exactly the relations given, in the shape
 * `scripts/schema-docs/render.js` writes into the committed pages.
 * @param {object[]} relations - snapshot relation records, in draw order
 * @returns {string} a fenced mermaid block
 */
export function toErDiagram(relations) {
  if (!relations.length) throw exportRefusal('This view drew no tables, so there is no erDiagram to copy.');
  const lines = ['```mermaid', 'erDiagram'];
  for (const r of relations) lines.push(`  ${mermaidName(r.name)} {`, ...diagramAttributes(r), '  }');
  const seen = new Set();
  for (const r of relations) {
    for (const fk of r.foreignKeys || []) {
      if (!fk.refTable) continue;
      const line = relationshipLine(r, fk);
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * @description A fenced `flowchart` for an owner graph (Apps & integrations, Shared objects), where
 * the nodes are applications rather than tables and an erDiagram would say nothing.
 * @param {{nodes: object[], edges: object[]}} graph - the drawn graph
 * @returns {string} a fenced mermaid block
 */
export function toFlowchart(graph) {
  if (!graph.nodes.length) throw exportRefusal('This view drew no applications, so there is no flowchart to copy.');
  const lines = ['```mermaid', 'flowchart LR'];
  for (const n of graph.nodes) lines.push(`  ${mermaidName(n.id)}["${mermaidLabel(n.label || n.id)}"]`);
  const seen = new Set();
  for (const e of graph.edges) {
    const line = `  ${mermaidName(e.source)} -- "${mermaidLabel(`${e.kind}: ${e.label}`)}" --> ${mermaidName(e.target)}`;
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * @description The relation records behind a drawn graph, in draw order. Only nodes the snapshot
 * knows as relations count, so an app node can never smuggle itself into an erDiagram.
 * @param {object} index - from `indexSnapshot`
 * @param {{nodes: object[]}} graph - the drawn graph
 * @returns {object[]} relation records
 */
export function drawnRelations(index, graph) {
  return graph.nodes.map((n) => index.relations.get(n.id)).filter(Boolean);
}

/**
 * @description The Mermaid block for the view on screen: an erDiagram when the graph is relations,
 * a flowchart when it is owners.
 * @param {object} index - from `indexSnapshot`
 * @param {{view: string}} state - current view state
 * @param {{nodes: object[], edges: object[]}} graph - the drawn graph
 * @returns {string} a fenced mermaid block
 */
export function toMermaid(index, state, graph) {
  if (state.view === 'tables') return toErDiagram(drawnRelations(index, graph));
  if (state.view === 'apps' || state.view === 'shared') return toFlowchart(graph);
  throw exportRefusal(`The ${state.view || 'current'} view draws no diagram; use JSON to take it away.`);
}

/**
 * @description The current scope as JSON: what the view drew and the state that drew it, so a
 * reader can reproduce the same screen from the file.
 * @param {object} index - from `indexSnapshot`
 * @param {object} state - current view state
 * @param {{nodes: object[], edges: object[]}} graph - the drawn graph (absent on the stores view)
 * @param {object[]} [stores] - store inventories, included on the stores view
 * @returns {object} a JSON-serialisable scope
 */
export function toScopedJson(index, state, graph, stores) {
  const snap = index.snap;
  const base = { exportedAt: new Date().toISOString(), generatedAt: snap.generatedAt, database: snap.database, view: state.view, scope: { ...state } };
  if (state.view === 'stores') {
    if (!stores || !stores.length) throw exportRefusal('The store inventories have not loaded yet.');
    return { ...base, stores };
  }
  if (!graph || !graph.nodes.length) throw exportRefusal('This view drew nothing, so there is no scope to export.');
  if (state.view === 'tables') {
    return { ...base, relations: drawnRelations(index, graph), foreignKeys: graph.edges.map((e) => ({ table: e.source, columns: String(e.label).split(', '), refTable: e.target })) };
  }
  const names = new Set(graph.nodes.map((n) => n.id));
  return { ...base, apps: snap.apps.filter((a) => names.has(a.name)), integrations: graph.edges.map((e) => ({ from: e.source, to: e.target, kind: e.kind, label: e.label })) };
}

/**
 * @description Wrap drawn SVG markup as a standalone document: its own viewBox, an opaque
 * background and the graph rules inlined, because the page's stylesheet does not travel with it.
 * @param {{viewBox: string, width: number, height: number, title: string, body: string}} parts - geometry and markup
 * @returns {string} a complete SVG document
 */
export function svgDocument(parts) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(parts.width)}" height="${Math.round(parts.height)}" viewBox="${parts.viewBox}">`,
    `<title>${mermaidLabel(parts.title).replace(/[<&>]/g, '')}</title>`,
    `<style>${SVG_STYLE}</style>`,
    `<rect x="${parts.viewBox.split(' ')[0]}" y="${parts.viewBox.split(' ')[1]}" width="100%" height="100%" fill="#0f1420"/>`,
    parts.body,
    '</svg>',
  ].join('\n');
}

/**
 * @description Serialise the live graph `<svg>` as a standalone file, fitted to what is drawn
 * (the export is the view, not the pan/zoom the reader happens to be at).
 * @param {SVGSVGElement} svg - the page's graph element
 * @param {string} title - document title
 * @returns {string} a complete SVG document
 */
export function serializeGraphSvg(svg, title) {
  const root = svg.querySelector('g.graph-root');
  if (!root || !root.querySelector('g.node')) throw exportRefusal('This view drew no graph, so there is no SVG to download.');
  const box = root.getBBox();
  const pad = 24;
  const clone = svg.cloneNode(true);
  const cloneRoot = clone.querySelector('g.graph-root');
  cloneRoot.removeAttribute('transform');
  cloneRoot.querySelectorAll('.is-dim, .is-selected, .is-near').forEach((n) => n.classList.remove('is-dim', 'is-selected', 'is-near'));
  const viewBox = `${Math.round(box.x - pad)} ${Math.round(box.y - pad)} ${Math.round(box.width + pad * 2)} ${Math.round(box.height + pad * 2)}`;
  const body = [...clone.childNodes].map((n) => new XMLSerializer().serializeToString(n)).join('\n');
  return svgDocument({ viewBox, width: box.width + pad * 2, height: box.height + pad * 2, title, body });
}

/**
 * @description A filename that says which view and which scope it holds, so three exports in a
 * downloads folder are still tellable apart.
 * @param {object} state - current view state
 * @param {string} ext - file extension without the dot
 * @param {Date} [now] - clock, injectable for tests
 * @returns {string} e.g. `data-model-tables-career-hunter-2026-09-14.svg`
 */
export function exportFilename(state, ext, now = new Date()) {
  const scope = state.view === 'tables' ? (state.focus || state.app || 'core') : '';
  const slug = String(scope).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return ['data-model', state.view, slug, now.toISOString().slice(0, 10)].filter(Boolean).join('-') + `.${ext}`;
}

/**
 * @description Hand a generated file to the browser as a download, cleaning the object URL up
 * afterwards so a long session does not leak one per export.
 * @param {string} filename - download name
 * @param {string} mime - MIME type
 * @param {string} text - file content
 * @returns {void}
 */
export function downloadText(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  // The synthetic click bubbles to document, where the page closes its menus on an outside click.
  a.addEventListener('click', (ev) => ev.stopPropagation());
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
