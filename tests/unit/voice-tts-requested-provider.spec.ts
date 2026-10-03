/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D10 guard at the VoiceService boundary for the provider a synthesize request names (the body of POST /api/voice/synthesize). It is a preference, as before ADR-173: an UNREGISTERED one and a registered but UNAVAILABLE one both fall through to the swarm default instead of refusing the call, each with a structured warning that names the provider, what is missing and why, and the request's voice never travels to the provider that answers (D9). An available requested provider answers at the app rung with no warning. Over the REAL TTS registry built from a swarm config on disk and the real Gemini and OpenAI provider classes; only their status probes and synthesize calls are doubled, and the resolver's logger is captured.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const resolutionLog = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/logger')>();
  return {
    ...actual,
    createChildLogger: (bindings: Record<string, unknown>) =>
      (bindings?.module === 'capability-resolution' ? resolutionLog : actual.createChildLogger(bindings)),
  };
});

import { VoiceService } from '../../src/features/voice/services/voice-service';
import {
  getTTSProviderRegistry,
  resetTTSProviderRegistryForTesting,
} from '../../src/features/voice-providers/services/tts-provider-registry';
import { userCapabilityPrincipal, type CapabilityCaller, type CapabilitySwarmRowReader } from '../../src/shared/capability-providers';

const NO_ROWS: CapabilitySwarmRowReader = { state: () => ({ installed: false, loaded: false }), rowFor: () => null };
const CALLER: CapabilityCaller = { principal: userCapabilityPrincipal({ sub: 'request-provider-sub', isOperator: false }), appId: null, agentId: 'a0000000-0000-0000-0000-000000000050' };
const FALL_THROUGH = 'requested capability provider is not usable — falling through to the next rung (ADR-173 D10)';

/** A swarm config whose default is OpenAI (available) beside Gemini (no key in these cases). */
const CONFIG = {
  voice: {
    tts: {
      default: 'openai-tts',
      serverSide: 'openai-tts',
      providers: {
        browser: {},
        'gemini-tts': { model: 'gemini-2.5-flash-preview-tts', defaultVoice: 'Kore', sampleRateHz: 24000 },
        'openai-tts': { model: 'gpt-4o-mini-tts', defaultVoice: 'marin', responseFormat: 'mp3', timeoutMs: 1000, retryDelayMs: 1 },
      },
    },
    stt: { default: 'browser', providers: { browser: {} } },
  },
};

let configDir = '';
const sent: Array<{ providerId: string; voiceId?: string }> = [];

beforeAll(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tts-requested-'));
  fs.writeFileSync(path.join(configDir, 'global-config.json'), JSON.stringify(CONFIG));
});

afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('OSHAL_GLOBAL_CONFIG_PATH', path.join(configDir, 'global-config.json'));
  resetTTSProviderRegistryForTesting();
  sent.length = 0;
  resolutionLog.warn.mockClear();
  const registry = getTTSProviderRegistry();
  const gemini = registry.get('gemini-tts')!;
  const openai = registry.get('openai-tts')!;
  vi.spyOn(gemini, 'getStatus').mockResolvedValue({ configured: false, providerId: 'gemini-tts', reason: 'GOOGLE_API_KEY / GEMINI_API_KEY env var is empty' });
  vi.spyOn(gemini, 'synthesize').mockImplementation(async (req) => { sent.push({ providerId: 'gemini-tts', voiceId: req.voiceId }); return { providerId: 'gemini-tts', audio: Buffer.from('g') }; });
  vi.spyOn(openai, 'getStatus').mockResolvedValue({ configured: true, providerId: 'openai-tts' });
  vi.spyOn(openai, 'synthesize').mockImplementation(async (req) => {
    sent.push({ providerId: 'openai-tts', voiceId: req.voiceId });
    return { providerId: 'openai-tts', audio: Buffer.from('mp3-bytes'), audioFormat: 'audio/mpeg', voiceId: req.voiceId };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetTTSProviderRegistryForTesting();
});

/** The fall-through warnings the resolver logged, as [fields, message] pairs. */
const fallThroughWarnings = () => resolutionLog.warn.mock.calls.filter((call) => call[1] === FALL_THROUGH);

describe('D10: the provider a synthesize request names is a preference, as before ADR-173', () => {
  it('an UNREGISTERED requested provider falls through to the swarm default, with a warning naming it and why', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('hello', 'Joanna', 'polly-tts', { caller: CALLER });
    expect(out).toMatchObject({ providerId: 'openai-tts', rung: 'swarm-default', voiceId: 'marin' });
    expect(out.fallback).toBeUndefined();
    expect(sent).toEqual([{ providerId: 'openai-tts', voiceId: 'marin' }]);
    expect(fallThroughWarnings()).toEqual([[
      expect.objectContaining({ capability: 'tts', providerId: 'polly-tts', missing: 'not-registered', detail: expect.any(String) }), FALL_THROUGH,
    ]]);
  });

  it('a registered but UNAVAILABLE requested provider falls through too, and its voice does not travel (D9)', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('hello', 'Kore', 'gemini-tts', { caller: CALLER });
    expect(out).toMatchObject({ providerId: 'openai-tts', rung: 'swarm-default', voiceId: 'marin' });
    expect(sent).toEqual([{ providerId: 'openai-tts', voiceId: 'marin' }]);
    expect(fallThroughWarnings()).toEqual([[
      expect.objectContaining({ capability: 'tts', providerId: 'gemini-tts', missing: 'no-credential', detail: expect.stringContaining('GOOGLE_API_KEY') }), FALL_THROUGH,
    ]]);
  });

  it('an available requested provider answers at the app rung, with its listed voice and no warning', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('hello', 'cedar', 'openai-tts', { caller: CALLER });
    expect(out).toMatchObject({ providerId: 'openai-tts', rung: 'app', voiceId: 'cedar' });
    expect(fallThroughWarnings()).toEqual([]);
  });
});
