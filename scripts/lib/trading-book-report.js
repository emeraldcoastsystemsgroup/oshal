/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | enabledOnly(summary) + totalOf(books): every public renderer shows the ENABLED books and a total computed over exactly those, so a page can never quote an all-books figure that includes an account it hid (the site section used to list disabled books while the journal clause omitted them). summarizeBooks' total is now totalOf over all books, unchanged.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export renderBookMove (the line without its ref) so the site page can bold the ref and print the move without slicing the ref back off renderBookLine's output; renderBookLine is now that composition. Formatting lives in one place, and a change to the prefix can no longer silently truncate the public page's bullets.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the per-book SQL + summarizer shared by the three host report scripts (site-oshal-report.js, oshal-deck-data.js, oshal-report-journal.js). ADR-134 D2 #7: with a second live book enabled, a per-MODE read merges two accounts' equity curves into one line; these readers group by book (book_id / denormalized book_ref, labels from oshal_trading_books under the is_operator GUC the scripts already stamp) and sum across books explicitly. Live-book dollars are percent-only for public surfaces unless OSHAL_REPORT_LIVE_DOLLARS=true; a ref with no roster row is labelled 'live' unless it is literally 'paper' (fail-safe: never dress a real-money book as paper).
 */
'use strict';

const ET = "AT TIME ZONE 'America/New_York'";

/**
 * @description Public-posture switch: live-book dollar figures render only when
 * OSHAL_REPORT_LIVE_DOLLARS=true (config → env → default false). Journal 'report' rows are rendered
 * verbatim on the public weekly page, so the default hides real-money account equity.
 * @param {NodeJS.ProcessEnv} [env] - Environment to read (defaults to process.env).
 * @returns {boolean} True only for the literal 'true' (case-insensitive).
 */
function liveDollarsFromEnv(env) {
  return String((env || process.env).OSHAL_REPORT_LIVE_DOLLARS || '').trim().toLowerCase() === 'true';
}

/**
 * @description Every book the sub owns, in creation order. Callers must tolerate zero rows: the
 * books table is FORCE-RLS, so without the is_operator GUC (or a matching current_sub) it is empty.
 * @param {import('pg').ClientBase} client - Connected pg client.
 * @param {string} sub - Owner sub.
 * @returns {Promise<Array<{bookId:string, ref:string, kind:string, label:string, enabled:boolean}>>}
 */
async function bookRoster(client, sub) {
  const r = await client.query(
    `SELECT book_id::text AS "bookId", ref, kind, label, enabled
       FROM oshal_trading_books WHERE user_sub=$1
      ORDER BY (kind='paper') DESC, (ref='live') DESC, created_at, ref`, [sub]);
  return r.rows;
}

/**
 * @description Resolve a book ref to its id for the sub. Roster first; the legacy refs 'paper' /
 * 'live' fall back to the DB-side deterministic derivation (the same md5 formula the fill trigger
 * and the TS store use) so the formula never gets a third copy in JS. Unknown ref → null.
 * @param {import('pg').ClientBase} client - Connected pg client.
 * @param {string} sub - Owner sub.
 * @param {string} ref - Book ref ('paper', 'live', 'b-…').
 * @returns {Promise<string|null>} The book id, or null when the ref is not a book of this sub.
 */
async function resolveBookId(client, sub, ref) {
  const r = await client.query(
    `SELECT COALESCE(
              (SELECT book_id FROM oshal_trading_books WHERE user_sub=$1 AND ref=$2),
              CASE WHEN $2 IN ('paper','live') THEN md5('oshal-book:' || $1 || ':' || $2)::uuid END
            )::text AS book_id`, [sub, ref]);
  return (r.rows[0] && r.rows[0].book_id) || null;
}

/**
 * @description Book label for a ledger row: the denormalized book_ref, else the roster ref, else the
 * first 8 hex of the book id — never NULL, so a deleted book still groups under a stable name.
 * @param {string} alias - Table alias carrying book_id (and book_ref when the table has one).
 * @param {boolean} hasRef - Whether the table carries a book_ref column.
 * @returns {string} SQL expression.
 */
function refExpr(alias, hasRef) {
  return `COALESCE(${hasRef ? `${alias}.book_ref, ` : ''}b.ref, left(${alias}.book_id::text, 8))`;
}

