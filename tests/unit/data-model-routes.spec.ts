/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Data-model explorer route guards over REAL HTTP with the REAL operator gate (requiresOperator + the operator allowlist): anonymous 401, non-operator 403 without the service ever being called, operator 200 for the snapshot and the store inventories, ?refresh=1 forwarded, a missing platform database answered 503 and any other failure 500 without leaking its message. Mirrors the server.ts mount: requiresAuth, then requiresOperator, then the router.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requiresOperator } from '@/shared/middleware/authz';
import { createDataModelRoutes } from '@/app/routes/data-model-routes';
import { noDatabaseError, type DataModelService } from '@/features/data-model';

let server: Server;
let base: string;
const calls: string[] = [];
let failure: Error | null = null;

const service: DataModelService = {
  snapshot: vi.fn(async (refresh?: boolean) => {
    calls.push(`snapshot:${Boolean(refresh)}`);
    if (failure) throw failure;
    return { generatedAt: 'now', database: 'oshal', tables: [{ name: 'tickets' }], views: [], apps: [], integrations: [], unowned: [], declaredAbsent: [], sqlite: [] } as never;
  }),
  stores: vi.fn(async () => { calls.push('stores'); return [{ store: 'cache', engine: 'Redis', status: 'ok', detail: '0 keys' }] as never; }),
};

/** Test stand-in for OIDC: `x-test-user` is the signed-in subject; no header = not signed in. */
const requiresAuth: RequestHandler = (req, res, next) => {
  const sub = req.headers['x-test-user'];
  if (!sub) { res.status(401).json({ error: 'Authentication required' }); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  next();
};

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'the-operator');
  const app = express();
  app.use('/api/admin/data-model', requiresAuth, requiresOperator, createDataModelRoutes(service));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

const get = async (path: string, user?: string) => {
  const res = await fetch(base + path, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, body: await res.json() as any };
};

describe('data-model explorer routes', () => {
  it('refuses anonymous callers with 401', async () => {
    calls.length = 0;
    expect((await get('/api/admin/data-model')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('refuses signed-in non-operators with 403 before touching the service', async () => {
    calls.length = 0;
    const res = await get('/api/admin/data-model', 'someone-else');
    expect(res.status).toBe(403);
    expect((await get('/api/admin/data-model/stores', 'someone-else')).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('serves the snapshot and the store inventories to an operator', async () => {
    calls.length = 0;
    const snap = await get('/api/admin/data-model', 'the-operator');
    expect(snap.status).toBe(200);
    expect(snap.body.tables[0].name).toBe('tickets');
    const stores = await get('/api/admin/data-model/stores', 'the-operator');
    expect(stores.status).toBe(200);
    expect(stores.body[0].engine).toBe('Redis');
    await get('/api/admin/data-model?refresh=1', 'the-operator');
    expect(calls).toEqual(['snapshot:false', 'stores', 'snapshot:true']);
  });

  it('answers 503 when the platform database is not configured', async () => {
    failure = noDatabaseError();
    const res = await get('/api/admin/data-model', 'the-operator');
    failure = null;
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('not configured');
  });

  it('answers 500 for any other failure without leaking its message', async () => {
    failure = new Error('internal detail zq7f3a: socket refused');
    const res = await get('/api/admin/data-model', 'the-operator');
    failure = null;
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('zq7f3a');
  });
});
