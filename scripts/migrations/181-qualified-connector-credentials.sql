-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Add an isolated personal connector credential namespace with exact issuer/subject keys and forced owner-only RLS. No legacy reads, migration, adoption or physical-handler activation.

CREATE TABLE IF NOT EXISTS oshal_qualified_deks (
  principal_issuer TEXT COLLATE "C" NOT NULL,
  owner_sub TEXT COLLATE "C" NOT NULL,
  wrapped_dek TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (principal_issuer, owner_sub),
  CONSTRAINT qualified_dek_issuer CHECK (
    octet_length(principal_issuer) BETWEEN 1 AND 2048 AND principal_issuer = btrim(principal_issuer)
    AND principal_issuer !~ '[[:cntrl:]]'),
  CONSTRAINT qualified_dek_subject CHECK (
    octet_length(owner_sub) BETWEEN 1 AND 1024 AND owner_sub = btrim(owner_sub)
    AND owner_sub !~ '[[:cntrl:]]'),
  CONSTRAINT qualified_dek_format CHECK (wrapped_dek LIKE 'qdk1:%' AND octet_length(wrapped_dek) <= 128)
);

CREATE TABLE IF NOT EXISTS oshal_qualified_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_issuer TEXT COLLATE "C" NOT NULL,
  owner_sub TEXT COLLATE "C" NOT NULL,
  provider TEXT COLLATE "C" NOT NULL,
  account_key TEXT COLLATE "C" NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  revision BIGINT NOT NULL DEFAULT 1,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expiry TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qualified_connection_owner FOREIGN KEY (principal_issuer, owner_sub)
    REFERENCES oshal_qualified_deks (principal_issuer, owner_sub),
  CONSTRAINT qualified_connection_account UNIQUE (principal_issuer, owner_sub, provider, account_key),
  CONSTRAINT qualified_connection_provider CHECK (provider ~ '^[a-z][a-z0-9-]{0,39}$'),
  CONSTRAINT qualified_connection_account_key CHECK (
    octet_length(account_key) BETWEEN 1 AND 2048 AND account_key = btrim(account_key)
    AND account_key !~ '[[:cntrl:]]'),
  CONSTRAINT qualified_connection_status CHECK (status IN ('connected', 'needs_reconnect', 'revoked')),
  CONSTRAINT qualified_connection_revision CHECK (revision > 0),
  CONSTRAINT qualified_connection_access CHECK (access_token LIKE 'qct1:%' AND octet_length(access_token) <= 87500),
  CONSTRAINT qualified_connection_refresh CHECK (
    refresh_token IS NULL OR (refresh_token LIKE 'qct1:%' AND octet_length(refresh_token) <= 87500))
);

-- Identity/account changes require a fresh grant/row; updating ciphertext must invalidate a
-- future broker's revision snapshot. This ordinary trigger has no elevated execution context.
CREATE OR REPLACE FUNCTION oshal_qualified_connection_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
  ELSE
    IF (NEW.connection_id, NEW.principal_issuer, NEW.owner_sub, NEW.provider, NEW.account_key, NEW.created_at)
      IS DISTINCT FROM
      (OLD.connection_id, OLD.principal_issuer, OLD.owner_sub, OLD.provider, OLD.account_key, OLD.created_at) THEN
      RAISE EXCEPTION 'qualified connection identity is immutable' USING ERRCODE = '23514';
    END IF;
    NEW.revision := OLD.revision + 1;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION oshal_qualified_connection_revision() FROM PUBLIC;
DROP TRIGGER IF EXISTS oshal_qualified_connection_revision ON oshal_qualified_connections;
CREATE TRIGGER oshal_qualified_connection_revision
  BEFORE INSERT OR UPDATE ON oshal_qualified_connections
  FOR EACH ROW EXECUTE FUNCTION oshal_qualified_connection_revision();

ALTER TABLE oshal_qualified_deks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_qualified_deks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qualified_deks_owner ON oshal_qualified_deks;
CREATE POLICY qualified_deks_owner ON oshal_qualified_deks FOR ALL
  USING (owner_sub = current_setting('oshal.current_sub', true)
    AND principal_issuer = current_setting('oshal.current_issuer', true))
  WITH CHECK (owner_sub = current_setting('oshal.current_sub', true)
    AND principal_issuer = current_setting('oshal.current_issuer', true));

ALTER TABLE oshal_qualified_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_qualified_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qualified_connections_owner ON oshal_qualified_connections;
CREATE POLICY qualified_connections_owner ON oshal_qualified_connections FOR ALL
  USING (owner_sub = current_setting('oshal.current_sub', true)
    AND principal_issuer = current_setting('oshal.current_issuer', true))
  WITH CHECK (owner_sub = current_setting('oshal.current_sub', true)
    AND principal_issuer = current_setting('oshal.current_issuer', true));

REVOKE ALL ON oshal_qualified_deks, oshal_qualified_connections FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON oshal_qualified_deks, oshal_qualified_connections TO oshal_app;
    GRANT EXECUTE ON FUNCTION oshal_qualified_connection_revision() TO oshal_app;
  END IF;
END $$;

COMMENT ON TABLE oshal_qualified_connections IS
  'Fresh personal grants only. Exact verified issuer/subject ownership; no tenant, legacy adoption or execution authority. Broker/connect/readiness integration is separate.';
COMMENT ON TABLE oshal_qualified_deks IS
  'Independent 32-byte principal DEKs wrapped with qualified-namespace KEK and exact-principal authenticated data. Legacy DEKs remain untouched.';
