/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127: per-user default LLM brain. One FORCE-RLS row per subject holding WHICH connected provider that user wants their work to run on. A preference is not an authorization — resolution still verifies the choice is usable and degrades to the next rung — so the only writer is the owner (or an operator acting on their behalf).
 */

-- Migration 121 is the ADR-118 app access store. The bootstrap runner owns the transaction.
CREATE TABLE IF NOT EXISTS oshal_user_llm_prefs (
  user_sub TEXT PRIMARY KEY
    CHECK (length(user_sub) > 0 AND octet_length(user_sub) <= 512),
  -- 'auto'        — resolve down the ADR-127 ladder (the default; no row means this too)
  -- 'claude-code' — the deployment's mounted Claude Code CLI login
  -- 'openai-codex'— the deployment's mounted OpenAI Codex CLI login
  -- 'any-llm'     — this user's own saved bring-your-own endpoint
  -- 'free-tier'   — this user's own connected free tiers (rotation picks among them)
  preferred_provider TEXT NOT NULL
    CHECK (preferred_provider IN ('auto', 'claude-code', 'openai-codex', 'any-llm', 'free-tier')),
  -- Optional model pin for the chosen provider. NULL = whatever that provider defaults to.
  preferred_model TEXT
    CHECK (preferred_model IS NULL OR (length(btrim(preferred_model)) > 0 AND length(preferred_model) <= 200)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION touch_oshal_user_llm_prefs_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oshal_user_llm_prefs_updated_at ON oshal_user_llm_prefs;
CREATE TRIGGER trg_oshal_user_llm_prefs_updated_at
  BEFORE UPDATE ON oshal_user_llm_prefs
  FOR EACH ROW EXECUTE FUNCTION touch_oshal_user_llm_prefs_updated_at();

ALTER TABLE oshal_user_llm_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_user_llm_prefs FORCE ROW LEVEL SECURITY;

-- A user reads only their own preference; an operator can read any, because the operator surfaces
-- (support, the provider matrix) must be able to answer "what is this account actually running on".
DROP POLICY IF EXISTS oshal_user_llm_prefs_owner_or_operator_read ON oshal_user_llm_prefs;
CREATE POLICY oshal_user_llm_prefs_owner_or_operator_read ON oshal_user_llm_prefs
  AS PERMISSIVE FOR SELECT
  USING (
    user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

-- Writes are the owner's own row only, or an operator acting deliberately. FORCE RLS keeps this
-- true for the table-owning runtime role as well, so a plain pool cannot quietly rewrite a choice.
DROP POLICY IF EXISTS oshal_user_llm_prefs_owner_write ON oshal_user_llm_prefs;
CREATE POLICY oshal_user_llm_prefs_owner_write ON oshal_user_llm_prefs
  AS PERMISSIVE FOR ALL
  USING (
    user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
