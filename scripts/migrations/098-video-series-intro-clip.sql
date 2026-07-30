-- ---------------------------------------------------------------------------
-- 098 — a series remembers which intro its episodes open with
--
-- The Breakfast Crew shape (the one the operator approved) is
-- `[cached series intro] + [this episode's scenes]`: every episode of a show
-- opens with the same short title sequence, rendered ONCE and reused forever.
-- Five of those intros have been sitting on the render node since 2026-07-08
-- (breakfast-intro-FINAL.mp4, 03-cardboard-cosmo-crew-intro-FINAL.mp4, …), and
-- the show library names the one each show uses.
--
-- Nothing carried that name from the show to the renderer. `dispatchAssembly`
-- accepted an `introClip` argument, but the conductor's render path
-- (dispatchStoryboardedEpisode → episode-render.js) never had one to pass, so
-- every pumped episode started cold on scene 1 while the intro sat unused on
-- disk. This column is the missing link: the pump copies the show's intro onto
-- the series, the dispatcher puts it in the render plan, and the node prepends
-- it at the stitch.
--
-- Nullable on purpose — a show without an intro is a normal thing, and every
-- series created before this migration simply has none.
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE video_series ADD COLUMN IF NOT EXISTS intro_clip TEXT;

COMMENT ON COLUMN video_series.intro_clip IS
  'Filename of the cached intro clip in the render node''s stage dir, prepended to every episode of this series at assembly. NULL = no intro.';
