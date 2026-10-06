/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-5, budgets API) on a private PostgreSQL with the real cost-governance migration: an operator removes any cap; a person removes only their own self-set cap; an operator-imposed cap on a person stays when the person tries (one statement, no check-then-write), and the person can set their own cap again once the operator removes it; an app or ticket cap keyed to the person's own subject is still not theirs to remove; a missing pool and a failing DELETE both answer 'unavailable' (never a claimed removal); the removed cap's figures come back for the audit event; getBudgetState reports the runaway thresholds and event cooldown from the env. Each fails on the tree before the fix.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '@/features/cost-governance';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const database = new DisposablePostgres({ purpose: 'budget-remove', migrations: ['078-cost-governance.sql'], max: 4 });
let pool: Pool;
let service: BudgetService;
const OPERATOR = { sub: 'ops-sub', operator: true };
const PERSON = { sub: 'person-sub', operator: false };
const OTHER = { sub: 'other-sub', operator: false };

beforeAll(async () => {
  pool = await database.start();
  service = new BudgetService(pool, { env: { OSHAL_BUDGET_RUNAWAY_MAX: '7', OSHAL_BUDGET_RUNAWAY_WINDOW_MIN: '3', OSHAL_BUDGET_EVENT_COOLDOWN_MIN: '11' } as NodeJS.ProcessEnv, notify: async () => undefined });
}, 120_000);
afterAll(async () => { await database.stop(); });
beforeEach(async () => { await pool.query('DELETE FROM oshal_budgets'); });

const cap = (scopeType: 'user' | 'app' | 'ticket', scopeKey: string) => ({ scopeType, scopeKey, dailyUsd: 5, hard: true, enabled: true });
const rows = async () => (await pool.query('SELECT scope_type, scope_key, set_by_operator FROM oshal_budgets ORDER BY scope_key')).rows;

describe('removeBudget on the real store', () => {
  it('an operator removes any cap, and a person only their own self-set one', async () => {
    expect((await service.setBudget(PERSON, cap('user', PERSON.sub))).ok).toBe(true);
    expect((await service.setBudget(OPERATOR, cap('app', 'little-monsters'))).ok).toBe(true);
    expect((await service.setBudget(OTHER, cap('user', OTHER.sub))).ok).toBe(true);
    // Another person's row, and an app row, are not the person's to remove.
    expect(await service.removeBudget(PERSON, { scopeType: 'user', scopeKey: OTHER.sub })).toEqual({ ok: false, error: 'forbidden' });
    expect(await service.removeBudget(PERSON, { scopeType: 'app', scopeKey: 'little-monsters' })).toEqual({ ok: false, error: 'forbidden' });
    // Nor an app or ticket row that merely carries the person's own subject as its key.
    expect(await service.removeBudget(PERSON, { scopeType: 'app', scopeKey: PERSON.sub })).toEqual({ ok: false, error: 'forbidden' });
    expect(await service.removeBudget(PERSON, { scopeType: 'ticket', scopeKey: PERSON.sub })).toEqual({ ok: false, error: 'forbidden' });
    expect(await service.removeBudget(PERSON, { scopeType: 'user', scopeKey: PERSON.sub })).toEqual({ ok: true, removed: true, cap: { dailyUsd: 5, hard: true, enabled: true, setByOperator: false } });
    expect(await service.removeBudget(OPERATOR, { scopeType: 'app', scopeKey: 'little-monsters' })).toEqual({ ok: true, removed: true, cap: { dailyUsd: 5, hard: true, enabled: true, setByOperator: true } });
    expect(await service.removeBudget(OPERATOR, { scopeType: 'app', scopeKey: 'little-monsters' })).toEqual({ ok: true, removed: false, cap: null });
    expect(await rows()).toEqual([{ scope_type: 'user', scope_key: OTHER.sub, set_by_operator: false }]);
  });

  it('an operator-imposed cap on a person stays when the person tries, and the person may set their own again once it is gone', async () => {
    expect((await service.setBudget(OPERATOR, cap('user', PERSON.sub))).ok).toBe(true);
    expect(await service.removeBudget(PERSON, { scopeType: 'user', scopeKey: PERSON.sub })).toEqual({ ok: true, removed: false, cap: null });
    expect(await rows()).toEqual([{ scope_type: 'user', scope_key: PERSON.sub, set_by_operator: true }]);
    // Before this change, switching the cap off left it marked set-by-operator forever; now the operator removes it...
    expect(await service.removeBudget(OPERATOR, { scopeType: 'user', scopeKey: PERSON.sub })).toMatchObject({ ok: true, removed: true });
    // ...and the person can set their own cap again.
    expect((await service.setBudget(PERSON, cap('user', PERSON.sub))).ok).toBe(true);
    expect(await rows()).toEqual([{ scope_type: 'user', scope_key: PERSON.sub, set_by_operator: false }]);
  });

  it('answers unavailable, never a claimed removal, without a pool or when the DELETE fails', async () => {
    expect(await new BudgetService(null).removeBudget(OPERATOR, { scopeType: 'app', scopeKey: 'x' })).toEqual({ ok: false, error: 'unavailable' });
    const broken = { query: async () => { throw new Error('connection lost'); } } as unknown as Pool;
    expect(await new BudgetService(broken).removeBudget(OPERATOR, { scopeType: 'app', scopeKey: 'x' })).toEqual({ ok: false, error: 'unavailable' });
    expect(await new BudgetService(broken).removeBudget(PERSON, { scopeType: 'user', scopeKey: PERSON.sub })).toEqual({ ok: false, error: 'unavailable' });
    // The guard still answers before the pool is consulted.
    expect(await new BudgetService(broken).removeBudget(PERSON, { scopeType: 'app', scopeKey: 'x' })).toEqual({ ok: false, error: 'forbidden' });
  });

  it('getBudgetState reports the runaway thresholds and event cooldown beside the caps', async () => {
    await service.setBudget(OPERATOR, cap('app', 'little-monsters'));
    const state = await service.getBudgetState(24, 10);
    expect(state.budgets.map((b) => b.scopeKey)).toEqual(['little-monsters']);
    expect(state.runaway).toEqual({ max: 7, windowMin: 3 });
    expect(state.eventCooldownMin).toBe(11);
  });
});
