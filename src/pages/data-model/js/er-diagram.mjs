/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | THE erDiagram renderer - one implementation behind both the committed schema docs (scripts/schema-docs/render.js requires this file) and the data-model explorer's Export (src/pages/data-model/js/export-view.js imports it). It used to be two copies kept honest by a byte-parity assertion; a parity test only tells you AFTER one side drifts, so the copies are gone. Plain ESM with no imports, so the browser loads it straight off the page mount and Node requires it from CommonJS. Row ownership is the one thing the two callers read differently - the docs generator classifies the policies itself, the page is handed the server's already-computed summary - so it arrives as an injected reader rather than a second classifier in here.
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

/**
 * @description Owner columns as the explorer's snapshot already carries them. The server ran the
 * RLS classifier once and shipped the answer; re-deriving it in the page could only disagree.
 * @param {object} relation - a relation record carrying `access.ownerColumns`
 * @returns {string[]} owner column names
 */
const snapshotOwnerColumns = (relation) => (relation.access && relation.access.ownerColumns) || [];

/**
 * @description Reduce a Postgres/SQLite type to a Mermaid-legal attribute type token.
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
 * @description Which of a relation's columns carry a key role, for the diagram and the docs notes.
 * @param {object} relation - a folded table record or a snapshot relation record
 * @param {function(object): string[]} [ownerColumnsOf] - reads the RLS owner columns for this caller
 * @returns {Map<string, string[]>} column -> roles among PK / FK / UK / owner
 */
export function keyRoles(relation, ownerColumnsOf = snapshotOwnerColumns) {
  const roles = new Map();
  const add = (col, role) => { if (!roles.has(col)) roles.set(col, []); if (!roles.get(col).includes(role)) roles.get(col).push(role); };
  (relation.primaryKey || []).forEach((c) => add(c, 'PK'));
  (relation.foreignKeys || []).forEach((fk) => (fk.columns || []).forEach((c) => add(c, 'FK')));
  (relation.uniques || []).filter((u) => u.length === 1).forEach((u) => add(u[0], 'UK'));
  (ownerColumnsOf(relation) || []).forEach((c) => add(c, 'owner'));
  return roles;
}

/**
 * @description Attribute lines for one entity: key columns only, so a forty-table scope stays
 * legible; a keyless relation still shows one column so its box is not empty.
 * @param {object} relation - a folded table record or a snapshot relation record
 * @param {function(object): string[]} [ownerColumnsOf] - reads the RLS owner columns for this caller
 * @returns {string[]} indented attribute lines
 */
export function diagramAttributes(relation, ownerColumnsOf = snapshotOwnerColumns) {
  const roles = keyRoles(relation, ownerColumnsOf);
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
export function relationshipLine(relation, fk) {
  const cols = fk.columns || [];
  const columns = relation.columns || [];
  const nullable = cols.some((c) => (columns.find((x) => x.name === c) || {}).nullable !== false);
  const unique = [relation.primaryKey || [], ...(relation.uniques || [])].some((k) => k.length === cols.length && cols.every((c) => k.includes(c)));
  return `  ${mermaidName(fk.refTable)} ${nullable ? '|o' : '||'}--${unique ? 'o|' : 'o{'} ${mermaidName(relation.name)} : "${cols.join(', ')}"`;
}

/**
 * @description Render one fenced `erDiagram` for exactly the relations given, in draw order. FKs to
 * relations outside the set still draw — the external parent appears as a bare entity box.
 * @param {object[]} relations - folded table records or snapshot relation records
 * @param {function(object): string[]} [ownerColumnsOf] - reads the RLS owner columns for this caller
 * @returns {string} a fenced mermaid block
 */
export function mermaidDiagram(relations, ownerColumnsOf = snapshotOwnerColumns) {
  const lines = ['```mermaid', 'erDiagram'];
  for (const r of relations) lines.push(`  ${mermaidName(r.name)} {`, ...diagramAttributes(r, ownerColumnsOf), '  }');
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
