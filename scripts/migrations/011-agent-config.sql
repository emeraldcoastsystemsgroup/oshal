/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 011: Agent Configuration Store
-- Date: 2026-03-14
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- Description: Per-agent configuration table for storing external service
--              credentials, API keys, and tool-specific settings.
--              Ported from oshal's Redis-backed AgentConfigManager to Postgres.
--              Schema defines the config fields; values stores the actual data.
--              Sensitive values (passwords, API keys) are stored as-is —
--              encryption at rest is handled by Postgres TDE / column-level
--              encryption if configured at the infrastructure layer.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_config (
  config_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  -- Schema definition: what config fields this agent supports
  -- Array of { name, type, label, required, defaultValue?, options?, placeholder? }
  config_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Actual config values: { "API_KEY": "sk-...", "BASE_URL": "https://..." }
  config_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One config record per agent
  CONSTRAINT uq_agent_config_agent_id UNIQUE (agent_id)
);

-- Index for fast lookup by agent_id (already unique constraint, but explicit)
CREATE INDEX IF NOT EXISTS idx_agent_config_agent_id ON agent_config(agent_id);

COMMENT ON TABLE agent_config IS 'Per-agent configuration store for external service credentials and tool settings. Ported from oshal AgentConfigManager (Redis) to Postgres.';
COMMENT ON COLUMN agent_config.config_schema IS 'JSON array of field definitions: [{name, type, label, required, defaultValue?, options?, placeholder?}]';
COMMENT ON COLUMN agent_config.config_values IS 'JSON object of actual config values keyed by field name';
