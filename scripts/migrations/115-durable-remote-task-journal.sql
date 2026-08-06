/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Persist remote task assignment and first-writer settlement in PostgreSQL, retain terminal tombstones for 30 days, preserve an append-only state journal, and add an idempotency-keyed transactional outbox for crash-safe replay.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Persist remote-client owner bindings and atomic cost-effect receipts so owner changes serialize with task assignment and settlement replay cannot double bill.
 */

-- =============================================================================
-- 115-durable-remote-task-journal.sql
--
-- SECURITY AND FAILURE MODEL
--   The former remote-client queue is process-local. An API restart can forget a
--   queued or completed task while the leaf client continues polling, and a
--   repeated completion can overwrite the result a caller already observed.
--   These tables make PostgreSQL the authority:
--
--   * One immutable task_id binds one target client_id. There is no lease,
--     claim expiry, reassignment, or orphan-steal field to accidentally revive.
--   * A partial unique index permits only one active claimed task per client.
--     The repository also takes a transaction advisory lock by client before it
--     claims, making competing pollers return the already-active task rather
--     than surfacing a uniqueness race.
--   * Terminal state is written under a row lock. The first completion/failure
--     wins; all later same/conflicting writes read the tombstone and make no
--     state, event, or outbox mutation.
--   * Terminal rows remain for at least 30 days. Cleanup refuses to remove a
--     task while any outbox row is undelivered, so retention can stretch but can
--     never erase an outstanding side effect.
--   * Dispatch and settlement outbox rows share the state-change transaction.
--     outbox_id is the stable downstream idempotency key. delivered_at rows are
--     excluded from replay; a crash after publish but before commit can still
--     redeliver, which is the standard at-least-once outbox boundary and why the
--     idempotency key is part of the public record.
--
-- APPEND-ONLY JOURNAL
--   Direct UPDATE/DELETE against event rows is rejected. The trigger permits a
--   nested FK-cascade delete only when the parent tombstone itself is purged;
--   retention is not a rewrite of history, it is destruction of the entire
--   expired aggregate after its outbox has drained.
--
-- TENANCY
--   owner_sub is copied onto all three tables so FORCE RLS does not depend on a
--   recursive parent lookup. NULL denotes a platform/system task and is visible
--   only to an operator/system identity. Machine-plane operations must execute
--   through the already-authorized controller service under system identity.
--
-- TRANSACTIONALITY
--   No top-level BEGIN/COMMIT and no non-transactional command: the migration
--   runner commits this file and its migration-ledger row together.
-- =============================================================================

CREATE TABLE IF NOT EXISTS remote_task_journal_client_owners (
  client_id TEXT PRIMARY KEY CHECK (length(btrim(client_id)) > 0),
  owner_sub TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_task_journal_tasks (
  task_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL CHECK (length(btrim(client_id)) > 0),
  owner_sub TEXT,
  correlation_id TEXT NOT NULL CHECK (length(btrim(correlation_id)) > 0),
  envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed')),
  claimed_by_client_id TEXT,
  claimed_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  terminal_result JSONB,
  tombstone_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT remote_task_journal_state_shape CHECK (
    (status = 'queued' AND claimed_by_client_id IS NULL AND claimed_at IS NULL
      AND settled_at IS NULL AND terminal_result IS NULL AND tombstone_expires_at IS NULL)
    OR (status = 'claimed' AND claimed_by_client_id = client_id AND claimed_at IS NOT NULL
      AND settled_at IS NULL AND terminal_result IS NULL AND tombstone_expires_at IS NULL)
    OR (status IN ('completed', 'failed') AND claimed_by_client_id = client_id
      AND claimed_at IS NOT NULL AND settled_at IS NOT NULL
      AND terminal_result IS NOT NULL AND tombstone_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_remote_task_queue
  ON remote_task_journal_tasks (client_id, created_at, task_id)
  WHERE status = 'queued';

CREATE UNIQUE INDEX IF NOT EXISTS uq_remote_task_one_active_per_client
  ON remote_task_journal_tasks (client_id)
  WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS idx_remote_task_tombstones
  ON remote_task_journal_tasks (tombstone_expires_at)
  WHERE status IN ('completed', 'failed');

CREATE TABLE IF NOT EXISTS remote_task_journal_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES remote_task_journal_tasks(task_id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  owner_sub TEXT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'task.queued', 'task.claimed', 'task.completed', 'task.failed'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT remote_task_journal_event_sequence UNIQUE (task_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_remote_task_events_task
  ON remote_task_journal_events (task_id, sequence_number);

CREATE TABLE IF NOT EXISTS remote_task_journal_outbox (
  outbox_id UUID PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES remote_task_journal_tasks(task_id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL REFERENCES remote_task_journal_events(event_id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  owner_sub TEXT,
  topic TEXT NOT NULL CHECK (topic IN ('remote-task.dispatch', 'remote-task.settlement')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  CONSTRAINT remote_task_outbox_delivery_time CHECK (
    delivered_at IS NULL OR delivered_at >= created_at
  )
);

CREATE INDEX IF NOT EXISTS idx_remote_task_outbox_pending
  ON remote_task_journal_outbox (created_at, outbox_id)
  WHERE delivered_at IS NULL;

-- Deliberately no FK to remote_task_journal_outbox: outbox delivery holds that row
-- FOR UPDATE while the publisher opens a separate cost transaction. A child-row FK
-- check would wait on the parent lock while delivery waits on cost, deadlocking every
-- first publication. The immutable UUID receipt remains the downstream dedupe key.
CREATE TABLE IF NOT EXISTS remote_task_cost_receipts (
  outbox_id UUID PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_sub TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION oshal_reject_remote_task_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'remote task journal events are append-only';
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS remote_task_journal_events_immutable ON remote_task_journal_events;
CREATE TRIGGER remote_task_journal_events_immutable
  BEFORE UPDATE OR DELETE ON remote_task_journal_events
  FOR EACH ROW EXECUTE FUNCTION oshal_reject_remote_task_event_mutation();

ALTER TABLE remote_task_journal_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_task_journal_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS remote_task_journal_tasks_owner_or_operator ON remote_task_journal_tasks;
CREATE POLICY remote_task_journal_tasks_owner_or_operator ON remote_task_journal_tasks
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

ALTER TABLE remote_task_journal_client_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_task_journal_client_owners FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS remote_task_journal_client_owners_owner_or_operator ON remote_task_journal_client_owners;
CREATE POLICY remote_task_journal_client_owners_owner_or_operator ON remote_task_journal_client_owners
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

ALTER TABLE remote_task_journal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_task_journal_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS remote_task_journal_events_owner_or_operator ON remote_task_journal_events;
CREATE POLICY remote_task_journal_events_owner_or_operator ON remote_task_journal_events
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

ALTER TABLE remote_task_journal_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_task_journal_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS remote_task_journal_outbox_owner_or_operator ON remote_task_journal_outbox;
CREATE POLICY remote_task_journal_outbox_owner_or_operator ON remote_task_journal_outbox
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

ALTER TABLE remote_task_cost_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_task_cost_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS remote_task_cost_receipts_owner_or_operator ON remote_task_cost_receipts;
CREATE POLICY remote_task_cost_receipts_owner_or_operator ON remote_task_cost_receipts
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
