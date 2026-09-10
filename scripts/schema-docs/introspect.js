/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Read-only Postgres catalog introspection for the schema-docs generator. Reads tables, views, columns, PK/FK/UNIQUE constraints, RLS flags and policy expressions from one database's `public` schema (plus TimescaleDB hypertables when the extension exists), through `docker exec … psql` or a pg connection URL. Catalog SELECTs only - it never writes.
 */

'use strict';

const { execFileSync } = require('child_process');

const CATALOG_SQL = `
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

const HYPERTABLE_SQL = `
SELECT coalesce(json_agg(json_build_object('table', d.hypertable_name, 'timeColumn', d.column_name)
  ORDER BY d.hypertable_name), '[]'::json)
FROM timescaledb_information.dimensions d
WHERE d.hypertable_schema = 'public' AND d.dimension_number = 1`;

/**
 * @description Run one JSON-returning SELECT against a target and parse the result. The docker
 * path exists because the reference stack does not publish its Postgres port to the host; the
 * URL path serves any reachable Postgres (managed, CI, a published port).
 * @param {{container?: string, database: string, user?: string, url?: string}} target - where to read
 * @param {string} sql - a single statement returning exactly one JSON value
 * @returns {Promise<any>} the parsed JSON value
 */
async function queryJson(target, sql) {
  if (target.url) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: target.url });
    await client.connect();
    try {
      const res = await client.query(sql);
      return Object.values(res.rows[0])[0];
    } finally {
      await client.end();
    }
  }
  const out = execFileSync('docker', ['exec', target.container, 'psql', '-U', target.user || 'oshal',
    '-d', target.database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return JSON.parse(out.trim());
}

/**
 * @description Fold the flat catalog rows into one record per table. Kept pure so the unit spec
 * can prove the folding without a database.
 * @param {object} raw - the CATALOG_SQL result ({tables, columns, constraints, policies})
 * @param {Array<{table: string, timeColumn: string}>} hypertables - TimescaleDB dimension rows
 * @returns {{tables: Map<string, object>, views: Map<string, object>}} name -> {name, comment,
 *   rls, forced, policies, columns, primaryKey, foreignKeys, uniques, hypertable, materialized}
 */
function foldCatalog(raw, hypertables = []) {
  const tables = new Map();
  const views = new Map();
  for (const t of raw.tables) {
    const record = {
      name: t.name, comment: t.comment || null, rls: !!t.rls, forced: !!t.forced,
      policies: [], columns: [], primaryKey: [], foreignKeys: [], uniques: [], hypertable: null,
      source: 'catalog', materialized: t.kind === 'm',
    };
    (t.kind === 'v' || t.kind === 'm' ? views : tables).set(t.name, record);
  }
  for (const c of raw.columns) {
    const t = tables.get(c.table) || views.get(c.table);
    if (t) t.columns.push({ name: c.name, type: c.type, nullable: c.nullable, default: c.default, comment: c.comment || null });
  }
  for (const k of raw.constraints) {
    const t = tables.get(k.table);
    if (!t) continue;
    if (k.type === 'p') t.primaryKey = k.columns || [];
    else if (k.type === 'u') t.uniques.push(k.columns || []);
    else t.foreignKeys.push({ name: k.name, columns: k.columns || [], refTable: k.refTable, refColumns: k.refColumns || [] });
  }
  for (const p of raw.policies) {
    tables.get(p.table)?.policies.push({ name: p.name, command: p.command, using: p.using || null, check: p.check || null });
  }
  for (const h of hypertables) {
    const t = tables.get(h.table);
    if (t) t.hypertable = { timeColumn: h.timeColumn };
  }
  return { tables, views };
}

/**
 * @description Introspect one database's public schema.
 * @param {{container?: string, database: string, user?: string, url?: string, label?: string}} target
 * @returns {Promise<{database: string, tables: Map<string, object>, views: Map<string, object>}>} the folded model
 */
async function introspectDatabase(target) {
  const raw = await queryJson(target, CATALOG_SQL);
  const hypertables = raw.timescale ? await queryJson(target, HYPERTABLE_SQL) : [];
  return { database: target.database, ...foldCatalog(raw, hypertables) };
}

module.exports = { introspectDatabase, foldCatalog, CATALOG_SQL };
