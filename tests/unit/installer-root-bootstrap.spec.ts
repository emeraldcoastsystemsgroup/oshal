/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove installer proof, atomic first root and recovery against disposable PostgreSQL and real Express routes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Include verified principal state in the isolated first-install ceremony schema and resets.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUserSchema, localSubForEmail } from '@/features/local-auth';
import { ensurePrincipalDirectorySchema } from '@/features/principal-directory';
import { ensureSwarmRoleSchema, claimRoot } from '@/features/swarm-roles';
import { clearPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { ensureInstallerRootSchema, issueInstallerRootSetup } from '@/app/composition/installer-root-bootstrap';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';
import { createSwarmRolesRoutes } from '@/app/routes/swarm-roles-routes';

const container = `oshal-root-fixture-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
let started = false; let owner: Pool; let runtime: Pool; let server: http.Server; let base: string; let port: number;
const accountPassword = 'fixture-only-password-12345';
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', randomUUID() + randomUUID());
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', '');
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=root_fixture', 'postgres:16-alpine']);
  started = true; port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  owner = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'root_fixture', connectionTimeoutMillis: 500 });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await owner.query('SELECT 1'); ready = true; break; } catch { await new Promise((done) => setTimeout(done, 200)); }
  }
  if (!ready) throw new Error('Disposable root fixture PostgreSQL unavailable');
  await ensureLocalUserSchema(owner); await ensureSwarmRoleSchema(owner); await ensureInstallerRootSchema(owner); await ensurePrincipalDirectorySchema(owner);
  await owner.query("CREATE ROLE root_runtime LOGIN PASSWORD 'fixture-runtime' NOSUPERUSER NOBYPASSRLS");
  await owner.query('GRANT USAGE ON SCHEMA public TO root_runtime');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO root_runtime');
  runtime = wrapPoolWithGuc(new Pool({ host: '127.0.0.1', port, user: 'root_runtime', password: 'fixture-runtime', database: 'root_fixture' }));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-fixture-user');
    if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
    next();
  });
  app.use(createLocalAuthRoutes(runtime));
  app.use('/api/swarm/roles', createSwarmRolesRoutes(runtime, (req, res, next) => {
    if (!req.get('x-fixture-user')) { res.status(401).json({ error: 'fixture_auth_required' }); return; }
    next();
  }));
  server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 90_000);
beforeEach(async () => {
  clearPrivilegedIdentities(); vi.stubEnv('OSHAL_OPERATOR_SUBS', ''); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  await owner.query('TRUNCATE oshal_local_users, swarm_roles, oshal_installer_root_setup, oshal_verified_principals');
});
afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (runtime) await runtime.end(); if (owner) await owner.end();
  if (started) docker(['rm', '--force', container]);
  clearPrivilegedIdentities(); vi.unstubAllEnvs();
});
async function bootstrap(token: string | undefined, email = 'installer@example.test', origin = base) {
  const response = await fetch(`${base}/api/local-auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password: accountPassword, setupToken: token }) });
  return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() as Record<string, unknown> };
}
async function counts() {
  return (await owner.query(`SELECT (SELECT count(*)::int FROM oshal_local_users) AS users,
    (SELECT count(*)::int FROM swarm_roles WHERE role='root') AS roots`)).rows[0];
}

