/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 parity gate as plain Node for a host that cannot reach Postgres (Docker port publishing wedged on the dev box, 2026-09-12). Twin of tests/unit/person-model-parity-postgres.spec.ts: creates a scratch database on the live server, applies the full migration chain, runs the lazy person-model DDL twice, recreates the legacy consent trigger and asserts convergence, then proves segment delete / merge / forget / discovered lifecycle delete parity — and drops the scratch database. Runs INSIDE oshal-local-api (BOOTSTRAP_DATABASE_URL is the superuser bootstrap URL there). PM_GATE_SCHEMA can point at a freshly compiled schema module not yet in the image.
 *
 * Usage (from the repo root, Git Bash):
 *   docker exec oshal-local-api sh -c 'mkdir -p /tmp/pm-gate/migrations && cp /app/scripts/migrations/*.sql /tmp/pm-gate/migrations/'
 *   MSYS_NO_PATHCONV=1 docker cp scripts/person-model-gate-in-container.js oshal-local-api:/tmp/pm-gate/gate.js
 *   docker exec oshal-local-api node /tmp/pm-gate/gate.js
 */
'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('/app/node_modules/pg');

const ADMIN_DSN = process.env.BOOTSTRAP_DATABASE_URL || process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const SCRATCH_DB = `pm_gate_${RUN}`;
const A = `spec-adr100-${RUN}-a`;
const B = `spec-adr100-${RUN}-b`;
const P1 = randomUUID(); const P2 = randomUUID(); const P3 = randomUUID();
const AT = '2026-09-10T15:00:00.000Z';
const seg = (n) => `seg-${RUN}-${n}`;

const { DatabaseBootstrapService } = require('/app/dist/features/tool-registry/services/database-bootstrap-service');
// PM_GATE_SCHEMA lets a freshly compiled schema module (not yet in the image) be proven here.
const { personModelSchemaStatements } = require(process.env.PM_GATE_SCHEMA || '/app/dist/features/person-model/services/person-model-schema');
const { SpeakerProfileStore } = require('/app/dist/features/speaker-diarization/speaker-profile-store');
const { discoverSubKeyedExporters } = require('/app/dist/features/data-lifecycle/services/discovered-exporters');
const { executeDeleteAll } = require('/app/dist/features/data-lifecycle/services/exporter-registry');

let admin; let pool; const results = [];
const count = async (sql, params = []) => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${sql}`, params)).rows[0].n);

/** @description Object inventory of the scratch database — equal before/after a DDL rerun means idempotent. */
async function inventory() {
  const n = async (sql) => Number((await pool.query(sql)).rows[0].n);
  return {
    tables: await n(`SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = 'public'`),
    triggers: await n(`SELECT COUNT(*) n FROM pg_trigger WHERE NOT tgisinternal`),
    functions: await n(`SELECT COUNT(*) n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public'`),
    indexes: await n(`SELECT COUNT(*) n FROM pg_indexes WHERE schemaname = 'public'`),
    policies: await n(`SELECT COUNT(*) n FROM pg_policies WHERE schemaname = 'public'`),
    segmentColumns: await n(`SELECT COUNT(*) n FROM information_schema.columns WHERE table_name = 'ambient_transcript_segments'`),
  };
}
async function applyLazyDdl() { for (const s of personModelSchemaStatements()) await pool.query(s); }
async function insertProfile(owner, id, ordinal) {
  await pool.query(`INSERT INTO ambient_speaker_profiles (profile_id, owner_sub, unidentified_ordinal, embedding_ciphertext, embedding_model, embedding_dimensions) VALUES ($1,$2,$3,'spec-ciphertext','spec-model',4)`, [id, owner, ordinal]);
}
async function insertSegment(owner, id, text, profile) {
  await pool.query(`INSERT INTO ambient_transcript_segments (segment_id, user_sub, transcript_text, captured_at, speaker_profile_id) VALUES ($1,$2,$3,$4,$5)`, [id, owner, text, AT, profile]);
  await pool.query(`INSERT INTO rag_chunks (chunk_id, collection, document, metadata, owner_sub) VALUES ($1,'ambient-recall',$2,$3::jsonb,$4)`,
    [`pm:${id}`, text, JSON.stringify({ owner_sub: owner, profile_id: profile || '', segment_id: id, captured_at: AT }), owner]);
}
async function insertEnrichment(owner, id, topics, askText, profile) {
  await pool.query(`INSERT INTO ambient_utterance_enrichment (segment_id, user_sub, topics, tone, intent, taxonomy_version) VALUES ($1,$2,$3::jsonb,'neutral','inform',1)`, [id, owner, JSON.stringify(topics)]);
  if (askText && profile) {
    await pool.query(`INSERT INTO ambient_person_asks (owner_sub, profile_id, segment_id, kind, text, source_quote, dedupe_key) VALUES ($1,$2,$3,'ask',$4,$4,$5)`, [owner, profile, id, askText, `${id}|ask`]);
  }
}
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(`PASS ${name} (${Date.now() - t}ms)`); }
  catch (e) { results.push(`FAIL ${name}: ${e && e.message ? e.message : e}`); throw e; }
}

