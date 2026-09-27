/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-03 browser proof: the real Users page in Chromium, over the real swarm-role routes and a disposable PostgreSQL, shows an identity-provider caller their exact issuer and subject while root is unclaimed, and redeems the installer code bound to exactly that identity; another identity's redemption is refused on the page with nothing written, and a local-account session is offered no form.
 */
/**
 * Isolated fixture evidence. Real: src/pages/users/index.html, createSwarmRolesRoutes, the installer ceremony module,
 * PostgreSQL 16 (core DisposablePostgres with the fixture-slot ceiling) under a NOSUPERUSER NOBYPASSRLS runtime role.
 * Doubled: the verified session, attached by a loopback header as req.oidc with the issuer on idTokenClaims (the
 * shape the OIDC rail produces). Docker and Chromium are required; a missing one fails, never skips.
 */
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ensureLocalUserSchema } from '@/features/local-auth';
import { ensurePrincipalDirectorySchema } from '@/features/principal-directory';
import { ensureSwarmRoleSchema } from '@/features/swarm-roles';
import { clearPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { ensureInstallerRootSchema, issueInstallerRootSetup } from '@/app/composition/installer-root-bootstrap';
import { createSwarmRolesRoutes } from '@/app/routes/swarm-roles-routes';

const IDP = 'https://login.example.test/tenant-a/v2.0';
const OWNER = 'idp-owner-subject';
const db = new DisposablePostgres({ purpose: 'installer-root-oidc-browser', roles: ['root_browser_runtime'] });
let runtime: ReturnType<typeof wrapPoolWithGuc>; let server: http.Server; let base: string; let browser: Browser;
const contexts: BrowserContext[] = [];

/** Real Users page and role routes; the session is a loopback header pair, as the OIDC rail would attach it. */
function mount(): express.Express {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-fixture-user'); const iss = req.get('x-fixture-issuer');
    if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub }, ...(iss ? { idTokenClaims: { iss, sub } } : { }) } });
    next();
  });
  app.get('/users', (_req, res) => res.sendFile(path.resolve('src/pages/users/index.html')));
  app.use('/api/swarm/roles', createSwarmRolesRoutes(runtime, (req, res, next) => {
    if (!req.get('x-fixture-user')) { res.status(401).json({ error: 'fixture_auth_required' }); return; }
    next();
  }));
  return app;
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); vi.stubEnv('MOCK_OIDC', 'false'); vi.stubEnv('LOG_LEVEL', 'silent');
  const owner = await db.start();
  await ensureLocalUserSchema(owner); await ensureSwarmRoleSchema(owner); await ensureInstallerRootSchema(owner); await ensurePrincipalDirectorySchema(owner);
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO root_browser_runtime');
  runtime = wrapPoolWithGuc(db.rolePool('root_browser_runtime'));
  server = http.createServer(mount());
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 180_000);
beforeEach(async () => {
  clearPrivilegedIdentities(); vi.stubEnv('OSHAL_OPERATOR_SUBS', ''); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  await db.pool.query('TRUNCATE oshal_local_users, swarm_roles, oshal_installer_root_setup, oshal_verified_principals');
});
afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  await db.stop(); clearPrivilegedIdentities(); vi.unstubAllEnvs();
}, 60_000);

/** One disposable browser context for one signed-in identity; nothing leaves the fixture origin. */
async function openUsers(sub: string, issuer?: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-user': sub, ...(issuer ? { 'x-fixture-issuer': issuer } : {}) } });
  contexts.push(context);
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.on('dialog', (dialog) => { void dialog.accept(); });
  await page.goto(`${base}/users`);
  await expect.poll(() => page.locator('#rootPill').textContent()).toBe('unclaimed');
  return page;
}
const roots = async () => (await db.pool.query("SELECT user_sub FROM swarm_roles WHERE role='root'")).rows;

describe('Users page identity-provider installer root (AUTH-03)', () => {
  it('shows the caller their exact identity and makes exactly that identity root with the bound code', async () => {
    const proof = await issueInstallerRootSetup(runtime, base, { issuer: IDP, subject: OWNER });
    const page = await openUsers(OWNER, IDP);
    expect(await page.locator('#installerIssuer').textContent()).toBe(IDP);
    expect(await page.locator('#installerSubject').textContent()).toBe(OWNER);
    expect(await page.locator('#rootBody').textContent()).toContain('existing operator');
    await page.locator('#installerRootCode').fill(proof.token);
    await page.getByRole('button', { name: 'Become swarm root', exact: true }).click();
    await expect.poll(() => page.locator('#rootPill').textContent()).toBe('you are root');
    expect(await roots()).toEqual([{ user_sub: OWNER }]);
  }, 60_000);

  it('refuses another identity on the page with nothing written, and offers a local-account session no form', async () => {
    const proof = await issueInstallerRootSetup(runtime, base, { issuer: IDP, subject: OWNER });
    const other = await openUsers('someone-else', IDP);
    await other.locator('#installerRootCode').fill(proof.token);
    await other.getByRole('button', { name: 'Become swarm root', exact: true }).click();
    await expect.poll(() => other.locator('body').textContent()).toContain('installer setup is bound to a different identity');
    expect(await other.locator('#rootPill').textContent()).toBe('unclaimed');
    expect(await roots()).toEqual([]);
    const local = await openUsers(OWNER, 'urn:oshal:local-auth');
    expect(await local.locator('#installerRootForm').count()).toBe(0);
    expect(await local.locator('#rootBody').textContent()).toContain('existing operator');
  }, 60_000);
});
