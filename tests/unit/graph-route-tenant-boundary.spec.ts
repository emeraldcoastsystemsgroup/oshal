/**
 * Tenant-boundary + read-only guards for the caller-scoped graph API (ADR-045, graph-routes.ts).
 *
 * TWO invariants the HTTP layer had no guard for at all:
 *
 *  (1) **No route may reach the TENANT tier.** `GraphConnector` exposes `getPersonGraph(sub)` AND
 *      `getTenantGraph(tenant)`, and the tenant tier is a SHARED database. The connector's own doc
 *      comment says tenant MEMBERSHIP must be checked "upstream" — and there is no upstream check
 *      today, because no HTTP path reaches that tier at all. That makes "the route never resolves a
 *      tenant graph" load-bearing: the day someone adds `?tenant=` for convenience, any
 *      authenticated caller reads another tenant's shared graph and nothing fails. These cases hold
 *      the line by asserting getTenantGraph is NEVER called, whatever a caller sends — a tenant in
 *      the query string, in the body, or in a header.
 *
 *  (2) **POST /query is a READ endpoint and must behave like one.** It documented itself as "run a
 *      raw AQL read" while calling `rawQuery`, which passes the string straight to the engine — so
 *      a REMOVE/INSERT went through. It is scoped to the caller's own database, so this was never a
 *      cross-tenant hole; it was a contract the code contradicted, and a bot that mis-writes its own
 *      topology silently poisons the next investigation. The route now calls `readQuery`, and a
 *      refusal must surface as 400 `graph_read_only` (the caller's mistake) — NOT the 502 an engine
 *      failure gets, and never a 500.
 *
 * A FAKE connector is used throughout (createGraphConnector is mocked) — never a live engine. The
 * engine-side half of (2) — that ArangoDB's explain plan is what classifies the query — is proved
 * in graph-adapter-read-only.spec.ts against a stubbed Database.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins that the graph HTTP layer resolves ONLY getPersonGraph(callerSub) (never getTenantGraph, on any endpoint, for any caller-supplied tenant hint) and that POST /query maps a read-only refusal to 400 graph_read_only rather than 502/500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
// The barrel is mocked so no real connector is ever constructed. GRAPH_READ_ONLY_CODE has to come
// through as a literal (a vi.mock factory is hoisted above every import), so a case below asserts
// the literal still equals the real exported constant — otherwise renaming the code would leave
// this guard green while the route answered something else.
vi.mock('@/features/graph', () => ({
  createGraphConnector: createGraphConnectorMock,
  GRAPH_READ_ONLY_CODE: 'graph_read_only',
}));

import { createGraphRoutes } from '@/app/routes/graph-routes';
// Deep import ON PURPOSE: the '@/features/graph' barrel is mocked above, so the real error type has
// to be reached by its module id. Tests are exempt from the barrel-only rule.
import { GRAPH_READ_ONLY_CODE, GraphReadOnlyError } from '@/features/graph/services/graph-types';

const USER = 'auth0|graph-boundary';
const OTHER_TENANT = 'acme-corp';

/** A handle that records what it was asked and answers successfully. */
function recordingHandle(calls: string[]): Record<string, unknown> {
  return {
    readQuery: async (aql: string) => { calls.push(`readQuery:${aql}`); return [{ ok: 1 }]; },
    rawQuery: async (aql: string) => { calls.push(`rawQuery:${aql}`); return [{ ok: 1 }]; },
    neighbors: async () => { calls.push('neighbors'); return []; },
    shortestPath: async () => { calls.push('shortestPath'); return []; },
    upsertNodes: async () => { calls.push('upsertNodes'); return 1; },
    upsertEdges: async () => { calls.push('upsertEdges'); return 1; },
  };
}

interface FakeConnector {
  getPersonGraph: ReturnType<typeof vi.fn>;
  getTenantGraph: ReturnType<typeof vi.fn>;
}

/** Connector exposing BOTH tiers, so "the route never touches the tenant tier" is falsifiable. */
function bothTierConnector(handle: Record<string, unknown>): FakeConnector {
  return {
    getPersonGraph: vi.fn(async () => handle),
    getTenantGraph: vi.fn(async () => handle),
  };
}

/** App with a fake OIDC session carrying `sub`, mounting the REAL router. */
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

interface HitResult { status: number; body: Record<string, unknown> | null }

