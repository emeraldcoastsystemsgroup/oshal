/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the on-host STT provider. The property that matters is negative and easy to lose in a refactor: this provider must reach the LOCAL sidecar and nothing else, because its entire reason to exist is that the audio does not leave the machine. Also pins that it is registered under 'local-stt', that it returns speaker labels rather than one flat block, and that an unconfigured install fails with an actionable reason instead of silently falling back to a cloud provider.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LocalSTTProvider } from '@/features/voice-providers/providers/local-stt-provider';

const SIDECAR = 'http://speaker-diarization:8080';

const TRANSCRIPT = {
  modelId: 'sherpa-onnx-1.13.1/pyannote-segmentation-3.0/3dspeaker-eres2net-en-voxceleb-16k',
  asrModelId: 'sherpa-onnx-1.13.1/moonshine-base-en-int8',
  sampleRate: 16000,
  durationSeconds: 12.5,
  speakerCount: 2,
  segments: [
    { index: 0, speakerKey: 'speaker-1', startTime: 0.2, endTime: 4.1, text: 'So you still need to authenticate on the server.' },
    { index: 1, speakerKey: 'speaker-2', startTime: 4.6, endTime: 9.0, text: 'Right, and who handles that today?' },
  ],
};

function mockFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return { fn, calls };
}

const provider = () => new LocalSTTProvider({ baseUrl: SIDECAR, serviceKey: 'k'.repeat(32) });
const audio = () => ({ audio: Buffer.from('fake-audio'), mimeType: 'audio/wav' });

describe('LocalSTTProvider', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('is a server provider identified as local-stt', () => {
    const p = provider();
    expect(p.id).toBe('local-stt');
    expect(p.kind).toBe('server');
  });

  it('sends the audio ONLY to the local sidecar — never to a cloud host', async () => {
    const { fn, calls } = mockFetch(TRANSCRIPT);
    globalThis.fetch = fn as unknown as typeof fetch;
    await provider().transcribe(audio());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${SIDECAR}/v1/transcribe`);
    // The whole point of this provider. If a refactor ever routes it outward, this fails.
    for (const host of ['googleapis.com', 'openai.com', 'anthropic.com', 'amazonaws.com', 'azure.com']) {
      expect(calls[0]).not.toContain(host);
    }
  });

  it('authenticates to the sidecar and forwards the audio mime type', async () => {
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Speaker-Service-Key']).toBe('k'.repeat(32));
      expect(headers['Content-Type']).toBe('audio/wav');
      expect(init.method).toBe('POST');
      return { ok: true, status: 200, json: async () => TRANSCRIPT, text: async () => '' } as unknown as Response;
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    await provider().transcribe(audio());
    expect(fn).toHaveBeenCalledOnce();
  });

  it('returns SPEAKER-LABELLED segments, not one undifferentiated block', async () => {
    const { fn } = mockFetch(TRANSCRIPT);
    globalThis.fetch = fn as unknown as typeof fetch;
    const result = await provider().transcribe(audio());

    expect(result.providerId).toBe('local-stt');
    expect(result.segments).toHaveLength(2);
    expect(result.segments?.[0].text).toContain('speaker-1:');
    expect(result.segments?.[1].text).toContain('speaker-2:');
    expect(result.segments?.[0].startTime).toBe(0.2);
    // Flattened text carries the words without the labels doubled in.
    expect(result.text).toBe('So you still need to authenticate on the server. Right, and who handles that today?');
  });

  it('omits segments when the caller asked for plain text', async () => {
    const { fn } = mockFetch(TRANSCRIPT);
    globalThis.fetch = fn as unknown as typeof fetch;
    const result = await provider().transcribe({ ...audio(), enableSegments: false });
    expect(result.segments).toBeUndefined();
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('reports an actionable reason when the sidecar is not configured', async () => {
    const previousUrl = process.env.SPEAKER_DIARIZATION_URL;
    const previousKey = process.env.SPEAKER_SERVICE_KEY;
    delete process.env.SPEAKER_DIARIZATION_URL;
    delete process.env.SPEAKER_SERVICE_KEY;
    try {
      const status = await new LocalSTTProvider().getStatus();
      expect(status.configured).toBe(false);
      expect(status.reason).toContain('SPEAKER_DIARIZATION_URL');
      // Must THROW rather than quietly transcribing somewhere else.
      await expect(new LocalSTTProvider().transcribe(audio())).rejects.toThrow(/not configured/i);
    } finally {
      if (previousUrl !== undefined) process.env.SPEAKER_DIARIZATION_URL = previousUrl;
      if (previousKey !== undefined) process.env.SPEAKER_SERVICE_KEY = previousKey;
    }
  });

  it('surfaces a sidecar error instead of returning an empty transcript', async () => {
    const { fn } = mockFetch({ code: 'asr_unavailable' }, 503);
    globalThis.fetch = fn as unknown as typeof fetch;
    await expect(provider().transcribe(audio())).rejects.toThrow(/503/);
  });
});
