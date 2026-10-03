/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1 Done-when "for each capability a spec shows the options list and the resolver agree for every provider" (D3: one availability function per capability, asked by both). For each REAL adapter — text to speech and speech to text over real registries built from a swarm config, images over the real storyboard providers, video over the real built-in video providers — every declared provider is made the swarm row in turn and resolved, and the resolution must say exactly what the options list says: available means the resolver lands on that provider at the swarm-default rung; unavailable means it refuses with the same missing piece and the same sentence. Run twice per capability, once with the credentials present and once without, so both answers of every provider are compared. Doubles: each provider's own credential probe where it reads files or the host (getStatus spies for the Google Cloud pair), and the two vendor key probes (OpenAI /v1/models, OpenRouter /key) — no network call leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_FLEET_SCOPE,
  listCapabilityOptions,
  resolveCapabilityProvider,
  userCapabilityPrincipal,
  type CapabilityAdapter,
  type CapabilityCallerCredentials,
  type CapabilityPrincipal,
  type CapabilitySwarmRowReader,
} from '@/shared/capability-providers';
import {
  STTProviderRegistry,
  TTSProviderRegistry,
  createSttCapabilityAdapter,
  createTtsCapabilityAdapter,
} from '@/features/voice-providers';
import {
  clearStoryboardImageHealthCache,
  createImageCapabilityAdapter,
  createVideoCapabilityAdapter,
  registerCliStoryboardImageExecutor,
} from '@/features/video-generation';

const OPERATOR_SUB = 'agree-operator-sub';
const OPERATOR: CapabilityPrincipal = userCapabilityPrincipal({ sub: OPERATOR_SUB, isOperator: true });
const PERSON: CapabilityPrincipal = userCapabilityPrincipal({ sub: 'agree-person-sub', isOperator: false });

const VOICE_CONFIG = {
  tts: {
    default: 'google-cloud-tts',
    providers: {
      browser: {},
      'gemini-tts': { model: 'gemini-2.5-flash-preview-tts', defaultVoice: 'Kore', sampleRateHz: 24000 },
      'google-cloud-tts': { defaultVoice: 'en-US-Chirp3-HD-Kore', defaultLanguageCode: 'en-US', audioEncoding: 'MP3' },
      'openai-tts': { model: 'gpt-4o-mini-tts', defaultVoice: 'marin', responseFormat: 'mp3' },
    },
  },
  stt: {
    default: 'gemini-stt',
    providers: {
      browser: {},
      'gemini-stt': { model: 'gemini-2.5-flash', defaultLanguageCode: 'en-US', transcribePrompt: 'Transcribe.' },
      'google-cloud-stt': { model: 'chirp_3', defaultLanguageCode: 'en-US', location: 'us' },
      'local-stt': {},
    },
  },
};

/** A row reader holding ONE fleet row for one capability. */
function fleetRow(capability: string, providerId: string): CapabilitySwarmRowReader {
  return {
    state: () => ({ installed: true, loaded: true }),
    rowFor: (scopeId, asked) => (scopeId === CAPABILITY_FLEET_SCOPE && asked === capability
      ? { scopeId, capability: asked, providerId, options: {}, updatedBy: OPERATOR_SUB, updatedAt: null } : null),
  };
}

/**
 * @description The agreement itself: every declared provider, made the swarm row, resolves to
 * exactly what the options list says about it.
 * @returns How many providers each answer covered.
 */
async function assertAgreement(adapter: CapabilityAdapter, principal: CapabilityPrincipal, credentials?: CapabilityCallerCredentials) {
  const options = await listCapabilityOptions(adapter, principal, credentials);
  expect(options.map((o) => o.providerId)).toEqual(adapter.declarations().map((d) => d.providerId));
  const tally = { available: 0, unavailable: 0 };
  for (const option of options) {
    const resolution = await resolveCapabilityProvider(adapter, {
      capability: adapter.capability, principal, appId: null, agentId: null, credentials,
    }, { rows: fleetRow(adapter.capability, option.providerId) });
    if (option.available) {
      tally.available += 1;
      expect(resolution, `${adapter.capability}/${option.providerId} is offered, so it must resolve`)
        .toMatchObject({ ok: true, providerId: option.providerId, rung: 'swarm-default', costClass: option.costClass });
    } else {
      tally.unavailable += 1;
      expect(resolution, `${adapter.capability}/${option.providerId} is not offered, so it must refuse the same way`)
        .toMatchObject({ ok: false, missing: option.missing, detail: option.detail });
    }
  }
  return tally;
}

/** Vendor key probes answered in-process: never a network call from this spec. */
function stubVendorProbes(ok: boolean): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://openrouter.ai/api/v1/key') || url.startsWith('https://api.openai.com/v1/models')) {
      return new Response(JSON.stringify({ data: { usage: 0, limit_remaining: 5 } }), { status: ok ? 200 : 401 });
    }
    throw new Error(`unexpected network call from the agreement spec: ${url}`);
  });
}

