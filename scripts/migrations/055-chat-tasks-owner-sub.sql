-- 055-chat-tasks-owner-sub.sql
-- Model-gateway Phase 2: per-user / per-tenant LLM budget enforcement.
-- Adds owner_sub to chat_tasks so cost rows can be attributed to the end-user
-- (OIDC sub). The governance gate already keys budgets by scope='owner_sub';
-- this column is what lets BudgetService read THAT user's spend instead of the
-- global daily total. Existing rows keep owner_sub = NULL (system/swarm tasks
-- and pre-migration rows are simply unattributed — they fall under global/bot
-- caps, never a per-owner cap). Idempotent: safe to run more than once.

ALTER TABLE chat_tasks ADD COLUMN IF NOT EXISTS owner_sub TEXT;

-- Lookups for per-owner spend reads; partial (owner-scoped rows only).
CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner
  ON chat_tasks(owner_sub) WHERE owner_sub IS NOT NULL;

-- Daily per-owner spend read path is (owner_sub, updated_at >= start-of-day).
CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner_updated
  ON chat_tasks(owner_sub, updated_at) WHERE owner_sub IS NOT NULL;
