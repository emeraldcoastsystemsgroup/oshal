-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | Record the verified issuer an ADR-118 app-access assignment was written for, so a tier can be resolved for a federated identity on its full principal; rows written before this migration stay NULL and are answered only for canonical local accounts.
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
-- The primary key stays (user_sub, app_name). One subject string therefore still holds at
-- most one assignment per application: an operator re-assigning that subject under a
-- different issuer REBINDS the existing row rather than adding a second one. Subjects are
-- issuer-scoped identifiers, so two live identities sharing a subject string is a
-- coincidence rather than a shape this table needs to represent, and keeping the key
-- unchanged means no existing lookup, policy or upsert arbiter has to move.
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
