-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Cost-governance spend budgets: chat_tasks records per-call cost but nothing ENFORCES a ceiling. oshal_budgets holds one daily USD cap per (scope_type, scope_key) — user (owner_sub), app (manifest ticketType), or ticket — soft (warn-only) by default, hard (block dispatch) when hard=TRUE. oshal_budget_events is the append-only breach/halt audit trail the operator reads to see WHY a dispatch was refused. Mirrors the small-table style of 077-career-digest.sql.
-- 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: (1) oshal_budgets.set_by_operator — an operator-imposed cap must not be erasable by the capped user, so setBudget's self-service upsert only updates rows where this flag is FALSE (idempotent ALTER for tables created from the earlier revision). (2) oshal_cost_events — append-only per-call cost ledger. chat_tasks accumulates LIFETIME totals per task_id, so a trailing-24h filter on chat_tasks.updated_at counts a long-lived task's whole history as "today"; windowed budget math needs one row per cost event. Written by CostTrackingService.recordCost alongside the chat_tasks rollup.

-- One budget row per scope. scope_key semantics by scope_type:
--   'user'   -> the end-user's OIDC sub (chat_tasks.owner_sub)
--   'app'    -> the app's manifest ticketType (tickets.ticket_type; ADR-038 bundles by type)
--   'ticket' -> a single tickets.ticket_id (per-run ceiling for an expensive workflow)
CREATE TABLE IF NOT EXISTS oshal_budgets (
  id            BIGSERIAL PRIMARY KEY,
  scope_type    VARCHAR(16) NOT NULL CHECK (scope_type IN ('user', 'app', 'ticket')),
  scope_key     TEXT NOT NULL,
  daily_usd     NUMERIC(12,4) NOT NULL CHECK (daily_usd >= 0),
  hard          BOOLEAN NOT NULL DEFAULT FALSE,  -- FALSE = soft cap: warn + audit only, never blocks
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,   -- disabled rows are kept (audit continuity) but never enforced
  set_by_operator BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE = operator-imposed: the scoped user cannot raise/disable it
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_type, scope_key)                 -- setBudget upserts on this pair
);

-- Idempotent for databases that ran the pre-review revision of this migration.
ALTER TABLE oshal_budgets ADD COLUMN IF NOT EXISTS set_by_operator BOOLEAN NOT NULL DEFAULT FALSE;

-- The dispatch-time check reads only enabled rows for up to three exact scope keys.
CREATE INDEX IF NOT EXISTS idx_oshal_budgets_enabled_scope
  ON oshal_budgets (scope_type, scope_key) WHERE enabled;

-- Breach/halt audit: one row per governance ACTION (a hard block, a runaway halt).
-- Soft-cap warnings stay in logs on purpose — a warn on every poll cycle would flood this table.
CREATE TABLE IF NOT EXISTS oshal_budget_events (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope_type    VARCHAR(16) NOT NULL,
  scope_key     TEXT NOT NULL,
  spend_usd     NUMERIC(12,4) NOT NULL,           -- observed spend at decision time
  cap_usd       NUMERIC(12,4) NOT NULL,           -- the cap (or runaway max, for action='halt' runaway rows)
  action        VARCHAR(16) NOT NULL CHECK (action IN ('breach', 'halt')),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb -- reason code + ids (ticketId/appId/userSub), never secrets
);

CREATE INDEX IF NOT EXISTS idx_oshal_budget_events_ts ON oshal_budget_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_oshal_budget_events_scope ON oshal_budget_events (scope_type, scope_key, ts DESC);

-- Per-call cost ledger: ONE row per recordCost event. chat_tasks stays the accumulating
-- per-task rollup (cockpit surfaces read it); THIS table is what time-windowed reads
-- (daily budget caps) sum, because an accumulating row filtered by updated_at attributes a
-- task's lifetime spend to the window of its latest touch. Attribution mirrors chat_tasks:
-- owner_sub for user scope; ticket/app scopes join through ticket_task_links on task_id.
CREATE TABLE IF NOT EXISTS oshal_cost_events (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  task_id       TEXT NOT NULL,                    -- chat_tasks.task_id (join key for ticket_task_links)
  owner_sub     TEXT,                             -- accountable end-user; NULL for system/swarm tasks
  agent_id      TEXT,
  provider_id   TEXT,
  model_id      TEXT,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0  -- this event's cost only, never a running total
);

CREATE INDEX IF NOT EXISTS idx_oshal_cost_events_owner_ts ON oshal_cost_events (owner_sub, ts DESC);
CREATE INDEX IF NOT EXISTS idx_oshal_cost_events_task_ts ON oshal_cost_events (task_id, ts DESC);
