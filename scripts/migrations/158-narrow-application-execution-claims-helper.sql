-- =============================================================================
-- Migration 158: Narrow application execution claims helper for oshal_bot
-- =============================================================================
-- Keep the 4-argument helper oshal_application_execution_claims(text, text, text, boolean)
-- for oshal_app, whose controller path needs the app-name lookup.
--
-- Add a 3-argument signature oshal_application_execution_claims(p_kind, p_id, p_enforce)
-- that delegates with p_app => NULL. Grant oshal_bot only the narrow signature so the
-- bot role cannot pass an arbitrary p_app to query existence or bypass p_id.
-- =============================================================================

CREATE OR REPLACE FUNCTION oshal_application_execution_claims(p_kind text, p_id text, p_enforce boolean)
  RETURNS TABLE (app text, protected boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT * FROM oshal_application_execution_claims(p_kind, p_id, NULL::text, p_enforce);
$$;

REVOKE ALL ON FUNCTION oshal_application_execution_claims(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_application_execution_claims(text, text, boolean) TO PUBLIC;
