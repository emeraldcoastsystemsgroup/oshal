#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the Gravity Model engine (ADR-054), the operator's first Intelligent-Trades algorithm. A baseline fundamental fair value (the stable, predictable line) is displaced by "masses" (influencers/events), each with mass (reach×magnitude), polarity (±pull), proximity (how directly it hits THIS stock), and a half-life (time decay). As masses age the pull fades and price reverts to baseline. "Anti-gravity" masses damp net displacement (a stabilizer / capital-rotation shield). Emits a model fair-value path + a trade signal, and a graphical HTML report. Masses are meant to come from the research bot (news/social/weather/D&B); this ships with a worked demo scenario. Pure Node, no deps.
 *
 *   node scripts/oshal-gravity.js demo [TICKER]        # worked example scenario → HTML + signal
 *   node scripts/oshal-gravity.js run <masses.json>    # { baseline, marketPrice?, horizonDays?, masses:[...] }
 *
 * A mass: { source, label, mass(0..1), polarity(1|-1), proximity(0..1), halfLifeDays, t0Day, antigravity? }
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_SWING = 0.6;   // cap net displacement at ±60% of baseline (speculation can't be infinite)

/** One mass's fractional contribution at day t (0 before it appears; exponential half-life decay after). */
function contribution(mass, t) {
  if (t < mass.t0Day) return 0;
  const decay = Math.pow(0.5, (t - mass.t0Day) / Math.max(0.5, mass.halfLifeDays));
  return mass.polarity * mass.mass * mass.proximity * decay;   // sign × reach × relevance × decay
}

/** Net fractional displacement at day t: gravity masses summed, then damped by any anti-gravity. */
function displacement(masses, t) {
  let pull = 0, damp = 0;
  for (const m of masses) {
    const c = contribution(m, t);
    if (m.antigravity) damp += Math.abs(c); else pull += c;
  }
  const damped = pull * Math.max(0, 1 - damp);                  // anti-gravity shrinks net swing
  return Math.max(-MAX_SWING, Math.min(MAX_SWING, damped));
}

/** Model fair value at day t = baseline displaced by the (decayed, damped) gravity field. */
function fairValue(baseline, masses, t) { return baseline * (1 + displacement(masses, t)); }

/** Trade read at "now" (t=evalDay): direction of the field + whether it's over-extended vs baseline. */
function signal(baseline, masses, marketPrice, evalDay = 0) {
  const d = displacement(masses, evalDay);
  const fair = baseline * (1 + d);
  const dir = d > 0.02 ? 'up' : d < -0.02 ? 'down' : 'flat';
  // Ride the gravity while it's building; fade when extension is extreme (mean-revert to baseline).
  const ride = dir === 'up' ? 'buy' : dir === 'down' ? 'sell' : 'hold';
  const fade = Math.abs(d) > 0.25 ? (d > 0 ? 'sell' : 'buy') : 'hold';
  // If we know the market price, also compare model-vs-market (model says where price "should" be).
  let vsMarket = null;
  if (marketPrice) vsMarket = fair > marketPrice * 1.03 ? 'buy (market below model)' : fair < marketPrice * 0.97 ? 'sell (market above model)' : 'hold (near model)';
  return { displacementPct: round(d * 100), fair: round(fair), direction: dir, rideSignal: ride, fadeSignal: fade, vsMarket };
}

