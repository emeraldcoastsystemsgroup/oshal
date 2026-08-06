/**
 * Connector marketplace lazy route gate regression guard.
 *
 * This crosses the real Express, filesystem spec parser, marketplace state-file, and per-user
 * enablement seams. Only authentication, Postgres query transport, and provider HTTP are scoped
 * doubles; the confirmation guard prevents provider traffic in the enabled action case.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove a catalog larger than 200 creates no parsed route footprint, current deployment and per-user gates run before spec loading, disabled routes are non-enumerating 404s, and enable-disable-re-enable works without an Express restart.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorMarketplaceService, loadConnectorSpec } from '@/app/connectors/runtime';
import { mountConnectorActionRoutes } from '@/app/routes/connector-action-routes';
import { mountConnectorSpecRoutes, type ConnectorSpecRouteDelegate } from '@/app/routes/connector-spec-routes';

const CATALOG_SIZE = 205;
const TARGET_PROVIDER = 'lazy-042';
let catalogDir = '';
let singleSpecDir = '';

interface RouteHarness {
  baseUrl: string;
  close(): Promise<void>;
  marketplace: ConnectorMarketplaceService;
  loadSpec: ReturnType<typeof vi.fn<(file: string) => ReturnType<typeof loadConnectorSpec>>>;
  specDelegate: ConnectorSpecRouteDelegate;
  providerGateChecks: ReturnType<typeof vi.spyOn>;
  catalogReads: ReturnType<typeof vi.spyOn>;
}

function connectorYaml(provider: string): string {
  const action = provider === TARGET_PROVIDER
    ? [
      'actions:',
      '  - name: create-item',
      '    method: POST',
      '    urlTemplate: /items',
      '    riskLevel: medium',
      '    description: Create one item',
      '    paramsSchema: { type: object, additionalProperties: false }',
    ]
    : [];
  return [
    `provider: ${provider}`,
    `displayName: ${provider}`,
    'version: 1.0.0',
    `baseUrl: https://${provider}.example.test`,
    'auth: { type: none }',
    'rateLimit: { burst: 1, perSecond: 1 }',
    'retry: { maxRetries: 0 }',
    'resources:',
    '  - name: status',
    `    tool: ${provider}-status`,
    '    method: GET',
    '    path: /status',
    ...action,
    'metadata:',
    '  category: Developer tools',
    '  description: Lazy route regression fixture',
    '',
  ].join('\n');
}

function identityMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const userSub = req.header('x-test-user-sub');
  if (userSub) (req as Request & { userSub?: string }).userSub = userSub;
  next();
}

function testPool() {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const isEnablementRead = /SELECT provider, enabled FROM oshal_connector_user_enablement/.test(sql);
      if (isEnablementRead && params?.[0] === 'blocked-user') {
        return { rows: [{ provider: TARGET_PROVIDER, enabled: false }] };
      }
      return { rows: [] };
    }),
  };
}

async function createHarness(name: string, specDir = singleSpecDir): Promise<RouteHarness> {
  const pool = testPool();
  const marketplace = new ConnectorMarketplaceService({
    specDir,
    statePath: path.join(specDir, `${name}-state.json`),
    cachePath: path.join(specDir, `${name}-catalog-cache.json`),
    defaultEnableAll: false,
    pool: pool as never,
  });
  const providerGateChecks = vi.spyOn(marketplace, 'isProviderEnabled');
  const catalogReads = vi.spyOn(marketplace, 'list');
  const loadSpec = vi.fn<(file: string) => ReturnType<typeof loadConnectorSpec>>(loadConnectorSpec);
  const app = express();
  app.use(express.json());
  const requiresAuth = identityMiddleware as RequestHandler;
  const specDelegate = mountConnectorSpecRoutes(app, { pool }, requiresAuth, {
    providerGate: marketplace,
    specDirs: [specDir],
    loadSpec,
  });
  mountConnectorActionRoutes(app, { pool }, requiresAuth, {
    providerGate: marketplace,
    specDirs: [specDir],
    loadSpec,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    marketplace,
    loadSpec,
    specDelegate,
    providerGateChecks,
    catalogReads,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function connectorGet(harness: RouteHarness, userSub?: string): Promise<globalThis.Response> {
  const headers = userSub ? { 'x-test-user-sub': userSub } : undefined;
  return fetch(`${harness.baseUrl}/api/connectors/${TARGET_PROVIDER}/_resources`, { headers });
}

function connectorAction(harness: RouteHarness, userSub: string): Promise<globalThis.Response> {
  return fetch(`${harness.baseUrl}/api/connectors/${TARGET_PROVIDER}/actions/create-item`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user-sub': userSub },
    body: JSON.stringify({ params: {} }),
  });
}

beforeAll(() => {
  catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-lazy-connectors-'));
  singleSpecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-lazy-connector-cycle-'));
  for (let index = 0; index < CATALOG_SIZE; index += 1) {
    const provider = `lazy-${String(index).padStart(3, '0')}`;
    fs.writeFileSync(path.join(catalogDir, `${provider}.yaml`), connectorYaml(provider), 'utf8');
  }
  fs.writeFileSync(path.join(singleSpecDir, `${TARGET_PROVIDER}.yaml`), connectorYaml(TARGET_PROVIDER), 'utf8');
});

beforeEach(() => {
  vi.stubEnv('CONNECTOR_ENABLED_PROVIDERS', '');
  vi.stubEnv('CONNECTOR_MARKETPLACE_DEFAULT_ENABLED', '');
});

afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  fs.rmSync(catalogDir, { recursive: true, force: true });
  fs.rmSync(singleSpecDir, { recursive: true, force: true });
});

describe('stable lazy connector route delegate', () => {
  it('registers a 200-plus catalog without parsing or retaining any provider spec', async () => {
    const harness = await createHarness('footprint', catalogDir);
    try {
      expect(fs.readdirSync(catalogDir).filter((file) => file.endsWith('.yaml'))).toHaveLength(CATALOG_SIZE);
      expect(harness.loadSpec).not.toHaveBeenCalled();
      expect(harness.providerGateChecks).not.toHaveBeenCalled();
      expect(harness.catalogReads).not.toHaveBeenCalled();
      expect(harness.specDelegate.cachedProviderCount()).toBe(0);

      expect((await connectorGet(harness)).status).toBe(401);
      const disabledRead = await connectorGet(harness, 'allowed-user');
      const disabledAction = await connectorAction(harness, 'allowed-user');
      expect(disabledRead.status).toBe(404);
      expect(await disabledRead.json()).toEqual({ ok: false, error: 'connector route not found' });
      expect(disabledAction.status).toBe(404);
      expect(await disabledAction.json()).toEqual({ ok: false, error: 'connector route not found' });
      expect(harness.loadSpec).not.toHaveBeenCalled();
      expect(harness.specDelegate.cachedProviderCount()).toBe(0);
      expect(harness.providerGateChecks).not.toHaveBeenCalled();
      expect(harness.catalogReads).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  }, 20_000);

  it('reflects disable, enable, disable, and re-enable without restarting Express', async () => {
    const harness = await createHarness('cycle');
    try {
      expect((await connectorGet(harness, 'allowed-user')).status).toBe(404);
      harness.marketplace.enableProvider(TARGET_PROVIDER);
      expect((await connectorGet(harness, 'allowed-user')).status).toBe(200);
      expect((await connectorAction(harness, 'allowed-user')).status).toBe(428);
      expect(harness.loadSpec).toHaveBeenCalledTimes(2);
      expect(harness.specDelegate.cachedProviders()).toEqual([TARGET_PROVIDER]);

      harness.marketplace.disableProvider(TARGET_PROVIDER);
      expect((await connectorGet(harness, 'allowed-user')).status).toBe(404);
      expect((await connectorAction(harness, 'allowed-user')).status).toBe(404);
      expect(harness.loadSpec).toHaveBeenCalledTimes(2);
      expect(harness.specDelegate.cachedProviderCount()).toBe(0);

      harness.marketplace.enableProvider(TARGET_PROVIDER);
      expect((await connectorGet(harness, 'allowed-user')).status).toBe(200);
      expect((await connectorAction(harness, 'allowed-user')).status).toBe(428);
      expect(harness.loadSpec).toHaveBeenCalledTimes(4);
    } finally {
      await harness.close();
    }
  });

  it('applies caller-specific disablement before either read or action spec loading', async () => {
    const harness = await createHarness('per-user');
    try {
      harness.marketplace.enableProvider(TARGET_PROVIDER);
      expect((await connectorGet(harness, 'blocked-user')).status).toBe(404);
      expect((await connectorAction(harness, 'blocked-user')).status).toBe(404);
      expect(harness.loadSpec).not.toHaveBeenCalled();

      expect((await connectorGet(harness, 'allowed-user')).status).toBe(200);
      expect((await connectorAction(harness, 'allowed-user')).status).toBe(428);
      expect(harness.loadSpec).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });
});
