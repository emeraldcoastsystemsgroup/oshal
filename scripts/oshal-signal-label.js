#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add Change Log header; docs/ path references updated in the 2026-07-04 docs consolidation
 */
/*
 * Signal labeler — turns the World layer's recorded signals into a LABELED dataset (ADR-052/054/058).
 *
 * The World-Intelligence layer records features per ticker over time (world_metrics: sentiment, mentions,
 * and — as the world team ships docs/apps/trading/signal-dataset.md §2 — velocity/shift/consensus/event_*).
 * Those are the X. This adds the y: for every (ticker, day) that has a signal, it pulls Alpaca daily bars
 * and computes the realized FORWARD RETURN at several horizons, writing them to OUR OWN table
 * (trading_signal_labels) — never world_metrics (the world service owns that). Run it daily; it only
 * labels horizons that have matured, and is idempotent. Once weeks accumulate, oshal-signal-mine.js can
 * test which signal combinations actually precede a move — on our own recorded data.
 *
 *   node scripts/oshal-signal-label.js [years]      # default 2; labels all world:ticker:* entities
 *
 * Reads TSDB (world_metrics) + Alpaca daily bars; writes trading_signal_labels in the same TSDB.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial — forward-return labeler over world_metrics ticker entities (fwd_ret_eod/1d/3d/5d from Alpaca adjusted daily bars) into trading_signal_labels.
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const { Pool } = require('pg');

const TSDB_URL = process.env.TSDB_URL_HOST || process.env.TSDB_URL || 'postgresql://oshal:oshal@localhost:55434/oshal_ts';
const ef = (...n) => { for (const k of n) { if (process.env[k]) return process.env[k].trim(); } return ''; };
const KEY = ef('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = ef('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const DATA = 'https://data.alpaca.markets/v2';
const HORIZONS = { fwd_ret_1d: 1, fwd_ret_3d: 3, fwd_ret_5d: 5 }; // close-to-close N trading days (+ eod = same-day open→close)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ad(p) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${DATA}${p}`, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
    if (r.status === 429 && attempt < 6) { await sleep(2000 * (attempt + 1)); continue; } // free-tier rate limit → back off
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `data ${r.status}`);
    return j;
  }
}
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/** Adjusted daily bars for a symbol over [start,end] → sorted [{date:'YYYY-MM-DD', o, c}]. */
async function dailyBars(sym, start, end) {
  let token = ''; const out = [];
  do {
    const j = await ad(`/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&adjustment=all&feed=iex&limit=10000${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
    for (const b of j.bars || []) out.push({ date: String(b.t).slice(0, 10), o: b.o, c: b.c });
    token = j.next_page_token || '';
  } while (token);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function ensureTable(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS trading_signal_labels (
       entity TEXT NOT NULL, sym TEXT NOT NULL, date DATE NOT NULL,
       horizon TEXT NOT NULL, fwd_ret DOUBLE PRECISION NOT NULL, base_close DOUBLE PRECISION,
       computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (entity, date, horizon)
     )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tsl_entity_date_idx ON trading_signal_labels (entity, date)`);
}

(async () => {
  if (!KEY || !SEC) { console.error('Missing Alpaca keys.'); process.exit(3); }
  const years = Number(process.argv[2]) || 2;
  const pool = new Pool({ connectionString: TSDB_URL });
  try {
    await ensureTable(pool);
    // Ticker entities that actually have recorded signals, + their signal date span.
    const ents = (await pool.query(
      `SELECT entity, min(ts)::date AS d0, max(ts)::date AS d1
         FROM world_metrics WHERE entity LIKE 'world:ticker:%'
         GROUP BY entity ORDER BY entity`)).rows
      .filter((r) => Date.now() - new Date(r.d0).getTime() <= years * 366 * 864e5 || true);
    if (!ents.length) { console.log('No world:ticker:* signals yet — nothing to label.'); return; }
    const today = new Date().toISOString().slice(0, 10);
    console.log(`\n  SIGNAL LABELER  ·  ${ents.length} ticker entities  ·  horizons: eod,${Object.keys(HORIZONS).join(',')}\n`);
    let totalLabels = 0, done = 0;
    for (const e of ents) {
      const sym = e.entity.replace('world:ticker:', '').toUpperCase();
      const start = `${ymd(e.d0)}T00:00:00Z`; const end = `${today}T23:59:59Z`;
      await sleep(250); // gentle pacing under the free-tier rate limit
      let bars;
      try { bars = await dailyBars(sym, start, end); } catch (err) { console.log(`  ${sym.padEnd(6)} price ERROR: ${err.message}`); continue; }
      if (bars.length < 6) { console.log(`  ${sym.padEnd(6)} too few bars`); continue; }
      const idx = new Map(bars.map((b, i) => [b.date, i]));
      // Distinct signal days for this entity (a day with any recorded metric).
      const days = (await pool.query(
        `SELECT DISTINCT ts::date AS d FROM world_metrics WHERE entity=$1 ORDER BY d`, [e.entity])).rows.map((r) => r.d.toISOString().slice(0, 10));
      const rows = [];
      for (const d of days) {
        const i = idx.get(d); if (i == null) continue;                 // signal day must be a trading day with a bar
        const base = bars[i].c;
        rows.push([e.entity, sym, d, 'fwd_ret_eod', bars[i].o > 0 ? bars[i].c / bars[i].o - 1 : 0, base]);
        for (const [h, n] of Object.entries(HORIZONS)) {
          const j = i + n; if (j >= bars.length) continue;             // horizon not matured yet → skip (labeled on a later run)
          rows.push([e.entity, sym, d, h, base > 0 ? bars[j].c / base - 1 : 0, base]);
        }
      }
      for (const r of rows) {
        await pool.query(
          `INSERT INTO trading_signal_labels (entity, sym, date, horizon, fwd_ret, base_close)
             VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (entity, date, horizon) DO UPDATE SET fwd_ret=EXCLUDED.fwd_ret, base_close=EXCLUDED.base_close, computed_at=now()`, r);
      }
      totalLabels += rows.length; done++;
      if (done % 20 === 0) console.log(`  …${done}/${ents.length} entities, ${totalLabels} labels`);
    }
    console.log(`\n  labeled ${totalLabels} (entity,day,horizon) rows across ${done} tickers → trading_signal_labels\n`);
  } finally { await pool.end(); }
})().catch((e) => { console.error('label failed:', e); process.exit(1); });
