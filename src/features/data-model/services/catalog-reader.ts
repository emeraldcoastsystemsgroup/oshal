/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Read-only catalog reader for the data-model explorer. The catalog SQL is byte-identical to the schema-docs generator's (scripts/schema-docs/introspect.js) - tests/unit/data-model-catalog.spec.ts holds the two together - so the explorer and the generated docs can never describe the same database differently. Catalog SELECTs only.
 */

import type { CatalogSnapshot, RelationInfo } from '../types';

/** The one query shape the reader needs; a pg Pool or Client satisfies it. */
export interface CatalogQueryable {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const CATALOG_SQL = `
SELECT json_build_object(
  'tables', (SELECT coalesce(json_agg(json_build_object(
      'name', c.relname, 'kind', c.relkind, 'comment', obj_description(c.oid, 'pg_class'),
      'rls', c.relrowsecurity, 'forced', c.relforcerowsecurity) ORDER BY c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition),
  'columns', (SELECT coalesce(json_agg(json_build_object(
      'table', c.relname, 'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
      'nullable', NOT a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid),
      'comment', col_description(c.oid, a.attnum)) ORDER BY c.relname, a.attnum), '[]'::json)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition),
  'constraints', (SELECT coalesce(json_agg(json_build_object(
      'table', c.relname, 'type', k.contype, 'name', k.conname,
      'columns', (SELECT json_agg(a.attname ORDER BY x.o) FROM unnest(k.conkey) WITH ORDINALITY x(n, o)
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.n),
      'refTable', rc.relname,
      'refColumns', (SELECT json_agg(a.attname ORDER BY x.o) FROM unnest(k.confkey) WITH ORDINALITY x(n, o)
                     JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.n))
      ORDER BY c.relname, k.conname), '[]'::json)
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class rc ON rc.oid = k.confrelid
    WHERE n.nspname = 'public' AND k.contype IN ('p', 'f', 'u') AND NOT c.relispartition),
  'policies', (SELECT coalesce(json_agg(json_build_object('table', tablename, 'name', policyname,
      'command', cmd, 'using', qual, 'check', with_check)
      ORDER BY tablename, policyname), '[]'::json) FROM pg_policies WHERE schemaname = 'public'),
  'timescale', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
)`;

export const HYPERTABLE_SQL = `
SELECT coalesce(json_agg(json_build_object('table', d.hypertable_name, 'timeColumn', d.column_name)
  ORDER BY d.hypertable_name), '[]'::json)
FROM timescaledb_information.dimensions d
WHERE d.hypertable_schema = 'public' AND d.dimension_number = 1`;

type Row = Record<string, unknown>;

/** The raw JSON object CATALOG_SQL returns. */
export interface RawCatalog {
  tables: Row[];
  columns: Row[];
  constraints: Row[];
  policies: Row[];
  timescale?: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

/**
 * @description Build an empty relation record for one pg_class row.
 * @param row - `{name, kind, comment, rls, forced}` from the catalog query
 * @returns a relation with no columns or constraints yet
 */
function emptyRelation(row: Row): RelationInfo {
  const kind = str(row.kind);
  return {
    name: str(row.name), kind: kind === 'v' || kind === 'm' ? 'view' : 'table', comment: strOrNull(row.comment),
    rls: row.rls === true, forced: row.forced === true, policies: [], columns: [], primaryKey: [],
    foreignKeys: [], uniques: [], hypertable: null, materialized: kind === 'm', source: 'catalog',
  };
}

/**
 * @description Apply one constraint row (p = primary, u = unique, f = foreign) to its relation.
 * @param rel - the relation that owns the constraint
 * @param k - the constraint row
 * @returns nothing; mutates `rel`
 */
function applyConstraint(rel: RelationInfo, k: Row): void {
  const type = str(k.type);
  if (type === 'p') rel.primaryKey = strList(k.columns);
  else if (type === 'u') rel.uniques.push(strList(k.columns));
  else if (type === 'f') {
    rel.foreignKeys.push({ name: strOrNull(k.name), columns: strList(k.columns), refTable: str(k.refTable), refColumns: strList(k.refColumns) });
  }
}

/**
 * @description Fold the flat catalog rows into one record per relation. Pure, so the unit spec
 * proves the folding without a database and the parity spec compares it with the generator's.
 * @param database - the database the rows came from
 * @param raw - the CATALOG_SQL result
 * @param hypertables - TimescaleDB dimension rows (`[]` outside TimescaleDB)
 * @returns tables and views, each sorted by name
 */
export function foldCatalog(database: string, raw: RawCatalog, hypertables: Row[] = []): CatalogSnapshot {
  const byName = new Map<string, RelationInfo>();
  for (const row of raw.tables) byName.set(str(row.name), emptyRelation(row));
  for (const c of raw.columns) {
    byName.get(str(c.table))?.columns.push({
      name: str(c.name), type: str(c.type), nullable: c.nullable === true, default: strOrNull(c.default), comment: strOrNull(c.comment),
    });
  }
  for (const k of raw.constraints) {
    const rel = byName.get(str(k.table));
    if (rel && rel.kind === 'table') applyConstraint(rel, k);
  }
  for (const p of raw.policies) {
    byName.get(str(p.table))?.policies.push({ name: str(p.name), command: str(p.command), using: strOrNull(p.using), check: strOrNull(p.check) });
  }
  for (const h of hypertables) {
    const rel = byName.get(str(h.table));
    if (rel) rel.hypertable = { timeColumn: str(h.timeColumn) };
  }
  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { database, tables: all.filter((r) => r.kind === 'table'), views: all.filter((r) => r.kind === 'view') };
}

/**
 * @description Read one database's public schema through a pg-compatible queryable.
 * @param db - pool or client connected to the database
 * @param database - its name, carried onto every relation
 * @returns the folded catalog
 */
export async function readCatalog(db: CatalogQueryable, database: string): Promise<CatalogSnapshot> {
  const res = await db.query(CATALOG_SQL);
  const raw = Object.values(res.rows[0] ?? {})[0] as RawCatalog;
  let hypertables: Row[] = [];
  if (raw.timescale) {
    const hres = await db.query(HYPERTABLE_SQL);
    hypertables = (Object.values(hres.rows[0] ?? {})[0] as Row[]) ?? [];
  }
  return foldCatalog(database, raw, hypertables);
}
