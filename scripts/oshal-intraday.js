#!/usr/bin/env node
/*
 * OSHAL intraday futures engine — the "actively day trade" research harness (ADR-052/054).
 *
 * The daily engine (oshal-backtest.js) trades end-of-day bars; this one trades INTRADAY minute bars
 * and is FLAT BY CLOSE — a true day-trading model. Because every trade opens and closes inside one
 * session, roll discontinuities never enter P&L, so (unlike the daily engine) NO back-adjustment is
 * needed: we just stitch the FRONT (highest-volume) contract per day into a continuous minute series.
 *
 * Two stages:
 *   build   — front-month continuous minute series from the per-contract Kibot files (memory-light,
 *             two-pass: pass 1 picks the winning contract per day by volume; pass 2 streams each
 *             winner's bars out in contract-chronological order → globally sorted, no big in-RAM array).
 *   compare — day-streaming backtest: buffers ONE session at a time, runs each strategy reset-per-day,
 *             flat at the session close, with per-fill slippage + commission → metrics + HTML report.
 *
 * Strategies (all intraday, reset each day, forced flat at the session close):
 *   orb       — opening-range breakout: range of the first N min, trade the break, stop the far side.
 *   vwap      — VWAP mean-reversion: fade a stretch beyond k·σ from the session VWAP, cover at VWAP.
 *   donchian  — intraday N-bar high/low breakout, stop the opposite band.
 *   ema       — fast/slow EMA cross on minute closes.
 *   buy-hold  — long the open, sell the close (the intraday benchmark).
 *
 *   node scripts/oshal-intraday.js build   <ES|CL>
 *   node scripts/oshal-intraday.js compare <ES|CL> [years]      # console + HTML report
 *   node scripts/oshal-intraday.js report  <ES|CL> [years]      # HTML only
 *
 * Reads data/_extracted/<SYM>-MINUTE/*.txt (unzip <SYM>Minute / <SYM>-MINUTE.zip there).
 * Writes data/_extracted/<sym>-minute-cont.csv (cache) + data/_extracted/<sym>-intraday-report.html.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — front-month continuous minute builder (no back-adjust: intraday=flat-by-close) + day-streaming intraday backtest (ORB/VWAP/Donchian/EMA/buy-hold), per-fill slippage+commission, session windows, graphical HTML report.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const POINT_VALUE = { ES: 50, CL: 1000 };       // $ per 1.00 point
// Cost dials — scale both with INTRADAY_COST_MULT (0 = frictionless, to isolate overhead vs edge).
const COST_MULT = process.env.INTRADAY_COST_MULT != null ? Number(process.env.INTRADAY_COST_MULT) : 1;
const SLIPPAGE_PTS = { ES: 0.25 * COST_MULT, CL: 0.02 * COST_MULT };    // ~1 tick ES / 2 ticks CL per fill
const COMMISSION_RT = 4.0 * COST_MULT;                                  // $ per round-turn (entry+exit), all-in
const TICK = { ES: 0.25, CL: 0.01 };
// Regular-session window in MINUTES-OF-DAY (exchange/ET clock the Kibot stamps use).
const SESSION = { ES: [570, 960], CL: [540, 870] }; // ES 09:30–16:00, CL 09:00–14:30
/** Session window for a symbol; unknown tickers default to equity RTH (09:30–16:00 ET). */
const sess = (s) => SESSION[s] || [570, 960];

const EXT = (sym) => path.join('data', '_extracted', `${sym}-MINUTE`);
const CONT = (sym) => path.join('data', '_extracted', `${sym.toLowerCase()}-minute-cont.csv`);
const REPORT = (sym) => path.join('data', '_extracted', `${sym.toLowerCase()}-intraday-report.html`);

const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const padL = (s, n) => String(s).padStart(n);
const pad = (s, n) => String(s).padEnd(n);

/* ── parse one raw minute line of either Kibot format → {day,hm,o,h,l,c,v} or null ──
 *  ES: MM/DD/YYYY,HH:MM,O,H,L,C,V   (comma)
 *  CL: YYYYMMDD HHMMSS;O;H;L;C;V    (semicolon) */
function parseLine(line) {
  if (!line) return null;
  if (line.indexOf(';') >= 0) { // CL
    const [stamp, o, h, l, c, v] = line.split(';');
    const sp = stamp.indexOf(' '); if (sp < 0) return null;
    const day = stamp.slice(0, 8);
    const t = stamp.slice(sp + 1);
    const hm = Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4));
    return { day, hm, o: +o, h: +h, l: +l, c: +c, v: +v };
  }
  const parts = line.split(','); if (parts.length < 6) return null; // ES
  const [d, t, o, h, l, c, v] = parts;
  const [mo, da, yr] = d.split('/');
  if (!yr) return null;
  const day = `${yr}${mo.padStart(2, '0')}${da.padStart(2, '0')}`;
  const [hh, mm] = t.split(':');
  return { day, hm: Number(hh) * 60 + Number(mm), o: +o, h: +h, l: +l, c: +c, v: +v };
}

/* ── stage 1: front-month continuous minute builder ─────────────────────────── */
async function streamFile(file, onBar) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { const b = parseLine(line); if (b && b.v >= 0 && b.c > 0) onBar(b); }
}

async function buildContinuous(sym) {
  const dir = EXT(sym);
  if (!fs.existsSync(dir)) { console.error(`No data dir ${dir} — unzip data/${sym}*Minute*.zip there.`); process.exit(1); }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => path.join(dir, f));
  console.log(`build ${sym}: ${files.length} contract files`);

  // Pass 1 — winning (highest total volume) contract per day.
  const dayWinner = new Map(); // day -> { file, vol }
  for (const file of files) {
    const local = new Map(); // day -> vol (this contract)
    await streamFile(file, (b) => local.set(b.day, (local.get(b.day) || 0) + b.v));
    for (const [day, vol] of local) {
      const w = dayWinner.get(day);
      if (!w || vol > w.vol) dayWinner.set(day, { file, vol });
    }
  }
  console.log(`build ${sym}: ${dayWinner.size.toLocaleString()} trading days`);

  // Invert: file -> Set(days it owns) + each file's earliest owned day (for chronological emit order).
  const owns = new Map(); const minDay = new Map();
  for (const [day, w] of dayWinner) {
    if (!owns.has(w.file)) owns.set(w.file, new Set());
    owns.get(w.file).add(day);
    if (!minDay.has(w.file) || day < minDay.get(w.file)) minDay.set(w.file, day);
  }
  const order = [...owns.keys()].sort((a, b) => minDay.get(a).localeCompare(minDay.get(b)));

  // Pass 2 — emit each winner's owned-day bars in contract order → globally sorted minute series.
  const out = fs.createWriteStream(CONT(sym));
  out.write('day,hm,o,h,l,c,v\n');
  let rows = 0;
  for (const file of order) {
    const days = owns.get(file);
    await streamFile(file, (b) => { if (days.has(b.day)) { out.write(`${b.day},${b.hm},${b.o},${b.h},${b.l},${b.c},${b.v}\n`); rows++; } });
  }
  await new Promise((r) => out.end(r));
  console.log(`build ${sym}: wrote ${rows.toLocaleString()} minute bars → ${CONT(sym)}`);
  return CONT(sym);
}

/* ── intraday strategies — each: (dayBars) => [{dir, entryIdx, exitIdx}] (flat by close) ──
 *  dayBars = the session-filtered bars for ONE day, chronological. Strategies enter on a bar's close
 *  and the engine fills the NEXT bar's open-ish (we use close-to-close on the signal bar for realism
 *  parity with the daily engine) and force-exits the final session bar. */
