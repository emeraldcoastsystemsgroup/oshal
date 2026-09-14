/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 live proof on the DEPLOYED api container: real pgvector engine, real MiniLM embedder, real Postgres, under an isolated synthetic owner (`live-proof-<run>`) that is removed afterwards through the real data-lifecycle discovered delete. Proves the semantic projection + ledger, the exact count kept literal beside paraphrase hits, the Jarvis front door phrasing, the migration-138 triggers on the live database, and a clean owner delete. Never touches the operator's data. Used after both preview deploys of 2026-09-12.
 *
 * Usage (from the repo root, Git Bash):
 *   MSYS_NO_PATHCONV=1 docker cp scripts/person-model-live-proof.js oshal-local-api:/tmp/pm-live.js
 *   docker exec oshal-local-api node /tmp/pm-live.js
 */
'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('/app/node_modules/pg');
const { wrapPoolWithGuc } = require('/app/dist/shared/services/database/guc-pool');
const { runWithSystemIdentity } = require('/app/dist/shared/services/database/request-identity');
const pm = require('/app/dist/features/person-model');
const { discoverSubKeyedExporters } = require('/app/dist/features/data-lifecycle/services/discovered-exporters');
const { executeDeleteAll } = require('/app/dist/features/data-lifecycle/services/exporter-registry');

const RUN = randomUUID().slice(0, 8);
const OWNER = `live-proof-${RUN}`;
const ELLA = randomUUID();
const log = (s) => { console.log(s); };

