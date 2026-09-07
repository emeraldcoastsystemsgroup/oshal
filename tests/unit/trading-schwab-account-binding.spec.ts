/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-134 Schwab account-pin retirement. The hazard it pins: an UNBOUND Schwab reader used to take SCHWAB_ACCOUNT_NUMBER "else the FIRST account the venue enumerates", and this operator's connected login enumerates THREE real accounts (a legacy live book, a margin account and a cash IRA) - so which real-money account was read and traded was decided by enumeration order. Proven here: selectSchwabAccount uses a single enumerated account, REFUSES two-or-more unbound (naming the count and the remedy), matches a bound book exactly regardless of enumeration order, and the same refusal reaches BOTH a read path (getAccount) and an order path (placeOrder, which never issues its POST) through a real fetch seam. Against the live Postgres: loadLegacyBook falls back to the pure constructor only when the ROW is absent and RETHROWS book_binding_undecryptable rather than degrading into an unbound book (the swallow that used to live in resolveBook), and resolveBook inherits that. Finally a source pin that nothing in src/, scripts/, the compose file or .env.example reads the env pin any more.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { selectSchwabAccount, SchwabBrokerAdapter } from '../../src/features/trading/services/schwab-broker-adapter';
import {
  ensureBooksSchema, legacyBook, legacyBookId, loadLegacyBook,
} from '../../src/app/trading-books-store';
import { ensureAccountsSchema } from '../../src/app/trading-accounts-store';
import { resolveBook } from '../../src/app/routes/trading-routes-helpers';

const REPO = path.resolve(__dirname, '../..');
const DSN = process.env.OSHAL_TEST_DSN
  || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB_ROWLESS = `spec-schwabpin-${RUN}-rowless`;
const SUB_BROKEN = `spec-schwabpin-${RUN}-broken`;
const SUB_VIEWONLY = `spec-schwabpin-${RUN}-viewonly`;

/** The three accounts this operator's Schwab login actually enumerates (shape, not real numbers). */
const THREE = [
  { accountNumber: '10000001', hashValue: 'HASH-LEGACY' },
  { accountNumber: '10000002', hashValue: 'HASH-MARGIN' },
  { accountNumber: '10000003', hashValue: 'HASH-CASH-IRA' },
];

