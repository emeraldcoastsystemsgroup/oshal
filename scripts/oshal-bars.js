#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — minute-bar ingester. Pulls 1-minute OHLCV bars from the Alpaca data API (IEX) for a watchlist, paginates a full session, and stores them to data/_extracted/minute/<SYM>-<date>.csv (gitignored). The "get minute tickers, store them" step — research store for intraday strategies + realistic fills. Pure Node. Production target = a Postgres/Timescale bars table; CSV is the local research store.
 *
 *   node scripts/oshal-bars.js [SYM1,SYM2,...] [YYYY-MM-DD]
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');

const ef = (...n) => { for (const k of n) { if (process.env[k]) return process.env[k].trim(); } return ''; };
const KEY = ef('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = ef('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const DATA = 'https://data.alpaca.markets/v2';

async function ad(p) { const r = await fetch(`${DATA}${p}`, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || `data ${r.status}`); return j; }

/** All 1-min bars for a symbol on [date, date+1) — paginates the session via next_page_token. */
async function minuteBars(sym, date) {
  const start = `${date}T00:00:00Z`; const end = `${date}T23:59:59Z`;
  let token = ''; const bars = [];
  do {
    const j = await ad(`/stocks/${sym}/bars?timeframe=1Min&start=${start}&end=${end}&limit=10000&feed=iex${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
    for (const b of j.bars || []) bars.push(b);
    token = j.next_page_token || '';
  } while (token);
  return bars;
}

(async () => {
  if (!KEY || !SEC) { console.error('Missing Alpaca keys.'); process.exit(3); }
  const args = process.argv.slice(2);
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const syms = (args.find((a) => /[A-Za-z]/.test(a)) || 'HD,LOW,GNRC,BLDR,SPY').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = path.join('data', '_extracted', 'minute'); fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n  MINUTE BARS  date ${date}  ·  ${syms.join(' ')}\n`);
  for (const sym of syms) {
    try {
      const bars = await minuteBars(sym, date);
      if (!bars.length) { console.log(`  ${sym.padEnd(6)} no bars (market closed / no IEX prints for ${date})`); continue; }
      const csv = 'timestamp,open,high,low,close,volume\n' + bars.map((b) => `${b.t},${b.o},${b.h},${b.l},${b.c},${b.v}`).join('\n') + '\n';
      const out = path.join(outDir, `${sym}-${date}.csv`);
      fs.writeFileSync(out, csv);
      console.log(`  ${sym.padEnd(6)} ${String(bars.length).padStart(5)} bars  →  ${out}`);
    } catch (e) { console.log(`  ${sym.padEnd(6)} ERROR: ${e.message}`); }
  }
  console.log('');
})();
