/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: unit coverage for the deterministic ambient-recall matcher and receipts block — count/what shapes, range + playback detection, self/anyone normalization, non-recall pass-through, and the unresolved-name guard.
 */

import { describe, expect, it } from 'vitest';
import { detectRecallIntent, buildRecallReceiptsBlock, buildRecallSpokenAnswer } from '@/features/person-model';
import type { RecallResult } from '@/features/person-model';

describe('detectRecallIntent', () => {
  it('parses the canonical count shape with person, topic, today range, and playback', () => {
    const intent = detectRecallIntent('Jarvis, how many times has Ella mentioned volleyball today? Play it back');
    expect(intent).toMatchObject({ personName: 'Ella', terms: 'volleyball', range: 'today', wantsPlayback: true });
  });

  it('parses the "what did X say about Y" shape without playback', () => {
    const intent = detectRecallIntent('what did Sam say about the school trip');
    expect(intent).toMatchObject({ personName: 'Sam', terms: 'school trip', range: 'all', wantsPlayback: false });
  });

  it('normalizes self-referential names to "me"', () => {
    expect(detectRecallIntent('how many times did I mention the budget today')?.personName).toBe('me');
  });

  it('treats "anyone" as an unscoped (blank person) recall', () => {
    expect(detectRecallIntent('how many times has anyone mentioned pizza today')?.personName).toBe('');
  });

  it('strips leading articles from the topic', () => {
    expect(detectRecallIntent('what has Ella said about the recital')?.terms).toBe('recital');
  });

  it('returns null for ordinary chat that is not a recall shape', () => {
    expect(detectRecallIntent('remind me to call the dentist tomorrow')).toBeNull();
    expect(detectRecallIntent('')).toBeNull();
    expect(detectRecallIntent('how do I enable ambient listening')).toBeNull();
  });
});

describe('buildRecallReceiptsBlock', () => {
  const intent = { personName: 'Ella', terms: 'volleyball', range: 'today' as const, wantsPlayback: true };

  it('states the literal count and quotes the receipts', () => {
    const result: RecallResult = {
      personLabel: 'Ella', personResolved: true, count: 2, terms: 'volleyball', range: 'today',
      receipts: [
        { segmentId: 's1', quote: 'volleyball tryouts are Thursday', capturedAt: '2026-07-17T13:00:00.000Z' },
        { segmentId: 's2', quote: 'I love playing volleyball', capturedAt: '2026-07-17T18:00:00.000Z' },
      ],
    };
    const block = buildRecallReceiptsBlock(intent, result);
    expect(block).toContain('Ella was heard about "volleyball" 2 times today');
    expect(block).toContain('volleyball tryouts are Thursday');
    expect(block).toContain('re-speak the quoted line(s) aloud in your own voice');
  });

  it('reports a clean zero without inventing anything', () => {
    const result: RecallResult = {
      personLabel: 'Ella', personResolved: true, count: 0, terms: 'volleyball', range: 'today', receipts: [],
    };
    const block = buildRecallReceiptsBlock(intent, result);
    expect(block).toContain('has not been heard');
    expect(block).not.toContain('re-speak');
  });

  it('refuses to guess a count when the name did not resolve to a voice', () => {
    const result: RecallResult = {
      personLabel: null, personResolved: false, count: 0, terms: 'volleyball', range: 'today', receipts: [],
    };
    const block = buildRecallReceiptsBlock(intent, result);
    expect(block).toContain('No enrolled or named voice matches "Ella"');
    expect(block).toContain('Do not guess a count');
  });
});

describe('buildRecallSpokenAnswer (deterministic Jarvis chat answer)', () => {
  const intent = { personName: 'Ella', terms: 'volleyball', range: 'today' as const, wantsPlayback: false };

  it('states the literal count and quotes the receipts, without model-facing instructions', () => {
    const result: RecallResult = {
      personLabel: 'Ella', personResolved: true, count: 2, terms: 'volleyball', range: 'today',
      receipts: [
        { segmentId: 's1', quote: 'volleyball tryouts are Thursday', capturedAt: '2026-07-17T13:00:00.000Z' },
        { segmentId: 's2', quote: 'I love playing volleyball', capturedAt: '2026-07-17T18:00:00.000Z' },
      ],
    };
    const answer = buildRecallSpokenAnswer(intent, result);
    expect(answer).toContain('Ella was heard about "volleyball" 2 times today');
    expect(answer).toContain('- "volleyball tryouts are Thursday"');
    expect(answer).toContain('- "I love playing volleyball"');
    // never leak the model-instruction header into the user-facing answer
    expect(answer).not.toContain('AMBIENT RECALL');
    expect(answer).not.toContain('do not invent');
  });

  it('answers a clean zero in plain voice', () => {
    const result: RecallResult = {
      personLabel: 'Ella', personResolved: true, count: 0, terms: 'volleyball', range: 'today', receipts: [],
    };
    expect(buildRecallSpokenAnswer(intent, result)).toBe('I haven\'t heard Ella about "volleyball" today.');
  });

  it('nudges the user to name an unresolved voice instead of guessing', () => {
    const result: RecallResult = {
      personLabel: null, personResolved: false, count: 0, terms: 'volleyball', range: 'today', receipts: [],
    };
    const answer = buildRecallSpokenAnswer(intent, result);
    expect(answer).toContain('I don\'t have a saved voice matching "Ella"');
    expect(answer).toContain('Manage Voices');
  });
});
