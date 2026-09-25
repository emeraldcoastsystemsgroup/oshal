/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Test Lab registration guard for the data-model explorer: the card is in SCENARIOS, its regression suites exist and are exactly the suites `npm run test:data-model` runs, and its live step - driven over real HTTP against the real route and operator gate - passes for an operator, degrades (not fails) for a non-operator, and fails a snapshot whose shape is wrong.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Include the dedicated internal-producer command in the exact suite-registration guard.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requiresOperator } from '@/shared/middleware/authz';
import { createDataModelRoutes } from '@/app/routes/data-model-routes';
import { DATA_MODEL_SCENARIOS } from '@/app/routes/test-lab-data-model-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import type { DataModelService } from '@/features/data-model';

let server: Server;
let body: Record<string, unknown>;
const good = {
  generatedAt: 'now', database: 'oshal', unowned: [], declaredAbsent: [], sqlite: [], views: [],
  tables: [{ name: 'tickets', owners: ['@core'], access: { state: 'forced', scopes: [], ownerColumns: [] } }],
  apps: [{ name: '@core' }, { name: 'shop' }],
  integrations: [{ from: 'shop', to: '@core', kind: 'foreign-key', label: 'x' }],
};
const service = { snapshot: async () => body, stores: async () => [] } as unknown as DataModelService;
const cookieAuth: RequestHandler = (req, res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sub) { res.status(401).json({ error: 'Authentication required' }); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  next();
};

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'lab-operator');
  const app = express();
  app.use('/api/admin/data-model', cookieAuth, requiresOperator, createDataModelRoutes(service));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vi.stubEnv('PORT', String((server.address() as AddressInfo).port));
});
afterAll(async () => { vi.unstubAllEnvs(); await new Promise((r) => server.close(r)); });

describe('data-model Test Lab registration', () => {
  it('is registered, and its suites exist and match the documented local commands exactly', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    const commands = `${scripts['test:data-model']}\n${readFileSync('scripts/test-schema-alert-producer.cjs', 'utf8')}`;
    for (const scenario of DATA_MODEL_SCENARIOS) {
      expect(SCENARIOS.find((item) => item.id === scenario.id)).toBe(scenario);
      const paths = scenario.regressionTests!.map((t) => t.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(existsSync(resolve(path)), path).toBe(true);
      expect(new Set(commands.match(/tests\/unit\/[a-z0-9-]+\.spec\.ts/g))).toEqual(new Set(paths));
    }
  });

  it('passes for an operator reading a well-formed snapshot', async () => {
    body = good;
    const result = await DATA_MODEL_SCENARIOS[0].steps[0].run('test-user=lab-operator', {});
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('1 tables');
  });

  it('degrades, rather than fails, for a caller who is not an operator', async () => {
    body = good;
    const result = await DATA_MODEL_SCENARIOS[0].steps[0].run('test-user=someone', {});
    expect(result.state).toBe('degraded');
    expect(result.status).toBe(403);
  });

  it('fails a snapshot whose integration edge names an unknown owner', async () => {
    body = { ...good, integrations: [{ from: 'ghost', to: '@core', kind: 'dependency', label: 'x' }] };
    const result = await DATA_MODEL_SCENARIOS[0].steps[0].run('test-user=lab-operator', {});
    expect(result.state).toBe('fail');
  });
});
