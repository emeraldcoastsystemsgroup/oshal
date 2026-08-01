/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard free-lane-rotation-is-observable-and-read-only for ADR-064 Plan-B step 3. The two properties that make this surface worth having are also the two that are easy to lose: it must show WHY a lane is down and WHETHER rotation still picks it (a bare connected/cooling pill left an operator nothing to act on, and an abandoned lane looked healthy), and it must be READ-ONLY — /resolve markUsed()s and would perturb the LRU order a polled health view reports, while platformFreeConnection() spends real completions from the shared key's daily quota. So this asserts the endpoint issues no write and no probe, that an unprobed platform lane reports 'unknown' rather than a guess, that no API key crosses the boundary, and that it is caller-scoped and 401s anonymously.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createFreeTierRoutes } from '@/app/routes/free-tier-routes';
import { freeTierRuntimeSnapshot } from '@/app/routes/free-tier-rotation';
import type { AppContext } from '@/app/composition/app-context';

const realFetch = globalThis.fetch;
const USER = { sub: 'free-lane-user', email: 'me@example.test' };
const OTHER_SUB = 'someone-else';
const DAY = 24 * 60 * 60_000;

/**
 * Pool double over the two tables the rotation read touches. Records every statement so a WRITE
 * on the read path is provable, not assumed.
 */
function stubPool(opts: { rows?: Record<string, unknown>[]; state?: Record<string, unknown>[] } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/oshal_free_tier_state/i.test(sql) && /SELECT/i.test(sql)) return { rows: opts.state ?? [], rowCount: (opts.state ?? []).length };
      if (/oshal_connections/i.test(sql)) {
        // Isolation belt: answer rows ONLY for the sub the query actually bound.
        const bound = params.map(String);
        const rows = (opts.rows ?? []).filter((r) => bound.includes(String(r.user_sub)));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { calls, pool: pool as never };
}

function appFor(user: Record<string, string> | null, pool: never): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/connect/free-tier', createFreeTierRoutes({ pool } as unknown as AppContext));
  return app;
}

