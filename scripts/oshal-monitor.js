#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — live monitor + prediction ledger (single momentum baseline).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | v2 — MULTI-ALGORITHM harness. Runs momentum / gravity (market-derived masses, ADR-054) / Donchian breakout / RSI mean-reversion side by side per symbol, records each prediction tagged by algo, resolves matured ones vs live price, and tracks a SEPARATE hit-rate per algorithm (recent-bar calibration + accumulating live ledger). Pulls live prices + an index series (SPY) for the gravity correlation mass. Pure Node; imports the gravity engine. Built to run on an interval (oshal-monitor-loop.cmd / scheduler).
 *
 *   node scripts/oshal-monitor.js [SYM1,SYM2,...]      # default: HD,LOW,GNRC,BLDR,SPY
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');
const G = require('./oshal-gravity.js');

const envFirst = (...n) => { for (const k of n) { const v = process.env[k]; if (v) return v.trim(); } return ''; };
const KEY = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SECRET = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const DATA_BASE = 'https://data.alpaca.markets/v2';
const LEDGER = path.join('data', '_extracted', 'predictions.json');
const HORIZON_HRS = Number(process.env.MONITOR_HORIZON_HRS || 24);
const INDEX = 'SPY';

function requireKeys() { if (!KEY || !SECRET) { console.error('Missing Alpaca keys (ALPACA_PAPER_KEY_ID/_SECRET or ALPACA_KEY/SECRET).'); process.exit(3); } }
async function adata(p) { const r = await fetch(`${DATA_BASE}${p}`, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || `alpaca-data ${p} ${r.status}`); return j; }
async function latestPrice(s) { const j = await adata(`/stocks/${s}/trades/latest?feed=iex`); return j.trade ? Number(j.trade.p) : null; }
async function dailyCloses(s, n = 60) { const start = new Date(Date.now() - 220 * 864e5).toISOString().slice(0, 10); const j = await adata(`/stocks/${s}/bars?timeframe=1Day&start=${start}&limit=${n}&adjustment=all&feed=iex`); return (j.bars || []).map((b) => Number(b.c)); }

const sma = (c, i, p) => { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += c[k]; return s / p; };
function rsi(c, i, n = 14) { if (i < n) return null; let up = 0, dn = 0; for (let k = i - n + 1; k <= i; k++) { const d = c[k] - c[k - 1]; if (d > 0) up += d; else dn -= d; } return dn === 0 ? 100 : 100 - 100 / (1 + up / dn); }

/* ── the algorithm registry: each .at(closes, i, ctx) → {dir,confidence,basis} | null ──
 * null = "no call today" (the algo only scores when it actually fires). Add algos here. */
const ALGORITHMS = {
  momentum: { label: 'Momentum', at: (c, i) => { const m = sma(c, i, 20); if (m == null) return null; const g = (c[i] - m) / m; return { dir: g >= 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(g) * 12), basis: `close vs SMA20 ${(g * 100).toFixed(1)}%` }; } },
  gravity: { label: 'Gravity', at: (c, i, ctx) => { const masses = G.deriveMasses(ctx.symbol, c.slice(0, i + 1), (ctx.indexCloses && i === c.length - 1) ? { indexCloses: ctx.indexCloses, indexName: INDEX } : {}); const d = G.displacement(masses, 0); if (Math.abs(d) < 0.01) return null; return { dir: d > 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(d) * 2), basis: `${masses.length} masses → ${(d * 100).toFixed(1)}%` }; } },
  donchian: { label: 'Donchian', at: (c, i) => { if (i < 20) return null; let hi = -Infinity, lo = Infinity; for (let k = i - 20; k < i; k++) { hi = Math.max(hi, c[k]); lo = Math.min(lo, c[k]); } if (c[i] > hi) return { dir: 'up', confidence: 0.7, basis: '20d breakout high' }; if (c[i] < lo) return { dir: 'down', confidence: 0.7, basis: '20d breakdown low' }; return null; } },
  meanrev: { label: 'Mean-rev', at: (c, i) => { const r = rsi(c, i, 14); if (r == null) return null; if (r < 35) return { dir: 'up', confidence: Math.min(1, (35 - r) / 35), basis: `RSI ${r.toFixed(0)} oversold` }; if (r > 65) return { dir: 'down', confidence: Math.min(1, (r - 65) / 35), basis: `RSI ${r.toFixed(0)} overbought` }; return null; } },
};

