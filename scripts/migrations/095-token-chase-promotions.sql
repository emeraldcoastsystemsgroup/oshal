/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase keep-winner re-baseline store (ADR-046, BACKLOG "auto keep-winner then re-baseline loop"): token_chase_promotions persists each frame-scope's preferred (promoted) lane — one ACTIVE row per (user_sub, run_id, seq) via a partial unique index; superseded/reverted rows stay as history. token_chase_promotion_audit is the promote/auto-promote/revert trail that makes promotion a visible, reversible action. Shapes match the in-app lazy bootstrap in token-chase-promotion-service.ts exactly (fresh boots pre-migration produce the identical tables). Owner-scoped RLS mirrors the 060/093 owner_or_operator pattern (create-if-absent, never drop/recreate). Transaction-safe: plain DDL inside BEGIN/COMMIT, no CONCURRENTLY.
 */

-- No top-level BEGIN;/COMMIT;: the migration runner (database-bootstrap-service)
-- wraps every migration + its history row in ONE transaction since 2026-07-24. A
-- self-managed transaction here would be a NEW self-wrapping migration the
-- transactionality guard rejects; plain DDL + DO blocks run inside the runner's txn.

CREATE TABLE IF NOT EXISTS token_chase_promotions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub           TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  provider           TEXT,                              -- winning lane provider id (null when the replay did not report one)
  model              TEXT NOT NULL,                     -- winning lane model id (the promoted baseline)
  label              TEXT,                              -- human lane label shown in surfaces
  baseline_provider  TEXT,                              -- the baseline the win was measured against
  baseline_model     TEXT,
  baseline_cost_usd  NUMERIC(12,6),
  variant_cost_usd   NUMERIC(12,6),                     -- the promoted lane's measured cost (the new baseline cost)
  saved_usd          NUMERIC(12,6),
  judge_score        INTEGER NOT NULL,                  -- the LLM-judge score that cleared the bar
  judge_mode         TEXT NOT NULL,                     -- always 'llm' — lexical-fallback grades never promote
  source             TEXT NOT NULL,                     -- manual | auto (TOKEN_CHASE_AUTO_PROMOTE opt-in)
  status             TEXT NOT NULL DEFAULT 'active',    -- active | superseded | reverted
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at        TIMESTAMPTZ
);

-- One ACTIVE promotion per frame scope; history rows (superseded/reverted) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tc_promotions_active
  ON token_chase_promotions (user_sub, run_id, seq) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_tc_promotions_user_run
  ON token_chase_promotions (user_sub, run_id);

CREATE TABLE IF NOT EXISTS token_chase_promotion_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub      TEXT NOT NULL,
  promotion_id  UUID,                                   -- no FK: audit rows must outlive any future promotion GC
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  action        TEXT NOT NULL,                          -- promote | auto-promote | revert
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tc_promotion_audit_user_run
  ON token_chase_promotion_audit (user_sub, run_id, created_at);

-- Owner-scoped RLS (defense-in-depth beneath the WHERE user_sub=$1 filter every query carries).
-- Create-if-absent, never drop/recreate: re-running must never open a window with RLS enabled
-- but no policy. Shape mirrors the 060 Tier-1 owner_or_operator pattern.
ALTER TABLE token_chase_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_chase_promotions FORCE ROW LEVEL SECURITY;
ALTER TABLE token_chase_promotion_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_chase_promotion_audit FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'token_chase_promotions_owner_or_operator'
      AND polrelid = 'token_chase_promotions'::regclass
  ) THEN
    CREATE POLICY token_chase_promotions_owner_or_operator ON token_chase_promotions
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
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'token_chase_promotion_audit_owner_or_operator'
      AND polrelid = 'token_chase_promotion_audit'::regclass
  ) THEN
    CREATE POLICY token_chase_promotion_audit_owner_or_operator ON token_chase_promotion_audit
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
END $$;
-- (runner-owned COMMIT — see the header note; no top-level COMMIT; here)
