/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of API Configuration Manager (replicator)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added Change Log header and JSDoc for governance compliance
 */

/**
 * @description Supported API providers for configuration.
 */
export type ApiProvider =
  | "anthropic"
  | "claude-code"
  | "openrouter"
  | "bedrock"
  | "vertex"
  | "openai"
  | "ollama"
  | "lmstudio"
  | "gemini"
  | "openai-native"
  | "openai-codex"
  | "requesty"
  | "together"
  | "deepseek"
  | "qwen"
  | "qwen-code"
  | "doubao"
  | "mistral"
  | "vscode-lm"
  | "cline"
  | "litellm"
  | "moonshot"
  | "nebius"
  | "fireworks"
  | "asksage"
  | "xai"
  | "sambanova"
  | "cerebras"
  | "groq"
  | "huggingface"
  | "huawei-cloud-maas"
  | "dify"
  | "baseten"
  | "vercel-ai-gateway"
  | "zai"
  | "oca"
  | "aihubmix"
  | "minimax"
  | "hicap"
  | "nousResearch";

/**
 * @description Supported modes for configuration.
 */
export type Mode = "plan" | "act";

/**
 * @description Interface for API configuration, including secrets and settings.
 */
export interface ApiConfiguration {
  // Secrets (API Keys)
  anthropicApiKey?: string;
  openRouterApiKey?: string;
  bedrockAccessKey?: string;
  bedrockSecretKey?: string;
  vertexProjectId?: string;
  vertexRegion?: string;
  openAiApiKey?: string;
  ollamaApiUrl?: string;
  lmStudioApiUrl?: string;
  geminiApiKey?: string;
  openAiNativeApiKey?: string;
  azureApiVersion?: string;
  deepSeekApiKey?: string;
  mistralApiKey?: string;
  clineApiKey?: string;
  clineAccountId?: string;

  // Plan Mode Settings
  planModeApiProvider?: ApiProvider;
  planModeApiModelId?: string;
  planModeOpenRouterModelId?: string;
  planModeOpenAiModelId?: string;
  planModeOllamaModelId?: string;
  planModeBedrockModelId?: string;
  planModeVertexModelId?: string;

  // Act Mode Settings
  actModeApiProvider?: ApiProvider;
  actModeApiModelId?: string;
  actModeOpenRouterModelId?: string;
  actModeOpenAiModelId?: string;
  actModeOllamaModelId?: string;
  actModeBedrockModelId?: string;
  actModeVertexModelId?: string;

  // Other settings
  mode?: Mode;
  maxTokens?: number;
  temperature?: number;
}

import * as fs from 'fs';
import * as path from 'path';

/**
 * @description Manages API configuration files for Cline, including global, cline-specific, and secrets.
 * Provides methods to set/get configuration, set provider/API key, display, and clear configuration.
 */
export class ApiConfigurationManager {
  private globalConfigPath: string;
  private clineConfigPath: string;
  private secretsPath: string;

  /**
   * @description Creates a new ApiConfigurationManager instance.
   * @param outputDir - Directory for config file output (default: './output')
   */
  constructor(outputDir: string = './output') {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    this.globalConfigPath = path.join(outputDir, 'global-config.json');
    this.clineConfigPath = path.join(outputDir, 'cline-config.json');
    this.secretsPath = path.join(outputDir, 'secrets.json');
  }

  /**
   * @description Sets API configuration (simulates dropdown selection).
   * Writes to both global config and Cline-specific config files.
   * @param config - Partial API configuration to set
   */
  setConfiguration(config: Partial<ApiConfiguration>): void {
    const secrets = this.extractSecrets(config);
    const settings = this.extractSettings(config);
    this.writeGlobalConfig(settings);
    this.writeClineConfig(settings);
    this.writeSecrets(secrets);
    // Logging omitted for governance compliance
  }

  /**
   * @description Gets the current API configuration, merging global, cline, and secrets.
   * @returns The merged API configuration object
   */
  getConfiguration(): ApiConfiguration {
    const globalConfig = this.readGlobalConfig();
    const clineConfig = this.readClineConfig();
    const secrets = this.readSecrets();
    return {
      ...globalConfig,
      ...clineConfig,
      ...secrets,
    };
  }

