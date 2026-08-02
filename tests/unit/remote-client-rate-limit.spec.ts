/**
 * /api/remote-clients per-caller rate limit — the guard for the "built but inert" bug.
 *
 * The limiter existed since the 2026-07-18 hardening pass but rode makeLimiter('remote_clients'),
 * which returns a pass-through unless OSHAL_RATE_LIMIT_REMOTE_CLIENTS is explicitly on — and that
 * flag was set in NO compose file, NO .env.example and NO running container. The control shipped,
 * was guarded, and throttled nothing. These assertions all fail if the limiter goes back to
 * opt-in, so "it's in the code" can never again be mistaken for "it's enforcing".
 *
 * Every assertion here is BEHAVIOURAL (real HTTP through real express), never a source substring.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — prove the remote-client limiter is ON with no env at all, caps at 300/min/caller, keys per clientId (not per IP), survives junk numeric overrides, and only turns off on an explicit operator opt-out; plus an end-to-end proof that the REAL router (not just the module) is limited by default.
 */

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import {
  REMOTE_CLIENT_RATE_LIMIT_DEFAULT_MAX,
  REMOTE_CLIENT_RATE_LIMIT_DEFAULT_WINDOW_MS,
  createRemoteClientRateLimiter,
} from '../../src/features/remote-client';

const ENV_KEYS = [
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS',
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX',
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS_WINDOW_MS',
  'REMOTE_CLIENT_SHARED_SECRET',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
];
let savedEnv: Record<string, string | undefined>;

const servers: Server[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers.length = 0;
});

/**
 * @description Mount a limiter on a bare express app whose only handler answers 200, so the
 * ONLY thing that can produce a non-200 is the limiter itself. Returns the app's base URL.
 * @param env - Environment the limiter reads its flag/overrides from.
 * @returns Base URL of the listening test server.
 */
function bootLimiterApp(env: NodeJS.ProcessEnv): string {
  const app = express();
  app.use(createRemoteClientRateLimiter(env));
  app.use((_req, res) => { res.status(200).json({ ok: true }); });
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
  return `http://127.0.0.1:${address.port}`;
}

/** Fire `count` GETs at one path and collect the status codes in order. */
async function statuses(base: string, path: string, count: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((await fetch(`${base}${path}`)).status);
  return out;
}

describe('createRemoteClientRateLimiter — enforcement posture', () => {
  it('is ENABLED with a completely empty environment (the inert-limiter regression)', async () => {
    // The whole bug: no flag set anywhere => no limiter. With an empty env the middleware must
    // still be a real limiter, which is observable as the standard RateLimit-* headers plus a
    // decreasing remaining count. A pass-through emits neither.
    const base = bootLimiterApp({});
    const first = await fetch(`${base}/node-a/tasks/next`);
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe(String(REMOTE_CLIENT_RATE_LIMIT_DEFAULT_MAX));

    const second = await fetch(`${base}/node-a/tasks/next`);
    const remaining = Number(second.headers.get('ratelimit-remaining'));
    expect(remaining).toBe(REMOTE_CLIENT_RATE_LIMIT_DEFAULT_MAX - 2);
  });

  it('ships a cap and window that actually bound a caller (300 requests / 60s)', () => {
    // Pinned so a future "tune" that effectively removes the ceiling has to be deliberate:
    // a node polls ~35 req/min, so 300 is ~8x headroom, not a rubber stamp.
    expect(REMOTE_CLIENT_RATE_LIMIT_DEFAULT_MAX).toBe(300);
    expect(REMOTE_CLIENT_RATE_LIMIT_DEFAULT_WINDOW_MS).toBe(60_000);
  });

  it('429s past the cap and keys the bucket PER CALLER, not per IP', async () => {
    const base = bootLimiterApp({ OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX: '2' });
    // Same source IP for every request below — the only thing that differs is the clientId.
    expect(await statuses(base, '/node-a/tasks/next', 3)).toEqual([200, 200, 429]);
    // A NAT sibling must not inherit the exhausted bucket…
    expect(await statuses(base, '/node-b/heartbeat', 2)).toEqual([200, 200]);
    // …and the throttled caller stays throttled on a DIFFERENT route of its own plane,
    // proving the key is the clientId segment rather than the full path.
    expect(await statuses(base, '/node-a/heartbeat', 1)).toEqual([429]);
  });

  it('answers a throttled caller with a machine-readable body, not an empty 429', async () => {
    const base = bootLimiterApp({ OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX: '1' });
    await fetch(`${base}/node-loud/tasks/next`);
    const blocked = await fetch(`${base}/node-loud/tasks/next`);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'remote-client rate limit exceeded; slow down' });
  });

  it('ignores junk / non-positive numeric overrides instead of degrading into no limit or no service', async () => {
    // max=0 in express-rate-limit admits NOTHING (every request 429s) and a 0 window never
    // resets — both are worse than the default, so unusable overrides must be discarded.
    for (const bad of ['0', '-5', 'abc', '']) {
      const base = bootLimiterApp({ OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX: bad, OSHAL_RATE_LIMIT_REMOTE_CLIENTS_WINDOW_MS: bad });
      const res = await fetch(`${base}/node-junk/tasks/next`);
      expect(res.status, `max=${JSON.stringify(bad)} must not brick the plane`).toBe(200);
      expect(res.headers.get('ratelimit-limit')).toBe(String(REMOTE_CLIENT_RATE_LIMIT_DEFAULT_MAX));
    }
  });

  it('honours a positive numeric window override', async () => {
    const base = bootLimiterApp({ OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX: '5', OSHAL_RATE_LIMIT_REMOTE_CLIENTS_WINDOW_MS: '1000' });
    const res = await fetch(`${base}/node-window/tasks/next`);
    expect(res.headers.get('ratelimit-limit')).toBe('5');
    // draft-6 RateLimit-Reset is the remaining seconds in the window: a 1s window rounds to ≤1.
    expect(Number(res.headers.get('ratelimit-reset'))).toBeLessThanOrEqual(1);
  });

  it('turns OFF only on an explicit operator opt-out', async () => {
    for (const off of ['off', 'false', '0', 'no', 'OFF']) {
      const base = bootLimiterApp({ OSHAL_RATE_LIMIT_REMOTE_CLIENTS: off, OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX: '1' });
      expect(await statuses(base, '/node-optout/tasks/next', 4), `flag=${off}`).toEqual([200, 200, 200, 200]);
    }
  });

  it('stays ON for values that are not an opt-out (a typo must not silently disable it)', async () => {
    for (const noise of ['on', 'true', '1', 'yes', 'enabled', 'disable', '']) {
      const base = bootLimiterApp({ OSHAL_RATE_LIMIT_REMOTE_CLIENTS: noise, OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX: '1' });
      expect(await statuses(base, '/node-typo/tasks/next', 2), `flag=${JSON.stringify(noise)}`).toEqual([200, 429]);
    }
  });
});

