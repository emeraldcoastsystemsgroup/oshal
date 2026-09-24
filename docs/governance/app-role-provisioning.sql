-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Converge superuser-created runtime role ADMIN membership without regranting it from managed non-superuser creators.
-- 2 | maintainer@emeraldcoastsystemsgroup.com | Reset legacy app table and sequence default grants before establishing the exact runtime privilege allowlist.
-- 3 | maintainer@emeraldcoastsystemsgroup.com | Add the derived application-execution-ownership helper (migration 142) to the bot contract: EXECUTE for oshal_app and oshal_bot, never PUBLIC. A bot node's ADR-149 posture guard needs that one decision; the tables behind it stay outside the contract, which is why migration 140's direct grants were stripped here on every boot.
-- 4 | maintainer@emeraldcoastsystemsgroup.com | Close three measured bot gaps without widening the contract. (a) Both ticket upserts read the columns their conflict target and update expression name, so PostgreSQL requires SELECT on exactly those columns: ticket_task_links gains SELECT(role) and ticket_agent_assignments gains SELECT(ticket_id, agent_id, role). Measured by running the two statements as oshal_bot against a private server with the shipped migrations - with the previous grants both raise 42501 permission denied, with these they succeed, and created_at/assigned_at stay ungranted because neither statement needs them. (b) The durable swarm-memory recall reaches the new derived helper (migration 152) instead of the table: oshal_swarm_memory stays entirely outside the contract, and the owner rule lives in SQL rather than in an application filter. (c) the agent-tool resolver's join selects install_verified, tool_config, created_at and updated_at, none of which the allowlist carried, so agent_tools answered 42501 too - measured the same way. (d) oshal_bot's connection limit follows the declared bot fleet - 38 bot-node services at DB_MAX_CONNECTIONS=3 is 114 - instead of 8, which every fleet boot exhausted; the ceiling still fits inside max_connections=200 beside oshal_app's 24.
-- 5 | maintainer@emeraldcoastsystemsgroup.com | Operator decision 2026-09-22 ("column-level SELECT via the governed allowlist; RLS scopes rows"; SECURITY DEFINER helpers declined): the bot-node read-only question tools read through oshal_bot and the contract carried none of it - measured live as no SELECT on chat_tasks, chat_messages or rag_chunks and no EXECUTE on oshal_owns_task. chat_tasks SELECT gains title and updated_at; chat_messages enters with SELECT(task_id, text, created_at); rag_chunks enters with SELECT(chunk_id, collection, document, embedding, fts, metadata), granted inside a DO block because migration 070 creates that table only where the vector extension exists; oshal_owns_task(text) becomes executable by oshal_bot because the chat_messages policy calls it. Each list is exactly the columns the reading SQL names (chat-search-source.ts, pgvector-rag-engine.ts) and no more; the verifier in provision-app-role.mjs carries the same lists.
-- ===========================================================================
-- app-role-provisioning.sql  (ADR-076)
--
-- Idempotently creates and converges the two runtime roles used by OSHAL:
--   * oshal_app: owns application relations because startup still performs DDL
--   * oshal_bot: DML-only worker role; owns no relations
--
-- Run this through scripts/governance/provision-app-role.mjs. The wrapper
-- supplies app_pw and bot_pw without logging either value and verifies the
-- resulting ownership/RLS posture. Direct psql use remains supported:
--
--   psql "$BOOTSTRAP_DATABASE_URL" \
--     -v app_pw="$(openssl rand -hex 24)" \
--     -v bot_pw="$(openssl rand -hex 24)" \
--     -f docs/governance/app-role-provisioning.sql
--   # The SQL deliberately leaves oshal_bot NOLOGIN. The Node wrapper performs
--   # exact posture checks and activates login transactionally afterward.
--
-- Managed-Postgres compatibility is deliberate:
--   * The migration owner is CURRENT_USER, never a hard-coded local role.
--     DigitalOcean uses doadmin; the local stack uses oshal.
--   * ALTER OWNER requires SET-capable membership in the destination role on
--     PostgreSQL 16+. PG18's explicit membership options are used so SET and
--     INHERIT can never depend on cluster defaults.
--   * SECURITY DEFINER functions stay owned by the bootstrap role. That role
--     must be SUPERUSER or BYPASSRLS (DigitalOcean doadmin is BYPASSRLS), which
--     is verified by the wrapper so derived-owner helpers cannot recurse.
--     It also needs CREATEROLE+CREATEDB to converge the runtime attributes to
--     NOCREATEROLE+NOCREATEDB without a superuser-only ALTER ROLE path.
--   * Extension-owned objects are excluded from ALTER OWNER.
--
-- The file intentionally contains no production password defaults.
-- ===========================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    CREATE ROLE oshal_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_bot') THEN
    CREATE ROLE oshal_bot NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- Do not repeat NOSUPERUSER in ALTER ROLE. PostgreSQL 18 correctly refuses that
