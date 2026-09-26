/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove content-keyed invariant prompt caching, single-flight creation, expiry/invalidation and OpenAI-compatible request fallback without ever placing task history in the cache input.
 */

import { describe, expect, it, vi } from 'vitest';

// The provider is CommonJS because the any-bot runtime must run without the TS build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenAIProvider = require('../../any-bot/server/services/llm/OpenAIProvider');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InvariantPromptCache, buildInvariantPromptCacheKey } = require('../../any-bot/server/services/llm/invariant-prompt-cache');

function completion() {
  return {
    choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

describe('invariant prompt cache contract', () => {
  it('keys the exact system/tool preamble and isolates credentials', () => {
    const base = {
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash',
      systemPrompt: 'stable system',
      tools: [{ name: 'conversation_query', inputSchema: { type: 'object' } }],
    };
    expect(buildInvariantPromptCacheKey({ ...base, apiKey: 'one' }))
      .toBe(buildInvariantPromptCacheKey({ ...base, apiKey: 'one' }));
    expect(buildInvariantPromptCacheKey({ ...base, apiKey: 'two' }))
      .not.toBe(buildInvariantPromptCacheKey({ ...base, apiKey: 'one' }));
    expect(buildInvariantPromptCacheKey({ ...base, systemPrompt: 'changed' }))
      .not.toBe(buildInvariantPromptCacheKey(base));
    expect(buildInvariantPromptCacheKey({ ...base, tools: [] }))
      .not.toBe(buildInvariantPromptCacheKey(base));
  });

  it('single-flights creation and expires or invalidates handles', async () => {
    let now = 100;
    const create = vi.fn(async () => 'cachedContents/one');
    const cache = new InvariantPromptCache({ createHandle: create, ttlMs: 50, now: () => now });
    const input = { key: 'same', systemPrompt: 'stable', tools: [], model: 'gemini', endpoint: null };
    await expect(Promise.all([cache.getHandle(input), cache.getHandle(input)])).resolves.toEqual([
      'cachedContents/one', 'cachedContents/one',
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await cache.getHandle(input)).toBe('cachedContents/one');
    now = 151;
    create.mockResolvedValueOnce('cachedContents/two');
    expect(await cache.getHandle(input)).toBe('cachedContents/two');
    cache.invalidate(input.key);
    create.mockResolvedValueOnce('cachedContents/three');
    expect(await cache.getHandle(input)).toBe('cachedContents/three');
  });

  it('uses a handle without caching task history and falls back to a full send on failure', async () => {
    const getHandle = vi.fn(async (input: { systemPrompt: string; tools: unknown[] }) => {
      expect(input.systemPrompt).toBe('invariant');
      expect(input).not.toHaveProperty('messages');
      return 'cachedContents/jarvis';
    });
    const provider = new OpenAIProvider({
      apiKey: 'unit-test-key',
      model: 'gemini-2.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      invariantPromptCache: { getHandle, apiKey: 'unit-test-key' },
    });
    const create = vi.fn(async () => completion());
    provider.client.chat.completions.create = create;
    await provider.generateResponse([{ role: 'user', content: 'task A only' }], { systemPrompt: 'invariant' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: 'task A only' }],
      extra_body: { cached_content: 'cachedContents/jarvis' },
    }));

    const fallback = new OpenAIProvider({
      apiKey: 'unit-test-key',
      model: 'gemini-2.5-flash',
      invariantPromptCache: { getHandle: async () => { throw new Error('unsupported'); } },
    });
    const fallbackCreate = vi.fn(async () => completion());
    fallback.client.chat.completions.create = fallbackCreate;
    await fallback.generateResponse([{ role: 'user', content: 'task B only' }], { systemPrompt: 'invariant' });
    expect(fallbackCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'system', content: 'invariant' },
        { role: 'user', content: 'task B only' },
      ],
    }));
    expect(fallbackCreate.mock.calls[0][0]).not.toHaveProperty('extra_body');
  });
});
