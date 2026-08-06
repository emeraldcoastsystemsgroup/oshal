/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove SEC-01 hash-only workload credentials, overlap rotation, forced broker RLS, immutable grants, signed user identity, revocation, binding, scope, expiry, and atomic replay behavior through real PostgreSQL and HTTP boundaries.
 */

/**
 * SEC-01 durable workload-delegation boundary proof.
 *
 * In-memory stores cover deterministic branches but cannot prove migration 119, FORCE RLS,
 * row locking, or a real PostgreSQL transaction. This fixture installs the migration in a
 * disposable schema, executes the production store as a NOSUPERUSER/NOBYPASSRLS role, and
 * drives the production Express middleware over HTTP. Missing PostgreSQL is a failure, not a skip.
 */

import { expect, test } from '@playwright/test';
import express, { type RequestHandler } from 'express';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool, type QueryResultRow } from 'pg';

import {
  createWorkloadDelegationMiddleware,
  generateWorkloadCredential,
  getVerifiedWorkloadDelegation,
  hashWorkloadCredential,
  PostgresWorkloadDelegationStore,
  WorkloadDelegationIssuerService,
} from '@/features/security';
import { createDelegationRouteTokenVerifier } from '@/shared/security/delegation-token';
import { getRequestIdentity } from '@/shared/services/database/request-identity';

const ADMIN_URL = process.env.OSHAL_RLS_ADMIN_DATABASE_URL
  ?? process.env.BOOTSTRAP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? '';
const RUNTIME_URL = process.env.OSHAL_WORKLOAD_DELEGATION_DATABASE_URL ?? '';
const BOT_URL = process.env.BOT_DATABASE_URL ?? '';
const RUNTIME_ROLE = process.env.OSHAL_WORKLOAD_DELEGATION_TEST_ROLE || 'oshal_app';
const BOT_ROLE = process.env.OSHAL_RLS_TEST_ROLE || 'oshal_bot';
const RUN = randomBytes(6).toString('hex');
const SCHEMA = `oshal_delegation_${RUN}`;
const WORKLOAD_ID = `sec01-node-${RUN}`;
const OWNER_SUB = `SEC01-Owner-${RUN}`;
const VICTIM_SUB = `SEC01-Victim-${RUN}`;
const PRINCIPAL_ISSUER = 'https://identity.example.test/';
const OLD_CREDENTIAL = generateWorkloadCredential();
const NEXT_CREDENTIAL = generateWorkloadCredential();
const BODY = Object.freeze({ aql: 'RETURN @value', bindVars: { value: RUN } });

