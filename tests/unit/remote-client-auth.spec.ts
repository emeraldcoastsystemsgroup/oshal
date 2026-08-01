/**
 * Remote-client worker-plane auth hardening guard (docs/backlog/hardening.md #7).
 *
 * Goes red if any of these regress:
 *  - the shared-secret compare reverts to a timing-oracle `===` (helper unit tests
 *    + a source tripwire on authorizeRemoteClient);
 *  - the router-local per-caller rate limiter is unmounted, stops being flag-gated
 *    (must be a no-op by default), or loses its per-clientId keying;
 *  - the node-token path breaks: the ENTIRE worker plane (register → heartbeat →
 *    enqueue → claim → complete) must work with ONLY a per-node token identity
 *    (the req.oidc shape createCliTokenAuthMiddleware injects) and NO shared
 *    secret configured, bound to the token owner's own devices;
 *  - the shared-secret branch loses its deprecation stamp (the observable that
 *    tracks re-enrollment progress until the secret is retired).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the remote-client auth hardening (timing-safe compare, per-caller rate limit, worker-plane-on-node-token proof)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | 2026-07-31 23:21:37 America/Chicago — Raises the first HTTP router boot timeout because full-suite dynamic import load can exceed 15s before the auth assertions execute.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { remoteClientRateLimitKey, timingSafeSecretEquals } from '../../src/features/remote-client';

const ENV_KEYS = [
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'OSHAL_ALLOW_LEGACY_UNOWNED',
  'REMOTE_CLIENT_SHARED_SECRET',
  'REMOTE_CLIENT_CONTROL_PLANE_TOKEN',
  'REMOTE_CLIENT_AUTH_HEADER',
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS',
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX',
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS_WINDOW_MS',
];
let savedEnv: Record<string, string | undefined>;

const SECRET = 'test-remote-secret';
const OWNER = 'auth0|node-token-owner';
const INTRUDER = 'auth0|node-token-intruder';

const ROUTES_SOURCE_PATH = path.resolve(__dirname, '../../src/app/routes/remote-client-routes.ts');

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('timingSafeSecretEquals', () => {
  it('matches only the exact secret', () => {
    expect(timingSafeSecretEquals(SECRET, SECRET)).toBe(true);
    // Same length, one character off — the case `===` leaked timing on.
    expect(timingSafeSecretEquals('test-remote-secreX', SECRET)).toBe(false);
    expect(timingSafeSecretEquals(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(timingSafeSecretEquals(`${SECRET}x`, SECRET)).toBe(false);
  });

  it('never matches an empty/absent candidate or an empty expected secret', () => {
    expect(timingSafeSecretEquals('', SECRET)).toBe(false);
    expect(timingSafeSecretEquals(null, SECRET)).toBe(false);
    expect(timingSafeSecretEquals(undefined, SECRET)).toBe(false);
    // An unset secret must not become a match-anything (or match-empty) credential.
    expect(timingSafeSecretEquals('', '')).toBe(false);
    expect(timingSafeSecretEquals('anything', '')).toBe(false);
  });
});

describe('remoteClientRateLimitKey', () => {
  it('keys the worker plane per clientId, never per shared IP', () => {
    const nodeA = remoteClientRateLimitKey({ path: '/node-a/tasks/next', ip: '10.0.0.9' });
    const nodeB = remoteClientRateLimitKey({ path: '/node-b/tasks/next', ip: '10.0.0.9' });
    expect(nodeA).toBe('client:node-a');
    expect(nodeB).toBe('client:node-b');
    // Two NAT'd nodes behind one IP land in different buckets — the load-bearing property.
    expect(nodeA).not.toBe(nodeB);
    expect(remoteClientRateLimitKey({ path: '/node-a/heartbeat', ip: '172.16.0.2' })).toBe('client:node-a');
  });

  it('falls back to an IP bucket for non-device surfaces (/register, the list)', () => {
    expect(remoteClientRateLimitKey({ path: '/register', ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    expect(remoteClientRateLimitKey({ path: '/', ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    // IPv6 goes through express-rate-limit's ipKeyGenerator (subnet bucket), not the raw address.
    const v6 = remoteClientRateLimitKey({ path: '/register', ip: '2001:db8:85a3::8a2e:370:7334' });
    expect(v6.startsWith('ip:')).toBe(true);
    expect(v6).not.toContain('7334');
  });
});

describe('authorizeRemoteClient wiring tripwires (source-level)', () => {
  const source = readFileSync(ROUTES_SOURCE_PATH, 'utf-8');

  it('compares the shared secret ONLY through the timing-safe helper', () => {
    expect(source).toContain('timingSafeSecretEquals(headerValue, sharedSecret)');
    expect(source).toContain('timingSafeSecretEquals(bearer, sharedSecret)');
    // A revert to the timing-oracle strict-equality compare goes red here.
    expect(source).not.toMatch(/(headerValue|bearer)\s*===\s*sharedSecret/);
    expect(source).not.toMatch(/sharedSecret\s*===\s*(headerValue|bearer)/);
  });

  it('mounts the flag-gated per-caller limiter AFTER the auth gate', () => {
    // 2026-07-24 adversarial-review fix: keying on the attacker-controllable /:clientId
    // ahead of auth let an unauthenticated flood mint a bucket per fabricated id and let a
    // known clientId be 429-starved by anonymous traffic. The limiter now mounts AFTER
    // authorizeRemoteClient so the clientId is proven; the global 1000/min/IP limiter bounds
    // unauthenticated floods. This tripwire is inverted from its original (pre-fix) assertion.
    const limiterAt = source.indexOf("makeLimiter('remote_clients'");
    const authAt = source.indexOf('router.use(authorizeRemoteClient)');
    expect(limiterAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(limiterAt);
    expect(source).toContain('keyGenerator: remoteClientRateLimitKey');
  });
});

describe('remote-client auth over HTTP', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  /**
   * Boots a fresh express app around the REAL remote-client router. The router
   * factory runs per boot, so the rate-limit flag env is re-read each time. The
   * oidc injector below mirrors the req.oidc shape createCliTokenAuthMiddleware
   * stamps for a `Bearer oshal_pat_…` node token — x-test-sub selects the owner.
   */
  async function bootApp(): Promise<string> {
    const { createRemoteClientRoutes } = await import('../../src/app/routes/remote-client-routes');
    const app = express();
    app.use(express.json());
    app.use(nodeTokenShapedOidc());
    app.use('/api/remote-clients', createRemoteClientRoutes());
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    return `http://127.0.0.1:${address.port}/api/remote-clients`;
  }

  function registrationBody(clientId: string): Record<string, unknown> {
    return {
      clientId,
      name: `Device ${clientId}`,
      transport: 'http',
      platform: 'windows',
      controlPlaneUrl: 'http://localhost:35457',
      capabilities: ['mcp.call-tool', 'shell.exec'],
      tags: ['test'],
    };
  }

  function taskBody(taskId: string, clientId: string): Record<string, unknown> {
    return {
      taskId,
      correlationId: `corr-${taskId}`,
      fromAgentId: 'test-suite',
      toAgentId: clientId,
      intent: 'mcp.call-tool',
      input: { name: 'shell.exec', arguments: { command: 'whoami' } },
      createdAt: new Date().toISOString(),
    };
  }

  it('admits the exact shared secret (stamped deprecated), rejects a same-length wrong one', async () => {
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    const base = await bootApp();

    const ok = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
      body: JSON.stringify(registrationBody('auth-secret-device')),
    });
    expect(ok.status).toBe(201);
    // The deprecation stamp is the observable that tracks which callers still ride the
    // swarm-wide secret; losing it silently un-deprecates the branch.
    expect(ok.headers.get('x-oshal-shared-secret-deprecated')).toBe('1');

    const wrongSameLength = SECRET.slice(0, -1) + (SECRET.endsWith('X') ? 'Y' : 'X');
    expect(wrongSameLength).toHaveLength(SECRET.length);
    const denied = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': wrongSameLength },
      body: JSON.stringify(registrationBody('auth-secret-device-2')),
    });
    expect(denied.status).toBe(401);

    // Bearer form of the shared secret also admits (the node daemon sends both).
    const viaBearer = await fetch(`${base}/auth-secret-device`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(viaBearer.status).toBe(200);
    expect(viaBearer.headers.get('x-oshal-shared-secret-deprecated')).toBe('1');
    // 30s: the first HTTP test pays the one-time dynamic import/transform of the router graph under full-suite load.
  }, 30_000);

  it('runs the ENTIRE worker plane on a node token with NO shared secret configured', async () => {
    // The BACKLOG-sanctioned replacement for the swarm-wide secret: a per-node
    // `oshal_pat_` token authenticates as its OWNER (upstream middleware), the
    // session branch admits it, and requireDeviceAccess binds it to owned devices.
    const base = await bootApp();
    const device = 'node-token-device';

    // Anonymous (no secret exists, no token) is rejected outright.
    const anon = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registrationBody(device)),
    });
    expect(anon.status).toBe(401);

    // Register: ownerSub is pinned server-side to the token owner (never self-asserted).
    const register = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
      body: JSON.stringify(registrationBody(device)),
    });
    expect(register.status).toBe(201);
    const registered = (await register.json()) as { client: { ownerSub?: string } };
    expect(registered.client.ownerSub).toBe(OWNER);
    // A session/token caller never gets the machine-trust deprecation stamp.
    expect(register.headers.get('x-oshal-shared-secret-deprecated')).toBeNull();

    // Heartbeat.
    const heartbeat = await fetch(`${base}/${device}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
      body: JSON.stringify({
        clientId: device,
        status: 'online',
        controlPlaneReachable: true,
        mcpReady: true,
        lastSeenAt: new Date().toISOString(),
      }),
    });
    expect(heartbeat.status).toBe(200);

    // Enqueue → claim → complete, all on the token identity.
    const enqueue = await fetch(`${base}/${device}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
      body: JSON.stringify(taskBody('node-token-task', device)),
    });
    expect(enqueue.status).toBe(201);

    const claim = await fetch(`${base}/${device}/tasks/next`, { headers: { 'x-test-sub': OWNER } });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as { claimed: boolean; task?: { taskId?: string } };
    expect(claimed.claimed).toBe(true);
    expect(claimed.task?.taskId).toBe('node-token-task');

    const complete = await fetch(`${base}/${device}/tasks/node-token-task/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
      body: JSON.stringify({ correlationId: 'corr-node-token-task', output: { ok: true } }),
    });
    expect(complete.status).toBe(200);

    // Another user's token cannot act on this device: per-node tokens are
    // owner-bound, unlike the swarm-wide secret they replace.
    const intruderClaim = await fetch(`${base}/${device}/tasks/next`, { headers: { 'x-test-sub': INTRUDER } });
    expect(intruderClaim.status).toBe(403);
    const intruderBeat = await fetch(`${base}/${device}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': INTRUDER },
      body: JSON.stringify({
        clientId: device,
        status: 'online',
        controlPlaneReachable: true,
        mcpReady: true,
        lastSeenAt: new Date().toISOString(),
      }),
    });
    expect(intruderBeat.status).toBe(403);
  }, 15_000);

  it('rate limiter is a no-op by default (flag off)', async () => {
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    const base = await bootApp();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/rl-off-device`, { headers: { 'x-remote-client-key': SECRET } });
      // Unregistered device → 404; NEVER 429 while the flag is off.
      expect(res.status).toBe(404);
    }
  }, 15_000);

  it('flag on: throttles the 3rd request for one clientId while another clientId still passes', async () => {
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    process.env.OSHAL_RATE_LIMIT_REMOTE_CLIENTS = 'on';
    process.env.OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX = '2';
    const base = await bootApp();

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/rl-hot-device`, { headers: { 'x-remote-client-key': SECRET } });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([404, 404, 429]);

    // Per-caller keying: a different clientId (same source IP) is NOT throttled.
    const other = await fetch(`${base}/rl-cool-device`, { headers: { 'x-remote-client-key': SECRET } });
    expect(other.status).toBe(404);
  }, 15_000);
});

/**
 * Simulates the authenticated identity a per-node token produces: the exact
 * req.oidc shape createCliTokenAuthMiddleware injects for `Bearer oshal_pat_…`
 * (cli-token-routes.ts) — which is how a node token reaches this router in prod
 * (the middleware is mounted globally BEFORE the /api/remote-clients mount).
 * x-test-sub selects the token owner; no header = anonymous.
 */
function nodeTokenShapedOidc() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sub = String(req.headers['x-test-sub'] || '').trim();
    if (sub) {
      (req as { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub, email: `${sub.replace(/[^a-z0-9]/gi, '-')}@example.test`, preferred_username: undefined },
        idToken: 'cli-token',
        accessToken: 'cli-token',
      };
    }
    next();
  };
}
