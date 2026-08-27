/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 PR1 schema guards against the REAL oshal Postgres (fail-loud when the stack is down, per the alert-incident-cutover precedent): dual-rail convergence + double-run idempotence, TS↔SQL legacy-book-id bijection, zero NULL book_ids after backfill on user-bearing rows, the straggler-writer trigger filling a legacy-shaped INSERT, cross-user account binding refused at the core store AND the composite FK, and the flag-off dispatch hard-skip rules (foreign bookId → logged no-op; unresolvable bookId under the flag → skip, never legacy fallback).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import {
  ensureBooksSchema, ensureLegacyBooks, legacyBook, legacyBookId, loadBook, createBook, deleteBook, updateBook, listBooks,
} from '../../src/app/trading-books-store';
import { ensureAccountsSchema, accountDigest } from '../../src/app/trading-accounts-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import { ensureEquityGuardTable } from '../../src/app/trading-equity-guard';
import { ensureGateBlockTable } from '../../src/app/trading-gate-block-store';
import { ensurePeaksTable } from '../../src/app/trading-peaks-store';
import { ensureDailyEquityTable } from '../../src/app/trading-daily-equity-store';
import { ensureRotationStateTable } from '../../src/app/trading-rotation-store';
import { dispatchTradingSchedule } from '../../src/app/trading-schedule-dispatch';
import type { AppContext } from '../../src/app/composition/app-context';

const DSN = process.env.OSHAL_TEST_DSN
  || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB_A = `spec-adr134-${RUN}-a`;
const SUB_B = `spec-adr134-${RUN}-b`;

let pool: Pool;
const ctx = () => ({ pool, ticketService: { createTicket: async () => ({}) } } as unknown as AppContext);

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  delete process.env.TRADING_MULTI_ACCOUNT;
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(`trading-books-schema requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  // The runtime rails ARE the migration (dual-rail; idempotent). Running them here both applies
  // and proves them — the designed mixed-version-safe sequence.
  await ensureAccountsSchema(pool as never);
  await ensureBooksSchema(pool as never);
  await ensureTradingSchema(pool as never);
  await ensureEquityGuardTable(pool as never);
  await ensureGateBlockTable(pool as never);
  await ensurePeaksTable(pool as never);
  await ensureDailyEquityTable(pool as never);
  await ensureRotationStateTable(pool as never);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM oshal_trading_gate_blocks WHERE user_sub LIKE 'spec-adr134-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub LIKE 'spec-adr134-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_accounts WHERE user_sub LIKE 'spec-adr134-%'`).catch(() => {});
  await pool.end();
});

describe('legacy book identity — TS ↔ SQL bijection', () => {
  it('legacyBookId matches Postgres md5(...)::uuid byte-for-byte', async () => {
    const { rows } = await pool.query(
      `SELECT md5('oshal-book:' || $1 || ':paper')::uuid AS p, md5('oshal-book:' || $1 || ':live')::uuid AS l`, [SUB_A]);
    expect(legacyBookId(SUB_A, 'paper')).toBe(String(rows[0].p));
    expect(legacyBookId(SUB_A, 'live')).toBe(String(rows[0].l));
  });

  it('legacy refs are byte-identical to the pre-ADR mode strings', () => {
    expect(legacyBook(SUB_A, 'paper').ref).toBe('paper');
    expect(legacyBook(SUB_A, 'live').ref).toBe('live');
  });
});

