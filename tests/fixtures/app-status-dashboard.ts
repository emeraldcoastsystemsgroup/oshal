/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-145 REAL-BOUNDARY fixture. One express listener on 127.0.0.1 carrying the REAL swarm-app router (real SwarmAppService, real manifest resolution, real getAppStatusPlan, and the shipped app-group-setup.html served by the real /:name/setup-dashboard route) alongside synthetic packages answering at their OWN declared mountPaths and the real /shared/ui assets the page links. Nothing on the request path is mocked: the plan is fetched over HTTP and the probe path the plan names is answered at that same origin. Doubled, and named as such: the installation repository (in-memory records instead of Postgres), the pg driver behind the D5 jarvis_tasks read, and the caller's identity middleware.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import {
  SwarmAppService,
  readAppTaskFallback,
  type SwarmAppManifest,
  type SwarmApplicationRecord,
  type SwarmAppRepository,
} from '@/features/swarm-apps';
import { createSwarmAppRoutes } from '@/app/routes/swarm-app-routes';
import type { AgentProfileRepository } from '@/entities/agent';

/** The synthetic subject every request in this fixture is made as. Never a real account. */
export const FIXTURE_CALLER = 'auth0|status-probe-viewer';

/**
 * @description Build a synthetic package manifest: one session-admitting route, one surface.
 * @param name - Stable synthetic identity.
 * @param extra - The declarations under test.
 * @returns The manifest.
 */
function manifest(name: string, extra: Record<string, unknown> = {}): SwarmAppManifest {
  return {
    name,
    displayName: `${name} display`,
    suite: 'ai-productivity',
    routes: [{ module: `routes/${name}.js`, factory: 'f', mountPath: `/api/${name}`, auth: 'oidc' }],
    ui: { static: [{ toolName: `${name}-home`, label: 'Home', icon: 'i', iframeUrl: `/api/${name}/ui` }] },
    ...extra,
  } as unknown as SwarmAppManifest;
}

/**
 * @description Wrap a manifest as the installation record the repository answers with.
 * @param m - The manifest.
 * @param scope - Its visibility scope.
 * @param ownerSub - The owning subject, for a person-scoped record.
 * @returns The installation record.
 */
function record(m: SwarmAppManifest, scope: 'public' | 'person' = 'public', ownerSub: string | null = null): SwarmApplicationRecord {
  return {
    appId: m.name, name: m.name, displayName: m.displayName, description: '', version: '1.0.0',
    manifestPath: `/fixtures/${m.name}/oshal-app.yaml`, manifest: m, status: 'active', agentIds: [], toolNames: [],
    scope, ownerSub, tenantId: null, guestTierApproved: null, loadedAt: new Date(0), updatedAt: new Date(0),
  } as unknown as SwarmApplicationRecord;
}

/** Declares `summary:` and two readiness probes — highlights AND setup steps on the one page. */
export const OK = manifest('fixture-ok', {
  summary: { path: '/api/fixture-ok/summary', tilesPointer: '/tiles', itemsPointer: '/items' },
  readiness: [
    { name: 'connect-inbox', path: '/api/fixture-ok/state', readyPointer: '/ready', detailPointer: '/detail' },
    { name: 'import-history', path: '/api/fixture-ok/history', readyPointer: '/ready', detailPointer: '/detail' },
  ],
});
/** Its summary probe answers HTTP 500 on purpose — the deliberately broken probe. */
export const BROKEN = manifest('fixture-broken', { summary: { path: '/api/fixture-broken/summary', tilesPointer: '/tiles' } });
/** Its summary pointer resolves to the wrong type — "can't check", never an empty fact. */
export const TYPED = manifest('fixture-typed', { summary: { path: '/api/fixture-typed/summary', tilesPointer: '/tiles' } });
/** Declares nothing — the ADR-145 D5 jarvis_tasks fallback applies. */
export const QUIET = manifest('fixture-quiet');
/** Owned by somebody else — must 404 exactly like a name nothing installed. */
export const PRIVATE = manifest('fixture-private');

const RECORDS = [
  record(OK), record(BROKEN), record(TYPED), record(QUIET),
  record(PRIVATE, 'person', 'auth0|somebody-else'),
];

/** The rows the doubled pg driver answers the D5 fallback read with. Synthetic titles only. */
const TASK_ROWS = [
  { title: 'fixture-quiet display: swept the queue', status: 'done', created_at: new Date().toISOString() },
  { title: 'fixture-quiet display: reconciled the ledger', status: 'error', created_at: new Date().toISOString() },
];

/** What a case gets back: the live origin, the doubled driver's last statement, and shutdown. */
export interface AppStatusDashboardFixture {
  origin: string;
  lastQuery: () => { text: string; values: unknown[] } | null;
  resetQuery: () => void;
  close: () => Promise<void>;
}

/**
 * @description Start the real swarm-app router and the synthetic packages on one loopback listener,
 * so every assertion a case makes crosses an actual HTTP mount rather than a resolver double.
 * @returns The started fixture.
 */
export async function startAppStatusDashboardFixture(): Promise<AppStatusDashboardFixture> {
  let lastQuery: { text: string; values: unknown[] } | null = null;
  const repo = {
    list: async (status?: 'active' | 'inactive') => RECORDS.filter((r) => !status || r.status === status),
    findByName: async (name: string) => RECORDS.find((r) => r.name === name) ?? null,
  } as unknown as SwarmAppRepository;
  const pool = {
    query: async (text: string, values: unknown[]) => { lastQuery = { text, values }; return { rows: TASK_ROWS }; },
  } as unknown as Pool;
  const service = new SwarmAppService(pool, repo, {} as AgentProfileRepository);

  const app: Express = express();
  // The identity middleware is the one doubled boundary on the request path: every route below it
  // is the real one, mounted exactly as the composition root mounts it.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { oidc: unknown }).oidc = { user: { sub: FIXTURE_CALLER }, isAuthenticated: () => true };
    next();
  });
  app.use('/api/swarm/apps', createSwarmAppRoutes(service, undefined, {
    recentAppTasks: (sub, apps) => readAppTaskFallback(pool, sub, apps),
  }));
  // The shipped page links these exactly as it does in the running stack.
  app.use('/shared/ui', express.static(resolve(process.cwd(), 'src/shared/ui')));

  // The synthetic packages, each serving its OWN declared mountPath over the same listener.
  app.get('/api/fixture-ok/summary', (_req, res) => {
    res.json({
      tiles: [
        { label: 'Record', value: '116W-215L', tone: 'warn' },
        { label: 'P&L', value: '-$18.24', tone: 'catastrophic' },
        { label: 'Open', value: '3', tone: 'good' },
        { label: 'Queued', value: '9' },
        { label: 'Fifth', value: 'dropped' },
      ],
      items: [
        { text: 'Both strategies are failing their Brier gate', tone: 'warn' },
        { text: '4 documents awaiting your approval', fix: 'fixture-ok-home' },
        { text: 'A fix into a surface this app does not own', fix: 'fixture-broken-home' },
      ],
    });
  });
  app.get('/api/fixture-ok/state', (_req, res) => res.json({ ready: true, detail: 'Inbox connected' }));
  app.get('/api/fixture-ok/history', (_req, res) => res.json({ ready: false, detail: 'No history imported yet' }));
  app.get('/api/fixture-broken/summary', (_req, res) => res.status(500).json({ error: 'the app is broken' }));
  app.get('/api/fixture-typed/summary', (_req, res) => res.json({ tiles: 'not an array at all' }));

  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', () => done()));
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    lastQuery: () => lastQuery,
    resetQuery: () => { lastQuery = null; },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
