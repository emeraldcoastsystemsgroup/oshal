/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Production guard for the CRM DigitalOcean PostgreSQL 18 lifecycle: URL/CA/topology validation, guarded launcher environment isolation, and the real pinned PG18 one-shot bootstrap/redeploy/retry proof (gated by OSHAL_RUN_PG18_INTEGRATION=1).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Align the writable-CA fixture with the launcher's path-component walker (0666 trips the component guard first) and add a 0640 case so the specific 0600-or-0644 mode guard stays covered.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const provisionPath = path.resolve(root, 'scripts/governance/provision-app-role.mjs');
const bootstrapPath = path.resolve(root, 'scripts/governance/bootstrap-managed-postgres.mjs');
const sql = fs.readFileSync(path.resolve(root, 'docs/governance/app-role-provisioning.sql'), 'utf8');
const provision = fs.readFileSync(provisionPath, 'utf8');
const bootstrap = fs.readFileSync(bootstrapPath, 'utf8');
const managed = fs.readFileSync(path.resolve(root, 'docker-compose.managed-postgres.yml'), 'utf8');
const launcher = fs.readFileSync(path.resolve(root, 'scripts/managed-postgres-compose.sh'), 'utf8');
const connectorBase = fs.readFileSync(path.resolve(root, 'scripts/migrations/100-connector-base-schema.sql'), 'utf8');
const cliBase = fs.readFileSync(path.resolve(root, 'scripts/migrations/100-cli-token-base-schema.sql'), 'utf8');
const ticketBase = fs.readFileSync(path.resolve(root, 'scripts/migrations/100-ticket-family-base-schema.sql'), 'utf8');
const workItemRouting = fs.readFileSync(path.resolve(root, 'scripts/migrations/123-work-items-routing-contract.sql'), 'utf8');

const APP_PASSWORD = 'a'.repeat(48);
const BOT_PASSWORD = 'b'.repeat(48);
const BOOTSTRAP_PASSWORD = 'c'.repeat(48);
const PRIVATE_HOST = 'private-crm-do-user-1-0.a.db.ondigitalocean.com';
const TEST_DEPLOYMENT_ID = 'gsquared-crm-test';
const TEST_BOT_IMAGE = 'ghcr.io/emeraldcoastsystemsgroup/oshal-bot:sha-abcdef1234567890';
const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUHAwqebxlihE724WTpE6C5nihQeQwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSb3NoYWwtbWFuYWdlZC10ZXN0MB4XDTI2MDgxOTE5MDQx
MVoXDTM2MDgxNjE5MDQxMVowHTEbMBkGA1UEAwwSb3NoYWwtbWFuYWdlZC10ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz/UmgNxT3oEbAFuO9n75
MfcBCmGeKiB2Fb+W2qEN1O+EM+9Gr52ewSAmenG7z4cD9nS3d7KAisMBo7ynemiO
iHFMjA31roy8V4kSG0dCtz2cMTULudjiGBlLJ8TO/uB+juCTm7Am4Dm2ZiYdZhzt
ABciQJ0SM2o7jf4c3k3Di6L/4C+ymmURviy5XicG4zMhZ85S+WqUY/KTx1XQvQ+F
Q8x9TsqiZyBqNReONgvmnl7GGWis31tDZ/UvEKjpunA1DrdaondmRonrnykVzPg5
pqJ91RfY9/DVE+gy8D7+9GcmfN2GoZPYHKWa6LNQIyUxDAJ51+kfNMRvCldsJdZX
RQIDAQABo1MwUTAdBgNVHQ4EFgQUkGUegku3AMf39F4RX8k7Qazz3PQwHwYDVR0j
BBgwFoAUkGUegku3AMf39F4RX8k7Qazz3PQwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAv5r4j6oPvW2EVkhZk7HnqFaOgMP4ruClsebZN7a0F8gc
96PMjNpDvG+hJLdx+qKyZnrMZc0oQUpZP/QM0jd4JQjrUSeed8LRVURA/fLG7DSA
Ufvg6NjJO5nBxigE26guCno/HcUA4YHNDK93eYmeo8cfpBKxKGXzY+0zDGGTGyZv
B+tFZD5hV2+nInqc9lSzEEB2/jYrzr8FTa4YQh/Fvwy7KRxKpWqvnNeQdVKw9ecB
+0YyzX5MZZdyIMT4Ldnu4UWfpmkHZ++ZJAfqz3sFeN1WvjWX+ks+vpU8LSasJhn2
DHeNoM8D2I5jcdRY4Dm4FmdZgC2D44GgMRB6ANTI8A==
-----END CERTIFICATE-----
`;
let tempDir: string;
let caPath: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-managed-pg-'));
  caPath = path.join(tempDir, 'do-postgres-ca.pem');
  fs.writeFileSync(caPath, TEST_CA_PEM, { mode: 0o600 });
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function databaseUrl(
  user: string,
  password: string,
  options: { host?: string; port?: string; database?: string; extra?: Record<string, string> } = {},
) {
  const url = new URL(
    `postgresql://${user}:${password}@${options.host ?? PRIVATE_HOST}:${options.port ?? '25060'}/${options.database ?? 'oshal'}`,
  );
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', caPath);
  for (const [key, value] of Object.entries(options.extra ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function managedEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BOOTSTRAP_DATABASE_URL: databaseUrl('doadmin', BOOTSTRAP_PASSWORD),
    DATABASE_URL: databaseUrl('oshal_app', APP_PASSWORD),
    BOT_DATABASE_URL: databaseUrl('oshal_bot', BOT_PASSWORD),
    POSTGRES_CA_CERT_PATH: caPath,
    OSHAL_MANAGED_DEPLOYMENT_ID: TEST_DEPLOYMENT_ID,
    OSHAL_BOT_IMAGE: TEST_BOT_IMAGE,
    ...overrides,
  };
}

