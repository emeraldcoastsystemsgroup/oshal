/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 001: Multi-Agent Foundation Tables
-- Date: 2026-03-08
-- Author: Cline
-- ADR: docs/adr/006-multi-agent-configuration-architecture.md
-- Description: Creates core tables for agent management, tool registry,
--              agent-tool assignments, config sync audit, and config snapshots.
-- =============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- AGENTS: Core agent definitions and metadata
-- =============================================================================
CREATE TABLE IF NOT EXISTS agents (
  agent_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(255) NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'inactive', 'error', 'provisioning', 'maintenance')),

  -- Provider link (which LLM API provider + model this agent uses)
  api_provider_id   VARCHAR(100) NOT NULL,
  model_id          VARCHAR(255),
  provider_overrides JSONB NOT NULL DEFAULT '{}',

  -- Persona (system prompt, role, capabilities, constraints)
  persona        JSONB NOT NULL DEFAULT '{}',

  -- Tool assignments stored as UUID array (canonical source is agent_tools table)
  tools          UUID[] NOT NULL DEFAULT '{}',

  -- Extensible metadata (custom key-value)
  metadata       JSONB NOT NULL DEFAULT '{}',

  -- Config management fields
  config_version   INTEGER NOT NULL DEFAULT 1,
  config_source    VARCHAR(20) NOT NULL DEFAULT 'central'
                     CHECK (config_source IN ('central', 'local', 'merged')),
  last_sync_at     TIMESTAMPTZ,

  -- Timestamps
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for status-based queries (e.g., dashboard "show all active agents")
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);

-- Index for provider-based queries (e.g., "all agents using anthropic")
CREATE INDEX IF NOT EXISTS idx_agents_provider ON agents (api_provider_id);

-- =============================================================================
-- TOOLS: Persistent tool registry (replaces oshal's in-memory ToolRegistry)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tools (
  tool_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(255) NOT NULL UNIQUE,
  display_name   VARCHAR(255) NOT NULL,
  type           VARCHAR(10)  NOT NULL CHECK (type IN ('mcp', 'api', 'cli')),
  category       VARCHAR(100) NOT NULL,
  version        VARCHAR(50)  NOT NULL DEFAULT '1.0.0',

  -- Type-specific configuration (exactly one populated based on type)
  mcp_server     JSONB,        -- { serverId, transport, command, args, url, env }
  api_endpoint   JSONB,        -- { url, method, headers, auth }
  cli_command    JSONB,        -- { executable, argsTemplate, workingDir, env }

  -- Universal tool metadata
  input_schema       JSONB NOT NULL DEFAULT '{}',
  output_schema      JSONB,
  description        TEXT NOT NULL,
  usage_instructions TEXT,
  examples           JSONB NOT NULL DEFAULT '[]',
  requires_approval  BOOLEAN NOT NULL DEFAULT false,
  timeout_ms         INTEGER NOT NULL DEFAULT 30000,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  enabled            BOOLEAN NOT NULL DEFAULT true,

  -- Registry metadata
  registered_by  VARCHAR(255) NOT NULL,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for type-based queries (e.g., "show all MCP tools")
CREATE INDEX IF NOT EXISTS idx_tools_type ON tools (type);

-- Index for category-based queries
CREATE INDEX IF NOT EXISTS idx_tools_category ON tools (category);

-- Full-text search on tool name + description
CREATE INDEX IF NOT EXISTS idx_tools_search ON tools USING gin (
  to_tsvector('english', name || ' ' || description)
);

-- =============================================================================
-- AGENT_TOOLS: Many-to-many agent ↔ tool assignments
-- =============================================================================
CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id    UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  tool_id     UUID NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  tool_config JSONB NOT NULL DEFAULT '{}',   -- Per-agent tool overrides

  PRIMARY KEY (agent_id, tool_id)
);

-- Index for "which tools does this agent have?"
CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools (agent_id);

-- Index for "which agents use this tool?"
CREATE INDEX IF NOT EXISTS idx_agent_tools_tool ON agent_tools (tool_id);

-- =============================================================================
-- CONFIG_SYNC_LOG: Audit trail for config distribution events
-- =============================================================================
CREATE TABLE IF NOT EXISTS config_sync_log (
  sync_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  direction              VARCHAR(10) NOT NULL CHECK (direction IN ('push', 'pull')),
  config_version_before  INTEGER NOT NULL,
  config_version_after   INTEGER NOT NULL,
  changes                JSONB NOT NULL DEFAULT '{}',
  status                 VARCHAR(20) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'applied', 'rejected', 'conflict')),
  conflict_resolution    VARCHAR(20)
                           CHECK (conflict_resolution IN ('central-wins', 'local-wins', 'manual')),
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for agent-based audit queries
CREATE INDEX IF NOT EXISTS idx_sync_log_agent ON config_sync_log (agent_id);

-- Index for status-based queries (e.g., "show all conflicts")
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON config_sync_log (status);

-- Index for time-based queries (e.g., "last 24h of sync activity")
CREATE INDEX IF NOT EXISTS idx_sync_log_time ON config_sync_log (synced_at DESC);

-- =============================================================================
-- CONFIG_SNAPSHOTS: Point-in-time config snapshots for rollback
-- =============================================================================
CREATE TABLE IF NOT EXISTS config_snapshots (
  snapshot_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  config_version INTEGER NOT NULL,
  snapshot_data  JSONB NOT NULL,           -- Full agent config at this point
  reason         VARCHAR(255),             -- Why snapshot was taken
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for finding snapshots by agent + version
CREATE INDEX IF NOT EXISTS idx_snapshots_agent_version
  ON config_snapshots (agent_id, config_version DESC);

-- =============================================================================
-- TRIGGER: Auto-update updated_at on agents table
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_agents_updated_at ON agents;
CREATE TRIGGER trigger_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
