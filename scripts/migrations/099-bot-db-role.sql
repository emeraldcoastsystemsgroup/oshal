/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K5 (BACKLOG kernel audit 2026-07-29): least-privilege oshal_bot role for bot-node containers. Bot containers inherited the superuser DSN, and Postgres exempts superuser and RLS-exempt-attribute roles from row-level security — so every bot node was an RLS bypass around the per-user isolation the platform is sold on. oshal_bot is NOSUPERUSER + NOBYPASSRLS + DML-only (no DDL, no ownership), so RLS policies enforce against every bot-path connection. Compose wires bots to it via BOT_DATABASE_URL (docker-compose.oshal-local.yml seq 5); guard: tests/unit/bot-db-least-privilege.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve migration 119's controller-only workload authority exception when this blanket role grant is re-run after the authority tables exist.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A GRANT that did nothing no longer records as APPLIED. Every block here degraded to a NOTICE, and the runner writes the app_migrations row either way, so this file appearing in the ledger proved only that it executed. Three of the six blocks now fail loud and the message names what could not be granted and the role it was attempted as; the two default-privilege blocks stay tolerant (the governed provisioner revokes exactly what they set on every boot) and the CREATE ROLE block stays tolerant (a NOCREATEROLE runner is a documented profile) but both now RAISE WARNING and the CREATE block still returns, so nothing downstream can claim a grant that never happened. Absence of an exception is NOT evidence the privileges landed: measured on postgres:16-alpine, GRANT USAGE ON SCHEMA public by a non-owner returns "WARNING: no privileges were granted" and succeeds, and REVOKE ALL by a grant-option holder that does not own the table succeeds silently while the grantee keeps every privilege — so the grant and the SEC-01 revoke are now VERIFIED against has_schema_privilege/has_table_privilege rather than inferred from a clean exit. Guard: tests/unit/bot-role-grant-fail-loud-postgres.spec.ts.
 */

-- =============================================================================
-- Migration 099: least-privilege bot-node database role (K5)
--
-- WHY A MIGRATION (vs the ADR-076 governance artifact): the compose api bootstrap
-- applies migrations FIRST over BOOTSTRAP_DATABASE_URL (the superuser), so on the
-- default flag-ON boot this runs with CREATEROLE privilege and the role exists
-- before any bot container starts (oshal-up.sh brings bots up last).
--
-- PRIVILEGE POSTURE — WHAT FAILS AND WHAT IS TOLERATED. This file used to degrade
-- EVERY block to a NOTICE. That is what let it record as applied on a run where the
-- grants did nothing, so the posture is now stated per block and enforced:
--
--   TOLERATED  CREATE ROLE without CREATEROLE. The legacy profile
--              (OSHAL_APP_ROLE_BOOTSTRAP=false, docs/runbooks/market-remediation.md)
--              runs migrations as oshal_app, which is NOCREATEROLE. The block warns
--              and RETURNS, so no later block runs and none can report a grant.
--   TOLERATED  ALTER DEFAULT PRIVILEGES FOR ROLE oshal / oshal_app, both when the
--              role is absent (undefined_object — the bootstrap role is `doadmin` on
--              managed PostgreSQL and neither runtime role exists yet on a fresh
--              compose boot) and when the runner may not change them. What they set
--              does not survive anyway: docs/governance/app-role-provisioning.sql
--              :181-206 REVOKEs exactly these default privileges from oshal_bot and
--              re-establishes its own on every api boot. Failing the boot over a
--              setting the next step deliberately discards would be a false alarm.
--   FAILS      An RLS-exempt oshal_bot this runner cannot correct. NOSUPERUSER +
--              NOBYPASSRLS is the entire point of the role; if the attributes have
--              drifted and the ALTER is refused, the migration must not certify it.
--              (Stated as "RLS-exempt" rather than the bare attribute keyword on
--              purpose: tests/unit/bot-db-least-privilege.spec.ts refuses any
--              non-NO-prefixed occurrence of it anywhere in this file.)
--   FAILS      The DML grant block, both on an exception and on a grant that lands
--              nothing. This is the block that has to work for a bot to read at all.
--   FAILS      The migration-119 workload-authority REVOKE. It is a security control
--              (a bot must never reach the delegation ledger directly) applied two
--              statements after the blanket grant handed it exactly those privileges.
--
-- ROLE SHAPE (deliberately weaker than oshal_app):
--   * oshal_app OWNS the tables (the api does startup DDL; FORCE RLS keeps the
--     owner scoped). Bot nodes do NO DDL — seedAgentProfile, work items,
--     chat_tasks cost rows, connector-token reads are all DML — so oshal_bot
--     owns NOTHING and gets plain RLS enforcement everywhere a policy exists.
--   * NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT.
--   * DML + sequence usage + EXECUTE only, plus default-privilege grants from
--     BOTH object-creating roles (oshal = migrations, oshal_app = runtime DDL)
--     so future tables stay readable without another migration. Controller-only
--     authorization tables added by migration 119 are explicitly revoked below.
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
DECLARE
  ungranted_count  integer;
  ungranted_sample text;
  still_granted    text;
