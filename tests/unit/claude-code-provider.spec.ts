/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for agent-profile runtime selection overrides
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial unit tests for ClineHarnessProvider (CLI agent wrapper)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Operator directive 2026-08-13 — nothing hardcoded: the provider-name assertion pinned the literal 'claude-code'. Replaced knowingly with the two real cases: the adapter names ITSELF (cline-cli) when no backing provider is configured, and reports the CONFIGURED provider when one is declared.
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

  it('names itself when the config declares no backing provider', () => {
    // Was: expected the literal 'claude-code'. Changed knowingly (operator directive
    // 2026-08-13) — this adapter IS the Cline harness and has no opinion about a vendor. The
    // old literal is why the api logged `provider: claude-code` on a fleet running codex.
    const priorForce = process.env.FORCE_LLM_PROVIDER;
    const priorLlm = process.env.LLM_PROVIDER;
    delete process.env.FORCE_LLM_PROVIDER;
    delete process.env.LLM_PROVIDER;
    try {
      expect(new ClineHarnessProvider(mockConfig).getProviderName()).toBe('cline-cli');
    } finally {
      if (priorForce === undefined) delete process.env.FORCE_LLM_PROVIDER;
      else process.env.FORCE_LLM_PROVIDER = priorForce;
      if (priorLlm === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = priorLlm;
    }
  });

  it('reports the CONFIGURED backing provider when one is declared', () => {
    const configured = new ClineHarnessProvider({ ...mockConfig, configuredProvider: 'openai-codex' });
    expect(configured.getProviderName()).toBe('openai-codex');
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
