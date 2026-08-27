/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — honesty-rail guards: journal writes carry sub/kind/summary/source, failures are swallowed (a knob turn is never blocked by its paper trail), the reader's window is (since, through] oldest-first, and read failures return empty (the report ships without the section, never crashes).
 */
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { recordStrategyJournal, listStrategyJournal } from '../../src/app/trading-strategy-journal';

/** Fake pg pool capturing every query; per-call results/errors injectable. */
function fakePool(handler?: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return handler ? handler(sql, params) : { rows: [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('recordStrategyJournal (every knob turn reaches the report)', () => {
  it('inserts sub, ET day, kind, summary, detail and source', async () => {
    const { pool, calls } = fakePool();
    const ok = await recordStrategyJournal(pool, {
      sub: 'sub-1', kind: 'knob-turn', summary: 'core hold moved SPY -> BRK.B',
      detail: { from: 'SPY', to: 'BRK.B' }, source: 'unit-test', etDayOverride: '2026-07-26',
    });
    expect(ok).toBe(true);
    const insert = calls.find((c) => /INSERT INTO oshal_trading_strategy_journal/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual([
      'sub-1', '2026-07-26', 'knob-turn', 'core hold moved SPY -> BRK.B',
      JSON.stringify({ from: 'SPY', to: 'BRK.B' }), 'unit-test',
      null, // book_ref (ADR-134 PR2) — absent on a book-less entry
    ]);
  });

  it('swallows failures — a journal outage must never block the change being journaled', async () => {
    const { pool } = fakePool(() => { throw new Error('db down'); });
    await expect(recordStrategyJournal(pool, {
      sub: 'sub-1', kind: 'incident', summary: 'x', source: 'unit-test',
    })).resolves.toBe(false);
  });

  it('caps summary at 500 chars so a paste-bomb cannot distort the report', async () => {
    const { pool, calls } = fakePool();
    await recordStrategyJournal(pool, {
      sub: 'sub-1', kind: 'note', summary: 'y'.repeat(2000), source: 'unit-test',
    });
    const insert = calls.find((c) => /INSERT INTO oshal_trading_strategy_journal/.test(c.sql));
    expect((insert!.params![3] as string).length).toBe(500);
  });
});

describe('listStrategyJournal (the "What changed" window)', () => {
  it('queries (since, through] for the sub, oldest first', async () => {
    const { pool, calls } = fakePool((sql) => (/SELECT/.test(sql) ? {
      rows: [{ id: '7', user_sub: 's', et_day: '2026-07-26', kind: 'knob-turn', summary: 'reweight', detail: null, source: 'cli', created_at: 'ts' }],
    } : { rows: [] }));
    const rows = await listStrategyJournal(pool, 'sub-1', '2026-07-25', '2026-07-28');
    const select = calls.find((c) => /et_day > \$2::date AND et_day <= \$3::date/.test(c.sql));
    expect(select).toBeDefined();
    expect(select!.params).toEqual(['sub-1', '2026-07-25', '2026-07-28']);
    expect(select!.sql).toMatch(/ORDER BY et_day, id/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 7, kind: 'knob-turn', summary: 'reweight', etDay: '2026-07-26' });
  });

  it('returns empty on a read failure — the report ships without the section, never crashes', async () => {
    const { pool } = fakePool(() => { throw new Error('db down'); });
    await expect(listStrategyJournal(pool, 'sub-1', '2026-07-01', '2026-07-02')).resolves.toEqual([]);
  });
});
