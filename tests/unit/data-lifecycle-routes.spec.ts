/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the /api/me data-lifecycle ROUTES the new cockpit My Data surface consumes. data-lifecycle.spec.ts covers the feature layer (exporters, tokens, the delete pass) but nothing pinned the HTTP boundary: this pins 401 on all three endpoints, that the export subject is the SESSION sub and a body/query-supplied sub cannot redirect it, that the export sets an attachment Content-Disposition (the surface links to it as a plain download), that delete-request refuses an operator account with 403 and fails CLOSED with 503 when no signing secret exists, and that delete-confirm rejects a missing/forged/foreign token without running the delete pass. Also pins that BOTH delete responses carry knownGaps — the surface prints them, and a delete that silently implied full coverage would be the dishonest outcome.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createDataLifecycleRouter } from '@/app/routes/data-lifecycle-routes';
import type { AppContext } from '@/app/composition/app-context';

/** Native fetch captured before any test could stub the global. */
const realFetch = globalThis.fetch;

const ME = { sub: 'me-data-sub', email: 'me@example.test' };
const OPERATOR = { sub: 'me-operator-sub', email: 'ops@example.test' };
const OTHER_SUB = 'someone-elses-sub';

interface QueryCall { sql: string; params: unknown[] }

/**
 * A Postgres double that answers every statement with an empty result set — enough for
 * buildAllExporters' information_schema discovery and for each exporter's own SELECT, and it
 * records the params so a test can prove which sub the pass was scoped to.
 */
function fakePool(): { pool: AppContext['pool']; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as AppContext['pool'], calls };
}