/** A worked demo scenario for a ticker — the kind of mass-set the research bot will produce. */
function demoScenario(ticker) {
  // proximity: 1 = directly about the name, lower = correlated-industry / indirect spillover.
  return {
    baseline: 100, marketPrice: 108, horizonDays: 180, ticker,
    masses: [
      { source: 'social/ai-hype', label: 'AI tailwind (sector)', mass: 0.5, polarity: 1, proximity: 0.35, halfLifeDays: 90, t0Day: -20, antigravity: false },
      { source: 'news/lawsuit', label: 'Class-action filed', mass: 0.7, polarity: -1, proximity: 0.9, halfLifeDays: 75, t0Day: -10, antigravity: false },
      { source: 'news/fda', label: 'FDA approval', mass: 0.9, polarity: 1, proximity: 1.0, halfLifeDays: 120, t0Day: 0, antigravity: false },
      { source: 'social/influencer', label: 'Negative POTUS comment', mass: 0.8, polarity: -1, proximity: 0.6, halfLifeDays: 4, t0Day: 2, antigravity: false },
      { source: 'weather/disaster', label: 'Tornado → roofing/gensets demand', mass: 0.55, polarity: 1, proximity: 0.45, halfLifeDays: 18, t0Day: 5, antigravity: false },
      { source: 'rotation/anti-gravity', label: 'Capital rotation (sector stabilizer)', mass: 0.4, polarity: 1, proximity: 0.5, halfLifeDays: 60, t0Day: -5, antigravity: true },
    ],
  };
}

