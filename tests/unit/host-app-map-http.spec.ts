/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real HTTP admission joins ingress Host to root, static shell and profile decisions despite conflicting forwarded-host values; current auth, operators, explicit selectors, protocol/IP trust and native-fetch Host transport remain intact.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type Request, type RequestHandler } from 'express';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { resolveRequestLandingPath } from '@/app/host-app-map';
import { focusedLandingApp } from '@/app/experience-shell-lock';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';
import { createUiProfileRoutes, type UiProfileDiscoveryPorts } from '@/app/routes/ui-profile-routes';
import { APP_REGISTRY_SCENARIOS } from '@/app/routes/test-lab-app-registry-scenarios';
import { UIProfileService } from '@/features/ui-profile';
import type { SwarmAppService } from '@/features/swarm-apps';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => log }));
const HOST = 'sales.fixture.invalid';
const APP = 'intelligent-sales';
const LANDING = `/cockpit/?app=${APP}`;
const MAP = `${HOST}=${APP},127.0.0.1=${APP}`;
const FALLBACK = '/cockpit/';
const httpPorts = createRequire(import.meta.url)('../../scripts/operations/live-acceptance.js').httpPorts;
let server: Server;
let baseUrl = '';
let directory = '';

/** Synthetic identities are confined to this listener; no live tokens or sessions are used. */
const requiresAuth: RequestHandler = (req, res, next) => {
  const sub = req.get('x-test-user');
  if (!sub || !['fixture-member', 'fixture-operator'].includes(sub)) { res.status(401).json({ error: 'not_authenticated' }); return; }
  Object.assign(req, { oidc: { user: { sub }, isAuthenticated: () => true } });
  next();
};
const isOperator = (req: Request): boolean => (req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub === 'fixture-operator';
const landingPath = (req: Request): string => resolveRequestLandingPath(MAP, req, FALLBACK);
const discovery: UiProfileDiscoveryPorts = {
  resolveActor: async () => ({ sub: 'fixture-member', issuer: 'https://fixture.invalid', isActive: true, isSwarmAdmin: false } as never),
  runtime: { canDiscover: async () => true, canNavigateHttpPath: async () => true },
};
const profile = { name: APP, displayName: 'Synthetic Sales', defaultView: 'tool-sales',
  ribbon: { items: [{ id: 'tool-sales', label: 'Sales' }], dynamicTools: { allow: [] } } };
const apps = {
  getApp: async (name: string) => name === APP ? { status: 'active', manifest: { name } } : null,
  getAppForViewer: async (name: string) => name === APP ? { status: 'active', manifest: { name } } : null,
  synthesiseProfile: async (name: string) => name === APP ? structuredClone(profile) : null,
} as unknown as SwarmAppService;

/** Mount the real static/profile routers with the production request-aware landing helper. */
async function start(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), 'host-admission-http-'));
  for (const path of ['cockpit', 'enhanced', 'fonts', 'css', 'js']) mkdirSync(join(directory, path));
  writeFileSync(join(directory, 'cockpit', 'index.html'), '<title>host admission fixture</title>');
  const app = express();
  app.set('trust proxy', true);
  app.get('/', requiresAuth, (req, res) => res.redirect(302, resolveRequestLandingPath(MAP, req, FALLBACK, req.query.app)));
  app.get('/transport', requiresAuth, (req, res) => res.json({ protocol: req.protocol, ip: req.ip,
    forwardedHostname: req.hostname, landing: landingPath(req) }));
  registerCockpitStaticRoutes({ app, requiresAuth, cockpitDir: join(directory, 'cockpit'), uiEnhancedDir: join(directory, 'enhanced'),
    codiconFontsDir: join(directory, 'fonts'), sharedUiCssDir: join(directory, 'css'), sharedUiJsDir: join(directory, 'js'),
    shellLock: { isOperator, landingPath } });
  app.use('/api/ui', requiresAuth, createUiProfileRoutes(new UIProfileService(), apps, discovery,
    { isOperator, landingApp: (req) => focusedLandingApp(landingPath(req)) }));
  await new Promise<void>((done) => { server = app.listen(0, '127.0.0.1', () => done()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** One real HTTP request with explicit ingress and forwarded headers, without redirects. */
function raw(path: string, host: string, forwarded?: string, user = 'fixture-member', extra: Record<string, string> = {}) {
  const headers = { host, ...(forwarded === undefined ? {} : { 'x-forwarded-host': forwarded }),
    ...(user ? { 'x-test-user': user } : {}), ...extra };
  return new Promise<{ status: number; location?: string; json: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: Number(new URL(baseUrl).port), path, headers, setHost: false }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch { /* HTML/redirect */ }
        resolve({ status: res.statusCode || 0, location: res.headers.location, json, text }); });
    });
    req.on('error', reject); req.end();
  });
}

