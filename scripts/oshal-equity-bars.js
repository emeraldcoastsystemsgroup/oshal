#!/usr/bin/env node
/*
 * Equity minute-bar range puller — feeds the intraday engine a STOCK BASKET (ADR-052/054).
 *
 * oshal-bars.js pulls one day per call (research store); this pulls a multi-YEAR range per symbol in a
 * few paginated calls and writes it straight into the intraday engine's continuous format
 * (data/_extracted/<sym>-minute-cont.csv: day,hm,o,h,l,c,v) so `oshal-intraday.js rotate <basket>` can
 * test the "send money to the hottest name" thesis across many dispersed names — which is where
 * momentum rotation actually earns (two futures don't disperse; a stock basket does).
 *
 * Alpaca free IEX gives full multi-year 1-min history (RTH, ~390 bars/day). Timestamps are UTC; we map
 * each bar to its EXCHANGE-LOCAL (America/New_York) minute-of-day via Intl so DST is handled correctly
 * and the session window [570,960] = 09:30–16:00 ET lines up with the engine.
 *
 *   node scripts/oshal-equity-bars.js <SYM1,SYM2,...> [years]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — range puller → continuous minute CSV per ticker (UTC→ET via Intl/DST-safe), for equity-basket intraday rotation backtests.
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');

const ef = (...n) => { for (const k of n) { if (process.env[k]) return process.env[k].trim(); } return ''; };
const KEY = ef('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = ef('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const DATA = 'https://data.alpaca.markets/v2';
const CONT = (sym) => path.join('data', '_extracted', `${sym.toLowerCase()}-minute-cont.csv`);

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** UTC ISO → { day:'YYYYMMDD', hm: minutes-of-day in ET (DST-correct) }. */
function toEt(iso) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(iso)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hh = Number(p.hour) % 24;
  return { day: `${p.year}${p.month}${p.day}`, hm: hh * 60 + Number(p.minute) };
}

async function ad(p) {
  const r = await fetch(`${DATA}${p}`, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `data ${r.status}`);
  return j;
}

/** Pull every 1-min IEX bar for [startDate, endDate] and write the continuous CSV. */
async function pullSymbol(sym, startDate, endDate) {
  const start = `${startDate}T00:00:00Z`, end = `${endDate}T23:59:59Z`;
  const out = fs.createWriteStream(CONT(sym));
  out.write('day,hm,o,h,l,c,v\n');
  let token = '', rows = 0, pages = 0;
  do {
    const j = await ad(`/stocks/${sym}/bars?timeframe=1Min&start=${start}&end=${end}&limit=10000&adjustment=all&feed=iex${token ? `&page_token=${encodeURIComponent(token)}` : ''}`);
    for (const b of j.bars || []) { const { day, hm } = toEt(b.t); out.write(`${day},${hm},${b.o},${b.h},${b.l},${b.c},${b.v}\n`); rows++; }
    token = j.next_page_token || ''; pages++;
  } while (token);
  await new Promise((r) => out.end(r));
  return { rows, pages };
}

(async () => {
  if (!KEY || !SEC) { console.error('Missing Alpaca keys (ALPACA_PAPER_KEY_ID/SECRET or ALPAKA_*).'); process.exit(3); }
  const args = process.argv.slice(2);
  const syms = (args.find((a) => /[A-Za-z]/.test(a)) || 'NVDA,AMD,TSLA').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const years = Number(args.find((a) => /^\d+$/.test(a))) || 2;
  const today = new Date(Date.now() - 864e5);                      // yesterday (free feed lags ~15m; avoid today)
  const endDate = today.toISOString().slice(0, 10);
  const startDate = `${today.getUTCFullYear() - years}${endDate.slice(4)}`;
  fs.mkdirSync(path.join('data', '_extracted'), { recursive: true });
  console.log(`\n  EQUITY MINUTE  ${startDate} → ${endDate}  ·  ${syms.length} symbols\n`);
  for (const sym of syms) {
    try { const { rows, pages } = await pullSymbol(sym, startDate, endDate); console.log(`  ${sym.padEnd(6)} ${String(rows).padStart(8)} bars (${pages} pages) → ${CONT(sym)}`); }
    catch (e) { console.log(`  ${sym.padEnd(6)} ERROR: ${e.message}`); }
  }
  console.log('');
})();
