/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added OpenAI natural TTS request, credential isolation, voice catalog, retry, safe-error, and registry configuration coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Verify applications may select a bounded performance direction without changing the global narrator default.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Registry-config assertion tracks the PR #43 swarm TTS default change (gemini-tts → billed google-cloud-tts): the spec froze the OLD default and went red on main; the invariant under test (registering OpenAI must not displace the swarm default) is unchanged.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAITTSProvider,
  TTSProviderRegistry,
  type OpenAITTSConfig,
  type SwarmVoiceConfig,
} from '../../src/features/voice-providers';

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_CODEX_KEY = process.env.CODEX_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
});

afterEach(() => {
  restoreEnv('OPENAI_API_KEY', ORIGINAL_OPENAI_KEY);
  restoreEnv('CODEX_API_KEY', ORIGINAL_CODEX_KEY);
  vi.unstubAllGlobals();
});

describe('OpenAI TTS credentials and request contract', () => {
  it('uses only OPENAI_API_KEY and never a Codex credential', async () => {
    process.env.CODEX_API_KEY = 'codex-oauth-must-not-be-used';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITTSProvider(testConfig());

    await expect(provider.getStatus()).resolves.toEqual({
      providerId: 'openai-tts',
      configured: false,
      reason: 'OPENAI_API_KEY is required for OpenAI TTS',
    });
    await expect(provider.synthesize({ text: 'Never use OAuth.' })).rejects.toThrow(
      'OPENAI_API_KEY is required',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the official speech contract and returns natural MP3 bytes', async () => {
    process.env.OPENAI_API_KEY = 'unit-openai-platform-key';
    const fetchMock = vi.fn(async () => new Response(Buffer.from('natural-mp3'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITTSProvider(testConfig());

    const result = await provider.synthesize({ text: 'Roll for initiative.', speakingRate: 0.95 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(init.headers).toEqual({
      Authorization: 'Bearer unit-openai-platform-key',
      'Content-Type': 'application/json',
    });
    expect(body).toEqual({
      model: 'gpt-4o-mini-tts', input: 'Roll for initiative.', voice: 'marin',
      instructions: testConfig().instructions, response_format: 'mp3', speed: 0.95,
    });
    expect(result).toMatchObject({ providerId: 'openai-tts', audioFormat: 'audio/mpeg', voiceId: 'marin' });
    expect(result.audio?.toString()).toBe('natural-mp3');
  });

  it('uses a bounded application-specific performance direction when supplied', async () => {
    process.env.OPENAI_API_KEY = 'unit-openai-platform-key';
    const fetchMock = vi.fn(async () => new Response(Buffer.from('folk-mp3'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITTSProvider(testConfig());
    const performanceInstructions = 'Tell this as restrained dark folklore, intimate and unhurried.';

    await provider.synthesize({ text: 'The old road remembers.', performanceInstructions });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(JSON.parse(String(init.body)).instructions).toBe(performanceInstructions);
  });

  it('rejects empty or oversized application performance directions', async () => {
    process.env.OPENAI_API_KEY = 'unit-openai-platform-key';
    const provider = new OpenAITTSProvider(testConfig());

    await expect(provider.synthesize({ text: 'Speak.', performanceInstructions: '   ' }))
      .rejects.toThrow('performance instructions must contain');
    await expect(provider.synthesize({ text: 'Speak.', performanceInstructions: 'x'.repeat(601) }))
      .rejects.toThrow('performance instructions must contain');
  });
});

describe('OpenAI TTS catalog and retry policy', () => {
  it('exposes all 13 official built-in voices with marin as configured default', async () => {
    const provider = new OpenAITTSProvider(testConfig());
    const voices = await provider.listVoices();

    expect(voices.map((voice) => voice.id)).toEqual([
      'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova',
      'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
    ]);
    expect(voices).toHaveLength(13);
  });

  it.each([429, 503])('retries HTTP %s exactly once and then returns audio', async (status) => {
    process.env.OPENAI_API_KEY = 'unit-openai-platform-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('transient failure', { status }))
      .mockResolvedValueOnce(new Response(Buffer.from('retry-mp3'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITTSProvider(testConfig({ retryDelayMs: 0 }));

    const result = await provider.synthesize({ text: 'The gate opens.' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.audio?.toString()).toBe('retry-mp3');
  });
});

describe('OpenAI TTS failure safety', () => {
  it('does not retry client errors or expose a remote error body', async () => {
    process.env.OPENAI_API_KEY = 'unit-openai-platform-key';
    const fetchMock = vi.fn(async () => new Response(
      'remote-provider-secret-debug-body', { status: 400, headers: { 'x-request-id': 'req_safe' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITTSProvider(testConfig());
    const promise = provider.synthesize({ text: 'A malformed request.' });

    await expect(promise).rejects.toThrow('OpenAI TTS returned HTTP 400');
    await expect(promise).rejects.not.toThrow('remote-provider-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported voices before making a network request', async () => {
    process.env.OPENAI_API_KEY = 'unit-openai-platform-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITTSProvider(testConfig());

    await expect(provider.synthesize({ text: 'Speak.', voiceId: 'robot' })).rejects.toThrow(
      'Unsupported OpenAI TTS voice: robot',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OpenAI TTS registry configuration', () => {
  it('registers OpenAI while preserving the billed swarm TTS defaults', () => {
    const configPath = join(process.cwd(), 'config-seed', 'global-config.json');
    const seed = JSON.parse(readFileSync(configPath, 'utf8')) as { voice: SwarmVoiceConfig };
    const registry = new TTSProviderRegistry(seed.voice);
    const openai = seed.voice.tts.providers['openai-tts'];

    // Swarm-wide default is the billed google-cloud-tts (Chirp3-HD) since PR #43 (2026-07-26);
    // registering OpenAI must not displace it.
    expect(seed.voice.tts.default).toBe('google-cloud-tts');
    expect(seed.voice.tts.serverSide).toBe('google-cloud-tts');
    expect(openai).toMatchObject({
      model: 'gpt-4o-mini-tts', defaultVoice: 'marin', responseFormat: 'mp3',
    });
    expect(registry.get('openai-tts')).toBeInstanceOf(OpenAITTSProvider);
  });
});

function testConfig(overrides: Partial<OpenAITTSConfig> = {}): OpenAITTSConfig {
  return {
    model: 'gpt-4o-mini-tts',
    defaultVoice: 'marin',
    responseFormat: 'mp3',
    instructions: 'Speak as a crisp, natural, cinematic game master. Never sound robotic.',
    timeoutMs: 20_000,
    retryDelayMs: 250,
    ...overrides,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
