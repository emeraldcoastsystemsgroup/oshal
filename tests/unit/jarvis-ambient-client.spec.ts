/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added browser-client contract tests for configurable wake phrases, privacy boundaries, and ambient API integration paths.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Covered coalescePendingSegment: growing/repeated/shrunken recognizer hypotheses collapse to one pending segment, distinct or stale utterances append, and in-flight flush entries are never superseded.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Loader update for the jarvis-ambient decomposition (core/ui/recognition siblings + coordinator): the VM harness now evaluates the four classic scripts in jarvis.html load order in one shared sandbox, and the source-content assertions run against the concatenated sources. Assertions unchanged.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface WakeResult {
  wakePhrase: string;
  command: string;
}

interface PendingSegment {
  clientSegmentId: string;
  capturedAt: string;
  text: string;
  sessionId: string;
}

interface AmbientApi {
  parseWakeCommand(transcript: string, phrases: string[]): WakeResult | null;
  coalescePendingSegment(
    pending: PendingSegment[],
    segment: PendingSegment,
    windowMs: number,
    frozenCount: number,
  ): PendingSegment;
}

// The ambient client is four load-ordered classic scripts (see jarvis.html); evaluate and
// assert against them exactly as the browser composes them.
const scriptPaths = [
  'src/api/jarvis-ambient-core.js',
  'src/api/jarvis-ambient-ui.js',
  'src/api/jarvis-ambient-recognition.js',
  'src/api/jarvis-ambient.js',
].map((scriptPath) => resolve(process.cwd(), scriptPath));
const stylePath = resolve(process.cwd(), 'src/api/jarvis-ambient.css');
const sources = scriptPaths.map((scriptPath) => readFileSync(scriptPath, 'utf8'));
const source = sources.join('\n');
const styles = readFileSync(stylePath, 'utf8');

function loadAmbientApi(): AmbientApi {
  const browser = {} as { JarvisAmbient?: AmbientApi };
  const sandbox = { window: browser, globalThis: browser };
  for (const part of sources) runInNewContext(part, sandbox);
  if (!browser.JarvisAmbient) throw new Error('JarvisAmbient was not attached to window');
  return browser.JarvisAmbient;
}

