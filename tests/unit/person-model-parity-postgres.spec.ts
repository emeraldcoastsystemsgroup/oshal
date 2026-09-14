/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phases 2-4 real-Postgres gate on a scratch database created for the run: (1) the fresh-database enable gate — the full migration chain, then the lazy person-model DDL twice (every object once, rerun changes nothing, consent ledger refuses UPDATE but stays DELETE-clean); (2) deletion/re-projection parity through the migration-138 triggers — a segment delete removes its ambient-recall chunk, a merge re-points asks + chunk tags and rebuilds rollups in the same transaction, forgetting a voice leaves zero derived rows, and the discovered data-lifecycle delete leaves zero rag_chunks rows for the sub while the other owner survives; (3) rebuild idempotency. Fails LOUDLY without a live Postgres — a skipping guard is no guard.
 */

import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseBootstrapService } from '@/features/tool-registry';
import { personModelSchemaStatements } from '@/features/person-model';
import { SpeakerProfileStore } from '@/features/speaker-diarization';
import { discoverSubKeyedExporters, executeDeleteAll } from '@/features/data-lifecycle';

const ADMIN_DSN = process.env.PERSON_MODEL_TEST_DSN ?? process.env.TEST_DATABASE_URL
  ?? `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = randomUUID().slice(0, 8);
const SCRATCH_DB = `pm_gate_${RUN}`;
const A = `spec-adr100-${RUN}-a`;
const B = `spec-adr100-${RUN}-b`;
const P1 = randomUUID();
const P2 = randomUUID();
const P3 = randomUUID();
const AT = '2026-09-10T15:00:00.000Z';
const seg = (n: number): string => `seg-${RUN}-${n}`;
const safeDsn = (dsn: string): string => dsn.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');

let admin: Pool;
let pool: Pool;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${sql}`, params);
  return Number(rows[0].n);
}

async function inventory(): Promise<Record<string, number>> {
  const n = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].n);
  return {
    tables: await n(`SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = 'public'`),
    triggers: await n(`SELECT COUNT(*) n FROM pg_trigger WHERE NOT tgisinternal`),
    functions: await n(`SELECT COUNT(*) n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public'`),
    indexes: await n(`SELECT COUNT(*) n FROM pg_indexes WHERE schemaname = 'public'`),
    policies: await n(`SELECT COUNT(*) n FROM pg_policies WHERE schemaname = 'public'`),
    segmentColumns: await n(`SELECT COUNT(*) n FROM information_schema.columns WHERE table_name = 'ambient_transcript_segments'`),
  };
}

async function applyLazyDdl(): Promise<void> {
  for (const statement of personModelSchemaStatements()) await pool.query(statement);
}

async function insertProfile(owner: string, id: string, ordinal: number): Promise<void> {
  await pool.query(
    `INSERT INTO ambient_speaker_profiles (profile_id, owner_sub, unidentified_ordinal, embedding_ciphertext, embedding_model, embedding_dimensions)
     VALUES ($1, $2, $3, 'spec-ciphertext', 'spec-model', 4)`,
    [id, owner, ordinal],
  );
}

async function insertSegment(owner: string, id: string, text: string, profile: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO ambient_transcript_segments (segment_id, user_sub, transcript_text, captured_at, speaker_profile_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, owner, text, AT, profile],
  );
  await pool.query(
    `INSERT INTO rag_chunks (chunk_id, collection, document, metadata, owner_sub) VALUES ($1, 'ambient-recall', $2, $3::jsonb, $4)`,
    [`pm:${id}`, text, JSON.stringify({ owner_sub: owner, profile_id: profile ?? '', segment_id: id, captured_at: AT }), owner],
  );
}

async function insertEnrichment(owner: string, id: string, topics: string[], askText?: string, profile?: string): Promise<void> {
  await pool.query(
    `INSERT INTO ambient_utterance_enrichment (segment_id, user_sub, topics, tone, intent, taxonomy_version)
     VALUES ($1, $2, $3::jsonb, 'neutral', 'inform', 1)`,
    [id, owner, JSON.stringify(topics)],
  );
  if (askText && profile) {
    await pool.query(
      `INSERT INTO ambient_person_asks (owner_sub, profile_id, segment_id, kind, text, source_quote, dedupe_key)
       VALUES ($1, $2, $3, 'ask', $4, $4, $5)`,
      [owner, profile, id, askText, `${id}|ask`],
    );
  }
}

