/**
 * Trend-exhaustion backtest — "ADX ≥ 40 + RSI extreme → jettison the winner on the first break."
 *
 * Tests an operator-sourced exit rule (2026-07-22, relayed from a trader friend). The claim, as
 * stated: RSI alone is a bad mean-reversion trigger because a strong tape stays pinned at the high
 * end for weeks. But when ADX ≥ 40 — a genuinely extended trend — an RSI extreme marks exhaustion,
 * so once you also have a good profit you should sell the FIRST time the indicator rolls over,
 * bank it, and use a looser re-entry to get back in if the trend resumes.
 *
 * PRE-REGISTERED before running (no post-hoc knob search):
 *   ADX_HOT 40, RSI_HOT 75, MIN_GAIN +5%, break = RSI ticks down AND close < prior close,
 *   re-entry = RSI back above 55 with +DI > −DI and an up close, inside a 15-session window.
 *   All are the values named in the source claim or classic defaults — none were fitted.
 *
 * Two parts, because they answer different questions:
 *
 *   PART 1 — EVENT STUDY. Does the reversion exist at all? For every (symbol, day) the trigger
 *   fires, measure the forward 5/10/20-session return. Judged against a SAME-SYMBOL RANDOM-TIME
 *   control with a matched event count (repo doctrine after the event-pop family was closed: an
 *   event claim must beat a random-time control on the same names, not merely be non-zero).
 *   Two ablation cohorts isolate which half of the gate does the work — RSI-only and ADX-only.
 *
 *   PART 2 — PORTFOLIO WALK. Even a real reversion only matters if it beats the exits we already
 *   run. Six books over the same tape with IDENTICAL entries, sizing and rotation; only the exit
 *   overlay differs. Book A is the live engine (5% stop / 8% TP / trail arm 5 giveback 3) as the
 *   control. The placebo book D sells winners at RANDOM times at the same hazard rate as B, which
 *   separates "this rule is smart" from "selling winners early happened to work in this window".
 *
 * HONEST LIMITS (same as every sibling harness): Alpaca free IEX history (floor ~2020-07-27),
 * survivors-only universe, same-close fills, no slippage or commission, one window with n≈2 bear
 * episodes. Books diverge in holdings over time — inherent to comparing full simulations. This is
 * decision support for an exit rule, not proof of alpha; anything that wins here still goes to
 * paper before live under the live==paper parity rule.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-adx-exhaustion-backtest.ts
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Wilder RSI/ADX/DMI over deep-history OHLCV, event study with a matched same-symbol random-time control plus RSI-only/ADX-only ablations, and a 6-book portfolio walk (live-engine control, exhaustion exit, exhaustion + eased re-entry, random-time placebo at B's hazard, and the two single-gate ablations).
 */
import 'dotenv/config';
import { barsBatchSinceOhlcv, DEFAULT_UNIVERSE, type DatedOhlcvBar } from '@/features/trading';
import { decideSymbol, type MtfDecision } from '../src/features/trading/services/multi-timeframe';
import { sizeEntry, rotationBenches, RISK_POLICIES, type NameStrength } from '../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../src/features/trading/services/broker-adapter';

// Window / feed are env-overridable so the SAME trigger, indicator and control code can be
// replayed on an out-of-sample tape (the point of an OOS test is new DATA through unchanged CODE).
// Defaults reproduce the in-sample discovery run exactly when no env is set.
//   ADX_START_ISO   fetch/warmup start (default 2020-07-01)
//   ADX_REPORT_FROM first session events are counted from (default 2021-06-01)
//   ADX_END_ISO     exclusive cutoff — cap the tape before a later window (default: last completed session)
//   ADX_FEED        'iex' (default) or 'sip' (consolidated tape; reaches back to 2016-01)
//   ADX_EVENT_ONLY  '1' → run Part 1 (event study) only and skip the portfolio walk
const START_ISO = process.env.ADX_START_ISO || '2020-07-01';
const REPORT_FROM = process.env.ADX_REPORT_FROM || '2021-06-01';
const END_ISO = process.env.ADX_END_ISO || '';
const FEED: 'iex' | 'sip' = process.env.ADX_FEED === 'sip' ? 'sip' : 'iex';
const EVENT_ONLY = process.env.ADX_EVENT_ONLY === '1';
const START_CASH = 100_000;
const MAX_NEW_PER_DAY = 8;
const policy = RISK_POLICIES.active;
const TRAIL_ARM = policy.trailArmPct;           // 5 — live engine
const TRAIL_GIVEBACK = policy.trailGivebackPct; // 3 — live engine
const HARD_STOP = 5, TAKE_PROFIT = 8;           // live engine

