-- ===========================================================================
-- 060-platform-rls-tenancy.sql
-- ADR-076 — Tenant-aware row-level security across the platform.
--
-- WHAT THIS DOES
--   Extends the owner-or-operator RLS already enforced on tickets/workspaces/
--   chat_tasks/access_audit_log (see docs/governance/rls-policies-enforce.sql)
--   to EVERY table that carries a per-user or per-tenant owner column, in three
--   tiers:
--     * user-private  : owner_col = current_setting('oshal.current_sub')
--     * tenant-shared : caller is a member of the row's tenant (household/org)
--     * dual          : personal rows (tenant_id IS NULL) are owner-scoped,
--                       shared rows (tenant_id IS NOT NULL) are tenant-scoped
--   A trusted SYSTEM context (oshal.is_operator = 'on') bypasses every policy so
--   schedulers, the queue manager and bot runtimes are never starved to 0 rows.
--
-- WHY IT IS SAFE TO AUTO-APPLY
--   Postgres SKIPS RLS for superuser / BYPASSRLS roles. While the app still
--   connects as the superuser `oshal` role these policies are inert (zero
--   behaviour change). They only begin to enforce once the app is switched to the
--   least-privilege `oshal_app` role — see docs/governance/app-role-provisioning.sql
--   and ADR-076. The GUC plumbing that makes this safe (oshal.current_sub /
--   oshal.is_operator stamped per query) is already ON by default via
--   src/shared/services/database/guc-pool.ts.
--
-- IDEMPOTENT: re-runnable. Policies are dropped-if-exists then recreated.
--
-- FRESH-DATABASE TOLERANCE (2026-07-04, A1.2): a handful of listed tables are
-- created LAZILY by their in-app stores (finance, youtube, trading equity/peaks,
-- tv_token_revocations) rather than by an earlier migration, so on a fresh DB
-- they do not exist when this migration runs. Each loop now skips (with a NOTICE)
-- any table that is absent instead of aborting the whole migration — an abort
-- here blocked 061 and left EVERY table without policies. Skipped tables get
-- their policies on the next re-run of this file's DO blocks (they are re-runnable);
-- tracked in BACKLOG: teach the lazy-DDL chokepoint to apply tier policies at
-- CREATE time so a late-created table is never policy-less.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Tenancy registry tables (2026-07-04, A1.2 fresh-boot fix). These were only
-- created LAZILY by src/app/routes/connector-tenancy.ts, so on a FRESH database
-- the SQL-language helper below failed body validation ('relation
-- "oshal_tenant_memberships" does not exist') and aborted this migration during
-- the pre-server superuser pass — which also left the SECURITY DEFINER helper
-- to be created later by the app role instead of the superuser. DDL mirrors
-- connector-tenancy.ts exactly; both sides are idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oshal_tenants (
  tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(16) NOT NULL DEFAULT 'space',
  name TEXT,
  created_by_sub TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oshal_tenant_memberships (
  tenant_id UUID NOT NULL REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  user_sub TEXT NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_sub)
);

-- ---------------------------------------------------------------------------
-- Tenant-membership helper. SECURITY DEFINER so the membership lookup itself is
-- NOT subject to RLS (prevents infinite recursion when policies on tenant tables
-- consult membership). Reads identity from the per-connection GUC the app sets.
-- search_path is pinned per SECURITY DEFINER best practice.
-- ---------------------------------------------------------------------------
-- Param is text (not uuid): tenant_id is uuid on most tables but text on a few
-- app-specific ones (career_hunter_*, optimize_configs, token_chase_*). Call sites
-- pass tenant_id::text so one helper serves both; the membership column is cast to
-- text for the comparison.
CREATE OR REPLACE FUNCTION oshal_is_tenant_member(p_tenant text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM oshal_tenant_memberships m
    WHERE m.tenant_id::text = p_tenant
      AND m.user_sub = current_setting('oshal.current_sub', true)
  );
$$;

REVOKE ALL ON FUNCTION oshal_is_tenant_member(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_is_tenant_member(text) TO PUBLIC;

-- ===========================================================================
-- TIER 1 — user-private tables (single owner column).
-- Visible/mutable only by the owning user, or a trusted system/operator context.
-- ===========================================================================
DO $rls$
DECLARE
  r record;
  pol text;
BEGIN
  FOR r IN
    SELECT tbl, col FROM (VALUES
      -- Eats
      ('eats_cart_items','user_sub'),('eats_carts','user_sub'),
      ('eats_conversations','user_sub'),('eats_feedback','user_sub'),
      ('eats_messages','user_sub'),('eats_orders','user_sub'),
      -- Feeds
      ('feed_messages','user_sub'),('feed_settings','user_sub'),
      -- Jarvis
      ('jarvis_tasks','user_sub'),
      -- Movies
      ('movies_conversations','user_sub'),('movies_feedback','user_sub'),
      ('movies_messages','user_sub'),('movies_profile','user_sub'),
      ('movies_watchlist','user_sub'),
      -- Content studio
      ('oshal_content_articles','user_sub'),('oshal_content_drafts','user_sub'),
      ('oshal_content_focus','user_sub'),('oshal_content_settings','user_sub'),
      ('oshal_content_topics','user_sub'),
      -- Email / inbox
      ('oshal_email_digests','user_sub'),('oshal_inbox_cursor','user_sub'),
      ('oshal_inbox_messages','user_sub'),
      -- Finance
      ('oshal_finance_data','user_sub'),('oshal_finance_items','user_sub'),
      ('oshal_finance_payments','user_sub'),('oshal_merchant_payments','user_sub'),
      -- Presentations / video / youtube
      ('oshal_presentations','user_sub'),('oshal_videos','user_sub'),
      ('oshal_youtube_activity','user_sub'),
      -- Security center
      ('oshal_security_findings','user_sub'),('oshal_security_scans','user_sub'),
      -- Storage prefs / encryption keys
      ('oshal_storage_prefs','user_sub'),('oshal_user_deks','user_sub'),
      -- Trading (per-user signals/predictions/decisions + the actual trades made)
      ('oshal_trading_decisions','user_sub'),('oshal_trading_equity_hwm','user_sub'),
      ('oshal_trading_orders','user_sub'),('oshal_trading_peaks','user_sub'),
      ('oshal_trading_predictions','user_sub'),('oshal_trading_signals','user_sub'),
      -- LoRA
      ('oshal_lora_characters','owner_sub'),
      -- Rides
      ('rides_conversations','user_sub'),('rides_messages','user_sub'),
      ('rides_requests','user_sub'),
      -- Shop (single-owner subset)
      ('shop_conversations','user_sub'),('shop_list_items','user_sub'),
      ('shop_messages','user_sub'),('shop_purchase_history','user_sub'),
      -- Spotify
      ('spotify_conversations','user_sub'),('spotify_feedback','user_sub'),
      ('spotify_messages','user_sub'),('spotify_profile','user_sub'),
      -- Travel (single-owner subset)
      ('travel_conversations','user_sub'),('travel_feedback','user_sub'),
      ('travel_messages','user_sub'),('travel_searches','user_sub'),
      ('travel_watches','user_sub'),
      -- TV device-link
      ('tv_token_revocations','user_sub'),
      -- Onboarding prefs + saved swarm presets (owner column is named user_id)
      ('user_preferences','user_id'),('swarm_presets','user_id')
    ) AS v(tbl, col)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE NOTICE 'rls-tenancy: skipping absent table % (lazy in-app DDL; policies apply on re-run)', r.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.tbl);
    pol := r.tbl || '_owner_or_operator';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, r.tbl);
    EXECUTE format($f$
      CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL
        USING (%I = current_setting('oshal.current_sub', true)
               OR current_setting('oshal.is_operator', true) = 'on')
        WITH CHECK (%I = current_setting('oshal.current_sub', true)
               OR current_setting('oshal.is_operator', true) = 'on')
    $f$, pol, r.tbl, r.col, r.col);
  END LOOP;
