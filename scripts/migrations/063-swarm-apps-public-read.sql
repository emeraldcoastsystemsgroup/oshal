-- ===========================================================================
-- 063-swarm-apps-public-read.sql
-- Make the swarm-application CATALOG readable by every signed-in user.
--
-- WHAT THIS DOES
--   Adds a PERMISSIVE FOR SELECT policy on swarm_applications for rows with
--   scope='public'. Migration 060 applied the generic personal-or-tenant RLS
--   policy to this table, treating it like per-user data — but it is a
--   catalog: framework apps are scope='public' with no owner_sub, so any
--   non-operator saw ZERO rows (GET /api/swarm/apps returned {apps: []} and
--   the /applications page rendered "No swarm applications loaded" for every
--   normal signed-in user; root-caused 2026-07-07 via a non-operator login).
--
-- NOTES
--   - SELECT-only: writes stay governed by swarm_applications_personal_or_tenant
--     (operator, own personal rows, or tenant membership) — a normal user still
--     cannot INSERT/UPDATE/DELETE public rows.
--   - The app layer (SwarmAppService.listApps -> isVisibleToCaller) already
--     models scope='public' as visible-to-all; this aligns the DB backstop
--     with that contract instead of silently emptying it.
--   - swarm_applications is created by 022-swarm-applications.sql, which sorts
--     before this file, so the table always exists when this runs.
--   - Idempotent: safe to re-run.
-- ===========================================================================

DROP POLICY IF EXISTS swarm_applications_public_read ON swarm_applications;
CREATE POLICY swarm_applications_public_read ON swarm_applications
  AS PERMISSIVE FOR SELECT
  USING (scope = 'public');
