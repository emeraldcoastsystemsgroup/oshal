/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from LLMProviderRegistry.js (1000-line cap decomposition): buildGlobalState — per-provider Cline CLI globalState.json content builder
 */

/**
 * Build the globalState.json content for a given provider/model
 * This controls what Cline CLI's internal state uses.
 * Key names sourced from _reference/cline-source/src/shared/storage/state-keys.ts
 * ⭐ PHASE_62: Expanded to all 22 providers
 * @description Maps a provider id + model id + credential overrides to Cline
 * CLI's internal globalState.json shape (auto-approval settings + per-provider
 * key names). Unknown providers get the auto-approval base only.
 * @param {string} providerId - Provider id (a key of PROVIDERS)
 * @param {string} modelId - Model id to run
 * @param {Object} [credentials] - Credential overrides keyed by env-var name (falls back to process.env)
 * @returns {Object} globalState.json content for Cline CLI
 */
function buildGlobalState(providerId, modelId, credentials = {}) {
  const base = {
    welcomeViewCompleted: true,
    mode: 'act',
    yoloModeToggled: true,
    autoApprovalSettings: {
      version: 3,
      enabled: true,
      favorites: [],
      maxRequests: 100,
      enableNotifications: false,
      actions: {
        readFiles: true, readFilesExternally: true,
        editFiles: true, editFilesExternally: true,
        executeSafeCommands: true, executeAllCommands: true,
        useBrowser: true, useMcp: true,
      },
    },
  };

  switch (providerId) {
    case 'bedrock':
      return {
        ...base,
        actModeApiProvider: 'bedrock',
        planModeApiProvider: 'bedrock',
        awsAuthentication: 'keys',
        awsAccessKey: credentials.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
        awsSecretKey: credentials.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
        awsRegion: credentials.AWS_REGION || process.env.AWS_REGION || 'us-gov-west-1',
        awsUseCrossRegionInference: false,
        awsBedrockEndpoint: `https://bedrock-runtime-fips.${credentials.AWS_REGION || process.env.AWS_REGION || 'us-gov-west-1'}.amazonaws.com`,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
        enablePromptCaching: true,
      };

    case 'anthropic':
      return {
        ...base,
        actModeApiProvider: 'anthropic',
        planModeApiProvider: 'anthropic',
        apiKey: credentials.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'openrouter':
      return {
        ...base,
        actModeApiProvider: 'openrouter',
        planModeApiProvider: 'openrouter',
        openRouterApiKey: credentials.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'openai':
      return {
        ...base,
        actModeApiProvider: 'openai',
        planModeApiProvider: 'openai',
        openAiApiKey: credentials.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'openai-native':
      return {
        ...base,
        actModeApiProvider: 'openai-native',
        planModeApiProvider: 'openai-native',
        openAiNativeApiKey: credentials.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'ollama':
      return {
        ...base,
        actModeApiProvider: 'ollama',
        planModeApiProvider: 'ollama',
        ollamaBaseUrl: credentials.OLLAMA_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434',
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'lmstudio':
      return {
        ...base,
        actModeApiProvider: 'lmstudio',
        planModeApiProvider: 'lmstudio',
        lmStudioBaseUrl: credentials.LMSTUDIO_HOST || process.env.LMSTUDIO_HOST || 'http://localhost:1234',
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'gemini':
      return {
        ...base,
        actModeApiProvider: 'gemini',
        planModeApiProvider: 'gemini',
        geminiApiKey: credentials.GEMINI_API_KEY || process.env.GEMINI_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'vertex':
      return {
        ...base,
        actModeApiProvider: 'vertex',
        planModeApiProvider: 'vertex',
        vertexProjectId: credentials.VERTEX_PROJECT_ID || process.env.VERTEX_PROJECT_ID,
        vertexRegion: credentials.VERTEX_REGION || process.env.VERTEX_REGION || 'us-central1',
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'azure':
      return {
        ...base,
        actModeApiProvider: 'azure',
        planModeApiProvider: 'azure',
        azureApiKey: credentials.AZURE_API_KEY || process.env.AZURE_API_KEY,
        openAiBaseUrl: credentials.AZURE_ENDPOINT || process.env.AZURE_ENDPOINT,
        openAiModelId: credentials.AZURE_DEPLOYMENT_ID || process.env.AZURE_DEPLOYMENT_ID || modelId,
        azureApiVersion: credentials.AZURE_API_VERSION || process.env.AZURE_API_VERSION || '2024-08-01-preview',
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'mistral':
      return {
        ...base,
        actModeApiProvider: 'mistral',
        planModeApiProvider: 'mistral',
        mistralApiKey: credentials.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'deepseek':
      return {
        ...base,
        actModeApiProvider: 'deepseek',
        planModeApiProvider: 'deepseek',
        deepSeekApiKey: credentials.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'xai':
      return {
        ...base,
        actModeApiProvider: 'xai',
        planModeApiProvider: 'xai',
        xaiApiKey: credentials.XAI_API_KEY || process.env.XAI_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'groq':
      return {
        ...base,
        actModeApiProvider: 'groq',
        planModeApiProvider: 'groq',
        groqApiKey: credentials.GROQ_API_KEY || process.env.GROQ_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'together':
      return {
        ...base,
        actModeApiProvider: 'together',
        planModeApiProvider: 'together',
        togetherApiKey: credentials.TOGETHER_API_KEY || process.env.TOGETHER_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'fireworks':
      return {
        ...base,
        actModeApiProvider: 'fireworks',
        planModeApiProvider: 'fireworks',
        fireworksApiKey: credentials.FIREWORKS_API_KEY || process.env.FIREWORKS_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'cerebras':
      return {
        ...base,
        actModeApiProvider: 'cerebras',
        planModeApiProvider: 'cerebras',
        cerebrasApiKey: credentials.CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'sambanova':
      return {
        ...base,
        actModeApiProvider: 'sambanova',
        planModeApiProvider: 'sambanova',
        sambaNovaApiKey: credentials.SAMBANOVA_API_KEY || process.env.SAMBANOVA_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'nebius':
      return {
        ...base,
        actModeApiProvider: 'nebius',
        planModeApiProvider: 'nebius',
        nebiusApiKey: credentials.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'asksage':
      return {
        ...base,
        actModeApiProvider: 'asksage',
        planModeApiProvider: 'asksage',
        asksageApiKey: credentials.ASKSAGE_API_KEY || process.env.ASKSAGE_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'litellm':
      return {
        ...base,
        actModeApiProvider: 'litellm',
        planModeApiProvider: 'litellm',
        liteLlmBaseUrl: credentials.LITELLM_BASE_URL || process.env.LITELLM_BASE_URL || 'http://localhost:4000',
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    case 'requesty':
      return {
        ...base,
        actModeApiProvider: 'requesty',
        planModeApiProvider: 'requesty',
        requestyApiKey: credentials.REQUESTY_API_KEY || process.env.REQUESTY_API_KEY,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };

    default:
      return base;
  }
}

module.exports = {
  buildGlobalState,
};