/* ── graphical report (HTML + Chart.js) ───────────────────────────────────── */
function buildHtml(cfg) {
  const { baseline, marketPrice, horizonDays, ticker, masses } = cfg;
  const days = []; for (let t = 0; t <= horizonDays; t++) days.push(t);
  const fairLine = days.map((t) => round(fairValue(baseline, masses, t)));
  const baseLine = days.map(() => baseline);
  const COLORS = ['#36d39a', '#ff7b7b', '#5fa8ff', '#ffcf6b', '#9ee6b8', '#c08bff'];
  const massLines = masses.map((m, i) => ({ label: `${m.label}${m.antigravity ? ' (anti-G)' : ''}`, data: days.map((t) => round(contribution(m, t) * 100, 2)), borderColor: COLORS[i % COLORS.length], borderWidth: 1.3, pointRadius: 0, tension: 0.15, borderDash: m.antigravity ? [5, 4] : [] }));
  const sig = signal(baseline, masses, marketPrice, 0);
  const mrows = masses.map((m, i) => `<tr><td style="color:${COLORS[i % COLORS.length]}">${m.label}</td><td>${m.source}</td><td class="num">${m.mass}</td><td class="num">${m.polarity > 0 ? '+' : '−'}</td><td class="num">${m.proximity}</td><td class="num">${m.halfLifeDays}d</td><td class="num">${m.t0Day}</td><td class="num">${round(contribution(m, 0) * 100, 2)}%</td></tr>`).join('');
  const DATA = JSON.stringify({ days, fairLine, baseLine, massLines, baseline, marketPrice });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ticker} — Gravity Model</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>:root{--bg:#0b1020;--panel:#121a30;--line:#27324f;--text:#e7ecf7;--muted:#8ea0c4;--accent:#5fa8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,sans-serif}
.page{max-width:1080px;margin:0 auto;padding:28px 22px 80px}h1{font-size:24px;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin-bottom:22px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}h2{font-size:15px;margin:0 0 12px;color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:7px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line)}td.num{text-align:right;font-variant-numeric:tabular-nums}canvas{max-height:340px}
.sig{display:flex;gap:10px;flex-wrap:wrap}.stat{background:#1a2540;border:1px solid var(--line);border-radius:11px;padding:11px 15px;min-width:130px}.stat .n{font-size:20px;font-weight:700;color:var(--accent)}.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase}</style></head>
<body><div class="page">
<h1>${ticker} — Gravity Model</h1>
<div class="sub">Baseline (fundamental) $${baseline} · market $${marketPrice} · ${horizonDays}-day horizon · masses decay by half-life back toward baseline</div>
<div class="panel"><h2>Signal (today)</h2><div class="sig">
  <div class="stat"><div class="n">${sig.displacementPct}%</div><div class="l">net displacement</div></div>
  <div class="stat"><div class="n">$${sig.fair}</div><div class="l">model fair value</div></div>
  <div class="stat"><div class="n">${sig.direction}</div><div class="l">gravity direction</div></div>
  <div class="stat"><div class="n">${sig.rideSignal}</div><div class="l">ride</div></div>
  <div class="stat"><div class="n">${sig.fadeSignal}</div><div class="l">fade (if extended)</div></div>
  <div class="stat"><div class="n" style="font-size:13px">${sig.vsMarket || '—'}</div><div class="l">model vs market</div></div>
</div></div>
<div class="panel"><h2>Fair value vs baseline (the line the gravity pulls)</h2><canvas id="fv"></canvas></div>
<div class="panel"><h2>Each mass's pull over time (% of baseline, decaying)</h2><canvas id="ms"></canvas></div>
<div class="panel"><h2>The masses</h2><table><thead><tr><th>Mass</th><th>Source</th><th class="num">mass</th><th class="num">±</th><th class="num">proximity</th><th class="num">half-life</th><th class="num">t0(day)</th><th class="num">pull@now</th></tr></thead><tbody>${mrows}</tbody></table>
<div class="sub" style="margin-top:10px">Masses come from the research bot (news / social / weather / D&amp;B). proximity 1 = directly names the stock; lower = correlated-industry spillover. Anti-gravity (dashed) damps net swing.</div></div>
</div><script>
const D=${DATA};const grid={color:'#1c2742'},tick={color:'#8ea0c4',font:{size:10}};
new Chart(fv,{type:'line',data:{labels:D.days,datasets:[
 {label:'Model fair value',data:D.fairLine,borderColor:'#5fa8ff',borderWidth:2,pointRadius:0,tension:.15},
 {label:'Baseline (fundamental)',data:D.baseLine,borderColor:'#8ea0c4',borderDash:[6,4],borderWidth:1,pointRadius:0},
 {label:'Market price',data:D.days.map(()=>D.marketPrice),borderColor:'#ffcf6b',borderDash:[2,3],borderWidth:1,pointRadius:0}
]},options:{plugins:{legend:{labels:{color:'#e7ecf7'}}},scales:{x:{title:{display:true,text:'days',color:'#8ea0c4'},ticks:{...tick,maxTicksLimit:12},grid},y:{ticks:tick,grid}}}});
new Chart(ms,{type:'line',data:{labels:D.days,datasets:D.massLines},options:{plugins:{legend:{labels:{color:'#e7ecf7',font:{size:10}}}},scales:{x:{ticks:{...tick,maxTicksLimit:12},grid},y:{title:{display:true,text:'% pull',color:'#8ea0c4'},ticks:tick,grid}}}});
</script></body></html>`;
}

/* ── multi-asset simulation: one mass, per-ticker coupling (the 3-D deflection) ──
 * Same event hits each name through its OWN signed coupling — HD down AND Lowe's up. A mass now
 * carries `coupling: { TICKER: signed[-1..1] }` instead of one polarity×proximity. */
function decayAt(mass, t) { return t < mass.t0Day ? 0 : Math.pow(0.5, (t - mass.t0Day) / Math.max(0.5, mass.halfLifeDays)); }

/** Net fractional displacement for ONE ticker from all masses (per-ticker coupling + anti-gravity damp). */
function simDisplacement(ticker, masses, t) {
  let pull = 0, damp = 0;
  for (const m of masses) {
    const k = (m.coupling && m.coupling[ticker]) || 0;
    if (!k) continue;
    const c = k * m.mass * decayAt(m, t);
    if (m.antigravity) damp += Math.abs(c); else pull += c;
  }
  return Math.max(-MAX_SWING, Math.min(MAX_SWING, pull * Math.max(0, 1 - damp)));
}
function simSignal(asset, masses, t = 0) {
  const d = simDisplacement(asset.ticker, masses, t);
  const dir = d > 0.02 ? 'up' : d < -0.02 ? 'down' : 'flat';
  return { ticker: asset.ticker, displacementPct: round(d * 100), fair: round(asset.baseline * (1 + d)), direction: dir, signal: dir === 'up' ? 'buy' : dir === 'down' ? 'sell' : 'hold' };
}

/** Worked cohort: one event-set, divergent per-vendor trajectories (HD/LOW/GNRC/BLDR). */
function simScenario() {
  return {
    horizonDays: 180, cohort: 'Home-improvement vendors',
    assets: [
      { ticker: 'HD', baseline: 100, marketPrice: 104 }, { ticker: 'LOW', baseline: 100, marketPrice: 99 },
      { ticker: 'GNRC', baseline: 100, marketPrice: 96 }, { ticker: 'BLDR', baseline: 100, marketPrice: 102 },
    ],
    masses: [
      // The operator's example: a hit ON Home Depot is a GIFT to Lowe's (shoppers substitute).
      { source: 'news/lawsuit', label: 'HD product-recall lawsuit', mass: 0.8, halfLifeDays: 60, t0Day: 0, coupling: { HD: -0.9, LOW: 0.5, GNRC: 0.1, BLDR: 0 } },
      // Disaster: demand spike — lifts generators & roofing/lumber hardest, retailers some.
      { source: 'weather/disaster', label: 'Tornado outbreak', mass: 0.7, halfLifeDays: 18, t0Day: 5, coupling: { HD: 0.45, LOW: 0.45, GNRC: 0.9, BLDR: 0.8 } },
      // Macro headwind: rates up → less home spend; new-construction (BLDR) hit worst.
      { source: 'macro/rates', label: 'Mortgage rates spike', mass: 0.6, halfLifeDays: 120, t0Day: -8, coupling: { HD: -0.4, LOW: -0.4, GNRC: -0.2, BLDR: -0.75 } },
      // Fast, name-specific influencer hit.
      { source: 'social/influencer', label: 'Negative POTUS post re: HD', mass: 0.8, halfLifeDays: 4, t0Day: 3, coupling: { HD: -0.7, LOW: 0.3, GNRC: 0, BLDR: 0 } },
      // Anti-gravity: capital rotating INTO the sector stabilizes the whole cohort.
      { source: 'rotation/anti-gravity', label: 'Sector capital rotation', mass: 0.4, halfLifeDays: 70, t0Day: -5, antigravity: true, coupling: { HD: 0.5, LOW: 0.5, GNRC: 0.5, BLDR: 0.5 } },
    ],
  };
}

/** Multi-asset HTML: divergent trajectories + a "same event, different deflection" bar + coupling matrix. */
function buildSimHtml(cfg) {
  const { assets, masses, horizonDays, cohort } = cfg;
  const days = []; for (let t = 0; t <= horizonDays; t++) days.push(t);
  const COLORS = ['#36d39a', '#ff7b7b', '#5fa8ff', '#ffcf6b', '#c08bff', '#9ee6b8'];
  const lines = assets.map((a, i) => ({ label: a.ticker, data: days.map((t) => round(simDisplacement(a.ticker, masses, t) * 100, 2)), borderColor: COLORS[i % COLORS.length], borderWidth: 1.8, pointRadius: 0, tension: 0.15 }));
  const sigs = assets.map((a) => simSignal(a, masses, 0));
  const headline = masses[0];   // the HD lawsuit — show its split deflection across the cohort
  const splitBar = assets.map((a) => round(((headline.coupling[a.ticker] || 0) * headline.mass) * 100, 1));
  const matRows = masses.map((m) => `<tr><td>${m.label}${m.antigravity ? ' (anti-G)' : ''}</td>${assets.map((a) => { const k = (m.coupling && m.coupling[a.ticker]) || 0; return `<td class="num" style="color:${k < 0 ? '#ff7b7b' : k > 0 ? '#36d39a' : '#8ea0c4'}">${k}</td>`; }).join('')}</tr>`).join('');
  const sigRows = sigs.map((s, i) => `<tr><td style="color:${COLORS[i % COLORS.length]}">${s.ticker}</td><td class="num">${s.displacementPct}%</td><td class="num">$${s.fair}</td><td class="num">${s.direction}</td><td class="num">${s.signal}</td></tr>`).join('');
  const DATA = JSON.stringify({ days, lines, tickers: assets.map((a) => a.ticker), splitBar });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gravity Sim — ${cohort}</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>:root{--bg:#0b1020;--panel:#121a30;--line:#27324f;--text:#e7ecf7;--muted:#8ea0c4;--accent:#5fa8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,sans-serif}
.page{max-width:1080px;margin:0 auto;padding:28px 22px 80px}h1{font-size:24px;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin-bottom:22px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}h2{font-size:15px;margin:0 0 12px;color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:7px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line)}td.num{text-align:right;font-variant-numeric:tabular-nums}canvas{max-height:340px}</style></head>
<body><div class="page">
<h1>Gravity Simulation — ${cohort}</h1>
<div class="sub">Same masses, different per-ticker coupling → divergent trajectories. ${assets.map((a) => a.ticker).join(' · ')} · ${horizonDays}-day horizon.</div>
<div class="panel"><h2>Per-vendor displacement over time (% from each baseline)</h2><canvas id="traj"></canvas></div>
<div class="panel"><h2>One event, different deflection — "${headline.label}" hits each name (% pull @ t0)</h2><canvas id="split"></canvas>
<div class="sub" style="margin-top:8px">The same negative mass pushes HD down and Lowe's up — substitution, not uniform impact.</div></div>
<div class="panel"><h2>Today's signal per vendor</h2><table><thead><tr><th>Ticker</th><th class="num">displacement</th><th class="num">fair</th><th class="num">direction</th><th class="num">signal</th></tr></thead><tbody>${sigRows}</tbody></table></div>
<div class="panel"><h2>Coupling matrix (mass × ticker, signed sensitivity −1…+1)</h2><table><thead><tr><th>Mass</th>${assets.map((a) => `<th class="num">${a.ticker}</th>`).join('')}</tr></thead><tbody>${matRows}</tbody></table></div>
</div><script>
const D=${DATA};const grid={color:'#1c2742'},tick={color:'#8ea0c4',font:{size:10}};
new Chart(traj,{type:'line',data:{labels:D.days,datasets:D.lines},options:{plugins:{legend:{labels:{color:'#e7ecf7'}}},scales:{x:{title:{display:true,text:'days',color:'#8ea0c4'},ticks:{...tick,maxTicksLimit:12},grid},y:{title:{display:true,text:'% move',color:'#8ea0c4'},ticks:tick,grid}}}});
new Chart(split,{type:'bar',data:{labels:D.tickers,datasets:[{data:D.splitBar,backgroundColor:D.splitBar.map(v=>v<0?'#ff7b7b':'#36d39a')}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:tick,grid},y:{ticks:tick,grid}}}});
</script></body></html>`;
}

