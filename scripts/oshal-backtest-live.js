#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — backtest the LIVE strategy. Runs the exact deterministic ensemble (scripts/oshal-algos.js — the same engine pick/monitor trade and the in-app /decide-algo mirrors) over years of Alpaca daily equity history, vs buy-hold and each component algo. Reports return/CAGR/Sharpe/Sortino/maxDD/win, writes a graphical HTML report, and a `wf` mode walk-forwards alternative ensemble WEIGHTS (the refine knob) to find what holds up out-of-sample. Closes the loop: test (live) == backtest (history) == refine. Pure Node.
 *
 *   node scripts/oshal-backtest-live.js <SYM> [years]        # compare ensemble vs components vs buy-hold + HTML
 *   node scripts/oshal-backtest-live.js <SYM> wf [years]     # walk-forward the ensemble weight schemes (refine)
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
const SLIP = 0.02; // $/share per fill

async function ad(p) { const r = await fetch(`${DATA}${p}`, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || `data ${r.status}`); return j; }
async function loadDaily(sym, years) {
  const start = new Date(Date.now() - years * 365 * 864e5).toISOString().slice(0, 10);
  let token = ''; const out = [];
  do { const j = await ad(`/stocks/${sym}/bars?timeframe=1Day&start=${start}&limit=10000&adjustment=all&feed=iex${token ? `&page_token=${encodeURIComponent(token)}` : ''}`); for (const b of j.bars || []) out.push({ date: b.t.slice(0, 10), c: Number(b.c) }); token = j.next_page_token || ''; } while (token);
  return out;
}

/** Backtest a position function over a close series → metrics + equity curve. */
function backtest(closes, posFn) {
  let pos = 0, pnl = 0, peak = 0, maxDD = 0; const rets = []; const curve = []; const trades = []; let cur = null;
  for (let i = 0; i < closes.length - 1; i++) {
    const want = posFn(i);
    if (want !== pos) { pnl -= SLIP * Math.abs(want - pos); if (cur) { cur.exit = closes[i]; trades.push(cur); } cur = want === 0 ? null : { dir: want, entry: closes[i] }; pos = want; }
    const dp = pos * (closes[i + 1] - closes[i]); pnl += dp; rets.push(dp / closes[i]); peak = Math.max(peak, pnl); maxDD = Math.min(maxDD, pnl - peak); curve.push(round(pnl));
  }
  if (cur) { cur.exit = closes[closes.length - 1]; trades.push(cur); }
  const years = (rets.length || 1) / 252; const ret = (pnl / closes[0]) * 100;
  const mean = avg(rets); const sd = Math.sqrt(avg(rets.map((x) => (x - mean) ** 2))) || 1e-9;
  const dn = rets.filter((x) => x < 0); const dsd = Math.sqrt(dn.reduce((a, b) => a + b * b, 0) / (dn.length || 1)) || 1e-9;
  const wins = trades.filter((t) => t.dir * (t.exit - t.entry) > 0).length;
  return { retPct: round(ret, 1), cagrPct: round((Math.pow(Math.max(0.0001, 1 + ret / 100), 1 / years) - 1) * 100, 1), sharpe: round(mean / sd * Math.sqrt(252), 2), sortino: round(mean / dsd * Math.sqrt(252), 2), maxDDPct: round((maxDD / closes[0]) * 100, 1), trades: trades.length, winPct: trades.length ? round(wins / trades.length * 100, 1) : 0, curve, pnl: round(pnl, 2) };
}
const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const round = (n, d = 4) => { const f = 10 ** d; return Math.round(n * f) / f; };
const pad = (s, n) => String(s).padEnd(n); const padL = (s, n) => String(s).padStart(n);

const WEIGHT_SCHEMES = {
  equal: {}, 'trend-lean': { momentum: 1, gravity: 1, donchian: 1, meanrev: 0.3 },
  'gravity-heavy': { gravity: 2, momentum: 1, donchian: 1, meanrev: 0.5 }, 'contrarian': { meanrev: 2, momentum: 0.5, gravity: 1, donchian: 0.5 },
};

