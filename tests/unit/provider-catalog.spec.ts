/**
 * Phase 0: Provider catalog and Cline config builder tests
 * Validates parity with any-bot LLMProviderRegistry.js
 */

import {
  PROVIDER_CATALOG,
  getAllProviders,
  getProvider,
  getDefaultModel,
  getClineProviderMapping,
  getProvidersForAgent,
} from '@/features/llm-provider/services/provider-catalog';

import {
  buildClineConfig,
  buildClineGlobalState,
} from '@/features/llm-provider/services/cline-config-builder';

describe('Provider Catalog', () => {
  test('contains all 23 providers (22 Cline + claude-code)', () => {
    const providers = getAllProviders();
    expect(providers.length).toBeGreaterThanOrEqual(23);
  });

  test('every provider has required fields', () => {
    for (const provider of getAllProviders()) {
      expect(provider.id).toBeTruthy();
      expect(provider.name).toBeTruthy();
      expect(provider.description).toBeTruthy();
      expect(Array.isArray(provider.requiresKeys)).toBe(true);
      expect(Array.isArray(provider.modelGroups)).toBe(true);
      expect(provider.modelGroups.length).toBeGreaterThan(0);
    }
  });

  test('every provider has at least one model', () => {
    for (const provider of getAllProviders()) {
      const totalModels = provider.modelGroups.reduce((sum, g) => sum + g.models.length, 0);
      expect(totalModels).toBeGreaterThan(0);
    }
  });

  test('every provider has exactly one default model', () => {
    for (const provider of getAllProviders()) {
      const defaults = provider.modelGroups
        .flatMap((g) => g.models)
        .filter((m) => m.default);
      expect(defaults.length).toBe(1);
    }
  });

  test('getProvider returns correct provider', () => {
    const bedrock = getProvider('bedrock');
    expect(bedrock).not.toBeNull();
    expect(bedrock.id).toBe('bedrock');
    expect(bedrock.clineProvider).toBe('bedrock');
  });

  test('getProvider returns null for unknown provider', () => {
    expect(getProvider('nonexistent')).toBeNull();
  });

  test('getDefaultModel returns default model for each provider', () => {
    for (const provider of getAllProviders()) {
      const defaultModel = getDefaultModel(provider.id);
      expect(defaultModel).toBeTruthy();
    }
  });

  test('getClineProviderMapping returns correct mapping', () => {
    expect(getClineProviderMapping('bedrock')).toBe('bedrock');
    expect(getClineProviderMapping('anthropic')).toBe('anthropic');
    expect(getClineProviderMapping('openai-codex')).toBe('openai-native');
    expect(getClineProviderMapping('claude-code')).toBeNull();
    expect(getClineProviderMapping('cline-cli')).toBeNull();
  });

  test('getProvidersForAgent returns correct constraints', () => {
    const claudeCodeProviders = getProvidersForAgent('claude-code');
    expect(claudeCodeProviders).toEqual(['anthropic']);

    const codexProviders = getProvidersForAgent('codex');
    expect(codexProviders).toContain('openai');
    expect(codexProviders).toContain('openai-native');
    expect(codexProviders).toContain('openai-codex');

    const clineProviders = getProvidersForAgent('cline');
    expect(clineProviders.length).toBeGreaterThan(15);
    expect(clineProviders).toContain('bedrock');
    expect(clineProviders).toContain('anthropic');
    expect(clineProviders).toContain('gemini');
  });
});

