/**
 * Default video-provider registration (ADR-070). Registers the built-in providers into the registry
 * — free providers first so the router prefers them: deck-to-video + ComfyUI (free) then Veo (paid).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial default-provider registration helper.
 *
 * @module video-generation/services/register-providers
 */

import { getVideoProviderRegistry, type VideoProviderRegistry } from './provider-registry';
import { DeckToVideoProvider } from './providers/deck-to-video-provider';
import { ComfyUIProvider } from './providers/comfyui-provider';
import { VeoProvider } from './providers/veo-provider';

/**
 * @description Register the built-in providers (free first, paid last). Idempotent per id.
 * @param registry - target registry (defaults to the singleton)
 * @returns the registry, for chaining
 */
export function registerDefaultVideoProviders(registry: VideoProviderRegistry = getVideoProviderRegistry()): VideoProviderRegistry {
  registry.register(new DeckToVideoProvider()); // free
  registry.register(new ComfyUIProvider());     // free (operator GPU box)
  registry.register(new VeoProvider());         // paid escalation
  return registry;
}
