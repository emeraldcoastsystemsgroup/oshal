/**
 * Structural arbitrage — edges that don't require predicting anything.
 *
 * Calibration (kalshi-calibration / bet-evaluator) asks "is the market's PRICE wrong?", which
 * needs a forecasting edge and did not survive adversarial review. This module asks a different,
 * much harder-to-refute question: "do the market's OWN prices contradict each other?" A logical
 * inconsistency inside one event is a mispricing whether or not anyone can forecast the outcome —
 * the payoff is bounded below by arithmetic, not by a probability estimate.
 *
 * Three strategies, in descending order of soundness:
 *
 *   OVERROUND (sound under mutual exclusivity ALONE — no exhaustiveness needed):
 *     At most one market in a mutually-exclusive event resolves YES, so at least n−1 resolve NO.
 *     Buying NO on all n costs Σ(no_ask) = n − Σ(yes_bid) and pays at least n−1. Profit whenever
 *     Σ(yes_bid) > 1 + fees. Equivalently: the market is paying more to sell the outcomes than the
 *     outcomes can collectively be worth.
 *
 *   LADDER (sound by set inclusion — no exhaustiveness, no calibration):
 *     For threshold markets "above X", a higher strike is a SUBSET event: P(above 72) ≤ P(above 71).
 *     If the book lets you BUY the lower strike cheaper than you can SELL the higher strike
 *     (ask_low < bid_high), buy YES_low + NO_high: the worst-case payout is $1 and the cost is
 *     1 − (bid_high − ask_low). Profit is locked by inclusion, not by forecasting.
 *
 *   UNDERROUND (candidate ONLY — requires the event to be collectively EXHAUSTIVE):
 *     Σ(yes_ask) < 1 − fees looks like a lock, but Kalshi's `mutually_exclusive` flag does NOT
 *     imply exhaustive (a candidate field can omit "someone else"). If nothing resolves YES the
 *     whole basket pays zero. Reported separately and never as a guaranteed profit.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — overround / ladder-inclusion / underround scanners over the events endpoint's nested books, all net of the quadratic taker fee on every leg.
 *
 * @module prediction-markets/arbitrage
 */

import { createChildLogger } from '@/shared/logger';
import { kalshiGet } from './kalshi-public-client';
import { feePerContract } from './kalshi-fees';

const log = createChildLogger({ module: 'kalshi-arbitrage' });

/** Standard-series fee model — arbitrage baskets are priced conservatively at multiplier 1. */
const STD_FEE = { feeType: 'quadratic', feeMultiplier: 1 };

/** One leg of an arbitrage basket. */
export interface ArbLeg {
  ticker: string;
  subtitle: string;
  /** What to do: buy the YES side, or buy the NO side. */
  buy: 'yes' | 'no';
  /** Cost per contract for that side, dollars. */
  price: number;
  /** Taker fee per contract at that price. */
  fee: number;
}

/** A detected structural mispricing. */
export interface ArbOpportunity {
  strategy: 'overround' | 'ladder' | 'underround';
  /** True when the profit is guaranteed by arithmetic alone (no exhaustiveness assumption). */
  guaranteed: boolean;
  eventTicker: string;
  title: string;
  legs: ArbLeg[];
  /** Total cost of one basket, dollars (including fees). */
  costPerBasket: number;
  /** Worst-case payout of one basket, dollars. */
  worstCasePayout: number;
  /** Worst-case profit per basket, dollars (payout − cost). */
  profitPerBasket: number;
  /** Return on capital at risk, worst case. */
  returnPct: number;
  /** Why this is (or isn't) a lock — the assumption the trade rests on. */
  rationale: string;
  closeTime: string | null;
}

interface RawMarket {
  ticker?: string;
  yes_sub_title?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  floor_strike?: number;
  cap_strike?: number;
  /** 'greater' | 'greater_or_equal' | 'less' | 'less_or_equal' | 'between' | 'structured' | 'custom' */
  strike_type?: string;
  close_time?: string;
  volume_fp?: string;
  liquidity_dollars?: string;
}

