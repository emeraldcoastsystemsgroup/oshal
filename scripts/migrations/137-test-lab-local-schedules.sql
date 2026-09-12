/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist disabled-by-default exact-owner local Test Lab schedules and durable batch leases.
 */
BEGIN;
CREATE TABLE IF NOT EXISTS oshal_test_lab_schedules (
  id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_sub TEXT NOT NULL, app_name TEXT NOT NULL,
  levels JSONB NOT NULL, cadence TEXT NOT NULL CHECK(cadence IN ('hourly','daily','weekly')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE, revision INTEGER NOT NULL DEFAULT 1,
  next_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(issuer,user_sub,app_name), CHECK(revision>0));
CREATE TABLE IF NOT EXISTS oshal_test_lab_schedule_batches (
  id UUID PRIMARY KEY, schedule_id UUID NOT NULL REFERENCES oshal_test_lab_schedules(id), issuer TEXT NOT NULL,
  user_sub TEXT NOT NULL, request_id UUID NOT NULL, schedule_revision INTEGER NOT NULL, one_off BOOLEAN NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','cancelled','interrupted')), summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '60 seconds', UNIQUE(issuer,user_sub,request_id));
CREATE UNIQUE INDEX IF NOT EXISTS test_lab_schedule_batch_capacity ON oshal_test_lab_schedule_batches((true)) WHERE state='running';
CREATE INDEX IF NOT EXISTS test_lab_schedule_due ON oshal_test_lab_schedules(next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS test_lab_schedule_history ON oshal_test_lab_schedule_batches(issuer,user_sub,schedule_id,created_at DESC);
ALTER TABLE oshal_test_lab_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_test_lab_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS test_lab_schedule_control ON oshal_test_lab_schedules;
CREATE POLICY test_lab_schedule_control ON oshal_test_lab_schedules USING(current_setting('oshal.is_operator',true)='on')
  WITH CHECK(current_setting('oshal.is_operator',true)='on');
ALTER TABLE oshal_test_lab_schedule_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_test_lab_schedule_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS test_lab_schedule_control ON oshal_test_lab_schedule_batches;
CREATE POLICY test_lab_schedule_control ON oshal_test_lab_schedule_batches USING(current_setting('oshal.is_operator',true)='on')
  WITH CHECK(current_setting('oshal.is_operator',true)='on');
COMMIT;