beforeEach(() => {
  for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'SPEAKER_DIARIZATION_URL', 'SPEAKER_SERVICE_KEY',
    'COMFYUI_URL', 'COMFYUI_STORYBOARD_WORKFLOW', 'COMFYUI_WORKFLOW_PATH', 'VERTEX_PROJECT', 'GCP_PROJECT_ID', 'VEO_ALLOW_SWARM_BILLING',
    'STORYBOARD_IMAGE_PROVIDER', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'OSHAL_SEED_SECRETS_PATH']) vi.stubEnv(name, '');
  clearStoryboardImageHealthCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  registerCliStoryboardImageExecutor(null);
  clearStoryboardImageHealthCache();
});

describe('D3: the options list and the resolver agree for every provider of every capability', () => {
  it('text to speech — credentials present, then absent', async () => {
    const registry = new TTSProviderRegistry(VOICE_CONFIG);
    const adapter = createTtsCapabilityAdapter(() => registry);
    vi.stubEnv('GOOGLE_API_KEY', 'agree-fake-google-key');
    vi.stubEnv('OPENAI_API_KEY', 'agree-fake-openai-key');
    const cloud = vi.spyOn(registry.get('google-cloud-tts')!, 'getStatus').mockResolvedValue({ configured: true, providerId: 'google-cloud-tts' });
    vi.spyOn(registry.get('google-cloud-tts')!, 'listVoices').mockResolvedValue([]);
    expect(await assertAgreement(adapter, PERSON)).toEqual({ available: 4, unavailable: 0 });
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    cloud.mockResolvedValue({ configured: false, providerId: 'google-cloud-tts', reason: 'no readable service-account ADC credential' });
    expect(await assertAgreement(adapter, PERSON)).toEqual({ available: 1, unavailable: 3 });
  });

  it('speech to text — credentials present, then absent', async () => {
    const registry = new STTProviderRegistry(VOICE_CONFIG);
    const adapter = createSttCapabilityAdapter(() => registry);
    vi.stubEnv('GOOGLE_API_KEY', 'agree-fake-google-key');
    vi.stubEnv('SPEAKER_DIARIZATION_URL', 'http://192.168.50.10:8080');
    vi.stubEnv('SPEAKER_SERVICE_KEY', 'agree-fake-sidecar-key');
    const cloud = vi.spyOn(registry.get('google-cloud-stt')!, 'getStatus').mockResolvedValue({ configured: true, providerId: 'google-cloud-stt' });
    expect(await assertAgreement(adapter, PERSON)).toEqual({ available: 4, unavailable: 0 });
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('SPEAKER_SERVICE_KEY', '');
    cloud.mockResolvedValue({ configured: false, providerId: 'google-cloud-stt', reason: 'GOOGLE_CLOUD_PROJECT is not set' });
    expect(await assertAgreement(adapter, PERSON)).toEqual({ available: 1, unavailable: 3 });
  });

  it('images — the operator with keys, a token and the demo carve; then a person with none of them', async () => {
    const adapter = createImageCapabilityAdapter();
    vi.stubEnv('OPENAI_API_KEY', 'sk-agree-fake-platform-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-agree-fake-key');
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR_SUB);
    registerCliStoryboardImageExecutor(async () => ({ success: false, responseText: '', error: 'never called by the agreement spec' }));
    stubVendorProbes(true);
    // comfyui stays unconfigured (no COMFYUI_URL), so no box is probed.
    expect(await assertAgreement(adapter, OPERATOR, { vertexToken: 'ya29.agree-fake-token' })).toEqual({ available: 5, unavailable: 1 });
    clearStoryboardImageHealthCache();
    vi.restoreAllMocks();
    stubVendorProbes(false);
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(await assertAgreement(adapter, PERSON)).toEqual({ available: 0, unavailable: 6 });
  });

  it('images — a key the vendor rejects is unavailable to both the list and the resolver (the D3 health probe)', async () => {
    const adapter = createImageCapabilityAdapter();
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-agree-revoked-key');
    stubVendorProbes(false);
    const options = await listCapabilityOptions(adapter, OPERATOR);
    expect(options.find((o) => o.providerId === 'openrouter')).toMatchObject({ available: false, missing: 'health-check-failed' });
    await assertAgreement(adapter, OPERATOR);
  });

  it('video — a Vertex project and the caller\'s token, then neither', async () => {
    const adapter = createVideoCapabilityAdapter();
    vi.stubEnv('VERTEX_PROJECT', 'agree-fake-project');
    expect(await assertAgreement(adapter, PERSON, { vertexToken: 'ya29.agree-fake-token' })).toEqual({ available: 2, unavailable: 1 });
    vi.stubEnv('VERTEX_PROJECT', '');
    expect(await assertAgreement(adapter, PERSON)).toEqual({ available: 1, unavailable: 2 });
  });
});
