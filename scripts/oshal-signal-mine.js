#!/usr/bin/env node
/*
 * Signal miner — does a recorded signal actually precede a move? (ADR-052/054/058)
 *
 * The honest test the operator wants: join the World layer's per-(ticker,day) FEATURES (world_metrics) to the
 * forward-return LABELS (trading_signal_labels, written by oshal-signal-label.js), then for each feature
 * bucket the samples by quantile and show the average forward return per bucket — IN-SAMPLE and on a
 * held-out later slice (temporal split). A feature predicts only if the bucket gradient is monotone AND
 * survives out-of-sample. This is the gate every signal must pass before it feeds the Gravity model or
 * the live bot — the same discipline that killed the intraday-rotation mirage, now on news features.
 *
 * Starts useful TODAY against whatever is recorded (sentiment, mentions); gets richer automatically as
 * the world team ships more features (velocity, sentiment_shift, consensus, event_*). No code change to
 * pick up a new metric — it mines every metric present in world_metrics.
 *
 *   node scripts/oshal-signal-mine.js [horizon] [buckets]   # horizon default fwd_ret_1d, buckets 5
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — feature→forward-return mining with quantile buckets + temporal OOS split; auto-discovers every world_metrics metric.
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* optional */ }
const { Pool } = require('pg');

const TSDB_URL = process.env.TSDB_URL_HOST || process.env.TSDB_URL || 'postgresql://oshal:oshal@localhost:55434/oshal_ts';
const round = (n, d = 4) => { const f = 10 ** d; return Math.round(n * f) / f; };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
/** Count-like metrics aggregate by SUM per day; everything else (sentiment-like) by AVG. */
const SUM_METRICS = new Set(['mentions', 'mention_count']);

/** Quantile-bucket the samples by feature value; return per-bucket avg label + count. */
function buckets(samples, nb) {
  const xs = samples.map((s) => s.x).sort((a, b) => a - b);
  if (xs.length < nb * 3) return null;
  const edges = []; for (let i = 1; i < nb; i++) edges.push(xs[Math.floor((i / nb) * xs.length)]);
  const b = Array.from({ length: nb }, () => ({ n: 0, sum: 0, lo: Infinity, hi: -Infinity }));
  for (const s of samples) {
    let k = 0; while (k < edges.length && s.x > edges[k]) k++;
    const cell = b[k]; cell.n++; cell.sum += s.y; cell.lo = Math.min(cell.lo, s.x); cell.hi = Math.max(cell.hi, s.x);
  }
  return b.map((c) => ({ n: c.n, avg: c.n ? c.sum / c.n : 0, lo: c.lo, hi: c.hi }));
}
/** Pearson correlation feature↔label. */
function corr(samples) {
  const n = samples.length; if (n < 5) return 0;
  const mx = samples.reduce((s, p) => s + p.x, 0) / n, my = samples.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const p of samples) { const a = p.x - mx, b = p.y - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : 0;
}
/** Monotonicity score of bucket avgs in [-1,1]: +1 = strictly rising, -1 = strictly falling. */
function monotone(bk) {
  let up = 0, dn = 0; for (let i = 1; i < bk.length; i++) { if (bk[i].avg > bk[i - 1].avg) up++; else dn++; }
  return (up - dn) / (bk.length - 1);
}

(async () => {
  const horizon = process.argv[2] || 'fwd_ret_1d';
  const nb = Number(process.argv[3]) || 5;
  const pool = new Pool({ connectionString: TSDB_URL });
  try {
    // Labels: (entity, date) → forward return at the chosen horizon.
    const labRows = (await pool.query(`SELECT entity, date, fwd_ret FROM trading_signal_labels WHERE horizon=$1`, [horizon])).rows;
    if (!labRows.length) { console.log(`No labels for ${horizon} yet — run oshal-signal-label.js first.`); return; }
    const label = new Map(); for (const r of labRows) label.set(`${r.entity}|${r.date.toISOString().slice(0, 10)}`, Number(r.fwd_ret));

    // Features: daily aggregate per (entity, date, metric).
    const metrics = (await pool.query(`SELECT DISTINCT metric FROM world_metrics`)).rows.map((r) => r.metric);
    console.log(`\n  SIGNAL MINER  ·  horizon ${horizon}  ·  ${labRows.length} labeled (entity,day)  ·  metrics: ${metrics.join(', ')}\n`);

    const dates = labRows.map((r) => r.date.toISOString().slice(0, 10)).sort();
    const splitDate = dates[Math.floor(dates.length * 0.7)]; // temporal 70/30 split for a held-out check

    console.log(`${pad('feature', 22)}${padL('N', 7)}${padL('corr', 8)}${padL('mono', 7)}${padL('lo-bucket', 11)}${padL('hi-bucket', 11)}${padL('OOS lo', 9)}${padL('OOS hi', 9)}`);
    console.log('-'.repeat(84));
    for (const metric of metrics) {
      const agg = SUM_METRICS.has(metric) ? 'sum(value)' : 'avg(value)';
      const fr = (await pool.query(
        `SELECT entity, ts::date AS d, ${agg} AS x FROM world_metrics WHERE metric=$1 GROUP BY entity, ts::date`, [metric])).rows;
      const all = [], oos = [];
      for (const r of fr) {
        const d = r.d.toISOString().slice(0, 10); const y = label.get(`${r.entity}|${d}`);
        if (y == null || r.x == null) continue;
        const s = { x: Number(r.x), y }; all.push(s); if (d >= splitDate) oos.push(s);
      }
      if (all.length < nb * 3) { console.log(`${pad(metric, 22)}${padL(all.length, 7)}  (too few labeled samples)`); continue; }
      const bk = buckets(all, nb); const ob = buckets(oos, nb);
      const c = corr(all), m = monotone(bk);
      const loA = (bk[0].avg * 100).toFixed(2) + '%', hiA = (bk[bk.length - 1].avg * 100).toFixed(2) + '%';
      const loO = ob ? (ob[0].avg * 100).toFixed(2) + '%' : 'n/a', hiO = ob ? (ob[ob.length - 1].avg * 100).toFixed(2) + '%' : 'n/a';
      console.log(`${pad(metric, 22)}${padL(all.length, 7)}${padL(round(c, 3), 8)}${padL(round(m, 2), 7)}${padL(loA, 11)}${padL(hiA, 11)}${padL(loO, 9)}${padL(hiO, 9)}`);
    }
    console.log(`\n  Read: a real signal has |corr| meaningfully >0, |mono|≈1 (clean gradient), and the hi vs lo`);
    console.log(`  bucket spread HOLDS in the OOS columns. Flat/!=-sign OOS = noise. Split at ${splitDate} (70/30 by date).`);
    console.log(`  Early on, samples are thin — this sharpens as the world layer records more days/features.\n`);
  } finally { await pool.end(); }
})().catch((e) => { console.error('mine failed:', e); process.exit(1); });
