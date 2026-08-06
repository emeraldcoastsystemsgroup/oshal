/**
 * Plaid Link connector route contract.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documented the existing Link/list/exchange regression and pinned its storage-only fake pool to legacy connector crypto; default-on DEK behavior is covered by the dedicated crypto suite.
 * -----------------------------------------------------------------------------
 */

import express from 'express';
import { test, expect } from '@playwright/test';
import { createConnectorsRoutes } from '@/app/routes/connectors-routes';

/**
 * Plaid Link connector (auth:'link') — ADR-048 corrected so Plaid is a first-class hub
 * connector (tokens in oshal_connections), not the app-private oshal_finance_items store.
 * Drives the two Plaid-specific routes against a fake pool + stubbed Plaid API.
 */

type Insert = { provider: string; accountEmail: string | null; accountId: string | null; label: string | null; accountKey: string };

function fakePool() {
  const rowsByKey = new Map<string, Insert>();
  return {
    rowsByKey,
    async query(text: string, params: unknown[] = []) {
      // INSERT first: the upsert's SQL contains "ON CONFLICT ... DO UPDATE SET", so a broad
      // UPDATE catch would otherwise swallow it before it's recorded.
      if (/INSERT INTO oshal_connections/i.test(text)) {
        const p = params as unknown[];
        const key = String(p[12]); // account_key = item_id → one row per linked bank
        rowsByKey.set(key, {
          provider: String(p[2]),
          accountEmail: p[3] == null ? null : String(p[3]),
          accountId: p[4] == null ? null : String(p[4]),
          label: p[11] == null ? null : String(p[11]),
          accountKey: key,
        });
        return { rows: [] };
      }
      if (/CREATE TABLE|ALTER TABLE|CREATE INDEX|UPDATE /i.test(text)) return { rows: [] };
      return { rows: [] }; // accessibleConnections etc. → empty is fine for these assertions
    },
  };
}

function mockOidc(app: express.Application, authed = true) {
  app.use((req, _res, next) => {
    (req as any).oidc = authed
      ? { isAuthenticated: () => true, user: { sub: 'user-plaid-001', email: 'owner@example.com' } }
      : { isAuthenticated: () => false };
    next();
  });
}

async function boot(pool: unknown, authed = true) {
  const app = express();
  app.use(express.json());
  mockOidc(app, authed);
  app.use('/api/connect', createConnectorsRoutes({ pool } as any));
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

function stubPlaid(items: Record<string, string> = { 'public-A': 'inst_chase' }, names: Record<string, string> = { inst_chase: 'Chase' }) {
  const original = global.fetch;
  // access_token → institution_id, so /item/get can resolve the label deterministically.
  const tokenToInst = new Map<string, string>();
  global.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/link/token/create')) {
      return { ok: true, status: 200, async json() { return { link_token: 'lt-fake', expiration: '2026-07-19T00:00:00Z' }; } } as Response;
    }
    if (url.endsWith('/item/public_token/exchange')) {
      const inst = items[String(body.public_token)] || 'inst_unknown';
      const access = `access-${body.public_token}`;
      const itemId = `item-${body.public_token}`;
      tokenToInst.set(access, inst);
      return { ok: true, status: 200, async json() { return { access_token: access, item_id: itemId }; } } as Response;
    }
    if (url.endsWith('/item/get')) {
      const inst = tokenToInst.get(String(body.access_token)) || 'inst_unknown';
      return { ok: true, status: 200, async json() { return { item: { institution_id: inst } }; } } as Response;
    }
    if (url.endsWith('/institutions/get_by_id')) {
      return { ok: true, status: 200, async json() { return { institution: { name: names[String(body.institution_id)] || 'Bank' } }; } } as Response;
    }
    if (!original) throw new Error(`Unexpected fetch: ${url}`);
    return original(input, init);
  };
  return () => { global.fetch = original; };
}

