/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | a2a_agents — per-agent credentials for the inbound A2A gateway (BACKLOG Plan F item 2). Replaces any global shared secret: each external agent gets its own operator-minted bearer token, stored ONLY as a sha256 hash, with capability scopes, an enable toggle, and soft revocation. Operator-managed platform config (no per-user rows), so no owner RLS — route-level operator gating is the isolation boundary. Matches the runtime lazy-DDL bootstrap in a2a-credentials-service.ts exactly.
 */

CREATE TABLE IF NOT EXISTS a2a_agents (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  -- sha256 hex of the bearer token; the plaintext is returned once at mint and never stored.
  token_hash   TEXT UNIQUE NOT NULL,
  -- Capability scopes gating the JSON-RPC methods: message:send | tasks:read | tasks:cancel.
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  owner_note   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
