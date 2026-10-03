/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: the text-to-speech and speech-to-text capability adapters the shared resolver walks. Declarations come from the registered providers and the cost class each declares (D4); ONE availability function per capability answers "may this caller use this provider now?" for the options list and the resolver alike, cheapest check first and naming the missing piece (D3): registered, a declared cost class, then the credential the provider itself reads (its getStatus); speech has no health probe and no user-written choice needs a grant until S2. The seed of the swarm default is what the swarm config names, exactly as the registry's resolveForApp chose it before (an unregistered configured default was the browser engine, and still is), so with no swarm row nothing changes. Text to speech also lists the voice ids a provider offers, cached for OSHAL_CAPABILITY_VOICE_LIST_TTL_MS, so a voice is never sent to a provider that did not list it (D9).
 */

/**
 * @description Capability adapters for text to speech and speech to text (ADR-173).
 * @module features/voice-providers/services/voice-capability-adapters
 */

import { createChildLogger } from '@/shared/logger';
import {
  isCapabilityCostClass,
  type CapabilityAdapter,
  type CapabilityAvailability,
  type CapabilityProviderDeclaration,
  type CapabilitySeedDefault,
} from '@/shared/capability-providers';
import type { STTProvider, TTSProvider, VoiceProviderStatus } from '../types';
import type { STTProviderRegistry } from './stt-provider-registry';
import type { TTSProviderRegistry } from './tts-provider-registry';

const logger = createChildLogger({ module: 'voice-capability-adapters' });

/** How long a provider's voice list is trusted before it is listed again (ms). */
const DEFAULT_VOICE_LIST_TTL_MS = 600_000;

/** The registry parts the TTS adapter reads (a getter, so a reset singleton is picked up). */
export type TtsRegistryGetter = () => Pick<TTSProviderRegistry, 'list' | 'get' | 'configuredDefaultId' | 'configuredDefaultVoice'>;

/** The registry parts the STT adapter reads. */
export type SttRegistryGetter = () => Pick<STTProviderRegistry, 'list' | 'get' | 'configuredDefaultId'>;

/**
 * @description The voice-list cache lifetime from the environment.
 * @param env - Environment map.
 * @returns Milliseconds; 0 disables caching.
 */
export function resolveVoiceListTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OSHAL_CAPABILITY_VOICE_LIST_TTL_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_VOICE_LIST_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_VOICE_LIST_TTL_MS;
}

/** A speech provider of either direction, as far as availability is concerned. */
type SpeechProvider = Pick<TTSProvider | STTProvider, 'id' | 'displayName' | 'kind' | 'costClass' | 'getStatus'>;

/**
 * @description getStatus that never throws: a probe that throws reads as "no credential" with its message.
 * @param provider - The provider.
 * @returns Its status.
 */
async function safeStatus(provider: SpeechProvider): Promise<VoiceProviderStatus> {
  try {
    return await provider.getStatus();
  } catch (err) {
    logger.error({ err, providerId: provider.id }, 'Speech provider status probe failed — reporting it unavailable');
    return { configured: false, providerId: provider.id, reason: (err as Error).message };
  }
}

/**
 * @description The shared speech availability check (D3): registered, a declared class, a credential.
 * @param noun - 'TTS' or 'STT', for the sentence.
 * @param provider - The registered provider, or undefined.
 * @param providerId - The id that was asked for.
 * @returns The availability.
 */
async function speechAvailability(
  noun: 'TTS' | 'STT',
  provider: SpeechProvider | undefined,
  providerId: string,
): Promise<CapabilityAvailability> {
  if (!provider) {
    return { providerId, available: false, missing: 'not-registered', detail: `No ${noun} provider "${providerId}" is registered on this deployment.` };
  }
  if (!isCapabilityCostClass(provider.costClass)) {
    return { providerId, available: false, missing: 'no-cost-class', detail: `${providerId} declares no cost class, so it is never offered (ADR-173 D4).` };
  }
  const status = await safeStatus(provider);
  if (!status.configured) {
    return { providerId, available: false, missing: 'no-credential', detail: status.reason || `${providerId} is not configured on this deployment.` };
  }
  return { providerId, available: true, missing: null, detail: '' };
}

