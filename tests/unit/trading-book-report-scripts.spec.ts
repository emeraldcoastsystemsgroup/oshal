/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Public posture is now ONE rule (2026-09-06 review): the weekly page rendered every book with a close — including a DISABLED account — while the journal clause deliberately omitted them, and quoted an "all books" total that counted the book it was about to hide. Both go through lib.enabledOnly(), so this spec pins that the disabled b-spec-off appears in the operator-facing OK line and in the deck JSON but NEVER in the rendered page, its footer, or the total's book count.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 D2 #7 report guard. Proves, against the live Postgres AS THE ENFORCING ROLE (oshal_app, force-RLS; self-validated: current_user + rolsuper=false + rolbypassrls=false), that the shared scripts/lib/trading-book-report.js SQL prints a per-book breakdown + a sum across books under the is_operator GUC the scripts stamp; that without the GUC the roster is empty and the summarizer still never dresses a non-paper ref as paper; that a book with no prior close reports pl/pct null (never 0); and — via REAL CLI runs of the three scripts — that site-oshal-report.js renders every ref + 'all books' with live refs percent-only by default, oshal-deck-data.js scopes its headline/orders to ONE book (OSHAL_TRADING_BOOK) with two live books seeded and fails loud on an unknown ref, and oshal-report-journal.js writes exactly one 'daily-report' row naming every ENABLED ref + 'all books' inside the 500-char cap, right after the headline figures. Also proves the per-book reads fail LOUD by real failure injection: the same CLI pointed at a throwaway EMPTY database prints BOOKS_READ_FAIL for each read and still renders the rest of the page (a silent fallback would drop the books section AND the paper week sentence with only 'books=none' as a hint). Static pins: Dockerfile COPYs site-oshal-report.js and .dockerignore allowlists it (a COPY of an excluded path fails the build).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | This file now STARTS its own PostgreSQL and both of its roles instead of resolving an address at all. Refusing an unpointed run closed the 2026-09-14 accident but left every case collapsing at import, so the guard ran nowhere; worse, the enforcing-role half still read DATABASE_URL out of the repo's .env and, failing that, fell back to a literal oshal_app DSN on the local stack — the operator's live trading database — which is precisely the address this spec must never be able to name. The fixture's `roles: ['oshal_app']` supplies a REAL non-superuser, non-bypassrls login, so the self-validation at the head of the file keeps passing honestly rather than being relaxed; the whole public schema is then handed to that role (`ALTER TABLE … OWNER TO`), which is what puts FORCE ROW LEVEL SECURITY on the critical path rather than the plain ENABLE that would filter any non-owner — measured by mutation: `NO FORCE` on oshal_trading_books turns the "roster is EMPTY without the GUC" case red, and substituting the superuser pool for the role turns both that case and the self-validation red. The ledger tables the CLIs read get the deployment's own owner-or-operator policy (migration 060 applies it there; the runtime bootstrap does not), so the enforcing role is enforced against the same surface it is in production. The throwaway EMPTY database for the fail-loud case is a SECOND database on this same private server rather than a second container, and it is no longer dropped by hand — the server is destroyed, which is the property that failed twice on 2026-09-14. The DELETE-by-sub teardown is gone with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { ensureBooksSchema, ensureLegacyBooks, legacyBookId } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-schema';
import { ensureDailyEquityTable } from '../../src/app/trading-daily-equity-store';
import { ensureStrategyJournalTable } from '../../src/app/trading-strategy-journal';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database';
import { DisposablePostgres } from '../helpers/disposable-postgres';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require('../../scripts/lib/trading-book-report') as typeof import('../../scripts/lib/trading-book-report');

const root = join(__dirname, '..', '..');
/**
 * A PostgreSQL this file owns, with the enforcing role on it. Nothing here reads an address from
 * the environment, so there is no value any caller could supply that would reach a deployment.
 * `row_security=off` keeps the SUPERUSER pool's reads across the FORCE-RLS tables explicit; the
 * role's own pool deliberately does not inherit it (on a non-privileged role it would turn an
 * enforced read into an error instead of the filtered result this spec exists to observe).
 */
