/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The missing route-chain guard for the ADR-148 403 path (docs/architecture/swarm-administration.md, open thread 3). The shipped guards cover the role STORE and isOperatorIdentity in isolation; the 401 and 200 paths were only ever verified by hand on a box, and the SIGNED-IN NON-OPERATOR 403 — the outcome the whole gate exists to produce — had no automated coverage at all. This mounts the real /api/swarm/roles and /api/swarm/registries routers behind the real deployment auth middleware set against a disposable PostgreSQL carrying the real swarm_roles schema, and asserts all three outcomes on the RESPONSE BODY rather than the status code: on the live box every unauthenticated /api/* path answers an identical 401, so a status-only assertion proves the global guard and never that the mount exists or the router ran.
 */

/**
 * THE ROUTE CHAIN — anonymous, signed-in non-operator, and swarm_roles admin.
 *
 * THE BOUNDARY THIS CROSSES, because the claim is about a chain and not a function:
 *   real auth middleware set (createApplicationAuthMiddlewareSet -> the LOCAL_AUTH set)
 *     -> real session cookie minted by the real POST /api/local-auth/login
 *       -> real requiresAuth from that same set (never a hand-rolled stand-in)
 *         -> real requiresOperator -> real isOperatorIdentity
 *           -> real privileged-identity snapshot loaded from a real swarm_roles table
 *             -> the real routers from src/app/routes.
 *
 * Nothing in that list is doubled. The only doubled collaborator is SwarmAppService.loadApp,
 * which sits OUTSIDE the boundary (it installs a package; no assertion here reaches it) and
 * throws if anything ever calls it.
 *
 * WHY THE BODY AND NOT THE STATUS. A 401 on this platform is produced by the global guard for
 * every /api/* path including paths that do not exist, so it says nothing about this mount. Each
 * outcome is therefore discriminated by the shape only its own layer emits — the LOCAL_AUTH
 * guard's {authenticated,error,loginPath}, requiresOperator's {error:'Operator privilege
 * required'}, and each router's own payload — and the 403 case additionally proves the SAME
 * cookie reaches 200 on the requiresAuth-only sibling route, so the refusal is the operator gate
 * and not a failed sign-in.
 *
 * WHY THE ROLE ROW IS THE AUTHORITY HERE. Both break-glass allowlists are stubbed EMPTY, so the
 * only path to operator is a swarm_roles row; the same account is asserted 403 before the grant
 * and 200 after it, and 403 again after the revoke.
 *
 * @module tests/unit/swarm-admin-route-chain-authorization
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApplicationAuthMiddlewareSet } from '@/app/middleware/application-auth';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';
import { createSwarmRolesRoutes } from '@/app/routes/swarm-roles-routes';
import { createAppRegistryRoutes, initializeAppRegistries } from '@/app/routes/app-registry-routes';
import { acceptInvite, ensureLocalUserSchema, ensureTotpSchema, upsertInvite } from '@/features/local-auth';
import { claimRoot, ensureSwarmRoleSchema, refreshPrivilegedCache } from '@/features/swarm-roles';
import { clearPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

/** Every value below is fixture data. None of it is read from, or written to, a deployment. */
const FIXTURE_PLACEHOLDER_PASSWORD = 'route-chain-guard-placeholder-password';
const FIXTURE_STORE_REPO = 'https://github.com/oshal-fixture/route-chain-guard-store';
const FIXTURE_PLACEHOLDER_SESSION_SECRET = 'route-chain-guard-placeholder-session-secret';
const CONTAINER = `oshal-route-chain-fixture-${randomUUID().slice(0, 8)}`;
const ACCOUNTS = {
  root: 'root@example.test',
  adminElect: 'admin-elect@example.test',
  member: 'member@example.test',
} as const;

/** The LOCAL_AUTH guard's own refusal body — no other layer in this chain emits it. */
const AUTH_REFUSAL = { authenticated: false, error: 'unauthorized', loginPath: '/login' };
/** requiresOperator's own refusal body — emitted only after requiresAuth has already passed. */
const OPERATOR_REFUSAL = { error: 'Operator privilege required' };

let pool: Pool;
let server: http.Server;
let base: string;
let containerStarted = false;
const subs: Record<keyof typeof ACCOUNTS, string> = { root: '', adminElect: '', member: '' };

/** Fixed docker argv; a generated fixture password is the only variable, and is never echoed. */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

/**
 * Starts this spec's OWN PostgreSQL. No deployment DSN is ever consulted: the 403 path is about
 * which rows exist in swarm_roles, and a shared database would make the assertions depend on
 * whatever a real swarm happens to hold.
 */
