/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- Migration 012: Routing Audit Log
-- Tracks every routing decision with full context: candidates, scores, tiers attempted, strategy.
-- Previously created inline at startup by RoutingAuditLog.ensureSchema() — now a proper migration.

CREATE TABLE IF NOT EXISTS routing_audit_log (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  ticket_external_id TEXT,
  swarm_run_id TEXT,
  winner_agent_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  winner_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  winner_confidence DOUBLE PRECISION,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  tiers_attempted TEXT[] NOT NULL DEFAULT '{}',
  required_capabilities TEXT[],
  ticket_title TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_audit_winner ON routing_audit_log (winner_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_routing_audit_strategy ON routing_audit_log (strategy, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_routing_audit_task ON routing_audit_log (task_id);
