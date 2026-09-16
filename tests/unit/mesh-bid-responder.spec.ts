/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the bid self-score contract (ADR-083 Tier-1): the true owner clears the 0.5 auction threshold on its OWN keyword evidence; off-domain bots score ~0 (no free baseline); a name-token hit alone can never claim a ticket; the required-capabilities path (build pipeline) still works.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pins the evidence self-score that replaced min(1, hits/3): ONE specific declared word is now a claim (the 2026-09-15 misroute was trading-analyst bidding 0.30 on 'stock' and losing its own question), a single BORROWED word - a fragment of an unmatched phrase, or a word of a declared capability - is deliberately not; a hyphenated declaration and an inflected word are matchable; a declared word does not fire inside a longer word; a phrase-only persona can bid on a rephrasing; twenty declarations cannot out-bid four on the same sentence; each word of the ask is credited once; and more evidence always ranks strictly higher, so two owners can no longer saturate together and leave the 0.05 name tie-breaker to choose. Entry 1's 'a single shared keyword (buy) is weak evidence' case is retitled, not weakened - it always proved a bot matching NOTHING scores zero, which is still true; the one-declared-word rule below is the deliberate reversal of the sentence in its comment.
 */

import { describe, expect, it } from 'vitest';
import { computeBidConfidence } from '../../src/features/agent-management/services/mesh-bid-responder';

const TRADING_SELF = {
  agentName: 'trading-analyst',
  capabilities: ['market-signal-analysis', 'trade-decision', 'portfolio-audit', 'autopilot-pnl'],
  routingKeywords: ['trading', 'trade', 'portfolio', 'position', 'autopilot', 'pnl', 'risk gate', 'buy', 'sell'],
};

const SHOPPING_SELF = {
  agentName: 'shopping-concierge',
  capabilities: ['product-search', 'retail-price-comparison', 'retail-checkout-handoff'],
  routingKeywords: ['buy', 'purchase', 'shopping', 'add to cart', 'reorder', 'walmart', 'amazon', 'groceries'],
};

const TRADING_AUDIT = {
  title: 'Audit why trading stopped near $20k',
  description: 'Trace the morning trading timeline: cap seen by the autopilot, target exposure, actual exposure, positions, and any risk gate denials.',
  requiredCapabilities: [] as string[],
};

describe('computeBidConfidence (ADR-083 Tier-1 self-score)', () => {
  it('the true owner clears the 0.5 auction threshold on its own keyword evidence', () => {
    // trading, autopilot, position(s), risk gate → 3+ hits = full keyword claim.
    expect(computeBidConfidence(TRADING_AUDIT, TRADING_SELF)).toBeGreaterThanOrEqual(0.5);
  });

  it('an off-domain bot scores near zero — no free confidence baseline', () => {
    const offDomain = {
      title: 'Summarize my inbox for today',
      description: 'Read my Gmail and give me the morning digest.',
      requiredCapabilities: [] as string[],
    };
    expect(computeBidConfidence(offDomain, TRADING_SELF)).toBeLessThan(0.5);
    expect(computeBidConfidence(offDomain, SHOPPING_SELF)).toBeLessThan(0.5);
  });

  it('a bot whose declarations match NOTHING in the ticket cannot claim it', () => {
    // The trading audit says nothing retail — none of shopping's keywords or capability words
    // appear in it, so it has no evidence to bid on (the "target"-style collision class).
    // A bot that DOES match one of its own declared words is a different case, and is a claim:
    // see 'one specific declared word is a claim, a borrowed one is not' below.
    expect(computeBidConfidence(TRADING_AUDIT, SHOPPING_SELF)).toBeLessThan(0.5);
  });

  it('a name-token hit alone is only a 0.05 tie-breaker, never a claim', () => {
    const nameOnly = {
      title: 'The page mentions trading-analyst in a footnote',
      description: 'Nothing else relevant here at all.',
      requiredCapabilities: [] as string[],
    };
    const score = computeBidConfidence(nameOnly, {
      agentName: 'trading-analyst',
      capabilities: ['market-signal-analysis'],
      // keywords deliberately non-matching for this text — except the name token
      routingKeywords: ['portfolio', 'autopilot'],
    });
    // "trading" IS a name token of trading-analyst and appears — but with no keyword
    // evidence the total must stay at the tie-breaker level.
    expect(score).toBeLessThanOrEqual(0.05);
  });

  it('the required-capabilities path (build pipeline) still scores overlap', () => {
    const buildPhase = {
      title: 'Implement the feature',
      description: 'No owner keywords here.',
      requiredCapabilities: ['market-signal-analysis', 'trade-decision'],
    };
    // 2/2 required caps matched → 1.0 * 0.9 = 0.9.
    expect(computeBidConfidence(buildPhase, TRADING_SELF)).toBeGreaterThanOrEqual(0.9);
  });

  it('multi-word keyword phrases match as substrings of the ticket text', () => {
    const ask = {
      title: 'What is my net worth right now',
      description: 'Across my linked accounts please.',
      requiredCapabilities: [] as string[],
    };
    const finance = {
      agentName: 'finance-analyst',
      capabilities: ['net-worth-analysis'],
      routingKeywords: ['net worth', 'account balances', 'spending', 'plaid'],
    };
    expect(computeBidConfidence(ask, finance)).toBeGreaterThan(0);
  });
});