async function main() {
  const pool = wrapPoolWithGuc(new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }));
  try {
    await runWithSystemIdentity(async () => {
      await pm.ensurePersonModelSchema(pool);
      const count = async (sql, params = []) => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${sql}`, params)).rows[0].n);
      log(`semanticLegAvailable=${await pm.semanticLegAvailable(pool)}`);
      assert.equal(await pm.semanticLegAvailable(pool), true, 'semantic leg must be on for this deployment (RAG_ENGINE=pgvector)');

      // Seed: settings, one named + consented voice, four lines (three about volleyball in different words).
      await pool.query(`INSERT INTO ambient_user_settings (user_sub, ambient_enabled, time_zone) VALUES ($1, TRUE, 'UTC')`, [OWNER]);
      await pool.query(`INSERT INTO ambient_speaker_profiles (profile_id, owner_sub, unidentified_ordinal, embedding_ciphertext, embedding_model, embedding_dimensions) VALUES ($1,$2,1,'live-proof','live-proof',4)`, [ELLA, OWNER]);
      await pool.query(`INSERT INTO ambient_speaker_assignments (profile_id, owner_sub, assignment_kind, custom_name, assigned_by_sub) VALUES ($1,$2,'custom','Ella',$2)`, [ELLA, OWNER]);
      await pool.query(`INSERT INTO ambient_speaker_consents (owner_sub, profile_id, scope, status, method) VALUES ($1,$2,'transcript','granted','owner_attested')`, [OWNER, ELLA]);
      const lines = [
        ['Volleyball practice got moved to Thursday this week', ELLA],
        ['Coach says the net sport tournament is on Saturday morning', ELLA],
        ['I need new knee pads before the next match', ELLA],
        ['Can we order pizza tonight', ELLA],
      ];
      const now = Date.now();
      for (let i = 0; i < lines.length; i += 1) {
        await pool.query(`INSERT INTO ambient_transcript_segments (segment_id, user_sub, transcript_text, captured_at, speaker_profile_id) VALUES ($1,$2,$3,$4,$5)`,
          [`live-${RUN}-${i}`, OWNER, lines[i][0], new Date(now - (lines.length - i) * 60000).toISOString(), lines[i][1]]);
      }

      // Project (real embedder + engine), then read the ledger.
      const written = await pm.projectOwnerSegments(pool, OWNER);
      log(`projected chunks: ${written}`);
      assert.equal(written, 4);
      const ledger = await pm.readProjectionLedger(pool, OWNER);
      log(`ledger: ${JSON.stringify(ledger)}`);
      assert.equal(ledger.projectedRows, 4); assert.equal(ledger.canonRows, 4); assert.equal(ledger.status, 'in-sync');
      assert.equal(await pm.projectOwnerSegments(pool, OWNER), 0, 'second projection is a no-op');

      // Exact leg + related leg: the exact count stays literal, paraphrases arrive separately.
      const intent = { personName: 'Ella', terms: 'volleyball', range: 'all', wantsPlayback: false };
      const exact = await pm.recallQuery(pool, OWNER, intent);
      log(`exact: count=${exact.count} label=${exact.personLabel} receipts=${exact.receipts.map((r) => r.segmentId).join(',')}`);
      assert.equal(exact.count, 1);
      const related = await pm.relatedRecall(pool, OWNER, intent, new Set(exact.receipts.map((r) => r.segmentId)));
      log(`related (${related.length}): ${related.map((r) => `${r.segmentId}:${r.score.toFixed(3)} "${r.quote}"`).join(' | ')}`);
      assert.ok(related.length >= 1, 'semantic leg returned paraphrase hits');
      assert.ok(related.every((r) => !exact.receipts.some((e) => e.segmentId === r.segmentId)), 'related never repeats an exact receipt');
      assert.ok(related.some((r) => /net sport|knee pads/.test(r.quote)), 'a volleyball paraphrase is among the related hits');

      // Jarvis front door phrasing over the same rows (no model turn).
      const answer = await pm.answerPersonModelIntent(pool, OWNER, { kind: 'recall', ...intent });
      log(`front door: ${answer.split('\n')[0]}`);
      assert.match(answer, /Ella was heard about "volleyball" 1 time on record/);
      const asks = await pm.answerPersonModelIntent(pool, OWNER, { kind: 'asks', personName: 'Ella', askKind: 'any' });
      log(`asks: ${asks.slice(0, 80)}`);
      assert.match(asks, /Nothing open from Ella/);

      // Segment delete → chunk purge (migration 138 on the LIVE database).
      await pool.query('DELETE FROM ambient_transcript_segments WHERE segment_id = $1', [`live-${RUN}-3`]);
      assert.equal(await count(`rag_chunks WHERE chunk_id = $1`, [`pm:live-${RUN}-3`]), 0, 'chunk purged by trigger on the live DB');
      const trig = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'pm_%' ORDER BY tgname`);
      log(`live triggers: ${trig.rows.map((r) => r.tgname).join(', ')}`);
      const mig = await pool.query(`SELECT applied_at FROM app_migrations WHERE filename = '138-person-model-parity.sql'`);
      log(`migration 138 recorded: ${mig.rows.length === 1} ${mig.rows[0] ? new Date(mig.rows[0].applied_at).toISOString() : ''}`);
      assert.equal(mig.rows.length, 1, 'migration 138 applied on the live database');
      assert.deepEqual(trig.rows.map((r) => r.tgname), ['pm_profile_deleting', 'pm_segment_deleted', 'pm_segment_repointed', 'pm_segments_repointed_stmt']);

      // Remove the synthetic owner through the real discovered lifecycle delete.
      const exporters = await discoverSubKeyedExporters(pool, new Set());
      await executeDeleteAll(exporters, OWNER);
      for (const t of ['ambient_transcript_segments WHERE user_sub = $1', 'rag_chunks WHERE owner_sub = $1', 'ambient_speaker_profiles WHERE owner_sub = $1', 'ambient_user_settings WHERE user_sub = $1', 'person_model_projections WHERE owner_sub = $1']) {
        assert.equal(await count(t, [OWNER]), 0, `cleanup: ${t}`);
      }
      log('cleanup: zero rows left for the synthetic owner');
    });
    log('LIVE PROOF OK');
  } finally {
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('LIVE PROOF FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
