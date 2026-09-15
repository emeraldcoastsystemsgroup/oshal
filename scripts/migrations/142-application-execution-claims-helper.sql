/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Application execution ownership as a derived SECURITY DEFINER helper, so the ADR-149 posture guard can run on a bot node within the governed bot contract. The bot is given the decision (which application claims this bot or tool, and is it protected), not the tables. Replaces migration 140, whose table grants the role provisioner correctly strips on every boot. No top-level BEGIN/COMMIT: the runner owns the transaction (tests/unit/migration-transactionality.spec.ts).
 */

-- =============================================================================
-- Migration 142: application execution ownership, derived for the bot contract
--
-- THE QUESTION
--   The ADR-149 posture guard asks one thing, in two places: "which application
--   claims this bot (or tool), and is that application protected?" The
--   controller asks it as oshal_app; every bot node asks it as oshal_bot before
--   accepting an execution (src/app/bot-node-application-authorization.ts),
--   and fails closed on any error.
--
-- WHY THE BOT COULD NOT ANSWER IT
--   The answer lives in oshal_authorization_applications and
--   swarm_applications. The governed bot contract
--   (docs/governance/app-role-provisioning.sql, converged and verified by
--   scripts/governance/provision-app-role.mjs on every boot) deliberately gives
--   oshal_bot neither table, and swarm_applications' policy calls
--   oshal_is_tenant_member, which is private to oshal_app. So every bot
--   execution answered authorization_bot_posture_unavailable (BUG-25).
--   Migration 140 granted the tables directly; the provisioner removed those
--   grants on the next boot, as it is designed to.
--
-- THE FIX, IN THE CONTRACT'S OWN PATTERN
--   A SECURITY DEFINER helper that returns the derived answer and nothing else:
--   one row per claiming application, (app, protected), for one executable id
--   or one application name - the same shape as oshal_owns_ticket, the helper
--   the bot contract already includes. The query is the one
--   readApplicationExecutionOwnership ran inline; the controller and the bot now
--   both call this helper, so there is one definition of ownership.
--
--   An unknown kind or an empty id RAISES rather than returning no rows: "no
--   claimant" means "unprotected" to the caller, so an empty answer to a bad
--   question would fail open.
--
-- GRANTS
--   REVOKE ALL FROM PUBLIC, then EXECUTE to PUBLIC - exactly what migration 113
--   does for oshal_owns_ticket - so a deployment that never runs the role
--   provisioner keeps working. The provisioner's final phase narrows EXECUTE to
--   oshal_app and oshal_bot, and verifies owner, search_path and ACL each boot.
-- =============================================================================

CREATE OR REPLACE FUNCTION oshal_application_execution_claims(p_kind text, p_id text, p_app text, p_enforce boolean)
  RETURNS TABLE (app text, protected boolean)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('bots', 'tools') OR p_id IS NULL OR p_id = '' THEN
    RAISE EXCEPTION 'oshal_application_execution_claims: kind must be bots or tools and id must be set'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT ownership.app, bool_or(ownership.protected)
      FROM (
        SELECT aa.app_name::text AS app, aa.protected AS protected
          FROM oshal_authorization_applications aa
         WHERE CASE WHEN p_app IS NULL
                    THEN p_id = ANY(CASE WHEN p_kind = 'bots' THEN aa.agent_ids::text[] ELSE aa.tool_names::text[] END)
                    ELSE aa.app_name = p_app END
        UNION ALL
        SELECT sa.name::text AS app,
               (sa.manifest ? 'authorization' OR COALESCE(claimed.protected, FALSE)
                OR (p_enforce AND replace(sa.manifest_path, chr(92), '/') ~ '(^|/)oshal-app[.]yaml$')) AS protected
          FROM swarm_applications sa
          LEFT JOIN oshal_authorization_applications claimed ON claimed.app_name = sa.name
         WHERE CASE WHEN p_app IS NULL
                    THEN p_id = ANY(CASE WHEN p_kind = 'bots' THEN sa.agent_ids::text[] ELSE sa.tool_names::text[] END)
                    ELSE sa.name = p_app END
      ) ownership
     GROUP BY ownership.app;
END;
$$;

REVOKE ALL ON FUNCTION oshal_application_execution_claims(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_application_execution_claims(text, text, text, boolean) TO PUBLIC;
