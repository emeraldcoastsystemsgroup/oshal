/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-5, budgets API): POST /api/budgets/remove validates its body, answers 200 { removed } when the service removed a row, 404 when nothing the caller may remove matched (with the honest reason for a person), 403 and 503 for the service's refusals, and never reads identity from the body; every successful set and remove writes one access-audit event (resourceType 'budget', resourceId '<scopeType>:<scopeKey>', budget.set / budget.remove) and a refused or failed write writes none; a person's request carries the person's own identity to the service whatever the body says; the parser trims, keeps the scope type exact, refuses a non-string key and caps it at 512 characters; the remove event carries the removed cap's figures. Each fails on the tree before the fix.
 */

import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitAuditEvent } = vi.hoisted(() => ({ emitAuditEvent: vi.fn(async (_pool: unknown, _event: Record<string, unknown>) => true) }));
vi.mock('@/features/governance', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), emitAuditEvent }));

import { createBudgetRoutes, parseRemoveBudgetBody } from '@/app/routes/budget-routes';
import type { BudgetService } from '@/features/cost-governance';

const OPERATOR = { sub: 'ops-operator-sub', email: 'ops@example.test' };
const PLAIN = { sub: 'plain-user-sub', email: 'plain@example.test' };
let server: ReturnType<express.Express['listen']> | undefined;
let base = '';

async function serve(service: Partial<BudgetService>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const raw = req.headers['x-fixture-user'];
    if (typeof raw === 'string' && raw) Object.assign(req, { oidc: { isAuthenticated: () => true, user: JSON.parse(raw) } });
    next();
  });
  const requiresAuth = (req: Request, res: Response, next: NextFunction) => {
    if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.status(401).json({ error: 'unauthorized' });
  };
  app.use('/api/budgets', createBudgetRoutes(requiresAuth, { pool: {} as never, service: service as BudgetService }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(path: string, user: Record<string, string> | null, body: unknown) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-fixture-user': JSON.stringify(user) } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => { emitAuditEvent.mockClear(); process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub; });
afterEach(async () => { delete process.env.OSHAL_OPERATOR_SUBS; await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())); server = undefined; });

describe('POST /api/budgets/remove', () => {
  it('removes through the service and writes one budget.remove audit event', async () => {
    const removeBudget = vi.fn(async () => ({ ok: true as const, removed: true, cap: { dailyUsd: 9, hard: true, enabled: false, setByOperator: true } }));
    await serve({ removeBudget });
    const res = await post('/api/budgets/remove', OPERATOR, { scopeType: 'app', scopeKey: 'little-monsters', sub: 'ignored' });
    expect(res).toEqual({ status: 200, body: { success: true, removed: true } });
    expect(removeBudget).toHaveBeenCalledWith({ sub: OPERATOR.sub, operator: true }, { scopeType: 'app', scopeKey: 'little-monsters' });
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(emitAuditEvent.mock.calls[0][1]).toMatchObject({ actorSub: OPERATOR.sub, action: 'budget.remove', resourceType: 'budget', resourceId: 'app:little-monsters', decision: 'allow', metadata: { operator: true, dailyUsd: 9, hard: true, enabled: false, setByOperator: true } });
  });

  it('hands the service the session identity, never the body\'s, for a person', async () => {
    const removeBudget = vi.fn(async () => ({ ok: true as const, removed: true, cap: null }));
    await serve({ removeBudget });
    const res = await post('/api/budgets/remove', PLAIN, { scopeType: 'user', scopeKey: 'victim', sub: 'victim', operator: true });
    expect(res.status).toBe(200);
    expect(removeBudget).toHaveBeenCalledWith({ sub: PLAIN.sub, operator: false }, { scopeType: 'user', scopeKey: 'victim' });
    expect(emitAuditEvent.mock.calls[0][1]).toMatchObject({ actorSub: PLAIN.sub, metadata: { operator: false } });
  });

  it('parses a remove body by the set parser\'s rules', () => {
    expect(parseRemoveBudgetBody({ scopeType: 'user', scopeKey: '  alice  ' })).toEqual({ scopeType: 'user', scopeKey: 'alice' });
    expect(parseRemoveBudgetBody({ scopeType: 'ticket', scopeKey: 'a'.repeat(512) })).toEqual({ scopeType: 'ticket', scopeKey: 'a'.repeat(512) });
    for (const body of [
      { scopeType: 'USER', scopeKey: 'alice' }, { scopeType: ['user'], scopeKey: 'alice' }, { scopeType: 'user', scopeKey: ['alice'] },
      { scopeType: 'user', scopeKey: { toString: () => 'alice' } }, { scopeType: 'user', scopeKey: '   ' }, { scopeType: 'app', scopeKey: 'a'.repeat(513) }, null, 'user:alice',
    ]) expect(parseRemoveBudgetBody(body), JSON.stringify(body)).toBeNull();
  });

  it('answers 404 with the honest reason when nothing the caller may remove matched, and writes no audit event', async () => {
    await serve({ removeBudget: vi.fn(async () => ({ ok: true as const, removed: false, cap: null })) });
    const person = await post('/api/budgets/remove', PLAIN, { scopeType: 'user', scopeKey: PLAIN.sub });
    expect(person.status).toBe(404);
    expect(String(person.body.error)).toContain('set by an administrator stays');
    const operator = await post('/api/budgets/remove', OPERATOR, { scopeType: 'ticket', scopeKey: 'tix-1' });
    expect(operator.status).toBe(404);
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('maps the service refusals to 403 and 503, and validates the body', async () => {
    await serve({ removeBudget: vi.fn(async (caller: { operator: boolean }) => (caller.operator ? { ok: false as const, error: 'unavailable' as const } : { ok: false as const, error: 'forbidden' as const })) });
    expect((await post('/api/budgets/remove', PLAIN, { scopeType: 'app', scopeKey: 'x' })).status).toBe(403);
    expect((await post('/api/budgets/remove', OPERATOR, { scopeType: 'app', scopeKey: 'x' })).status).toBe(503);
    expect((await post('/api/budgets/remove', OPERATOR, { scopeType: 'nope', scopeKey: 'x' })).status).toBe(400);
    expect((await post('/api/budgets/remove', OPERATOR, { scopeType: 'user' })).status).toBe(400);
    expect((await post('/api/budgets/remove', null, { scopeType: 'user', scopeKey: 'x' })).status).toBe(401);
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/budgets audit trail', () => {
  it('writes one budget.set event for a successful set, none for a refused one', async () => {
    const setBudget = vi.fn(async (caller: { operator: boolean }) => (caller.operator
      ? { ok: true as const, budget: { id: 1, scopeType: 'user' as const, scopeKey: PLAIN.sub, dailyUsd: 5, hard: true, enabled: true, setByOperator: true, createdAt: 'x', updatedAt: 'y' } }
      : { ok: false as const, error: 'forbidden' as const }));
    await serve({ setBudget });
    expect((await post('/api/budgets', OPERATOR, { scopeType: 'user', scopeKey: PLAIN.sub, dailyUsd: 5, hard: true, enabled: true })).status).toBe(200);
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(emitAuditEvent.mock.calls[0][1]).toMatchObject({ action: 'budget.set', resourceId: `user:${PLAIN.sub}`, metadata: { dailyUsd: 5, hard: true, enabled: true, setByOperator: true } });
    expect((await post('/api/budgets', PLAIN, { scopeType: 'app', scopeKey: 'x', dailyUsd: 5, hard: true, enabled: true })).status).toBe(403);
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
  });
});
