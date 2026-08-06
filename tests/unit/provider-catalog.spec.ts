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
  test('buildClineConfig emits non-secret metadata with auto-approval off', () => {
    const config = buildClineConfig('bedrock', 'anthropic.claude-3-5-sonnet-v2:0');
    expect(config).not.toBeNull();
    expect(config.provider).toBe('bedrock');
    expect(config.model).toBe('anthropic.claude-3-5-sonnet-v2:0');
    expect(config.autoApprove).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/AKIA|secret|apiKey|accessKey|token/i);
  });

  test('buildClineConfig rejects the removed credential argument before inspecting it', () => {
    expect(() => buildClineConfig('anthropic', 'claude-sonnet-4-6', {}))
      .toThrow(/Credential-bearing Cline configuration is disabled/);
    expect(() => buildClineConfig('gemini', 'gemini-3.1-pro-preview', {
      GEMINI_API_KEY: 'sentinel-secret',
    })).toThrow(/Credential-bearing Cline configuration is disabled/);
  });

  test('buildClineConfig returns null for cline-cli (use existing config)', () => {
    expect(buildClineConfig('cline-cli', 'auto')).toBeNull();
  });

  test('buildClineConfig returns null for claude-code (uses own binary)', () => {
    expect(buildClineConfig('claude-code', 'sonnet')).toBeNull();
  });

});

describe('Cline GlobalState Builder', () => {
  test('buildClineGlobalState emits non-secret state with every autonomous approval off', () => {
    const state = buildClineGlobalState('bedrock', 'anthropic.claude-3-5-sonnet-v2:0');
    expect(state.actModeApiProvider).toBe('bedrock');
    expect(state.planModeApiProvider).toBe('bedrock');
    expect(state.actModeApiModelId).toBe('anthropic.claude-3-5-sonnet-v2:0');
    const approval = /** @type {any} */ (state.autoApprovalSettings);
    expect(approval.enabled).toBe(false);
    expect(Object.values(approval.actions)).toEqual(expect.arrayContaining([false]));
    expect(Object.values(approval.actions).every((value) => value === false)).toBe(true);
    expect(JSON.stringify(state)).not.toMatch(/AKIA|secret|apiKey|accessKey|token/i);
  });

  test('buildClineGlobalState rejects every legacy credential argument', () => {
    expect(() => buildClineGlobalState('azure', 'gpt-4o', {}))
      .toThrow(/Credential-bearing Cline global state is disabled/);
  });
});
