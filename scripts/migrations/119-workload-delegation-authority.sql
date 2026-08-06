/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the durable SEC-01 workload identity and single-use user delegation authority with hash-only overlapping credential rotation, immutable signed bindings, revocation, and broker-only forced RLS.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Revoke authority-table access inherited by the bot role through migration 099 defaults; only the controller runtime may execute broker transactions.
 */

-- The migration runner owns BEGIN/COMMIT. These tables are an authorization authority, not
-- user content: ordinary request GUCs never grant access. Only a short connection-scoped broker
-- transaction in PostgresWorkloadDelegationStore sets oshal.workload_delegation_broker=on.
CREATE TABLE IF NOT EXISTS oshal_workload_identities (
  workload_id TEXT PRIMARY KEY
    CHECK (workload_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  workload_kind TEXT NOT NULL
    CHECK (workload_kind IN ('bot', 'node', 'controller', 'automation')),
  credential_hash TEXT NOT NULL
    CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  allowed_scopes TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  expires_at TIMESTAMPTZ,
  current_key_id TEXT NOT NULL
    CHECK (current_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  rotated_at TIMESTAMPTZ,
  previous_credential_hash TEXT
    CHECK (previous_credential_hash IS NULL OR previous_credential_hash ~ '^[0-9a-f]{64}$'),
  previous_key_id TEXT
    CHECK (previous_key_id IS NULL OR previous_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  previous_valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_workload_identity_scope_count CHECK (
    cardinality(allowed_scopes) BETWEEN 1 AND 64
    AND array_position(allowed_scopes, NULL) IS NULL
  ),
  CONSTRAINT oshal_workload_identity_expiry CHECK (
    expires_at IS NULL OR expires_at > created_at
  ),
  CONSTRAINT oshal_workload_identity_previous_key_shape CHECK (
    (previous_credential_hash IS NULL AND previous_key_id IS NULL AND previous_valid_until IS NULL)
    OR (previous_credential_hash IS NOT NULL AND previous_key_id IS NOT NULL
      AND previous_valid_until IS NOT NULL AND rotated_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_oshal_workload_identities_status_expiry
  ON oshal_workload_identities (status, expires_at);

CREATE TABLE IF NOT EXISTS oshal_user_delegations (
  jti TEXT PRIMARY KEY
    CHECK (jti ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
  workload_id TEXT NOT NULL REFERENCES oshal_workload_identities(workload_id),
  user_sub TEXT NOT NULL CHECK (length(user_sub) > 0 AND octet_length(user_sub) <= 512),
  principal_issuer TEXT NOT NULL
    CHECK (length(btrim(principal_issuer)) > 0 AND length(principal_issuer) <= 2048),
  ticket_id TEXT,
  run_id TEXT,
  route_method TEXT NOT NULL
    CHECK (route_method IN ('DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT')),
  route_path TEXT NOT NULL CHECK (
    route_path ~ '^/[^?#[:cntrl:] ]{0,2047}$' AND position('//' IN route_path) = 0
  ),
  body_sha256 TEXT NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  scopes TEXT[] NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_user_delegation_dispatch CHECK (
    num_nonnulls(ticket_id, run_id) = 1
    AND length(COALESCE(ticket_id, run_id)) > 0
  ),
  CONSTRAINT oshal_user_delegation_scope_count CHECK (
    cardinality(scopes) BETWEEN 1 AND 16 AND array_position(scopes, NULL) IS NULL
  ),
  CONSTRAINT oshal_user_delegation_time_order CHECK (
    issued_at <= not_before AND not_before < expires_at
    AND expires_at <= issued_at + INTERVAL '30 minutes'
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
  ),
  CONSTRAINT oshal_user_delegation_consumed_order CHECK (
    consumed_at IS NULL OR consumed_at >= issued_at
  )
);

CREATE INDEX IF NOT EXISTS idx_oshal_user_delegations_workload_expiry
  ON oshal_user_delegations (workload_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_oshal_user_delegations_subject_expiry
  ON oshal_user_delegations (user_sub, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_oshal_user_delegations_active
  ON oshal_user_delegations (expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

-- Signed authority fields are append-only. Only two monotonic state transitions are legal:
-- unconsumed -> consumed and active -> revoked. An attacker with generic UPDATE cannot rewrite a
-- harmless recorded grant into a different user, workload, route, body, scope, or lifetime.
CREATE OR REPLACE FUNCTION oshal_guard_user_delegation_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'oshal_user_delegations are retained authority records';
  END IF;
  IF ROW(
    NEW.jti, NEW.workload_id, NEW.user_sub, NEW.principal_issuer,
    NEW.ticket_id, NEW.run_id, NEW.route_method, NEW.route_path,
    NEW.body_sha256, NEW.scopes, NEW.issued_at, NEW.not_before,
    NEW.expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.jti, OLD.workload_id, OLD.user_sub, OLD.principal_issuer,
    OLD.ticket_id, OLD.run_id, OLD.route_method, OLD.route_path,
    OLD.body_sha256, OLD.scopes, OLD.issued_at, OLD.not_before,
    OLD.expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'immutable delegation binding cannot be changed';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'delegation revocation is irreversible';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'delegation consumption is irreversible';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oshal_user_delegation_immutable ON oshal_user_delegations;
CREATE TRIGGER trg_oshal_user_delegation_immutable
  BEFORE UPDATE OR DELETE ON oshal_user_delegations
  FOR EACH ROW EXECUTE FUNCTION oshal_guard_user_delegation_immutability();

ALTER TABLE oshal_workload_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_workload_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE oshal_user_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_user_delegations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oshal_workload_identities_broker ON oshal_workload_identities;
CREATE POLICY oshal_workload_identities_broker ON oshal_workload_identities
  AS PERMISSIVE FOR ALL
  USING (current_setting('oshal.workload_delegation_broker', true) = 'on')
  WITH CHECK (current_setting('oshal.workload_delegation_broker', true) = 'on');

DROP POLICY IF EXISTS oshal_user_delegations_broker ON oshal_user_delegations;
CREATE POLICY oshal_user_delegations_broker ON oshal_user_delegations
  AS PERMISSIVE FOR ALL
  USING (current_setting('oshal.workload_delegation_broker', true) = 'on')
  WITH CHECK (current_setting('oshal.workload_delegation_broker', true) = 'on');

-- Migration 099 deliberately gives oshal_bot DML on future public tables. These two authority
-- tables are controller-only: a bot can present a signed token over HTTP but must never inspect,
-- insert, revoke, or consume ledger rows directly, even if it sets the application-defined GUC.
REVOKE ALL PRIVILEGES ON TABLE oshal_workload_identities, oshal_user_delegations FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_bot') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE oshal_workload_identities, oshal_user_delegations FROM oshal_bot';
  END IF;
END;
$$;
