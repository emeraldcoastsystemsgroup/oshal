/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Workflow Studio run-history read surface: a non-operator's list stays hard-scoped to their own owner_sub even when ?scope=all and ?ownerSub= are supplied (the parameters an attacker would reach for), an operator's ?scope=all really does drop the scope, ?ticketType= reaches the store verbatim (the definition→runs join the Runs panel depends on), and a cross-owner detail read answers 404 rather than 403 so run ids are not oracle-able. Asserts against the real router with a recording store double — the scoping decision under test is the router's, not the store's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createWorkflowRunRoutes } from '@/app/routes/workflow-run-routes';
import type {
  WorkflowRunDetail,
  WorkflowRunHistoryStore,
  WorkflowRunListOptions,
  WorkflowRunSummary,
} from '@/features/workflow-studio';

/** Native fetch captured before any test could stub the global. */
const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'studio-runs-operator-sub', email: 'ops@example.test' };
const OWNER = { sub: 'studio-runs-owner-sub', email: 'owner@example.test' };
const INTRUDER = { sub: 'studio-runs-intruder-sub', email: 'intruder@example.test' };

const RUN_ID = '11111111-2222-4333-8444-555555555555';

const SUMMARY: WorkflowRunSummary = {
  runId: RUN_ID,
  ticketId: 'ticket-abc-123',
  ownerSub: OWNER.sub,
  ticketType: 'sales-pipeline',
  workflowName: 'Sales Pipeline',
  status: 'completed',
  outcome: 'completed',
  reason: null,
  resumedCount: 0,
  startedAt: '2026-07-29T00:00:00Z',
  finishedAt: '2026-07-29T00:01:00Z',
  stepCount: 3,
};

const DETAIL: WorkflowRunDetail = { ...SUMMARY, steps: [] };

/**
 * A WorkflowRunHistoryStore double exposing only the two read methods the routes call, and
 * recording the options the router computed so the scoping decision can be asserted directly.
 */
function fakeStore(): {
  store: WorkflowRunHistoryStore;
  listRuns: ReturnType<typeof vi.fn>;
  getRun: ReturnType<typeof vi.fn>;
} {
  const listRuns = vi.fn(async (_options: WorkflowRunListOptions = {}) => [SUMMARY]);
  const getRun = vi.fn(async (_runId: string) => DETAIL);
  return { store: { listRuns, getRun } as unknown as WorkflowRunHistoryStore, listRuns, getRun };
}

/** requiresAuth stub mirroring OIDC: 401 when there is no session, else pass through. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(user: Record<string, string> | null, store: WorkflowRunHistoryStore): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  // The real mount in server.ts is `app.use('/api/workflow-studio', requiresAuth, router)`.
  app.use('/api/workflow-studio', requiresAuthStub, createWorkflowRunRoutes({ store }));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null }

async function hit(app: express.Express, route: string): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/workflow-studio${route}`);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Workflow Studio run-history routes — owner scoping + join key', () => {
  beforeEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    delete process.env.OSHAL_ALLOW_LEGACY_UNOWNED;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    delete process.env.OSHAL_ALLOW_LEGACY_UNOWNED;
  });

  it('rejects an unauthenticated list with 401 before the store is touched', async () => {
    const { store, listRuns } = fakeStore();
    const res = await hit(appFor(null, store), '/runs');
    expect(res.status).toBe(401);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('hard-scopes a NON-operator to their own sub even when ?scope=all&ownerSub= are supplied', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub; // OWNER is not an operator
    const { store, listRuns } = fakeStore();
    const res = await hit(
      appFor(OWNER, store),
      `/runs?scope=all&ownerSub=${encodeURIComponent(INTRUDER.sub)}`,
    );
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledTimes(1);
    const options = listRuns.mock.calls[0][0] as WorkflowRunListOptions;
    expect(options.ownerSub).toBe(OWNER.sub);
    expect(options.includeUnowned).toBe(false);
  });

  it('never widens a non-operator scope to unowned rows unless the legacy switch is on', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';
    const { store, listRuns } = fakeStore();
    await hit(appFor(OWNER, store), '/runs');
    const options = listRuns.mock.calls[0][0] as WorkflowRunListOptions;
    expect(options.ownerSub).toBe(OWNER.sub);
    expect(options.includeUnowned).toBe(true);
  });

  it("drops the owner scope for an operator's ?scope=all", async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store, listRuns } = fakeStore();
    const res = await hit(appFor(OPERATOR, store), '/runs?scope=all');
    expect(res.status).toBe(200);
    const options = listRuns.mock.calls[0][0] as WorkflowRunListOptions;
    expect(options.ownerSub).toBeUndefined();
  });

  it('scopes an operator to their own runs by default (no ?scope=all)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store, listRuns } = fakeStore();
    await hit(appFor(OPERATOR, store), '/runs');
    const options = listRuns.mock.calls[0][0] as WorkflowRunListOptions;
    expect(options.ownerSub).toBe(OPERATOR.sub);
  });

  it('passes ?ticketType= through verbatim — the definition→runs join key the Runs panel sends', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store, listRuns } = fakeStore();
    const res = await hit(appFor(OWNER, store), '/runs?ticketType=sales-pipeline&limit=50');
    expect(res.status).toBe(200);
    const options = listRuns.mock.calls[0][0] as WorkflowRunListOptions;
    expect(options.ticketType).toBe('sales-pipeline');
    expect(options.limit).toBe(50);
    // Scoping is not sacrificed for the filter.
    expect(options.ownerSub).toBe(OWNER.sub);
  });

  it('omits ticketType entirely when the caller asks for all their runs', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store, listRuns } = fakeStore();
    await hit(appFor(OWNER, store), '/runs?limit=50');
    const options = listRuns.mock.calls[0][0] as WorkflowRunListOptions;
    expect(options.ticketType).toBeUndefined();
  });

  it("answers 404 (not 403) on another owner's run detail so run ids are not oracle-able", async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store, getRun } = fakeStore();
    const res = await hit(appFor(INTRUDER, store), `/runs/${RUN_ID}`);
    expect(res.status).toBe(404);
    expect(res.body?.success).toBe(false);
    expect(getRun).toHaveBeenCalledWith(RUN_ID);
    // Identical shape to a genuinely missing run — no ownership signal leaks.
    expect(String(res.body?.error)).toContain(RUN_ID);
  });

  it('serves the run detail to its owner', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store } = fakeStore();
    const res = await hit(appFor(OWNER, store), `/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const run = res.body?.run as Record<string, unknown>;
    expect(run?.runId).toBe(RUN_ID);
    expect(run?.ticketId).toBe(SUMMARY.ticketId);
  });

  it("serves any owner's run detail to an operator", async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store } = fakeStore();
    const res = await hit(appFor(OPERATOR, store), `/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
  });

  it('rejects a non-uuid run id with 400 before the store is touched', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { store, getRun } = fakeStore();
    const res = await hit(appFor(OWNER, store), '/runs/not-a-uuid');
    expect(res.status).toBe(400);
    expect(getRun).not.toHaveBeenCalled();
  });
});
