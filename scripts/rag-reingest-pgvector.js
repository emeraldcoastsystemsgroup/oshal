/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-091 reingest: copy every ChromaDB collection (documents + metadatas + EXISTING embeddings, ids preserved) into Postgres rag_chunks. Idempotent (ON CONFLICT DO NOTHING); chunks without vectors land with NULL embedding and stay lexical-only until properly re-ingested. Run on the HOST with the docker stack up.
 */

/*
 * Usage:  node scripts/rag-reingest-pgvector.js [--only <collection>] [--drop]
 *   --only <name>  reingest a single collection
 *   --drop         DELETE the target rows in rag_chunks first (clean copy)
 * Env: OSHAL_CHROMA (default http://localhost:58001),
 *      OSHAL_PG (default postgres://oshal:oshal@127.0.0.1:55433/oshal — the compose superuser).
 */

'use strict';

const { Pool } = require('pg');

const CHROMA = process.env.OSHAL_CHROMA || 'http://localhost:58001';
const PG = process.env.OSHAL_PG || 'postgres://oshal:oshal@127.0.0.1:55433/oshal';
const BATCH = 200;

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const drop = args.includes('--drop');

async function chroma(path, init) {
  const res = await fetch(`${CHROMA}${path}`, init);
  if (!res.ok) throw new Error(`chroma ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const pool = new Pool({ connectionString: PG, max: 4 });
  await pool.query('SELECT 1 FROM rag_chunks LIMIT 1'); // fail fast when migration 070 hasn't run

  const collections = (await chroma('/api/v1/collections'))
    .map((c) => ({ id: c.id, name: c.name }))
    .filter((c) => !only || c.name === only);
  console.log(`Reingesting ${collections.length} collection(s) from ${CHROMA}`);

  let totalRows = 0;
  for (const col of collections) {
    // Chroma 0.4.x raises IndexError on include:['embeddings'] for collections whose
    // docs were stored without vectors — retry docs-only (rows land lexical-only),
    // and never let one bad collection abort the sweep.
    let data;
    try {
      data = await chroma(`/api/v1/collections/${col.id}/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include: ['documents', 'metadatas', 'embeddings'] }),
      });
    } catch (err) {
      try {
        data = await chroma(`/api/v1/collections/${col.id}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ include: ['documents', 'metadatas'] }),
        });
        console.log(`  ${col.name}: embeddings unreadable (${err.message.slice(0, 80)}) — copied documents-only`);
      } catch (err2) {
        console.log(`  ${col.name}: SKIPPED — ${err2.message.slice(0, 120)}`);
        continue;
      }
    }
    const ids = data.ids || [];
    const docs = data.documents || [];
    const metas = data.metadatas || [];
    const embs = data.embeddings || [];
    if (!ids.length) { console.log(`  ${col.name}: empty — skipped`); continue; }

    if (drop) await pool.query('DELETE FROM rag_chunks WHERE collection = $1', [col.name]);

    let inserted = 0;
    for (let start = 0; start < ids.length; start += BATCH) {
      const end = Math.min(start + BATCH, ids.length);
      const values = [];
      const params = [];
      for (let i = start; i < end; i++) {
        const base = params.length;
        const emb = Array.isArray(embs?.[i]) && embs[i].length ? `[${embs[i].join(',')}]` : null;
        // Postgres TEXT/JSONB reject NUL bytes (pdf-parse output contains them).
        params.push(ids[i], col.name, String(docs[i] ?? '').replace(/\u0000/g, ''),
          JSON.stringify(metas[i] ?? {}).replace(/\\u0000/g, ''), emb);
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::vector)`);
      }
      const res = await pool.query(
        `INSERT INTO rag_chunks (chunk_id, collection, document, metadata, embedding)
         VALUES ${values.join(', ')} ON CONFLICT (chunk_id) DO NOTHING`,
        params,
      );
      inserted += res.rowCount ?? 0;
    }
    totalRows += inserted;
    const vectorised = embs?.filter?.((e) => Array.isArray(e) && e.length)?.length ?? 0;
    console.log(`  ${col.name}: ${inserted}/${ids.length} rows inserted (${vectorised} with vectors)`);
  }

  const counts = await pool.query('SELECT collection, count(*) AS chunks, count(embedding) AS vectorised FROM rag_chunks GROUP BY collection ORDER BY collection');
  console.log('\nrag_chunks now holds:');
  for (const r of counts.rows) console.log(`  ${r.collection}: ${r.chunks} chunks (${r.vectorised} vectorised)`);
  console.log(`\nDone — ${totalRows} rows copied this run.`);
  await pool.end();
}

main().catch((err) => { console.error(`REINGEST FAILED: ${err.message}`); process.exitCode = 1; });
