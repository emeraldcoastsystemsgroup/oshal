/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added durable chat task/message history tables with per-model token and cost telemetry columns
 */

CREATE TABLE IF NOT EXISTS chat_tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'active', 'processing', 'waiting_for_input', 'completed', 'failed', 'cancelled')),
  processing_mode TEXT NOT NULL DEFAULT 'agentic'
    CHECK (processing_mode IN ('agentic', 'direct')),
  agent_id TEXT,
  provider_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  cost_currency TEXT NOT NULL DEFAULT 'USD',
  usage_by_model JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_tasks_agent_id ON chat_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_chat_tasks_updated_at ON chat_tasks(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id UUID PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES chat_tasks(task_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  content_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_task_created ON chat_messages(task_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);
