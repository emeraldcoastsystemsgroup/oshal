/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 inline hosted brain: OpenAI-compatible hosted LLMService driven by a caller-resolved { baseUrl, apiKey, model } connection (the exact shape resolveUserLlmConnection returns), so controller-inline turns for CLI-harness bots can run on the user-brain ladder instead of dying on the SEC-05 unattended-CLI refusal. Maps the platform's ContentBlock history (incl. tool_use/tool_result) to the OpenAI wire shape and back; plus a governed factory that applies the same GovernedProvider wrap the composition root gives every other provider path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Tool-call arguments must parse to a plain JSON object: valid-but-wrong shapes (a scalar, an array, null) are now skipped like parse failures instead of handing executeTool a malformed input.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { ContentBlock, LLMMessage } from '@/shared/types';
import {
  LLMService,
  type LLMResponse,
  type LLMToolDefinition,
  type SendRequestOptions,
  type TokenUsage,
} from './llm-service';
import { GovernedProvider } from './governed-provider';

const logger = createChildLogger({ module: 'byo-hosted-provider' });

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Upper bound on how much of an error body travels into an Error message. */
const ERROR_BODY_EXCERPT_CHARS = 400;

/**
 * @description A caller-resolved OpenAI-compatible hosted connection — the exact shape the
 * ADR-127 user-brain ladder (`resolveUserLlmConnection`) returns and `byoLlmConnection`
 * carries: any endpoint that answers `POST {baseUrl}/chat/completions` with a Bearer key.
 */
export interface ByoHostedConnection {
  /** OpenAI-compatible base URL (no trailing `/chat/completions`). */
  baseUrl: string;
  /** Bearer key for the endpoint. Never logged, never echoed into errors. */
  apiKey: string;
  /** Model id the endpoint should run. The connection's model always wins (bot-node parity). */
  model: string;
}

/** One message on the OpenAI chat-completions wire. */
interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/** One assistant-requested function call on the OpenAI wire. */
interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** The loosely-parsed subset of an OpenAI chat-completions response this provider reads. */
interface OpenAiCompletionPayload {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

/**
 * @description Hosted OpenAI-compatible LLM provider for controller-side reasoning on a
 * caller-resolved connection (ADR-127). This is a clean TS sibling of the any-bot JS
 * `OpenAIProvider`: it speaks `POST {baseUrl}/chat/completions`, supports system prompt,
 * conversation history, OpenAI function tools, and maps `tool_calls` responses back into the
 * platform's `tool_use` content blocks so `runAgenticLoop` can drive it unchanged.
 *
 * The endpoint owns the user's billing, so {@link LLMService.calculateCost} stays at the
 * base-class $0 (tokens are still reported for telemetry). The api key lives only in a
 * private field — it is never logged and never placed on the inherited `config` bag.
 */
export class ByoHostedProvider extends LLMService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpointHost: string;
  private readonly timeoutMs: number;

  constructor(connection: ByoHostedConnection, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    // The config bag deliberately excludes the apiKey — nothing downstream may see it.
    super(`byo-hosted:${connection?.model ?? 'unknown'}`, {
      baseUrl: connection?.baseUrl,
      model: connection?.model,
    });
    if (!connection?.baseUrl || !connection?.apiKey || !connection?.model) {
      throw new Error('Invalid BYO hosted connection: baseUrl, apiKey, and model are all required');
    }
    this.baseUrl = connection.baseUrl.replace(/\/+$/, '');
    this.apiKey = connection.apiKey;
    this.model = connection.model;
    this.endpointHost = safeEndpointHost(this.baseUrl);
    this.timeoutMs = timeoutMs;
  }

