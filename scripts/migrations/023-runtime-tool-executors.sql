-- =============================================================================
-- Migration 023: Runtime Tool Executors
-- Date: 2026-05-09
-- Author: OpenAI Codex
-- Description: Persists executable tool descriptors registered through the
--              framework/runtime API so dynamic tools survive API restarts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS runtime_tool_executors (
  tool_name VARCHAR(255) PRIMARY KEY REFERENCES tools(name) ON DELETE CASCADE ON UPDATE CASCADE,
  executor_type VARCHAR(20) NOT NULL CHECK (executor_type IN ('builtin', 'cli', 'api', 'mcp')),
  cli_command TEXT,
  api_endpoint TEXT,
  mcp_server_name VARCHAR(255),
  builtin_key VARCHAR(255),
  runtime_registered BOOLEAN NOT NULL DEFAULT true,
  registered_by VARCHAR(255) NOT NULL DEFAULT 'runtime-api',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_tool_executors_strategy_check CHECK (
    (executor_type = 'cli' AND cli_command IS NOT NULL)
    OR (executor_type = 'api' AND api_endpoint IS NOT NULL)
    OR (executor_type = 'mcp' AND mcp_server_name IS NOT NULL)
    OR (executor_type = 'builtin' AND builtin_key IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_tool_executors_type
  ON runtime_tool_executors (executor_type);

DROP TRIGGER IF EXISTS trigger_runtime_tool_executors_updated_at ON runtime_tool_executors;
CREATE TRIGGER trigger_runtime_tool_executors_updated_at
  BEFORE UPDATE ON runtime_tool_executors
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
