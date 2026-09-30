/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the measurement plumbing behind the invariant prompt cache: the OpenAI-compatible adapter folds the endpoint-reported cached-token count into usage and prints input/output/cached tokens plus the cache state on its call log line; the extracted direct-path metrics fold carries the split into apiMetrics (and never NaN); the bot-node handler bills and relays that split through recordCost and the HTTP usage block while a total-only result keeps the legacy mapping.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Guard central bot-node cost resolution: a real nonzero provider total wins unchanged, a zero-cost Cline/Gemini result is estimated from the shared registry with its input/output split, and an unknown model remains zero. Runtime attribution remains cline-cli even when Gemini supplies the pricing identity.
 */

import { describe, expect, it, vi } from 'vitest';
import { createBotNodeExecutionHandler, resolveExecutionUsage } from '../../src/app/bot-node-execution-handler';

/* eslint-disable @typescript-eslint/no-require-imports */
const OpenAIProvider = require('../../any-bot/server/services/llm/OpenAIProvider');
const { InvariantPromptCache } = require('../../any-bot/server/services/llm/invariant-prompt-cache');
const { mergeDirectResponseMetrics } = require('../../any-bot/server/utils/direct-response-metrics');
const anyBotLogger = require('../../any-bot/server/utils/logger');
/* eslint-enable @typescript-eslint/no-require-imports */

const GEMINI_COMPAT = 'https://generativelanguage.googleapis.com/v1beta/openai';

function completion(text: string, usage: Record<string, unknown>) {
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage };
}

describe('OpenAI-compatible adapter: cached tokens reach usage and the call log', () => {
  it('folds prompt_tokens_details.cached_tokens into cacheReads and logs the split with the cache state', async () => {
    const cache = new InvariantPromptCache({ createHandle: async () => 'cachedContents/warm' });
    const provider = new OpenAIProvider({ apiKey: 'unit-test-key', model: 'gemini-2.5-flash', baseUrl: GEMINI_COMPAT, invariantPromptCache: cache });
    provider.client.chat.completions.create = vi.fn(async () => completion('ready', {
      prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 900 },
    }));
    const info = vi.spyOn(anyBotLogger, 'info').mockImplementation(() => anyBotLogger);
    try {
      // Warm the handle first so this turn is a hit, not a creation.
      await provider.generateResponse([{ role: 'user', content: 'warm' }], { systemPrompt: 'invariant' });
      const result = await provider.generateResponse([{ role: 'user', content: 'ask' }], { systemPrompt: 'invariant' });
      expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 20, totalTokens: 1020, cacheCreationTokens: 0, cacheReads: 900 });
      expect(result.promptCache).toBe('hit');
      const line = info.mock.calls.map((call) => String(call[0])).find((m) => m.includes('invariant cache hit'));
      expect(line).toContain('1020 tokens (input 1000, output 20, cached 900), invariant cache hit');
    } finally {
      info.mockRestore();
    }
  });

  it('reports cacheReads 0 and state none when the endpoint reports no cached tokens and no cache applies', async () => {
    const provider = new OpenAIProvider({ apiKey: 'unit-test-key', model: 'gpt-4o-mini', invariantPromptCache: null });
    provider.client.chat.completions.create = vi.fn(async () => completion('ready', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }));
    const result = await provider.generateResponse([{ role: 'user', content: 'ask' }], { systemPrompt: 'invariant' });
    expect(result.usage.cacheReads).toBe(0);
    expect(result.promptCache).toBe('disabled');
  });
});

describe('direct-path metrics fold', () => {
  it('carries the input/output split, the cached count and the cache state into apiMetrics', () => {
    const folded = mergeDirectResponseMetrics({ totalTokens: 5, requestCount: 1, cacheHits: 0 }, {
      usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020, cacheReads: 900 }, cost: 0.5, promptCache: 'hit',
    });
    expect(folded).toEqual({
      totalTokens: 1025, totalCost: 0.5, requestCount: 2, inputTokens: 1000, outputTokens: 20,
      cacheReads: 900, cacheHits: 1, promptCache: 'hit',
    });
    // A second turn accumulates rather than replaces.
    const again = mergeDirectResponseMetrics(folded, { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReads: 0 }, promptCache: 'none' });
    expect(again).toMatchObject({ totalTokens: 1135, inputTokens: 1100, outputTokens: 30, cacheReads: 900, cacheHits: 1, requestCount: 3, promptCache: 'none' });
  });

  it('keeps a total-only legacy response readable and never produces NaN', () => {
    expect(mergeDirectResponseMetrics({}, { usage: { totalTokens: 50 }, cost: 0 })).toEqual({
      totalTokens: 50, totalCost: 0, requestCount: 1, inputTokens: 0, outputTokens: 0, cacheReads: 0, cacheHits: 0,
    });
    expect(mergeDirectResponseMetrics(undefined, { usage: { inputTokens: 7, outputTokens: 3 } })).toMatchObject({ totalTokens: 10 });
    expect(mergeDirectResponseMetrics({ totalTokens: 'bad' }, { usage: {} })).toEqual({
      totalTokens: 0, totalCost: 0, requestCount: 1, inputTokens: 0, outputTokens: 0, cacheReads: 0, cacheHits: 0,
    });
  });
});

