-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-node worker-plane token binding (docs/backlog/hardening.md #7): oshal_cli_tokens.node_client_id confines a credential to ONE remote-client device so the swarm-wide REMOTE_CLIENT_SHARED_SECRET can be retired. NULL = an ordinary account PAT, which every existing row is, so this is behaviour-neutral on apply.
--
-- Recorded form of the lazy-DDL statements in src/app/routes/cli-token-routes.ts
-- (ensureCliTokenSchema). Idempotent and transaction-safe, so the runner wraps it.
--
-- WHY a column and not a new table: rotation, revocation, expiry, hashing-at-rest and the
-- global auth middleware already exist on this store and are proven. A device credential is
-- the SAME kind of secret as a PAT; what it needed was a scope, not a second rail.

ALTER TABLE oshal_cli_tokens ADD COLUMN IF NOT EXISTS node_client_id TEXT;

-- Partial index: only device tokens are ever looked up by clientId (rotation revokes every
-- live generation for one device), and account PATs must not bloat it.
CREATE INDEX IF NOT EXISTS idx_oshal_cli_tokens_node_client
  ON oshal_cli_tokens (node_client_id) WHERE node_client_id IS NOT NULL;

COMMENT ON COLUMN oshal_cli_tokens.node_client_id IS
  'Remote-client device this token is confined to (hardening #7). NULL = ordinary account PAT. A bound token authenticates ONLY on /api/remote-clients/<node_client_id>/** plus the enrollment handshake paths - see features/remote-client/services/node-token-scope.ts.';
