-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Multi-account-per-provider (ADR-113 section 4): retire oshal_connections' UNIQUE (user_sub, provider) in favour of per-ACCOUNT partial unique indexes so one user can hold two accounts of the same provider (e.g. two Gmails). This was previously applied ONLY by the runtime bootstrap in src/app/routes/connector-tenancy.ts (ensureTenancySchema) — which does nothing under OSHAL_SCHEMA_BOOTSTRAP=validate-only, so a migration-driven deployment still carried the one-account-per-provider constraint and the second connect silently OVERWROTE the first. This file is the owner-role half; the runtime mirror stays for a fresh local boot. Also backfills the deterministic-resolution inputs (label, account_key) and seeds exactly one is_default per (owner scope, provider) so token resolution never depends on which row was refreshed most recently.

-- Columns the multi-account model needs. Additive + idempotent: this migration is safe on a
-- database the runtime bootstrap already upgraded (every ADD/DROP below is IF EXISTS/IF NOT EXISTS).
ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS connected_by_sub TEXT;
ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS account_key TEXT;
ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- account_key is the per-account identity inside (owner, provider): the provider's own account id
-- when it gave us one, else the account email, else 'default' for the single-account legacy rows.
UPDATE oshal_connections
   SET account_key = COALESCE(NULLIF(account_id, ''), NULLIF(account_email, ''), 'default')
 WHERE account_key IS NULL;

-- label is what a human sees when picking between two accounts of one provider.
UPDATE oshal_connections
   SET label = COALESCE(NULLIF(account_email, ''), 'default')
 WHERE label IS NULL;

-- THE constraint change. The old table-level UNIQUE (user_sub, provider) is what made "two Gmails"
-- impossible: the second connect's ON CONFLICT updated the first row instead of adding one.
ALTER TABLE oshal_connections DROP CONSTRAINT IF EXISTS oshal_connections_user_sub_provider_key;

-- Superseded intermediate indexes (one-account-per-scope) from earlier runtime bootstraps.
DROP INDEX IF EXISTS oshal_conn_personal_uq;
DROP INDEX IF EXISTS oshal_conn_shared_uq;

-- Uniqueness is now per ACCOUNT, split by ownership scope: re-connecting the SAME account still
-- updates in place (no duplicate rows on a silent re-auth), a DIFFERENT account adds a row.
CREATE UNIQUE INDEX IF NOT EXISTS oshal_conn_personal_acct_uq
  ON oshal_connections (user_sub, provider, account_key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS oshal_conn_shared_acct_uq
  ON oshal_connections (tenant_id, provider, account_key) WHERE tenant_id IS NOT NULL;

-- Deterministic token resolution needs an EXPLICIT default per (ownership scope, provider). Without
-- one, "the user's Gmail token" resolved to whichever row sorted first by updated_at — which moves
-- every time an access token is refreshed. Seed the oldest connection of each scope/provider group
-- that has no default yet; the user can move it at /utilities (POST /api/connect/connection/:id/label).
WITH ranked AS (
  SELECT connection_id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(tenant_id::text, 'personal:' || user_sub), provider
           ORDER BY created_at, connection_id
         ) AS rn,
         BOOL_OR(is_default) OVER (
           PARTITION BY COALESCE(tenant_id::text, 'personal:' || user_sub), provider
         ) AS scope_has_default
    FROM oshal_connections
)
UPDATE oshal_connections c
   SET is_default = TRUE
  FROM ranked r
 WHERE c.connection_id = r.connection_id
   AND r.rn = 1
   AND r.scope_has_default IS NOT TRUE;

-- Resolution reads every accessible row for one (caller, provider) before picking; index the
-- personal lookup that the token broker performs on every dispatch.
CREATE INDEX IF NOT EXISTS idx_oshal_connections_user_provider
  ON oshal_connections (user_sub, provider) WHERE tenant_id IS NULL;
