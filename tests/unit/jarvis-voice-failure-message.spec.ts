/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the voice-input honesty fix: a transcription that returns no text must report WHY. On the G-Squared customer box the STT provider is unconfigured (no GOOGLE_API_KEY/GEMINI_API_KEY) and the server correctly returns {fallback:'unconfigured',message:...}, but jarvis.html read only `text` and printed "Didn't catch that — try again" — telling the operator to repeat themselves when no transcription service exists on that deployment. Evaluates the REAL function out of jarvis.html (sibling pattern: jarvis-ambient-client.spec.ts) so a regression in the shipped source fails here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type FailureMessageFn = (envelope: unknown, httpOk: boolean, httpStatus: number) => string;

/**
 * Pull the shipped `voiceFailureMessage` out of jarvis.html and evaluate it. Testing the real
 * source rather than a copy is the point — a copy would keep passing after the page changed.
 */
function loadVoiceFailureMessage(): FailureMessageFn {
  const html = readFileSync(resolve(__dirname, '../../src/api/jarvis.html'), 'utf8');
  const match = html.match(/function voiceFailureMessage\(envelope, httpOk, httpStatus\)\{[\s\S]*?\n\}/);
  if (!match) {
    throw new Error('voiceFailureMessage not found in jarvis.html — the surface changed, update this guard');
  }
  const sandbox: Record<string, unknown> = {};
  runInNewContext(`${match[0]}\nthis.fn = voiceFailureMessage;`, sandbox);
  return sandbox.fn as FailureMessageFn;
}

describe('jarvis voice input: an empty transcript must say WHY', () => {
  const voiceFailureMessage = loadVoiceFailureMessage();

  it('names an unconfigured STT provider instead of blaming the speaker', () => {
    // The exact envelope the G-Squared droplet returns, captured live 2026-07-30.
    const live = {
      providerId: 'gemini-stt',
      fallback: 'unconfigured',
      message: 'GOOGLE_API_KEY / GEMINI_API_KEY is not set — get a key at aistudio.google.com',
    };
    const msg = voiceFailureMessage(live, true, 200);
    expect(msg).toContain('isn’t set up on this deployment');
    expect(msg).not.toContain('Didn’t catch that');
    expect(msg).not.toContain('try again,');
  });

  it('handles the same envelope wrapped by the controller success() shape', () => {
    const wrapped = { success: true, data: { providerId: 'gemini-stt', fallback: 'unconfigured' } };
    expect(voiceFailureMessage(wrapped, true, 200)).toContain('isn’t set up on this deployment');
  });

  it('does NOT leak the operator-facing detail (env var names) into the user message', () => {
    const live = { fallback: 'unconfigured', message: 'GOOGLE_API_KEY / GEMINI_API_KEY is not set' };
    const msg = voiceFailureMessage(live, true, 200);
    expect(msg).not.toMatch(/API_KEY|aistudio|env var/i);
  });

  it('distinguishes a failed call from an unconfigured one', () => {
    expect(voiceFailureMessage({ fallback: 'failed' }, true, 200)).toContain('Transcription failed');
    expect(voiceFailureMessage({ fallback: 'failed' }, true, 200)).not.toContain('isn’t set up');
  });

  it('treats an expired session as a sign-in problem, not a speech problem', () => {
    const msg = voiceFailureMessage({ error: 'unauthorized' }, false, 401);
    expect(msg).toContain('Session expired');
    expect(msg).not.toContain('Didn’t catch that');
  });

  it('reports a non-401 HTTP error as a failure rather than a bad transcript', () => {
    expect(voiceFailureMessage({}, false, 500)).toContain('Transcription failed');
  });

  it('still says "Didn’t catch that" for a genuinely silent clip on a healthy provider', () => {
    // 200 OK, provider configured, empty transcript — here the original wording is CORRECT,
    // and the fix must not sweep this case into the unconfigured message.
    const silent = { providerId: 'gemini-stt', text: '', languageCode: 'en-US' };
    expect(voiceFailureMessage(silent, true, 200)).toContain('Didn’t catch that');
  });
});