BEGIN
  -- TOLERATED. Creating the role needs CREATEROLE; the legacy migration profile has
  -- none. Warn (not notice — a notice is invisible in a boot log) and RETURN, so the
  -- blocks below never run and none of them can report a grant that did not happen.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_bot') THEN
    BEGIN
      CREATE ROLE oshal_bot LOGIN PASSWORD 'oshal-bot-dev'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
      RAISE NOTICE 'migration 099: oshal_bot created (dev default password — rotate for production)';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'migration 099: oshal_bot NOT created and NOTHING below was applied — "%" lacks CREATEROLE. Re-run migrations over BOOTSTRAP_DATABASE_URL (superuser), or create the role manually.', current_user;
      RETURN;
    END;
  ELSE
    -- FAILS when it matters. A role that drifted back to a superuser or RLS-exempt
    -- attribute silently defeats the whole point of this migration, so a refused
    -- correction of THAT is fatal. A refused correction of NOCREATEDB/NOCREATEROLE/
    -- NOINHERIT on a role that is already NOSUPERUSER + NOBYPASSRLS is not, and warns.
    BEGIN
      ALTER ROLE oshal_bot NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    EXCEPTION WHEN insufficient_privilege THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_bot' AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'migration 099: oshal_bot carries a superuser or RLS-exempt attribute and "%" may not ALTER ROLE it — every bot connection would bypass row-level security. Re-run over BOOTSTRAP_DATABASE_URL (superuser).', current_user;
      END IF;
      RAISE WARNING 'migration 099: oshal_bot attribute converge skipped as "%" — NOSUPERUSER and NOBYPASSRLS already hold; NOCREATEDB/NOCREATEROLE/NOINHERIT were not converged.', current_user;
    END;
  END IF;

  -- FAILS. Schema usage + DML on everything that exists today. A GRANT by the table
  -- OWNER (oshal_app) or a superuser both succeed; anything else is a bot that cannot
  -- read, and this file recording as applied while that is true is the defect.
  BEGIN
    GRANT USAGE ON SCHEMA public TO oshal_bot;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oshal_bot;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oshal_bot;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO oshal_bot;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'migration 099: oshal_bot DML grants were REFUSED as "%" — %. Re-run migrations over BOOTSTRAP_DATABASE_URL (superuser) or as the table owner.', current_user, SQLERRM
      USING ERRCODE = 'insufficient_privilege';
  END;

  -- A clean exit is not evidence. GRANT USAGE ON SCHEMA public by a non-owner returns
  -- "WARNING: no privileges were granted" and SUCCEEDS, so the effective privilege is
  -- checked rather than inferred from the absence of an exception.
  IF NOT has_schema_privilege('oshal_bot', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'migration 099: GRANT USAGE ON SCHEMA public TO oshal_bot granted NOTHING as "%" (the statement warned instead of raising). Re-run over BOOTSTRAP_DATABASE_URL (superuser) or as the schema owner.', current_user;
  END IF;

  SELECT count(*), string_agg(relname, ', ' ORDER BY relname)
    INTO ungranted_count, ungranted_sample
    FROM (
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND NOT (has_table_privilege('oshal_bot', c.oid, 'SELECT')
              AND has_table_privilege('oshal_bot', c.oid, 'INSERT')
              AND has_table_privilege('oshal_bot', c.oid, 'UPDATE')
              AND has_table_privilege('oshal_bot', c.oid, 'DELETE'))
       ORDER BY c.relname
       LIMIT 20
    ) missing;
  IF ungranted_count > 0 THEN
    RAISE EXCEPTION 'migration 099: oshal_bot still lacks SELECT/INSERT/UPDATE/DELETE on % public table(s) after the grant, attempted as "%" — %', ungranted_count, current_user, ungranted_sample;
  END IF;

  -- TOLERATED. Future objects created by MIGRATIONS (run as `oshal`) auto-grant to
  -- oshal_bot. The role is named `doadmin` on managed PostgreSQL and does not exist at
  -- all on a fresh compose boot, and app-role-provisioning.sql:199-206 revokes exactly
  -- these default privileges from oshal_bot on every api boot regardless — so this
  -- block is convergence, not a control, and a failure here is a warning.
  BEGIN
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO oshal_bot;
  EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
    RAISE WARNING 'migration 099: default-privilege grants FOR ROLE oshal did NOT apply, attempted as "%" — % (the governed provisioner sets its own on the next api boot)', current_user, SQLERRM;
  END;

  -- TOLERATED, for the same reason: future objects created by the api RUNTIME
  -- (oshal_app startup DDL). oshal_app does not exist until provision-app-role.mjs
  -- runs, which is AFTER migrations on a fresh compose boot.
  BEGIN
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO oshal_bot;
    ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO oshal_bot;
  EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
    RAISE WARNING 'migration 099: default-privilege grants FOR ROLE oshal_app did NOT apply, attempted as "%" — % (the governed provisioner sets its own on the next api boot)', current_user, SQLERRM;
  END;

  -- FAILS. SEC-01 authority is intentionally not a bot-readable application table.
  -- Migration 119 revokes the default future-table grant at creation time; repeat that
  -- exception here so an operator re-running this convergent migration cannot silently
  -- restore bot ledger access — which the blanket grant above just handed back.
  --
  -- Verified, not assumed: measured on postgres:16-alpine, a REVOKE issued by a role
  -- holding GRANT OPTION but not ownership succeeds with no warning at all while the
  -- grantee keeps every privilege. Dropping the exception handler alone would not have
  -- caught that; reading the effective privilege afterwards does.
  IF to_regclass('public.oshal_workload_identities') IS NOT NULL
     AND to_regclass('public.oshal_user_delegations') IS NOT NULL THEN
    BEGIN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.oshal_workload_identities, public.oshal_user_delegations FROM oshal_bot';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'migration 099: the oshal_bot workload-authority REVOKE was refused as "%" — %. The bot would keep direct access to the delegation ledger; re-run over BOOTSTRAP_DATABASE_URL (superuser) or as the table owner.', current_user, SQLERRM
        USING ERRCODE = 'insufficient_privilege';
    END;

    SELECT string_agg(authority_table, ', ' ORDER BY authority_table)
      INTO still_granted
      FROM unnest(ARRAY['public.oshal_workload_identities', 'public.oshal_user_delegations']) AS authority_table
     WHERE has_table_privilege('oshal_bot', authority_table, 'SELECT')
        OR has_table_privilege('oshal_bot', authority_table, 'INSERT')
        OR has_table_privilege('oshal_bot', authority_table, 'UPDATE')
        OR has_table_privilege('oshal_bot', authority_table, 'DELETE');
    IF still_granted IS NOT NULL THEN
      RAISE EXCEPTION 'migration 099: oshal_bot STILL holds privileges on % after the revoke ran as "%" — the statement reported success and removed nothing.', still_granted, current_user;
    END IF;
  END IF;
END
$$;