function preflight(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [bootstrapPath, '--preflight-only'], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

function dryRun(
  appPassword = APP_PASSWORD,
  botPassword = BOT_PASSWORD,
  bootstrapHost = PRIVATE_HOST,
  runtimeHost = bootstrapHost,
  phase = 'pre-migration',
) {
  return spawnSync(process.execPath, [provisionPath, '--dry-run', `--phase=${phase}`], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      BOOTSTRAP_DATABASE_URL: `postgresql://doadmin:${BOOTSTRAP_PASSWORD}@${bootstrapHost}:25060/oshal`,
      DATABASE_URL: `postgresql://oshal_app:${appPassword}@${runtimeHost}:25060/oshal`,
      BOT_DATABASE_URL: `postgresql://oshal_bot:${botPassword}@${runtimeHost}:25060/oshal`,
      OSHAL_APP_DB_PASSWORD: appPassword,
      OSHAL_BOT_DB_PASSWORD: botPassword,
    },
  });
}

describe('managed PostgreSQL static preflight', () => {
  it('accepts only the private, dedicated, TLS-verifying three-role topology without printing secrets', () => {
    const result = preflight(managedEnv());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('"valid":true');
    expect(result.stdout).not.toContain(APP_PASSWORD);
    expect(result.stdout).not.toContain(BOT_PASSWORD);
    expect(result.stdout).not.toContain(BOOTSTRAP_PASSWORD);
  });

  it.each([
    ['public endpoint', { BOOTSTRAP_DATABASE_URL: databaseUrl('doadmin', BOOTSTRAP_PASSWORD, { host: 'crm-do-user-1-0.a.db.ondigitalocean.com' }) }],
    ['wrong port', { BOOTSTRAP_DATABASE_URL: databaseUrl('doadmin', BOOTSTRAP_PASSWORD, { port: '5432' }) }],
    ['default database', { BOOTSTRAP_DATABASE_URL: databaseUrl('doadmin', BOOTSTRAP_PASSWORD, { database: 'defaultdb' }) }],
    ['unexpected query key', { BOOTSTRAP_DATABASE_URL: databaseUrl('doadmin', BOOTSTRAP_PASSWORD, { extra: { options: '-csearch_path=public' } }) }],
    ['wrong app identity', { DATABASE_URL: databaseUrl('some_user', APP_PASSWORD) }],
    ['host mismatch', { BOT_DATABASE_URL: databaseUrl('oshal_bot', BOT_PASSWORD, { host: 'private-other-do-user-1-0.a.db.ondigitalocean.com' }) }],
    ['reused role password', { BOT_DATABASE_URL: databaseUrl('oshal_bot', APP_PASSWORD) }],
  ])('rejects %s before mutation', (_label, overrides) => {
    const result = preflight(managedEnv(overrides));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[managed-postgres] FAILED:');
  });

  it('allows committed development passwords only when bootstrap itself is local', () => {
    const local = dryRun('oshal-app-dev', 'oshal-bot-dev', 'oshal-db');
    expect(local.status, local.stderr).toBe(0);
    const externalBootstrap = dryRun('oshal-app-dev', 'oshal-bot-dev', PRIVATE_HOST, 'oshal-db');
    expect(externalBootstrap.status).toBe(1);
    expect(externalBootstrap.stderr).toContain('48-128 hexadecimal characters');
  });
});

