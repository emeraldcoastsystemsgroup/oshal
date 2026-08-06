/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add one PostgreSQL-authoritative, token-bound lease shared by recap and video-pump render-node work, plus durable pump-run bindings for restart-safe renewal and release.
 */

-- =============================================================================
-- 120-shared-node-resource-leases.sql
--
-- One signed-in render node cannot safely execute two browser-driving workflows.
-- The former split coordination was not an authority boundary: recap held a mutex
-- on its initiating host, while the pump performed a non-atomic read/write of a
-- JSON file on the node. PostgreSQL now arbitrates every claimant atomically.
--
-- A random lease_id is the release/renewal capability. Holder names are useful
-- operational labels, never authority: a restarted or duplicated process cannot
-- release a successor merely by presenting the same label. Expired rows may be
-- replaced atomically, and a stale token cannot mutate the replacement.
--
-- The table is system/operator-only under FORCE RLS. Callers use the existing
-- positive system identity (controller) or the host-side recap CLI, which stamps
-- an explicit operator transaction. A bare database connection sees no lease and
-- cannot create one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_node_resource_leases (
  resource_key TEXT PRIMARY KEY CHECK (
    length(btrim(resource_key)) BETWEEN 1 AND 255
  ),
  lease_id UUID NOT NULL UNIQUE,
  holder TEXT NOT NULL CHECK (length(btrim(holder)) BETWEEN 1 AND 255),
  purpose TEXT NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 120),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_node_resource_lease_time_shape CHECK (
    heartbeat_at >= acquired_at AND expires_at > heartbeat_at
  )
);

CREATE INDEX IF NOT EXISTS idx_oshal_node_resource_leases_expiry
  ON oshal_node_resource_leases (expires_at);

ALTER TABLE oshal_node_resource_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_node_resource_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_node_resource_leases_operator ON oshal_node_resource_leases;
CREATE POLICY oshal_node_resource_leases_operator ON oshal_node_resource_leases
  AS PERMISSIVE FOR ALL
  USING (current_setting('oshal.is_operator', true) = 'on')
  WITH CHECK (current_setting('oshal.is_operator', true) = 'on');

/** Atomically take an absent/expired resource, or return its current holder. */
CREATE OR REPLACE FUNCTION oshal_acquire_node_resource_lease(
  p_resource_key TEXT,
  p_lease_id UUID,
  p_holder TEXT,
  p_purpose TEXT,
  p_ttl_seconds INTEGER,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  acquired BOOLEAN,
  resource_key TEXT,
  lease_id UUID,
  holder TEXT,
  purpose TEXT,
  acquired_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ttl_seconds < 30 OR p_ttl_seconds > 43200 THEN
    RAISE EXCEPTION 'node resource lease TTL must be between 30 and 43200 seconds';
  END IF;
  IF jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'node resource lease metadata must be an object';
  END IF;

  RETURN QUERY
  INSERT INTO oshal_node_resource_leases AS current_lease
    (resource_key, lease_id, holder, purpose, acquired_at, heartbeat_at, expires_at, metadata)
  VALUES
    (p_resource_key, p_lease_id, p_holder, p_purpose, NOW(), NOW(),
     NOW() + make_interval(secs => p_ttl_seconds), COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (resource_key) DO UPDATE
    SET lease_id = EXCLUDED.lease_id,
        holder = EXCLUDED.holder,
        purpose = EXCLUDED.purpose,
        acquired_at = EXCLUDED.acquired_at,
        heartbeat_at = EXCLUDED.heartbeat_at,
        expires_at = EXCLUDED.expires_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    WHERE current_lease.expires_at <= NOW()
  RETURNING TRUE, current_lease.resource_key, current_lease.lease_id,
            current_lease.holder, current_lease.purpose, current_lease.acquired_at,
            current_lease.heartbeat_at, current_lease.expires_at, current_lease.metadata;

  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT FALSE, active.resource_key, active.lease_id, active.holder, active.purpose,
         active.acquired_at, active.heartbeat_at, active.expires_at, active.metadata
    FROM oshal_node_resource_leases AS active
   WHERE active.resource_key = p_resource_key AND active.expires_at > NOW();
END
$$;

/** Renew only the exact unexpired capability; holder text alone has no authority. */
CREATE OR REPLACE FUNCTION oshal_renew_node_resource_lease(
  p_resource_key TEXT,
  p_lease_id UUID,
  p_holder TEXT,
  p_ttl_seconds INTEGER
)
RETURNS SETOF oshal_node_resource_leases
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ttl_seconds < 30 OR p_ttl_seconds > 43200 THEN
    RAISE EXCEPTION 'node resource lease TTL must be between 30 and 43200 seconds';
  END IF;
  RETURN QUERY
  UPDATE oshal_node_resource_leases AS lease
     SET heartbeat_at = NOW(),
         expires_at = NOW() + make_interval(secs => p_ttl_seconds),
         updated_at = NOW()
   WHERE lease.resource_key = p_resource_key
     AND lease.lease_id = p_lease_id
     AND lease.holder = p_holder
     AND lease.expires_at > NOW()
  RETURNING lease.*;
END
$$;

/** Release only the exact capability and report whether one row was removed. */
CREATE OR REPLACE FUNCTION oshal_release_node_resource_lease(
  p_resource_key TEXT,
  p_lease_id UUID,
  p_holder TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  WITH removed AS (
    DELETE FROM oshal_node_resource_leases AS lease
     WHERE lease.resource_key = p_resource_key
       AND lease.lease_id = p_lease_id
       AND lease.holder = p_holder
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM removed)
$$;

-- Pump-run binding is historical evidence and restart authority. Terminal rows
-- retain the binding; release removes only the active resource row above.
ALTER TABLE video_pump_runs
  ADD COLUMN IF NOT EXISTS node_resource_key TEXT,
  ADD COLUMN IF NOT EXISTS node_client_id TEXT,
  ADD COLUMN IF NOT EXISTS node_lease_id UUID,
  ADD COLUMN IF NOT EXISTS node_lease_holder TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'video_pump_runs_node_lease_shape'
       AND conrelid = 'video_pump_runs'::regclass
  ) THEN
    ALTER TABLE video_pump_runs
      ADD CONSTRAINT video_pump_runs_node_lease_shape CHECK (
        (node_resource_key IS NULL AND node_client_id IS NULL
          AND node_lease_id IS NULL AND node_lease_holder IS NULL)
        OR
        (length(btrim(node_resource_key)) > 0 AND length(btrim(node_client_id)) > 0
          AND node_lease_id IS NOT NULL AND length(btrim(node_lease_holder)) > 0)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_video_pump_runs_active_node_lease
  ON video_pump_runs (node_resource_key, node_lease_id)
  WHERE outcome IN ('started', 'rendering');
