/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: person-model schema — a generated tsvector FTS column on ambient_transcript_segments (exact recall leg) plus the versioned inference/asks/rollup/relations/consent tables beside the ambient canon, all owner-RLS'd, segment-FK CASCADE for deletion parity, and an append-only trigger on the consent ledger.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the lazy-DDL schema apply in runWithSystemIdentity — the chokepoint is often first hit with no request in scope; the global DDL must stamp operator under OSHAL_DB_GUC_STRICT=deny (guc warn-audit site).
 */

import type { Pool } from 'pg';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'person-model-schema' });

/**
 * @description The idempotent DDL for the ambient Person Model. Canon stays the existing
 * ambient/speaker tables; everything here is either an exact-recall index over that canon
 * (the generated tsvector column) or a derived, versioned, deletable inference layer that
 * CASCADE-deletes with its source transcript segment. Every owned table gets owner-RLS and
 * is discovered automatically by the data-lifecycle export/delete sweep via its ownership column.
 * @returns Ordered idempotent SQL statements safe to run at every boot.
 */
export function personModelSchemaStatements(): string[] {
  return [
    // Exact-recall leg: a stored generated tsvector over the canonical transcript text. GIN index
    // makes `fts @@ websearch_to_tsquery(...)` the count-true path — recall is never a model guess.
    `ALTER TABLE ambient_transcript_segments
       ADD COLUMN IF NOT EXISTS fts tsvector
       GENERATED ALWAYS AS (to_tsvector('english', transcript_text)) STORED`,
    'CREATE INDEX IF NOT EXISTS ambient_segments_fts ON ambient_transcript_segments USING GIN (fts)',

    // Versioned inference layer beside canon — a taxonomy revision creates a new generation rather
    // than silently overwriting. CASCADE from the transcript segment guarantees no inference outlives
    // the text it was derived from.
    `CREATE TABLE IF NOT EXISTS ambient_utterance_enrichment (
       segment_id TEXT NOT NULL REFERENCES ambient_transcript_segments(segment_id) ON DELETE CASCADE,
       user_sub TEXT NOT NULL,
       topics JSONB NOT NULL DEFAULT '[]'::jsonb,
       tone TEXT, intent TEXT, ask_text TEXT, commitment_text TEXT,
       confidence DOUBLE PRECISION, model TEXT,
       taxonomy_version INTEGER NOT NULL DEFAULT 1,
       is_inference BOOLEAN NOT NULL DEFAULT TRUE,
       enriched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (segment_id, taxonomy_version))`,
    'CREATE INDEX IF NOT EXISTS person_enrichment_owner_time ON ambient_utterance_enrichment (user_sub, enriched_at)',
    'CREATE INDEX IF NOT EXISTS person_enrichment_topics ON ambient_utterance_enrichment USING GIN (topics)',
    // Taxonomy v1 (ADR-100 §3): closed tone/intent sets enforced in the DB, so a drifted analyst
    // reply can never persist an out-of-taxonomy label. Added if-absent (the table starts empty).
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='person_enrichment_tone_chk') THEN
         ALTER TABLE ambient_utterance_enrichment ADD CONSTRAINT person_enrichment_tone_chk
           CHECK (tone IS NULL OR tone IN ('neutral','warm','excited','frustrated','upset','urgent','humorous','tired'));
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='person_enrichment_intent_chk') THEN
         ALTER TABLE ambient_utterance_enrichment ADD CONSTRAINT person_enrichment_intent_chk
           CHECK (intent IS NULL OR intent IN ('inform','question','ask_request','commit','plan','recall','vent','banter'));
       END IF;
     END $$`,

    // Follow-up ledger with provenance. Extraction is derived; status is canonical USER state — a
    // rebuild upserts on dedupe_key and never touches status. source_quote keeps the verbatim line so
    // an extracted ask is always shown beside what was actually said.
    `CREATE TABLE IF NOT EXISTS ambient_person_asks (
       ask_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       owner_sub TEXT NOT NULL,
       profile_id UUID NOT NULL,
       segment_id TEXT NOT NULL REFERENCES ambient_transcript_segments(segment_id) ON DELETE CASCADE,
       kind TEXT NOT NULL CHECK (kind IN ('ask','commitment')),
       text TEXT NOT NULL, source_quote TEXT NOT NULL,
       model TEXT, confidence DOUBLE PRECISION,
       is_inference BOOLEAN NOT NULL DEFAULT TRUE,
       dedupe_key TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ,
       UNIQUE (owner_sub, dedupe_key))`,
    'CREATE INDEX IF NOT EXISTS person_asks_owner_profile ON ambient_person_asks (owner_sub, profile_id, status)',

    // Pure-SQL trend rollup, retention-bounded by the owner's transcript_retention_days sweep.
    `CREATE TABLE IF NOT EXISTS ambient_person_topic_daily (
       owner_sub TEXT NOT NULL,
       profile_id UUID NOT NULL REFERENCES ambient_speaker_profiles(profile_id) ON DELETE CASCADE,
       local_date DATE NOT NULL, topic TEXT NOT NULL,
       mention_count INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (owner_sub, profile_id, local_date, topic))`,

    // The temporal graph, relationally emulated — append-only dated occurrences. Two-hop questions
    // ("topics connecting Ella and Sam") are one self-join. Retention-bounded like topic_daily.
    `CREATE TABLE IF NOT EXISTS ambient_person_relations (
       owner_sub TEXT NOT NULL,
       from_ref TEXT NOT NULL, to_ref TEXT NOT NULL,
       profile_from_id UUID REFERENCES ambient_speaker_profiles(profile_id) ON DELETE CASCADE,
       profile_to_id UUID REFERENCES ambient_speaker_profiles(profile_id) ON DELETE CASCADE,
       rel_type TEXT NOT NULL CHECK (rel_type IN ('mentions','co_present','asked_about')),
       observed_on DATE NOT NULL,
       session_id TEXT,
       segment_id TEXT REFERENCES ambient_transcript_segments(segment_id) ON DELETE CASCADE,
       weight DOUBLE PRECISION NOT NULL DEFAULT 1,
       PRIMARY KEY (owner_sub, from_ref, to_ref, rel_type, observed_on))`,
    'CREATE INDEX IF NOT EXISTS person_relations_owner_from ON ambient_person_relations (owner_sub, from_ref, rel_type, observed_on DESC)',

    // Per-heard-person notice/consent ledger (Phase 2 gating). Append-only: the latest row per
    // (profile, scope) is current. Deliberately no audio_clip scope — clip retention is rejected.
    `CREATE TABLE IF NOT EXISTS ambient_speaker_consents (
       consent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       owner_sub TEXT NOT NULL,
       profile_id UUID NOT NULL REFERENCES ambient_speaker_profiles(profile_id) ON DELETE CASCADE,
       scope TEXT NOT NULL CHECK (scope IN ('transcript','voiceprint')),
       status TEXT NOT NULL CHECK (status IN ('granted','declined','revoked')),
       is_minor BOOLEAN NOT NULL DEFAULT FALSE,
       method TEXT NOT NULL CHECK (method IN ('in_app','owner_attested','written')),
       evidence_segment_id TEXT REFERENCES ambient_transcript_segments(segment_id) ON DELETE SET NULL,
       recorded_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    'CREATE INDEX IF NOT EXISTS person_consents_owner_profile ON ambient_speaker_consents (owner_sub, profile_id, scope, recorded_at DESC)',
    // Append-only enforcement: a recorded consent decision can never be FLIPPED — status changes are
    // appends and the gate reads the latest row, so a decline can't be silently reversed by rewriting
    // it. UPDATE is blocked; DELETE is deliberately allowed so a profile-delete cascade and full
    // account deletion (person/account forgotten) stay clean. Created if-absent (never CREATE OR
    // REPLACE) so a re-run under the least-privilege app role never fails on a function it does not own.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='ambient_speaker_consents_no_flip') THEN
         CREATE FUNCTION ambient_speaker_consents_no_flip() RETURNS trigger AS $fn$
           BEGIN RAISE EXCEPTION 'ambient_speaker_consents is append-only (record a new row to change a decision)'; END; $fn$ LANGUAGE plpgsql;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='ambient_speaker_consents_no_mutate') THEN
         CREATE TRIGGER ambient_speaker_consents_no_mutate
           BEFORE UPDATE ON ambient_speaker_consents
           FOR EACH ROW EXECUTE FUNCTION ambient_speaker_consents_no_flip();
       END IF;
     END $$`,

    // Drift ledger — the one derived index (vectors, Phase 3) will have its freshness accounted, not
    // assumed. Present from Phase 1 so the accounting table exists before the projection does.
    `CREATE TABLE IF NOT EXISTS person_model_projections (
       owner_sub TEXT NOT NULL, store TEXT NOT NULL CHECK (store IN ('vector')),
       watermark_captured_at TIMESTAMPTZ, canon_rows INTEGER, projected_rows INTEGER,
       last_rebuild_at TIMESTAMPTZ, status TEXT,
       PRIMARY KEY (owner_sub, store))`,

    ...buildOwnerRlsPolicyStatements('ambient_utterance_enrichment', 'user_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_person_asks', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_person_topic_daily', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_person_relations', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_speaker_consents', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('person_model_projections', 'owner_sub'),
  ];
}

let schemaPromise: Promise<void> | null = null;

/**
 * @description Applies the person-model schema once per process at the lazy-DDL chokepoint, mirroring
 * the ambient service's fresh-boot pattern so a table is never policy-less. Idempotent and safe to
 * call before every query; failure clears the memo so a later call retries.
 * @param pool - Shared GUC-aware Postgres pool.
 * @returns Void once the schema is present.
 */
export async function ensurePersonModelSchema(pool: Pool): Promise<void> {
  if (!schemaPromise) {
    // Lazy-DDL chokepoint, often first hit with no request in scope — run the schema DDL as
    // trusted SYSTEM so it stamps operator under OSHAL_DB_GUC_STRICT=deny (DDL is global; an
    // identity-less connection would otherwise be RLS-scoped to nothing).
    schemaPromise = runWithSystemIdentity(() => (async () => {
      for (const statement of personModelSchemaStatements()) {
        await pool.query(statement);
      }
      logger.info({ operation: 'ensurePersonModelSchema' }, 'person-model schema ensured');
    })()).catch((error: unknown) => {
      schemaPromise = null;
      logger.error({ err: error, operation: 'ensurePersonModelSchema' }, 'person-model schema bootstrap failed');
      throw error;
    });
  }
  await schemaPromise;
}