/** Recent-bar calibration: how often the algo's next-day direction was right (immediate hit-rate). */
function calibrate(closes, algo, ctx) {
  let hit = 0, n = 0;
  for (let i = 25; i < closes.length - 1; i++) { const p = algo.at(closes, i, ctx); if (!p) continue; if ((p.dir === 'up') === (closes[i + 1] > closes[i])) hit++; n++; }
  return { samples: n, hitRatePct: n ? round((hit / n) * 100, 1) : null };
}

const loadLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { predictions: [] }; } };
const saveLedger = (l) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); };

(async () => {
  requireKeys();
  const watch = (process.argv[2] || 'HD,LOW,GNRC,BLDR,SPY').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const algoKeys = Object.keys(ALGORITHMS);
  const ledger = loadLedger(); const nowMs = Date.now(); const nowIso = new Date(nowMs).toISOString();
  const spy = await dailyCloses(INDEX).catch(() => []);

  // 1) Resolve matured open predictions against the live price.
  let resolvedNow = 0;
  for (const p of ledger.predictions.filter((x) => !x.resolved && (nowMs - Date.parse(x.ts)) >= x.horizonHrs * 3.6e6)) {
    try { const now = await latestPrice(p.symbol); if (now == null) continue; p.actualDir = now > p.price ? 'up' : 'down'; p.hit = p.predDir === p.actualDir; p.actualPrice = now; p.resolved = true; resolvedNow++; } catch { /* retry next run */ }
  }

  // 2) Per symbol: fetch data, run every algo (live call + recent calibration), record predictions.
  const grid = {}; const calib = {};
  for (const sym of watch) {
    try {
      const closes = await dailyCloses(sym); const price = (await latestPrice(sym)) ?? closes[closes.length - 1];
      const live = price && price !== closes[closes.length - 1] ? [...closes, price] : [...closes];
      const ctx = { symbol: sym, indexCloses: sym === INDEX ? undefined : spy };
      grid[sym] = {};
      for (const k of algoKeys) {
        const p = ALGORITHMS[k].at(live, live.length - 1, ctx);
        const c = calibrate(closes, ALGORITHMS[k], { symbol: sym });
        (calib[k] ||= []).push(c);
        if (p) { grid[sym][k] = p; ledger.predictions.push({ id: `${sym}-${k}-${nowMs}`, symbol: sym, algo: k, ts: nowIso, price: round(price), predDir: p.dir, confidence: round(p.confidence), horizonHrs: HORIZON_HRS, resolved: false }); }
      }
      grid[sym]._price = round(price);
    } catch (e) { grid[sym] = { _error: e.message }; }
  }
  saveLedger(ledger);

  // 3) Report: predictions matrix + per-algo accuracy (calibration + accumulating live ledger).
  console.log(`\n  MULTI-ALGO MONITOR  ${nowIso}  ·  watch: ${watch.join(' ')}\n`);
  console.log(`${pad('symbol', 8)}${padL('price', 10)}${algoKeys.map((k) => padL(ALGORITHMS[k].label, 14)).join('')}`);
  console.log('-'.repeat(8 + 10 + 14 * algoKeys.length));
  for (const sym of watch) {
    const g = grid[sym]; if (g._error) { console.log(`${pad(sym, 8)}  ERROR: ${g._error}`); continue; }
    console.log(`${pad(sym, 8)}${padL(g._price, 10)}${algoKeys.map((k) => padL(g[k] ? `${g[k].dir} ${g[k].confidence ? '(' + round(g[k].confidence) + ')' : ''}` : '—', 14)).join('')}`);
  }
  console.log(`\n${pad('algorithm', 14)}${padL('recent acc%', 14)}${padL('live resolved', 15)}${padL('live hit%', 12)}`);
  console.log('-'.repeat(55));
  for (const k of algoKeys) {
    const cs = (calib[k] || []).filter((c) => c.hitRatePct != null); const ns = cs.reduce((a, c) => a + c.samples, 0);
    const wAcc = ns ? round(cs.reduce((a, c) => a + c.hitRatePct * c.samples, 0) / ns, 1) : '—';
    const res = ledger.predictions.filter((x) => x.algo === k && x.resolved); const hits = res.filter((x) => x.hit).length;
    console.log(`${pad(ALGORITHMS[k].label, 14)}${padL(wAcc + '%', 14)}${padL(res.length, 15)}${padL(res.length ? round((hits / res.length) * 100, 1) + '%' : '—', 12)}`);
  }
  console.log(`\nledger: ${ledger.predictions.length} predictions · ${resolvedNow} resolved this run · stored ${LEDGER}`);
  console.log('Run on an interval to accumulate the LIVE per-algo track record. recent acc% = next-day hit-rate over recent bars.\n');
})();

function round(n, d = 2) { const f = 10 ** d; return Math.round(n * f) / f; }
function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
