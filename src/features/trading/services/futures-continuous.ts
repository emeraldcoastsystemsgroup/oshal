/**
 * Continuous futures series — front-month stitching + panama back-adjustment (ADR-116).
 *
 * A multi-year futures backtest needs ONE price series, but the market trades a chain of dated
 * contracts at DIFFERENT absolute levels (ES quarterly basis runs 10–40 points). Stitching raw
 * front-month segments therefore leaves a price jump at every roll, and a simulator faithfully
 * books that jump as phantom P&L on any trade spanning it. This module owns the whole problem:
 *
 *  1. **Stitch** — fetch each contract ONLY over its active front-month window (the clamp that
 *     keeps a back month's illiquid quotes out of the series; see KibotFileOptions.frontMonthOnly
 *     for the empirical case) and concatenate the segments in time order.
 *  2. **Measure** every roll seam. Preferred method: the two contracts trade SIMULTANEOUSLY in the
 *     days before the roll, so the level difference is read off bars with IDENTICAL timestamps
 *     (median of close-minus-close over the overlap window) — immune to market movement between
 *     one contract's last bar and the next one's first. Fallback (`adjacent`) when no overlap data
 *     exists: incoming first open minus outgoing last close, which conflates one bar of real
 *     market movement into the measured basis.
 *  3. **Panama-adjust** (difference method, NinjaTrader's continuous-contract default): the most
 *     recent contract keeps its true prices; every earlier segment is shifted by the cumulative
 *     seam jumps after it, snapped to the root's tick grid. Percent/ratio adjustment is not
 *     implemented — the source trader's NT continuous contracts use difference adjustment.
 *
 * Panama trade-offs the caller must know: historical absolute LEVELS are fictional (only the most
 * recent segment is real), percentage returns computed on adjusted early history are distorted,
 * and a long enough decline can push adjusted prices negative. Point DIFFERENCES — which drive
 * every $-P&L, ATR, and stop distance in this stack — are exact within each contract.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — front-month stitching promoted out of the backtest runner into the feature, plus panama (difference) back-adjustment with overlap-median seam measurement and adjacent-bar fallback. Closes the "roll seams make multi-year P&L unquotable" gap.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fix: non-consecutive segments (an intermediate contract with no bars) now classify their boundary as a 'gap' seam — reported, warned, and EXCLUDED from panama offsets. The adjacent-bar fallback across such a gap measured months of market drift as a "roll basis" and would have relocated all earlier history by it.
 *
 * @module futures-continuous
 */

import { createChildLogger } from '@/shared/logger';
import type { Timeframe } from './market-data';
import {
  contractsForRange, getFuturesRoot, DEFAULT_ROLL_DAYS_BEFORE_EXPIRY,
  type FuturesBar, type FuturesContract,
} from './futures-contract';
import type { FuturesDataSource } from './futures-data-source';

const logger = createChildLogger({ module: 'futures-continuous' });

/** One roll boundary in a stitched series, with how its price gap was measured. */
export interface RollSeam {
  /** Timestamp of the incoming contract's first stitched bar (the seam sits just before it). */
  at: string;
  /** The outgoing (earlier) contract symbol. */
  fromSymbol: string;
  /** The incoming (later) contract symbol. */
  toSymbol: string;
  /** Incoming-minus-outgoing price level at the roll (raw measurement, unrounded). */
  jump: number;
  /**
   * 'overlap' = median close-difference on identical timestamps (preferred); 'adjacent' =
   * first-open minus last-close fallback; 'gap' = the two contracts are NOT consecutive front
   * months (one or more intermediate contracts contributed no bars), so the level difference is
   * months of real market drift, not a roll basis — it is reported here but NEVER folded into
   * panama offsets, and the discontinuity stays visible in the series.
   */
  method: 'overlap' | 'adjacent' | 'gap';
}

/** Per-contract accounting for a stitched series. */
export interface ContinuousContractUse {
  symbol: string;
  /** Bars this contract contributed. */
  bars: number;
  /** The panama offset added to this contract's prices (0 for the most recent contract, and for adjust='none'). */
  offset: number;
}

