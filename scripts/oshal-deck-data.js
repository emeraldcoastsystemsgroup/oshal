#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Stale-guard the recap-data.json fallback: only use its numbers when its date matches the report day. A frozen prior-day copy could otherwise silently supply the headline P/L when the DB equity row is missing (the failure mode behind the June-30-labeled July-6 email).
 */
/*
 * oshal-deck-data.js — EXTRACTION for the DETAILED daily trade-recap deck.
 * Pulls the analytical readout from the REAL data (Alpaca + the OSHAL trading DB) into
 * deck-data.json, which make-deck-detailed.py turns into a multi-slide narrated PowerPoint.
 *
 * Sections (each grounded in real rows; NEVER fabricated — empty -> honest "none"):
 *   - results   : the day's P/L, equity, fills, winners/losers   (from recap-data.json = Alpaca)
 *   - ytd       : year/inception-to-date return + equity curve    (Alpaca portfolio history)
 *   - trades    : each fill joined to its DECISION (the "why")     (orders ⋈ decisions)
 *   - why       : decision rationale themes + confidence            (oshal_trading_decisions)
 *   - sentiment : the market signals driving the day               (oshal_trading_signals)
 *   - optimize  : parameter recommendations (current→proposed)      (oshal_trading_param_recommendations)
 *   - book      : open positions at close                           (Alpaca positions)
 *
 *   Usage:  node oshal-deck-data.js [YYYY-MM-DD]   (default: today ET)
 *   Writes: packages/oshal-vids-operator/out/deck-data.json
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch {}
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT_DIR = path.join(__dirname, '..', 'packages', 'oshal-vids-operator', 'out');
const RECAP = path.join(OUT_DIR, 'recap-data.json');
const OUT = path.join(OUT_DIR, 'deck-data.json');
const SUB = process.env.OSHAL_USER_SUB || 'example-user-sub';
const MODE = process.env.OSHAL_TRADING_MODE || 'paper';

function envFirst(...names) { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; }
const KEY_ID = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SECRET = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const ALPACA = (envFirst('ALPACA_PAPER_ENDPOINT', 'ALPACA_ENDPOINT', 'ALPAKA_ENDPOINT') || 'https://paper-api.alpaca.markets').replace(/\/+$/, '').replace(/\/v2$/i, '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function alpaca(p) {
  const r = await fetch(`${ALPACA}${p}`, { headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET } });
  if (!r.ok) throw new Error(`alpaca ${p} ${r.status}`);
  return r.json();
}

// ET calendar date as 'YYYY-MM-DD' (Postgres does the tz math in the queries).
function etDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }

(async () => {
  const arg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  // Default = yesterday ET = the last COMPLETE trading session (a mid-session "today" is partial).
  const targetDate = arg || etDate(new Date(Date.now() - 24 * 3600 * 1000));
  const label = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(targetDate + 'T12:00:00Z'));

  // 1) Alpaca basics from recap-data.json (run oshal-trade-data.js first) + YTD history.
  let recap = {};
  try { recap = JSON.parse(fs.readFileSync(RECAP, 'utf8')); } catch { recap = {}; }
  // STALE GUARD: recap-data.json is only a trustworthy fallback for the SAME day. A frozen
  // prior-day copy must never supply headline numbers — better honest nulls than stale data.
  if (recap.date && recap.date !== label) {
    console.error(`DECK_DATA stale recap-data.json ignored (its date "${recap.date}" != report day "${label}")`);
    recap = {};
  }
  // HONEST day + since-inception numbers from OUR OWN local daily-equity snapshot store
  // (oshal_trading_daily_equity), NOT Alpaca. Alpaca's account.last_equity carries a PHANTOM prior
  // close (observed 2026-06-30: last_equity $105,694 vs the real ~$102,315) that fabricates a huge
  // day P/L (-$3,700 when the book was ~flat, ~-$175). The store keeps our recorded close per ET day,
  // so day P/L = close - prior-day close is phantom-proof (same source the cockpit uses). Alpaca is
  // used ONLY for the live position book (holdings/avg cost), which is fine. Computed in the DB block.
  let acct = {}, livePositions = [];
  let liveEquity = null, winners = [];
  try {
    acct = await alpaca('/v2/account');
    try { livePositions = await alpaca('/v2/positions'); } catch { livePositions = []; }
    liveEquity = Number(acct.equity);
    winners = (livePositions || []).map((p) => [p.symbol, round2(Number(p.unrealized_plpc) * 100)]).sort((a, b) => b[1] - a[1]);
  } catch (e) { /* Alpaca book optional — the DB snapshot drives the headline P/L */ }
  let ytd = null, dayResults = null; // computed below from the DB equity store

  // 2) DB analytical sections (operator context bypasses RLS for this system readout).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const q = (sql, params) => client.query(sql, params).then((r) => r.rows).catch(() => []);
  const ET = "AT TIME ZONE 'America/New_York'";
  let trades = [], whyThemes = [], sentTop = [], sentHeadlines = [], optimize = [], decisionStats = {}, totalSignals = 0;
  try {
    await client.query("SELECT set_config('oshal.is_operator','on',false)");

    // HONEST headline P/L from our own close-equity snapshots (phantom-proof; see note above).
    const eqRows = await q(
      `SELECT et_day::text AS d, equity::float AS e FROM oshal_trading_daily_equity
        WHERE user_sub=$1 AND mode=$2 AND et_day <= $3::date ORDER BY et_day DESC LIMIT 6`, [SUB, MODE, targetDate]);
    const closeEquity = ((eqRows.find((r) => r.d === targetDate) || {}).e) ?? liveEquity;
    const priorClose = ((eqRows.find((r) => r.d < targetDate) || {}).e) ?? null;
    if (closeEquity != null) {
      const base = 100000; // $100k paper inception
      dayResults = {
        equity: round2(closeEquity),
        pl: priorClose != null ? round2(closeEquity - priorClose) : null,
        pct: priorClose ? round2((closeEquity / priorClose - 1) * 100) : null,
        unrealized: round2((livePositions || []).reduce((s, p) => s + Number(p.unrealized_pl || 0), 0)),
        positions: (livePositions || []).length,
        winners: winners.slice(0, 4),
        leaders: winners.slice(0, 3).map((w) => w[0]).join(' · '),
        priorClose: priorClose != null ? round2(priorClose) : null,
        source: 'oshal_trading_daily_equity',
      };
      ytd = { base, last: round2(closeEquity), retPct: round2(((closeEquity - base) / base) * 100), retUsd: round2(closeEquity - base), days: null, sinceInception: true };
    }

    trades = await q(
      `SELECT o.symbol, o.side, o.qty::float, o.filled_avg_price::float AS fill, o.realized_pnl::float AS pnl, o.status,
              d.confidence::float AS confidence, left(d.rationale, 300) AS rationale, d.indicators
         FROM oshal_trading_orders o
         LEFT JOIN oshal_trading_decisions d ON d.decision_id = o.decision_id
        WHERE o.mode=$1 AND (o.created_at ${ET})::date = $2::date
        ORDER BY o.created_at`, [MODE, targetDate]);

    whyThemes = await q(
      `SELECT coalesce(indicators->>'reason','signal-driven') AS theme, count(*)::int AS n, round(avg(confidence)::numeric,2)::float AS avg_conf
         FROM oshal_trading_decisions
        WHERE mode=$1 AND (created_at ${ET})::date = $2::date
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [MODE, targetDate]);

    const ds = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE action='buy')::int AS buys,
              count(*) FILTER (WHERE action='sell')::int AS sells,
              count(*) FILTER (WHERE action='hold')::int AS holds,
              round(avg(confidence)::numeric,2)::float AS avg_conf
         FROM oshal_trading_decisions WHERE mode=$1 AND (created_at ${ET})::date = $2::date`, [MODE, targetDate]);
    decisionStats = ds[0] || {};

    const sc = await q(`SELECT count(*)::int AS n FROM oshal_trading_signals WHERE (observed_at ${ET})::date = $1::date`, [targetDate]);
    totalSignals = (sc[0] && sc[0].n) || 0;
    sentTop = await q(
      `SELECT s AS symbol, count(*)::int AS mentions
         FROM oshal_trading_signals, unnest(symbols) s
        WHERE (observed_at ${ET})::date = $1::date
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [targetDate]);
    sentHeadlines = await q(
      `SELECT DISTINCT ON (title) source, author, left(title,140) AS title, symbols
         FROM oshal_trading_signals
        WHERE (observed_at ${ET})::date = $1::date AND title IS NOT NULL
        ORDER BY title, observed_at DESC LIMIT 6`, [targetDate]);

    optimize = await q(
      `SELECT param, current_value::float, proposed_value::float, baseline_winrate::float AS base_wr,
              proposed_winrate::float AS prop_wr, status
         FROM oshal_trading_param_recommendations
        WHERE (created_at ${ET})::date = $1::date OR status='applied'
        ORDER BY created_at DESC LIMIT 8`, [targetDate]);

    // Real trading age = distinct ET days we've actually placed orders, up to the report day
    // (NOT Alpaca's 251-point 1-year history). Drives the "since inception" period.
    const td = await q(
      `SELECT count(DISTINCT (created_at ${ET})::date)::int AS n
         FROM oshal_trading_orders
        WHERE mode=$1 AND (created_at ${ET})::date <= $2::date`, [MODE, targetDate]);
    if (ytd && !ytd.error) ytd.days = (td[0] && td[0].n) || 0;
  } finally { client.release(); await pool.end(); }

  // Day's fills/buys/sells come from the DB orders; authoritative equity/pl/positions/winners
  // come from the Alpaca account/positions pulled above (dayResults).
  const filledCount = trades.filter((t) => t.status === 'filled').length;
  const dayBuys = [...new Set(trades.filter((t) => t.side === 'buy').map((t) => t.symbol))].slice(0, 8);
  const daySells = [...new Set(trades.filter((t) => t.side === 'sell').map((t) => t.symbol))].slice(0, 8);

  const deck = {
    date: label,
    generatedAt: new Date().toISOString(),
    mode: MODE,
    results: {
      pl: dayResults ? dayResults.pl : (recap.pl ?? null),
      pct: dayResults ? dayResults.pct : (recap.pct ?? null),
      equity: dayResults ? dayResults.equity : (recap.equity ?? null),
      unrealized: dayResults ? dayResults.unrealized : (recap.unrealized ?? null),
      fills: filledCount || recap.fills || null,
      positions: dayResults ? dayResults.positions : (recap.positions ?? null),
      winners: dayResults ? dayResults.winners : (recap.winners || []),
      sells: daySells.length ? daySells : (recap.sells || []),
      buys: dayBuys.length ? dayBuys : (recap.buys || []),
      leaders: dayResults ? dayResults.leaders : (recap.leaders || ''),
    },
    ytd,
    trades,
    why: { themes: whyThemes, stats: decisionStats },
    sentiment: { topSymbols: sentTop, headlines: sentHeadlines, totalSignals },
    optimize, // empty array = no parameter changes this period (surfaced honestly, not faked)
    book: dayResults ? dayResults.positions : (recap.positions ?? null),
    positionsDetail: livePositions.map((p) => ({ sym: p.symbol, qty: Number(p.qty), avg: round2(Number(p.avg_entry_price)), mv: round2(Number(p.market_value)), pl: round2(Number(p.unrealized_pl)), plpc: round2(Number(p.unrealized_plpc) * 100) })),
  };
  fs.writeFileSync(OUT, JSON.stringify(deck, null, 2));
  console.log('DECK_DATA_OK', OUT, '| trades=' + trades.length, 'whyThemes=' + whyThemes.length, 'sentiment=' + sentTop.length, 'optimize=' + optimize.length, 'ytd=' + (ytd && ytd.retPct != null ? ytd.retPct + '%' : 'n/a'));
})().catch((e) => { console.error('DECK_DATA_FAIL', e.message || e); process.exit(1); });
