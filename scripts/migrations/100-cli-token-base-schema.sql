-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Record the lazy cli-token-routes base table before additive migrations 102/114. A fresh migration-only deployment otherwise fails at 102 and never reaches API startup. The schema/index/policy are byte-equivalent in shape to ensureCliTokenSchema/buildOwnerRlsPolicyStatements and remain idempotent.

CREATE TABLE IF NOT EXISTS oshal_cli_tokens (
  id               TEXT PRIMARY KEY,
  user_sub         TEXT NOT NULL,
  email            TEXT,
  label            TEXT,
  token_hash       TEXT UNIQUE NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  node_client_id   TEXT,
  principal_issuer TEXT
);

CREATE INDEX IF NOT EXISTS idx_oshal_cli_tokens_node_client
  ON oshal_cli_tokens (node_client_id) WHERE node_client_id IS NOT NULL;

ALTER TABLE oshal_cli_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_cli_tokens FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'oshal_cli_tokens_owner_or_operator'
       AND polrelid = 'oshal_cli_tokens'::regclass
  ) THEN
    CREATE POLICY oshal_cli_tokens_owner_or_operator ON oshal_cli_tokens
      AS PERMISSIVE FOR ALL
      USING (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END
$$;
