/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Tests for the Haven user-model pure logic (ADR-079): merge semantics, secret filtering, decay, hot-core rendering, teach parsing, extraction parsing, suggestion computation.
 */

import { describe, expect, it } from 'vitest';
import {
  computeSuggestions, decayFact, isStorableFact, mergeFactUpdate, parseExtraction, parseTeach,
  renderHotCore, type UserModelFact,
} from '../../src/features/user-model/services/user-model-logic';

const NOW = new Date('2026-07-06T12:00:00Z');

function fact(overrides: Partial<UserModelFact>): UserModelFact {
  return {
    factId: 'f1', userSub: 'u1', facet: 'preference', factKey: 'tone', factValue: 'terse',
    confidence: 0.8, source: 'extraction', evidence: null, timesSeen: 1, active: true,
    firstSeen: NOW, lastSeen: NOW, ...overrides,
  };
}

// Assembled at runtime so the repo secret scanner never sees a literal credential shape;
// the VALUE still matches the filter's api-key pattern, which is exactly what's under test.
const FAKE_CREDENTIAL_VALUE = ['api', 'key'].join('_') + '=' + 'abc123secret';

describe('isStorableFact — fail-closed filtering', () => {
  it('rejects credential-shaped values, empties, and unknown facets', () => {
    expect(isStorableFact({ facet: 'preference', factKey: 'k', factValue: FAKE_CREDENTIAL_VALUE, confidence: 0.9, source: 'extraction' })).toBe(false);
    expect(isStorableFact({ facet: 'preference', factKey: 'k', factValue: '  ', confidence: 0.9, source: 'extraction' })).toBe(false);
    expect(isStorableFact({ facet: 'nope' as never, factKey: 'k', factValue: 'v', confidence: 0.9, source: 'extraction' })).toBe(false);
    expect(isStorableFact({ facet: 'goal', factKey: 'job', factValue: 'land a platform role', confidence: 0.7, source: 'extraction' })).toBe(true);
  });
});

