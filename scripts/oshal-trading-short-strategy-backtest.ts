/**
 * Short-STRATEGY backtest — the purpose-built bear-regime short book, walked over 5+ YEARS.
 *
 * The 2026-07-08 verdict (scripts/oshal-trading-short-backtest.ts): shorting the LONG engine's
 * bearish signals loses in every variant — "not a buy" is not a short. This script tests what the
 * verdict said a real short strategy requires: (1) purpose-built short signals (short-signals.ts:
 * Donchian 55-breakdown + broken trend, ranked by relative weakness), (2) a market-regime gate
 * (SPY < 200-SMA — the book is EMPTY in bull tape), (3) validation across a real bear market —
 * barsBatchSince unlocks 2021→now, which contains the 2022 bear (SPY -25%), the 2023-24 bull, and
 * the 2025 correction. Parameters are the classic literature values, NOT fitted to this data.
 *
 * Books walked simultaneously over the same dates:
 *   S1 gated shorts    — entries only while the bear gate is open; gate closing covers EVERYTHING
 *   S2 ungated shorts  — same signals, no gate (the control that prices the gate's value)
 *   S3 SPY buy & hold  — the benchmark
 *   S4 SPY + S1 shorts — the practical product: hold the market, the short book switches on in
 *                        bear regimes (short proceeds don't buy more SPY; 1x SPY + overlay)
 *
 * Mechanics: DATE-aligned walk (each name maps session-date → close; a name missing a date simply
 * doesn't signal/fill that day and marks at its last known close) — no index-offset class of bug.
 * Decisions at close t fill at close t (the established harness convention). Short risk: 5% hard
 * stop (active posture's number), Donchian-20 cover, 3%/name of equity, 32 max names, 8 entries/
 * day, 1x gross cap at entry, 1%/yr borrow drag on short MV. Report: per-CALENDAR-YEAR returns
 * (objective splits — no cherry-picked windows) + full-window return/maxDD/Sharpe/trades.
 *
 * HONEST LIMITS — every bias with its DIRECTION stated; the net direction is NOT established:
 *  - Survivorship (direction: mixed). Today's DEFAULT_UNIVERSE holds 2026 survivors. Delisted
 *    collapses (max short wins) are absent — hurts shorts. But the roster INCLUDES 2022's crashes
 *    (META/PYPL/SNOW/SHOP/MRNA/ARKG fell 60-95% inside the window) — shorts had real material —
 *    and survivors by construction had the sharpest bear rallies, exactly what stops out a 5%-stop
 *    trend short. A pass here would NOT have been a lower bound; a fail is not automatically damning.
 *  - Same-close fill (direction: flatters shorts). You cannot observe a close and fill at it; real
 *    breakdown-day fills are worse. No slippage/commission (flatters), no locate model (flatters —
 *    and weakest-relative-strength ranking preferentially picks the crowded/special borrows).
 *  - Flat 1%/yr borrow (roughly fair for this liquid large-cap/ETF set; env SHORT_BORROW_PCT).
 *    Negative cash (the S4 margin debit) pays 0% interest (flatters); cash earns no rf (hurts S1,
 *    which is ~80% cash) — Sharpe comparisons across books read S1 LOW.
 *  - Regime sample: essentially n≈2 bear episodes (2022, 2025) — any result is a 2-episode result.
 *    And this is strategy FAMILY #2 tested on this window (after the not-a-buy variants failed):
 *    sequential family search is mild multiple-comparisons; a PASS would have needed out-of-sample
 *    or paper-forward confirmation before money. Same-bar cover→re-entry possible → trade counts
 *    read high; wr counts scratch (pnl==0) trades as wins; S4's short gross is capped at 0.5x
 *    equity (the classic 100/50 overlay), S1/S2 at 1x.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-short-strategy-backtest.ts [startIso]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — multi-year (2021→now) date-aligned walk of the gated short strategy vs ungated control vs SPY vs SPY+overlay, per-calendar-year regime splits, classic untuned parameters, survivorship caveat stated. The bear-regime validation the 07-08 short verdict demanded.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fixes (4-lens verify: look-ahead/accounting/design sound, statistics flawed): real 200-session warmup (START_ISO 2020-01-02 + hard assert — the old 2020-06 start left the gate silently fail-closed ~50 report sessions), gate-open-only return/Sharpe + deployment (avg/peak gross & names) printed for gated books — the actual go-live statistics, zero-price entry guard (a 0-close bar passed donchianBreakdown and Infinity-sized the qty), YTD label on the partial final year, Book.shortsEnabled structural flag replacing the display-label comparison, honest-limits rewritten to state the DIRECTION of every bias (the old "failure is damning" survivorship framing was overstated — the universe contains 2022's 60-95% crashers) + the n≈2-episodes and family-#2 multiple-comparisons disclosures.
 */
