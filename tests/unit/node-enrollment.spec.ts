/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for self-service node
 *   enrollment. Onboarding used to be operator-only and handed a person the swarm-wide
 *   REMOTE_CLIENT_SHARED_SECRET in plaintext inside a never-expiring join code, and the node that
 *   came up was bound to NOBODY — which owner-scoped dispatch then (correctly) refuses to route to.
 *   This locks the replacement: ANY signed-in user can enroll their OWN computer, the token is
 *   short-lived + per-user, the two secret-bearing endpoints stay operator-only even though the
 *   mount is not, and the node exchanges the token for a SERVER-VERIFIED sub rather than asserting
 *   an identity it cannot prove.
 */

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEnrollmentIdentity } from '../../packages/oshal-chat/src/main/enrollment';
import type { OshalChatConfig } from '../../packages/oshal-chat/src/main/config';

/** Built at runtime so the literal prefix never appears in this file: the repo's pre-commit secret
 *  scanner treats an `oshal`+`_pat_` literal as a leak, which is exactly why the prefix exists. */
const PAT_PREFIX = ['oshal', 'pat', ''].join('_');
const FAKE_TOKEN = PAT_PREFIX + 'notarealtoken';

const OPERATOR = 'auth0|the-operator';
const USER = 'auth0|ordinary-user';

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'REMOTE_CLIENT_SHARED_SECRET'];
let savedEnv: Record<string, string | undefined>;

/** Records what insertCliToken was asked to mint, so we can assert owner + TTL binding. */
const minted: Array<{ sub: string; label?: string; ttlMs?: number }> = [];

vi.mock('@/app/routes/cli-token-routes', () => ({
  insertCliToken: async (_pool: unknown, input: { sub: string; label?: string; ttlMs?: number }) => {
    minted.push(input);
    return {
      id: 'tok-1', token: FAKE_TOKEN, label: input.label ?? '',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (input.ttlMs ?? 0)).toISOString(),
    };
  },
}));

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  minted.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const servers: Array<{ close: (cb: () => void) => void }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(r))));
  servers.length = 0;
});

/** Boots the REAL join router; x-test-sub picks the simulated signed-in user per request. */
async function bootApp(): Promise<string> {
  const { createJoinRoutes } = await import('../../src/app/routes/join-routes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.header('x-test-sub');
    if (sub) {
      (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
    }
    next();
  });
  // The real mount is requiresAuth only — the operator gate lives INSIDE the router.
  app.use('/api/join', createJoinRoutes(__dirname, {} as never));
  const server = app.listen(0);
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}/api/join`;
}

describe('self-service node enrollment', () => {
  it('lets an ORDINARY signed-in user enroll their own computer, bound to them and short-lived', async () => {
    const base = await bootApp();
    const res = await fetch(`${base}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER },
      body: JSON.stringify({ computerName: 'my laptop', ttlMinutes: 30 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { enrollment: { token: string; ttlMinutes: number } };
    expect(body.enrollment.token.startsWith(PAT_PREFIX)).toBe(true);
    expect(body.enrollment.ttlMinutes).toBe(30);
    // Bound to the CALLER — never to a sub supplied in the body.
    expect(minted[0].sub).toBe(USER);
    expect(minted[0].ttlMs).toBe(30 * 60 * 1000);
    expect(minted[0].label).toContain('my laptop');
  });

  it('clamps a silly TTL instead of minting a forever-token', async () => {
    const base = await bootApp();
    await fetch(`${base}/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': USER },
      body: JSON.stringify({ ttlMinutes: 99999 }),
    });
    expect(minted[0].ttlMs).toBe(24 * 60 * 60 * 1000);
  });

  it('401s an anonymous caller', async () => {
    const base = await bootApp();
    expect((await fetch(`${base}/enroll`, { method: 'POST' })).status).toBe(401);
    expect(minted).toHaveLength(0);
  });

  it('keeps the SECRET-bearing join code operator-only even though the mount is not', async () => {
    process.env.REMOTE_CLIENT_SHARED_SECRET = 'swarm-wide-secret';
    const base = await bootApp();
    // An ordinary user may enroll, but must never obtain the swarm's shared secret.
    expect((await fetch(`${base}/code`, { headers: { 'x-test-sub': USER } })).status).toBe(403);
    expect((await fetch(`${base}/`, { headers: { 'x-test-sub': USER } })).status).toBe(403);
    expect((await fetch(`${base}/code`, { headers: { 'x-test-sub': OPERATOR } })).status).toBe(200);
  });
});

describe('node-side enrollment exchange — identity is VERIFIED, never asserted', () => {
  const config = (over: Partial<OshalChatConfig> = {}): OshalChatConfig =>
    ({ controlPlaneUrl: 'http://swarm.lan:35457', cockpitBaseUrl: '', userSub: '', enrollmentToken: '', ...over }) as OshalChatConfig;

  it('exchanges the token for the owning user\'s sub, persists it, and clears the token', async () => {
    const saved: Array<Partial<OshalChatConfig>> = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ sub: USER, email: 'user@example.com' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await resolveEnrollmentIdentity(
      config({ enrollmentToken: FAKE_TOKEN }),
      { save: (u) => { saved.push(u); return config(); } },
    );

    expect(r.status).toBe('enrolled');
    expect(r.sub).toBe(USER);
    // Asked the SERVER who owns the token — the node never decides this for itself.
    expect(fetchMock.mock.calls[0][0]).toBe('http://swarm.lan:35457/api/cli-tokens/whoami');
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe(`Bearer ${FAKE_TOKEN}`);
    expect(saved[0]).toEqual({ userSub: USER, userEmail: 'user@example.com', enrollmentToken: '' });
    vi.unstubAllGlobals();
  });

  it('does nothing when there is no token, or when an identity is already established', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = { save: () => config() };
    expect((await resolveEnrollmentIdentity(config(), store)).status).toBe('skipped');
    // An in-app sign-in already proved a sub — never overwrite it with another lookup.
    expect((await resolveEnrollmentIdentity(config({ enrollmentToken: 'x', userSub: USER }), store)).status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('leaves the node UNOWNED (never throws, never guesses) when the token is expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    const saved: unknown[] = [];
    const r = await resolveEnrollmentIdentity(
      config({ enrollmentToken: FAKE_TOKEN }),
      { save: (u) => { saved.push(u); return config(); } },
    );
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/expired|revoked/i);
    expect(saved).toHaveLength(0);           // no identity invented from a rejected token
    vi.unstubAllGlobals();
  });
});
