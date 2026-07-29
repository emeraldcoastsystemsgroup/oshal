/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the scalar ensemble entry model ported from NT8Custom ATCEnsembleGen.cs: the nine participating contributors (adaptive-Laguerre excluded), membership-derived maxPossible (never a hardcoded ±14), the percentage entry threshold with long/short symmetry, no-mandatory-indicator behavior, and the dual-floor confirmation exit including his zero-entry-score dormancy guard and the never-retreating peak.
 */
import { describe, it, expect } from 'vitest';
import {
  ENSEMBLE_CONTRIBUTORS, ensembleScore, ensembleEntrySignal, createEnsembleConfirmation,
  gradeDmiStateEnsemble, gradeLagFilterStateEnsemble,
  type GradedStates,
} from '../../src/features/trading';

/** All ten graded states at once; every contributor neutral unless overridden. */
function states(over: Partial<GradedStates> = {}): GradedStates {
  return {
    dmi: 0, macd: 0, mfi: 0, lagOsc: 0, lagFilter: 0, eit: 0,
    superTrend: 0, lagRsi: 0, wavePattern: 0, adaptiveLagFilter: 0,
    ...over,
  };
}

/** Every contributor at the given scaler. */
function allAt(v: number): GradedStates {
  const s = states();
  for (const k of ENSEMBLE_CONTRIBUTORS) s[k] = v;
  return s;
}

describe('ensemble membership', () => {
  it('has exactly the NINE contributors his code sums, in his order', () => {
    expect([...ENSEMBLE_CONTRIBUTORS]).toEqual([
      'dmi', 'macd', 'mfi', 'lagOsc', 'lagFilter', 'eit', 'superTrend', 'lagRsi', 'wavePattern',
    ]);
  });

  it('EXCLUDES the adaptive-Laguerre-filter state — it is graded but takes no part', () => {
    expect(ENSEMBLE_CONTRIBUTORS as readonly string[]).not.toContain('adaptiveLagFilter');
    // Proof it cannot influence the score: swing it to its extreme and nothing moves.
    const a = ensembleScore(states({ adaptiveLagFilter: 2 }));
    const b = ensembleScore(states({ adaptiveLagFilter: -2 }));
    expect(a.score).toBe(0);
    expect(b.score).toBe(0);
  });
});

describe('ensembleScore', () => {
  it('sums the enabled scalers and maxes at 2 per contributor (all nine → 18)', () => {
    const s = ensembleScore(allAt(2));
    expect(s.score).toBe(18);
    expect(s.maxPossible).toBe(18);
  });

  it('derives maxPossible from MEMBERSHIP, not from a hardcoded ±14', () => {
    // His prose says "(−14, 14) when there are 7 indicators" and his pseudocode then hardcodes 14;
    // his shipped CalculateMaxPossibleScore() counts enabled flags × 2, which is what we port.
    const seven = ensembleScore(allAt(2), { lagRsi: false, wavePattern: false });
    expect(seven.maxPossible).toBe(14);
    expect(seven.score).toBe(14);
    const three = ensembleScore(allAt(2), {
      mfi: false, lagOsc: false, lagFilter: false, eit: false, superTrend: false, lagRsi: false,
    });
    expect(three.maxPossible).toBe(6);
    expect(three.score).toBe(6);
  });

  it('a disabled contributor is excluded from BOTH the score and the maximum', () => {
    const s = ensembleScore(states({ dmi: 2, macd: -2 }), { macd: false });
    expect(s.score).toBe(2);           // the −2 is gone
    expect(s.maxPossible).toBe(16);    // and so is its headroom
    expect(s.contributions.macd).toBeUndefined();
    expect(s.contributions.dmi).toBe(2);
  });

  it('mixes positive and negative scalers arithmetically', () => {
    expect(ensembleScore(states({ dmi: 2, macd: 1, mfi: -1, lagOsc: -2 })).score).toBe(0);
  });
});