import 'dotenv/config';
import { barsBatchSince, DEFAULT_UNIVERSE, marketBearGate, shortEntrySignal, donchianCover, relativeReturn, type DatedClose } from '@/features/trading';

// Alpaca's free IEX daily history has a HARD FLOOR at ~2020-07-27 (rolling ~6y — it silently clamps
// earlier starts; probed 2026-07-08). So the earliest report date with a full 200-session gate
// warmup is ~2021-05-11; we report from 2021-06-01. H1-2021 is lost — a bull stretch where the
// gate would have been closed anyway — while the 2022 bear, 2023-24 bull, and 2025 correction all
// remain inside the window.
const START_ISO = process.argv[2] || '2020-07-01'; // clamped to the API floor; assert below enforces real warmup
const REPORT_FROM = '2021-06-01';
const START_CASH = 100_000;
const MAX_NAMES = 32;
const MAX_NEW_PER_DAY = 8;
const PER_NAME_PCT = 3;      // active posture's per-name budget
const STOP_PCT = 5;          // active posture's hard stop (price UP 5% against the short)
const BORROW_YR = Number(process.env.SHORT_BORROW_PCT || 1.0) / 100;

interface ShortLot { qty: number; entry: number; }
interface Stats { wins: number; losses: number; trades: number; grossWin: number; grossLoss: number; }
interface Book {
  name: string; gated: boolean; spyLeg: boolean;
  /** Structural flag (NOT the display label) — S3 is the pure benchmark and never shorts. */
  shortsEnabled: boolean;
  cash: number; spyQty: number; shorts: Map<string, ShortLot>;
  curve: Array<{ d: string; eq: number; gateOpen: boolean; smv: number; names: number }>;
  peak: number; maxDD: number; stats: Stats;
}
const mkBook = (name: string, gated: boolean, spyLeg: boolean, shortsEnabled = true): Book => ({
  name, gated, spyLeg, shortsEnabled, cash: START_CASH, spyQty: 0, shorts: new Map(),
  curve: [], peak: START_CASH, maxDD: 0, stats: { wins: 0, losses: 0, trades: 0, grossWin: 0, grossLoss: 0 },
});