/** requiresAuth stub mirroring OIDC: 401 when there is no session, else pass through. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(user: Record<string, string> | null, pool: AppContext['pool']): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/me', createDataLifecycleRouter({ pool } as AppContext, requiresAuthStub));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null; headers: Headers }

async function hit(app: express.Express, route: string, init?: RequestInit): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/me${route}`, init);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { body = null; }
    return { status: res.status, body, headers: res.headers };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postJson(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
}

beforeEach(() => {
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  delete process.env.ARANGO_URL;
  // Port 1 is on the browser/undici blocked-port list, so the Chroma heartbeat fails instantly and
  // deterministically (no DNS wait, and no chance of hitting a real Chroma on a dev box) — which is
  // exactly the absent-engine no-op path the exporter is supposed to take.
  process.env.CHROMADB_URL = 'http://127.0.0.1:1';
  process.env.SESSION_SECRET = 'data-lifecycle-route-spec-secret';
});
afterEach(() => {
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  delete process.env.CHROMADB_URL;
  delete process.env.SESSION_SECRET;
});

describe('GET /api/me/export — the download the My Data surface links to', () => {
  it('rejects an unauthenticated caller with 401 before any store is read', async () => {
    const { pool, calls } = fakePool();
    const res = await hit(appFor(null, pool), '/export');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("builds the bundle for the SESSION sub and ignores a query-supplied sub", async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), `/export?sub=${OTHER_SUB}&userSub=${OTHER_SUB}`);
    expect(res.status).toBe(200);
    const manifest = res.body?.manifest as Record<string, unknown>;
    expect(manifest?.userSub).toBe(ME.sub);
    expect(JSON.stringify(res.body)).not.toContain(OTHER_SUB);
  });

  it('sets an attachment Content-Disposition so the browser saves it as a file', async () => {
    // The surface is a plain <a download> — fetching it into JS would discard the filename, so
    // the header is what makes the link work at all.
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="oshal-data-export-/);
  });

  it('declares the coverage gaps in the manifest (a bundle never implies full coverage)', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/export');
    expect(res.status).toBe(200);
    const manifest = res.body?.manifest as { knownGaps?: unknown[] };
    expect(Array.isArray(manifest?.knownGaps)).toBe(true);
    expect((manifest?.knownGaps ?? []).length).toBeGreaterThan(0);
  });
});

describe('POST /api/me/delete-request — step 1, the plan the surface shows before confirming', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(null, pool), '/delete-request', postJson());
    expect(res.status).toBe(401);
  });

  it('refuses an operator-allowlisted account with 403 and mints no token', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool } = fakePool();
    const res = await hit(appFor(OPERATOR, pool), '/delete-request', postJson());
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('operator-account');
    expect(res.body?.token).toBeUndefined();
  });

  it('fails CLOSED with 503 when no signing secret is configured (an unsigned confirm would be forgeable)', async () => {
    delete process.env.SESSION_SECRET;
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/delete-request', postJson());
    expect(res.status).toBe(503);
    expect(res.body?.token).toBeUndefined();
  });

  it('returns a token, an expiry, the per-store plan, and the coverage gaps', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/delete-request', postJson());
    expect(res.status).toBe(200);
    expect(typeof res.body?.token).toBe('string');
    expect(typeof res.body?.expiresAt).toBe('string');
    const stores = res.body?.stores as Array<Record<string, unknown>>;
    expect(Array.isArray(stores)).toBe(true);
    expect(stores.length).toBeGreaterThan(0);
    // Every row must declare deletability — the surface renders export-only rows as "NOT deleted".
    for (const s of stores) expect(typeof s.deletable).toBe('boolean');
    expect(stores.some((s) => s.deletable === false)).toBe(true);
    expect(Array.isArray(res.body?.knownGaps)).toBe(true);
  });
});

describe('POST /api/me/delete-confirm — step 2, the irreversible pass', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(null, pool), '/delete-confirm', postJson({ token: 'x' }));
    expect(res.status).toBe(401);
  });

  it('rejects a missing token with 400 and deletes nothing', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/delete-confirm', postJson({}));
    expect(res.status).toBe(400);
    expect(res.body?.outcomes).toBeUndefined();
  });

  it('rejects a forged token with 403 and deletes nothing', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/delete-confirm', postJson({ token: 'not.a.real-token' }));
    expect(res.status).toBe(403);
    expect(res.body?.outcomes).toBeUndefined();
  });

  it("rejects ANOTHER account's valid token with 403 (tokens are sub-bound)", async () => {
    const { pool } = fakePool();
    // Mint under ME, then present it as a different signed-in user.
    const minted = await hit(appFor(ME, pool), '/delete-request', postJson());
    expect(minted.status).toBe(200);
    const res = await hit(
      appFor({ sub: OTHER_SUB, email: 'other@example.test' }, pool),
      '/delete-confirm',
      postJson({ token: minted.body?.token }),
    );
    expect(res.status).toBe(403);
    expect(res.body?.outcomes).toBeUndefined();
  });

  it('refuses an operator account with 403 even when it holds a token', async () => {
    const { pool } = fakePool();
    const minted = await hit(appFor(OPERATOR, pool), '/delete-request', postJson());
    expect(minted.status).toBe(200); // not yet allowlisted
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await hit(appFor(OPERATOR, pool), '/delete-confirm', postJson({ token: minted.body?.token }));
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('operator-account');
  });

  it('executes the pass on a valid token and reports every store outcome, the audit flag, and the gaps', async () => {
    const { pool } = fakePool();
    const minted = await hit(appFor(ME, pool), '/delete-request', postJson());
    expect(minted.status).toBe(200);
    const res = await hit(appFor(ME, pool), '/delete-confirm', postJson({ token: minted.body?.token }));
    expect(res.status).toBe(200);
    const outcomes = res.body?.outcomes as Array<Record<string, unknown>>;
    expect(Array.isArray(outcomes)).toBe(true);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const o of outcomes) expect(['deleted', 'skipped', 'failed']).toContain(o.action);
    // The retained audit row is a reported fact, not an assumption — the surface WARNS when false.
    expect(typeof res.body?.auditRecorded).toBe('boolean');
    // knownGaps must ride along: success must never imply the uncovered stores were touched.
    expect(Array.isArray(res.body?.knownGaps)).toBe(true);
    expect((res.body?.knownGaps as unknown[]).length).toBeGreaterThan(0);
  });
});
