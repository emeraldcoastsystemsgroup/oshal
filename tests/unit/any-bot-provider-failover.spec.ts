import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isProviderRecoverableRuntimeFailure,
  isProviderRuntimeBanner,
  isProviderRuntimeStall,
  ProviderFailoverProvider,
} = require('../../any-bot/server/services/llm/ProviderFailoverProvider');
const ClaudeCodeProvider = require('../../any-bot/server/services/llm/ClaudeCodeProvider');
const ClaudeCodeCLIWrapper = require('../../any-bot/server/services/codebase/ClaudeCodeCLIWrapper');
const CodexProvider = require('../../any-bot/server/services/llm/CodexProvider');
const AgenticController = require('../../any-bot/server/controllers/AgenticController');
const TaskController = require('../../any-bot/server/controllers/TaskController');

describe('any-bot ProviderFailoverProvider', () => {
  it('falls back when the primary returns the Claude stall banner as content', async () => {
    const primary = {
      generateResponse: vi.fn(async () => ({
        content: 'Claude Code CLI encountered an error: Claude CLI stalled - no output for 180s.',
        provider: 'claude-code',
      })),
    };
    const fallback = {
      generateResponse: vi.fn(async () => ({
        content: 'codex completed the task',
        usage: { totalTokens: 12 },
        provider: 'openai-codex',
      })),
    };
    const provider = new ProviderFailoverProvider({
      primary,
      fallback,
      primaryName: 'claude-code',
      fallbackName: 'openai-codex',
      reason: 'provider_runtime_stall',
    });

    const response = await provider.generateResponse([{ role: 'user', content: 'do work' }], { source: 'test' });

    expect(response.content).toBe('codex completed the task');
    expect(response.providerFailover).toMatchObject({
      reason: 'provider_runtime_stall',
      primary: 'claude-code',
      fallback: 'openai-codex',
    });
    expect(primary.generateResponse).toHaveBeenCalledTimes(1);
    expect(fallback.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for non-stall responses', async () => {
    const primaryResponse = { content: 'normal response', provider: 'claude-code' };
    const primary = { generateResponse: vi.fn(async () => primaryResponse) };
    const fallback = { generateResponse: vi.fn(async () => ({ content: 'fallback' })) };
    const provider = new ProviderFailoverProvider({
      primary,
      fallback,
      primaryName: 'claude-code',
      fallbackName: 'openai-codex',
    });

    await expect(provider.generateResponse([{ role: 'user', content: 'do work' }])).resolves.toBe(primaryResponse);
    expect(fallback.generateResponse).not.toHaveBeenCalled();
  });

  it('falls back when the primary returns Codex auth failure text as content', async () => {
    const primary = {
      generateResponse: vi.fn(async () => ({
        content: 'Codex CLI error: failed to connect to websocket: HTTP error: 401 Unauthorized',
        provider: 'openai-codex',
      })),
    };
    const fallback = {
      generateResponse: vi.fn(async () => ({
        content: 'fallback completed the task',
        provider: 'claude-code',
        model: 'claude-sonnet-4-6',
      })),
    };
    const provider = new ProviderFailoverProvider({
      primary,
      fallback,
      primaryName: 'openai-codex',
      fallbackName: 'claude-code',
      reason: 'provider_runtime_error',
    });

    const response = await provider.generateResponse([{ role: 'user', content: 'do work' }]);

    expect(response.content).toBe('fallback completed the task');
    expect(response.provider).toBe('claude-code');
    expect(response.model).toBe('claude-sonnet-4-6');
    expect(fallback.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('carries the actual fallback provider/model through the agentic result', async () => {
    const primary = {
      generateResponse: vi.fn(async () => {
        throw new Error('Codex CLI error: You have 0 weighted tokens left');
      }),
    };
    const fallback = {
      generateResponse: vi.fn(async () => ({
        content: 'Completed by Claude.',
        contentBlocks: [{ type: 'text', text: 'Completed by Claude.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        cost: 0.01,
        provider: 'claude-code',
        model: 'claude-sonnet-4-6',
        claudeCodeMetadata: { numTurns: 1 },
      })),
    };
    const failover = new ProviderFailoverProvider({
      primary,
      fallback,
      primaryName: 'openai-codex',
      fallbackName: 'claude-code',
      reason: 'provider_runtime_failure',
    });
    const taskController = {
      getTask: vi.fn(async () => ({
        id: 'accountability-task',
        ticketId: 'ticket-1',
        workspace_dir: os.tmpdir(),
      })),
      addMessage: vi.fn(async () => undefined),
      updateMetrics: vi.fn(async () => undefined),
    };
    const controller = new AgenticController({
      codexProvider: failover,
      getCurrentProvider: () => 'openai-codex',
    }, {
      getAll: () => [],
      has: () => false,
    }, {
      broadcast: vi.fn(),
    }, taskController);

    const result = await controller.processAgenticTask(
      'accountability-task',
      'Do the work.',
      [],
      {},
      { source: 'swarm-dispatch' },
    );

    expect(result).toMatchObject({
      success: true,
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
    expect(primary.generateResponse).toHaveBeenCalledTimes(1);
    expect(fallback.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('preserves the final agentic provider/model in the processMessage result', async () => {
    const task = { id: 'task-controller-accountability', messages: [], apiMetrics: {} };
    const controller = Object.create(TaskController.prototype);
    controller.getTask = vi.fn(async () => task);
    controller.updateTask = vi.fn(async () => task);
    controller.messageStore = { saveMessage: vi.fn(async () => undefined) };
    controller.agenticController = {
      getCurrentProvider: () => 'openai-codex',
      processAgenticTask: vi.fn(async () => ({
        success: true,
        result: { success: true, result: 'Completed by Claude.' },
        turns: 1,
        apiMetrics: { totalTokens: 5, totalCost: 0.01 },
        provider: 'claude-code',
        model: 'claude-sonnet-4-6',
      })),
    };

    const result = await controller.processMessage(
      'task-controller-accountability',
      { text: 'Do the work.' },
      { agenticMode: true, source: 'swarm-dispatch' },
    );

    expect(result).toMatchObject({
      success: true,
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
  });

  it('classifies inactivity, auth, and throttle errors as provider runtime failures', () => {
    expect(isProviderRuntimeStall(new Error('INACTIVITY CIRCUIT BREAKER - no output for 180s'))).toBe(true);
    expect(isProviderRuntimeStall(new Error('Invalid API key'))).toBe(false);
    expect(isProviderRecoverableRuntimeFailure(new Error('Invalid API key'))).toBe(true);
    expect(isProviderRecoverableRuntimeFailure(new Error('Codex CLI error: 401 Unauthorized'))).toBe(true);
    expect(isProviderRecoverableRuntimeFailure(new Error('429 too many requests'))).toBe(true);
    expect(isProviderRecoverableRuntimeFailure(new Error('Implemented the OAuth connector flow successfully'))).toBe(false);
    expect(isProviderRecoverableRuntimeFailure(new Error('business rule rejected the request'))).toBe(false);
  });

  it('does NOT fall back when a successful primary answer merely mentions throttle/auth keywords', async () => {
    // Regression: a valid answer explaining a 429/quota/401 must be returned as-is,
    // not misclassified as a provider failure and needlessly failed over.
    const primaryResponse = {
      content:
        'Root cause: the API returned HTTP 429 because the request rate exceeded the account quota; '
        + 'the 401 Unauthorized was a stale OAuth token.',
      provider: 'claude-code',
    };
    const primary = { generateResponse: vi.fn(async () => primaryResponse) };
    const fallback = { generateResponse: vi.fn(async () => ({ content: 'fallback' })) };
    const provider = new ProviderFailoverProvider({
      primary,
      fallback,
      primaryName: 'claude-code',
      fallbackName: 'openai-codex',
    });

    await expect(
      provider.generateResponse([{ role: 'user', content: 'explain the incident' }]),
    ).resolves.toBe(primaryResponse);
    expect(fallback.generateResponse).not.toHaveBeenCalled();
  });

  it('isProviderRuntimeBanner matches only runtime/stall banners, not throttle/auth keywords', () => {
    expect(isProviderRuntimeBanner('Claude Code CLI encountered an error: stalled')).toBe(true);
    expect(isProviderRuntimeBanner('INACTIVITY CIRCUIT BREAKER - no output for 180s')).toBe(true);
    // Valid answers that merely mention these words must NOT be flagged as failures.
    expect(isProviderRuntimeBanner('The API returned HTTP 429 because the request exceeded quota')).toBe(false);
    expect(isProviderRuntimeBanner('Rotate the invalid api key; the 401 Unauthorized will clear')).toBe(false);
    expect(isProviderRuntimeBanner('the method is overloaded and rate-limited')).toBe(false);
    // ...but the broad classifier (error channel) still catches them.
    expect(isProviderRecoverableRuntimeFailure('429 too many requests')).toBe(true);
    expect(isProviderRecoverableRuntimeFailure('401 Unauthorized')).toBe(true);
  });

  it('returns successful Codex content even when it mentions throttle/auth keywords', async () => {
    const provider = new CodexProvider({ model: 'fake-model' });
    provider.wrapper.executeTask = vi.fn(async () => ({
      success: true,
      text: 'Root cause analysis: the HTTP 429 rate-limit was caused by exceeding the account quota.',
      stderr: '',
      costUSD: 0,
      usage: {},
      durationMs: 10,
      exitCode: 0,
    }));

    const res = await provider.generateResponse([{ role: 'user', content: 'do work' }], {
      workspaceDir: os.tmpdir(),
    });

    expect(res.content).toContain('429 rate-limit');
  });

  it('throws when Codex CLI returns provider error text instead of successful content', async () => {
    const provider = new CodexProvider({ model: 'fake-model' });
    provider.wrapper.executeTask = vi.fn(async () => ({
      success: false,
      text: '',
      result: '',
      stderr: 'failed to connect to websocket: HTTP error: 401 Unauthorized',
      costUSD: 0,
      usage: {},
      durationMs: 10,
      exitCode: 1,
    }));

    await expect(provider.generateResponse([{ role: 'user', content: 'do work' }], {
      workspaceDir: os.tmpdir(),
    })).rejects.toThrow(/Codex CLI error.*401 Unauthorized/);
  });
});

describe('any-bot ClaudeCodeProvider timeout config', () => {
  const ENV_KEYS = [
    'CLAUDE_CODE_TIMEOUT_MS',
    'CLAUDE_CODE_TIMEOUT_SECONDS',
    'CLAUDE_CODE_INACTIVITY_TIMEOUT_MS',
    'CLAUDE_CODE_INACTIVITY_TIMEOUT_SECONDS',
    'CLAUDE_CODE_KILL_ON_INACTIVITY',
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('honors millisecond env vars; killOnInactivity defaults ON (2026-07-24 idle directive — sound because runs stream)', () => {
    process.env.CLAUDE_CODE_TIMEOUT_MS = '600000';
    process.env.CLAUDE_CODE_INACTIVITY_TIMEOUT_MS = '180000';

    const provider = new ClaudeCodeProvider({ claudeCommand: 'claude-test' });

    expect(provider.config.timeout).toBe(600);
    expect(provider.config.inactivityTimeout).toBe(180);
    // Default flipped true 2026-07-24: the wrapper streams stream-json so silence is a
    // real stall signal — and the wrapper DISARMS the kill for batch (streaming:false)
    // runs regardless, preserving the "batch is legitimately silent" invariant (see
    // harness-idle-timeouts.spec.ts for the disarm guard).
    expect(provider.config.killOnInactivity).toBe(true);
  });

  it('honors an explicit CLAUDE_CODE_KILL_ON_INACTIVITY=false opt-out', () => {
    process.env.CLAUDE_CODE_KILL_ON_INACTIVITY = 'false';
    try {
      const provider = new ClaudeCodeProvider({ claudeCommand: 'claude-test' });
      expect(provider.config.killOnInactivity).toBe(false);
    } finally {
      delete process.env.CLAUDE_CODE_KILL_ON_INACTIVITY;
    }
  });

  it('normalizes legacy millisecond config values when callers pass timeout directly', () => {
    const provider = new ClaudeCodeProvider({
      claudeCommand: 'claude-test',
      timeout: 900000,
      inactivityTimeout: 240000,
      killOnInactivity: true,
    });

    expect(provider.config.timeout).toBe(900);
    expect(provider.config.inactivityTimeout).toBe(240);
    expect(provider.config.killOnInactivity).toBe(true);
  });
});

describe('any-bot ClaudeCodeCLIWrapper batch inactivity handling', () => {
  it('keeps silent batch runs alive past inactivity when killOnInactivity is disabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-claude-fake-'));
    const fakeCli = path.join(tmpDir, 'silent-success.cjs');
    fs.writeFileSync(fakeCli, `
process.stdin.resume();
process.stdin.on('end', () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'silent success after inactivity',
      total_cost_usd: 0,
      duration_ms: 150,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 2 }
    }));
  }, 150);
});
`);

    try {
      const wrapper = new ClaudeCodeCLIWrapper({
        claudeCommand: process.execPath,
        timeout: 5,
        inactivityTimeout: 0.05,
        killOnInactivity: false,
        inactivityCheckIntervalMs: 25,
        model: 'fake-model',
      });
      wrapper._buildArgs = () => [fakeCli];

      const result = await wrapper.executeTask('stay alive while silent', tmpDir, {
        timeout: 5,
        inactivityTimeout: 0.05,
        killOnInactivity: false,
        inactivityCheckIntervalMs: 25,
        model: 'fake-model',
      });

      expect(result.success).toBe(true);
      expect(result.text).toBe('silent success after inactivity');
      expect(result.inactivityObserved).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps silent streaming runs alive past inactivity when killOnInactivity is disabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-claude-stream-fake-'));
    const fakeCli = path.join(tmpDir, 'silent-stream-success.cjs');
    fs.writeFileSync(fakeCli, `
process.stdin.resume();
process.stdin.on('end', () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'silent streaming success after inactivity',
      total_cost_usd: 0,
      duration_ms: 150,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 2 }
    }));
  }, 150);
});
`);

    try {
      const wrapper = new ClaudeCodeCLIWrapper({
        claudeCommand: process.execPath,
        timeout: 5,
        inactivityTimeout: 0.05,
        killOnInactivity: false,
        inactivityCheckIntervalMs: 25,
        model: 'fake-model',
      });
      wrapper._buildArgs = () => [fakeCli];

      const result = await wrapper.executeTaskStreaming('stay alive while streaming silently', tmpDir, {
        timeout: 5,
        inactivityTimeout: 0.05,
        killOnInactivity: false,
        inactivityCheckIntervalMs: 25,
        model: 'fake-model',
      });

      expect(result.success).toBe(true);
      expect(result.finalResult?.result).toBe('silent streaming success after inactivity');
      expect(result.inactivityObserved).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
