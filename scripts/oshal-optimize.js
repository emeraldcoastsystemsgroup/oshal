#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — batch self-optimizer + algorithm performance report. Sweeps an ensemble-weight grid (momentum/gravity/donchian/meanrev each in {0,1,2}) across a universe, in-sample/out-of-sample split per symbol, picks the best config BY IN-SAMPLE return and reports its OUT-OF-SAMPLE result (honest — selection never peeks at OOS). Emits the robust global config to data/_extracted/best-configs.json (the live engine adopts it = the self-improvement loop) and a graphical performance report. Efficient: algo signals are weight-independent, so they're computed once per symbol then the grid folds cheaply. Uses the SAME engine as live + backtest (oshal-algos.js).
 *
 *   node scripts/oshal-optimize.js [SYM1,SYM2,...] [years]
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const fs = require('fs');
const path = require('path');
const A = require('./oshal-algos.js');

const ef = (...n) => { for (const k of n) { if (process.env[k]) return process.env[k].trim(); } return ''; };
const KEY = ef('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = ef('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const DATA = 'https://data.alpaca.markets/v2';
const UNIVERSE = 'SPY,QQQ,AAPL,MSFT,NVDA,AMZN,META,TSLA,JPM,XOM,WMT,DIS,HD,LOW,GNRC,BLDR';
const SLIP = 0.02;

async function ad(p) { const r = await fetch(`${DATA}${p}`, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || `data ${r.status}`); return j; }
async function loadDaily(sym, years) {
  const start = new Date(Date.now() - years * 365 * 864e5).toISOString().slice(0, 10);
  let token = ''; const out = [];
  do { const j = await ad(`/stocks/${sym}/bars?timeframe=1Day&start=${start}&limit=10000&adjustment=all&feed=iex${token ? `&page_token=${encodeURIComponent(token)}` : ''}`); for (const b of j.bars || []) out.push(Number(b.c)); token = j.next_page_token || ''; } while (token);
  return out;
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const wkey = (w) => `${w.momentum}/${w.gravity}/${w.donchian}/${w.meanrev}`;

/** The weight grid — every algo in {0,1,2}, minus the all-off config. */
function grid() { const L = [0, 1, 2]; const g = []; for (const m of L) for (const gr of L) for (const d of L) for (const r of L) { if (m + gr + d + r === 0) continue; g.push({ momentum: m, gravity: gr, donchian: d, meanrev: r }); } return g; }

/** Fold precomputed per-bar signals into a position under given weights (cheap). */
function posFromSignals(sigs, w) {
  if (!sigs || !sigs.length) return 0; let s = 0, ww = 0;
  for (const x of sigs) { const wt = w[x.algo] ?? 1; const c = x.confidence * wt; s += (x.dir === 'up' ? 1 : -1) * c; ww += c; }
  const n = ww ? s / ww : 0; return n > 0.15 ? 1 : n < -0.15 ? -1 : 0;
}

/** Backtest a position-by-bar function over closes → {ret%, sharpe}. */
function bt(closes, off, posAt) {
  let pos = 0, pnl = 0; const rets = [];
  for (let i = 0; i < closes.length - 1; i++) { const w = posAt(off + i); if (w !== pos) { pnl -= SLIP * Math.abs(w - pos); pos = w; } const dp = pos * (closes[i + 1] - closes[i]); pnl += dp; rets.push(dp / closes[i]); }
  const ret = (pnl / closes[0]) * 100; const m = avg(rets); const sd = Math.sqrt(avg(rets.map((x) => (x - m) ** 2))) || 1e-9;
  return { ret: round(ret, 1), sharpe: round(m / sd * Math.sqrt(252), 2) };
}

function report(rows, robust, universe) {
  const C = '#5fa8ff';
  const tr = rows.map((r) => `<tr><td>${r.sym}</td><td class="mono">${r.weights}</td><td class="num">${r.isRet}</td><td class="num" style="color:${r.oosRet < 0 ? '#ff7b7b' : '#36d39a'}">${r.oosRet}</td><td class="num">${r.oosSharpe}</td></tr>`).join('');
  const bars = JSON.stringify({ labels: rows.map((r) => r.sym), data: rows.map((r) => r.oosRet) });
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Algorithm Performance Report</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>body{margin:0;background:#0b1020;color:#e7ecf7;font-family:system-ui,Segoe UI,sans-serif}.page{max-width:1000px;margin:0 auto;padding:26px 22px 70px}h1{font-size:23px;margin:0 0 2px}.sub{color:#8ea0c4;font-size:13px;margin-bottom:20px}.panel{background:#121a30;border:1px solid #27324f;border-radius:14px;padding:20px;margin-bottom:16px}h2{font-size:15px;color:#5fa8ff;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#8ea0c4;font-size:11px;text-transform:uppercase;padding:7px 8px;border-bottom:1px solid #27324f}td{padding:7px 8px;border-bottom:1px solid #27324f}td.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font-family:ui-monospace,monospace}.big{font-size:20px;font-weight:700;color:#36d39a}canvas{max-height:320px}</style></head>
<body><div class="page"><h1>Algorithm Performance Report</h1>
<div class="sub">Batch self-optimization over ${universe.length} symbols. Per symbol: best ensemble weights chosen on IN-SAMPLE, scored OUT-OF-SAMPLE. Weights = momentum/gravity/donchian/meanrev.</div>
<div class="panel"><h2>Robust default (best mean in-sample → adopt live)</h2>
<div class="big mono">${robust.weights}</div>
<div class="sub">mean in-sample ${robust.meanIs}% · mean out-of-sample ${robust.meanOos}% · written to best-configs.json</div></div>
<div class="panel"><h2>Out-of-sample return by symbol (IS-selected weights)</h2><canvas id="b"></canvas></div>
<div class="panel"><h2>Per-symbol winners</h2><table><thead><tr><th>Symbol</th><th>Best weights (m/g/d/r)</th><th class="num">IS ret %</th><th class="num">OOS ret %</th><th class="num">OOS Sharpe</th></tr></thead><tbody>${tr}</tbody></table></div>
<div class="sub">Research-grade; OOS = honest (selection never saw it). Refine: widen the grid, add algos, re-run on a schedule.</div></div>
<script>const D=${bars};new Chart(b,{type:'bar',data:{labels:D.labels,datasets:[{data:D.data,backgroundColor:D.data.map(v=>v<0?'#ff7b7b':'#36d39a')}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#8ea0c4',font:{size:10}},grid:{color:'#1c2742'}},y:{ticks:{color:'#8ea0c4'},grid:{color:'#1c2742'}}}}});</script></body></html>`;
}

(async () => {
  if (!KEY || !SEC) { console.error('Missing Alpaca keys.'); process.exit(3); }
  const args = process.argv.slice(2);
  const years = Number(args.find((a) => /^\d+$/.test(a))) || 6;
  const universe = (args.find((a) => /[A-Za-z]/.test(a)) || UNIVERSE).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const G = grid();
  const spy = (await loadDaily('SPY', years));
  console.log(`\n  BATCH OPTIMIZER  ·  ${universe.length} symbols × ${G.length} weight configs · ${years}y · 70/30 IS/OOS\n`);
  console.log(`  ${'sym'.padEnd(7)}${'best m/g/d/r'.padEnd(14)}${'IS ret%'.padStart(9)}${'OOS ret%'.padStart(10)}${'OOS Shp'.padStart(9)}`);
  console.log('  ' + '-'.repeat(48));
  const rows = []; const isByConfig = new Map(); const oosByConfig = new Map();
  for (const sym of universe) {
    try {
      const closes = await loadDaily(sym, years); if (closes.length < 250) continue;
      const idx = sym === 'SPY' ? closes : spy;
      const sigs = []; for (let i = 0; i < closes.length; i++) sigs.push(A.signalsAt(sym, closes, i, idx));
      const cut = Math.floor(closes.length * 0.7);
      const isC = closes.slice(0, cut); const oosC = closes.slice(cut);
      let best = null;
      for (const w of G) {
        const is = bt(isC, 0, (i) => posFromSignals(sigs[i], w));
        const oos = bt(oosC, cut, (i) => posFromSignals(sigs[i], w));
        isByConfig.set(wkey(w), (isByConfig.get(wkey(w)) || 0) + is.ret);
        oosByConfig.set(wkey(w), (oosByConfig.get(wkey(w)) || 0) + oos.ret);
        if (!best || is.ret > best.is.ret) best = { w, is, oos };
      }
      rows.push({ sym, weights: wkey(best.w), isRet: best.is.ret, oosRet: best.oos.ret, oosSharpe: best.oos.sharpe });
      console.log(`  ${sym.padEnd(7)}${wkey(best.w).padEnd(14)}${String(best.is.ret).padStart(9)}${String(best.oos.ret).padStart(10)}${String(best.oos.sharpe).padStart(9)}`);
    } catch (e) { console.log(`  ${sym.padEnd(7)}ERROR ${e.message}`); }
  }
  // Robust global config: best MEAN in-sample across the universe (honest — selected on IS), report its mean OOS.
  let robustKey = null, bestMeanIs = -Infinity;
  for (const [k, v] of isByConfig) { if (v > bestMeanIs) { bestMeanIs = v; robustKey = k; } }
  const n = rows.length || 1;
  const robust = { weights: robustKey, meanIs: round(bestMeanIs / n, 1), meanOos: round((oosByConfig.get(robustKey) || 0) / n, 1) };
  const [m, g, d, r] = robustKey.split('/').map(Number);
  const outDir = path.join('data', '_extracted'); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'best-configs.json'), JSON.stringify({ robustDefault: { weights: { momentum: m, gravity: g, donchian: d, meanrev: r }, meanIsRet: robust.meanIs, meanOosRet: robust.meanOos }, perSymbol: rows }, null, 2));
  fs.writeFileSync(path.join(outDir, 'algo-performance-report.html'), report(rows, robust, universe));
  console.log('  ' + '-'.repeat(48));
  console.log(`\n  ROBUST DEFAULT (adopt live): weights ${robustKey}  ·  mean IS ${robust.meanIs}%  mean OOS ${robust.meanOos}%`);
  console.log(`  wrote data/_extracted/best-configs.json + algo-performance-report.html\n`);
})();
