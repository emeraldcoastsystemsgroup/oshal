/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the STT turn-time failover (live 2026-08-11: Gemini's free tier quota-walled mid-day and every Jarvis dictation answered "Transcription failed" while the configured on-host sherpa sidecar sat idle — the registry resolved exactly one provider and VoiceService had no second try). Pins: the DEFAULT-resolved provider failing walks to the next server-kind provider and answers with a real transcript; an EXPLICITLY requested provider surfaces its own failure unswitched (caller's-choice boundary, like an explicit BYO brain); every candidate failing surfaces the ORIGINAL failure; and local-stt is REGISTERED from the default config (the provider existed but nothing declared it, so no walk could ever reach it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../../src/features/voice/services/voice-service';
import {
  getSTTProviderRegistry,
  resetSTTProviderRegistryForTesting,
} from '../../src/features/voice-providers/services/stt-provider-registry';
import type { STTProvider } from '../../src/features/voice-providers';

const AUDIO = Buffer.from('not-really-audio');
const MIME = 'audio/wav';
const GEMINI_429 = new Error('Gemini API returned 429: quota exceeded for generate_content_free_tier_requests');

function provider(id: string): STTProvider {
  const found = getSTTProviderRegistry().get(id);
  if (!found) throw new Error(`provider ${id} is not registered — the default config must declare it`);
  return found;
}

describe('STT turn-time failover — a quota-walled default never answers "Transcription failed" while a sibling can transcribe', () => {
  beforeEach(() => {
    resetSTTProviderRegistryForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSTTProviderRegistryForTesting();
  });

  it('local-stt is registered from the default config (the walk needs a landing spot)', () => {
    const local = getSTTProviderRegistry().get('local-stt');
    expect(local).toBeDefined();
    expect(local?.kind).toBe('server');
  });

  it('the default provider failing walks to the next server-kind provider and answers with its transcript', async () => {
    const gemini = vi.spyOn(provider('gemini-stt'), 'transcribe').mockRejectedValue(GEMINI_429);
    // The walk passes google-cloud-stt first (registration order); it is also down.
    vi.spyOn(provider('google-cloud-stt'), 'transcribe').mockRejectedValue(new Error('no google auth'));
    const local = vi.spyOn(provider('local-stt'), 'transcribe').mockResolvedValue({
      providerId: 'local-stt', text: 'strengthen my resume', languageCode: 'en-US',
    });

    const out = await new VoiceService().transcribeAudio(AUDIO, MIME);

    expect(out.fallback).toBeUndefined();
    expect(out.text).toBe('strengthen my resume');
    expect(out.providerId).toBe('local-stt');
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('an EXPLICITLY requested provider surfaces its own failure — never silently switched', async () => {
    vi.spyOn(provider('gemini-stt'), 'transcribe').mockRejectedValue(GEMINI_429);
    const local = vi.spyOn(provider('local-stt'), 'transcribe').mockResolvedValue({
      providerId: 'local-stt', text: 'should never be used', languageCode: 'en-US',
    });

    const out = await new VoiceService().transcribeAudio(AUDIO, MIME, { providerId: 'gemini-stt' });

    expect(out.fallback).toBe('failed');
    expect(out.message).toContain('429');
    expect(local).not.toHaveBeenCalled();
  });

  it('every candidate failing surfaces the ORIGINAL failure, each tried exactly once', async () => {
    const gemini = vi.spyOn(provider('gemini-stt'), 'transcribe').mockRejectedValue(GEMINI_429);
    const gcloud = vi.spyOn(provider('google-cloud-stt'), 'transcribe').mockRejectedValue(new Error('no google auth'));
    const local = vi.spyOn(provider('local-stt'), 'transcribe').mockRejectedValue(new Error('sidecar 503: ASR model absent'));

    const out = await new VoiceService().transcribeAudio(AUDIO, MIME);

    expect(out.fallback).toBe('failed');
    expect(out.providerId).toBe('gemini-stt');
    expect(out.message).toContain('429');
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(gcloud).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledTimes(1);
  });
});
