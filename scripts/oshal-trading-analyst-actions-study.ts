/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the pre-registered (2026-07-12) analyst-actions event study: Benzinga wire headlines (real publisher timestamps) over the trading universe, deterministically classified (classifyAnalystHeadline), entry at the first session CLOSE after publication, market-adjusted forward returns at 1/5/25 sessions, SAME-SYMBOL seeded permutation null (1000 iters), date-split robustness, Bonferroni over the 6 pooled cells. Study only — arms nothing.
 */

/**
 * Analyst-actions event study — does the recurring pre-move headline class (upgrades /
 * price-target raises, flagged by the 07-12 news-wire recall test) condition FORWARD returns?
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/oshal-trading-analyst-actions-study.ts [months=12]
 *
 * PRE-REGISTERED DECISION RULE (stated before any number is computed):
 *   PROCEED (build the shadow event-overlay) iff the pooled-UP cell at horizon 1 or 5 sessions
 *   shows mean market-adjusted excess >= +0.20% with permutation p < 0.05/6 (Bonferroni, 6 pooled
 *   cells), the SAME SIGN in both date halves, and n >= 100 events.
 *   MARGINAL (park; re-run with more history) iff p < 0.05 uncorrected with n >= 100 and both
 *   halves agree. Otherwise KILL for sizing purposes.
 *
 * Writes docs/evidence/analyst-actions-study-<date>.md and prints a RESULT json line.
 *
 * @module scripts/oshal-trading-analyst-actions-study
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_UNIVERSE } from '../src/features/trading';
import { classifyAnalystHeadline, ANALYST_UP_CLASSES, type AnalystActionClass } from '../src/features/trading/services/analyst-actions';

const MONTHS = Math.max(3, Math.min(36, Number(process.argv[2] || 12)));
const HORIZONS = [1, 5, 25];
const PERM_ITERS = 1000;
const DATA = 'https://data.alpaca.markets';

const keys = () => ({
  id: (process.env.ALPACA_LIVE_KEY_ID || process.env.ALPACA_PAPER_KEY_ID || process.env.ALPACA_KEY || '').trim(),
  secret: (process.env.ALPACA_LIVE_SECRET_KEY || process.env.ALPACA_PAPER_SECRET_KEY || process.env.ALPACA_SECRET || '').trim(),
});
const H = () => ({ 'APCA-API-KEY-ID': keys().id, 'APCA-API-SECRET-KEY': keys().secret });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic PRNG (mulberry32) — the permutation null must be reproducible run-to-run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface WireItem { headline: string; createdAt: string; symbols: string[] }
interface EventRow { sym: string; cls: AnalystActionClass; dir: 'up' | 'down'; tMs: number; headline: string; entryIdx?: number }

/** Paginated multi-symbol wire fetch (real Benzinga publisher timestamps), ascending. */
async function fetchWire(symbols: string[], startIso: string): Promise<WireItem[]> {
  const out: WireItem[] = [];
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50).join(',');
    let pageToken = '';
    let pages = 0;
    do {
      const url = `${DATA}/v1beta1/news?symbols=${encodeURIComponent(batch)}&start=${encodeURIComponent(startIso)}&limit=50&sort=asc&include_content=false${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await fetch(url, { headers: H() });
      if (r.status === 429) { await sleep(2000); continue; }
      if (!r.ok) { console.error(`  news ${r.status} on batch ${i / 50 + 1} page ${pages}`); break; }
      const j = await r.json() as { news?: Array<{ headline: string; created_at: string; symbols: string[] }>; next_page_token?: string | null };
      for (const n of j.news || []) out.push({ headline: n.headline, createdAt: n.created_at, symbols: n.symbols || [] });
      pageToken = j.next_page_token || '';
      pages++;
      if (pages % 50 === 0) console.log(`  …batch ${i / 50 + 1}/${Math.ceil(symbols.length / 50)}: ${pages} pages, ${out.length} items so far`);
      await sleep(60); // ~16 rps ceiling → well under the 200/min data limit
    } while (pageToken);
    console.log(`  batch ${i / 50 + 1}/${Math.ceil(symbols.length / 50)} done (${out.length} items cumulative)`);
  }
  return out;
}

/** SIP daily closes with session dates (iex fallback), per symbol. */
async function fetchDailies(symbols: string[], startIso: string): Promise<Map<string, Array<{ d: string; c: number }>>> {
  const out = new Map<string, Array<{ d: string; c: number }>>();
  for (const feed of ['sip', 'iex'] as const) {
    try {
      out.clear();
      const endParam = feed === 'sip' ? `&end=${encodeURIComponent(new Date(Date.now() - 16 * 60 * 1000).toISOString())}` : '';
      for (let i = 0; i < symbols.length; i += 100) {
        const batch = symbols.slice(i, i + 100).join(',');
        let pageToken = '';
        for (let page = 0; page < 25; page++) {
          const url = `${DATA}/v2/stocks/bars?symbols=${encodeURIComponent(batch)}&timeframe=1Day&start=${startIso}${endParam}&limit=10000&adjustment=all&feed=${feed}${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
          const r = await fetch(url, { headers: H() });
          if (!r.ok) throw new Error(`bars ${r.status} (${feed})`);
          const j = await r.json() as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
          for (const [sym, arr] of Object.entries(j.bars || {})) {
            const prev = out.get(sym) || [];
            out.set(sym, prev.concat((arr || []).map((b) => ({ d: String(b.t).slice(0, 10), c: Number(b.c) }))));
          }
          if (!j.next_page_token) break;
          pageToken = j.next_page_token;
        }
      }
      if ((out.get('SPY') || []).length > 50) { console.log(`  dailies on feed=${feed}`); return out; }
    } catch (e) { console.error(`  dailies ${feed} failed: ${(e as Error).message}`); }
  }
  return out;
}