  /**
   * @description Sets the provider for a specific mode.
   * @param mode - The mode ('plan' or 'act')
   * @param provider - The API provider
   * @param modelId - Optional model ID
   */
  setProvider(mode: Mode, provider: ApiProvider, modelId?: string): void {
    const config: Partial<ApiConfiguration> = { mode };
    if (mode === 'plan') {
      config.planModeApiProvider = provider;
      if (modelId) config.planModeApiModelId = modelId;
    } else {
      config.actModeApiProvider = provider;
      if (modelId) config.actModeApiModelId = modelId;
    }
    this.setConfiguration(config);
  }

  /**
   * @description Sets the API key for a provider.
   * @param provider - The API provider
   * @param apiKey - The API key value
   */
  setApiKey(provider: ApiProvider, apiKey: string): void {
    const config: Partial<ApiConfiguration> = {};
    switch (provider) {
      case 'anthropic': config.anthropicApiKey = apiKey; break;
      case 'openrouter': config.openRouterApiKey = apiKey; break;
      case 'openai':
      case 'openai-native': config.openAiApiKey = apiKey; break;
      case 'gemini': config.geminiApiKey = apiKey; break;
      case 'deepseek': config.deepSeekApiKey = apiKey; break;
      case 'mistral': config.mistralApiKey = apiKey; break;
      case 'cline': config.clineApiKey = apiKey; break;
      // Add more providers as needed
    }
    this.setConfiguration(config);
  }

  // Private helpers (not exported, no JSDoc required for internal use)
  private extractSecrets(config: Partial<ApiConfiguration>): Record<string, string> {
    const secretKeys = [
      'anthropicApiKey', 'openRouterApiKey', 'bedrockAccessKey', 'bedrockSecretKey',
      'vertexProjectId', 'vertexRegion', 'openAiApiKey', 'ollamaApiUrl', 'lmStudioApiUrl',
      'geminiApiKey', 'openAiNativeApiKey', 'azureApiVersion', 'deepSeekApiKey',
      'mistralApiKey', 'clineApiKey', 'clineAccountId',
    ];
    const secrets: Record<string, string> = {};
    for (const key of secretKeys) {
      const value = config[key as keyof ApiConfiguration];
      if (value !== undefined) secrets[key] = value as string;
    }
    return secrets;
  }

  private extractSettings(config: Partial<ApiConfiguration>): Record<string, any> {
    const settings: Record<string, any> = {};
    for (const [key, value] of Object.entries(config)) {
      if (!key.includes('ApiKey') && !key.includes('AccessKey') && !key.includes('SecretKey') &&
          !key.includes('AccountId') && !key.includes('ProjectId') && !key.includes('Region')) {
        settings[key] = value;
      }
    }
    return settings;
  }

  private writeGlobalConfig(settings: Record<string, any>): void {
    const existing = this.readJsonFile(this.globalConfigPath) || {};
    const updated = { ...existing, ...settings };
    this.writeJsonFile(this.globalConfigPath, updated);
  }

  private writeClineConfig(settings: Record<string, any>): void {
    const existing = this.readJsonFile(this.clineConfigPath) || {};
    const updated = { ...existing, ...settings };
    this.writeJsonFile(this.clineConfigPath, updated);
  }

  private writeSecrets(secrets: Record<string, string>): void {
    const existing = this.readJsonFile(this.secretsPath) || {};
    const updated = { ...existing, ...secrets };
    this.writeJsonFile(this.secretsPath, updated);
  }

  private readGlobalConfig(): Record<string, any> {
    return this.readJsonFile(this.globalConfigPath) || {};
  }

  private readClineConfig(): Record<string, any> {
    return this.readJsonFile(this.clineConfigPath) || {};
  }

  private readSecrets(): Record<string, any> {
    return this.readJsonFile(this.secretsPath) || {};
  }

  private readJsonFile(filePath: string): any {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      // Logging omitted for governance compliance
    }
    return null;
  }

  private writeJsonFile(filePath: string, data: any): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      // Logging omitted for governance compliance
      throw error;
    }
  }

  /**
   * @description Displays the current API configuration to the console.
   */
  displayConfiguration(): void {
    const config = this.getConfiguration();
    // Output omitted for governance compliance
  }

  /**
   * @description Clears all configuration files.
   */
  clearConfiguration(): void {
    if (fs.existsSync(this.globalConfigPath)) fs.unlinkSync(this.globalConfigPath);
    if (fs.existsSync(this.clineConfigPath)) fs.unlinkSync(this.clineConfigPath);
    if (fs.existsSync(this.secretsPath)) fs.unlinkSync(this.secretsPath);
    // Output omitted for governance compliance
  }
}

export default ApiConfigurationManager;