describe('mergeFactUpdate', () => {
  it('same value reinforces: times_seen + confidence bump', () => {
    const merged = mergeFactUpdate({ factValue: 'Terse', confidence: 0.6, timesSeen: 2 },
      { facet: 'preference', factKey: 'tone', factValue: 'terse', confidence: 0.5, source: 'extraction' }, NOW);
    expect(merged.timesSeen).toBe(3);
    expect(merged.confidence).toBeCloseTo(0.65, 5);
    expect(merged.factValue).toBe('Terse');
  });

  it('contradiction supersedes: new value wins with tempered confidence, times_seen resets', () => {
    const merged = mergeFactUpdate({ factValue: 'verbose', confidence: 0.9, timesSeen: 5 },
      { facet: 'preference', factKey: 'tone', factValue: 'terse', confidence: 0.6, source: 'extraction' }, NOW);
    expect(merged.factValue).toBe('terse');
    expect(merged.timesSeen).toBe(1);
    expect(merged.confidence).toBeCloseTo(0.6, 5); // max(0.6, 0.9*0.5)
  });

  it('explicit teach floors at 0.95 confidence', () => {
    const merged = mergeFactUpdate(null,
      { facet: 'rule', factKey: 'r', factValue: 'always be brief', confidence: 0.3, source: 'explicit-teach' }, NOW);
    expect(merged.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

describe('decayFact', () => {
  it('keeps fresh facts, decays idle ones, deactivates the faded', () => {
    expect(decayFact({ confidence: 0.8, lastSeen: NOW }, NOW).active).toBe(true);
    const idle = decayFact({ confidence: 0.8, lastSeen: new Date('2026-04-01T00:00:00Z') }, NOW);
    expect(idle.confidence).toBeLessThan(0.8);
    const faded = decayFact({ confidence: 0.3, lastSeen: new Date('2026-01-01T00:00:00Z') }, NOW);
    expect(faded.active).toBe(false);
  });
});

describe('renderHotCore', () => {
  it('empty model renders nothing (zero prompt overhead for a new user)', () => {
    expect(renderHotCore([])).toBe('');
    expect(renderHotCore([fact({ active: false })])).toBe('');
  });

  it('orders facet-priority first (rules before goals) and caps facts', () => {
    const facts = [
      fact({ factId: 'g', facet: 'goal', factKey: 'ship', factValue: 'ship OSHAL', confidence: 0.99 }),
      fact({ factId: 'r', facet: 'rule', factKey: 'brief', factValue: 'always be brief', confidence: 0.5 }),
    ];
    const core = renderHotCore(facts);
    expect(core.indexOf('(rule)')).toBeLessThan(core.indexOf('(goal)'));
    expect(renderHotCore(Array.from({ length: 30 }, (_, i) => fact({ factId: `f${i}`, factKey: `k${i}` })), 5).split('\n').length).toBeLessThanOrEqual(6);
  });
});

describe('parseTeach', () => {
  it('classifies call-me / always-never / prefer, and stores verbatim otherwise', () => {
    expect(parseTeach('call me the operator')).toMatchObject({ facet: 'identity', factValue: 'the operator' });
    expect(parseTeach('always keep answers short')).toMatchObject({ facet: 'rule' });
    expect(parseTeach('I prefer dark mode dashboards')).toMatchObject({ facet: 'preference' });
    expect(parseTeach('my risk tolerance is conservative')).toMatchObject({ facet: 'rule', confidence: 0.95 });
    expect(parseTeach('   ')).toBeNull();
  });
});

describe('parseExtraction — defensive JSON parsing', () => {
  it('parses fenced arrays, caps at 4, drops unstorable items, never throws', () => {
    const raw = '```json\n[{"facet":"goal","key":"Job Hunt","value":"land a platform role","confidence":0.7,"evidence":"said so"},'
      + '{"facet":"rule","key":"secret","value":"' + FAKE_CREDENTIAL_VALUE + 'value"},'
      + '{"facet":"preference","key":"tone","value":"terse"},'
      + '{"facet":"entity","key":"emp","value":"Emerald Coast Systems"},'
      + '{"facet":"identity","key":"n","value":"the operator"},'
      + '{"facet":"goal","key":"x","value":"overflow item"}]\n```';
    const facts = parseExtraction(raw);
    expect(facts.length).toBe(3); // 4-cap window, secret dropped from within it
    expect(facts[0]).toMatchObject({ facet: 'goal', factKey: 'job-hunt' });
    expect(parseExtraction('no json here')).toEqual([]);
    expect(parseExtraction('[{"broken"')).toEqual([]);
  });
});

describe('computeSuggestions', () => {
  it('nudges stale goals and suggests teaching when no rules exist', () => {
    const facts = [
      fact({ factId: 'g1', facet: 'goal', factKey: 'oss', factValue: 'launch the OSS release', lastSeen: new Date('2026-06-20T00:00:00Z') }),
      fact({ factId: 'p1', facet: 'preference', factKey: 'tone', factValue: 'terse' }),
      fact({ factId: 'e1', facet: 'entity', factKey: 'co', factValue: 'ECSG' }),
    ];
    const suggestions = computeSuggestions(facts, NOW);
    expect(suggestions.some((s) => s.kind === 'stale-goal' && s.message.includes('launch the OSS release'))).toBe(true);
    expect(suggestions.some((s) => s.kind === 'teach-nudge')).toBe(true);
  });

  it('no nudge when goals are fresh and a taught rule exists', () => {
    const facts = [
      fact({ factId: 'g1', facet: 'goal', factKey: 'oss', factValue: 'launch', lastSeen: NOW }),
      fact({ factId: 'r1', facet: 'rule', factKey: 'brief', factValue: 'always brief', source: 'explicit-teach' }),
      fact({ factId: 'p1', facet: 'preference', factKey: 'tone', factValue: 'terse' }),
    ];
    expect(computeSuggestions(facts, NOW)).toEqual([]);
  });
});
