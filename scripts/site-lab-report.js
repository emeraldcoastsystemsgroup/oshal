#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — nightly Strategy Lab report generator for the public site (operator ask 2026-07-17: "I want the report published nightly on the oshal website"). Reads the lab over the api's auth'd routes (the trading-regression-suite lane), renders a SELF-CONTAINED static page to site/oswarm.ai/lab/index.html: latest-session movers, the full permutation matrix, and the earnings-gate twin-vs-base table. SIMULATED DATA ONLY by design — every walk is the lab's synthetic $100k notional; the operator's real paper/live book equity and positions are deliberately never read here, so nothing private can leak onto the public page.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Brand naming pass (operator directive 2026-07-24): user-facing product name is lowercase "oshal" — never "Open Swarm" alone. Template title/h1/disclaimer/footer updated; footer home link reads oshal.ai.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Stop emailing a bare "fetch failed" for a busy box (2026-07-27 + 2026-07-30 both died this way while the api was up and healthy). Three changes: (a) default BASE is 127.0.0.1, not localhost — a stale wslrelay squats the IPv6 loopback here, and the ::1 detour costs ~300ms per call and can exceed undici's connect timeout under load; (b) every GET retries transient failures (connect error / 5xx / 429) with linear backoff, so one blip mid-run no longer discards 59 strategies' worth of work; (c) errors report undici's full cause chain — the old code logged err.message, which is the literal string "fetch failed" with the real reason (ECONNREFUSED vs timeout) hidden in .cause. Auth/4xx stay fatal: retrying a 401 just delays the same email.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve an explicit acting OIDC subject exactly while still trimming the comma-delimited operator fallback.
 *
 * Usage: node scripts/site-lab-report.js            (writes site/oswarm.ai/lab/index.html)
 *        node scripts/site-lab-report.js --stdout   (print the HTML instead of writing)
 * Exit 0 = page written. Non-zero = generation failed (the publisher must then SKIP the deploy,
 * leaving last night's page live, rather than publishing a broken/empty report).
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { requireExactUserSubject } = require('./lib/exact-user-subject');

// 127.0.0.1, never `localhost`: this box's IPv6 loopback is intermittently squatted (see the
// wslrelay runbook), and the happy-eyeballs detour is exactly what times out under nightly load.
const BASE = process.env.OSHAL_BASE_URL || 'http://127.0.0.1:35457';
const OUT = path.join(__dirname, '..', 'site', 'oswarm.ai', 'lab', 'index.html');
/** Reads a numeric env override. `?? default` on a parsed number, NOT `|| default` — an
 *  explicit 0 (used by the guard to run the retry paths without sleeping) is a real value. */
const envNum = (name, dflt) => {
  const n = Number(process.env[name]);
  return process.env[name] === undefined || process.env[name] === '' || Number.isNaN(n) ? dflt : n;
};
const ATTEMPTS = Math.max(1, envNum('LAB_REPORT_ATTEMPTS', 4));
const BACKOFF_MS = Math.max(0, envNum('LAB_REPORT_BACKOFF_MS', 10000));
const TIMEOUT_MS = Math.max(1000, envNum('LAB_REPORT_TIMEOUT_MS', 30000));

/** Auth headers — PAT first (human lane), service secret + sub second (bot lane). */
function authHeaders() {
  const pat = (process.env.OSHAL_CLI_TOKEN || '').trim();
  if (pat) return { Authorization: `Bearer ${pat}` };
  const secret = (process.env.OSHAL_SERVICE_SECRET || process.env.SWARM_SERVICE_SECRET || '').trim();
  const fallbackSub = (process.env.OSHAL_OPERATOR_SUBS || '').split(',')[0].trim();
  const sub = process.env.OSHAL_USER_SUB
    ? requireExactUserSubject(process.env.OSHAL_USER_SUB) : fallbackSub;
  if (secret && sub) return { 'X-Service-Secret': secret, 'X-OSHAL-User-Sub': sub };
  throw new Error('no auth: set OSHAL_CLI_TOKEN or SWARM_SERVICE_SECRET + OSHAL_USER_SUB/OSHAL_OPERATOR_SUBS');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Flattens an Error's `cause` chain into one readable line.
 * @description undici throws `TypeError: fetch failed` and buries the reason that actually
 *   matters — ECONNREFUSED, ConnectTimeoutError, socket hang up — one level down in `.cause`.
 *   Logging `err.message` alone is how two nights of failures reported nothing diagnosable.
 * @param {unknown} err the thrown error
 * @returns {string} e.g. "fetch failed <- Connect Timeout Error (ECONNREFUSED)"
 */
function describeError(err) {
  const parts = [];
  for (let e = err; e instanceof Error && parts.length < 5; e = e.cause) {
    parts.push(e.code ? `${e.message} (${e.code})` : e.message);
  }
  return parts.length ? parts.join(' <- ') : String(err);
}

/**
 * True when a failure is worth retrying rather than emailing about.
 * @description A busy box (the 17:00 recap leg overlaps this job) produces connect errors and
 *   5xx/429; those clear on their own. A 401/404 is a real defect — retrying only delays the
 *   same alert by a minute, so those propagate immediately.
 * @param {Error & {status?: number}} err the failure under consideration
 * @returns {boolean} whether to try again
 */
function isTransient(err) {
  if (typeof err.status === 'number') return err.status >= 500 || err.status === 429;
  return true; // connect/timeout/abort — the transport never delivered a verdict
}

/**
 * GETs a lab route, retrying transient failures with linear backoff.
 * @description Retries live HERE rather than around the whole run: `collect()` makes one call
 *   per strategy, so a single blip 50 strategies in used to throw away the entire report.
 * @param {string} p api path, e.g. '/api/trading/lab/strategies'
 * @returns {Promise<any>} the parsed JSON body
 * @throws {Error} after ATTEMPTS transient failures, or immediately on a fatal one
 */
async function get(p) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const r = await fetch(`${BASE}${p}`, { headers: authHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw Object.assign(new Error(`${p} HTTP ${r.status}`), { status: r.status });
      return await r.json();
    } catch (err) {
      last = err;
      if (!isTransient(err) || attempt === ATTEMPTS) break;
      const wait = BACKOFF_MS * attempt;
      console.warn(`site-lab-report: ${p} attempt ${attempt}/${ATTEMPTS} — ${describeError(err)}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  throw new Error(`${p} after ${ATTEMPTS} attempt(s): ${describeError(last)}`);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : '—');
const signed = (n, dp = 2) => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(dp) : '—');
const cls = (n) => (!Number.isFinite(n) ? '' : n > 0 ? 'up' : n < 0 ? 'dn' : '');

/** The group shelf a row renders under (prefix before '/', or 'originals'). */
function groupOf(name) {
  const i = name.indexOf('/');
  return i > 0 ? name.slice(0, i) : 'originals';
}

/** The gate-off base row name for an egate twin (mirrors the EGATE_BASES naming). */
function egateBaseName(twinName) {
  const key = twinName.replace(/^egate\//, '').replace(/-g\d+$/, '');
  return key.startsWith('ira-') ? `ira/${key.slice(4)}` : `sweep4/${key}`;
}

/** @returns rows joined with per-row forward series (last two points, forward-window return). */
async function collect() {
  const { strategies } = await get('/api/trading/lab/strategies');
  const rows = [];
  for (const s of strategies) {
    if (s.status === 'retired') continue;
    const m = (s.latestBacktest && s.latestBacktest.metrics) || {};
    const row = {
      name: s.name, group: groupOf(s.name), status: s.status,
      total: Number(m.totalReturnPct), sharpe: Number(m.sharpe), maxDD: Number(m.maxDrawdownPct),
      avgDay: Number(m.avgDailyPct), bestDay: Number(m.bestDayPct), worstDay: Number(m.worstDayPct),
      alpha: Number(m.alphaVsSpyPct), trades: Number(m.trades) || 0,
      fwdPoints: Number(s.forwardPoints) || 0, fwdReturn: NaN, lastDay: NaN, lastDate: null,
    };
    if (row.fwdPoints >= 1) {
      // Forward series: return over the walked window + the newest session's move.
      const detail = await get(`/api/trading/lab/strategies/${encodeURIComponent(s.id)}`);
      const pts = (detail.forward && detail.forward.points) || [];
      if (pts.length >= 1) {
        row.lastDate = pts[pts.length - 1].d;
        row.fwdReturn = (pts[pts.length - 1].e / pts[0].e - 1) * 100;
        if (pts.length >= 2) row.lastDay = (pts[pts.length - 1].e / pts[pts.length - 2].e - 1) * 100;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Renders one matrix table body (rows pre-sorted). */
function tableRows(rows) {
  return rows.map((r) => `<tr>
    <td class="nm">${esc(r.name)}${r.status === 'armed' ? ' <span class="tag">armed</span>' : ''}</td>
    <td>${f2(r.total)}</td><td>${f3(r.avgDay)}</td><td>${f2(r.bestDay)}</td><td>${f2(r.worstDay)}</td>
    <td>${f2(r.sharpe)}</td><td>${f2(r.maxDD)}</td><td class="${cls(r.alpha)}">${signed(r.alpha)}</td>
    <td>${r.fwdPoints}</td><td class="${cls(r.fwdReturn)}">${signed(r.fwdReturn)}</td>
    <td class="${cls(r.lastDay)}">${signed(r.lastDay)}</td>
  </tr>`).join('\n');
}

function moversSection(rows) {
  const walked = rows.filter((r) => Number.isFinite(r.lastDay));
  if (!walked.length) {
    return '<p class="note">Out-of-sample forward walks begin accruing tonight — movers appear after two walked sessions per strategy.</p>';
  }
  const day = walked[0].lastDate || '';
  const sorted = [...walked].sort((a, b) => b.lastDay - a.lastDay);
  const line = (r) => `<li><span class="nm">${esc(r.name)}</span> <span class="${cls(r.lastDay)}">${signed(r.lastDay)}%</span></li>`;
  return `<p class="note">Latest walked session: <strong>${esc(day)}</strong> · ${walked.length} strategies walked</p>
  <div class="movers"><div><h3>Session winners</h3><ol>${sorted.slice(0, 5).map(line).join('')}</ol></div>
  <div><h3>Session losers</h3><ol>${sorted.slice(-5).reverse().map(line).join('')}</ol></div></div>`;
}

function egateSection(rows) {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const twins = rows.filter((r) => r.group === 'egate');
  if (!twins.length) return '<p class="note">Earnings-gate twin rows have not been seeded yet.</p>';
  const body = twins.map((t) => {
    const base = byName.get(egateBaseName(t.name));
    const delta = base && Number.isFinite(t.fwdReturn) && Number.isFinite(base.fwdReturn) ? t.fwdReturn - base.fwdReturn : NaN;
    return `<tr><td class="nm">${esc(t.name)}</td><td class="nm">${esc(base ? base.name : '?')}</td>
      <td class="${cls(t.fwdReturn)}">${signed(t.fwdReturn)}</td><td class="${cls(base ? base.fwdReturn : NaN)}">${signed(base ? base.fwdReturn : NaN)}</td>
      <td class="${cls(delta)}"><strong>${signed(delta)}</strong></td></tr>`;
  }).join('\n');
  return `<p class="note">Each twin differs from its base by ONLY the earnings gate. The forward delta (twin − base) is the gate's measured value; backtests are near-identical by construction (the calendar exists only from 2026-06-25).</p>
  <table><thead><tr><th>gated twin</th><th>gate-off base</th><th>twin fwd %</th><th>base fwd %</th><th>Δ fwd pts</th></tr></thead><tbody>${body}</tbody></table>`;
}

function render(rows) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const groups = ['sweep4', 'thesis', 'ira', 'egate', 'originals'];
  const groupTitles = {
    sweep4: 'Knob permutation grid — rank × topN × corePct over the armed base (36)',
    thesis: 'Operator theses — defensive shelter, small/mid medtech, AI-infrastructure, T-bill hide-out',
    ira: 'Retirement cadence — slow-rotation sleeves (5/10-session, conservative/balanced)',
    egate: 'Earnings-gate twins — bases duplicated with only the gate turned on',
    originals: 'Hand-authored strategies',
  };
  const sections = groups.filter((g) => rows.some((r) => r.group === g)).map((g) => {
    const rs = rows.filter((r) => r.group === g).sort((a, b) => (b.total || 0) - (a.total || 0));
    return `<h2>${esc(groupTitles[g] || g)}</h2>
    <div class="tw"><table><thead><tr><th>strategy</th><th>total %</th><th>avg day %</th><th>best day %</th><th>worst day %</th><th>sharpe</th><th>max DD %</th><th>alpha vs SPY</th><th>fwd sessions</th><th>fwd %</th><th>last session %</th></tr></thead>
    <tbody>${tableRows(rs)}</tbody></table></div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>oshal Strategy Lab — nightly forward-walk report</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0e14;color:#d7dce4;font:15px/1.55 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;padding:2rem 1rem 4rem}
  main{max-width:1080px;margin:0 auto}
  h1{font-size:1.6rem;margin:0 0 .25rem} h2{font-size:1.05rem;margin:2.2rem 0 .5rem;color:#9fb2cc}
  h3{font-size:.95rem;margin:.2rem 0 .4rem;color:#9fb2cc}
  .sub{color:#8b93a3;margin:0 0 1rem} .note{color:#8b93a3;font-size:.9rem}
  .disc{border:1px solid #2a3446;background:#111726;border-radius:8px;padding: .8rem 1rem;margin:1.2rem 0;font-size:.88rem;color:#aeb7c6}
  .tw{overflow-x:auto} table{border-collapse:collapse;width:100%;font-size:.85rem;font-variant-numeric:tabular-nums}
  th,td{padding:.32rem .55rem;text-align:right;border-bottom:1px solid #1c2333;white-space:nowrap}
  th{color:#7f8ba0;font-weight:600;text-align:right} th:first-child,td:first-child{text-align:left}
  td.nm{text-align:left;font-family:ui-monospace,Consolas,monospace;font-size:.82rem}
  .up{color:#4ade80} .dn{color:#f87171}
  .tag{background:#1d3a2a;color:#4ade80;border-radius:4px;padding:0 .35rem;font-size:.7rem;vertical-align:middle}
  .movers{display:flex;gap:2.5rem;flex-wrap:wrap} .movers ol{margin:.2rem 0;padding-left:1.2rem}
  .movers li{margin:.15rem 0} .movers .nm{font-family:ui-monospace,Consolas,monospace;font-size:.85rem}
  a{color:#7fb4ff} footer{margin-top:3rem;color:#6b7280;font-size:.82rem}
</style></head><body><main>
<h1>oshal Strategy Lab</h1>
<p class="sub">Nightly forward-walk report · generated ${esc(now)} · ${rows.length} strategies under test</p>
<div class="disc"><strong>What this is:</strong> oshal's strategy lab walks every saved configuration forward one real market session per night, out-of-sample, from a synthetic $100,000 notional. <strong>What this is not:</strong> real-money performance (no live account data appears here), a track record, or investment advice. All figures are gross of slippage and commissions; backtest columns are in-sample and overfit-prone by nature — the forward columns are the honest ones, and they are short. Strategies are ranked to be <em>studied</em>, not followed.</div>
<h2>Latest session</h2>
${moversSection(rows)}
<h2>Earnings-gate A/B</h2>
${egateSection(rows)}
${sections}
<footer>Built nightly by the oshal swarm after the lab's post-close forward walk. Columns: total/avg/best/worst/sharpe/maxDD/alpha are the latest full backtest; fwd = out-of-sample sessions walked and the return over them; last session = the newest walked day. <a href="/">← oshal.ai</a></footer>
</main></body></html>`;
}

async function main() {
  const rows = await collect();
  if (!rows.length) throw new Error('lab returned zero strategies — refusing to publish an empty report');
  const html = render(rows);
  if (process.argv.includes('--stdout')) { process.stdout.write(html); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`site-lab-report: wrote ${OUT} (${rows.length} strategies, ${Buffer.byteLength(html)} bytes)`);
}

// Exported for the regression guard (tests/unit/site-lab-report-fetch-resilience.spec.ts).
// The dispatch below is gated on require.main so importing this file is side-effect free.
module.exports = { describeError, isTransient, get, BASE };

if (require.main === module) {
  main().catch((err) => { console.error(`site-lab-report FAILED: ${err.message}`); process.exit(1); });
}