  /**
   * @description Sends one chat-completions request to the hosted endpoint and maps the
   * response to the platform contract. The connection's model always wins over
   * `options.model` (parity with the bot-node `_buildByoLlm` path — a cockpit-selected
   * harness model is meaningless on the user's own endpoint).
   * @param options - Platform request options (messages, systemPrompt, tools, limits).
   * @returns Normalized LLM response (text and/or tool_use blocks + token usage).
   */
  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    const start = Date.now();
    this.requestCount++;
    const wireMessages = mapMessagesToWire(options.messages, options.systemPrompt);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: wireMessages,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.tools && options.tools.length > 0) {
      body.tools = mapToolsToWire(options.tools);
      body.tool_choice = 'auto';
    }

    logger.info(
      {
        endpoint: this.endpointHost,
        model: this.model,
        messageCount: wireMessages.length,
        toolCount: options.tools?.length ?? 0,
      },
      'byo-hosted request start',
    );

    const payload = await this.postChatCompletions(body);
    const choice = payload.choices?.[0];
    const content = mapWireResponseContent(choice?.message);
    const usage = readWireUsage(payload);

    logger.info(
      {
        endpoint: this.endpointHost,
        model: payload.model ?? this.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - start,
      },
      'byo-hosted request complete',
    );

    return {
      content,
      usage,
      model: typeof payload.model === 'string' && payload.model.trim() ? payload.model : this.model,
      stopReason: choice?.finish_reason ?? undefined,
    };
  }

  /**
   * @description POST the request body to `{baseUrl}/chat/completions` with a bounded
   * timeout. Non-2xx answers become a typed error carrying the status code and a bounded
   * excerpt of the body (status digits kept in the message so quota/rate-limit failure
   * classifiers keep matching); transport failures become a typed request-failed error.
   * The api key never appears in any error or log line.
   * @param body - OpenAI chat-completions request body.
   * @returns Parsed response payload.
   */
  private async postChatCompletions(body: Record<string, unknown>): Promise<OpenAiCompletionPayload> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      logger.error({ err, endpoint: this.endpointHost, model: this.model }, 'byo-hosted transport failure');
      const cause = err instanceof Error ? err.message : String(err);
      const error = new Error(
        `byo-hosted endpoint ${this.endpointHost} request failed: ${cause}`,
      ) as Error & { code: string };
      error.code = 'BYO_HOSTED_REQUEST_FAILED';
      throw error;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const excerpt = boundedExcerpt(bodyText);
      logger.error(
        { endpoint: this.endpointHost, model: this.model, status: response.status, excerpt },
        'byo-hosted endpoint returned an error status',
      );
      const error = new Error(
        `byo-hosted endpoint ${this.endpointHost} returned HTTP ${response.status}: ${excerpt || response.statusText}`,
      ) as Error & { code: string; statusCode: number };
      error.code = 'BYO_HOSTED_HTTP_ERROR';
      error.statusCode = response.status;
      throw error;
    }

    return (await response.json()) as OpenAiCompletionPayload;
  }
}

/**
 * @description Builds a governed hosted provider for a caller-resolved connection —
 * the SAME `GovernedProvider` wrap `createProviderResolver` applies to every registry /
 * process provider before it reaches an orchestrated turn, so the BYO path gains the model
 * gateway (quota window; budget legs fail open without a pool) instead of skipping
 * governance. Callers that hold no pg pool (the chat orchestrator) pass nothing.
 * @param connection - Caller-resolved OpenAI-compatible endpoint + key + model.
 * @param pool - Optional pg pool for budget reads; null keeps budgets fail-open.
 * @returns Governed LLMService ready for `runAgenticLoop` / direct sends.
 */
export function createGovernedByoHostedProvider(
  connection: ByoHostedConnection,
  pool: Pool | null = null,
): LLMService {
  return new GovernedProvider(new ByoHostedProvider(connection), pool);
}

/**
 * @description Maps platform conversation history (+ optional system prompt) to OpenAI wire
 * messages. String turns pass through by role; block-array turns split into an assistant
 * message with `tool_calls`, `role:'tool'` results (keyed by `tool_call_id`), and plain user
 * text; `thinking` blocks never travel to the endpoint.
 * @param messages - Platform history (strings or ContentBlock arrays).
 * @param systemPrompt - Optional system prompt, emitted first.
 * @returns OpenAI chat-completions `messages` array.
 */
function mapMessagesToWire(messages: LLMMessage[], systemPrompt?: string): OpenAiChatMessage[] {
  const wire: OpenAiChatMessage[] = [];
  if (systemPrompt && systemPrompt.trim().length > 0) {
    wire.push({ role: 'system', content: systemPrompt });
  }
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (typeof message.content === 'string') {
      if (message.content.trim().length > 0) wire.push({ role, content: message.content });
      continue;
    }
    wire.push(...mapBlockMessageToWire(role, message.content));
  }
  return wire;
}

/**
 * @description Maps one block-array turn to its OpenAI wire messages (see
 * {@link mapMessagesToWire} for the shape rules). Tool results are emitted BEFORE any user
 * text so they directly follow the assistant `tool_calls` message, as the wire requires.
 * @param role - Normalized platform role of the turn.
 * @param blocks - The turn's content blocks.
 * @returns Zero or more wire messages for this turn.
 */