/** Pre-registered rule constants — the operator's stated numbers, declared before the walk. */
const ADX_HOT = 40;      // "whenever you get above forty on the ADX, that's a very high trending market"
const RSI_HOT = 75;      // "when the relative strength is near a hundred"
const MIN_GAIN = 5;      // "you got a good profit on that position"
const REENTRY_RSI = 55;  // "it only comes down to seventy five or whatever, but ... moving back to the upside"
const REENTRY_WINDOW = 15; // sessions the eased re-entry stays available after an exhaustion exit
const FWD_HORIZONS = [5, 10, 20];
const PRIOR_RUN_DAYS = 10; // event study's stand-in for "a good profit" — prior 10-session return

const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);
const avg = (v: number[]): number => v.reduce((s, x) => s + x, 0) / (v.length || 1);

/** Deterministic PRNG (mulberry32) — the placebo/control books must be reproducible run to run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Indicators — Wilder smoothing throughout, computed ONCE per symbol as full
// series aligned to bar index (recomputing per day would dominate runtime).
// ─────────────────────────────────────────────────────────────────────────────

/** Wilder RSI-14 aligned to bar index; entries before the seed window are null. */
function rsiSeries(bars: DatedOhlcvBar[], n = 14): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (bars.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** One bar's ADX/DMI reading. */
interface DmiPoint { adx: number; pdi: number; mdi: number }

/**
 * Wilder ADX-14 with +DI/−DI, aligned to bar index. Same math as the ADR-096 shadow `adx`
 * indicator in algorithms.ts (its helpers are module-private), evaluated as a series.
 */
function dmiSeries(bars: DatedOhlcvBar[], n = 14): Array<DmiPoint | null> {
  const out: Array<DmiPoint | null> = new Array(bars.length).fill(null);
  if (bars.length < 2 * n + 2) return out;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
    const up = b.h - p.h, dn = p.l - b.l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  // Wilder seed = sum of the first n, then prev − prev/n + current.
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 0; i < n; i++) { sTR += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dx: Array<{ i: number; v: number; pdi: number; mdi: number }> = [];
  for (let i = n; i < tr.length; i++) {
    sTR = sTR - sTR / n + tr[i]; sP = sP - sP / n + pdm[i]; sM = sM - sM / n + mdm[i];
    const pdi = sTR > 0 ? (100 * sP) / sTR : 0;
    const mdi = sTR > 0 ? (100 * sM) / sTR : 0;
    dx.push({ i: i + 1, v: pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0, pdi, mdi });
  }
  if (dx.length < n) return out;
  let adx = avg(dx.slice(0, n).map((x) => x.v));
  out[dx[n - 1].i] = { adx, pdi: dx[n - 1].pdi, mdi: dx[n - 1].mdi };
  for (let k = n; k < dx.length; k++) {
    adx = (adx * (n - 1) + dx[k].v) / n;
    out[dx[k].i] = { adx, pdi: dx[k].pdi, mdi: dx[k].mdi };
  }
  return out;
}

/** Everything precomputed for one symbol: bars, indicator series, and a date→index map. */
interface SymbolTape {
  bars: DatedOhlcvBar[];
  rsi: Array<number | null>;
  dmi: Array<DmiPoint | null>;
  idx: Map<string, number>;
}

/** Which half of the gate a cohort uses — the ablation axis. */
type Gate = 'both' | 'rsi-only' | 'adx-only';

/**
 * @description Does bar `i` satisfy the exhaustion ARM condition under the given gate? Arming is
 * the "extended and overbought" state; it does not itself sell.
 */
function armed(t: SymbolTape, i: number, gate: Gate): boolean {
  const r = t.rsi[i], d = t.dmi[i];
  if (r == null || d == null) return false;
  const hotRsi = r >= RSI_HOT, hotAdx = d.adx >= ADX_HOT && d.pdi > d.mdi;
  if (gate === 'rsi-only') return hotRsi;
  if (gate === 'adx-only') return hotAdx;
  return hotRsi && hotAdx;
}

/**
 * @description The BREAK: the indicator rolls over and price confirms it on the same bar. This is
 * The operator's "sell at that first break after your indicator set back up" — deliberately a
 * two-of-two confirmation so a single flat bar inside a strong trend does not eject the position.
 */
function broke(t: SymbolTape, i: number): boolean {
  const r = t.rsi[i], rPrev = t.rsi[i - 1];
  if (r == null || rPrev == null) return false;
  return r < rPrev && t.bars[i].c < t.bars[i - 1].c;
}

/**
 * @description The eased re-entry: after an exhaustion exit, the trend is presumed intact, so a
 * turn back up re-arms a long without waiting for the full ensemble to print a fresh buy.
 */
function reentryReady(t: SymbolTape, i: number): boolean {
  const r = t.rsi[i], rPrev = t.rsi[i - 1], d = t.dmi[i];
  if (r == null || rPrev == null || d == null) return false;
  return r >= REENTRY_RSI && r > rPrev && d.pdi > d.mdi && t.bars[i].c > t.bars[i - 1].c;
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — event study
// ─────────────────────────────────────────────────────────────────────────────

/** Forward-return sample for one triggered event (or one control draw). */
interface Sample { fwd: number[]; d: string }

/** Mean, median, share-negative and a one-sample t-stat for a forward-return column. */
function describe(vals: number[]): { n: number; mean: number; med: number; negPct: number; t: number } {
  const n = vals.length;
  if (!n) return { n: 0, mean: 0, med: 0, negPct: 0, t: 0 };
  const s = [...vals].sort((a, b) => a - b);
  const mean = avg(vals);
  const sd = Math.sqrt(avg(vals.map((v) => (v - mean) ** 2))) || 1e-9;
  return { n, mean, med: s[Math.floor(n / 2)], negPct: (vals.filter((v) => v < 0).length / n) * 100, t: (mean / (sd / Math.sqrt(n))) };
}

/** Welch t-stat between two independent samples — event cohort vs its random-time control. */
function welch(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const ma = avg(a), mb = avg(b);
  const va = avg(a.map((v) => (v - ma) ** 2)) * (a.length / (a.length - 1));
  const vb = avg(b.map((v) => (v - mb) ** 2)) * (b.length / (b.length - 1));
  return (ma - mb) / (Math.sqrt(va / a.length + vb / b.length) || 1e-9);
}

/** Forward percent returns from bar i, or null when the tape runs out. */
function forwardReturns(t: SymbolTape, i: number): number[] | null {
  const out: number[] = [];
  for (const h of FWD_HORIZONS) {
    if (i + h >= t.bars.length) return null;
    out.push((t.bars[i + h].c / t.bars[i].c - 1) * 100);
  }
  return out;
}

/**
 * @description Scan one symbol for trigger days under a gate. A trigger requires the arm condition
 * to have been satisfied on this bar or an earlier bar of the same armed run (sticky, matching
 * "once you get above forty ... I'm gonna jettison that thing"), the prior-run profit filter, and
 * the break on this bar. Returns trigger bar indices.
 */
function triggerDays(t: SymbolTape, gate: Gate, from: number): number[] {
  const hits: number[] = [];
  let sticky = false;
  for (let i = Math.max(from, PRIOR_RUN_DAYS + 1); i < t.bars.length; i++) {
    if (armed(t, i, gate)) sticky = true;
    if (!sticky || !broke(t, i)) continue;
    sticky = false; // the break consumes the arm either way — a missed profit gate is not a trigger
    if ((t.bars[i].c / t.bars[i - PRIOR_RUN_DAYS].c - 1) * 100 >= MIN_GAIN) hits.push(i);
  }
  return hits;
}

/** Collect forward-return samples for a cohort across every symbol. */
function cohort(tapes: Map<string, SymbolTape>, gate: Gate, from: (t: SymbolTape) => number): Sample[] {
  const out: Sample[] = [];
  for (const t of tapes.values()) {
    for (const i of triggerDays(t, gate, from(t))) {
      const fwd = forwardReturns(t, i);
      if (fwd) out.push({ fwd, d: t.bars[i].d });
    }
  }
  return out;
}

/**
 * @description Same-symbol random-time control: for each symbol draw exactly as many uniformly
 * random eligible days as that symbol produced triggers, so the control matches the event cohort
 * in BOTH count and name mix. This is the bar an event claim has to clear in this repo.
 */
function randomControl(tapes: Map<string, SymbolTape>, gate: Gate, from: (t: SymbolTape) => number, seed: number): Sample[] {
  const rnd = mulberry32(seed);
  const out: Sample[] = [];
  for (const t of tapes.values()) {
    const k = triggerDays(t, gate, from(t)).length;
    if (!k) continue;
    const lo = Math.max(from(t), PRIOR_RUN_DAYS + 1);
    const hi = t.bars.length - Math.max(...FWD_HORIZONS) - 1;
    if (hi <= lo) continue;
    for (let j = 0; j < k; j++) {
      const i = lo + Math.floor(rnd() * (hi - lo));
      const fwd = forwardReturns(t, i);
      if (fwd) out.push({ fwd, d: t.bars[i].d });
    }
  }
  return out;
}

/** Print one cohort's forward-return table, optionally with a Welch test against a control. */
function reportCohort(label: string, s: Sample[], ctrl?: Sample[]): void {
  console.log(`\n  ${label}  (n=${s.length})`);
  if (!s.length) { console.log('    no events'); return; }
  FWD_HORIZONS.forEach((h, k) => {
    const d = describe(s.map((x) => x.fwd[k]));
    const tail = ctrl?.length ? `   vs control Δ ${(d.mean - avg(ctrl.map((x) => x.fwd[k]))).toFixed(2)} pts (Welch t ${welch(s.map((x) => x.fwd[k]), ctrl.map((x) => x.fwd[k])).toFixed(2)})` : '';
    console.log(`    +${String(h).padStart(2)}d  mean ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(2)}%  median ${d.med >= 0 ? '+' : ''}${d.med.toFixed(2)}%  negative ${d.negPct.toFixed(0)}%  t ${d.t.toFixed(2)}${tail}`);
  });
}

/**
 * @description Market regime per session date: 'risk-on' when SPY closed above its 200-day
 * average, 'risk-off' otherwise. The whole test window is a strong bull tape, so a "the trend
 * continues" finding has to be shown to survive the risk-off half or it is a bull artifact.
 */
function regimeByDate(spyBars: DatedOhlcvBar[]): Map<string, 'risk-on' | 'risk-off'> {
  const out = new Map<string, 'risk-on' | 'risk-off'>();
  for (let i = 199; i < spyBars.length; i++) {
    const sma = avg(spyBars.slice(i - 199, i + 1).map((b) => b.c));
    out.set(spyBars[i].d, spyBars[i].c > sma ? 'risk-on' : 'risk-off');
  }
  return out;
}

/** Split a cohort and its control by regime and report each half against its own control. */
function reportByRegime(label: string, s: Sample[], ctrl: Sample[], regime: Map<string, 'risk-on' | 'risk-off'>): void {
  for (const r of ['risk-on', 'risk-off'] as const) {
    const pick = (x: Sample[]): Sample[] => x.filter((v) => regime.get(v.d) === r);
    const sr = pick(s), cr = pick(ctrl);
    // Distinct months = a floor on how INDEPENDENT these events are. Events cluster inside an
    // episode and their forward windows overlap, so n overstates the effective sample badly.
    const months = new Set(sr.map((x) => x.d.slice(0, 7))).size;
    console.log(`\n  ${label} — ${r.toUpperCase()} (SPY ${r === 'risk-on' ? 'above' : 'below'} its 200dma)  (n=${sr.length} across ${months} distinct months, control n=${cr.length})`);
    if (!sr.length || !cr.length) { console.log('    too few events'); continue; }
    FWD_HORIZONS.forEach((h, k) => {
      const a = sr.map((x) => x.fwd[k]), b = cr.map((x) => x.fwd[k]);
      const d = describe(a);
      console.log(`    +${String(h).padStart(2)}d  mean ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(2)}%  median ${d.med >= 0 ? '+' : ''}${d.med.toFixed(2)}%  negative ${d.negPct.toFixed(0)}%   vs control ${avg(b) >= 0 ? '+' : ''}${avg(b).toFixed(2)}%  Δ ${(d.mean - avg(b)).toFixed(2)} pts (Welch t ${welch(a, b).toFixed(2)})`);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — portfolio walk
// ─────────────────────────────────────────────────────────────────────────────

interface Lot { qty: number; entry: number; peak: number; sticky: boolean }
/** Exit overlay under test — everything else about a book is the live engine. */
interface Overlay {
  gate?: Gate;          // exhaustion gate; absent = no exhaustion exit
  easedReentry?: boolean;
  placeboHazard?: number; // per-eligible-lot-day probability of a random exit (control book D)
}
interface Book {
  name: string; overlay: Overlay;
  cash: number; lots: Map<string, Lot>;
  reArm: Map<string, number>; // symbol → session index the eased re-entry window closes
  curve: number[]; peak: number; maxDD: number;
  wins: number; losses: number; trades: number; stopOuts: number; ruleExits: number; reEntries: number;
  eligibleDays: number; // lot-days at ≥ MIN_GAIN — the placebo's matched population
}
const mkBook = (name: string, overlay: Overlay): Book => ({
  name, overlay, cash: START_CASH, lots: new Map(), reArm: new Map(), curve: [], peak: START_CASH,
  maxDD: 0, wins: 0, losses: 0, trades: 0, stopOuts: 0, ruleExits: 0, reEntries: 0, eligibleDays: 0,
});

/** One book's per-symbol context for a single session. */
interface DayCtx { t: SymbolTape; i: number; price: number }

/**
 * @description Run every exit rule for one book on one session: the live engine's stop / take-
 * profit / trailing / signal exits first (so the overlay can only ADD exits, never mask a
 * protective one), then the overlay's exhaustion or placebo exit.
 */
function runExits(book: Book, ctx: Map<string, DayCtx>, decisions: Map<string, MtfDecision>, rnd: () => number, sell: (s: string, p: number, kind: 'stop' | 'rule' | 'plain') => void): void {
  for (const [sym, lot] of [...book.lots]) {
    const c = ctx.get(sym); if (!c) continue;
    const p = c.price;
    lot.peak = Math.max(lot.peak, p);
    const plPct = ((p - lot.entry) / lot.entry) * 100;
    if (plPct <= -HARD_STOP) { sell(sym, p, 'stop'); continue; }
    if (plPct >= TAKE_PROFIT) { sell(sym, p, 'plain'); continue; }
    if (plPct >= TRAIL_ARM && ((lot.peak - p) / lot.peak) * 100 >= TRAIL_GIVEBACK) { sell(sym, p, 'plain'); continue; }
    if (decisions.get(sym)?.action === 'sell') { sell(sym, p, 'plain'); continue; }
    // Arm tracking follows the TAPE, not the P&L — a lot can go extended before it is +5%.
    const gate = book.overlay.gate;
    if (gate && armed(c.t, c.i, gate)) lot.sticky = true;
    if (plPct < MIN_GAIN) { if (gate && broke(c.t, c.i)) lot.sticky = false; continue; }
    book.eligibleDays++;                          // "a good profit" gate — the overlays' population
    if (book.overlay.placeboHazard != null) { if (rnd() < book.overlay.placeboHazard) sell(sym, p, 'rule'); continue; }
    if (gate && lot.sticky && broke(c.t, c.i)) { lot.sticky = false; sell(sym, p, 'rule'); }
  }
}

/** Entry candidates for a book: the shared ensemble buys, plus this book's eased re-entries. */
function entryCandidates(book: Book, ctx: Map<string, DayCtx>, decisions: Map<string, MtfDecision>, t: number): Array<{ symbol: string; confidence: number; eased: boolean }> {
  const buys = [...decisions.values()]
    .filter((d) => d.action === 'buy' && !book.lots.has(d.symbol) && d.price)
    .map((d) => ({ symbol: d.symbol, confidence: d.confidence, eased: false }));
  if (!book.overlay.easedReentry) return buys.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set(buys.map((b) => b.symbol));
  for (const [sym, until] of [...book.reArm]) {
    if (t > until) { book.reArm.delete(sym); continue; }
    if (seen.has(sym) || book.lots.has(sym)) continue;
    const c = ctx.get(sym); if (!c) continue;
    if (decisions.get(sym)?.action === 'sell') continue; // never re-enter into an active sell call
    if (reentryReady(c.t, c.i)) buys.push({ symbol: sym, confidence: decisions.get(sym)?.confidence ?? 0.5, eased: true });
  }
  return buys.sort((a, b) => b.confidence - a.confidence);
}

/** Summary line for one finished book. */
function reportBook(book: Book, lastClose: Map<string, number>): void {
  for (const [sym, lot] of book.lots) book.cash += lot.qty * (lastClose.get(sym) ?? lot.entry);
  const ret = (book.cash / START_CASH - 1) * 100;
  const rets = book.curve.slice(1).map((e, i) => e / book.curve[i] - 1);
  const m = avg(rets);
  const sd = Math.sqrt(avg(rets.map((r) => (r - m) ** 2))) || 1e-9;
  const wr = book.trades ? (book.wins / (book.wins + book.losses)) * 100 : 0;
  console.log(`\n  ${book.name}`);
  console.log(`    return ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   maxDD -${(book.maxDD * 100).toFixed(1)}%   sharpe ${((m / sd) * Math.sqrt(252)).toFixed(2)}   trades ${book.trades}   wr ${wr.toFixed(0)}%   stop-outs ${book.stopOuts}   rule-exits ${book.ruleExits}   re-entries ${book.reEntries}`);
}

/** Everything the walk needs that does not change between passes. */
interface WalkInput {
  calendar: string[];
  tapes: Map<string, SymbolTape>;
  t0: number;
  /** date → per-symbol decisions. Filled on the first pass, reused on the second (decideSymbol
   *  over ~100 names × ~1250 sessions dominates runtime; the placebo pass must not pay it twice). */
  cache: Map<string, Map<string, MtfDecision>>;
}

/** Advance one book by one session: exits, rotation, entries, then mark equity. */
function stepBook(book: Book, ctx: Map<string, DayCtx>, decisions: Map<string, MtfDecision>, strength: Map<string, NameStrength>, lastClose: Map<string, number>, rnd: () => number, t: number): void {
  const mark = (sym: string): number => ctx.get(sym)?.price ?? lastClose.get(sym) ?? 0;
  const sell = (sym: string, p: number, kind: 'stop' | 'rule' | 'plain'): void => {
    const lot = book.lots.get(sym); if (!lot) return;
    book.cash += lot.qty * p;
    if (lot.qty * (p - lot.entry) >= 0) book.wins++; else book.losses++; // scratch = win (sibling-harness convention)
    if (kind === 'stop') book.stopOuts++;
    if (kind === 'rule') { book.ruleExits++; if (book.overlay.easedReentry) book.reArm.set(sym, t + REENTRY_WINDOW); }
    book.trades++;
    book.lots.delete(sym);
  };
  runExits(book, ctx, decisions, rnd, sell);

  const posOf = (): Position[] => [...book.lots].map(([sym, lot]) => {
    const p = mark(sym);
    return { symbol: sym, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: p, marketValue: lot.qty * p, unrealizedPl: lot.qty * (p - lot.entry) };
  });
  for (const b of rotationBenches(posOf(), strength, policy)) {
    const c = ctx.get(b.symbol); if (c) sell(b.symbol, c.price, 'plain');
  }

  const remaining = posOf();
  const account: BrokerAccount = { cash: book.cash, buyingPower: book.cash, equity: book.cash + remaining.reduce((s, p) => s + p.marketValue, 0), currency: 'USD' };
  let placed = 0;
  for (const cand of entryCandidates(book, ctx, decisions, t)) {
    if (placed >= MAX_NEW_PER_DAY) break;
    const c = ctx.get(cand.symbol);
    if (!c || !(c.price > 0) || book.lots.has(cand.symbol)) continue;
    const sized = sizeEntry(cand.symbol, c.price, cand.confidence, account, remaining, policy);
    if (sized.qty <= 0) continue;
    book.cash -= sized.qty * c.price;
    book.lots.set(cand.symbol, { qty: sized.qty, entry: c.price, peak: c.price, sticky: false });
    remaining.push({ symbol: cand.symbol, qty: sized.qty, avgEntryPrice: c.price, currentPrice: c.price, marketValue: sized.qty * c.price, unrealizedPl: 0 });
    if (cand.eased) { book.reEntries++; book.reArm.delete(cand.symbol); }
    placed++;
  }

  const eq = book.cash + [...book.lots].reduce((s, [sym, lot]) => s + lot.qty * mark(sym), 0);
  book.curve.push(eq);
  book.peak = Math.max(book.peak, eq);
  book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak);
}

/**
 * @description Walk the whole tape for a set of books. Entries, sizing and rotation are computed
 * from ONE shared decision set per session, so books can differ only in their exit overlay.
 * @returns Last close per symbol, for marking open lots at the end.
 */
function walk(input: WalkInput, books: Book[], seed: number): Map<string, number> {
  const { calendar, tapes, t0, cache } = input;
  const rnd = mulberry32(seed);
  const lastClose = new Map<string, number>();
  for (let t = 0; t < calendar.length; t++) {
    const date = calendar[t];
    const ctx = new Map<string, DayCtx>();
    const windows = new Map<string, number[]>();
    for (const [sym, tape] of tapes) {
      const i = tape.idx.get(date);
      if (i == null) continue;
      lastClose.set(sym, tape.bars[i].c);
      ctx.set(sym, { t: tape, i, price: tape.bars[i].c });
      if (t >= t0 && !cache.has(date)) windows.set(sym, tape.bars.slice(0, i + 1).map((b) => b.c));
    }
    if (t < t0) continue;
    let decisions = cache.get(date);
    if (!decisions) {
      decisions = new Map<string, MtfDecision>();
      for (const [sym, win] of windows) {
        const tf = new Map([['1Day', win.slice(-220)], ['1Week', resample(win, 5).slice(-60)], ['3Month', resample(win, 63).slice(-40)]] as [import('@/features/trading').Timeframe, number[]][]);
        decisions.set(sym, decideSymbol(sym, tf));
      }
      cache.set(date, decisions);
    }
    const strength = new Map<string, NameStrength>([...decisions].map(([s, d]) => [s, { score: d.score, action: d.action }]));
    for (const book of books) stepBook(book, ctx, decisions, strength, lastClose, rnd, t);
  }
  return lastClose;
}

async function main(): Promise<void> {
  console.log(`Loading daily ${FEED.toUpperCase()} OHLCV since ${START_ISO}${END_ISO ? ` to ${END_ISO}` : ''} for ${DEFAULT_UNIVERSE.length} names + SPY…`);
  const bars = await barsBatchSinceOhlcv([...DEFAULT_UNIVERSE, 'SPY'], START_ISO, FEED, END_ISO);
  // Exclusive cutoff: an explicit ADX_END_ISO (out-of-sample runs cap the tape before the
  // in-sample window), else the last COMPLETED session. Today's bar is dropped either way — while
  // the session is open it is partial, which made results drift between same-day runs and fed a
  // half-formed bar to the indicators.
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const cutoff = END_ISO && END_ISO < todayEt ? END_ISO : todayEt;
  const spySeries = (bars.get('SPY') || []).filter((b) => b.d < cutoff);
  const calendar = spySeries.map((b) => b.d);
  const t0 = calendar.findIndex((d) => d >= REPORT_FROM);
  if (t0 < 200) { console.error(`Insufficient warmup (${t0} sessions before ${REPORT_FROM}).`); process.exit(1); }

  const tapes = new Map<string, SymbolTape>();
  for (const [sym, raw] of bars) {
    const arr = raw.filter((b) => b.d < cutoff);
    if (sym === 'SPY' || arr.length < 260) continue;
    tapes.set(sym, { bars: arr, rsi: rsiSeries(arr), dmi: dmiSeries(arr), idx: new Map(arr.map((b, i) => [b.d, i])) });
  }
  const spy = spySeries.map((b) => b.c);
  console.log(`Window: ${calendar[t0]} → ${calendar[calendar.length - 1]} (${calendar.length - t0} sessions), ${tapes.size} names, feed ${FEED.toUpperCase()}.`);
  console.log(`Rule (pre-registered): ADX≥${ADX_HOT}, RSI≥${RSI_HOT}, prior gain ≥${MIN_GAIN}%, exit on first RSI-down + lower close.`);

  // ── PART 1 ────────────────────────────────────────────────────────────────
  const fromIdx = (t: SymbolTape): number => t.idx.get(calendar[t0]) ?? 60;
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(' PART 1 — EVENT STUDY: forward return after the exhaustion break');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  const both = cohort(tapes, 'both', fromIdx);
  const ctrl = randomControl(tapes, 'both', fromIdx, 20260722);
  reportCohort(`ADX≥${ADX_HOT} + RSI≥${RSI_HOT} + break  ← the claim`, both, ctrl);
  reportCohort('same-symbol RANDOM-TIME control (matched count)', ctrl);
  reportCohort(`ABLATION: RSI≥${RSI_HOT} + break only (no ADX gate)`, cohort(tapes, 'rsi-only', fromIdx), ctrl);
  reportCohort(`ABLATION: ADX≥${ADX_HOT} + break only (no RSI gate)`, cohort(tapes, 'adx-only', fromIdx), ctrl);
  console.log('\n  ── REGIME SPLIT — the window is a bull tape; the finding has to survive the other half ──');
  reportByRegime('the claim', both, ctrl, regimeByDate(spySeries));

  if (EVENT_ONLY) {
    console.log('\n(ADX_EVENT_ONLY=1 — skipping the portfolio walk; this is a signal/OOS validation run.)');
    return;
  }

  // ── PART 2 ────────────────────────────────────────────────────────────────
  // Pass 1 runs every book whose exits are rule-driven. Pass 2 then runs the placebo at the hazard
  // book B ACTUALLY realised (rule-exits per eligible lot-day), so the control matches B in exit
  // count rather than in a proxy rate measured over a different population.
  const input: WalkInput = { calendar, tapes, t0, cache: new Map() };
  const books: Book[] = [
    mkBook('A  live engine (5% stop / 8% TP / trail 5-3)  ← control', {}),
    mkBook(`B  + exhaustion exit (ADX≥${ADX_HOT} & RSI≥${RSI_HOT})`, { gate: 'both' }),
    mkBook('C  + exhaustion exit + eased re-entry', { gate: 'both', easedReentry: true }),
    mkBook(`E  + exhaustion exit, RSI≥${RSI_HOT} only (no ADX)`, { gate: 'rsi-only' }),
    mkBook(`F  + exhaustion exit, ADX≥${ADX_HOT} only (no RSI)`, { gate: 'adx-only' }),
  ];
  console.log('\nWalking books A/B/C/E/F…');
  const lastClose = walk(input, books, 90210);

  const bookB = books[1];
  const hazard = bookB.eligibleDays ? bookB.ruleExits / bookB.eligibleDays : 0;
  console.log(`Walking placebo book D at book B's realised hazard: ${bookB.ruleExits} rule-exits / ${bookB.eligibleDays} eligible lot-days = ${(hazard * 100).toFixed(2)}%/day…`);
  const bookD = mkBook("D  + RANDOM-TIME exit at B's hazard  ← placebo", { placeboHazard: hazard });
  walk(input, [bookD], 424242);
  books.splice(3, 0, bookD);

  const spyRet = (spy[calendar.length - 1] / spy[t0] - 1) * 100;
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(` PART 2 — PORTFOLIO WALK   (SPY buy & hold same window: ${spyRet >= 0 ? '+' : ''}${spyRet.toFixed(1)}%)`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  for (const book of books) reportBook(book, lastClose);
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(' Read B vs A for the rule, B vs D for whether it beats selling winners at random,');
  console.log(' and E/F for which half of the gate earns its place.');
  console.log('══════════════════════════════════════════════════════════════════════════════');
}
main().then(() => process.exit(0)).catch((e) => { console.error('adx-exhaustion backtest failed:', e); process.exit(1); });
