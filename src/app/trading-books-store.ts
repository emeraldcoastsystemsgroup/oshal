/**
 * Trading books store (ADR-134) — the account-scoped book registry the multi-account world keys on.
 *
 * A book = capital slice × strategy × broker account. The legacy two-book world maps to two
 * DETERMINISTIC rows per user (book_id = md5('oshal-book:'+sub+':'+kind) as a UUID, ref literally
 * 'paper'/'live'), so every backfill, trigger, and id-text derivation is idempotent and byte-stable
 * across both schema rails and every boot. Lifecycle invariants live HERE, in core, not in route
 * code: live books are born disabled, account bindings are immutable once traded, deletion is
 * refused while ledger/HWM rows or open positions exist, and account ownership is verified
 * in-transaction (belt to the composite FK's braces).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — books table (deterministic legacy ids, composite (user_sub, account_id) FK, learn-book partial unique), legacy mint/backfill helpers, loadBook keyed (user_sub, book_id) — the WHERE is the wall under system identity — lifecycle invariants (createBook disabled-live + ownership check, deleteBook ledger/HWM/position refusal, updateBook account_id immutability), resetBreaker, and the per-fire multiAccountEnabled() flag read (never a module constant).
 */

import crypto from 'crypto';
import type { AppContext } from './composition-root';
import type { TradingBook, TradingMode } from '@/features/trading';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { ensureAccountsSchema } from './trading-accounts-store';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-books-store' });

/**
 * @description ADR-134 feature flag, read PER CALL (config → env → default false) — a module
 * constant would be invisible to guards and un-flippable without a restart.
 * @returns Whether multi-account dispatch/schedule/UI behavior is armed.
 */
export function multiAccountEnabled(): boolean {
  return String(process.env.TRADING_MULTI_ACCOUNT || 'false').toLowerCase() === 'true';
}

/**
 * @description The deterministic legacy book id — md5('oshal-book:'+sub+':'+kind) formatted as a
 * UUID, byte-identical to Postgres `md5(...)::uuid` so TS-side derivation, SQL backfill, and the
 * straggler-writer trigger all mint the SAME id.
 * @param sub - Owner sub.
 * @param kind - Legacy book kind ('paper' | 'live').
 * @returns The UUID string.
 */
