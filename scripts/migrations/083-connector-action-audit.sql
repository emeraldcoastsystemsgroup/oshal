-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | connector_action_audit: one row per write-capable connector action ATTEMPT (success, provider error, params rejection, or refused-unconfirmed), keyed by user_sub + connector + action with a sha256 params_hash (never raw payloads). Append-only via triggers, mirroring 061-audit-append-only.sql. Runtime lazy-ensure in action-executor.ts creates table+indexes only; triggers are migration-owned.
-- 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes (comment-only; migration not yet applied anywhere): document the new statuses — 'attempt' (fail-closed pre-write row that must persist before the provider call; executed writes therefore land TWO rows) and 'not_connected' (caller has no brokered credential; writes never fall back to operator env keys).

-- gen_random_uuid() is built into PG13+, but keep parity with 061 for older local snapshots.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS connector_action_audit (
  audit_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub     TEXT NOT NULL,                -- the caller whose brokered credential was (or would have been) used
  connector_id TEXT NOT NULL,                -- connector provider slug (spec.provider)
  action       TEXT NOT NULL,                -- declared action name (spec.actions[].name)
  params_hash  TEXT NOT NULL,                -- sha256 hex of the canonical (key-sorted) params JSON; raw params are never stored
  risk_level   TEXT,                         -- declared riskLevel at attempt time (low|medium|high); NULL for unknown-action attempts
  status       TEXT NOT NULL,                -- attempt (pre-write, fail-closed) | success | error | not_connected | confirmation_required | invalid_params | unknown_action
  http_status  INTEGER,                      -- provider HTTP status when a request was actually sent
  error        TEXT,                         -- error summary for non-success outcomes
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_connector_action_audit_user ON connector_action_audit (user_sub, ts DESC);
CREATE INDEX IF NOT EXISTS idx_connector_action_audit_connector ON connector_action_audit (connector_id, action, ts DESC);

-- Append-only enforcement (same rationale + honest limits as 061-audit-append-only.sql):
-- a write-action audit trail that the runtime role can rewrite is not an audit trail. Rows can be
-- INSERTed, never UPDATEd/DELETEd/TRUNCATEd through normal DML — even by the table owner.
CREATE OR REPLACE FUNCTION connector_action_audit_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'connector_action_audit is append-only: % blocked', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_connector_action_audit_no_mutate ON connector_action_audit;
CREATE TRIGGER trg_connector_action_audit_no_mutate
  BEFORE UPDATE OR DELETE ON connector_action_audit
  FOR EACH ROW EXECUTE FUNCTION connector_action_audit_block_mutation();

DROP TRIGGER IF EXISTS trg_connector_action_audit_no_truncate ON connector_action_audit;
CREATE TRIGGER trg_connector_action_audit_no_truncate
  BEFORE TRUNCATE ON connector_action_audit
  FOR EACH STATEMENT EXECUTE FUNCTION connector_action_audit_block_mutation();
