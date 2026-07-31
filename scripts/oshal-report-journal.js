#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — writes the daily "the report ran" journal entry so the record has at least one entry EVERY day, not only on days a human wrote something. Idempotent per day, so a re-run or a recovery re-publish never duplicates the day.
 */
/*
 * oshal-report-journal.js — record that the daily report ran, in the journal itself.
 *
 * The journal was only ever written by hand (knob turns, incidents), so quiet days left holes and
 * the weekly write-up had nothing to say about them. Publishing every session but journaling only
 * the eventful ones makes the record look like the platform was idle when it was working fine.
 * This writes one `report` entry per day, from the day's own deck data — the same ledger figures
 * the report itself published, never re-derived or estimated.
 *
 * IDEMPOTENT: a day's `report` entry is replaced, not appended, so a recovery re-publish (which is
 * normal — the nightly retries) cannot stack three entries for the same session. Hand-written
 * entries for the same day are untouched; only this script's own rows are replaced.
 *
 * Usage (inside the api container, OSHAL_USER_SUB set):
 *   node scripts/oshal-report-journal.js --day=YYYY-MM-DD [--deck=/path/deck-data.json]
 *                                        [--video=true|false] [--note="ops note"]
 */
const fs = require('fs');
const { Pool } = require('pg');

const SUB = process.env.OSHAL_USER_SUB || '';
const SOURCE = 'daily-report';
const DEFAULT_DECK = '/app/packages/oshal-vids-operator/out/deck-data.json';

/** @description Parse `--k=v` argv into a plain object. @returns {Record<string,string>} */
function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** @description Format a signed dollar figure for prose. @param n - amount @returns {string} */
function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'n/a';
  return (x >= 0 ? '+$' : '-$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * @description Build the one-line day summary from the day's published figures.
 * @param d - Parsed deck-data.json for the report day.
 * @param hasVideo - Whether the session shipped a narrated video.
 * @param note - Optional operations note (lateness, incident) to carry into the entry.
 * @returns {string} The journal summary line, capped to the column width.
 */
function composeSummary(d, hasVideo, note) {
  const r = (d && d.results) || {};
  const bits = [`Daily report published for ${(d && d.date) || 'the session'}`];
  if (r.equity != null) bits.push(`equity $${Number(r.equity).toLocaleString('en-US')}`);
  if (r.pl != null) bits.push(`day ${money(r.pl)}${r.pct != null ? ` (${r.pct}%)` : ''}`);
  if (d && d.ytd && d.ytd.retPct != null) bits.push(`${d.ytd.retPct}% since inception`);
  const fills = r.fills != null ? r.fills : (d && d.trades ? d.trades.length : null);
  if (fills != null) bits.push(`${fills} fills`);
  bits.push(hasVideo ? 'narrated video + deck' : 'numbers + deck, no video this session');
  let s = bits.join(', ') + '.';
  if (note) s += ' ' + note;
  return s.slice(0, 500);
}

(async () => {
  const args = parseArgs();
  const day = args.day || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error('REPORT_JOURNAL_FAIL --day=YYYY-MM-DD required'); process.exit(1); }
  if (!SUB) { console.error('REPORT_JOURNAL_FAIL OSHAL_USER_SUB not set'); process.exit(1); }

  const deckPath = args.deck || DEFAULT_DECK;
  let deck = null;
  try { deck = JSON.parse(fs.readFileSync(deckPath, 'utf8')); } catch { /* summary degrades honestly */ }
  // Refuse to describe the wrong day. The generator defaults to yesterday when handed no date, and
  // a mislabeled journal entry is worse than none — it becomes "evidence" for the weekly write-up.
  if (deck && deck.date) {
    const want = new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    if (deck.date !== want) {
      console.error(`REPORT_JOURNAL_FAIL deck-data is for "${deck.date}" but --day is ${day} (${want}) — refusing to journal a mislabeled day`);
      process.exit(1);
    }
  }
  const hasVideo = String(args.video || '').toLowerCase() === 'true';
  const summary = composeSummary(deck, hasVideo, args.note || '');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('oshal.is_operator','on',false)");
    // Replace only OUR row for the day; hand-written entries for the same date survive untouched.
    await client.query(
      `DELETE FROM oshal_trading_strategy_journal WHERE user_sub=$1 AND et_day=$2::date AND source=$3`,
      [SUB, day, SOURCE]);
    await client.query(
      `INSERT INTO oshal_trading_strategy_journal (user_sub, et_day, kind, summary, source)
       VALUES ($1, $2::date, 'report', $3, $4)`,
      [SUB, day, summary, SOURCE]);
    console.log('REPORT_JOURNAL_OK ' + day + ' :: ' + summary.slice(0, 110));
  } catch (e) {
    console.error('REPORT_JOURNAL_FAIL ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
