/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual runtime-role provisioning against disposable PostgreSQL16 for local superuser and managed creator membership paths.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Converge legacy broad app defaults through the full final provisioner and verify PostgreSQL16 worker ACLs and future object privileges.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionRuntimeRoles } from '../../scripts/governance/provision-app-role.mjs';

const appPassword = randomBytes(24).toString('hex');
const botPassword = randomBytes(24).toString('hex');
const ownerPassword = randomBytes(24).toString('hex');
let container: string;
let started = false;
let pool: Pool;
let port: number;

/** @description Run Docker only for the uniquely named disposable database.
 * @param args Fixed test commands. @returns Trimmed command output.
 */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

/** @description Build a connection exclusively to the ephemeral loopback fixture.
 * @param user Fixture database role. @param password Generated fixture credential.
 * @returns Fixture connection URL, never logged.
 */
function databaseUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@127.0.0.1:${port}/role_fixture`;
}

/** @description Run the actual SQL and strict role verifier without historical app migrations.
 * @param bootstrapRole Fixture owner or managed creator. @param phase Requested provisioning boundary.
 * @returns Verified provisioning result.
 */
function provision(bootstrapRole = 'postgres', phase: 'pre-migration' | 'final' = 'pre-migration') {
  return provisionRuntimeRoles({ bootstrapUrl: databaseUrl(bootstrapRole, ownerPassword),
    appUrl: databaseUrl('oshal_app', appPassword), botUrl: databaseUrl('oshal_bot', botPassword), phase });
}

/** @description Reproduce the two existing local memberships with ADMIN absent.
 * @returns Completion after fixture-only role creation.
 */
async function existingLocalRoles(): Promise<void> {
  await pool.query(`CREATE ROLE oshal_app LOGIN NOSUPERUSER NOINHERIT;
    CREATE ROLE oshal_bot LOGIN NOSUPERUSER NOINHERIT;
    GRANT oshal_app TO postgres WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;
    GRANT oshal_bot TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`);
}

/** @description Read effective membership options without credentials or application data.
 * @returns Exact role, member and independent option tuples.
 */
async function memberships() {
  return (await pool.query(`SELECT role.rolname AS role, member.rolname AS member,
    bool_or(m.admin_option) AS admin, bool_or(m.inherit_option) AS inherit, bool_or(m.set_option) AS set
    FROM pg_auth_members m JOIN pg_roles role ON role.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
    WHERE role.rolname IN ('oshal_app','oshal_bot') GROUP BY role.rolname,member.rolname ORDER BY 1,2`)).rows;
}

const FINAL_TABLE_COLUMNS: Record<string, string> = {
  agents: 'agent_id,name,status,api_provider_id,model_id,persona,metadata,base_capabilities,base_selector_descriptor,base_routing_keywords,updated_at,private_secret',
  tools: 'tool_id,name,type,display_name,description,category,install_spec,version,skills,selector_fragment,routing_tags,input_schema,output_schema,usage_instructions,examples,auth_group,default_auth_mode,requires_approval,timeout_ms,tags,enabled,registered_by,registered_at,created_at,updated_at',
  agent_tools: 'agent_id,tool_id,auth_mode,installed',
  persona_layers: 'fixture_id',
  work_items: 'status,assigned_agent_id,execution_output,updated_at',
  chat_tasks: 'task_id,title,status,processing_mode,agent_id,provider_id,message_count,turn_count,total_input_tokens,total_output_tokens,total_input_cost,total_output_cost,total_cost,total_requests,cost_currency,usage_by_model,metadata,owner_sub,created_at,updated_at',
  oshal_cost_events: 'task_id,owner_sub,agent_id,provider_id,model_id,cost_usd,input_tokens,output_tokens,duration_ms',
  tickets: 'status,state_group,execution_phase,metadata,assigned_agent_id,updated_at',
  ticket_task_links: 'task_id,ticket_id,role',
  ticket_status_history: 'ticket_id,from_status,to_status,changed_by,changed_by_label,metadata',
  ticket_agent_assignments: 'ticket_id,agent_id,role,phase',
  fixture_sensitive: 'secret',
};

/** @description Seed only the worker ACL contract, with no application records or historical migrations.
 * @returns Completion after fixture tables, safe helpers and deliberately excessive grants exist.
 */
async function seedFinalSchema(): Promise<void> {
  for (const [table, columns] of Object.entries(FINAL_TABLE_COLUMNS)) {
    await pool.query(`CREATE TABLE ${table} (${columns.split(',').map(column => `${column} text`).join(',')})`);
  }
  await pool.query('CREATE SEQUENCE oshal_cost_events_id_seq');
  for (const signature of ['oshal_is_tenant_member(text)', 'oshal_owns_task(text)', 'oshal_owns_ticket(uuid)']) {
    await pool.query(`CREATE FUNCTION ${signature} RETURNS boolean LANGUAGE sql SECURITY DEFINER
      SET search_path=public,pg_temp AS 'SELECT false'`);
  }
  await pool.query('GRANT SELECT ON fixture_sensitive TO oshal_bot; GRANT SELECT(private_secret) ON agents TO oshal_bot');
}

/** @description Inspect app defaults owned by the fixture bootstrap role.
 * @returns Object-kind, exact privilege set and onward-grant option.
 */
async function defaultGrants() {
  return (await pool.query(`SELECT d.defaclobjtype AS kind,
    array_agg(a.privilege_type ORDER BY a.privilege_type) AS privileges, bool_or(a.is_grantable) AS grantable
    FROM pg_default_acl d JOIN pg_roles owner ON owner.oid=d.defaclrole
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a JOIN pg_roles recipient ON recipient.oid=a.grantee
    WHERE owner.rolname=current_user AND recipient.rolname='oshal_app'
    GROUP BY d.defaclobjtype ORDER BY d.defaclobjtype`)).rows;
}

beforeEach(async () => {
  container = `oshal-provision-fixture-${randomUUID().slice(0, 8)}`;
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data', '--env', `POSTGRES_PASSWORD=${ownerPassword}`,
    '--env', 'POSTGRES_DB=role_fixture', 'postgres:16-alpine']);
  started = true; port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  pool = new Pool({ connectionString: databaseUrl('postgres', ownerPassword), connectionTimeoutMillis: 500 });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await pool.query('SELECT 1'); return; } catch { await new Promise(done => setTimeout(done, 200)); }
  }
  throw new Error('Disposable PostgreSQL16 role fixture unavailable');
}, 90_000);

afterEach(async () => {
  await pool?.end();
  if (started) { docker(['rm', '--force', container]); started = false; }
});

describe('PostgreSQL16 runtime-role membership convergence', () => {
  it('repairs existing superuser grants and passes the unchanged verifier on repeated runs', async () => {
    await existingLocalRoles();
    expect((await memberships()).every(row => row.admin === false)).toBe(true);
    expect((await provision()).provisioned).toBe(true);
    expect(await memberships()).toEqual([
      { role: 'oshal_app', member: 'postgres', admin: true, inherit: true, set: true },
      { role: 'oshal_bot', member: 'postgres', admin: true, inherit: false, set: false },
    ]);
    expect((await provision()).provisioned).toBe(true);
    const roles = (await pool.query("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname IN ('oshal_app','oshal_bot')")).rows;
    expect(roles.every(role => !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole)).toBe(true);
  });

  it('preserves managed non-superuser creator ADMIN without the forbidden regrant', async () => {
    await pool.query(`CREATE ROLE fixture_admin LOGIN PASSWORD '${ownerPassword}' CREATEROLE CREATEDB BYPASSRLS;
      GRANT pg_signal_backend TO fixture_admin; ALTER DATABASE role_fixture OWNER TO fixture_admin`);
    expect((await provision('fixture_admin')).provisioned).toBe(true);
    expect((await provision('fixture_admin')).provisioned).toBe(true);
    expect(await memberships()).toEqual([
      { role: 'oshal_app', member: 'fixture_admin', admin: true, inherit: true, set: true },
      { role: 'oshal_bot', member: 'fixture_admin', admin: true, inherit: false, set: false },
    ]);
  });

  it('still rejects an unexpected principal membership and leaves worker login disabled', async () => {
    await existingLocalRoles();
    await pool.query('CREATE ROLE fixture_unexpected; GRANT oshal_bot TO fixture_unexpected');
    await expect(provision()).rejects.toThrow('unexpected app/bot role membership detected');
    expect((await pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='oshal_bot'")).rows[0].rolcanlogin).toBe(false);
  });
});

describe('PostgreSQL16 legacy default ACL convergence', () => {
  it('removes excess table and sequence defaults before regranting the exact future-object rights', async () => {
    await existingLocalRoles();
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO oshal_app WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO oshal_app WITH GRANT OPTION`);
    const legacy = await defaultGrants();
    expect(legacy.find(row => row.kind === 'S').privileges).toContain('UPDATE');
    expect(legacy.find(row => row.kind === 'r').privileges).toContain('TRUNCATE');
    await seedFinalSchema();
    expect((await provision('postgres', 'final')).provisioned).toBe(true);
    const expected = [
      { kind: 'S', privileges: ['SELECT', 'USAGE'], grantable: false },
      { kind: 'f', privileges: ['EXECUTE'], grantable: false },
      { kind: 'r', privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], grantable: false },
    ];
    expect(await defaultGrants()).toEqual(expected);
    expect((await provision('postgres', 'final')).provisioned).toBe(true);
    expect(await defaultGrants()).toEqual(expected);
    await pool.query('CREATE TABLE fixture_future(id integer); CREATE SEQUENCE fixture_future_sequence');
    const rights = (await pool.query(`SELECT
      has_table_privilege('oshal_app','fixture_future','TRUNCATE') AS truncate,
      has_table_privilege('oshal_app','fixture_future','SELECT,INSERT,UPDATE,DELETE') AS dml,
      has_sequence_privilege('oshal_app','fixture_future_sequence','UPDATE') AS sequence_update,
      has_sequence_privilege('oshal_app','fixture_future_sequence','USAGE,SELECT') AS sequence_read,
      has_table_privilege('oshal_bot','fixture_sensitive','SELECT') AS sensitive,
      has_column_privilege('oshal_bot','agents','agent_id','SELECT') AS permitted_column,
      has_column_privilege('oshal_bot','agents','private_secret','SELECT') AS private_column`)).rows[0];
    expect(rights).toEqual({ truncate: false, dml: true, sequence_update: false, sequence_read: true,
      sensitive: false, permitted_column: true, private_column: false });
    expect((await pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='oshal_bot'")).rows[0].rolcanlogin).toBe(true);
  });
});
