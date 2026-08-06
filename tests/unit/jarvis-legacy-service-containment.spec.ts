/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exhaustively cover the SEC-01 refusal on every owner-scoped Jarvis read, both victim-substitution header forms, mixed OIDC/PAT precedence, and a source-derived route inventory that fails when a new read lacks classification.
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

import { serviceSecretOr } from '@/shared/middleware/authz';
import { createJarvisRoutes } from '@/app/routes/jarvis-routes';

const SERVICE_SECRET = 'unit-jarvis-sec01-credential';
const OWNER = 'oidc|actual-jarvis-owner';
const VICTIM = 'oidc|substituted-jarvis-victim';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000001';
const READ_ENDPOINTS = [
  '/history?sessionId=owner-session',
  '/tasks',
  '/overview',
  '/ask/result?jobId=unknown-job',
  '/ask/jobs',
  `/visuals/${ARTIFACT_ID}`,
] as const;
const READ_PATH_TEMPLATES = [
  '/history', '/tasks', '/overview', '/ask/result', '/ask/jobs', '/visuals/:artifactId',
] as const;

interface QueryObservation {
  sql: string;
  params: unknown[];
}

interface JarvisHarness {
  app: express.Express;
  queries: QueryObservation[];
}

/** A minimal Pool/PoolClient pair that records owner bindings and satisfies schema bootstraps. */
function recordingPool(queries: QueryObservation[]): Record<string, unknown> {
  const query = async (sql: unknown, params: unknown[] = []) => {
    queries.push({ sql: String(sql), params });
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
}

/** Build only the dependencies exercised after an authenticated Jarvis read passes containment. */
function jarvisContext(queries: QueryObservation[]): Record<string, unknown> {
  return {
    pool: recordingPool(queries),
    taskStore: { get: async () => null },
    messageStore: { getByTask: async () => [] },
    ticketService: {
      listTickets: async () => [],
      updateStatus: async () => undefined,
    },
    swarm: { runtimeRegistryService: { listOnlineAgentIds: async () => [] } },
  };
}

/** Build the real service-or-user Jarvis mount with an injectable verified principal. */
function jarvisHarness(): JarvisHarness {
  const queries: QueryObservation[] = [];
  const app = express();
  app.use(express.json());
  app.use(testUserPrincipal());
  const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: 'unauthorized' }); };
  app.use(
    '/api/jarvis',
    serviceSecretOr(deny),
    createJarvisRoutes(jarvisContext(queries) as never, process.cwd()),
  );
  return { app, queries };
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

/** Serve one app for a test and return its stable Jarvis base URL plus cleanup. */
async function serve(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api/jarvis`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Both victim assertion forms accepted by the legacy compatibility resolver. */
function victimHeaders(kind: 'plain' | 'encoded'): Record<string, string> {
  return {
    'X-Service-Secret': SERVICE_SECRET,
    'X-Oshal-Workload-Id': `jarvis-reader-${kind}`,
    ...(kind === 'plain'
      ? { 'X-Oshal-User-Sub': VICTIM }
      : { 'X-Oshal-User-Sub-B64': Buffer.from(VICTIM).toString('base64url') }),
  };
}

/** Fetch and parse the JSON responses used by both denial and positive-path checks. */
async function hit(
  base: string,
  route: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, { headers });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('SEC-01 Jarvis read containment', () => {
  beforeEach(() => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_SECRET);
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['plain', 'encoded'] as const)(
    'refuses %s victim substitution on every owner-scoped Jarvis read',
    async (kind) => {
      const harness = jarvisHarness();
      const server = await serve(harness.app);
      try {
        for (const route of READ_ENDPOINTS) {
          const result = await hit(server.base, route, victimHeaders(kind));
          expect(result.status, route).toBe(403);
          expect(result.body).toEqual({ error: 'legacy_service_identity_not_allowed' });
        }
        expect(harness.queries.some((entry) => entry.params.includes(VICTIM))).toBe(false);
      } finally {
        await server.close();
      }
    },
  );

  it('returns the same exact refusal before the older missing-sub compatibility error', async () => {
    const harness = jarvisHarness();
    const server = await serve(harness.app);
    try {
      const result = await hit(server.base, '/tasks', { 'X-Service-Secret': SERVICE_SECRET });
      expect(result).toEqual({
        status: 403,
        body: { error: 'legacy_service_identity_not_allowed' },
      });
    } finally {
      await server.close();
    }
  });

  it.each(['OIDC', 'PAT'])('keeps the authenticated %s owner on every mixed-header read', async () => {
    const harness = jarvisHarness();
    const server = await serve(harness.app);
    try {
      for (const route of READ_ENDPOINTS) {
        const result = await hit(server.base, route, {
          ...victimHeaders('plain'),
          'X-Test-Authenticated-Sub': OWNER,
        });
        expect(result.status, route).not.toBe(403);
        expect([200, 404]).toContain(result.status);
      }
      expect(harness.queries.some((entry) => entry.params.includes(OWNER))).toBe(true);
      expect(harness.queries.some((entry) => entry.params.includes(VICTIM))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('pins every Jarvis GET as static/non-user or explicitly contained owner data', () => {
    const routeSource = fs.readFileSync(path.resolve('src/app/routes/jarvis-routes.ts'), 'utf8');
    const visualSource = fs.readFileSync(path.resolve('src/app/routes/jarvis-visual-response.ts'), 'utf8');
    const mainGets = [...routeSource.matchAll(/router\.get\(\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    const visualGets = [...visualSource.matchAll(/router\.get\(\s*['"]([^'"]+)['"]/g)]
      .map((match) => `/visuals${match[1]}`);
    const nonUserReads = new Set(['/', '/ui', '/assets/:file', '/catalog']);
    const ownerReads = [...new Set([...mainGets, ...visualGets])]
      .filter((route) => !nonUserReads.has(route))
      .sort();
    expect(ownerReads).toEqual([...READ_PATH_TEMPLATES].sort());

    const listStart = routeSource.indexOf('const USER_SCOPED_JARVIS_READS');
    const listEnd = routeSource.indexOf('] as const;', listStart);
    const containmentList = routeSource.slice(listStart, listEnd);
    for (const route of READ_PATH_TEMPLATES) expect(containmentList).toContain(`['${route}',`);
  });
});
