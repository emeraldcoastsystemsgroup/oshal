/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deterministic classifier on real Benzinga headline shapes (incl. the RKLB/KLAC leads from the 07-12 recall test), sweep-#5 exclusion classes, precedence (rating change > PT move), neutral initiations as no-calls.
 */
import { describe, it, expect } from 'vitest';
import { classifyAnalystHeadline } from '../../src/features/trading/services/analyst-actions';

const cls = (h: string) => classifyAnalystHeadline(h)?.cls ?? null;

describe('classifyAnalystHeadline — real wire shapes', () => {
  it('classifies the two headlines that LED moves in the 07-12 recall test', () => {
    // RKLB — 60 min ahead of a +~4% surge; KLAC — 5 min ahead.
    expect(classifyAnalystHeadline('B of A Securities Maintains Buy on Rocket Lab USA, Raises Price Target to $55'))
      .toMatchObject({ cls: 'pt-raise', dir: 'up', broker: 'B of A Securities' });
    expect(classifyAnalystHeadline('Cantor Fitzgerald Maintains Overweight on KLA, Raises Price Target to $1,050'))
      .toMatchObject({ cls: 'pt-raise', dir: 'up' });
  });
  it('rating changes and PT cuts, both directions', () => {
    expect(cls('Morgan Stanley Upgrades Apple to Overweight, Announces $300 Price Target')).toBe('upgrade');
    expect(cls('Goldman Sachs Downgrades Intel to Neutral, Lowers Price Target to $28')).toBe('downgrade');
    expect(cls('JPMorgan Lowers Price Target on Nike to $85')).toBe('pt-cut');
    expect(cls('Wells Fargo Boosts Price Target on Nvidia to $220')).toBe('pt-raise');
  });
  it('initiations classify only with a directional rating', () => {
    expect(cls('KeyBanc Initiates Coverage On Palantir with Overweight Rating, Announces $180 Price Target')).toBe('initiation-bull');
    expect(cls('Citi Initiates Coverage On Foo Corp with Sell Rating')).toBe('initiation-bear');
    expect(cls('Barclays Initiates Coverage On Bar Inc with Equal-Weight Rating')).toBe(null);
    expect(cls('UBS Initiates Coverage On Baz with Neutral Rating, Announces $50 Price Target')).toBe(null);
  });
  it('precedence: a rating change that also moves the PT is the rating change', () => {
    expect(cls('Piper Sandler Upgrades AMD to Overweight, Raises Price Target to $210')).toBe('upgrade');
    expect(cls('Bernstein Downgrades Tesla to Underperform, Cuts Price Target to $150')).toBe('downgrade');
  });
  it('bare reiterations with no PT move are no-calls (no new information)', () => {
    expect(cls('Jefferies Reiterates Buy on Microsoft')).toBe(null);
    expect(cls('RBC Maintains Outperform on Amazon')).toBe(null);
  });
  it('sweep-#5 noise classes are excluded before anything else', () => {
    expect(cls('Top 10 Stocks To Watch This Week: Nvidia, Tesla And Other Big Movers')).toBe(null);
    expect(cls("What's Going On With AMD Stock Monday?")).toBe(null);
    expect(cls('Why Is Rocket Lab Trading Higher? Analyst Raises Price Target')).toBe(null);
    expect(cls('12 Stocks Analysts Love: Price Target Raised On Several Names')).toBe(null);
    expect(cls('Market Recap: Analysts Raise Price Targets Across Semis')).toBe(null);
    expect(cls('Is Apple A Buy After The Upgrade?')).toBe(null);
  });
  it('non-analyst headlines are no-calls', () => {
    expect(cls('Apple Announces $9B Datacenter Investment In Texas')).toBe(null);
    expect(cls('Moderna Receives FDA Approval For Updated Vaccine')).toBe(null);
    expect(cls('')).toBe(null);
  });
});
