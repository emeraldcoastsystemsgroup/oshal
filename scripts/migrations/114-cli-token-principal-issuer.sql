-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | Persist the verified issuer namespace delegated into PAT and node-token credentials; legacy rows stay null so no historical subject is guessed into a different IdP
-- -----------------------------------------------------------------------------

-- `sub` is unique only inside its issuer. A derived credential must therefore carry
-- both halves of the authenticated principal or deliberately carry no issuer at all.
-- This nullable additive column preserves existing core PAT behavior while making
-- issuer-bound applications reject legacy tokens until the owner remints them.
ALTER TABLE oshal_cli_tokens
  ADD COLUMN IF NOT EXISTS principal_issuer TEXT;

COMMENT ON COLUMN oshal_cli_tokens.principal_issuer IS
  'Verified issuer namespace delegated by the authenticated session that minted this credential. NULL means unknown/legacy and must never be inferred from current OIDC configuration.';