/** The 2026-09-15 misroute: one declared domain word, in a sentence that is unmistakably its subject. */
const STOCK_MARKET_ASK = {
  title: 'How did we do in the stock market today?',
  description: '',
  requiredCapabilities: [] as string[],
};

describe('computeBidConfidence: one specific declared word is a claim, a borrowed one is not', () => {
  it('lets a bot claim its own subject from a SINGLE declared keyword', () => {
    // 'stock' is the only declared trading word in this sentence (TRADING_SELF above is entry 1's
    // hand-written subset and omits it; the real persona declares it, and the end-to-end proof that
    // this exact title now reaches trading-analyst is in tests/unit/selector-benchmark.spec.ts).
    // Under min(1, hits/3) one hit scored 0.30, the auction found nothing above 0.5, and the ticket
    // fell through to the cruder tiers.
    const trading = { ...TRADING_SELF, routingKeywords: [...TRADING_SELF.routingKeywords, 'stock'] };
    expect(computeBidConfidence(STOCK_MARKET_ASK, trading)).toBeGreaterThanOrEqual(0.5);
  });

  it('does NOT let a word borrowed from an unmatched phrase claim anything on its own', () => {
    const drone = {
      agentName: 'drone-operator',
      capabilities: ['waypoint-planning'],
      routingKeywords: ['survey pattern', 'geofence', 'mission plan'],
    };
    const ask = { title: 'run a survey of the field today', description: '', requiredCapabilities: [] as string[] };
    const score = computeBidConfidence(ask, drone);
    expect(score, 'a lone phrase fragment claimed the ticket').toBeLessThan(0.5);
    expect(score, 'a phrase fragment must still be evidence, just not a claim').toBeGreaterThan(0);
  });

  it('does NOT let a single capability word claim anything on its own', () => {
    const sat = {
      agentName: 'sat-operator',
      capabilities: ['sat-telemetry-briefing', 'pass-window-awareness'],
      routingKeywords: [] as string[],
    };
    const ask = { title: 'pull the telemetry please', description: '', requiredCapabilities: [] as string[] };
    const score = computeBidConfidence(ask, sat);
    expect(score, 'one capability word claimed the ticket').toBeLessThan(0.5);
    expect(score, 'a capability-only owner must still be able to bid at all').toBeGreaterThan(0);
  });
});

describe('computeBidConfidence: a declaration is matchable in the words a person types', () => {
  const verifier = {
    agentName: 'delivery-verifier',
    capabilities: ['regression-guards'],
    routingKeywords: ['regression-guard', 'browser-test', 'proof', 'parity'],
  };

  it('matches a hyphenated declaration against the separated words', () => {
    const ask = { title: 'add a regression guard and a browser test as proof', description: '', requiredCapabilities: [] as string[] };
    expect(computeBidConfidence(ask, verifier)).toBeGreaterThanOrEqual(0.5);
  });

  it('matches an inflected form of a declared word', () => {
    // 'fill' is declared; the caller typed 'fills'. A raw substring test happens to catch this one,
    // a word-boundary test does not — the stem comparison is what makes both work.
    const ask = { title: 'what were the fills today', description: '', requiredCapabilities: [] as string[] };
    const trading = { agentName: 'trading-analyst', capabilities: ['order-forensics'], routingKeywords: ['fill', 'order'] };
    expect(computeBidConfidence(ask, trading)).toBeGreaterThanOrEqual(0.5);
  });

  it('does not let a declared word fire inside a longer, unrelated word', () => {
    const shopping = { agentName: 'shopping-concierge', capabilities: [], routingKeywords: ['buy'] };
    const ask = { title: 'the buyer walked away from the deal', description: '', requiredCapabilities: [] as string[] };
    expect(computeBidConfidence(ask, shopping), '"buy" claimed a ticket about a "buyer"').toBeLessThan(0.5);
  });

  it('lets a phrase-only persona bid on a rephrasing of its own declaration', () => {
    const architect = {
      agentName: 'system-architect',
      capabilities: ['technical-specification'],
      routingKeywords: ['system architecture', 'integration architecture', 'decomposition plan'],
    };
    const ask = { title: 'write the architecture for the new integration', description: '', requiredCapabilities: [] as string[] };
    // Compared against the SAME declarations under a name that does not appear in the ask, so the
    // 0.05 name tie-breaker cannot stand in for the evidence this case is actually asserting.
    const nameless = { ...architect, agentName: 'zzz-owner' };
    expect(
      computeBidConfidence(ask, nameless),
      'a phrase-only persona could not bid on a rephrasing of its own declaration',
    ).toBeGreaterThan(0);
  });
});

