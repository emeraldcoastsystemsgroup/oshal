-- Migration: Haven Home Context Model — 7 tables for persistent home awareness
-- Date: 2026-04-01
-- ADR: docs/adr/030-home-persona-layer.md
-- Build Plan: planning/home-persona-layer-build-plan.md

-- ── home_context (top-level household record) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS home_context (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL UNIQUE,
  name          TEXT,                             -- "The Demo Home", optional
  timezone      TEXT DEFAULT 'America/Chicago',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── household_members ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS household_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID REFERENCES home_context(household_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT,                             -- 'primary' | 'member' | 'guest'
  preferences   JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_household_members_household ON household_members (household_id);

-- ── connected_devices ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connected_devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID REFERENCES home_context(household_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL,                   -- 'google-home' | 'alexa' | 'smartthings'
  platform_id   TEXT,
  device_type   TEXT,                            -- 'light' | 'thermostat' | 'lock' | 'sensor' | 'camera' | 'speaker' | 'appliance'
  location      TEXT,
  status        TEXT DEFAULT 'online',           -- 'online' | 'offline' | 'unknown'
  last_seen     TIMESTAMPTZ,
  properties    JSONB DEFAULT '{}',
  notes         TEXT,
  connected_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connected_devices_household ON connected_devices (household_id);

-- ── linked_integrations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS linked_integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    UUID REFERENCES home_context(household_id) ON DELETE CASCADE,
  service         TEXT NOT NULL,                 -- 'chase-bank' | 'google-home' | 'smartthings' | 'alexa'
  category        TEXT NOT NULL,                 -- 'smart-home' | 'finance' | 'utility' | 'health'
  display_name    TEXT,
  auth_status     TEXT DEFAULT 'active',         -- 'active' | 'expiring' | 'expired' | 'pending'
  token_expires   TIMESTAMPTZ,
  preferences     JSONB DEFAULT '{}',
  linked_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_linked_integrations_household ON linked_integrations (household_id);

-- ── household_preferences ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS household_preferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID REFERENCES home_context(household_id) ON DELETE CASCADE,
  category      TEXT NOT NULL,                   -- 'climate' | 'lighting' | 'security' | 'notifications'
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  source        TEXT DEFAULT 'user',             -- 'user' | 'inferred' | 'default'
  set_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(household_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_household_preferences_household ON household_preferences (household_id);

-- ── open_threads ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS open_threads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID REFERENCES home_context(household_id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  context       JSONB DEFAULT '{}',
  status        TEXT DEFAULT 'open',             -- 'open' | 'closed' | 'snoozed'
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_active   TIMESTAMPTZ DEFAULT NOW(),
  closes_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_open_threads_household ON open_threads (household_id);
CREATE INDEX IF NOT EXISTS idx_open_threads_status ON open_threads (status);

-- ── haven_memory (free-form observations) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS haven_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID REFERENCES home_context(household_id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT[],
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_haven_memory_household ON haven_memory (household_id);

-- ── Default household seed ────────────────────────────────────────────────────
-- Creates the default household on migration so Phase 1 works without a setup step.
INSERT INTO home_context (household_id, name, timezone)
VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'America/Chicago')
ON CONFLICT (household_id) DO NOTHING;