describe('PostgreSQL 18 role and ownership contract', () => {
  it('sets PG18 membership options before ownership and skips linked/extension sequences', () => {
    expect(sql).toContain('GRANT oshal_app TO CURRENT_USER WITH SET TRUE, INHERIT TRUE');
    expect(sql).toContain('GRANT oshal_bot TO CURRENT_USER WITH SET FALSE, INHERIT FALSE');
    expect(sql).not.toMatch(/GRANT\s+oshal_(?:app|bot).*WITH ADMIN TRUE/);
    expect(sql.indexOf('WITH SET TRUE, INHERIT TRUE')).toBeLessThan(sql.indexOf("ALTER TABLE public.%I OWNER TO oshal_app"));
    expect(sql.indexOf("ALTER TABLE public.%I OWNER TO oshal_app")).toBeLessThan(sql.indexOf("ALTER SEQUENCE public.%I OWNER TO oshal_app"));
    expect(sql).toContain("d.deptype IN ('a', 'i', 'e')");
    expect(sql).toContain('public foreign tables are unsupported');
    expect(provision).toContain("pg_has_role(current_user, 'oshal_app', 'USAGE')");
    expect(provision).toContain("pg_has_role(current_user, 'oshal_bot', 'USAGE')");
  });

  it('keeps pre-migration convergence relation-safe and reserves exact convergence for final', () => {
    const pre = dryRun();
    expect(pre.status, pre.stderr).toBe(0);
    expect(pre.stdout).not.toContain('ALTER TABLE public.');
    expect(pre.stdout).not.toContain('ALTER DEFAULT PRIVILEGES');
    expect(pre.stdout).not.toContain('SET LOCAL ROLE oshal_app');

    const final = dryRun(APP_PASSWORD, BOT_PASSWORD, PRIVATE_HOST, PRIVATE_HOST, 'final');
    expect(final.status, final.stderr).toBe(0);
    expect(final.stdout).toContain('ALTER TABLE public.%I OWNER TO oshal_app');
    expect(final.stdout).toContain('ALTER DEFAULT PRIVILEGES');
    expect(pre.stdout).toContain('ALTER ROLE oshal_bot WITH PASSWORD');
    expect(pre.stdout).toContain('NOLOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT');
    expect(sql).toContain("RAISE EXCEPTION 'oshal_bot sessions survived the pre-migration lockdown'");
    expect(sql).not.toContain('ALTER ROLE oshal_bot LOGIN');
    expect(provision).toContain("await client.query('ALTER ROLE oshal_bot LOGIN')");
    expect(provision).toContain("await client.query('ROLLBACK').catch(() => {})");
    expect(provision).toContain("phase === 'pre-migration' && rows.length > EXPECTED_HELPERS.size");
    expect(provision).toContain("phase === 'final' && rows.length !== EXPECTED_HELPERS.size");
  });

  it('proves exact runtime attributes, effective memberships, helpers, settings, and default ACLs', () => {
    expect(provision).toContain('rolreplication');
    expect(provision).toContain('rolconfig');
    expect(provision).toContain("role.rolname === 'oshal_bot' ? phase === 'final' : true");
    expect(provision).toContain("pg_has_role(current_user, 'pg_signal_backend', 'MEMBER')");
    expect(bootstrap).toContain("pg_has_role(current_user, 'pg_signal_backend', 'MEMBER')");
    expect(provision).toContain('bool_or(m.set_option)');
    expect(provision).toContain('unexpected app/bot role membership detected');
    expect(provision).toContain("'search_path=public, pg_temp'");
    expect(provision).toContain('runtime-role default privileges are incomplete or unexpected');
    expect(sql).toContain('CONNECTION LIMIT 24');
    expect(sql).toContain('CONNECTION LIMIT 8');
    expect(provision).toContain("role.rolname === 'oshal_app' ? 24 : 8");
    expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES FOR ROLE oshal\b/);
  });

  it('revokes broad bot defaults and converges the reviewed effective ACL allowlist', () => {
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC, oshal_bot');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, oshal_bot');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC, oshal_bot');
    expect(sql).toContain('REVOKE CONNECT, TEMPORARY ON DATABASE :DBNAME FROM PUBLIC');
    expect(sql).toContain('GRANT CONNECT, TEMPORARY ON DATABASE :DBNAME TO oshal_app');
    expect(sql).toContain('GRANT CONNECT ON DATABASE :DBNAME TO oshal_bot');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON FUNCTIONS FROM oshal_bot');
    expect(sql).toContain('GRANT SELECT (\n  agent_id, name, status');
    expect(sql).toContain('GRANT UPDATE (status, assigned_agent_id, execution_output, updated_at)');
    expect(sql).toContain('GRANT USAGE ON SEQUENCE public.oshal_cost_events_id_seq TO oshal_bot');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.oshal_owns_ticket(uuid) TO oshal_app, oshal_bot');
    expect(sql).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO oshal_bot');
    expect(provision).toContain("has_table_privilege('oshal_bot'");
    expect(provision).toContain("has_column_privilege('oshal_bot'");
    expect(provision).toContain("has_sequence_privilege('oshal_bot'");
    expect(provision).toContain("has_function_privilege('oshal_bot'");
    expect(provision).toContain("has_schema_privilege('oshal_bot', 'public', 'CREATE')");
    expect(provision).toContain("a.privilege_type = 'TEMPORARY'");
    expect(provision).toContain('unexpected direct PUBLIC table privilege');
    expect(provision).toContain('unexpected direct PUBLIC sequence privilege');
    expect(provision).toContain("p.prosecdef\n         OR p.proname IN");
  });

  it('uses distinct hex passwords and masks them in dry-run output', () => {
    const result = dryRun();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASSWORD '***'");
    expect(result.stdout).not.toContain(APP_PASSWORD);
    expect(result.stdout).not.toContain(BOT_PASSWORD);
  });

  it('precreates roles, locks the lifecycle, migrates, enforces RLS, then proves exact users', () => {
    const precreate = bootstrap.indexOf("phase: 'pre-migration'");
    const migrate = bootstrap.lastIndexOf('runMigrations(config);');
    const enforce = bootstrap.lastIndexOf('applyRls(config);');
    const final = bootstrap.indexOf("phase: 'final'");
    expect(precreate).toBeGreaterThan(0);
    expect(precreate).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(enforce);
    expect(enforce).toBeLessThan(final);
    expect(bootstrap).toContain('pg_try_advisory_lock');
    expect(bootstrap).toContain("delete env.BOOTSTRAP_DATABASE_URL");
    expect(bootstrap).toContain("proveRuntime(config.appUrl, 'oshal_app')");
    expect(bootstrap).toContain("proveRuntime(config.botUrl, 'oshal_bot')");
  });
});