describe('installer-root proof transaction', () => {
  it('refuses arbitrary public first-account attempts, forged proof and wrong browser origin without side effects', async () => {
    const proof = await issueInstallerRootSetup(runtime, base);
    expect((await bootstrap(undefined)).status).toBe(403);
    expect((await bootstrap(randomUUID())).status).toBe(403);
    expect((await bootstrap(proof.token, 'installer@example.test', 'https://another-origin.test')).status).toBe(403);
    const invalidSameShape = proof.token[0] === 'a' ? 'b' : 'a';
    expect((await bootstrap(invalidSameShape + proof.token.slice(1))).status).toBe(403);
    expect(await counts()).toEqual({ users: 0, roots: 0 });
    expect((await runtime.query('SELECT * FROM oshal_installer_root_setup')).rows).toEqual([]);
  });

  it('commits account, root and consumed proof before session issuance and never reopens after restart/replay', async () => {
    const proof = await issueInstallerRootSetup(runtime, base);
    const stored = (await owner.query('SELECT token_hash,expires_at FROM oshal_installer_root_setup')).rows[0];
    expect(stored.token_hash).toBe(createHash('sha256').update(proof.token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(proof.token);
    const created = await bootstrap(proof.token);
    expect(created.status).toBe(201); expect(created.body.rootClaimed).toBe(true); expect(created.cookie).toContain('oshal_local=');
    expect(await counts()).toEqual({ users: 1, roots: 1 });
    expect((await owner.query('SELECT completed_sub,completed_issuer FROM oshal_installer_root_setup')).rows[0])
      .toEqual({ completed_sub: localSubForEmail('installer@example.test'), completed_issuer: 'urn:oshal:local-auth' });
    const replay = await bootstrap(proof.token, 'second@example.test');
    expect(replay.status).toBe(409); expect(replay.cookie).toBeNull();
    await expect(issueInstallerRootSetup(runtime, base)).rejects.toMatchObject({ status: 409 });
    // Even loss of legacy account/role rows cannot reopen the durable completed installation marker.
    await owner.query('TRUNCATE oshal_local_users, swarm_roles');
    await expect(issueInstallerRootSetup(runtime, base)).rejects.toThrow(/already completed/);
  });

  it('has one winner for simultaneous valid proofs targeting different first accounts', async () => {
    const proof = await issueInstallerRootSetup(runtime, base);
    const attempts = await Promise.all([bootstrap(proof.token, 'first@example.test'), bootstrap(proof.token, 'second@example.test')]);
    expect(attempts.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(attempts.filter((result) => result.cookie)).toHaveLength(1);
    expect(await counts()).toEqual({ users: 1, roots: 1 });
  });

  it('rolls back account and proof when root persistence fails, allowing a valid retry', async () => {
    const proof = await issueInstallerRootSetup(runtime, base);
    await owner.query('REVOKE INSERT ON swarm_roles FROM root_runtime');
    try {
      const failed = await bootstrap(proof.token);
      expect(failed.status).toBe(500); expect(failed.cookie).toBeNull();
      expect(await counts()).toEqual({ users: 0, roots: 0 });
      expect((await owner.query('SELECT completed_at FROM oshal_installer_root_setup')).rows[0].completed_at).toBeNull();
    } finally { await owner.query('GRANT INSERT ON swarm_roles TO root_runtime'); }
    expect((await bootstrap(proof.token)).status).toBe(201);
  });

  it('persists absolute expiry and permits only explicit local reissue', async () => {
    const proof = await issueInstallerRootSetup(runtime, base);
    await owner.query("UPDATE oshal_installer_root_setup SET expires_at=NOW()-INTERVAL '1 second'");
    expect((await bootstrap(proof.token)).status).toBe(410);
    const reissued = await issueInstallerRootSetup(runtime, base);
    expect(reissued.token).not.toBe(proof.token);
    expect((await bootstrap(proof.token)).status).toBe(403);
    expect((await bootstrap(reissued.token)).status).toBe(201);
  });
});

describe('operator recovery and local installer helper', () => {
  it('does not elect an arbitrary signed-in first visitor, while existing exact operator recovery remains available', async () => {
    const claim = (sub: string) => fetch(`${base}/api/swarm/roles/claim-root`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-user': sub }, body: '{}' });
    expect((await claim('public-visitor')).status).toBe(403);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'trusted-recovery');
    expect((await claim('trusted-recovery')).status).toBe(201);
    expect((await owner.query("SELECT user_sub FROM swarm_roles WHERE role='root'")).rows).toEqual([{ user_sub: 'trusted-recovery' }]);
  });

  it('never replaces a root established through existing recovery, even with previously issued installer proof', async () => {
    const proof = await issueInstallerRootSetup(runtime, base);
    await claimRoot(runtime, { userSub: 'existing-root' });
    expect((await bootstrap(proof.token)).status).toBe(409);
    expect(await counts()).toEqual({ users: 0, roots: 1 });
  });

  it('runs the real local command and delivers a transient code usable only by the selected origin', async () => {
    const output = execFileSync(process.execPath, ['scripts/oshal-setup-root.mjs', '--origin', base], { encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'silent', LOCAL_AUTH: 'true', MOCK_OIDC: 'false',
        DATABASE_URL: `postgresql://root_runtime:fixture-runtime@127.0.0.1:${port}/root_fixture` }, timeout: 30_000 });
    const token = /Installer setup code: ([A-Za-z0-9_-]{43})/.exec(output)?.[1];
    expect(token).toBeTruthy(); expect((await bootstrap(token)).status).toBe(201);
  });
});
