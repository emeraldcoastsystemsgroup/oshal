-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Queue dead-letter store: the QueueManager's dispatch circuit breaker was in-memory only (dispatchCounts resets on restart) and the auto-escalate loop (BACKLOG "Build phase auto-escalates") could cycle a poison ticket forever. oshal_queue_dlq persists per-ticket failed dispatch/escalation cycles; after QM_MAX_ATTEMPTS (default 3) the ticket is quarantined into the new terminal 'dead_letter' state. Also widens tickets_status_check to admit 'dead_letter' (guarded: the tickets table is created by the runtime ticket-schema ensure AFTER migrations on a fresh DB, so the ALTER is a no-op when the table is absent — same guard pattern as migration 018).

-- One row per ticket that has ever failed a dispatch/escalation cycle. attempts is the
-- persisted circuit-breaker counter (survives api restarts, unlike the in-memory
-- dispatchCounts map). quarantined_at IS NOT NULL == the ticket is in the DLQ.
-- requeued_by/requeued_at record the operator who last released it back to 'approved'.
CREATE TABLE IF NOT EXISTS oshal_queue_dlq (
  ticket_id       TEXT PRIMARY KEY,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      TEXT,
  last_failure_at TIMESTAMPTZ,
  quarantined_at  TIMESTAMPTZ,
  reason          TEXT,
  requeued_by     TEXT,
  requeued_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The operator DLQ view lists quarantined entries newest-first.
CREATE INDEX IF NOT EXISTS idx_oshal_queue_dlq_quarantined
  ON oshal_queue_dlq (quarantined_at DESC) WHERE quarantined_at IS NOT NULL;

-- Admit the new terminal state on existing databases. Fresh databases get the same
-- widened list from the runtime schema ensure (src/shared/services/database/ticket-schema.ts),
-- which re-asserts tickets_status_check on every boot; this migration covers the
-- migrations-only path (e.g. a k8s migrations job) without waiting for an api boot.
DO $$ BEGIN
  IF to_regclass('tickets') IS NOT NULL THEN
    ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
    ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
      CHECK (status IN (
        'backlog', 'approved',
        'in_process',
        'in_process_discovery',
        'in_process_design', 'in_process_build', 'in_process_deploy',
        'in_process_test', 'in_process_release',
        'approval_required', 'customer_action', 'complete', 'escalated',
        'dead_letter',
        'paused', 'cancelled'
      ));
  END IF;
END $$;