let adminPool: Pool;
let runtimePool: Pool;
let botPool: Pool;
let store: PostgresWorkloadDelegationStore;
let issuer: WorkloadDelegationIssuerService;
let server: Server;
let baseUrl: string;

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(value)) throw new TypeError('unsafe PostgreSQL identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

async function authorityRows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await client.query("SELECT set_config('oshal.workload_delegation_broker', 'on', true)");
    const result = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function installDisposableAuthority(): Promise<void> {
  const migration = readFileSync('scripts/migrations/119-workload-delegation-authority.sql', 'utf8');
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${quotedIdentifier(SCHEMA)}`);
    await client.query(`SET LOCAL search_path TO ${quotedIdentifier(SCHEMA)}, public`);
    await client.query(migration);
    await client.query(`GRANT USAGE ON SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(RUNTIME_ROLE)}`);
    await client.query(`GRANT USAGE ON SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(BOT_ROLE)}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotedIdentifier(SCHEMA)} TO ${quotedIdentifier(RUNTIME_ROLE)}`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function connectRuntimeAndBotRoles(): Promise<void> {
  const runtimeRoleOption = RUNTIME_URL ? '' : `-c role=${RUNTIME_ROLE} `;
  runtimePool = new Pool({
    connectionString: RUNTIME_URL || ADMIN_URL,
    options: `${runtimeRoleOption}-c search_path=${SCHEMA},public`,
  });
  const identity = await runtimePool.query<{ current_user: string }>('SELECT current_user');
  expect(identity.rows[0].current_user).toBe(RUNTIME_ROLE);
  const botRoleOption = BOT_URL ? '' : `-c role=${BOT_ROLE} `;
  botPool = new Pool({
    connectionString: BOT_URL || ADMIN_URL,
    options: `${botRoleOption}-c search_path=${SCHEMA},public`,
  });
  const botIdentity = await botPool.query<{ current_user: string }>('SELECT current_user');
  expect(botIdentity.rows[0].current_user).toBe(BOT_ROLE);
  store = new PostgresWorkloadDelegationStore(runtimePool);
}

function createSigningEnvironment(): {
  issuerEnv: Record<string, string>;
  publicKeys: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const kid = `sec01-${RUN}`;
  return {
    issuerEnv: {
      OSHAL_DELEGATION_SIGNING_KID: kid,
      OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
      OSHAL_WORKLOAD_DELEGATION_AUDIENCE: 'urn:oshal:api',
      OSHAL_WORKLOAD_DELEGATION_TTL_SECONDS: '900',
    },
    publicKeys: JSON.stringify({ [kid]: publicKey.export({ format: 'jwk' }) }),
  };
}

async function startDelegatedRoute(): Promise<void> {
  const signing = createSigningEnvironment();
  issuer = new WorkloadDelegationIssuerService(store, { env: signing.issuerEnv });
  const fallback: RequestHandler = (_req, res) => {
    res.status(401).json({ error: 'ordinary_auth_required' });
  };
  const auth = createWorkloadDelegationMiddleware({
    store,
    fallback,
    env: {
      OSHAL_WORKLOAD_DELEGATION_MODE: 'enforce',
      OSHAL_WORKLOAD_DELEGATION_AUDIENCE: 'urn:oshal:api',
    },
    verifier: createDelegationRouteTokenVerifier({
      env: { OSHAL_DELEGATION_PUBLIC_KEYS: signing.publicKeys },
    }),
  });
  const app = express();
  app.use(express.json());
  app.post('/api/graph/query', auth, (req, res) => res.json({
    identity: getRequestIdentity(),
    delegation: getVerifiedWorkloadDelegation(req),
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function issueGraphToken(label: string) {
  return issuer.issue({
    workloadId: WORKLOAD_ID,
    userSub: OWNER_SUB,
    principalIssuer: PRINCIPAL_ISSUER,
    ticketId: `ticket-${label}-${RUN}`,
    method: 'POST',
    path: '/api/graph/query',
    body: BODY,
    dispatchExpiresAt: new Date(Date.now() + 20 * 60_000),
  });
}

async function callGraph(token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/graph/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-oshal-user-sub': VICTIM_SUB,
    },
    body: JSON.stringify(BODY),
  });
}

async function setWorkloadState(status: 'active' | 'suspended'): Promise<void> {
  await authorityRows(
    'UPDATE oshal_workload_identities SET status=$2, updated_at=NOW() WHERE workload_id=$1',
    [WORKLOAD_ID, status],
  );
}

async function closeServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    ADMIN_URL,
    'DATABASE_URL (or OSHAL_RLS_ADMIN_DATABASE_URL) is required for the SEC-01 PostgreSQL proof.',
  ).not.toBe('');
  quotedIdentifier(RUNTIME_ROLE);
  quotedIdentifier(BOT_ROLE);
  adminPool = new Pool({ connectionString: ADMIN_URL });
  const roles = await adminPool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',
    [[RUNTIME_ROLE, BOT_ROLE]],
  );
  expect(roles.rows).toHaveLength(2);
  expect(roles.rows.every((role) => !role.rolsuper && !role.rolbypassrls)).toBe(true);
  await installDisposableAuthority();
  await connectRuntimeAndBotRoles();
  await store.registerWorkload({
    workloadId: WORKLOAD_ID,
    workloadKind: 'node',
    credential: OLD_CREDENTIAL.credential,
    keyId: OLD_CREDENTIAL.keyId,
    allowedScopes: ['graph:read', 'graph:write', 'jarvis:read'],
  });
  await startDelegatedRoute();
});

test.afterAll(async () => {
  await closeServer().catch(() => undefined);
  await runtimePool?.end().catch(() => undefined);
  await botPool?.end().catch(() => undefined);
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(SCHEMA)} CASCADE`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
  }
});

test('stores only a credential hash and hides both authority tables without the broker marker', async () => {
  const rows = await authorityRows<{ credential_hash: string; current_key_id: string }>(
    'SELECT credential_hash, current_key_id FROM oshal_workload_identities WHERE workload_id=$1',
    [WORKLOAD_ID],
  );
  expect(rows).toEqual([{
    credential_hash: hashWorkloadCredential(OLD_CREDENTIAL.credential),
    current_key_id: OLD_CREDENTIAL.keyId,
  }]);
  expect(JSON.stringify(rows)).not.toContain(OLD_CREDENTIAL.credential);
  await expect(runtimePool.query('SELECT * FROM oshal_workload_identities')).resolves.toMatchObject({ rows: [] });
  await expect(runtimePool.query('SELECT * FROM oshal_user_delegations')).resolves.toMatchObject({ rows: [] });
  const botClient = await botPool.connect();
  try {
    await botClient.query("SELECT set_config('oshal.workload_delegation_broker', 'on', false)");
    await expect(botClient.query('SELECT * FROM oshal_user_delegations')).rejects.toThrow(/permission denied/i);
  } finally {
    botClient.release();
  }
  await expect(runtimePool.query(
    `INSERT INTO oshal_workload_identities
       (workload_id, workload_kind, credential_hash, allowed_scopes, current_key_id)
     VALUES ('raw-attacker', 'node', $1, ARRAY['graph:read'], 'raw-key')`,
    ['a'.repeat(64)],
  )).rejects.toThrow(/row-level security/i);
});

