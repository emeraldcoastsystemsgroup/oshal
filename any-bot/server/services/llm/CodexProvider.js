/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial CodexProvider for the bot-node runtime — lets a bot container execute via the OpenAI Codex CLI alongside Cline + ClaudeCode. Implements the same generateResponse() contract; wraps CodexCLIWrapper. With a sandbox (danger-full-access) a codex bot can shell out (run scripts/oshal-gmail.js) — which claude-code-as-root cannot. See docs/adr/037-communications-swarm.md.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: deny constrained execution before autonomous Codex CLI can bypass server tool authorization.
 */

'use strict';

const CodexCLIWrapper = require('../codebase/CodexCLIWrapper');
const { formatProviderFailure, isProviderRuntimeBanner } = require('./providerFailureClassifier');
const { assertCliToolBoundary } = require('./assert-cli-tool-boundary');

/**
 * @description LLM provider backed by the OpenAI Codex CLI (`codex exec`).
 * Parallel to ClaudeCodeProvider — same generateResponse() return shape so the
 * bot-node AgenticController can call it interchangeably.
 */
class CodexProvider {
  /**
   * @param {{model?: string, timeoutMs?: number, codexCommand?: string, sandboxMode?: string}} config
   */
  constructor(config = {}) {
    this.config = {
      model: config.model || process.env.CODEX_MODEL || 'gpt-5.5',
      timeout: config.timeoutMs || parseInt(process.env.CODEX_TIMEOUT_MS || '600000', 10),
      sandboxMode: config.sandboxMode || process.env.CODEX_SANDBOX_MODE || 'danger-full-access',
    };
    this.wrapper = new CodexCLIWrapper({
      codexCommand: config.codexCommand || process.env.CODEX_CLI_PATH || 'codex',
      model: this.config.model,
      sandboxMode: this.config.sandboxMode,
      timeoutMs: this.config.timeout,
    });
  }

  /**
   * @description Runs a prompt through `codex exec` and returns a normalized result.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{systemPrompt?: string, workspaceDir?: string, source?: string}} [options]
   * @returns {Promise<object>} { content, contentBlocks, stopReason, usage, cost, latency, model, provider }
   */
  async generateResponse(messages, options = {}) {
    assertCliToolBoundary(options, 'openai-codex');
    const start = Date.now();

    // Model-gateway pre-flight (budgets/quotas/cost-aware routing). One gate for
    // ALL bot LLM traffic — the controller. Fail-open; no-op until OSHAL_LLM_BUDGETS
    // is enabled.
    const { gateLlmCall } = require('./llmGate');
    const gate = await gateLlmCall(this.config.model, messages, options);
    if (!gate.allowed) {
      throw new Error(`LLM call denied by model gateway (${gate.reason})`);
    }
    const gatedModel = gate.model || this.config.model;

    const task = this._messagesToTask(messages, options);
    const workspaceDir = options.workspaceDir || process.env.CODEX_WORKSPACE || '/app/workspace-shared/codex-default';

    const result = await this.wrapper.executeTask(task, workspaceDir, {
      model: gatedModel, // gateway may downshift under budget pressure
      sandboxMode: this.config.sandboxMode,
      source: options.source,
      extraEnv: options.extraEnv, // per-request scoping (e.g. OSHAL_USER_SUB) → spawn env
    });

    if (!result.success) {
      const error = new Error(`Codex CLI error: ${result.stderr || result.text || 'no output'}`);
      error.provider = 'openai-codex';
      error.model = gatedModel;
      error.stderr = result.stderr || '';
      error.exitCode = result.exitCode;
      error.durationMs = result.durationMs;
      throw error;
    }

    const text = result.text
      || 'Execution completed.';

    // Success path (result.success === true here): match only narrow runtime/stall
    // banners, not the broad throttle/auth keywords, which appear in valid answers.
    // Real throttle/auth failures set result.success === false and are thrown above.
    if (isProviderRuntimeBanner(text)) {
      const error = new Error(formatProviderFailure(text));
      error.provider = 'openai-codex';
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
        inputTokens: (result.usage && result.usage.inputTokens) || 0,
        outputTokens: (result.usage && result.usage.outputTokens) || 0,
        totalTokens: (result.usage && result.usage.totalTokens) || 0,
        cacheReadTokens: (result.usage && result.usage.cacheReadTokens) || 0,
        cacheCreationTokens: 0,
      },
      cost: result.costUSD || 0,
      latency: Date.now() - start,
      // Report the model that actually executed after gateway governance. The
      // configured model may differ when the gateway downshifts the request.
      model: gatedModel,
      provider: 'openai-codex',
      // Structured post-model command capture. Never concatenate these records into model text.
      providerRecords: Array.isArray(result.providerRecords) ? result.providerRecords : [],
      providerRecordCapture: 'codex-command-events-v1',
      codexMetadata: { durationMs: result.durationMs, exitCode: result.exitCode, success: result.success },
    };
  }

  /**
   * @description Flattens the message list (+ optional systemPrompt) into a single
   * task prompt for `codex exec`. The bot-node assembles the persona/instructions
   * upstream, so the messages already carry the full prompt.
   * @param {Array<{role: string, content: any}>} messages
   * @param {{systemPrompt?: string}} [options]
   * @returns {string}
   */
  _messagesToTask(messages, options = {}) {
    const parts = [];
    if (options.systemPrompt) parts.push(options.systemPrompt);
    for (const m of messages || []) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (c && c.trim()) parts.push(c);
    }
    return parts.join('\n\n');
  }

  /** @description Provider/model introspection for the runtime. */
  getModelInfo() {
    return { provider: 'openai-codex', model: this.config.model, timeout: this.config.timeout, sandboxMode: this.config.sandboxMode };
  }

  /** @description Health/status descriptor. */
  getProviderInfo() {
    return {
      name: 'openai-codex',
      displayName: 'OpenAI Codex',
      description: 'OpenAI Codex CLI (codex exec) — sandboxed, can shell out to run CLIs',
      model: this.config.model,
      authMethod: 'chatgpt-oauth (or OPENAI_API_KEY)',
      costTracking: 'token-usage (no per-call $ on ChatGPT-account login)',
    };
  }

  /** @description Verifies the codex binary + auth are present. */
  async testConnection() {
    return this.wrapper.testConnection();
  }
}

module.exports = CodexProvider;