async function hit(app: express.Express, route: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/connect/free-tier${route}`);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    return { status: res.status, body, raw };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('free-lane-rotation-is-observable-and-read-only', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Any outbound HTTP from a health read is a probe, and a probe spends real quota.
    fetchSpy = vi.fn(async () => { throw new Error('the rotation read must not make network calls'); });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('an anonymous caller gets 401 and the store is never read', async () => {
    const { pool, calls } = stubPool();
    globalThis.fetch = realFetch;
    const res = await hit(appFor(null, pool), '/rotation');
    expect(res.status).toBe(401);
    // createFreeTierRoutes fires ensureFreeTierSchema (CREATE TABLE IF NOT EXISTS) once at router
    // construction; that is boot-time DDL, not a read of anyone's data. What must not happen is a
    // DATA statement against either table on behalf of an unauthenticated caller.
    const dataReads = calls.filter(
      (c) => /oshal_connections|oshal_free_tier_state/i.test(c.sql) && !/CREATE\s+TABLE/i.test(c.sql),
    );
    expect(dataReads.map((c) => c.sql)).toEqual([]);
  });

  it('reports WHY a lane is down and WHEN it returns, not just that it is', async () => {
    const now = Date.now();
    const { pool } = stubPool({
      rows: [{
        connection_id: '11111111-1111-1111-1111-111111111111', user_sub: USER.sub,
        provider: 'free:groq', scopes: 'llama-3.3-70b-versatile', account_id: 'https://api.groq.com/openai/v1',
        is_default: true, tenant_id: null,
      }],
      state: [{
        connection_id: '11111111-1111-1111-1111-111111111111',
        cooldown_until: now + 90_000, last_used_at: now - 5_000, last_status: 'rate_limited',
      }],
    });
    globalThis.fetch = realFetch;
    const res = await hit(appFor(USER, pool), '/rotation');
    expect(res.status).toBe(200);
    const lanes = res.body?.lanes as Array<Record<string, unknown>>;
    expect(lanes).toHaveLength(1);
    expect(lanes[0].cooledDown).toBe(true);
    expect(lanes[0].lastStatus).toBe('rate_limited');            // WHY
    expect(Number(lanes[0].cooldownRemainingMs)).toBeGreaterThan(0); // WHEN it comes back
    expect(lanes[0].neverUsed).toBe(false);
    expect(lanes[0].stale).toBe(false);
  });

  it('a lane rotation has stopped picking is visible as stale, not as healthy', async () => {
    const now = Date.now();
    const { pool } = stubPool({
      rows: [
        { connection_id: 'aaaaaaaa-0000-0000-0000-000000000001', user_sub: USER.sub, provider: 'free:groq', scopes: 'm', account_id: '', is_default: false, tenant_id: null },
        { connection_id: 'aaaaaaaa-0000-0000-0000-000000000002', user_sub: USER.sub, provider: 'free:mistral', scopes: 'm', account_id: '', is_default: false, tenant_id: null },
      ],
      state: [
        { connection_id: 'aaaaaaaa-0000-0000-0000-000000000001', cooldown_until: 0, last_used_at: now - 3 * DAY, last_status: 'ok' },
        // no state row for …002 at all: never picked
      ],
    });
    globalThis.fetch = realFetch;
    const res = await hit(appFor(USER, pool), '/rotation');
    const lanes = res.body?.lanes as Array<Record<string, unknown>>;
    const stale = lanes.find((l) => l.connectionId === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    const never = lanes.find((l) => l.connectionId === 'aaaaaaaa-0000-0000-0000-000000000002')!;
    // Neither is cooling down, so the OLD surface would have shown both as plain "connected".
    expect(stale.cooledDown).toBe(false);
    expect(never.cooledDown).toBe(false);
    expect(stale.stale).toBe(true);
    expect(never.neverUsed).toBe(true);
    expect((res.body?.summary as Record<string, unknown>).stale).toBe(1);
    expect((res.body?.summary as Record<string, unknown>).neverUsed).toBe(1);
  });

  it('the read issues NO write and NO outbound probe', async () => {
    const { pool, calls } = stubPool({
      rows: [{ connection_id: 'bbbbbbbb-0000-0000-0000-000000000001', user_sub: USER.sub, provider: 'free:groq', scopes: 'm', account_id: '', is_default: false, tenant_id: null }],
    });
    const app = appFor(USER, pool);
    // fetch stays stubbed to throw: a probe would surface as a 500, and the write check below
    // would still be meaningful either way.
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await realFetch(`http://127.0.0.1:${port}/api/connect/free-tier/rotation`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // No UPDATE/INSERT/DELETE — markUsed would perturb the very LRU order this endpoint reports.
    const writes = calls.filter((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql));
    expect(writes.map((w) => w.sql)).toEqual([]);
    // No outbound HTTP — a probe spends the shared key's daily free-request quota.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is caller-scoped: another user\'s lanes never appear', async () => {
    const { pool } = stubPool({
      rows: [
        { connection_id: 'cccccccc-0000-0000-0000-000000000001', user_sub: USER.sub, provider: 'free:groq', scopes: 'm', account_id: '', is_default: false, tenant_id: null },
        { connection_id: 'cccccccc-0000-0000-0000-000000000002', user_sub: OTHER_SUB, provider: 'free:mistral', scopes: 'm', account_id: '', is_default: false, tenant_id: null },
      ],
    });
    globalThis.fetch = realFetch;
    const res = await hit(appFor(USER, pool), '/rotation');
    const ids = (res.body?.lanes as Array<Record<string, unknown>>).map((l) => l.connectionId);
    expect(ids).toContain('cccccccc-0000-0000-0000-000000000001');
    expect(ids).not.toContain('cccccccc-0000-0000-0000-000000000002');
  });

  it('never leaks an API key in the response body', async () => {
    const { pool } = stubPool({
      rows: [{
        connection_id: 'dddddddd-0000-0000-0000-000000000001', user_sub: USER.sub, provider: 'free:groq',
        scopes: 'm', account_id: '', is_default: false, tenant_id: null,
        access_token: 'sk-super-secret-value', refresh_token: 'rt-secret',
      }],
    });
    globalThis.fetch = realFetch;
    const res = await hit(appFor(USER, pool), '/rotation');
    expect(res.raw).not.toContain('sk-super-secret-value');
    expect(res.raw).not.toContain('rt-secret');
    expect(res.raw).not.toMatch(/apiKey|access_token|refresh_token/);
  });

  it('an unprobed platform lane reports UNKNOWN rather than guessing healthy', () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key-not-used';
    try {
      const snap = freeTierRuntimeSnapshot();
      expect(snap.configured).toBe(true);
      // Nothing has resolved the lane in this process, so there is no cached verdict.
      expect(snap.verdict).toBe('unknown');
      expect(snap.verdictExpiresAt).toBeNull();
      expect(snap.model).toBeNull();
      expect(snap.verdictScope).toBe('this-api-process');
      // The key must never appear anywhere in the snapshot.
      expect(JSON.stringify(snap)).not.toContain('test-key-not-used');
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it('an unconfigured platform lane says so instead of reporting unknown health', () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(freeTierRuntimeSnapshot().configured).toBe(false);
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it('the snapshot is non-probing: reading it makes no network call', () => {
    freeTierRuntimeSnapshot();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