async function hit(
  app: express.Express,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/graph${route}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method.toUpperCase() === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Every endpoint, each carrying a caller-supplied TENANT hint in whichever place a future
 * "convenience" change would most plausibly read it from.
 */
const TENANT_PROBES: Array<{ method: string; route: string; body?: unknown }> = [
  { method: 'POST', route: `/query?tenant=${OTHER_TENANT}`, body: { aql: 'RETURN 1', tenant: OTHER_TENANT } },
  { method: 'GET', route: `/neighbors?id=n1&depth=2&tenant=${OTHER_TENANT}` },
  { method: 'GET', route: `/path?from=a&to=b&tenant=${OTHER_TENANT}` },
  { method: 'POST', route: `/nodes?tenant=${OTHER_TENANT}`, body: { nodes: [{ id: 'n1' }], tenant: OTHER_TENANT } },
  { method: 'POST', route: `/edges?tenant=${OTHER_TENANT}`, body: { edges: [{ from: 'a', to: 'b', type: 'x' }], tenant: OTHER_TENANT } },
];

describe('graph-routes tenant boundary (ADR-045) — HTTP reaches the PERSON tier only', () => {
  beforeEach(() => { createGraphConnectorMock.mockReset(); vi.clearAllMocks(); });

  it('never resolves a tenant graph, whatever tenant the caller names (query, body, or header)', async () => {
    const calls: string[] = [];
    const connector = bothTierConnector(recordingHandle(calls));
    createGraphConnectorMock.mockReturnValue(connector);
    const app = appWithUser(USER);

    for (const probe of TENANT_PROBES) {
      const res = await hit(app, probe.method, probe.route, probe.body, {
        'X-Tenant-Id': OTHER_TENANT,
        'X-OSHAL-Tenant': OTHER_TENANT,
      });
      expect(res.status, `${probe.method} ${probe.route}`).toBe(200);
    }

    // THE invariant: the shared tier was never reached, on any endpoint, by any hint.
    expect(connector.getTenantGraph).not.toHaveBeenCalled();
    // …and every request resolved the CALLER's own graph, named only by their sub.
    expect(connector.getPersonGraph).toHaveBeenCalledTimes(TENANT_PROBES.length);
    for (const call of connector.getPersonGraph.mock.calls) {
      expect(call[0]).toBe(USER);
    }
  });

  it('resolves the graph from the SESSION sub, not from anything the caller can set', async () => {
    const calls: string[] = [];
    const connector = bothTierConnector(recordingHandle(calls));
    createGraphConnectorMock.mockReturnValue(connector);

    // A caller claiming to be someone else in the body/query still gets their own graph. (The
    // trusted-service header path is a separate, secret-gated mechanism — see graph-routes callerSub.)
    const res = await hit(appWithUser(USER), 'POST', '/query?sub=auth0|victim', {
      aql: 'RETURN 1',
      sub: 'auth0|victim',
      userSub: 'auth0|victim',
    });

    expect(res.status).toBe(200);
    expect(connector.getPersonGraph).toHaveBeenCalledWith(USER);
    expect(connector.getTenantGraph).not.toHaveBeenCalled();
  });
});

describe('graph-routes POST /query is read-only (ADR-045)', () => {
  beforeEach(() => { createGraphConnectorMock.mockReset(); vi.clearAllMocks(); });

  it('the code this suite mocks into the barrel is the code the feature really exports', () => {
    expect(GRAPH_READ_ONLY_CODE).toBe('graph_read_only');
  });

  it('routes the caller AQL through readQuery — never the rawQuery escape hatch', async () => {
    const calls: string[] = [];
    createGraphConnectorMock.mockReturnValue(bothTierConnector(recordingHandle(calls)));

    const res = await hit(appWithUser(USER), 'POST', '/query', {
      aql: 'FOR n IN nodes RETURN n.id',
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual(['readQuery:FOR n IN nodes RETURN n.id']);
    expect(calls.some((c) => c.startsWith('rawQuery'))).toBe(false);
  });

  it('a refused WRITE is 400 graph_read_only (the caller is wrong), not 502 and never 500', async () => {
    const handle = {
      ...recordingHandle([]),
      readQuery: async () => { throw new GraphReadOnlyError('would write: nodes'); },
    };
    createGraphConnectorMock.mockReturnValue(bothTierConnector(handle));

    const res = await hit(appWithUser(USER), 'POST', '/query', {
      aql: 'FOR n IN nodes REMOVE n IN nodes',
    });

    expect(res.status).toBe(400);
    expect(res.body?.error).toBe(GRAPH_READ_ONLY_CODE);
    expect(String(res.body?.message)).toContain('READ queries only');
    // Refusing a bad request is not an engine incident — it must not be logged as an ERROR.
    expect(logSpies.warn).toHaveBeenCalled();
    expect(logSpies.error).not.toHaveBeenCalled();
  });

  it('a genuine engine failure still gets 502 — the two are distinguishable', async () => {
    const handle = {
      ...recordingHandle([]),
      readQuery: async () => { throw new Error('AQL: syntax error near RETURN'); },
    };
    createGraphConnectorMock.mockReturnValue(bothTierConnector(handle));

    const res = await hit(appWithUser(USER), 'POST', '/query', { aql: 'RETURN' });

    expect(res.status).toBe(502);
    expect(res.body?.error).not.toBe(GRAPH_READ_ONLY_CODE);
    expect(logSpies.error).toHaveBeenCalled();
  });
});
