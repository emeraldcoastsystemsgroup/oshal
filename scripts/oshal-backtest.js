#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — futures daily backtest engine: volume continuous + SMA/Donchian/RSI/buy-hold compare.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | v2 — back-adjusted continuous series (return-stitched, no roll gaps), per-fill transaction costs, parameterized strategy families, parameter SWEEP, and WALK-FORWARD out-of-sample validation (optimize in-sample → score the held-out next slice). Subcommands: compare | sweep | wf.
 *
 *   node scripts/oshal-backtest.js compare <CL|ES>
 *   node scripts/oshal-backtest.js sweep   <CL|ES> <donchian|sma>
 *   node scripts/oshal-backtest.js wf      <CL|ES> <donchian|sma> [folds]
 *
 * Reads Kibot daily files (YYYYMMDD;O;H;L;C;V) from data/_extracted/<SYM>-DAILY.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const POINT_VALUE = { ES: 50, CL: 1000 };          // $ per 1.00 point
const SLIPPAGE_PTS = { ES: 0.25, CL: 0.03 };       // ~1 tick per fill (cost realism)

/** Parse one Kibot daily file → [{date,o,h,l,c,v}] (volume>0 only). */
function parseContract(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const [date, o, h, l, c, v] = line.split(';');
    const vol = Number(v);
    if (!date || !(vol > 0)) continue;
    out.push({ date, o: +o, h: +h, l: +l, c: +c, v: vol });
  }
  return out;
}

/**
 * Back-adjusted continuous series (return-stitched): each day uses the highest-volume (active)
 * contract; day-to-day change is taken from a SINGLE contract so roll gaps never enter P&L.
 * Adjusted O/H/L are offset by the same amount as the close. Eliminates the v1 roll-gap flaw.
 */
function loadAdjusted(dir) {
  const contracts = new Map(); const dateSet = new Set();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
    const m = new Map();
    for (const bar of parseContract(path.join(dir, f))) { m.set(bar.date, bar); dateSet.add(bar.date); }
    if (m.size) contracts.set(f.replace('.txt', ''), m);
  }
  const dates = [...dateSet].sort();
  const active = new Map();
  for (const d of dates) {
    let best = null;
    for (const [id, m] of contracts) { const b = m.get(d); if (b && (!best || b.v > best.bar.v)) best = { id, bar: b }; }
    if (best) active.set(d, best);
  }
  const days = dates.filter((d) => active.has(d));
  const out = []; let adjC = active.get(days[0]).bar.c;
  out.push(adjBar(days[0], active.get(days[0]).bar, adjC));
  for (let i = 1; i < days.length; i++) {
    const prev = active.get(days[i - 1]); const pm = contracts.get(prev.id);
    const delta = (pm.has(days[i]) && pm.has(days[i - 1])) ? pm.get(days[i]).c - pm.get(days[i - 1]).c
      : active.get(days[i]).bar.c - prev.bar.c;
    adjC += delta;
    out.push(adjBar(days[i], active.get(days[i]).bar, adjC));
  }
  return out;
}
function adjBar(date, raw, adjClose) { const off = adjClose - raw.c; return { date, o: raw.o + off, h: raw.h + off, l: raw.l + off, c: adjClose, v: raw.v }; }

/* ── indicators ───────────────────────────────────────────────────────────── */
function sma(c, i, n) { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; }
function rsi(c, i, n) {
  if (i < n) return null; let up = 0, dn = 0;
  for (let k = i - n + 1; k <= i; k++) { const d = c[k] - c[k - 1]; if (d > 0) up += d; else dn -= d; }
  return dn === 0 ? 100 : 100 - 100 / (1 + (up / dn));
}