let pool: Pool;

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = process.env.TRADING_MAX_NOTIONAL_USD || '50000';
  process.env.TRADING_MAX_QTY = process.env.TRADING_MAX_QTY || '100000';
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(`trading-schwab-account-binding requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureAccountsSchema(pool as never);
  await ensureBooksSchema(pool as never);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub LIKE 'spec-schwabpin-%'`).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_accounts WHERE user_sub LIKE 'spec-schwabpin-%'`).catch(() => {});
  await pool.end();
});

/* ─── the selection rule itself ─────────────────────────────────────────────────────────────── */

describe('selectSchwabAccount — an unbound reader never guesses', () => {
  it('uses the account when the connection enumerates exactly one', () => {
    expect(selectSchwabAccount([THREE[1]], null)).toEqual(THREE[1]);
  });

  it('REFUSES an unbound book on a multi-account login, naming the count and the remedy', () => {
    let message = '';
    try { selectSchwabAccount(THREE, null); } catch (err) { message = (err as Error).message; }
    expect(message, 'selectSchwabAccount must throw for an unbound book with 3 accounts').not.toBe('');
    expect(message).toContain('enumerates 3 accounts');
    expect(message).toContain('not bound');
    expect(message).toMatch(/refusing to guess/i);
    expect(message).toContain('Accounts & books');
    // The whole point: it must not have silently returned one of them.
    expect(message).not.toContain('undefined');
  });

  it('refuses an empty enumeration rather than returning undefined', () => {
    expect(() => selectSchwabAccount([], null)).toThrow(/no accounts/i);
  });

  it('a BOUND book gets its own account whatever the enumeration order', () => {
    expect(selectSchwabAccount(THREE, '10000003')).toEqual(THREE[2]);
    expect(selectSchwabAccount([...THREE].reverse(), '10000003')).toEqual(THREE[2]);
    expect(selectSchwabAccount([THREE[2]], '10000003')).toEqual(THREE[2]);
  });

  it('a BOUND account missing from the enumeration refuses instead of falling back', () => {
    expect(() => selectSchwabAccount(THREE, '19999999')).toThrow(/refusing to fall back/i);
    expect(() => selectSchwabAccount(THREE, '19999999')).toThrow(/…9999/);
  });
});

/* ─── the same refusal on a read path AND an order path (real fetch seam) ───────────────────── */

interface FetchCall { url: string; method: string }

/** Stand in for the Schwab venue: records every request, answers the enumeration + account reads. */
function stubVenue(calls: FetchCall[], accounts: Array<{ accountNumber: string; hashValue: string }>): void {
  const res = (body: unknown, status = 200, location?: string) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location ?? null : null) },
    text: async () => JSON.stringify(body),
  }) as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method || 'GET') });
    if (String(url).includes('/accounts/accountNumbers')) return res(accounts);
    if (String(url).includes('/orders')) return res({}, 201, 'https://api.schwabapi.com/trader/v1/accounts/x/orders/999');
    return res({ securitiesAccount: { accountNumber: '10000003', type: 'CASH', currentBalances: { cashBalance: 1, liquidationValue: 1 } } });
  }));
}

const ORDER = {
  userSub: 'spec', symbol: 'MSFT', side: 'buy' as const, qty: 1, type: 'market' as const,
  clientOrderId: `spec-${RUN}`,
};

describe('SchwabBrokerAdapter — the refusal reaches reads and orders alike', () => {
  it('an UNBOUND adapter on a 3-account login refuses the account READ before addressing anything', async () => {
    const calls: FetchCall[] = [];
    stubVenue(calls, THREE);
    const a = new SchwabBrokerAdapter('live', async () => 'tok', `${RUN}-read-unbound`, null);
    await expect(a.getAccount()).rejects.toThrow(/enumerates 3 accounts/);
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining('/accounts/accountNumbers')]);
    vi.unstubAllGlobals();
  });

  it('an UNBOUND adapter on a 3-account login refuses placeOrder and issues NO POST', async () => {
    const calls: FetchCall[] = [];
    stubVenue(calls, THREE);
    const a = new SchwabBrokerAdapter('live', async () => 'tok', `${RUN}-order-unbound`, null);
    await expect(a.placeOrder({ ...ORDER })).rejects.toThrow(/refusing to guess/i);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('an UNBOUND adapter on a SINGLE-account login still works (the rule is single-or-refuse)', async () => {
    const calls: FetchCall[] = [];
    stubVenue(calls, [THREE[2]]);
    const a = new SchwabBrokerAdapter('live', async () => 'tok', `${RUN}-single`, null);
    await expect(a.getAccount()).resolves.toMatchObject({ currency: 'USD' });
    expect(calls.some((c) => c.url.includes(`/accounts/${THREE[2].hashValue}`))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('a BOUND adapter addresses ITS account hash, not the first enumerated one', async () => {
    const calls: FetchCall[] = [];
    stubVenue(calls, THREE);
    const a = new SchwabBrokerAdapter('live', async () => 'tok', `${RUN}-bound`, '10000003');
    await a.getAccount();
    expect(calls.some((c) => c.url.includes(`/accounts/${THREE[2].hashValue}`))).toBe(true);
    expect(calls.some((c) => c.url.includes(THREE[0].hashValue))).toBe(false);
    vi.unstubAllGlobals();
  });
});

/* ─── loadLegacyBook: fall back on an ABSENT row, never on a THROW (live Postgres) ──────────── */

/** Bind a legacy live book to an account whose stored binding cannot be decrypted. */
async function seedUndecryptableLegacyLive(sub: string): Promise<void> {
  const acct = (await pool.query(
    `INSERT INTO oshal_trading_accounts
       (user_sub, broker, connection_key, account_number_enc, account_digest, account_last4, account_type)
     VALUES ($1,'schwab','default','not-a-valid-envelope',$2,'6771','MARGIN') RETURNING account_id`,
    [sub, `spec-digest-${sub}`])).rows[0];
  await pool.query(
    `INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, broker, account_id, connection_key, enabled, learn)
       VALUES ($1,$2,'live','Live (legacy account)','live','schwab',$3,'default',true,false)`,
    [legacyBookId(sub, 'live'), sub, String(acct.account_id)]);
}

describe('loadLegacyBook — the row is the binding, and a failure never degrades to unbound', () => {
  it('falls back to the pure legacy book when the row is genuinely ABSENT', async () => {
    const book = await loadLegacyBook(pool as never, SUB_ROWLESS, 'live');
    expect(book).toEqual(legacyBook(SUB_ROWLESS, 'live'));
    expect(book.accountNumber).toBeNull();
  });

  it('RETHROWS an undecryptable binding instead of handing back an unbound book', async () => {
    await seedUndecryptableLegacyLive(SUB_BROKEN);
    const err = await loadLegacyBook(pool as never, SUB_BROKEN, 'live').then(() => null, (e: Error) => e);
    expect(err, 'an undecryptable binding must NOT resolve to a book').toBeInstanceOf(Error);
    expect((err as Error).message).toContain('book_binding_undecryptable');
  });

  it('resolveBook(\'live\') inherits the rethrow — the route helper no longer swallows it', async () => {
    const err = await resolveBook(pool as never, SUB_BROKEN, 'live').then(() => null, (e: Error) => e);
    expect(err, 'resolveBook must not degrade an undecryptable binding to an unbound legacy book').toBeInstanceOf(Error);
    expect((err as Error).message).toContain('book_binding_undecryptable');
  });

  it('the ROW governs the book, not the pure constructor (a view-only legacy book stays disabled)', async () => {
    await pool.query(
      `INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, enabled, learn)
         VALUES ($1,$2,'live','Live (legacy account)','live',false,false)`,
      [legacyBookId(SUB_VIEWONLY, 'live'), SUB_VIEWONLY]);
    await expect(loadLegacyBook(pool as never, SUB_VIEWONLY, 'live')).resolves.toMatchObject({ enabled: false });
    expect(legacyBook(SUB_VIEWONLY, 'live').enabled, 'the pure constructor cannot know this').toBe(true);
  });
});

/* ─── the pin is gone from every rail that could bring the guess back ───────────────────────── */

/** Every source file under a directory, recursively, filtered by extension. */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

describe('SCHWAB_ACCOUNT_NUMBER is retired end to end', () => {
  it('no source file reads process.env.SCHWAB_ACCOUNT_NUMBER', () => {
    const files = [...walk(path.join(REPO, 'src'), ['.ts', '.js']), ...walk(path.join(REPO, 'scripts'), ['.ts', '.js', '.sh'])];
    const hits = files.filter((f) => /process\.env\.SCHWAB_ACCOUNT_NUMBER|\$SCHWAB_ACCOUNT_NUMBER|\$\{SCHWAB_ACCOUNT_NUMBER/.test(fs.readFileSync(f, 'utf8')));
    expect(hits.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('the compose file and .env.example no longer carry the pin at all', () => {
    for (const f of ['docker-compose.oshal-local.yml', '.env.example']) {
      expect(fs.readFileSync(path.join(REPO, f), 'utf8'), `${f} still names the retired pin`).not.toContain('SCHWAB_ACCOUNT_NUMBER');
    }
  });

  it('the cutover script decides the legacy link from the books/accounts tables, not from .env', () => {
    const sh = fs.readFileSync(path.join(REPO, 'scripts/trading-books-cutover.sh'), 'utf8');
    expect(sh).not.toMatch(/grep -E '\^SCHWAB_ACCOUNT_NUMBER=' \.env/);
    expect(sh).toContain("SELECT count(*) FROM oshal_trading_books WHERE ref = 'live' AND account_id IS NOT NULL");
  });
});
