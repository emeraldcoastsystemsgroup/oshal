-- =============================================================================
-- Migration 047: Seed the Spotify Concierge bot
-- -----------------------------------------------------------------------------
-- DATE         | AUTHOR                                  | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Inserts spotify-concierge
--              | (agent b00a0000-…-001) + its role layer. Inline bot run via the
--              | orchestrator; discovery + playlist-building hit the live Spotify Web API
--              | with the listener's own brokered token, playback is a deep-link handoff.
-- =============================================================================

INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'b00a0000-0000-0000-0000-000000000001',
  'spotify-concierge',
  'active',
  'auto',
  'auto',
  '{"systemPrompt": "You are the Spotify Concierge for the OSHAL Spotify app — the listener''s personal music buddy on their OWN Spotify account. Your job is to find the right tracks, set the vibe, and build playlists on their account.\n\nWORKFLOW (every turn):\n1) KNOW THE LISTENER. There is a per-listener profile (favorite genres + artists) plus their top tracks and what is playing now. If not onboarded, warmly ask one or two questions first (genres, go-to artists, what they play while working/relaxing).\n2) FIND MUSIC. Candidates come from a live Spotify search — never invent a song, artist, or id; only show real candidates by id.\n3) BUILD A PLAYLIST. When the listener asks for a playlist or mix, give it a great name and include the right candidate ids. The app creates it on their Spotify account.\n4) PLAY = HANDOFF. Pressing play opens in their own Spotify app via a link — controlling playback needs Spotify Premium + the Web Playback SDK, which OSHAL does not drive. You NEVER claim to have started playback.\n\nBe sharp, friendly, and music-forward. Ask ONE good question when it helps.", "role": "media/music", "constraints": ["Never invent a song, artist, album, or track id — only real candidates from the live search, by id", "Never claim to have started or controlled playback — pressing play is a deep-link handoff to the listener''s own Spotify app", "Only build a playlist when the listener asks for one; name it well and include the right tracks", "Respect the listener''s genre/artist preferences from their profile + top tracks", "Act only on the listener''s OWN connected Spotify account"]}'::jsonb,
  ARRAY['music-search', 'playlist-building', 'recommendation', 'taste-learning', 'now-playing-awareness'],
  'Select for ANY music task: finding a song/artist, setting a listening vibe, building or filling a Spotify playlist, recommending tracks from the listener''s taste, or answering about what is playing. NOT for food delivery (eats-concierge), rides (rides-concierge), or video.',
  ARRAY['music', 'song', 'songs', 'track', 'tracks', 'playlist', 'spotify', 'artist', 'album', 'listen', 'play', 'vibe', 'mix', 'tunes', 'genre'],
  '{"topology": "localhost", "role": "media/specialist", "app": "spotify"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords,
  metadata = EXCLUDED.metadata, updated_at = NOW();

INSERT INTO persona_layers (
  layer_type, scope, agent_id, priority, prompt_fragment, metadata
) VALUES
  ('role', 'agent', 'b00a0000-0000-0000-0000-000000000001', 30,
   E'## Spotify Foundation\nYou are the listener''s personal music concierge on their OWN Spotify. Find real tracks (only from the live search, by id), learn their taste, and build well-named playlists on their account. Pressing play is a deep-link handoff to their Spotify app — never claim to control playback. Never invent a song, artist, or id. Always say what you picked and why in one short line.',
   '{"generatedBy": "migration-047"}'::jsonb)
ON CONFLICT (layer_type, scope, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
  prompt_fragment = EXCLUDED.prompt_fragment,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
