/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS G14 guard: connected-badge-reflects-live-check. Over a real express app with every transport stubbed (no live token endpoints): a grant whose forced refresh throws `refresh 400` reports needs_reconnect with an actionable detail (the exact state the G-Squared box hid behind "1 connected"); a healthy refresh reports ok; the probe PROVABLY forces a refresh (forceRefresh:true asserted on the call — trusting the DB expiry again goes red); refresh-token-less rows verify via the account endpoint and degrade to an honest `unknown` (never a false red) when unverifiable; results cache ≤15min with ?fresh=1 bypass; anonymous is 401.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import {
  createConnectorLivenessRoutes,
  probeProviderLiveness,
  resetConnectorLivenessCacheForTesting,
  type LivenessDeps,
} from '@/app/routes/connector-liveness';
import type { ConnectionRow } from '@/app/routes/connector-tenancy';

function row(provider: string, withRefresh: boolean): ConnectionRow {
  return {
    connection_id: `conn-${provider}`, user_sub: 'auth0|admin', connected_by_sub: null, tenant_id: null,
    provider, label: null, account_key: 'default', is_default: true, account_email: 'admin@example.com',
    account_id: null, scopes: null, access_token: 'enc-access', refresh_token: withRefresh ? 'enc-refresh' : null,
    expiry: new Date(Date.now() + 3600_000),
  };
}

function makeDeps(overrides: Partial<LivenessDeps> = {}): LivenessDeps & { getToken: ReturnType<typeof vi.fn> } {
  const getToken = vi.fn(async () => 'fresh-token');
  return {
    listConnections: async () => [row('google', true)],
    resolveRow: async (_p, _s, provider) => row(provider, true),
    getToken,
    fetchAccount: async () => ({ email: 'admin@example.com', id: 'acct-1' }),
    ...overrides,
  } as LivenessDeps & { getToken: ReturnType<typeof vi.fn> };
}

function testIdentity() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sub = req.headers['x-test-sub'];
    if (sub) (req as unknown as { oidc: { user: { sub: string } } }).oidc = { user: { sub: String(sub) } };
    next();
  };
}

let server: Server | undefined;
async function start(deps: LivenessDeps): Promise<string> {
  const app = express();
  app.use(testIdentity());
  app.use('/api/connect', createConnectorLivenessRoutes({ pool: {} } as never, deps));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server!.address();
  if (!addr || typeof addr === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => resetConnectorLivenessCacheForTesting());
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => { server = undefined; resolve(); }) : resolve())));

const AUTH = { 'x-test-sub': 'auth0|admin' };

describe('connected-badge-reflects-live-check', () => {
  it('a refresh-400 grant reports needs_reconnect with an actionable detail — a row is not a badge', async () => {
    const deps = makeDeps({ getToken: vi.fn(async () => { throw new Error('refresh 400'); }) });
    const base = await start(deps);
    const res = await fetch(`${base}/api/connect/liveness`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].provider).toBe('google');
    expect(body.providers[0].status).toBe('needs_reconnect');
    expect(body.providers[0].detail).toMatch(/reconnect/i);
    expect(body.providers[0].detail).toMatch(/Connections screen/);
  });

  it('the probe FORCES a real refresh — it never trusts the DB expiry column', async () => {
    const deps = makeDeps();
    const base = await start(deps);
    await fetch(`${base}/api/connect/liveness`, { headers: AUTH });
    // The row's expiry is an hour out; without forceRefresh getValidAccessToken would just
    // decrypt-and-return and a dead grant would still read "connected" (the G14 bug).
    expect(deps.getToken).toHaveBeenCalledWith(
      expect.anything(), 'auth0|admin', 'google',
      expect.objectContaining({ forceRefresh: true, connectionId: 'conn-google' }),
    );
  });

  it('a healthy refresh reports ok', async () => {
    const base = await start(makeDeps());
    const body = await (await fetch(`${base}/api/connect/liveness`, { headers: AUTH })).json();
    expect(body.providers[0].status).toBe('ok');
  });

  it('refresh-token-less rows verify via the account endpoint; unverifiable is an honest unknown, never a false red', async () => {
    const noRefresh = (provider: string) => row(provider, false);
    // Identity comes back → ok.
    const okProbe = await probeProviderLiveness({}, 'auth0|admin', 'github', makeDeps({
      resolveRow: async () => noRefresh('github'),
    }));
    expect(okProbe.status).toBe('ok');
    // Provider yields no identity (blip or unsupported dialect) → unknown, NOT needs_reconnect.
    const blipProbe = await probeProviderLiveness({}, 'auth0|admin', 'github', makeDeps({
      resolveRow: async () => noRefresh('github'),
      fetchAccount: async () => ({ email: null, id: null }),
    }));
    expect(blipProbe.status).toBe('unknown');
  });

  it('results cache (≤15 min) and ?fresh=1 re-probes', async () => {
    const deps = makeDeps();
    const base = await start(deps);
    await fetch(`${base}/api/connect/liveness`, { headers: AUTH });
    const second = await (await fetch(`${base}/api/connect/liveness`, { headers: AUTH })).json();
    expect(deps.getToken).toHaveBeenCalledTimes(1);
    expect(second.providers[0].cached).toBe(true);
    await fetch(`${base}/api/connect/liveness?fresh=1`, { headers: AUTH });
    expect(deps.getToken).toHaveBeenCalledTimes(2);
  });

  it('a needs_reconnect result is remembered per-provider until fresh (the badge stays red on reload)', async () => {
    const getToken = vi.fn(async () => { throw new Error('refresh 400'); });
    const base = await start(makeDeps({ getToken }));
    await fetch(`${base}/api/connect/liveness`, { headers: AUTH });
    const again = await (await fetch(`${base}/api/connect/liveness`, { headers: AUTH })).json();
    expect(again.providers[0].status).toBe('needs_reconnect');
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('is auth-gated — anonymous gets 401 and no probe runs', async () => {
    const deps = makeDeps();
    const base = await start(deps);
    const res = await fetch(`${base}/api/connect/liveness`);
    expect(res.status).toBe(401);
    expect(deps.getToken).not.toHaveBeenCalled();
  });
});