test.describe('Plaid Link connector (auth:link)', () => {
  const saved = { CID: process.env.PLAID_CLIENT_ID, SEC: process.env.PLAID_SECRET, SS: process.env.SESSION_SECRET, EC: process.env.OSHAL_ENVELOPE_CRYPTO };
  test.beforeEach(() => {
    process.env.SESSION_SECRET = 'plaid-test-secret';
    // The fake pool models connector rows, not the separate per-user DEK table.
    process.env.OSHAL_ENVELOPE_CRYPTO = 'false';
  });
  test.afterEach(() => {
    process.env.PLAID_CLIENT_ID = saved.CID; process.env.PLAID_SECRET = saved.SEC;
    process.env.SESSION_SECRET = saved.SS; process.env.OSHAL_ENVELOPE_CRYPTO = saved.EC;
  });

  test('/list shows plaid as a finance link-connector; configured tracks PLAID creds', async () => {
    delete process.env.PLAID_CLIENT_ID; delete process.env.PLAID_SECRET;
    let { server, base } = await boot(fakePool());
    try {
      let plaid = (await (await fetch(`${base}/api/connect/list`)).json()).providers.find((p: any) => p.id === 'plaid');
      expect(plaid).toMatchObject({ auth: 'link', category: 'finance', configured: false });
    } finally { server.close(); }

    process.env.PLAID_CLIENT_ID = 'cid'; process.env.PLAID_SECRET = 'sec';
    ({ server, base } = await boot(fakePool()));
    try {
      const plaid = (await (await fetch(`${base}/api/connect/list`)).json()).providers.find((p: any) => p.id === 'plaid');
      expect(plaid.configured).toBe(true);
    } finally { server.close(); }
  });

  test('link-token: 503 unconfigured, 401 unauthenticated, 200 with a link_token when ready', async () => {
    const restore = stubPlaid();
    try {
      delete process.env.PLAID_CLIENT_ID; delete process.env.PLAID_SECRET;
      let { server, base } = await boot(fakePool());
      try {
        const r = await fetch(`${base}/api/connect/plaid/link-token`, { method: 'POST' });
        expect(r.status).toBe(503);
      } finally { server.close(); }

      process.env.PLAID_CLIENT_ID = 'cid'; process.env.PLAID_SECRET = 'sec';
      ({ server, base } = await boot(fakePool(), false));
      try {
        const r = await fetch(`${base}/api/connect/plaid/link-token`, { method: 'POST' });
        expect(r.status).toBe(401);
      } finally { server.close(); }

      ({ server, base } = await boot(fakePool()));
      try {
        const r = await fetch(`${base}/api/connect/plaid/link-token`, { method: 'POST' });
        expect(r.status).toBe(200);
        expect((await r.json()).link_token).toBe('lt-fake');
      } finally { server.close(); }
    } finally { restore(); }
  });

  test('exchange: stores a plaid connection labeled by institution; distinct Items = distinct rows', async () => {
    process.env.PLAID_CLIENT_ID = 'cid'; process.env.PLAID_SECRET = 'sec';
    const restore = stubPlaid({ 'public-A': 'inst_chase', 'public-B': 'inst_fidelity' }, { inst_chase: 'Chase', inst_fidelity: 'Fidelity' });
    const pool = fakePool();
    const { server, base } = await boot(pool);
    try {
      const a = await fetch(`${base}/api/connect/plaid/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public_token: 'public-A' }),
      });
      expect(a.status).toBe(200);
      expect(await a.json()).toMatchObject({ success: true, account: 'Chase', itemId: 'item-public-A' });

      const b = await fetch(`${base}/api/connect/plaid/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public_token: 'public-B' }),
      });
      expect((await b.json()).account).toBe('Fidelity');

      // Two distinct Plaid Items → two rows (keyed on account_key = item_id), both provider 'plaid'.
      expect(pool.rowsByKey.size).toBe(2);
      const stored = Array.from(pool.rowsByKey.values());
      expect(stored.every((r) => r.provider === 'plaid')).toBe(true);
      expect(stored.map((r) => r.accountId).sort()).toEqual(['item-public-A', 'item-public-B']);
      expect(stored.map((r) => r.label).sort()).toEqual(['Chase', 'Fidelity']);
    } finally { server.close(); }
  });

  test('exchange rejects a missing public_token with 400', async () => {
    process.env.PLAID_CLIENT_ID = 'cid'; process.env.PLAID_SECRET = 'sec';
    const restore = stubPlaid();
    const { server, base } = await boot(fakePool());
    try {
      const r = await fetch(`${base}/api/connect/plaid/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(r.status).toBe(400);
    } finally { server.close(); restore(); }
  });

  test('generic /plaid/start does not redirect to an empty OAuth URL (503, routing-safe)', async () => {
    process.env.PLAID_CLIENT_ID = 'cid'; process.env.PLAID_SECRET = 'sec';
    const { server, base } = await boot(fakePool());
    try {
      const r = await fetch(`${base}/api/connect/plaid/start`, { redirect: 'manual' });
      expect(r.status).toBe(503); // plaid has no OAuth client → generic /start refuses, not a bogus 302
    } finally { server.close(); }
  });
});