const database = new DisposablePostgres({
  purpose: 'trading-book-report-scripts', database: 'trading_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off',
  roles: [{ name: 'oshal_app', max: 4 }],
});
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-adr134obs-${RUN}`;
const D1 = '2026-01-05', D2 = '2026-01-06';
const B_ON = crypto.randomUUID(), B_OFF = crypto.randomUUID();
const scratch = mkdtempSync(join(tmpdir(), 'oshal-book-report-'));
let superPool: Pool, appPool: Pool;

/**
 * A libpq URL for the ENFORCING role on this file's private server — the value the three CLIs get
 * as DATABASE_URL. Built from the fixture's generated credentials at call time, never from env.
 */
function roleDsn(db?: string): string {
  const c = database.roleConnection('oshal_app');
  return `postgresql://${c.user}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${db ?? c.database}`;
}

const etNoon = (day: string) => `(($1::date + time '12:00') AT TIME ZONE 'America/New_York')`.replace('$1', `'${day}'`);

/** Seed one filled order (signal → decision → order) for a book on D2 with a book-unique symbol. */
async function seedFill(bookId: string, mode: 'paper' | 'live', symbol: string): Promise<void> {
  const sig = (await superPool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, content_hash) VALUES ($1,$2,$3,'spec',$4) RETURNING signal_id`,
    [SUB, mode, bookId, `spec-${crypto.randomUUID()}`])).rows[0];
  const dec = (await superPool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, action, symbol, side, qty, order_type, rationale, confidence, created_at)
       VALUES ($1,$2,$3,ARRAY[$4]::uuid[],'buy',$5,'buy',10,'market','spec',0.5,${etNoon(D2)}) RETURNING decision_id`,
    [SUB, mode, bookId, sig.signal_id, symbol])).rows[0];
  await superPool.query(
    `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, client_order_id, symbol, side, qty, order_type, status, raw_status, filled_qty, filled_avg_price, created_at)
       VALUES ($1,$2,$3,$4,'spec',$5,$6,'buy',10,'market','filled','FILLED',10,100,${etNoon(D2)})`,
    [SUB, mode, bookId, dec.decision_id, `${SUB}:${symbol}`, symbol]);
}

/**
 * Give the fixture the shape the deployment has: the ledger tables the report CLIs read carry the
 * owner-or-operator policy (migration 060 installs it there; the runtime bootstraps above do not),
 * and the whole public schema is OWNED by the enforcing role. The ownership handoff is what puts
 * FORCE ROW LEVEL SECURITY on the critical path: a NON-owner is filtered by plain ENABLE, so
 * without it the "roster is EMPTY without the GUC" case would pass while never once exercising the
 * FORCE the deployment's own owner depends on. Measured: `NO FORCE ROW LEVEL SECURITY` on
 * oshal_trading_books turns that case red (all four books come back), which it could not do unless
 * oshal_app really owns the table.
 */
async function handSchemaToTheEnforcingRole(): Promise<void> {
  for (const table of ['oshal_trading_orders', 'oshal_trading_decisions', 'oshal_trading_signals']) {
    for (const statement of buildOwnerRlsPolicyStatements(table, 'user_sub')) await superPool.query(statement);
  }
  await superPool.query(`DO $$
    DECLARE name text;
    BEGIN
      FOR name IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE format('ALTER TABLE public.%I OWNER TO oshal_app', name);
      END LOOP;
      FOR name IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
        EXECUTE format('ALTER SEQUENCE public.%I OWNER TO oshal_app', name);
      END LOOP;
    END $$`);
}