async function startPostgres(): Promise<Pool> {
  const password = randomUUID();
  docker(['run', '--detach', '--rm', '--name', CONTAINER,
    '--label', 'oshal.test-fixture=swarm-admin-route-chain', '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data', '--memory', '256m', '--cpus', '1',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=route_chain_fixture',
    'postgres:16-alpine']);
  containerStarted = true;
  const published = docker(['port', CONTAINER, '5432/tcp'])
    .split('\n').map((line) => line.trim()).find((line) => /^127\.0\.0\.1:\d+$/.test(line));
  if (!published) throw new Error('the route-chain fixture PostgreSQL must publish one loopback port');
  const created = new Pool({
    host: '127.0.0.1', port: Number(published.split(':')[1]), user: 'postgres', password,
    database: 'route_chain_fixture', max: 8, connectionTimeoutMillis: 500, statement_timeout: 15_000,
  });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try { await created.query('SELECT 1'); return created; }
    catch { await new Promise((done) => setTimeout(done, 200)); }
  }
  throw new Error('the route-chain fixture PostgreSQL did not become ready');
}

/**
 * Pins the auth mode and empties BOTH break-glass allowlists, so the ONLY thing that can make a
 * caller an operator in this spec is a swarm_roles row.
 */
function stubDeploymentEnvironment(): void {
  vi.stubEnv('LOCAL_AUTH', 'true');
  vi.stubEnv('MOCK_OIDC', '');
  vi.stubEnv('ENTRA_LOCAL_AUTH_HYBRID', '');
  vi.stubEnv('ENTRA_LOCAL_IDENTITY_BRIDGE', '');
  vi.stubEnv('SESSION_SECRET', FIXTURE_PLACEHOLDER_SESSION_SECRET);
  vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
  vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'self-heal');
  vi.stubEnv('OSHAL_STORE_REPO', FIXTURE_STORE_REPO);
}

/** Invites and activates the three fixture accounts through the real local-user store. */
async function seedAccounts(): Promise<void> {
  for (const name of Object.keys(ACCOUNTS) as (keyof typeof ACCOUNTS)[]) {
    const invite = await upsertInvite(pool, { email: ACCOUNTS[name] });
    const user = await acceptInvite(pool, invite.token, FIXTURE_PLACEHOLDER_PASSWORD);
    if (!user) throw new Error(`fixture account ${name} could not be activated`);
    subs[name] = user.userSub;
  }
}

/** The REAL routers behind the REAL deployment auth set — the chain under test. */
function mountRealRoutes(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const auth = createApplicationAuthMiddlewareSet(pool);
  app.use(auth.authMiddleware);
  app.use(createLocalAuthRoutes(pool));
  app.use('/api/swarm/roles', createSwarmRolesRoutes(pool, auth.requiresAuth));
  app.use('/api/swarm/registries', createAppRegistryRoutes(pool, auth.requiresAuth, {
    // Outside the boundary: installing a package is not what this guard is about, and a call
    // to it would be a defect in the spec rather than a pass.
    loadApp: async () => { throw new Error('the route-chain guard never installs a package'); },
  }));
  return app;
}

/** One HTTP call through the whole chain; the body is what every assertion reads. */
async function call(path: string, cookie?: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(base + path, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* a non-JSON body is itself evidence; keep it raw */ }
  return { status: response.status, body };
}