/**
 * @description Daily close equity per book over a window, oldest first within each book.
 * @param {import('pg').ClientBase} client - Connected pg client.
 * @param {string} sub - Owner sub.
 * @param {string} since - Window start (inclusive), YYYY-MM-DD.
 * @param {string} through - Window end (inclusive), YYYY-MM-DD.
 * @returns {Promise<Array<{ref:string, day:string, e:number}>>}
 */
async function perBookEquitySeries(client, sub, since, through) {
  const r = await client.query(
    `SELECT ${refExpr('e', true)} AS ref, e.et_day::text AS day, e.equity::float AS e
       FROM oshal_trading_daily_equity e
       LEFT JOIN oshal_trading_books b ON b.book_id=e.book_id AND b.user_sub=e.user_sub
      WHERE e.user_sub=$1 AND e.et_day BETWEEN $2::date AND $3::date
      ORDER BY 1, e.et_day ASC`, [sub, since, through]);
  return r.rows;
}

/**
 * @description Per book: the latest close on/before the day and the latest close strictly before
 * it (DISTINCT ON), so day P/L = close − prior close per book, never across books.
 * @param {import('pg').ClientBase} client - Connected pg client.
 * @param {string} sub - Owner sub.
 * @param {string} targetDate - Report day, YYYY-MM-DD (ET).
 * @returns {Promise<{close:Array<{ref:string, day:string, e:number}>, prior:Array<{ref:string, day:string, e:number}>}>}
 */
async function perBookCloseAndPrior(client, sub, targetDate) {
  const one = (op) => client.query(
    `SELECT DISTINCT ON (ref) ref, day, e FROM (
        SELECT ${refExpr('e', true)} AS ref, e.et_day::text AS day, e.equity::float AS e, e.et_day
          FROM oshal_trading_daily_equity e
          LEFT JOIN oshal_trading_books b ON b.book_id=e.book_id AND b.user_sub=e.user_sub
         WHERE e.user_sub=$1 AND e.et_day ${op} $2::date) x
      ORDER BY ref, et_day DESC`, [sub, targetDate]).then((r) => r.rows);
  const [close, prior] = await Promise.all([one('<='), one('<')]);
  return { close, prior };
}

/**
 * @description Orders per book for one ET day: total and filled counts (labels via the books table).
 * @param {import('pg').ClientBase} client - Connected pg client.
 * @param {string} sub - Owner sub.
 * @param {string} targetDate - Report day, YYYY-MM-DD (ET).
 * @returns {Promise<Array<{ref:string, orders:number, fills:number}>>}
 */
async function perBookFills(client, sub, targetDate) {
  const r = await client.query(
    `SELECT ${refExpr('o', false)} AS ref, count(*)::int AS orders,
            count(*) FILTER (WHERE o.status='filled')::int AS fills
       FROM oshal_trading_orders o
       LEFT JOIN oshal_trading_books b ON b.book_id=o.book_id AND b.user_sub=o.user_sub
      WHERE o.user_sub=$1 AND (o.created_at ${ET})::date=$2::date
      GROUP BY 1 ORDER BY 1`, [sub, targetDate]);
  return r.rows;
}

/**
 * @description Fail-safe kind for a ledger ref. A ref with no roster row is treated as LIVE unless
 * it is literally 'paper': mislabelling a live book as paper would publish real-money dollars.
 * @param {string} ref - Book ref from a ledger row.
 * @param {Array<{ref:string, kind:string}>} roster - From bookRoster (may be [] / undefined).
 * @returns {'paper'|'live'|string} The roster's kind, else the fail-safe.
 */
function kindFor(ref, roster) {
  const row = (roster || []).find((b) => b.ref === ref);
  return row ? row.kind : (ref === 'paper' ? 'paper' : 'live');
}

/**
 * @description Stable render order for the refs present in the ledgers: roster order first (so the
 * legacy paper/live books lead), then any ref with no roster row, alphabetically.
 * @param {Set<string>} refs - Refs actually present in the ledger rows.
 * @param {Array<{ref:string}>} roster - From bookRoster (may be [] / undefined).
 * @returns {string[]} Ordered refs.
 */
function orderRefs(refs, roster) {
  const known = (roster || []).map((b) => b.ref).filter((r) => refs.has(r));
  const rest = [...refs].filter((r) => !known.includes(r)).sort();
  return [...known, ...rest];
}