describe('the REAL /api/remote-clients router is per-caller limited out of the box', () => {
  /**
   * @description Boot the actual remote-client router (no shared secret, no session) exactly the
   * way server.ts mounts it. Anonymous callers are refused by authorizeRemoteClient, so this
   * proves the limiter reached the wiring — not just that the module compiles.
   * @returns Base URL of the mounted router.
   */
  async function bootRouter(): Promise<string> {
    const { createRemoteClientRoutes } = await import('../../src/app/routes/remote-client-routes');
    const app = express();
    app.use(express.json());
    app.use('/api/remote-clients', createRemoteClientRoutes());
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    return `http://127.0.0.1:${address.port}/api/remote-clients`;
  }

  it('throttles an AUTHENTICATED caller past the cap with the flag unset', async () => {
    // Flag deliberately NOT set — only the cap is lowered so the test is fast. Before the fix
    // this returned 404,404,404: the limiter was a pass-through in exactly this configuration,
    // which is the configuration every deployment actually runs.
    process.env.REMOTE_CLIENT_SHARED_SECRET = 'rl-router-secret';
    process.env.OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX = '2';
    const base = await bootRouter();
    const headers = { 'x-remote-client-key': 'rl-router-secret' };
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) seen.push((await fetch(`${base}/rl-real-device`, { headers })).status);
    // 404 = authenticated but no such registration; 429 = the limiter engaged.
    expect(seen).toEqual([404, 404, 429]);
  }, 30_000);

  it('rejects an ANONYMOUS flood at the auth gate before it can touch a node bucket', async () => {
    // Ordering proof: the limiter sits AFTER authorizeRemoteClient, so unauthenticated traffic
    // naming a real clientId can neither mint nor drain that client's bucket. If the limiter
    // ever moves back ahead of auth, the authenticated request below turns 429.
    process.env.REMOTE_CLIENT_SHARED_SECRET = 'rl-order-secret';
    process.env.OSHAL_RATE_LIMIT_REMOTE_CLIENTS_MAX = '2';
    const base = await bootRouter();
    for (let i = 0; i < 6; i++) {
      const anon = await fetch(`${base}/rl-victim-device`);
      expect(anon.status).toBe(401);
    }
    const authed = await fetch(`${base}/rl-victim-device`, { headers: { 'x-remote-client-key': 'rl-order-secret' } });
    expect(authed.status).toBe(404);
  }, 30_000);
});