/* ── gravity INDICATORS: derive masses from market data (no external feed needed) ──
 * "Market trend gravity" — the masses the price itself reveals: a persistent trend, a volatility
 * shock (an unnamed event arrived), a correlated index pulling via its correlation, and a
 * mean-reversion tug when the price is stretched. The research bot adds news/social/weather masses
 * on top of these; together they feed the same displacement(). */
function avg(a) { return a.reduce((s, x) => s + x, 0) / (a.length || 1); }
function pctReturns(c) { const r = []; for (let i = 1; i < c.length; i++) r.push((c[i] - c[i - 1]) / c[i - 1]); return r; }
function pearson(a, b) {
  const n = Math.min(a.length, b.length); if (n < 5) return 0;
  const ax = a.slice(-n), bx = b.slice(-n); const am = avg(ax), bm = avg(bx);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = ax[i] - am, y = bx[i] - bm; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}

/** Derive market-gravity masses for a symbol from its closes (+ optional index closes for the pull). */
function deriveMasses(symbol, closes, opts = {}) {
  const masses = []; const n = closes.length; if (n < 25) return masses;
  const last = closes[n - 1];
  const sma50 = avg(closes.slice(-50)); const trend = (last - sma50) / sma50;
  masses.push({ source: 'market/trend', label: `${symbol} trend`, mass: Math.min(1, Math.abs(trend) * 6), polarity: trend >= 0 ? 1 : -1, proximity: 1, halfLifeDays: 30, t0Day: 0 });
  const rets = pctReturns(closes); const recent = rets.slice(-21); const mu = avg(recent);
  const sd = Math.sqrt(avg(recent.map((x) => (x - mu) ** 2))) || 1e-9; const z = (rets[rets.length - 1] - mu) / sd;
  if (Math.abs(z) > 1.5) masses.push({ source: 'market/shock', label: `${symbol} vol-shock z=${z.toFixed(1)}`, mass: Math.min(1, Math.abs(z) / 4), polarity: z >= 0 ? 1 : -1, proximity: 1, halfLifeDays: 5, t0Day: 0 });
  if (opts.indexCloses && opts.indexCloses.length > 25) {
    const idx = opts.indexCloses; const c = pearson(rets, pctReturns(idx));
    const isma = avg(idx.slice(-20)); const imove = (idx[idx.length - 1] - isma) / isma;
    if (Math.abs(c) > 0.2 && Math.abs(imove) > 0.005) masses.push({ source: 'market/correlated-index', label: `${opts.indexName || 'index'} pull (ρ=${c.toFixed(2)})`, mass: Math.abs(c) * Math.min(1, Math.abs(imove) * 8), polarity: (imove >= 0 ? 1 : -1) * (c >= 0 ? 1 : -1), proximity: Math.abs(c), halfLifeDays: 20, t0Day: 0 });
  }
  const sma20 = avg(closes.slice(-20)); const gap = (last - sma20) / sma20;
  if (Math.abs(gap) > 0.08) masses.push({ source: 'market/mean-reversion', label: `${symbol} stretched ${(gap * 100).toFixed(0)}%`, mass: Math.min(1, Math.abs(gap) * 3), polarity: gap > 0 ? -1 : 1, proximity: 0.6, halfLifeDays: 10, t0Day: 0 });
  return masses;
}

