/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — direct OpenAI Codex provider using OAuth access token
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned OpenAI Codex provider contracts with OSHAL LLM service types for validation compatibility
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed remaining OpenAI Codex typing issues surfaced by retrofit validation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | CRITICAL FIX: Switched from Chat Completions API to Responses API — OAuth tokens only work with /v1/responses
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Updated the direct OpenAI Codex provider default model to match current upstream Cline defaults
 */

import { createChildLogger } from '@/shared/logger';
import type { ContentBlock, LLMMessage } from '@/shared/types';
import { LLMService } from './llm-service';
import type { CostResult, LLMResponse, SendRequestOptions, LLMToolDefinition, StreamCallback, TokenUsage } from './llm-service';

const logger = createChildLogger({ module: 'openai-codex-provider' });

/**
 * @description Configuration for the OpenAI Codex provider.
 */
interface OpenAICodexProviderConfig {
  accessToken: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
}

/**
 * @description LLM provider that calls the OpenAI **Responses API** (/v1/responses)
 *              using an OAuth access token from the ChatGPT Pro / Codex OAuth flow.
 *
 *              IMPORTANT: ChatGPT Pro OAuth tokens do NOT work with /v1/chat/completions.
 *              They return 429 "insufficient_quota" on that endpoint. The OAuth tokens
 *              are scoped exclusively for the Responses API. This is how Cline calls
 *              OpenAI Codex — via `openai.responses.stream()`.
 */
export class OpenAICodexProvider extends LLMService {
  private accessToken: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;

  constructor(config: OpenAICodexProviderConfig) {
    super('openai-codex', config as unknown as Record<string, unknown>);
    this.accessToken = config.accessToken;
    this.model = config.model ?? 'gpt-5.3-codex';
    this.maxTokens = config.maxTokens ?? 8192;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    logger.info(
      { provider: 'openai-codex', model: this.model, maxTokens: this.maxTokens, endpoint: '/v1/responses' },
      'OpenAICodexProvider initialized (Responses API)',
    );
  }

  getProviderName(): string {
    return 'openai-codex';
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * @description Sends a request to the OpenAI Responses API using the OAuth access token.
   *              Converts LLMMessage format to Responses API input format.
   * @param options - Request options.
   * @returns LLM response.
   */
  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    this.requestCount++;
    const model = options.model ?? this.model;
    const maxTokens = options.maxTokens ?? this.maxTokens;

    logger.info(
      {
        model,
        messageCount: options.messages.length,
        toolCount: options.tools?.length ?? 0,
        hasSystemPrompt: !!options.systemPrompt,
        streaming: !!(options.stream && options.onStreamChunk),
        endpoint: `${this.baseUrl}/responses`,
      },
      'Sending request to OpenAI Responses API',
    );

    const input = this.buildResponsesInput(options.messages);
    const tools = options.tools ? this.formatResponsesTools(options.tools) : undefined;

    const body: Record<string, unknown> = {
      model,
      max_output_tokens: maxTokens,
      input,
      temperature: options.temperature ?? 0.7,
    };

    if (options.systemPrompt) {
      body.instructions = options.systemPrompt;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (options.stream && options.onStreamChunk) {
      body.stream = true;
      return this.sendStreamingRequest(body, options.onStreamChunk);
    }

    return this.sendNonStreamingRequest(body);
  }

  /**
   * @description Sends a non-streaming request to the OpenAI Responses API.
   */
  private async sendNonStreamingRequest(body: Record<string, unknown>): Promise<LLMResponse> {
    const url = `${this.baseUrl}/responses`;
    logger.debug({ url, model: body.model, inputItems: Array.isArray(body.input) ? (body.input as unknown[]).length : 0 }, 'Non-streaming Responses API call');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();

      if (!response.ok) {
        logger.error(
          { status: response.status, body: responseText.slice(0, 1000), url },
          'OpenAI Responses API request failed',
        );
        throw new Error(`OpenAI API returned ${response.status}: ${responseText.slice(0, 200)}`);
      }

      const data = JSON.parse(responseText) as ResponsesAPIResponse;

      logger.info(
        {
          id: data.id,
          model: data.model,
          status: data.status,
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
          outputItems: data.output?.length,
        },
        'OpenAI Responses API response received',
      );

      return {
        content: this.mapResponsesOutput(data),
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        model: data.model ?? (body.model as string),
        stopReason: data.status ?? undefined,
      };
    } catch (error) {
      logger.error({ err: error, url }, 'OpenAI Codex Responses API request failed');
      throw error;
    }
  }

