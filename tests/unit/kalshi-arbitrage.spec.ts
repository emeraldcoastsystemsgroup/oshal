/**
 * Structural-arbitrage detection (ADR-094).
 *
 * The headline test is `does NOT treat disjoint buckets as nested` — the live scan initially
 * reported 594 "risk-free" arbitrages because `between` markets ("0 seats" / "1 seat") carry a
 * floor_strike just like a real threshold ladder does, and were fed into subset logic. Disjoint
 * outcomes are mutually exclusive, NOT nested; 594 locks on a regulated exchange was the tell.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — regression test for the phantom-ladder bug, plus overround soundness and the underround exhaustiveness caveat.
 */

import { describe, expect, it } from 'vitest';
import { findLadderViolations, findOverround, findUnderround, parseMarketDate } from '../../src/features/prediction-markets';

/** An inverted BUCKET event — exactly the shape that produced the phantom locks. */
const BUCKET_EVENT = {
  event_ticker: 'KXHOUSEWINSTATE-LAD',
  title: 'How many House seats will Democrats win in Louisiana?',
  mutually_exclusive: true,
  markets: [
    { ticker: 'LAD-0', yes_sub_title: '0', strike_type: 'between', floor_strike: 0, cap_strike: 0, yes_bid_dollars: '0.0500', yes_ask_dollars: '0.0600', no_ask_dollars: '0.9500' },
    { ticker: 'LAD-1', yes_sub_title: '1', strike_type: 'between', floor_strike: 1, cap_strike: 1, yes_bid_dollars: '0.8900', yes_ask_dollars: '0.9000', no_ask_dollars: '0.1100' },
  ],
};

/** A REAL threshold ladder, correctly priced (higher strike is cheaper — no arb). */
const SANE_LADDER = {
  event_ticker: 'KXGDPYEAR-30',
  title: 'GDP growth in 2030',
  mutually_exclusive: false,
  markets: [
    { ticker: 'T2', yes_sub_title: '2.1% or Above', strike_type: 'greater', floor_strike: 2, yes_bid_dollars: '0.7000', yes_ask_dollars: '0.7200', no_ask_dollars: '0.3000' },
    { ticker: 'T6', yes_sub_title: '6.1% or Above', strike_type: 'greater', floor_strike: 6, yes_bid_dollars: '0.1000', yes_ask_dollars: '0.1200', no_ask_dollars: '0.9000' },
  ],
};

/** A REAL threshold ladder that IS inverted — the genuine arb this strategy hunts. */
const INVERTED_LADDER = {
  event_ticker: 'KXTEST-LADDER',
  title: 'Test index above X',
  mutually_exclusive: false,
  markets: [
    // Buying the EASIER event (above 2) at 20c while the HARDER event (above 6) bids 60c is a
    // logical impossibility: P(above 6) <= P(above 2).
    { ticker: 'T2', yes_sub_title: '2 or Above', strike_type: 'greater', floor_strike: 2, yes_bid_dollars: '0.1900', yes_ask_dollars: '0.2000', no_ask_dollars: '0.8100' },
    { ticker: 'T6', yes_sub_title: '6 or Above', strike_type: 'greater', floor_strike: 6, yes_bid_dollars: '0.6000', yes_ask_dollars: '0.6200', no_ask_dollars: '0.4000' },
  ],
};

describe('findLadderViolations — the phantom-ladder regression', () => {
  it('does NOT treat disjoint `between` buckets as nested sets (the 594-phantom-locks bug)', () => {
    // "1 seat" is mutually exclusive with "0 seats", NOT a subset of it. Pricing them at 6c and
    // 89c is perfectly coherent and must produce ZERO opportunities.
    expect(findLadderViolations(BUCKET_EVENT)).toHaveLength(0);
  });

  it('ignores a correctly-ordered threshold ladder (higher strike priced lower)', () => {
    expect(findLadderViolations(SANE_LADDER)).toHaveLength(0);
  });

  it('DOES catch a genuine inversion in a real one-sided threshold ladder', () => {
    const found = findLadderViolations(INVERTED_LADDER);
    expect(found).toHaveLength(1);
    const arb = found[0];
    expect(arb.guaranteed).toBe(true);
    // Buy YES(above 2) @ 20c + NO(above 6) @ 40c = 60c + fees; worst case pays $1.
    expect(arb.legs.map((l) => l.buy)).toEqual(['yes', 'no']);
    expect(arb.profitPerBasket).toBeGreaterThan(0);
    expect(arb.profitPerBasket).toBeLessThan(0.4); // fees eat into the raw 40c spread
  });

  it('orders a SAME-STRIKE / different-deadline ladder correctly and never calls it guaranteed', () => {
    // The real KXYTUBESUBSISHOWSPEED shape: identical floor_strike (100M subs), the deadline
    // varies only in close_time. Sorting by strike is a no-op here, which originally mis-ordered
    // the rungs and "found" a basket that pays $0 if he hits 100M in an in-between year.
    const timeLadder = {
      event_ticker: 'KXYTUBESUBSISHOWSPEED', title: 'When will IShowSpeed reach 100M subs?', mutually_exclusive: false,
      markets: [
        { ticker: '-27', yes_sub_title: 'Before 2027', strike_type: 'greater_or_equal', floor_strike: 100_000_000, close_time: '2027-01-01T04:59:00Z', yes_bid_dollars: '0.0600', yes_ask_dollars: '0.1200', no_ask_dollars: '0.9400' },
        { ticker: '-30', yes_sub_title: 'Before 2030', strike_type: 'greater_or_equal', floor_strike: 100_000_000, close_time: '2030-01-01T04:59:00Z', yes_bid_dollars: '0.6900', yes_ask_dollars: '0.7900', no_ask_dollars: '0.3100' },
      ],
    };
    const found = findLadderViolations(timeLadder);
    for (const arb of found) {
      // Never a lock: level-at-date markets share this exact shape and break inclusion.
      expect(arb.guaranteed).toBe(false);
      expect(arb.rationale).toMatch(/first-passage/);
      // And when it DOES fire, it must buy the SUPERSET (later deadline) and sell the SUBSET.
      const yesLeg = arb.legs.find((l) => l.buy === 'yes')!;
      expect(yesLeg.subtitle).toBe('Before 2030');
    }
  });

  it('ignores categorical/structured markets entirely (no strike semantics to exploit)', () => {
    const categorical = {
      event_ticker: 'KXNEWPOPE-70', title: 'Who will the next Pope be?', mutually_exclusive: true,
      markets: [
        { ticker: 'A', yes_sub_title: 'A', strike_type: 'custom', yes_bid_dollars: '0.0400', yes_ask_dollars: '0.0460', no_ask_dollars: '0.9600' },
        { ticker: 'B', yes_sub_title: 'B', strike_type: 'custom', yes_bid_dollars: '0.9000', yes_ask_dollars: '0.9200', no_ask_dollars: '0.1000' },
      ],
    };
    expect(findLadderViolations(categorical)).toHaveLength(0);
  });
});

