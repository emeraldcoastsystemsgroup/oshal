/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 0: Ported buildClineConfig + buildClineGlobalState from any-bot LLMProviderRegistry.js — per-provider credential mapping for all 22 providers
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'cline-config-builder' });

/**
 * @description Credential bag passed from the cockpit config save or node assignment.
 * Keys are environment variable names or provider-specific config field names.
 */
export type CredentialBag = Record<string, string | undefined>;

/**
 * @description Builds the Cline CLI config.json content for a given provider/model/credentials.
 * This is what gets written to ~/.cline/config.json.
 *
 * Ported from any-bot LLMProviderRegistry.js buildClineConfig() — PHASE_62.
 * Each provider has unique credential field names that Cline CLI expects.
 *
 * @param providerId - Provider identifier from the catalog
 * @param modelId - Selected model identifier
 * @param credentials - Provider-specific credentials (from env, secrets, or assignment payload)
 * @returns Cline config.json payload, or null for providers that don't use config.json (e.g. cline-cli)
 */
export function buildClineConfig(
  providerId: string,
  modelId: string,
  credentials: CredentialBag = {},
): Record<string, unknown> | null {
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
    case 'openai-codex':
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

    case 'claude-code':
      // Not a Cline provider — uses claude binary directly
      return null;

    default:
      logger.warn({ providerId }, 'No Cline config builder for provider — using generic');
      return {
        ...baseConfig,
        provider: providerId,
        model: modelId,
      };
  }
}

/**
 * @description Builds the Cline CLI globalState.json content for a given provider/model.
 * This controls Cline CLI's internal state, including provider-specific credential key names.
 *
 * Key names sourced from Cline CLI source: src/shared/storage/state-keys.ts
 * Ported from any-bot LLMProviderRegistry.js buildGlobalState() — PHASE_62.
 *
 * @param providerId - Provider identifier from the catalog
 * @param modelId - Selected model identifier
 * @param credentials - Provider-specific credentials
 * @returns Cline globalState.json payload
 */
export function buildClineGlobalState(
  providerId: string,
  modelId: string,
  credentials: CredentialBag = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
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
        readFiles: true,
        readFilesExternally: true,
        editFiles: true,
        editFilesExternally: true,
        executeSafeCommands: true,
        executeAllCommands: true,
        useBrowser: true,
        useMcp: true,
      },
    },
  };

  // Provider-specific state keys — each provider uses different key names in Cline's globalState
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
    case 'openai-codex':
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
      return {
        ...base,
        actModeApiProvider: providerId,
        planModeApiProvider: providerId,
        actModeApiModelId: modelId,
        planModeApiModelId: modelId,
      };
  }
}