describe('computeBidConfidence: bids stay comparable across personas', () => {
  it('does not advantage twenty declarations over four on the same sentence', () => {
    const ask = { title: 'the geofence and the playlist', description: '', requiredCapabilities: [] as string[] };
    const wide = {
      agentName: 'wide-owner',
      capabilities: [],
      routingKeywords: ['geofence', 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india',
        'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra'],
    };
    const narrow = { agentName: 'narrow-owner', capabilities: [], routingKeywords: ['playlist', 'tango', 'uniform', 'victor'] };
    expect(computeBidConfidence(ask, wide)).toBe(computeBidConfidence(ask, narrow));
  });

  it('credits each word of the ask once, however many ways a persona declares it', () => {
    const ask = { title: 'the quarterly profit and loss report', description: '', requiredCapabilities: [] as string[] };
    const once = { agentName: 'once-owner', capabilities: [], routingKeywords: ['profit and loss'] };
    const thrice = {
      agentName: 'thrice-owner',
      capabilities: ['profit-and-loss-analysis'],
      routingKeywords: ['profit and loss', 'profit', 'loss'],
    };
    expect(computeBidConfidence(ask, thrice)).toBe(computeBidConfidence(ask, once));
  });

  it('does not rank an exact phrase declaration BELOW the same words declared loosely', () => {
    // This is what PHRASE_EVIDENCE = 2 buys, and the only thing it buys: measured on the
    // benchmark corpus, dropping it to 1 changes neither accuracy (105/105) nor the tier split
    // (bid=102). It matters here — at 1 an exact 'profit and loss' would be worth ONE, while a
    // bot that happened to declare 'profit' and 'loss' separately collects TWO, so declaring the
    // precise phrase would cost its owner the ticket. 2 also matches the Tier-3 constant
    // (agent-router's PHRASE_MATCH_WEIGHT), so both tiers rank the same evidence the same way.
    const ask = { title: 'the quarterly profit and loss report', description: '', requiredCapabilities: [] as string[] };
    const phrase = { agentName: 'phrase-owner', capabilities: [], routingKeywords: ['profit and loss'] };
    const loose = { agentName: 'loose-owner', capabilities: [], routingKeywords: ['profit', 'loss'] };
    expect(
      computeBidConfidence(ask, phrase),
      'the owner that declared the exact phrase was out-bid by one that declared its words loosely',
    ).toBeGreaterThanOrEqual(computeBidConfidence(ask, loose));
  });

  it('does not let a declaration made only of function words claim an ordinary sentence', () => {
    // delivery-architect really declares 'as-is-to-be'. Separator normalization turns that into the
    // bare auxiliary 'to be', which scored a full phrase hit (0.692) — above the 0.5 threshold and
    // above a true owner holding one real declared word (0.5625) — so its declarer claimed any
    // sentence containing those two words. Found by the independent verification of this change.
    const flight = { title: 'my flight is going to be late', description: '', requiredCapabilities: [] as string[] };
    const functionWords = { agentName: 'delivery-architect', capabilities: [], routingKeywords: ['as-is-to-be', 'to-be'] };
    const trueOwner = { agentName: 'travel-concierge', capabilities: [], routingKeywords: ['flight'] };
    expect(
      computeBidConfidence(flight, functionWords),
      'a declaration of nothing but function words bid on an ordinary sentence',
    ).toBe(0);
    expect(computeBidConfidence(flight, trueOwner)).toBeGreaterThan(computeBidConfidence(flight, functionWords));

    // The same bot still bids on its REAL subject: the domain words in the declaration survive.
    const real = { title: 'draw the as-is and to-be architecture diagrams', description: '', requiredCapabilities: [] as string[] };
    const architect = { agentName: 'delivery-architect', capabilities: [], routingKeywords: ['architecture diagram', 'as-is-to-be'] };
    expect(computeBidConfidence(real, architect)).toBeGreaterThan(0.5);
  });

  it('always ranks more evidence strictly higher — nothing saturates into a tie', () => {
    const ask = { title: 'geofence waypoint takeoff rtl', description: '', requiredCapabilities: [] as string[] };
    const two = { agentName: 'two-owner', capabilities: [], routingKeywords: ['geofence', 'waypoint'] };
    const four = { agentName: 'four-owner', capabilities: [], routingKeywords: ['geofence', 'waypoint', 'takeoff', 'rtl'] };
    const twoScore = computeBidConfidence(ask, two);
    const fourScore = computeBidConfidence(ask, four);
    expect(fourScore).toBeGreaterThan(twoScore);
    expect(fourScore, 'a saturated 1.0 leaves the 0.05 name boost deciding the auction').toBeLessThan(1);
  });
});
