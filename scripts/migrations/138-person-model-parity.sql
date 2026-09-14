/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-100 Phases 3/4 deletion + re-projection parity, enforced IN the database so every segment-delete path (day delete, clear data, retention sweep, privacy erasure) and every profile delete/merge inherits it without cross-slice hooks: (a) an ambient-recall vector chunk dies with its transcript segment; (b) re-pointing a segment's speaker (merge, or the FK SET NULL on forget) re-points its asks and chunk metadata and rebuilds the owner's rollups; (c) forgetting a voice purges the asks, enrichment and chunks derived from it; (d) pm_rebuild_rollups(owner) re-projects topic rollups + mention relations from STORED enrichment rows (pure SQL, no LLM) for the nightly job, the rebuild script and the merge trigger. Bodies are guarded with to_regclass so they work whether or not the lazily-created person-model tables and the pgvector rag_chunks table exist. No top-level BEGIN/COMMIT on purpose: the runner wraps the file in one transaction, so a failure rolls back cleanly instead of leaving partial state.
 */

-- (d) Pure-SQL re-projection of the aggregate stores from canon + stored inferences. Uses the
-- latest taxonomy generation per segment; days are owner-local (ambient_user_settings.time_zone).
CREATE OR REPLACE FUNCTION pm_rebuild_rollups(p_owner TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tz TEXT := 'UTC';
BEGIN
  IF to_regclass('public.ambient_utterance_enrichment') IS NULL
     OR to_regclass('public.ambient_person_topic_daily') IS NULL
     OR to_regclass('public.ambient_person_relations') IS NULL THEN
    RETURN;
  END IF;
  SELECT COALESCE(NULLIF(trim(u.time_zone), ''), 'UTC') INTO tz FROM ambient_user_settings u WHERE u.user_sub = p_owner;
  tz := COALESCE(tz, 'UTC');

  DELETE FROM ambient_person_topic_daily WHERE owner_sub = p_owner;
  INSERT INTO ambient_person_topic_daily (owner_sub, profile_id, local_date, topic, mention_count)
  SELECT s.user_sub, s.speaker_profile_id, (s.captured_at AT TIME ZONE tz)::date, t.topic, COUNT(*)
    FROM (
      SELECT DISTINCT ON (e.segment_id) e.segment_id, e.topics
        FROM ambient_utterance_enrichment e
       WHERE e.user_sub = p_owner
       ORDER BY e.segment_id, e.taxonomy_version DESC
    ) latest
    JOIN ambient_transcript_segments s ON s.segment_id = latest.segment_id
    CROSS JOIN LATERAL jsonb_array_elements_text(latest.topics) AS t(topic)
   WHERE s.user_sub = p_owner AND s.speaker_profile_id IS NOT NULL
   GROUP BY 1, 2, 3, 4;

  DELETE FROM ambient_person_relations WHERE owner_sub = p_owner AND rel_type = 'mentions';
  INSERT INTO ambient_person_relations (owner_sub, from_ref, to_ref, profile_from_id, rel_type, observed_on, segment_id, weight)
  SELECT DISTINCT ON (s.user_sub, s.speaker_profile_id, t.topic, (s.captured_at AT TIME ZONE tz)::date)
         s.user_sub, 'person:' || s.speaker_profile_id::text, 'topic:' || t.topic, s.speaker_profile_id,
         'mentions', (s.captured_at AT TIME ZONE tz)::date, s.segment_id, 1
    FROM (
      SELECT DISTINCT ON (e.segment_id) e.segment_id, e.topics
        FROM ambient_utterance_enrichment e
       WHERE e.user_sub = p_owner
       ORDER BY e.segment_id, e.taxonomy_version DESC
    ) latest
    JOIN ambient_transcript_segments s ON s.segment_id = latest.segment_id
    CROSS JOIN LATERAL jsonb_array_elements_text(latest.topics) AS t(topic)
   WHERE s.user_sub = p_owner AND s.speaker_profile_id IS NOT NULL
   ORDER BY s.user_sub, s.speaker_profile_id, t.topic, (s.captured_at AT TIME ZONE tz)::date, s.captured_at ASC;
END
$$;

-- (a) A semantic chunk never outlives its transcript segment, on any delete path.
CREATE OR REPLACE FUNCTION pm_segment_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.rag_chunks') IS NOT NULL THEN
    DELETE FROM rag_chunks WHERE collection = 'ambient-recall' AND chunk_id = 'pm:' || OLD.segment_id;
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS pm_segment_deleted ON ambient_transcript_segments;
CREATE TRIGGER pm_segment_deleted
  AFTER DELETE ON ambient_transcript_segments
  FOR EACH ROW EXECUTE FUNCTION pm_segment_deleted();

-- (b) Per-row: a segment whose speaker changed (merge re-point, or forget's FK SET NULL) carries its
-- ask and its chunk's profile tag with it; an unattributed segment keeps no ask.
CREATE OR REPLACE FUNCTION pm_segment_repointed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.speaker_profile_id IS NOT DISTINCT FROM OLD.speaker_profile_id THEN
    RETURN NEW;
  END IF;
  IF to_regclass('public.ambient_person_asks') IS NOT NULL THEN
    IF NEW.speaker_profile_id IS NULL THEN
      DELETE FROM ambient_person_asks WHERE owner_sub = NEW.user_sub AND segment_id = NEW.segment_id;
    ELSE
      UPDATE ambient_person_asks SET profile_id = NEW.speaker_profile_id
       WHERE owner_sub = NEW.user_sub AND segment_id = NEW.segment_id;
    END IF;
  END IF;
  IF to_regclass('public.rag_chunks') IS NOT NULL THEN
    UPDATE rag_chunks
       SET metadata = metadata || jsonb_build_object('profile_id', COALESCE(NEW.speaker_profile_id::text, ''))
     WHERE collection = 'ambient-recall' AND chunk_id = 'pm:' || NEW.segment_id;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS pm_segment_repointed ON ambient_transcript_segments;
CREATE TRIGGER pm_segment_repointed
  AFTER UPDATE OF speaker_profile_id ON ambient_transcript_segments
  FOR EACH ROW EXECUTE FUNCTION pm_segment_repointed();

-- (b) Per-statement: the aggregate stores converge in the same transaction as the re-point.
CREATE OR REPLACE FUNCTION pm_segments_repointed_stmt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner TEXT;
BEGIN
  FOR owner IN
    SELECT DISTINCT n.user_sub
      FROM moved n JOIN removed o ON o.segment_id = n.segment_id
     WHERE n.speaker_profile_id IS DISTINCT FROM o.speaker_profile_id
  LOOP
    PERFORM pm_rebuild_rollups(owner);
  END LOOP;
  RETURN NULL;
END
$$;
-- Postgres refuses transition tables on a trigger with a column list, so this fires on every UPDATE
-- statement and the function filters to rows whose speaker actually changed (cheap: one join over
-- the transition tables, no work when nothing moved).
DROP TRIGGER IF EXISTS pm_segments_repointed_stmt ON ambient_transcript_segments;
CREATE TRIGGER pm_segments_repointed_stmt
  AFTER UPDATE ON ambient_transcript_segments
  REFERENCING OLD TABLE AS removed NEW TABLE AS moved
  FOR EACH STATEMENT EXECUTE FUNCTION pm_segments_repointed_stmt();

-- (c) Forgetting a voice leaves zero derived rows for it. Runs BEFORE the delete so the enrichment
-- join still sees the attribution the FK is about to null out. (topic_daily, relations and consents
-- already CASCADE on the profile FK.) A merge re-points segments first, so this finds nothing then.
CREATE OR REPLACE FUNCTION pm_profile_deleting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.ambient_utterance_enrichment') IS NOT NULL THEN
    DELETE FROM ambient_utterance_enrichment e
     USING ambient_transcript_segments s
     WHERE e.segment_id = s.segment_id AND s.user_sub = OLD.owner_sub AND s.speaker_profile_id = OLD.profile_id;
  END IF;
  IF to_regclass('public.ambient_person_asks') IS NOT NULL THEN
    DELETE FROM ambient_person_asks WHERE owner_sub = OLD.owner_sub AND profile_id = OLD.profile_id;
  END IF;
  IF to_regclass('public.rag_chunks') IS NOT NULL THEN
    DELETE FROM rag_chunks
     WHERE collection = 'ambient-recall' AND owner_sub = OLD.owner_sub AND metadata->>'profile_id' = OLD.profile_id::text;
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS pm_profile_deleting ON ambient_speaker_profiles;
CREATE TRIGGER pm_profile_deleting
  BEFORE DELETE ON ambient_speaker_profiles
  FOR EACH ROW EXECUTE FUNCTION pm_profile_deleting();

-- Owner-scoped lookups and the anti-join backstop over the semantic leg (pgvector deployments only).
DO $$
BEGIN
  IF to_regclass('public.rag_chunks') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS rag_chunks_ambient_recall_owner_idx
      ON rag_chunks (owner_sub, chunk_id) WHERE collection = 'ambient-recall';
  END IF;
END
$$;
