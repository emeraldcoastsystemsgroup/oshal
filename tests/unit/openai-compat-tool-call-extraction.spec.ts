/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the OpenAI-compatible adapter dropping a paid turn that came back as a tool call. Every response fixture here was CAPTURED from generativelanguage.googleapis.com on 2026-09-22 while reproducing the live Jarvis failure; the empty-turn case is the exact shape the operator hit (choice with no finish_reason, message whose only key is role). Covers the other providers routed through this same adapter so the fix cannot regress a vendor that works today.
 */

import { describe, expect, it, vi } from 'vitest';

const OpenAIProvider = require('../../any-bot/server/services/llm/OpenAIProvider');
const logger = require('../../any-bot/server/utils/logger');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

/** A provider whose HTTP client is replaced by a scripted queue of captured responses. */
function providerWith(responses: unknown[], config: Record<string, unknown> = {}) {
  const provider = new OpenAIProvider({
    apiKey: 'unit-test-not-a-real-credential',
    model: 'gemini-2.5-flash',
    baseUrl: GEMINI_BASE,
    ...config,
  });
  const create = vi.fn(async () => {
    if (!responses.length) throw new Error('the adapter made more calls than the fixture scripted');
    return responses.shift();
  });
  provider.client = { chat: { completions: { create } } };
  return { provider, create };
}

const ask = [{ role: 'user', content: 'Read README.md and tell me what this project is.' }];
const askOptions = {
  systemPrompt: 'You are an OSHAL agent, a helpful AI coding assistant with full Cline capabilities. '
    + 'You have access to 17 tools including file operations and DevOps CLI tools.',
  maxTokens: 4096,
  temperature: 0.7,
};

/**
 * CAPTURED LIVE (gemini-2.5-flash and gemini-3.8-flash, 2026-09-22): the assistant message has no
 * `content` key at all — only `role` and `tool_calls`. The text extractor sees undefined and the
 * pre-fix adapter threw EMPTY_FINAL_ANSWER on a billed completion.
 */
const TOOL_CALLS_ONLY = {
  choices: [{
    finish_reason: 'tool_calls',
    index: 0,
    message: {
      role: 'assistant',
      tool_calls: [{
        id: 'function-call-12359270223919593867',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    },
  }],
  usage: { prompt_tokens: 98, completion_tokens: 17, total_tokens: 155 },
};

/**
 * CAPTURED LIVE (gemini-3.8-flash, 2026-09-22): the gateway filtered a malformed function call.
 * There is no text, no tool call and no id to answer — only the finish reason names what happened.
 */
const MALFORMED_FUNCTION_CALL = {
  choices: [{
    finish_reason: 'function_call_filter: MALFORMED_FUNCTION_CALL',
    index: 0,
    message: { role: 'assistant', extra_content: { google: {} } },
  }],
  usage: { prompt_tokens: 111, completion_tokens: 14, total_tokens: 125 },
};

/**
 * CAPTURED LIVE (gemini-2.5-flash, 2026-09-22) — the operator's own failure shape. The choice
 * carries NO finish_reason and the message's only key is `role`. Nothing is recoverable here.
 */
const GENUINELY_EMPTY = {
  choices: [{ index: 0, message: { role: 'assistant' } }],
  usage: { prompt_tokens: 6843, completion_tokens: 0, total_tokens: 6843 },
};

/** A plain text answer, the shape every provider that works today returns. */
function textAnswer(text: string, usage = { prompt_tokens: 61, completion_tokens: 142, total_tokens: 271 }) {
  return { choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: text } }], usage };
}