const ema = (prev, price, k) => prev == null ? price : prev + k * (price - prev);

const STRATS = {
  // Opening-range breakout: range over first orbMin bars; first break long/short; stop far side; flat EOD.
  orb: (bars, orbMin = 15) => {
    if (bars.length < orbMin + 5) return [];
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < orbMin; i++) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
    for (let i = orbMin; i < bars.length - 1; i++) {
      if (bars[i].c > hi) return [{ dir: 1, entryIdx: i, stop: lo }];
      if (bars[i].c < lo) return [{ dir: -1, entryIdx: i, stop: hi }];
    }
    return [];
  },
  // VWAP mean-reversion: fade beyond k·σ of typical-price from session VWAP; cover back at VWAP / EOD.
  vwap: (bars, k = 2.0) => {
    let pv = 0, vol = 0, sse = 0, n = 0; const trades = []; let open = null;
    for (let i = 0; i < bars.length; i++) {
      const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
      pv += tp * Math.max(1, bars[i].v); vol += Math.max(1, bars[i].v); n++;
      const vwap = pv / vol; sse += (tp - vwap) ** 2; const sd = Math.sqrt(sse / n) || 1e-9;
      if (open == null && i > 20 && i < bars.length - 2) {
        if (bars[i].c > vwap + k * sd) open = { dir: -1, entryIdx: i, target: vwap };
        else if (bars[i].c < vwap - k * sd) open = { dir: 1, entryIdx: i, target: vwap };
      } else if (open) {
        const back = open.dir === 1 ? bars[i].c >= vwap : bars[i].c <= vwap;
        if (back) { open.exitIdx = i; trades.push(open); open = null; }
      }
    }
    if (open) trades.push(open);
    return trades;
  },
  // Intraday Donchian: break of the prior N-bar high/low, stop the opposite band, flat EOD.
  donchian: (bars, n = 30) => {
    for (let i = n; i < bars.length - 1; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - n; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
      if (bars[i].c > hi) return [{ dir: 1, entryIdx: i, stop: lo }];
      if (bars[i].c < lo) return [{ dir: -1, entryIdx: i, stop: hi }];
    }
    return [];
  },
  // Fast/slow EMA cross on minute closes; one position, flips on cross, flat EOD.
  ema: (bars, [f, s] = [9, 30]) => {
    const kf = 2 / (f + 1), ks = 2 / (s + 1); let ef = null, es = null, pos = 0; const trades = []; let open = null;
    for (let i = 0; i < bars.length - 1; i++) {
      ef = ema(ef, bars[i].c, kf); es = ema(es, bars[i].c, ks);
      if (i < s) continue;
      const want = ef > es ? 1 : -1;
      if (want !== pos) {
        if (open) { open.exitIdx = i; trades.push(open); }
        open = { dir: want, entryIdx: i }; pos = want;
      }
    }
    if (open) trades.push(open);
    return trades;
  },
  // Benchmark: long the first session bar, exit the last.
  'buy-hold': (bars) => bars.length > 2 ? [{ dir: 1, entryIdx: 0 }] : [],
};

/* ── day-streaming backtest engine ──────────────────────────────────────────── */
function newAcc() { return { pts: 0, trades: 0, wins: 0, gw: 0, gl: 0, dayRets: [], curve: [], peak: 0, maxDD: 0, profitableDays: 0, days: 0 }; }

/** Run one strategy over one day's session bars; return the day's net points (after costs) + trade stats. */
function runDay(bars, sym, stratFn) {
  const slip = SLIPPAGE_PTS[sym] || 0;
  const last = bars.length - 1;
  let dayPts = 0, nTrades = 0, wins = 0, gw = 0, gl = 0;
  for (const t of stratFn(bars)) {
    const entry = bars[t.entryIdx].c;
    // Exit precedence: explicit exitIdx → stop hit intrabar → forced session close.
    let exitIdx = t.exitIdx != null ? t.exitIdx : last, exit = bars[exitIdx].c, stopped = false;
    if (t.stop != null) {
      for (let i = t.entryIdx + 1; i <= (t.exitIdx != null ? t.exitIdx : last); i++) {
        const hitLong = t.dir === 1 && bars[i].l <= t.stop;
        const hitShort = t.dir === -1 && bars[i].h >= t.stop;
        if (hitLong || hitShort) { exit = t.stop; stopped = true; break; }
      }
    }
    void stopped;
    const grossPts = t.dir * (exit - entry) - slip * 2;                  // 2 fills (in + out)
    const netPts = grossPts - (COMMISSION_RT / (POINT_VALUE[sym] || 1)); // commission in points
    dayPts += netPts; nTrades++;
    if (netPts > 0) { wins++; gw += netPts; } else { gl += -netPts; }
  }
  return { dayPts, nTrades, wins, gw, gl };
}

function accrue(acc, day, r) {
  acc.pts += r.dayPts; acc.trades += r.nTrades; acc.wins += r.wins; acc.gw += r.gw; acc.gl += r.gl;
  acc.days++; if (r.dayPts > 0) acc.profitableDays++;
  acc.dayRets.push(r.dayPts);
  acc.peak = Math.max(acc.peak, acc.pts); acc.maxDD = Math.min(acc.maxDD, acc.pts - acc.peak);
  acc.curve.push({ day, eq: round(acc.pts * (acc._pv || 1)) });
}

function summarize(acc, sym) {
  const pv = POINT_VALUE[sym] || 1;
  const mean = acc.dayRets.reduce((a, b) => a + b, 0) / (acc.dayRets.length || 1);
  const sd = Math.sqrt(acc.dayRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (acc.dayRets.length || 1)) || 1e-9;
  const dn = acc.dayRets.filter((x) => x < 0); const dsd = Math.sqrt(dn.reduce((a, b) => a + b * b, 0) / (dn.length || 1)) || 1e-9;
  return {
    dollars: round(acc.pts * pv), points: round(acc.pts), trades: acc.trades,
    winPct: acc.trades ? round((acc.wins / acc.trades) * 100, 1) : 0,
    profitFactor: round(acc.gl ? acc.gw / acc.gl : 0),
    avgTradeUsd: acc.trades ? round((acc.pts / acc.trades) * pv) : 0,
    perDayUsd: acc.days ? round((acc.pts / acc.days) * pv) : 0,
    dayWinPct: acc.days ? round((acc.profitableDays / acc.days) * 100, 1) : 0,
    sharpe: round((mean / sd) * Math.sqrt(252)), sortino: round((mean / dsd) * Math.sqrt(252)),
    ddUsd: round(acc.maxDD * pv), curve: acc.curve,
  };
}