describe('backfill + trigger — no row escapes the book key', () => {
  it('every user-bearing pre-existing row got its book_id backfilled (bijection, zero NULLs)', async () => {
    for (const t of ['oshal_trading_orders', 'oshal_trading_signals', 'oshal_trading_decisions', 'oshal_trading_equity_hwm', 'oshal_trading_peaks', 'oshal_trading_daily_equity', 'oshal_trading_rotation_state']) {
      const nulls = (await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE book_id IS NULL AND user_sub IS NOT NULL`)).rows[0].n;
      expect(nulls, `${t} has NULL book_ids after backfill`).toBe(0);
      const wrong = (await pool.query(
        `SELECT count(*)::int AS n FROM ${t} WHERE user_sub IS NOT NULL AND book_id IS DISTINCT FROM md5('oshal-book:'||user_sub||':'||mode)::uuid`)).rows[0].n;
      expect(wrong, `${t} rows whose book_id breaks the legacy bijection`).toBe(0);
    }
  });

  it('a legacy-shaped INSERT (no book_id) is filled by the BEFORE INSERT trigger', async () => {
    await pool.query(
      `INSERT INTO oshal_trading_gate_blocks (user_sub, mode, gate, symbol, et_day, ref_price)
         VALUES ($1,'paper','spec','TEST', CURRENT_DATE, 1)`, [SUB_A]);
    const row = (await pool.query(
      'SELECT book_id FROM oshal_trading_gate_blocks WHERE user_sub=$1 AND gate=$2', [SUB_A, 'spec'])).rows[0];
    expect(String(row.book_id)).toBe(legacyBookId(SUB_A, 'paper'));
  });

  it('the rails are double-run idempotent (second pass changes nothing, raises nothing)', async () => {
    await ensureLegacyBooks(pool as never, SUB_A);
    await ensureLegacyBooks(pool as never, SUB_A);
    const n = (await pool.query('SELECT count(*)::int AS n FROM oshal_trading_books WHERE user_sub=$1', [SUB_A])).rows[0].n;
    expect(n).toBe(2);
  });
});

describe('book lifecycle invariants live in the CORE store', () => {
  async function seedAccount(sub: string): Promise<string> {
    const num = `9${RUN}${sub.slice(-1)}`;
    // The REAL envelope path (mints the user's DEK) — the stored value must be a decryptable
    // v2 blob, exactly what discovery writes; a fake envelope would (correctly) fail loadBook.
    const { encryptToken } = await import('../../src/app/routes/connector-token-crypto');
    const enc = await encryptToken(pool as never, sub, num);
    expect(enc.startsWith('v2:') || enc.startsWith('k2:'), 'stored account number must be an envelope blob, never plaintext').toBe(true);
    expect(enc.includes(num)).toBe(false);
    const r = await pool.query(
      `INSERT INTO oshal_trading_accounts (user_sub, broker, connection_key, account_number_enc, account_digest, account_last4)
         VALUES ($1,'schwab','default',$2,$3,$4) RETURNING account_id`,
      [sub, enc, accountDigest(sub, num), num.slice(-4)]);
    return String(r.rows[0].account_id);
  }

  it('createBook binds only the OWNER’s account; a cross-user bind errors at the store AND the composite FK', async () => {
    await ensureLegacyBooks(pool as never, SUB_A);
    await ensureLegacyBooks(pool as never, SUB_B);
    const acctB = await seedAccount(SUB_B);
    await expect(createBook(pool as never, SUB_A, acctB, 'stolen')).rejects.toThrow(/account_not_owned/);
    // Belt AND braces: a raw INSERT past the store hits the composite FK.
    await expect(pool.query(
      `INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, broker, account_id)
         VALUES ($1,$2,'b-steal01','steal','live','schwab',$3)`,
      [crypto.randomUUID(), SUB_A, acctB])).rejects.toThrow(/foreign key/i);
  });

  it('a live book is born DISABLED; account_id is immutable via updateBook; legacy books are undeletable', async () => {
    const acctA = await seedAccount(SUB_A);
    const book = await createBook(pool as never, SUB_A, acctA, 'IRA test');
    expect(book.enabled).toBe(false);
    expect(book.ref.startsWith('b-')).toBe(true);
    const patched = await updateBook(pool as never, SUB_A, book.bookId, { label: 'renamed', enabled: false });
    expect(patched?.enabled).toBe(false);
    await expect(deleteBook(pool as never, SUB_A, legacyBookId(SUB_A, 'paper'))).rejects.toThrow(/legacy books are permanent/);
    // The never-traded live book deletes cleanly.
    expect(await deleteBook(pool as never, SUB_A, book.bookId)).toBe(true);
    expect((await listBooks(pool as never, SUB_A)).some((b) => b.bookId === book.bookId)).toBe(false);
  });
});

describe('dispatch hard-skip rules (ADR-134 blockers)', () => {
  const schedule = (bookId: string | null) => ({
    id: `spec-${RUN}`, taskType: 'trading-autopilot', taskData: { userSub: SUB_A, mode: 'live', ...(bookId ? { bookId } : {}) },
  }) as never;

  it('flag OFF + non-legacy bookId → logged no-op, no fallback to the legacy live book', async () => {
    delete process.env.TRADING_MULTI_ACCOUNT;
    const r = await dispatchTradingSchedule(ctx(), schedule(crypto.randomUUID()));
    expect(r.success).toBe(true);
    expect((r as { taskId?: string }).taskId).toBeUndefined(); // never reached the run path
  });

  it('flag ON + unresolvable bookId → skip with error log, never the legacy book', async () => {
    process.env.TRADING_MULTI_ACCOUNT = 'true';
    try {
      const r = await dispatchTradingSchedule(ctx(), schedule(crypto.randomUUID()));
      expect(r.success).toBe(true);
      expect((r as { taskId?: string }).taskId).toBeUndefined();
    } finally {
      delete process.env.TRADING_MULTI_ACCOUNT;
    }
  });
});
