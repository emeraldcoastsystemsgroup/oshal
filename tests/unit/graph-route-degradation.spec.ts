/**
 * Graceful-degradation guard for the caller-scoped graph API (ADR-045 #2, graph-routes.ts).
 *
 * The graph engine (ArangoDB) is an OPTIONAL extension tier. Three failure shapes must all
 * degrade to a clear status with a body — never an unhandled 500:
 *   (a) ARANGO_URL UNSET → connector factory returns null → every endpoint 503
 *       graph_engine_unavailable (documented behavior; pinned so it can't regress);
 *   (b) ARANGO_URL SET but the engine UNREACHABLE at runtime — getPersonGraph rejects during the
 *       lazy provisioning round-trip. Before the sweep this rejection was unhandled inside the
 *       async route (→ 500 / hung request); it must now be caught, logged at ERROR, and returned as
 *       503 graph_engine_unreachable;
 *   (c) the handle resolves but a QUERY fails (bad AQL / traversal error) → the per-route 502,
 *       distinct from the connect-time 503 above.
 *
 * A FAKE connector is used throughout (createGraphConnector is mocked) — never a live engine.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard for graph-routes graceful degradation: unset → 503 unavailable, runtime-unreachable → 503 unreachable (was an unhandled 500), query error → 502; all logged, none a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

const logSpies = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
  logger: logSpies,
  LOG_REDACT_OPTIONS: { paths: [], censor: '[redacted]' },
}));

const createGraphConnectorMock = vi.hoisted(() => vi.fn());
vi.mock('@/features/graph', () => ({ createGraphConnector: createGraphConnectorMock }));

import { createGraphRoutes } from '@/app/routes/graph-routes';

/** A GraphHandle whose every operation rejects — models an engine that connects but errors per-query. */
function throwingHandle(): Record<string, unknown> {
  const boom = async (): Promise<never> => { throw new Error('AQL: syntax error near RETURN'); };
  return { rawQuery: boom, neighbors: boom, shortestPath: boom, upsertNodes: boom, upsertEdges: boom };
}

/** Build an app whose fake OIDC session carries `sub` (null = unauthenticated), mounting the real router. */
function appWithUser(sub: string | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { user: sub ? { sub } : undefined };
    next();
  });
  app.use('/api/graph', createGraphRoutes());
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null; raw: string }

async function hit(app: express.Express, method: string, route: string, body?: unknown): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/graph${route}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: method.toUpperCase() === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, raw };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Every graph endpoint, with a minimal valid body, so a sweep touches the whole surface. */
const ENDPOINTS: Array<{ method: string; route: string; body?: unknown }> = [
  { method: 'POST', route: '/query', body: { aql: 'RETURN 1' } },
  { method: 'GET', route: '/neighbors?id=n1&depth=1' },
  { method: 'GET', route: '/path?from=a&to=b' },
  { method: 'POST', route: '/nodes', body: { nodes: [{ id: 'n1' }] } },
  { method: 'POST', route: '/edges', body: { edges: [{ from: 'a', to: 'b', type: 'x' }] } },
];

const USER = 'auth0|graph-degrade';

describe('graph-routes graceful degradation (ADR-045)', () => {
  beforeEach(() => { createGraphConnectorMock.mockReset(); vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('(a) ARANGO_URL unset (connector null): every endpoint 503 graph_engine_unavailable, never 500', async () => {
    createGraphConnectorMock.mockReturnValue(null);
    const app = appWithUser(USER);
    for (const ep of ENDPOINTS) {
      const res = await hit(app, ep.method, ep.route, ep.body);
      expect(res.status, `${ep.method} ${ep.route}`).toBe(503);
      expect(res.body?.error).toBe('graph_engine_unavailable');
    }
  });

  it('(b) engine set but UNREACHABLE at runtime: getPersonGraph rejection → 503 graph_engine_unreachable, logged, NEVER 500', async () => {
    createGraphConnectorMock.mockReturnValue({
      getPersonGraph: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8529'); },
    });
    const app = appWithUser(USER);
    for (const ep of ENDPOINTS) {
      const res = await hit(app, ep.method, ep.route, ep.body);
      expect(res.status, `${ep.method} ${ep.route} must degrade, not 500`).toBe(503);
      expect(res.body?.error).toBe('graph_engine_unreachable');
      // Never swallowed silently — the runtime failure is logged at ERROR with context.
      expect(logSpies.error).toHaveBeenCalled();
    }
    // The engine address must never leak into the client body.
    const q = await hit(app, 'POST', '/query', { aql: 'RETURN 1' });
    expect(q.raw).not.toContain('127.0.0.1:8529');
  });

  it('(c) handle resolves but the QUERY fails: per-route 502 (distinct from the connect-time 503)', async () => {
    createGraphConnectorMock.mockReturnValue({ getPersonGraph: async () => throwingHandle() });
    const app = appWithUser(USER);
    for (const ep of ENDPOINTS) {
      const res = await hit(app, ep.method, ep.route, ep.body);
      expect(res.status, `${ep.method} ${ep.route} query error → 502`).toBe(502);
      expect(logSpies.error).toHaveBeenCalled();
    }
  });

  it('the auth gate still fires first: an unauthenticated caller gets 401, not a graph status', async () => {
    createGraphConnectorMock.mockReturnValue(null);
    const res = await hit(appWithUser(null), 'POST', '/query', { aql: 'RETURN 1' });
    expect(res.status).toBe(401);
    expect(res.body?.error).toBe('not_authenticated');
  });
});