/**
 * @description One declaration per registered speech provider.
 * @param capability - 'tts' or 'stt'.
 * @param providers - The registered providers, in registration order.
 * @param defaultVoice - The configured default voice of a provider (text to speech only).
 * @returns The declarations.
 */
function speechDeclarations(
  capability: 'tts' | 'stt',
  providers: SpeechProvider[],
  defaultVoice: (id: string) => string | null,
): CapabilityProviderDeclaration[] {
  return providers.map((provider) => ({
    capability,
    providerId: provider.id,
    displayName: provider.displayName,
    costClass: isCapabilityCostClass(provider.costClass) ? provider.costClass : null,
    ...(capability === 'tts' ? { defaultVoice: defaultVoice(provider.id) } : {}),
  }));
}

/**
 * @description The seed of a speech swarm default: the configured id when it is registered, else the
 * browser engine — exactly what resolveForApp chose before ADR-173.
 * @param configuredId - The id the swarm config names.
 * @param registered - Whether that id is registered.
 * @param field - The config field, for the source label.
 * @returns The seed.
 */
function speechSeed(configuredId: string, registered: boolean, field: string): CapabilitySeedDefault {
  if (registered) return { choice: { providerId: configuredId, voice: null }, source: `global-config.json ${field}` };
  return { choice: { providerId: 'browser', voice: null }, source: `global-config.json ${field} names ${configuredId}, which is not registered; the browser engine, as before` };
}

/**
 * @description The voice ids one TTS provider lists, cached: null for the browser engine (it
 * enumerates on the client), [] when the list cannot be read.
 * @param registry - The registry getter.
 * @param ttlMs - Cache lifetime.
 * @returns The listing function.
 */
function cachedVoiceIds(registry: TtsRegistryGetter, ttlMs: number): (providerId: string) => Promise<string[] | null> {
  const cache = new Map<string, { at: number; ids: string[] }>();
  return async (providerId) => {
    const provider = registry().get(providerId);
    if (!provider) return [];
    if (provider.kind === 'browser') return null;
    const hit = cache.get(providerId);
    if (hit && ttlMs > 0 && Date.now() - hit.at < ttlMs) return hit.ids;
    try {
      const ids = (await provider.listVoices()).map((voice) => voice.id);
      cache.set(providerId, { at: Date.now(), ids });
      return ids;
    } catch (err) {
      logger.error({ err, providerId }, 'Listing a TTS provider\'s voices failed — no voice is sent to it unlisted');
      return [];
    }
  };
}

/**
 * @description The text-to-speech capability adapter (ADR-173 D3, D4, D6, D9).
 * @param registry - Getter for the TTS registry, read per call so a reset singleton is picked up.
 * @param ttlMs - Voice-list cache lifetime (default: OSHAL_CAPABILITY_VOICE_LIST_TTL_MS, 10 min).
 * @returns The adapter.
 */
export function createTtsCapabilityAdapter(registry: TtsRegistryGetter, ttlMs: number = resolveVoiceListTtlMs()): CapabilityAdapter {
  return {
    capability: 'tts',
    declarations: () => speechDeclarations('tts', registry().list(), (id) => registry().configuredDefaultVoice(id)),
    availability: async (providerId) => speechAvailability('TTS', registry().get(providerId), providerId),
    seedSwarmDefault: async () => {
      const configured = registry().configuredDefaultId('default');
      return speechSeed(configured, Boolean(registry().get(configured)), 'voice.tts.default');
    },
    listVoiceIds: cachedVoiceIds(registry, ttlMs),
  };
}

/**
 * @description The speech-to-text capability adapter (ADR-173 D3, D4, D6).
 * @param registry - Getter for the STT registry, read per call so a reset singleton is picked up.
 * @returns The adapter.
 */
export function createSttCapabilityAdapter(registry: SttRegistryGetter): CapabilityAdapter {
  return {
    capability: 'stt',
    declarations: () => speechDeclarations('stt', registry().list(), () => null),
    availability: async (providerId) => speechAvailability('STT', registry().get(providerId), providerId),
    seedSwarmDefault: async () => {
      const configured = registry().configuredDefaultId();
      return speechSeed(configured, Boolean(registry().get(configured)), 'voice.stt.default');
    },
  };
}