-- option to a non-superuser CREATEROLE admin even when the target is already
-- non-superuser. The wrapper verifies rolsuper=false after this transaction.
ALTER ROLE oshal_app WITH PASSWORD :'app_pw'
  LOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 24 VALID UNTIL 'infinity';
-- The ceiling is the DECLARED bot fleet, not a round number: 38 bot-node services in
-- docker-compose.oshal-local.yml, each pool capped at DB_MAX_CONNECTIONS=3, is 114, and the
-- spare six covers the one-shot oshal_bot callers (bot-node-batch, record-cost,
-- finalize-incident). 120 + oshal_app's 24 + superuser_reserved_connections sits well inside
-- max_connections=200. The old ceiling of 8 was below a single container's pool times two, so
-- a fleet boot raised FATAL too many connections for role "oshal_bot" in 24 of 36 containers
-- and the bots that lost the race refused execution with an authorization-shaped message.
-- tests/unit/managed-postgres-pool-budget.spec.ts derives all three numbers and fails when a
-- new bot service pushes the fleet past this ceiling.
ALTER ROLE oshal_bot WITH PASSWORD :'bot_pw'
  NOLOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 120 VALID UNTIL 'infinity';
ALTER ROLE oshal_app RESET ALL;
ALTER ROLE oshal_bot RESET ALL;

REVOKE CONNECT, TEMPORARY ON DATABASE :DBNAME FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :DBNAME TO oshal_app;
GRANT CONNECT ON DATABASE :DBNAME TO oshal_bot;
REVOKE TEMPORARY ON DATABASE :DBNAME FROM oshal_bot;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, oshal_bot;
GRANT USAGE ON SCHEMA public TO oshal_app, oshal_bot;
GRANT CREATE ON SCHEMA public TO oshal_app;

-- Only non-superuser CREATEROLE creators receive ADMIN TRUE automatically.
-- Local superuser-created roles need that option established explicitly.
-- Managed creators must preserve their existing ADMIN grant: PostgreSQL rejects
-- granting ADMIN back to their own grantor. The wrapper proves all options.
DO $runtime_membership$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT oshal_app TO CURRENT_USER WITH ADMIN TRUE;
    GRANT oshal_bot TO CURRENT_USER WITH ADMIN TRUE;
  END IF;
END
$runtime_membership$;

-- doadmin must inherit app-owner privileges because migrations and the RLS
-- applier run without SET ROLE; bot privileges must never be inherited.
GRANT oshal_app TO CURRENT_USER WITH SET TRUE, INHERIT TRUE;
GRANT oshal_bot TO CURRENT_USER WITH SET FALSE, INHERIT FALSE;

COMMIT;

-- NOLOGIN must commit before existing worker sessions are terminated; otherwise
-- another worker could reconnect before the catalog change becomes visible.
-- The managed preflight proves pg_signal_backend authority before any mutation.
SELECT pg_terminate_backend(pid, 5000)
  FROM pg_stat_activity
 WHERE usename = 'oshal_bot' AND pid <> pg_backend_pid();
