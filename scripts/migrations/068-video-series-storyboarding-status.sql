-- ===========================================================================
-- 068-video-series-storyboarding-status.sql
-- Add the 'storyboarding' resting state to video_series.
--
-- WHY
--   The orchestrator (src/app/series-orchestrator.ts) walks a series through
--   scripting -> awaiting_approval -> storyboarding -> rendering -> done. 066
--   had no state between approval and rendering, so a series generating its
--   frames had nowhere to sit. 'storyboarding' is that state: approved, spending
--   the cheap image budget, not yet touching the expensive renderer.
--
--   The approval gate lives on the awaiting_approval -> storyboarding edge — the
--   last free moment. Nothing an image or a clip costs is spent before it.
-- ===========================================================================

ALTER TABLE video_series DROP CONSTRAINT IF EXISTS video_series_status_check;
ALTER TABLE video_series ADD CONSTRAINT video_series_status_check
  CHECK (status IN ('scripting','awaiting_approval','storyboarding','rendering','assembling','done','failed'));
