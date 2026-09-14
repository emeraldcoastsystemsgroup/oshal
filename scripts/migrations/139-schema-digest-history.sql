/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Durable memory for the data-model explorer, so schema drift can be noticed instead of looked at. One row per DISTINCT schema shape per database: the structure-only digest (owners, RLS state, policy NAMES, key columns, foreign-key targets - never a value, a default or a policy expression), its fingerprint, and the app_migrations count at capture time, which is what lets the differ separate a migrated change from an unexplained one. Unique on (database, fingerprint) so a stack that never changes shape stores exactly one row and re-stamps its captured_at. Operator-only under forced RLS, matching the explorer route that produces it. No top-level BEGIN/COMMIT on purpose: the runner owns the transaction (see tests/unit/migration-transactionality.spec.ts).
 */

CREATE TABLE IF NOT EXISTS oshal_schema_digest (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  database        TEXT        NOT NULL,
  captured_at     TIMESTAMPTZ NOT NULL,
  digest_version  INTEGER     NOT NULL,
  fingerprint     TEXT        NOT NULL,
  relation_count  INTEGER     NOT NULL,
  migration_count INTEGER,
  digest          JSONB       NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_schema_digest_shape UNIQUE (database, fingerprint),
  CONSTRAINT oshal_schema_digest_counts CHECK (relation_count >= 0 AND digest_version >= 1)
);

COMMENT ON TABLE oshal_schema_digest IS
  'Schema-shape history for the data-model explorer. Structure only - no table contents, no column defaults, no policy expressions. One row per distinct shape per database.';

CREATE INDEX IF NOT EXISTS idx_schema_digest_latest
  ON oshal_schema_digest (database, captured_at DESC, id DESC);

ALTER TABLE oshal_schema_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_schema_digest FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_digest_operator ON oshal_schema_digest;
CREATE POLICY schema_digest_operator ON oshal_schema_digest
  USING (current_setting('oshal.is_operator', true) = 'on')
  WITH CHECK (current_setting('oshal.is_operator', true) = 'on');
