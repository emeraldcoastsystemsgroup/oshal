-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | Correct the recorded meaning of a pre-145 issuer-less assignment: it keeps applying to EVERY issuer of its subject as a ceiling, and is the full assignment only for the canonical local account. 145 read NULL as local-only, which silently dropped a deny or viewer ceiling that main enforced for any issuer through subject-only SQL.
-- -----------------------------------------------------------------------------

-- WHY THIS IS A SEPARATE MIGRATION. 145-app-access-principal-issuer.sql has already run on a
-- live deployment (applied 2026-09-17 21:41Z on the operator preview, recorded in app_migrations),
-- so its statements are not edited: the runner applies each file once, and a changed 145 would
-- run nowhere. This file corrects the contract 145 recorded and is applied on every deployment,
-- including the ones 145 has already reached.
--
-- THE DEFECT. Before 145 the assignment SQL was subject-only, so a row written for subject S
-- was enforced for S under ANY issuer: local, mock-OIDC, Google, Entra. 145 declared that an
-- issuer-less row "resolves ONLY for urn:oshal:local-auth". For a deployment whose users signed
-- in through an identity provider, every existing deny and viewer ceiling was therefore
-- dropped the moment 145 ran, and the subject fell through to the manifest default - which is
-- admin on security, devops and oshal-dev and editor on the other seven kernel applications.
-- Reproduced on a disposable PostgreSQL: a pre-145 deny for a Google-shaped subject resolved
-- tier=deny on main and tier=admin source=default after 145.
--
-- THE CORRECTED CONTRACT, enforced by src/features/swarm-apps/services/app-access-service.ts
-- and proved by tests/authorization-issuer-tier-live.spec.ts against a real database:
--
--   user_issuer = '<issuer>'  -> the full assignment for exactly that (subject, issuer)
--   user_issuer IS NULL       -> the full assignment for urn:oshal:local-auth, AND a CEILING
--                                for every other issuer of the same subject: a legacy deny
--                                still denies, a legacy viewer still caps, a legacy grant never
--                                lifts another issuer above the manifest default
--
-- A row bound to an issuer is the operator's re-bind for that issuer and takes precedence over
-- the legacy row for that issuer alone; the legacy row keeps applying to every other issuer
-- until the operator clears it (clearing the local-auth assignment deletes the NULL row).
--
-- No row is rewritten, no key or policy changes, and there is no down migration: 145 already
-- re-keyed the table one way (an image rollback does not restore the old key, and the pre-145
-- upsert then fails with "no unique or exclusion constraint matching the ON CONFLICT spec").

COMMENT ON COLUMN oshal_app_access.user_issuer IS
  'Verified issuer namespace this assignment was written for. NULL means the assignment predates issuer provenance (migration 145): it is the full assignment for urn:oshal:local-auth and a ceiling for every other issuer of the same subject (a legacy deny or viewer keeps applying; a legacy grant lifts no other issuer above the manifest default) until an operator re-binds or clears it. It must never be inferred from the deployment current identity-provider configuration.';

COMMENT ON TABLE oshal_app_access IS
  'ADR-118 per-user, per-application coarse access tier, keyed on the full principal (user_sub, app_name, principal_issuer). See migrations 121, 145 and 146 for the issuer-less legacy rule.';