const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };

module.exports = { contribution, displacement, fairValue, signal, decayAt, simDisplacement, simSignal, deriveMasses, MAX_SWING };

function main() {
  const [cmd = 'demo', arg] = process.argv.slice(2);
  // Multi-asset simulation: one mass-set, per-ticker coupling → divergent trajectories.
  if (cmd === 'sim') {
    const cfg = (arg && fs.existsSync(arg)) ? JSON.parse(fs.readFileSync(arg, 'utf8')) : simScenario();
    cfg.cohort = cfg.cohort || 'cohort'; cfg.horizonDays = cfg.horizonDays || 180;
    console.log(`\n${cfg.cohort} — gravity signals (today):`);
    for (const a of cfg.assets) console.log(' ', JSON.stringify(simSignal(a, cfg.masses, 0)));
    const outDir = path.join('data', '_extracted'); fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `gravity-sim-${cfg.cohort.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`);
    fs.writeFileSync(out, buildSimHtml(cfg));
    console.log(`\nWrote ${out} — open it in a browser.\n`);
    return;
  }
  let cfg;
  if (cmd === 'demo') cfg = demoScenario((arg || 'DEMO').toUpperCase());
  else if (cmd === 'run') {
    if (!arg || !fs.existsSync(arg)) { console.error('run needs a masses JSON file: { baseline, marketPrice?, horizonDays?, masses:[...] }'); process.exit(1); }
    cfg = JSON.parse(fs.readFileSync(arg, 'utf8')); cfg.ticker = cfg.ticker || 'TICKER'; cfg.horizonDays = cfg.horizonDays || 180;
  } else { console.error('usage: oshal-gravity.js <demo|run> [TICKER|masses.json]'); process.exit(1); }
  const sig = signal(cfg.baseline, cfg.masses, cfg.marketPrice, 0);
  console.log(`\n${cfg.ticker} gravity signal (today):`, JSON.stringify(sig, null, 2));
  const outDir = path.join('data', '_extracted'); fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `gravity-${cfg.ticker}.html`);
  fs.writeFileSync(out, buildHtml(cfg));
  console.log(`\nWrote ${out} — open it in a browser.\n`);
}

if (require.main === module) main();
