/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The RENDER half of the applications-as-a-swarm-catalog guard. The unit spec proves the decision; this proves the page carries it to the screen, because the defect being closed is a screen that could not express "connected" or "credential needed" at all. Real Chromium loads the real src/pages/applications/index.html over a real HTTP server, and both feeds it consumes are the real projections: installed rows come from toSummary, store rows from parseCatalog, and connector state from the buildConnectorListResponse body GET /api/connect/list actually sends. Only the transport and the datastore are fixtures. The last case is the one a mock-only test could never make: with the broker answering 500, the page must render "connections unknown" and must NOT render a connected or credential-needed badge anywhere.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { toSummary } from '@/features/swarm-apps/services/swarm-app-record-view';
import { parseCatalog } from '@/app/routes/app-store-remote';
import { buildConnectorListResponse } from '@/app/routes/connector-response-helpers';
import type { ConnectionRow } from '@/app/routes/connector-tenancy';
import type { SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps/types';
import { APP_REGISTRY_SCENARIOS } from '@/app/routes/test-lab-app-registry-scenarios';

let server: Server, base: string, browser: Browser;
/** Flipped to false to prove an unreadable broker never becomes a claim about the operator. */
let brokerOk = true;

/**
 * @description A manifest declaring connectors in the tiered form, as every store package does.
 * @param name - Package name (also the row's display name).
 * @param required - Provider ids the bundle cannot do its job without.
 * @param optional - Provider ids it works without.
 * @returns The manifest a listing record carries.
 */
function manifest(name: string, required: string[], optional: string[] = []): SwarmAppManifest {
  return {
    name, displayName: name, version: '1.0.0', suite: 'ai-home', uses: ['app-dependencies'],
    ui: { static: [{ toolName: name, label: name, icon: 'codicon codicon-home', iframeUrl: `/${name}/` }] },
    dependencies: {
      required: { apps: [], tools: [], connectors: required },
      optional: { apps: [], tools: [], connectors: optional },
    },
  } as unknown as SwarmAppManifest;
}

/**
 * @description Project a manifest through the REAL listing projection the route serializes.
 * @param m - The manifest.
 * @returns One entry of the GET /api/swarm/apps response.
 */
function summary(m: SwarmAppManifest) {
  return toSummary({
    name: m.name, displayName: m.displayName, description: `${m.name} description`, version: '1.0.0',
    status: 'active', agentIds: [], toolNames: [], manifest: m, manifestPath: `/fixture/${m.name}.yaml`,
    loadedAt: new Date(0), updatedAt: new Date(0), scope: 'public', ownerSub: null, tenantId: null,
  } as unknown as SwarmApplicationRecord, null);
}

/** The caller's one live connection. Everything else about this deployment comes from env. */
const CONNECTED_ROWS: ConnectionRow[] = [{
  connection_id: 'smartthings-1', user_sub: 'user-1', connected_by_sub: 'user-1', tenant_id: null,
  provider: 'smartthings', label: null, account_key: 'a', is_default: true,
  account_email: 'person@example.test', account_id: 'a', scopes: null,
  // Null on purpose: the projection never reads a token, so the fixture holds none.
  access_token: null, refresh_token: null, expiry: null, created_at: new Date(0),
}];

/** A marketplace.json document in the dual (tiered + flat compatibility) shape the store emits. */
const STORE_DOC = JSON.stringify({
  apps: [{
    name: 'store-home', displayName: 'Store Home', description: 'Not installed here', suite: 'ai-home',
    version: '3.0.0', status: 'ready',
    dependencies: {
      apps: [], tools: [], connectors: ['smartthings'],
      required: { apps: [], tools: [], connectors: ['smartthings'] },
      optional: { apps: [], tools: [], connectors: [] },
    },
    source: { type: 'git-subdir', url: 'https://github.com/example/store', path: 'store-home', ref: 'main' },
    audit: { record: 'audits/store-home.json', sourceSha: '0'.repeat(40) },
  }],
});

/**
 * @description The rendered text of one application row, by its manifest name.
 * @param page - The loaded catalog page.
 * @param name - The app name on the row's data-name attribute.
 * @returns The row's visible text.
 */
async function rowText(page: Page, name: string): Promise<string> {
  return page.locator(`.app-row[data-name="${name}"]`).innerText();
}

beforeAll(async () => {
  // This deployment registered SmartThings and Slack OAuth clients and never registered a Google
  // Home Device Access client. Those three postures, against one live SmartThings connection, are
  // exactly the three verdicts the catalog has to keep apart.
  vi.stubEnv('SMARTTHINGS_CLIENT_ID', 'fixture-client');
  vi.stubEnv('SMARTTHINGS_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('SLACK_CLIENT_ID', 'fixture-slack');
  vi.stubEnv('SLACK_CLIENT_SECRET', 'fixture-slack-secret');
  vi.stubEnv('GOOGLE_HOME_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_HOME_CLIENT_SECRET', '');

  const app = express();
  app.get('/api/swarm/apps', (_req, res) => res.json({
    apps: [
      summary(manifest('linked-home', ['smartthings'])),
      summary(manifest('waiting-home', ['slack'], ['google-home'])),
      summary(manifest('blocked-home', ['google-home'])),
      summary(manifest('plain-app', [])),
    ],
  }));
  app.get('/api/connect/list', (_req, res) => {
    if (!brokerOk) { res.status(500).json({ error: 'broker unavailable' }); return; }
    res.json({ providers: buildConnectorListResponse(CONNECTED_ROWS) });
  });
  // The page prefers the multi-registry rail and falls back to the single-store one on 403.
  app.get('/api/swarm/registries/catalog', (_req, res) => res.status(403).json({ error: 'operator only' }));
  app.get('/api/swarm/apps/catalog', (_req, res) => res.json({ repo: 'fixture', apps: parseCatalog(STORE_DOC) }));
  app.get('/api/updates', (_req, res) => res.json({ apps: [] }));
  app.get('/api/dev-console/access', (_req, res) => res.json({ superAdmin: false }));
  app.get('/api/auth/user', (_req, res) => res.json({ guestMode: false }));
  app.get('/api/swarm/apps/access-matrix', (_req, res) => res.json({ apps: [], assignments: [] }));
  app.get('/applications/', (_req, res) => res.sendFile(resolve('src/pages/applications/index.html')));
  // The page's own modules and shared assets, exactly as registerStaticHtmlPageRoute serves them.
  // A module script fails atomically, so without these the page renders blank rather than failing.
  app.use('/applications', express.static(resolve('src/pages/applications'), { index: false }));
  app.use('/shared', express.static(resolve('src/shared')));
  app.use('/fonts', express.static(resolve('src/pages/cockpit/fonts')));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The Lab step reads the two feeds over loopback on PORT — pointing it at this fixture server is
  // what makes the registration executable here instead of a path typed into a list.
  vi.stubEnv('PORT', String((server.address() as AddressInfo).port));
  browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise<void>((done) => server?.close(() => done()));
  vi.unstubAllEnvs();
});

/**
 * @description Open the catalog with no external network, waiting for both shelves to render.
 * @returns The loaded page.
 */
async function openCatalog(): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  await page.goto(`${base}/applications/`);
  await page.waitForSelector('.app-row[data-name="linked-home"]');
  await page.waitForSelector('[data-store-name="store-home"]');
  return page;
}

describe('the applications catalog shows what each bundle plugs into', () => {
  it('renders every bundle state the catalog is supposed to distinguish', async () => {
    const page = await openCatalog();
    try {
      // Connected: a live connection for the provider the bundle requires.
      expect(await rowText(page, 'linked-home')).toContain('connected');
      expect(await page.locator('.app-row[data-name="linked-home"] .conn-chip.state-connected').innerText())
        .toContain('SmartThings');
      expect(await page.locator('.app-row[data-name="linked-home"] .ready-badge').getAttribute('class'))
        .toContain('ready-ok');

      // Credential needed: this box can offer SmartThings, and its optional Google Home it cannot,
      // which must NOT be what decides the row — an optional provider is a feature, not a blocker.
      const waiting = page.locator('.app-row[data-name="waiting-home"]');
      expect(await waiting.locator('.ready-badge').innerText()).toBe('credential needed');
      expect(await waiting.locator('.ready-badge').getAttribute('title')).toContain('Slack');
      expect(await waiting.locator('.conn-chip.state-needs-credential').count()).toBe(1);
      expect(await waiting.locator('.conn-chip.state-unavailable').count()).toBe(1);

      // Unavailable here: the REQUIRED provider has no OAuth client on this deployment.
      const blocked = page.locator('.app-row[data-name="blocked-home"]');
      expect(await blocked.locator('.ready-badge').innerText()).toBe('unavailable here');
      expect(await blocked.locator('.ready-badge').getAttribute('title')).toContain('does not offer');

      // A bundle that plugs into nothing says nothing — silence, not a fabricated verdict.
      const plain = page.locator('.app-row[data-name="plain-app"]');
      expect(await plain.locator('.ready-badge').count()).toBe(0);
      expect(await plain.locator('.conn-list').count()).toBe(0);
    } finally { await page.close(); }
  }, 60000);

  it('shows the store shelf what a package plugs into before it is installed', async () => {
    const page = await openCatalog();
    try {
      const store = page.locator('[data-store-name="store-home"]');
      // The Discover row is the AVAILABLE state, and it still reports live provider state — that
      // is what tells an operator whether installing this package leaves them anything to do.
      expect(await store.locator('.conn-chip.state-connected').innerText()).toContain('SmartThings');
      expect(await store.locator('.ready-badge').innerText()).toBe('connected');
      expect(await store.innerText()).toContain('Ready'); // the store lifecycle badge, unchanged
    } finally { await page.close(); }
  }, 60000);

  // THE HONESTY CASE. An unreadable broker is not evidence that nothing is connected.
  it('says connections unknown — and claims nothing else — when the broker answers 500', async () => {
    brokerOk = false;
    const page = await openCatalog();
    try {
      const body = await page.locator('body').innerText();
      expect(body).toContain('connections unknown');
      expect(body).not.toContain('credential needed');
      expect(body).not.toContain('unavailable here');
      expect(await page.locator('.ready-badge.ready-ok').count()).toBe(0);
      expect(await page.locator('.conn-chip.state-connected').count()).toBe(0);
      // Every declared provider still renders — the row says what the bundle needs, and admits it
      // does not know the state, which is a different statement from "not connected".
      expect(await page.locator('.app-row[data-name="waiting-home"] .conn-chip.state-unknown').count()).toBe(2);
    } finally { await page.close(); brokerOk = true; }
  }, 60000);
});

describe('the AI Test Lab step over the same two feeds', () => {
  const scenario = APP_REGISTRY_SCENARIOS.find((item) => item.id === 'app-catalog-connector-readiness');

  it('is registered with both regression suites attached', () => {
    expect(scenario).toBeDefined();
    expect(scenario!.regressionTests?.map((test) => test.path)).toEqual([
      'tests/unit/app-catalog-connector-readiness.spec.ts',
      'tests/unit/app-catalog-connectors-browser.spec.ts',
    ]);
  });

  it('passes while both feeds answer, and fails loudly when the broker does not', async () => {
    const ok = await scenario!.steps[0].run('', {});
    expect(ok.state).toBe('pass');
    expect(ok.detail).toContain('provider id(s)');
    brokerOk = false;
    try {
      const broken = await scenario!.steps[0].run('', {});
      // A 500 from the broker is a real failure, not a "degraded" shrug: the catalog cannot answer
      // its own question, and a Lab step that shrugged would train everyone to ignore it.
      expect(broken.state).toBe('fail');
      expect(broken.detail).toContain('HTTP 500');
    } finally { brokerOk = true; }
  }, 60000);
});