/**
 * Nesting family of a market, or null when its outcomes are NOT nested.
 *
 * CRITICAL (bug caught live 2026-07-13): `between` markets carry a floor_strike too, but their
 * outcomes are DISJOINT BUCKETS ("0 seats" vs "1 seat"), not nested sets. Keying inclusion off
 * floor_strike alone produced 594 phantom "risk-free" arbs — the classic mistake of treating
 * mutually-exclusive buckets as a subset chain. Only a genuine ONE-SIDED threshold nests.
 */
function ladderFamily(m: RawMarket): 'above' | 'below' | null {
  const t = m.strike_type;
  // "X or above": a HIGHER floor is a strictly harder (subset) event. cap must be open.
  if ((t === 'greater' || t === 'greater_or_equal') && typeof m.floor_strike === 'number' && m.cap_strike == null) return 'above';
  // "X or below": a LOWER cap is the subset. floor must be open.
  if ((t === 'less' || t === 'less_or_equal') && typeof m.cap_strike === 'number' && m.floor_strike == null) return 'below';
  return null; // between / structured / custom / categorical — disjoint or unknown, never nested
}

interface RawEvent {
  event_ticker?: string;
  title?: string;
  mutually_exclusive?: boolean;
  markets?: RawMarket[];
}

function n(v: unknown): number {
  const x = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : 0;
}

/** A market is tradeable for arb purposes only if BOTH sides quote a usable price. */
function tradeable(m: RawMarket): boolean {
  const yb = n(m.yes_bid_dollars), ya = n(m.yes_ask_dollars);
  return yb > 0 && ya > 0 && ya < 1 && yb < ya;
}

/**
 * @description Overround: buy NO on every leg of a mutually-exclusive event. At most one leg can
 * resolve YES, so the basket pays at least n−1 regardless of which (if any) wins. Sound without
 * assuming the event is exhaustive.
 * @param ev - Event with nested markets.
 * @returns The opportunity, or null when the book doesn't offer one.
 */
export function findOverround(ev: RawEvent): ArbOpportunity | null {
  if (!ev.mutually_exclusive) return null;
  const ms = (ev.markets || []).filter(tradeable);
  if (ms.length < 2) return null;
  const legs: ArbLeg[] = ms.map((m) => {
    const noAsk = n(m.no_ask_dollars) || 1 - n(m.yes_bid_dollars);
    return {
      ticker: String(m.ticker), subtitle: String(m.yes_sub_title || ''),
      buy: 'no' as const, price: noAsk, fee: feePerContract(noAsk, STD_FEE),
    };
  });
  const cost = legs.reduce((s, l) => s + l.price + l.fee, 0);
  const worstCasePayout = legs.length - 1; // at least n−1 legs resolve NO
  const profit = worstCasePayout - cost;
  if (profit <= 0) return null;
  return {
    strategy: 'overround', guaranteed: true,
    eventTicker: String(ev.event_ticker), title: String(ev.title || ''),
    legs, costPerBasket: cost, worstCasePayout, profitPerBasket: profit,
    returnPct: cost > 0 ? profit / cost : 0,
    rationale: `Mutually exclusive: at most 1 of ${legs.length} can resolve YES, so ≥${worstCasePayout} legs pay $1. Buying every NO costs $${cost.toFixed(3)} incl. fees — locked profit regardless of the outcome.`,
    closeTime: ms[0].close_time || null,
  };
}

/**
 * @description Ladder inclusion: in a threshold ladder ("index above X"), a higher strike is a
 * strict subset of a lower one, so its probability can never exceed the lower strike's. When the
 * book lets you BUY the lower strike below the price you can SELL the higher strike, the pair is
 * locked by set inclusion. Returns every violating pair found in the event.
 * @param ev - Event with nested markets carrying floor_strike.
 * @returns Opportunities (possibly empty).
 */
