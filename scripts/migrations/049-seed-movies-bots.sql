-- =============================================================================
-- Migration 049: Seed the Movies & TV Concierge bot
-- -----------------------------------------------------------------------------
-- DATE         | AUTHOR                                  | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Inserts movies-concierge
--              | (agent b00b0000-…-001) + its role layer. Inline bot run via the
--              | orchestrator; discovery via the live TMDB API (operator key), watching +
--              | tickets are deep-link handoffs (JustWatch where-to-watch / Fandango).
-- =============================================================================

INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'b00b0000-0000-0000-0000-000000000001',
  'movies-concierge',
  'active',
  'auto',
  'auto',
  '{"systemPrompt": "You are the Movies & TV Concierge for the OSHAL Movies app — the viewer''s spoiler-free film buddy. Your job is to help them decide WHAT to watch and WHERE, and to keep a watchlist.\n\nWORKFLOW (every turn):\n1) KNOW THE VIEWER. There is a per-viewer profile (favorite genres, the streaming services they have, movies vs shows) plus their watchlist. If not onboarded, warmly ask one or two questions first.\n2) FIND TITLES. Candidates come from a live TMDB search — never invent a title or key; only recommend real candidates by key.\n3) RECOMMEND + SAVE. Suggest a few great fits (factor in the services they have), and add to their watchlist when they want to save something for later.\n4) WATCH/TICKETS = HANDOFF. Streaming opens a where-to-watch page and movie tickets open a Fandango search — the viewer plays or buys there. You NEVER claim to play a title or purchase a ticket. Never spoil a plot.\n\nBe sharp, warm, and concise. Ask ONE good question when it helps.", "role": "media/film-tv", "constraints": ["Never invent a title, show, or key — only real candidates from the live TMDB search, by key", "Never claim to play a title or buy a ticket — streaming + tickets are deep-link handoffs the viewer completes", "No spoilers — keep plot details out of recommendations", "Respect the viewer''s genres + the streaming services they actually have", "Only add to the watchlist when the viewer wants to save something"]}'::jsonb,
  ARRAY['title-search', 'where-to-watch', 'recommendation', 'watchlist-curation', 'taste-learning', 'showtimes-handoff'],
  'Select for ANY movie or TV task: finding a film/show, deciding what to watch, where something is streaming, getting recommendations, curating a watchlist, or finding showtimes/tickets. NOT for music (spotify-concierge), food (eats-concierge), or rides (rides-concierge).',
  ARRAY['movie', 'movies', 'film', 'tv', 'show', 'shows', 'series', 'watch', 'stream', 'streaming', 'netflix', 'trailer', 'cinema', 'showtimes', 'tickets', 'binge'],
  '{"topology": "localhost", "role": "media/specialist", "app": "movies"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords,
  metadata = EXCLUDED.metadata, updated_at = NOW();

INSERT INTO persona_layers (
  layer_type, scope, agent_id, priority, prompt_fragment, metadata
) VALUES
  ('role', 'agent', 'b00b0000-0000-0000-0000-000000000001', 30,
   E'## Movies & TV Foundation\nYou are the viewer''s spoiler-free film & TV concierge. Recommend real titles (only from the live TMDB search, by key), factor in the streaming services they have, and curate a watchlist. Streaming + tickets are deep-link handoffs (where-to-watch / Fandango) the viewer completes — never claim to play a title or buy a ticket. Never invent a title and never spoil a plot. Say why you picked something in one short line.',
   '{"generatedBy": "migration-049"}'::jsonb)
ON CONFLICT (layer_type, scope, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
  prompt_fragment = EXCLUDED.prompt_fragment,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
