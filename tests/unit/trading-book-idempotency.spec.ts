/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 PR1 idempotency guards on the REAL orders ledger: two books may share a client_order_id without clobbering (the 07-08 class, now book-scoped), within ONE book the reservation arbiter admits exactly one winner (the 08-18 twin-order class), and a decision minted for book A 404s when executed on book B (the ADR-052 justification chain stays book-true).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Provisions its OWN disposable PostgreSQL instead of resolving an address. specDatabaseUrl has no default and throws at IMPORT, so with nothing set this file was one of 14 trading specs collapsed to "no tests" on main. A triage called that environmental - a missing database - and it is not: Docker is up, the image is cached, and the repo already ships DisposablePostgres. The blocker was an in-repo edit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import { ensureTradingSchema, placeDecisionOrder } from '../../src/app/trading-engine';
import { ensureLegacyBooks, legacyBook, legacyBookId } from '../../src/app/trading-books-store';
import { TradingError } from '../../src/app/routes/trading-routes-helpers';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// Its OWN server, not an address. specDatabaseUrl has no default and throws at IMPORT
// when nothing is set, which collapsed this whole file to "no tests". It has no default
// because of the 2026-09-14 incident where trading specs pointed at the operator's live
// Postgres; a disposable cluster answers both halves - nothing to point, nothing to point at.
const fixture = new DisposablePostgres({
  purpose: 'trading-book-idempotency',
  options: '-c row_security=off',
  max: 4,
});
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-adr134i-${RUN}`;

let pool: Pool;

/** Seed a minimal decision row for a book and return its id. */
async function seedDecision(bookId: string, mode: 'paper' | 'live'): Promise<string> {
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, content_hash)
       VALUES ($1,$2,$3,'spec',$4) RETURNING signal_id`,
    [SUB, mode, bookId, `spec-${crypto.randomUUID()}`])).rows[0];
  const d = (await pool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, action, symbol, side, qty, order_type, rationale)
       VALUES ($1,$2,$3,ARRAY[$4]::uuid[],'sell','ARKG','sell',30,'market','spec') RETURNING decision_id`,
    [SUB, mode, bookId, sig.signal_id])).rows[0];
  return String(d.decision_id);
}

beforeAll(async () => {
  delete process.env.TRADING_MULTI_ACCOUNT;
  pool = await fixture.start();
  await ensureTradingSchema(pool as never);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM oshal_trading_orders WHERE user_sub LIKE 'spec-adr134i-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_decisions WHERE user_sub LIKE 'spec-adr134i-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_signals WHERE user_sub LIKE 'spec-adr134i-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub LIKE 'spec-adr134i-%'`).catch(() => {});
  await fixture.stop();
});

describe('the book-scoped orders arbiter', () => {
  it('TWO books may carry the same client_order_id without clobbering (the 07-08 class)', async () => {
    const cid = `${SUB}:shared-${RUN}`;
    const paperBook = legacyBookId(SUB, 'paper');
    const liveBook = legacyBookId(SUB, 'live');
    const dPaper = await seedDecision(paperBook, 'paper');
    const dLive = await seedDecision(liveBook, 'live');
    for (const [bookId, mode, dec] of [[paperBook, 'paper', dPaper], [liveBook, 'live', dLive]] as const) {
      const r = await pool.query(
        `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, client_order_id, symbol, side, qty, order_type, status, raw_status, filled_qty)
           VALUES ($1,$2,$3,$4,'alpaca',$5,'ARKG','sell',30,'market','submitting','SUBMITTING',0)
         ON CONFLICT (user_sub, book_id, client_order_id) DO NOTHING RETURNING order_id`,
        [SUB, mode, bookId, dec, cid]);
      expect(r.rows.length, `${mode} book reservation should win — different book, same cid`).toBe(1);
    }
  });

  it('within ONE book the reservation admits exactly one winner (the 08-18 twin-order class)', async () => {
    const cid = `${SUB}:twin-${RUN}`;
    const bookId = legacyBookId(SUB, 'paper');
    const dec = await seedDecision(bookId, 'paper');
    const insert = () => pool.query(
      `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, client_order_id, symbol, side, qty, order_type, status, raw_status, filled_qty)
         VALUES ($1,'paper',$2,$3,'alpaca',$4,'ARKG','sell',30,'market','submitting','SUBMITTING',0)
       ON CONFLICT (user_sub, book_id, client_order_id) DO NOTHING RETURNING order_id`,
      [SUB, bookId, dec, cid]);
    const [a, b] = await Promise.all([insert(), insert()]);
    expect(a.rows.length + b.rows.length, 'exactly one racer wins the reservation').toBe(1);
  });

  it('book B executing book A’s decision_id → 404 decision_not_found (justification chain stays book-true)', async () => {
    const dec = await seedDecision(legacyBookId(SUB, 'paper'), 'paper');
    const err = await placeDecisionOrder(pool as never, SUB, legacyBook(SUB, 'live'), dec, `req-${RUN}`, true).catch((e) => e);
    expect(err).toBeInstanceOf(TradingError);
    expect((err as TradingError).httpStatus).toBe(404);
    expect((err as TradingError).code).toBe('decision_not_found');
  });

  it('a DISABLED (view-only) book refuses BUYs at the engine; sells pass the disabled check', async () => {
    const paperId = legacyBookId(SUB, 'paper');
    const viewOnly = { ...legacyBook(SUB, 'paper'), enabled: false };
    // BUY on a disabled book → the view-only refusal, before any venue/config concern.
    const buySig = (await pool.query(
      `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, content_hash)
         VALUES ($1,'paper',$2,'spec',$3) RETURNING signal_id`, [SUB, paperId, `spec-buy-${RUN}`])).rows[0];
    const buyDec = (await pool.query(
      `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, action, symbol, side, qty, order_type, rationale)
         VALUES ($1,'paper',$2,ARRAY[$3]::uuid[],'buy','NVDA','buy',1,'market','spec') RETURNING decision_id`,
      [SUB, paperId, buySig.signal_id])).rows[0];
    const buyErr = await placeDecisionOrder(pool as never, SUB, viewOnly, String(buyDec.decision_id), `req-b-${RUN}`, true).catch((e) => e);
    expect(buyErr).toBeInstanceOf(TradingError);
    expect((buyErr as TradingError).code).toBe('book_disabled');
    // SELL on the same disabled book gets PAST the disabled check (risk reduction is always
    // allowed) — whatever it fails on downstream, it is never book_disabled.
    const sellDec = await seedDecision(paperId, 'paper');
    const sellErr = await placeDecisionOrder(pool as never, SUB, viewOnly, sellDec, `req-s-${RUN}`, true).catch((e) => e);
    expect((sellErr as TradingError)?.code).not.toBe('book_disabled');
  });
});
