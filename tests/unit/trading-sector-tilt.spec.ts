/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards TRADING_SECTOR_TILT: neutral-by-default (an unset knob must not move the ranking), the lean actually re-orders, and the sign-preservation property rotateSleeve's `score > 0` admission depends on.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-168: a lean on a multi-market bucket (fixed-income) re-orders a ranking that holds extension names, and leaves a default-universe-only ranking byte-identical — the extension buckets are new, so no existing lean can reach a default name through them.
 */

import { describe, expect, it } from 'vitest';
import { parseSectorTilt, sectorTiltConfig, applySectorTilt, MAX_SECTOR_TILT } from '../../src/features/trading/services/sector-tilt';
import { sectorOf, MULTI_MARKET_BUCKETS } from '../../src/features/trading/services/portfolio';
import { DEFAULT_UNIVERSE } from '../../src/features/trading/services/multi-timeframe';

/** Sort the way rotateSleeve does, then take the leaderboard it would buy (`score > 0`, top N). */
const leaderboard = (ranked: Array<{ sym: string; score: number }>, n: number): string[] =>
  [...ranked].sort((a, b) => b.score - a.score).filter((r) => r.score > 0).slice(0, n).map((r) => r.sym);

describe('parseSectorTilt', () => {
  it('returns an empty (neutral) map for unset, empty, and whitespace input', () => {
    for (const raw of [undefined, null, '', '   ', ',, ,']) {
      expect(parseSectorTilt(raw).size).toBe(0);
    }
  });

  it('parses sector:multiplier pairs and lower-cases the sector', () => {
    const tilt = parseSectorTilt('materials:1.5, Energy:1.2');
    expect(tilt.get('materials')).toBe(1.5);
    expect(tilt.get('energy')).toBe(1.2);
    expect(tilt.size).toBe(2);
  });

  it('SKIPS malformed entries instead of defaulting them, so a typo cannot silently re-weight a book', () => {
    const tilt = parseSectorTilt('materials:abc,energy,:2,tech:1.4,storage:-1');
    expect(tilt.has('materials')).toBe(false); // non-numeric multiplier
    expect(tilt.has('energy')).toBe(false);    // no separator
    expect(tilt.has('')).toBe(false);          // no sector name
    expect(tilt.has('storage')).toBe(false);   // negative would flip signs — refused
    expect(tilt.get('tech')).toBe(1.4);        // the one well-formed entry still applies
    expect(tilt.size).toBe(1);
  });

  it('clamps a multiplier to MAX_SECTOR_TILT', () => {
    expect(parseSectorTilt('materials:999').get('materials')).toBe(MAX_SECTOR_TILT);
  });

  it('reads the knob from TRADING_SECTOR_TILT', () => {
    const prior = process.env.TRADING_SECTOR_TILT;
    try {
      delete process.env.TRADING_SECTOR_TILT;
      expect(sectorTiltConfig().size).toBe(0);
      process.env.TRADING_SECTOR_TILT = 'materials:2';
      expect(sectorTiltConfig().get('materials')).toBe(2);
    } finally {
      if (prior === undefined) delete process.env.TRADING_SECTOR_TILT;
      else process.env.TRADING_SECTOR_TILT = prior;
    }
  });
});

