#!/usr/bin/env node
/**
 * Idempotently provision and prove the two least-privilege runtime roles.
 *
 * The managed-Postgres one-shot calls this before migrations (so migration 099
 * can never create a development-password bot role) and after migrations (to
 * converge ownership/default privileges and verify SECURITY DEFINER helpers).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(here, '../../docs/governance/app-role-provisioning.sql');
const EXPECTED_HELPERS = new Set([
  'oshal_is_tenant_member(text)',
  'oshal_owns_task(text)',
  'oshal_owns_ticket(uuid)',
]);
const FINAL_PHASE_BEGIN = '-- OSHAL_FINAL_PHASE_BEGIN';
const FINAL_PHASE_END = '-- OSHAL_FINAL_PHASE_END';
const BOT_TABLE_PRIVILEGES = new Map([
  ['persona_layers', new Set(['SELECT'])],
  ['work_items', new Set(['SELECT'])],
  ['tickets', new Set(['SELECT'])],
]);
const BOT_COLUMN_PRIVILEGES = new Map([
  ['agents', {
    SELECT: new Set([
      'agent_id', 'name', 'status', 'api_provider_id', 'model_id', 'persona', 'metadata',
      'base_capabilities', 'base_selector_descriptor', 'base_routing_keywords', 'updated_at',
    ]),
  }],
  ['tools', {
    SELECT: new Set([
      'tool_id', 'name', 'type', 'display_name', 'description', 'category', 'install_spec',
      'version', 'skills', 'selector_fragment', 'routing_tags', 'input_schema', 'output_schema',
      'usage_instructions', 'examples', 'auth_group', 'default_auth_mode', 'requires_approval',
      'timeout_ms', 'tags', 'enabled', 'registered_by', 'registered_at', 'created_at', 'updated_at',
    ]),
  }],
  ['agent_tools', {
    SELECT: new Set(['agent_id', 'tool_id', 'auth_mode', 'installed']),
  }],
  ['work_items', {
    UPDATE: new Set(['status', 'assigned_agent_id', 'execution_output', 'updated_at']),
  }],
  ['chat_tasks', {
    SELECT: new Set([
      'task_id', 'status', 'agent_id', 'provider_id', 'total_input_tokens', 'total_output_tokens',
      'total_input_cost', 'total_output_cost', 'total_cost', 'total_requests', 'cost_currency',
      'usage_by_model', 'owner_sub', 'metadata',
    ]),
    INSERT: new Set([
      'task_id', 'title', 'status', 'processing_mode', 'agent_id', 'provider_id', 'message_count',
      'turn_count', 'total_input_tokens', 'total_output_tokens', 'total_input_cost',
      'total_output_cost', 'total_cost', 'total_requests', 'cost_currency', 'usage_by_model',
      'metadata', 'owner_sub', 'created_at', 'updated_at',
    ]),
    UPDATE: new Set([
      'status', 'agent_id', 'provider_id', 'total_input_tokens', 'total_output_tokens',
      'total_input_cost', 'total_output_cost', 'total_cost', 'total_requests', 'cost_currency',
      'usage_by_model', 'owner_sub', 'metadata', 'updated_at',
    ]),
  }],
  ['oshal_cost_events', {
    INSERT: new Set([
      'task_id', 'owner_sub', 'agent_id', 'provider_id', 'model_id', 'cost_usd',
      'input_tokens', 'output_tokens', 'duration_ms',
    ]),
  }],
  ['tickets', {
    UPDATE: new Set([
      'status', 'state_group', 'execution_phase', 'metadata', 'assigned_agent_id', 'updated_at',
    ]),
  }],
  ['ticket_task_links', {
    SELECT: new Set(['task_id', 'ticket_id']),
    INSERT: new Set(['task_id', 'ticket_id', 'role']),
    UPDATE: new Set(['role']),
  }],
  ['ticket_status_history', {
    INSERT: new Set(['ticket_id', 'from_status', 'to_status', 'changed_by', 'changed_by_label', 'metadata']),
  }],
  ['ticket_agent_assignments', {
    SELECT: new Set(['phase']),
    INSERT: new Set(['ticket_id', 'agent_id', 'role', 'phase']),
    UPDATE: new Set(['phase']),
  }],
]);
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

function fail(message) {
  throw new Error(message);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function parsePostgresUrl(raw, label) {
  if (!raw) fail(`${label} is required`);
  try {
    const parsed = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      fail(`${label} must be a PostgreSQL URL`);
    }
    return parsed;
  } catch (error) {
    fail(`${label} is not a valid PostgreSQL URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decoded(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${label} contains invalid percent encoding`);
  }
}

export function runtimeCredentials({ bootstrapUrl, appUrl, botUrl, appPassword, botPassword }) {
  const bootstrap = parsePostgresUrl(bootstrapUrl, 'BOOTSTRAP_DATABASE_URL');
  const app = parsePostgresUrl(appUrl, 'DATABASE_URL');
  const bot = parsePostgresUrl(botUrl, 'BOT_DATABASE_URL');
  const resolvedAppPassword = appPassword || decoded(app.password, 'DATABASE_URL password');
  const resolvedBotPassword = botPassword || decoded(bot.password, 'BOT_DATABASE_URL password');

  if (decoded(app.username, 'DATABASE_URL username') !== 'oshal_app') {
    fail('DATABASE_URL must authenticate exactly as oshal_app');
  }
  if (decoded(bot.username, 'BOT_DATABASE_URL username') !== 'oshal_bot') {
    fail('BOT_DATABASE_URL must authenticate exactly as oshal_bot');
  }
  if (!resolvedAppPassword || !resolvedBotPassword) fail('both runtime role passwords are required');
  if (decoded(app.password, 'DATABASE_URL password') !== resolvedAppPassword) {
    fail('oshal_app password does not match DATABASE_URL');
  }
  if (decoded(bot.password, 'BOT_DATABASE_URL password') !== resolvedBotPassword) {
    fail('oshal_bot password does not match BOT_DATABASE_URL');
  }

  const localBootstrap = bootstrap.hostname === 'oshal-db';
  const localAppDefault = localBootstrap && app.hostname === 'oshal-db' && resolvedAppPassword === 'oshal-app-dev';
  const localBotDefault = localBootstrap && bot.hostname === 'oshal-db' && resolvedBotPassword === 'oshal-bot-dev';
  if (!localAppDefault && !/^[0-9a-f]{48,128}$/i.test(resolvedAppPassword)) {
    fail('oshal_app password must be 48-128 hexadecimal characters (generate with: openssl rand -hex 24)');
  }
  if (!localBotDefault && !/^[0-9a-f]{48,128}$/i.test(resolvedBotPassword)) {
    fail('oshal_bot password must be 48-128 hexadecimal characters (generate with: openssl rand -hex 24)');
  }
  if (resolvedAppPassword === resolvedBotPassword) fail('oshal_app and oshal_bot passwords must be distinct');
  const bootstrapPassword = decoded(bootstrap.password, 'BOOTSTRAP_DATABASE_URL password');
  if (bootstrapPassword && [resolvedAppPassword, resolvedBotPassword].includes(bootstrapPassword)) {
    fail('bootstrap, app, and bot passwords must be distinct');
  }

  return { bootstrap, app, bot, appPassword: resolvedAppPassword, botPassword: resolvedBotPassword };
}

function phaseSql(raw, phase) {
  const begin = raw.indexOf(FINAL_PHASE_BEGIN);
  const end = raw.indexOf(FINAL_PHASE_END);
  if (begin < 0 || end < 0 || begin >= end
    || begin !== raw.lastIndexOf(FINAL_PHASE_BEGIN)
    || end !== raw.lastIndexOf(FINAL_PHASE_END)) {
    fail('role SQL must contain exactly one ordered final-phase boundary');
  }
  if (phase === 'pre-migration') {
    return `${raw.slice(0, begin)}${raw.slice(end + FINAL_PHASE_END.length)}`;
  }
  return raw
    .replace(FINAL_PHASE_BEGIN, '')
    .replace(FINAL_PHASE_END, '');
}

function runnableSql(raw, databaseName, appPassword, botPassword, phase) {
  return phaseSql(raw, phase)
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n')
    .replaceAll(":'app_pw'", sqlLiteral(appPassword))
    .replaceAll(":'bot_pw'", sqlLiteral(botPassword))
    .replaceAll(':DBNAME', sqlIdentifier(databaseName));
}

function maskedSql(sql, appPassword, botPassword) {
  return sql
    .replaceAll(sqlLiteral(appPassword), "'***'")
    .replaceAll(sqlLiteral(botPassword), "'***'");
}

async function bootstrapPosture(client) {
  const result = await client.query(`
    SELECT current_database() AS database_name, current_user AS role_name,
           rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
           pg_has_role(current_user, 'pg_signal_backend', 'MEMBER') AS can_signal_backend
      FROM pg_roles WHERE rolname = current_user
  `);
  const role = result.rows[0];
  if (!role) fail('could not resolve bootstrap role attributes');
  if (!role.rolsuper && !role.rolcreaterole) {
    fail(`bootstrap role ${role.role_name} needs CREATEROLE to provision runtime roles`);
  }
  if (!role.rolsuper && !role.rolcreatedb) {
    fail(`bootstrap role ${role.role_name} needs CREATEDB to converge runtime roles to NOCREATEDB`);
  }
  if (!role.rolsuper && !role.rolbypassrls) {
    fail(`bootstrap role ${role.role_name} needs BYPASSRLS for ownership-helper administration`);
  }
  if (!role.rolsuper && !role.can_signal_backend) {
    fail(`bootstrap role ${role.role_name} needs pg_signal_backend to terminate stale bot sessions safely`);
  }
  return role;
}

function assertHelpers(rows, bootstrapRole, phase) {
  if (phase === 'final' && rows.length !== EXPECTED_HELPERS.size) {
    fail(`final provisioning requires exactly three approved helpers; found ${rows.length}`);
  }
  if (phase === 'pre-migration' && rows.length > EXPECTED_HELPERS.size) {
    fail(`pre-migration provisioning found too many approved-name helpers: ${rows.length}`);
  }
  const seen = new Set();
  for (const helper of rows) {
    if (!EXPECTED_HELPERS.has(helper.signature)) fail(`unexpected SECURITY DEFINER helper: ${helper.signature}`);
    if (seen.has(helper.signature)) fail(`duplicate SECURITY DEFINER helper: ${helper.signature}`);
    seen.add(helper.signature);
    if (!helper.prosecdef) fail(`${helper.signature} must be SECURITY DEFINER`);
    if (helper.owner !== bootstrapRole) fail(`${helper.signature} must remain owned by ${bootstrapRole}`);
    if (helper.proconfig?.length !== 1 || helper.proconfig[0] !== 'search_path=public, pg_temp') {
      fail(`${helper.signature} must pin exactly search_path=public, pg_temp`);
    }
    if (phase === 'final' && (!helper.app_can_execute || helper.public_can_execute)) {
      fail(`${helper.signature} must be executable by oshal_app and not PUBLIC`);
    }
  }
  if (phase === 'final') {
    const missing = [...EXPECTED_HELPERS].filter((signature) => !seen.has(signature));
    if (missing.length) fail(`missing approved SECURITY DEFINER helpers: ${missing.join(', ')}`);
  }
}

function expectedBotColumnPrivilege(tableName, columnName, privilege) {
  if (BOT_TABLE_PRIVILEGES.get(tableName)?.has(privilege)) return true;
  return Boolean(BOT_COLUMN_PRIVILEGES.get(tableName)?.[privilege]?.has(columnName));
}

async function verifyBotAcl(client) {
  const tableChecks = TABLE_PRIVILEGES
    .map((privilege) => `has_table_privilege('oshal_bot', c.oid, '${privilege}') AS can_${privilege.toLowerCase()}`)
    .join(',\n           ');
  const tables = await client.query(`
    SELECT c.relname,
           NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_class'::regclass
                AND d.objid = c.oid
                AND d.deptype = 'e'
           ) AS is_non_extension,
           EXISTS (
             SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0
           ) AS public_has_any,
           ${tableChecks}
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     ORDER BY c.relname
  `);
  const seenTables = new Set(tables.rows.map((row) => row.relname));
  for (const tableName of new Set([...BOT_TABLE_PRIVILEGES.keys(), ...BOT_COLUMN_PRIVILEGES.keys()])) {
    if (!seenTables.has(tableName)) fail(`bot ACL contract table is missing: ${tableName}`);
  }
  for (const table of tables.rows) {
    if (table.is_non_extension && table.public_has_any) {
      fail(`unexpected direct PUBLIC table privilege on public.${table.relname}`);
    }
    for (const privilege of TABLE_PRIVILEGES) {
      const expected = Boolean(BOT_TABLE_PRIVILEGES.get(table.relname)?.has(privilege));
      if (Boolean(table[`can_${privilege.toLowerCase()}`]) !== expected) {
        fail(`unexpected effective oshal_bot ${privilege} table privilege on public.${table.relname}`);
      }
    }
  }

  const columnChecks = COLUMN_PRIVILEGES
    .map((privilege) => `has_column_privilege('oshal_bot', c.oid, a.attnum, '${privilege}') AS can_${privilege.toLowerCase()}`)
    .join(',\n           ');
  const columns = await client.query(`
    SELECT c.relname, a.attname, ${columnChecks}
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum
  `);
  const seenColumns = new Map();
  for (const column of columns.rows) {
    if (!seenColumns.has(column.relname)) seenColumns.set(column.relname, new Set());
    seenColumns.get(column.relname).add(column.attname);
    for (const privilege of COLUMN_PRIVILEGES) {
      const expected = expectedBotColumnPrivilege(column.relname, column.attname, privilege);
      if (Boolean(column[`can_${privilege.toLowerCase()}`]) !== expected) {
        fail(`unexpected effective oshal_bot ${privilege} column privilege on public.${column.relname}.${column.attname}`);
      }
    }
  }
  for (const [tableName, privileges] of BOT_COLUMN_PRIVILEGES) {
    for (const columnsForPrivilege of Object.values(privileges)) {
      for (const columnName of columnsForPrivilege) {
        if (!seenColumns.get(tableName)?.has(columnName)) {
          fail(`bot ACL contract column is missing: public.${tableName}.${columnName}`);
        }
      }
    }
  }

  const sequences = await client.query(`
    SELECT c.relname,
           NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_class'::regclass
                AND d.objid = c.oid
                AND d.deptype = 'e'
           ) AS is_non_extension,
           EXISTS (
             SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0
           ) AS public_has_any,
           has_sequence_privilege('oshal_bot', c.oid, 'USAGE') AS can_usage,
           has_sequence_privilege('oshal_bot', c.oid, 'SELECT') AS can_select,
           has_sequence_privilege('oshal_bot', c.oid, 'UPDATE') AS can_update
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
     ORDER BY c.relname
  `);
  let costSequenceSeen = false;
  for (const sequence of sequences.rows) {
    const isCostSequence = sequence.relname === 'oshal_cost_events_id_seq';
    costSequenceSeen ||= isCostSequence;
    if (sequence.is_non_extension && sequence.public_has_any) {
      fail(`unexpected direct PUBLIC sequence privilege on public.${sequence.relname}`);
    }
    if (Boolean(sequence.can_usage) !== isCostSequence || sequence.can_select || sequence.can_update) {
      fail(`unexpected effective oshal_bot sequence privilege on public.${sequence.relname}`);
    }
  }
  if (!costSequenceSeen) fail('bot ACL contract sequence is missing: public.oshal_cost_events_id_seq');

  const functions = await client.query(`
    SELECT p.oid::regprocedure::text AS signature,
           NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid
                AND d.deptype = 'e'
           ) AS is_non_extension,
           has_function_privilege('oshal_bot', p.oid, 'EXECUTE') AS can_execute,
           EXISTS (
             SELECT 1 FROM aclexplode(p.proacl) a
              WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'oshal_bot')
                AND a.privilege_type = 'EXECUTE'
           ) AS has_direct_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY signature
  `);
  let botHelperSeen = false;
  for (const fn of functions.rows) {
    const expected = fn.signature === 'oshal_owns_ticket(uuid)';
    botHelperSeen ||= expected;
    if (fn.has_direct_execute !== expected) {
      fail(`unexpected direct oshal_bot function privilege on public.${fn.signature}`);
    }
    if (fn.is_non_extension && Boolean(fn.can_execute) !== expected) {
      fail(`unexpected effective oshal_bot function privilege on public.${fn.signature}`);
    }
  }
  if (!botHelperSeen) fail('bot ACL contract function is missing: public.oshal_owns_ticket(uuid)');
}

async function verifyPosture(client, bootstrap, phase) {
  const databasePrivileges = await client.query(`
    SELECT has_database_privilege('oshal_app', current_database(), 'CONNECT') AS app_connect,
           has_database_privilege('oshal_app', current_database(), 'TEMPORARY') AS app_temporary,
           has_database_privilege('oshal_bot', current_database(), 'CONNECT') AS bot_connect,
           has_database_privilege('oshal_bot', current_database(), 'TEMPORARY') AS bot_temporary,
           EXISTS (
             SELECT 1
               FROM pg_database d
               CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
              WHERE d.datname = current_database() AND a.grantee = 0
                AND a.privilege_type = 'CONNECT'
           ) AS public_connect,
           EXISTS (
             SELECT 1
               FROM pg_database d
               CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
              WHERE d.datname = current_database() AND a.grantee = 0
                AND a.privilege_type = 'TEMPORARY'
           ) AS public_temporary
  `);
  const database = databasePrivileges.rows[0];
  if (!database?.app_connect || !database?.app_temporary || !database?.bot_connect || database?.bot_temporary
    || database?.public_connect || database?.public_temporary) {
    fail('database privileges must be app CONNECT+TEMPORARY, bot CONNECT-only, and PUBLIC none');
  }

  const schemaPrivileges = await client.query(`
    SELECT has_schema_privilege('oshal_app', 'public', 'USAGE') AS app_usage,
           has_schema_privilege('oshal_app', 'public', 'CREATE') AS app_create,
           has_schema_privilege('oshal_bot', 'public', 'USAGE') AS bot_usage,
           has_schema_privilege('oshal_bot', 'public', 'CREATE') AS bot_create
  `);
  const schema = schemaPrivileges.rows[0];
  if (!schema?.app_usage || !schema?.app_create || !schema?.bot_usage || schema?.bot_create) {
    fail('public schema privileges must be app USAGE+CREATE and bot USAGE-only');
  }

  const roles = await client.query(`
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
           rolreplication, rolcanlogin, rolinherit, rolconnlimit, rolvaliduntil, rolconfig
      FROM pg_roles WHERE rolname IN ('oshal_app', 'oshal_bot') ORDER BY rolname
  `);
  if (roles.rowCount !== 2) fail('both oshal_app and oshal_bot must exist');
  for (const role of roles.rows) {
    const expectedConnectionLimit = role.rolname === 'oshal_app' ? 24 : 8;
    const expectedCanLogin = role.rolname === 'oshal_bot' ? phase === 'final' : true;
    if (role.rolcanlogin !== expectedCanLogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole
      || role.rolbypassrls || role.rolreplication || role.rolinherit
      || role.rolconnlimit !== expectedConnectionLimit
      || (role.rolvaliduntil !== null && role.rolvaliduntil !== 'infinity' && role.rolvaliduntil !== Number.POSITIVE_INFINITY)
      || (role.rolconfig !== null && role.rolconfig.length !== 0)) {
      fail(`${role.rolname} has unexpected login, privilege, connection-limit, expiry, or persistent setting posture`);
    }
  }

  const memberships = await client.query(`
    SELECT granted.rolname AS granted_role, member.rolname AS member_role,
           bool_or(m.admin_option) AS admin_option,
           bool_or(m.inherit_option) AS inherit_option,
           bool_or(m.set_option) AS set_option
      FROM pg_auth_members m
      JOIN pg_roles granted ON granted.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
     WHERE granted.rolname IN ('oshal_app', 'oshal_bot')
        OR member.rolname IN ('oshal_app', 'oshal_bot')
     GROUP BY granted.rolname, member.rolname
     ORDER BY granted.rolname, member.rolname
  `);
  if (memberships.rowCount !== 2) fail('unexpected app/bot role membership detected');
  const expectedMemberships = {
    oshal_app: { admin: true, inherit: true, set: true },
    oshal_bot: { admin: true, inherit: false, set: false },
  };
  for (const membership of memberships.rows) {
    const expected = expectedMemberships[membership.granted_role];
    if (!expected || membership.member_role !== bootstrap.role_name
      || membership.admin_option !== expected.admin
      || membership.inherit_option !== expected.inherit
      || membership.set_option !== expected.set) {
      fail(`unexpected membership posture for ${membership.granted_role} -> ${membership.member_role}`);
    }
  }

  const effectiveMembership = await client.query(`
    SELECT pg_has_role(current_user, 'oshal_app', 'SET') AS app_can_set,
           pg_has_role(current_user, 'oshal_app', 'USAGE') AS app_is_inherited,
           pg_has_role(current_user, 'oshal_bot', 'SET') AS bot_can_set,
           pg_has_role(current_user, 'oshal_bot', 'USAGE') AS bot_is_inherited
  `);
  const effective = effectiveMembership.rows[0];
  if (!effective?.app_can_set || !effective?.app_is_inherited) {
    fail(`${bootstrap.role_name} must SET and inherit oshal_app privileges`);
  }
  if (!bootstrap.rolsuper && (effective.bot_can_set || effective.bot_is_inherited)) {
    fail(`${bootstrap.role_name} must neither SET nor inherit oshal_bot privileges`);
  }

  const botOwned = await client.query(`
    SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public' AND r.rolname = 'oshal_bot'
  `);
  if (botOwned.rows[0].n !== 0) fail('oshal_bot must not own public-schema objects');

  const appOwned = await client.query(`
    SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
       AND r.rolname = 'oshal_app'
  `);

  const helpers = await client.query(`
    SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig,
           owner.rolname AS owner,
           has_function_privilege('oshal_app', p.oid, 'EXECUTE') AS app_can_execute,
           EXISTS (
             SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) AS public_can_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE n.nspname = 'public'
       AND (
         p.prosecdef
         OR p.proname IN ('oshal_is_tenant_member', 'oshal_owns_task', 'oshal_owns_ticket')
       )
     ORDER BY signature
  `);
  assertHelpers(helpers.rows, bootstrap.role_name, phase);

  if (phase === 'final') {
    const defaultAcl = await client.query(`
      SELECT owner.rolname AS owner_role, d.defaclobjtype AS object_type,
             grantee.rolname AS grantee_role,
             array_agg(a.privilege_type ORDER BY a.privilege_type) AS privileges
        FROM pg_default_acl d
        JOIN pg_roles owner ON owner.oid = d.defaclrole
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee
       WHERE n.nspname = 'public'
         AND (
           (owner.rolname IN ($1, 'oshal_app')
             AND (a.grantee = 0 OR grantee.rolname IN ('oshal_app', 'oshal_bot')))
           OR grantee.rolname = 'oshal_bot'
         )
       GROUP BY owner.rolname, d.defaclobjtype, grantee.rolname
       ORDER BY owner.rolname, d.defaclobjtype, grantee.rolname
    `, [bootstrap.role_name]);
    const expectedAcl = new Map();
    const privilegeSets = {
      r: 'DELETE,INSERT,SELECT,UPDATE',
      S: 'SELECT,USAGE',
      f: 'EXECUTE',
    };
    for (const objectType of Object.keys(privilegeSets)) {
      expectedAcl.set(`${bootstrap.role_name}:${objectType}:oshal_app`, privilegeSets[objectType]);
    }
    if (defaultAcl.rowCount !== expectedAcl.size) fail('runtime-role default privileges are incomplete or unexpected');
    for (const entry of defaultAcl.rows) {
      const key = `${entry.owner_role}:${entry.object_type}:${entry.grantee_role}`;
      if (expectedAcl.get(key) !== entry.privileges.join(',')) fail(`unexpected default privileges for ${key}`);
      expectedAcl.delete(key);
    }
    if (expectedAcl.size) fail(`missing runtime-role default privileges: ${[...expectedAcl.keys()].join(', ')}`);

    const functionDefaults = await client.query(`
      SELECT owner.rolname AS owner_role,
             EXISTS (
               SELECT 1 FROM aclexplode(d.defaclacl) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_can_execute
        FROM pg_default_acl d
        JOIN pg_roles owner ON owner.oid = d.defaclrole
       WHERE d.defaclnamespace = 0 AND d.defaclobjtype = 'f'
         AND owner.rolname IN ($1, 'oshal_app')
       ORDER BY owner.rolname
    `, [bootstrap.role_name]);
    if (functionDefaults.rowCount !== 2
      || functionDefaults.rows.some((entry) => entry.public_can_execute)) {
      fail(`bootstrap and app function defaults must both revoke PUBLIC EXECUTE: ${JSON.stringify(functionDefaults.rows)}`);
    }
    await verifyBotAcl(client);
  }

  return { roles: roles.rows, appOwned: appOwned.rows[0].n, helperCount: helpers.rowCount };
}

export async function provisionRuntimeRoles({
  bootstrapUrl, appUrl, botUrl, appPassword, botPassword, phase = 'final', dryRun = false,
} = {}) {
  if (!['pre-migration', 'final'].includes(phase)) fail('phase must be pre-migration or final');
  const credentials = runtimeCredentials({ bootstrapUrl, appUrl, botUrl, appPassword, botPassword });
  const databaseName = decoded(credentials.bootstrap.pathname.slice(1), 'BOOTSTRAP_DATABASE_URL database') || 'postgres';
  const raw = readFileSync(sqlPath, 'utf8');
  const sql = runnableSql(raw, databaseName, credentials.appPassword, credentials.botPassword, phase);
  if (dryRun) return { sql: maskedSql(sql, credentials.appPassword, credentials.botPassword), phase };

  const client = new pg.Client({ connectionString: bootstrapUrl });
  try {
    await client.connect();
    const bootstrap = await bootstrapPosture(client);
    await client.query(sql);
    let verified;
    if (phase === 'final') {
      // Keep activation uncommitted until every exact ACL/default/helper check
      // passes. Any verifier error rolls back LOGIN and leaves the bot inert.
      await client.query('BEGIN');
      try {
        await client.query('ALTER ROLE oshal_bot LOGIN');
        verified = await verifyPosture(client, bootstrap, phase);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } else {
      verified = await verifyPosture(client, bootstrap, phase);
    }
    return {
      provisioned: true,
      database: bootstrap.database_name,
      bootstrapRole: bootstrap.role_name,
      bootstrapBypassRls: Boolean(bootstrap.rolsuper || bootstrap.rolbypassrls),
      roles: verified.roles,
      appOwnedObjects: verified.appOwned,
      securityDefinerHelpersChecked: verified.helperCount,
      phase,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const phaseArg = process.argv.find((argument) => argument.startsWith('--phase='));
  const phase = phaseArg?.slice('--phase='.length) || process.env.OSHAL_ROLE_PROVISION_PHASE || 'final';
  const result = await provisionRuntimeRoles({
    bootstrapUrl: process.env.BOOTSTRAP_DATABASE_URL || process.env.DATABASE_URL,
    appUrl: process.env.DATABASE_URL,
    botUrl: process.env.BOT_DATABASE_URL,
    appPassword: process.env.OSHAL_APP_DB_PASSWORD,
    botPassword: process.env.OSHAL_BOT_DB_PASSWORD,
    phase,
    dryRun,
  });
  if (dryRun) {
    console.log(result.sql);
    console.log('\n[provision-app-role] dry run - nothing executed.');
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[provision-app-role] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