export function findLadderViolations(ev: RawEvent): ArbOpportunity[] {
  const out: ArbOpportunity[] = [];
  const usable = (ev.markets || []).filter((m) => tradeable(m) && ladderFamily(m) !== null);

  // ── STRIKE ladder: same deadline, different strikes. Inclusion is structural and SOUND.
  // Grouping by close_time is what keeps a same-strike/different-expiry ladder (below) from
  // contaminating this one — they are different objects with different soundness.
  const byClose = new Map<string, RawMarket[]>();
  for (const m of usable) {
    const k = `${ladderFamily(m)}|${m.close_time || ''}`;
    byClose.set(k, [...(byClose.get(k) || []), m]);
  }
  for (const [key, group] of byClose) {
    const family = key.split('|')[0] as 'above' | 'below';
    const strike = (m: RawMarket) => (family === 'above' ? (m.floor_strike as number) : (m.cap_strike as number));
    // Distinct strikes are REQUIRED — equal strikes mean the ladder varies by deadline, not by
    // strike, and sorting would be a no-op that silently mis-orders subset vs superset.
    const rungs = [...new Set(group.map(strike))].length === group.length
      ? [...group].sort((a, b) => (family === 'above' ? strike(a) - strike(b) : strike(b) - strike(a)))
      : [];
    if (rungs.length >= 2) out.push(...pairsFor(ev, rungs, true, 'strike'));
  }

  // ── TIME ladder: same strike, different deadlines. Inclusion holds ONLY if the underlying is a
  // first-passage event ("when will X first reach Y" — monotone: once true, stays true). It does
  // NOT hold for level-at-date markets ("will X be above Y ON date D"). That distinction lives in
  // the rules text, not in any structured field, so these are CANDIDATES, never auto-locks.
  const byStrike = new Map<string, RawMarket[]>();
  for (const m of usable) {
    const k = `${ladderFamily(m)}|${m.floor_strike ?? m.cap_strike}`;
    byStrike.set(k, [...(byStrike.get(k) || []), m]);
  }
  for (const group of byStrike.values()) {
    const closes = group.map((m) => m.close_time || '');
    if (group.length < 2 || new Set(closes).size !== group.length) continue;  // deadlines must be distinct
    // Earlier deadline = harder = SUBSET. Sort widest (latest deadline) first.
    const rungs = [...group].sort((a, b) => String(b.close_time).localeCompare(String(a.close_time)));
    out.push(...pairsFor(ev, rungs, false, 'time'));
  }
  return out;
}

/**
 * Every superset/subset pair in an ordered ladder whose book is inverted.
 * `rungs` MUST be ordered widest (superset) → narrowest (subset).
 */
function pairsFor(ev: RawEvent, rungs: RawMarket[], guaranteed: boolean, kind: 'strike' | 'time'): ArbOpportunity[] {
  const out: ArbOpportunity[] = [];
  for (let i = 0; i < rungs.length; i++) {
    for (let j = i + 1; j < rungs.length; j++) {
      const low = rungs[i], high = rungs[j];       // low = SUPERSET (easier), high = SUBSET (harder)
      const askLow = n(low.yes_ask_dollars);        // buy YES on the EASIER event
      const bidHigh = n(high.yes_bid_dollars);      // sell YES on the HARDER event
      if (bidHigh <= askLow) continue;              // no inversion
      const noHighPrice = 1 - bidHigh;              // selling YES_high == buying NO_high
      const legs: ArbLeg[] = [
        { ticker: String(low.ticker), subtitle: String(low.yes_sub_title || ''), buy: 'yes', price: askLow, fee: feePerContract(askLow, STD_FEE) },
        { ticker: String(high.ticker), subtitle: String(high.yes_sub_title || ''), buy: 'no', price: noHighPrice, fee: feePerContract(noHighPrice, STD_FEE) },
      ];
      const cost = legs.reduce((s, l) => s + l.price + l.fee, 0);
      const worstCasePayout = 1; // above-high ⇒ YES_low pays; below-high ⇒ NO_high pays; both ⇒ 2
      const profit = worstCasePayout - cost;
      if (profit <= 0) continue;
      const base = `Set inclusion: "${high.yes_sub_title}" ⊂ "${low.yes_sub_title}", so P(subset) ≤ P(superset) — yet the book asks ${(askLow * 100).toFixed(0)}¢ for the SUPERSET and bids ${(bidHigh * 100).toFixed(0)}¢ for the SUBSET. Buy YES("${low.yes_sub_title}") + NO("${high.yes_sub_title}"): worst case pays $1 against a $${cost.toFixed(3)} cost.`;
      out.push({
        strategy: 'ladder', guaranteed,
        eventTicker: String(ev.event_ticker), title: String(ev.title || ''),
        legs, costPerBasket: cost, worstCasePayout, profitPerBasket: profit,
        returnPct: cost > 0 ? profit / cost : 0,
        rationale: kind === 'strike' ? base
          : `${base} ⚠ TIME ladder (same strike, different deadlines): this is a lock ONLY if the market is first-passage ("when will X FIRST reach Y" — once true it stays true). If it resolves on a LEVEL at each date ("will X be above Y ON that date"), the inclusion does NOT hold and the basket can pay $0. Read the rules before acting.`,
        closeTime: low.close_time || null,
      });
    }
  }
  return out;
}

