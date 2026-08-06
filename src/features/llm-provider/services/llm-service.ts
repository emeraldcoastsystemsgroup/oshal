/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added interactionMode so Cline-backed runtime can distinguish conversational chat launches from swarm/task execution launches
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — abstract LLM base class ported from any-bot LLMService.js
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added optional taskId to provider request options for workspace-aware CLI execution
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added optional agentId to provider request options so runtime startup manifests can reflect the active bot identity
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added optional streaming callback and total-token compatibility fields for provider validation parity
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | IMP-2: Added executionScopeId to SendRequestOptions for child/review ticket context isolation
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: added optional `creds` (caller's short-lived per-user access tokens, OSHAL_CRED_*) to SendRequestOptions so the in-controller harness path can write them to the task workspace as .oshal-cred-<provider> files (parity with the remote any-bot path).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove the generic credential carrier from model-provider requests; connector credentials remain inside audited server-side operation brokers.
 */

import { createChildLogger } from '@/shared/logger';
import type { LLMMessage, ContentBlock } from '@/shared/types';

const logger = createChildLogger({ module: 'llm-service' });

/**
 * @description Token usage data returned by an LLM provider.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * @description Cost breakdown from an LLM request.
 */
export interface CostResult {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
}

/**
 * @description Tool definition formatted for LLM API calls.
 */
export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * @description Options for sending a request to an LLM provider.
 */
export interface SendRequestOptions {
  messages: LLMMessage[];
  systemPrompt?: string;
  tools?: LLMToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  providerId?: string;
  model?: string;
  taskId?: string;
  agentId?: string;
  interactionMode?: 'chat' | 'task';
  executionScopeId?: string;
  onStreamChunk?: StreamCallback;
  /** Authenticated caller's OIDC sub — scopes per-user data access (e.g. which
   *  connected Gmail the bot may read). Threaded to the harness task workspace. */
  userSub?: string;

}

/**
 * @description Response from an LLM provider.
 */
export interface LLMResponse {
  content: ContentBlock[];
  usage: TokenUsage;
  model: string;
  stopReason?: string;
}

/**
 * @description Callback for streaming chunks from an LLM provider.
 */
export type StreamCallback = (chunk: string, messageId?: string) => void;

/**
 * @description Abstract base class for all LLM providers.
 * Ported from any-bot's LLMService.js — provides the unified interface
 * that all provider implementations must satisfy.
 *
 * @remarks
 * Concrete providers (Anthropic, Bedrock, Claude Code, etc.) extend this
 * class and implement `sendRequest()`. The base class provides shared
 * utilities for message formatting, tool formatting, and cost calculation.
 */
export abstract class LLMService {
  protected provider: string;
  protected config: Record<string, unknown>;
  protected requestCount: number;

  constructor(provider: string, config: Record<string, unknown>) {
    this.provider = provider;
    this.config = config;
    this.requestCount = 0;

    logger.info({ provider }, 'LLM service initialized');
  }

  /**
   * @description Send a request to the LLM provider.
   * Must be implemented by each concrete provider.
   *
   * @param options - Request options including messages, tools, and config
   * @returns LLM response with content blocks and token usage
   */
  abstract sendRequest(options: SendRequestOptions): Promise<LLMResponse>;

  /**
   * @description Format stored messages into LLM API format.
   * Maps internal message types to user/assistant roles.
   *
   * @param messages - Array of LLM-formatted messages
   * @returns Formatted messages ready for the provider API
   */
  formatMessages(messages: LLMMessage[]): LLMMessage[] {
    return messages.map((msg) => ({
      role: this.mapRole(msg.role),
      content: msg.content,
    }));
  }

  /**
   * @description Map internal role to provider role.
   *
   * @param role - Internal role identifier
   * @returns Provider-compatible role string
   */
  protected mapRole(role: string): 'user' | 'assistant' {
    if (role === 'user' || role === 'task' || role === 'say') {
      return 'user';
    }
    return 'assistant';
  }

  /**
   * @description Format tool definitions for the LLM API.
   *
   * @param tools - Array of tool definitions
   * @returns Formatted tools for the provider
   */
  formatTools(tools: LLMToolDefinition[]): LLMToolDefinition[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.input_schema || { type: 'object', properties: {} },
    }));
  }

  /**
   * @description Calculate cost for a completed request.
   * Default implementation returns zero — override per provider.
   *
   * @param usage - Token usage from the response
   * @returns Cost breakdown
   */
  calculateCost(usage: TokenUsage): CostResult {
    logger.debug({ provider: this.provider, usage }, 'Cost calculation (base — $0)');
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
  }

  /**
   * @description Test connectivity to the provider.
   * Default sends a minimal request; override for custom health checks.
   *
   * @returns True if connection succeeds
   */
  async testConnection(): Promise<boolean> {
    logger.info({ provider: this.provider }, 'Testing provider connection');
    try {
      await this.sendRequest({
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 10,
      });
      logger.info({ provider: this.provider }, 'Provider connection test passed');
      return true;
    } catch (error) {
      logger.error({ err: error, provider: this.provider }, 'Provider connection test failed');
      return false;
    }
  }

  /**
   * @description Get the provider identifier.
   *
   * @returns Provider name string
   */
  getProviderName(): string {
    return this.provider;
  }

  /**
   * @description Get the total number of requests made.
   *
   * @returns Request count
   */
  getRequestCount(): number {
    return this.requestCount;
  }
}