beforeAll(async () => {
  superPool = await database.start();
  appPool = database.rolePool('oshal_app');
  await ensureBooksSchema(superPool as never);
  await ensureTradingSchema(superPool as never);
  await ensureDailyEquityTable(superPool as never);
  await ensureStrategyJournalTable(superPool as never);
  // The daily-equity PRIMARY KEY is re-keyed (user_sub, mode, et_day) → (user_sub, book_id, et_day)
  // by the ADR-134 cutover migration, NOT by the runtime bootstrap above — and a second LIVE book
  // closing on the same day is precisely what the legacy mode-keyed PK refuses. The file is applied
  // verbatim (its DO-blocks skip every table this fixture does not have) rather than hand-copied, so
  // the fixture is re-keyed by the same statement the deployment was.
  await superPool.query(readFileSync(join(root, 'scripts', 'migrations', '125-trading-books-cutover.sql'), 'utf8'));
  await handSchemaToTheEnforcingRole();
  await ensureLegacyBooks(superPool as never, SUB);
  // Two statements so created_at orders them (the roster ORDER BY is created_at, then ref).
  await superPool.query(`INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, broker, enabled) VALUES ($1,$2,'b-spec-on','Spec margin','live','schwab',true)`, [B_ON, SUB]);
  await superPool.query(`INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, broker, enabled) VALUES ($1,$2,'b-spec-off','Spec cash','live','schwab',false)`, [B_OFF, SUB]);
  const paper = legacyBookId(SUB, 'paper'), live = legacyBookId(SUB, 'live');
  const eq: Array<[string, string, string, number, string]> = [
    ['paper', paper, D1, 100000, 'paper'], ['paper', paper, D2, 100500, 'paper'],
    ['live', live, D1, 50000, 'live'], ['live', live, D2, 49500, 'live'],
    ['live', B_ON, D1, 20000, 'b-spec-on'], ['live', B_ON, D2, 20200, 'b-spec-on'],
    ['live', B_OFF, D2, 10000, 'b-spec-off'], // no prior close → pl/pct must be null
  ];
  for (const [mode, bookId, day, equity, ref] of eq) {
    await superPool.query(
      `INSERT INTO oshal_trading_daily_equity (user_sub, mode, et_day, equity, book_id, book_ref) VALUES ($1,$2,$3::date,$4,$5,$6)`,
      [SUB, mode, day, equity, bookId, ref]);
  }
  await seedFill(paper, 'paper', 'PAPR');
  await seedFill(live, 'live', 'LIVE');
  await seedFill(B_ON, 'live', 'BSPC');
}, 120_000);

// No DELETE pass and no DROP DATABASE: the whole server goes away, so there is nothing to clean and
// nowhere to clean it — including the throwaway empty database the fail-loud case mints below.
afterAll(async () => {
  await database.stop();
  rmSync(scratch, { recursive: true, force: true });
}, 120_000);

const byRef = (s: { books: Array<{ ref: string }> }, ref: string) => s.books.find((b) => b.ref === ref) as never as Record<string, unknown>;

