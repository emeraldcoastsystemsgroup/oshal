/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Read-only Postgres catalog introspection for the schema-docs generator. Reads tables, views, columns, PK/FK/UNIQUE constraints, RLS flags and policy expressions from one database's `public` schema (plus TimescaleDB hypertables when the extension exists), through `docker exec … psql` or a pg connection URL. Catalog SELECTs only - it never writes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The catalog SQL and the fold are no longer a second copy. Both come from the data-model feature slice through ./kernel, so the committed pages and the live explorer cannot describe the same database differently; what stays here is the generator's own transport (docker exec / connection URL) and the by-name Map shape the rest of the pipeline reads.
 */

'use strict';

const { execFileSync } = require('child_process');
const { CATALOG_SQL, HYPERTABLE_SQL, foldCatalog: foldSnapshot } = require('./kernel');

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
 * @description Fold the flat catalog rows into one record per relation, then key them by name
 * for the rest of the generator. The folding itself is the slice's - this is only the shape
 * change, because every downstream module looks a table up by name rather than scanning a list.
 * @param {object} raw - the CATALOG_SQL result ({tables, columns, constraints, policies})
 * @param {Array<{table: string, timeColumn: string}>} hypertables - TimescaleDB dimension rows
 * @param {string} database - the database the rows came from, carried onto the snapshot
 * @returns {{tables: Map<string, object>, views: Map<string, object>}} name -> relation record
 */
function foldCatalog(raw, hypertables = [], database = '') {
  const snapshot = foldSnapshot(database, raw, hypertables);
  const byName = (relations) => new Map(relations.map((r) => [r.name, r]));
  return { tables: byName(snapshot.tables), views: byName(snapshot.views) };
}

/**
 * @description Introspect one database's public schema.
 * @param {{container?: string, database: string, user?: string, url?: string, label?: string}} target
 * @returns {Promise<{database: string, tables: Map<string, object>, views: Map<string, object>}>} the folded model
 */
async function introspectDatabase(target) {
  const raw = await queryJson(target, CATALOG_SQL);
  const hypertables = raw.timescale ? await queryJson(target, HYPERTABLE_SQL) : [];
  return { database: target.database, ...foldCatalog(raw, hypertables, target.database) };
}

module.exports = { introspectDatabase, foldCatalog, CATALOG_SQL };
