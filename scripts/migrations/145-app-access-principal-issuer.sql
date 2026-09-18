-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | Record the verified issuer an ADR-118 app-access assignment was written for, so a tier can be resolved for a federated identity on its full principal; rows written before this migration stay NULL and are answered only for canonical local accounts.
-- 2   | maintainer@emeraldcoastsystemsgroup.com     | Isolate simultaneous same-subject identities in the key, mutations and owner RLS; preserve NULL provenance as the canonical local principal.
-- 3   | maintainer@emeraldcoastsystemsgroup.com     | APPLIED ON A LIVE DEPLOYMENT (operator preview, 2026-09-17 21:41Z, recorded in app_migrations) - the statements below are frozen and this note is comment-only. The NULL-issuer rule stated here was too narrow: main enforced an issuer-less row for ANY issuer of its subject, so reading it as local-only dropped every federated deny and viewer ceiling. 146-app-access-legacy-issuerless-rows.sql records the corrected contract; there is no down migration (the re-key is one-way).
-- -----------------------------------------------------------------------------

-- ADR-118 keyed an assignment on `user_sub` alone. A subject identifier is unique only
-- INSIDE its issuer, so `oshal_app_access` could not say which identity provider a stored
-- assignment belonged to, and the only safe reading of an issuer-less row was "a canonical
-- local account". That is what src/app/composition/application-authorization-wiring.ts
-- encoded by refusing to resolve a tier at all for any other issuer — which denied every
-- OIDC-signed-in user a tier on every application, including an explicit admin assignment
-- an operator had made for them.
--
-- This additive, nullable column lets a NEW assignment name the issuer it was written for,
-- exactly as scripts/migrations/114-cli-token-principal-issuer.sql does for derived
-- credentials. NULL keeps its historical meaning and is never inferred from whatever
-- identity provider the deployment happens to be configured with today:
--
--   user_issuer = '<issuer>'  -> resolves ONLY for that exact (subject, issuer) principal
--   user_issuer IS NULL       -> resolves ONLY for urn:oshal:local-auth
--
ALTER TABLE oshal_app_access
  ADD COLUMN IF NOT EXISTS user_issuer TEXT;

-- ADD COLUMN IF NOT EXISTS does not attach a CHECK when the column is already present,
-- so the constraint is declared separately and idempotently.
ALTER TABLE oshal_app_access
  DROP CONSTRAINT IF EXISTS oshal_app_access_user_issuer_shape;
ALTER TABLE oshal_app_access
  ADD CONSTRAINT oshal_app_access_user_issuer_shape
  CHECK (user_issuer IS NULL OR (length(user_issuer) > 0 AND octet_length(user_issuer) <= 2048));

COMMENT ON COLUMN oshal_app_access.user_issuer IS
  'Verified issuer namespace this assignment was written for. NULL means the assignment predates issuer provenance and resolves only for urn:oshal:local-auth; it must never be inferred from the deployment current identity-provider configuration.';

-- NULL preserves legacy provenance while sharing exactly one key with explicit local auth.
-- Other issuers with the same subject are independent people, including when one is denied.
ALTER TABLE oshal_app_access
  ADD COLUMN IF NOT EXISTS principal_issuer TEXT
    GENERATED ALWAYS AS (COALESCE(user_issuer, 'urn:oshal:local-auth')) STORED;
ALTER TABLE oshal_app_access DROP CONSTRAINT IF EXISTS oshal_app_access_pkey;
ALTER TABLE oshal_app_access ADD CONSTRAINT oshal_app_access_pkey
  PRIMARY KEY (user_sub, app_name, principal_issuer);

DROP POLICY IF EXISTS oshal_app_access_owner_or_operator_read ON oshal_app_access;
CREATE POLICY oshal_app_access_owner_or_operator_read ON oshal_app_access
  AS PERMISSIVE FOR SELECT USING (
    (user_sub = current_setting('oshal.current_sub', true)
      AND principal_issuer = current_setting('oshal.current_issuer', true))
    OR current_setting('oshal.is_operator', true) = 'on'
  );