/** Stream the continuous CSV, group by day (session-filtered), run every strategy per day. */
async function backtestAll(sym, runs, years) {
  const file = CONT(sym);
  if (!fs.existsSync(file)) await buildContinuous(sym);
  const [s0, s1] = SESSION[sym] || [0, 1440];
  const cutoff = years ? Number(years) : 0;
  const accs = Object.fromEntries(Object.keys(runs).map((k) => [k, Object.assign(newAcc(), { _pv: POINT_VALUE[sym] })]));
  let cur = null, curDay = null, minDay = null, maxDay = null, totalDays = 0;
  // determine cutoff day (last day minus N years) in a first cheap scan of the tail? simpler: filter by year math on the fly using max day discovered — but we stream once. Use a pre-scan of last line for max day.
  const lastDay = await tailDay(file);
  const fromDay = cutoff ? String(Number(lastDay.slice(0, 4)) - cutoff) + lastDay.slice(4) : '00000000';

  const flush = () => {
    if (!cur || cur.length < 30) return;
    totalDays++;
    for (const [name, fn] of Object.entries(runs)) accrue(accs[name], curDay, runDay(cur, sym, fn));
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const ci = line.indexOf(','); const day = line.slice(0, ci);
    if (day < fromDay) continue;
    const rest = line.slice(ci + 1);
    const p = rest.split(','); const hm = +p[0];
    if (hm < s0 || hm > s1) continue; // session filter
    if (day !== curDay) { flush(); cur = []; curDay = day; }
    cur.push({ hm, o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5] });
    if (minDay == null) minDay = day; maxDay = day;
  }
  flush();
  return { results: Object.fromEntries(Object.entries(accs).map(([k, a]) => [k, summarize(a, sym)])), meta: { from: minDay, to: maxDay, days: totalDays } };
}

/** Cheap last-day read (max day = last data line's day). */
async function tailDay(file) {
  let last = '00000000';
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { const ci = line.indexOf(','); if (ci > 0) { const d = line.slice(0, ci); if (d > last && /^\d{8}$/.test(d)) last = d; } }
  rl.close();
  return last;
}