END
$rls$;

-- ===========================================================================
-- TIER 2 — dual tables (owner column + tenant_id).
-- Personal rows (tenant_id IS NULL) are owner-scoped; rows shared into a
-- household/org (tenant_id IS NOT NULL) are visible to that tenant's members.
-- ===========================================================================
DO $rls$
DECLARE
  r record;
  pol text;
BEGIN
  FOR r IN
    SELECT tbl, col FROM (VALUES
      ('eats_profile','user_sub'),
      ('career_hunter_applications','user_sub'),
      ('optimize_configs','user_sub'),
      ('oshal_connections','user_sub'),
      ('rides_profile','user_sub'),
      ('shop_feedback','user_sub'),
      ('shop_lists','user_sub'),
      ('shop_preferences','user_sub'),
      ('shop_profile','user_sub'),
      ('token_chase_optimizer_corpus','user_sub'),
      ('travel_profile','user_sub'),
      ('vids_jobs','user_sub'),
      ('swarm_applications','owner_sub')
    ) AS v(tbl, col)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE NOTICE 'rls-tenancy: skipping absent table % (lazy in-app DDL; policies apply on re-run)', r.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.tbl);
    pol := r.tbl || '_personal_or_tenant';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, r.tbl);
    EXECUTE format($f$
      CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL
        USING (
          current_setting('oshal.is_operator', true) = 'on'
          OR (tenant_id IS NULL AND %I = current_setting('oshal.current_sub', true))
          OR (tenant_id IS NOT NULL AND oshal_is_tenant_member(tenant_id::text))
        )
        WITH CHECK (
          current_setting('oshal.is_operator', true) = 'on'
          OR (tenant_id IS NULL AND %I = current_setting('oshal.current_sub', true))
          OR (tenant_id IS NOT NULL AND oshal_is_tenant_member(tenant_id::text))
        )
    $f$, pol, r.tbl, r.col, r.col);
  END LOOP;
