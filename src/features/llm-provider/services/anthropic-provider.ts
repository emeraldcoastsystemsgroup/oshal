/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native Anthropic API provider using @anthropic-ai/sdk for swarm agent execution
 */

import Anthropic from '@anthropic-ai/sdk';
import { createChildLogger } from '@/shared/logger';
import type { ContentBlock } from '@/shared/types';
import {
  LLMService,
  type CostResult,
  type LLMResponse,
  type LLMToolDefinition,
  type SendRequestOptions,
  type TokenUsage,
} from './llm-service';

const logger = createChildLogger({ module: 'anthropic-provider' });

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * @description Per-million-token pricing for Anthropic models.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-4-20250506': { input: 0.8, output: 4 },
};

/**
 * @description Construction options for AnthropicProvider.
 */
export interface AnthropicProviderConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
}

/**
 * @description Native Anthropic API provider for direct Claude model access.
 */
export class AnthropicProvider extends LLMService {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;

  constructor(config: AnthropicProviderConfig = {}) {
    super('anthropic', config as Record<string, unknown>);
    const clientOpts: Record<string, unknown> = { apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY };
    if (config.baseUrl) {
      clientOpts.baseURL = config.baseUrl;
    }
    this.client = new Anthropic(clientOpts as ConstructorParameters<typeof Anthropic>[0]);
    this.defaultModel = config.model || DEFAULT_MODEL;
    this.defaultMaxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;
  }

  /**
   * @description Sends a request to the Anthropic Messages API.
   * @param options - Request options
   * @returns LLM response with content blocks and token usage
   */
  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    this.requestCount++;
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens || this.defaultMaxTokens;

    logger.info({ model, maxTokens, messageCount: options.messages.length }, 'Sending Anthropic API request');

    const params = buildRequestParams(options, model, maxTokens);
    const response = await this.client.messages.create(params);

    const content = mapResponseContent(response.content);
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as unknown as Record<string, number>).cache_read_input_tokens,
      cacheWriteTokens: (response.usage as unknown as Record<string, number>).cache_creation_input_tokens,
    };

    logger.info({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, 'Anthropic API response received');

    return { content, usage, model: response.model, stopReason: response.stop_reason ?? undefined };
  }

  /**
   * @description Calculates cost using Anthropic's per-model pricing.
   * @param usage - Token usage from the response
   * @returns Cost breakdown in USD
   */
  calculateCost(usage: TokenUsage): CostResult {
    const pricing = MODEL_PRICING[this.defaultModel] || { input: 3, output: 15 };
    const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
    return { inputCost, outputCost, totalCost: inputCost + outputCost, currency: 'USD' };
  }
}

/**
 * @description Builds the Anthropic messages.create params from SendRequestOptions.
 * @param options - LLM request options
 * @param model - Model identifier
 * @param maxTokens - Maximum output tokens
 * @returns Anthropic API request params
 */
function buildRequestParams(
  options: SendRequestOptions,
  model: string,
  maxTokens: number,
): Anthropic.MessageCreateParamsNonStreaming {
  const messages = options.messages.map((msg) => ({
    role: (msg.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  }));

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages,
  };

  if (options.systemPrompt) {
    params.system = options.systemPrompt;
  }
  if (options.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options.tools && options.tools.length > 0) {
    params.tools = mapTools(options.tools);
  }

  return params;
}

/**
 * @description Maps LLMToolDefinition[] to Anthropic tool format.
 * @param tools - Tool definitions
 * @returns Anthropic-formatted tools
 */
function mapTools(tools: LLMToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * @description Maps Anthropic response content blocks to OSHAL ContentBlock format.
 * @param blocks - Anthropic content blocks
 * @returns Normalized content blocks
 */
function mapResponseContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    if (block.type === 'tool_use') {
      return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input as Record<string, unknown> };
    }
    return { type: 'text' as const, text: JSON.stringify(block) };
  });
}
