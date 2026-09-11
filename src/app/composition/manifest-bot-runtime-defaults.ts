/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reuse deployment runtime selection for manifest bot initialization without crossing provider models.
 */
import { resolveRuntimeModelName, resolveRuntimeProviderName } from './provider-runtime';

/** @description Reuse deployment defaults only for the same provider so a different provider never inherits an unrelated model.
 * @param providerId - An explicit provider, otherwise the deployment's selected provider.
 * @returns Proven provider/model defaults; a different provider retains its own model resolution.
 */
export function resolveManifestBotRuntimeDefaults(providerId?: string): { providerId: string; modelId?: string } {
  const deployedProvider = resolveRuntimeProviderName();
  const selectedProvider = providerId ?? deployedProvider;
  const modelId = selectedProvider === deployedProvider ? resolveRuntimeModelName() : undefined;
  return { providerId: selectedProvider, ...(modelId ? { modelId } : {}) };
}
