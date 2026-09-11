/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify existing-account adoption, provider collisions and operator continuity against disposable PostgreSQL.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrincipalDirectoryStore } from '../../src/features/principal-directory';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '../../src/features/application-authorization';
import { ensureLocalUserSchema } from '../../src/features/local-auth';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import { preserveVerifiedDirectoryClaims } from '../../src/shared/middleware/verified-directory-claims';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '../../src/shared/middleware/principal-issuer';
import { createApplicationPrincipalDirectory } from '../../src/app/composition/application-principal-directory';
import { createApplicationAuthorizationActorResolver } from '../../src/app/middleware/application-authorization-identity';
import type { AuthorizationActor } from '../../src/shared/application-authorization';

const container = `oshal-principals-${randomUUID().slice(0,8)}`; const password = randomUUID();
const google = 'https://accounts.google.com'; const tenant = '11111111-2222-4333-8444-555555555555';
const microsoft = `https://login.microsoftonline.com/${tenant}/v2.0`;
const objectId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let started = false; let owner: Pool; let runtime: Pool; let env: NodeJS.ProcessEnv;
let directory: ReturnType<typeof createApplicationPrincipalDirectory>;
const admin: AuthorizationActor = { sub: 'existing-admin',issuer: LOCAL_AUTH_PRINCIPAL_ISSUER,isActive: true,isSwarmAdmin: true };
function docker(args: string[]): string { return execFileSync('docker',args,{ encoding: 'utf8',stdio: ['ignore','pipe','pipe'],timeout: 30_000 }).trim(); }
function req(issuer: string,sub = 'same-sub',extra: Record<string,unknown> = {}): Request {
  const now = Math.floor(Date.now()/1000); const claims = { iss: issuer,sub,iat: now,exp: now+3600,
    email: 'same@example.test',email_verified: true,name: 'Same name',...extra };
  return { oidc: { isAuthenticated: () => true,user: { sub,email: claims.email },idTokenClaims: claims },headers: {} } as unknown as Request;
}
beforeAll(async () => {
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP','');
  docker(['run','--detach','--rm','--name',container,'--publish','127.0.0.1::5432','--tmpfs','/var/lib/postgresql/data',
    '--env',`POSTGRES_PASSWORD=${password}`,'--env','POSTGRES_DB=principal_fixture','postgres:16-alpine']);
  started = true; const port = Number(docker(['port',container,'5432/tcp']).split(':').pop());
  owner = new Pool({ host: '127.0.0.1',port,user: 'postgres',password,database: 'principal_fixture',connectionTimeoutMillis: 500 });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await owner.query('SELECT 1'); ready = true; break; } catch { await new Promise(done => setTimeout(done,200)); }
  }
  if (!ready) throw new Error('Disposable principal database unavailable');
  await owner.query(readFileSync('scripts/migrations/129-verified-principal-directory.sql','utf8'));
  await ensureLocalUserSchema(owner);
  await owner.query(`CREATE TABLE oshal_external_identity_links(issuer TEXT,external_sub TEXT,entra_tenant_id TEXT,entra_object_id TEXT,
    local_user_sub TEXT REFERENCES oshal_local_users(user_sub),PRIMARY KEY(issuer,external_sub))`);
  await owner.query("CREATE ROLE principal_runtime LOGIN PASSWORD 'fixture-only' NOSUPERUSER NOBYPASSRLS");
  await owner.query('GRANT USAGE ON SCHEMA public TO principal_runtime');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO principal_runtime');
  runtime = wrapPoolWithGuc(new Pool({ host: '127.0.0.1',port,user: 'principal_runtime',password: 'fixture-only',database: 'principal_fixture' }));
},30_000);
beforeEach(async () => {
  await owner.query('TRUNCATE oshal_verified_principals,oshal_external_identity_links,oshal_local_users');
  env = { OIDC_ISSUER_URL: google,OIDC_CLIENT_ID: 'fixture-google',OIDC_CLIENT_SECRET: 'fixture',
    MICROSOFT_LOGIN: 'true',MICROSOFT_TENANT_ID: tenant,MICROSOFT_OIDC_CLIENT_ID: 'fixture-microsoft',MICROSOFT_OIDC_CLIENT_SECRET: 'fixture' };
  directory = createApplicationPrincipalDirectory(runtime,Promise.resolve(),env);
});
afterAll(async () => { if (runtime) await runtime.end(); if (owner) await owner.end(); if (started) docker(['rm','--force',container]); vi.unstubAllEnvs(); });