async function main() {
  admin = new Pool({ connectionString: ADMIN_DSN, max: 2 });
  await admin.query('SELECT 1');
  await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
  const url = new URL(ADMIN_DSN); url.pathname = `/${SCRATCH_DB}`;
  pool = new Pool({ connectionString: url.toString(), max: 4 });
  process.env.RUN_MIGRATIONS = 'true'; delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
  const migrationsDir = process.env.PM_GATE_MIGRATIONS || '/tmp/pm-gate/migrations';
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  assert.ok(files.includes('138-person-model-parity.sql'), 'migration 138 must be in the chain');

  await step('full migration chain on a fresh database', async () => {
    const applied = await new DatabaseBootstrapService(pool, migrationsDir).applyMigrations();
    assert.ok(applied.includes('138-person-model-parity.sql'), '138 applied');
    assert.ok(applied.includes('070-rag-chunks-pgvector.sql'), '070 applied');
    results.push(`      applied ${applied.length} migrations`);
  });
  await step('lazy DDL on the fresh database, rerun changes nothing', async () => {
    const rag = await pool.query(`SELECT to_regclass('public.rag_chunks') IS NOT NULL AS present`);
    assert.equal(rag.rows[0].present, true, 'rag_chunks present (pgvector)');
    await applyLazyDdl();
    const first = await inventory();
    for (const t of ['ambient_utterance_enrichment', 'ambient_person_asks', 'ambient_person_topic_daily', 'ambient_person_relations', 'ambient_speaker_consents', 'person_model_projections']) {
      assert.equal(await count(`information_schema.tables WHERE table_name = $1`, [t]), 1, t);
    }
    const trig = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'pm_%' ORDER BY tgname`);
    assert.deepEqual(trig.rows.map((r) => r.tgname), ['pm_profile_deleting', 'pm_segment_deleted', 'pm_segment_repointed', 'pm_segments_repointed_stmt']);
    await applyLazyDdl();
    assert.deepEqual(await inventory(), first);
    results.push(`      inventory ${JSON.stringify(first)}`);
  });
  await step('lazy DDL converges the legacy BEFORE DELETE OR UPDATE consent trigger', async () => {
    await pool.query('DROP TRIGGER IF EXISTS ambient_speaker_consents_no_mutate ON ambient_speaker_consents');
    await pool.query(`CREATE OR REPLACE FUNCTION ambient_speaker_consents_append_only() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'ambient_speaker_consents is append-only'; END; $fn$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER ambient_speaker_consents_no_mutate BEFORE DELETE OR UPDATE ON ambient_speaker_consents FOR EACH ROW EXECUTE FUNCTION ambient_speaker_consents_append_only()`);
    assert.notEqual(Number((await pool.query(`SELECT tgtype FROM pg_trigger WHERE tgname = 'ambient_speaker_consents_no_mutate'`)).rows[0].tgtype) & 8, 0);
    await applyLazyDdl();
    const c = await pool.query(`SELECT tgtype, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'ambient_speaker_consents_no_mutate'`);
    assert.equal(c.rows.length, 1); assert.equal(Number(c.rows[0].tgtype) & 8, 0); assert.ok(String(c.rows[0].def).includes('BEFORE UPDATE ON'));
    results.push(`      converged: ${c.rows[0].def}`);
  });
  await step('consent ledger append-only for UPDATE, DELETE cascade-clean', async () => {
    const p0 = randomUUID();
    await insertProfile(A, p0, 99);
    await pool.query(`INSERT INTO ambient_speaker_consents (owner_sub, profile_id, scope, status, method) VALUES ($1,$2,'transcript','granted','owner_attested')`, [A, p0]);
    await assert.rejects(pool.query(`UPDATE ambient_speaker_consents SET status = 'declined' WHERE profile_id = $1`, [p0]), /append-only/);
    await pool.query('DELETE FROM ambient_speaker_profiles WHERE profile_id = $1', [p0]);
    assert.equal(await count('ambient_speaker_consents WHERE profile_id = $1', [p0]), 0);
  });
  await step('seed two owners + rebuild rollups idempotently', async () => {
    await insertProfile(A, P1, 1); await insertProfile(A, P2, 2); await insertProfile(B, P3, 1);
    await pool.query(`INSERT INTO ambient_speaker_consents (owner_sub, profile_id, scope, status, method) VALUES ($1,$2,'transcript','granted','owner_attested')`, [A, P1]);
    await insertSegment(A, seg(1), 'Can you drive me to volleyball practice on Thursday?', P1);
    await insertSegment(A, seg(2), 'Volleyball was great today', P1);
    await insertSegment(A, seg(3), 'I still have homework to finish', P2);
    await insertSegment(A, seg(4), 'unattributed background line', null);
    await insertSegment(B, seg(5), 'Owner B talks about sailing', P3);
    await insertEnrichment(A, seg(1), ['volleyball', 'practice'], 'a ride to practice Thursday', P1);
    await insertEnrichment(A, seg(2), ['volleyball']);
    await insertEnrichment(A, seg(3), ['homework'], 'help with homework', P2);
    await insertEnrichment(B, seg(5), ['sailing'], 'crew for Saturday', P3);
    await pool.query('SELECT pm_rebuild_rollups($1)', [A]); await pool.query('SELECT pm_rebuild_rollups($1)', [B]);
    const snap = async () => (await pool.query(`SELECT profile_id::text, local_date::text, topic, mention_count FROM ambient_person_topic_daily WHERE owner_sub = $1 ORDER BY 1,2,3`, [A])).rows;
    const before = await snap(); const relBefore = await count('ambient_person_relations WHERE owner_sub = $1', [A]);
    const expected = [
      { profile_id: P1, local_date: '2026-09-10', topic: 'practice', mention_count: 1 },
      { profile_id: P1, local_date: '2026-09-10', topic: 'volleyball', mention_count: 2 },
      { profile_id: P2, local_date: '2026-09-10', topic: 'homework', mention_count: 1 },
    ].sort((x, y) => (x.profile_id + x.topic).localeCompare(y.profile_id + y.topic));
    assert.deepEqual(before, expected); assert.equal(relBefore, 3);
    await pool.query('SELECT pm_rebuild_rollups($1)', [A]);
    assert.deepEqual(await snap(), before); assert.equal(await count('ambient_person_relations WHERE owner_sub = $1', [A]), relBefore);
  });
  await step('segment delete removes its chunk + inference rows', async () => {
    assert.equal(await count(`rag_chunks WHERE chunk_id = $1`, [`pm:${seg(2)}`]), 1);
    await pool.query('DELETE FROM ambient_transcript_segments WHERE segment_id = $1', [seg(2)]);
    assert.equal(await count(`rag_chunks WHERE chunk_id = $1`, [`pm:${seg(2)}`]), 0);
    assert.equal(await count('ambient_utterance_enrichment WHERE segment_id = $1', [seg(2)]), 0);
    assert.equal(await count(`rag_chunks WHERE owner_sub = $1 AND collection = 'ambient-recall'`, [A]), 3);
  });
  await step('merge re-points asks + chunk tag and rebuilds rollups in-transaction', async () => {
    // The store's merge (speaker-profile-store.ts applyMerge) re-points the transcripts, then deletes
    // the source profile — the same two statements, minus the encrypted-centroid math it also does.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE ambient_transcript_segments SET speaker_profile_id=$3 WHERE user_sub=$1 AND speaker_profile_id=$2', [A, P2, P1]);
      await c.query('DELETE FROM ambient_speaker_profiles WHERE profile_id=$1 AND owner_sub=$2', [P2, A]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    assert.deepEqual((await pool.query('SELECT profile_id::text FROM ambient_person_asks WHERE segment_id = $1', [seg(3)])).rows, [{ profile_id: P1 }]);
    assert.deepEqual((await pool.query(`SELECT metadata->>'profile_id' AS profile FROM rag_chunks WHERE chunk_id = $1`, [`pm:${seg(3)}`])).rows, [{ profile: P1 }]);
    assert.equal(await count('ambient_person_topic_daily WHERE owner_sub = $1 AND profile_id = $2', [A, P2]), 0);
    assert.equal(await count(`ambient_person_topic_daily WHERE owner_sub = $1 AND profile_id = $2 AND topic = 'homework' AND mention_count = 1`, [A, P1]), 1);
    assert.equal(await count('ambient_utterance_enrichment WHERE segment_id = $1', [seg(3)]), 1);
  });
  await step('forget leaves zero derived rows for the voice, other owner untouched', async () => {
    assert.equal(await new SpeakerProfileStore(pool).deleteProfile(A, P1), true);
    assert.equal(await count('ambient_speaker_consents WHERE owner_sub = $1 AND profile_id = $2', [A, P1]), 0, 'consent cascades with the profile');
    assert.equal(await count('ambient_person_asks WHERE owner_sub = $1', [A]), 0);
    assert.equal(await count('ambient_utterance_enrichment WHERE segment_id = ANY($1::text[])', [[seg(1), seg(3)]]), 0);
    assert.equal(await count(`rag_chunks WHERE owner_sub = $1 AND metadata->>'profile_id' = $2`, [A, P1]), 0);
    assert.equal(await count('ambient_person_topic_daily WHERE owner_sub = $1', [A]), 0);
    assert.equal(await count('ambient_transcript_segments WHERE segment_id = ANY($1::text[]) AND speaker_profile_id IS NULL', [[seg(1), seg(3)]]), 2);
    assert.equal(await count(`rag_chunks WHERE chunk_id = $1`, [`pm:${seg(4)}`]), 1);
    assert.equal(await count('ambient_person_asks WHERE owner_sub = $1', [B]), 1);
    assert.equal(await count('ambient_utterance_enrichment WHERE user_sub = $1', [B]), 1);
    assert.equal(await count(`rag_chunks WHERE owner_sub = $1`, [B]), 1);
    assert.equal(await count('ambient_person_topic_daily WHERE owner_sub = $1', [B]), 1);
  });
  await step('discovered data-lifecycle delete: zero rag_chunks + canon for the sub, other owner survives', async () => {
    const exporters = await discoverSubKeyedExporters(pool, new Set());
    assert.ok(exporters.map((e) => e.store).includes('rag_chunks'));
    const outcomes = await executeDeleteAll(exporters, A);
    assert.equal(outcomes.filter((o) => o.store === 'rag_chunks').length, 1);
    assert.equal(await count(`rag_chunks WHERE owner_sub = $1`, [A]), 0);
    assert.equal(await count('ambient_transcript_segments WHERE user_sub = $1', [A]), 0);
    assert.equal(await count('ambient_speaker_profiles WHERE owner_sub = $1', [A]), 0);
    assert.equal(await count(`rag_chunks WHERE owner_sub = $1`, [B]), 1);
    assert.equal(await count('ambient_transcript_segments WHERE user_sub = $1', [B]), 1);
  });
}

/** @description Drops the scratch database whatever happened, then exits with the gate's verdict. */
async function cleanup(code) {
  try { if (pool) await pool.end(); } catch { /* pool already closed */ }
  try {
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [SCRATCH_DB]);
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
      await admin.end();
    }
  } catch (e) { console.error('cleanup:', e.message); }
  process.exit(code);
}

main().then(() => { console.log(results.join('\n')); console.log('GATE OK'); return cleanup(0); })
  .catch((e) => { console.log(results.join('\n')); console.error('GATE FAILED:', e && e.stack ? e.stack : e); return cleanup(1); });
