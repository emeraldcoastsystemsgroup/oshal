/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Re-create oshal_acquire_node_resource_lease so its ON CONFLICT target resolves to the table column. The function's RETURNS TABLE declares a resource_key column, which PL/pgSQL also scopes as a variable over the body, and PostgreSQL rewrites a plain ON CONFLICT (resource_key) target into a column reference that is resolved through that scope - under the default variable_conflict=error the call fails with 'column reference "resource_key" is ambiguous'. Nothing ever saw it: the nightly recap's argument quoting broke on the day the lease landed (2026-08-06) and hid this behind "returned no JSON", and the pump's Playwright proof needs DATABASE_URL and never ran. The 2026-09-17 and 2026-09-18 nightlies, with the quoting fixed, died here (run-2026-09-17.log, run-2026-09-18.log). Migration 120 is applied history on every existing database, so its in-place correction reaches only a fresh install; this file reaches the rest. Same signature, same result shape, same expired-only takeover - the one change is the #variable_conflict use_column directive, and CREATE OR REPLACE makes it idempotent.
 */

-- =============================================================================
-- Migration 150: oshal_acquire_node_resource_lease resolves its conflict target
--                to the column, not to the OUT variable of the same name
-- Date: 2026-09-20
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- Description: Identical to the definition in 120 except for the
--              #variable_conflict use_column directive at the top of the body.
--              The OUT variables (acquired, resource_key, lease_id, ...) are
--              only ever assigned positionally by RETURN QUERY and never read
--              by name, so preferring the column changes nothing except the one
--              reference PostgreSQL used to refuse.
-- =============================================================================

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
-- Every RETURNS TABLE column above is also a PL/pgSQL variable inside this body, and the plain
-- ON CONFLICT (resource_key) target below is resolved as a column reference through that scope.
-- Prefer the column: the variables are only ever assigned by RETURN QUERY, never read by name.
#variable_conflict use_column
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
