/**
 * Prediction-markets domain types — Kalshi contracts, calibration tables, and evaluated bet "hands".
 *
 * All prices are DOLLARS per contract (0..1). Kalshi's v2 API returns `*_dollars` string fields
 * (deci-cent capable); the client normalizes to numbers once, here, so every downstream module
 * does plain arithmetic.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — normalized Kalshi market/series/candle shapes + CalibrationTable + BetHand (the poker-hand evaluation of a contract: true-prob estimate vs price, net-of-fee EV, Kelly sizing, risk flags).
 *
 * @module prediction-markets/types
 */

/** A Kalshi binary market, normalized from the trade-api v2 wire shape. */
export interface KalshiMarket {
  /** Market ticker, e.g. `KXHIGHNY-26JUL13-B87.5`. */
  ticker: string;
  /** Parent event ticker; its prefix (before the first `-`) is the series ticker. */
  eventTicker: string;
  /** Series ticker derived from the event ticker — the fee/category lookup key. */
  seriesTicker: string;
  /** Human title (event title + strike subtitle when present). */
  title: string;
  /** `open` | `closed` | `settled` | ... (wire values passed through). */
  status: string;
  /** Settlement result when settled: 'yes' | 'no' | '' otherwise. */
  result: string;
  /** Best YES bid/ask in dollars (0 when the book is empty). */
  yesBid: number;
  yesAsk: number;
  /** Best NO bid/ask in dollars (0 when the book is empty). */
  noBid: number;
  noAsk: number;
  /** Last traded YES price in dollars. */
  lastPrice: number;
  /** Contracts traded over the market's life (floating-point contracts are possible). */
  volume: number;
  /** Resting-order book depth in dollars. */
  liquidity: number;
  /** Open interest in contracts. */
  openInterest: number;
  openTime: Date | null;
  closeTime: Date | null;
  /** True for multivariate/parlay legs (excluded from single-market edge math). */
  isMultivariate: boolean;
  /** Strike semantics — REQUIRED to tell a nested threshold from a disjoint bucket. Dropping
   *  these once produced 594 phantom "risk-free" arbitrages (see arbitrage.ts). */
  strikeType?: string;
  floorStrike?: number;
  capStrike?: number;
}

/** Kalshi series metadata — the per-series fee model and category. */
export interface KalshiSeriesMeta {
  ticker: string;
  /** Kalshi category, e.g. 'Crypto' | 'Sports' | 'Economics' | 'Climate and Weather' | 'Politics'. */
  category: string;
  /** Fee model: 'quadratic' (ceil(0.07·mult·C·P·(1−P))) is the exchange default. */
  feeType: string;
  /** Series fee multiplier (1 = standard). */
  feeMultiplier: number;
  /** Cadence hint, e.g. 'fifteen_min', 'daily'. */
  frequency: string;
}

/** One OHLC candle of a market's YES price/book, dollars. */
export interface KalshiCandle {
  endPeriodTs: number;
  /** Trade-price OHLC (absent when no trades printed in the period). */
  close: number | null;
  mean: number | null;
  /** Best-bid / best-ask closes — the mid is the price signal when no trades printed. */
  yesBidClose: number | null;
  yesAskClose: number | null;
  volume: number;
  openInterest: number;
}

/** A single (price-at-horizon, outcome) observation from a settled market. */
export interface CalibrationSample {
  ticker: string;
  category: string;
  /** Hours before market close the price was observed. */
  horizonHours: number;
  /** YES price observed at the horizon, dollars. */
  price: number;
  /** True when the market settled YES. */
  settledYes: boolean;
}

/** Aggregated calibration bucket: what price p ACTUALLY settled YES at, historically. */
export interface CalibrationBucket {
  /** Bucket price range [lo, hi) in dollars. */
  lo: number;
  hi: number;
  /** Observations in the bucket. */
  n: number;
  /** Mean observed YES price of the samples. */
  avgPrice: number;
  /** Empirical settle-YES rate (unshrunk). */
  yesRate: number;
}

/** Calibration tables keyed by horizon and category ('*' = all categories pooled). */
export interface CalibrationTable {
  generatedAt: string;
  /** Markets sampled per category (transparency for the evidence doc). */
  sampleCounts: Record<string, number>;
  /** horizonHours -> category -> buckets. */
  horizons: Record<string, Record<string, CalibrationBucket[]>>;
}

/** Poker-style strength classes for an evaluated contract. */
export type HandStrength = 'monster' | 'strong' | 'playable' | 'fold';

/** The evaluated "poker hand" for one side of one market: edge, EV, sizing, and risk. */
export interface BetHand {
  ticker: string;
  /** Parent event — hands within one event are mutually-exclusive strikes and must not stack. */
  eventTicker: string;
  title: string;
  category: string;
  closeTime: string | null;
  /** Which side the edge is on. */
  side: 'yes' | 'no';
  /** Cost to enter (that side's ask), dollars per contract. */
  price: number;
  /** Market-implied probability of the SIDE (its ask). */
  marketProb: number;
  /** Our calibration-based estimate of the side's true win probability. */
  trueProb: number;
  /** Observations behind trueProb (0 = no history; the hand is a fold). */
  calibrationN: number;
  /** Taker fee per contract at this price, dollars. */
  feePerContract: number;
  /** Net edge per contract after fees: trueProb − (price + fee). */
  edgeNet: number;
  /** Expected profit per contract net of fees, dollars. */
  evPerContract: number;
  /** Full-Kelly fraction of bankroll for this hand (before fractional cap). */
  kellyFraction: number;
  /** Recommended stake as a fraction of bankroll (fractional Kelly, risk-flag discounted, capped). */
  stakeFraction: number;
  /** Confidence 0..1 from calibration sample size. */
  confidence: number;
  /** Why the sizing was discounted: wide-spread, thin-book, near-expiry, low-sample... */
  riskFlags: string[];
  /** Poker-style strength label derived from edge × confidence. */
  strength: HandStrength;
  /** Book spread on the traded side, dollars. */
  spread: number;
  liquidity: number;
  volume: number;
}
