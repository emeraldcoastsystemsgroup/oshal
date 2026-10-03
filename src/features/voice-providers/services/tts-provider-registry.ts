/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | TTS provider registry — singleton that instantiates providers from swarm config and resolves swarm-default vs per-app overrides at call time
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Registered OpenAI TTS as an explicit server provider without changing swarm defaults.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: configuredDefaultId(channel) and configuredDefaultVoice(id) expose what the swarm config names (the seed of the swarm default when no swarm row exists, D6) and a provider's own default voice (the voice a resolution landing on it uses, D9), so the capability adapter reads the same config this registry was built from.
 */

import { createChildLogger } from '@/shared/logger';
import {
  BrowserTTSProvider,
  GeminiTTSProvider,
  GoogleCloudTTSProvider,
  OpenAITTSProvider,
  type GeminiTTSConfig,
  type GoogleCloudTTSConfig,
  type OpenAITTSConfig,
} from '../providers';
import {
  SWARM_DEFAULT_SENTINEL,
  type SwarmAppVoiceConfig,
  type SwarmVoiceConfig,
  type TTSProvider,
} from '../types';
import { loadSwarmVoiceConfig } from './voice-config-loader';

const logger = createChildLogger({ module: 'tts-provider-registry' });

/**
 * @description Registry of all TTS providers known to this swarm. Pattern
 * mirrors `any-bot/server/services/llm/LLMProviderRegistry.js` — one entry
 * per provider, resolved at call time from config.
 */
export class TTSProviderRegistry {
  private providers = new Map<string, TTSProvider>();
  private config: SwarmVoiceConfig;

  constructor(config?: SwarmVoiceConfig) {
    this.config = config || loadSwarmVoiceConfig();
    this.seedProviders();
  }

  /**
   * @description Instantiate and register every provider declared in the
   * swarm config. Unknown provider IDs are logged and skipped — they don't
   * crash the registry.
   */
  private seedProviders(): void {
    const declared = Object.keys(this.config.tts.providers);
    for (const id of declared) {
      const provider = this.buildProvider(id);
      if (provider) {
        this.providers.set(id, provider);
      }
    }
    logger.info(
      { registered: Array.from(this.providers.keys()), default: this.config.tts.default },
      'TTS providers registered',
    );
  }

  /**
   * @description Factory for a single provider. Add new provider IDs here
   * as sibling classes are added (ElevenLabs, OpenAI, etc.).
   *
   * @param id Provider identifier from config.
   * @returns Instantiated provider or `null` when the ID is unknown.
   */
  private buildProvider(id: string): TTSProvider | null {
    const options = this.config.tts.providers[id] || {};
    switch (id) {
      case 'browser':
        return new BrowserTTSProvider();
      case 'gemini-tts':
        return new GeminiTTSProvider(options as unknown as GeminiTTSConfig);
      case 'google-cloud-tts':
        return new GoogleCloudTTSProvider(options as unknown as GoogleCloudTTSConfig);
      case 'openai-tts':
        return new OpenAITTSProvider(options as unknown as OpenAITTSConfig);
      default:
        logger.warn({ id }, 'Unknown TTS provider in config — skipping');
        return null;
    }
  }

  /**
   * @description List every registered provider (for UI dropdowns).
   *
   * @returns All providers in registration order.
   */
  list(): TTSProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * @description Look up a provider by ID.
   *
   * @param id Provider identifier.
   * @returns Provider instance, or `undefined` when not registered.
   */
  get(id: string): TTSProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * @description The provider id the swarm config names for a channel, whether or not it is
   * registered: the seed of the swarm default when no swarm row exists (ADR-173 D6).
   *
   * @param channel Which configured default — `default` or `serverSide`.
   * @returns The configured provider id.
   */
  configuredDefaultId(channel: 'default' | 'serverSide' = 'default'): string {
    return channel === 'serverSide'
      ? this.config.tts.serverSide || this.config.tts.default
      : this.config.tts.default;
  }

  /**
   * @description A provider's configured default voice (its `defaultVoice` option): the voice a
   * resolution that lands on this provider without a voice of its own uses (ADR-173 D9).
   *
   * @param id Provider identifier.
   * @returns The voice id, or null when the provider configures none.
   */
  configuredDefaultVoice(id: string): string | null {
    const value = this.config.tts.providers[id]?.defaultVoice;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  /**
   * @description Resolve the provider for a given swarm-app voice config,
   * falling back to the swarm-level default when the app uses the
   * `swarm-default` sentinel or omits TTS entirely.
   *
   * @param appConfig Per-app voice block (optional).
   * @param channel Which default to use when the app defers — `tts.default`
   *   for client-facing synthesis, `tts.serverSide` for async audio rendering.
   * @returns Resolved provider — never `undefined`; falls back to browser.
   */
  resolveForApp(
    appConfig?: SwarmAppVoiceConfig,
    channel: 'default' | 'serverSide' = 'default',
  ): TTSProvider {
    const requested = appConfig?.tts?.provider;
    if (requested && requested !== SWARM_DEFAULT_SENTINEL) {
      const explicit = this.providers.get(requested);
      if (explicit) return explicit;
      logger.warn(
        { requested, available: Array.from(this.providers.keys()) },
        'Swarm app requested unknown TTS provider — falling back to swarm default',
      );
    }
    const defaultId =
      channel === 'serverSide'
        ? this.config.tts.serverSide || this.config.tts.default
        : this.config.tts.default;
    return this.providers.get(defaultId) || new BrowserTTSProvider();
  }
}

let singleton: TTSProviderRegistry | undefined;

/**
 * @description Lazy singleton accessor. Kept as a function (rather than a
 * top-level constant) so tests can reset between runs by clearing the module.
 *
 * @returns Shared registry instance.
 */
export function getTTSProviderRegistry(): TTSProviderRegistry {
  if (!singleton) {
    singleton = new TTSProviderRegistry();
  }
  return singleton;
}

/**
 * @description Reset the singleton — for tests that want a fresh registry
 * after mutating config. Not for production use.
 */
export function resetTTSProviderRegistryForTesting(): void {
  singleton = undefined;
}