/** A stitched (and optionally back-adjusted) continuous series plus its full provenance. */
export interface ContinuousSeries {
  root: string;
  timeframe: Timeframe;
  /** Ascending bars; adjusted when `adjusted` is true. */
  bars: FuturesBar[];
  /** Every roll boundary between contributing contracts. */
  seams: RollSeam[];
  /** Contracts that contributed bars, in time order, with their applied offsets. */
  contracts: ContinuousContractUse[];
  /** True when panama adjustment was applied. */
  adjusted: boolean;
}

/** Options for {@link buildContinuousSeries}. */
export interface ContinuousSeriesOptions {
  /** 'panama' (default) = difference back-adjustment; 'none' = raw stitched segments with live seams. */
  adjust?: 'panama' | 'none';
  /** Roll convention forwarded to contract enumeration (default 8 calendar days before expiry). */
  rollDaysBeforeExpiry?: number;
  /**
   * A source WITHOUT the front-month clamp (e.g. `new KibotFileDataSource({dir, frontMonthOnly:
   * false, minVolume: 0})`), used only to measure seams on overlapping timestamps. The primary
   * source cannot serve this: the incoming contract's pre-roll bars are exactly the back-month
   * bars the clamp removes. Omit it and every seam falls back to the 'adjacent' method.
   */
  basisProbe?: FuturesDataSource;
  /** How many hours before each roll to search for overlapping bars (default 72). */
  overlapHours?: number;
}

interface Segment {
  contract: FuturesContract;
  bars: FuturesBar[];
}

/**
 * @description Build a continuous front-month series for a root over [start, end): stitch each
 * contract's active window, measure every roll seam, and (by default) panama-adjust so the series
 * is gap-free with the most recent contract's prices real. See the module doc for the panama
 * trade-offs; pass `adjust: 'none'` to get raw segments plus the seam list.
 * @param src - The bar source; each contract is fetched only over its clamped active window.
 * @param rootSym - Futures root, e.g. 'ES'.
 * @param timeframe - Bar size of the stitched series.
 * @param start - Range start (inclusive).
 * @param end - Range end (exclusive).
 * @param opts - Adjustment mode, roll convention, and the optional overlap basis probe.
 * @returns The stitched series with seams and per-contract offsets.
 * @throws If the root is unknown.
 */
export async function buildContinuousSeries(
  src: FuturesDataSource, rootSym: string, timeframe: Timeframe, start: Date, end: Date,
  opts: ContinuousSeriesOptions = {},
): Promise<ContinuousSeries> {
  const root = getFuturesRoot(rootSym);
  if (!root) throw new Error(`unknown futures root '${rootSym}'`);
  const adjust = opts.adjust ?? 'panama';
  const rollDays = opts.rollDaysBeforeExpiry ?? DEFAULT_ROLL_DAYS_BEFORE_EXPIRY;

  const segments: Segment[] = [];
  for (const contract of contractsForRange(root.root, start, end, rollDays)) {
    const s = new Date(Math.max(start.getTime(), contract.activeStart.getTime()));
    const e = new Date(Math.min(end.getTime(), contract.activeEnd.getTime()));
    if (s.getTime() >= e.getTime()) continue;
    // The window is passed to the source AND re-applied here: a source that honours the caller's
    // window verbatim would otherwise leak a back month's off-market quotes into the series.
    const got = (await src.fetchBars(contract, timeframe, { start: s, end: e }))
      .filter((b) => { const t = Date.parse(b.t); return t >= s.getTime() && t < e.getTime(); })
      .sort((a, b) => a.t.localeCompare(b.t));
    if (got.length) segments.push({ contract, bars: got });
  }

  const seams: RollSeam[] = [];
  for (let i = 1; i < segments.length; i++) {
    seams.push(await measureSeam(segments[i - 1], segments[i], timeframe, opts));
  }

  // Panama offsets accumulate from the most recent contract backwards: the last segment is real,
  // each earlier one is shifted by every seam after it, snapped to the tick grid. A 'gap' seam
  // contributes NOTHING — its measured jump is market drift across missing contracts, and folding
  // it in would relocate all earlier history by that drift (the fabrication class this module
  // exists to prevent). The discontinuity is left standing and reported instead.
  const offsets = new Array<number>(segments.length).fill(0);
  if (adjust === 'panama') {
    for (let i = segments.length - 2; i >= 0; i--) {
      const contribution = seams[i].method === 'gap' ? 0 : seams[i].jump;
      offsets[i] = snapToTick(offsets[i + 1] + contribution, root.tickSize);
    }
  }

  const bars: FuturesBar[] = [];
  for (let i = 0; i < segments.length; i++) {
    const off = offsets[i];
    if (off === 0) { bars.push(...segments[i].bars); continue; }
    for (const b of segments[i].bars) {
      bars.push({
        t: b.t,
        o: snapToTick(b.o + off, root.tickSize), h: snapToTick(b.h + off, root.tickSize),
        l: snapToTick(b.l + off, root.tickSize), c: snapToTick(b.c + off, root.tickSize),
        v: b.v,
      });
    }
  }

  logger.info({
    root: root.root, timeframe, bars: bars.length, contracts: segments.length,
    seams: seams.length, adjusted: adjust === 'panama',
  }, 'continuous series built');
  return {
    root: root.root, timeframe, bars, seams,
    contracts: segments.map((seg, i) => ({ symbol: seg.contract.symbol, bars: seg.bars.length, offset: offsets[i] })),
    adjusted: adjust === 'panama',
  };
}

