/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | 1000-line cap decomposition: PROVIDERS catalog + buildClineConfig + buildGlobalState extracted to registry/ modules; module.exports contract unchanged
 */

/**
 * LLM Provider Registry
 *
 * ⭐ PHASE_62: Full 22-provider registry matching Cline CLI's supported providers.
 * Used by the agent-config UI to populate provider/model dropdowns.
 * When a provider is selected and saved, the Cline CLI config is updated
 * so all subsequent Cline CLI invocations use the new provider.
 *
 * Architecture:
 * - Cline CLI remains the execution engine for all bots
 * - This registry controls WHAT provider/model Cline CLI uses
 * - Config is persisted to Redis + written to ~/.cline/config.json
 *
 * 22 providers confirmed in Cline CLI binary:
 * anthropic, asksage, azure, bedrock, cerebras, deepseek, fireworks,
 * gemini, groq, litellm, lmstudio, mistral, nebius, ollama, openai,
 * openai-native, openrouter, requesty, sambanova, together, vertex, xai
 */

const { PROVIDERS } = require('./registry/provider-definitions');
const { buildClineConfig } = require('./registry/cline-config-builder');
const { buildGlobalState } = require('./registry/global-state-builder');

/**
 * Get all providers as an array
 * @description Flattens the PROVIDERS catalog into an array for the
 * agent-config UI provider dropdown.
 * @returns {Object[]} All provider definition objects
 */
function getAllProviders() {
  return Object.values(PROVIDERS);
}

/**
 * Get a specific provider by ID
 * @description Looks up a single provider definition from the catalog.
 * @param {string} providerId - Provider id (a key of PROVIDERS)
 * @returns {Object|null} The provider definition, or null if unknown
 */
function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

/**
 * Get the default model for a provider
 * @description Returns the model flagged `default: true` in the provider's
 * model groups, falling back to the first listed model.
 * @param {string} providerId - Provider id (a key of PROVIDERS)
 * @returns {string|null} Default model id, or null if the provider is unknown or has no models
 */
function getDefaultModel(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;

  for (const group of provider.modelGroups) {
    const defaultModel = group.models.find(m => m.default);
    if (defaultModel) return defaultModel.id;
  }

  // Fall back to first model
  if (provider.modelGroups.length > 0 && provider.modelGroups[0].models.length > 0) {
    return provider.modelGroups[0].models[0].id;
  }

  return null;
}

module.exports = {
  PROVIDERS,
  getAllProviders,
  getProvider,
  getDefaultModel,
  buildClineConfig,
  buildGlobalState,
};