/* ── parameterized strategy families: build(bars, param) → (i) => +1|-1|0|null(hold) ── */
const FAMILIES = {
  donchian: (bars, n) => (i) => {
    if (i < n) return 0; let hi = -Infinity, lo = Infinity;
    for (let k = i - n; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
    return bars[i].c > hi ? 1 : bars[i].c < lo ? -1 : null;
  },
  sma: (bars, [f, s]) => { const c = bars.map((b) => b.c); return (i) => { const a = sma(c, i, f), b = sma(c, i, s); return a == null || b == null ? 0 : (a > b ? 1 : -1); }; },
};
const GRID = {
  donchian: [10, 15, 20, 30, 40, 55, 80].map((n) => ({ p: n, label: `N=${n}` })),
  sma: [[10, 30], [20, 50], [20, 100], [50, 100], [50, 200]].map((p) => ({ p, label: `${p[0]}/${p[1]}` })),
};

/* ── backtest engine (with costs) ─────────────────────────────────────────── */
function backtest(bars, sym, signalFn) {
  const slip = SLIPPAGE_PTS[sym] || 0; const pv = POINT_VALUE[sym] || 1;
  let pos = 0, pts = 0, peak = 0, maxDD = 0; const rets = []; const trades = []; const curve = []; let cur = null;
  for (let i = 0; i < bars.length - 1; i++) {
    let want = signalFn(i); if (want === null) want = pos;
    if (want !== pos) {
      pts -= slip * Math.abs(want - pos);                       // fill cost
      if (cur) { cur.exit = bars[i].c; trades.push(cur); }
      cur = want === 0 ? null : { dir: want, entry: bars[i].c };
      pos = want;
    }
    const dp = pos * (bars[i + 1].c - bars[i].c); pts += dp;
    rets.push(dp / bars[i].c); peak = Math.max(peak, pts); maxDD = Math.min(maxDD, pts - peak);
    curve.push({ date: bars[i].date, eq: round(pts * pv) });
  }
  if (cur) { cur.exit = bars[bars.length - 1].c; trades.push(cur); }
  const m = summarize(bars, sym, pts, rets, trades, maxDD); m.curve = curve; return m;
}
function summarize(bars, sym, pts, rets, trades, maxDD) {
  const pv = POINT_VALUE[sym] || 1;
  const years = (Date.parse(iso(bars[bars.length - 1].date)) - Date.parse(iso(bars[0].date))) / 3.15576e10 || 1;
  const ret = (pts / bars[0].c) * 100;
  const tp = trades.map((t) => t.dir * (t.exit - t.entry));    // per-trade points
  const winsArr = tp.filter((x) => x > 0); const lossArr = tp.filter((x) => x < 0);
  const gw = winsArr.reduce((a, b) => a + b, 0); const gl = -lossArr.reduce((a, b) => a + b, 0);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
  const dn = rets.filter((x) => x < 0); const dsd = Math.sqrt(dn.reduce((a, b) => a + b * b, 0) / (dn.length || 1)) || 1e-9;
  return {
    points: round(pts), dollars: round(pts * pv), retPct: round(ret),
    cagrPct: round((Math.pow(Math.max(0.0001, 1 + ret / 100), 1 / years) - 1) * 100),
    trades: trades.length, winPct: trades.length ? round((winsArr.length / trades.length) * 100) : 0,
    ddUsd: round(maxDD * pv), sharpe: round((mean / sd) * Math.sqrt(252)),
    sortino: round((mean / dsd) * Math.sqrt(252)), profitFactor: round(gl ? gw / gl : 0),
    avgWinUsd: round((winsArr.length ? gw / winsArr.length : 0) * pv), avgLossUsd: round((lossArr.length ? gl / lossArr.length : 0) * pv),
  };
}

/* ── walk-forward: optimize on the expanding past, score the next held-out slice ── */
function walkForward(bars, sym, fam, folds) {
  const seg = Math.floor(bars.length / (folds + 1)); const rows = []; let oosPts = 0;
  for (let k = 1; k <= folds; k++) {
    const trainEnd = seg * k; const testEnd = Math.min(seg * (k + 1), bars.length);
    const train = bars.slice(0, trainEnd); const test = bars.slice(trainEnd - 80, testEnd); // carry lookback
    let best = null;
    for (const g of GRID[fam]) { const m = backtest(train, sym, FAMILIES[fam](train, g.p)); if (!best || m.points > best.m.points) best = { g, m }; }
    const oos = backtest(test, sym, FAMILIES[fam](test, g_(best)));
    oosPts += oos.dollars;
    rows.push({ fold: k, picked: best.g.label, isRet: best.m.retPct, oosRet: oos.retPct, oos$: oos.dollars, oosSharpe: oos.sharpe });
  }
  return { rows, oosTotalUsd: round(oosPts) };
}
const g_ = (best) => best.g.p;
const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const round = (n) => Math.round(n * 100) / 100;
const padL = (s, n) => String(s).padStart(n);
const pad = (s, n) => String(s).padEnd(n);

/* ── graphical report (HTML + Chart.js) ───────────────────────────────────── */
function sampleCurve(curve, max = 420) { const step = Math.max(1, Math.ceil(curve.length / max)); return curve.filter((_, i) => i % step === 0); }
function underwater(curve) { let pk = -Infinity; return curve.map((p) => { pk = Math.max(pk, p.eq); return { date: p.date, dd: round(p.eq - pk) }; }); }
function monthlyPnl(curve) {
  const last = new Map(); for (const p of curve) last.set(p.date.slice(0, 6), p.eq);
  const keys = [...last.keys()].sort(); const out = []; let prev = 0;
  for (const k of keys) { out.push({ m: `${k.slice(0, 4)}-${k.slice(4, 6)}`, pnl: round(last.get(k) - prev) }); prev = last.get(k); }
  return out;
}

/** Build a self-contained HTML dashboard: metrics table + equity/drawdown/monthly/WF charts. */
function buildReportHtml(sym, meta, strats, wf) {
  const COLORS = ['#8ea0c4', '#36d39a', '#5fa8ff', '#ffcf6b', '#ff7b7b'];
  const best = strats.filter((s) => s.name !== 'buy-hold').sort((a, b) => b.m.dollars - a.m.dollars)[0] || strats[0];
  const labels = sampleCurve(strats[0].m.curve).map((p) => iso(p.date));
  const equityDs = strats.map((s, i) => ({ label: s.name, data: sampleCurve(s.m.curve).map((p) => p.eq), borderColor: COLORS[i % COLORS.length], borderWidth: 1.5, pointRadius: 0, tension: 0.1 }));
  const uw = sampleCurve(underwater(best.m.curve));
  const mp = monthlyPnl(best.m.curve);
  const COLS = [['retPct', 'Return %'], ['cagrPct', 'CAGR %'], ['dollars', '$ P&L'], ['sharpe', 'Sharpe'], ['sortino', 'Sortino'], ['profitFactor', 'Profit factor'], ['winPct', 'Win %'], ['trades', 'Trades'], ['ddUsd', 'Max DD $'], ['avgWinUsd', 'Avg win $'], ['avgLossUsd', 'Avg loss $']];
  const fmt = (k, v) => (k.endsWith('Usd') || k === 'dollars') ? '$' + Number(v).toLocaleString() : String(v);
  const rows = strats.map((s, i) => `<tr><td style="color:${COLORS[i % COLORS.length]}">${s.name}</td>${COLS.map(([k]) => `<td class="num">${fmt(k, s.m[k])}</td>`).join('')}</tr>`).join('');
  const wfRows = wf.rows.map((r) => `<tr><td>${r.fold}</td><td>${r.picked}</td><td class="num">${r.isRet}</td><td class="num" style="color:${r.oos$ < 0 ? '#ff7b7b' : '#36d39a'}">${r.oosRet}</td><td class="num">$${r.oos$.toLocaleString()}</td><td class="num">${r.oosSharpe}</td></tr>`).join('');
  const DATA = JSON.stringify({ labels, equityDs, uw, mp, wf: wf.rows });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${sym} Backtest Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root{--bg:#0b1020;--panel:#121a30;--line:#27324f;--text:#e7ecf7;--muted:#8ea0c4;--accent:#5fa8ff}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,sans-serif}
  .page{max-width:1080px;margin:0 auto;padding:28px 22px 80px}h1{font-size:24px;margin:0 0 2px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:22px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}
  h2{font-size:15px;margin:0 0 12px;color:var(--accent)}
  table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:7px 8px;border-bottom:1px solid var(--line)}
  td{padding:7px 8px;border-bottom:1px solid var(--line)}td.num{text-align:right;font-variant-numeric:tabular-nums}
  canvas{max-height:320px}.foot{color:var(--muted);font-size:11px;margin-top:10px}
</style></head><body><div class="page">
  <h1>${sym} — Backtest Report</h1>
  <div class="sub">${meta.days.toLocaleString()} trading days · ${meta.from} → ${meta.to} · back-adjusted continuous · $${meta.pv}/pt · ${meta.slip}pt slippage/fill · 1 contract, no compounding</div>
  <div class="panel"><h2>Performance summary</h2><table><thead><tr><th>Strategy</th>${COLS.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
  <div class="panel"><h2>Equity curves (cumulative $ P&amp;L)</h2><canvas id="eq"></canvas></div>
  <div class="panel"><h2>Drawdown — underwater ($), best strategy: ${best.name}</h2><canvas id="dd"></canvas></div>
  <div class="panel"><h2>Monthly P&amp;L ($), ${best.name}</h2><canvas id="mp"></canvas></div>
  <div class="panel"><h2>Walk-forward (out-of-sample) — Donchian</h2>
    <table><thead><tr><th>Fold</th><th>Picked (in-sample)</th><th class="num">IS ret %</th><th class="num">OOS ret %</th><th class="num">OOS $</th><th class="num">OOS Sharpe</th></tr></thead><tbody>${wfRows}</tbody></table>
    <canvas id="wf" style="margin-top:14px"></canvas>
    <div class="foot">OOS = each fold trades with parameters chosen ONLY from earlier data — the honest, anti-overfit test. Total OOS: $${wf.oosTotalUsd.toLocaleString()}.</div></div>
  <div class="foot">Research-grade: close-to-close fills, 1 contract, no compounding/position-sizing. Not investment advice.</div>
</div>
<script>
const D=${DATA};const grid={color:'#1c2742'},tick={color:'#8ea0c4',font:{size:10}};
new Chart(eq,{type:'line',data:{labels:D.labels,datasets:D.equityDs},options:{plugins:{legend:{labels:{color:'#e7ecf7'}}},scales:{x:{ticks:{...tick,maxTicksLimit:10},grid},y:{ticks:tick,grid}}}});
new Chart(dd,{type:'line',data:{labels:D.uw.map(p=>p.date.slice(0,4)+'-'+p.date.slice(4,6)),datasets:[{data:D.uw.map(p=>p.dd),borderColor:'#ff7b7b',backgroundColor:'rgba(255,123,123,.15)',fill:true,borderWidth:1,pointRadius:0}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{...tick,maxTicksLimit:10},grid},y:{ticks:tick,grid}}}});
new Chart(mp,{type:'bar',data:{labels:D.mp.map(p=>p.m),datasets:[{data:D.mp.map(p=>p.pnl),backgroundColor:D.mp.map(p=>p.pnl<0?'#ff7b7b':'#36d39a')}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{...tick,maxTicksLimit:14},grid},y:{ticks:tick,grid}}}});
new Chart(wf,{type:'bar',data:{labels:D.wf.map(r=>'Fold '+r.fold),datasets:[{label:'OOS ret %',data:D.wf.map(r=>r.oosRet),backgroundColor:D.wf.map(r=>r.oosRet<0?'#ff7b7b':'#5fa8ff')}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:tick,grid},y:{ticks:tick,grid}}}});
</script></body></html>`;
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */
function bars(sym) {
  const dir = path.join('data', '_extracted', `${sym}-DAILY`);
  if (!fs.existsSync(dir)) { console.error(`No data dir ${dir} — unzip data/${sym}-DAILY.zip there.`); process.exit(1); }
  const b = loadAdjusted(dir);
  if (b.length < 120) { console.error(`Too few bars (${b.length}).`); process.exit(1); }
  return b;
}
(function main() {
  const [cmd = 'compare', symA = 'ES', famOrFolds, folds] = process.argv.slice(2);
  const sym = symA.toUpperCase();
  if (cmd === 'compare') {
    const b = bars(sym);
    console.log(`\n${sym} back-adjusted continuous: ${b.length} days, ${iso(b[0].date)} → ${iso(b[b.length - 1].date)} | $${POINT_VALUE[sym]}/pt, ${SLIPPAGE_PTS[sym]}pt slippage/fill\n`);
    console.log(`${pad('strategy', 14)}${padL('ret%', 9)}${padL('CAGR%', 8)}${padL('$P&L', 13)}${padL('trades', 8)}${padL('win%', 7)}${padL('maxDD$', 13)}${padL('Sharpe', 8)}`);
    console.log('-'.repeat(80));
    const runs = { 'buy-hold': () => 1, 'sma 20/50': FAMILIES.sma(b, [20, 50]), 'donchian 20': FAMILIES.donchian(b, 20), 'donchian 55': FAMILIES.donchian(b, 55) };
    for (const [name, fn] of Object.entries(runs)) {
      const m = backtest(b, sym, fn);
      console.log(`${pad(name, 14)}${padL(m.retPct, 9)}${padL(m.cagrPct, 8)}${padL(m.dollars.toLocaleString(), 13)}${padL(m.trades, 8)}${padL(m.winPct, 7)}${padL(m.ddUsd.toLocaleString(), 13)}${padL(m.sharpe, 8)}`);
    }
    console.log('');
  } else if (cmd === 'sweep') {
    const fam = famOrFolds; const b = bars(sym);
    console.log(`\n${sym} ${fam} parameter sweep (in-sample, full history):\n`);
    console.log(`${pad('param', 10)}${padL('ret%', 9)}${padL('$P&L', 13)}${padL('trades', 8)}${padL('win%', 7)}${padL('Sharpe', 8)}`);
    console.log('-'.repeat(55));
    for (const g of GRID[fam]) { const m = backtest(b, sym, FAMILIES[fam](b, g.p)); console.log(`${pad(g.label, 10)}${padL(m.retPct, 9)}${padL(m.dollars.toLocaleString(), 13)}${padL(m.trades, 8)}${padL(m.winPct, 7)}${padL(m.sharpe, 8)}`); }
    console.log('');
  } else if (cmd === 'wf') {
    const fam = famOrFolds; const nf = Number(folds) || 5; const b = bars(sym);
    const { rows, oosTotalUsd } = walkForward(b, sym, fam, nf);
    console.log(`\n${sym} ${fam} WALK-FORWARD (${nf} folds — optimize on past, score the held-out next slice):\n`);
    console.log(`${pad('fold', 6)}${pad('picked(IS)', 12)}${padL('IS ret%', 9)}${padL('OOS ret%', 10)}${padL('OOS $', 13)}${padL('OOS Sharpe', 12)}`);
    console.log('-'.repeat(62));
    for (const r of rows) console.log(`${pad(r.fold, 6)}${pad(r.picked, 12)}${padL(r.isRet, 9)}${padL(r.oosRet, 10)}${padL(r.oos$.toLocaleString(), 13)}${padL(r.oosSharpe, 12)}`);
    console.log('-'.repeat(62));
    console.log(`${pad('TOTAL OOS', 18)}${padL('', 19)}${padL(oosTotalUsd.toLocaleString(), 13)}\n`);
    console.log('OOS = out-of-sample: each fold trades with params chosen ONLY from earlier data. This is the honest test.\n');
  } else if (cmd === 'report') {
    const b = bars(sym);
    const meta = { days: b.length, from: iso(b[0].date), to: iso(b[b.length - 1].date), pv: POINT_VALUE[sym], slip: SLIPPAGE_PTS[sym] };
    const strats = [
      { name: 'buy-hold', m: backtest(b, sym, () => 1) },
      { name: 'sma 20/50', m: backtest(b, sym, FAMILIES.sma(b, [20, 50])) },
      { name: 'donchian 20', m: backtest(b, sym, FAMILIES.donchian(b, 20)) },
      { name: 'donchian 55', m: backtest(b, sym, FAMILIES.donchian(b, 55)) },
    ];
    const wf = walkForward(b, sym, 'donchian', 5);
    const html = buildReportHtml(sym, meta, strats, wf);
    const outDir = path.join('data', '_extracted'); fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${sym}-backtest-report.html`);
    fs.writeFileSync(out, html);
    console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB) — open it in a browser.`);
  } else { console.error('usage: oshal-backtest.js <compare|sweep|wf|report> <CL|ES> [family] [folds]'); process.exit(1); }
})();
