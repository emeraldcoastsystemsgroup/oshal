/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the cost-governance BudgetService against a mocked pg pool: fail-OPEN on infra gaps (missing table / no pool / unreadable spend), fail-CLOSED with audit row + notification on a definitive HARD breach, soft caps warn-only, the runaway kill switch + its env knobs, per-scope spend SQL, and the operator/self authorization split on getBudgets/setBudget + the route body/query parsers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review-fix coverage: spend SQL now targets the oshal_cost_events per-event ledger (chat_tasks lifetime rollups overcounted trailing-24h spend); operator-imposed caps survive a capped user's self-write (conditional upsert returns 0 rows -> forbidden); recordEvent dedupes audit rows + notifications inside OSHAL_BUDGET_EVENT_COOLDOWN_MIN (mock inserts carry rowCount so notification gating is observable).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  BudgetService,
  readRunawayConfig,
  readEventCooldownMin,
  spendSqlFor,
  upsertBudgetSqlFor,
  type BudgetRecord,
} from '@/features/cost-governance';
import { parseSetBudgetBody, parseSpendQuery } from '@/app/routes/budget-routes';

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryHandler = (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>;

/** Builds a pool whose query() dispatches on SQL content, recording every call. */
function mockPool(handler: QueryHandler): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  });
  return { pool: { query } as unknown as Pool, calls };
}

function budgetRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1, scope_type: 'user', scope_key: 'sub-a', daily_usd: '10.0000',
    hard: false, enabled: true, set_by_operator: false, created_at: '2026-07-15', updated_at: '2026-07-15',
    ...over,
  };
}

const QUIET_ENV = {} as NodeJS.ProcessEnv; // default runaway knobs (25 / 30min)

describe('readRunawayConfig — env knobs', () => {
  it('defaults to 25 executions / 30 minutes', () => {
    expect(readRunawayConfig({} as NodeJS.ProcessEnv)).toEqual({ max: 25, windowMin: 30 });
  });
  it('honors OSHAL_BUDGET_RUNAWAY_MAX / OSHAL_BUDGET_RUNAWAY_WINDOW_MIN', () => {
    const env = { OSHAL_BUDGET_RUNAWAY_MAX: '5', OSHAL_BUDGET_RUNAWAY_WINDOW_MIN: '10' } as NodeJS.ProcessEnv;
    expect(readRunawayConfig(env)).toEqual({ max: 5, windowMin: 10 });
  });
  it('falls back on garbage values (never a NaN threshold)', () => {
    const env = { OSHAL_BUDGET_RUNAWAY_MAX: 'lots', OSHAL_BUDGET_RUNAWAY_WINDOW_MIN: '-3' } as NodeJS.ProcessEnv;
    expect(readRunawayConfig(env)).toEqual({ max: 25, windowMin: 30 });
  });
});

describe('readEventCooldownMin — audit/notification anti-flood knob', () => {
  it('defaults to 30 minutes and honors OSHAL_BUDGET_EVENT_COOLDOWN_MIN', () => {
    expect(readEventCooldownMin({} as NodeJS.ProcessEnv)).toBe(30);
    expect(readEventCooldownMin({ OSHAL_BUDGET_EVENT_COOLDOWN_MIN: '5' } as NodeJS.ProcessEnv)).toBe(5);
    expect(readEventCooldownMin({ OSHAL_BUDGET_EVENT_COOLDOWN_MIN: '-1' } as NodeJS.ProcessEnv)).toBe(30);
  });
});

describe('spendSqlFor — per-scope attribution over the per-event ledger', () => {
  it('user scope sums oshal_cost_events.owner_sub rows — NEVER chat_tasks lifetime rollups', () => {
    expect(spendSqlFor('user')).toContain('owner_sub = $1');
    expect(spendSqlFor('user')).toContain('oshal_cost_events');
    expect(spendSqlFor('user')).not.toContain('chat_tasks');
  });
  it('ticket scope joins ticket_task_links (same linkage as the cockpit rollup)', () => {
    expect(spendSqlFor('ticket')).toContain('ticket_task_links');
    expect(spendSqlFor('ticket')).toContain('ttl.ticket_id = $1');
    expect(spendSqlFor('ticket')).toContain('oshal_cost_events');
  });
  it('app scope attributes via tickets.ticket_type (ADR-038: app = ticketType bundle)', () => {
    expect(spendSqlFor('app')).toContain('ticket_type = $1');
    expect(spendSqlFor('app')).toContain('ticket_task_links');
    expect(spendSqlFor('app')).toContain('oshal_cost_events');
  });
  it('every scope windows on the EVENT timestamp, not a mutable row column', () => {
    for (const scope of ['user', 'ticket', 'app'] as const) {
      expect(spendSqlFor(scope)).toContain('make_interval(hours => $2::int)');
      expect(spendSqlFor(scope)).not.toContain('updated_at');
    }
  });
});

