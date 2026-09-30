/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify a host-owned, isolated PostgreSQL lease before fixture initialization; fixed readonly contract, first-read server identity, fresh database and one-use claim. Never accept a deployment DSN or perform server cleanup.
 */
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { Client } from 'pg';

const CONTRACT = '/contract/access.json';
const MAX_BYTES = 8192;
const KEYS = ['protocol', 'runId', 'containerId', 'network', 'purpose', 'spec', 'database', 'requestedImage',
  'imageId', 'host', 'port', 'user', 'password', 'nonce', 'expiresAt'].sort();
const fail = (code: string): never => { throw new Error('Owned PostgreSQL refused: ' + code); };
type Contract = {
  protocol: 'owned-postgres-v1'; runId: string; containerId: string; network: string;
  purpose: string; spec: string; database: string; requestedImage: string; imageId: string;
  host: 'fixture-pg'; port: 5432; user: 'postgres'; password: string; nonce: string; expiresAt: number;
};

/** Exact fixture request; it grants no endpoint-selection authority. */
export interface OwnedPostgresRequest { purpose: string; database: string; requestedImage: string }
/** Host cleanup owns the server; release only closes the real control connection. */
export interface OwnedPostgresLease {
  connection: { host: 'fixture-pg'; port: 5432; user: 'postgres'; password: string; database: string };
  assertActive(): void;
  release(): Promise<void>;
}

function checkEnvironment(): void {
  if (platform() !== 'linux' || process.env.OSHAL_OWNED_PG_CONTRACT !== CONTRACT) fail('untrusted_environment');
  for (const key of Object.keys(process.env)) {
    if (/^PG[A-Z_]+$|^(?:POSTGRES_|DATABASE_URL$|BOT_DATABASE_URL$)|(?:DATABASE_URL|_DSN)$/.test(key)) {
      fail('inherited_database_configuration');
    }
  }
}

/** Mount options, not a caller boolean, establish the contract's read-only boundary. */
function checkMount(): void {
  const info = readFileSync('/proc/self/mountinfo', 'utf8');
  const mounts = info.split('\n').map(line => line.split(' ')).filter(parts =>
    parts[4] === '/contract' || parts[4] === CONTRACT).sort((a, b) => b[4].length - a[4].length);
  if (!mounts.length || !mounts[0][5].split(',').includes('ro')) fail('contract_not_readonly');
  for (const name of ['/contract', CONTRACT]) if (lstatSync(name).isSymbolicLink()) fail('contract_symlink');
}

/** Read by a no-follow descriptor and never attach raw content/errors as the exception cause. */
function readContract(): unknown {
  checkEnvironment(); checkMount();
  const fd = openSync(CONTRACT, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0) fail('unsafe_contract_file');
    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > MAX_BYTES) fail('oversized_contract');
    return JSON.parse(raw);
  } finally { closeSync(fd); }
}

function validate(value: unknown, expected: OwnedPostgresRequest): Contract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_contract');
  const c = value as Contract;
  if (JSON.stringify(Object.keys(c).sort()) !== JSON.stringify(KEYS)) fail('invalid_contract');
  for (const key of KEYS.filter(k => k !== 'port' && k !== 'expiresAt')) {
    if (typeof (c as unknown as Record<string, unknown>)[key] !== 'string') fail('invalid_contract');
  }
  if (c.protocol !== 'owned-postgres-v1' || c.host !== 'fixture-pg' || c.port !== 5432 || c.user !== 'postgres') fail('invalid_endpoint');
  if (!/^l8-pg-[a-f0-9]{16}$/.test(c.runId) || c.network !== c.runId + '-internal' ||
      !/^[a-f0-9]{64}$/.test(c.containerId) || !/^sha256:[a-f0-9]{64}$/.test(c.imageId)) fail('invalid_identity');
  if (!/^[a-f0-9]{48}$/.test(c.password) || !/^[a-f0-9]{48}$/.test(c.nonce) || c.password === c.nonce) fail('invalid_credential');
  if (c.purpose !== expected.purpose || c.database !== expected.database || c.requestedImage !== expected.requestedImage ||
      !/^[a-z0-9-]+$/.test(c.purpose) || !['oshal_fixture', 'oshal'].includes(c.database) ||
      !['postgres:16-alpine', 'pgvector/pgvector:pg16'].includes(c.requestedImage)) fail('fixture_mismatch');
  if (!/^tests\/unit\/[a-z0-9-]+\.spec\.ts$/.test(c.spec) || c.spec !== process.env.OSHAL_OWNED_PG_SPEC) fail('spec_mismatch');
  if (!Number.isSafeInteger(c.expiresAt) || c.expiresAt <= Date.now() || c.expiresAt > Date.now() + 600_000) fail('invalid_expiry');
  return c;
}