/** The event's effective ET date string: published before that day's close → same day, else next. */
function effectiveDate(tMs: number): string {
  const etMs = tMs - 4 * 3600e3; // ET (DST) — analyst notes cluster pre-market; exactness at the minute level is not load-bearing for daily entries
  const d = new Date(etMs);
  const hhmm = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (hhmm >= 16 * 60) d.setUTCDate(d.getUTCDate() + 1); // after the close → next session's close is the entry
  return d.toISOString().slice(0, 10);
}

interface Cell { label: string; n: number; meanPct: number; p: number; firstHalfPct: number; secondHalfPct: number; agree: boolean }

async function main(): Promise<void> {
  if (!keys().id) { console.error('FAIL: no Alpaca keys in env'); process.exit(1); }
  const startIso = new Date(Date.now() - MONTHS * 30.44 * 864e5).toISOString();
  console.log(`# Analyst-actions event study — pre-registered 2026-07-12, run ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Universe ${DEFAULT_UNIVERSE.length} · window ${MONTHS} months · horizons ${HORIZONS.join('/')} sessions · entry = first close after publication`);
  console.log(`DECISION RULE (pre-registered): PROCEED iff pooled-UP @1d or @5d has mean excess >= +0.20%,`);
  console.log(`perm p < ${(0.05 / 6).toFixed(4)} (Bonferroni/6), same sign both date halves, n >= 100. MARGINAL: p<0.05 uncorr. Else KILL.\n`);

  // 1) The wire.
  console.log('## Fetching the wire…');
  const items = await fetchWire([...DEFAULT_UNIVERSE], startIso);
  console.log(`  ${items.length} wire items`);

  // 2) Classify + attribute + dedupe (one event per symbol × effective-date × direction; first wins).
  const uniSet = new Set(DEFAULT_UNIVERSE.map((s) => s.toUpperCase()));
  const seen = new Set<string>();
  const events: EventRow[] = [];
  let classified = 0;
  for (const it of items) {
    const a = classifyAnalystHeadline(it.headline);
    if (!a) continue;
    classified++;
    const tMs = Date.parse(it.createdAt);
    if (!Number.isFinite(tMs)) continue;
    for (const symRaw of it.symbols) {
      const sym = symRaw.toUpperCase();
      if (!uniSet.has(sym)) continue;
      const key = `${sym}|${effectiveDate(tMs)}|${a.dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ sym, cls: a.cls, dir: a.dir, tMs, headline: it.headline });
    }
  }
  const byCls = new Map<string, number>();
  for (const e of events) byCls.set(e.cls, (byCls.get(e.cls) ?? 0) + 1);
  console.log(`  ${classified} classified headlines → ${events.length} deduped events: ${[...byCls.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);

  // 3) Prices.
  console.log('## Fetching SIP dailies…');
  const priceStart = new Date(Date.parse(startIso) - 40 * 864e5).toISOString().slice(0, 10);
  const dailies = await fetchDailies([...DEFAULT_UNIVERSE, 'SPY'], priceStart);
  const spy = dailies.get('SPY') || [];
  const sessions = spy.map((b) => b.d);
  const sessionIdx = new Map(sessions.map((d, i) => [d, i]));
  const spyClose = spy.map((b) => b.c);
  const closesBySym = new Map<string, Map<string, number>>();
  for (const [sym, bars] of dailies) closesBySym.set(sym, new Map(bars.map((b) => [b.d, b.c])));
  console.log(`  ${sessions.length} sessions (${sessions[0]} → ${sessions[sessions.length - 1]})\n`);

  // Entry index per event: first session >= effective date.
  const firstSessionAtOrAfter = (dateStr: string): number => {
    if (sessionIdx.has(dateStr)) return sessionIdx.get(dateStr) as number;
    for (let i = 0; i < sessions.length; i++) if (sessions[i] >= dateStr) return i;
    return -1;
  };
  for (const e of events) e.entryIdx = firstSessionAtOrAfter(effectiveDate(e.tMs));

  /** Market-adjusted forward return (%) for symbol from session i over h sessions, or null. */
  const excess = (sym: string, i: number, h: number): number | null => {
    if (i < 0 || i + h >= sessions.length) return null;
    const m = closesBySym.get(sym);
    const c0 = m?.get(sessions[i]); const c1 = m?.get(sessions[i + h]);
    if (!c0 || !c1) return null;
    const rSym = c1 / c0 - 1;
    const rSpy = spyClose[i + h] / spyClose[i] - 1;
    return (rSym - rSpy) * 100;
  };

  // 4) Cells: pooled UP / pooled DOWN × horizons, permutation-tested; per-class descriptive.
  const rand = mulberry32(96_2026);
  const midMs = events.length ? events.map((e) => e.tMs).sort((a, b) => a - b)[Math.floor(events.length / 2)] : 0;
  const cellFor = (label: string, evs: EventRow[], h: number): Cell => {
    const obs: number[] = []; const first: number[] = []; const second: number[] = [];
    const perSymValid = new Map<string, number[]>(); // valid entry indices for the permutation null
    for (const e of evs) {
      const x = excess(e.sym, e.entryIdx ?? -1, h);
      if (x == null) continue;
      obs.push(x);
      (e.tMs <= midMs ? first : second).push(x);
      if (!perSymValid.has(e.sym)) {
        const m = closesBySym.get(e.sym);
        const valid: number[] = [];
        for (let i = 0; i + h < sessions.length; i++) if (m?.get(sessions[i]) && m?.get(sessions[i + h])) valid.push(i);
        perSymValid.set(e.sym, valid);
      }
    }
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const observed = mean(obs);
    // SAME-SYMBOL permutation: each event re-lands on a random valid session for ITS symbol —
    // controls symbol drift/beta (a high-beta name in a bull tape is "up" at random times too).
    let extreme = 0;
    for (let it = 0; it < PERM_ITERS; it++) {
      let s = 0; let n = 0;
      for (const e of evs) {
        const valid = perSymValid.get(e.sym);
        if (!valid || !valid.length) continue;
        const i = valid[Math.floor(rand() * valid.length)];
        const x = excess(e.sym, i, h);
        if (x != null) { s += x; n++; }
      }
      if (n && Math.abs(s / n) >= Math.abs(observed)) extreme++;
    }
    return {
      label, n: obs.length, meanPct: +observed.toFixed(3), p: +(extreme / PERM_ITERS).toFixed(4),
      firstHalfPct: +mean(first).toFixed(3), secondHalfPct: +mean(second).toFixed(3),
      agree: Math.sign(mean(first)) === Math.sign(mean(second)) && first.length > 0 && second.length > 0,
    };
  };

  const upEvents = events.filter((e) => e.dir === 'up');
  const downEvents = events.filter((e) => e.dir === 'down');
  const cells: Cell[] = [];
  for (const h of HORIZONS) cells.push(cellFor(`pooled-UP @${h}d`, upEvents, h));
  for (const h of HORIZONS) cells.push(cellFor(`pooled-DOWN @${h}d`, downEvents, h));

  console.log('## Pooled cells (market-adjusted mean excess %, same-symbol permutation p)\n');
  for (const c of cells) console.log(`  ${c.label.padEnd(17)} n=${String(c.n).padStart(5)}  mean ${String(c.meanPct).padStart(7)}%  p=${c.p}  halves ${c.firstHalfPct}%/${c.secondHalfPct}% ${c.agree ? 'AGREE' : 'DISAGREE'}`);

  console.log('\n## Per-class breakdown @5d (descriptive)\n');
  const perClass: Cell[] = [];
  for (const k of [...byCls.keys()]) {
    const c = cellFor(`${k} @5d`, events.filter((e) => e.cls === k), 5);
    perClass.push(c);
    console.log(`  ${c.label.padEnd(22)} n=${String(c.n).padStart(5)}  mean ${String(c.meanPct).padStart(7)}%  p=${c.p}`);
  }

  // 5) The pre-registered verdict.
  const bonf = 0.05 / 6;
  const primary = cells.filter((c) => (c.label === 'pooled-UP @1d' || c.label === 'pooled-UP @5d'));
  const proceedCell = primary.find((c) => c.meanPct >= 0.2 && c.p < bonf && c.agree && c.n >= 100);
  const marginalCell = primary.find((c) => c.meanPct >= 0.2 && c.p < 0.05 && c.agree && c.n >= 100);
  const verdict = proceedCell ? 'PROCEED' : marginalCell ? 'MARGINAL' : 'KILL';
  console.log(`\n## VERDICT (pre-registered rule): ${verdict}${proceedCell ? ` on ${proceedCell.label}` : marginalCell ? ` (uncorrected) on ${marginalCell.label}` : ''}`);
  if (verdict === 'PROCEED') console.log('   → Build the SHADOW event-overlay next (recorded sizing signal, ADR-096 promotion bar applies before capital).');
  else if (verdict === 'MARGINAL') console.log('   → Park: extend the window / refine classes and re-run before any overlay work.');
  else console.log('   → No sizing overlay on this class. The recording rail and classifier remain for future event streams.');

  // 6) Evidence doc + RESULT.
  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join('docs', 'evidence', `analyst-actions-study-${date}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [
    `# Analyst-actions event study — ${date}`, '',
    `Pre-registered 2026-07-12 (news-wire recall test); executed ${date}. Universe ${DEFAULT_UNIVERSE.length},`,
    `window ${MONTHS} months, Benzinga wire (real publisher timestamps), deterministic classifier`,
    `(\`classifyAnalystHeadline\`), entry at the first session CLOSE after publication, market-adjusted`,
    `(minus SPY) forward returns, SAME-SYMBOL seeded permutation null (${PERM_ITERS} iters), Bonferroni/6.`, '',
    `**Decision rule (stated before computation):** PROCEED iff pooled-UP @1d or @5d ≥ +0.20% mean excess,`,
    `p < ${bonf.toFixed(4)}, both date halves agree in sign, n ≥ 100. MARGINAL: p < 0.05 uncorrected. Else KILL.`, '',
    `Wire items: ${items.length} · classified: ${classified} · deduped events: ${events.length}`,
    `(${[...byCls.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')})`, '',
    '| cell | n | mean excess % | perm p | 1st half % | 2nd half % | halves |',
    '|---|---|---|---|---|---|---|',
    ...cells.map((c) => `| ${c.label} | ${c.n} | ${c.meanPct} | ${c.p} | ${c.firstHalfPct} | ${c.secondHalfPct} | ${c.agree ? 'agree' : 'DISAGREE'} |`),
    '', '## Per-class @5d (descriptive)', '',
    '| class | n | mean excess % | perm p |', '|---|---|---|---|',
    ...perClass.map((c) => `| ${c.label} | ${c.n} | ${c.meanPct} | ${c.p} |`),
    '', `## Verdict: **${verdict}**`, '',
    'Honest limits: daily closes (no intraday execution modeled); entry at the post-publication close',
    'concedes the day-0 reaction — this measures POST-EVENT DRIFT, the sizeable/tradeable component;',
    'overlapping same-symbol events within a horizon are not de-clustered beyond per-day dedup (the',
    'date-split is the robustness check); SIP dailies with IEX fallback.', '',
  ].join('\n'));
  console.log(`\nEvidence: ${outPath}`);
  console.log(`RESULT ${JSON.stringify({ verdict, events: events.length, cells: cells.map((c) => ({ label: c.label, n: c.n, mean: c.meanPct, p: c.p, agree: c.agree })) })}`);
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