describe('fresh-schema migration-owned bases', () => {
  it('creates connector and DEK stores with exact FORCE RLS before migration 101', () => {
    expect(connectorBase).toContain('CREATE TABLE IF NOT EXISTS oshal_connections');
    expect(connectorBase).toContain('CREATE TABLE IF NOT EXISTS oshal_user_deks');
    expect(connectorBase).toContain('oshal_connections_personal_or_tenant');
    expect(connectorBase).toContain('oshal_user_deks_owner_or_operator');
    expect(connectorBase.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
  });

  it('creates the canonical CLI token and ticket families before their additive/RLS migrations', () => {
    expect(cliBase).toContain('CREATE TABLE IF NOT EXISTS oshal_cli_tokens');
    expect(cliBase).toContain('node_client_id');
    expect(cliBase).toContain('principal_issuer');
    expect(cliBase).toContain('oshal_cli_tokens_owner_or_operator');
    expect(ticketBase).toContain('CREATE TABLE IF NOT EXISTS tickets');
    for (const table of ['ticket_task_links', 'ticket_workspace_links', 'ticket_status_history', 'ticket_agent_assignments']) {
      expect(ticketBase).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(ticketBase).toContain('tickets_owner_or_operator');
  });

  it('moves the remaining work-item routing schema into an idempotent migration', () => {
    expect(workItemRouting).toContain('ADD COLUMN IF NOT EXISTS run_id TEXT');
    expect(workItemRouting).toContain('DROP CONSTRAINT IF EXISTS work_items_status_check');
    expect(workItemRouting).toContain("'routing_failed'");
    expect(workItemRouting).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
  });
});

describe('managed Compose topology and guarded launcher', () => {
  it('uses one-shot admin initialization, an app-only live gate, a pinned PG18 client, and exact CA mounts', () => {
    expect(managed).toContain('oshal-db-init:');
    expect(managed).toContain('condition: service_completed_successfully');
    expect(managed).toContain('postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2');
    expect(managed).toContain('source: ./config-seed/do-postgres-ca.pem');
    expect(managed).toContain('create_host_path: false');
    expect(managed).toContain("SELECT current_user");
    expect(managed).toContain('BOOTSTRAP_DATABASE_URL: !reset null');
    expect(managed).toContain('OSHAL_DB_POOL_MAX: "8"');
    expect(managed).toContain('PGPOOL_MAX: "2"');
    expect(managed).toContain('RAG_DB_POOL_MAX: "2"');
    expect(managed.match(/OSHAL_SCHEMA_BOOTSTRAP: validate-only/g)).toHaveLength(2);
    expect(managed.match(/DATABASE_URL: !reset null/g)?.length).toBeGreaterThanOrEqual(4);
    expect(managed).toContain('OSHAL_SKIP_RUNTIME_MIGRATIONS: "true"');
    expect(managed).toContain('RUN_MIGRATIONS: "false"');
  });

  it('pins both Compose files, minimum version, CRM service set, and removes init metadata after health', () => {
    expect(launcher).toContain('MIN_COMPOSE_VERSION="2.24.4"');
    expect(launcher).toContain('-f "$BASE_FILE"');
    expect(launcher).toContain('-f "$MANAGED_FILE"');
    expect(launcher).toContain('--profile sales-node');
    expect(launcher).toContain('--project-name "$OSHAL_MANAGED_DEPLOYMENT_ID"');
    expect(launcher).toContain('DEFAULT_DEPLOYMENT_MARKER_FILE="/etc/oshal/deployment-id"');
    expect(launcher).toContain('Never sudo a user-writable');
    expect(launcher).toContain('REPO_ROOT="$(dirname -- "$(dirname -- "$LAUNCHER_PATH")")"');
    expect(launcher).toContain('validate_release_assets');
    expect(launcher).toContain('validate_trusted_path_components "$CRM_ENV_FILE"');
    expect(launcher).toContain('validate_trusted_regular_file "$MANAGED_FILE"');
    expect(launcher).toContain('validate_trusted_directory "$MIGRATIONS_DIR"');
    expect(launcher).toContain('Dedicated-host marker does not exactly match');
    expect(launcher).toContain('CRM env file must have mode 0600');
    expect(launcher).toContain('validate_ca_trust_anchor "$POSTGRES_CA_HOST_FILE"');
    expect(launcher).toContain('PostgreSQL CA trust anchor must be owned by root');
    expect(launcher).toContain('PostgreSQL CA trust anchor must have mode 0600 or 0644');
    expect(launcher).toContain('OSHAL_BOT_IMAGE must not use the mutable latest tag');
    expect(launcher).toContain('COMPOSE_ENV_PREFIX+=(-u "$interpolation_key")');
    expect(launcher).toContain('validate_env_file_keys "$CRM_ENV_FILE"');
    expect(launcher).toContain('assert_exact_running_topology');
    expect(launcher).toContain('label=com.docker.compose.project=$OSHAL_MANAGED_DEPLOYMENT_ID');
    expect(launcher).toContain('Unexpected running service(s) in managed CRM project');
    expect(launcher).toContain('assert_exact_running_topology pre');
    expect(launcher).toContain('assert_exact_running_topology post');
    expect(launcher).toContain('Missing running service(s) from managed CRM project');
    expect(launcher).toContain('up -d --remove-orphans "${CRM_SERVICES[@]}"');
    expect(launcher).toContain('wait_for_runtime_health');
    expect(launcher).toContain('logs --no-color oshal-db-init');
    expect(launcher).toContain('rm -f -s oshal-db-init');
    expect(launcher).toContain('chmod 600');
    expect(launcher).toContain('must run as root');
  });

  it('effective Compose leaves admin/bot DSNs out of the API and uses only app readiness', () => {
    const version = spawnSync('docker', ['compose', 'version', '--short'], { cwd: root, encoding: 'utf8' });
    if (version.status !== 0) return;
    const result = spawnSync('docker', [
      'compose',
      '--project-name', TEST_DEPLOYMENT_ID,
      '-f', 'docker-compose.oshal-local.yml',
      '-f', 'docker-compose.managed-postgres.yml',
      '--profile', 'sales-node',
      'config', '--format', 'json',
    ], { cwd: root, encoding: 'utf8', env: managedEnv() });
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout);
    const services = config.services;
    expect(Object.keys(services['oshal-db-init'].environment).sort()).toEqual([
      'BOOTSTRAP_DATABASE_URL', 'BOT_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_CA_CERT_PATH',
    ]);
    expect(Object.keys(services['oshal-db'].environment)).toEqual(['DATABASE_URL']);
    expect(services['oshal-api'].environment.BOOTSTRAP_DATABASE_URL).toBeUndefined();
    expect(services['oshal-api'].environment.BOT_DATABASE_URL).toBeUndefined();
    expect(services['oshal-api'].environment.DATABASE_URL).toBe(managedEnv().DATABASE_URL);
    expect(services['oshal-api'].environment.OSHAL_SKIP_RUNTIME_MIGRATIONS).toBe('true');
    expect(services['oshal-api'].environment.RUN_MIGRATIONS).toBe('false');
    for (const serviceName of ['jarvis-bot', 'sales-bot']) {
      const modelEnv = services[serviceName].environment as Record<string, string>;
      const datastoreKeys = Object.keys(modelEnv).filter((key) => (
        key === 'DATABASE_URL'
        || key === 'BOOTSTRAP_DATABASE_URL'
        || key === 'BOT_DATABASE_URL'
        || key.startsWith('PG')
        || key.startsWith('POSTGRES_')
        || key.includes('CHROMADB')
        || key.startsWith('ARANGO_')
        || key === 'OSHAL_DB_GUC'
        || key === 'DB_MAX_CONNECTIONS'
      ));
      expect(datastoreKeys, `${serviceName} must be DB-credential-free`).toEqual([]);
    }
    expect(services['jarvis-bot'].environment.OSHAL_SCHEMA_BOOTSTRAP).toBe('validate-only');
    expect(services['sales-bot'].environment.OSHAL_SCHEMA_BOOTSTRAP).toBe('validate-only');
    expect(services['oshal-db'].ports).toBeUndefined();
    expect(services['oshal-db'].volumes).toHaveLength(1);
    expect(services['oshal-db'].healthcheck.test.join(' ')).toContain('SELECT current_user');
  }, 15_000);
});

const RUN_PG18_INTEGRATION = process.env.OSHAL_RUN_PG18_INTEGRATION === '1';
const PG18_VECTOR_IMAGE = 'pgvector/pgvector:pg18@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a';
const BOOTSTRAP_FIXTURE_IMAGE = process.env.OSHAL_PG18_BOOTSTRAP_IMAGE || 'oshal-bot:latest';

interface Pg18Fixture {
  container: string;
  network: string;
}

function dockerPath(filePath: string): string {
  return path.resolve(filePath).replaceAll('\\', '/');
}

function docker(args: string[], options: { input?: string; timeout?: number } = {}) {
  return spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout ?? 180_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function startPg18Fixture(label: string): Pg18Fixture {
  const suffix = `${process.pid}-${Date.now()}`;
  const fixture = {
    container: `oshal-pg18-${label}-${suffix}`,
    network: `oshal-pg18-${label}-net-${suffix}`,
  };
  const network = docker(['network', 'create', fixture.network]);
  expect(network.status, network.stderr).toBe(0);
  const started = docker([
    'run', '-d', '--name', fixture.container,
    '--network', fixture.network, '--network-alias', 'oshal-db',
    '-e', 'POSTGRES_PASSWORD=postgres-test-only',
    '-e', 'POSTGRES_DB=oshal',
    PG18_VECTOR_IMAGE,
  ]);
  if (started.status !== 0) {
    docker(['network', 'rm', fixture.network]);
    expect(started.status, started.stderr).toBe(0);
  }

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = docker(['exec', fixture.container, 'psql', '-U', 'postgres', '-d', 'oshal', '-Atqc', 'SELECT 1'], { timeout: 10_000 });
    if (probe.status === 0 && probe.stdout.trim() === '1') {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) {
    stopPg18Fixture(fixture);
    throw new Error('pinned PostgreSQL 18 fixture did not become ready');
  }

  const setup = docker(
    ['exec', '-i', fixture.container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'oshal'],
    {
      input: `
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE ROLE doadmin LOGIN PASSWORD '${BOOTSTRAP_PASSWORD}' CREATEROLE CREATEDB BYPASSRLS;
        GRANT pg_signal_backend TO doadmin;
        ALTER DATABASE oshal OWNER TO doadmin;
      `,
    },
  );
  if (setup.status !== 0) {
    stopPg18Fixture(fixture);
    expect(setup.status, setup.stderr).toBe(0);
  }
  return fixture;
}

function stopPg18Fixture(fixture: Pg18Fixture): void {
  docker(['rm', '-f', fixture.container], { timeout: 30_000 });
  docker(['network', 'rm', fixture.network], { timeout: 30_000 });
}

function runWholeBootstrap(fixture: Pg18Fixture, migrationsDir?: string) {
  const args = [
    'run', '--rm', '--network', fixture.network,
    '--entrypoint', 'node',
    '--volume', `${dockerPath(path.resolve(root, 'scripts'))}:/app/scripts:ro`,
    '--volume', `${dockerPath(path.resolve(root, 'docs'))}:/app/docs:ro`,
  ];
  if (migrationsDir) {
    args.push('--volume', `${dockerPath(migrationsDir)}:/app/scripts/migrations:ro`);
  }
  args.push(
    '-e', `BOOTSTRAP_DATABASE_URL=postgresql://doadmin:${BOOTSTRAP_PASSWORD}@oshal-db:5432/oshal`,
    '-e', `DATABASE_URL=postgresql://oshal_app:${APP_PASSWORD}@oshal-db:5432/oshal`,
    '-e', `BOT_DATABASE_URL=postgresql://oshal_bot:${BOT_PASSWORD}@oshal-db:5432/oshal`,
    '-e', 'OSHAL_BOOTSTRAP_CONNECT_ATTEMPTS=3',
    BOOTSTRAP_FIXTURE_IMAGE,
    'scripts/governance/bootstrap-managed-postgres.mjs',
  );
  return docker(args);
}

function fixtureQuery(fixture: Pg18Fixture, query: string): string {
  const result = docker(['exec', fixture.container, 'psql', '-U', 'postgres', '-d', 'oshal', '-Atqc', query]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function fixtureRoleCommand(fixture: Pg18Fixture, role: string, password: string, sqlCommand: string) {
  return docker([
    'exec', '-e', `PGPASSWORD=${password}`, fixture.container,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', 'oshal', '-Atqc', sqlCommand,
  ]);
}

function fixtureTcpRoleCommand(fixture: Pg18Fixture, role: string, password: string, sqlCommand: string) {
  return docker([
    'exec', '-e', `PGPASSWORD=${password}`, fixture.container,
    'psql', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', role, '-d', 'oshal', '-Atqc', sqlCommand,
  ]);
}

describe.skipIf(!RUN_PG18_INTEGRATION)('guarded launcher process environment', () => {
  it('removes hostile parent-shell DSNs before every effective Compose invocation', () => {
    const expectedImage = TEST_BOT_IMAGE;
    const fakeDocker = `#!/bin/sh
if [ "$1" = "compose" ] && [ "$2" = "version" ] && [ "$3" = "--short" ]; then
  echo 2.24.4
  exit 0
fi
if [ "$1" = "ps" ]; then
  [ -n "\${FAKE_UNEXPECTED_SERVICE:-}" ] && echo "$FAKE_UNEXPECTED_SERVICE"
  exit 0
fi
for key in BOOTSTRAP_DATABASE_URL DATABASE_URL BOT_DATABASE_URL POSTGRES_CA_CERT_PATH OSHAL_MANAGED_DEPLOYMENT_ID OSHAL_BOT_IMAGE; do
  if env | grep -q "^$key="; then
    echo "launcher leaked parent-shell $key into Compose" >&2
    exit 91
  fi
done
case " $* " in
  *" config --quiet "*) exit 0 ;;
  *" config --images "*) echo '${expectedImage}'; exit 0 ;;
esac
echo "unexpected docker invocation" >&2
exit 92
`;
    const crmEnv = `OSHAL_MANAGED_DEPLOYMENT_ID=${TEST_DEPLOYMENT_ID}
OSHAL_BOT_IMAGE=${TEST_BOT_IMAGE}
POSTGRES_CA_CERT_PATH=/app/config-seed/do-postgres-ca.pem
BOOTSTRAP_DATABASE_URL=postgresql://doadmin:file-authoritative@oshal-db:5432/oshal
DATABASE_URL=postgresql://oshal_app:file-authoritative@oshal-db:5432/oshal
BOT_DATABASE_URL=postgresql://oshal_bot:file-authoritative@oshal-db:5432/oshal
`;
    const setup = `
set -euo pipefail
mkdir -p /fixture/scripts/governance /fixture/scripts/migrations /fixture/docs/governance /fixture/fakebin /fixture/config-seed
cp /repo/scripts/managed-postgres-compose.sh /fixture/scripts/
cp /repo/scripts/governance/bootstrap-managed-postgres.mjs /repo/scripts/governance/provision-app-role.mjs /fixture/scripts/governance/
cp /repo/scripts/migrations/*.sql /fixture/scripts/migrations/
cp /repo/docs/governance/app-role-provisioning.sql /fixture/docs/governance/
cp /repo/docker-compose.oshal-local.yml /repo/docker-compose.managed-postgres.yml /fixture/
printf '%s' '${Buffer.from(crmEnv).toString('base64')}' | base64 -d >/fixture/crm.env
printf '%s' '${Buffer.from(`${TEST_DEPLOYMENT_ID}\n`).toString('base64')}' | base64 -d >/fixture/deployment-id
printf '%s' '${Buffer.from(TEST_CA_PEM).toString('base64')}' | base64 -d >/fixture/config-seed/do-postgres-ca.pem
printf '%s' '${Buffer.from(fakeDocker).toString('base64')}' | base64 -d >/usr/local/bin/docker
chmod 0600 /fixture/crm.env
chmod 0644 /fixture/deployment-id /fixture/config-seed/do-postgres-ca.pem
chmod 0755 /usr/local/bin/docker /fixture/scripts/managed-postgres-compose.sh
cd /fixture
export OSHAL_ALLOW_TEST_MARKER_OVERRIDE=1
export OSHAL_DEPLOYMENT_MARKER_FILE=/fixture/deployment-id
export BOOTSTRAP_DATABASE_URL=postgresql://hostile-shell/wrong
export DATABASE_URL=postgresql://hostile-shell/wrong
export BOT_DATABASE_URL=postgresql://hostile-shell/wrong
export POSTGRES_CA_CERT_PATH=/hostile/ca.pem
bash scripts/managed-postgres-compose.sh /fixture/crm.env validate
chmod 0666 /fixture/docker-compose.managed-postgres.yml
if bash scripts/managed-postgres-compose.sh /fixture/crm.env validate 2>/fixture/release-mode.err; then
  echo 'launcher accepted a writable managed Compose asset' >&2
  exit 93
fi
grep -q 'Managed Compose file path component must not be group/world writable' /fixture/release-mode.err
chmod 0644 /fixture/docker-compose.managed-postgres.yml
chmod 0666 /fixture/config-seed/do-postgres-ca.pem
if bash scripts/managed-postgres-compose.sh /fixture/crm.env validate 2>/fixture/ca-mode.err; then
  echo 'launcher accepted a writable PostgreSQL CA trust anchor' >&2
  exit 94
fi
grep -q 'PostgreSQL CA trust anchor path component must not be group/world writable' /fixture/ca-mode.err
chmod 0640 /fixture/config-seed/do-postgres-ca.pem
if bash scripts/managed-postgres-compose.sh /fixture/crm.env validate 2>/fixture/ca-perm.err; then
  echo 'launcher accepted a non-0600/0644 PostgreSQL CA trust anchor' >&2
  exit 98
fi
grep -q 'PostgreSQL CA trust anchor must have mode 0600 or 0644' /fixture/ca-perm.err
chmod 0644 /fixture/config-seed/do-postgres-ca.pem
mv /fixture/config-seed/do-postgres-ca.pem /fixture/config-seed/real-ca.pem
ln -s /fixture/config-seed/real-ca.pem /fixture/config-seed/do-postgres-ca.pem
if bash scripts/managed-postgres-compose.sh /fixture/crm.env validate 2>/fixture/ca-link.err; then
  echo 'launcher accepted a symlinked PostgreSQL CA trust anchor' >&2
  exit 95
fi
grep -q 'PostgreSQL CA trust anchor path must be normalized and must not traverse symlinks' /fixture/ca-link.err
rm /fixture/config-seed/do-postgres-ca.pem
mv /fixture/config-seed/real-ca.pem /fixture/config-seed/do-postgres-ca.pem
printf '%s\n' '-----BEGIN CERTIFICATE-----' 'not-a-certificate' '-----END CERTIFICATE-----' >/fixture/config-seed/do-postgres-ca.pem
chmod 0644 /fixture/config-seed/do-postgres-ca.pem
if bash scripts/managed-postgres-compose.sh /fixture/crm.env validate 2>/fixture/ca-parse.err; then
  echo 'launcher accepted malformed X.509 content' >&2
  exit 96
fi
grep -q 'not a parseable X.509 certificate' /fixture/ca-parse.err
printf '%s' '${Buffer.from(TEST_CA_PEM).toString('base64')}' | base64 -d >/fixture/config-seed/do-postgres-ca.pem
chmod 0644 /fixture/config-seed/do-postgres-ca.pem
export FAKE_UNEXPECTED_SERVICE=career-bot
if bash scripts/managed-postgres-compose.sh /fixture/crm.env up 2>/fixture/up.err; then
  echo 'launcher accepted an unexpected running project service' >&2
  exit 97
fi
grep -q 'Unexpected running service(s) in managed CRM project: career-bot' /fixture/up.err
`;
    const result = docker([
      'run', '--rm', '--entrypoint', '/bin/bash',
      '--volume', `${dockerPath(root)}:/repo:ro`,
      BOOTSTRAP_FIXTURE_IMAGE, '-c', setup,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Managed PostgreSQL CRM compose configuration is valid.');
  }, 60_000);
});

describe.skipIf(!RUN_PG18_INTEGRATION)('real pinned PostgreSQL 18 managed lifecycle', () => {
  it('runs the entire one-shot twice as non-super doadmin after app ownership transfer', () => {
    const fixture = startPg18Fixture('redeploy');
    try {
      const first = runWholeBootstrap(fixture);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('"initialized":true');

      const workItem = fixtureRoleCommand(fixture, 'oshal_app', APP_PASSWORD, `
        INSERT INTO work_items (
          work_item_id, swarm_run_id, external_id, provider, unit_id, title, status, run_id
        ) VALUES (
          '00000000-0000-0000-0000-000000000123', 'managed-test-swarm', 'managed-test-external',
          'managed-test', 'managed-test-unit', 'managed test', 'pending', 'managed-test-run'
        )
      `);
      expect(workItem.status, workItem.stderr).toBe(0);
      const routed = fixtureRoleCommand(fixture, 'oshal_bot', BOT_PASSWORD, `
        UPDATE work_items
           SET status = 'routing_failed', updated_at = NOW()
         WHERE work_item_id = '00000000-0000-0000-0000-000000000123'
         RETURNING status || '|' || run_id
      `);
      expect(routed.status, routed.stderr).toBe(0);
      expect(routed.stdout.trim()).toBe('routing_failed|managed-test-run');

      const sentinel = fixtureRoleCommand(fixture, 'oshal_app', APP_PASSWORD, `
        CREATE TABLE sales_acl_sentinel(id integer);
        GRANT SELECT, INSERT, UPDATE, DELETE ON sales_acl_sentinel TO PUBLIC, oshal_bot;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC
      `);
      expect(sentinel.status, sentinel.stderr).toBe(0);

      const forbiddenAdminRegrant = docker([
        'exec', '-e', `PGPASSWORD=${BOOTSTRAP_PASSWORD}`, fixture.container,
        'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'doadmin', '-d', 'oshal',
        '-c', 'GRANT oshal_app TO CURRENT_USER WITH ADMIN TRUE, SET TRUE, INHERIT TRUE',
      ]);
      expect(forbiddenAdminRegrant.status).toBe(1);
      expect(forbiddenAdminRegrant.stderr).toContain('ADMIN option cannot be granted back to your own grantor');

      const second = runWholeBootstrap(fixture);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('migrations applied: 0');
      expect(second.stdout).toContain('"appRole":"oshal_app"');
      expect(second.stdout).toContain('"botRole":"oshal_bot"');
      expect(fixtureQuery(fixture, `
        SELECT has_table_privilege('oshal_bot', 'public.sales_acl_sentinel', 'SELECT')
            OR has_table_privilege('oshal_bot', 'public.sales_acl_sentinel', 'INSERT')
            OR has_table_privilege('oshal_bot', 'public.sales_acl_sentinel', 'UPDATE')
            OR has_table_privilege('oshal_bot', 'public.sales_acl_sentinel', 'DELETE')
      `)).toBe('f');
      expect(fixtureQuery(fixture, `
        SELECT has_database_privilege('oshal_app', 'oshal', 'CONNECT') || ':' ||
               has_database_privilege('oshal_app', 'oshal', 'TEMPORARY') || ':' ||
               has_database_privilege('oshal_bot', 'oshal', 'CONNECT') || ':' ||
               has_database_privilege('oshal_bot', 'oshal', 'TEMPORARY')
      `)).toBe('true:true:true:false');

      const membership = fixtureQuery(fixture, `
        SELECT string_agg(
          effective.granted_role || ':' || effective.admin_option || ':' || effective.inherit_option || ':' || effective.set_option,
          ',' ORDER BY effective.granted_role
        )
          FROM (
            SELECT granted.rolname AS granted_role,
                   bool_or(m.admin_option) AS admin_option,
                   bool_or(m.inherit_option) AS inherit_option,
                   bool_or(m.set_option) AS set_option
              FROM pg_auth_members m
              JOIN pg_roles granted ON granted.oid = m.roleid
              JOIN pg_roles member ON member.oid = m.member
             WHERE member.rolname = 'doadmin'
               AND granted.rolname IN ('oshal_app', 'oshal_bot')
             GROUP BY granted.rolname
          ) effective
      `);
      expect(membership).toBe('oshal_app:true:true:true,oshal_bot:true:false:false');
      expect(fixtureQuery(fixture, `
        SELECT string_agg(rolname || ':' || rolconnlimit, ',' ORDER BY rolname)
          FROM pg_roles WHERE rolname IN ('oshal_app', 'oshal_bot')
      `)).toBe('oshal_app:24,oshal_bot:8');
    } finally {
      stopPg18Fixture(fixture);
    }
  }, 240_000);

  it('retries safely after a partial chain fails with only a valid helper subset', () => {
    const fixture = startPg18Fixture('retry');
    const sleeper = `${fixture.container}-bot-session`;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-pg18-partial-'));
    const partialMigrations = path.join(tempRoot, 'migrations');
    fs.cpSync(path.resolve(root, 'scripts/migrations'), partialMigrations, { recursive: true });
    fs.writeFileSync(
      path.join(partialMigrations, '099z-injected-managed-bootstrap-failure.sql'),
      `DO $$ BEGIN RAISE EXCEPTION 'injected managed bootstrap retry proof'; END $$;\n`,
      { mode: 0o600 },
    );
    try {
      const createBot = fixtureRoleCommand(fixture, 'doadmin', BOOTSTRAP_PASSWORD, `
        CREATE ROLE oshal_bot LOGIN PASSWORD '${BOT_PASSWORD}' NOINHERIT
      `);
      expect(createBot.status, createBot.stderr).toBe(0);
      const sleeping = docker([
        'run', '-d', '--name', sleeper, '--network', fixture.network,
        '--entrypoint', 'psql', '-e', `PGPASSWORD=${BOT_PASSWORD}`,
        PG18_VECTOR_IMAGE, '-h', 'oshal-db', '-U', 'oshal_bot', '-d', 'oshal',
        '-c', 'SELECT pg_sleep(300)',
      ]);
      expect(sleeping.status, sleeping.stderr).toBe(0);
      let botSessionReady = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (fixtureQuery(fixture, `SELECT count(*) FROM pg_stat_activity WHERE usename = 'oshal_bot'`) === '1') {
          botSessionReady = true;
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      expect(botSessionReady).toBe(true);

      const failed = runWholeBootstrap(fixture, partialMigrations);
      expect(failed.status).toBe(1);
      expect(`${failed.stdout}\n${failed.stderr}`).toContain('injected managed bootstrap retry proof');
      expect(fixtureQuery(fixture, `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'oshal_bot'`)).toBe('f');
      expect(fixtureQuery(fixture, `SELECT count(*) FROM pg_stat_activity WHERE usename = 'oshal_bot'`)).toBe('0');
      const deniedBotLogin = fixtureTcpRoleCommand(fixture, 'oshal_bot', BOT_PASSWORD, 'SELECT 1');
      expect(deniedBotLogin.status).not.toBe(0);
      expect(deniedBotLogin.stderr).toContain('role "oshal_bot" is not permitted to log in');
      expect(fixtureQuery(fixture, `
        SELECT count(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('oshal_is_tenant_member', 'oshal_owns_task', 'oshal_owns_ticket')
      `)).toBe('2');
      expect(fixtureQuery(fixture, `
        SELECT count(*) FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_roles r ON r.oid = c.relowner
         WHERE n.nspname = 'public' AND r.rolname = 'oshal_app'
      `)).toBe('0');

      const evil = fixtureRoleCommand(fixture, 'doadmin', BOOTSTRAP_PASSWORD, `
        CREATE FUNCTION public.evil() RETURNS boolean
          LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
          AS 'SELECT true'
      `);
      expect(evil.status, evil.stderr).toBe(0);
      const rejected = runWholeBootstrap(fixture);
      expect(rejected.status).toBe(1);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain('unexpected SECURITY DEFINER helper: evil()');
      const dropEvil = fixtureRoleCommand(fixture, 'doadmin', BOOTSTRAP_PASSWORD, 'DROP FUNCTION public.evil()');
      expect(dropEvil.status, dropEvil.stderr).toBe(0);

      const retried = runWholeBootstrap(fixture);
      expect(retried.status, retried.stderr).toBe(0);
      expect(retried.stdout).toContain('"initialized":true');
      expect(fixtureQuery(fixture, `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'oshal_bot'`)).toBe('t');
      const restoredBotLogin = fixtureTcpRoleCommand(fixture, 'oshal_bot', BOT_PASSWORD, 'SELECT current_user');
      expect(restoredBotLogin.status, restoredBotLogin.stderr).toBe(0);
      expect(restoredBotLogin.stdout.trim()).toBe('oshal_bot');
      const expectedMigrations = fs.readdirSync(path.resolve(root, 'scripts/migrations'))
        .filter((filename) => filename.endsWith('.sql')).length;
      expect(fixtureQuery(fixture, 'SELECT count(*) FROM app_migrations')).toBe(String(expectedMigrations));
      expect(fixtureQuery(fixture, `
        SELECT count(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('oshal_is_tenant_member', 'oshal_owns_task', 'oshal_owns_ticket')
      `)).toBe('3');
    } finally {
      docker(['rm', '-f', sleeper], { timeout: 30_000 });
      fs.rmSync(tempRoot, { recursive: true, force: true });
      stopPg18Fixture(fixture);
    }
  }, 240_000);
});
