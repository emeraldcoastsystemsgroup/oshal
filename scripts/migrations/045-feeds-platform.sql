-- =============================================================================
-- Migration 045: Feeds platform (Slack feed indexing + settings + curator bot)
-- -----------------------------------------------------------------------------
-- DATE         | AUTHOR                                  | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | The "Feeds" app data layer:
--              | feed_messages (durable, per-user, deduped index of the user's Slack
--              | messages — with sentiment columns the sentiment team reads/writes),
--              | feed_settings (per-user poll/sentiment config with DB defaults), and the
--              | feeds-curator bot that owns the Feeds queue (ticketType 'feeds').
-- =============================================================================

-- Durable per-user message index. INGEST (cron/on-view) writes rows; the surface + the
-- sentiment team READ them. Deduped by (user_sub, source, channel_id, ts). The sentiment_*
-- columns are intentionally on THIS table so the sentiment team shares one store: they fill
-- sentiment/sentiment_label/sentiment_at; everything else is written by the indexer.
CREATE TABLE IF NOT EXISTS feed_messages (
  user_sub        VARCHAR(255) NOT NULL,
  source          VARCHAR(32)  NOT NULL DEFAULT 'slack',
  channel_id      VARCHAR(64)  NOT NULL,
  channel_name    TEXT,
  channel_type    VARCHAR(16),                       -- channel | private | im | mpim
  author_id       VARCHAR(64),
  author_name     TEXT,
  text            TEXT,
  ts              VARCHAR(64)  NOT NULL,             -- Slack message ts (e.g. 1718900000.000100)
  posted_at       TIMESTAMPTZ  NOT NULL,             -- derived from ts (for ordering/timeline)
  sentiment       NUMERIC(4,3),                      -- [-1.000, 1.000], NULL until scored (sentiment team)
  sentiment_label VARCHAR(16),                       -- positive | neutral | negative (sentiment team)
  sentiment_at    TIMESTAMPTZ,                       -- when it was scored (sentiment team)
  indexed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_sub, source, channel_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_feed_msgs_user_posted ON feed_messages (user_sub, posted_at DESC);
-- Lets the sentiment team pull the unscored backlog cheaply.
CREATE INDEX IF NOT EXISTS idx_feed_msgs_unscored ON feed_messages (user_sub, posted_at DESC) WHERE sentiment IS NULL;

-- Per-user surface settings. Defaults make the feed poll automatically once a user connects
-- Slack — the operator can flip these here (DB) or from the surface's settings drawer.
CREATE TABLE IF NOT EXISTS feed_settings (
  user_sub              VARCHAR(255) PRIMARY KEY,
  poll_enabled          BOOLEAN NOT NULL DEFAULT TRUE,   -- auto-index periodically (default ON)
  poll_interval_minutes INT     NOT NULL DEFAULT 30,
  max_channels          INT     NOT NULL DEFAULT 25,
  per_channel           INT     NOT NULL DEFAULT 15,
  sentiment_enabled     BOOLEAN NOT NULL DEFAULT FALSE,  -- opt-in: share with the sentiment team
  last_synced_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The bot responsible for the Feeds app: curates the feed, summarizes hot areas, and is the
-- worker the Feeds queue (ticketType 'feeds') routes to. Inline run via the orchestrator.
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'fd000000-0000-0000-0000-000000000001',
  'feeds-curator',
  'active',
  'auto',
  'auto',
  '{"systemPrompt": "You are the Feeds Curator for the OSHAL Feeds app — the user''s personal signal-watcher over their connected message feeds (Slack to start). Your job: turn a noisy stream of channel + DM messages into what MATTERS.\n\nWHAT YOU DO:\n1) SUMMARIZE. Given the user''s recent indexed messages, surface the few things that need attention — decisions, asks directed at the user, deadlines, blockers — over small talk.\n2) SPOT HOT AREAS. Identify which channels/threads are heating up (volume + who + sentiment) and say why in one line each.\n3) TREND. Note shifts vs. the usual baseline (a channel suddenly busy, a topic spiking, sentiment turning negative).\n4) RESPECT PRIVACY. These are the user''s OWN messages, indexed for them; never repeat them outside the user''s own surface, and never invent a message, author, or number — only what is in the index.\n\nBe concise and signal-first. Lead with the single most important thing.", "role": "communications/feeds", "constraints": ["Only use messages present in the feed index — never invent a message, author, channel, or count", "These are the user''s private messages — summarize for the user only, never leak them", "Lead with what needs the user''s attention; demote chit-chat", "Sentiment scoring is opt-in per user — do not assume it is enabled"]}'::jsonb,
  ARRAY['feed-aggregation', 'feed-summarization', 'hot-area-detection', 'trend-analysis', 'sentiment-triage'],
  'Select for ANY task about the user''s message feeds: summarizing recent Slack activity, finding what needs attention, spotting hot/heating channels, trend or sentiment analysis over indexed messages. NOT for sending messages or for email (email-summarizer).',
  ARRAY['feed', 'feeds', 'slack', 'messages', 'channels', 'what did i miss', 'catch me up', 'summarize slack', 'hot channels', 'trending', 'sentiment'],
  '{"topology": "localhost", "role": "communications/specialist", "app": "feeds"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona, base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords,
  metadata = EXCLUDED.metadata, updated_at = NOW();

INSERT INTO persona_layers (
  layer_type, scope, agent_id, priority, prompt_fragment, metadata
) VALUES
  ('role', 'agent', 'fd000000-0000-0000-0000-000000000001', 30,
   E'## Feeds Foundation\nYou watch the user''s own connected message feeds (Slack first) and surface what matters: asks aimed at them, decisions, deadlines, blockers, heating channels, and trend/sentiment shifts. Only use indexed messages — never invent one. Lead with the single most important thing. The feed is private to the user.',
   '{"generatedBy": "migration-045"}'::jsonb)
ON CONFLICT (layer_type, scope, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
  prompt_fragment = EXCLUDED.prompt_fragment,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