END
$rls$;

-- ===========================================================================
-- TIER 2 — tenant-only tables (tenant_id, no per-user owner column).
-- Visible to members of that tenant, or a trusted system/operator context.
-- ===========================================================================
DO $rls$
DECLARE
  r record;
  pol text;
BEGIN
  FOR r IN
    SELECT tbl FROM (VALUES
      ('career_hunter_tenants'),
      ('shop_tenants'),
      ('travel_tenants')
    ) AS v(tbl)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE NOTICE 'rls-tenancy: skipping absent table % (lazy in-app DDL; policies apply on re-run)', r.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.tbl);
    pol := r.tbl || '_tenant_member';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol, r.tbl);
    EXECUTE format($f$
      CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL
        USING (current_setting('oshal.is_operator', true) = 'on'
               OR oshal_is_tenant_member(tenant_id::text))
        WITH CHECK (current_setting('oshal.is_operator', true) = 'on'
               OR oshal_is_tenant_member(tenant_id::text))
    $f$, pol, r.tbl);
  END LOOP;
END
$rls$;

-- ===========================================================================
-- TIER 2 — tenant registry + membership (special: include creator / self row so
-- a user can always see the tenants they created and their own membership rows,
-- which is what bootstraps access before any membership join resolves).
-- ===========================================================================

-- oshal_tenants: creator OR member OR operator.
ALTER TABLE oshal_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_tenants_member_or_creator ON oshal_tenants;
CREATE POLICY oshal_tenants_member_or_creator ON oshal_tenants
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR created_by_sub = current_setting('oshal.current_sub', true)
    OR oshal_is_tenant_member(tenant_id::text)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR created_by_sub = current_setting('oshal.current_sub', true)
    OR oshal_is_tenant_member(tenant_id::text)
  );

-- oshal_tenant_memberships: a user sees their own membership rows; tenant members
-- see co-members; operator sees all. (Reads the table the helper also reads, but
-- the helper is SECURITY DEFINER so it does not re-trigger this policy.)
ALTER TABLE oshal_tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_tenant_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_tenant_memberships_self_or_member ON oshal_tenant_memberships;
CREATE POLICY oshal_tenant_memberships_self_or_member ON oshal_tenant_memberships
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR user_sub = current_setting('oshal.current_sub', true)
    OR oshal_is_tenant_member(tenant_id::text)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR user_sub = current_setting('oshal.current_sub', true)
    OR oshal_is_tenant_member(tenant_id::text)
  );

COMMIT;

-- ===========================================================================
-- DEFERRED (Phase 2 — NOT covered here; documented in ADR-076).
-- These hold user data but lack a direct owner/tenant column, so they need
-- join-based policies or a schema change and are intentionally left on
-- app-level filtering for now (no regression vs today):
--   * personal_graph_nodes / personal_graph_edges  (NO owner column — needs one)
--   * chat_messages / agent_memories / knowledge_memory_documents (keyed by task/agent)
--   * lm_assignments, lm_calendar_events, lm_enrollments, lm_flashcard_progress,
--     lm_flashcard_sets, lm_flashcards, lm_lectures, lm_materials, lm_notifications,
--     lm_quiz_results, lm_rewards, lm_xp_events  (keyed by student_id -> lm_students)
-- ===========================================================================
