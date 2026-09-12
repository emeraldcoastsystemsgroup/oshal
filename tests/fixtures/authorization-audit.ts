/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Compose real PostgreSQL authorization audit, HTTP and browser fixtures without deployment data.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Close fixture keep-alive connections before resetting or removing the disposable database.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ApplicationAuthorizationService, PostgresAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationChange } from '@/shared/application-authorization';
import { createAuthorizationPageRoutes, createAuthorizationRoutes } from '@/app/routes/authorization-routes';
import { AuthorizationToolRuntime } from '@/app/composition/authorization-tool';
import { LocalAccountFixture } from './local-account-administration';

/** @description Real shared store/service and fixed tool entrypoint; test authentication is confined to loopback. */
export class AuthorizationAuditFixture {
  readonly database = new LocalAccountFixture();
  actors!: Record<string, AuthorizationActor>;
  store!: PostgresAuthorizationStore; service!: ApplicationAuthorizationService; tool!: AuthorizationToolRuntime;
  server!: http.Server; base!: string;

  /** @description Start an isolated PostgreSQL database. @returns Schema-ready fixture. */
  async start(): Promise<void> {
    await this.database.start();
    for (const file of ['127-application-authorization.sql', '131-authorization-audit-indexes.sql']) {
      await this.database.owner.query(readFileSync(resolve('scripts/migrations', file), 'utf8'));
    }
    await this.database.owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO users_runtime');
    this.store = new PostgresAuthorizationStore(this.database.runtime);
  }

  /** @description Recompose real routes and restore only fixture data. @returns A listening loopback endpoint. */
  async reset(): Promise<void> {
    await this.closeServer();
    await this.database.owner.query('TRUNCATE oshal_authorization_assignments,oshal_authorization_previews,oshal_authorization_audit,oshal_authorization_applications');
    await this.database.owner.query('UPDATE oshal_authorization_state SET revision=0');
    const actor = (sub: string): AuthorizationActor => ({ sub, issuer: 'urn:audit-fixture', isActive: true, isSwarmAdmin: false });
    this.actors = { root: { ...actor('root'), isSwarmAdmin: true }, user: actor('user'),
      manager: { ...actor('manager'), managementScopes: [{ app: 'app-one', permissions: ['read'] }] },
      tenant: { ...actor('tenant'), managementScopes: [{ app: 'app-one', tenantId: 'tenant-a', permissions: ['read'] }] } };
    this.service = new ApplicationAuthorizationService(this.store, { refreshActor: async actor => this.actors[actor.sub] ?? null,
      inventory: async () => ({ users: [{ sub: 'user', issuer: 'urn:audit-fixture', label: 'User' }], groups: [] }) });
    for (const app of ['app-one', 'app-two']) await this.service.registerApp({ app, source: 'fixture', version: '1', catalog: null, mode: 'enforce' });
    this.tool = new AuthorizationToolRuntime(this.service); this.mount();
    await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private mount(): void {
    const app = express();
    const actor = (req: express.Request) => this.actors[/(?:^|;\s*)session=([^;]+)/.exec(req.get('cookie') ?? '')?.[1] ?? ''];
    const options = { requiresAuth: ((req, res, next) => {
      if (!actor(req)) { res.status(401).json({ error: 'fixture_auth_required' }); return; } next();
    }) as express.RequestHandler, resolveActor: async (req: express.Request) => structuredClone(actor(req)), authorizationTool: this.tool };
    app.use('/api/authorization', createAuthorizationRoutes(this.service, options));
    app.use('/access', createAuthorizationPageRoutes(this.service, options));
    app.use('/shared', express.static(resolve('src/shared')));
    this.server = http.createServer(app);
  }

  /** @description Commit a fixture grant through the real preview/apply service. @param input Controlled test change. @returns Audit receipt. */
  async apply(input: Partial<AuthorizationChange> = {}) {
    const preview = await this.service.previewChange(this.actors.root, { app: 'app-one', action: 'grant', targetSub: 'user', targetIssuer: 'urn:audit-fixture',
      role: '@app-admin', reason: 'SECRET_REASON_NOT_FOR_HISTORY', expectedRevision: (await this.store.read()).revision, ...input });
    return this.service.applyChange(this.actors.root, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
  }

  /** @description Exercise the real HTTP adapter. @param path Relative API path. @param caller Fixture identity. @param body Optional request. @returns HTTP response. */
  async call(path: string, caller = 'root', body?: unknown) {
    const response = await fetch(this.base + '/api/authorization' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(caller ? { cookie: `session=${caller}` } : {}), ...(body === undefined ? {} : {
        origin: this.base, 'content-type': 'application/json', 'x-oshal-access-request': '1',
      }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  /** @description Remove this fixture's temporary resources. @returns Cleanup completion. */
  async close(): Promise<void> {
    try { await this.closeServer(); } finally { await this.database.close(); }
  }

  private async closeServer(): Promise<void> {
    if (!this.server) return;
    const closed = new Promise<void>(done => this.server.close(() => done()));
    this.server.closeAllConnections();
    await closed;
  }
}
