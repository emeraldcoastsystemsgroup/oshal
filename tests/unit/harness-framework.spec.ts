/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Harness framework unit tests — HarnessAdapter contract, HARNESS_FACTORIES registry, HarnessLLMBridge, per-bot override
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Retarget the retired legacy harness factory expectations to 'noop' (e308175); NoopProvider kept reporting the legacy provider name at that point
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | De-brand final pass: NoopProvider now reports 'noop' — mock adapter harnessType, provider-name expectations, and the fixed-result model label all track the retired-name removal
 */

/**
 * @description
 * Unit tests for the harness-as-bot framework:
 *  - HarnessAdapter interface contract
 *  - HarnessLLMBridge (adapts HarnessAdapter → LLMService)
 *  - HARNESS_FACTORIES registry lookup
 *  - CodexCliHarnessAdapter construction (no subprocess)
 *  - ClaudeCodeCliHarnessAdapter construction (no subprocess)
 *  - Per-bot harness override via resolveHarnessForAgent
 */

import { vi } from 'vitest';
import { HarnessLLMBridge } from '../../src/features/llm-provider/services/harness-adapter';
import type { HarnessAdapter, HarnessTask, HarnessResult, HarnessType } from '../../src/features/llm-provider/services/harness-adapter';
import { CodexCliHarnessAdapter } from '../../src/features/llm-provider/services/codex-cli-harness-adapter';
import { ClaudeCodeCliHarnessAdapter } from '../../src/features/llm-provider/services/claude-code-cli-harness-adapter';
import { HARNESS_FACTORIES } from '../../src/app/composition/provider-runtime';

// ── Shared mock adapter ────────────────────────────────────────────────────────

class MockHarnessAdapter implements HarnessAdapter {
  readonly harnessType: HarnessType = 'noop';
  readonly capturedTasks: HarnessTask[] = [];
  readonly result: HarnessResult;

  constructor(result: HarnessResult) {
    this.result = result;
  }

  async run(task: HarnessTask): Promise<HarnessResult> {
    this.capturedTasks.push(task);
    return this.result;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ── HarnessLLMBridge ──────────────────────────────────────────────────────────

describe('HarnessLLMBridge', () => {
  const fixedResult: HarnessResult = {
    text: 'Test output from harness',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    model: 'mock-model-v1',
    stopReason: 'end_turn',
  };

  it('translates sendRequest → HarnessTask → LLMResponse correctly', async () => {
    const adapter = new MockHarnessAdapter(fixedResult);
    const bridge = new HarnessLLMBridge(adapter);

    const response = await bridge.sendRequest({
      messages: [{ role: 'user', content: 'Hello harness' }],
      systemPrompt: 'You are a test agent',
      taskId: 'task-123',
      agentId: 'agent-456',
      model: 'mock-model-v1',
    });

    // LLMResponse fields
    expect(response.content).toHaveLength(1);
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'Test output from harness' });
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(20);
    expect(response.model).toBe('mock-model-v1');
    expect(response.stopReason).toBe('end_turn');

    // HarnessTask constructed from SendRequestOptions
    expect(adapter.capturedTasks).toHaveLength(1);
    const task = adapter.capturedTasks[0];
    expect(task.prompt).toBe('Hello harness');
    expect(task.systemPrompt).toBe('You are a test agent');
    expect(task.taskId).toBe('task-123');
    expect(task.agentId).toBe('agent-456');
    expect(task.model).toBe('mock-model-v1');
  });

  it('extracts prompt from last message when multiple messages present', async () => {
    const adapter = new MockHarnessAdapter(fixedResult);
    const bridge = new HarnessLLMBridge(adapter);

    await bridge.sendRequest({
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'First response' },
        { role: 'user', content: 'Latest message — this is the prompt' },
      ],
    });

    expect(adapter.capturedTasks[0].prompt).toBe('Latest message — this is the prompt');
  });

  it('returns harness:noop as provider name', () => {
    const bridge = new HarnessLLMBridge(new MockHarnessAdapter(fixedResult));
    expect(bridge.getProviderName()).toBe('harness:noop');
  });

  it('increments request count on each sendRequest', async () => {
    const bridge = new HarnessLLMBridge(new MockHarnessAdapter(fixedResult));
    await bridge.sendRequest({ messages: [{ role: 'user', content: 'a' }] });
    await bridge.sendRequest({ messages: [{ role: 'user', content: 'b' }] });
    expect(bridge.getRequestCount()).toBe(2);
  });
});

// ── HARNESS_FACTORIES registry ─────────────────────────────────────────────────

