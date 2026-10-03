/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Bot-node provider for Google's Antigravity CLI, under the same ADR-127 boundary and model-gateway preflight as the other autonomous CLI providers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Forward the trusted call-time framework-tool bridge binding to the native CLI wrapper.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Advertise explicit support for the execution-bound framework-tool bridge so routers can keep its credential away from unrelated providers.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Forward hostToolsOnly to the wrapper. The agentic host loop sets it for an interactive (direct) turn, whose tools the loop itself brokers; the wrapper then runs agy with no native tools instead of letting it chase the answer with file reads and commands a headless run cannot be granted.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Forward imageTurn to the wrapper (ADR-130 amendment 2026-10-02): a storyboard render dispatched onto the Antigravity harness is an image turn, so the wrapper collects generate_image's output into the task workspace before the private HOME is removed. The collected image's metadata (file, real mime type, bytes, sha256, locator) rides on antigravityMetadata.image.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | A refused image turn's untrusted diagnostic (the image tool's error text and the model's final reply, which Guard A appends behind DIAGNOSTIC_MARKER) no longer reaches the thrown error's message or stderr. ProviderFailoverProvider classifies both (isProviderRecoverableRuntimeFailure: 429, quota, rate limit, resource_exhausted, unauthorized, ...), and bot-node-runtime wraps this provider in that failover whenever a fallback order is configured, so a throttle word in the tool's or the model's text sent the render to the fallback rung for a second model turn (verifier finding on core PR #1031). On an image turn the message and stderr now carry Guard A's own words only and the diagnostic rides on error.diagnostic, which the bot-node handler re-attaches behind the marker where the error leaves the node. Every other turn's error is unchanged.
 */

'use strict';

const AntigravityCLIWrapper = require('../codebase/AntigravityCLIWrapper');
const { DIAGNOSTIC_MARKER } = require('../codebase/agy-image-turn');
const { formatProviderFailure, isProviderRuntimeBanner } = require('./providerFailureClassifier');
const { assertCliToolBoundary } = require('./assert-cli-tool-boundary');

function positiveMs(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @description A failed turn's stderr, split at Guard A's DIAGNOSTIC_MARKER on an image turn: Guard A's
 * own words, and the untrusted diagnostic after them (the image tool's error, the model's reply). Only
 * the own words may reach the error's message and stderr, which provider failover classifies; any
 * other turn's stderr is left whole.
 * @param {string} stderr - The wrapper's stderr.
 * @param {boolean} imageTurn - Whether the turn was an image turn.
 * @returns {{own: string, diagnostic: string}} The two parts ('' when there is no diagnostic).
 */
function splitImageTurnFailure(stderr, imageTurn) {
  const text = String(stderr || '');
  const at = imageTurn ? text.indexOf(DIAGNOSTIC_MARKER) : -1;
  return at < 0 ? { own: text, diagnostic: '' } : { own: text.slice(0, at), diagnostic: text.slice(at + DIAGNOSTIC_MARKER.length) };
}

class AntigravityProvider {
  constructor(config = {}) {
    this.supportsFrameworkToolBridge = true;
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
      toolBridge: options.toolBridge,
      hostToolsOnly: options.hostToolsOnly === true,
      imageTurn: options.imageTurn === true,
    });
    if (!result.success) {
      // Guard A's untrusted diagnostic stays off the message and stderr: provider failover classifies both.
      const failure = splitImageTurnFailure(result.stderr, options.imageTurn === true);
      const error = new Error(`Antigravity CLI error: ${failure.own || result.text || 'no output'}`);
      error.provider = 'antigravity-cli';
      error.model = gatedModel;
      error.stderr = failure.own;
      if (failure.diagnostic) error.diagnostic = failure.diagnostic;
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
      antigravityMetadata: { durationMs: result.durationMs, exitCode: result.exitCode, success: result.success, ...(result.image ? { image: result.image } : {}) },
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
