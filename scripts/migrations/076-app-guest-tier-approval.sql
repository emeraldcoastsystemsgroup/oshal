-- =============================================================================
-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                     | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D4: operator-approved guest tier per installed app.
-- =============================================================================
--
-- A manifest's `guestTier` is a REQUEST, not a grant (operator decision 2026-07-13). Guests are
-- UNAUTHENTICATED, so if a package could set its own tier, installing one would silently widen what
-- an anonymous visitor can reach — including writes. The app cannot decide how much of itself to
-- expose to the public; the person who owns the deployment decides.
--
-- This column holds ONLY what the operator approved. NULL (the default, including for every app
-- installed before this migration) = the safe Tier-B default: guests may read, every mutation is
-- blocked. A package that requested `full` and was never approved stays read-only.

ALTER TABLE swarm_applications
  ADD COLUMN IF NOT EXISTS guest_tier_approved TEXT;

-- Fail closed on a bad value rather than letting an unrecognised tier read as "unrestricted".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'swarm_applications_guest_tier_approved_check'
  ) THEN
    ALTER TABLE swarm_applications
      ADD CONSTRAINT swarm_applications_guest_tier_approved_check
      CHECK (guest_tier_approved IS NULL OR guest_tier_approved IN ('full', 'readonly', 'blocked'));
  END IF;
END $$;

COMMENT ON COLUMN swarm_applications.guest_tier_approved IS
  'ADR-085 D4: the guest tier an OPERATOR approved for this app. NULL = not approved = Tier-B default (guests read, mutations blocked). The manifest''s guestTier is only a request.';
