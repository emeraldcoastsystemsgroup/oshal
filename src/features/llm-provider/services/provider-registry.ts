/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — static provider metadata registry
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored: extracted provider definitions to provider-definitions.ts
 *              |         | Expanded from 4 to 41 providers matching Phase 1 UI and ApiProvider enum
 */

import { createChildLogger } from '@/shared/logger';
import type { ApiProvider } from '@/shared/types';
import { PROVIDER_DEFINITIONS } from './provider-definitions';

const logger = createChildLogger({ module: 'provider-registry' });

/**
 * @description Model pricing per million tokens.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

/**
 * @description Capability flags for an LLM model.
 */
export interface ModelCapabilities {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  extendedThinking: boolean;
  promptCaching: boolean;
}

/**
 * @description Metadata for a single model within a provider.
 */
export interface ModelInfo {
  id: string;
  name: string;
  maxTokens: number;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  isDefault?: boolean;
}

/**
 * @description Metadata for an LLM provider.
 */
export interface ProviderInfo {
  id: ApiProvider;
  displayName: string;
  description: string;
  models: ModelInfo[];
  defaultModelId: string;
  requiresApiKey: boolean;
  configKeys: string[];
}

/**
 * @description Static registry of known LLM providers and their models.
 * Loads all 41 provider definitions from provider-definitions.ts.
 * This is metadata only — NOT runtime provider instances.
 *
 * @remarks
 * The registry provides lookup for display names, model lists, pricing,
 * and capability flags. Used by the UI for dropdowns and by the cost
 * calculator for per-model pricing.
 */
export class ProviderRegistry {
  private providers: Map<string, ProviderInfo>;

  constructor() {
    this.providers = new Map();
    this.registerDefaults();
    logger.info({ providerCount: this.providers.size }, 'Provider registry initialized');
  }

  /**
   * @description Register the default set of known providers from definitions file.
   */
  private registerDefaults(): void {
    for (const def of PROVIDER_DEFINITIONS) {
      this.register(def);
    }
  }

  /**
   * @description Register a provider in the registry.
   * @param info - Provider metadata
   */
  register(info: ProviderInfo): void {
    this.providers.set(info.id, info);
    logger.debug({ providerId: info.id, modelCount: info.models.length }, 'Provider registered');
  }

  /**
   * @description Get provider metadata by ID.
   * @param id - Provider identifier
   * @returns Provider info or undefined
   */
  get(id: string): ProviderInfo | undefined {
    return this.providers.get(id);
  }

  /**
   * @description Get all registered providers.
   * @returns Array of provider metadata
   */
  getAll(): ProviderInfo[] {
    return Array.from(this.providers.values());
  }

  /**
   * @description Get the default model for a provider.
   * @param providerId - Provider identifier
   * @returns Default model info or undefined
   */
  getDefaultModel(providerId: string): ModelInfo | undefined {
    const provider = this.providers.get(providerId);
    if (!provider) return undefined;
    return provider.models.find((m) => m.id === provider.defaultModelId) ?? provider.models[0];
  }

  /**
   * @description Get all models for a provider.
   * @param providerId - Provider identifier
   * @returns Array of model info
   */
  getModels(providerId: string): ModelInfo[] {
    return this.providers.get(providerId)?.models ?? [];
  }

  /**
   * @description Check if a provider is registered.
   * @param id - Provider identifier
   * @returns True if provider exists
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * @description Get the total number of registered providers.
   * @returns Provider count
   */
  count(): number {
    return this.providers.size;
  }
}