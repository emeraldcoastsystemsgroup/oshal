-- ---------------------------------------------------------------------------
-- 097 — the joke-shorts pump: enrolled shows + a run ledger
--
-- The video-series conductor (066/067) can walk ONE series from a premise to a
-- finished MP4. What it never had was something to keep asking. These two tables
-- are that: a set of shows the operator has signed up for, and an honest record of
-- every attempt so the thing can be tuned instead of guessed at.
--
--   video_pump_shows — one row per show. Holds the cast bible and the style lock
--   (the two things that keep a cast from drifting between episodes), the joke
--   seeds that stop consecutive episodes being the same joke, and the enrollment
--   itself: enabled, a cadence, a daily cap, and standing_authorization.
--
--   STANDING AUTHORIZATION IS THE WHOLE SAFETY MODEL. The conductor's approval
--   gate is absolute — awaiting_approval never advances on its own — because the
--   step after it costs real money. A pump that auto-approved everything would
--   quietly delete that gate. Instead the operator authorizes A SHOW, ONCE, with a
--   daily cap; the pump may then approve episodes of THAT show up to THAT cap and
--   nothing else. Default is FALSE: an enrolled show with no standing
--   authorization writes its scripts and parks, exactly as a hand-made series does.
--
--   video_pump_runs — one row per attempt, including the ones that never got as
--   far as the node ('skipped', with the gate's reason). "The pump did nothing for
--   six hours because the recap owned the node" has to be readable, or the first
--   quiet night looks identical to a broken pump.
--
-- Both tables are user_sub-keyed and RLS-FORCED, matching video_series/066.
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS video_pump_shows (
  show_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub       TEXT        NOT NULL,
  -- Stable handle from the show library (e.g. 'stupid-superheroes'). One per owner.
  slug           TEXT        NOT NULL,
  title          TEXT        NOT NULL,
  -- The recurring situation. Each episode's premise = this + the next joke seed.
  premise        TEXT        NOT NULL,
  style_lock     TEXT,
  -- The cast bible, as writeSeries expects it: [{ name, description }].
  cast_bible     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Comedic premises, used in order and recycled once exhausted. Empty = the
  -- writer invents one, which is how ten episodes become the same joke.
  joke_seeds     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  seed_cursor    INTEGER     NOT NULL DEFAULT 0 CHECK (seed_cursor >= 0),
  scenes_per_episode INTEGER NOT NULL DEFAULT 4 CHECK (scenes_per_episode BETWEEN 2 AND 10),
  orientation    TEXT        NOT NULL DEFAULT 'Landscape',
  -- The cached intro clip on the render node, prepended at assembly when present.
  intro_clip     TEXT,

  -- ── the enrollment ──
  enabled        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- The operator's one-time go for THIS show's render spend. Default off.
  standing_authorization BOOLEAN NOT NULL DEFAULT FALSE,
  -- Hard ceiling on episodes this show may start per calendar day (node-local).
  daily_cap      INTEGER     NOT NULL DEFAULT 1 CHECK (daily_cap BETWEEN 0 AND 24),
  -- Don't start another episode of this show within this many minutes.
  min_interval_minutes INTEGER NOT NULL DEFAULT 240 CHECK (min_interval_minutes >= 0),

  -- ── tuning state ──
  episodes_made  INTEGER     NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Set when the pump auto-paused the show; enabled stays true so the operator can
  -- see WHY it stopped rather than finding a silently-off switch.
  paused_reason  TEXT,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_pump_shows_owner_slug UNIQUE (user_sub, slug)
);

CREATE INDEX IF NOT EXISTS video_pump_shows_owner_idx ON video_pump_shows (user_sub, enabled);
CREATE INDEX IF NOT EXISTS video_pump_shows_rotation_idx ON video_pump_shows (enabled, last_started_at NULLS FIRST);

CREATE TABLE IF NOT EXISTS video_pump_runs (
  run_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub       TEXT        NOT NULL,
  show_id        UUID        REFERENCES video_pump_shows(show_id) ON DELETE SET NULL,
  show_slug      TEXT,
  -- Set only once the pump actually created them.
  series_id      UUID,
  ticket_id      TEXT,
  episode_title  TEXT,
  joke_seed      TEXT,
  -- skipped  = the gate said no (outcome_reason carries which check)
  -- started   = ticket + series created, scripts being written
  -- scripted  = written and parked (no standing authorization)
  -- rendering = approved and dispatched
  -- delivered = an MP4 the node actually returned
  -- failed    = a stage rejected it
  outcome        TEXT        NOT NULL
                   CHECK (outcome IN ('skipped','started','scripted','rendering','delivered','failed')),
  -- The gate check or the failing stage, in one token ('blackout', 'recap-running', 'write', …).
  outcome_stage  TEXT,
  outcome_reason TEXT,
  drive_url      TEXT,
  duration_ms    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_pump_runs_owner_idx ON video_pump_runs (user_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS video_pump_runs_show_idx  ON video_pump_runs (show_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_pump_runs_series_idx ON video_pump_runs (series_id);

-- ── Row-level security: owner or operator ──────────────────────────────────
-- FORCE is not optional (see 066): the api applies migrations as `oshal_app`, so it
-- OWNS these tables, and a table owner bypasses its own RLS unless FORCE is set.
ALTER TABLE video_pump_shows ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_pump_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_pump_shows FORCE  ROW LEVEL SECURITY;
ALTER TABLE video_pump_runs  FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polname = 'video_pump_shows_owner_or_operator'
      AND polrelid = 'video_pump_shows'::regclass
  ) THEN
    CREATE POLICY video_pump_shows_owner_or_operator ON video_pump_shows
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
    SELECT 1 FROM pg_policy WHERE polname = 'video_pump_runs_owner_or_operator'
      AND polrelid = 'video_pump_runs'::regclass
  ) THEN
    CREATE POLICY video_pump_runs_owner_or_operator ON video_pump_runs
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