describe('ensembleEntrySignal', () => {
  const pct = 70;

  it('fires long at exactly the threshold (70% of 18 = 12.6 → score 13)', () => {
    expect(ensembleEntrySignal({ score: 13, maxPossible: 18, contributions: {} }, pct)).toBe('long');
    expect(ensembleEntrySignal({ score: 12, maxPossible: 18, contributions: {} }, pct)).toBeNull();
  });

  it('is symmetric for shorts', () => {
    expect(ensembleEntrySignal({ score: -13, maxPossible: 18, contributions: {} }, pct)).toBe('short');
    expect(ensembleEntrySignal({ score: -12, maxPossible: 18, contributions: {} }, pct)).toBeNull();
  });

  it('scales with membership: 7 contributors move the bar to 9.8, not 12.6', () => {
    expect(ensembleEntrySignal({ score: 10, maxPossible: 14, contributions: {} }, pct)).toBe('long');
    expect(ensembleEntrySignal({ score: 10, maxPossible: 18, contributions: {} }, pct)).toBeNull();
  });

  it('needs NO specific indicator — a signal fires with the oscillator flat or against', () => {
    // The unanimous-AND generations require lagOsc > 0 AND rising; the ensemble does not.
    const flatOsc = ensembleScore(states({
      dmi: 2, macd: 2, mfi: 2, lagFilter: 2, eit: 2, superTrend: 2, lagRsi: 2, wavePattern: 2, lagOsc: 0,
    }));
    expect(flatOsc.score).toBe(16);
    expect(ensembleEntrySignal(flatOsc, pct)).toBe('long');
    const againstOsc = ensembleScore(states({
      dmi: 2, macd: 2, mfi: 2, lagFilter: 2, eit: 2, superTrend: 2, lagRsi: 2, wavePattern: 2, lagOsc: -2,
    }));
    expect(againstOsc.score).toBe(14); // ≥ 12.6
    expect(ensembleEntrySignal(againstOsc, pct)).toBe('long');
  });

  it('an EMPTY ensemble never signals — a LABELLED NT8 deviation (his code goes long every bar)', () => {
    const empty = ensembleScore(states(), Object.fromEntries(ENSEMBLE_CONTRIBUTORS.map((k) => [k, false])));
    expect(empty.maxPossible).toBe(0);
    expect(ensembleEntrySignal(empty, pct)).toBeNull();
  });

  it('a 100% threshold demands every contributor ultra-aligned', () => {
    expect(ensembleEntrySignal({ score: 17, maxPossible: 18, contributions: {} }, 100)).toBeNull();
    expect(ensembleEntrySignal({ score: 18, maxPossible: 18, contributions: {} }, 100)).toBe('long');
  });
});

describe('ensemble confirmation exit — the dual floor', () => {
  it('exits when strength drops below the ENTRY-retention floor (90% of entry)', () => {
    const c = createEnsembleConfirmation({ retentionPct: 90, drawdownPct: 0 });
    c.onEntry(10, 'long');
    expect(c.onBar(10).exit).toBe(false);
    expect(c.onBar(9).exit).toBe(false); // 9 ≥ 9.0
    expect(c.onBar(8).exit).toBe(true);  // 8 < 9.0
  });

  it('exits when strength drops below the PEAK-drawdown floor — "this is the key"', () => {
    const c = createEnsembleConfirmation({ retentionPct: 0, drawdownPct: 93 });
    c.onEntry(10, 'long');
    expect(c.onBar(16).exit).toBe(false); // new peak 16 → floor 14.88
    expect(c.onBar(15).exit).toBe(false); // 15 ≥ 14.88
    expect(c.onBar(14).exit).toBe(true);  // 14 < 14.88 — peaked out and gave back
  });

  it('binds on the GREATER of the two floors', () => {
    const c = createEnsembleConfirmation({ retentionPct: 90, drawdownPct: 93 });
    c.onEntry(10, 'long');
    const v = c.onBar(12); // peak 12 → drawdown floor 11.16 vs retention floor 9.0
    expect(v.minAllowed).toBeCloseTo(11.16, 10);
    expect(c.onBar(11).exit).toBe(true); // 11 < 11.16, even though it beats the entry floor
  });

  it('the peak NEVER retreats, so the floor only ratchets up', () => {
    const c = createEnsembleConfirmation({ retentionPct: 0, drawdownPct: 50 });
    c.onEntry(10, 'long');
    c.onBar(18);
    expect(c.onBar(12).peak).toBe(18); // still 18
    expect(c.onBar(12).minAllowed).toBeCloseTo(9, 10);
  });

  it('mirrors for shorts on ABSOLUTE strength (peak is the most negative score)', () => {
    const c = createEnsembleConfirmation({ retentionPct: 90, drawdownPct: 93 });
    c.onEntry(-10, 'short');
    const deeper = c.onBar(-16);
    expect(deeper.peak).toBe(-16);
    expect(deeper.exit).toBe(false);
    expect(c.onBar(-15).exit).toBe(false); // |−15| ≥ 14.88
    expect(c.onBar(-14).exit).toBe(true);  // |−14| < 14.88
  });

  it('stays DORMANT when the entry score was exactly 0 (his ensembleStateAtEntry != 0 guard)', () => {
    const c = createEnsembleConfirmation();
    c.onEntry(0, 'long');
    const v = c.onBar(0);
    expect(v.exit).toBe(false);
    expect(Number.isNaN(v.minAllowed)).toBe(true);
  });

  it('uses his defaults when unconfigured (90 / 93)', () => {
    const c = createEnsembleConfirmation();
    c.onEntry(10, 'long');
    expect(c.onBar(10).minAllowed).toBeCloseTo(9.3, 10); // max(9.0, 0.93×10)
  });
});