const MARKER_SQL = `SELECT current_database() AS database, current_user AS username,
  current_setting('server_version_num') AS version,
  current_setting('oshal.fixture_run_id', true) AS run_id,
  current_setting('oshal.fixture_nonce', true) AS nonce`;
const FRESH_SQL = `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS claimed,
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')) AS empty_public,
  NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema')
    AND left(nspname,3) <> 'pg_') AS empty_schemas,
  NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname <> 'postgres' AND left(rolname,3) <> 'pg_') AS fresh_roles`;

async function verifyServer(client: Client, c: Contract, active: () => void): Promise<void> {
  const result = await client.query(MARKER_SQL); active();
  const row = result.rows[0];
  if (result.rows.length !== 1 || row.database !== c.database || row.username !== c.user ||
      !/^16\d{4}$/.test(String(row.version)) || row.run_id !== c.runId || row.nonce !== c.nonce) fail('server_identity_mismatch');
  const fresh = await client.query(FRESH_SQL, ['owned-postgres-v1/' + c.runId]); active();
  if (fresh.rows.length !== 1 || !fresh.rows[0].claimed || !fresh.rows[0].empty_public ||
      !fresh.rows[0].empty_schemas || !fresh.rows[0].fresh_roles) fail('server_not_fresh_or_claimed');
  // Exclusive local latch survives release for the lifetime of this runner, with no extra SQL table.
  const fd = openSync('/tmp/owned-postgres-' + c.runId + '.claim', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  closeSync(fd);
}

async function closeClient(client: Client): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.end(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned PostgreSQL refused: close_timeout')), 5_000);
    })]);
  } catch { fail('control_close_failed'); }
  finally { if (timer) clearTimeout(timer); }
}

/** No password, nonce, connection string or server response enters an attestation. */
function attest(c: Contract, released: boolean): void {
  writeFileSync('/receipts/owned-endpoint.json', JSON.stringify({
    protocol: c.protocol, runId: c.runId, containerId: c.containerId, spec: c.spec,
    verifiedFresh: true, claims: 1, released,
  }), { mode: 0o600 });
}

function lease(client: Client, c: Contract, active: () => void, stopTimer: () => void): OwnedPostgresLease {
  let released = false;
  return {
    connection: { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database },
    assertActive: () => { if (released) fail('lease_released'); active(); },
    async release() {
      if (released) return; released = true; stopTimer();
      await closeClient(client);
      try { attest(c, true); } catch { fail('attestation_failed'); }
    },
  };
}

/**
 * @description Claim a verified host-owned endpoint, or null ONLY when transport opt-in is absent.
 * @param expected - Fixture purpose/database/image chosen by the actual spec, never a DSN.
 * @returns A live, single-use lease whose release cannot remove or mutate a database.
 */
export async function claimOwnedPostgres(expected: OwnedPostgresRequest): Promise<OwnedPostgresLease | null> {
  if (process.env.OSHAL_OWNED_PG_CONTRACT === undefined) return null;
  let client: Client | undefined, timer: ReturnType<typeof setTimeout> | undefined, lost = false;
  try {
    const c = validate(readContract(), expected);
    const active = () => { if (lost || Date.now() >= c.expiresAt) fail('lease_expired_or_lost'); };
    client = new Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
      connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 5_000, ssl: false, options: '' });
    client.on('error', () => { lost = true; });
    await client.connect(); active();
    await verifyServer(client, c, active); active();
    attest(c, false);
    const owned = client;
    timer = setTimeout(() => { lost = true; void closeClient(owned).catch(() => undefined); }, c.expiresAt - Date.now());
    timer.unref();
    return lease(client, c, active, () => { if (timer) clearTimeout(timer); });
  } catch {
    if (timer) clearTimeout(timer);
    if (client) await closeClient(client).catch(() => undefined);
    // Raw JSON, pg errors and filesystem errors may contain the password/nonce. Never echo them.
    fail('contract_or_server_verification_failed');
  }
}
