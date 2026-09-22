/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Bot-node provider for Google's Antigravity CLI, under the same ADR-127 boundary and model-gateway preflight as the other autonomous CLI providers.
 */

'use strict';

const AntigravityCLIWrapper = require('../codebase/AntigravityCLIWrapper');
const { formatProviderFailure, isProviderRuntimeBanner } = require('./providerFailureClassifier');
const { assertCliToolBoundary } = require('./assert-cli-tool-boundary');

function positiveMs(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class AntigravityProvider {
  constructor(config = {}) {
    this.config = {
      model: config.model || process.env.ANTIGRAVITY_MODEL || 'gemini-3.8-flash-low',
      effort: config.effort || process.env.ANTIGRAVITY_EFFORT || '',
      timeout: positiveMs(config.timeoutMs || process.env.ANTIGRAVITY_INACTIVITY_TIMEOUT_MS || process.env.ANTIGRAVITY_TIMEOUT_MS, 600000),
    };
    this.wrapper = new AntigravityCLIWrapper({
      agyCommand: config.agyCommand || process.env.ANTIGRAVITY_CLI_PATH || 'agy',
      model: this.config.model,
      effort: this.config.effort,
      timeoutMs: this.config.timeout,
    });
  }

  async generateResponse(messages, options = {}) {
    assertCliToolBoundary(options, 'antigravity-cli');
    const start = Date.now();
    const { gateLlmCall } = require('./llmGate');
    const gate = await gateLlmCall(this.config.model, messages, options);
    if (!gate.allowed) throw new Error(`LLM call denied by model gateway (${gate.reason})`);
    const gatedModel = gate.model || this.config.model;
    const task = this._messagesToTask(messages, options);
    const workspaceDir = options.workspaceDir || process.env.ANTIGRAVITY_WORKSPACE || '/app/workspace-shared/antigravity-default';
    const result = await this.wrapper.executeTask(task, workspaceDir, {
      model: gatedModel,
      effort: this.config.effort,
      source: options.source,
      extraEnv: options.extraEnv,
    });
    if (!result.success) {
      const error = new Error(`Antigravity CLI error: ${result.stderr || result.text || 'no output'}`);
      error.provider = 'antigravity-cli';
      error.model = gatedModel;
      error.stderr = result.stderr || '';
      error.exitCode = result.exitCode;
      error.durationMs = result.durationMs;
      throw error;
    }
    const text = result.text || 'Execution completed.';
    if (isProviderRuntimeBanner(text)) {
      const error = new Error(formatProviderFailure(text));
      error.provider = 'antigravity-cli';
      error.model = gatedModel;
      error.stderr = result.stderr || '';
      error.exitCode = result.exitCode;
      error.durationMs = result.durationMs;
      throw error;
    }
    return {
      content: text,
      contentBlocks: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: {
        inputTokens: result.usage && result.usage.inputTokens || 0,
        outputTokens: result.usage && result.usage.outputTokens || 0,
        totalTokens: result.usage && result.usage.totalTokens || 0,
        cacheReadTokens: result.usage && result.usage.cacheReadTokens || 0,
        cacheCreationTokens: 0,
      },
      cost: result.costUSD || 0,
      latency: Date.now() - start,
      model: gatedModel,
      provider: 'antigravity-cli',
      providerRecords: [],
      providerRecordCapture: 'antigravity-command-events-v1',
      antigravityMetadata: { durationMs: result.durationMs, exitCode: result.exitCode, success: result.success },
    };
  }

  _messagesToTask(messages, options = {}) {
    const parts = [];
    if (options.systemPrompt) parts.push(options.systemPrompt);
    for (const message of messages || []) {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      if (content && content.trim()) parts.push(content);
    }
    return parts.join('\n\n');
  }

  getModelInfo() {
    return { provider: 'antigravity-cli', model: this.config.model, timeout: this.config.timeout, effort: this.config.effort || null };
  }

  getProviderInfo() {
    return {
      name: 'antigravity-cli', displayName: 'Google Antigravity CLI',
      description: 'Google Antigravity CLI headless runtime', model: this.config.model,
      authMethod: 'Google account login (or GEMINI_API_KEY)', costTracking: 'token-usage',
    };
  }

  async testConnection() {
    return this.wrapper.testConnection();
  }
}

module.exports = AntigravityProvider;
