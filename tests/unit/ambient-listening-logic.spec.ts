/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added privacy, configuration, text-batch, daily summary, and confirmation-required proposal tests for ambient listening.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the invariant preventing remembered speaker profiles while diarization is disabled.
 */

import { describe, expect, it } from 'vitest';
import {
  AmbientInputError,
  buildAmbientDailyReview,
  dueAmbientReviewDate,
  normalizeAmbientSegmentBatch,
  normalizeAmbientSettings,
  type AmbientSettings,
} from '../../src/features/ambient-listening';

const NOW = new Date('2026-07-09T22:00:00.000Z');

function settings(overrides: Partial<AmbientSettings> = {}): AmbientSettings {
  return {
    assistantName: 'Jarvis',
    wakePhrases: ['hey jarvis'],
    ambientEnabled: false,
    transcriptRetentionDays: 30,
    timeZone: 'America/Chicago',
    dailyReviewEnabled: false,
    dailyReviewTime: '21:00',
    suggestFollowUps: true,
    speakerDiarizationEnabled: false,
    rememberSpeakers: false,
    speakerTenantId: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('ambient settings', () => {
  it('cannot remember speakers while diarization is disabled', () => {
    const current = settings({ speakerDiarizationEnabled: true, rememberSpeakers: true });
    const result = normalizeAmbientSettings(current, {
      speakerDiarizationEnabled: false,
      rememberSpeakers: true,
    }, NOW);

    expect(result.speakerDiarizationEnabled).toBe(false);
    expect(result.rememberSpeakers).toBe(false);
  });

  it('derives a configurable wake phrase and keeps capture opt-in', () => {
    const result = normalizeAmbientSettings(settings(), { assistantName: 'Enterprise' }, NOW);
    expect(result.assistantName).toBe('Enterprise');
    expect(result.wakePhrases).toEqual(['hey enterprise']);
    expect(result.ambientEnabled).toBe(false);
  });

  it('normalizes custom wake phrases and bounds retention', () => {
    const result = normalizeAmbientSettings(settings(), {
      wakePhrases: [' Hey Computer ', 'computer', 'hey computer'],
      ambientEnabled: true,
      transcriptRetentionDays: 7,
      dailyReviewEnabled: true,
      dailyReviewTime: '20:30',
      suggestFollowUps: false,
    }, NOW);
    expect(result.wakePhrases).toEqual(['hey computer', 'computer']);
    expect(result.ambientEnabled).toBe(true);
    expect(result.transcriptRetentionDays).toBe(7);
    expect(result.dailyReviewTime).toBe('20:30');
    expect(result.suggestFollowUps).toBe(false);
    expect(() => normalizeAmbientSettings(settings(), { transcriptRetentionDays: 0 })).toThrow(AmbientInputError);
    expect(() => normalizeAmbientSettings(settings(), { dailyReviewTime: '8:30 PM' })).toThrow(AmbientInputError);
  });

  it('computes end-of-day review due state in the owner time zone', () => {
    const enabled = settings({ ambientEnabled: true, dailyReviewEnabled: true, dailyReviewTime: '17:00' });
    expect(dueAmbientReviewDate(enabled, new Date('2026-07-09T21:59:00Z'))).toBeNull();
    expect(dueAmbientReviewDate(enabled, new Date('2026-07-09T22:00:00Z'))).toBe('2026-07-09');
    expect(dueAmbientReviewDate({ ...enabled, dailyReviewEnabled: false }, NOW)).toBeNull();
  });
});

describe('text-only transcript batches', () => {
  it('accepts text batches and normalizes retry ids without any audio value', () => {
    const segments = normalizeAmbientSegmentBatch({ segments: [{
      id: 'phone-segment-1',
      text: '  the operator, I need you to remind me to call the dentist. ',
      capturedAt: NOW.toISOString(),
      speakerLabel: 'Alice',
    }] }, NOW);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      clientSegmentId: 'phone-segment-1',
      text: 'the operator, I need you to remind me to call the dentist.',
      speakerLabel: 'Alice',
    });
  });

  it('rejects a generic client assertion of a trusted speaker profile id', () => {
    expect(() => normalizeAmbientSegmentBatch({
      text: 'A client cannot make this identity claim.',
      speakerProfileId: '00000000-0000-4000-8000-000000000001',
    }, NOW)).toThrowError(expect.objectContaining({ code: 'trusted_speaker_profile_not_allowed' }));
  });

  it.each(['audio', 'audioData', 'rawAudio', 'blob'])(
    'rejects the raw-audio-shaped field %s',
    (field) => {
      expect(() => normalizeAmbientSegmentBatch({
        segments: [{ text: 'transcribed words', [field]: 'binary-or-base64' }],
      }, NOW)).toThrowError(/Raw audio is not accepted/);
    },
  );
});

describe('daily review', () => {
  it('summarizes text and proposes—but never executes—a calendar reminder', () => {
    const review = buildAmbientDailyReview('2026-07-09', 'America/Chicago', [{
      segmentId: 'segment-wife',
      speakerLabel: 'Alice',
      text: 'the operator, I need you to remind me to call the dentist tomorrow.',
    }], NOW);

    expect(review.summary).toContain('Captured 1 text transcript segment');
    expect(review.summary).toContain('Alice');
    expect(review.suggestions).toHaveLength(1);
    expect(review.suggestions[0]).toMatchObject({
      kind: 'reminder',
      title: 'call the dentist tomorrow',
      proposedTarget: 'calendar',
      requiresConfirmation: true,
      status: 'proposed',
    });
    expect(review.suggestions[0].prompt).toContain('would you like me to create a calendar reminder');
  });

  it('recognizes commitments and missed follow-ups as task proposals', () => {
    const review = buildAmbientDailyReview('2026-07-09', 'UTC', [
      { segmentId: 's1', speakerLabel: null, text: 'We need to send the proposal by Friday.' },
      { segmentId: 's2', speakerLabel: null, text: 'I forgot to email Pat the revised quote.' },
    ], NOW);
    expect(review.suggestions.map((item) => item.kind)).toEqual(['task', 'follow-up']);
    expect(review.suggestions.every((item) => item.status === 'proposed' && item.requiresConfirmation)).toBe(true);
  });

  it('still summarizes but emits no proposals when follow-up suggestions are disabled', () => {
    const review = buildAmbientDailyReview('2026-07-09', 'UTC', [{
      segmentId: 's1', speakerLabel: null, text: 'Remind me to call the dentist.',
    }], NOW, false);
    expect(review.summary).toContain('call the dentist');
    expect(review.suggestions).toEqual([]);
  });
});