/**
 * @description Underround: Σ(yes_ask) < 1 − fees. A lock ONLY if the event is collectively
 * exhaustive — which Kalshi's mutually_exclusive flag does NOT guarantee. Reported as a
 * CANDIDATE (guaranteed=false); acting on it requires reading the rules to confirm some outcome
 * must occur.
 * @param ev - Event with nested markets.
 * @returns The candidate, or null.
 */
export function findUnderround(ev: RawEvent): ArbOpportunity | null {
  if (!ev.mutually_exclusive) return null;
  const ms = (ev.markets || []).filter(tradeable);
  if (ms.length < 2) return null;
  const legs: ArbLeg[] = ms.map((m) => {
    const ask = n(m.yes_ask_dollars);
    return {
      ticker: String(m.ticker), subtitle: String(m.yes_sub_title || ''),
      buy: 'yes' as const, price: ask, fee: feePerContract(ask, STD_FEE),
    };
  });
  const cost = legs.reduce((s, l) => s + l.price + l.fee, 0);
  const profit = 1 - cost; // pays $1 IF exactly one resolves YES
  if (profit <= 0) return null;
  return {
    strategy: 'underround', guaranteed: false,
    eventTicker: String(ev.event_ticker), title: String(ev.title || ''),
    legs, costPerBasket: cost, worstCasePayout: 1, profitPerBasket: profit,
    returnPct: cost > 0 ? profit / cost : 0,
    rationale: `Buying all ${legs.length} YES legs costs $${cost.toFixed(3)} incl. fees and pays $1 — but ONLY if one of them must win. NOT a lock: if the listed outcomes aren't exhaustive (e.g. an unlisted candidate wins), the basket pays $0. Read the event rules before acting.`,
    closeTime: ms[0].close_time || null,
  };
}

/**
 * @description Sweep the open-events feed for every structural mispricing. Pages the events
 * endpoint with nested books so each event's legs are priced at the same instant (scanning
 * markets individually would risk pairing stale quotes into a phantom arb).
 * @param maxEvents - Cap on events paged.
 * @returns Opportunities, best worst-case return first, guaranteed ones ranked above candidates.
 */
export async function scanArbitrage(maxEvents = 4000): Promise<{ opportunities: ArbOpportunity[]; eventsScanned: number; marketsScanned: number }> {
  const found: ArbOpportunity[] = [];
  let cursor = '';
  let eventsScanned = 0;
  let marketsScanned = 0;
  while (eventsScanned < maxEvents) {
    const q = new URLSearchParams({ limit: '200', status: 'open', with_nested_markets: 'true' });
    if (cursor) q.set('cursor', cursor);
    const body = await kalshiGet<{ cursor?: string; events?: RawEvent[] }>(`/events?${q}`);
    const events = body.events || [];
    for (const ev of events) {
      eventsScanned += 1;
      marketsScanned += (ev.markets || []).length;
      const over = findOverround(ev);
      if (over) found.push(over);
      found.push(...findLadderViolations(ev));
      const under = findUnderround(ev);
      if (under) found.push(under);
    }
    cursor = body.cursor || '';
    if (!cursor || events.length === 0) break;
  }
  found.sort((a, b) => Number(b.guaranteed) - Number(a.guaranteed) || b.returnPct - a.returnPct);
  log.info({ eventsScanned, marketsScanned, opportunities: found.length, guaranteed: found.filter((f) => f.guaranteed).length }, 'kalshi arbitrage scan complete');
  return { opportunities: found, eventsScanned, marketsScanned };
}
