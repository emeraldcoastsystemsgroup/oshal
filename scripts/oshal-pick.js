#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deterministic stock picker. Scans a universe over the Alpaca data API, runs the algo ensemble (momentum/gravity/donchian/meanrev) per name, and ranks the strongest longs + shorts by ensemble conviction. The "pick stocks" step that feeds the watchlist. Pure Node; imports the gravity engine.
 *
 *   node scripts/oshal-pick.js [SYM1,SYM2,...] [topN]
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const A = require('./oshal-algos.js'); // single-source strategy — same engine the backtester runs

const ef = (...n) => { for (const k of n) { if (process.env[k]) return process.env[k].trim(); } return ''; };
const KEY = ef('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = ef('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const DATA = 'https://data.alpaca.markets/v2';
const UNIVERSE = 'SPY,QQQ,AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,JPM,XOM,WMT,DIS,NFLX,HD,LOW,GNRC,BLDR,COST';

async function ad(p) { const r = await fetch(`${DATA}${p}`, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || `data ${r.status}`); return j; }
async function closes(s) { const start = new Date(Date.now() - 220 * 864e5).toISOString().slice(0, 10); const j = await ad(`/stocks/${s}/bars?timeframe=1Day&start=${start}&limit=60&adjustment=all&feed=iex`); return (j.bars || []).map((b) => Number(b.c)); }
async function last(s) { const j = await ad(`/stocks/${s}/trades/latest?feed=iex`); return j.trade ? Number(j.trade.p) : null; }

const round = (n) => Math.round(n * 1000) / 1000;
const pad = (s, n) => String(s).padEnd(n); const padL = (s, n) => String(s).padStart(n);

(async () => {
  if (!KEY || !SEC) { console.error('Missing Alpaca keys.'); process.exit(3); }
  const args = process.argv.slice(2);
  const topN = Number(args.find((a) => /^\d+$/.test(a))) || 6;
  const list = (args.find((a) => /[A-Za-z]/.test(a)) || UNIVERSE).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const spy = await closes('SPY').catch(() => []);
  const ranked = [];
  for (const sym of list) {
    try { const c = await closes(sym); if (c.length < 25) continue; const px = (await last(sym)) ?? c[c.length - 1]; const live = px !== c[c.length - 1] ? [...c, px] : [...c]; const e = A.ensembleAt(sym, live, live.length - 1, (spy.length && sym !== 'SPY') ? spy : undefined); ranked.push({ sym, px: round(px), score: e.score, n: e.votes.length }); }
    catch (e) { /* skip unrenderable */ }
  }
  ranked.sort((a, b) => b.score - a.score);
  const longs = ranked.filter((r) => r.score > 0.15).slice(0, topN);
  const shorts = ranked.filter((r) => r.score < -0.15).slice(-topN).reverse();
  console.log(`\n  STOCK PICKER  ·  ${list.length} scanned  ·  deterministic ensemble (momentum/gravity/donchian/meanrev)\n`);
  console.log('  LONGS (buy conviction)                SHORTS (sell conviction)');
  for (let i = 0; i < Math.max(longs.length, shorts.length); i++) {
    const l = longs[i] ? `${pad(longs[i].sym, 6)} ${padL('$' + longs[i].px, 9)}  score ${padL(longs[i].score, 6)} (${longs[i].n})` : '';
    const s = shorts[i] ? `${pad(shorts[i].sym, 6)} ${padL('$' + shorts[i].px, 9)}  score ${padL(shorts[i].score, 7)} (${shorts[i].n})` : '';
    console.log('  ' + pad(l, 38) + s);
  }
  console.log(`\n  ${ranked.length - longs.length - shorts.length} names neutral (|score| ≤ 0.15). Pipe picks into the monitor / decide-algo.\n`);
})();
