-- ===========================================================================
-- 067-video-episode-scenes.sql
-- The screenplay-writer emits STRUCTURED scenes, not markdown. Give the episode
-- a place to hold them, plus the storyboard frames generated from them.
--
-- WHY
--   066 modelled an episode as three markdown blobs (script/animation/image
--   prompts) because that is the shape the hand-run packs used. The bot's actual
--   contract is JSON: per scene a `camera` line, a `motion` line, ordered
--   `dialogue`, and an optional `reaction`. Storing the JSON keeps the render
--   stage from re-parsing prose, and lets the storyboard stage address a scene
--   by index.
--
--   `frame_ids` holds the Drive file ids of the generated stills, in scene order.
--   The remote node fetches them by id (the LAN between controller and node is
--   firewalled both ways), so an episode can be re-rendered without regenerating
--   a single image.
-- ===========================================================================

ALTER TABLE video_episodes
  ADD COLUMN IF NOT EXISTS scenes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS frame_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN video_episodes.scenes IS
  'Ordered scenes from the screenplay-writer: [{n, camera, motion, dialogue:[{who,line}], reaction}]';
COMMENT ON COLUMN video_episodes.frame_ids IS
  'Drive file ids of the storyboard stills, in scene order. The node fetches by id.';

-- A storyboarded episode is a distinct state between scripted and rendering.
ALTER TABLE video_episodes DROP CONSTRAINT IF EXISTS video_episodes_status_check;
ALTER TABLE video_episodes ADD CONSTRAINT video_episodes_status_check
  CHECK (status IN ('planned','scripted','storyboarded','rendering','rendered','assembled','failed'));