describe('the lib SQL as the ENFORCING role (oshal_app, force-RLS)', () => {
  it('runs as a non-superuser, non-bypass role (audit rule: the boundary is real)', async () => {
    const r = await appPool.query(`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
    expect(r.rows[0]).toMatchObject({ current_user: 'oshal_app', rolsuper: false, rolbypassrls: false });
  });

  it('with the is_operator GUC the scripts stamp: four books labelled by ref, kinds from the roster, total = arithmetic sum', async () => {
    const c = await appPool.connect();
    try {
      await c.query("SELECT set_config('oshal.is_operator','on',false)");
      const [closes, fills, roster] = await Promise.all([lib.perBookCloseAndPrior(c, SUB, D2), lib.perBookFills(c, SUB, D2), lib.bookRoster(c, SUB)]);
      const s = lib.summarizeBooks(closes, fills, roster);
      expect(s.books.map((b) => b.ref)).toEqual(['paper', 'live', 'b-spec-on', 'b-spec-off']);
      expect(byRef(s, 'paper')).toMatchObject({ kind: 'paper', equity: 100500, priorClose: 100000, pl: 500, pct: 0.5, fills: 1, enabled: true });
      expect(byRef(s, 'live')).toMatchObject({ kind: 'live', equity: 49500, pl: -500, pct: -1, fills: 1 });
      expect(byRef(s, 'b-spec-on')).toMatchObject({ kind: 'live', label: 'Spec margin', equity: 20200, pl: 200, pct: 1, fills: 1 });
      expect(byRef(s, 'b-spec-off')).toMatchObject({ kind: 'live', enabled: false, equity: 10000, priorClose: null, pl: null, pct: null, fills: 0 });
      expect(s.total).toEqual({ books: 4, equity: 100500 + 49500 + 20200 + 10000, pl: 200, pct: 0.12 });
    } finally { c.release(); }
  });

  it('WITHOUT the GUC (the report-lies class): the force-RLS books roster is EMPTY while the equity rows still come back labelled by the denormalized book_ref — and a non-paper ref is never "paper"', async () => {
    const c = await appPool.connect();
    try {
      await c.query('RESET ALL'); // set_config(..., false) is session-scoped and the pool reuses connections
      expect(await lib.bookRoster(c, SUB)).toEqual([]);
      const closes = await lib.perBookCloseAndPrior(c, SUB, D2);
      expect(closes.close.map((r) => r.ref).sort()).toEqual(['b-spec-off', 'b-spec-on', 'live', 'paper']);
      const s = lib.summarizeBooks(closes, await lib.perBookFills(c, SUB, D2), []);
      expect(s.books.map((b) => [b.ref, b.kind]).sort()).toEqual([['b-spec-off', 'live'], ['b-spec-on', 'live'], ['live', 'live'], ['paper', 'paper']]);
      expect(byRef(s, 'b-spec-off')).toMatchObject({ pl: null, pct: null, label: null });
      expect(s.total.equity).toBe(180200);
    } finally { c.release(); }
  });

  it('the window view (weekly page) uses first/last close per book and sums across books', async () => {
    const c = await appPool.connect();
    try {
      await c.query("SELECT set_config('oshal.is_operator','on',false)");
      const s = lib.summarizeBookSeries(await lib.perBookEquitySeries(c, SUB, D1, D2), await lib.bookRoster(c, SUB));
      expect(byRef(s, 'paper')).toMatchObject({ pct: 0.5, pl: 500 });
      expect(byRef(s, 'b-spec-off')).toMatchObject({ equity: 10000, pl: null });
      expect(s.total.equity).toBe(180200);
    } finally { c.release(); }
  });

  it('enabledOnly: the public view hides disabled books AND totals only what it shows', () => {
    const s = { books: [
      { ref: 'paper', kind: 'paper', enabled: true, equity: 100500, priorClose: 100000, pl: 500, pct: 0.5 },
      { ref: 'off', kind: 'live', enabled: false, equity: 10000, priorClose: 5000, pl: 5000, pct: 100 },
    ], total: { books: 2, equity: 110500, pl: 5500, pct: 5.24 } } as never;
    const view = lib.enabledOnly(s);
    expect(view.books.map((b: { ref: string }) => b.ref)).toEqual(['paper']);
    expect(view.total).toEqual({ books: 1, equity: 100500, pl: 500, pct: 0.5 });
  });

  it('renderBooksText: enabled books only, live percent-only by default, dollars when allowed', () => {
    // The disabled book carries a huge move on purpose: the printed 'all books' figure must be the
    // total over the books the line NAMES, never one inflated by an account it hid.
    const s = { books: [
      { ref: 'paper', kind: 'paper', enabled: true, equity: 100500, priorClose: 100000, pl: 500, pct: 0.5 },
      { ref: 'live', kind: 'live', enabled: true, equity: 49500, priorClose: 50000, pl: -500, pct: -1 },
      { ref: 'b-spec-off', kind: 'live', enabled: false, equity: 20000, priorClose: 10000, pl: 10000, pct: 100 },
    ], total: { pct: 6.67 } } as never;
    expect(lib.renderBooksText(s, { liveDollars: false })).toBe('books: paper +0.50% (+$500.00) / live -1.00%; all books +0.00%');
    expect(lib.renderBooksText(s, { liveDollars: true })).toBe('books: paper +0.50% (+$500.00) / live -1.00% (-$500.00); all books +0.00%');
    expect(lib.liveDollarsFromEnv({ OSHAL_REPORT_LIVE_DOLLARS: 'TRUE' } as never)).toBe(true);
    expect(lib.liveDollarsFromEnv({} as never)).toBe(false);
  });
});

const runNode = (script: string, args: string[], env: Record<string, string>, cwd = scratch) => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    encoding: 'utf8', timeout: 90_000, cwd,
    env: { ...process.env, DATABASE_URL: roleDsn(), OSHAL_USER_SUB: SUB, OSHAL_REPORT_LIVE_DOLLARS: '', ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const deckEnv = { OSHAL_DECK_OUT_DIR: scratch, ALPACA_PAPER_ENDPOINT: 'http://127.0.0.1:9', ALPACA_PAPER_KEY_ID: 'spec', ALPACA_PAPER_SECRET_KEY: 'spec' };

describe('real CLI runs as oshal_app', () => {
  it('site-oshal-report.js renders every ref + all books; live refs carry no dollar figure by default; the paper week sentence is unchanged', () => {
    const out = join(scratch, 'oshal-report.html');
    const r = runNode('site-oshal-report.js', [`--through=${D2}`, '--days=2', `--out=${out}`, '--commits=0'], {});
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/OSHAL_REPORT_OK .*books=paper:\+0\.50%,live:-1\.00%,b-spec-on:\+1\.00%,b-spec-off:n\/a allBooks=\+0\.12%/);
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('<h2>The books</h2>');
    for (const ref of ['paper', 'live', 'b-spec-on']) expect(html).toContain(`<strong>${ref}</strong>`);
    // The DISABLED book is on the operator-facing OK line above but never on the public page, and the
    // total counts only what the page shows (it used to say "across 4 books" while listing 3).
    expect(html).not.toContain('b-spec-off');
    expect(html).toMatch(/<strong>all books<\/strong> \+0\.12% across 3 books/);
    const liveLines = html.split('\n').filter((l) => /<strong>(live|b-spec-on)<\/strong>/.test(l));
    expect(liveLines).toHaveLength(2);
    for (const l of liveLines) expect(l, l).not.toContain('$');
    expect(html.split('\n').find((l) => /<strong>paper<\/strong>/.test(l))).toContain('+$500.00');
    expect(html).toContain('the paper book moved <strong>+0.50%</strong> (+$500)');
    expect(html).toMatch(/paper: paper; live: live, b-spec-on, shown as percent only/);
  }, 90_000);

  it('oshal-deck-data.js scopes the headline + orders to ONE book (OSHAL_TRADING_BOOK) with two live books seeded, and emits books[] + booksTotal', () => {
    const r = runNode('oshal-deck-data.js', [D2], { ...deckEnv, OSHAL_TRADING_BOOK: 'b-spec-on' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/DECK_DATA_OK .*book=b-spec-on books=4 trades=1/);
    const deck = JSON.parse(readFileSync(join(scratch, 'deck-data.json'), 'utf8'));
    expect(deck.bookRef).toBe('b-spec-on');
    expect(deck.results).toMatchObject({ equity: 20200, pl: 200, pct: 1, fills: 1, buys: ['BSPC'] });
    expect(deck.trades.map((t: { symbol: string }) => t.symbol)).toEqual(['BSPC']);
    expect(deck.why.stats.total).toBe(1);
    expect(deck.ytd.days).toBe(1);
    expect(deck.books.map((b: { ref: string }) => b.ref)).toEqual(['paper', 'live', 'b-spec-on', 'b-spec-off']);
    expect(deck.booksTotal).toEqual({ books: 4, equity: 180200, pl: 200, pct: 0.12 });
  }, 90_000);

  it('oshal-deck-data.js keeps the legacy default (OSHAL_TRADING_MODE=paper → the paper book) and fails loud on an unknown ref', () => {
    const paper = runNode('oshal-deck-data.js', [D2], { ...deckEnv, OSHAL_TRADING_MODE: 'paper' });
    expect(paper.status, paper.out).toBe(0);
    const deck = JSON.parse(readFileSync(join(scratch, 'deck-data.json'), 'utf8'));
    expect(deck.bookRef).toBe('paper');
    expect(deck.results).toMatchObject({ equity: 100500, pl: 500, buys: ['PAPR'] });
    const bad = runNode('oshal-deck-data.js', [D2], { ...deckEnv, OSHAL_TRADING_BOOK: 'b-nope' });
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/DECK_DATA_FAIL OSHAL_TRADING_BOOK="b-nope" is not a book of this sub/);
  }, 90_000);

  it('a per-book read that FAILS is LOUD (BOOKS_READ_FAIL on stderr), never a silent empty books[]', async () => {
    // Real failure injection: a throwaway EMPTY database. Every other read in the script goes through
    // its swallowing q() helper, so the ONLY thing that can speak here is the per-book catch — which
    // is exactly the path whose silence would drop "The books" AND the paper week sentence with no trace.
    // It is a SECOND database on this file's own private server, not a second container: "empty" is
    // then a fact about a database nothing ever migrated, it is reached as the same enforcing role,
    // and it needs no teardown because the server it lives on is destroyed in afterAll.
    const emptyDb = `oshal_spec_a134_${RUN.replace(/[^a-z0-9]/gi, '')}`; // an identifier, so no hyphens
    await superPool.query(`CREATE DATABASE ${emptyDb}`);
    await superPool.query(`GRANT CONNECT ON DATABASE ${emptyDb} TO oshal_app`);
    const out = join(scratch, 'oshal-report-empty.html');
    const r = runNode('site-oshal-report.js', [`--through=${D2}`, '--days=2', `--out=${out}`, '--commits=0'], { DATABASE_URL: roleDsn(emptyDb) });
    expect(r.out).toMatch(/BOOKS_READ_FAIL perBookEquitySeries/);
    expect(r.out).toMatch(/BOOKS_READ_FAIL bookRoster/);
    expect(r.status, r.out).toBe(0); // the rest of the page still renders; the failure is on the record
    expect(readFileSync(out, 'utf8')).not.toContain('The books');
  }, 60_000);

  it('oshal-report-journal.js writes exactly ONE daily-report row naming every ENABLED ref + all books, right after the headline figures, inside 500 chars', async () => {
    const paper = runNode('oshal-deck-data.js', [D2], { ...deckEnv, OSHAL_TRADING_MODE: 'paper' });
    expect(paper.status, paper.out).toBe(0);
    const deckPath = join(scratch, 'deck-data.json');
    for (let i = 0; i < 2; i++) {
      const r = runNode('oshal-report-journal.js', [`--day=${D2}`, `--deck=${deckPath}`], {});
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/REPORT_JOURNAL_OK/);
    }
    const rows = (await superPool.query(
      `SELECT summary FROM oshal_trading_strategy_journal WHERE user_sub=$1 AND et_day=$2::date AND source='daily-report'`, [SUB, D2])).rows;
    expect(rows).toHaveLength(1);
    const s: string = rows[0].summary;
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s).toContain('Daily report published for January 6, 2026, equity $100,500, day +$500.00 (0.5%)');
    expect(s).toContain('books: paper +0.50% (+$500.00) / live -1.00% / b-spec-on +1.00%; all books +0.12%');
    expect(s).not.toContain('b-spec-off');
    expect(s.indexOf('books:')).toBeLessThan(s.indexOf('1 fills'));
  }, 120_000);
});

describe('image pins — the weekly publisher execs site-oshal-report.js IN the container', () => {
  it('Dockerfile.oshal COPYs scripts/site-oshal-report.js (runtime probe: trading-books-cutover.sh precondition 5(c))', () => {
    expect(readFileSync(join(root, 'Dockerfile.oshal'), 'utf8')).toMatch(/^COPY scripts\/site-oshal-report\.js \.\/scripts\/$/m);
  });
  it('.dockerignore allowlists scripts/site-oshal-report.js — a COPY of an excluded path fails the build outright', () => {
    expect(readFileSync(join(root, '.dockerignore'), 'utf8'), 'add `!scripts/site-oshal-report.js` to .dockerignore beside `!scripts/oshal-*.js`').toMatch(/^!scripts\/site-oshal-report\.js$/m);
  });
});
