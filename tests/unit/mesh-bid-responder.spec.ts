/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the bid self-score contract (ADR-083 Tier-1): the true owner clears the 0.5 auction threshold on its OWN keyword evidence; off-domain bots score ~0 (no free baseline); a name-token hit alone can never claim a ticket; the required-capabilities path (build pipeline) still works.
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

  it('a single shared keyword ("buy") is weak evidence — below the auction threshold', () => {
    // The trading audit says nothing retail; shopping matched nothing here, and even a
    // one-keyword graze must not claim a ticket (the "target"-style collision class).
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
