/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real local account and role APIs against isolated PostgreSQL for HTTP and browser regression tests.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { Pool } from 'pg';
import { ensureLocalUserSchema, ensureTotpSchema, upsertInvite, acceptInvite, type LocalUser } from '@/features/local-auth';
import { ensurePrincipalDirectorySchema } from '@/features/principal-directory';
import { ensureSwarmRoleSchema, refreshPrivilegedCache } from '@/features/swarm-roles';
import { clearPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';
import { createSwarmRolesRoutes } from '@/app/routes/swarm-roles-routes';
import { ensureInstallerRootSchema } from '@/app/composition/installer-root-bootstrap';

export const fixturePassword = 'disposable-password-12345';
export const fixtureServiceSecret = 'disposable-service-secret-12345';
const directoryIssuer = 'https://accounts.google.com';
type AccountName = 'root' | 'admin' | 'member';
const docker = (args: string[]) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
}).trim();

/** Disposable database and real route fixture; authentication injection is confined to loopback test code. */
export class LocalAccountFixture {
  readonly container = `oshal-users-fixture-${randomUUID().slice(0, 8)}`;
  readonly password = randomUUID();
  started = false; owner!: Pool; runtime!: Pool; server!: http.Server; base!: string;
  users = {} as Record<AccountName, LocalUser>;

  /** Start PostgreSQL and real Express APIs without using deployment configuration or data. */
  async start(): Promise<void> {
    docker(['run', '--detach', '--rm', '--name', this.container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
      '--env', `POSTGRES_PASSWORD=${this.password}`, '--env', 'POSTGRES_DB=users_fixture', 'postgres:16-alpine']);
    this.started = true;
    const port = Number(docker(['port', this.container, '5432/tcp']).split(':').pop());
    this.owner = new Pool({ host: '127.0.0.1', port, user: 'postgres', password: this.password, database: 'users_fixture', connectionTimeoutMillis: 500 });
    await this.waitForDatabase();
    await ensureLocalUserSchema(this.owner); await ensureTotpSchema(this.owner); await ensureSwarmRoleSchema(this.owner);
    await ensureInstallerRootSchema(this.owner); await ensurePrincipalDirectorySchema(this.owner);
    await this.owner.query("CREATE ROLE users_runtime LOGIN PASSWORD 'fixture-runtime' NOSUPERUSER NOBYPASSRLS");
    await this.owner.query('GRANT USAGE ON SCHEMA public TO users_runtime');
    await this.owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO users_runtime');
    this.runtime = wrapPoolWithGuc(new Pool({ host: '127.0.0.1', port, user: 'users_runtime', password: 'fixture-runtime', database: 'users_fixture' }));
  }

  private async waitForDatabase(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await this.owner.query('SELECT 1'); return; } catch { await new Promise(done => setTimeout(done, 200)); }
    }
    throw new Error('Disposable users fixture PostgreSQL unavailable');
  }

  /** Restore established fixture accounts and a newly composed API, including a fresh setup state cache. */
  async reset(seedAccounts = true): Promise<void> {
    if (this.server) await new Promise<void>(done => this.server.close(() => done()));
    await this.owner.query('TRUNCATE oshal_local_users, swarm_roles, oshal_installer_root_setup, oshal_verified_principals');
    clearPrivilegedIdentities();
    if (seedAccounts) {
      for (const name of ['root', 'admin', 'member'] as const) {
        const invite = await upsertInvite(this.runtime, { email: `${name}@example.test` });
        this.users[name] = (await acceptInvite(this.runtime, invite.token, fixturePassword))!;
      }
      await this.owner.query("INSERT INTO swarm_roles (user_sub,role) VALUES ($1,'root'),($2,'admin')", [this.users.root.userSub, this.users.admin.userSub]);
    }
    await refreshPrivilegedCache(this.runtime);
    this.mount();
    await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private authenticate: RequestHandler = async (req, _res, next) => {
    const name = req.get('x-fixture-user') ?? /(?:^|;\s*)fixture=([^;]+)/.exec(req.get('cookie') ?? '')?.[1];
    const user = this.users[name as AccountName];
    const issuer = req.get('x-fixture-issuer') ?? LOCAL_AUTH_PRINCIPAL_ISSUER;
    const snapshot = user ? await this.owner.query('SELECT status FROM oshal_local_users WHERE id=$1', [user.id]) : null;
    const active = snapshot?.rows[0]?.status === 'active';
    if (active && user) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: user.userSub, email: user.email, iss: issuer } } });
    runWithRequestIdentity({ sub: active ? user.userSub : null, principalIssuer: active ? issuer : null,
      isOperator: active && isOperatorIdentity(user.userSub, user.email) }, next);
  };

  private mount(): void {
    const app = express(); app.use(express.json()); app.use(this.authenticate);
    app.get('/users', (_req, res) => res.sendFile(path.resolve('src/pages/users/index.html')));
    app.use(createLocalAuthRoutes(this.runtime));
    app.use('/api/swarm/roles', createSwarmRolesRoutes(this.runtime, (req, res, next) => {
      if (!req.oidc?.isAuthenticated()) { res.status(401).json({ error: 'fixture_auth_required' }); return; } next();
    }));
    // The Users page only consumes the existing Access inventory projection. Account mutation uses the real APIs above.
    app.get('/api/authorization/catalog', async (req, res) => {
      if (!req.oidc?.isAuthenticated() || !isOperatorIdentity(req.oidc.user?.sub, req.oidc.user?.email)) { res.status(403).json({ error: 'forbidden' }); return; }
      const result = await this.owner.query('SELECT issuer,user_sub AS sub,display_name AS label FROM oshal_verified_principals');
      res.json({ users: result.rows });
    });
    this.server = http.createServer(app);
  }

  /** Call a real API with a test-only authenticated identity or a service credential. */
  async post(route: string, body: unknown = {}, caller = 'admin', issuer?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: this.base };
    if (caller === 'service') headers['X-Service-Secret'] = fixtureServiceSecret;
    else if (caller) headers['x-fixture-user'] = caller;
    if (issuer) headers['x-fixture-issuer'] = issuer;
    const response = await fetch(this.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }

  /** Add a verified-history fixture record; never contact or change an actual identity provider. */
  async externalIdentity(): Promise<void> {
    await this.owner.query(`INSERT INTO oshal_verified_principals (issuer,user_sub,provider,email,email_verified,display_name)
      VALUES ($1,'external-person','google','person@example.test',TRUE,'Person <img src=x onerror=alert(1)>')`, [directoryIssuer]);
  }

  /** Close all handles and remove only this fixture's named disposable container. */
  async close(): Promise<void> {
    if (this.server) await new Promise<void>(done => this.server.close(() => done()));
    await this.runtime?.end(); await this.owner?.end();
    if (this.started) docker(['rm', '--force', this.container]);
    clearPrivilegedIdentities();
  }
}
