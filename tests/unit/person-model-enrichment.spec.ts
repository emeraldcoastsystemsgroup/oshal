/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2: unit coverage for the ambient-analyst reply parser — taxonomy validation, id whitelisting, ask/commitment gating by intent, topic normalization/cap, and tolerance of fenced/prose-wrapped replies.
 */

import { describe, expect, it } from 'vitest';
import { buildEnrichmentPrompt, parseEnrichmentJson, type EnrichmentInput } from '@/features/person-model';

const batch: EnrichmentInput[] = [
  { segmentId: 's1', text: 'volleyball tryouts are Thursday', speakerLabel: 'Ella' },
  { segmentId: 's2', text: 'can you grab milk on the way home', speakerLabel: 'Ella' },
  { segmentId: 's3', text: 'I will pick up the kids at five', speakerLabel: 'Ella' },
];

describe('buildEnrichmentPrompt', () => {
  it('includes every segmentId and asks for the JSON contract', () => {
    const prompt = buildEnrichmentPrompt(batch);
    expect(prompt).toContain('s1');
    expect(prompt).toContain('s2');
    expect(prompt).toContain('"enrichments"');
  });
});

describe('parseEnrichmentJson', () => {
  it('parses a clean reply and gates ask/commitment by intent', () => {
    const raw = JSON.stringify({ enrichments: [
      { segmentId: 's1', tone: 'excited', intent: 'inform', topics: ['Volleyball', 'school'], ask: 'x', commitment: 'y' },
      { segmentId: 's2', tone: 'neutral', intent: 'ask_request', topics: ['groceries'], ask: 'grab milk', commitment: null },
      { segmentId: 's3', tone: 'neutral', intent: 'commit', topics: [], ask: null, commitment: 'pick up the kids at five' },
    ] });
    const out = parseEnrichmentJson(raw, batch);
    expect(out).toHaveLength(3);
    // ask/commitment only survive when the intent matches
    expect(out[0]).toMatchObject({ ask: null, commitment: null });          // intent inform → both dropped
    expect(out[0].topics).toEqual(['volleyball', 'school']);                 // lowercased
    expect(out[1]).toMatchObject({ intent: 'ask_request', ask: 'grab milk', commitment: null });
    expect(out[2]).toMatchObject({ intent: 'commit', commitment: 'pick up the kids at five', ask: null });
  });

  it('drops entries with an out-of-taxonomy tone or intent (never coerces)', () => {
    const raw = JSON.stringify({ enrichments: [
      { segmentId: 's1', tone: 'furious', intent: 'inform', topics: [] },      // bad tone
      { segmentId: 's2', tone: 'neutral', intent: 'demand', topics: [] },      // bad intent
      { segmentId: 's3', tone: 'warm', intent: 'inform', topics: [] },         // valid
    ] });
    const out = parseEnrichmentJson(raw, batch);
    expect(out.map((e) => e.segmentId)).toEqual(['s3']);
  });

  it('ignores unknown ids, duplicates, and caps topics at three', () => {
    const raw = JSON.stringify({ enrichments: [
      { segmentId: 'not-in-batch', tone: 'neutral', intent: 'inform', topics: [] },
      { segmentId: 's1', tone: 'neutral', intent: 'inform', topics: ['a', 'b', 'c', 'd', 'e'] },
      { segmentId: 's1', tone: 'warm', intent: 'inform', topics: [] },          // duplicate id
    ] });
    const out = parseEnrichmentJson(raw, batch);
    expect(out).toHaveLength(1);
    expect(out[0].topics).toEqual(['a', 'b', 'c']);
  });

  it('tolerates prose and code fences around the JSON', () => {
    const raw = 'Here you go:\n```json\n' + JSON.stringify({ enrichments: [
      { segmentId: 's1', tone: 'tired', intent: 'vent', topics: ['work'] },
    ] }) + '\n```\nHope that helps!';
    const out = parseEnrichmentJson(raw, batch);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ segmentId: 's1', tone: 'tired', intent: 'vent' });
  });

  it('returns nothing for an unparseable reply instead of throwing', () => {
    expect(parseEnrichmentJson('the model refused', batch)).toEqual([]);
    expect(parseEnrichmentJson('', batch)).toEqual([]);
  });
});
