/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Backfill embeddings for rag_chunks rows that have none (legacy corpora copied docs-only from Chroma — runbook collections were FTS-only, and english-stemmed ts_rank ranks domain-specific tokens worse than the old tuned BM25; vectors restore hybrid RRF). Runs INSIDE the api container so it reuses the dist local-embedding-service + DATABASE_URL.
 */

/*
 * Usage (from the HOST):
 *   docker cp scripts/rag-embed-backfill.js oshal-local-api:/tmp/rag-embed-backfill.js
 *   docker exec -w /app oshal-local-api node /tmp/rag-embed-backfill.js [collection]
 * No arg = every collection with NULL-embedding rows. Idempotent (only fills NULLs).
 */

'use strict';

const path = require('path');

async function main() {
  const only = process.argv[2] || null;
  const { Pool } = require(path.join('/app', 'node_modules', 'pg'));
  const { localEmbeddings } = require(path.join('/app', 'dist', 'features', 'rag', 'services', 'local-embedding-service'));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const where = only ? 'embedding IS NULL AND collection = $1' : 'embedding IS NULL';
  const params = only ? [only] : [];
  const todo = await pool.query(`SELECT collection, count(*) FROM rag_chunks WHERE ${where} GROUP BY collection ORDER BY collection`, params);
  if (!todo.rows.length) { console.log('Nothing to backfill.'); await pool.end(); return; }
  for (const r of todo.rows) console.log(`to backfill: ${r.collection} (${r.count})`);

  const BATCH = 32;
  let done = 0;
  for (;;) {
    const batch = await pool.query(
      `SELECT chunk_id, document FROM rag_chunks WHERE ${where} ORDER BY chunk_id LIMIT ${BATCH}`, params);
    if (!batch.rows.length) break;
    const vectors = await localEmbeddings.embed(batch.rows.map((r) => r.document));
    if (!vectors) throw new Error('embedder unavailable — aborting (rows left NULL, retrieval stays FTS-only)');
    for (let i = 0; i < batch.rows.length; i++) {
      await pool.query('UPDATE rag_chunks SET embedding = $2::vector WHERE chunk_id = $1',
        [batch.rows[i].chunk_id, `[${vectors[i].join(',')}]`]);
    }
    done += batch.rows.length;
    process.stdout.write(`\rembedded ${done} chunks`);
  }
  console.log(`\nDone — ${done} chunks vectorised.`);
  const left = await pool.query('SELECT count(*) FROM rag_chunks WHERE embedding IS NULL');
  console.log(`rows still without vectors: ${left.rows[0].count}`);
  await pool.end();
}

main().catch((err) => { console.error(`BACKFILL FAILED: ${err.message}`); process.exitCode = 1; });
