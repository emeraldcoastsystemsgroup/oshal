/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the FIRST scheduled-event study (the fundamental-overlay path that survives the 07-14 event-pop closure: a calendar, not a latency race). Historical Nasdaq earnings dates × market-adjusted forward returns, split by holding THROUGH the print vs AFTER it, with tail/dispersion stats and a SAME-SYMBOL RANDOM-TIME control. Needs NO consensus data. A no-initiate/size-down gate is proposed ONLY if the evidence earns it.
 */

/**
 * Earnings-proximity event study — is holding INTO a scheduled earnings print a risk we're being
 * paid for, or an uncompensated coin flip?
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/oshal-trading-earnings-proximity-study.ts [months=12]
 *
 * The question the operator's framework asks, in its simplest honest form: the calendar tells us
 * WHEN (we already ingest it — 68 earnings in the next 30 days). Before we can score a SURPRISE
 * (needs consensus data), we can measure whether event PROXIMITY alone conditions the outcome.
 *
 * PRE-REGISTERED DECISION RULE (stated before any number is computed):
 *   GATE (build a no-initiate / size-down rule) iff holding through the print is BOTH
 *     (a) not paid: mean market-adjusted through-print return <= +0.20%, AND
 *     (b) materially riskier: |through-print| stdev >= 1.5x the same-symbol random-time control's,
 *         or the 5th-percentile (left-tail) loss is >= 1.5x worse than the control's.
 *   ALPHA (a directional bet, not a gate) iff the through-print mean >= +0.40% AND beats the
 *     same-symbol random-time control by >= 0.30pp with permutation p < 0.05.
 *   Otherwise NO CHANGE — the print is neither an edge nor an extra risk worth a rule.
 *
 * Writes docs/evidence/earnings-proximity-<date>.md and prints a RESULT json line.
 *
 * @module scripts/oshal-trading-earnings-proximity-study
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_UNIVERSE } from '../src/features/trading';

const MONTHS = Math.max(3, Math.min(24, Number(process.argv[2] || 12)));
const DATA = 'https://data.alpaca.markets';
const NASDAQ_UA = process.env.WORLD_EARNINGS_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const PERM_ITERS = 2000;

const keys = () => ({
  id: (process.env.ALPACA_LIVE_KEY_ID || process.env.ALPACA_PAPER_KEY_ID || process.env.ALPACA_KEY || '').trim(),
  secret: (process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_SECRET || '').trim(),
});
const H = () => ({ 'APCA-API-KEY-ID': keys().id, 'APCA-API-SECRET-KEY': keys().secret });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const stdev = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)))]; };

/** Nasdaq earnings calendar for one date → symbols reporting (same source the world collector uses). */
async function earningsOn(date: string): Promise<string[]> {
  try {
    const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: { 'User-Agent': NASDAQ_UA, Accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json() as { data?: { rows?: Array<{ symbol?: string }> | null } };
    return (j.data?.rows || []).map((row) => String(row.symbol || '').toUpperCase()).filter(Boolean);
  } catch { return []; }
}

async function fetchDailies(symbols: string[], startIso: string): Promise<Map<string, Array<{ d: string; c: number }>>> {
  const out = new Map<string, Array<{ d: string; c: number }>>();
  const endParam = `&end=${encodeURIComponent(new Date(Date.now() - 16 * 60 * 1000).toISOString())}`;
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100).join(',');
    let pageToken = '';
    for (let page = 0; page < 25; page++) {
      const url = `${DATA}/v2/stocks/bars?symbols=${encodeURIComponent(batch)}&timeframe=1Day&start=${startIso}${endParam}&limit=10000&adjustment=all&feed=sip${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await fetch(url, { headers: H() });
      if (!r.ok) { console.error(`  bars ${r.status}`); break; }
      const j = await r.json() as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
      for (const [sym, arr] of Object.entries(j.bars || {})) {
        const prev = out.get(sym) || [];
        out.set(sym, prev.concat((arr || []).map((b) => ({ d: String(b.t).slice(0, 10), c: Number(b.c) }))));
      }
      if (!j.next_page_token) break;
      pageToken = j.next_page_token;
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (!keys().id) { console.error('FAIL: no Alpaca keys'); process.exit(1); }
  console.log(`# Earnings-proximity study — run ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Universe ${DEFAULT_UNIVERSE.length} · ${MONTHS} months · Nasdaq earnings calendar × SIP dailies`);
  console.log(`RULE (pre-registered): GATE iff through-print mean <= +0.20% AND (stdev >= 1.5x control OR p5 loss >= 1.5x worse).`);
  console.log(`ALPHA iff mean >= +0.40% AND beats same-symbol random-time control by >= 0.30pp with p < 0.05. Else NO CHANGE.\n`);

  // 1) Prices (fetch first — the session calendar comes from SPY).
  const startIso = new Date(Date.now() - (MONTHS * 30.44 + 40) * 864e5).toISOString().slice(0, 10);
  console.log('## Fetching SIP dailies…');
  const dailies = await fetchDailies([...DEFAULT_UNIVERSE, 'SPY'], startIso);
  const spy = dailies.get('SPY') || [];
  const sessions = spy.map((b) => b.d);
  const sIdx = new Map(sessions.map((d, i) => [d, i]));
  const spyC = spy.map((b) => b.c);
  const closes = new Map<string, Map<string, number>>();
  for (const [sym, bars] of dailies) closes.set(sym, new Map(bars.map((b) => [b.d, b.c])));
  console.log(`  ${sessions.length} sessions (${sessions[0]} → ${sessions[sessions.length - 1]})\n`);

  // 2) The earnings calendar, scanned per session date (the same Nasdaq source the world collector uses).
  console.log('## Fetching the historical earnings calendar (per session)…');
  const uni = new Set(DEFAULT_UNIVERSE.map((s) => s.toUpperCase()));
  const scanDates = sessions.filter((_, i) => i >= 30 && i < sessions.length - 30); // room for pre/post windows
  const events: Array<{ sym: string; idx: number; date: string }> = [];
  for (let i = 0; i < scanDates.length; i++) {
    const d = scanDates[i];
    const syms = await earningsOn(d);
    for (const s of syms) if (uni.has(s)) events.push({ sym: s, idx: sIdx.get(d) as number, date: d });
    if (i % 40 === 39) console.log(`  …${i + 1}/${scanDates.length} dates, ${events.length} events`);
    await sleep(120); // be gentle with the free Nasdaq endpoint
  }
  console.log(`  ${events.length} earnings events in the universe\n`);
  if (events.length < 30) { console.log('Too few events to judge — aborting (no verdict).'); return; }

  /** Market-adjusted return (%) from session i to i+h. */
  const excess = (sym: string, i: number, h: number): number | null => {
    if (i < 0 || i + h >= sessions.length || i + h < 0) return null;
    const m = closes.get(sym);
    const c0 = m?.get(sessions[i]); const c1 = m?.get(sessions[i + h]);
    if (!c0 || !c1) return null;
    return ((c1 / c0 - 1) - (spyC[i + h] / spyC[i] - 1)) * 100;
  };

  // 3) THROUGH the print: hold from 2 sessions before to 2 after (captures the gap).
  //    AFTER the print: the 5 sessions following it (the post-event drift, no event risk).
  const through: number[] = []; const after: number[] = [];
  for (const e of events) {
    const t = excess(e.sym, e.idx - 2, 4);
    if (t != null) through.push(t);
    const a = excess(e.sym, e.idx + 1, 5);
    if (a != null) after.push(a);
  }

  // 4) SAME-SYMBOL RANDOM-TIME control on the identical 4-session holding period.
  const rand = mulberry32(98_2026);
  const pool = new Map<string, number[]>();
  for (const e of events) {
    if (pool.has(e.sym)) continue;
    const m = closes.get(e.sym);
    const valid: number[] = [];
    for (let i = 0; i + 4 < sessions.length; i++) if (m?.get(sessions[i]) && m?.get(sessions[i + 4])) valid.push(i);
    pool.set(e.sym, valid);
  }
  const controlMeans: number[] = [];
  let controlAll: number[] = [];
  for (let it = 0; it < PERM_ITERS; it++) {
    const xs: number[] = [];
    for (const e of events) {
      const v = pool.get(e.sym) || [];
      if (!v.length) continue;
      const x = excess(e.sym, v[Math.floor(rand() * v.length)], 4);
      if (x != null) xs.push(x);
    }
    if (xs.length) { controlMeans.push(mean(xs)); if (it < 40) controlAll = controlAll.concat(xs); }
  }
  const cMean = mean(controlMeans);
  const cStd = stdev(controlAll);
  const cP5 = pct(controlAll, 5);
  const tMean = mean(through);
  const tStd = stdev(through);
  const tP5 = pct(through, 5);
  const p = controlMeans.length ? controlMeans.filter((m) => m >= tMean).length / controlMeans.length : 1;

  console.log('## THROUGH the print (hold −2 → +2 sessions, market-adjusted)');
  console.log(`  n=${through.length}  mean ${tMean.toFixed(3)}%  stdev ${tStd.toFixed(2)}  5th-pct ${tP5.toFixed(2)}%  win ${Math.round((through.filter((x) => x > 0).length / Math.max(1, through.length)) * 100)}%`);
  console.log('## Same-symbol RANDOM-TIME control (identical 4-session hold)');
  console.log(`  mean ${cMean.toFixed(3)}%  stdev ${cStd.toFixed(2)}  5th-pct ${cP5.toFixed(2)}%  · perm p=${p.toFixed(4)}`);
  console.log(`  → volatility ratio ${(tStd / (cStd || 1)).toFixed(2)}x · left-tail ratio ${(Math.abs(tP5) / Math.abs(cP5 || 1)).toFixed(2)}x · edge ${(tMean - cMean >= 0 ? '+' : '')}${(tMean - cMean).toFixed(3)}pp`);
  console.log(`\n## AFTER the print (hold +1 → +6 sessions — post-event drift, no event risk)`);
  console.log(`  n=${after.length}  mean ${mean(after).toFixed(3)}%  stdev ${stdev(after).toFixed(2)}`);

  const volRatio = tStd / (cStd || 1);
  const tailRatio = Math.abs(tP5) / Math.abs(cP5 || 1);
  const edge = tMean - cMean;
  const gate = tMean <= 0.2 && (volRatio >= 1.5 || tailRatio >= 1.5);
  const alpha = tMean >= 0.4 && edge >= 0.3 && p < 0.05;
  const verdict = alpha ? 'ALPHA' : gate ? 'GATE' : 'NO CHANGE';
  console.log(`\n## VERDICT (pre-registered): ${verdict}`);
  console.log(alpha ? '   → Holding through the print is PAID. Do not gate; consider it a positive event tilt (needs a shadow leg first).'
    : gate ? '   → Holding through the print is UNCOMPENSATED RISK. Build the no-initiate / size-down gate (flag-gated, paper-first).'
    : '   → The print is neither an edge nor materially extra risk on this sample. No rule; revisit with consensus data (surprise scoring).');

  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join('docs', 'evidence', `earnings-proximity-${date}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [
    `# Earnings-proximity study — ${date}`, '',
    `The FIRST scheduled-event test (the fundamental-overlay path that survives the 07-14 event-pop closure:`,
    `a calendar, not a latency race). ${MONTHS} months, universe ${DEFAULT_UNIVERSE.length}, Nasdaq earnings`,
    `calendar × SIP dailies, market-adjusted (minus SPY). **Needs no consensus data** — it asks whether event`,
    `PROXIMITY alone conditions the outcome, before we can score a SURPRISE.`, '',
    `**Pre-registered rule:** GATE iff through-print mean ≤ +0.20% AND (stdev ≥ 1.5× control OR p5 loss ≥ 1.5× worse).`,
    `ALPHA iff mean ≥ +0.40%, edge ≥ 0.30pp over the same-symbol random-time control, p < 0.05. Else NO CHANGE.`, '',
    `| window | n | mean % | stdev | 5th pct | `, `|---|---|---|---|---|`,
    `| THROUGH the print (−2 → +2) | ${through.length} | **${tMean.toFixed(3)}** | ${tStd.toFixed(2)} | ${tP5.toFixed(2)} |`,
    `| same-symbol random-time control | ${through.length} | ${cMean.toFixed(3)} | ${cStd.toFixed(2)} | ${cP5.toFixed(2)} |`,
    `| AFTER the print (+1 → +6) | ${after.length} | ${mean(after).toFixed(3)} | ${stdev(after).toFixed(2)} | ${pct(after, 5).toFixed(2)} |`, '',
    `- volatility ratio (through / control): **${volRatio.toFixed(2)}×**`,
    `- left-tail ratio (|p5| through / |p5| control): **${tailRatio.toFixed(2)}×**`,
    `- edge over control: **${edge >= 0 ? '+' : ''}${edge.toFixed(3)}pp** · permutation p = ${p.toFixed(4)}`, '',
    `## Verdict: **${verdict}**`, '',
    'Honest limits: daily closes; the Nasdaq calendar does not distinguish before-open vs after-close prints,',
    'so the −2→+2 window is deliberately wide enough to contain the gap either way; no consensus/surprise data',
    '(that is the next input, and the reason the connector exists); one tape, one regime.', '',
  ].join('\n'));
  console.log(`\nEvidence: ${outPath}`);
  console.log(`RESULT ${JSON.stringify({ verdict, events: events.length, throughMean: +tMean.toFixed(3), controlMean: +cMean.toFixed(3), volRatio: +volRatio.toFixed(2), tailRatio: +tailRatio.toFixed(2), p: +p.toFixed(4) })}`);
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
