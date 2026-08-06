/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Phase 0: ported provider-specific Cline runtime-file builders.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | SEC-05: remove credential parameters and ambient secret reads; emit non-secret provider/model metadata with every autonomous approval disabled.
 */

import { getClineProviderMapping, getProvider } from './provider-catalog';

function rejectLegacyCredentialCarrier(kind: 'configuration' | 'global state'): Error {
  const error = new Error(
    `Credential-bearing Cline ${kind} is disabled; use a hosted provider or deterministic server operation.`,
  );
  (error as Error & { code?: string }).code = 'UNSCOPED_CREDENTIAL_CARRIER';
  return error;
}

function resolveClineProvider(providerId: string): string | null {
  if (!getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);
  return getClineProviderMapping(providerId);
}

/**
 * @description Builds non-secret Cline compatibility metadata. API keys, OAuth material,
 * access keys, endpoints carrying credentials, and process-environment fallbacks are outside
 * this contract. Any third argument is a legacy credential carrier and fails closed even when
 * it is an empty object.
 * @param providerId - Provider identifier from the static catalog.
 * @param modelId - Non-secret model identifier.
 * @param legacyCredentialCarrier - Removed argument retained only to produce a stable refusal.
 * @returns Non-secret provider/model metadata, or null for wrapper-owned CLI providers.
 */
export function buildClineConfig(
  providerId: string,
  modelId: string,
  ...legacyCredentialCarrier: unknown[]
): Record<string, unknown> | null {
  if (legacyCredentialCarrier.length > 0) {
    throw rejectLegacyCredentialCarrier('configuration');
  }
  const provider = resolveClineProvider(providerId);
  if (provider === null) return null;
  return {
    autoApprove: false,
    provider,
    model: modelId,
  };
}

/**
 * @description Builds non-secret Cline compatibility state. It selects plan mode and disables
 * every autonomous action. The state deliberately contains no provider credential fields and
 * never reads ambient process secrets. A third argument is always rejected.
 * @param providerId - Provider identifier from the static catalog.
 * @param modelId - Non-secret model identifier.
 * @param legacyCredentialCarrier - Removed argument retained only to produce a stable refusal.
 * @returns Non-secret provider/model state with autonomous approvals off.
 */
export function buildClineGlobalState(
  providerId: string,
  modelId: string,
  ...legacyCredentialCarrier: unknown[]
): Record<string, unknown> {
  if (legacyCredentialCarrier.length > 0) {
    throw rejectLegacyCredentialCarrier('global state');
  }
  const provider = resolveClineProvider(providerId) ?? providerId;
  return {
    welcomeViewCompleted: true,
    mode: 'plan',
    yoloModeToggled: false,
    autoApprovalSettings: {
      version: 3,
      enabled: false,
      favorites: [],
      maxRequests: 0,
      enableNotifications: false,
      actions: {
        readFiles: false,
        readFilesExternally: false,
        editFiles: false,
        editFilesExternally: false,
        executeSafeCommands: false,
        executeAllCommands: false,
        useBrowser: false,
        useMcp: false,
      },
    },
    actModeApiProvider: provider,
    planModeApiProvider: provider,
    actModeApiModelId: modelId,
    planModeApiModelId: modelId,
  };
}