/* ── graphical report ───────────────────────────────────────────────────────── */
const isoDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
function sampleCurve(curve, max = 500) { const step = Math.max(1, Math.ceil(curve.length / max)); return curve.filter((_, i) => i % step === 0); }
function underwater(curve) { let pk = -Infinity; return curve.map((p) => { pk = Math.max(pk, p.eq); return { day: p.day, dd: round(p.eq - pk) }; }); }
function monthlyPnl(curve) {
  const last = new Map(); for (const p of curve) last.set(p.day.slice(0, 6), p.eq);
  const keys = [...last.keys()].sort(); const out = []; let prev = 0;
  for (const k of keys) { out.push({ m: `${k.slice(0, 4)}-${k.slice(4, 6)}`, pnl: round(last.get(k) - prev) }); prev = last.get(k); }
  return out;
}
function buildReportHtml(sym, meta, results) {
  const COLORS = ['#36d39a', '#5fa8ff', '#ffcf6b', '#c08cff', '#8ea0c4'];
  const names = Object.keys(results);
  const best = names.filter((n) => n !== 'buy-hold').sort((a, b) => results[b].dollars - results[a].dollars)[0] || names[0];
  const ref = results[best].curve.length ? results[best] : results[names[0]];
  const labels = sampleCurve(ref.curve).map((p) => isoDay(p.day));
  const equityDs = names.map((n, i) => ({ label: n, data: sampleCurve(results[n].curve).map((p) => p.eq), borderColor: COLORS[i % COLORS.length], borderWidth: 1.5, pointRadius: 0, tension: 0.1 }));
  const uw = sampleCurve(underwater(ref.curve));
  const mp = monthlyPnl(ref.curve);
  const COLS = [['dollars', '$ P&L'], ['perDayUsd', '$/day'], ['avgTradeUsd', '$/trade'], ['trades', 'Trades'], ['winPct', 'Win %'], ['dayWinPct', 'Day win %'], ['profitFactor', 'Profit factor'], ['sharpe', 'Sharpe'], ['sortino', 'Sortino'], ['ddUsd', 'Max DD $']];
  const fmt = (k, v) => (k.endsWith('Usd') || k === 'dollars') ? '$' + Number(v).toLocaleString() : String(v);
  const rows = names.map((n, i) => `<tr><td style="color:${COLORS[i % COLORS.length]}">${n}</td>${COLS.map(([k]) => `<td class="num">${fmt(k, results[n][k])}</td>`).join('')}</tr>`).join('');
  const DATA = JSON.stringify({ labels, equityDs, uw: uw.map((p) => ({ d: isoDay(p.day).slice(0, 7), dd: p.dd })), mp });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${sym} Intraday Report</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>:root{--bg:#0b1020;--panel:#121a30;--line:#27324f;--text:#e7ecf7;--muted:#8ea0c4;--accent:#5fa8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,sans-serif}
.page{max-width:1080px;margin:0 auto;padding:28px 22px 80px}h1{font-size:24px;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin-bottom:22px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}h2{font-size:15px;margin:0 0 12px;color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:7px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line)}td.num{text-align:right;font-variant-numeric:tabular-nums}canvas{max-height:320px}.foot{color:var(--muted);font-size:11px;margin-top:10px}</style></head>
<body><div class="page"><h1>${sym} — Intraday (day-trade) Report</h1>
<div class="sub">${meta.subtitle || `${meta.days.toLocaleString()} sessions · ${isoDay(meta.from)} → ${isoDay(meta.to)} · front-month continuous · $${POINT_VALUE[sym]}/pt · ${SLIPPAGE_PTS[sym]}pt slip + $${COMMISSION_RT} RT/fill · flat by close · 1 contract`}</div>
<div class="panel"><h2>Performance summary</h2><table><thead><tr><th>Strategy</th>${COLS.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
<div class="panel"><h2>Equity curves (cumulative $)</h2><canvas id="eq"></canvas></div>
<div class="panel"><h2>Drawdown — underwater ($), best: ${best}</h2><canvas id="dd"></canvas></div>
<div class="panel"><h2>Monthly P&amp;L ($), ${best}</h2><canvas id="mp"></canvas></div>
<div class="foot">Research-grade: signal-bar close fills, 1 contract, no compounding/sizing, intraday-only (flat by close). Not investment advice.</div></div>
<script>const D=${DATA};const grid={color:'#1c2742'},tick={color:'#8ea0c4',font:{size:10}};
new Chart(eq,{type:'line',data:{labels:D.labels,datasets:D.equityDs},options:{plugins:{legend:{labels:{color:'#e7ecf7'}}},scales:{x:{ticks:{...tick,maxTicksLimit:10},grid},y:{ticks:tick,grid}}}});
new Chart(dd,{type:'line',data:{labels:D.uw.map(p=>p.d),datasets:[{data:D.uw.map(p=>p.dd),borderColor:'#ff7b7b',backgroundColor:'rgba(255,123,123,.15)',fill:true,borderWidth:1,pointRadius:0}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{...tick,maxTicksLimit:10},grid},y:{ticks:tick,grid}}}});
new Chart(mp,{type:'bar',data:{labels:D.mp.map(p=>p.m),datasets:[{data:D.mp.map(p=>p.pnl),backgroundColor:D.mp.map(p=>p.pnl<0?'#ff7b7b':'#36d39a')}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{...tick,maxTicksLimit:14},grid},y:{ticks:tick,grid}}}});
</script></body></html>`;
}

/* ── intraday momentum ROTATION — "send the money where the momentum is" ─────────
 *  Capital-fraction (return-based) model, NOT contracts, so it rotates coherently across ANY mix of
 *  instruments (ES vs CL today; add equity minute CSVs and it scales to a stock basket unchanged).
 *  Every R minutes it ranks each symbol by trailing-L-minute momentum and concentrates the book into
 *  the top-K with POSITIVE momentum (K=1 = all-in the single strongest = max upside / max concentration).
 *  A name merely doing "ok" loses its capital to a name running harder — relative strength, intraday.
 *  Flat by close. Switch legs pay a per-turn cost (bps). Benchmarks: equal-weight-always-in + per-symbol
 *  intraday buy-hold, so you can see whether concentrating into momentum actually beats spreading out. */

/** Async day-at-a-time reader over a sorted (day,hm,...) continuous CSV, with one-line lookahead so
 *  several symbols can be advanced in lockstep to a common day (k-way day merge). */
class DayReader {
  constructor(file) { this.it = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })[Symbol.asyncIterator](); this.pending = null; this.started = false; this.done = false; }
  async _raw() { const n = await this.it.next(); if (n.done) { this.done = true; return null; } return n.value; }
  /** Next full day → { day, bars:[{hm,o,h,l,c,v}] } or null at EOF. Bars are session-unfiltered here. */
  async nextDay() {
    if (this.done && !this.pending) return null;
    if (!this.started) { this.started = true; let l = await this._raw(); if (l && l.startsWith('day,')) l = await this._raw(); this.pending = l; }
    if (!this.pending) return null;
    const parse = (line) => { const c = line.split(','); return { day: c[0], hm: +c[1], o: +c[2], h: +c[3], l: +c[4], c: +c[5], v: +c[6] }; };
    let row = parse(this.pending); const day = row.day; const bars = [row];
    for (;;) { const l = await this._raw(); if (!l) { this.pending = null; break; } const r = parse(l); if (r.day !== day) { this.pending = l; break; } bars.push(r); }
    return { day, bars };
  }
}

/** Forward-filled close at/just-before a grid time from a day's session bars (sorted by hm). */
function closeAt(bars, hm) { let px = bars[0].c; for (const b of bars) { if (b.hm > hm) break; px = b.c; } return px; }

/** Run ONE rotation variant over the aligned per-day price grids. opts: {lookback,rebalMin,topK,costBps}.
 *  allowedSlice (optional): per-day-index Set of the symbols eligible that day (the daily-strength SCREEN
 *  in the two-stage design). null/undefined = whole universe eligible. Aligned 1:1 with daySymBars. */
function rotateVariant(daySymBars, sym0, syms, opts, allowedSlice) {
  const { lookback, rebalMin, topK, costBps } = opts;
  const [s0, s1] = sess(sym0);
  const cost = costBps / 10000;
  const acc = Object.assign(newAcc(), { _pv: 1 });
  const CAP = 100000;
  let gw = 0, gl = 0, wins = 0, episodes = 0, switches = 0;
  for (let di = 0; di < daySymBars.length; di++) {
    const { day, perSym } = daySymBars[di];
    const allow = allowedSlice ? allowedSlice[di] : null; // today's screened-in universe (null = all)
    let prevW = Object.fromEntries(syms.map((s) => [s, 0])); // intraday → start flat
    let prevPx = Object.fromEntries(syms.map((s) => [s, closeAt(perSym[s], s0)]));
    const entryPx = {}; // open episode entry price per held symbol
    let dayPnl = 0;
    for (let g = s0 + lookback; g <= s1; g += rebalMin) {
      const last = g + rebalMin > s1;
      // momentum at g: trailing-L return per symbol.
      const mom = {}; const pxNow = {};
      for (const s of syms) { const now = closeAt(perSym[s], g); const then = closeAt(perSym[s], g - lookback); pxNow[s] = now; mom[s] = then > 0 ? now / then - 1 : 0; }
      // realize P&L of the interval just ended under the OUTGOING weights.
      for (const s of syms) if (prevW[s] !== 0) dayPnl += prevW[s] * CAP * (prevPx[s] > 0 ? (pxNow[s] - prevPx[s]) / prevPx[s] : 0);
      // target weights: top-K positive-momentum names, equal weight; flatten at the last bar.
      let target = Object.fromEntries(syms.map((s) => [s, 0]));
      if (!last) {
        if (opts.forceAll) { const w = 1 / syms.length; for (const s of syms) target[s] = w; } // equal-weight benchmark (no rotation)
        else {
          // Hysteresis (anti-whipsaw, mirrors the live bot's ROTATION_MARGIN): keep held names that
          // still have positive momentum, fill empty slots with the hottest bench, and only SWAP a
          // held name for a challenger when the challenger's momentum beats it by `switchMargin`.
          const margin = opts.switchMargin || 0;
          const held = syms.filter((s) => prevW[s] > 0);
          const ranked = syms.filter((s) => mom[s] > 0 && (!allow || allow.has(s))).sort((a, b) => mom[b] - mom[a]);
          let keep = held.filter((s) => mom[s] > 0);                 // drop a held name that went non-positive
          let bench = ranked.filter((s) => !keep.includes(s));
          while (keep.length < topK && bench.length) keep.push(bench.shift()); // fill open slots
          keep.sort((a, b) => mom[a] - mom[b]);                      // weakest kept first
          while (bench.length && keep.length >= topK) {              // margin-gated swaps
            if (mom[bench[0]] > mom[keep[0]] + margin) { keep.shift(); keep.push(bench.shift()); keep.sort((a, b) => mom[a] - mom[b]); }
            else break;
          }
          keep = keep.slice(0, topK);
          const w = keep.length ? 1 / keep.length : 0;
          for (const s of keep) target[s] = w;
        }
      }
      // costs + episode bookkeeping on weight changes.
      for (const s of syms) {
        if (target[s] !== prevW[s]) {
          dayPnl -= cost * CAP * Math.abs(target[s] - prevW[s]); switches++;
          if (prevW[s] === 0 && target[s] > 0) { entryPx[s] = pxNow[s]; }
          if (prevW[s] > 0 && target[s] === 0 && entryPx[s] != null) {
            const r = (pxNow[s] - entryPx[s]) / entryPx[s]; episodes++; if (r > 0) { wins++; gw += r; } else { gl += -r; } delete entryPx[s];
          }
        }
      }
      prevW = target; prevPx = pxNow;
    }
    const dayRet = dayPnl / CAP;
    acc.pts += dayRet; acc.days++; if (dayPnl > 0) acc.profitableDays++; acc.dayRets.push(dayRet);
    acc.peak = Math.max(acc.peak, acc.pts); acc.maxDD = Math.min(acc.maxDD, acc.pts - acc.peak);
    acc.curve.push({ day, eq: round(acc.pts * CAP) });
  }
  // summarize in $ terms on the $100k notional (compatible with buildReportHtml's columns).
  const mean = acc.dayRets.reduce((a, b) => a + b, 0) / (acc.dayRets.length || 1);
  const sd = Math.sqrt(acc.dayRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (acc.dayRets.length || 1)) || 1e-9;
  const dn = acc.dayRets.filter((x) => x < 0); const dsd = Math.sqrt(dn.reduce((a, b) => a + b * b, 0) / (dn.length || 1)) || 1e-9;
  return {
    dollars: round(acc.pts * CAP), points: round(acc.pts * 100, 2), trades: switches,
    winPct: episodes ? round((wins / episodes) * 100, 1) : 0, profitFactor: round(gl ? gw / gl : 0),
    avgTradeUsd: episodes ? round((acc.pts * CAP) / episodes) : 0, perDayUsd: acc.days ? round((acc.pts * CAP) / acc.days) : 0,
    dayWinPct: acc.days ? round((acc.profitableDays / acc.days) * 100, 1) : 0,
    sharpe: round((mean / sd) * Math.sqrt(252)), sortino: round((mean / dsd) * Math.sqrt(252)),
    ddUsd: round(acc.maxDD * CAP), curve: acc.curve,
  };
}

/** k-way day-merge the symbols' continuous CSVs to the common (intersection) trading days, session-
 *  filtered. Returns the aligned per-day price grids (held in memory once; reused by all variants/folds). */
async function loadAligned(syms, years) {
  for (const s of syms) if (!fs.existsSync(CONT(s))) await buildContinuous(s);
  const sym0 = syms[0]; const [s0, s1] = sess(sym0);
  const lastDay = await tailDay(CONT(sym0));
  const fromDay = years ? String(Number(lastDay.slice(0, 4)) - Number(years)) + lastDay.slice(4) : '00000000';
  const readers = syms.map((s) => new DayReader(CONT(s)));
  let curs = await Promise.all(readers.map((r) => r.nextDay()));
  const aligned = []; let from = null, to = null;
  const sessionFilter = (bars) => bars.filter((b) => b.hm >= s0 && b.hm <= s1);
  while (curs.every(Boolean)) {
    const days = curs.map((c) => c.day); const maxDay = days.reduce((a, b) => (a > b ? a : b));
    if (days.every((d) => d === maxDay)) {
      if (maxDay >= fromDay) {
        const perSym = {}; let ok = true;
        for (let i = 0; i < syms.length; i++) { const sb = sessionFilter(curs[i].bars); if (sb.length < 30) { ok = false; break; } perSym[syms[i]] = sb; }
        if (ok) { aligned.push({ day: maxDay, perSym }); from = from || maxDay; to = maxDay; }
      }
      curs = await Promise.all(readers.map((r) => r.nextDay()));
    } else {
      for (let i = 0; i < syms.length; i++) if (curs[i].day < maxDay) curs[i] = await readers[i].nextDay();
    }
  }
  return { aligned, sym0, meta: { from, to, days: aligned.length } };
}

/** Run the three reference variants over the full aligned set. */
async function rotateAll(syms, years, opts) {
  const { aligned, sym0, meta } = await loadAligned(syms, years);
  const variants = {
    'concentrate-K1': rotateVariant(aligned, sym0, syms, { ...opts, topK: 1 }),
    'rotate-top2': rotateVariant(aligned, sym0, syms, { ...opts, topK: 2 }),
    'equal-weight': rotateVariant(aligned, sym0, syms, { ...opts, forceAll: true }), // always in all → no rotation (diversify benchmark)
  };
  return { results: variants, meta };
}

/* ── walk-forward: choose the config on the past, score the held-out next slice (anti-overfit) ──
 *  The honest test. A grid of (lookback × rebal × topK × margin) is scored IN-SAMPLE on the expanding
 *  past; the best-by-IN-SAMPLE-Sharpe config trades the next OOS slice. The selection never sees the
 *  OOS data, so OOS aggregate is what we'd actually have earned choosing params as we went. */
const WF_GRID = (() => {
  const g = [];
  for (const lookback of [60, 120, 240]) for (const rebalMin of [30, 60]) for (const topK of [1, 2, 3]) for (const switchMargin of [0.003, 0.005]) g.push({ lookback, rebalMin, topK, switchMargin });
  return g;
})();

function rotateWalkForward(aligned, sym0, syms, costBps, folds) {
  const seg = Math.floor(aligned.length / (folds + 1)); const rows = []; let oos$ = 0; const oosCurve = [];
  for (let k = 1; k <= folds; k++) {
    const trainEnd = seg * k; const testEnd = Math.min(seg * (k + 1), aligned.length);
    const train = aligned.slice(0, trainEnd); const test = aligned.slice(trainEnd, testEnd);
    if (!test.length) break;
    let best = null;
    for (const cfg of WF_GRID) {
      const m = rotateVariant(train, sym0, syms, { ...cfg, costBps });
      if (!best || m.sharpe > best.m.sharpe) best = { cfg, m };          // select by IN-SAMPLE Sharpe (robust)
    }
    const oos = rotateVariant(test, sym0, syms, { ...best.cfg, costBps });
    const eb = rotateVariant(test, sym0, syms, { ...best.cfg, costBps, forceAll: true }); // OOS equal-weight benchmark
    oos$ += oos.dollars;
    const base = oosCurve.length ? oosCurve[oosCurve.length - 1].eq : 0;
    for (const p of oos.curve) oosCurve.push({ day: p.day, eq: round(base + p.eq) });
    rows.push({ fold: k, picked: `L${best.cfg.lookback}/R${best.cfg.rebalMin}/K${best.cfg.topK}/m${best.cfg.switchMargin}`, isSharpe: best.m.sharpe, oos$: oos.dollars, oosSharpe: oos.sharpe, oosPF: oos.profitFactor, ewOos$: eb.dollars });
  }
  return { rows, oosTotalUsd: round(oos$), oosCurve };
}

/* ── two-stage: DAILY-strength SCREEN the universe, then rotate intraday WITHIN it ──
 *  The honest version of "go where it's hot": each day, rank names by a CAUSAL daily-momentum signal
 *  (prior closes only — no lookahead), keep the top-M, and let the intraday rotation pick only among
 *  those. The screen is part of the model, so the walk-forward grid tunes it too and the OOS number
 *  includes it — no selection bias smuggled in (the failure mode the neutral-universe test exposed). */

/** Daily close per symbol per aligned day (last session bar). */
function buildDailyCloses(aligned, syms) {
  return aligned.map((d) => Object.fromEntries(syms.map((s) => [s, d.perSym[s][d.perSym[s].length - 1].c])));
}

/** Per-day eligible set: top-M by trailing screenL-day daily return, using ONLY closes before day i. */
function computeAllowed(dc, syms, screenL, topM) {
  const allowed = [];
  for (let i = 0; i < dc.length; i++) {
    if (i <= screenL) { allowed.push(new Set(syms)); continue; }            // warmup → whole universe
    const ref = i - 1;                                                       // last completed day
    const scored = syms.map((s) => { const a = dc[ref][s], b = dc[ref - screenL][s]; return { s, r: b > 0 ? a / b - 1 : -Infinity }; })
      .filter((x) => isFinite(x.r)).sort((x, y) => y.r - x.r).slice(0, topM).map((x) => x.s);
    allowed.push(new Set(scored.length ? scored : syms));
  }
  return allowed;
}

const WF2_GRID = (() => {
  const g = [];
  for (const screenL of [3, 5, 10]) for (const topM of [5, 8, 12]) for (const lookback of [120, 240]) for (const rebalMin of [30, 60]) for (const topK of [1, 2, 3]) g.push({ screenL, topM, lookback, rebalMin, topK, switchMargin: 0.005 });
  return g;
})();

/** Two-stage walk-forward: grid (screen + intraday) chosen on the past by in-sample Sharpe, scored OOS.
 *  allowed sets are computed on the FULL series (causal per day) then sliced to match train/test. */
function rotateWalkForward2(aligned, sym0, syms, costBps, folds) {
  const dc = buildDailyCloses(aligned, syms);
  const allowedCache = new Map(); // `${screenL}:${topM}` → full allowed array
  const allowedFor = (cfg) => { const k = `${cfg.screenL}:${cfg.topM}`; if (!allowedCache.has(k)) allowedCache.set(k, computeAllowed(dc, syms, cfg.screenL, cfg.topM)); return allowedCache.get(k); };
  const seg = Math.floor(aligned.length / (folds + 1)); const rows = []; let oos$ = 0;
  for (let k = 1; k <= folds; k++) {
    const trainEnd = seg * k; const testEnd = Math.min(seg * (k + 1), aligned.length);
    const train = aligned.slice(0, trainEnd); const test = aligned.slice(trainEnd, testEnd);
    if (!test.length) break;
    let best = null;
    for (const cfg of WF2_GRID) {
      const m = rotateVariant(train, sym0, syms, { ...cfg, costBps }, allowedFor(cfg).slice(0, trainEnd));
      if (!best || m.sharpe > best.m.sharpe) best = { cfg, m };
    }
    const aT = allowedFor(best.cfg).slice(trainEnd, testEnd);
    const oos = rotateVariant(test, sym0, syms, { ...best.cfg, costBps }, aT);
    const eb = rotateVariant(test, sym0, syms, { ...best.cfg, costBps, forceAll: true }); // OOS equal-weight (whole universe)
    oos$ += oos.dollars;
    rows.push({ fold: k, picked: `S${best.cfg.screenL}/M${best.cfg.topM}/L${best.cfg.lookback}/R${best.cfg.rebalMin}/K${best.cfg.topK}`, isSharpe: best.m.sharpe, oos$: oos.dollars, oosSharpe: oos.sharpe, oosPF: oos.profitFactor, ewOos$: eb.dollars });
  }
  return { rows, oosTotalUsd: round(oos$) };
}

/* ── TREND-ALIGNED DIP-BUY — the sound iteration ────────────────────────────────
 *  The operator's idea done so costs can't eat it: only go LONG on a day whose DAILY trend is up (causal SMA
 *  of prior closes), buy a REAL intraday pullback (price down dipMult·ATR from the session high — not a
 *  1-tick wiggle), and exit at a target sized in ATR (targetMult·ATR ≫ cost) or a stop, flat by close.
 *  Few trades/day, targets far bigger than the friction — the opposite of the overtrading that got beat
 *  up. Single instrument, 1 contract, costs ON. Benchmark = just being long all day on the same up days
 *  (isolates whether the dip-TIMING adds value over naive "long on up days"). */

/** Load the continuous series into memory once: per-day session bars + per-day daily O?/H/L/C. */
async function loadDays(sym, years) {
  if (!fs.existsSync(CONT(sym))) await buildContinuous(sym);
  const [s0, s1] = sess(sym);
  const lastDay = await tailDay(CONT(sym));
  const fromDay = years ? String(Number(lastDay.slice(0, 4)) - Number(years)) + lastDay.slice(4) : '00000000';
  const days = []; const daily = []; let cur = null, curDay = null;
  const flush = () => { if (cur && cur.length >= 30) { days.push({ day: curDay, bars: cur }); let h = -Infinity, l = Infinity; for (const b of cur) { h = Math.max(h, b.h); l = Math.min(l, b.l); } daily.push({ c: cur[cur.length - 1].c, h, l }); } };
  const rl = readline.createInterface({ input: fs.createReadStream(CONT(sym)), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const ci = line.indexOf(','); const day = line.slice(0, ci); if (day < fromDay) continue;
    const p = line.slice(ci + 1).split(','); const hm = +p[0]; if (hm < s0 || hm > s1) continue;
    if (day !== curDay) { flush(); cur = []; curDay = day; }
    cur.push({ hm, o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5] });
  }
  flush();
  return { days, daily };
}

/** Daily ATR(n) in points; atr[i] uses days ≤ i (so trading day j reads atr[j-1] — causal). */
function dailyATR(daily, n = 14) {
  const tr = [], atr = [];
  for (let i = 0; i < daily.length; i++) {
    tr.push(i === 0 ? daily[0].h - daily[0].l : Math.max(daily[i].h - daily[i].l, Math.abs(daily[i].h - daily[i - 1].c), Math.abs(daily[i].l - daily[i - 1].c)));
    if (i + 1 >= n) { let s = 0; for (let k = i - n + 1; k <= i; k++) s += tr[k]; atr.push(s / n); } else atr.push(null);
  }
  return atr;
}
/** trendUp[i] = was the daily close BEFORE day i above its ma-day SMA (causal uptrend gate). */
function trendUp(daily, ma) {
  const up = [];
  for (let i = 0; i < daily.length; i++) {
    if (i < ma) { up.push(false); continue; }
    let s = 0; for (let k = i - ma; k < i; k++) s += daily[k].c; up.push(daily[i - 1].c > s / ma);
  }
  return up;
}

/** Simulate ONE trend-up day's dip-buys. p:{dipMult,targetMult,stopMult,maxTrades}. Costs ON. */
function trendDipDay(bars, sym, atr, p) {
  const slip = SLIPPAGE_PTS[sym] || 0, commPts = COMMISSION_RT / (POINT_VALUE[sym] || 1);
  let dayPts = 0, n = 0, wins = 0, gw = 0, gl = 0, sessionHigh = -Infinity, pos = null, trades = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]; sessionHigh = Math.max(sessionHigh, b.h);
    if (pos) {
      let exit = null;
      if (b.l <= pos.stop) exit = pos.stop;            // stop first (conservative when both hit in a bar)
      else if (b.h >= pos.target) exit = pos.target;
      if (exit != null || i === bars.length - 1) {
        const px = exit != null ? exit : b.c;
        const net = (px - pos.entry) - slip * 2 - commPts;
        dayPts += net; n++; if (net > 0) { wins++; gw += net; } else { gl += -net; }
        pos = null;
      }
      continue;
    }
    if (trades >= p.maxTrades || i >= bars.length - 5) continue;          // leave time to exit before close
    if (atr > 0 && b.c <= sessionHigh - p.dipMult * atr) {                // a real pullback from the highs
      pos = { entry: b.c, target: b.c + p.targetMult * atr, stop: b.c - p.stopMult * atr }; trades++;
    }
  }
  return { dayPts, n, wins, gw, gl };
}
/** Long the whole up-day (open→close) — the "just be long on up days" benchmark. */
function trendHoldDay(bars, sym) {
  const slip = SLIPPAGE_PTS[sym] || 0, commPts = COMMISSION_RT / (POINT_VALUE[sym] || 1);
  const net = (bars[bars.length - 1].c - bars[0].c) - slip * 2 - commPts;
  return { dayPts: net, n: 1, wins: net > 0 ? 1 : 0, gw: net > 0 ? net : 0, gl: net > 0 ? 0 : -net };
}

/** Run a trend strategy over day indices [a,b). dayFn(bars,sym,atr)→{dayPts,...} on trend-up days only. */
function runTrend(days, daily, sym, atr, up, a, b, dayFn) {
  const acc = Object.assign(newAcc(), { _pv: POINT_VALUE[sym] }); const pv = POINT_VALUE[sym] || 1;
  let gw = 0, gl = 0, wins = 0, trades = 0;
  for (let i = a; i < b; i++) {
    const r = (up[i] && atr[i - 1] > 0) ? dayFn(days[i].bars, sym, atr[i - 1]) : { dayPts: 0, n: 0, wins: 0, gw: 0, gl: 0 };
    acc.pts += r.dayPts; acc.days++; if (r.dayPts > 0) acc.profitableDays++; acc.dayRets.push(r.dayPts);
    acc.peak = Math.max(acc.peak, acc.pts); acc.maxDD = Math.min(acc.maxDD, acc.pts - acc.peak);
    acc.curve.push({ day: days[i].day, eq: round(acc.pts * pv) });
    trades += r.n; wins += r.wins; gw += r.gw; gl += r.gl;
  }
  const mean = acc.dayRets.reduce((s, x) => s + x, 0) / (acc.dayRets.length || 1);
  const sd = Math.sqrt(acc.dayRets.reduce((s, x) => s + (x - mean) ** 2, 0) / (acc.dayRets.length || 1)) || 1e-9;
  return {
    dollars: round(acc.pts * pv), trades, winPct: trades ? round((wins / trades) * 100, 1) : 0,
    profitFactor: round(gl ? gw / gl : 0), perDayUsd: acc.days ? round((acc.pts * pv) / acc.days) : 0,
    avgTradeUsd: trades ? round((acc.pts * pv) / trades) : 0, dayWinPct: acc.days ? round((acc.profitableDays / acc.days) * 100, 1) : 0,
    sharpe: round((mean / sd) * Math.sqrt(252)), ddUsd: round(acc.maxDD * pv), curve: acc.curve,
  };
}

const TREND_GRID = (() => { const g = []; for (const trendMA of [20, 50, 100]) for (const dipMult of [0.5, 1.0, 1.5]) for (const targetMult of [1.0, 2.0]) for (const stopMult of [1.0]) g.push({ trendMA, dipMult, targetMult, stopMult, maxTrades: 2 }); return g; })();

/** Walk-forward the trend-dip: pick config on the past by in-sample Sharpe, score OOS, vs the
 *  "long on up days" benchmark (run with the SAME chosen trendMA so the comparison is apples-to-apples). */
function trendWalkForward(days, daily, sym, atr, folds) {
  const upCache = new Map(); const upFor = (ma) => { if (!upCache.has(ma)) upCache.set(ma, trendUp(daily, ma)); return upCache.get(ma); };
  const seg = Math.floor(days.length / (folds + 1)); const rows = []; let oos$ = 0, bench$ = 0;
  for (let k = 1; k <= folds; k++) {
    const trainEnd = seg * k, testEnd = Math.min(seg * (k + 1), days.length); if (testEnd <= trainEnd) break;
    let best = null;
    for (const p of TREND_GRID) { const m = runTrend(days, daily, sym, atr, upFor(p.trendMA), 0, trainEnd, (b, s, a2) => trendDipDay(b, s, a2, p)); if (!best || m.sharpe > best.m.sharpe) best = { p, m }; }
    const oos = runTrend(days, daily, sym, atr, upFor(best.p.trendMA), trainEnd, testEnd, (b, s, a2) => trendDipDay(b, s, a2, best.p));
    const bench = runTrend(days, daily, sym, atr, upFor(best.p.trendMA), trainEnd, testEnd, (b, s) => trendHoldDay(b, s));
    oos$ += oos.dollars; bench$ += bench.dollars;
    rows.push({ fold: k, picked: `MA${best.p.trendMA}/dip${best.p.dipMult}/tgt${best.p.targetMult}`, isSharpe: best.m.sharpe, oos$: oos.dollars, oosSharpe: oos.sharpe, oosPF: oos.profitFactor, oosTrades: oos.trades, bench$: bench.dollars });
  }
  return { rows, oosTotalUsd: round(oos$), benchTotalUsd: round(bench$) };
}

/* ── CLI ────────────────────────────────────────────────────────────────────── */
const RUNS = {
  'buy-hold': (b) => STRATS['buy-hold'](b),
  'orb-15': (b) => STRATS.orb(b, 15),
  'orb-30': (b) => STRATS.orb(b, 30),
  'vwap-rev': (b) => STRATS.vwap(b, 2.0),
  'donchian-30': (b) => STRATS.donchian(b, 30),
  'ema-9/30': (b) => STRATS.ema(b, [9, 30]),
};

(async function main() {
  const [cmd = 'compare', symA = 'ES', years] = process.argv.slice(2);
  const sym = symA.toUpperCase();
  if (!['rotate', 'wf', 'wf2'].includes(cmd) && !POINT_VALUE[sym]) { console.error(`Unknown symbol ${sym} (ES|CL).`); process.exit(1); }
  if (cmd === 'build') { await buildContinuous(sym); return; }
  if (cmd === 'trend') {
    // node oshal-intraday.js trend <ES|CL> [years] [folds] — trend-aligned dip-buy, walk-forward
    const yrs = years && /^\d+$/.test(years) ? years : undefined;
    const folds = Number(process.argv[5]) || 5;
    const { days, daily } = await loadDays(sym, yrs);
    if (days.length < 200) { console.error(`Too few days (${days.length}).`); process.exit(1); }
    const atr = dailyATR(daily, 14);
    const wf = trendWalkForward(days, daily, sym, atr, folds);
    console.log(`\nTREND-ALIGNED DIP-BUY walk-forward ${sym}: ${days.length.toLocaleString()} sessions ${isoDay(days[0].day)} → ${isoDay(days[days.length - 1].day)}, ${folds} folds | grid ${TREND_GRID.length} configs, select by IN-SAMPLE Sharpe | $${POINT_VALUE[sym]}/pt, ${SLIPPAGE_PTS[sym]}pt slip + $${COMMISSION_RT} RT\n`);
    console.log(`${pad('fold', 5)}${pad('picked (in-sample)', 24)}${padL('IS Shp', 8)}${padL('OOS $', 12)}${padL('OOS Shp', 9)}${padL('OOS PF', 8)}${padL('trades', 8)}${padL('BENCH $', 12)}`);
    console.log('-'.repeat(86));
    for (const r of wf.rows) console.log(`${pad(r.fold, 5)}${pad(r.picked, 24)}${padL(r.isSharpe, 8)}${padL(r.oos$.toLocaleString(), 12)}${padL(r.oosSharpe, 9)}${padL(r.oosPF, 8)}${padL(r.oosTrades.toLocaleString(), 8)}${padL(r.bench$.toLocaleString(), 12)}`);
    console.log('-'.repeat(86));
    console.log(`${pad('TOTAL OOS', 37)}${padL('$' + wf.oosTotalUsd.toLocaleString(), 23)}${padL('bench(long-up-days) $' + wf.benchTotalUsd.toLocaleString(), 0)}`);
    console.log(`\nDip-TIMING adds value only if OOS > BENCH (just being long all day on the same up-days). Both > 0 = the trend gate works; OOS > bench = the dip entry earns its costs.\n`);
    return;
  }
  if (cmd === 'rotate') {
    // node oshal-intraday.js rotate ES,CL [years] [lookbackMin] [rebalMin]
    const syms = symA.toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (syms.length < 2) { console.error('rotate needs ≥2 symbols, e.g. rotate ES,CL'); process.exit(1); }
    // Unknown tickers are fine for rotation (return-based, equity-RTH session) — they just need a
    // data/_extracted/<sym>-minute-cont.csv (pull equities with scripts/oshal-equity-bars.js).
    for (const s of syms) if (!fs.existsSync(CONT(s))) { console.error(`No data for ${s} — build/pull ${CONT(s)} first.`); process.exit(1); }
    const lookback = Number(process.argv[5]) || 30, rebalMin = Number(process.argv[6]) || 5, costBps = 1.0;
    const switchMargin = process.argv[7] != null ? Number(process.argv[7]) : 0.0015; // momentum edge a challenger needs to steal a slot
    const opts = { lookback, rebalMin, costBps, switchMargin };
    const yrs = years && /^\d+$/.test(years) ? years : undefined; // numeric = cutoff; "all"/blank = full history
    const { results, meta } = await rotateAll(syms, yrs, opts);
    console.log(`\nintraday momentum ROTATION ${syms.join('+')}: ${meta.days.toLocaleString()} common sessions, ${isoDay(meta.from)} → ${isoDay(meta.to)} | $100k notional, L=${lookback}m, rebal=${rebalMin}m, ${costBps}bp/turn, margin=${switchMargin}\n`);
    console.log(`${pad('variant', 16)}${padL('$P&L', 13)}${padL('$/day', 9)}${padL('switches', 10)}${padL('win%', 7)}${padL('dayW%', 7)}${padL('PF', 6)}${padL('Sharpe', 8)}${padL('maxDD$', 12)}`);
    console.log('-'.repeat(88));
    for (const [name, m] of Object.entries(results)) {
      console.log(`${pad(name, 16)}${padL(m.dollars.toLocaleString(), 13)}${padL(m.perDayUsd.toLocaleString(), 9)}${padL(m.trades.toLocaleString(), 10)}${padL(m.winPct, 7)}${padL(m.dayWinPct, 7)}${padL(m.profitFactor, 6)}${padL(m.sharpe, 8)}${padL(m.ddUsd.toLocaleString(), 12)}`);
    }
    console.log('');
    const out = path.join('data', '_extracted', `rotate-${syms.join('-').toLowerCase()}-report.html`);
    meta.subtitle = `${meta.days.toLocaleString()} common sessions · ${isoDay(meta.from)} → ${isoDay(meta.to)} · momentum rotation · $100k notional · L=${lookback}m · rebal=${rebalMin}m · ${costBps}bp/turn · flat by close`;
    fs.writeFileSync(out, buildReportHtml(syms.join('+'), meta, results));
    console.log(`report → ${out}`);
    return;
  }
  if (cmd === 'wf') {
    // node oshal-intraday.js wf SYM1,SYM2,... [years] [folds] — walk-forward (params chosen on the past)
    const syms = symA.toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (syms.length < 2) { console.error('wf needs ≥2 symbols'); process.exit(1); }
    for (const s of syms) if (!fs.existsSync(CONT(s))) { console.error(`No data for ${s} — pull ${CONT(s)} first.`); process.exit(1); }
    const yrs = years && /^\d+$/.test(years) ? years : undefined;
    const folds = Number(process.argv[5]) || 5;
    const { aligned, sym0, meta } = await loadAligned(syms, yrs);
    const wf = rotateWalkForward(aligned, sym0, syms, 1.0, folds);
    console.log(`\nWALK-FORWARD rotation ${syms.length} names: ${meta.days.toLocaleString()} sessions ${isoDay(meta.from)} → ${isoDay(meta.to)}, ${folds} folds | grid ${WF_GRID.length} configs, select by IN-SAMPLE Sharpe\n`);
    console.log(`${pad('fold', 5)}${pad('picked (in-sample)', 26)}${padL('IS Shp', 8)}${padL('OOS $', 12)}${padL('OOS Shp', 9)}${padL('OOS PF', 8)}${padL('EW OOS $', 12)}`);
    console.log('-'.repeat(80));
    let ew = 0;
    for (const r of wf.rows) { ew += r.ewOos$; console.log(`${pad(r.fold, 5)}${pad(r.picked, 26)}${padL(r.isSharpe, 8)}${padL(r.oos$.toLocaleString(), 12)}${padL(r.oosSharpe, 9)}${padL(r.oosPF, 8)}${padL(r.ewOos$.toLocaleString(), 12)}`); }
    console.log('-'.repeat(80));
    console.log(`${pad('TOTAL OOS', 39)}${padL('$' + wf.oosTotalUsd.toLocaleString(), 21)}${padL('EW $' + ew.toLocaleString(), 20)}`);
    console.log(`\nHonest read: OOS total is what choosing params on the past would have earned. Beat equal-weight (EW) OOS = real edge; near/under EW = the in-sample sweep was overfit.\n`);
    return;
  }
  if (cmd === 'wf2') {
    // node oshal-intraday.js wf2 SYM1,SYM2,... [years] [folds] — TWO-STAGE walk-forward (daily screen → intraday rotate)
    const syms = symA.toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (syms.length < 4) { console.error('wf2 needs a real universe (≥4 symbols)'); process.exit(1); }
    for (const s of syms) if (!fs.existsSync(CONT(s))) { console.error(`No data for ${s} — pull ${CONT(s)} first.`); process.exit(1); }
    const yrs = years && /^\d+$/.test(years) ? years : undefined;
    const folds = Number(process.argv[5]) || 5;
    const { aligned, sym0, meta } = await loadAligned(syms, yrs);
    const wf = rotateWalkForward2(aligned, sym0, syms, 1.0, folds);
    console.log(`\nTWO-STAGE WALK-FORWARD (daily-screen → intraday-rotate) ${syms.length} names: ${meta.days.toLocaleString()} sessions ${isoDay(meta.from)} → ${isoDay(meta.to)}, ${folds} folds | grid ${WF2_GRID.length} configs (screen incl.), select by IN-SAMPLE Sharpe\n`);
    console.log(`${pad('fold', 5)}${pad('picked (in-sample)', 30)}${padL('IS Shp', 8)}${padL('OOS $', 12)}${padL('OOS Shp', 9)}${padL('OOS PF', 8)}${padL('EW OOS $', 12)}`);
    console.log('-'.repeat(84));
    let ew = 0;
    for (const r of wf.rows) { ew += r.ewOos$; console.log(`${pad(r.fold, 5)}${pad(r.picked, 30)}${padL(r.isSharpe, 8)}${padL(r.oos$.toLocaleString(), 12)}${padL(r.oosSharpe, 9)}${padL(r.oosPF, 8)}${padL(r.ewOos$.toLocaleString(), 12)}`); }
    console.log('-'.repeat(84));
    console.log(`${pad('TOTAL OOS', 43)}${padL('$' + wf.oosTotalUsd.toLocaleString(), 21)}${padL('EW $' + ew.toLocaleString(), 20)}`);
    console.log(`\nThe screen is INSIDE the walk-forward grid, so this OOS includes it — beating EW here = a real two-stage edge, not selection bias.\n`);
    return;
  }
  if (cmd === 'compare' || cmd === 'report') {
    const { results, meta } = await backtestAll(sym, RUNS, years);
    if (cmd === 'compare') {
      console.log(`\n${sym} intraday: ${meta.days.toLocaleString()} sessions, ${isoDay(meta.from)} → ${isoDay(meta.to)} | $${POINT_VALUE[sym]}/pt, ${SLIPPAGE_PTS[sym]}pt slip + $${COMMISSION_RT} RT\n`);
      console.log(`${pad('strategy', 14)}${padL('$P&L', 13)}${padL('$/day', 9)}${padL('$/trade', 9)}${padL('trades', 8)}${padL('win%', 7)}${padL('dayW%', 7)}${padL('PF', 6)}${padL('Sharpe', 8)}${padL('maxDD$', 12)}`);
      console.log('-'.repeat(96));
      for (const [name, m] of Object.entries(results)) {
        console.log(`${pad(name, 14)}${padL(m.dollars.toLocaleString(), 13)}${padL(m.perDayUsd.toLocaleString(), 9)}${padL(m.avgTradeUsd.toLocaleString(), 9)}${padL(m.trades.toLocaleString(), 8)}${padL(m.winPct, 7)}${padL(m.dayWinPct, 7)}${padL(m.profitFactor, 6)}${padL(m.sharpe, 8)}${padL(m.ddUsd.toLocaleString(), 12)}`);
      }
      console.log('');
    }
    fs.writeFileSync(REPORT(sym), buildReportHtml(sym, meta, results));
    console.log(`report → ${REPORT(sym)}`);
    return;
  }
  console.error(`Usage: oshal-intraday.js build|compare|report <ES|CL> [years]`);
  process.exit(1);
})().catch((e) => { console.error('intraday failed:', e); process.exit(1); });