DO $$
BEGIN
  -- The Node wrapper delivers this whole file as one simple-query batch, so the
  -- terminate above and this check share one implicit transaction, and
  -- pg_stat_activity is served from a per-transaction backend-status snapshot
  -- taken during the terminate. Discard it or this check re-reads the
  -- already-dead session and fails every wrapper-driven run (psql was immune:
  -- it sends one statement per message). pg_terminate_backend(pid, 5000) has
  -- already waited for actual process exit, so the fresh read is authoritative.
  PERFORM pg_stat_clear_snapshot();
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity
     WHERE usename = 'oshal_bot' AND pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'oshal_bot sessions survived the pre-migration lockdown';
  END IF;
END
$$;

-- The Node wrapper removes this marked section during pre-migration role
-- convergence. Keep relation ownership, default ACLs, and object ACL convergence
-- below this boundary: a failed partial migration must remain safely retryable.
-- OSHAL_FINAL_PHASE_BEGIN

BEGIN;

DO $$
DECLARE r record;
BEGIN
  -- Migration 099 historically granted the bot every public relation. Clear
  -- direct grants on bootstrap-owned objects before ownership convergence.
  FOR r IN
    SELECT c.relkind, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype = 'e'
       )
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC, oshal_bot', r.relname);
    ELSE
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, oshal_bot', r.relname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure::text AS signature,
           NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid
                AND d.deptype = 'e'
           ) AS is_non_extension
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM oshal_bot', r.signature);
    IF r.is_non_extension THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.signature);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO oshal_app', r.signature);
    END IF;
  END LOOP;
END
$$;

-- Future migration-owned objects. Without FOR ROLE this correctly targets
-- the connected bootstrap role on local Postgres and DigitalOcean alike.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, oshal_bot, oshal_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, oshal_bot, oshal_app;
ALTER DEFAULT PRIVILEGES
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM oshal_bot;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oshal_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO oshal_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO oshal_app;

-- PostgreSQL tracks defaults per object creator. Converge the app owner's
-- defaults explicitly; SET ROLE alone is not a reliable target selector for
-- ALTER DEFAULT PRIVILEGES on managed PG18.
ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, oshal_bot;
ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, oshal_bot;
ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE oshal_app IN SCHEMA public
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM oshal_bot;

DO $$
DECLARE r record;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'f'
  ) THEN
    RAISE EXCEPTION 'public foreign tables are unsupported by managed bootstrap; migrate them explicitly before provisioning';
  END IF;

  -- Transfer table-like objects first. ALTER TABLE also transfers the ownership
  -- of identity/serial sequences linked to their columns.
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'oshal_app')
       AND NOT EXISTS (
         SELECT 1
           FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO oshal_app', r.relname);
  END LOOP;

  -- Views are independent schema objects and follow tables so their dependency
  -- graph remains intact while ownership converges.
  FOR r IN
    SELECT c.relkind, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('v', 'm')
       AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'oshal_app')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype = 'e'
       )
  LOOP
    IF r.relkind = 'v' THEN
      EXECUTE format('ALTER VIEW public.%I OWNER TO oshal_app', r.relname);
    ELSE
      EXECUTE format('ALTER MATERIALIZED VIEW public.%I OWNER TO oshal_app', r.relname);
    END IF;
  END LOOP;

  -- Standalone sequences need an explicit transfer. Skip extension objects and
  -- sequences linked to a table column (serial/identity); their ownership is
  -- governed by the table and PostgreSQL rejects an independent owner change.
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'S'
       AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'oshal_app')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype IN ('a', 'i', 'e')
       )
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO oshal_app', r.relname);
  END LOOP;
END
$$;

-- Runtime-created objects are owned by oshal_app. Remove the historical broad
-- bot grants/defaults under that owner, then install the reviewed CRM worker
-- allowlist. Column grants are intentional: the shared bot role is not an
-- application/controller identity and must not mutate authority/config fields.
SET LOCAL ROLE oshal_app;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relkind, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'oshal_app')
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype = 'e'
       )
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC, oshal_bot', r.relname);
    ELSE
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, oshal_bot', r.relname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'oshal_app')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, oshal_bot', r.signature);
  END LOOP;
