-- Migration: Add onboarding state to user_preferences and create swarm_presets table
-- Date: 2026-03-31

-- Ensure user_preferences table exists
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add onboarding columns
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS onboarding_data JSONB DEFAULT '{}';

-- Create swarm_presets table
CREATE TABLE IF NOT EXISTS swarm_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  bot_ids UUID[] NOT NULL DEFAULT '{}',
  phase_config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swarm_presets_user ON swarm_presets (user_id);