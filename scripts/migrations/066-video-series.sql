-- ===========================================================================
-- 066-video-series.sql
-- Video Studio SERIES: a user-described series, its episodes, and the render
-- state of each episode.
--
-- WHY THIS TABLE EXISTS (and why it is not optional)
--   The `video-series` ticket runs as a multi-stage graph workflow:
--       screenplay-writer -> (script approval) -> vids-operator -> post-production
--   The ProcessDefinitionExecutionEngine walks those nodes sequentially, but it
--   DISCARDS each bot's reply: EngineServicesAdapter.runExecution returns only
--   { dispatched, agentId }, and every execute-agent node rebuilds its prompt
--   from the ORIGINAL ticket (buildTicketContext reads only state.ticket).
--   So nothing a stage produces can reach the next stage through the graph.
--
--   These tables ARE the hand-off. The screenplay-writer writes episode scripts
--   here; the vids-operator reads them, renders each on the remote Vids node,
--   and writes back the clip paths; post-production reads those and writes the
--   assembled MP4. Every stage is keyed by ticket_id, so a resumed or retried
--   run picks up exactly where it stopped instead of re-rendering (which is how
--   a night of Veo credits got burned).
--
-- OWNERSHIP
--   user_sub-keyed, RLS-enforced (ADR-060 / ADR-076): a user sees only their own
--   series. The operator GUC (oshal.is_operator = 'on') sees all, matching the
--   shape used by workspaces_owner_or_operator in 052.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS video_series (
  series_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub         TEXT        NOT NULL,
  ticket_id        TEXT,
  title            TEXT        NOT NULL,
  premise          TEXT        NOT NULL,
  -- The style lock + cast table. The renderer's speaker-pointer resolution
  -- depends on each character's description; see the persona's hard rules.
  style_lock       TEXT,
  cast_bible       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  episode_count    INTEGER     NOT NULL DEFAULT 1 CHECK (episode_count BETWEEN 1 AND 20),
  scenes_per_episode INTEGER   NOT NULL DEFAULT 4 CHECK (scenes_per_episode BETWEEN 2 AND 10),
  orientation      TEXT        NOT NULL DEFAULT 'Landscape',
  -- The character-consistency anchor: one reference frame reused by every
  -- episode. Losing it is what makes a cast drift between episodes.
  character_image_path TEXT,
  status           TEXT        NOT NULL DEFAULT 'scripting'
                     CHECK (status IN ('scripting','awaiting_approval','rendering','assembling','done','failed')),
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_series_user_idx   ON video_series (user_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS video_series_ticket_idx ON video_series (ticket_id);

CREATE TABLE IF NOT EXISTS video_episodes (
  episode_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id    UUID NOT NULL REFERENCES video_series(series_id) ON DELETE CASCADE,
  user_sub     TEXT NOT NULL,
  ordinal      INTEGER NOT NULL CHECK (ordinal >= 1),
  title        TEXT NOT NULL,
  logline      TEXT,
  -- The renderable pack, exactly as pack-import.js parses it. Written by the
  -- screenplay-writer, read by the vids-operator stage.
  script_md    TEXT,
  animation_md TEXT,
  image_prompts_md TEXT,
  -- Set by the render stage.
  vids_job_id  TEXT,
  clip_paths   JSONB NOT NULL DEFAULT '[]'::jsonb,
  mp4_path     TEXT,
  drive_url    TEXT,
  -- Set by post-production.
  assembled_path TEXT,
  status       TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','scripted','rendering','rendered','assembled','failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series_id, ordinal)
);

CREATE INDEX IF NOT EXISTS video_episodes_series_idx ON video_episodes (series_id, ordinal);
CREATE INDEX IF NOT EXISTS video_episodes_user_idx   ON video_episodes (user_sub);
CREATE INDEX IF NOT EXISTS video_episodes_status_idx ON video_episodes (status);

-- ── Row-level security: owner or operator ──────────────────────────────────
-- FORCE is not optional. The api applies migrations as `oshal_app`, so these tables are OWNED by
-- oshal_app — and in Postgres a table's owner BYPASSES its own row-level security unless FORCE is
-- set. Without it, ENABLE + a policy looks correct, passes review, and enforces nothing: the app
-- role reads every user's rows and can insert a row owned by someone else. Caught live 2026-07-08
-- by querying as oshal_app with no GUC (2 rows visible) and inserting a row for another user
-- (accepted). Every one of the platform's other 89 RLS tables sets FORCE; see 052 and 060.
ALTER TABLE video_series   ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_series   FORCE  ROW LEVEL SECURITY;
ALTER TABLE video_episodes FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polname = 'video_series_owner_or_operator'
      AND polrelid = 'video_series'::regclass
  ) THEN
    CREATE POLICY video_series_owner_or_operator ON video_series
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
    SELECT 1 FROM pg_policy WHERE polname = 'video_episodes_owner_or_operator'
      AND polrelid = 'video_episodes'::regclass
  ) THEN
    CREATE POLICY video_episodes_owner_or_operator ON video_episodes
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
