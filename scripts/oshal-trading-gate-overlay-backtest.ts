/**
 * Gate-overlay backtest — the 200-day trend gate as a LONG-side exposure switch (Faber-style).
 *
 * The one thing the 2026-07-08 short-strategy work validated was the GATE: SPY < SMA200 called
 * every regime in the window correctly (flat through 2021/2024 bull tape, open in 2022 and the
 * 2025 correction). Its refuted use was licensing short ENTRIES; its classic, decades-documented
 * use is cutting LONG exposure. This measures exactly that, on the same data + conventions as the
 * short-strategy harness:
 *
 *   G1 SPY buy & hold        — the benchmark
 *   G2 gate → CASH           — hold SPY while SPY ≥ SMA200, sit fully in cash while below
 *   G3 gate → HALF exposure  — hold SPY, cut to 50% while below (the "trim, don't liquidate"
 *                              policy closest to how the live book would actually apply it)
 *
 * G2/G3's exposure levels (0%, 50%) are natural policy points, not fitted parameters; the gate's
 * SMA200 is the same classic value the short work used. NO parameter search here either.
 *
 * HONEST LIMITS: cash earns 0% (2022-2026 cash really earned 3-5% — this UNDERSTATES the gated
 * books, direction conservative). Same-close signal/fill convention (the daily-crossing gate is
 * whipsaw-prone vs Faber's month-end checks — the switch count is printed so the friction is
 * visible; no commission/slippage modeled, which FLATTERS high-switch variants). SPY-only: this
 * tests the OVERLAY concept on the market proxy, not the autopilot's stock book; wiring it into
 * the autopilot (e.g. halving per-name caps while the gate is open) is a separate decision.
 * Single ~5y window = the same n≈2 bear episodes as the short work.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-gate-overlay-backtest.ts
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — SPY gate-to-cash and gate-to-half overlays vs buy & hold over the full free-IEX window, per-year splits, switch counts, drawdown/Sharpe. The long-side application of the gate the short-strategy work validated.
 */
import 'dotenv/config';
import { barsBatchSince, marketBearGate } from '@/features/trading';

const START_ISO = '2020-07-01';          // clamps to the free-IEX floor (~2020-07-27)
const REPORT_FROM = '2021-06-01';        // ≥200 SPY sessions of gate warmup (same as the short harness)
const START_CASH = 100_000;

interface Overlay {
  name: string;
  /** Fraction of equity held in SPY while the gate is OPEN (bear). Closed (bull) is always 1.0. */
  bearExposure: number;
  cash: number; spyQty: number;
  curve: Array<{ d: string; eq: number }>;
  peak: number; maxDD: number; switches: number;
}
const mk = (name: string, bearExposure: number): Overlay =>
  ({ name, bearExposure, cash: START_CASH, spyQty: 0, curve: [], peak: START_CASH, maxDD: 0, switches: 0 });

async function main(): Promise<void> {
  console.log(`Loading SPY daily bars since ${START_ISO}…`);
  const bars = await barsBatchSince(['SPY'], START_ISO);
  const spy = bars.get('SPY') || [];
  const t0 = spy.findIndex((b) => b.d >= REPORT_FROM);
  if (t0 < 200) { console.error(`Insufficient warmup: ${t0} sessions before ${REPORT_FROM} (need 200).`); process.exit(1); }
  console.log(`Window: ${spy[t0].d} → ${spy[spy.length - 1].d} (${spy.length - t0} sessions).\n`);

  const closes = spy.map((b) => b.c);
  const books = [mk('G1 SPY buy & hold', 1.0), mk('G2 gate → cash', 0.0), mk('G3 gate → half', 0.5)];

  let gateOpenDays = 0;
  let prevGate: boolean | null = null;

  for (let t = t0; t < spy.length; t++) {
    const px = closes[t];
    const gateOpen = marketBearGate(closes.slice(0, t + 1));
    if (gateOpen) gateOpenDays++;
    const flipped = prevGate !== null && gateOpen !== prevGate;
    prevGate = gateOpen;

    for (const b of books) {
      const target = gateOpen ? b.bearExposure : 1.0;
      const eqNow = b.cash + b.spyQty * px;
      const targetQty = (eqNow * target) / px;
      // Rebalance only on a gate flip (or the initial entry) — not daily — so the overlay trades
      // exactly when the regime changes and the switch count means what it says.
      if (b.spyQty === 0 && b.cash > 0 && target > 0 && b.curve.length === 0) {
        b.spyQty = targetQty; b.cash = eqNow - targetQty * px;
      } else if (flipped && Math.abs(targetQty - b.spyQty) * px > 1) {
        b.cash += (b.spyQty - targetQty) * px;
        b.spyQty = targetQty;
        b.switches++;
      }
      const eq = b.cash + b.spyQty * px;
      b.curve.push({ d: spy[t].d, eq });
      b.peak = Math.max(b.peak, eq);
      b.maxDD = Math.max(b.maxDD, (b.peak - eq) / b.peak);
    }
  }

  const years = [...new Set(spy.slice(t0).map((b) => b.d.slice(0, 4)))];
  const lastYear = years[years.length - 1];
  console.log('════════════════════════════════════════════════════════════════════════');
  console.log(` Gate open (bear) ${gateOpenDays}/${spy.length - t0} sessions (${((gateOpenDays / (spy.length - t0)) * 100).toFixed(0)}%)   cash yield modeled: 0% (conservative for G2/G3)`);
  console.log('════════════════════════════════════════════════════════════════════════');
  for (const b of books) {
    const final = b.curve[b.curve.length - 1].eq;
    const ret = (final / START_CASH - 1) * 100;
    const rets = b.curve.slice(1).map((p, i) => p.eq / b.curve[i].eq - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1)) || 1e-9;
    const yearRet = (y: string): number => {
      const inY = b.curve.filter((p) => p.d.slice(0, 4) === y);
      const prior = b.curve.filter((p) => p.d < inY[0].d);
      const base = prior.length ? prior[prior.length - 1].eq : START_CASH;
      return (inY[inY.length - 1].eq / base - 1) * 100;
    };
    console.log(`\n ${b.name}`);
    console.log(`   full ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%   maxDD -${(b.maxDD * 100).toFixed(1)}%   sharpe ${((mean / sd) * Math.sqrt(252)).toFixed(2)}   switches ${b.switches}`);
    console.log('   ' + years.map((y) => `${y}${y === lastYear ? ' (YTD)' : ''} ${(() => { const r = yearRet(y); return (r >= 0 ? '+' : '') + r.toFixed(1) + '%'; })()}`).join('   '));
  }
  console.log('\n════════════════════════════════════════════════════════════════════════');
}
main().then(() => process.exit(0)).catch((e) => { console.error('gate-overlay backtest failed:', e); process.exit(1); });
