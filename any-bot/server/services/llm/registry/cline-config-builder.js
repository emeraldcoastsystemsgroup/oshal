/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from LLMProviderRegistry.js (1000-line cap decomposition): buildClineConfig — per-provider ~/.cline/config.json content builder
 */

const { PROVIDERS } = require('./provider-definitions');

/**
 * Build the Cline CLI config.json content for a given provider/model/credentials
 * This is what gets written to ~/.cline/config.json
 * ⭐ PHASE_62: Expanded to all 22 providers
 * @description Maps a provider id + model id + credential overrides to the exact
 * JSON shape Cline CLI expects in ~/.cline/config.json. Credentials fall back to
 * process.env when not supplied.
 * @param {string} providerId - Provider id (a key of PROVIDERS)
 * @param {string} modelId - Model id to run
 * @param {Object} [credentials] - Credential overrides keyed by env-var name (falls back to process.env)
 * @returns {Object|null} Cline config.json content, or null for 'cline-cli' (keep existing config)
 * @throws {Error} If providerId is unknown or has no config builder
 */
function buildClineConfig(providerId, modelId, credentials = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const baseConfig = { autoApprove: true };

  switch (providerId) {
    case 'bedrock':
      return {
        ...baseConfig,
        provider: 'bedrock',
        model: modelId,
        region: credentials.AWS_REGION || process.env.AWS_REGION || 'us-gov-west-1',
        accessKeyId: credentials.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: credentials.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
      };

    case 'anthropic':
      return {
        ...baseConfig,
        provider: 'anthropic',
        model: modelId,
        apiKey: credentials.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
      };

    case 'openrouter':
      return {
        ...baseConfig,
        provider: 'openrouter',
        model: modelId,
        apiKey: credentials.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY,
        baseUrl: 'https://openrouter.ai/api/v1',
      };

    case 'openai':
      return {
        ...baseConfig,
        provider: 'openai',
        model: modelId,
        apiKey: credentials.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
      };

    case 'openai-native':
      return {
        ...baseConfig,
        provider: 'openai-native',
        model: modelId,
        apiKey: credentials.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
      };

    case 'ollama':
      return {
        ...baseConfig,
        provider: 'ollama',
        model: modelId,
        baseUrl: credentials.OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434',
      };

    case 'lmstudio':
      return {
        ...baseConfig,
        provider: 'lmstudio',
        model: modelId,
        baseUrl: credentials.LMSTUDIO_HOST || process.env.LMSTUDIO_HOST || 'http://localhost:1234',
      };

    case 'gemini':
      return {
        ...baseConfig,
        provider: 'gemini',
        model: modelId,
        apiKey: credentials.GEMINI_API_KEY || process.env.GEMINI_API_KEY,
      };

    case 'vertex':
      return {
        ...baseConfig,
        provider: 'vertex',
        model: modelId,
        projectId: credentials.VERTEX_PROJECT_ID || process.env.VERTEX_PROJECT_ID,
        region: credentials.VERTEX_REGION || process.env.VERTEX_REGION || 'us-central1',
      };

    case 'azure':
      return {
        ...baseConfig,
        provider: 'azure',
        model: modelId,
        apiKey: credentials.AZURE_API_KEY || process.env.AZURE_API_KEY,
        baseUrl: credentials.AZURE_ENDPOINT || process.env.AZURE_ENDPOINT,
        deploymentId: credentials.AZURE_DEPLOYMENT_ID || process.env.AZURE_DEPLOYMENT_ID || modelId,
        apiVersion: credentials.AZURE_API_VERSION || process.env.AZURE_API_VERSION || '2024-08-01-preview',
      };

    case 'mistral':
      return {
        ...baseConfig,
        provider: 'mistral',
        model: modelId,
        apiKey: credentials.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY,
      };

    case 'deepseek':
      return {
        ...baseConfig,
        provider: 'deepseek',
        model: modelId,
        apiKey: credentials.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY,
      };

    case 'xai':
      return {
        ...baseConfig,
        provider: 'xai',
        model: modelId,
        apiKey: credentials.XAI_API_KEY || process.env.XAI_API_KEY,
      };

    case 'groq':
      return {
        ...baseConfig,
        provider: 'groq',
        model: modelId,
        apiKey: credentials.GROQ_API_KEY || process.env.GROQ_API_KEY,
      };

    case 'together':
      return {
        ...baseConfig,
        provider: 'together',
        model: modelId,
        apiKey: credentials.TOGETHER_API_KEY || process.env.TOGETHER_API_KEY,
      };

    case 'fireworks':
      return {
        ...baseConfig,
        provider: 'fireworks',
        model: modelId,
        apiKey: credentials.FIREWORKS_API_KEY || process.env.FIREWORKS_API_KEY,
      };

    case 'cerebras':
      return {
        ...baseConfig,
        provider: 'cerebras',
        model: modelId,
        apiKey: credentials.CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY,
      };

    case 'sambanova':
      return {
        ...baseConfig,
        provider: 'sambanova',
        model: modelId,
        apiKey: credentials.SAMBANOVA_API_KEY || process.env.SAMBANOVA_API_KEY,
      };

    case 'nebius':
      return {
        ...baseConfig,
        provider: 'nebius',
        model: modelId,
        apiKey: credentials.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY,
      };

    case 'asksage':
      return {
        ...baseConfig,
        provider: 'asksage',
        model: modelId,
        apiKey: credentials.ASKSAGE_API_KEY || process.env.ASKSAGE_API_KEY,
      };

    case 'litellm':
      return {
        ...baseConfig,
        provider: 'litellm',
        model: modelId,
        baseUrl: credentials.LITELLM_BASE_URL || process.env.LITELLM_BASE_URL || 'http://localhost:4000',
      };

    case 'requesty':
      return {
        ...baseConfig,
        provider: 'requesty',
        model: modelId,
        apiKey: credentials.REQUESTY_API_KEY || process.env.REQUESTY_API_KEY,
      };

    case 'cline-cli':
      // Don't overwrite — use existing config
      return null;

    default:
      throw new Error(`No Cline config builder for provider: ${providerId}`);
  }
}

module.exports = {
  buildClineConfig,
};
