import { describe, expect, it } from 'vitest';
import {
  sanitizeStoryboard,
  storyboardSeconds,
  clampTargetSeconds,
  clampClipSeconds,
  veoCostPerSecond,
  type VideoShape,
} from '../../src/features/video-generation';

const baseShape: VideoShape = {
  style: 'clean explainer',
  tone: 'energetic',
  aspectRatio: '9:16',
  targetSeconds: 20,
  captions: true,
  voice: 'default',
  music: 'none',
};

describe('video storyboard sanitizer', () => {
  it('clamps scene durations into the Veo 2–8s window', () => {
    const sb = sanitizeStoryboard(
      { title: 'T', scenes: [{ prompt: 'a', durationSec: 99 }, { prompt: 'b', durationSec: 0 }] },
      baseShape,
      'fallback',
    );
    expect(sb.scenes[0].durationSec).toBe(8);
    expect(sb.scenes[1].durationSec).toBe(2);
  });

  it('caps the scene count at 12', () => {
    const scenes = Array.from({ length: 30 }, (_, i) => ({ prompt: `scene ${i}`, durationSec: 4 }));
    const sb = sanitizeStoryboard({ scenes }, baseShape, 'fallback');
    expect(sb.scenes.length).toBe(12);
  });

  it('strips narration when the shape has voice "none"', () => {
    const sb = sanitizeStoryboard(
      { scenes: [{ prompt: 'a', durationSec: 4, narration: 'hello' }] },
      { ...baseShape, voice: 'none' },
      'fallback',
    );
    expect(sb.scenes[0].narration).toBe('');
  });

  it('strips captions when the shape disables them', () => {
    const sb = sanitizeStoryboard(
      { scenes: [{ prompt: 'a', durationSec: 4, caption: 'BIG TEXT' }] },
      { ...baseShape, captions: false },
      'fallback',
    );
    expect(sb.scenes[0].caption).toBe('');
  });

  it('accepts a bare scene array and applies the fallback title', () => {
    const sb = sanitizeStoryboard([{ prompt: 'a', durationSec: 4 }], baseShape, 'My idea');
    expect(sb.title).toBe('My idea');
    expect(sb.scenes.length).toBe(1);
  });

  it('drops scenes with no prompt and throws when none survive', () => {
    expect(() => sanitizeStoryboard({ scenes: [{ durationSec: 4 }, { prompt: '' }] }, baseShape, 'x')).toThrow();
  });

  it('sums realized seconds across scenes', () => {
    const sb = sanitizeStoryboard({ scenes: [{ prompt: 'a', durationSec: 5 }, { prompt: 'b', durationSec: 6 }] }, baseShape, 'x');
    expect(storyboardSeconds(sb)).toBe(11);
  });
});

describe('video clamps + cost', () => {
  it('clamps target length to the 2–90s studio range', () => {
    expect(clampTargetSeconds(1000)).toBe(90);
    expect(clampTargetSeconds(-5)).toBe(2);
    expect(clampTargetSeconds(20)).toBe(20);
  });

  it('clamps a clip request to the Veo window', () => {
    expect(clampClipSeconds(100)).toBe(8);
    expect(clampClipSeconds(1)).toBe(2);
    expect(clampClipSeconds(NaN)).toBe(2);
  });

  it('returns a positive default per-second Veo cost', () => {
    expect(veoCostPerSecond()).toBeGreaterThan(0);
  });
});
