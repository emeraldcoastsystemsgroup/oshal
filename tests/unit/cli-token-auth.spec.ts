/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — proves the personal-access-token tier (src/app/routes/cli-token-routes.ts): the Bearer middleware stamps req.oidc ONLY for a valid unrevoked oshal_pat_ token (unknown/revoked/foreign-Bearer/existing-session paths all pass through untouched), plaintext never lands at rest (sha256 only), and the full loop works over a real express app with a scripted pool — trusted-service mint → Bearer whoami resolves the owner → owner-scoped list/revoke → revoked token no longer authenticates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import {
  CLI_TOKEN_PREFIX,
  generateCliToken,
  hashCliToken,
  createCliTokenAuthMiddleware,
  createCliTokenRoutes,
} from '../../src/app/routes/cli-token-routes';
import { serviceSecretOr } from '../../src/shared/middleware/authz';

const SECRET = 'unit-service-secret';

interface TokenRow {
  id: string; user_sub: string; email: string | null; label: string;
  token_hash: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
}

/** Scripted in-memory stand-in for the pg Pool — routes on SQL substrings. */
function fakePool(): { pool: Pool; rows: TokenRow[] } {
  const rows: TokenRow[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('INSERT INTO oshal_cli_tokens')) {
        rows.push({
          id: String(params[0]), user_sub: String(params[1]), email: (params[2] as string | null) ?? null,
          label: String(params[3]), token_hash: String(params[4]),
          created_at: new Date(), last_used_at: null, revoked_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('WHERE token_hash')) {
        const hit = rows.find((r) => r.token_hash === params[0] && r.revoked_at === null);
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes('SET last_used_at')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SET revoked_at')) {
        const hit = rows.find((r) => r.id === params[0] && r.user_sub === params[1] && r.revoked_at === null);
        if (hit) hit.revoked_at = new Date();
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes('FROM oshal_cli_tokens WHERE user_sub')) {
        return { rows: rows.filter((r) => r.user_sub === params[0]), rowCount: 0 };
      }
      // Schema bootstrap and anything else: succeed silently.
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, rows };
}

function fakeReq(headers: Record<string, string>, oidc?: unknown): Request {
  return { headers, path: '/x', oidc } as unknown as Request;
}

const ENV_KEYS = ['SWARM_SERVICE_SECRET', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('cli token primitives', () => {
  it('generates prefixed high-entropy tokens and never stores plaintext-compatible hashes', () => {
    const token = generateCliToken();
    expect(token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(CLI_TOKEN_PREFIX.length + 40);
    expect(hashCliToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCliToken(token)).not.toContain(token.slice(CLI_TOKEN_PREFIX.length));
  });
});

describe('createCliTokenAuthMiddleware', () => {
  it('stamps an authenticated req.oidc for a valid token', async () => {
    const { pool, rows } = fakePool();
    const token = generateCliToken();
    rows.push({
      id: 't1', user_sub: 'user-a', email: 'a@example.com', label: 'x',
      token_hash: hashCliToken(token), created_at: new Date(), last_used_at: null, revoked_at: null,
    });
    const req = fakeReq({ authorization: `Bearer ${token}` });
    await new Promise<void>((r) => void createCliTokenAuthMiddleware(pool)(req, {} as Response, (() => r()) as NextFunction));
    const oidc = (req as { oidc?: { isAuthenticated: () => boolean; user: { sub: string } } }).oidc;
    expect(oidc?.isAuthenticated()).toBe(true);
    expect(oidc?.user.sub).toBe('user-a');
  });

  it('leaves unknown, revoked, and foreign Bearer credentials unauthenticated', async () => {
    const { pool, rows } = fakePool();
    const revoked = generateCliToken();
    rows.push({
      id: 't2', user_sub: 'user-a', email: null, label: 'x',
      token_hash: hashCliToken(revoked), created_at: new Date(), last_used_at: null, revoked_at: new Date(),
    });
    for (const auth of [`Bearer ${generateCliToken()}`, `Bearer ${revoked}`, 'Bearer some-remote-client-secret']) {
      const req = fakeReq({ authorization: auth });
      await new Promise<void>((r) => void createCliTokenAuthMiddleware(pool)(req, {} as Response, (() => r()) as NextFunction));
      expect((req as { oidc?: unknown }).oidc).toBeUndefined();
    }
  });

  it('never overrides an existing authenticated session', async () => {
    const { pool } = fakePool();
    const session = { isAuthenticated: () => true, user: { sub: 'session-user' } };
    const req = fakeReq({ authorization: `Bearer ${generateCliToken()}` }, session);
    await new Promise<void>((r) => void createCliTokenAuthMiddleware(pool)(req, {} as Response, (() => r()) as NextFunction));
    expect((req as { oidc?: unknown }).oidc).toBe(session);
  });
});

describe('cli token routes — full loop over HTTP', () => {
  let server: http.Server;
  let base: string;
  let rows: TokenRow[];

  beforeEach(async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const fake = fakePool();
    rows = fake.rows;
    const app = express();
    app.use(express.json());
    app.use(createCliTokenAuthMiddleware(fake.pool));
    // Stand-in for requiresAuth: pass when the middleware stamped req.oidc, else 401 —
    // the same contract createRequiresAuthWrapper implements.
    const requiresAuthStub = (req: Request, res: Response, next: NextFunction): void => {
      const oidc = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
      if (oidc?.isAuthenticated?.()) { next(); return; }
      res.status(401).json({ error: 'unauthorized' });
    };
    app.use('/api/cli-tokens', serviceSecretOr(requiresAuthStub), createCliTokenRoutes(fake.pool));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}/api/cli-tokens`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => { server.close(() => r()); });
  });

  const serviceHeaders = { 'Content-Type': 'application/json', 'X-Service-Secret': SECRET, 'x-oshal-user-sub': 'user-a' };

  it('mint via trusted service → Bearer whoami resolves the owner → revoke kills it', async () => {
    const mint = await fetch(base, { method: 'POST', headers: serviceHeaders, body: JSON.stringify({ label: 'laptop' }) });
    expect(mint.status).toBe(201);
    const minted = await mint.json() as { id: string; token: string; label: string };
    expect(minted.token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);
    expect(minted.label).toBe('laptop');
    expect(rows[0].token_hash).toBe(hashCliToken(minted.token));
    expect(JSON.stringify(rows)).not.toContain(minted.token);

    const who = await fetch(`${base}/whoami`, { headers: { Authorization: `Bearer ${minted.token}` } });
    expect(who.status).toBe(200);
    expect(((await who.json()) as { sub: string }).sub).toBe('user-a');

    const list = await fetch(base, { headers: { Authorization: `Bearer ${minted.token}` } });
    const tokens = ((await list.json()) as { tokens: Array<{ id: string; revoked: boolean }> }).tokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0].revoked).toBe(false);

    const revoke = await fetch(`${base}/${minted.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${minted.token}` } });
    expect(((await revoke.json()) as { revoked: boolean }).revoked).toBe(true);

    const dead = await fetch(`${base}/whoami`, { headers: { Authorization: `Bearer ${minted.token}` } });
    expect(dead.status).toBe(401);
  });

  it('rejects unauthenticated mint and cross-user revoke', async () => {
    const anon = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(anon.status).toBe(401);

    const mint = await fetch(base, { method: 'POST', headers: serviceHeaders, body: JSON.stringify({ label: 'a' }) });
    const minted = await mint.json() as { id: string };
    const foreign = await fetch(`${base}/${minted.id}`, {
      method: 'DELETE',
      headers: { ...serviceHeaders, 'x-oshal-user-sub': 'user-b' },
    });
    expect(((await foreign.json()) as { revoked: boolean }).revoked).toBe(false);
  });
});
