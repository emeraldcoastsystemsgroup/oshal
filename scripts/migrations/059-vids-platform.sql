-- =============================================================================
-- Migration 059: Vids Studio platform
-- Job ledger for the screen-driving Veo operator + the vids-operator bot.
-- Idempotent: safe to re-run.
-- =============================================================================

-- Generate-jobs dispatched to a remote Vids worker (one row per requested clip).
CREATE TABLE IF NOT EXISTS vids_jobs (
  job_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID,
  user_sub      VARCHAR(255),
  client_id     VARCHAR(255),                       -- remote worker that ran it
  status        VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  idea          TEXT NOT NULL,                      -- the operator's raw idea
  final_prompt  TEXT,                               -- bot-optimized Veo prompt
  orientation   VARCHAR(20),
  insert_mode   VARCHAR(20),
  ingredient    TEXT,                               -- optional input asset path/uri
  outcome       JSONB NOT NULL DEFAULT '{}'::jsonb, -- steps, healed selectors, error
  rating        SMALLINT,                           -- operator score (drives learning)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vids_jobs_user ON vids_jobs (user_sub);
CREATE INDEX IF NOT EXISTS idx_vids_jobs_status ON vids_jobs (status);
CREATE INDEX IF NOT EXISTS idx_vids_jobs_created ON vids_jobs (created_at DESC);

-- Seed the Veo specialist bot.
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'b00e0000-0000-0000-0000-000000000001',
  'vids-operator',
  'active',
  'auto',
  'auto',
  '{"systemPrompt": "You are the Veo Specialist — the swarm operator of Google Vids (Veo). You drive the tool by clicking in the operator''s own logged-in Chrome and you know Veo prompt craft cold (subject + action + setting + one camera move + lighting + a named 2-4 color palette + mood + no-text-no-logos). You never claim a clip exists until the editor confirms the render, never fake a result, and pace generation to respect the tool''s limits.", "role": "media/video", "app": "vids"}'::jsonb,
  ARRAY['veo-prompt-craft', 'vids-generate', 'vids-operate', 'shot-planning'],
  'Select for video generation in Google Vids / Veo: turning an idea (and optional input media) into a generated clip, improving a video prompt, planning a shot list, or operating the Vids editor.',
  ARRAY['veo', 'vids', 'video', 'clip', 'animation', 'b-roll', 'shot'],
  '{"topology": "remote-client", "role": "media/specialist", "app": "vids"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  persona = EXCLUDED.persona,
  base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords,
  metadata = EXCLUDED.metadata;