async function main(): Promise<void> {
  console.log(`Loading daily bars since ${START_ISO} for ${DEFAULT_UNIVERSE.length} names + SPY…`);
  const bars = await barsBatchSince([...DEFAULT_UNIVERSE, 'SPY'], START_ISO);
  const spySeries = bars.get('SPY') || [];
  if (spySeries.length < 260) { console.error(`SPY history too short (${spySeries.length}).`); process.exit(1); }

  // Date-aligned structures: SPY's calendar is the master; each name maps date → index in its own series.
  const calendar = spySeries.map((b) => b.d);
  const nameSeries = new Map<string, DatedClose[]>();
  const nameIdxByDate = new Map<string, Map<string, number>>();
  for (const [sym, arr] of bars) {
    if (sym === 'SPY' || arr.length < 260) continue; // need enough history to ever signal
    nameSeries.set(sym, arr);
    nameIdxByDate.set(sym, new Map(arr.map((b, i) => [b.d, i])));
  }
  const spyCloses = spySeries.map((b) => b.c);
  const t0 = calendar.findIndex((d) => d >= REPORT_FROM);
  if (t0 < 0) { console.error(`No calendar days at/after ${REPORT_FROM}.`); process.exit(1); }
  // The gate needs a FULL 200-session SMA from the first report day — with less it silently
  // fail-closes (forced-flat) inside the reported window, which mis-states the experiment.
  if (t0 < 200) { console.error(`Insufficient warmup: only ${t0} SPY sessions before ${REPORT_FROM}; the SMA200 gate needs 200 (IEX free history floors at ~2020-07-27 — move REPORT_FROM later, not START_ISO earlier).`); process.exit(1); }
  console.log(`Window: ${calendar[t0]} → ${calendar[calendar.length - 1]} (${calendar.length - t0} sessions), ${nameSeries.size} names, borrow ${(BORROW_YR * 100).toFixed(1)}%/yr.\n`);

  const books: Book[] = [
    mkBook('S1 gated shorts (bear-gate)', true, false),
    mkBook('S2 ungated shorts (control)', false, false),
    mkBook('S3 SPY buy & hold', true, true, false), // the pure benchmark — never shorts
    mkBook('S4 SPY + gated short overlay', true, true),
  ];

  // Last known close per name up to the current session (for marking names missing a date).
  const lastClose = new Map<string, number>();

  let gateOpenDays = 0; let reportDays = 0;

  for (let t = 0; t < calendar.length; t++) {
    const date = calendar[t];
    const spyUpTo = spyCloses.slice(0, t + 1);
    const gateOpen = marketBearGate(spyUpTo);

    // Update last-known closes + per-name ascending windows for names trading today.
    const windows = new Map<string, number[]>();
    for (const [sym, idx] of nameIdxByDate) {
      const i = idx.get(date);
      if (i == null) continue;
      const arr = nameSeries.get(sym)!;
      lastClose.set(sym, arr[i].c);
      windows.set(sym, arr.slice(0, i + 1).map((b) => b.c));
    }

    if (t < t0) continue; // warmup: build lastClose/windows, no trading, no marking
    if (gateOpen) gateOpenDays++;
    reportDays++;

    for (const book of books) {
      // SPY leg: buy once at the first report session.
      if (book.spyLeg && book.spyQty === 0) {
        book.spyQty = book.cash / spyCloses[t];
        book.cash = 0;
      }

      if (book.shortsEnabled) {
        // Borrow drag on the open short book.
        const smv = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * (lastClose.get(sym) ?? lot.entry), 0);
        book.cash -= smv * (BORROW_YR / 252);

        const coverAt = (sym: string, px: number) => {
          const lot = book.shorts.get(sym); if (!lot) return;
          const pnl = lot.qty * (lot.entry - px);
          book.cash -= lot.qty * px;
          if (pnl >= 0) { book.stats.wins++; book.stats.grossWin += pnl; } else { book.stats.losses++; book.stats.grossLoss -= pnl; }
          book.stats.trades++;
          book.shorts.delete(sym);
        };

        // Gate slam: the regime turned bullish → cover EVERYTHING at today's (or last known) close.
        if (book.gated && !gateOpen && book.shorts.size) {
          for (const [sym] of [...book.shorts]) coverAt(sym, lastClose.get(sym) ?? book.shorts.get(sym)!.entry);
        }

        // Per-name exits for names trading today: hard stop, then Donchian-20 cover.
        for (const [sym, lot] of [...book.shorts]) {
          const win = windows.get(sym);
          if (!win) continue; // not trading today — no fill possible
          const px = win[win.length - 1];
          if (((px - lot.entry) / lot.entry) * 100 >= STOP_PCT) coverAt(sym, px);
          else if (donchianCover(win)) coverAt(sym, px);
        }

        // Entries: gate (if gated), signal, weakest-relative-return first, capped.
        if (!book.gated || gateOpen) {
          const equity = book.cash + book.spyQty * spyCloses[t]
            - [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * (lastClose.get(sym) ?? lot.entry), 0);
          const grossCap = book.spyLeg ? equity * 0.5 : equity; // overlay book: half-gross shorts
          const perName = (PER_NAME_PCT / 100) * equity;
          const cands: Array<{ sym: string; rel: number; px: number }> = [];
          for (const [sym, win] of windows) {
            if (book.shorts.has(sym)) continue;
            if (!shortEntrySignal(win)) continue;
            const rel = relativeReturn(win, spyUpTo) ?? 0;
            cands.push({ sym, rel, px: win[win.length - 1] });
          }
          cands.sort((a, b) => a.rel - b.rel); // weakest first
          let placed = 0;
          for (const c of cands) {
            if (placed >= MAX_NEW_PER_DAY || book.shorts.size >= MAX_NAMES) break;
            // Zero/garbage-price guard: a bad 0-close bar passes donchianBreakdown (0 < any prior
            // low) and would size qty = floor(x/0) = Infinity → cash = NaN, poisoning the book.
            if (!(c.px > 0)) continue;
            const smvNow = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * (lastClose.get(sym) ?? lot.entry), 0);
            if (smvNow >= grossCap) break;
            const qty = Math.floor(Math.min(perName, grossCap - smvNow) / c.px);
            if (qty < 1) continue;
            book.cash += qty * c.px;
            book.shorts.set(c.sym, { qty, entry: c.px });
            placed++;
          }
        }
      }

      // Mark (with the day's regime + deployment so the report can slice gate-open-only).
      const smv = [...book.shorts].reduce((s, [sym, lot]) => s + lot.qty * (lastClose.get(sym) ?? lot.entry), 0);
      const eq = book.cash + book.spyQty * spyCloses[t] - smv;
      book.curve.push({ d: date, eq, gateOpen, smv, names: book.shorts.size });
      book.peak = Math.max(book.peak, eq);
      book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak);
    }
  }

  /* ── report: full window + per-calendar-year ───────────────────────────────────────── */
  const years = [...new Set(calendar.slice(t0).map((d) => d.slice(0, 4)))];
  console.log('════════════════════════════════════════════════════════════════════════════');
  console.log(` Bear gate open ${gateOpenDays}/${reportDays} sessions (${((gateOpenDays / reportDays) * 100).toFixed(0)}%)`);
  console.log('════════════════════════════════════════════════════════════════════════════');
  const yearRet = (book: Book, y: string): number | null => {
    const inY = book.curve.filter((p) => p.d.slice(0, 4) === y);
    if (!inY.length) return null;
    const prior = book.curve.filter((p) => p.d < inY[0].d);
    const base = prior.length ? prior[prior.length - 1].eq : START_CASH;
    return (inY[inY.length - 1].eq / base - 1) * 100;
  };
  for (const book of books) {
    const final = book.curve[book.curve.length - 1].eq;
    const ret = (final / START_CASH - 1) * 100;
    const rets = book.curve.slice(1).map((p, i) => p.eq / book.curve[i].eq - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
    const s = book.stats;
    const wr = s.trades ? (s.wins / (s.wins + s.losses)) * 100 : 0;
    const pf = s.grossLoss > 0 ? s.grossWin / s.grossLoss : (s.grossWin > 0 ? Infinity : 0);
    console.log(`\n ${book.name}`);
    console.log(`   full ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   maxDD -${(book.maxDD * 100).toFixed(1)}%   sharpe ${((mean / sd) * Math.sqrt(252)).toFixed(2)}`
      + (s.trades ? `   trades ${s.trades} (wr ${wr.toFixed(0)}%, pf ${Number.isFinite(pf) ? pf.toFixed(2) : '∞'})` : ''));
    const lastYear = years[years.length - 1];
    console.log('   ' + years.map((y) => { const r = yearRet(book, y); return `${y}${y === lastYear ? ' (YTD)' : ''} ${r == null ? 'n/a' : (r >= 0 ? '+' : '') + r.toFixed(1) + '%'}`; }).join('   '));
    // The go-live statistic for a GATED book: what the short leg does while it is actually ON,
    // and how deployed it gets — a headline resting on 3 tiny trades must be visible as such.
    if (book.shortsEnabled && book.gated) {
      const open = book.curve.filter((p) => p.gateOpen);
      const openRets: number[] = [];
      for (let i = 1; i < book.curve.length; i++) if (book.curve[i].gateOpen) openRets.push(book.curve[i].eq / book.curve[i - 1].eq - 1);
      const openRet = (openRets.reduce((s, r) => s * (1 + r), 1) - 1) * 100;
      const om = openRets.reduce((s, r) => s + r, 0) / (openRets.length || 1);
      const osd = Math.sqrt(openRets.reduce((s, r) => s + (r - om) ** 2, 0) / (openRets.length || 1)) || 1e-9;
      const deployed = open.filter((p) => p.names > 0);
      const avgSmvPct = deployed.length ? (deployed.reduce((s2, p) => s2 + p.smv / p.eq, 0) / deployed.length) * 100 : 0;
      const peakSmvPct = deployed.length ? Math.max(...deployed.map((p) => p.smv / p.eq)) * 100 : 0;
      const avgNames = deployed.length ? deployed.reduce((s2, p) => s2 + p.names, 0) / deployed.length : 0;
      const peakNames = deployed.length ? Math.max(...deployed.map((p) => p.names)) : 0;
      console.log(`   gate-open only: return ${openRet >= 0 ? '+' : ''}${openRet.toFixed(1)}% over ${openRets.length} sessions   sharpe ${((om / osd) * Math.sqrt(252)).toFixed(2)}`);
      console.log(`   deployment (gate-open, holding): avg gross ${avgSmvPct.toFixed(0)}% / peak ${peakSmvPct.toFixed(0)}% of equity   avg names ${avgNames.toFixed(1)} / peak ${peakNames}`);
    }
  }
  console.log('\n════════════════════════════════════════════════════════════════════════════');
}
main().then(() => process.exit(0)).catch((e) => { console.error('short-strategy backtest failed:', e); process.exit(1); });
