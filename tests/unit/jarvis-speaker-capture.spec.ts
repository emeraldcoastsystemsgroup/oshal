/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added privacy, lifecycle, MIME selection, and upload-contract tests for diarization audio capture.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface CaptureApi {
  selectMimeType(recorder: { isTypeSupported(type: string): boolean }): string;
  shouldCapture(settings: Record<string, unknown>, state: Record<string, unknown>): boolean;
}

const scriptPath = resolve(process.cwd(), 'src/api/jarvis-speaker-capture.js');
const source = readFileSync(scriptPath, 'utf8');

function loadApi(): CaptureApi {
  const browser = {} as { JarvisSpeakerCapture?: CaptureApi };
  runInNewContext(source, { window: browser, globalThis: browser });
  if (!browser.JarvisSpeakerCapture) throw new Error('JarvisSpeakerCapture was not attached');
  return browser.JarvisSpeakerCapture;
}

describe('Jarvis speaker capture client', () => {
  const api = loadApi();

  it('records only after explicit ambient and diarization opt-in', () => {
    const ready = { supported: true, online: true, visible: true, assistantSpeaking: false, suspended: false };
    expect(api.shouldCapture({ enabled: true, speakerDiarizationEnabled: true }, ready)).toBe(true);
    expect(api.shouldCapture({ enabled: true, speakerDiarizationEnabled: false }, ready)).toBe(false);
    expect(api.shouldCapture({ enabled: false, speakerDiarizationEnabled: true }, ready)).toBe(false);
  });

  it('pauses for assistant speech, hidden tabs, offline state, and manual suspension', () => {
    const settings = { enabled: true, speakerDiarizationEnabled: true };
    const ready = { supported: true, online: true, visible: true, assistantSpeaking: false, suspended: false };
    for (const blocked of [
      { ...ready, assistantSpeaking: true },
      { ...ready, visible: false },
      { ...ready, online: false },
      { ...ready, suspended: true },
    ]) expect(api.shouldCapture(settings, blocked)).toBe(false);
    expect(source).toContain('if (this.assistantSpeaking) this.stopCurrent(false, false)');
  });

  it('prefers an Opus container supported by the browser', () => {
    const recorder = { isTypeSupported: (type: string) => type === 'audio/ogg;codecs=opus' };
    expect(api.selectMimeType(recorder)).toBe('audio/ogg;codecs=opus');
  });

  it('sends bounded multipart memory uploads and never creates a durable audio queue', () => {
    expect(source).toContain("form.append('audio', audio");
    expect(source).toContain("`${this.apiBase}/audio`");
    expect(source).toContain("form.append('purpose'");
    expect(source).toContain("form.append('clientChunkId'");
    expect(source).toContain('MAX_IN_FLIGHT = 2');
    expect(source).toContain('MAX_FILE_BYTES = 7 * 1024 * 1024');
    expect(source).toContain('UPLOAD_TIMEOUT_MS = 120000');
    expect(source).toContain("'fallback_required'");
    expect(source).not.toMatch(/localStorage|indexedDB|sendBeacon|FileSystem|audioQueue/);
  });

  it('supports recorded-file import and a dedicated signed-in-user enrollment purpose', () => {
    expect(source).toContain("'jarvis:speakers-file-selected'");
    expect(source).toContain("'jarvis:speakers-enroll-requested'");
    expect(source).toContain("'jarvis:speakers-capture-requested'");
    expect(source).toContain("'recording_import'");
    expect(source).toContain("'self_enrollment'");
    expect(source).toContain('measureAudioDuration');
    expect(source).toContain('55 second transcription limit');
    expect(source).toContain('const CHUNK_DURATION_MS = 18000');
    expect(source).toContain('const ENROLLMENT_DURATION_MS = 8000');
  });
});
