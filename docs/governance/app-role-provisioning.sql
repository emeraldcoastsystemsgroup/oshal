-- ===========================================================================
-- app-role-provisioning.sql  (ADR-076)
--
-- ARTIFACT — apply DELIBERATELY, not auto-run by the app or any migration.
--
-- Creates the least-privilege runtime role `oshal_app` that the application
-- connects as. It is NOSUPERUSER + NOBYPASSRLS, so the row-level-security
-- policies from migration 060 actually enforce against it (Postgres skips RLS
-- for superuser/BYPASSRLS roles — that is why the app must stop running as the
-- superuser `oshal` for isolation to bite).
--
-- AS-BUILT NOTE: this app performs idempotent schema DDL at STARTUP (e.g.
-- createEducationRewardsRoutes), so a pure DML role + OSHAL_SCHEMA_BOOTSTRAP=
-- validate-only crash-loops (the DDL guard throws). The working posture is to
-- make `oshal_app` the OWNER of the tables — then FORCE ROW LEVEL SECURITY still
-- subjects the owner to RLS, while ownership lets the startup/migration DDL run.
-- The SECURITY DEFINER helper `oshal_is_tenant_member` MUST stay owned by a
-- BYPASSRLS role (the superuser `oshal`) so it bypasses RLS and the tenant-table
-- policies do not recurse. Do NOT reassign functions to oshal_app.
--
-- A cleaner separation (app does NO runtime DDL; oshal_app stays DML-only with
-- validate-only) is a follow-up that needs the startup DDL moved into migrations.
--
-- USAGE (run as the superuser `oshal`; pass the password as a psql variable so it
-- is never committed):
--     psql "$DATABASE_URL" -v app_pw="$(openssl rand -hex 24)" \
--          -f docs/governance/app-role-provisioning.sql
--     -- then reassign table/sequence/view ownership (see block at the end) and
--     -- point the app's runtime DATABASE_URL at:
--     --   postgresql://oshal_app:<app_pw>@oshal-db:5432/oshal
--
-- ROLLBACK (break-glass): repoint the app's DATABASE_URL back at the `oshal`
-- superuser role (RLS is bypassed again) or set OSHAL_DB_GUC=off. No data change.
-- ===========================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    CREATE ROLE oshal_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- Set/rotate the password (provided out-of-band via -v app_pw=...).
ALTER ROLE oshal_app WITH PASSWORD :'app_pw';

-- Defensive: ensure the attributes are correct even if the role pre-existed.
ALTER ROLE oshal_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- Schema + DML privileges (no DDL).
GRANT USAGE ON SCHEMA public TO oshal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oshal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oshal_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO oshal_app;

-- Future objects created by migrations (owned by `oshal`) auto-grant to oshal_app.
ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oshal_app;
ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO oshal_app;
ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO oshal_app;

-- ---------------------------------------------------------------------------
-- AS-BUILT ownership reassignment (required because the app does startup DDL).
-- Reassigns tables/sequences/views to oshal_app, but NOT functions (the
-- SECURITY DEFINER tenant helper must stay owned by the BYPASSRLS superuser).
-- FORCE ROW LEVEL SECURITY (set in migration 060) keeps the owner scoped.
-- ---------------------------------------------------------------------------
GRANT CREATE, USAGE ON SCHEMA public TO oshal_app;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO oshal_app', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO oshal_app', r.sequencename);
  END LOOP;
  FOR r IN SELECT table_name FROM information_schema.views WHERE table_schema='public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO oshal_app', r.table_name);
  END LOOP;
END
$$;