describe('findOverround — sound under mutual exclusivity alone', () => {
  it('fires when the YES bids sum above $1 (selling every outcome collects more than $1)', () => {
    const ev = {
      event_ticker: 'E', title: 'Overpriced field', mutually_exclusive: true,
      markets: [
        { ticker: 'A', yes_sub_title: 'A', yes_bid_dollars: '0.6000', yes_ask_dollars: '0.6200', no_ask_dollars: '0.4000' },
        { ticker: 'B', yes_sub_title: 'B', yes_bid_dollars: '0.6000', yes_ask_dollars: '0.6200', no_ask_dollars: '0.4000' },
      ],
    };
    // Buy both NOs at 40c = 80c + fees; at most one resolves YES so >=1 NO pays $1.
    const arb = findOverround(ev);
    expect(arb).not.toBeNull();
    expect(arb!.guaranteed).toBe(true);
    expect(arb!.worstCasePayout).toBe(1);
    expect(arb!.profitPerBasket).toBeGreaterThan(0);
  });

  it('stays silent on a normally-priced field, and on non-mutually-exclusive events', () => {
    const fair = {
      event_ticker: 'E', title: 'Fair', mutually_exclusive: true,
      markets: [
        { ticker: 'A', yes_sub_title: 'A', yes_bid_dollars: '0.4800', yes_ask_dollars: '0.5000', no_ask_dollars: '0.5200' },
        { ticker: 'B', yes_sub_title: 'B', yes_bid_dollars: '0.4800', yes_ask_dollars: '0.5000', no_ask_dollars: '0.5200' },
      ],
    };
    expect(findOverround(fair)).toBeNull();
    expect(findOverround({ ...fair, mutually_exclusive: false })).toBeNull();
  });
});

describe('findUnderround — never claims a guarantee', () => {
  it('reports a cheap basket as a CANDIDATE, not a lock (exhaustiveness is unproven)', () => {
    const ev = {
      event_ticker: 'E', title: 'Cheap field', mutually_exclusive: true,
      markets: [
        { ticker: 'A', yes_sub_title: 'A', yes_bid_dollars: '0.2000', yes_ask_dollars: '0.2200', no_ask_dollars: '0.8000' },
        { ticker: 'B', yes_sub_title: 'B', yes_bid_dollars: '0.2000', yes_ask_dollars: '0.2200', no_ask_dollars: '0.8000' },
      ],
    };
    const arb = findUnderround(ev);
    expect(arb).not.toBeNull();
    expect(arb!.guaranteed).toBe(false);           // the whole point — an unlisted outcome pays $0
    expect(arb!.rationale).toMatch(/NOT a lock/);
  });
});

describe('parseMarketDate — the wrong-day regression', () => {
  it('reads the SETTLEMENT date from the ticker, not close_time', () => {
    // KXHIGHNY-26JUL14-* measures Jul 14's high but CLOSES 2026-07-15T04:59Z (UTC rollover).
    // Matching forecasts to markets by close_time priced the Jul-14 book against the Jul-15
    // forecast and produced a +55c "edge" out of a perfectly-priced market.
    expect(parseMarketDate('KXHIGHNY-26JUL14-B94.5')).toBe('2026-07-14');
    expect(parseMarketDate('KXHIGHAUS-26JUL14-T85')).toBe('2026-07-14');
    expect(parseMarketDate('KXHIGHCHI-26DEC01-B30.5')).toBe('2026-12-01');
  });

  it('returns null for tickers with no date (never guesses)', () => {
    expect(parseMarketDate('KXNEWPOPE-70-PPIZ')).toBeNull();
    expect(parseMarketDate('KXELONMARS-99')).toBeNull();
  });
});