describe('Jarvis ambient browser client', () => {
  const ambient = loadAmbientApi();

  it('extracts a command after a configurable wake phrase', () => {
    expect(ambient.parseWakeCommand('Hey Enterprise, show my calendar', ['Hey Enterprise', 'Enterprise']))
      .toEqual({ wakePhrase: 'Hey Enterprise', command: 'show my calendar' });
  });

  it('arms on a wake-only utterance and tolerates natural punctuation', () => {
    expect(ambient.parseWakeCommand('  Hey, Computer!  ', ['Hey Computer', 'Computer']))
      .toEqual({ wakePhrase: 'Hey Computer', command: '' });
  });

  it('does not dispatch an incidental wake-phrase mention in the middle of speech', () => {
    expect(ambient.parseWakeCommand('the operator said hey Jarvis should make a reminder', ['Hey Jarvis']))
      .toBeNull();
  });

  it('handles regex characters in a user-defined assistant name safely', () => {
    expect(ambient.parseWakeCommand('Hey C++, run the report', ['Hey C++']))
      .toEqual({ wakePhrase: 'Hey C++', command: 'run the report' });
  });

  it('keeps raw audio out of the ambient text client and accurately discloses the separate ephemeral path', () => {
    expect(source).toContain("`${this.apiBase}/segments`");
    expect(source).toContain("`${this.apiBase}/days/${encodeURIComponent(date)}`");
    expect(source).toContain("`${this.apiBase}/days/${encodeURIComponent(date)}/review`");
    expect(source).not.toMatch(/navigator\.mediaDevices|new\s+MediaRecorder|new\s+AudioContext|audioChunks|audioBlob/);
    expect(source).toContain('Raw audio is never stored.');
    expect(source).toContain("OSHAL's local engine");
    expect(source).toContain('Chunks with no voice are discarded after OSHAL processing');
    expect(source).toContain('Google Cloud Speech-to-Text');
    expect(source).toContain("browser's speech service");
    // ADR-100 Phase 2 disclosure: the panel must state that per-person insights derive + keep
    // deletable inferences, and that declining a heard person purges theirs. Pinned so a future
    // edit can't silently drop the disclosure while the capability is enabled.
    expect(source).toContain('deletable inferences beside the words actually said');
    expect(source).toContain('declining a heard person stops that and purges');
    expect(source).not.toContain('Only transcript text and encrypted voice profiles you choose to remember are kept');
  });

  it('adapts browser-friendly state names to the persisted API contract', () => {
    expect(source).toContain('ambientEnabled: settings.enabled');
    expect(source).toContain('transcriptRetentionDays: settings.retentionDays');
    expect(source).toContain('dailyReviewEnabled: settings.dailyReviewEnabled');
    expect(source).toContain('suggestFollowUps: settings.suggestFollowUps');
    expect(source).toContain('speakerDiarizationEnabled: settings.speakerDiarizationEnabled');
    expect(source).toContain('rememberSpeakers: settings.rememberSpeakers');
    expect(source).toContain("wakePhraseDetected: Boolean(wake)");
    expect(source).toContain('matchedWakePhrase: wake ? wake.wakePhrase : null');
    expect(source).toContain('sessionId: this.sessionId');
  });

  it('hands recognized text to the trusted audio path without duplicating the generic transcript batch', () => {
    expect(source).toContain("this.emit('jarvis:ambient-recognized'");
    expect(source).toContain('this.holdForSpeakerOutcome');
    expect(source).toContain("detail.outcome === 'audio_persisted'");
    expect(source).toContain('this.releaseDiarizationFallback');
    expect(source).toContain('entry.speakerLabel');
    expect(source).toContain('name="speakerDiarizationEnabled"');
    expect(source).toContain('name="rememberSpeakers"');
    expect(source).toContain('rememberSpeakers: fields.speakerDiarizationEnabled.checked && fields.rememberSpeakers.checked');
    expect(source).toContain("this.emit('jarvis:speakers-open-requested'");
  });

  it('ships visible active, paused, blocked, hidden-tab, and unsupported states', () => {
    for (const state of ['paused', 'listening', 'hidden', 'blocked', 'unsupported']) {
      expect(source).toContain(`${state}: [`);
    }
    expect(styles).toContain('.jarvis-ambient[data-state="listening"]');
    expect(styles).toContain('.jarvis-ambient[data-state="listening"] .jarvis-ambient__bar::before');
    expect(styles).toContain('jarvis-ambient-halo-breathe');
    expect(styles).toContain('.ambient-mount {');
    expect(styles).toContain('position: absolute;');
    expect(source).toContain("state === 'armed' ? `${this.settings.assistantName} is awake`");
    expect(source).toContain("canvasWrap.dataset.ambientState = state");
  });

  describe('coalescePendingSegment (streaming-final hypothesis spam)', () => {
    const seg = (id: string, at: string, text: string, sessionId = 'session-a'): PendingSegment => ({
      clientSegmentId: id, capturedAt: at, text, sessionId,
    });

    it('collapses growing hypotheses of one utterance into a single pending segment', () => {
      const pending: PendingSegment[] = [];
      ambient.coalescePendingSegment(pending, seg('s1', '2026-07-17T12:00:00.000Z', 'but'), 15000, 0);
      ambient.coalescePendingSegment(pending, seg('s2', '2026-07-17T12:00:00.400Z', "but there's"), 15000, 0);
      const kept = ambient.coalescePendingSegment(
        pending, seg('s3', '2026-07-17T12:00:01.100Z', "but there's the same volume"), 15000, 0,
      );
      expect(pending).toHaveLength(1);
      expect(kept.text).toBe("but there's the same volume");
      expect(kept.clientSegmentId).toBe('s1');
      expect(kept.capturedAt).toBe('2026-07-17T12:00:00.000Z');
    });

    it('drops an identical repeat and a shrunken re-hypothesis, keeping the fullest text', () => {
      const pending = [seg('s1', '2026-07-17T12:00:00.000Z', 'the same amount of')];
      const afterRepeat = ambient.coalescePendingSegment(
        pending, seg('s2', '2026-07-17T12:00:00.300Z', 'the same amount of'), 15000, 0,
      );
      const afterShrink = ambient.coalescePendingSegment(
        pending, seg('s3', '2026-07-17T12:00:00.600Z', 'the same amount'), 15000, 0,
      );
      expect(pending).toHaveLength(1);
      expect(afterRepeat.clientSegmentId).toBe('s1');
      expect(afterShrink.text).toBe('the same amount of');
    });

    it('appends a distinct utterance instead of superseding', () => {
      const pending = [seg('s1', '2026-07-17T12:00:00.000Z', 'schedule the release')];
      ambient.coalescePendingSegment(
        pending, seg('s2', '2026-07-17T12:00:02.000Z', 'and notify the operators'), 15000, 0,
      );
      expect(pending).toHaveLength(2);
    });

    it('appends when the previous segment is older than the coalesce window or from another session', () => {
      const pending = [seg('s1', '2026-07-17T12:00:00.000Z', 'good morning')];
      ambient.coalescePendingSegment(
        pending, seg('s2', '2026-07-17T12:00:20.000Z', 'good morning everyone'), 15000, 0,
      );
      ambient.coalescePendingSegment(
        pending, seg('s3', '2026-07-17T12:00:20.200Z', 'good morning everyone again', 'session-b'), 15000, 0,
      );
      expect(pending).toHaveLength(3);
    });

    it('never supersedes an entry inside an in-flight flush batch', () => {
      const pending = [seg('s1', '2026-07-17T12:00:00.000Z', 'good morning')];
      ambient.coalescePendingSegment(
        pending, seg('s2', '2026-07-17T12:00:00.300Z', 'good morning everyone'), 15000, 1,
      );
      expect(pending).toHaveLength(2);
      expect(pending[0].text).toBe('good morning');
      expect(pending[1].text).toBe('good morning everyone');
    });
  });
});
