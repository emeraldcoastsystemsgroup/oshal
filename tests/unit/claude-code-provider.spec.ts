/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for agent-profile runtime selection overrides
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial unit tests for ClineHarnessProvider (CLI agent wrapper)
 */

/**
 * @description
 * Unit tests for ClineHarnessProvider. Mocks CLI process and validates sendRequest, error handling, and cost calculation.
 */

import { vi } from 'vitest';
import { ClineHarnessProvider } from '../../src/features/llm-provider/services/claude-code-provider';
import type { ClineHarnessProviderConfig } from '../../src/shared/types/llm-provider';

describe('ClineHarnessProvider', () => {
  const mockConfig: ClineHarnessProviderConfig = {
    apiKey: 'test-key',
    model: 'claude-3-haiku-20240307',
    baseUrl: 'mock-cli',
  };

  let provider: ClineHarnessProvider;

  beforeEach(() => {
    provider = new ClineHarnessProvider(mockConfig);
  });

  it('should initialize with correct config', () => {
    expect(provider.getProviderName()).toBe('claude-code');
  });

  it('should calculate cost as zero', () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    const cost = provider.calculateCost(usage);
    expect(cost.totalCost).toBe(0);
    expect(cost.currency).toBe('USD');
  });

  it('should prefer saved agent runtime selection over persisted shared config', async () => {
    provider = new ClineHarnessProvider(mockConfig, {
      resolveAgentRuntimeSelection: async () => ({
        providerId: 'openai-codex',
        modelId: 'gpt-5.4',
      }),
    });

    (provider as any).runtimeSyncService = {
      readRuntimeSelection: vi.fn(() => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        mode: 'act',
      })),
    };

    const selection = await (provider as any).resolveRuntimeSelection({
      messages: [{ role: 'user', content: 'test' }],
      agentId: 'a0000000-0000-0000-0000-000000000001',
    });

    expect(selection).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.4',
      mode: 'act',
    });
  });

  it('should handle CLI spawn error', async () => {
    await expect(
      provider.sendRequest({
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 10,
      })
    ).rejects.toThrow();
  });

  // Additional tests for CLI output parsing and error handling can be added here
});
