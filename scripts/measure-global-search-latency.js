#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: the before/after latency harness the pg_trgm backlog item asks for. Runs entirely inside a THROWAWAY database it creates and drops on the configured server, so it never drops an index or reads a row from the live one — a benchmark that mutates production indexes is a benchmark nobody is allowed to run twice. Issues the adapters' EXACT predicates (leading-wildcard ILIKE with the owner-column equality in front) against synthetic rows, times N iterations, then applies migration 103 and repeats.
 */

/**
 * @description Before/after latency measurement for the global-search trigram indexes.
 *
 * Usage:
 *   node scripts/measure-global-search-latency.js [--rows 20000] [--iterations 25]
 *                                                  [--single-owner] [--keep]
 *
 * Connection comes from DATABASE_URL, or from PG* / OSHAL_DB_* env vars the way the rest of the
 * scripts read them. The script CREATEs a scratch database, seeds it, measures, and DROPs it
 * (unless --keep). Exit code is non-zero on any failure so a CI wrapper cannot mistake a broken
 * benchmark for a fast one.
 * @module scripts/measure-global-search-latency
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const MIGRATION = path.join(__dirname, 'migrations', '103-global-search-trgm.sql');

/** @description Parse `--flag value` / `--flag` argv. @returns {Record<string, string|boolean>} */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
  }
  return out;
}

/**
 * @description Build the admin connection config (the server, not the scratch DB).
 * @returns {{host:string,port:number,user:string,password:string|undefined,database:string}}
 */
function adminConfig() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: 'postgres',
    };
  }
  return {
    host: process.env.PGHOST || process.env.OSHAL_DB_HOST || 'localhost',
    port: Number(process.env.PGPORT || process.env.OSHAL_DB_PORT || 5432),
    user: process.env.PGUSER || process.env.OSHAL_DB_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.OSHAL_DB_PASSWORD,
    database: 'postgres',
  };
}

/** The four owner-scoped, leading-wildcard predicates the adapters issue verbatim. */
const QUERIES = [
  {
    label: 'tickets (title/description ILIKE, owner-scoped)',
    sql: `SELECT ticket_id FROM tickets
           WHERE owner_sub = $1 AND (title ILIKE $2 ESCAPE '\\' OR description ILIKE $2 ESCAPE '\\')
           ORDER BY updated_at DESC LIMIT 20`,
  },
  {
    label: 'chat (task title UNION message text, owner-scoped)',
    sql: `SELECT t.task_id FROM chat_tasks t
           WHERE t.owner_sub = $1 AND t.title ILIKE $2 ESCAPE '\\'
          UNION ALL
          SELECT t.task_id FROM chat_messages m
            JOIN chat_tasks t ON t.task_id = m.task_id AND t.owner_sub = $1
           WHERE m.text ILIKE $2 ESCAPE '\\'
           LIMIT 80`,
  },
  {
    label: 'connectors (provider/account_email ILIKE, owner-scoped)',
    sql: `SELECT provider FROM oshal_connections
           WHERE user_sub = $1
             AND (provider ILIKE $2 ESCAPE '\\' OR account_email ILIKE $2 ESCAPE '\\')
           ORDER BY updated_at DESC LIMIT 20`,
  },
];