describe('OpenAI-compatible adapter: a turn spent on a tool call is not dropped', () => {
  it('extracts an answer when the model returned ONLY tool calls and no text', async () => {
    const { provider, create } = providerWith([
      TOOL_CALLS_ONLY,
      textAnswer('I cannot read README.md — no tools are available on this turn.',
        { prompt_tokens: 165, completion_tokens: 79, total_tokens: 244 }),
    ]);

    const result = await provider.generateResponse(ask, askOptions);

    expect(result.content).toBe('I cannot read README.md — no tools are available on this turn.');
    // The calls are surfaced, not silently swallowed.
    expect(result.contentBlocks).toEqual([
      { type: 'tool_use', id: 'function-call-12359270223919593867', name: 'read_file', input: { path: 'README.md' } },
      { type: 'text', text: 'I cannot read README.md — no tools are available on this turn.' },
    ]);
    // Both legs are billed, so both legs are reported.
    expect(result.usage).toMatchObject({ inputTokens: 263, outputTokens: 96, totalTokens: 399 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('completes the tool exchange the protocol way and never offers tools of its own', async () => {
    const { provider, create } = providerWith([TOOL_CALLS_ONLY, textAnswer('Answered directly.')]);

    await provider.generateResponse(ask, askOptions);

    const first = create.mock.calls[0][0];
    const second = create.mock.calls[1][0];
    // The adapter declares no tools — which is WHY any returned call is unsolicited.
    expect(first.tools).toBeUndefined();
    expect(second.tools).toBeUndefined();
    // The continuation replays the assistant turn and answers each call by id.
    const toolTurn = second.messages[second.messages.length - 1];
    expect(toolTurn.role).toBe('tool');
    expect(toolTurn.tool_call_id).toBe('function-call-12359270223919593867');
    expect(JSON.parse(toolTurn.content)).toMatchObject({ error: 'no_tools_available' });
    expect(second.messages[second.messages.length - 2]).toMatchObject({ role: 'assistant' });
  });

  it('recovers a gateway-filtered MALFORMED_FUNCTION_CALL, which leaves no call id to answer', async () => {
    const { provider, create } = providerWith([
      MALFORMED_FUNCTION_CALL,
      textAnswer('I cannot inspect the workspace without tools.'),
    ]);

    const result = await provider.generateResponse(ask, { ...askOptions }, );

    expect(result.content).toBe('I cannot inspect the workspace without tools.');
    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1][0];
    const last = second.messages[second.messages.length - 1];
    // No tool_call_id exists, so the constraint is restated as a user turn instead.
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/No tools are available in this request/);
  });

  it('reads a call left in the deprecated function_call field, not just tool_calls', async () => {
    const legacy = {
      choices: [{
        finish_reason: 'function_call',
        index: 0,
        message: { role: 'assistant', function_call: { name: 'list_directory', arguments: '{}' } },
      }],
      usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
    };
    const { provider } = providerWith([legacy, textAnswer('Nothing to list without tools.')]);

    const result = await provider.generateResponse(ask, askOptions);

    expect(result.contentBlocks[0]).toMatchObject({ type: 'tool_use', name: 'list_directory', input: {} });
    expect(result.content).toBe('Nothing to list without tools.');
  });
});

describe('OpenAI-compatible adapter: an unanswerable turn fails honestly', () => {
  it('names provider, model and the ABSENT finish reason, and does not retry blindly', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { provider, create } = providerWith([GENUINELY_EMPTY]);

      const error = await provider.generateResponse(ask, askOptions).then(
        () => null, (e: Error & { code?: string }) => e,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error!.code).toBe('EMPTY_FINAL_ANSWER');
      expect(error!.message).toContain('gemini-2.5-flash');
      expect(error!.message).toContain('generativelanguage.googleapis.com');
      // The pre-fix adapter defaulted an absent finish_reason to "stop", which is what made the
      // operator's log read like a normal completion.
      expect(error!.message).toContain('(absent)');
      expect(error!.message).toContain('0 output token(s)');
      // Nothing recoverable was in the response, so nothing is replayed.
      expect(create).toHaveBeenCalledTimes(1);

      // The structural fingerprint reaches the MESSAGE, because the console transport drops metadata.
      const shapeLine = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('response shape'));
      expect(shapeLine).toBeDefined();
      expect(shapeLine).toContain('"messageKeys":["role"]');
      expect(shapeLine).toContain('"contentType":"undefined"');
      // Content-free: the prompt and the credential never appear in a diagnostic.
      expect(shapeLine).not.toContain('README.md');
      expect(shapeLine).not.toContain('unit-test-not-a-real-credential');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the retryability contract free-tier rotation matches on', async () => {
    const { provider } = providerWith([GENUINELY_EMPTY]);
    const error = await provider.generateResponse(ask, askOptions).then(
      () => null, (e: Error & { code?: string }) => e,
    );

    // free-tier-rotation.ts tests `${code} ${message}` against RETRYABLE_PROVIDER_FAILURE.
    const retryable = /(?:\b(?:402|403|429)\b|too many requests|rate[-\s]?limit|quota|throttl\w*|resourceexhausted|empty_final_answer|returned no final answer)/i;
    expect(retryable.test(`${error!.code} ${error!.message}`)).toBe(true);
  });

  it('still fails when the continuation also produces nothing', async () => {
    const { provider, create } = providerWith([TOOL_CALLS_ONLY, GENUINELY_EMPTY]);

    const error = await provider.generateResponse(ask, askOptions).then(
      () => null, (e: Error & { code?: string }) => e,
    );

    expect(error!.code).toBe('EMPTY_FINAL_ANSWER');
    expect(error!.message).toContain('1 tool call(s) and no text');
    // Exactly one continuation — never a loop.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('falls through to the honest error when the continuation itself throws', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'unit-test-not-a-real-credential', model: 'gemini-2.5-flash', baseUrl: GEMINI_BASE,
    });
    let call = 0;
    provider.client = { chat: { completions: { create: vi.fn(async () => {
      call += 1;
      if (call === 1) return TOOL_CALLS_ONLY;
      throw new Error('400 tool messages are not accepted without a tools array');
    }) } } };

    const error = await provider.generateResponse(ask, askOptions).then(
      () => null, (e: Error & { code?: string }) => e,
    );

    expect(error!.code).toBe('EMPTY_FINAL_ANSWER');
    expect(error!.message).toContain('gemini-2.5-flash');
  });
});

