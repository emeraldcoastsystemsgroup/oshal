/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reuse deployment runtime selection for manifest bot initialization without crossing provider models.
 */
import { resolveRuntimeModelName, resolveRuntimeProviderName } from './provider-runtime';

/** A different declared provider gets no guessed model; its existing provider default remains responsible. */
export function resolveManifestBotRuntimeDefaults(providerId?: string): { providerId: string; modelId?: string } {
  const deployedProvider = resolveRuntimeProviderName();
  const selectedProvider = providerId ?? deployedProvider;
  const modelId = selectedProvider === deployedProvider ? resolveRuntimeModelName() : undefined;
  return { providerId: selectedProvider, ...(modelId ? { modelId } : {}) };
}