/** @description Create the minimal schema the queries touch. @param {Client} c - Scratch client. */
async function createSchema(c) {
  await c.query(`
    CREATE TABLE tickets (
      ticket_id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE chat_tasks (
      task_id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, title TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE chat_messages (
      message_id BIGSERIAL PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE oshal_connections (
      connection_id BIGSERIAL PRIMARY KEY, user_sub TEXT NOT NULL, provider TEXT NOT NULL,
      account_email TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
}

/**
 * @description Seed synthetic rows spread over many owners so the owner filter is selective the
 * way it is in production (one caller's slice of a shared table), and so the text side is what the
 * index has to work for.
 * @param {Client} c - Scratch client.
 * @param {number} rows - Row count per table.
 * @param {string} targetSub - The sub the measured queries filter on.
 * @param {boolean} singleOwner - When true the target sub owns EVERY row. This is the real shape
 * of a single-operator box, and it is the case that decides whether a trigram index is worth its
 * write cost: with many owners the owner-column btree already narrows the scan to a few hundred
 * rows and the text index is never chosen, so measuring only the many-owner case would retire an
 * index that a one-person deployment depends on.
 */
async function seed(c, rows, targetSub, singleOwner) {
  const owners = singleOwner ? 1 : 50;
  await c.query(
    `INSERT INTO tickets (ticket_id, owner_sub, title, description, updated_at)
     SELECT 'tk-' || i,
            CASE WHEN i % $2 = 0 THEN $3 ELSE 'sub-' || (i % $2) END,
            'ticket ' || i || ' about ' || (ARRAY['deployment','invoice','outage','migration','render'])[1 + (i % 5)],
            'body text for record ' || i || ' mentioning ' || (ARRAY['postgres','chromadb','redis','wrangler','codex'])[1 + (i % 5)] || ' at length',
            NOW() - (i || ' minutes')::interval
       FROM generate_series(1, $1) AS s(i)`,
    [rows, owners, targetSub],
  );
  await c.query(
    `INSERT INTO chat_tasks (task_id, owner_sub, title, updated_at)
     SELECT 'ct-' || i,
            CASE WHEN i % $2 = 0 THEN $3 ELSE 'sub-' || (i % $2) END,
            'conversation ' || i || ' regarding ' || (ARRAY['deployment','invoice','outage','migration','render'])[1 + (i % 5)],
            NOW() - (i || ' minutes')::interval
       FROM generate_series(1, $1) AS s(i)`,
    [rows, owners, targetSub],
  );
  await c.query(
    `INSERT INTO chat_messages (task_id, text, created_at)
     SELECT 'ct-' || i,
            'message body ' || i || ' talking about ' || (ARRAY['postgres','chromadb','redis','wrangler','codex'])[1 + (i % 5)] || ' in some detail',
            NOW() - (i || ' minutes')::interval
       FROM generate_series(1, $1) AS s(i)`,
    [rows],
  );
  await c.query(
    `INSERT INTO oshal_connections (user_sub, provider, account_email, updated_at)
     SELECT CASE WHEN i % $2 = 0 THEN $3 ELSE 'sub-' || (i % $2) END,
            (ARRAY['google','dropbox','github','linkedin','slack'])[1 + (i % 5)],
            'account' || i || '@example.test',
            NOW() - (i || ' minutes')::interval
       FROM generate_series(1, $1) AS s(i)`,
    [Math.max(200, Math.floor(rows / 20)), owners, targetSub],
  );
  await c.query('ANALYZE tickets; ANALYZE chat_tasks; ANALYZE chat_messages; ANALYZE oshal_connections;');
}

/**
 * @description Time one query over `iterations` runs after a discarded warm-up, reporting the
 * median (robust to a single scheduler hiccup) alongside min/max.
 * @param {Client} c - Scratch client.
 * @param {string} sql - The statement.
 * @param {unknown[]} params - Bind values.
 * @param {number} iterations - Timed runs.
 * @returns {Promise<{medianMs:number,minMs:number,maxMs:number,rows:number}>}
 */
async function timeQuery(c, sql, params, iterations) {
  await c.query(sql, params);
  const samples = [];
  let rows = 0;
  for (let i = 0; i < iterations; i += 1) {
    const t0 = process.hrtime.bigint();
    const r = await c.query(sql, params);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
    rows = r.rowCount;
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    minMs: samples[0],
    maxMs: samples[samples.length - 1],
    rows,
  };
}

/** @description Report whether the planner actually chose a trigram index. @returns {Promise<boolean>} */
async function usesBitmapIndex(c, sql, params) {
  const plan = await c.query(`EXPLAIN (FORMAT TEXT) ${sql}`, params);
  const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
  return /_trgm/.test(text);
}

/** @description Run the benchmark. @returns {Promise<void>} */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = Number(args.rows || 20000);
  const iterations = Number(args.iterations || 25);
  const singleOwner = args['single-owner'] === true || args['single-owner'] === 'true';
  const dbName = `gs_trgm_bench_${Date.now().toString(36)}`;
  const targetSub = 'bench-owner-sub';
  const admin = adminConfig();

  const adminClient = new Client(admin);
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${dbName}`);
  await adminClient.end();
  console.log(`scratch database ${dbName} created on ${admin.host}:${admin.port}`);

  const c = new Client({ ...admin, database: dbName });
  const results = [];
  try {
    await c.connect();
    await createSchema(c);
    await seed(c, rows, targetSub, singleOwner);

    const pattern = '%invoice%';
    for (const q of QUERIES) {
      const before = await timeQuery(c, q.sql, [targetSub, pattern], iterations);
      results.push({ label: q.label, before });
    }

    const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
    const t0 = process.hrtime.bigint();
    await c.query(migrationSql);
    const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`migration 103 applied in ${buildMs.toFixed(0)} ms`);

    for (const r of results) {
      const q = QUERIES.find((x) => x.label === r.label);
      r.after = await timeQuery(c, q.sql, [targetSub, pattern], iterations);
      r.trigramInPlan = await usesBitmapIndex(c, q.sql, [targetSub, pattern]);
    }
  } finally {
    await c.end().catch(() => {});
    if (!args.keep) {
      const drop = new Client(admin);
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await drop.end();
      console.log(`scratch database ${dbName} dropped`);
    } else {
      console.log(`--keep: scratch database ${dbName} left in place`);
    }
  }

  console.log(`\nrows per table: ${rows}  iterations: ${iterations}  (median of ${iterations} runs)`);
  console.log('-'.repeat(96));
  for (const r of results) {
    const gain = r.before.medianMs / r.after.medianMs;
    console.log(
      `${r.label}\n  before ${r.before.medianMs.toFixed(2)} ms  ->  after ${r.after.medianMs.toFixed(2)} ms`
      + `  (${gain.toFixed(1)}x)  trigram index in plan: ${r.trigramInPlan}`,
    );
  }
}

main().catch((err) => {
  console.error('measurement FAILED:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