describe('HARNESS_FACTORIES registry', () => {
  it('contains entries for all expected harness types', () => {
    expect(HARNESS_FACTORIES).toHaveProperty('noop');
    expect(HARNESS_FACTORIES).toHaveProperty('cline');
    expect(HARNESS_FACTORIES).toHaveProperty('codex-cli');
    expect(HARNESS_FACTORIES).toHaveProperty('claude-code');
    expect(HARNESS_FACTORIES).toHaveProperty('gemini-cli');
  });

  it('noop factory creates the NoopProvider', () => {
    // NoopProvider reports 'noop' as its provider name (the legacy stub label was
    // fully retired in the de-brand final pass; telemetry/chat_tasks key on 'noop').
    const service = HARNESS_FACTORIES['noop']({});
    expect(service.getProviderName()).toBe('noop');
  });

  it('codex-cli factory creates harness:codex-cli service', () => {
    const service = HARNESS_FACTORIES['codex-cli']({});
    expect(service.getProviderName()).toBe('harness:codex-cli');
  });

  it('claude-code factory spawns the Claude Code CLI subprocess', () => {
    // claude-code spawns the Claude Code CLI via ClaudeCodeCliHarnessAdapter wrapped in
    // HarnessLLMBridge. It requires auth (ANTHROPIC_API_KEY or a ~/.claude OAuth session),
    // so provide a test key; the bridge reports the harness-prefixed provider name.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key';
    try {
      const service = HARNESS_FACTORIES['claude-code']({});
      expect(service.getProviderName()).toBe('harness:claude-code');
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});

// ── CodexCliHarnessAdapter construction ───────────────────────────────────────

describe('CodexCliHarnessAdapter', () => {
  it('initializes with default config', () => {
    const adapter = new CodexCliHarnessAdapter();
    expect(adapter.harnessType).toBe('codex-cli');
  });

  it('accepts explicit binary and model config', () => {
    const adapter = new CodexCliHarnessAdapter({
      binaryPath: '/usr/local/bin/codex',
      model: 'o3',
      approvalPolicy: 'full-auto',
    });
    expect(adapter.harnessType).toBe('codex-cli');
    // Verify construction doesn't throw
  });

  it('healthCheck returns false when binary not found', async () => {
    const adapter = new CodexCliHarnessAdapter({ binaryPath: '/nonexistent/codex-binary' });
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });
});

// ── ClaudeCodeCliHarnessAdapter construction ──────────────────────────────────

describe('ClaudeCodeCliHarnessAdapter', () => {
  it('initializes with default config', () => {
    const adapter = new ClaudeCodeCliHarnessAdapter();
    expect(adapter.harnessType).toBe('claude-code');
  });

  it('accepts explicit binary and model config', () => {
    const adapter = new ClaudeCodeCliHarnessAdapter({
      binaryPath: '/usr/local/bin/claude',
      model: 'claude-sonnet-4-6',
      outputFormat: 'text',
    });
    expect(adapter.harnessType).toBe('claude-code');
  });

  it('healthCheck returns false when binary not found', async () => {
    const adapter = new ClaudeCodeCliHarnessAdapter({ binaryPath: '/nonexistent/claude-binary' });
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });
});

// ── HarnessAdapter contract (interface compliance) ────────────────────────────

describe('HarnessAdapter interface compliance', () => {
  it('CodexCliHarnessAdapter implements HarnessAdapter', () => {
    const adapter: HarnessAdapter = new CodexCliHarnessAdapter();
    expect(typeof adapter.run).toBe('function');
    expect(typeof adapter.healthCheck).toBe('function');
    expect(adapter.harnessType).toBe('codex-cli');
  });

  it('ClaudeCodeCliHarnessAdapter implements HarnessAdapter', () => {
    const adapter: HarnessAdapter = new ClaudeCodeCliHarnessAdapter();
    expect(typeof adapter.run).toBe('function');
    expect(typeof adapter.healthCheck).toBe('function');
    expect(adapter.harnessType).toBe('claude-code');
  });

  it('MockHarnessAdapter satisfies HarnessAdapter contract', async () => {
    const result: HarnessResult = {
      text: 'echo output',
      usage: { inputTokens: 5, outputTokens: 5 },
      model: 'noop',
    };
    const adapter: HarnessAdapter = new MockHarnessAdapter(result);
    const task: HarnessTask = { prompt: 'test prompt', taskId: 'test-1' };
    const res = await adapter.run(task);
    expect(res.text).toBe('echo output');
    expect(res.usage.inputTokens).toBe(5);
  });
});
