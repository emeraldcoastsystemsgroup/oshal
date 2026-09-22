-- ---------------------------------------------------------------------------
-- 153 — a series remembers the SEASON it assembled, not just its episodes
--
-- A multi-episode series produces one artifact none of its episodes is: the
-- season cut, every finished episode stitched end to end in ordinal order.
-- Nothing recorded it, because nothing made it — `advanceVideoSeries` went
-- straight to 'done' the moment the last episode rendered, and the only
-- assembly the pipeline had was per-episode (`episode.assemble`).
--
-- These three columns are where the season lands:
--   season_job_id     the remote task id of the stitch running on the render
--                     node. Set when the dispatch is ACCEPTED, which is also
--                     what stops the 20s reconciler sweep dispatching a second
--                     stitch of the same season on its next pass.
--   season_path       where the finished season cut lives on the render node.
--   season_drive_url  its Drive link — written ONLY when the upload actually
--                     returned one, never inferred. A season that exists only
--                     on the node says exactly that.
--
-- The 'assembling' resting state the conductor parks in while the stitch runs
-- already exists in the video_series status CHECK (066, re-stated by 068), so
-- there is no constraint to widen here.
--
-- All three nullable on purpose: every series created before this migration has
-- no season, and a one-episode series never gets one — a "season" of one is the
-- episode, and paying a stitch to copy it would be a lie about what happened.
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE video_series
  ADD COLUMN IF NOT EXISTS season_job_id    TEXT,
  ADD COLUMN IF NOT EXISTS season_path      TEXT,
  ADD COLUMN IF NOT EXISTS season_drive_url TEXT;

COMMENT ON COLUMN video_series.season_job_id IS
  'Remote-client task id of the season stitch in flight on the render node. NULL = no stitch dispatched.';
COMMENT ON COLUMN video_series.season_path IS
  'Path of the assembled season cut on the render node, written from the node''s SEASON_OK line.';
COMMENT ON COLUMN video_series.season_drive_url IS
  'Drive link of the season cut. NULL when the upload did not return one — never inferred.';
