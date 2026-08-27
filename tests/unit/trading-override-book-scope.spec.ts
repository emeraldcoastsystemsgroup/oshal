/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 PR2 per-book strategy guards on the REAL database: the clone-backfill turns a pre-book active row into identical per-legacy-book actives (rollback-benign); an apply to book A never deactivates book B (the cross-revert trap); revert is book-scoped; one-active-per-(user, book) is a DB invariant; a legacy-shaped book-less ACTIVE insert still succeeds until PR4 (the deferred CHECK — rollback shape); the journal carries book_ref; and the single-learning-book rule is a partial-unique DB invariant with the review dispatch source-gated on it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import {
  ensureOverridesSchema, getActiveOverride, applyOverride, revertOverride,
} from '../../src/app/trading-config-overrides';
import { ensureLegacyBooks, legacyBookId } from '../../src/app/trading-books-store';
import { recordStrategyJournal } from '../../src/app/trading-strategy-journal';
import type { StrategyConfig } from '../../src/app/trading-strategy-lab-sim';

const DSN = process.env.OSHAL_TEST_DSN
  || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-adr134o-${RUN}`;
const SUB_PRE = `spec-adr134o-${RUN}-pre`;

const CFG = { kind: 'rotation', posture: 'balanced', corePct: 0, coreSymbol: 'SPY', takeProfitPct: null, rank: 'momentum', cadenceDays: 5, topN: 8, weighting: 'equal', universe: [], warmupDays: 60, windowDays: 365, earningsGateDays: 0 } as unknown as StrategyConfig;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(`trading-override-book-scope requires the live oshal Postgres — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  // Seed a PRE-PR2-shaped active row (book_id NULL) BEFORE the module's schema ensure runs, so the
  // clone-backfill inside ensureOverridesSchema operates on it exactly as it will on the live box.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_config_overrides (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_sub TEXT NOT NULL, strategy_id UUID,
      strategy_name TEXT NOT NULL, config JSONB NOT NULL,
      apply_pct INTEGER NOT NULL DEFAULT 100 CHECK (apply_pct BETWEEN 1 AND 100),
      active BOOLEAN NOT NULL DEFAULT true, note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deactivated_at TIMESTAMPTZ)`);
  await pool.query(`ALTER TABLE trading_config_overrides ADD COLUMN IF NOT EXISTS book_id UUID`);
  await pool.query(
    `INSERT INTO trading_config_overrides (user_sub, strategy_name, config, active) VALUES ($1, 'pre-book-strategy', $2, true)`,
    [SUB_PRE, JSON.stringify(CFG)]);
  await ensureOverridesSchema(pool);
  await ensureLegacyBooks(pool as never, SUB);
  await ensureLegacyBooks(pool as never, SUB_PRE);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM trading_config_overrides WHERE user_sub LIKE 'spec-adr134o-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_strategy_journal WHERE user_sub LIKE 'spec-adr134o-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub LIKE 'spec-adr134o-%'`).catch(() => {});
  await pool.end();
});

describe('clone-backfill — a pre-book active becomes identical per-legacy-book actives', () => {
  it('both legacy books carry the cloned strategy; the book-less original is deactivated', async () => {
    const paper = await getActiveOverride(pool, SUB_PRE, legacyBookId(SUB_PRE, 'paper'));
    const live = await getActiveOverride(pool, SUB_PRE, legacyBookId(SUB_PRE, 'live'));
    expect(paper?.strategyName).toBe('pre-book-strategy');
    expect(live?.strategyName).toBe('pre-book-strategy');
    const nullActive = (await pool.query(
      `SELECT count(*)::int AS n FROM trading_config_overrides WHERE user_sub=$1 AND active AND book_id IS NULL`, [SUB_PRE])).rows[0].n;
    expect(nullActive).toBe(0);
    // A book-less read (deployed store twin) still resolves an active row — today's contract.
    const legacyRead = await getActiveOverride(pool, SUB_PRE);
    expect(legacyRead?.strategyName).toBe('pre-book-strategy');
  });
});

describe('per-book apply/revert — the cross-revert trap', () => {
  const paperId = () => legacyBookId(SUB, 'paper');
  const liveId = () => legacyBookId(SUB, 'live');

  it('apply to book A does NOT deactivate book B; each book runs its own strategy', async () => {
    await applyOverride(pool, SUB, { strategyId: null, strategyName: 'paper-strat', config: CFG, applyPct: 100, note: '', bookId: paperId(), bookRef: 'paper' });
    await applyOverride(pool, SUB, { strategyId: null, strategyName: 'live-strat', config: CFG, applyPct: 50, note: '', bookId: liveId(), bookRef: 'live' });
    expect((await getActiveOverride(pool, SUB, paperId()))?.strategyName).toBe('paper-strat');
    expect((await getActiveOverride(pool, SUB, liveId()))?.strategyName).toBe('live-strat');
  });

  it('revert is book-scoped: reverting paper leaves live active', async () => {
    await revertOverride(pool, SUB, paperId(), 'paper');
    expect(await getActiveOverride(pool, SUB, paperId())).toBeNull();
    expect((await getActiveOverride(pool, SUB, liveId()))?.strategyName).toBe('live-strat');
  });

  it('one-active-per-(user, book) is a DB invariant', async () => {
    await expect(pool.query(
      `INSERT INTO trading_config_overrides (user_sub, book_id, strategy_name, config, active)
         VALUES ($1, $2, 'dup', $3, true)`,
      [SUB, liveId(), JSON.stringify(CFG)])).rejects.toThrow(/duplicate key|unique/i);
  });

  it('ROLLBACK SHAPE: a legacy-shaped book-less ACTIVE insert still succeeds (CHECK deferred to PR4)', async () => {
    const r = await pool.query(
      `INSERT INTO trading_config_overrides (user_sub, strategy_name, config, active)
         VALUES ($1, 'rolled-back-code-shape', $2, true) RETURNING id`,
      [`${SUB}-rb`, JSON.stringify(CFG)]);
    expect(r.rows.length).toBe(1);
  });
});

describe('journal + learning book', () => {
  it('recordStrategyJournal writes book_ref', async () => {
    const ok = await recordStrategyJournal(pool, { sub: SUB, kind: 'knob-turn', summary: 'spec entry', source: 'spec', bookRef: 'live' });
    expect(ok).toBe(true);
    const row = (await pool.query(
      `SELECT book_ref FROM oshal_trading_strategy_journal WHERE user_sub=$1 ORDER BY id DESC LIMIT 1`, [SUB])).rows[0];
    expect(row.book_ref).toBe('live');
  });

  it('the single-learning-book rule is a DB invariant (partial unique on learn)', async () => {
    await expect(pool.query(
      `UPDATE oshal_trading_books SET learn = true WHERE user_sub=$1 AND ref='live'`, [SUB]))
      .rejects.toThrow(/duplicate key|unique/i);
  });

  it('the review dispatch is source-gated on the learning book', () => {
    const src = readFileSync('src/app/trading-review-dispatch.ts', 'utf8');
    expect(/isLearnBook/.test(src)).toBe(true);
    expect(/for \(const r of isLearnBook \? rows : \[\]\)/.test(src)).toBe(true);
  });
});