END
$$;

GRANT SELECT (
  agent_id, name, status, api_provider_id, model_id, persona, metadata,
  base_capabilities, base_selector_descriptor, base_routing_keywords, updated_at
) ON TABLE public.agents TO oshal_bot;

GRANT SELECT (
  tool_id, name, type, display_name, description, category, install_spec,
  version, skills, selector_fragment, routing_tags, input_schema, output_schema,
  usage_instructions, examples, auth_group, default_auth_mode,
  requires_approval, timeout_ms, tags, enabled, registered_by, registered_at,
  created_at, updated_at
) ON TABLE public.tools TO oshal_bot;

-- The tool resolver selects the whole link row (agent-tool-repository.ts), so the allowlist has
-- to carry install_verified, tool_config and the two timestamps as well; installed_at is not
-- selected and stays out. agent_tools is swarm configuration, not anyone's data.
GRANT SELECT (agent_id, tool_id, auth_mode, installed, install_verified, tool_config,
              created_at, updated_at)
  ON TABLE public.agent_tools TO oshal_bot;

GRANT SELECT ON TABLE public.persona_layers TO oshal_bot;

GRANT SELECT ON TABLE public.work_items TO oshal_bot;
GRANT UPDATE (status, assigned_agent_id, execution_output, updated_at)
  ON TABLE public.work_items TO oshal_bot;

-- title and updated_at are what the bot-node conversation read (chat-search-source.ts) selects
-- beyond the cost-rollup columns already here; message_count, turn_count, processing_mode and
-- created_at are named by no bot read and stay out.
GRANT SELECT (
  task_id, status, agent_id, provider_id, total_input_tokens,
  total_output_tokens, total_input_cost, total_output_cost, total_cost,
  total_requests, cost_currency, usage_by_model, owner_sub, metadata,
  title, updated_at
) ON TABLE public.chat_tasks TO oshal_bot;
GRANT INSERT (
  task_id, title, status, processing_mode, agent_id, provider_id, message_count,
  turn_count, total_input_tokens, total_output_tokens, total_input_cost,
  total_output_cost, total_cost, total_requests, cost_currency, usage_by_model,
  metadata, owner_sub, created_at, updated_at
) ON TABLE public.chat_tasks TO oshal_bot;
GRANT UPDATE (
  status, agent_id, provider_id, total_input_tokens, total_output_tokens,
  total_input_cost, total_output_cost, total_cost, total_requests,
  cost_currency, usage_by_model, owner_sub, metadata, updated_at
) ON TABLE public.chat_tasks TO oshal_bot;

-- The conversation read joins chat_messages on task_id and selects text and created_at; role,
-- type, content_blocks and metadata are named by no bot read. Rows are walled by the
-- oshal_owns_task policy (migration 094), which is why that helper is granted below.
GRANT SELECT (task_id, text, created_at)
  ON TABLE public.chat_messages TO oshal_bot;

-- Exactly what the pgvector engine's reads name (pgvector-rag-engine.ts): chunk_id, document and
-- metadata in the select list; collection in every WHERE and in listCollections; embedding for
-- the vector leg's distance and NULL check; fts for the lexical leg's match and rank. owner_sub,
-- tenant_id and created_at are named by no read - the row policy compares owner_sub on its own.
-- Conditional because migration 070 creates rag_chunks only where the vector extension exists
-- and skips with a NOTICE otherwise; provision-app-role.mjs tolerates the table's absence on
-- exactly that condition (OPTIONAL_BOT_CONTRACT_TABLES).
DO $$
BEGIN
  IF to_regclass('public.rag_chunks') IS NOT NULL THEN
    GRANT SELECT (chunk_id, collection, document, embedding, fts, metadata)
      ON TABLE public.rag_chunks TO oshal_bot;
  END IF;
END
$$;