describe('applySectorTilt', () => {
  // FCX/NEM are 'materials', NVDA/AMD are 'tech' — assert the fixtures really bucket that way, so
  // this spec fails loudly if the sector map is re-bucketed underneath it.
  it('fixture symbols bucket into the sectors this spec assumes', () => {
    expect(sectorOf('FCX')).toBe('materials');
    expect(sectorOf('NEM')).toBe('materials');
    expect(sectorOf('NVDA')).toBe('tech');
  });

  it('an empty tilt leaves every score untouched (unset knob = no behavior change)', () => {
    const ranked = [{ sym: 'NVDA', score: 1.4 }, { sym: 'FCX', score: 0.9 }, { sym: 'AMD', score: -0.3 }];
    expect(applySectorTilt(ranked, new Map())).toEqual(ranked);
  });

  it('does not mutate the input array', () => {
    const ranked = [{ sym: 'FCX', score: 1 }];
    applySectorTilt(ranked, new Map([['materials', 3]]));
    expect(ranked[0].score).toBe(1);
  });

  it('leans the leaderboard toward the tilted sector', () => {
    const ranked = [{ sym: 'NVDA', score: 1.2 }, { sym: 'FCX', score: 0.9 }];
    // Untilted, tech leads.
    expect(leaderboard(applySectorTilt(ranked, new Map()), 1)).toEqual(['NVDA']);
    // A 1.5x materials lean promotes FCX (0.9 -> 1.35) past NVDA.
    expect(leaderboard(applySectorTilt(ranked, new Map([['materials', 1.5]])), 1)).toEqual(['FCX']);
  });

  it('untilted sectors keep their exact score while a tilted sector scales', () => {
    const tilted = applySectorTilt(
      [{ sym: 'NVDA', score: 1.2 }, { sym: 'FCX', score: 0.9 }],
      new Map([['materials', 2]]),
    );
    expect(tilted.find((r) => r.sym === 'NVDA')!.score).toBe(1.2);
    expect(tilted.find((r) => r.sym === 'FCX')!.score).toBeCloseTo(1.8, 10);
  });

  // THE safety property rotateSleeve depends on: it admits candidates on `score > 0`, so a tilt must
  // never change a sign. A lean may re-order the eligible set; it may not manufacture eligibility.
  it('never flips a sign — a negatively-scored name stays out of the leaderboard at any tilt', () => {
    const ranked = [{ sym: 'NVDA', score: 0.5 }, { sym: 'FCX', score: -0.8 }];
    for (const mult of [1.5, 3, MAX_SECTOR_TILT]) {
      const out = applySectorTilt(ranked, new Map([['materials', mult]]));
      expect(out.find((r) => r.sym === 'FCX')!.score).toBeLessThan(0);
      expect(leaderboard(out, 10)).not.toContain('FCX');
    }
  });

  it('cannot demote a positively-scored name out of eligibility', () => {
    const ranked = [{ sym: 'NVDA', score: 0.5 }, { sym: 'FCX', score: 0.1 }];
    // Even a heavy lean on the OTHER sector leaves NVDA eligible — only its rank can change.
    expect(leaderboard(applySectorTilt(ranked, new Map([['materials', MAX_SECTOR_TILT]])), 10)).toContain('NVDA');
  });

  it('a tilt of 0 mutes the sector — the supported way to drop it without editing the universe', () => {
    const ranked = [{ sym: 'NVDA', score: 0.5 }, { sym: 'FCX', score: 2 }];
    expect(leaderboard(applySectorTilt(ranked, new Map([['materials', 0]])), 10)).toEqual(['NVDA']);
  });
});

describe('applySectorTilt over the ADR-168 multi-market buckets', () => {
  it('a fixed-income lean promotes a Treasury fund past an equity leader', () => {
    expect(sectorOf('TLT')).toBe('fixed-income');
    const ranked = [{ sym: 'NVDA', score: 1.2 }, { sym: 'TLT', score: 0.9 }];
    expect(leaderboard(applySectorTilt(ranked, new Map()), 1)).toEqual(['NVDA']);
    expect(leaderboard(applySectorTilt(ranked, parseSectorTilt('fixed-income:1.5')), 1)).toEqual(['TLT']);
  });

  it('a lean on every extension bucket leaves a default-universe-only ranking byte-identical', () => {
    const ranked = DEFAULT_UNIVERSE.map((sym, i) => ({ sym, score: ((i * 7) % 11) / 10 - 0.3 }));
    const tilt = new Map(Object.keys(MULTI_MARKET_BUCKETS).map((b) => [b, MAX_SECTOR_TILT] as [string, number]));
    expect(applySectorTilt(ranked, tilt)).toEqual(ranked);
  });
});

