/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the Cline global-state builder from LLMProviderRegistry.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: remove credential parameters and ambient-secret fallbacks; emit non-secret, non-auto-approved compatibility state only.
 */
'use strict';

const { PROVIDERS } = require('./provider-definitions');

/** Stable refusal for the removed credential-materialization API. */
function credentialCarrierError() {
  const error = new Error(
    'Credential-bearing Cline global state is disabled; use a hosted provider or deterministic server operation.',
  );
  error.code = 'UNSCOPED_CREDENTIAL_CARRIER';
  return error;
}

/**
 * @description Builds non-secret compatibility state. All autonomous approvals are off and no
 * API key, access key, token, secret, password, private key, endpoint credential, or process-env
 * fallback can enter the result. A third argument is always rejected.
 * @param {string} providerId - Provider id from the static registry.
 * @param {string} modelId - Non-secret model identifier.
 * @returns {object} Non-secret compatibility state.
 */
function buildGlobalState(providerId, modelId) {
  if (arguments.length > 2) throw credentialCarrierError();
  if (!PROVIDERS[providerId]) throw new Error(`Unknown provider: ${providerId}`);
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
    actModeApiProvider: providerId,
    planModeApiProvider: providerId,
    actModeApiModelId: typeof modelId === 'string' ? modelId : '',
    planModeApiModelId: typeof modelId === 'string' ? modelId : '',
  };
}

module.exports = {
  buildGlobalState,
};