  /**
   * @description Sends a streaming request to the OpenAI Responses API.
   *              Parses SSE events: response.output_text.delta for text chunks,
   *              response.completed for final usage data.
   */
  private async sendStreamingRequest(
    body: Record<string, unknown>,
    onChunk: StreamCallback,
  ): Promise<LLMResponse> {
    const url = `${this.baseUrl}/responses`;
    logger.debug({ url, model: body.model, streaming: true }, 'Streaming Responses API call');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { status: response.status, body: errorText.slice(0, 1000), url },
          'OpenAI Responses API streaming request failed',
        );
        throw new Error(`OpenAI API returned ${response.status}: ${errorText.slice(0, 200)}`);
      }

      let fullText = '';
      const contentBlocks: ContentBlock[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      let status: string | undefined;

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body reader available');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;

          try {
            const event = JSON.parse(payload) as ResponsesStreamEvent;

            if (event.type === 'response.output_text.delta' && event.delta) {
              fullText += event.delta;
              onChunk(event.delta);
            }

            if (event.type === 'response.completed' && event.response) {
              const usage = event.response.usage;
              if (usage) {
                inputTokens = usage.input_tokens ?? 0;
                outputTokens = usage.output_tokens ?? 0;
                totalTokens = usage.total_tokens ?? 0;
              }
              status = event.response.status;
              logger.debug(
                { inputTokens, outputTokens, totalTokens, status },
                'Responses API stream completed event',
              );
            }

            if (event.type === 'response.error') {
              const errMsg = (event as unknown as { error?: unknown }).error;
              logger.error({ event }, 'Responses API stream error event');
              throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              logger.debug({ raw: payload.slice(0, 200) }, 'Skipping unparseable SSE chunk');
            } else {
              throw parseErr;
            }
          }
        }
      }

      if (fullText) {
        contentBlocks.push({ type: 'text', text: fullText });
      }

      logger.info(
        { model: (body.model as string), status, textLength: fullText.length, inputTokens, outputTokens },
        'OpenAI Responses API streaming complete',
      );

      return {
        content: contentBlocks,
        usage: { inputTokens, outputTokens, totalTokens },
        model: body.model as string,
        stopReason: status,
      };
    } catch (error) {
      logger.error({ err: error, url }, 'OpenAI Codex Responses API streaming failed');
      throw error;
    }
  }

  /**
   * @description Builds Responses API input array from conversation messages.
   *              The Responses API uses {role, content: [{type:"input_text"|"output_text", text}]}
   *              instead of the Chat Completions {role, content: string} format.
   */
  private buildResponsesInput(
    messages: LLMMessage[],
  ): ResponsesInputItem[] {
    const result: ResponsesInputItem[] = [];

    for (const msg of messages) {
      const textContent = typeof msg.content === 'string'
        ? msg.content
        : msg.content
          .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n');

      if (msg.role === 'assistant') {
        result.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: textContent }],
        });
      } else {
        result.push({
          role: 'user',
          content: [{ type: 'input_text', text: textContent }],
        });
      }
    }

    return result;
  }

  /**
   * @description Formats tools for the Responses API function-calling format.
   */
  private formatResponsesTools(tools: LLMToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    }));
  }

  /**
   * @description Maps Responses API output to ContentBlock array.
   */
  private mapResponsesOutput(data: ResponsesAPIResponse): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    if (data.output) {
      for (const item of data.output) {
        if (item.type === 'message' && item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              blocks.push({ type: 'text', text: part.text });
            }
          }
        }
        if (item.type === 'function_call') {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>;
          } catch {
            input = { raw: item.arguments };
          }
          blocks.push({
            type: 'tool_use',
            id: item.call_id ?? item.id ?? '',
            name: item.name ?? '',
            input,
          });
        }
      }
    }

    if (data.output_text) {
      blocks.push({ type: 'text', text: data.output_text });
    }

    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: '' });
    }

    return blocks;
  }

  /**
   * @description Calculates estimated cost (GPT-4.1 / Codex pricing).
   */
  calculateCost(usage: TokenUsage): CostResult {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const inputRate = 2.0 / 1_000_000;
    const outputRate = 8.0 / 1_000_000;
    const inputCost = inputTokens * inputRate;
    const outputCost = outputTokens * outputRate;
    return { inputCost, outputCost, totalCost: inputCost + outputCost, currency: 'USD' };
  }

  /**
   * @description Tests the connection to the OpenAI Responses API.
   *              Sends a minimal request to verify the token works.
   */
  async testConnection(): Promise<boolean> {
    const url = `${this.baseUrl}/responses`;
    logger.debug({ url }, 'Testing OpenAI Responses API connection');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
          max_output_tokens: 5,
        }),
      });
      logger.info({ status: response.status, ok: response.ok }, 'Responses API connection test result');
      return response.ok;
    } catch (err) {
      logger.error({ err }, 'Responses API connection test failed');
      return false;
    }
  }
}

// --- Responses API types ---

/**
 * @description Input item for the Responses API.
 */
interface ResponsesInputItem {
  role: 'user' | 'assistant' | 'system';
  content: Array<{ type: string; text: string }>;
}

/**
 * @description Full response from the Responses API (non-streaming).
 */
interface ResponsesAPIResponse {
  id: string;
  model?: string;
  status?: string;
  output_text?: string;
  output?: Array<{
    type: string;
    id?: string;
    content?: Array<{ type: string; text?: string }>;
    // function_call fields
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * @description SSE event from the Responses API streaming endpoint.
 */
interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  response?: {
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
}
