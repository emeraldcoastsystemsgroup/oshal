/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added opt-in ambient settings, text-only transcript segments, daily reviews, retention metadata, idempotent client segment keys, and forced owner RLS.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added configurable local-time daily review scheduling and follow-up proposal enablement.
 */

-- Ambient capture is deliberately OFF by default. This schema persists finalized text only;
-- there is no raw-audio column. Daily review suggestions are proposals requiring confirmation,
-- not calendar events, reminders, tasks, or any other actuated side effect.

CREATE TABLE IF NOT EXISTS ambient_user_settings (
  user_sub                  TEXT PRIMARY KEY,
  assistant_name            TEXT NOT NULL DEFAULT 'Jarvis',
  wake_phrases              JSONB NOT NULL DEFAULT '["hey jarvis"]'::jsonb,
  ambient_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  transcript_retention_days INTEGER NOT NULL DEFAULT 30
                              CHECK (transcript_retention_days BETWEEN 1 AND 365),
  time_zone                 TEXT NOT NULL DEFAULT 'UTC',
  daily_review_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  daily_review_time         TIME NOT NULL DEFAULT '21:00',
  suggest_follow_ups        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(assistant_name) BETWEEN 1 AND 40),
  CHECK (jsonb_typeof(wake_phrases) = 'array')
);

ALTER TABLE ambient_user_settings
  ADD COLUMN IF NOT EXISTS daily_review_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ambient_user_settings
  ADD COLUMN IF NOT EXISTS daily_review_time TIME NOT NULL DEFAULT '21:00';
ALTER TABLE ambient_user_settings
  ADD COLUMN IF NOT EXISTS suggest_follow_ups BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS ambient_settings_review_due
  ON ambient_user_settings (daily_review_time)
  WHERE ambient_enabled = TRUE AND daily_review_enabled = TRUE;

CREATE TABLE IF NOT EXISTS ambient_transcript_segments (
  segment_id          TEXT PRIMARY KEY,
  user_sub            TEXT NOT NULL,
  transcript_text     TEXT NOT NULL CHECK (char_length(transcript_text) BETWEEN 1 AND 8000),
  captured_at         TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  speaker_label       TEXT,
  wake_phrase_detected BOOLEAN NOT NULL DEFAULT FALSE,
  matched_wake_phrase TEXT,
  session_id          TEXT,
  client_segment_id   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= captured_at)
);

CREATE INDEX IF NOT EXISTS ambient_segments_owner_time
  ON ambient_transcript_segments (user_sub, captured_at DESC);

-- Browser batches may retry after a lost response. A client id makes those retries idempotent
-- without forcing clients that do not yet supply one to fabricate a value.
CREATE UNIQUE INDEX IF NOT EXISTS ambient_segments_owner_client_id
  ON ambient_transcript_segments (user_sub, client_segment_id)
  WHERE client_segment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ambient_daily_reviews (
  review_id            TEXT PRIMARY KEY,
  user_sub             TEXT NOT NULL,
  local_date           DATE NOT NULL,
  time_zone            TEXT NOT NULL,
  summary              TEXT NOT NULL,
  suggestions          JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_segment_count INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_sub, local_date)
);

CREATE INDEX IF NOT EXISTS ambient_reviews_owner_date
  ON ambient_daily_reviews (user_sub, local_date DESC);

ALTER TABLE ambient_user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambient_user_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE ambient_transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambient_transcript_segments FORCE ROW LEVEL SECURITY;
ALTER TABLE ambient_daily_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambient_daily_reviews FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'ambient_user_settings_owner_or_operator'
      AND polrelid = 'ambient_user_settings'::regclass
  ) THEN
    CREATE POLICY ambient_user_settings_owner_or_operator ON ambient_user_settings
      AS PERMISSIVE FOR ALL
      USING (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'ambient_transcript_segments_owner_or_operator'
      AND polrelid = 'ambient_transcript_segments'::regclass
  ) THEN
    CREATE POLICY ambient_transcript_segments_owner_or_operator ON ambient_transcript_segments
      AS PERMISSIVE FOR ALL
      USING (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'ambient_daily_reviews_owner_or_operator'
      AND polrelid = 'ambient_daily_reviews'::regclass
  ) THEN
    CREATE POLICY ambient_daily_reviews_owner_or_operator ON ambient_daily_reviews
      AS PERMISSIVE FOR ALL
      USING (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END
$$;