describe('ensemble-specific contributor grades (they differ from the Export chain)', () => {
  it('DMI needs ADX RISING in both branches; ±2 still needs ADX between the DI lines', () => {
    expect(gradeDmiStateEnsemble(40, 10, 30, 25)).toBe(2);   // rising, between
    expect(gradeDmiStateEnsemble(40, 10, 45, 40)).toBe(1);   // rising, not between
    expect(gradeDmiStateEnsemble(40, 10, 30, 30)).toBe(0);   // flat ADX → nothing
    expect(gradeDmiStateEnsemble(40, 10, 30, 35)).toBe(0);   // falling ADX → nothing
    expect(gradeDmiStateEnsemble(10, 40, 30, 25)).toBe(-2);  // bearish mirror
    expect(gradeDmiStateEnsemble(10, 40, 30, 35)).toBe(0);
  });

  it('the Laguerre-filter upgrade is an up/down CLOSE; both terms of the ±1 gate are required', () => {
    expect(gradeLagFilterStateEnsemble(99, 98, 101, 100.5)).toBe(2);  // rising, above, up close
    expect(gradeLagFilterStateEnsemble(99, 98, 101, 101.5)).toBe(1);  // rising, above, down close
    expect(gradeLagFilterStateEnsemble(99, 98, 98.5, 98)).toBe(0);    // rising but close below filter
    expect(gradeLagFilterStateEnsemble(98, 99, 97, 97.5)).toBe(-2);   // falling, below, down close
    expect(gradeLagFilterStateEnsemble(98, 99, 97, 96.5)).toBe(-1);   // falling, below, up close
    expect(gradeLagFilterStateEnsemble(99, 99, 101, 100)).toBe(0);    // flat filter
  });
});

describe('confirmation exit — the Math.Abs artifact (port it, never "fix" it)', () => {
  it('a score that flips fully AGAINST a long does NOT exit — |current| is strength, not direction', () => {
    // His code compares Math.Abs(current) to the floors (ATCEnsembleGen.cs:519, :527): a long armed
    // at 13 whose ensemble collapses to −14 reads as STRONGER (14 > 12.09), so the trade stays
    // open on a fully bearish ensemble. Faithful artifact; a directional "fix" must go red here.
    const c = createEnsembleConfirmation({ retentionPct: 90, drawdownPct: 93 });
    c.onEntry(13, 'long');
    const v = c.onBar(-14);
    expect(v.exit).toBe(false);
    expect(v.peak).toBe(13); // Math.max keeps the long-side peak; the flip does not advance it
  });

  it('mirrors for shorts: a +14 spike against a short armed at −13 does not exit', () => {
    const c = createEnsembleConfirmation({ retentionPct: 90, drawdownPct: 93 });
    c.onEntry(-13, 'short');
    expect(c.onBar(14).exit).toBe(false);
  });
});
