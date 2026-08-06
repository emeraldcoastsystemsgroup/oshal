/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the per-provider Cline config builder from LLMProviderRegistry.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: remove credential parameters and ambient-secret fallbacks; emit non-secret provider/model metadata with auto-approval disabled.
 */
'use strict';

const { PROVIDERS } = require('./provider-definitions');

/** Stable refusal for the removed credential-materialization API. */
function credentialCarrierError() {
  const error = new Error(
    'Credential-bearing Cline configuration is disabled; use a hosted provider or deterministic server operation.',
  );
  error.code = 'UNSCOPED_CREDENTIAL_CARRIER';
  return error;
}

/**
 * @description Builds non-secret provider/model metadata only. Unattended Cline execution is
 * fail-closed elsewhere; this compatibility shape must never acquire API keys, tokens, secrets,
 * or ambient credential fallbacks. Passing a third argument is rejected even when empty so the
 * former credential API cannot silently return.
 * @param {string} providerId - Provider id from the static registry.
 * @param {string} modelId - Non-secret model identifier.
 * @returns {object|null} Non-secret compatibility metadata, or null for wrapper-owned runtimes.
 */
function buildClineConfig(providerId, modelId) {
  if (arguments.length > 2) throw credentialCarrierError();
  if (!PROVIDERS[providerId]) throw new Error(`Unknown provider: ${providerId}`);
  if (providerId === 'cline-cli' || providerId === 'claude-code') return null;
  return {
    autoApprove: false,
    provider: providerId,
    model: typeof modelId === 'string' ? modelId : '',
  };
}

module.exports = {
  buildClineConfig,
};
