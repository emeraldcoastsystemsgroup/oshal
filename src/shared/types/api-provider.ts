/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted API provider types from config-manager.ts to shared types layer
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Corrected Change Log author and timestamp to comply with .clinerules/attribution.md
 */

import { z } from 'zod';

/**
 * @description Zod schema for supported API providers.
 * Mirrors the original ApiProvider type from config-manager.ts.
 */
export const ApiProviderSchema = z.enum([
  'anthropic',
  'claude-code',
  'openrouter',
  'bedrock',
  'vertex',
  'openai',
  'ollama',
  'lmstudio',
  'gemini',
  'openai-native',
  'openai-codex',
  'requesty',
  'together',
  'deepseek',
  'qwen',
  'qwen-code',
  'doubao',
  'mistral',
  'vscode-lm',
  'cline',
  'litellm',
  'moonshot',
  'nebius',
  'fireworks',
  'asksage',
  'xai',
  'sambanova',
  'cerebras',
  'groq',
  'huggingface',
  'huawei-cloud-maas',
  'dify',
  'baseten',
  'vercel-ai-gateway',
  'zai',
  'oca',
  'aihubmix',
  'minimax',
  'hicap',
  'nousResearch',
]);

/**
 * @description Supported API provider identifiers.
 */
export type ApiProvider = z.infer<typeof ApiProviderSchema>;

/**
 * @description Zod schema for configuration modes.
 */
export const ModeSchema = z.enum(['plan', 'act']);

/**
 * @description Supported configuration modes.
 */
export type Mode = z.infer<typeof ModeSchema>;

/**
 * @description Zod schema for API configuration (secrets + settings).
 * Validates the full configuration object for a single API provider setup.
 */
export const ApiConfigurationSchema = z.object({
  // Secrets (API Keys)
  anthropicApiKey: z.string().optional(),
  openRouterApiKey: z.string().optional(),
  bedrockAccessKey: z.string().optional(),
  bedrockSecretKey: z.string().optional(),
  vertexProjectId: z.string().optional(),
  vertexRegion: z.string().optional(),
  openAiApiKey: z.string().optional(),
  ollamaApiUrl: z.string().url().optional(),
  lmStudioApiUrl: z.string().url().optional(),
  geminiApiKey: z.string().optional(),
  openAiNativeApiKey: z.string().optional(),
  azureApiVersion: z.string().optional(),
  deepSeekApiKey: z.string().optional(),
  mistralApiKey: z.string().optional(),
  clineApiKey: z.string().optional(),
  clineAccountId: z.string().optional(),

  // Plan Mode Settings
  planModeApiProvider: ApiProviderSchema.optional(),
  planModeApiModelId: z.string().optional(),
  planModeOpenRouterModelId: z.string().optional(),
  planModeOpenAiModelId: z.string().optional(),
  planModeOllamaModelId: z.string().optional(),
  planModeBedrockModelId: z.string().optional(),
  planModeVertexModelId: z.string().optional(),

  // Act Mode Settings
  actModeApiProvider: ApiProviderSchema.optional(),
  actModeApiModelId: z.string().optional(),
  actModeOpenRouterModelId: z.string().optional(),
  actModeOpenAiModelId: z.string().optional(),
  actModeOllamaModelId: z.string().optional(),
  actModeBedrockModelId: z.string().optional(),
  actModeVertexModelId: z.string().optional(),

  // Other settings
  mode: ModeSchema.optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

/**
 * @description Full API configuration interface (secrets + settings).
 */
export type ApiConfiguration = z.infer<typeof ApiConfigurationSchema>;