describe('person-model fresh-database gate + deletion/re-projection parity (ADR-100, migration 138)', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_DSN, max: 2 });
    // Fail LOUDLY rather than skipping — a guard that quietly disappears when the database is absent
    // is exactly how a parity defect reaches a deploy.
    await admin.query('SELECT 1').catch((err: Error) => {
      throw new Error(`person-model parity gate needs a live Postgres at ${safeDsn(ADMIN_DSN)} — ${err.message}. Start the stack (bash scripts/oshal-up.sh) or set PERSON_MODEL_TEST_DSN.`);
    });
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const url = new URL(ADMIN_DSN);
    url.pathname = `/${SCRATCH_DB}`;
    pool = new Pool({ connectionString: url.toString(), max: 4 });
    process.env.RUN_MIGRATIONS = 'true';
    delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    const applied = await new DatabaseBootstrapService(pool, resolve(__dirname, '..', '..', 'scripts', 'migrations')).applyMigrations();
    expect(applied).toContain('138-person-model-parity.sql');
    expect(applied).toContain('070-rag-chunks-pgvector.sql');
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [SCRATCH_DB]).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`).catch(() => undefined);
      await admin.end();
    }
  }, 60_000);

  it('applies the lazy person-model DDL on the freshly migrated database, and a rerun changes nothing', async () => {
    const { rows: rag } = await pool.query(`SELECT to_regclass('public.rag_chunks') IS NOT NULL AS present`);
    expect(rag[0].present, 'this image ships pgvector (migration 070 must not self-skip)').toBe(true);
    await applyLazyDdl();
    const first = await inventory();
    for (const table of ['ambient_utterance_enrichment', 'ambient_person_asks', 'ambient_person_topic_daily', 'ambient_person_relations', 'ambient_speaker_consents', 'person_model_projections']) {
      expect(await count(`information_schema.tables WHERE table_name = $1`, [table]), table).toBe(1);
    }
    const { rows: triggers } = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'pm_%' ORDER BY tgname`);
    expect(triggers.map((t) => t.tgname)).toEqual(['pm_profile_deleting', 'pm_segment_deleted', 'pm_segment_repointed', 'pm_segments_repointed_stmt']);
    await applyLazyDdl();
    expect(await inventory()).toEqual(first);
  }, 60_000);

  it('converges a consent trigger created under the earlier BEFORE DELETE OR UPDATE definition', async () => {
    // A deployment whose lazy DDL first ran in July 2026 carries this trigger shape; the by-name
    // IF NOT EXISTS guard kept it, and forgetting a consented voice then failed with "append-only".
    await pool.query('DROP TRIGGER IF EXISTS ambient_speaker_consents_no_mutate ON ambient_speaker_consents');
    await pool.query(`CREATE OR REPLACE FUNCTION ambient_speaker_consents_append_only() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'ambient_speaker_consents is append-only'; END; $fn$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER ambient_speaker_consents_no_mutate BEFORE DELETE OR UPDATE ON ambient_speaker_consents
      FOR EACH ROW EXECUTE FUNCTION ambient_speaker_consents_append_only()`);
    const legacy = await pool.query(`SELECT tgtype FROM pg_trigger WHERE tgname = 'ambient_speaker_consents_no_mutate'`);
    expect(Number(legacy.rows[0].tgtype) & 8, 'legacy trigger blocks DELETE').not.toBe(0);
    await applyLazyDdl();
    const converged = await pool.query(`SELECT tgtype, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'ambient_speaker_consents_no_mutate'`);
    expect(converged.rows).toHaveLength(1);
    expect(Number(converged.rows[0].tgtype) & 8, 'DELETE no longer blocked').toBe(0);
    expect(String(converged.rows[0].def)).toContain('BEFORE UPDATE ON');
    expect(String(converged.rows[0].def)).toContain('ambient_speaker_consents_no_flip()');
  });

  it('keeps the consent ledger append-only for UPDATE while DELETE stays cascade-clean', async () => {
    const p0 = randomUUID();
    await insertProfile(A, p0, 99);
    await pool.query(`INSERT INTO ambient_speaker_consents (owner_sub, profile_id, scope, status, method) VALUES ($1, $2, 'transcript', 'granted', 'owner_attested')`, [A, p0]);
    await expect(pool.query(`UPDATE ambient_speaker_consents SET status = 'declined' WHERE profile_id = $1`, [p0])).rejects.toThrow(/append-only/);
    await pool.query('DELETE FROM ambient_speaker_profiles WHERE profile_id = $1', [p0]);
    expect(await count('ambient_speaker_consents WHERE profile_id = $1', [p0])).toBe(0);
  });

  it('seeds two owners (canon + stored inferences + chunks) and rebuilds rollups idempotently', async () => {
    await insertProfile(A, P1, 1);
    await insertProfile(A, P2, 2);
    await insertProfile(B, P3, 1);
    // A recorded consent on the voice that will later be forgotten — the live-box failure shape.
    await pool.query(`INSERT INTO ambient_speaker_consents (owner_sub, profile_id, scope, status, method) VALUES ($1, $2, 'transcript', 'granted', 'owner_attested')`, [A, P1]);
    await insertSegment(A, seg(1), 'Can you drive me to volleyball practice on Thursday?', P1);
    await insertSegment(A, seg(2), 'Volleyball was great today', P1);
    await insertSegment(A, seg(3), 'I still have homework to finish', P2);
    await insertSegment(A, seg(4), 'unattributed background line', null);
    await insertSegment(B, seg(5), 'Owner B talks about sailing', P3);
    await insertEnrichment(A, seg(1), ['volleyball', 'practice'], 'a ride to practice Thursday', P1);
    await insertEnrichment(A, seg(2), ['volleyball']);
    await insertEnrichment(A, seg(3), ['homework'], 'help with homework', P2);
    await insertEnrichment(B, seg(5), ['sailing'], 'crew for Saturday', P3);

    await pool.query('SELECT pm_rebuild_rollups($1)', [A]);
    await pool.query('SELECT pm_rebuild_rollups($1)', [B]);
    const snapshot = async (): Promise<unknown[]> => (await pool.query(
      `SELECT profile_id::text, local_date::text, topic, mention_count FROM ambient_person_topic_daily WHERE owner_sub = $1 ORDER BY 1, 2, 3`, [A],
    )).rows;
    const relations = async (): Promise<number> => count('ambient_person_relations WHERE owner_sub = $1', [A]);
    const before = await snapshot();
    const relBefore = await relations();
    expect(before).toEqual([
      { profile_id: P1, local_date: '2026-09-10', topic: 'practice', mention_count: 1 },
      { profile_id: P1, local_date: '2026-09-10', topic: 'volleyball', mention_count: 2 },
      { profile_id: P2, local_date: '2026-09-10', topic: 'homework', mention_count: 1 },
    ].sort((x, y) => (x.profile_id + x.topic).localeCompare(y.profile_id + y.topic)));
    expect(relBefore).toBe(3);
    await pool.query('SELECT pm_rebuild_rollups($1)', [A]);
    expect(await snapshot()).toEqual(before);
    expect(await relations()).toBe(relBefore);
  });

  it('deleting a segment removes its ambient-recall chunk and its inference rows', async () => {
    expect(await count(`rag_chunks WHERE chunk_id = $1`, [`pm:${seg(2)}`])).toBe(1);
    await pool.query('DELETE FROM ambient_transcript_segments WHERE segment_id = $1', [seg(2)]);
    expect(await count(`rag_chunks WHERE chunk_id = $1`, [`pm:${seg(2)}`])).toBe(0);
    expect(await count('ambient_utterance_enrichment WHERE segment_id = $1', [seg(2)])).toBe(0);
    expect(await count(`rag_chunks WHERE owner_sub = $1 AND collection = 'ambient-recall'`, [A])).toBe(3);
  });

  it('merging a voice re-points its asks and chunk tags and rebuilds the rollups in the same transaction', async () => {
    // The store's merge (speaker-profile-store.ts applyMerge) re-points the transcripts, then deletes
    // the source profile — the same two statements, minus the encrypted-centroid math it also does.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE ambient_transcript_segments SET speaker_profile_id=$3 WHERE user_sub=$1 AND speaker_profile_id=$2', [A, P2, P1]);
      await client.query('DELETE FROM ambient_speaker_profiles WHERE profile_id=$1 AND owner_sub=$2', [P2, A]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const { rows: asks } = await pool.query('SELECT profile_id::text FROM ambient_person_asks WHERE segment_id = $1', [seg(3)]);
    expect(asks).toEqual([{ profile_id: P1 }]);
    const { rows: chunk } = await pool.query(`SELECT metadata->>'profile_id' AS profile FROM rag_chunks WHERE chunk_id = $1`, [`pm:${seg(3)}`]);
    expect(chunk).toEqual([{ profile: P1 }]);
    expect(await count('ambient_person_topic_daily WHERE owner_sub = $1 AND profile_id = $2', [A, P2])).toBe(0);
    expect(await count(`ambient_person_topic_daily WHERE owner_sub = $1 AND profile_id = $2 AND topic = 'homework' AND mention_count = 1`, [A, P1])).toBe(1);
    expect(await count('ambient_utterance_enrichment WHERE segment_id = $1', [seg(3)])).toBe(1);
  });

  it('forgetting a voice leaves zero derived rows for it and untouched rows for everyone else', async () => {
    expect(await new SpeakerProfileStore(pool).deleteProfile(A, P1)).toBe(true);
    expect(await count('ambient_speaker_consents WHERE owner_sub = $1 AND profile_id = $2', [A, P1]), 'consent cascades with the profile').toBe(0);
    expect(await count('ambient_person_asks WHERE owner_sub = $1 AND profile_id = $2', [A, P1])).toBe(0);
    expect(await count('ambient_person_asks WHERE owner_sub = $1', [A])).toBe(0);
    expect(await count('ambient_utterance_enrichment WHERE segment_id = ANY($1::text[])', [[seg(1), seg(3)]])).toBe(0);
    expect(await count(`rag_chunks WHERE owner_sub = $1 AND metadata->>'profile_id' = $2`, [A, P1])).toBe(0);
    expect(await count('ambient_person_topic_daily WHERE owner_sub = $1', [A])).toBe(0);
    expect(await count('ambient_transcript_segments WHERE segment_id = ANY($1::text[]) AND speaker_profile_id IS NULL', [[seg(1), seg(3)]])).toBe(2);
    // The unattributed line and its chunk are canon, not derived — they stay.
    expect(await count(`rag_chunks WHERE chunk_id = $1`, [`pm:${seg(4)}`])).toBe(1);
    // Owner B is untouched.
    expect(await count('ambient_person_asks WHERE owner_sub = $1', [B])).toBe(1);
    expect(await count('ambient_utterance_enrichment WHERE user_sub = $1', [B])).toBe(1);
    expect(await count(`rag_chunks WHERE owner_sub = $1`, [B])).toBe(1);
    expect(await count('ambient_person_topic_daily WHERE owner_sub = $1', [B])).toBe(1);
  });

  it('a discovered data-lifecycle delete leaves zero rag_chunks (and canon) rows for the sub, and the other owner survives', async () => {
    const exporters = await discoverSubKeyedExporters(pool, new Set());
    expect(exporters.map((e) => e.store)).toContain('rag_chunks');
    const outcomes = await executeDeleteAll(exporters, A);
    expect(outcomes.filter((o) => o.store === 'rag_chunks')).toHaveLength(1);
    expect(await count(`rag_chunks WHERE owner_sub = $1`, [A])).toBe(0);
    expect(await count('ambient_transcript_segments WHERE user_sub = $1', [A])).toBe(0);
    expect(await count('ambient_speaker_profiles WHERE owner_sub = $1', [A])).toBe(0);
    expect(await count(`rag_chunks WHERE owner_sub = $1`, [B])).toBe(1);
    expect(await count('ambient_transcript_segments WHERE user_sub = $1', [B])).toBe(1);
  }, 60_000);
});
