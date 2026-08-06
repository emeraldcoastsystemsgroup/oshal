/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add hashed, expiring, single-use Apply
 *   completion capabilities bound to the exact task, owner, ticket, posting, target host, and
 *   remote client. Issuing a new ticket generation revokes every older live callback.
 */

CREATE TABLE IF NOT EXISTS apply_task_capabilities (
  task_id TEXT PRIMARY KEY CHECK (task_id ~* '^apply-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  owner_sub TEXT NOT NULL CHECK (length(btrim(owner_sub)) > 0),
  ticket_id TEXT NOT NULL CHECK (length(btrim(ticket_id)) > 0),
  settle_ticket BOOLEAN NOT NULL,
  posting_id BIGINT NOT NULL CHECK (posting_id > 0),
  client_id TEXT NOT NULL CHECK (length(btrim(client_id)) > 0),
  target_host TEXT NOT NULL CHECK (length(btrim(target_host)) > 0),
  operation TEXT NOT NULL DEFAULT 'apply.complete' CHECK (operation = 'apply.complete'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'processing', 'consumed', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  processing_started_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apply_task_capability_generation UNIQUE (ticket_id, generation),
  CONSTRAINT apply_task_capability_state_shape CHECK (
    (state = 'active' AND processing_started_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'processing' AND processing_started_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND consumed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_apply_capability_current_ticket
  ON apply_task_capabilities (ticket_id)
  WHERE state IN ('active', 'processing');

CREATE INDEX IF NOT EXISTS idx_apply_capability_expiry
  ON apply_task_capabilities (expires_at)
  WHERE state IN ('active', 'processing');

ALTER TABLE apply_task_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE apply_task_capabilities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apply_task_capabilities_owner_or_operator ON apply_task_capabilities;
CREATE POLICY apply_task_capabilities_owner_or_operator ON apply_task_capabilities
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