test('authenticates exact scopes and honors one bounded overlapping credential rotation', async () => {
  await expect(store.authenticateWorkloadCredential({
    workloadId: WORKLOAD_ID, keyId: OLD_CREDENTIAL.keyId,
    credential: OLD_CREDENTIAL.credential, requiredScopes: ['graph:read'],
  })).resolves.toBe(true);
  await expect(store.authenticateWorkloadCredential({
    workloadId: WORKLOAD_ID, keyId: OLD_CREDENTIAL.keyId,
    credential: NEXT_CREDENTIAL.credential, requiredScopes: ['graph:read'],
  })).resolves.toBe(false);
  const rotatedAt = new Date();
  const previousValidUntil = new Date(rotatedAt.getTime() + 60_000);
  await expect(store.rotateWorkloadCredential({
    workloadId: WORKLOAD_ID, expectedCurrentKeyId: OLD_CREDENTIAL.keyId,
    nextCredential: NEXT_CREDENTIAL.credential, nextKeyId: NEXT_CREDENTIAL.keyId,
    rotatedAt, previousValidUntil,
  })).resolves.toBe(true);
  await expect(store.authenticateWorkloadCredential({
    workloadId: WORKLOAD_ID, keyId: OLD_CREDENTIAL.keyId,
    credential: OLD_CREDENTIAL.credential, requiredScopes: ['graph:read'],
    at: new Date(rotatedAt.getTime() + 30_000),
  })).resolves.toBe(true);
  await expect(store.authenticateWorkloadCredential({
    workloadId: WORKLOAD_ID, keyId: OLD_CREDENTIAL.keyId,
    credential: OLD_CREDENTIAL.credential, requiredScopes: ['graph:read'],
    at: new Date(previousValidUntil.getTime() + 1),
  })).resolves.toBe(false);
});

test('derives the HTTP database identity only from signed claims and consumes atomically', async () => {
  const receipt = await issueGraphToken('atomic');
  await expect(authorityRows(
    'UPDATE oshal_user_delegations SET user_sub=$2 WHERE jti=$1',
    [receipt.claims.jti, VICTIM_SUB],
  )).rejects.toThrow(/immutable delegation binding/i);
  const responses = await Promise.all([callGraph(receipt.token), callGraph(receipt.token)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const accepted = responses.find((response) => response.status === 200);
  expect(accepted).toBeDefined();
  const body = await accepted!.json() as {
    identity: { sub: string; principalIssuer: string; isOperator: boolean };
    delegation: { sub: string; azp: string };
  };
  expect(body.identity).toEqual({
    sub: OWNER_SUB, principalIssuer: PRINCIPAL_ISSUER, isOperator: false,
  });
  expect(body.delegation).toMatchObject({ sub: OWNER_SUB, azp: WORKLOAD_ID });
  expect(body.identity.sub).not.toBe(VICTIM_SUB);
});

test('enforces revocation, durable workload binding, expiry, lifecycle, and current scopes', async () => {
  const revoked = await issueGraphToken('revoked');
  await expect(store.revokeDelegation(revoked.claims.jti)).resolves.toBe(true);
  expect((await callGraph(revoked.token)).status).toBe(401);

  const binding = await issueGraphToken('binding');
  await expect(store.consumeDelegation({ ...binding.claims, azp: `attacker-${RUN}` }))
    .resolves.toBe('binding_mismatch');
  await expect(store.consumeDelegation(binding.claims)).resolves.toBe('authorized');

  const expired = await issueGraphToken('expired');
  await expect(store.consumeDelegation(expired.claims, new Date(expired.claims.exp * 1_000)))
    .resolves.toBe('expired');

  const suspended = await issueGraphToken('suspended');
  await setWorkloadState('suspended');
  await expect(store.consumeDelegation(suspended.claims)).resolves.toBe('not_active');
  await setWorkloadState('active');

  const narrowed = await issueGraphToken('narrowed');
  await authorityRows(
    "UPDATE oshal_workload_identities SET allowed_scopes=ARRAY['jarvis:read'] WHERE workload_id=$1",
    [WORKLOAD_ID],
  );
  await expect(store.consumeDelegation(narrowed.claims)).resolves.toBe('insufficient_scope');
});