describe('verified existing-principal directory', () => {
  it('observes authenticated HTTP callers before handlers and refuses on registry failure', async () => {
    const app = express();
    app.use((request,_response,next) => { if (request.get('x-fixture-auth') === 'yes') Object.assign(request,{ oidc: req(google).oidc }); next(); });
    app.use(directory.observePrincipal);
    app.get('/',(_request,response) => response.json({ reached: true }));
    const server = http.createServer(app); await new Promise<void>(done => server.listen(0,'127.0.0.1',done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      expect((await fetch(url)).status).toBe(200); expect(await new PrincipalDirectoryStore(runtime).list()).toEqual([]);
      expect((await fetch(url,{ headers: { 'x-fixture-auth': 'yes' } })).status).toBe(200);
      expect((await new PrincipalDirectoryStore(runtime).list()).map(row => row.issuer)).toEqual([google]);
      await owner.query('ALTER TABLE oshal_verified_principals RENAME TO temporarily_unavailable');
      try { expect((await fetch(url,{ headers: { 'x-fixture-auth': 'yes' } })).status).toBe(503); }
      finally { await owner.query('ALTER TABLE temporarily_unavailable RENAME TO oshal_verified_principals'); }
    } finally { await new Promise<void>((done,error) => server.close(err => err ? error(err) : done())); }
  });
  it('keeps local, Google and Microsoft subjects/emails separate and preserves accounts', async () => {
    await owner.query("INSERT INTO oshal_local_users(id,email,user_sub,status,password_hash) VALUES('local-row','same@example.test','same-sub','active','unchanged-hash')");
    await directory.observe(req(google)); await directory.observe(req(microsoft));
    const inventory = await directory.inventory(admin);
    expect(inventory.users.map(user => [user.issuer,user.sub]).sort()).toEqual([
      [google,'same-sub'],[microsoft,'same-sub'],[LOCAL_AUTH_PRINCIPAL_ISSUER,'same-sub'],
    ].sort());
    expect((await owner.query('SELECT password_hash,status FROM oshal_local_users')).rows).toEqual([{ password_hash: 'unchanged-hash',status: 'active' }]);
    expect((await runtime.query('SELECT * FROM oshal_verified_principals')).rows).toEqual([]);
    const restarted = createApplicationPrincipalDirectory(runtime,Promise.resolve(),env);
    expect((await restarted.inventory(admin)).users).toHaveLength(3);
  });
  it('never invents principals from metadata-only sessions, body claims, incoherent evidence or disabled provider flags', async () => {
    await directory.observe({ oidc: { isAuthenticated: () => true,user: { iss: google,sub: 'unverified' } },headers: {} } as unknown as Request);
    await directory.observe({ body: { iss: google,sub: 'forged' },headers: {} } as unknown as Request);
    await expect(directory.observe(req(google,'invalid',{ exp: 1 }))).rejects.toThrow(/invalid/);
    env.MICROSOFT_LOGIN = 'false'; await directory.observe(req(microsoft));
    expect(await new PrincipalDirectoryStore(runtime).list()).toEqual([]);
  });
  it('preserves a middleware-authenticated app session after its original coherent ID token expires', async () => {
    const now = Math.floor(Date.now()/1000);
    await directory.observe(req(google,'established',{ iat: now-7200,exp: now-3600 }));
    expect((await directory.nativePrincipal('established',google)).isActive).toBe(true);
  });
  it('scopes configured operators to enabled primary or explicit secondary issuers and verified email provenance', async () => {
    env.OSHAL_OPERATOR_SUBS = 'same-sub'; await directory.observe(req(google)); await directory.observe(req(microsoft));
    expect(await directory.nativePrincipal('same-sub',google)).toEqual({ isActive: true,isSwarmAdmin: true });
    expect(await directory.nativePrincipal('same-sub',microsoft)).toEqual({ isActive: true,isSwarmAdmin: false });
    env.OSHAL_AUTHORIZATION_ADMIN_ISSUERS = microsoft;
    expect((await directory.nativePrincipal('same-sub',microsoft)).isSwarmAdmin).toBe(true);
    env.OSHAL_OPERATOR_SUBS = ''; env.OSHAL_OPERATOR_EMAILS = 'same@example.test';
    await directory.observe(req(google,'same-sub',{ email_verified: false }));
    expect((await directory.nativePrincipal('same-sub',google)).isSwarmAdmin).toBe(false);
    await directory.observe(req(google)); expect((await directory.nativePrincipal('same-sub',google)).isSwarmAdmin).toBe(true);
    const resolve = createApplicationAuthorizationActorResolver(runtime,{ nativePrincipal: directory.nativePrincipal,tenantIds: async () => [] });
    const refreshed = { oidc: { isAuthenticated: () => true,user: { sub: 'same-sub',iss: google } },headers: {} } as unknown as Request;
    expect((await resolve(refreshed)).isSwarmAdmin).toBe(true);
    env.OSHAL_OPERATOR_EMAILS = ''; expect((await resolve(refreshed)).isSwarmAdmin).toBe(false);
    env.MICROSOFT_LOGIN = 'false'; expect(await directory.nativePrincipal('same-sub',microsoft)).toEqual({ isActive: false,isSwarmAdmin: false });
    expect((await directory.inventory(admin)).users.find(user => user.issuer === microsoft)?.label).toContain('provider disabled');
  });
  it('keeps disabled principal state through subsequent verified sign-ins and denies nonadmin inventory', async () => {
    await directory.observe(req(google));
    await owner.query("UPDATE oshal_verified_principals SET status='disabled'");
    await directory.observe(req(google));
    expect(await directory.nativePrincipal('same-sub',google)).toEqual({ isActive: false,isSwarmAdmin: false });
    expect((await directory.inventory({ ...admin,isSwarmAdmin: false })).users).toEqual([]);
    const resolve = createApplicationAuthorizationActorResolver(runtime,{ nativePrincipal: directory.nativePrincipal,tenantIds: async () => [] });
    expect(await resolve(req(google))).toMatchObject({ issuer: google,sub: 'same-sub',isActive: false,isSwarmAdmin: false });
  });
  it('deduplicates Microsoft only through the existing exact link and does not create or rebind accounts', async () => {
    await owner.query("INSERT INTO oshal_local_users(id,email,user_sub,status) VALUES('local-row','same@example.test','local-canonical','active')");
    const bridged = { oidc: { isAuthenticated: () => true,user: { iss: LOCAL_AUTH_PRINCIPAL_ISSUER,sub: 'local-canonical' } },headers: {} } as unknown as Request;
    const external = req(microsoft,'external-sub',{ tid: tenant,oid: objectId });
    preserveVerifiedDirectoryClaims(bridged,(external.oidc as unknown as { idTokenClaims: Record<string,unknown> }).idTokenClaims);
    await expect(directory.observe(bridged)).rejects.toThrow(/does not match/);
    await owner.query('INSERT INTO oshal_external_identity_links VALUES($1,$2,$3,$4,$5)',[microsoft,'external-sub',tenant,objectId,'local-canonical']);
    await directory.observe(bridged);
    const inventory = await directory.inventory(admin); expect(inventory.users).toHaveLength(1);
    expect(inventory.users[0]).toMatchObject({ issuer: LOCAL_AUTH_PRINCIPAL_ISSUER,sub: 'local-canonical' });
    expect(inventory.users[0].label).toContain('microsoft linked');
    expect(await directory.nativePrincipal('external-sub',microsoft)).toEqual({ isActive: false,isSwarmAdmin: false });
    await expect(directory.observe(req(microsoft,'external-sub'))).rejects.toThrow(/canonical identity conflict/);
    expect(Number((await owner.query('SELECT count(*) AS n FROM oshal_external_identity_links')).rows[0].n)).toBe(1);
  });
  it('supports native targets through the real authorization service without granting same-sub provider peers', async () => {
    await directory.observe(req(google)); await directory.observe(req(microsoft));
    const service = new ApplicationAuthorizationService(new MemoryAuthorizationStore(),{ resolveActor: directory.targetActor,inventory: directory.inventory });
    await service.registerApp({ app: 'fixture-app',source: 'fixture',version: '1',catalog: null,mode: 'enforce' });
    const preview = await service.previewChange(admin,{ action: 'grant',app: 'fixture-app',role: '@app-admin',targetSub: 'same-sub',targetIssuer: google,reason: 'Exact provider fixture',expectedRevision: 0 });
    await service.applyChange(admin,{ previewId: preview.previewId,idempotencyKey: preview.previewId });
    expect((await service.effective(admin,{ app: 'fixture-app',targetSub: 'same-sub',targetIssuer: google })).tier).toBe('admin');
    expect((await service.effective(admin,{ app: 'fixture-app',targetSub: 'same-sub',targetIssuer: microsoft })).tier).toBe('deny');
    expect((await service.catalog(admin)).users).toHaveLength(2);
  });
});
