import { describe, expect, it, vi } from 'vitest';
import {
  LLMService,
  type LLMResponse,
  type SendRequestOptions,
} from '../../src/features/llm-provider/services/llm-service';
import {
  isProviderRuntimeStall,
  ProviderFailoverService,
} from '../../src/features/llm-provider/services/provider-failover-service';

class StubProvider extends LLMService {
  readonly sendRequestMock: ReturnType<typeof vi.fn>;

  constructor(providerName: string, impl: (options: SendRequestOptions) => Promise<LLMResponse>) {
    super(providerName, {});
    this.sendRequestMock = vi.fn(impl);
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    return this.sendRequestMock(options);
  }
}

const fallbackResponse: LLMResponse = {
  content: [{ type: 'text', text: 'fallback result' }],
  usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
  model: 'fallback-model',
  stopReason: 'end_turn',
};

describe('ProviderFailoverService', () => {
  it('retries through fallback on provider runtime stall errors', async () => {
    const primary = new StubProvider('harness:claude-code', async () => {
      throw new Error('Claude CLI stalled - no output for 180s');
    });
    const fallback = new StubProvider('harness:codex-cli', async () => fallbackResponse);
    const provider = new ProviderFailoverService({
      primary,
      fallback,
      reason: 'unit-test-stall',
      shouldFailover: isProviderRuntimeStall,
    });

    const response = await provider.sendRequest({
      messages: [{ role: 'user', content: 'fix the thing' }],
      taskId: 'ticket-1',
      agentId: 'agent-1',
    });

    expect(response).toBe(fallbackResponse);
    expect(primary.sendRequestMock).toHaveBeenCalledTimes(1);
    expect(fallback.sendRequestMock).toHaveBeenCalledTimes(1);
    expect(provider.getProviderName()).toBe('failover:harness:claude-code->harness:codex-cli');
  });

  it('retries through fallback on provider auth errors', async () => {
    const primary = new StubProvider('harness:claude-code', async () => {
      throw new Error('Invalid API key');
    });
    const fallback = new StubProvider('harness:codex-cli', async () => fallbackResponse);
    const provider = new ProviderFailoverService({
      primary,
      fallback,
      reason: 'unit-test-stall',
      shouldFailover: isProviderRuntimeStall,
    });

    await expect(provider.sendRequest({
      messages: [{ role: 'user', content: 'fix the thing' }],
    })).resolves.toBe(fallbackResponse);
    expect(primary.sendRequestMock).toHaveBeenCalledTimes(1);
    expect(fallback.sendRequestMock).toHaveBeenCalledTimes(1);
  });

  it('retries through fallback when primary returns provider failure text', async () => {
    const primary = new StubProvider('harness:codex-cli', async () => ({
      content: [{ type: 'text', text: 'Codex CLI error: failed to connect to websocket: HTTP error: 401 Unauthorized' }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: 'codex',
      stopReason: 'end_turn',
    }));
    const fallback = new StubProvider('harness:claude-code', async () => fallbackResponse);
    const provider = new ProviderFailoverService({
      primary,
      fallback,
      reason: 'unit-test-provider-text',
      shouldFailover: isProviderRuntimeStall,
    });

    await expect(provider.sendRequest({
      messages: [{ role: 'user', content: 'fix the thing' }],
    })).resolves.toBe(fallbackResponse);
    expect(primary.sendRequestMock).toHaveBeenCalledTimes(1);
    expect(fallback.sendRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry unrelated application errors', async () => {
    const primary = new StubProvider('harness:claude-code', async () => {
      throw new Error('Implemented the OAuth connector flow successfully');
    });
    const fallback = new StubProvider('harness:codex-cli', async () => fallbackResponse);
    const provider = new ProviderFailoverService({
      primary,
      fallback,
      reason: 'unit-test-stall',
      shouldFailover: isProviderRuntimeStall,
    });

    await expect(provider.sendRequest({
      messages: [{ role: 'user', content: 'fix the thing' }],
    })).rejects.toThrow('Implemented the OAuth connector flow successfully');
    expect(primary.sendRequestMock).toHaveBeenCalledTimes(1);
    expect(fallback.sendRequestMock).not.toHaveBeenCalled();
  });

  it('keeps both errors when fallback also fails', async () => {
    const primary = new StubProvider('harness:claude-code', async () => {
      throw new Error('Claude CLI stalled - no output for 180s');
    });
    const fallback = new StubProvider('harness:codex-cli', async () => {
      throw new Error('Codex CLI unavailable');
    });
    const provider = new ProviderFailoverService({
      primary,
      fallback,
      reason: 'unit-test-stall',
      shouldFailover: isProviderRuntimeStall,
    });

    await expect(provider.sendRequest({
      messages: [{ role: 'user', content: 'fix the thing' }],
    })).rejects.toThrow(/primaryError=.*Claude CLI stalled.*fallbackError=.*Codex CLI unavailable/);
  });
});