describe('checkBudget — fail-OPEN on infra gaps', () => {
  it('allows with no pool at all (budgets-unavailable, never bricks dispatch)', async () => {
    const svc = new BudgetService(null, { notify: vi.fn(), env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a', 'career-hunter', 'tick-1');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('budgets-unavailable');
  });

  it('allows when the budgets table is missing (query throws)', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('ticket_task_links')) return { rows: [{ n: 0 }] };
      throw new Error('relation "oshal_budgets" does not exist');
    });
    const svc = new BudgetService(pool, { notify: vi.fn(), env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a', null, 'tick-1');
    expect(decision).toMatchObject({ allowed: true, softWarn: false, reason: 'budgets-unavailable' });
  });

  it('skips a cap whose spend read fails, instead of blocking on it', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('FROM oshal_budgets')) return { rows: [budgetRow({ hard: true })] };
      if (sql.includes('oshal_cost_events')) throw new Error('db reset');
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify: vi.fn(), env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a');
    expect(decision).toMatchObject({ allowed: true, reason: 'within-cap' });
  });
});

describe('checkBudget — cap semantics', () => {
  it('returns no-budgets when nothing matches', async () => {
    const { pool } = mockPool(() => ({ rows: [] }));
    const svc = new BudgetService(pool, { notify: vi.fn(), env: QUIET_ENV });
    expect((await svc.checkBudget('sub-a')).reason).toBe('no-budgets');
  });

  it('allows within-cap spend', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('FROM oshal_budgets')) return { rows: [budgetRow({ daily_usd: '10' })] };
      if (sql.includes('oshal_cost_events')) return { rows: [{ spend: '3.50' }] };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify: vi.fn(), env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a');
    expect(decision).toMatchObject({ allowed: true, softWarn: false, reason: 'within-cap' });
  });

  it('SOFT cap exceeded: warns but allows, and writes NO audit event', async () => {
    const notify = vi.fn(async () => ({}));
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes('FROM oshal_budgets')) return { rows: [budgetRow({ daily_usd: '10', hard: false })] };
      if (sql.includes('oshal_cost_events')) return { rows: [{ spend: '12.25' }] };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify, env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a');
    expect(decision).toMatchObject({ allowed: true, softWarn: true, reason: 'soft-cap-exceeded', spend: 12.25, cap: 10 });
    expect(calls.some((c) => c.sql.includes('oshal_budget_events'))).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('HARD cap exceeded: blocks, writes a halt audit row, and notifies', async () => {
    const notify = vi.fn(async () => ({}));
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes('FROM oshal_budgets')) return { rows: [budgetRow({ daily_usd: '10', hard: true })] };
      if (sql.includes('oshal_cost_events')) return { rows: [{ spend: '10.00' }] };
      if (sql.includes('INSERT INTO oshal_budget_events')) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify, env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a');
    expect(decision).toMatchObject({ allowed: false, softWarn: false, reason: 'hard-cap-exceeded', cap: 10, scopeType: 'user', scopeKey: 'sub-a' });
    const audit = calls.find((c) => c.sql.includes('INSERT INTO oshal_budget_events'));
    expect(audit).toBeTruthy();
    expect(audit!.params[4]).toBe('halt');
    // The insert itself carries the anti-flood guard: default 30-minute cooldown as $7.
    expect(audit!.sql).toContain('WHERE NOT EXISTS');
    expect(audit!.params[6]).toBe(30);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain('HARD daily cap');
  });

  it('sustained HARD breach re-checked inside the cooldown: still blocks but does NOT re-notify (anti-flood)', async () => {
    const notify = vi.fn(async () => ({}));
    const { pool } = mockPool((sql) => {
      if (sql.includes('FROM oshal_budgets')) return { rows: [budgetRow({ daily_usd: '10', hard: true })] };
      if (sql.includes('oshal_cost_events')) return { rows: [{ spend: '10.00' }] };
      // Dedupe subquery found a fresh row for this (scope, action) — nothing inserted.
      if (sql.includes('INSERT INTO oshal_budget_events')) return { rows: [], rowCount: 0 };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify, env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a');
    expect(decision).toMatchObject({ allowed: false, reason: 'hard-cap-exceeded' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('reports the MOST SPECIFIC hard breach first (ticket beats user)', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('FROM oshal_budgets')) {
        return { rows: [
          budgetRow({ id: 1, scope_type: 'user', scope_key: 'sub-a', daily_usd: '1', hard: true }),
          budgetRow({ id: 2, scope_type: 'ticket', scope_key: 'tick-1', daily_usd: '2', hard: true }),
        ] };
      }
      if (sql.includes('ticket_task_links') && sql.includes('COUNT')) return { rows: [{ n: 0 }] };
      if (sql.includes('AS spend')) return { rows: [{ spend: '99' }] };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify: vi.fn(async () => ({})), env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a', null, 'tick-1');
    expect(decision).toMatchObject({ allowed: false, scopeType: 'ticket', scopeKey: 'tick-1' });
  });
});

describe('checkBudget — runaway kill switch', () => {
  it('halts a ticket past the execution threshold (audit + notify), before any cap math', async () => {
    const notify = vi.fn(async () => ({}));
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 25 }] };
      if (sql.includes('INSERT INTO oshal_budget_events')) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify, env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a', null, 'tick-loop');
    expect(decision).toMatchObject({ allowed: false, reason: 'runaway-halt', spend: 25, cap: 25, scopeKey: 'tick-loop' });
    expect(calls.some((c) => c.sql.includes('FROM oshal_budgets'))).toBe(false); // halted before cap reads
    expect(calls.find((c) => c.sql.includes('oshal_budget_events'))!.params[4]).toBe('halt');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a runaway-halted ticket re-checked inside the cooldown does not re-notify', async () => {
    const notify = vi.fn(async () => ({}));
    const { pool } = mockPool((sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 25 }] };
      if (sql.includes('INSERT INTO oshal_budget_events')) return { rows: [], rowCount: 0 };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify, env: QUIET_ENV });
    const decision = await svc.checkBudget('sub-a', null, 'tick-loop');
    expect(decision).toMatchObject({ allowed: false, reason: 'runaway-halt' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('honors the env knobs (max=5 trips at 5)', async () => {
    const env = { OSHAL_BUDGET_RUNAWAY_MAX: '5', OSHAL_BUDGET_RUNAWAY_WINDOW_MIN: '10' } as NodeJS.ProcessEnv;
    const { pool, calls } = mockPool((sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 5 }] };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify: vi.fn(async () => ({})), env });
    const decision = await svc.checkBudget(null, null, 'tick-1');
    expect(decision.reason).toBe('runaway-halt');
    // The count query must use the configured 10-minute window.
    expect(calls[0].params[1]).toBe(10);
  });

  it('stays quiet below the threshold and falls through to cap checks', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 24 }] };
      if (sql.includes('FROM oshal_budgets')) return { rows: [] };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify: vi.fn(), env: QUIET_ENV });
    expect((await svc.checkBudget('sub-a', null, 'tick-1')).reason).toBe('no-budgets');
  });

  it('fails open when the count query itself fails', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('COUNT(*)')) throw new Error('db down');
      if (sql.includes('FROM oshal_budgets')) return { rows: [] };
      return { rows: [] };
    });
    const svc = new BudgetService(pool, { notify: vi.fn(), env: QUIET_ENV });
    expect((await svc.checkBudget('sub-a', null, 'tick-1')).allowed).toBe(true);
  });
});

