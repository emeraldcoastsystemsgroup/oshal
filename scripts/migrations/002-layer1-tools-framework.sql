/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 002: Layer 1 Tools Framework
-- Date: 2026-03-09
-- Author: Cline
-- ADR: docs/adr/010-layer1-tools-framework.md
-- Description: Creates tool registry catalog, switch framework tables, and
--              agent selector composition fields for dynamic capability assembly.
-- =============================================================================

-- =============================================================================
-- TOOLS: Central registry catalog for all available tools (CLI, API, MCP)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tools (
  tool_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('mcp', 'api', 'cli')),
  category VARCHAR(100) NOT NULL,
  version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
  
  -- Install specification for conditional installation
  -- Schema: { method: 'apt'|'npm'|'binary'|'pip'|'script'|'none', ... }
  install_spec JSONB NOT NULL DEFAULT '{}',
  
  -- Selector contribution (skills that this tool provides to agents)
  skills TEXT[] NOT NULL DEFAULT '{}',
  selector_fragment TEXT NOT NULL DEFAULT '',
  routing_tags TEXT[] NOT NULL DEFAULT '{}',
  
  -- Authorization grouping (tools sharing authorization state)
  -- Example: kubectl group includes kubectl, helm, argocd
  auth_group VARCHAR(100) NOT NULL DEFAULT '',
  default_auth_mode VARCHAR(10) NOT NULL DEFAULT 'off' 
    CHECK (default_auth_mode IN ('auto', 'ask', 'off')),
  
  -- Tool metadata
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL DEFAULT '{}',
  output_schema JSONB,
  usage_instructions TEXT,
  examples JSONB NOT NULL DEFAULT '[]',
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  tags TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  
  -- Registry metadata
  registered_by VARCHAR(255) NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill current tool-registry columns when migration 001 has already created
-- an older `tools` table shape.
ALTER TABLE tools ADD COLUMN IF NOT EXISTS install_spec JSONB NOT NULL DEFAULT '{}';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS skills TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS selector_fragment TEXT NOT NULL DEFAULT '';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS routing_tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS auth_group VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS default_auth_mode VARCHAR(10) NOT NULL DEFAULT 'off';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tools ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE legacy_constraint RECORD;
BEGIN
  FOR legacy_constraint IN
    SELECT conname
  FROM pg_constraint
  WHERE conrelid = 'tools'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%type%'
    AND (
      pg_get_constraintdef(oid) ILIKE '%mcp%'
      OR pg_get_constraintdef(oid) ILIKE '%api%'
      OR pg_get_constraintdef(oid) ILIKE '%cli%'
      OR conname = 'tools_type_check'
    )
  LOOP
    EXECUTE format('ALTER TABLE tools DROP CONSTRAINT IF EXISTS %I', legacy_constraint.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'tools'::regclass
      AND conname = 'tools_type_check'
  ) THEN
    ALTER TABLE tools
      ADD CONSTRAINT tools_type_check
      CHECK (type IN ('mcp', 'api', 'cli', 'presentron', 'rag'));
  END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tools_type ON tools (type);
CREATE INDEX IF NOT EXISTS idx_tools_category ON tools (category);
CREATE INDEX IF NOT EXISTS idx_tools_auth_group ON tools (auth_group);
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools (name);
CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools (enabled);

-- Full-text search on tool name + description
CREATE INDEX IF NOT EXISTS idx_tools_search ON tools USING gin (
  to_tsvector('english', name || ' ' || description)
);

-- =============================================================================
-- AGENT_TOOLS: Switch framework (per-agent, per-tool authorization)
-- Extends existing agent_tools table from migration 001
-- =============================================================================

-- Drop existing agent_tools table if it exists (from migration 001)
-- We'll recreate it with the new schema
DROP TABLE IF EXISTS agent_tools CASCADE;

CREATE TABLE agent_tools (
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  tool_id UUID NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
  
  -- Three-state authorization: auto (execute immediately), ask (require approval), off (not available)
  auth_mode VARCHAR(10) NOT NULL DEFAULT 'off' 
    CHECK (auth_mode IN ('auto', 'ask', 'off')),
  
  -- Installation state tracking
  installed BOOLEAN NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ,
  install_verified BOOLEAN NOT NULL DEFAULT false,
  
  -- Per-agent tool configuration overrides
  tool_config JSONB NOT NULL DEFAULT '{}',
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  PRIMARY KEY (agent_id, tool_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_tool ON agent_tools (tool_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_auth_mode ON agent_tools (auth_mode);
CREATE INDEX IF NOT EXISTS idx_agent_tools_installed ON agent_tools (installed);

-- =============================================================================
-- AGENTS: Add selector composition fields
-- =============================================================================

-- Base capabilities (from persona definition)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS base_capabilities TEXT[] NOT NULL DEFAULT '{}';

-- Base selector descriptor (from persona definition)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS base_selector_descriptor TEXT NOT NULL DEFAULT '';

-- Base routing keywords (from persona definition)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS base_routing_keywords TEXT[] NOT NULL DEFAULT '{}';

-- Computed fields (populated by SelectorCompositionService)
-- These are derived from base_ fields + enabled tool contributions
ALTER TABLE agents ADD COLUMN IF NOT EXISTS computed_capabilities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS computed_selector_descriptor TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS computed_routing_keywords TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS selector_last_computed_at TIMESTAMPTZ;

-- Index for selector-based queries
CREATE INDEX IF NOT EXISTS idx_agents_computed_capabilities ON agents USING gin (computed_capabilities);
CREATE INDEX IF NOT EXISTS idx_agents_computed_routing_keywords ON agents USING gin (computed_routing_keywords);

-- =============================================================================
-- TOOL_INSTALL_LOG: Audit trail for tool installation events
-- =============================================================================
CREATE TABLE IF NOT EXISTS tool_install_log (
  install_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  tool_id UUID NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK (action IN ('install', 'uninstall', 'verify', 'cleanup')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
  
  -- Installation details
  install_method VARCHAR(20),
  duration_ms INTEGER,
  error_message TEXT,
  verification_output TEXT,
  
  -- Metadata
  triggered_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_install_log_agent ON tool_install_log (agent_id);
CREATE INDEX IF NOT EXISTS idx_install_log_tool ON tool_install_log (tool_id);
CREATE INDEX IF NOT EXISTS idx_install_log_status ON tool_install_log (status);
CREATE INDEX IF NOT EXISTS idx_install_log_created_at ON tool_install_log (created_at DESC);

-- =============================================================================
-- TRIGGER: Auto-update updated_at on agent_tools table
-- =============================================================================
DROP TRIGGER IF EXISTS trigger_agent_tools_updated_at ON agent_tools;
CREATE TRIGGER trigger_agent_tools_updated_at
  BEFORE UPDATE ON agent_tools
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- TRIGGER: Auto-update updated_at on tools table
-- =============================================================================
DROP TRIGGER IF EXISTS trigger_tools_updated_at ON tools;
CREATE TRIGGER trigger_tools_updated_at
  BEFORE UPDATE ON tools
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
