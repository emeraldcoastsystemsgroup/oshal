/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ops-rails tool-budgets read surface: GET /api/budgets/state must reject an unauthenticated caller (401 via requiresAuth) AND an authed non-operator (403 via requiresOperator) BEFORE touching BudgetService, and hand a full read-only snapshot to an operator. Pins that the enforcement/spend service method is never invoked for a denied caller (no data leak past the gate).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createBudgetRoutes } from '@/app/routes/budget-routes';
import type { BudgetService, BudgetGovernanceState } from '@/features/cost-governance';

/** Native fetch captured before any test could stub the global. */
const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'ops-rails-operator-sub', email: 'ops@example.test' };
const PLAIN = { sub: 'plain-user-sub', email: 'plain@example.test' };

const SNAPSHOT: BudgetGovernanceState = {
  windowHours: 24,
  budgets: [
    {
      id: 1, scopeType: 'user', scopeKey: 'u1', dailyUsd: 5, hard: true,
      enabled: true, setByOperator: true, createdAt: '2026-07-19T00:00:00Z',
      updatedAt: '2026-07-19T00:00:00Z', spendUsd: 2.5,
    },
  ],
  events: [
    {
      id: 9, ts: '2026-07-19T00:00:00Z', scopeType: 'ticket', scopeKey: 'tk1',
      spendUsd: 6, capUsd: 5, action: 'halt', detail: { reason: 'hard-cap-exceeded' },
    },
  ],
};

/** A BudgetService double exposing only the method the /state route calls. */
function fakeService(): { service: BudgetService; getBudgetState: ReturnType<typeof vi.fn> } {
  const getBudgetState = vi.fn(async () => SNAPSHOT);
  return { service: { getBudgetState } as unknown as BudgetService, getBudgetState };
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

async function hit(app: express.Express, route: string): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/budgets${route}`);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /api/budgets/state — ops-rails tool-budgets operator read surface', () => {
  beforeEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  it('rejects an unauthenticated caller with 401 before the operator gate (BudgetService untouched)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service, getBudgetState } = fakeService();
    const res = await hit(appFor(null, service), '/state');
    expect(res.status).toBe(401);
    expect(getBudgetState).not.toHaveBeenCalled();
  });

  it('denies an authenticated NON-operator with 403 (BudgetService untouched)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub; // PLAIN is not on the allowlist
    const { service, getBudgetState } = fakeService();
    const res = await hit(appFor(PLAIN, service), '/state');
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('Operator privilege required');
    expect(getBudgetState).not.toHaveBeenCalled();
  });

  it('denies EVERY caller when the operator allowlist is empty (fail-closed)', async () => {
    // No OSHAL_OPERATOR_SUBS/EMAILS set — nobody is an operator.
    const { service } = fakeService();
    const res = await hit(appFor(OPERATOR, service), '/state');
    expect(res.status).toBe(403);
  });

  it('hands an operator the read-only snapshot (caps+spend + recent enforcement events)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { service, getBudgetState } = fakeService();
    const res = await hit(appFor(OPERATOR, service), '/state?windowHours=48&eventLimit=10');
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(getBudgetState).toHaveBeenCalledWith(48, 10);
    const budgets = res.body?.budgets as Array<Record<string, unknown>>;
    const events = res.body?.events as Array<Record<string, unknown>>;
    expect(Array.isArray(budgets)).toBe(true);
    expect(budgets[0]?.spendUsd).toBe(2.5);
    expect(Array.isArray(events)).toBe(true);
    expect(events[0]?.action).toBe('halt');
    expect(res.body?.windowHours).toBe(24);
  });
});
