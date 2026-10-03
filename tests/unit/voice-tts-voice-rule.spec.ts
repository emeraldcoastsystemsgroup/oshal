/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D9 guard at the VoiceService boundary, over the REAL TTS registry built from a swarm config on disk (OSHAL_GLOBAL_CONFIG_PATH) and the real Gemini and OpenAI provider classes — only their status probes and the OpenAI network call are doubled. Pins: a saved (provider, voice) pair whose provider is unavailable lands on the swarm default with THAT provider's default voice; a voice hint the landing provider does not list (a Gemini voice name sent to OpenAI) is dropped; an explicit provider with an unlisted voice is sent its own default voice; a listed voice of an available saved pair is kept; and across every case no synthesize call ever carries a voice id the landing provider does not list.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D10 (round 2): the provider a synthesize request names is a preference (D10's default), so an unavailable one is no longer refused: it falls through to the swarm default under D5 (a change from main, where it was called and returned its own unconfigured result), and its voice ('Kore') is not sent to the provider that answers (D9). The fall-through itself, the unregistered case and the warning are pinned in voice-tts-requested-provider.spec.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../../src/features/voice/services/voice-service';
import {
  getTTSProviderRegistry,
  resetTTSProviderRegistryForTesting,
} from '../../src/features/voice-providers/services/tts-provider-registry';
import { userCapabilityPrincipal, type CapabilityCaller, type CapabilitySwarmRowReader } from '../../src/shared/capability-providers';

const NO_ROWS: CapabilitySwarmRowReader = { state: () => ({ installed: false, loaded: false }), rowFor: () => null };
const CALLER: CapabilityCaller = { principal: userCapabilityPrincipal({ sub: 'listener-sub', isOperator: false }), appId: null, agentId: 'a0000000-0000-0000-0000-000000000050' };

/** A swarm config whose default is OpenAI (available) beside Gemini (made unavailable per case). */
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
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tts-voice-rule-'));
  fs.writeFileSync(path.join(configDir, 'global-config.json'), JSON.stringify(CONFIG));
});

afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('OSHAL_GLOBAL_CONFIG_PATH', path.join(configDir, 'global-config.json'));
  resetTTSProviderRegistryForTesting();
  sent.length = 0;
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

/** Every voice OpenAI lists (static in the provider class). */
async function openAiVoices(): Promise<string[]> {
  return (await getTTSProviderRegistry().get('openai-tts')!.listVoices()).map((voice) => voice.id);
}

describe('D9: a TTS voice travels only with its own provider', () => {
  it('a saved pair whose provider is unavailable lands on the swarm default with ITS default voice', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('hello there', undefined, undefined, {
      caller: CALLER, userDefault: { providerId: 'gemini-tts', voice: 'Puck' },
    });
    expect(out).toMatchObject({ providerId: 'openai-tts', rung: 'swarm-default', voiceId: 'marin' });
    expect(sent).toEqual([{ providerId: 'openai-tts', voiceId: 'marin' }]);
  });

  it('a voice hint from another provider (a Gemini name) is dropped by OpenAI, which keeps its default voice', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('read aloud', 'Kore', undefined, { caller: CALLER });
    expect(out).toMatchObject({ providerId: 'openai-tts', voiceId: 'marin' });
    expect(sent).toEqual([{ providerId: 'openai-tts', voiceId: 'marin' }]);
  });

  it('an explicit provider with a voice it does not list is sent its own default voice', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('preview', 'not-a-voice', 'openai-tts', { caller: CALLER });
    expect(out).toMatchObject({ providerId: 'openai-tts', rung: 'app', voiceId: 'marin' });
  });

  it('a listed voice of an available saved pair is kept, at the user-default rung', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('mine', undefined, undefined, {
      caller: CALLER, userDefault: { providerId: 'openai-tts', voice: 'cedar' },
    });
    expect(out).toMatchObject({ providerId: 'openai-tts', rung: 'user-default', voiceId: 'cedar' });
  });

  it('no synthesize call in any case carries a voice id the landing provider does not list', async () => {
    const service = new VoiceService({ rows: NO_ROWS });
    await service.synthesizeSpeech('one', undefined, undefined, { caller: CALLER, userDefault: { providerId: 'gemini-tts', voice: 'Charon' } });
    await service.synthesizeSpeech('two', 'Zephyr', undefined, { caller: CALLER });
    await service.synthesizeSpeech('three', 'Kore', 'openai-tts', { caller: CALLER });
    await service.synthesizeSpeech('four', undefined, undefined, { caller: CALLER, userDefault: { providerId: 'openai-tts', voice: 'ash' } });
    const listed = await openAiVoices();
    expect(sent.length).toBe(4);
    for (const call of sent) {
      expect(call.providerId).toBe('openai-tts');
      expect(listed, `voice ${call.voiceId} must be one OpenAI lists`).toContain(call.voiceId);
    }
  });

  it('a requested provider that is unavailable falls through, and its voice is not sent to the provider that answers', async () => {
    const out = await new VoiceService({ rows: NO_ROWS }).synthesizeSpeech('nope', 'Kore', 'gemini-tts', { caller: CALLER });
    expect(out).toMatchObject({ providerId: 'openai-tts', rung: 'swarm-default', voiceId: 'marin' });
    expect(sent).toEqual([{ providerId: 'openai-tts', voiceId: 'marin' }]);
  });
});
