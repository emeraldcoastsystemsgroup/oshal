-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Added checkpoint, agent-memory, and knowledge-memory tables for non-swarm memory layers

CREATE TABLE IF NOT EXISTS task_checkpoints (
  checkpoint_id UUID PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES chat_tasks(task_id) ON DELETE CASCADE,
  agent_id TEXT,
  label TEXT,
  summary TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('auto', 'manual', 'restore')),
  message_count INTEGER NOT NULL DEFAULT 0,
  task_snapshot JSONB NOT NULL,
  messages_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_created
  ON task_checkpoints(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_memories (
  memory_id UUID PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES chat_tasks(task_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  last_user_message TEXT,
  last_assistant_message TEXT,
  tool_names TEXT[] NOT NULL DEFAULT '{}'::text[],
  keywords TEXT[] NOT NULL DEFAULT '{}'::text[],
  message_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL DEFAULT 'task_result'
    CHECK (source IN ('task_result', 'checkpoint', 'manual')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_agent_memories_agent_task UNIQUE (agent_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_updated
  ON agent_memories(agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_memory_documents (
  knowledge_id UUID PRIMARY KEY,
  agent_id TEXT,
  task_id TEXT REFERENCES chat_tasks(task_id) ON DELETE SET NULL,
  collection_name TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  format TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  document_count INTEGER NOT NULL DEFAULT 0,
  embedding_provider_id TEXT,
  embedding_model_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_memory_collection_created
  ON knowledge_memory_documents(collection_name, created_at DESC);
