/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise membership authority with real PostgreSQL, provider inventory and loopback HTTP.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import express from 'express';
import { Pool } from 'pg';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { createApplicationPrincipalDirectory } from '@/app/composition/application-principal-directory';
import { createExternalTenantMembershipRoutes } from '@/app/routes/external-tenant-membership-routes';
import { ExternalTenantMembershipService, PostgresExternalTenantMembershipStore, ensureExternalTenantMembershipSchema,
  type ExternalTenantMembershipChange } from '@/features/external-tenant-memberships';
import { PrincipalDirectoryStore } from '@/features/principal-directory';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { LocalAccountFixture } from './local-account-administration';

/** @description Actual provider namespace used only with disposable observed fixture rows. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
/** @description Provider-directory namespace deliberately distinct from the business tenant. */
export const MICROSOFT_TENANT = '11111111-1111-4111-8111-111111111111';
/** @description Actual issuer shape, with no live provider interaction. */
export const MICROSOFT_ISSUER = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`;
/** @description Existing disposable business workspace identity. */
export const BUSINESS_TENANT = '22222222-2222-4222-8222-222222222222';
/** @description Real stores and enabled-provider resolution; authentication injection is isolated to the HTTP fixture. */
export class ExternalMembershipFixture {
  readonly database = new LocalAccountFixture(); pool!: Pool; store!: PostgresExternalTenantMembershipStore;
  service!: ExternalTenantMembershipService; directory!: ReturnType<typeof createApplicationPrincipalDirectory>;
  server!: Server; base!: string; now = Date.now();
  admin: AuthorizationActor = { sub: 'operator', issuer: GOOGLE_ISSUER, isActive: true, isSwarmAdmin: true };
  readonly google: AuthorizationActor = { sub: 'same-sub', issuer: GOOGLE_ISSUER, isActive: true, isSwarmAdmin: false };
  readonly microsoft: AuthorizationActor = { ...this.google, issuer: MICROSOFT_ISSUER };
  env: NodeJS.ProcessEnv = { OIDC_ISSUER_URL: GOOGLE_ISSUER, OIDC_CLIENT_ID: 'fixture-client', OIDC_CLIENT_SECRET: 'fixture-secret',
    MICROSOFT_LOGIN: 'true', MICROSOFT_TENANT_ID: MICROSOFT_TENANT, MICROSOFT_OIDC_CLIENT_ID: 'fixture-ms', MICROSOFT_OIDC_CLIENT_SECRET: 'fixture-ms-secret' };
  /** @description Prove migration and runtime schema coexist against disposable PostgreSQL. @returns Fixture readiness. */
  async start(): Promise<void> {
    await this.database.start();
    await this.database.owner.query(readFileSync('scripts/migrations/127-application-authorization.sql', 'utf8'));
    await this.database.owner.query('CREATE TABLE oshal_tenants(tenant_id UUID PRIMARY KEY,name TEXT)');
    await this.database.owner.query(readFileSync('scripts/migrations/135-external-tenant-memberships.sql', 'utf8'));
    await ensureExternalTenantMembershipSchema(this.database.owner);
    await this.database.owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO users_runtime');
    this.pool = wrapPoolWithGuc(new Pool({ ...this.database.runtime.options, password: this.database.runtime.options.password,
      max: 1, connectionTimeoutMillis: 1000 }));
    this.directory = createApplicationPrincipalDirectory(this.pool, Promise.resolve(), this.env);
    this.store = new PostgresExternalTenantMembershipStore(this.pool);
    this.service = new ExternalTenantMembershipService(this.store, { refreshActor: this.refreshActor,
      resolveTarget: this.directory.targetActor, now: () => this.now });
    this.mount();
    await new Promise<void>(resolve => this.server.once('listening', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  /** @description Reset fixture facts while retaining same-subject, same-email collision cases. @returns Reset completion. */
  async reset(): Promise<void> {
    await this.database.owner.query('TRUNCATE oshal_external_tenant_memberships,oshal_external_tenant_previews,oshal_authorization_audit,oshal_authorization_assignments,oshal_authorization_previews,oshal_verified_principals,oshal_tenants');
    await this.database.owner.query('UPDATE oshal_authorization_state SET revision=0');
    await this.database.owner.query('INSERT INTO oshal_tenants(tenant_id,name) VALUES($1,$2)', [BUSINESS_TENANT,'Business fixture']);
    this.admin = { sub: 'operator',issuer: GOOGLE_ISSUER,isActive: true,isSwarmAdmin: true }; this.now = Date.now(); this.env.MICROSOFT_LOGIN = 'true';
    const directory = new PrincipalDirectoryStore(this.pool);
    for (const actor of [this.google,this.microsoft]) await directory.observe({ issuer: actor.issuer,sub: actor.sub,
      provider: actor.issuer === GOOGLE_ISSUER ? 'google' : 'microsoft',email: 'shared@example.test',emailVerified: true,
      displayName: 'Existing provider account',canonicalLocalSub: null });
  }
  /** @description Revalidate through the one-connection pool. @param actor Original fixture identity. @returns Current actor or null. */
  refreshActor = async (actor: AuthorizationActor): Promise<AuthorizationActor | null> => {
    await this.pool.query('SELECT 1');
    if (actor.sub === 'operator' && actor.issuer === GOOGLE_ISSUER) return { ...this.admin };
    const target = await this.directory.targetActor(actor.sub,actor.issuer);
    return target ? { ...target, tenantIds: target.isActive ? await this.store.tenantIds(target.sub,target.issuer) : [] } : null;
  };
  /** @description Produce a review at the shared revision. @param input Explicit case overrides. @returns Reviewed change input. */
  async change(input: Partial<ExternalTenantMembershipChange> = {}): Promise<ExternalTenantMembershipChange> {
    return { action: 'grant', targetSub: this.google.sub,targetIssuer: this.google.issuer,tenantId: BUSINESS_TENANT,
      reason: 'Reviewed fixture membership',expectedRevision: (await this.store.catalog()).revision,...input };
  }
  /** @description Exercise the real preview/apply authority. @param input Explicit case overrides. @returns Durable applied receipt. */
  async apply(input: Partial<ExternalTenantMembershipChange> = {}) {
    const preview = await this.service.preview(this.admin, await this.change(input));
    return this.service.apply(this.admin, { previewId: preview.previewId,idempotencyKey: preview.previewId });
  }
  /** @description Call the actual adapter on loopback only.
   * @param path Fixed route. @param body Optional request. @param user Fixture caller. @param headers Case-specific request headers. @returns HTTP result.
   */
  async call(path: string, body?: unknown, user = 'admin', headers: Record<string,string> = {}) {
    const response = await fetch(this.base + '/api/authorization/tenant-memberships' + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'x-fixture-user': user,...(body === undefined ? {} : { 'content-type': 'application/json',origin: this.base,'x-oshal-access-request': '1' }),...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status,body: await response.json(),headers: response.headers };
  }
  /** @description Release only the disposable server and database. @returns Cleanup completion. */
  async close(): Promise<void> {
    this.server?.closeAllConnections(); if (this.server) await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.pool?.end(); await this.database.close();
  }
  private mount(): void {
    const app = express(); this.mountPageReads(app);
    app.use('/api/authorization/tenant-memberships',createExternalTenantMembershipRoutes(this.service, { requiresAuth: (req,res,next) => {
      if (!['admin','google'].includes(req.get('x-fixture-user') ?? '')) { res.status(401).json({ error: 'authentication_required' }); return; }
      next();
    }, resolveActor: async req => req.get('x-fixture-user') === 'admin' ? { ...this.admin } : this.google }));
    this.server = app.listen(0,'127.0.0.1');
  }
  private mountPageReads(app: express.Express): void {
    app.get('/users',(_req,res) => res.sendFile(resolve('src/pages/users/index.html')));
    app.use('/shared',express.static(resolve('src/shared')));
    app.use('/cockpit/css/themes',express.static(resolve('src/pages/cockpit/css/themes')));
    app.get('/api/swarm/roles/me',(_req,res) => res.json({ sub: this.admin.sub,role: 'user' }));
    app.get('/api/swarm/roles/status',(_req,res) => res.json({ rootClaimed: false,callerIsRoot: false,
      callerIsOperator: this.admin.isSwarmAdmin,callerBreakGlassOnly: this.admin.isSwarmAdmin }));
    app.get('/api/swarm/roles',(_req,res) => res.json({ roles: [] }));
    app.get('/api/local-auth/users',(_req,res) => res.status(404).json({ error: 'local_auth_disabled' }));
    app.get('/api/user-directory',async (_req,res) => res.json(await this.directory.roster(this.admin)));
  }
}