GRANT INSERT (
  task_id, owner_sub, agent_id, provider_id, model_id, cost_usd,
  input_tokens, output_tokens, duration_ms
) ON TABLE public.oshal_cost_events TO oshal_bot;

GRANT SELECT ON TABLE public.tickets TO oshal_bot;
GRANT UPDATE (
  status, state_group, execution_phase, metadata, assigned_agent_id, updated_at
) ON TABLE public.tickets TO oshal_bot;

-- ON CONFLICT DO UPDATE needs SELECT on every column the statement names: the two conflict
-- target columns and `role`, which the update expression reads. created_at is never named, so
-- it stays ungranted.
GRANT SELECT (task_id, ticket_id, role)
  ON TABLE public.ticket_task_links TO oshal_bot;
GRANT INSERT (task_id, ticket_id, role)
  ON TABLE public.ticket_task_links TO oshal_bot;
GRANT UPDATE (role)
  ON TABLE public.ticket_task_links TO oshal_bot;

GRANT INSERT (
  ticket_id, from_status, to_status, changed_by, changed_by_label, metadata
) ON TABLE public.ticket_status_history TO oshal_bot;

-- Same rule, same statement shape: the three conflict target columns plus `phase`, which the
-- COALESCE in the update expression reads. assigned_at stays ungranted.
GRANT SELECT (ticket_id, agent_id, role, phase)
  ON TABLE public.ticket_agent_assignments TO oshal_bot;
GRANT INSERT (ticket_id, agent_id, role, phase)
  ON TABLE public.ticket_agent_assignments TO oshal_bot;
GRANT UPDATE (phase)
  ON TABLE public.ticket_agent_assignments TO oshal_bot;

GRANT USAGE ON SEQUENCE public.oshal_cost_events_id_seq TO oshal_bot;

RESET ROLE;

-- Only derived helpers are part of the bot contract: ticket ownership,
-- application execution ownership (which application claims a bot or tool,
-- and whether it is protected - the ADR-149 posture guard a bot node runs
-- before accepting any execution), and durable swarm-memory recall scoped to
-- the reader (shared memories plus the reader's own), and task ownership,
-- which the chat_messages row policy calls for every message a bot reads.
-- The bot gets those decisions, never the tables behind them -
-- oshal_swarm_memory in particular stays entirely outside the contract.
-- Every SECURITY DEFINER helper is private by default; the app gets all six.
REVOKE EXECUTE ON FUNCTION public.oshal_is_tenant_member(text) FROM PUBLIC, oshal_bot;
REVOKE EXECUTE ON FUNCTION public.oshal_owns_task(text) FROM PUBLIC, oshal_bot;
REVOKE EXECUTE ON FUNCTION public.oshal_owns_ticket(uuid) FROM PUBLIC, oshal_bot;
REVOKE EXECUTE ON FUNCTION public.oshal_application_execution_claims(text, text, text, boolean) FROM PUBLIC, oshal_bot;
REVOKE EXECUTE ON FUNCTION public.oshal_application_execution_claims(text, text, boolean) FROM PUBLIC, oshal_bot;
REVOKE EXECUTE ON FUNCTION public.oshal_swarm_memory_readable(text[], text) FROM PUBLIC, oshal_bot;
GRANT EXECUTE ON FUNCTION public.oshal_is_tenant_member(text) TO oshal_app;
GRANT EXECUTE ON FUNCTION public.oshal_owns_task(text) TO oshal_app, oshal_bot;
GRANT EXECUTE ON FUNCTION public.oshal_owns_ticket(uuid) TO oshal_app, oshal_bot;
GRANT EXECUTE ON FUNCTION public.oshal_application_execution_claims(text, text, text, boolean) TO oshal_app;
GRANT EXECUTE ON FUNCTION public.oshal_application_execution_claims(text, text, boolean) TO oshal_app, oshal_bot;
GRANT EXECUTE ON FUNCTION public.oshal_swarm_memory_readable(text[], text) TO oshal_app, oshal_bot;

COMMIT;

-- OSHAL_FINAL_PHASE_END