describe('computeSpend / countRecentExecutions — parsing + degraded mode', () => {
  it('parses numeric strings from pg and floors garbage to 0', async () => {
    const { pool } = mockPool(() => ({ rows: [{ spend: '4.2500' }] }));
    const svc = new BudgetService(pool, { env: QUIET_ENV });
    expect(await svc.computeSpend('user', 'sub-a', 24)).toBe(4.25);
  });
  it('returns null (not 0) when the spend query fails — null means "unknown", 0 means "no spend"', async () => {
    const { pool } = mockPool(() => { throw new Error('boom'); });
    const svc = new BudgetService(pool, { env: QUIET_ENV });
    expect(await svc.computeSpend('ticket', 't1', 24)).toBeNull();
    expect(await svc.countRecentExecutions('t1', 30)).toBeNull();
  });
});

describe('getBudgets / setBudget — operator vs self authorization', () => {
  it('non-operator listing is server-side filtered to their own user row', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [budgetRow()] }));
    const svc = new BudgetService(pool, { env: QUIET_ENV });
    const rows = await svc.getBudgets({ sub: 'sub-a', operator: false });
    expect(rows).toHaveLength(1);
    expect(calls[0].sql).toContain("scope_type = 'user'");
    expect(calls[0].params[0]).toBe('sub-a');
  });

  it('operator listing reads every row', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [] }));
    const svc = new BudgetService(pool, { env: QUIET_ENV });
    await svc.getBudgets({ sub: 'op', operator: true });
    expect(calls[0].sql).not.toContain('scope_key = $1');
  });

  it('a user may set ONLY their own user-scope cap', async () => {
    const { pool } = mockPool(() => ({ rows: [budgetRow()] }));
    const svc = new BudgetService(pool, { env: QUIET_ENV });
    const own = await svc.setBudget(
      { sub: 'sub-a', operator: false },
      { scopeType: 'user', scopeKey: 'sub-a', dailyUsd: 5, hard: false, enabled: true },
    );
    expect(own.ok).toBe(true);

    for (const attempt of [
      { scopeType: 'user' as const, scopeKey: 'sub-OTHER' },
      { scopeType: 'app' as const, scopeKey: 'career-hunter' },
      { scopeType: 'ticket' as const, scopeKey: 'tick-1' },
    ]) {
      const denied = await svc.setBudget(
        { sub: 'sub-a', operator: false },
        { ...attempt, dailyUsd: 5, hard: true, enabled: true },
      );
      expect(denied).toEqual({ ok: false, error: 'forbidden' });
    }
  });

  it('operator may set any scope; upsert carries all fields and stamps set_by_operator=TRUE', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [budgetRow({ scope_type: 'app', scope_key: 'eats', daily_usd: '50', hard: true, set_by_operator: true })] }));
    const svc = new BudgetService(pool, { env: QUIET_ENV });
    const result = await svc.setBudget(
      { sub: 'op', operator: true },
      { scopeType: 'app', scopeKey: 'eats', dailyUsd: 50, hard: true, enabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.budget.setByOperator).toBe(true);
    expect(calls[0].sql).toContain('ON CONFLICT (scope_type, scope_key)');
    expect(calls[0].sql).toContain('set_by_operator = TRUE');
    expect(calls[0].params).toEqual(['app', 'eats', 50, true, true]);
  });

  it('a capped user CANNOT raise/disable an operator-imposed cap on themselves (conditional upsert returns 0 rows)', async () => {
    // The operator-owned row makes the self-service upsert a no-op — RETURNING yields nothing.
    const { pool, calls } = mockPool(() => ({ rows: [], rowCount: 0 }));
    const svc = new BudgetService(pool, { env: QUIET_ENV });
    const result = await svc.setBudget(
      { sub: 'sub-123', operator: false },
      { scopeType: 'user', scopeKey: 'sub-123', dailyUsd: 1_000_000, hard: false, enabled: false },
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    // The guard is IN the statement (no read-then-write race), scoped to non-operator rows only.
    expect(calls[0].sql).toContain('WHERE oshal_budgets.set_by_operator = FALSE');
  });

  it('upsertBudgetSqlFor: only the self-service variant is conditional; the operator variant takes ownership', () => {
    expect(upsertBudgetSqlFor(false)).toContain('WHERE oshal_budgets.set_by_operator = FALSE');
    expect(upsertBudgetSqlFor(true)).not.toContain('WHERE oshal_budgets.set_by_operator = FALSE');
    expect(upsertBudgetSqlFor(true)).toContain('set_by_operator = TRUE');
  });

  it('reports unavailable (not forbidden) when there is no pool', async () => {
    const svc = new BudgetService(null, { env: QUIET_ENV });
    const result = await svc.setBudget(
      { sub: 'op', operator: true },
      { scopeType: 'user', scopeKey: 'x', dailyUsd: 1, hard: false, enabled: true },
    );
    expect(result).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('route parsers — validation before anything touches the governance table', () => {
  it('parseSetBudgetBody accepts a valid body and defaults enabled=true', () => {
    expect(parseSetBudgetBody({ scopeType: 'app', scopeKey: 'eats', dailyUsd: 25 }))
      .toEqual({ scopeType: 'app', scopeKey: 'eats', dailyUsd: 25, hard: false, enabled: true });
  });
  it('parseSetBudgetBody rejects bad scope types, empty keys, and negative/NaN caps', () => {
    expect(parseSetBudgetBody({ scopeType: 'global', scopeKey: 'x', dailyUsd: 1 })).toBeNull();
    expect(parseSetBudgetBody({ scopeType: 'user', scopeKey: '  ', dailyUsd: 1 })).toBeNull();
    expect(parseSetBudgetBody({ scopeType: 'user', scopeKey: 'x', dailyUsd: -1 })).toBeNull();
    expect(parseSetBudgetBody({ scopeType: 'user', scopeKey: 'x', dailyUsd: 'free' })).toBeNull();
  });
  it('parseSpendQuery accepts both compact and explicit forms and clamps the window', () => {
    expect(parseSpendQuery({ scope: 'user:sub-a' })).toEqual({ scopeType: 'user', scopeKey: 'sub-a', windowHours: 24 });
    expect(parseSpendQuery({ scopeType: 'ticket', scopeKey: 't1', windowHours: '9999' }))
      .toEqual({ scopeType: 'ticket', scopeKey: 't1', windowHours: 720 });
    expect(parseSpendQuery({ scope: 'bogus:key' })).toBeNull();
    expect(parseSpendQuery({})).toBeNull();
  });
});
