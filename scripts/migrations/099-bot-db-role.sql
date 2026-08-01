/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K5 (BACKLOG kernel audit 2026-07-29): least-privilege oshal_bot role for bot-node containers. Bot containers inherited the superuser DSN, and Postgres exempts superuser and RLS-exempt-attribute roles from row-level security — so every bot node was an RLS bypass around the per-user isolation the platform is sold on. oshal_bot is NOSUPERUSER + NOBYPASSRLS + DML-only (no DDL, no ownership), so RLS policies enforce against every bot-path connection. Compose wires bots to it via BOT_DATABASE_URL (docker-compose.oshal-local.yml seq 5); guard: tests/unit/bot-db-least-privilege.spec.ts.
 */

-- =============================================================================
-- Migration 099: least-privilege bot-node database role (K5)
--
-- WHY A MIGRATION (vs the ADR-076 governance artifact): the compose api bootstrap
-- applies migrations FIRST over BOOTSTRAP_DATABASE_URL (the superuser), so on the
-- default flag-ON boot this runs with CREATEROLE privilege and the role exists
-- before any bot container starts (oshal-up.sh brings bots up last). The whole
-- file is privilege-TOLERANT: when re-run by the api's own in-process migration
-- pass as oshal_app (NOCREATEROLE), every statement that needs superuser degrades
-- to a NOTICE instead of failing the bootstrap chain.
--
-- ROLE SHAPE (deliberately weaker than oshal_app):
--   * oshal_app OWNS the tables (the api does startup DDL; FORCE RLS keeps the
--     owner scoped). Bot nodes do NO DDL — seedAgentProfile, work items,
--     chat_tasks cost rows, connector-token reads are all DML — so oshal_bot
--     owns NOTHING and gets plain RLS enforcement everywhere a policy exists.
--   * NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT.
--   * DML + sequence usage + EXECUTE only, plus default-privilege grants from
--     BOTH object-creating roles (oshal = migrations, oshal_app = runtime DDL)
--     so future tables stay readable without another migration.
--
-- PASSWORD: the dev default below matches the compose default DSN
-- (postgresql://oshal_bot:oshal-bot-dev@oshal-db:5432/oshal) — the same posture
-- as the tracked oshal_app:oshal-app-dev dev default. Set ONLY on first create;
-- production rotates it out-of-band and points BOT_DATABASE_URL at the new
-- password (the operator .env never travels through git):
--   ALTER ROLE oshal_bot WITH PASSWORD '<new>';
--
-- ROLLBACK (break-glass): point BOT_DATABASE_URL back at the superuser DSN.
-- No data change; RLS is simply bypassed again on bot paths.
-- =============================================================================

DO $$
BEGIN
  -- Create the role (needs CREATEROLE/superuser — tolerate its absence).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_bot') THEN
    BEGIN
      CREATE ROLE oshal_bot LOGIN PASSWORD 'oshal-bot-dev'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
      RAISE NOTICE 'oshal_bot created (dev default password — rotate for production)';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'oshal_bot NOT created — current role lacks CREATEROLE. Re-run migrations over BOOTSTRAP_DATABASE_URL (superuser), or create the role manually.';
      RETURN;  -- nothing below can succeed without the role
    END;
  ELSE
    -- Defensive: converge the attributes even if the role pre-existed (a role
    -- that drifted back to an RLS-exempt attribute would silently defeat the whole point).
    BEGIN
      ALTER ROLE oshal_bot NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'oshal_bot attribute converge skipped (insufficient privilege)';
    END;
  END IF;

  -- Schema usage + DML on everything that exists today. GRANT by the table
  -- OWNER (oshal_app) or superuser both succeed; tolerate anything else.
  BEGIN
    GRANT USAGE ON SCHEMA public TO oshal_bot;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oshal_bot;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oshal_bot;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO oshal_bot;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'oshal_bot DML grants incomplete (insufficient privilege) — re-run as superuser';
  END;

  -- Future objects created by MIGRATIONS (run as `oshal`) auto-grant to oshal_bot.
  BEGIN
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO oshal_bot;
  EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
    RAISE NOTICE 'default-privilege grants FOR ROLE oshal skipped (insufficient privilege or role absent)';
  END;

  -- Future objects created by the api RUNTIME (oshal_app startup DDL) too.
  BEGIN
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO oshal_bot;
  EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
    RAISE NOTICE 'default-privilege grants FOR ROLE oshal_app skipped (insufficient privilege or role absent)';
  END;
END
$$;
