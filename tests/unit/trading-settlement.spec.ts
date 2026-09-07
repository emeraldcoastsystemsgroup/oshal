/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 D8 cash-account settlement against the REAL oshal Postgres (books/accounts join, the orders ledger, the settlement_policy CHECK) with the venue doubled through the engine's own getBrokerAdapter seam (vi.mock, the trading-duplicate-submission pattern; recorded in the real-boundary audit). Proves: a CASH account loads as a cash-type book and the per-book policy persists (invalid values refused by the store AND the column CHECK); the ledger fallback keys on submitted_at (a days-old sell re-polled today is NOT unsettled); settlesOn is a weekday-only business-day add in ET (Friday → Monday); BOTH refusals cross the ENGINE boundary — placeDecisionOrder for an OPERATOR buy and for an AUTONOMOUS buy on the cash book throws 422 settlement_blocked naming the settlement date and the T+n label, never reaching the venue and leaving no ledger row; a SELL performs zero I/O (pool + venue both throw and it still resolves) and passes the engine's guard; policy 'warn' proceeds with a warning; margin / typeless paper / env 'off' are byte-identical no-ops; venue figures win over the ledger; an unknown type on a live book is cash (fail-closed) and a failed read under 'refuse' is 503 settlement_unknown; source pins the engine ordering (after guardrails, before the reservation INSERT). Run with --no-file-parallelism.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix guards: a market BUY whose price read throws (or answers null) with unsettled proceeds present is 503 under refuse and an explicit "NOT checked for unsettled funding" advisory under warn — never a silent $0 pass; with nothing unsettled the price is never read. Source pin: the kernel module contains no silent catch (every catch binds err and logs it at error).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import type { BrokerAccount, OrderResult, TradingBook } from '../../src/features/trading';

const h = vi.hoisted(() => ({
  getAccount: vi.fn(),
  placeOrder: vi.fn(),
  getPositions: vi.fn(async () => []),
  latestPrice: vi.fn(async () => 100),
}));

vi.mock('@/features/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/trading')>();
  return {
    ...actual,
    liveTradingEnabled: () => true,
    tradingSession: async () => 'regular',
    getMarketData: () => ({ latestPrice: h.latestPrice, latestTrade: async () => null }),
    // The venue double, reached ONLY through the engine's own factory seam — the DB is real.
    getBrokerAdapter: () => ({
      provider: 'schwab', mode: () => 'live', configured: () => true,
      getAccount: h.getAccount, placeOrder: h.placeOrder, getPositions: h.getPositions,
    }),
  };
});

import { ensureTradingSchema, placeDecisionOrder } from '../../src/app/trading-engine';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook, loadBook, createBook, updateBook, listBooks } from '../../src/app/trading-books-store';
import { ensureAccountsSchema, accountDigest } from '../../src/app/trading-accounts-store';
import { TradingError } from '../../src/app/routes/trading-routes-helpers';
import {
  assertSettledFunding, buildSettlementView, clampToSettled, settledBuyingPower, settlementViolation, gfvAdvisory,
  nextSettlementDate, unsettledLedgerSells, settlementPolicy, settlementApplies, settlementLabel, etDay,
} from '../../src/app/trading-settlement';
import { schwabSettlementFigures } from '../../src/features/trading/services/schwab-broker-adapter';
import { alpacaAccountType } from '../../src/features/trading/services/alpaca-broker-adapter';

const DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-settle-${RUN}`;
let pool: Pool;
let cashBook: TradingBook;

/** The venue's view of the cash account: $10,000 cash of which $2,000 is settled and $8,000 is fresh sale proceeds. */
const CASH_ACCOUNT: BrokerAccount = { cash: 10000, buyingPower: 10000, equity: 50000, currency: 'USD', accountType: 'cash', settledCash: 2000, unsettledCash: 8000 };
const FILL: OrderResult = { id: 'sch-1', clientOrderId: 'x', symbol: 'MSFT', side: 'buy', qty: 1, type: 'market', status: 'filled', filledQty: 1, filledAvgPrice: 100, provider: 'schwab', mode: 'live' };

async function seedAccount(type: string): Promise<string> {
  const num = `8${RUN}${type.length}`;
  const { encryptToken } = await import('../../src/app/routes/connector-token-crypto');
  const enc = await encryptToken(pool as never, SUB, num);
  const r = await pool.query(
    `INSERT INTO oshal_trading_accounts (user_sub, broker, connection_key, account_number_enc, account_digest, account_last4, account_type)
       VALUES ($1,'schwab','default',$2,$3,$4,$5) RETURNING account_id`, [SUB, enc, accountDigest(SUB, num), num.slice(-4), type]);
  return String(r.rows[0].account_id);
}

async function seedDecision(book: TradingBook, d: { side: 'buy' | 'sell'; symbol: string; qty: number; agentId: string; orderType?: string; limitPrice?: number | null }): Promise<string> {
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, content_hash) VALUES ($1,$2,$3,'spec',$4) RETURNING signal_id`,
    [SUB, book.kind, book.bookId, `spec-${crypto.randomUUID()}`])).rows[0];
  const row = (await pool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, limit_price, rationale)
       VALUES ($1,$2,$3,ARRAY[$4]::uuid[],$5,$6,$7,$6,$8,$9,$10,'spec') RETURNING decision_id`,
    [SUB, book.kind, book.bookId, sig.signal_id, d.agentId, d.side, d.symbol, d.qty, d.orderType ?? 'limit', d.limitPrice === undefined ? 100 : d.limitPrice])).rows[0];
  return String(row.decision_id);
}

/** A filled SELL row on the book with an explicit trade time (submitted_at) and updated_at = now(). */
async function seedFilledSell(book: TradingBook, symbol: string, qty: number, price: number, submittedAt: Date): Promise<void> {
  const dec = await seedDecision(book, { side: 'sell', symbol, qty, agentId: 'rotation' });
  await pool.query(
    `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, client_order_id, symbol, side, qty, order_type, status, raw_status, filled_qty, filled_avg_price, submitted_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'schwab',$5,$6,'sell',$7,'market','filled','FILLED',$7,$8,$9,$9,now())`,
    [SUB, book.kind, book.bookId, dec, `${SUB}:sell-${crypto.randomUUID().slice(0, 8)}`, symbol, qty, price, submittedAt.toISOString()]);
}

const asError = (p: Promise<unknown>) => p.then(() => null as unknown, (e) => e as TradingError);

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  process.env.TRADING_EXTENDED_HOURS = 'false';
  delete process.env.TRADING_MULTI_ACCOUNT; delete process.env.TRADING_CASH_SETTLEMENT_POLICY; delete process.env.TRADING_SETTLEMENT_DAYS;
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try { await pool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-settlement requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureAccountsSchema(pool as never); await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never);
  await ensureLegacyBooks(pool as never, SUB);
  const acct = await seedAccount('CASH');
  const created = await createBook(pool as never, SUB, acct, 'IRA (cash) spec');
  cashBook = (await loadBook(pool as never, SUB, created.bookId)) as TradingBook;
}, 120_000);

afterAll(async () => {
  for (const t of ['oshal_trading_orders', 'oshal_trading_decisions', 'oshal_trading_signals', 'oshal_trading_books', 'oshal_trading_accounts']) {
    await pool.query(`DELETE FROM ${t} WHERE user_sub = $1`, [SUB]).catch(() => {});
  }
  await pool.end();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.getAccount.mockResolvedValue(CASH_ACCOUNT);
  h.placeOrder.mockResolvedValue(FILL);
  h.getPositions.mockResolvedValue([]);
  h.latestPrice.mockResolvedValue(100);
  delete process.env.TRADING_CASH_SETTLEMENT_POLICY; delete process.env.TRADING_SETTLEMENT_DAYS;
});

describe('the book carries its account type and settlement policy (real books/accounts join)', () => {
  it('a book bound to a CASH account loads with accountType cash; listBooks carries it too; legacy books are typeless', async () => {
    expect(cashBook.accountType).toBe('cash');
    expect(cashBook.settlementPolicy).toBeNull();
    expect((await listBooks(pool as never, SUB)).find((b) => b.bookId === cashBook.bookId)?.accountType).toBe('cash');
    expect(legacyBook(SUB, 'live').accountType).toBeNull();
  });

  it('updateBook persists refuse|warn|null and refuses anything else; the column CHECK refuses a raw UPDATE to off', async () => {
    expect((await updateBook(pool as never, SUB, cashBook.bookId, { settlementPolicy: 'warn' }))?.settlementPolicy).toBe('warn');
    expect((await updateBook(pool as never, SUB, cashBook.bookId, { settlementPolicy: null }))?.settlementPolicy).toBeNull();
    await expect(updateBook(pool as never, SUB, cashBook.bookId, { settlementPolicy: 'off' as never })).rejects.toThrow(/settlement_policy_invalid/);
    await expect(pool.query(`UPDATE oshal_trading_books SET settlement_policy='off' WHERE user_sub=$1 AND book_id=$2`, [SUB, cashBook.bookId])).rejects.toThrow(/check constraint/i);
  });

  it('policy resolution: env off disarms fleet-wide; otherwise the book override wins over the env default (refuse)', () => {
    expect(settlementPolicy(cashBook)).toBe('refuse');
    expect(settlementPolicy({ ...cashBook, settlementPolicy: 'warn' })).toBe('warn');
    process.env.TRADING_CASH_SETTLEMENT_POLICY = 'warn';
    expect(settlementPolicy(cashBook)).toBe('warn');
    expect(settlementPolicy({ ...cashBook, settlementPolicy: 'refuse' })).toBe('refuse');
    process.env.TRADING_CASH_SETTLEMENT_POLICY = 'off';
    expect(settlementPolicy({ ...cashBook, settlementPolicy: 'refuse' })).toBe('off');
    expect(settlementApplies(cashBook)).toBe(false);
  });
});

describe('venue field semantics (pure adapter helpers)', () => {
  it('Schwab: settled = cashAvailableForTrading − unsettledCash (tradable INCLUDES unsettled proceeds); withdrawal is the fallback; a margin block has none', () => {
    expect(schwabSettlementFigures({ cashAvailableForTrading: 10000, unsettledCash: 8000, cashAvailableForWithdrawal: 1500 })).toEqual({ settledCash: 2000, unsettledCash: 8000 });
    expect(schwabSettlementFigures({ cashAvailableForWithdrawal: 1500 })).toEqual({ settledCash: 1500, unsettledCash: undefined });
    expect(schwabSettlementFigures({ buyingPower: 40000, availableFunds: 20000 })).toEqual({ settledCash: undefined, unsettledCash: undefined });
    expect(schwabSettlementFigures(undefined)).toEqual({});
  });

  it('Alpaca: multiplier 1 → cash, 2/4 → margin, absent → undefined', () => {
    expect(alpacaAccountType('1')).toBe('cash');
    expect(alpacaAccountType('2')).toBe('margin');
    expect(alpacaAccountType('4')).toBe('margin');
    expect(alpacaAccountType(undefined)).toBeUndefined();
    expect(alpacaAccountType('')).toBeUndefined();
  });
});

describe('settlement dates (ET, weekday-only)', () => {
  it('T+1: Thu → Fri, Fri → Mon, a weekend-dated trade → the business day after Monday; T+2 Fri → Tue; the label derives from the env', () => {
    expect(nextSettlementDate(new Date('2026-09-03T18:00:00Z'), 1)).toEqual({ iso: '2026-09-04', words: 'Fri Sep 4' });
    expect(nextSettlementDate(new Date('2026-09-04T18:00:00Z'), 1)).toEqual({ iso: '2026-09-07', words: 'Mon Sep 7' });
    expect(nextSettlementDate(new Date('2026-09-05T18:00:00Z'), 1).iso).toBe('2026-09-08');
    expect(nextSettlementDate(new Date('2026-09-04T18:00:00Z'), 2)).toEqual({ iso: '2026-09-08', words: 'Tue Sep 8' });
    // 23:30 ET on Sep 4 is 03:30Z Sep 5 — the ET day, not the UTC day, is the trade day.
    expect(etDay(new Date('2026-09-05T03:30:00Z'))).toBe('2026-09-04');
    expect(settlementLabel()).toBe('T+1');
    process.env.TRADING_SETTLEMENT_DAYS = '2';
    expect(settlementLabel()).toBe('T+2');
  });
});

describe('the ledger fallback (real orders rows)', () => {
  it('keys on submitted_at — a sell filled 10 days ago but re-polled today (updated_at = now) is NOT unsettled', async () => {
    await seedFilledSell(cashBook, 'OLD', 10, 50, new Date(Date.now() - 10 * 86_400_000));
    await seedFilledSell(cashBook, 'NEW', 20, 100, new Date());
    const sells = await unsettledLedgerSells(pool as never, SUB, cashBook);
    expect(sells.map((s) => s.symbol)).toEqual(['NEW']);
    expect(sells[0].qty * sells[0].price).toBe(2000);
  });

  it('buildSettlementView: venue figures win over the ledger; without them settled = cash − Σ ledger sells; no account → source n/a with settled null', async () => {
    const sells = await unsettledLedgerSells(pool as never, SUB, cashBook);
    const venue = buildSettlementView(CASH_ACCOUNT, cashBook, sells);
    expect(venue).toMatchObject({ accountType: 'cash', policy: 'refuse', cash: 10000, settledCash: 2000, unsettledCash: 8000, source: 'venue' });
    expect(venue.settlesOn?.iso).toBe(nextSettlementDate(new Date()).iso);
    const ledger = buildSettlementView({ cash: 10000, buyingPower: 10000, equity: 50000, currency: 'USD', accountType: 'cash' }, cashBook, sells);
    expect(ledger).toMatchObject({ settledCash: 8000, unsettledCash: 2000, source: 'ledger' });
    expect(buildSettlementView(null, cashBook, [])).toMatchObject({ accountType: 'cash', settledCash: null, source: 'n/a' });
    // An unknown type on a LIVE book is cash (fail-closed); on paper it is margin.
    expect(buildSettlementView({ cash: 1, buyingPower: 1, equity: 1, currency: 'USD' }, legacyBook(SUB, 'live'), []).accountType).toBe('unknown');
    expect(buildSettlementView({ cash: 1, buyingPower: 1, equity: 1, currency: 'USD' }, legacyBook(SUB, 'paper'), []).accountType).toBe('margin');
  });
});

describe('the pure clamp and violation', () => {
  it('clampToSettled caps cash/buyingPower at settled cash; margin, policy off and an unknown settled figure return the SAME values (paper byte-identity)', () => {
    const acct: BrokerAccount = { cash: 10000, buyingPower: 10000, equity: 50000, currency: 'USD' };
    const view = buildSettlementView(CASH_ACCOUNT, cashBook, []);
    expect(clampToSettled(acct, view)).toMatchObject({ cash: 2000, buyingPower: 2000, equity: 50000 });
    expect(clampToSettled(acct, { ...view, accountType: 'margin' })).toEqual(acct);
    expect(clampToSettled(acct, { ...view, policy: 'off' })).toEqual(acct);
    expect(clampToSettled(acct, { ...view, settledCash: null, source: 'n/a' })).toEqual(acct);
    // The dispatcher's one-line hook: a margin book is untouched, a cash book is clamped from the venue snapshot alone.
    expect(settledBuyingPower(acct, { ...cashBook, accountType: 'margin' })).toEqual(acct);
    expect(settledBuyingPower(CASH_ACCOUNT, cashBook)).toMatchObject({ cash: 2000, buyingPower: 2000 });
    expect(settledBuyingPower(acct, legacyBook(SUB, 'paper'))).toEqual(acct);
  });

  it('settlementViolation trips only when the buy needs unsettled proceeds; the message names the date and the T+n label, never a typed literal', () => {
    const view = buildSettlementView(CASH_ACCOUNT, cashBook, [{ symbol: 'NEW', qty: 20, price: 100, tradedAt: new Date('2026-09-04T18:00:00Z') }]);
    const v = settlementViolation(view, 5000);
    expect(v).toMatchObject({ code: 'settlement_blocked', warnOnly: false, settlesOn: { iso: '2026-09-07', words: 'Mon Sep 7' } });
    expect(v?.message).toContain('Only $2,000.00 of your $10,000.00 cash is settled');
    expect(v?.message).toContain('settle on Mon Sep 7 (T+1)');
    expect(settlementViolation(view, 1999)).toBeNull();
    expect(settlementViolation({ ...view, unsettledCash: 0, settledCash: 1000 }, 5000)).toBeNull(); // plain shortfall = the venue's own refusal
    expect(settlementViolation({ ...view, policy: 'warn' }, 5000)?.warnOnly).toBe(true);
    process.env.TRADING_SETTLEMENT_DAYS = '2';
    expect(settlementViolation({ ...view, settlementDays: 2 }, 5000)?.message).toContain('(T+2)');
  });

  it('gfvAdvisory warns on selling a symbol bought while proceeds were unsettled — and never on margin', () => {
    const view = buildSettlementView(CASH_ACCOUNT, cashBook, [{ symbol: 'NEW', qty: 20, price: 100, tradedAt: new Date() }]);
    expect(gfvAdvisory(view, 'msft', [{ symbol: 'MSFT', tradedAt: new Date() }])).toMatch(/good-faith violation \(T\+1\)/);
    expect(gfvAdvisory(view, 'MSFT', [])).toBeNull();
    expect(gfvAdvisory({ ...view, accountType: 'margin' }, 'MSFT', [{ symbol: 'MSFT', tradedAt: new Date() }])).toBeNull();
  });
});

describe('assertSettledFunding — the helper', () => {
  const throwingPool = { query: async () => { throw new Error('pool must not be touched'); } } as never;
  const deps = { readAccount: async () => { throw new Error('venue must not be touched'); }, priceOf: async () => 100 };

  it('a SELL performs ZERO I/O — the pool and the venue both throw and it still resolves (protective exits are untouched)', async () => {
    await expect(assertSettledFunding(throwingPool, SUB, cashBook, 'sell', 'MSFT', 5, 100, deps)).resolves.toEqual({ warning: null, view: null });
  });

  it('margin, typeless paper and env off are no-ops with no I/O', async () => {
    await expect(assertSettledFunding(throwingPool, SUB, { ...cashBook, accountType: 'margin' }, 'buy', 'MSFT', 50, 100, deps)).resolves.toEqual({ warning: null, view: null });
    await expect(assertSettledFunding(throwingPool, SUB, legacyBook(SUB, 'paper'), 'buy', 'MSFT', 50, 100, deps)).resolves.toEqual({ warning: null, view: null });
    process.env.TRADING_CASH_SETTLEMENT_POLICY = 'off';
    await expect(assertSettledFunding(throwingPool, SUB, cashBook, 'buy', 'MSFT', 50, 100, deps)).resolves.toEqual({ warning: null, view: null });
  });

  it('an unknown type on a LIVE book is cash: a failed venue read under refuse is 503 settlement_unknown; under warn it proceeds', async () => {
    const e = await asError(assertSettledFunding(pool as never, SUB, legacyBook(SUB, 'live'), 'buy', 'MSFT', 50, 100, deps));
    expect(e).toBeInstanceOf(TradingError);
    expect(e).toMatchObject({ httpStatus: 503, code: 'settlement_unknown' });
    await expect(assertSettledFunding(pool as never, SUB, { ...legacyBook(SUB, 'live'), settlementPolicy: 'warn' }, 'buy', 'MSFT', 50, 100, deps)).resolves.toEqual({ warning: null, view: null });
  });

  it('a market BUY whose price read FAILS with unsettled proceeds present: refuse → 503 settlement_unknown; warn → a "NOT checked" advisory, never a silent pass', async () => {
    const blind = { readAccount: async () => CASH_ACCOUNT, priceOf: async () => { throw new Error('quote feed down'); } };
    const e = await asError(assertSettledFunding(pool as never, SUB, cashBook, 'buy', 'NVDA', 30, 0, blind));
    expect(e).toMatchObject({ httpStatus: 503, code: 'settlement_unknown' });
    const r = await assertSettledFunding(pool as never, SUB, { ...cashBook, settlementPolicy: 'warn' }, 'buy', 'NVDA', 30, 0, blind);
    expect(r.view?.source).toBe('venue');
    expect(r.warning).toContain('Could not price NVDA');
    expect(r.warning).toContain('NOT checked for unsettled funding');
    expect(r.warning).toContain(`(${settlementLabel()})`);
    // A null price (feed answered "no quote") behaves the same as a thrown one.
    const noQuote = { ...blind, priceOf: async () => null };
    expect((await assertSettledFunding(pool as never, SUB, { ...cashBook, settlementPolicy: 'warn' }, 'buy', 'NVDA', 30, 0, noQuote)).warning).toContain('NOT checked');
    // With NOTHING unsettled (venue figures win over the ledger) the price is never read — the guard cannot trip regardless of size.
    const untouched = { readAccount: async () => ({ ...CASH_ACCOUNT, settledCash: 10000, unsettledCash: 0 }), priceOf: async () => { throw new Error('must not be read'); } };
    await expect(assertSettledFunding(pool as never, SUB, cashBook, 'buy', 'NVDA', 30, 0, untouched)).resolves.toMatchObject({ warning: null });
  });

  it('a venue that reports margin on a typeless live book is a no-op after the read', async () => {
    const r = await assertSettledFunding(pool as never, SUB, legacyBook(SUB, 'live'), 'buy', 'MSFT', 50, 100, { ...deps, readAccount: async () => ({ ...CASH_ACCOUNT, accountType: 'margin' as const }) });
    expect(r.warning).toBeNull(); expect(r.view?.accountType).toBe('margin');
  });
});

describe('placeDecisionOrder — the refusal crosses the ENGINE boundary (real DB, venue doubled at the factory seam)', () => {
  it('REFUSAL 1: an OPERATOR buy on the cash book is refused 422 settlement_blocked, names the settlement date, never reaches the venue, leaves no ledger row', async () => {
    const dec = await seedDecision(cashBook, { side: 'buy', symbol: 'MSFT', qty: 50, agentId: 'operator', limitPrice: 100 });
    const e = await asError(placeDecisionOrder(pool as never, SUB, cashBook, dec, `op-${RUN}`, true));
    expect(e).toBeInstanceOf(TradingError);
    expect(e).toMatchObject({ httpStatus: 422, code: 'settlement_blocked' });
    const settles = nextSettlementDate(new Date()); // the NEW sell seeded above was traded today
    expect((e as TradingError).message).toContain(`settle on ${settles.words} (${settlementLabel()})`);
    expect((e as TradingError).message).toContain('$5,000.00 buy');
    expect(h.getAccount).toHaveBeenCalledTimes(1);
    expect(h.placeOrder).not.toHaveBeenCalled();
    const rows = await pool.query('SELECT 1 FROM oshal_trading_orders WHERE user_sub=$1 AND client_order_id=$2', [SUB, `${SUB}:op-${RUN}`]);
    expect(rows.rows.length, 'a refusal before the reservation leaves nothing to release').toBe(0);
  });

  it('REFUSAL 2: an AUTONOMOUS market buy (priced through the book\'s data source) on the ENABLED cash book meets the same wall', async () => {
    await updateBook(pool as never, SUB, cashBook.bookId, { enabled: true });
    const enabled = (await loadBook(pool as never, SUB, cashBook.bookId)) as TradingBook;
    expect(enabled.enabled).toBe(true);
    const dec = await seedDecision(enabled, { side: 'buy', symbol: 'NVDA', qty: 30, agentId: 'a0000000-0000-0000-0000-000000000046', orderType: 'market', limitPrice: null });
    const e = await asError(placeDecisionOrder(pool as never, SUB, enabled, dec, `auto-${RUN}`, true));
    expect(e).toMatchObject({ httpStatus: 422, code: 'settlement_blocked' });
    expect((e as TradingError).message).toContain('$3,000.00 buy'); // 30 × the $100 latestPrice — refPrice is 0 for a market order
    expect(h.latestPrice).toHaveBeenCalledWith('NVDA');
    expect(h.placeOrder).not.toHaveBeenCalled();
  });

  it('a buy inside settled cash proceeds; a SELL on the cash book never consults the venue account', async () => {
    const small = await seedDecision(cashBook, { side: 'buy', symbol: 'MSFT', qty: 10, agentId: 'operator', limitPrice: 100 }); // $1,000 ≤ $2,000 settled
    const r = await placeDecisionOrder(pool as never, SUB, cashBook, small, `ok-${RUN}`, true);
    expect(r.status).toBe('filled');
    expect(h.getAccount).toHaveBeenCalledTimes(1);
    expect(h.placeOrder).toHaveBeenCalledTimes(1);
    vi.clearAllMocks(); h.placeOrder.mockResolvedValue({ ...FILL, side: 'sell' }); h.getPositions.mockResolvedValue([]);
    const sell = await seedDecision(cashBook, { side: 'sell', symbol: 'MSFT', qty: 5, agentId: 'operator', limitPrice: 100 });
    await placeDecisionOrder(pool as never, SUB, cashBook, sell, `sell-${RUN}`, true);
    expect(h.getAccount).not.toHaveBeenCalled();
    expect(h.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('policy warn (per-book override) lets the same buy through to the venue', async () => {
    await updateBook(pool as never, SUB, cashBook.bookId, { settlementPolicy: 'warn' });
    const warnBook = (await loadBook(pool as never, SUB, cashBook.bookId)) as TradingBook;
    expect(warnBook.settlementPolicy).toBe('warn');
    const dec = await seedDecision(warnBook, { side: 'buy', symbol: 'MSFT', qty: 50, agentId: 'operator', limitPrice: 100 });
    const r = await placeDecisionOrder(pool as never, SUB, warnBook, dec, `warn-${RUN}`, true);
    expect(r.status).toBe('filled');
    expect(h.placeOrder).toHaveBeenCalledTimes(1);
    await updateBook(pool as never, SUB, cashBook.bookId, { settlementPolicy: null });
  });

  it('env TRADING_CASH_SETTLEMENT_POLICY=off disarms the guard: no venue account read, the buy reaches the venue', async () => {
    process.env.TRADING_CASH_SETTLEMENT_POLICY = 'off';
    const dec = await seedDecision(cashBook, { side: 'buy', symbol: 'MSFT', qty: 50, agentId: 'operator', limitPrice: 100 });
    const r = await placeDecisionOrder(pool as never, SUB, cashBook, dec, `off-${RUN}`, true);
    expect(r.status).toBe('filled');
    expect(h.getAccount).not.toHaveBeenCalled();
  });
});

describe('source pins — the engine ordering and the dispatcher hook surface', () => {
  const engine = readFileSync(path.resolve(__dirname, '../../src/app/trading-engine.ts'), 'utf8');

  it('placeDecisionOrder calls assertSettledFunding AFTER guardrailViolation and BEFORE the reservation INSERT', () => {
    const guard = engine.indexOf('const violation = guardrailViolation(g, symbol, qty, refPrice);');
    const settle = engine.indexOf('await assertSettledFunding(pool, sub, book, d.side, symbol, qty, refPrice, {');
    const reserve = engine.indexOf("VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitting','SUBMITTING',0,now())");
    expect(guard).toBeGreaterThan(0); expect(settle).toBeGreaterThan(guard); expect(reserve).toBeGreaterThan(settle);
    // The decision SELECT and the operator-authored lines are untouched (pinned by trading-manual-buy-disabled-book.spec.ts).
    expect(engine).toContain("const operatorAuthored = d.agent_id === 'operator' || d.agent_id === 'pinned-lot' || d.agent_id === 'event-playbook';");
  });

  it('the refusal copy carries no typed T+1 — every label derives from TRADING_SETTLEMENT_DAYS', () => {
    const settlement = readFileSync(path.resolve(__dirname, '../../src/app/trading-settlement.ts'), 'utf8');
    const code = settlement.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/['"`][^'"`]*T\+1[^'"`]*['"`]/);
    expect(settlement).toContain('return `T+${days}`;');
  });

  it('the module has NO silent catch — every catch binds the error and logs it', () => {
    const settlement = readFileSync(path.resolve(__dirname, '../../src/app/trading-settlement.ts'), 'utf8');
    expect(settlement).not.toMatch(/\.catch\(\(\)\s*=>/);
    expect(settlement).not.toMatch(/catch\s*\{/);
    for (const m of settlement.matchAll(/catch\s*\((\w+)\)\s*\{([^}]*)\}/g)) expect(m[2], `catch (${m[1]}) must log the err`).toMatch(/logger\.error\(\{ err/);
    for (const m of settlement.matchAll(/\.catch\(\((\w+)\)\s*=>\s*\{([^}]*)\}/g)) expect(m[2], `.catch((${m[1]}) => …) must log the err`).toMatch(/logger\.error\(\{ err/);
  });
});