/**
 * @description Round to cents. Money is summed across books, so every emitted figure is rounded at
 * the same place rather than carrying float noise into the report.
 * @param {number|string} n - Value to round.
 * @returns {number} n rounded to two decimals.
 */
function round2(n) { return Math.round(Number(n) * 100) / 100; }

/**
 * @description Assemble the per-book summary. pl/pct are null (never 0) when a prior close is
 * missing; the total sums equity over books with a close and pl/pct over books with BOTH values.
 * Every book present in the roster or in any row appears; kinds come from the roster, else the
 * fail-safe rule (non-paper refs are live).
 * @param {{close:Array, prior:Array}} closes - From perBookCloseAndPrior (or the series adapter).
 * @param {Array<{ref:string, orders:number, fills:number}>} fillRows - From perBookFills (may be []).
 * @param {Array} roster - From bookRoster (may be []).
 * @returns {{books:Array<{ref:string, kind:string, label:string|null, enabled:boolean, day:string|null, equity:number|null, priorClose:number|null, pl:number|null, pct:number|null, orders:number, fills:number}>, total:{equity:number|null, pl:number|null, pct:number|null, books:number}}}
 */
function summarizeBooks(closes, fillRows, roster) {
  const close = (closes && closes.close) || [], prior = (closes && closes.prior) || [];
  const refs = new Set([...(roster || []).map((b) => b.ref), ...close.map((r) => r.ref), ...prior.map((r) => r.ref), ...(fillRows || []).map((r) => r.ref)]);
  const books = orderRefs(refs, roster).map((ref) => {
    const row = (roster || []).find((b) => b.ref === ref);
    const c = close.find((r) => r.ref === ref), p = prior.find((r) => r.ref === ref), f = (fillRows || []).find((r) => r.ref === ref);
    const equity = c ? Number(c.e) : null, priorClose = p ? Number(p.e) : null;
    const both = equity != null && priorClose != null && priorClose !== 0;
    return {
      ref, kind: kindFor(ref, roster), label: row ? row.label : null, enabled: row ? row.enabled !== false : true,
      day: c ? c.day : null, equity: equity == null ? null : round2(equity), priorClose: priorClose == null ? null : round2(priorClose),
      pl: both ? round2(equity - priorClose) : null, pct: both ? round2(((equity - priorClose) / priorClose) * 100) : null,
      orders: f ? Number(f.orders) : 0, fills: f ? Number(f.fills) : 0,
    };
  });
  return { books, total: totalOf(books) };
}

/**
 * @description The all-books total for a set of summarized books: equity sums the books with a
 * close, pl/pct only the books with BOTH closes (a book with no prior close contributes equity but
 * never a fabricated 0 move). Extracted so a caller that renders a SUBSET (the enabled books) can
 * total exactly what it shows rather than quoting a total over books it hid.
 * @param {Array<object>} books - Summarized books.
 * @returns {{equity:number|null, pl:number|null, pct:number|null, books:number}}
 */
function totalOf(books) {
  const withEq = (books || []).filter((b) => b.equity != null), withPl = (books || []).filter((b) => b.pl != null);
  const priorSum = withPl.reduce((s, b) => s + b.priorClose, 0);
  const plSum = withPl.reduce((s, b) => s + b.pl, 0);
  return {
    books: withEq.length,
    equity: withEq.length ? round2(withEq.reduce((s, b) => s + b.equity, 0)) : null,
    pl: withPl.length ? round2(plSum) : null,
    pct: withPl.length && priorSum ? round2((plSum / priorSum) * 100) : null,
  };
}

/**
 * @description The public view of a summary: ENABLED books with a close, and a total over exactly
 * those. A disabled book is an account the operator switched off — naming it on a public page (or
 * quoting a total that includes it while hiding it) is the kind of mismatch this module exists to
 * prevent. Every public renderer goes through this.
 * @param {{books:Array, total:object}} summary - From summarizeBooks / summarizeBookSeries.
 * @returns {{books:Array, total:{equity:number|null, pl:number|null, pct:number|null, books:number}}}
 */
function enabledOnly(summary) {
  const books = ((summary && summary.books) || []).filter((b) => b.enabled !== false && b.equity != null);
  return { books, total: totalOf(books) };
}

