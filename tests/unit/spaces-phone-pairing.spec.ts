/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 mobile-ingest security guard. Proves the phone-pairing token boundary the Spaces LiDAR ingest depends on: a valid short-lived pairing token minted via insertCliToken authenticates the tokened ingest under the OWNER sub (ACCEPT), while a missing, foreign-Bearer, unknown, EXPIRED, or revoked credential resolves no owner and the requiresAuth gate 401s (REJECT — the rejection cases are the point, there are NO anonymous writes). Also pins the middleware lookup to the expiry guard (`expires_at > NOW()`) so the fake pool here and the real SQL can't drift, and confirms the mint stores only a hash + an expiry, never the plaintext.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import {
  CLI_TOKEN_PREFIX,
  generateCliToken,
  hashCliToken,
  insertCliToken,
  createCliTokenAuthMiddleware,
} from '../../src/app/routes/cli-token-routes';

interface TokenRow {
  id: string; user_sub: string; email: string | null; label: string;
  token_hash: string; created_at: Date; last_used_at: Date | null;
  revoked_at: Date | null; expires_at: Date | null;
}

/**
 * Scripted in-memory stand-in for the pg Pool. The `WHERE token_hash` branch mirrors the REAL
 * middleware SQL (`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`) so the guard
 * exercises the same acceptance rule the database enforces; every issued query is captured so the
 * test can assert the real code actually filters on expiry.
 */
function fakePool(): { pool: Pool; rows: TokenRow[]; queries: string[] } {
  const rows: TokenRow[] = [];
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      if (sql.includes('INSERT INTO oshal_cli_tokens')) {
        rows.push({
          id: String(params[0]), user_sub: String(params[1]), email: (params[2] as string | null) ?? null,
          label: String(params[3]), token_hash: String(params[4]),
          created_at: new Date(), last_used_at: null, revoked_at: null,
          expires_at: (params[5] as Date | null) ?? null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('WHERE token_hash')) {
        const now = Date.now();
        const hit = rows.find((r) =>
          r.token_hash === params[0] && r.revoked_at === null &&
          (r.expires_at === null || r.expires_at.getTime() > now));
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes('SET last_used_at')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, rows, queries };
}

/** Mirror the spaces callerSub: an ingest handler protected exactly like the /api/spaces mount. */
function buildIngestApp(pool: Pool): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createCliTokenAuthMiddleware(pool));
  // Stand-in for requiresAuth (same contract as createRequiresAuthWrapper): pass only when a
  // session/token was stamped, else 401 — the gate the /api/spaces mount applies to ingest.
  const requiresAuth = (req: Request, res: Response, next: NextFunction): void => {
    const oidc = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
    if (oidc?.isAuthenticated?.()) { next(); return; }
    res.status(401).json({ error: 'not_authenticated' });
  };
  app.post('/api/spaces/scans/import', requiresAuth, (req: Request, res: Response) => {
    const oidc = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc;
    const owner = oidc?.user?.sub || oidc?.user?.oid || null;
    if (!owner) { res.status(401).json({ error: 'not_authenticated' }); return; }
    res.status(201).json({ owner });
  });
  return app;
}

async function listen(app: express.Express): Promise<{ base: string; server: http.Server }> {
  const server = await new Promise<http.Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}/api/spaces/scans/import`, server };
}

const OWNER = 'owner-sub-123';

describe('spaces phone-pairing mint (insertCliToken)', () => {
  it('stores only a hash + an expiry and hands back the plaintext exactly once', async () => {
    const { pool, rows } = fakePool();
    const minted = await insertCliToken(pool, { sub: OWNER, email: 'o@example.com', label: 'phone pairing: iPhone', ttlMs: 60_000 });
    expect(minted.token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);
    expect(minted.expiresAt).not.toBeNull();
    expect(new Date(minted.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].token_hash).toBe(hashCliToken(minted.token));
    expect(JSON.stringify(rows)).not.toContain(minted.token); // plaintext never persisted
  });

  it('mints a non-expiring PAT when no ttl is given', async () => {
    const { pool, rows } = fakePool();
    const minted = await insertCliToken(pool, { sub: OWNER });
    expect(minted.expiresAt).toBeNull();
    expect(rows[0].expires_at).toBeNull();
  });
});

describe('spaces tokened ingest — security boundary', () => {
  it('ACCEPTS a valid pairing token and ingests under the owner sub', async () => {
    const { pool } = fakePool();
    const minted = await insertCliToken(pool, { sub: OWNER, label: 'phone pairing', ttlMs: 10 * 60_000 });
    const { base, server } = await listen(buildIngestApp(pool));
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.token}` },
        body: JSON.stringify({ title: 'garage' }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { owner: string }).owner).toBe(OWNER);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('REJECTS a missing, foreign-Bearer, or unknown credential (401, no anonymous write)', async () => {
    const { pool } = fakePool();
    const { base, server } = await listen(buildIngestApp(pool));
    try {
      const headerSets: Array<Record<string, string>> = [
        { 'Content-Type': 'application/json' },                                   // missing auth
        { 'Content-Type': 'application/json', Authorization: 'Bearer not-our-secret' }, // foreign bearer
        { 'Content-Type': 'application/json', Authorization: `Bearer ${generateCliToken()}` }, // unknown token
      ];
      for (const headers of headerSets) {
        const res = await fetch(base, { method: 'POST', headers, body: '{}' });
        expect(res.status).toBe(401);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('REJECTS an expired pairing token (401)', async () => {
    const { pool, rows, queries } = fakePool();
    const token = generateCliToken();
    rows.push({
      id: 'expired-1', user_sub: OWNER, email: null, label: 'phone pairing',
      token_hash: hashCliToken(token), created_at: new Date(Date.now() - 3_600_000),
      last_used_at: null, revoked_at: null, expires_at: new Date(Date.now() - 1_000), // already elapsed
    });
    const { base, server } = await listen(buildIngestApp(pool));
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      expect(res.status).toBe(401);
      // Pin the fake pool to the real rule: the middleware lookup must filter on expiry.
      expect(queries.some((q) => q.includes('WHERE token_hash') && q.includes('expires_at'))).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('REJECTS a revoked pairing token (401)', async () => {
    const { pool, rows } = fakePool();
    const token = generateCliToken();
    rows.push({
      id: 'revoked-1', user_sub: OWNER, email: null, label: 'phone pairing',
      token_hash: hashCliToken(token), created_at: new Date(),
      last_used_at: null, revoked_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
    });
    const { base, server } = await listen(buildIngestApp(pool));
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