/** Signs in through the REAL login route and returns the REAL session cookie it minted. */
async function signIn(email: string): Promise<string> {
  const response = await fetch(`${base}/api/local-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, password: FIXTURE_PLACEHOLDER_PASSWORD }),
  });
  const payload = await response.json() as { ok?: boolean };
  const raw = response.headers.get('set-cookie') ?? '';
  const cookie = raw.split(';')[0];
  if (response.status !== 200 || payload.ok !== true || !cookie) {
    throw new Error(`fixture sign-in failed for ${email} (status ${response.status})`);
  }
  return cookie;
}

beforeAll(async () => {
  stubDeploymentEnvironment();
  pool = await startPostgres();
  await ensureLocalUserSchema(pool);
  await ensureTotpSchema(pool);
  await ensureSwarmRoleSchema(pool);
  await initializeAppRegistries(pool);
  await seedAccounts();
  clearPrivilegedIdentities();
  // Deliberately loaded from an EMPTY swarm_roles: the starting state is a swarm with no
  // operators at all, which is what makes the later grant observable.
  expect(await refreshPrivilegedCache(pool)).toBe(0);
  server = http.createServer(mountRealRoutes());
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  await pool?.end();
  if (containerStarted) docker(['rm', '--force', CONTAINER]);
  clearPrivilegedIdentities();
  vi.unstubAllEnvs();
}, 60_000);

describe('the /api/swarm administration route chain refuses and admits on the identity it actually resolves', () => {
  it('refuses an ANONYMOUS caller at the auth middleware, with the guard body and not a bare status', async () => {
    for (const path of ['/api/swarm/roles', '/api/swarm/registries']) {
      const response = await call(path);
      expect(response.status, path).toBe(401);
      // The LOCAL_AUTH guard's own shape. A status-only assertion would pass against any
      // blanket 401, which is exactly the trap this guard exists to avoid.
      expect(response.body, path).toEqual(AUTH_REFUSAL);
    }
    // And the 401 is the MOUNT's, not a catch-all: an unmounted /api path 404s on this server,
    // so the two refusals above were produced by the chain under test.
    expect((await call('/api/totally/unknown/path')).status).toBe(404);
  });

  it('refuses a SIGNED-IN NON-OPERATOR with 403 from the operator gate — the path nothing covered', async () => {
    const cookie = await signIn(ACCOUNTS.member);

    // Proof the caller really is signed in: the SAME cookie reaches 200 on the sibling route
    // that is requiresAuth-only, and the router reports the caller's own resolved identity.
    const me = await call('/api/swarm/roles/me', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ sub: subs.member, role: 'user', isOperator: false, breakGlassOnly: false });

    for (const path of ['/api/swarm/roles', '/api/swarm/registries']) {
      const response = await call(path, cookie);
      expect(response.status, path).toBe(403);
      // requiresOperator's own body — reachable ONLY after requiresAuth already passed.
      expect(response.body, path).toEqual(OPERATOR_REFUSAL);
    }
  });

  it('admits an admin granted through a swarm_roles ROW, and the row is the only thing that changed', async () => {
    const adminCookie = await signIn(ACCOUNTS.adminElect);
    // Same caller, same cookie, before the grant: refused.
    expect(await call('/api/swarm/roles', adminCookie)).toMatchObject({ status: 403, body: OPERATOR_REFUSAL });

    // Bootstrap root in the store (POST /claim-root requires an EXISTING operator, which a
    // swarm with zero roles has by construction), then grant through the REAL route as root.
    await claimRoot(pool, { userSub: subs.root, email: ACCOUNTS.root, note: 'route-chain fixture bootstrap' });
    await refreshPrivilegedCache(pool);
    const rootCookie = await signIn(ACCOUNTS.root);
    const granted = await call('/api/swarm/roles', rootCookie, {
      method: 'POST',
      body: JSON.stringify({ userSub: subs.adminElect, email: ACCOUNTS.adminElect, role: 'admin' }),
    });
    expect(granted).toMatchObject({ status: 201, body: { role: { userSub: subs.adminElect, role: 'admin' } } });

    const roles = await call('/api/swarm/roles', adminCookie);
    expect(roles.status).toBe(200);
    // The roles router's own payload — a status alone could not tell this from any other 200.
    expect((roles.body as { roles: { userSub: string; role: string }[] }).roles)
      .toContainEqual(expect.objectContaining({ userSub: subs.adminElect, role: 'admin' }));

    const registries = await call('/api/swarm/registries', adminCookie);
    expect(registries.status).toBe(200);
    // The registry router's own payload, carrying the built-in row seeded from the FIXTURE store.
    expect((registries.body as { registries: { slug: string; url: string }[] }).registries)
      .toContainEqual(expect.objectContaining({ slug: 'oshal-store', url: FIXTURE_STORE_REPO }));

    // The privilege came from the ROW, not from an allowlist: both are empty, and the router
    // reports the caller as an operator whose status is not break-glass.
    expect(process.env.OSHAL_OPERATOR_SUBS).toBe('');
    expect(process.env.OSHAL_OPERATOR_EMAILS).toBe('');
    expect((await call('/api/swarm/roles/me', adminCookie)).body)
      .toMatchObject({ sub: subs.adminElect, role: 'admin', isOperator: true, breakGlassOnly: false });
  });

  it('returns a REVOKED admin to 403 on the very next request, with no restart and the same cookie', async () => {
    const adminCookie = await signIn(ACCOUNTS.adminElect);
    expect((await call('/api/swarm/roles', adminCookie)).status).toBe(200);

    const rootCookie = await signIn(ACCOUNTS.root);
    const revoked = await call(`/api/swarm/roles/${encodeURIComponent(subs.adminElect)}`, rootCookie, { method: 'DELETE' });
    expect(revoked).toMatchObject({ status: 200, body: { removed: true } });

    expect(await call('/api/swarm/roles', adminCookie)).toMatchObject({ status: 403, body: OPERATOR_REFUSAL });
    expect(await call('/api/swarm/registries', adminCookie)).toMatchObject({ status: 403, body: OPERATOR_REFUSAL });
  });
});
