/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Direct OpenAI Chat Completions for Haven — bypasses Cline CLI
 *                     |                           | Uses OAuth token from ~/.cline/data/secrets.json
 *                     |                           | Supports dispatch_to_swarm function calling for swarm dispatch
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added havenGoogleChat() using Gemini 1.5 Flash via GOOGLE_API_KEY
 *                     |                           | GOOGLE_API_KEY is set in container — fast path, no quota issues
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { governLlmCall } from '@/features/llm-provider';

const logger = createChildLogger({ module: 'haven-direct-llm' });

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
// Haven calls the OpenAI chat completions API directly, so the fallback must be
// a valid OpenAI *chat* model — not the codex CLI model (gpt-5.3-codex), which
// the chat API rejects.
const HAVEN_MODEL = process.env.LLM_MODEL ?? 'gpt-4o';

const SECRETS_PATH = path.join(
  process.env.HOME ?? '/root',
  '.cline/data/secrets.json',
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenAiCredentials {
  access_token: string;
  refresh_token?: string;
  expires?: number;
  accountId?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  error?: { message: string; type: string };
}

/**
 * @description Shape of a swarm dispatch request produced when the model invokes the
 * dispatch_to_swarm tool, carrying the work item the user implicitly asked Haven to perform.
 */
export interface DispatchRequest {
  title: string;
  description: string;
  priority?: 'low' | 'medium' | 'high';
}

/**
 * @description Result returned from a Haven LLM call: the conversational text reply and,
 * when the model chose to delegate work, an optional swarm dispatch request.
 */
export interface HavenLlmResult {
  text: string;
  dispatch?: DispatchRequest;
}

// ── Credentials ───────────────────────────────────────────────────────────────

/**
 * @description Reads and parses the OpenAI OAuth access token from the Cline secrets file.
 * Token format: secrets.json['openai-codex-oauth-credentials'] is a JSON string
 * containing { access_token, refresh_token, expires, accountId }.
 */
function readCredentials(): OpenAiCredentials | null {
  try {
    if (!fs.existsSync(SECRETS_PATH)) {
      logger.warn({ path: SECRETS_PATH }, 'Haven: Cline secrets file not found');
      return null;
    }

    const raw = fs.readFileSync(SECRETS_PATH, 'utf-8');
    const secrets = JSON.parse(raw) as Record<string, unknown>;
    const credsRaw = secrets['openai-codex-oauth-credentials'];

    if (typeof credsRaw !== 'string') {
      logger.warn('Haven: openai-codex-oauth-credentials not found in secrets');
      return null;
    }

    const creds = JSON.parse(credsRaw) as OpenAiCredentials;

    if (!creds.access_token) {
      logger.warn('Haven: access_token missing from OAuth credentials');
      return null;
    }

    return creds;
  } catch (err) {
    logger.error({ err }, 'Haven: failed to read OpenAI OAuth credentials');
    return null;
  }
}

// ── Tool definition for swarm dispatch ────────────────────────────────────────

const DISPATCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'dispatch_to_swarm',
    description:
      'Creates a background work request for tasks that need execution. Use this when the user asks to build, create, write, analyze, send, schedule, research, or do anything that requires actual work to be done. The user never sees the ticket — just dispatch silently and give a brief, natural acknowledgment in your response.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Concise task title, under 80 characters.',
        },
        description: {
          type: 'string',
          description:
            'Full description of what needs to be done, including any context from the conversation.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Task priority. Default is medium.',
        },
      },
      required: ['title', 'description'],
    },
  },
};

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * @description Calls the OpenAI Chat Completions API directly using the OAuth token.
 * Bypasses Cline CLI entirely — Haven is a chat interface, not an agentic coding bot.
 *
 * When enableDispatch is true, includes the dispatch_to_swarm tool definition.
 * If the model decides to dispatch, returns result.dispatch populated.
 * Otherwise returns result.text with the conversational reply.
 *
 * @param systemPrompt - Combined Haven persona + home context block
 * @param messages - Conversation history + current user message
 * @param enableDispatch - Whether to include the swarm dispatch tool
 * @returns Text reply and optional dispatch request
 */
// ── Google Gemini path ────────────────────────────────────────────────────────

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content: {
      parts: GeminiPart[];
      role: string;
    };
    finishReason: string;
  }>;
  error?: { message: string; code: number };
}

/**
 * @description Calls Google Gemini 1.5 Flash via the REST API using GOOGLE_API_KEY.
 * Fast (1-3s), no billing setup required on free tier, key already set in container.
 *
 * @param systemPrompt - Combined Haven persona + home context block
 * @param messages - Conversation history + current user message
 * @returns Text reply
 */