function mapBlockMessageToWire(role: 'user' | 'assistant', blocks: ContentBlock[]): OpenAiChatMessage[] {
  const text = blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (role === 'assistant') {
    const toolCalls: OpenAiToolCall[] = blocks
      .filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    if (!text && toolCalls.length === 0) return [];
    return [{
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }];
  }

  const wire: OpenAiChatMessage[] = blocks
    .filter((b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result')
    .map((b) => ({ role: 'tool' as const, tool_call_id: b.toolUseId, content: b.content }));
  if (text) wire.push({ role: 'user', content: text });
  return wire;
}

/**
 * @description Maps platform tool definitions to OpenAI function-calling tools.
 * @param tools - Platform tool definitions.
 * @returns OpenAI `tools` array.
 */
function mapToolsToWire(tools: LLMToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * @description Maps an OpenAI response message to platform content blocks: text (string or
 * multipart) becomes one text block; each `tool_calls` entry becomes a `tool_use` block with
 * parsed arguments. A tool call whose arguments fail to parse is skipped with a warning
 * (matching the any-bot reference) rather than fabricating an empty invocation.
 * @param message - The first choice's message, if any.
 * @returns Platform content blocks (possibly empty).
 */
function mapWireResponseContent(
  message: NonNullable<OpenAiCompletionPayload['choices']>[number]['message'],
): ContentBlock[] {
  const content: ContentBlock[] = [];
  const text = normalizeWireText(message?.content);
  if (text) content.push({ type: 'text', text });
  for (const call of message?.tool_calls ?? []) {
    const name = call.function?.name;
    if (!call.id || !name) continue;
    try {
      const parsed: unknown = JSON.parse(call.function?.arguments || '{}');
      // Valid JSON that is not a plain object ('"5"', '[]', 'null') would hand executeTool a
      // malformed input — treat it exactly like a parse failure rather than passing it through.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn({ toolName: name, shape: Array.isArray(parsed) ? 'array' : typeof parsed },
          'byo-hosted tool_call arguments were not a JSON object — call skipped');
        continue;
      }
      content.push({ type: 'tool_use', id: call.id, name, input: parsed as Record<string, unknown> });
    } catch (err) {
      logger.warn({ err, toolName: name }, 'byo-hosted tool_call arguments failed to parse — call skipped');
    }
  }
  return content;
}

/**
 * @description Normalizes string or multipart OpenAI-compatible message content to plain
 * text, without surfacing reasoning parts.
 * @param content - Raw `message.content` from the wire.
 * @returns Trimmed text ('' when none).
 */
function normalizeWireText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const p = part as { type?: string; text?: unknown; content?: unknown };
      if (p.type === 'text' || p.type === 'output_text') return String(p.text ?? p.content ?? '');
      return '';
    })
    .join('')
    .trim();
}

/**
 * @description Reads token usage from the wire payload, tolerating endpoints that omit it.
 * @param payload - Parsed chat-completions payload.
 * @returns Normalized token usage (zeros when the endpoint reports nothing).
 */
function readWireUsage(payload: OpenAiCompletionPayload): TokenUsage {
  const inputTokens = toCount(payload.usage?.prompt_tokens);
  const outputTokens = toCount(payload.usage?.completion_tokens);
  const reportedTotal = toCount(payload.usage?.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
  };
}

/**
 * @description Coerces a wire count to a non-negative integer.
 * @param value - Raw count.
 * @returns Non-negative integer (0 for anything unusable).
 */
function toCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Bounds an error body to a safe excerpt for Error messages/logs.
 * @param text - Raw response body text.
 * @returns At most {@link ERROR_BODY_EXCERPT_CHARS} characters, single-line.
 */
function boundedExcerpt(text: string): string {
  const flattened = (text || '').replace(/\s+/g, ' ').trim();
  return flattened.length > ERROR_BODY_EXCERPT_CHARS
    ? `${flattened.slice(0, ERROR_BODY_EXCERPT_CHARS)}…`
    : flattened;
}

/**
 * @description Privacy-safe endpoint label for logs and errors — hostname only, never the
 * full URL (which could embed user-info) and never credentials.
 * @param baseUrl - The connection's base URL.
 * @returns Lowercased hostname, or a generic label when unparsable.
 */
function safeEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase() || 'compatible-endpoint';
  } catch {
    return 'compatible-endpoint';
  }
}
