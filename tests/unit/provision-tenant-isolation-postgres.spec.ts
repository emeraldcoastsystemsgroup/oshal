/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The two-tenant proof for the isolated tier (ADR-035 as amended 2026-09-21; BACKLOG "Two-tier tenant provisioning"). scripts/governance/verify-tenant-isolation.sh checks only Kubernetes NetworkPolicy, so nothing attempted a cross-tenant DATABASE connection or a cross-tenant ROW read. Here the shipped provision-tenant.sh renders two tenants in a real Git Bash, the real psql inside a PostgreSQL 16 server this file starts and destroys applies each rendered database.sql, and each tenant's own LOGIN role is then driven over TCP: its own database and rows answer; the other tenant's database refuses the connection in both directions (42501, no CONNECT); a cross-database reference from its own session is refused (0A000); with the connection layer deliberately drifted open the other tenant's rows are still refused at the schema (42501), even rows that tenant granted to PUBLIC; and re-applying the rendered file closes the drift and removes a membership that would let one tenant SET ROLE into the other. No collaborator is doubled: the boundary is the database's own privilege checks against the roles the rendering creates. The shared tier is refused and renders nothing. Never touches the running stack: the server's address is minted at start(). Mutation-checked against the script: dropping the PUBLIC connect revoke reds 3 cases, the schema revoke 1, either membership revoke 1, the other-grantee connect revoke 1, a role name not derived from the tenant 2, and accepting --tenancy=shared 1.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Mutation coverage extended and stated exactly: the missing-password guard, the 16-character minimum, NOINHERIT and CONNECTION LIMIT each red 1 case when removed. Removing the owner's own GRANT CONNECT, TEMPORARY leaves every case green (the owner already holds those rights), so it is not claimed as guarded. New case pinning an as-built limit: the rendering governs only the databases it creates, and the tenant's role still opens the server's other databases ('postgres' and the fixture's own) through PUBLIC's default CONNECT.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The shared-tier refusal case follows the script's reworded refusal (operator decision 2026-10-01): not built, isolated is the only tenancy today, a shared mode is planned under the backlog enhancement. Still exit 2 and nothing written.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASH, REPO_ROOT, posix } from '../helpers/core-release-harness';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const SCRIPT = 'scripts/governance/provision-tenant.sh';
const DB_HOST = 'oshal-db.oshal.svc.cluster.local';
const CIDR = '192.168.50.10/32';
const REQUIRED = [`--db-host=${DB_HOST}`, `--apiserver-cidr=${CIDR}`];
const scratch: string[] = [];

/** A finished run of the script or of psql. */
interface Run { status: number | null; out: string }

/** A rendered Kubernetes object, as far as these cases read it. */
interface K8sObject {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, unknown> };
  spec?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/**
 * @description The calling environment with every OSHAL_* and database variable removed, so the
 * script and the docker client see nothing that could point them at a deployment.
 * @returns A copy of process.env without those keys.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(OSHAL_|PG)|DATABASE_URL/i.test(key)) env[key] = value;
  }
  return env;
}

/**
 * @description A fresh scratch directory, removed after the file.
 * @param prefix Directory name prefix.
 * @returns Its native path.
 */
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * @description Run the shipped script in Git Bash.
 * @param args Its arguments.
 * @returns Exit status and combined output.
 */
function provision(args: string[]): Run {
  const result = spawnSync(BASH, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: childEnv(), timeout: 60_000 });
  if (result.error) throw result.error;
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * @description Render one isolated tenant into a fresh directory and require success.
 * @param name The tenant slug.
 * @returns The directory holding database.sql and namespace.yaml.
 */
function renderTenant(name: string): string {
  const out = freshDir(`oshal-tenant-${name}-`);
  const run = provision([name, '--tenancy=isolated', ...REQUIRED, `--out=${posix(out)}`]);
  expect(run.status, run.out).toBe(0);
  return out;
}

/**
 * @description The rendered namespace.yaml as objects.
 * @param dir A rendering directory.
 * @returns Every document in the file.
 */
function namespaceObjects(dir: string): K8sObject[] {
  return (yaml.loadAll(readFileSync(join(dir, 'namespace.yaml'), 'utf8')) as (K8sObject | null)[])
    .filter((item): item is K8sObject => item !== null);
}

/**
 * @description One object of a rendering, by kind and name.
 * @param objects The rendered objects.
 * @param kind Kubernetes kind.
 * @param name metadata.name.
 * @returns The object.
 */
function objectOf(objects: K8sObject[], kind: string, name: string): K8sObject {
  const found = objects.find((item) => item.kind === kind && item.metadata.name === name);
  if (!found) throw new Error(`rendering has no ${kind}/${name}`);
  return found;
}

describe('provision-tenant.sh: what it renders and what it refuses', () => {
  afterAll(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('refuses the shared tier as not built and writes nothing', () => {
    const out = freshDir('oshal-tenant-shared-');
    const run = provision(['alpha', '--tenancy=shared', ...REQUIRED, `--out=${posix(out)}`]);
    expect(run.status).toBe(2);
    expect(run.out).toContain('--tenancy=shared is not built');
    expect(run.out).toContain('isolated (a database per tenant) is the only tenancy today');
    expect(run.out).toContain('A shared mode is planned under the backlog enhancement');
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses a missing or unknown tenancy, a malformed name and every missing or malformed input', () => {
    const out = posix(join(freshDir('oshal-tenant-refusals-'), 'never'));
    const cases: [string[], string][] = [
      [['alpha', ...REQUIRED, `--out=${out}`], '--tenancy is required'],
      [['alpha', '--tenancy=pooled', ...REQUIRED, `--out=${out}`], "unknown tenancy 'pooled'"],
      [['--tenancy=isolated', ...REQUIRED, `--out=${out}`], 'a tenant name is required'],
      [['Alpha', '--tenancy=isolated', ...REQUIRED, `--out=${out}`], "invalid tenant name 'Alpha'"],
      [['alpha_1', '--tenancy=isolated', ...REQUIRED, `--out=${out}`], "invalid tenant name 'alpha_1'"],
      [['1alpha', '--tenancy=isolated', ...REQUIRED, `--out=${out}`], "invalid tenant name '1alpha'"],
      [['alpha-', '--tenancy=isolated', ...REQUIRED, `--out=${out}`], "invalid tenant name 'alpha-'"],
      [[`a${'b'.repeat(40)}`, '--tenancy=isolated', ...REQUIRED, `--out=${out}`], 'invalid tenant name'],
      [['alpha', 'bravo', '--tenancy=isolated', ...REQUIRED, `--out=${out}`], 'one tenant name only'],
      [['alpha', '--tenancy=isolated', `--apiserver-cidr=${CIDR}`, `--out=${out}`], '--db-host is required'],
      [['alpha', '--tenancy=isolated', `--db-host=${DB_HOST}`, `--out=${out}`], '--apiserver-cidr is required'],
      [['alpha', '--tenancy=isolated', `--db-host=${DB_HOST}`, '--apiserver-cidr=192.168.50.300/32', `--out=${out}`], 'invalid --apiserver-cidr'],
      [['alpha', '--tenancy=isolated', ...REQUIRED, '--db-port=70000', `--out=${out}`], "invalid --db-port '70000'"],
      [['alpha', '--tenancy=isolated', ...REQUIRED, '--connection-limit=0', `--out=${out}`], "invalid --connection-limit '0'"],
      [['alpha', '--tenancy=isolated', '--db-host=bad;host', `--apiserver-cidr=${CIDR}`, `--out=${out}`], "invalid --db-host 'bad;host'"],
      [['alpha', '--tenancy=isolated', ...REQUIRED], '--out is required'],
      [['alpha', '--tenancy=isolated', ...REQUIRED, `--out=${out}`, '--apply'], 'unknown argument: --apply'],
    ];
    for (const [args, message] of cases) {
      const run = provision(args);
      expect(run.status, args.join(' ')).toBe(2);
      expect(run.out, args.join(' ')).toContain(message);
    }
    expect(existsSync(out)).toBe(false);
  });

  it('refuses to overwrite a rendering that is already there', () => {
    const out = renderTenant('alpha');
    writeFileSync(join(out, 'database.sql'), '-- operator edit\n');
    const run = provision(['alpha', '--tenancy=isolated', ...REQUIRED, `--out=${posix(out)}`]);
    expect(run.status).toBe(2);
    expect(run.out).toContain('database.sql already exists');
    expect(readFileSync(join(out, 'database.sql'), 'utf8')).toBe('-- operator edit\n');
  });

  it('renders the namespace policy for an isolated tenant: deny by default, its own peers, its own database', () => {
    const objects = namespaceObjects(renderTenant('alpha'));
    expect(objects.map((item) => `${item.kind}/${item.metadata.name}`)).toEqual([
      'Namespace/oshal-tenant-alpha', 'ResourceQuota/oshal-tenant-quota', 'LimitRange/oshal-tenant-defaults',
      'NetworkPolicy/default-deny-all', 'NetworkPolicy/allow-same-tenant', 'ServiceAccount/oshal-workflow',
      'Role/oshal-workflow', 'RoleBinding/oshal-workflow', 'ConfigMap/oshal-tenant-db',
    ]);
    for (const item of objects.slice(1)) expect(item.metadata.namespace).toBe('oshal-tenant-alpha');
    expect(objectOf(objects, 'Namespace', 'oshal-tenant-alpha').metadata.labels)
      .toMatchObject({ 'oshal.io/tenant': 'alpha', 'oshal.io/tenancy': 'isolated' });
    expect(objectOf(objects, 'NetworkPolicy', 'default-deny-all').spec)
      .toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
    const allow = objectOf(objects, 'NetworkPolicy', 'allow-same-tenant').spec as {
      ingress: { from: { namespaceSelector: { matchLabels: Record<string, string> } }[] }[];
      egress: { to: { namespaceSelector?: { matchLabels?: Record<string, string> }; ipBlock?: { cidr: string } }[] }[];
    };
    expect(allow.ingress).toEqual([{ from: [{ namespaceSelector: { matchLabels: { 'oshal.io/tenant': 'alpha' } } }] }]);
    const peers = allow.egress.flatMap((rule) => rule.to);
    expect(peers.map((peer) => peer.namespaceSelector?.matchLabels).filter(Boolean)).toEqual([
      { 'oshal.io/tenant': 'alpha' }, { 'kubernetes.io/metadata.name': 'oshal' },
      { 'kubernetes.io/metadata.name': 'oshal-model' },
    ]);
    expect(peers.find((peer) => peer.ipBlock)?.ipBlock).toEqual({ cidr: CIDR });
    expect(objectOf(objects, 'ConfigMap', 'oshal-tenant-db').data).toEqual({
      OSHAL_TENANT: 'alpha', OSHAL_TENANCY: 'isolated', TENANT_DB_HOST: DB_HOST, TENANT_DB_PORT: '5432',
      TENANT_DB_NAME: 'oshal_tenant_alpha', TENANT_DB_USER: 'oshal_tenant_alpha',
    });
  });

  it('derives every identifier from the tenant name alone and writes no password', () => {
    const alpha = renderTenant('alpha');
    const bravo = renderTenant('bravo');
    for (const file of ['database.sql', 'namespace.yaml']) {
      const alphaText = readFileSync(join(alpha, file), 'utf8');
      expect(alphaText).not.toMatch(/bravo/);
      expect(readFileSync(join(bravo, file), 'utf8')).toBe(alphaText.replaceAll('alpha', 'bravo'));
    }
    const sql = readFileSync(join(alpha, 'database.sql'), 'utf8');
    expect(sql).toContain("PASSWORD :'tenant_password'");
    expect(sql).not.toMatch(/PASSWORD\s+'/);
  });

  it('keeps a tenant name a string wherever YAML would read it as another type, and maps hyphens for SQL', () => {
    const no = namespaceObjects(renderTenant('no'));
    expect(objectOf(no, 'Namespace', 'oshal-tenant-no').metadata.labels?.['oshal.io/tenant']).toBe('no');
    expect(objectOf(no, 'ConfigMap', 'oshal-tenant-db').data?.OSHAL_TENANT).toBe('no');
    const north = renderTenant('north-1');
    expect(objectOf(namespaceObjects(north), 'ConfigMap', 'oshal-tenant-db').data)
      .toMatchObject({ OSHAL_TENANT: 'north-1', TENANT_DB_NAME: 'oshal_tenant_north_1', TENANT_DB_USER: 'oshal_tenant_north_1' });
    expect(readFileSync(join(north, 'database.sql'), 'utf8')).toContain('CREATE DATABASE %I OWNER %I TEMPLATE template0\', \'oshal_tenant_north_1\'');
  });
});

const SERVER = new DisposablePostgres({ purpose: 'provision-tenant-isolation' });
const PASSWORDS: Record<string, string> = {
  alpha: randomBytes(24).toString('hex'),
  bravo: randomBytes(24).toString('hex'),
};
const RENDERED: Record<string, string> = {};

/**
 * @description Apply a rendered database.sql with the real psql inside the fixture's own container,
 * as its superuser over the local socket, exactly as the runbook's psql command does. The password
 * reaches psql through the environment variable the file reads with \getenv, never through argv.
 * @param tenant Which rendering to apply.
 * @param password The tenant password, or undefined to apply without one.
 * @returns psql's exit status and combined output.
 */
function applyRendered(tenant: string, password: string | undefined): Run {
  const env = childEnv();
  if (password !== undefined) env.OSHAL_TENANT_DB_PASSWORD = password;
  const result = spawnSync('docker', ['exec', '-i', ...(password !== undefined ? ['-e', 'OSHAL_TENANT_DB_PASSWORD'] : []),
    SERVER.containerName, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', SERVER.connection.database, '-f', '-'], {
    input: readFileSync(join(RENDERED[tenant], 'database.sql')), encoding: 'utf8', env, timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * @description Connect over TCP as one tenant's own LOGIN role.
 * @param tenant The role's tenant.
 * @param database The database to open.
 * @returns A connected client; the caller ends it.
 */
async function connectAs(tenant: string, database: string): Promise<Client> {
  const { host, port } = SERVER.connection;
  const client = new Client({ host, port, user: `oshal_tenant_${tenant}`, password: PASSWORDS[tenant], database });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

/**
 * @description Run a body over a tenant connection and always close it.
 * @param tenant The role's tenant.
 * @param database The database to open.
 * @param body What to do with the client.
 * @returns What the body returns.
 */
async function asTenant<T>(tenant: string, database: string, body: (client: Client) => Promise<T>): Promise<T> {
  const client = await connectAs(tenant, database);
  try { return await body(client); } finally { await client.end(); }
}

/**
 * @description Require a PostgreSQL refusal with a given SQLSTATE and message. A connection that
 * unexpectedly opens is closed before the assertion fails, so a regression reports as this
 * assertion rather than as a connection the server later tears down.
 * @param attempt The operation that must fail.
 * @param code The SQLSTATE.
 * @param message A fragment of the server's message.
 * @returns Nothing.
 */
async function expectRefused(attempt: Promise<unknown>, code: string, message: string): Promise<void> {
  const error = await attempt.then(
    async (opened) => { if (opened instanceof Client) await opened.end(); return null; },
    (failure: unknown) => failure as { code?: string; message?: string },
  );
  expect(error, `expected ${code} ${message}`).not.toBeNull();
  expect(error?.code).toBe(code);
  expect(error?.message).toContain(message);
}

/**
 * @description The note a tenant reads back from its own table.
 * @param tenant The tenant.
 * @returns The notes in its own database.
 */
async function ownNotes(tenant: string): Promise<string[]> {
  return asTenant(tenant, `oshal_tenant_${tenant}`, async (client) =>
    (await client.query<{ note: string }>('SELECT note FROM tenant_rows ORDER BY id')).rows.map((row) => row.note));
}

describe('two isolated tenants on one disposable PostgreSQL', () => {
  beforeAll(async () => {
    await SERVER.start();
    for (const tenant of ['alpha', 'bravo', 'charlie']) {
      RENDERED[tenant] = freshDir(`oshal-tenant-${tenant}-apply-`);
      const run = provision([tenant, '--tenancy=isolated', ...REQUIRED, `--out=${posix(RENDERED[tenant])}`]);
      expect(run.status, run.out).toBe(0);
    }
    for (const tenant of ['alpha', 'bravo']) {
      const run = applyRendered(tenant, PASSWORDS[tenant]);
      expect(run.status, run.out).toBe(0);
      await asTenant(tenant, `oshal_tenant_${tenant}`, async (client) => {
        await client.query('CREATE TABLE tenant_rows (id serial PRIMARY KEY, note text NOT NULL)');
        await client.query('INSERT INTO tenant_rows (note) VALUES ($1)', [`${tenant}-only`]);
      });
    }
  }, 180_000);

  afterAll(async () => {
    await SERVER.stop();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('gives each tenant a non-privileged role and its own database, and each reads its own rows', async () => {
    const roles = await SERVER.pool.query(`SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
        rolreplication, rolinherit, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname LIKE 'oshal_tenant_%' ORDER BY rolname`);
    expect(roles.rows).toEqual(['alpha', 'bravo'].map((tenant) => ({
      rolname: `oshal_tenant_${tenant}`, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
      rolreplication: false, rolinherit: false, rolcanlogin: true, rolconnlimit: 24,
    })));
    const databases = await SERVER.pool.query(`SELECT d.datname, pg_get_userbyid(d.datdba) AS owner,
        has_database_privilege('public', d.datname, 'CONNECT') AS public_connect
        FROM pg_database d WHERE d.datname LIKE 'oshal_tenant_%' ORDER BY d.datname`);
    expect(databases.rows).toEqual(['alpha', 'bravo'].map((tenant) => ({
      datname: `oshal_tenant_${tenant}`, owner: `oshal_tenant_${tenant}`, public_connect: false,
    })));
    expect(await ownNotes('alpha')).toEqual(['alpha-only']);
    expect(await ownNotes('bravo')).toEqual(['bravo-only']);
  });

  it('refuses a cross-tenant database connection, in both directions', async () => {
    await expectRefused(connectAs('alpha', 'oshal_tenant_bravo'), '42501', 'permission denied for database "oshal_tenant_bravo"');
    await expectRefused(connectAs('bravo', 'oshal_tenant_alpha'), '42501', 'permission denied for database "oshal_tenant_alpha"');
  });

  it("refuses a cross-tenant row read from the tenant's own session", async () => {
    await asTenant('alpha', 'oshal_tenant_alpha', (client) => expectRefused(
      client.query('SELECT note FROM oshal_tenant_bravo.public.tenant_rows'), '0A000', 'cross-database references are not implemented'));
  });

  it("refuses the other tenant's rows even with the connection layer drifted open, and re-applying closes it", async () => {
    await asTenant('bravo', 'oshal_tenant_bravo', (client) => client.query('GRANT SELECT ON tenant_rows TO PUBLIC'));
    await SERVER.pool.query('GRANT CONNECT ON DATABASE oshal_tenant_bravo TO oshal_tenant_alpha');
    await asTenant('alpha', 'oshal_tenant_bravo', async (client) => {
      expect((await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0].db).toBe('oshal_tenant_bravo');
      await expectRefused(client.query('SELECT note FROM public.tenant_rows'), '42501', 'permission denied for schema public');
    });
    const reapplied = applyRendered('bravo', PASSWORDS.bravo);
    expect(reapplied.status, reapplied.out).toBe(0);
    await expectRefused(connectAs('alpha', 'oshal_tenant_bravo'), '42501', 'permission denied for database "oshal_tenant_bravo"');
    expect(await ownNotes('bravo')).toEqual(['bravo-only']);
  });

  it('re-applying removes a membership that would let one tenant become the other, and keeps its data', async () => {
    // Both directions, one at a time (PostgreSQL refuses a circular membership): the role the
    // tenant holds, and the other tenant holding the tenant's role. Each drift is shown live first.
    const drifts: [string, string, string][] = [
      ['GRANT oshal_tenant_bravo TO oshal_tenant_alpha', 'alpha', 'oshal_tenant_bravo'],
      ['GRANT oshal_tenant_alpha TO oshal_tenant_bravo', 'bravo', 'oshal_tenant_alpha'],
    ];
    for (const [grant, member, target] of drifts) {
      await SERVER.pool.query(grant);
      await asTenant(member, `oshal_tenant_${member}`, (client) => client.query(`SET ROLE ${target}`));
      const reapplied = applyRendered('alpha', PASSWORDS.alpha);
      expect(reapplied.status, reapplied.out).toBe(0);
      await asTenant(member, `oshal_tenant_${member}`, (client) =>
        expectRefused(client.query(`SET ROLE ${target}`), '42501', `permission denied to set role "${target}"`));
    }
    const memberships = await SERVER.pool.query(`SELECT 1 FROM pg_auth_members m
      WHERE m.member IN ('oshal_tenant_alpha'::regrole, 'oshal_tenant_bravo'::regrole)`);
    expect(memberships.rowCount).toBe(0);
    expect(await ownNotes('alpha')).toEqual(['alpha-only']);
  });

  it('governs only the databases it creates: PUBLIC keeps CONNECT on the server\'s other databases', async () => {
    // As built, not a goal: the rendering closes the tenant's own database and changes no other
    // database on the server. Both databases below keep PostgreSQL's default PUBLIC CONNECT, so the
    // tenant's role opens them. The runbook records this limit; if a change closes it, this case
    // goes red and the runbook must change with it.
    for (const database of ['postgres', SERVER.connection.database]) {
      const reached = await asTenant('alpha', database, async (client) =>
        (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0].db);
      expect(reached).toBe(database);
    }
  });

  it('refuses to provision without a password, or with a short one, and creates nothing', async () => {
    const missing = applyRendered('charlie', undefined);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain('refused: set OSHAL_TENANT_DB_PASSWORD');
    const short = applyRendered('charlie', 'short-secret');
    expect(short.status).not.toBe(0);
    expect(short.out).toContain('refused: the tenant password must be at least 16 characters');
    expect((await SERVER.pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'oshal_tenant_charlie'")).rowCount).toBe(0);
    expect((await SERVER.pool.query("SELECT 1 FROM pg_database WHERE datname = 'oshal_tenant_charlie'")).rowCount).toBe(0);
  });
});

