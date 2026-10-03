/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | STT provider registry — mirrors TTS registry, resolves swarm-default vs per-app override for transcription calls
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: configuredDefaultId() exposes the STT default the swarm config names, the seed of the swarm default when no swarm row exists (D6), so the capability adapter reads the same config this registry was built from.
 */

import { createChildLogger } from '@/shared/logger';
import {
  BrowserSTTProvider,
  GeminiSTTProvider,
  GoogleCloudSTTProvider,
  LocalSTTProvider,
  type GeminiSTTConfig,
  type GoogleCloudSTTConfig,
  type LocalSTTConfig,
} from '../providers';
import {
  SWARM_DEFAULT_SENTINEL,
  type STTProvider,
  type SwarmAppVoiceConfig,
  type SwarmVoiceConfig,
} from '../types';
import { loadSwarmVoiceConfig } from './voice-config-loader';

const logger = createChildLogger({ module: 'stt-provider-registry' });

/**
 * @description Registry of all STT providers known to this swarm.
 */
export class STTProviderRegistry {
  private providers = new Map<string, STTProvider>();
  private config: SwarmVoiceConfig;

  constructor(config?: SwarmVoiceConfig) {
    this.config = config || loadSwarmVoiceConfig();
    this.seedProviders();
  }

  /**
   * @description Instantiate and register every declared STT provider.
   */
  private seedProviders(): void {
    const declared = Object.keys(this.config.stt.providers);
    for (const id of declared) {
      const provider = this.buildProvider(id);
      if (provider) {
        this.providers.set(id, provider);
      }
    }
    logger.info(
      { registered: Array.from(this.providers.keys()), default: this.config.stt.default },
      'STT providers registered',
    );
  }

  /**
   * @description Factory for a single provider. Add new provider IDs here
   * as sibling classes are added (OpenAI Whisper BYOK, Deepgram, etc.).
   *
   * @param id Provider identifier from config.
   * @returns Instantiated provider or `null` when the ID is unknown.
   */
  private buildProvider(id: string): STTProvider | null {
    const options = this.config.stt.providers[id] || {};
    switch (id) {
      case 'browser':
        return new BrowserSTTProvider();
      case 'gemini-stt':
        return new GeminiSTTProvider(options as unknown as GeminiSTTConfig);
      case 'google-cloud-stt':
        return new GoogleCloudSTTProvider(options as unknown as GoogleCloudSTTConfig);
      // On-host transcription via the pinned sherpa-onnx sidecar. The only STT option here
      // where the audio never leaves the machine — and the only one that returns speaker
      // labels rather than one undifferentiated block of text.
      case 'local-stt':
        return new LocalSTTProvider(options as unknown as LocalSTTConfig);
      default:
        logger.warn({ id }, 'Unknown STT provider in config — skipping');
        return null;
    }
  }

  /**
   * @description List every registered provider.
   *
   * @returns All providers in registration order.
   */
  list(): STTProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * @description Look up a provider by ID.
   *
   * @param id Provider identifier.
   * @returns Provider instance, or `undefined` when not registered.
   */
  get(id: string): STTProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * @description The provider id the swarm config names as the STT default, whether or not it is
   * registered: the seed of the swarm default when no swarm row exists (ADR-173 D6).
   *
   * @returns The configured provider id.
   */
  configuredDefaultId(): string {
    return this.config.stt.default;
  }

  /**
   * @description Resolve the STT provider for a given swarm-app voice config.
   *
   * @param appConfig Per-app voice block (optional).
   * @returns Resolved provider — never `undefined`; falls back to browser.
   */
  resolveForApp(appConfig?: SwarmAppVoiceConfig): STTProvider {
    const requested = appConfig?.stt?.provider;
    if (requested && requested !== SWARM_DEFAULT_SENTINEL) {
      const explicit = this.providers.get(requested);
      if (explicit) return explicit;
      logger.warn(
        { requested, available: Array.from(this.providers.keys()) },
        'Swarm app requested unknown STT provider — falling back to swarm default',
      );
    }
    return this.providers.get(this.config.stt.default) || new BrowserSTTProvider();
  }
}

let singleton: STTProviderRegistry | undefined;

/**
 * @description Lazy singleton accessor.
 *
 * @returns Shared registry instance.
 */
export function getSTTProviderRegistry(): STTProviderRegistry {
  if (!singleton) {
    singleton = new STTProviderRegistry();
  }
  return singleton;
}

/**
 * @description Reset the singleton — for tests.
 */
export function resetSTTProviderRegistryForTesting(): void {
  singleton = undefined;
}