beforeAll(start);
afterAll(async () => {
  if (server) await new Promise<void>(done => server.close(() => done()));
  if (directory) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('host-admission-http-')) {
      throw new Error('Refusing cleanup outside the disposable Host admission fixture.');
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ingress Host controls focused admission over real HTTP', () => {
  it.each([
    ['the legitimate focused host', HOST, undefined],
    ['uppercase Host and a numeric port', 'SALES.FIXTURE.INVALID:443', 'unmapped.fixture.invalid'],
    ['an unmapped forwarded host', HOST, 'unmapped.fixture.invalid'],
    ['a conflicting forwarded host list', HOST, 'unmapped.fixture.invalid, sales.fixture.invalid'],
  ])('retains the root, shell and profile hold for %s', async (_label, host, forwarded) => {
    expect((await raw('/', host, forwarded)).location).toBe(LANDING);
    const shell = await raw('/Cockpit/', host, forwarded);
    expect([shell.status, shell.location]).toEqual([302, LANDING]);
    const unknown = await raw('/api/ui/profile?name=unknown-fixture', host, forwarded);
    expect([unknown.status, unknown.json]).toEqual([404, { error: 'experience_unavailable', landingApp: APP, operator: false }]);
    const admitted = await raw('/api/ui/profile', host, forwarded);
    expect(admitted.status).toBe(200);
    expect(admitted.json).toMatchObject({ source: 'swarm-app', requested: APP, landingApp: APP, operator: false });
  });

  it.each(['unmapped.fixture.invalid', 'unmapped.fixture.invalid:443', '', '[::1]:35457'])('does not borrow the forwarded host map for actual Host %s', async host => {
    expect((await raw('/', host, HOST)).location).toBe(FALLBACK);
    expect((await raw('/cockpit/', host, HOST)).status).toBe(200);
    const unknown = await raw('/api/ui/profile?name=unknown-fixture', host, HOST);
    expect(unknown.status).toBe(200);
    expect(unknown.json).toMatchObject({ source: 'disk', landingApp: null, operator: false });
  });

  it('keeps the current operator admission and profile fallback', async () => {
    expect((await raw('/cockpit/', HOST, 'unmapped.fixture.invalid', 'fixture-operator')).status).toBe(200);
    const response = await raw('/api/ui/profile?name=unknown-fixture', HOST, 'unmapped.fixture.invalid', 'fixture-operator');
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ source: 'disk', landingApp: APP, operator: true });
  });

  it('requires authentication before root, document and profile responses', async () => {
    for (const path of ['/', '/Cockpit/', '/api/ui/profile']) {
      expect((await raw(path, HOST, 'unmapped.fixture.invalid', '')).status, path).toBe(401);
    }
  });

  it('preserves bounded explicit root application links without exempting the plain shell', async () => {
    expect((await raw('/?app=another-app', HOST, 'unmapped.fixture.invalid')).location).toBe('/cockpit/?app=another-app');
    expect((await raw('/?app=../bad', HOST, 'unmapped.fixture.invalid')).location).toBe(LANDING);
    expect((await raw('/?app=one&app=two', HOST, 'unmapped.fixture.invalid')).location).toBe(LANDING);
  });

  it('retains forwarded HTTPS and IP while the hostile forwarded hostname has no landing authority', async () => {
    const response = await raw('/transport', HOST, 'unmapped.fixture.invalid', 'fixture-member',
      { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.17' });
    expect(response.json).toEqual({ protocol: 'https', ip: '203.0.113.17', forwardedHostname: 'unmapped.fixture.invalid', landing: LANDING });
  });

  it('the native-fetch acceptance transport uses its actual configured origin Host', async () => {
    const response = await httpPorts(baseUrl, 'synthetic-fixture-token').api('GET', '/api/ui/profile', undefined,
      { headers: { 'x-test-user': 'fixture-member' } });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ source: 'swarm-app', requested: APP, landingApp: APP, operator: false });
  });

  it('registers the boundary suite as integration coverage in the existing Test Lab', () => {
    expect(APP_REGISTRY_SCENARIOS.find(row => row.id === 'focused-application-entry')?.regressionTests)
      .toContainEqual({ level: 'integration', path: 'tests/unit/host-app-map-http.spec.ts' });
  });
});
