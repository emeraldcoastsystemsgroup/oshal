/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove content-keyed invariant prompt caching, single-flight creation, expiry/invalidation and OpenAI-compatible request fallback without ever placing task history in the cache input.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The wire shape is now the documented `extra_body.google.cached_content`; a handle-carrying request declares no system message and no tools while the local boundary still refuses an undeclared call and executes a declared one; a first-leg rejection invalidates the handle and answers from one full send, a later-leg failure is never replayed; a refused creation is negatively cached for its TTL instead of re-paid every turn; resolve() tells a hit from a creation.
 */

import { describe, expect, it, vi } from 'vitest';

// The provider is CommonJS because the any-bot runtime must run without the TS build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpenAIProvider = require('../../any-bot/server/services/llm/OpenAIProvider');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InvariantPromptCache, buildInvariantPromptCacheKey, buildCachedPreambleExtraBody } = require('../../any-bot/server/services/llm/invariant-prompt-cache');

function completion(text = 'ready') {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

function toolCallTurn(name: string, args: Record<string, unknown>, id = 'call_1') {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

const GEMINI_COMPAT = 'https://generativelanguage.googleapis.com/v1beta/openai';
const TOOL = { name: 'conversation_query', description: 'd', inputSchema: { type: 'object', properties: {}, required: [] } };

/** A provider on the Gemini compat base with an explicit cache and a scripted client. */
function cachedProvider(cache: unknown, responses: unknown[]) {
  const provider = new OpenAIProvider({
    apiKey: 'unit-test-key', model: 'gemini-2.5-flash', baseUrl: GEMINI_COMPAT, invariantPromptCache: cache,
  });
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  provider.client.chat.completions.create = create;
  return { provider, create };
}

describe('invariant prompt cache contract', () => {
  it('keys the exact system/tool preamble and isolates credentials', () => {
    const base = {
      endpoint: GEMINI_COMPAT,
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

  it('tells a hit from a creation and negatively caches a refused creation for its TTL', async () => {
    let now = 1000;
    const create = vi.fn<[], Promise<string | null>>();
    const cache = new InvariantPromptCache({ createHandle: create, ttlMs: 10_000, negativeTtlMs: 300, now: () => now });
    const input = { key: 'k', systemPrompt: 's', tools: [], model: 'gemini', endpoint: null };

    create.mockRejectedValueOnce(Object.assign(new Error('HTTP 400'), { status: 400 }));
    expect(await cache.resolve(input)).toEqual({ handle: null, state: 'refused' });
    // Within the negative TTL the refusal is remembered: no second create round-trip.
    expect(await cache.resolve(input)).toEqual({ handle: null, state: 'refused' });
    expect(create).toHaveBeenCalledTimes(1);

    now = 1301;
    create.mockResolvedValueOnce('cachedContents/late');
    expect(await cache.resolve(input)).toEqual({ handle: 'cachedContents/late', state: 'created' });
    expect(await cache.resolve(input)).toEqual({ handle: 'cachedContents/late', state: 'hit' });
    expect(cache.peek('k')).toBe('cachedContents/late');

    // A rejection inside the chat request drops the handle AND remembers the refusal.
    cache.invalidate('k', 'rejected');
    expect(cache.peek('k')).toBeNull();
    expect(await cache.resolve(input)).toEqual({ handle: null, state: 'refused' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('emits the documented Gemini nesting for the handle', () => {
    expect(buildCachedPreambleExtraBody('cachedContents/abc')).toEqual({ google: { cached_content: 'cachedContents/abc' } });
  });

  it('uses a handle without caching task history and falls back to a full send on failure', async () => {
    const getHandle = vi.fn(async (input: { systemPrompt: string; tools: unknown[] }) => {
      expect(input.systemPrompt).toBe('invariant');
      expect(input).not.toHaveProperty('messages');
      return 'cachedContents/jarvis';
    });
    const { create } = await (async () => {
      const built = cachedProvider({ getHandle }, [completion()]);
      await built.provider.generateResponse([{ role: 'user', content: 'task A only' }], { systemPrompt: 'invariant' });
      return built;
    })();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: 'user', content: 'task A only' }],
      extra_body: { google: { cached_content: 'cachedContents/jarvis' } },
    }));

    const fallback = new OpenAIProvider({
      apiKey: 'unit-test-key',
      model: 'gemini-2.5-flash',
      invariantPromptCache: { getHandle: async () => { throw new Error('unsupported'); } },
    });
    const fallbackCreate = vi.fn(async () => completion());
    fallback.client.chat.completions.create = fallbackCreate;
    const result = await fallback.generateResponse([{ role: 'user', content: 'task B only' }], { systemPrompt: 'invariant' });
    expect(fallbackCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'system', content: 'invariant' },
        { role: 'user', content: 'task B only' },
      ],
    }));
    expect(fallbackCreate.mock.calls[0][0]).not.toHaveProperty('extra_body');
    expect(result.promptCache).toBe('none');
  });

  it('declares no tools on a handle-carrying request while the local boundary keeps enforcing', async () => {
    const cache = new InvariantPromptCache({ createHandle: async () => 'cachedContents/tools-held' });
    const execute = vi.fn(async () => ({ ok: true, result: 'executed' }));
    const { provider, create } = cachedProvider(cache, [
      toolCallTurn('execute_command', { q: 'whoami' }, 'call_bad'),
      toolCallTurn('conversation_query', { q: 'x' }, 'call_ok'),
      completion('answered'),
    ]);

    const result = await provider.generateResponse([{ role: 'user', content: 'ask' }], {
      systemPrompt: 'invariant',
      tools: [TOOL],
      enforceToolBoundary: true,
      authorizedScopes: ['tool:conversation_query'],
      executeTool: execute,
    });

    // Every leg carried the handle and none re-declared what the handle already holds.
    for (const [request] of create.mock.calls) {
      expect(request.extra_body).toEqual({ google: { cached_content: 'cachedContents/tools-held' } });
      expect(request).not.toHaveProperty('tools');
      expect(request).not.toHaveProperty('tool_choice');
      expect(request.messages[0].role).not.toBe('system');
    }
    // The undeclared call was refused, the declared one executed, exactly as with tools on the wire.
    // (The exchange mutates one messages array across legs and the mock records the reference, so
    // the conversation the LAST leg sent is where every settled call is read from.)
    const conversation = create.mock.calls.at(-1)[0].messages as Array<{ role: string; tool_call_id?: string; content: string }>;
    const refusal = conversation.find((m) => m.role === 'tool' && m.tool_call_id === 'call_bad');
    expect(String(refusal?.content)).toContain('was not offered on this request');
    const executed = conversation.find((m) => m.role === 'tool' && m.tool_call_id === 'call_ok');
    expect(String(executed?.content)).toBe('executed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('conversation_query', { q: 'x' }, { callId: 'call_ok' });
    expect(result.content).toBe('answered');
    expect(result.promptCache).toBe('created');
  });

  it('invalidates a rejected handle and answers from ONE full send', async () => {
    const cache = new InvariantPromptCache({ createHandle: async () => 'cachedContents/stale', negativeTtlMs: 60_000 });
    const rejection = Object.assign(new Error('400 CachedContent not found'), { status: 400 });
    const { provider, create } = cachedProvider(cache, [rejection, completion('full send answer')]);

    const result = await provider.generateResponse([{ role: 'user', content: 'ask' }], {
      systemPrompt: 'invariant', tools: [TOOL], enforceToolBoundary: true, authorizedScopes: [],
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].extra_body).toEqual({ google: { cached_content: 'cachedContents/stale' } });
    const full = create.mock.calls[1][0];
    expect(full).not.toHaveProperty('extra_body');
    expect(full.messages[0]).toEqual({ role: 'system', content: 'invariant' });
    expect(full.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['conversation_query']);
    expect(result.content).toBe('full send answer');
    expect(result.promptCache).toBe('fallback');
    // The rejected handle is gone and negatively cached: the next turn takes the full send directly.
    const key = buildInvariantPromptCacheKey({
      endpoint: GEMINI_COMPAT, model: 'gemini-2.5-flash', apiKey: 'unit-test-key', systemPrompt: 'invariant', tools: [TOOL],
    });
    expect(cache.peek(key)).toBeNull();
    expect(await cache.resolve({ key, systemPrompt: 'invariant', tools: [TOOL], model: 'gemini-2.5-flash', endpoint: GEMINI_COMPAT }))
      .toEqual({ handle: null, state: 'refused' });
  });

  it('never replays a later leg: a failure after a tool executed surfaces as it always did', async () => {
    const cache = new InvariantPromptCache({ createHandle: async () => 'cachedContents/live' });
    const execute = vi.fn(async () => ({ ok: true, result: 'ran once' }));
    const { provider, create } = cachedProvider(cache, [
      toolCallTurn('conversation_query', { q: 'x' }),
      new Error('502 upstream'),
      completion('must not be reached'),
    ]);

    await expect(provider.generateResponse([{ role: 'user', content: 'ask' }], {
      systemPrompt: 'invariant', tools: [TOOL], enforceToolBoundary: true,
      authorizedScopes: ['tool:conversation_query'], executeTool: execute,
    })).rejects.toThrow('502 upstream');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    // The handle is still good; nothing about a later-leg failure says the handle caused it.
    expect(cache.peek(buildInvariantPromptCacheKey({
      endpoint: GEMINI_COMPAT, model: 'gemini-2.5-flash', apiKey: 'unit-test-key', systemPrompt: 'invariant', tools: [TOOL],
    }))).toBe('cachedContents/live');
  });
});