describe('OpenAI-compatible adapter: the providers that work today are untouched', () => {
  it.each([
    ['OpenAI', undefined, 'gpt-4o-mini', 'api.openai.com'],
    ['Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile', 'api.groq.com'],
    ['DeepSeek', 'https://api.deepseek.com', 'deepseek-chat', 'api.deepseek.com'],
    ['OpenRouter', 'https://openrouter.ai/api/v1', 'model:free', 'openrouter.ai'],
  ])('%s: a plain text answer is returned on ONE call, with no continuation', async (
    _name, baseUrl, model, endpoint,
  ) => {
    const { provider, create } = providerWith(
      [textAnswer('The project is a multi-agent orchestration platform.')],
      { model, ...(baseUrl ? { baseUrl } : { baseUrl: undefined }) },
    );

    const result = await provider.generateResponse(ask, askOptions);

    expect(result.content).toBe('The project is a multi-agent orchestration platform.');
    expect(result.contentBlocks).toEqual([
      { type: 'text', text: 'The project is a multi-agent orchestration platform.' },
    ]);
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toMatchObject({ inputTokens: 61, outputTokens: 142, totalTokens: 271 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(provider.endpointLabel).toBe(endpoint);
  });

  it('normalizes a multipart content array without a continuation', async () => {
    const multipart = {
      choices: [{
        finish_reason: 'stop',
        index: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Multipart ' }, { type: 'text', text: 'answer.' }] },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
    const { provider, create } = providerWith([multipart]);

    const result = await provider.generateResponse(ask, askOptions);

    expect(result.content).toBe('Multipart answer.');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a model that answers in text AND requests a tool keeps its text, with no extra call', async () => {
    const both = {
      choices: [{
        finish_reason: 'tool_calls',
        index: 0,
        message: {
          role: 'assistant',
          content: 'Let me look that up.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    };
    const { provider, create } = providerWith([both]);

    const result = await provider.generateResponse(ask, askOptions);

    expect(result.content).toBe('Let me look that up.');
    expect(result.contentBlocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
      { type: 'text', text: 'Let me look that up.' },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('honours an endpoint-reported total_tokens rather than assuming input + output', async () => {
    // Google counts thinking tokens in total_tokens but NOT in completion_tokens, so the reported
    // total is legitimately larger than the two parts (captured live: 61 + 142 != 271).
    const { provider } = providerWith([textAnswer('ok')]);
    const result = await provider.generateResponse(ask, askOptions);
    expect(result.usage.totalTokens).toBe(271);
  });
});