function reportHtml(sym, dates, runs) {
  const C = ['#5fa8ff', '#8ea0c4', '#36d39a', '#ffcf6b', '#ff7b7b', '#c08bff'];
  const step = Math.max(1, Math.ceil(dates.length / 420));
  const labels = dates.filter((_, i) => i % step === 0);
  const ds = runs.map((r, i) => ({ label: r.name, data: r.m.curve.filter((_, j) => j % step === 0), borderColor: C[i % C.length], borderWidth: r.name === 'ensemble' ? 2.2 : 1.2, pointRadius: 0, tension: 0.1 }));
  const rows = runs.map((r, i) => `<tr><td style="color:${C[i % C.length]}">${r.name}</td><td class="num">${r.m.retPct}</td><td class="num">${r.m.cagrPct}</td><td class="num">${r.m.sharpe}</td><td class="num">${r.m.sortino}</td><td class="num">${r.m.maxDDPct}</td><td class="num">${r.m.winPct}</td><td class="num">${r.m.trades}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${sym} — Live Strategy Backtest</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>body{margin:0;background:#0b1020;color:#e7ecf7;font-family:system-ui,Segoe UI,sans-serif}.page{max-width:1060px;margin:0 auto;padding:26px 22px 70px}h1{font-size:23px;margin:0 0 2px}.sub{color:#8ea0c4;font-size:13px;margin-bottom:20px}.panel{background:#121a30;border:1px solid #27324f;border-radius:14px;padding:20px;margin-bottom:16px}h2{font-size:15px;color:#5fa8ff;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#8ea0c4;font-size:11px;text-transform:uppercase;padding:7px 8px;border-bottom:1px solid #27324f}td{padding:7px 8px;border-bottom:1px solid #27324f}td.num{text-align:right;font-variant-numeric:tabular-nums}canvas{max-height:340px}</style></head>
<body><div class="page"><h1>${sym} — Live Strategy Backtest</h1>
<div class="sub">The exact deterministic ensemble that trades live, run over ${dates.length} sessions (${dates[0]} → ${dates[dates.length - 1]}). 1 share, close-to-close, $${SLIP}/share slippage, long & short.</div>
<div class="panel"><h2>Performance — ensemble vs components vs buy-hold</h2><table><thead><tr><th>Strategy</th><th class="num">Return %</th><th class="num">CAGR %</th><th class="num">Sharpe</th><th class="num">Sortino</th><th class="num">Max DD %</th><th class="num">Win %</th><th class="num">Trades</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="panel"><h2>Equity curves ($ P&amp;L per share)</h2><canvas id="eq"></canvas></div>
<div class="sub">Research-grade; not investment advice.</div></div>
<script>const D=${JSON.stringify({ labels, ds })};const t={color:'#8ea0c4',font:{size:10}},g={color:'#1c2742'};
new Chart(eq,{type:'line',data:{labels:D.labels,datasets:D.ds},options:{plugins:{legend:{labels:{color:'#e7ecf7'}}},scales:{x:{ticks:{...t,maxTicksLimit:10},grid:g},y:{ticks:t,grid:g}}}});</script></body></html>`;
}

(async () => {
  if (!KEY || !SEC) { console.error('Missing Alpaca keys.'); process.exit(3); }
  const args = process.argv.slice(2); const sym = (args[0] || 'AAPL').toUpperCase();
  const wf = args.includes('wf'); const years = Number(args.find((a) => /^\d+$/.test(a))) || 6;
  const bars = await loadDaily(sym, years); const closes = bars.map((b) => b.c); const dates = bars.map((b) => b.date);
  if (closes.length < 120) { console.error(`Too few bars for ${sym} (${closes.length}).`); process.exit(1); }
  const spy = sym === 'SPY' ? closes : (await loadDaily('SPY', years)).map((b) => b.c);
  console.log(`\n  LIVE-STRATEGY BACKTEST  ${sym}  ·  ${closes.length} sessions ${dates[0]} → ${dates[dates.length - 1]}\n`);

  if (wf) {
    const seg = Math.floor(closes.length / 6); console.log('  WALK-FORWARD weight schemes (optimize IS return → score OOS):\n');
    console.log(`  ${pad('fold', 6)}${pad('picked scheme', 16)}${padL('IS ret%', 10)}${padL('OOS ret%', 10)}${padL('OOS Sharpe', 12)}`);
    let oos = 0;
    for (let k = 1; k <= 5; k++) {
      const tr = closes.slice(0, seg * k); const te = closes.slice(seg * k - 60, seg * (k + 1));
      let best = null;
      for (const [nm, w] of Object.entries(WEIGHT_SCHEMES)) { const m = backtest(tr, (i) => A.positionAt(sym, tr, i, spy, w)); if (!best || m.retPct > best.m.retPct) best = { nm, w, m }; }
      const m = backtest(te, (i) => A.positionAt(sym, te, i, spy, best.w)); oos += m.retPct;
      console.log(`  ${pad(k, 6)}${pad(best.nm, 16)}${padL(best.m.retPct, 10)}${padL(m.retPct, 10)}${padL(m.sharpe, 12)}`);
    }
    console.log(`\n  total OOS return ${round(oos, 1)}%  (out-of-sample = weights chosen only from earlier data)\n`);
    return;
  }

  const runs = [
    { name: 'ensemble', m: backtest(closes, (i) => A.positionAt(sym, closes, i, spy)) },
    ...A.ALGOS.map((a) => ({ name: a, m: backtest(closes, (i) => A.algoPositionAt(sym, closes, i, spy, a)) })),
    { name: 'buy-hold', m: backtest(closes, () => 1) },
  ];
  console.log(`  ${pad('strategy', 12)}${padL('ret%', 9)}${padL('CAGR%', 8)}${padL('Sharpe', 8)}${padL('Sortino', 9)}${padL('maxDD%', 9)}${padL('win%', 7)}${padL('trades', 8)}`);
  console.log('  ' + '-'.repeat(68));
  for (const r of runs) console.log(`  ${pad(r.name, 12)}${padL(r.m.retPct, 9)}${padL(r.m.cagrPct, 8)}${padL(r.m.sharpe, 8)}${padL(r.m.sortino, 9)}${padL(r.m.maxDDPct, 9)}${padL(r.m.winPct, 7)}${padL(r.m.trades, 8)}`);
  const outDir = path.join('data', '_extracted'); fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `live-backtest-${sym}.html`); fs.writeFileSync(out, reportHtml(sym, dates, runs));
  console.log(`\n  wrote ${out}\n`);
})();