/**
 * Measure one seam. Overlap method: both contracts' bars over the `overlapHours` before the
 * incoming contract's activeStart, matched on identical timestamps, median of close-differences.
 * Falls back to adjacent bars when there is no probe or no overlapping stamps.
 */
async function measureSeam(
  prev: Segment, next: Segment, timeframe: Timeframe, opts: ContinuousSeriesOptions,
): Promise<RollSeam> {
  const base = {
    at: next.bars[0].t, fromSymbol: prev.contract.symbol, toSymbol: next.contract.symbol,
  };
  // Consecutive front months tile exactly: prev's activeEnd IS next's activeStart. When they
  // don't, one or more intermediate contracts were dropped for having no bars, the "seam" spans
  // months of real drift, and no measurement method can recover the true roll basis — classify
  // it 'gap' so the adjuster refuses to bake it in.
  if (prev.contract.activeEnd.getTime() !== next.contract.activeStart.getTime()) {
    logger.warn(
      { from: base.fromSymbol, to: base.toSymbol, coverageEndsAt: prev.contract.activeEnd.toISOString(), resumesAt: next.contract.activeStart.toISOString() },
      'continuous series has a COVERAGE GAP — intermediate contract(s) contributed no bars; the discontinuity is not adjustable and results spanning it are suspect',
    );
    return { ...base, jump: next.bars[0].o - prev.bars[prev.bars.length - 1].c, method: 'gap' };
  }
  if (opts.basisProbe) {
    const rollAt = next.contract.activeStart.getTime();
    const window = {
      start: new Date(rollAt - (opts.overlapHours ?? 72) * 3_600_000),
      end: new Date(rollAt),
    };
    const [outgoing, incoming] = await Promise.all([
      opts.basisProbe.fetchBars(prev.contract, timeframe, window),
      opts.basisProbe.fetchBars(next.contract, timeframe, window),
    ]);
    const outgoingByStamp = new Map(outgoing.map((b) => [b.t, b.c]));
    const diffs: number[] = [];
    for (const b of incoming) {
      const oc = outgoingByStamp.get(b.t);
      if (oc !== undefined) diffs.push(b.c - oc);
    }
    if (diffs.length > 0) return { ...base, jump: median(diffs), method: 'overlap' };
    logger.warn({ from: base.fromSymbol, to: base.toSymbol }, 'no overlapping bars at roll — falling back to adjacent-bar seam measurement');
  }
  return {
    ...base,
    jump: next.bars[0].o - prev.bars[prev.bars.length - 1].c,
    method: 'adjacent',
  };
}

/** Median of a non-empty list. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Snap a price to the nearest tick, suppressing float residue from repeated offset addition. */
function snapToTick(price: number, tick: number): number {
  return Math.round(Math.round(price / tick) * tick * 1e9) / 1e9;
}