describe('bot-node handler: the split is billed and relayed', () => {
  function handlerWith(
    apiMetrics: Record<string, unknown>,
    executionIdentity: { provider?: string; apiProvider?: string; model?: string } = {},
  ) {
    const recordCost = vi.fn(async () => undefined);
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => ({ id: 'ticket-usage' })),
        createTask: vi.fn(async () => ({ id: 'ticket-usage' })),
        processMessage: vi.fn(async () => ({
          messages: [{ say: 'completion_result', text: 'Done.' }],
          apiMetrics,
          ...executionIdentity,
        })),
      },
      providerName: 'byo-llm',
      modelName: 'fixture-unpriced-model',
      recordCost,
    });
    const envelope = {
      correlationId: 'correlation-usage', fromAgentId: 'swarm-controller', toAgentId: 'jarvis',
      channel: 'swarm.agent.jarvis', payload: { text: 'Ask.', direct: true, workspaceTaskId: 'ticket-usage' },
    };
    return { handler, recordCost, envelope };
  }

  it('bills inputTokens/outputTokens from the split and relays the cached count on the response', async () => {
    const { handler, recordCost, envelope } = handlerWith({ totalTokens: 1020, inputTokens: 1000, outputTokens: 20, cacheReads: 900, totalCost: 0, promptCache: 'hit' });
    const result = await handler(envelope);
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 1000, outputTokens: 20 }));
    expect(result).toMatchObject({ success: true, output: { usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020, cacheReadTokens: 900, cacheWriteTokens: 0 } } });
  });

  it('keeps the legacy total-as-input mapping when the runtime reports only a total', async () => {
    const { handler, recordCost, envelope } = handlerWith({ totalTokens: 42, totalCost: 0.01 });
    const result = await handler(envelope);
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 42,
      outputTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0.01,
    }));
    expect(result).toMatchObject({ output: {
      cost: 0.01,
      usage: { inputTokens: 42, outputTokens: 0, totalTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } });
  });

  it('estimates zero-cost Cline-backed Gemini usage from the shared catalog', async () => {
    const { handler, recordCost, envelope } = handlerWith(
      { totalTokens: 25, inputTokens: 20, outputTokens: 5, totalCost: 0 },
      { provider: 'cline-cli', apiProvider: 'gemini', model: 'gemini-3.8-flash' },
    );
    const result = await handler(envelope);
    const event = recordCost.mock.calls[0]?.[0];
    expect(event).toMatchObject({ providerId: 'cline-cli', modelId: 'gemini-3.8-flash' });
    expect(event?.inputCost).toBeCloseTo(0.000015, 12);
    expect(event?.outputCost).toBeCloseTo(0.00001875, 12);
    expect(event?.totalCost).toBeCloseTo(0.00003375, 12);
    expect((result.output as { cost: number }).cost).toBeCloseTo(0.00003375, 12);
  });

  it('keeps zero cost for an unknown Gemini model instead of inventing a rate', async () => {
    const { handler, recordCost, envelope } = handlerWith(
      { totalTokens: 25, inputTokens: 20, outputTokens: 5, totalCost: 0 },
      { provider: 'cline-cli', apiProvider: 'gemini', model: 'gemini-future-unpriced' },
    );
    const result = await handler(envelope);
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'cline-cli',
      modelId: 'gemini-future-unpriced',
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
    }));
    expect(result).toMatchObject({ output: { cost: 0 } });
  });

  it('resolveExecutionUsage derives a total from the split when none was reported', () => {
    expect(resolveExecutionUsage({ inputTokens: 7, outputTokens: 3 })).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(resolveExecutionUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