export async function havenGoogleChat(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<HavenLlmResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Haven: GOOGLE_API_KEY not set in environment');
  }

  const geminiModel = process.env.HAVEN_GOOGLE_MODEL ?? 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  // Convert messages: OpenAI assistant → Gemini model
  const contents: GeminiContent[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const requestBody = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  logger.info(
    { model: geminiModel, messageCount: contents.length },
    'Haven: calling Gemini directly',
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error({ status: response.status, body: errText.slice(0, 400) }, 'Haven: Gemini API error');
    throw new Error(`Gemini API responded ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as GeminiResponse;

  if (data.error) {
    throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
  }

  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();

  logger.info({ replyLength: text.length }, 'Haven: Gemini reply ready');

  return { text };
}

// ── OpenAI path (legacy — hits 429 without real OPENAI_API_KEY) ───────────────

/**
 * @description Calls the OpenAI Chat Completions API directly using the Cline OAuth token,
 * bypassing the Cline CLI. When dispatch is enabled and the model invokes dispatch_to_swarm,
 * returns a populated dispatch request; otherwise returns the conversational text reply.
 * Legacy path that hits HTTP 429 without a real OPENAI_API_KEY.
 *
 * @param systemPrompt - Combined Haven persona and home context block sent as the system message.
 * @param messages - Conversation history plus the current user message.
 * @param enableDispatch - Whether to include the dispatch_to_swarm tool so the model may delegate work.
 * @returns The text reply and an optional swarm dispatch request.
 */
export async function havenLlmChat(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  enableDispatch: boolean,
): Promise<HavenLlmResult> {
  const creds = readCredentials();

  if (!creds) {
    throw new Error(
      'Haven: OpenAI OAuth credentials not available. Complete the OpenAI Codex OAuth flow at /api/openai-codex/oauth/login.',
    );
  }

  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // LLM governance gate (ADR: model gateway). No-op unless OSHAL_LLM_BUDGETS is on; when on it can
  // deny the call (budget/quota) or downshift the model (cost-aware routing). This is the dispatch
  // chokepoint the gateway was built for. Scope 'global' keyed by feature keeps it deployment-wide.
  const governed = await governLlmCall({ requestedModel: HAVEN_MODEL, scope: 'global', key: 'haven' });
  if (!governed.allowed) {
    throw new Error(`Haven: LLM call denied by governance gate (${governed.reason}).`);
  }
  const modelToUse = governed.model;

  const requestBody: Record<string, unknown> = {
    model: modelToUse,
    messages: chatMessages,
    max_tokens: 1024,
    temperature: 0.7,
  };

  if (enableDispatch) {
    requestBody.tools = [DISPATCH_TOOL];
    requestBody.tool_choice = 'auto';
  }

  logger.info(
    { model: modelToUse, downshiftedFrom: governed.downshiftedFrom, messageCount: chatMessages.length, enableDispatch },
    'Haven: calling OpenAI Chat Completions directly',
  );

  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${creds.access_token}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error({ status: response.status, body: errText.slice(0, 400) }, 'Haven: OpenAI API error');
    throw new Error(`OpenAI API responded ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as ChatCompletionResponse;

  // Surface any API-level errors embedded in 200 responses
  if (data.error) {
    logger.error({ apiError: data.error }, 'Haven: OpenAI API returned error object');
    throw new Error(`OpenAI API error: ${data.error.message}`);
  }

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error('Haven: OpenAI returned no choices');
  }

  // ── Handle function/tool call (dispatch_to_swarm) ──────────────────────────
  if (choice.message.tool_calls?.length) {
    const toolCall = choice.message.tool_calls[0];

    if (toolCall.function.name === 'dispatch_to_swarm') {
      try {
        const args = JSON.parse(toolCall.function.arguments) as DispatchRequest;
        logger.info({ title: args.title, priority: args.priority ?? 'medium' }, 'Haven: dispatch_to_swarm tool called');
        return { text: '', dispatch: args };
      } catch (parseErr) {
        logger.error({ err: parseErr, raw: toolCall.function.arguments }, 'Haven: failed to parse dispatch arguments');
        // Fall through to text extraction
      }
    }
  }

  // ── Standard text reply ────────────────────────────────────────────────────
  const text = (choice.message.content ?? '').trim();

  logger.info({ replyLength: text.length, finishReason: choice.finish_reason }, 'Haven: reply ready');

  return { text };
}