/**
 * @description Window view of a series: per book, equity = last close in the window and
 * priorClose = first close in the window (the weekly page's "moved from … to …"). Books with a
 * single row report pl/pct null.
 * @param {Array<{ref:string, day:string, e:number}>} series - From perBookEquitySeries.
 * @param {Array} roster - From bookRoster (may be []).
 * @returns {ReturnType<typeof summarizeBooks>}
 */
function summarizeBookSeries(series, roster) {
  const close = [], prior = [];
  for (const ref of new Set((series || []).map((r) => r.ref))) {
    const rows = series.filter((r) => r.ref === ref);
    close.push(rows[rows.length - 1]);
    if (rows.length > 1) prior.push(rows[0]);
  }
  return summarizeBooks({ close, prior }, [], roster);
}

/**
 * @description Signed percent for display. Null renders 'n/a', never '0.00%' - a missing prior close
 * is not a flat day, and printing it as one is the report lie this module exists to avoid.
 * @param {number|null|undefined} pct - Percent move, or null when unknown.
 * @returns {string} e.g. '+1.24%', '-0.30%', 'n/a'.
 */
function pctText(pct) { return pct == null ? 'n/a' : (pct >= 0 ? '+' : '') + Number(pct).toFixed(2) + '%'; }

/**
 * @description Signed dollar figure with thousands separators, e.g. '+$1,204.50' / '-$83.10'.
 * @param {number|string} n - Dollar amount.
 * @returns {string} Formatted amount.
 */
function usdText(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/**
 * @description Whether a book's dollar figures may be printed: paper always; live only when the
 * operator flipped OSHAL_REPORT_LIVE_DOLLARS.
 * @param {{kind:string}} book - Summarized book.
 * @param {boolean} liveDollars - liveDollarsFromEnv().
 * @returns {boolean}
 */
function showDollars(book, liveDollars) { return book.kind === 'paper' || liveDollars === true; }

/**
 * @description A book's move WITHOUT its ref: "<pct>" plus "(<pl>, close $<equity>)" when dollars are
 * allowed. Exported so a caller that renders the ref itself (the site page bolds it) composes from
 * this instead of slicing the ref back off renderBookLine's output — string surgery on another
 * module's formatting silently corrupts the public page the day the prefix changes.
 * @param {object} book - Summarized book.
 * @param {boolean} liveDollars - liveDollarsFromEnv().
 * @returns {string} e.g. '+1.24% (+$120.00, close $9,120.00)' or 'n/a'.
 */
function renderBookMove(book, liveDollars) {
  let s = pctText(book.pct);
  if (showDollars(book, liveDollars) && book.equity != null) {
    s += ` (${book.pl != null ? usdText(book.pl) + ', ' : ''}close $${Number(book.equity).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  }
  return s;
}

/**
 * @description One book as prose: "<ref> <pct>" plus "(<pl>, close $<equity>)" when dollars are allowed.
 * @param {object} book - Summarized book.
 * @param {boolean} liveDollars - liveDollarsFromEnv().
 * @returns {string}
 */
function renderBookLine(book, liveDollars) { return `${book.ref} ${renderBookMove(book, liveDollars)}`; }

/**
 * @description Compact per-book text for a journal row or a log line: enabled books only,
 * "books: <ref> <pct> / <ref> <pct>; all books <pct>". Dollars only where showDollars allows.
 * @param {{books:Array, total:object}} summary - From summarizeBooks / summarizeBookSeries.
 * @param {{liveDollars?:boolean}} [opts] - Rendering options.
 * @returns {string} Empty string when no enabled book has a close.
 */
function renderBooksText(summary, opts) {
  const liveDollars = !!(opts && opts.liveDollars);
  const view = enabledOnly(summary);
  if (!view.books.length) return '';
  const parts = view.books.map((b) => `${b.ref} ${pctText(b.pct)}${showDollars(b, liveDollars) && b.pl != null ? ` (${usdText(b.pl)})` : ''}`);
  return `books: ${parts.join(' / ')}; all books ${pctText(view.total.pct)}`;
}

module.exports = {
  liveDollarsFromEnv, bookRoster, resolveBookId, perBookEquitySeries, perBookCloseAndPrior, perBookFills,
  summarizeBooks, summarizeBookSeries, totalOf, enabledOnly, renderBookLine, renderBookMove, renderBooksText,
  showDollars, pctText, usdText,
};
