/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the two /api/budgets READ endpoints the new cockpit Budgets surface consumes, which had none: GET / and GET /spend. Pins 401 for an unauthenticated caller before BudgetService is touched, that the caller identity handed to the service comes ONLY from the session (a body/query-supplied sub can never widen the list), that a non-operator's cross-user spend read is 403 while their own 'user'-scope self-read succeeds, and that an unreadable spend store answers 503 rather than a fabricated 0 (the surface renders null as "unknown", so a 0 here would be a lie with a number on it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createBudgetRoutes } from '@/app/routes/budget-routes';
import type { BudgetCaller, BudgetRecord, BudgetService } from '@/features/cost-governance';

/** Native fetch captured before any test could stub the global. */
const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'budgets-operator-sub', email: 'ops@example.test' };
const PLAIN = { sub: 'plain-user-sub', email: 'plain@example.test' };
const OTHER = 'someone-elses-sub';

function budgetRow(scopeKey: string): BudgetRecord {
  return {
    id: 1, scopeType: 'user', scopeKey, dailyUsd: 5, hard: false, enabled: true,
    setByOperator: false, createdAt: '2026-07-29T00:00:00Z', updatedAt: '2026-07-29T00:00:00Z',
  };
}

/**
 * A BudgetService double exposing only the two read methods these routes call, plus the spies
 * that let a test assert WHAT the route asked for (the caller identity, the scope, the window).
 */
function fakeService(spend: number | null = 1.25): {
  service: BudgetService;
  getBudgets: ReturnType<typeof vi.fn>;
  computeSpend: ReturnType<typeof vi.fn>;
} {
  const getBudgets = vi.fn(async (caller: BudgetCaller) => [budgetRow(caller.sub ?? '')]);
  const computeSpend = vi.fn(async () => spend);
  return {
    service: { getBudgets, computeSpend } as unknown as BudgetService,
    getBudgets,
    computeSpend,
  };
}

/** requiresAuth stub mirroring OIDC: 401 when there is no session, else pass through. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(user: Record<string, string> | null, service: BudgetService): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/budgets', createBudgetRoutes(requiresAuthStub, { pool: null, service }));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null }

async function hit(app: express.Express, route: string, init?: RequestInit): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/budgets${route}`, init);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /api/budgets — the caps list the Budgets surface reads', () => {
  beforeEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  it('rejects an unauthenticated caller with 401 before BudgetService is touched', async () => {
    const { service, getBudgets } = fakeService();
    const res = await hit(appFor(null, service), '/');
    expect(res.status).toBe(401);
    expect(getBudgets).not.toHaveBeenCalled();
  });

  it('scopes a non-operator to their OWN identity — operator:false and their session sub', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub; // PLAIN is not allowlisted
    const { service, getBudgets } = fakeService();
    const res = await hit(appFor(PLAIN, service), '/');
    expect(res.status).toBe(200);
    expect(getBudgets).toHaveBeenCalledWith({ sub: PLAIN.sub, operator: false });
    const budgets = res.body?.budgets as BudgetRecord[];
    expect(budgets.map((b) => b.scopeKey)).toEqual([PLAIN.sub]);
  });

  it('an allowlisted operator is handed operator:true (the deployment-wide list)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service, getBudgets } = fakeService();
    const res = await hit(appFor(OPERATOR, service), '/');
    expect(res.status).toBe(200);
    expect(getBudgets).toHaveBeenCalledWith({ sub: OPERATOR.sub, operator: true });
  });

  it('an empty operator allowlist leaves EVERY caller self-scoped (fail-closed)', async () => {
    // Nobody is an operator when neither env var is set.
    const { service, getBudgets } = fakeService();
    const res = await hit(appFor(OPERATOR, service), '/');
    expect(res.status).toBe(200);
    expect(getBudgets).toHaveBeenCalledWith({ sub: OPERATOR.sub, operator: false });
  });
});

describe('GET /api/budgets/spend — the per-row spend the surface joins onto each cap', () => {
  beforeEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  it('rejects an unauthenticated caller with 401 before any spend is computed', async () => {
    const { service, computeSpend } = fakeService();
    const res = await hit(appFor(null, service), `/spend?scope=user:${PLAIN.sub}`);
    expect(res.status).toBe(401);
    expect(computeSpend).not.toHaveBeenCalled();
  });

  it("denies a non-operator reading ANOTHER user's spend with 403 (service untouched)", async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service, computeSpend } = fakeService();
    const res = await hit(appFor(PLAIN, service), `/spend?scope=user:${OTHER}`);
    expect(res.status).toBe(403);
    expect(computeSpend).not.toHaveBeenCalled();
  });

  it('denies a non-operator reading an app/ticket scope with 403 (only self-scope is self-readable)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service, computeSpend } = fakeService();
    const res = await hit(appFor(PLAIN, service), '/spend?scope=app:intelligent-operations');
    expect(res.status).toBe(403);
    expect(computeSpend).not.toHaveBeenCalled();
  });

  it("allows a non-operator's OWN 'user'-scope read and passes the clamped window through", async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service, computeSpend } = fakeService(2.5);
    const res = await hit(appFor(PLAIN, service), `/spend?scope=user:${PLAIN.sub}&windowHours=168`);
    expect(res.status).toBe(200);
    expect(res.body?.spendUsd).toBe(2.5);
    expect(computeSpend).toHaveBeenCalledWith('user', PLAIN.sub, 168);
  });

  it('answers 503 (never a fabricated 0) when the spend store cannot be read', async () => {
    // The budget service is fail-open and returns null for "unknown". The route must NOT turn
    // that into 0 — the Budgets surface renders unknown as a dash, and a 0 here would be a lie.
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service } = fakeService(null);
    const res = await hit(appFor(OPERATOR, service), `/spend?scope=user:${OTHER}`);
    expect(res.status).toBe(503);
    expect(res.body?.spendUsd).toBeUndefined();
  });

  it('rejects a malformed scope with 400 rather than defaulting to some scope', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service, computeSpend } = fakeService();
    const res = await hit(appFor(OPERATOR, service), '/spend?scope=nonsense');
    expect(res.status).toBe(400);
    expect(computeSpend).not.toHaveBeenCalled();
  });
});
