/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard: cross-session model compaction bounds the ACTIVE model without ever retiring something the user explicitly taught or their identity, keeps the strongest facts, is deterministic run-to-run, and does nothing at all while the model fits.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ACTIVE_FACTS,
  factRetentionScore,
  isCompactionProtected,
  planModelCompaction,
  type UserModelFact,
} from '@/features/user-model';

const NOW = new Date('2026-08-02T12:00:00.000Z');

function fact(over: Partial<UserModelFact> & { factId: string }): UserModelFact {
  return {
    userSub: 'auth0|owner-1',
    facet: 'entity',
    factKey: over.factId,
    factValue: `value for ${over.factId}`,
    confidence: 0.6,
    source: 'extraction',
    evidence: null,
    timesSeen: 1,
    active: true,
    firstSeen: NOW,
    lastSeen: NOW,
    ...over,
  };
}

/** N compactable extraction facts, each staler and weaker than the last. */
function ladder(count: number): UserModelFact[] {
  return Array.from({ length: count }, (_, i) => fact({
    factId: `f-${String(i).padStart(3, '0')}`,
    confidence: 0.95 - i * 0.005,
    lastSeen: new Date(NOW.getTime() - i * 86_400_000),
  }));
}

describe('haven model compaction', () => {
  it('does nothing while the model fits inside its bound', () => {
    const plan = planModelCompaction(ladder(10), NOW, DEFAULT_MAX_ACTIVE_FACTS);
    expect(plan.retire).toEqual([]);
    expect(plan.keptActive).toBe(10);
  });

  it('bounds the active model and retires the WEAKEST facts, not arbitrary ones', () => {
    const facts = ladder(20);
    const plan = planModelCompaction(facts, NOW, 12);
    expect(plan.retire).toHaveLength(8);
    expect(plan.keptActive).toBe(12);
    // The strongest/freshest survive; the stalest are the ones retired.
    expect(plan.retire).not.toContain('f-000');
    expect(plan.retire).toContain('f-019');
    // Weakest first, so a bounded per-run application still sheds the least valuable.
    expect(plan.retire[0]).toBe('f-019');
  });

  it('never retires something the user explicitly taught, or their identity — even at a tiny bound', () => {
    const taught = fact({
      factId: 'taught-1', facet: 'rule', source: 'explicit-teach', confidence: 0.95,
      lastSeen: new Date(NOW.getTime() - 400 * 86_400_000),   // ancient, and still protected
    });
    const name = fact({ factId: 'identity-1', facet: 'identity', source: 'extraction', confidence: 0.3 });
    expect(isCompactionProtected(taught)).toBe(true);
    expect(isCompactionProtected(name)).toBe(true);
    expect(isCompactionProtected(fact({ factId: 'ordinary' }))).toBe(false);

    const plan = planModelCompaction([taught, name, ...ladder(30)], NOW, 3);
    expect(plan.retire).not.toContain('taught-1');
    expect(plan.retire).not.toContain('identity-1');
    expect(plan.protectedCount).toBe(2);
    // Protected facts consume the budget; the compactable tail goes entirely.
    expect(plan.retire).toHaveLength(29);
  });

  it('already-inactive facts are left alone (they are already compacted)', () => {
    const facts = [...ladder(5), fact({ factId: 'gone', active: false })];
    expect(planModelCompaction(facts, NOW, 60).retire).toEqual([]);
    expect(planModelCompaction(facts, NOW, 2).retire).not.toContain('gone');
  });

  it('is deterministic: the same model compacts the same way twice', () => {
    const facts = ladder(25);
    const a = planModelCompaction(facts, NOW, 10);
    const b = planModelCompaction([...facts].reverse(), NOW, 10);
    expect(a.retire).toEqual(b.retire);
  });

  it('scoring rewards confidence, recency and reinforcement — and decays with idleness', () => {
    const fresh = fact({ factId: 'a', confidence: 0.8, timesSeen: 1, lastSeen: NOW });
    const stale = fact({ factId: 'b', confidence: 0.8, timesSeen: 1, lastSeen: new Date(NOW.getTime() - 180 * 86_400_000) });
    const reinforced = fact({ factId: 'c', confidence: 0.8, timesSeen: 12, lastSeen: NOW });
    expect(factRetentionScore(fresh, NOW)).toBeGreaterThan(factRetentionScore(stale, NOW));
    expect(factRetentionScore(reinforced, NOW)).toBeGreaterThan(factRetentionScore(fresh, NOW));
  });
});