describe('Cline Config Builder', () => {
  test('buildClineConfig returns correct Bedrock config', () => {
    const config = buildClineConfig('bedrock', 'anthropic.claude-3-5-sonnet-v2:0', {
      AWS_ACCESS_KEY_ID: 'AKIA_TEST',
      AWS_SECRET_ACCESS_KEY: 'secret_test',
      AWS_REGION: 'us-gov-west-1',
    });
    expect(config).not.toBeNull();
    expect(config.provider).toBe('bedrock');
    expect(config.model).toBe('anthropic.claude-3-5-sonnet-v2:0');
    expect(config.accessKeyId).toBe('AKIA_TEST');
    expect(config.secretAccessKey).toBe('secret_test');
    expect(config.region).toBe('us-gov-west-1');
    expect(config.autoApprove).toBe(true);
  });

  test('buildClineConfig returns correct Anthropic config', () => {
    const config = buildClineConfig('anthropic', 'claude-sonnet-4-6', {
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('sk-ant-test');
  });

  test('buildClineConfig returns correct Azure config with deployment ID', () => {
    const config = buildClineConfig('azure', 'gpt-4o', {
      AZURE_API_KEY: 'azure-key',
      AZURE_ENDPOINT: 'https://myendpoint.openai.azure.com',
      AZURE_DEPLOYMENT_ID: 'my-deployment',
      AZURE_API_VERSION: '2024-08-01-preview',
    });
    expect(config.provider).toBe('azure');
    expect(config.apiKey).toBe('azure-key');
    expect(config.baseUrl).toBe('https://myendpoint.openai.azure.com');
    expect(config.deploymentId).toBe('my-deployment');
    expect(config.apiVersion).toBe('2024-08-01-preview');
  });

  test('buildClineConfig returns correct Gemini config', () => {
    const config = buildClineConfig('gemini', 'gemini-3.1-pro-preview', {
      GEMINI_API_KEY: 'gemini-key',
    });
    expect(config.provider).toBe('gemini');
    expect(config.apiKey).toBe('gemini-key');
  });

  test('buildClineConfig returns correct OpenAI Native config for openai-codex', () => {
    const config = buildClineConfig('openai-codex', 'gpt-5.3-codex', {
      OPENAI_API_KEY: 'openai-key',
    });
    expect(config.provider).toBe('openai-native');
    expect(config.apiKey).toBe('openai-key');
  });

  test('buildClineConfig returns null for cline-cli (use existing config)', () => {
    expect(buildClineConfig('cline-cli', 'auto')).toBeNull();
  });

  test('buildClineConfig returns null for claude-code (uses own binary)', () => {
    expect(buildClineConfig('claude-code', 'sonnet')).toBeNull();
  });

  test('buildClineConfig handles Ollama with custom host', () => {
    const config = buildClineConfig('ollama', 'llama3.1:70b', {
      OLLAMA_HOST: 'http://gpu-server:11434',
    });
    expect(config.provider).toBe('ollama');
    expect(config.baseUrl).toBe('http://gpu-server:11434');
  });
});

describe('Cline GlobalState Builder', () => {
  test('buildClineGlobalState returns correct Bedrock state with AWS-specific keys', () => {
    const state = buildClineGlobalState('bedrock', 'anthropic.claude-3-5-sonnet-v2:0', {
      AWS_ACCESS_KEY_ID: 'AKIA_TEST',
      AWS_SECRET_ACCESS_KEY: 'secret_test',
      AWS_REGION: 'us-gov-west-1',
    });
    expect(state.actModeApiProvider).toBe('bedrock');
    expect(state.planModeApiProvider).toBe('bedrock');
    expect(state.awsAuthentication).toBe('keys');
    expect(state.awsAccessKey).toBe('AKIA_TEST');
    expect(state.awsSecretKey).toBe('secret_test');
    expect(state.awsRegion).toBe('us-gov-west-1');
    expect(state.enablePromptCaching).toBe(true);
    expect(state.actModeApiModelId).toBe('anthropic.claude-3-5-sonnet-v2:0');
  });

  test('buildClineGlobalState uses provider-specific API key names', () => {
    // Each provider has a different key name in Cline's globalState
    const anthropicState = buildClineGlobalState('anthropic', 'claude-sonnet-4-6', {
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(anthropicState.apiKey).toBe('sk-ant-test');

    const openrouterState = buildClineGlobalState('openrouter', 'anthropic/claude-3.5-sonnet', {
      OPENROUTER_API_KEY: 'or-key',
    });
    expect(openrouterState.openRouterApiKey).toBe('or-key');

    const openaiNativeState = buildClineGlobalState('openai-native', 'gpt-5.2', {
      OPENAI_API_KEY: 'oai-key',
    });
    expect(openaiNativeState.openAiNativeApiKey).toBe('oai-key');

    const geminiState = buildClineGlobalState('gemini', 'gemini-3.1-pro-preview', {
      GEMINI_API_KEY: 'gem-key',
    });
    expect(geminiState.geminiApiKey).toBe('gem-key');

    const groqState = buildClineGlobalState('groq', 'llama-3.3-70b-versatile', {
      GROQ_API_KEY: 'groq-key',
    });
    expect(groqState.groqApiKey).toBe('groq-key');
  });

  test('buildClineGlobalState includes autoApprovalSettings with all tool permissions', () => {
    const state = buildClineGlobalState('anthropic', 'claude-sonnet-4-6');
    const approval = /** @type {any} */ (state.autoApprovalSettings);
    expect(approval.enabled).toBe(true);
    const actions = approval.actions;
    expect(actions.readFiles).toBe(true);
    expect(actions.editFiles).toBe(true);
    expect(actions.executeAllCommands).toBe(true);
    expect(actions.useMcp).toBe(true);
  });

  test('buildClineGlobalState sets correct Vertex-specific keys', () => {
    const state = buildClineGlobalState('vertex', 'gemini-3-pro-preview', {
      VERTEX_PROJECT_ID: 'my-project',
      VERTEX_REGION: 'europe-west1',
    });
    expect(state.vertexProjectId).toBe('my-project');
    expect(state.vertexRegion).toBe('europe-west1');
  });

  test('buildClineGlobalState sets correct Azure-specific keys', () => {
    const state = buildClineGlobalState('azure', 'gpt-4o', {
      AZURE_API_KEY: 'az-key',
      AZURE_ENDPOINT: 'https://myendpoint.openai.azure.com',
      AZURE_DEPLOYMENT_ID: 'my-deploy',
    });
    expect(state.azureApiKey).toBe('az-key');
    expect(state.openAiBaseUrl).toBe('https://myendpoint.openai.azure.com');
    expect(state.openAiModelId).toBe('my-deploy');
  });
});
