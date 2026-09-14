/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise installation reports through real catalog, verifier, session transport, HTTP and Lab routes using temporary packages.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { createInstallVerificationRoutes } from '@/app/routes/install-verification-routes';
import { createTestLabRoutes } from '@/app/routes/test-lab-routes';
import { createServiceSmokeFetch } from '@/app/composition/test-lab-wiring';
import { InstalledAppTestCatalog } from '@/features/swarm-apps/services/installed-app-test-catalog';
import type { PackageTestSandbox } from '@/features/swarm-apps/services/package-test-sandbox';
import type { SwarmAppManifest, SwarmApplicationRecord, SwarmAppService } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { AppContext } from '@/app/composition/app-context';
import type { AppSmokeFetch } from '@/features/swarm-apps/services/app-smoke-verifier';
import { packageManifest, packageTestCase, writeTestPackage } from './package-testing';

/** @description Synthetic installation service credential; never valid outside this fixture. */
export const INSTALL_SECRET = 'installation-service-secret-sentinel';
/** @description Synthetic session used only by the disposable HTTP fixture. */
export const INSTALL_COOKIE = 'installation-fixture=operator';

function fixtureActor(): AuthorizationActor {
  return { sub: 'installation-operator', issuer: 'https://issuer.fixture.test', isActive: true, isSwarmAdmin: true,
    tenantIds: [] };
}

function fixtureState() {
  return { actor: fixtureActor(), base: '', reads: new Map<string, number>(), suiteRuns: 0,
    requireSession: false, httpStatus: 200, ready: true, hold: undefined as (() => Promise<void>) | undefined,
    beforeTransport: undefined as (() => void) | undefined, catalogHold: undefined as (() => Promise<void>) | undefined,
    fetchImpl: undefined as AppSmokeFetch | undefined };
}

function recordOf(manifest: SwarmAppManifest, file: string): SwarmApplicationRecord {
  return { appId: manifest.name, name: manifest.name, displayName: manifest.displayName || manifest.name, description: '', version: manifest.version || '0.0.0',
    status: 'active', manifestPath: file, manifest, agentIds: [], toolNames: [], scope: 'public', ownerSub: null,
    tenantId: null, guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
}

function installPackage(root: string, records: Map<string, SwarmApplicationRecord>, catalog: InstalledAppTestCatalog,
  manifest: SwarmAppManifest, declared = true): SwarmApplicationRecord {
  if (!declared) delete manifest.testing;
  const cases = [packageTestCase({ runner: { kind: 'node-test', scope: 'package', files: ['tests/behavior.spec.ts'] },
    prerequisites: ['runner:node-test'], sideEffects: 'none' as const })];
  const fixture = writeTestPackage(root, manifest, cases);
  const record = recordOf(manifest, fixture.file);
  records.set(manifest.name, record); catalog.register(record); return record;
}

function attachIdentity(app: express.Express, state: ReturnType<typeof fixtureState>): void {
  app.use((req, _res, next) => {
    const authenticated = req.headers.cookie === INSTALL_COOKIE;
    Object.assign(req, { oidc: { isAuthenticated: () => authenticated,
      user: authenticated ? { sub: state.actor.sub, email: 'operator@fixture.test' } : undefined } });
    next();
  });
}

function attachSmokeRoutes(app: express.Express, state: ReturnType<typeof fixtureState>): void {
  app.all('/api/:appName/:probe', async (req, res, next) => {
    if (!['ready', 'user', 'mutate', 'ai'].includes(String(req.params.probe))) { next(); return; }
    const key = `${req.method} ${req.path}`; state.reads.set(key, (state.reads.get(key) || 0) + 1);
    if (state.hold) await state.hold();
    if (state.requireSession && req.headers.cookie !== INSTALL_COOKIE) { res.status(401).json({ error: 'session required' }); return; }
    res.status(state.httpStatus).json({ ready: state.ready });
  });
  app.get('/api/readiness', (_req, res) => res.json({ ready: true,
    summary: 'llm=off bots=off catalogs=ok credentials=off voice.tts=off voice.stt=off db=ok', problems: [] }));
}

function attachVerification(app: express.Express, state: ReturnType<typeof fixtureState>, records: Map<string, SwarmApplicationRecord>,
  catalog: InstalledAppTestCatalog): void {
  const service = { getApp: async (name: string) => records.get(name) ?? null, testLabCatalog: catalog } as unknown as SwarmAppService;
  app.use('/api/install-verification', createInstallVerificationRoutes({} as AppContext, service, {
    get apiBaseUrl() { return state.base; },
    get fetchImpl() { return state.fetchImpl; },
    serviceSmokeFetch: async (req, test) => {
      const transport = await createServiceSmokeFetch(req, async () => state.actor, state.base, test.path);
      state.beforeTransport?.(); return transport;
    },
  }));
}

function attachLab(app: express.Express, state: ReturnType<typeof fixtureState>, records: Map<string, SwarmApplicationRecord>,
  catalog: InstalledAppTestCatalog): void {
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [] }));
  app.use('/shared', express.static(resolve('src/shared')));
  app.use('/api/test-lab', (req, res, next) => {
    if (req.headers.cookie !== INSTALL_COOKIE) { res.status(401).json({ error: 'session required' }); return; }
    next();
  });
  app.get('/api/test-lab/catalog', async (_req, _res, next) => { if (state.catalogHold) await state.catalogHold(); next(); });
  app.use('/api/test-lab', createTestLabRoutes({} as AppContext, { installedTests: catalog,
    visibleApps: async () => new Map([...records].filter(([, record]) => record.status === 'active').map(([name]) => [name, name])),
    get apiBaseUrl() { return state.base; } }));
}

/** @description Start real HTTP boundaries with temporary manifests and no production database, provider or runner access.
 * @returns Fixture state, lifecycle controls, canonical catalog and deterministic cleanup. */
export async function startInstallationVerificationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'oshal-installation-report-'));
  const state = fixtureState(); const records = new Map<string, SwarmApplicationRecord>();
  const sandbox = { run: async () => { state.suiteRuns++; throw new Error('Installation attempted an unauthorized suite.'); } } as unknown as PackageTestSandbox;
  const catalog = new InstalledAppTestCatalog({ sandbox });
  const app = express(); app.use(express.json()); attachIdentity(app, state); attachSmokeRoutes(app, state);
  attachVerification(app, state, records, catalog); attachLab(app, state, records, catalog);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, catalog, records, root, base: state.base,
    add: (manifest = packageManifest('install-fixture'), declared = true) => installPackage(root, records, catalog, manifest, declared),
    replace(name: string, version: string) {
      const record = records.get(name)!; record.version = version; record.manifest.version = version;
      writeFileSync(record.manifestPath, yaml.dump(record.manifest)); catalog.register(record);
    },
    async close() {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      if (!relative(resolve(tmpdir()), resolve(root)).startsWith('oshal-installation-report-')) throw new Error('Unsafe fixture cleanup');
      rmSync(root, { recursive: true, force: true });
    } };
}

/** @description Make an installer request through the actual route, using only the synthetic service identity.
 * @param base Disposable HTTP origin. @param apps Exact package selection. @param headers Optional synthetic session/Accept headers.
 * @returns Actual server response; callers assert both status and body. */
export function installationRequest(base: string, apps: string[], headers: Record<string, string> = {}) {
  return fetch(base + '/api/install-verification/apps', { method: 'POST', headers: { 'content-type': 'application/json',
    'x-service-secret': INSTALL_SECRET, ...headers }, body: JSON.stringify({ apps }) });
}
