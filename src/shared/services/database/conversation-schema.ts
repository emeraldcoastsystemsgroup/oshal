/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of conversation persistence schema bootstrap for task/message history and usage telemetry
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added checkpoint, agent-memory, and knowledge-memory tables so non-swarm memory layers bootstrap with the conversation schema
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added paused task status and idempotent task-status constraint refresh so existing chat_tasks tables accept cockpit pause updates
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | A1.2: append owner-or-operator RLS policy statements for chat_tasks so a fresh database enforces isolation at table-create time (chokepoint fix; shapes mirror rls-policies-enforce.sql)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added nullable owner_sub column + index to knowledge_memory_documents (idempotent ALTER for existing DBs) so the knowledge catalog is permission-aware: NULL = shared (swarm/bot), non-null = private-to-owner. Powers the Settings RAG visibility surface (operator sees all; a user sees shared + own)
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';
import { SCHEMA_LOCK_KEYS } from './schema-lock';
import { buildOwnerRlsPolicyStatements } from './owner-rls-policy';

const logger = createChildLogger({ module: 'conversation-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures chat task/message persistence tables exist before stores execute queries.
 * Uses a shared process-level promise so bootstrap runs once per process.
 *
 * @param pool - Postgres connection pool
 * @returns Promise resolving when schema is ready
 */
export function ensureConversationStoreSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applyConversationSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

/**
 * @description Applies idempotent SQL statements for chat task and message persistence.
 *
 * @param pool - Postgres connection pool
 */
async function applyConversationSchema(pool: Pool): Promise<void> {
  logger.info('Ensuring conversation persistence schema');
  const statements = buildSchemaStatements();

  // Serialize concurrent bootstrappers so the DROP/ADD CONSTRAINT pair (chat_tasks status check)
  // can't interleave across connections and throw "constraint already exists".
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'conversation',
    statements,
    lockKey: SCHEMA_LOCK_KEYS.conversation,
    requirements: [
      { table: 'chat_tasks', columns: ['task_id', 'owner_sub', 'status', 'metadata'] },
      { table: 'chat_messages', columns: ['message_id', 'task_id', 'role', 'metadata'] },
      { table: 'task_checkpoints', columns: ['checkpoint_id', 'task_id'] },
      { table: 'agent_memories', columns: ['memory_id', 'agent_id', 'task_id'] },
      { table: 'knowledge_memory_documents', columns: ['knowledge_id', 'collection_name'] },
    ],
  });

  logger.info({ statementCount: statements.length }, 'Conversation persistence schema ready');
}

/**
 * @description Returns ordered SQL statements required for conversation persistence tables.
 *
 * @returns SQL statements
 */
function buildSchemaStatements(): string[] {
  return [
    `
      CREATE TABLE IF NOT EXISTS chat_tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'created'
          CHECK (status IN ('created', 'active', 'processing', 'waiting_for_input', 'paused', 'completed', 'failed', 'cancelled')),
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
      )
    `,
    `ALTER TABLE chat_tasks DROP CONSTRAINT IF EXISTS chat_tasks_status_check`,
    `ALTER TABLE chat_tasks ADD CONSTRAINT chat_tasks_status_check CHECK (status IN (
      'created', 'active', 'processing', 'waiting_for_input', 'paused', 'completed', 'failed', 'cancelled'
    ))`,
    `ALTER TABLE chat_tasks ADD COLUMN IF NOT EXISTS owner_sub TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_chat_tasks_agent_id ON chat_tasks(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_tasks_updated_at ON chat_tasks(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner ON chat_tasks(owner_sub) WHERE owner_sub IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner_updated ON chat_tasks(owner_sub, updated_at) WHERE owner_sub IS NOT NULL`,
    `
      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id UUID PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES chat_tasks(task_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        content_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_task_created ON chat_messages(task_id, created_at ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC)`,
    `
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
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_created ON task_checkpoints(task_id, created_at DESC)`,
    `
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
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_updated ON agent_memories(agent_id, updated_at DESC)`,
    `
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
        owner_sub TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    /* Backfill owner_sub onto databases whose knowledge_memory_documents predates the column
       (CREATE TABLE IF NOT EXISTS is a no-op for them). NULL owner_sub = shared visibility
       (general swarm or bot-shared); a non-null value scopes the doc to that user (permission-aware
       RAG visibility — operator sees all, a user sees shared + their own private docs). */
    `ALTER TABLE knowledge_memory_documents ADD COLUMN IF NOT EXISTS owner_sub TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_memory_collection_created ON knowledge_memory_documents(collection_name, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_memory_owner ON knowledge_memory_documents(owner_sub)`,

    /* ── owner-scoped RLS (A1.2): applied at the lazy-DDL chokepoint so a
       fresh database enforces isolation the moment chat_tasks is created.
       Inert while the runtime connects as a superuser role. ─────────────── */
    ...buildOwnerRlsPolicyStatements('chat_tasks', 'owner_sub'),
  ];
}
