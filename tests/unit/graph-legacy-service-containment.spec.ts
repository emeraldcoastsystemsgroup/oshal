/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exhaustively drive every caller-scoped graph read against legacy victim-substitution headers, prove the exact SEC-01 refusal, and preserve OIDC/PAT owner precedence plus the explicitly retained write compatibility.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile the retained-write description with the implemented workload-delegation design: compatibility remains only for the explicit legacy rollout mode, not because the design is pending.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

const logSpies = vi.hoisted(() => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
  logger: logSpies,
  LOG_REDACT_OPTIONS: { paths: [], censor: '[redacted]' },
}));

const createGraphConnectorMock = vi.hoisted(() => vi.fn());
vi.mock('@/features/graph', () => ({
  createGraphConnector: createGraphConnectorMock,
  GRAPH_READ_ONLY_CODE: 'graph_read_only',
}));

import { serviceSecretOr } from '@/shared/middleware/authz';
import { createGraphRoutes } from '@/app/routes/graph-routes';

const SERVICE_SECRET = 'unit-graph-sec01-credential';
const OWNER = 'oidc|actual-owner';
const VICTIM = 'oidc|substituted-victim';
const READ_ENDPOINTS = [
  { method: 'POST', route: '/query', body: { aql: 'RETURN 1' } },
  { method: 'GET', route: '/neighbors?id=node-one&depth=1' },
  { method: 'GET', route: '/path?from=node-one&to=node-two' },
] as const;
const WRITE_ENDPOINTS = [
  { method: 'POST', route: '/nodes', body: { nodes: [{ id: 'node-one' }] } },
  { method: 'POST', route: '/edges', body: { edges: [{ from: 'node-one', to: 'node-two', type: 'owns' }] } },
] as const;

interface GraphHarness {
  app: express.Express;
  personGraphSubjects: string[];
}

/** Return a complete successful fake so each request reaches only the route/auth behavior. */
function graphHandle(): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return {
    readQuery: async () => [{ value: 1 }],
    neighbors: async () => [],
    shortestPath: async () => [],
    upsertNodes: async () => 1,
    upsertEdges: async () => 1,
  };
}

/** Build the real outer service-or-user mount with an injectable authenticated-user rail. */
function graphHarness(): GraphHarness {
  const personGraphSubjects: string[] = [];
  createGraphConnectorMock.mockReturnValue({
    getPersonGraph: async (sub: string) => {
      personGraphSubjects.push(sub);
      return graphHandle();
    },
  });
  const app = express();
  app.use(express.json());
  app.use(testUserPrincipal());
  const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'unauthorized' }); };
  app.use('/api/graph', serviceSecretOr(deny), createGraphRoutes());
  return { app, personGraphSubjects };
}

/** Simulate the verified req.oidc shape shared by browser OIDC and PAT middleware. */
function testUserPrincipal(): RequestHandler {
  return (req, _res, next) => {
    const sub = req.header('x-test-authenticated-sub');
    if (sub) {
      (req as unknown as { oidc: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub },
      };
    }
    next();
  };
}

/** Serve one app for a test and return its stable graph base URL plus cleanup. */
async function serve(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api/graph`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Issue one graph request with JSON parsing kept outside the assertions. */
async function hit(
  base: string,
  endpoint: { method: string; route: string; body?: unknown },
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${endpoint.route}`, {
    method: endpoint.method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: endpoint.method === 'GET' ? undefined : JSON.stringify(endpoint.body ?? {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Both legacy victim assertion forms supported by the compatibility resolver. */
function victimHeaders(kind: 'plain' | 'encoded'): Record<string, string> {
  return {
    'X-Service-Secret': SERVICE_SECRET,
    'X-Oshal-Workload-Id': `graph-reader-${kind}`,
    ...(kind === 'plain'
      ? { 'X-Oshal-User-Sub': VICTIM }
      : { 'X-Oshal-User-Sub-B64': Buffer.from(VICTIM).toString('base64url') }),
  };
}

describe('SEC-01 graph read containment', () => {
  beforeEach(() => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_SECRET);
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['plain', 'encoded'] as const)(
    'refuses %s victim substitution on every graph read before graph resolution',
    async (kind) => {
      const harness = graphHarness();
      const server = await serve(harness.app);
      try {
        for (const endpoint of READ_ENDPOINTS) {
          const result = await hit(server.base, endpoint, victimHeaders(kind));
          expect(result.status, `${endpoint.method} ${endpoint.route}`).toBe(403);
          expect(result.body).toEqual({ error: 'legacy_service_identity_not_allowed' });
        }
        expect(harness.personGraphSubjects).toEqual([]);
      } finally {
        await server.close();
      }
    },
  );

  it.each(['OIDC', 'PAT'])('keeps the authenticated %s owner under mixed victim headers', async () => {
    const harness = graphHarness();
    const server = await serve(harness.app);
    try {
      for (const endpoint of READ_ENDPOINTS) {
        const result = await hit(server.base, endpoint, {
          ...victimHeaders('plain'),
          'X-Test-Authenticated-Sub': OWNER,
        });
        expect(result.status, `${endpoint.method} ${endpoint.route}`).toBe(200);
      }
      expect(harness.personGraphSubjects).toEqual(READ_ENDPOINTS.map(() => OWNER));
      expect(harness.personGraphSubjects).not.toContain(VICTIM);
    } finally {
      await server.close();
    }
  });

  it('leaves invalid legacy credentials behind the ordinary auth wall', async () => {
    const harness = graphHarness();
    const server = await serve(harness.app);
    try {
      const result = await hit(server.base, READ_ENDPOINTS[0], {
        'X-Service-Secret': `${SERVICE_SECRET}x`,
        'X-Oshal-User-Sub': VICTIM,
      });
      expect(result.status).toBe(401);
      expect(harness.personGraphSubjects).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('retains legacy graph writes only while the durable delegation rollout remains in legacy mode', async () => {
    const harness = graphHarness();
    const server = await serve(harness.app);
    try {
      for (const endpoint of WRITE_ENDPOINTS) {
        expect((await hit(server.base, endpoint, victimHeaders('plain'))).status).toBe(200);
      }
      expect(harness.personGraphSubjects).toEqual(WRITE_ENDPOINTS.map(() => VICTIM));
    } finally {
      await server.close();
    }
  });

  it('pins the complete graph route inventory so a new read cannot bypass classification', () => {
    const source = fs.readFileSync(path.resolve('src/app/routes/graph-routes.ts'), 'utf8');
    const routes = [...source.matchAll(/router\.(get|post)\(\s*['"]([^'"]+)['"]/g)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
      .sort();
    expect(routes).toEqual([
      'GET /neighbors', 'GET /path', 'POST /edges', 'POST /nodes', 'POST /query',
    ]);
    for (const route of ['/api/graph/query', '/api/graph/neighbors', '/api/graph/path']) {
      expect(source).toContain(`rejectLegacyServiceIdentityForUserRead('${route}')`);
    }
  });
});