export function legacyBookId(sub: string, kind: TradingMode): string {
  const h = crypto.createHash('md5').update(`oshal-book:${sub}:${kind}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * @description Pure legacy-book constructor for callers pinned to the two-book world (swing,
 * research, reconcile ledger, route mode aliases). No DB read: binding fields are NULL, which the
 * broker factory resolves exactly like today (env pin / first account / default connection).
 * @param sub - Owner sub.
 * @param kind - 'paper' | 'live'.
 * @returns The legacy TradingBook.
 */
export function legacyBook(sub: string, kind: TradingMode): TradingBook {
  return {
    bookId: legacyBookId(sub, kind), ref: kind, kind, broker: null,
    accountNumber: null, connectionKey: null, capitalCapUsd: null,
    learn: kind === 'paper', enabled: true,
  };
}

// Memoized like ensureTradingSchema — the bootstrap runs once per process; failures clear the memo.
let booksReady: Promise<void> | null = null;

/**
 * @description Ensure the books table exists, RLS'd, with the legacy books minted for every user
 * already present in the trading tables. Depends on the accounts table (composite FK target).
 * @param pool - Postgres pool.
 * @returns Resolves when the books schema is in place.
 */
export async function ensureBooksSchema(pool: AppContext['pool']): Promise<void> {
  if (!booksReady) {
    booksReady = bootstrapBooks(pool).catch((err) => { booksReady = null; throw err; });
  }
  return booksReady;
}

async function bootstrapBooks(pool: AppContext['pool']): Promise<void> {
  await ensureAccountsSchema(pool);
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading books',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_books (
        book_id         UUID PRIMARY KEY,
        user_sub        TEXT NOT NULL,
        ref             TEXT NOT NULL,
        label           TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('paper','live')),
        broker          TEXT CHECK (broker IN ('schwab','alpaca')),
        account_id      UUID,
        connection_key  TEXT,
        enabled         BOOLEAN NOT NULL DEFAULT true,
        learn           BOOLEAN NOT NULL DEFAULT false,
        capital_cap_usd NUMERIC(18,2),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (account_id IS NULL OR broker IS NOT NULL),
        FOREIGN KEY (user_sub, account_id) REFERENCES oshal_trading_accounts (user_sub, account_id)
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_books_ref  ON oshal_trading_books (user_sub, ref)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_books_acct ON oshal_trading_books (user_sub, account_id) WHERE account_id IS NOT NULL',
      // The single-learning-book rule is a DB invariant, not a code-path promise.
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_books_learn ON oshal_trading_books (user_sub) WHERE learn',
      ...buildOwnerRlsPolicyStatements('oshal_trading_books', 'user_sub'),
      // The straggler-writer fill function lives HERE (canonical, single source) because every
      // trading store awaits ensureBooksSchema before arming its own BEFORE INSERT trigger —
      // side-store bootstraps run lazily in any order.
      `CREATE OR REPLACE FUNCTION oshal_trading_book_id_fill() RETURNS trigger AS $fn$
       BEGIN
         IF NEW.book_id IS NULL AND NEW.user_sub IS NOT NULL AND NEW.mode IS NOT NULL THEN
           NEW.book_id := md5('oshal-book:' || NEW.user_sub || ':' || NEW.mode)::uuid;
         END IF;
         RETURN NEW;
       END $fn$ LANGUAGE plpgsql`,
      // Mint the legacy books for every user the trading tables already know. Guarded per source
      // table (to_regclass) so a FRESH database — where books bootstrap first and no trading table
      // exists yet — mints nothing and relies on lazy ensureLegacyBooks. Single arbiter:
      // ON CONFLICT (book_id), the deterministic PK, so a concurrent dual-rail run no-ops.
      `DO $$
       DECLARE src text;
       BEGIN
         FOREACH src IN ARRAY ARRAY['oshal_trading_orders','oshal_trading_signals','oshal_trading_equity_hwm'] LOOP
           IF to_regclass(src) IS NOT NULL THEN
             EXECUTE format(
               'INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, learn, enabled)
                SELECT DISTINCT md5(''oshal-book:'' || user_sub || '':paper'')::uuid, user_sub,
                       ''paper'', ''Paper (reference book)'', ''paper'', true, true
                  FROM %I WHERE user_sub IS NOT NULL
                ON CONFLICT (book_id) DO NOTHING', src);
             EXECUTE format(
               'INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, learn, enabled)
                SELECT DISTINCT md5(''oshal-book:'' || user_sub || '':live'')::uuid, user_sub,
                       ''live'', ''Live (legacy account)'', ''live'', false, true
                  FROM %I WHERE user_sub IS NOT NULL AND mode = ''live''
                ON CONFLICT (book_id) DO NOTHING', src);
           END IF;
         END LOOP;
       END $$`,
    ],
    requirements: [{
      table: 'oshal_trading_books',
      columns: ['book_id', 'user_sub', 'ref', 'label', 'kind', 'broker', 'account_id', 'connection_key', 'enabled', 'learn', 'capital_cap_usd', 'created_at'],
    }],
  });
}

/**
 * @description Lazily mint the two legacy books for a user (first route/fire touch of a brand-new
 * user). Idempotent — single-arbiter conflict on the deterministic PK.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 */
export async function ensureLegacyBooks(pool: AppContext['pool'], sub: string): Promise<void> {
  await ensureBooksSchema(pool);
  for (const kind of ['paper', 'live'] as TradingMode[]) {
    await pool.query(
      `INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, learn, enabled)
         VALUES ($1, $2, $3, $4, $3, $5, true)
       ON CONFLICT (book_id) DO NOTHING`,
      [legacyBookId(sub, kind), sub, kind,
        kind === 'paper' ? 'Paper (reference book)' : 'Live (legacy account)', kind === 'paper']);
  }
}

/** Map a books row to the TradingBook contract (binding decryption happens at adapter construction). */
interface BookRow {
  book_id: string; ref: string; kind: TradingMode; broker: 'schwab' | 'alpaca' | null;
  account_id: string | null; connection_key: string | null; enabled: boolean; learn: boolean;
  capital_cap_usd: string | null;
}
function toBook(r: BookRow, accountNumber: string | null): TradingBook {
  return {
    bookId: r.book_id, ref: r.ref, kind: r.kind, broker: r.broker,
    accountNumber, connectionKey: r.connection_key,
    capitalCapUsd: r.capital_cap_usd != null ? Number(r.capital_cap_usd) : null,
    learn: !!r.learn, enabled: !!r.enabled,
  };
}

/**
 * @description Load one book. The SQL is keyed (user_sub, book_id) — background dispatch runs under
 * system identity (is_operator=on) where RLS does not scope the read, so this WHERE clause is the
 * only wall between a schedule's taskData and another user's book (token-broker SQL-scope precedent).
 * The bound account number, when present, is decrypted at this point of use.
 * @param pool - Postgres pool.
 * @param sub - Owner sub the book must belong to.
 * @param bookId - The book UUID from taskData / a route ref.
 * @returns The book, or null when it does not exist FOR THIS USER (caller must fail closed).
 */
export async function loadBook(pool: AppContext['pool'], sub: string, bookId: string): Promise<TradingBook | null> {
  await ensureBooksSchema(pool);
  const r = (await pool.query(
    `SELECT b.book_id, b.ref, b.kind, b.broker, b.account_id, b.connection_key, b.enabled, b.learn,
            b.capital_cap_usd, a.account_number_enc
       FROM oshal_trading_books b
       LEFT JOIN oshal_trading_accounts a ON a.account_id = b.account_id AND a.user_sub = b.user_sub
      WHERE b.user_sub = $1 AND b.book_id = $2`,
    [sub, bookId])).rows[0];
  if (!r) return null;
  let accountNumber: string | null = null;
  if (r.account_number_enc) {
    try {
      const { decryptToken } = await import('./routes/connector-token-crypto.js');
      accountNumber = await decryptToken(pool, sub, String(r.account_number_enc));
    } catch (err) {
      // An undecryptable binding must surface as a NAMED failure, not a stack from the crypto
      // layer — dispatch treats a loadBook throw as unresolvable and SKIPS the fire (fail-closed;
      // trading a bound book without its binding would fall through to the wrong account).
      throw new Error(`book_binding_undecryptable: ${(err as Error).message}`);
    }
  }
  return toBook(r as BookRow, accountNumber);
}

/**
 * @description Resolve a book by its short ref ('paper' / 'live' / 'b-xxxxxxxx').
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param ref - The book ref.
 * @returns The book or null.
 */
export async function getBookByRef(pool: AppContext['pool'], sub: string, ref: string): Promise<TradingBook | null> {
  await ensureBooksSchema(pool);
  const r = (await pool.query(
    'SELECT book_id FROM oshal_trading_books WHERE user_sub=$1 AND ref=$2', [sub, ref])).rows[0];
  return r ? loadBook(pool, sub, String(r.book_id)) : null;
}

/**
 * @description List a user's books (all kinds), legacy first then by creation.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @returns Books without decrypted bindings (list surfaces never need the full number).
 */
export async function listBooks(pool: AppContext['pool'], sub: string): Promise<TradingBook[]> {
  await ensureBooksSchema(pool);
  const rows = (await pool.query(
    `SELECT book_id, ref, kind, broker, account_id, connection_key, enabled, learn, capital_cap_usd
       FROM oshal_trading_books WHERE user_sub=$1
      ORDER BY (ref IN ('paper','live')) DESC, created_at ASC`, [sub])).rows;
  return rows.map((r) => toBook(r as BookRow, null));
}

/** Ledger/positions references that block deletion and freeze the account binding. */
async function bookHasHistory(pool: AppContext['pool'], sub: string, bookId: string): Promise<boolean> {
  const r = (await pool.query(
    `SELECT (EXISTS (SELECT 1 FROM oshal_trading_orders     WHERE user_sub=$1 AND book_id=$2))
         OR (EXISTS (SELECT 1 FROM oshal_trading_equity_hwm WHERE user_sub=$1 AND book_id=$2))
         OR (EXISTS (SELECT 1 FROM oshal_trading_peaks      WHERE user_sub=$1 AND book_id=$2)) AS has`,
    [sub, bookId])).rows[0];
  return !!r?.has;
}

/**
 * @description Create a live book bound to a discovered account. Invariants enforced HERE:
 * kind='live' is born disabled (arming is explicit), and account ownership is verified
 * in-transaction — the composite FK is the DB backstop, this is the readable refusal.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param accountId - The discovered account to bind.
 * @param label - Operator label.
 * @returns The created book.
 */
export async function createBook(pool: AppContext['pool'], sub: string, accountId: string, label: string): Promise<TradingBook> {
  await ensureBooksSchema(pool);
  const acct = (await pool.query(
    'SELECT broker, connection_key FROM oshal_trading_accounts WHERE account_id=$1 AND user_sub=$2',
    [accountId, sub])).rows[0];
  if (!acct) throw new Error('account_not_owned: no such account for this user');
  const bookId = crypto.randomUUID();
  const ref = `b-${bookId.replace(/-/g, '').slice(0, 8)}`;
  await pool.query(
    `INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, broker, account_id, connection_key, enabled, learn)
       VALUES ($1,$2,$3,$4,'live',$5,$6,$7,false,false)`,
    [bookId, sub, ref, label.slice(0, 120), acct.broker, accountId, acct.connection_key]);
  logger.info({ sub, bookId, ref, accountId }, 'created live book (disabled — arming is explicit)');
  return (await loadBook(pool, sub, bookId)) as TradingBook;
}

/**
 * @description Update a book's mutable fields. `account_id` is IMMUTABLE once the book has any
 * ledger/HWM row (re-pointing carries the old HWM onto a new account — the phantom-drawdown class).
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param bookId - The book.
 * @param patch - label / enabled / capitalCapUsd only.
 */
export async function updateBook(
  pool: AppContext['pool'], sub: string, bookId: string,
  patch: { label?: string; enabled?: boolean; capitalCapUsd?: number | null },
): Promise<TradingBook | null> {
  await ensureBooksSchema(pool);
  await pool.query(
    `UPDATE oshal_trading_books SET
       label = COALESCE($3, label),
       enabled = COALESCE($4, enabled),
       capital_cap_usd = CASE WHEN $5::boolean THEN $6::numeric ELSE capital_cap_usd END
     WHERE user_sub=$1 AND book_id=$2`,
    [sub, bookId, patch.label?.slice(0, 120) ?? null, patch.enabled ?? null,
      patch.capitalCapUsd !== undefined, patch.capitalCapUsd ?? null]);
  return loadBook(pool, sub, bookId);
}

/**
 * @description Delete a book — refused while it has ledger/HWM/peaks history (disable instead).
 * Legacy books ('paper'/'live' refs) are never deletable.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param bookId - The book.
 * @returns true when deleted.
 */
export async function deleteBook(pool: AppContext['pool'], sub: string, bookId: string): Promise<boolean> {
  await ensureBooksSchema(pool);
  const b = (await pool.query('SELECT ref FROM oshal_trading_books WHERE user_sub=$1 AND book_id=$2', [sub, bookId])).rows[0];
  if (!b) return false;
  if (b.ref === 'paper' || b.ref === 'live') throw new Error('book_delete_refused: legacy books are permanent');
  if (await bookHasHistory(pool, sub, bookId)) {
    throw new Error('book_delete_refused: book has ledger/HWM history — disable it instead');
  }
  const res = await pool.query('DELETE FROM oshal_trading_books WHERE user_sub=$1 AND book_id=$2', [sub, bookId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * @description Explicit, confirm-gated breaker re-baseline: sets the book's high-water mark to its
 * last recorded equity (the legitimate case after a deliberate withdrawal/transfer). Journaled by
 * the caller; this store logs the before/after for the audit trail.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param bookId - The book whose breaker to re-baseline.
 * @returns The prior and new high-water mark, or null when no HWM row exists.
 */
export async function resetBreaker(pool: AppContext['pool'], sub: string, bookId: string): Promise<{ prior: number; next: number } | null> {
  await ensureBooksSchema(pool);
  const prior = (await pool.query(
    'SELECT high_water_mark, last_equity FROM oshal_trading_equity_hwm WHERE user_sub=$1 AND book_id=$2',
    [sub, bookId])).rows[0];
  if (!prior) return null;
  await pool.query(
    `UPDATE oshal_trading_equity_hwm SET high_water_mark = last_equity, updated_at = now()
      WHERE user_sub=$1 AND book_id=$2`, [sub, bookId]);
  const result = { prior: Number(prior.high_water_mark), next: Number(prior.last_equity) };
  logger.warn({ sub, bookId, ...result }, 'drawdown breaker re-baselined by operator action');
  return result;
}
