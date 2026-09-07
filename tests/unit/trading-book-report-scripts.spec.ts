/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Public posture is now ONE rule (2026-09-06 review): the weekly page rendered every book with a close — including a DISABLED account — while the journal clause deliberately omitted them, and quoted an "all books" total that counted the book it was about to hide. Both go through lib.enabledOnly(), so this spec pins that the disabled b-spec-off appears in the operator-facing OK line and in the deck JSON but NEVER in the rendered page, its footer, or the total's book count.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 D2 #7 report guard. Proves, against the live Postgres AS THE ENFORCING ROLE (oshal_app, force-RLS; self-validated: current_user + rolsuper=false + rolbypassrls=false), that the shared scripts/lib/trading-book-report.js SQL prints a per-book breakdown + a sum across books under the is_operator GUC the scripts stamp; that without the GUC the roster is empty and the summarizer still never dresses a non-paper ref as paper; that a book with no prior close reports pl/pct null (never 0); and — via REAL CLI runs of the three scripts — that site-oshal-report.js renders every ref + 'all books' with live refs percent-only by default, oshal-deck-data.js scopes its headline/orders to ONE book (OSHAL_TRADING_BOOK) with two live books seeded and fails loud on an unknown ref, and oshal-report-journal.js writes exactly one 'daily-report' row naming every ENABLED ref + 'all books' inside the 500-char cap, right after the headline figures. Also proves the per-book reads fail LOUD by real failure injection: the same CLI pointed at a throwaway EMPTY database prints BOOKS_READ_FAIL for each read and still renders the rest of the page (a silent fallback would drop the books section AND the paper week sentence with only 'books=none' as a hint). Static pins: Dockerfile COPYs site-oshal-report.js and .dockerignore allowlists it (a COPY of an excluded path fails the build).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { ensureLegacyBooks, legacyBookId } from '../../src/app/trading-books-store';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require('../../scripts/lib/trading-book-report') as typeof import('../../scripts/lib/trading-book-report');

const root = join(__dirname, '..', '..');
const PG_PORT = process.env.OSHAL_PG_PORT ?? '55433';
const SUPER_DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${PG_PORT}/oshal`;
/**
 * The enforcing role's DSN. OSHAL_TEST_APP_DSN is THE supported path (set it in CI and on any box
 * whose password is not the dev default); the operator-local .env read is a convenience for this
 * workstation only, and the dev default is the last resort. A missing/short .env is never fatal —
 * the connect below fails loud and names OSHAL_TEST_APP_DSN.
 */
function appDsn(): string {
  if (process.env.OSHAL_TEST_APP_DSN) return process.env.OSHAL_TEST_APP_DSN;
  try {
    const m = /^DATABASE_URL=(postgresql:\/\/oshal_app:\S+)$/m.exec(readFileSync(join(root, '.env'), 'utf8'));
    if (m) return m[1].trim().replace(/@[^/]+\//, `@127.0.0.1:${PG_PORT}/`);
  } catch { /* no .env here */ }
  return `postgresql://oshal_app:oshal-app-dev@127.0.0.1:${PG_PORT}/oshal`;
}
const APP_DSN = appDsn();
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-adr134obs-${RUN}`;
const D1 = '2026-01-05', D2 = '2026-01-06';
const B_ON = crypto.randomUUID(), B_OFF = crypto.randomUUID();
const scratch = mkdtempSync(join(tmpdir(), 'oshal-book-report-'));
let superPool: Pool, appPool: Pool;

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

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPER_DSN, max: 2, options: '-c row_security=off' });
  try { await superPool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-book-report-scripts requires the live oshal Postgres — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  appPool = new Pool({ connectionString: APP_DSN, max: 2 });
  try { await appPool.query('SELECT 1'); } catch (error) {
    throw new Error(`the enforcing-role DSN did not authenticate — set OSHAL_TEST_APP_DSN to the oshal_app connection string (cause: ${(error as Error).message})`);
  }
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

/** Set by the fail-loud test: a throwaway EMPTY database whose missing tables make the reads fail. */
let emptyDb: string | null = null;

afterAll(async () => {
  if (emptyDb) await superPool.query(`DROP DATABASE IF EXISTS ${emptyDb} WITH (FORCE)`).catch(() => {});
  for (const t of ['oshal_trading_orders', 'oshal_trading_decisions', 'oshal_trading_signals', 'oshal_trading_daily_equity', 'oshal_trading_strategy_journal', 'oshal_trading_books']) {
    await superPool.query(`DELETE FROM ${t} WHERE user_sub LIKE 'spec-adr134obs-%'`).catch(() => {});
  }
  await appPool.end();
  await superPool.end();
  rmSync(scratch, { recursive: true, force: true });
  // Explicit hook timeout: DROP DATABASE ... WITH (FORCE) plus six DELETEs on a loaded box exceeded
  // vitest's 10s default, which failed the FILE after every test had passed (and, worse, left the
  // throwaway database behind).
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
    env: { ...process.env, DATABASE_URL: APP_DSN, OSHAL_USER_SUB: SUB, OSHAL_REPORT_LIVE_DOLLARS: '', ...env },
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
    emptyDb = `oshal_spec_a134_${RUN.replace(/[^a-z0-9]/gi, '')}`; // an identifier, so no hyphens
    await superPool.query(`CREATE DATABASE ${emptyDb}`);
    const dsn = SUPER_DSN.replace(/\/[^/?]+(\?|$)/, `/${emptyDb}$1`);
    const out = join(scratch, 'oshal-report-empty.html');
    const r = runNode('site-oshal-report.js', [`--through=${D2}`, '--days=2', `--out=${out}`, '--commits=0'], { DATABASE_URL: dsn });
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
