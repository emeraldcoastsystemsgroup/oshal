/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the Gemini context-cache adapter: the native base is derived only from the Gemini compat path shape; the cachedContents body holds the system instruction and function declarations and never a task turn; the API key travels in a header, never the URL or body; a refusal throws with its status and a nameless answer throws; the env kill switch and TTL parsing; the default cache resolution hands out ONE shared instance for Gemini and none for any other endpoint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  buildCachedContentBody,
  createGeminiCachedContent,
  getSharedInvariantPromptCache,
  readInvariantPromptCacheSettings,
  resetSharedInvariantPromptCache,
  resolveDefaultInvariantPromptCache,
  resolveGeminiNativeBase,
  toFunctionDeclarations,
} = require('../../any-bot/server/services/llm/gemini-context-cache');
const { InvariantPromptCache } = require('../../any-bot/server/services/llm/invariant-prompt-cache');
/* eslint-enable @typescript-eslint/no-require-imports */

const GEMINI_COMPAT = 'https://generativelanguage.googleapis.com/v1beta/openai';
const TOOL = {
  name: 'conversation_query',
  description: 'Search the caller\'s own conversations.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

/** A fetch double that records the one call it receives and answers from the script. */
function fetchDouble(status: number, json: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
  });
  return { impl, calls };
}

afterEach(() => {
  resetSharedInvariantPromptCache();
  vi.unstubAllEnvs();
});

describe('Gemini native base resolution', () => {
  it('derives the native API base from the Gemini compat path and nothing else', () => {
    expect(resolveGeminiNativeBase(GEMINI_COMPAT)).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(resolveGeminiNativeBase(`${GEMINI_COMPAT}/`)).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(resolveGeminiNativeBase('http://127.0.0.1:4010/v1beta/openai')).toBe('http://127.0.0.1:4010/v1beta');
    expect(resolveGeminiNativeBase('https://openrouter.ai/api/v1')).toBeNull();
    expect(resolveGeminiNativeBase('https://api.openai.com/v1')).toBeNull();
    expect(resolveGeminiNativeBase('http://oshal.example.com:11434/v1')).toBeNull();
    expect(resolveGeminiNativeBase(null)).toBeNull();
    expect(resolveGeminiNativeBase('not a url')).toBeNull();
  });
});

describe('cachedContents create body', () => {
  it('holds the system instruction and the declared tools, and no task turn', () => {
    const body = buildCachedContentBody({
      model: 'gemini-2.5-flash', systemPrompt: 'You are an OSHAL agent.', tools: [TOOL], ttlSeconds: 3360,
    });
    expect(body).toEqual({
      model: 'models/gemini-2.5-flash',
      systemInstruction: { parts: [{ text: 'You are an OSHAL agent.' }] },
      tools: [{ functionDeclarations: [{
        name: 'conversation_query',
        description: 'Search the caller\'s own conversations.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }] }],
      ttl: '3360s',
    });
    expect(body).not.toHaveProperty('contents');
    expect(JSON.stringify(body)).not.toContain('role');
  });

  it('omits tools when none are declared and keeps an existing models/ prefix', () => {
    const body = buildCachedContentBody({ model: 'models/gemini-2.5-flash', systemPrompt: 's', tools: [], ttlSeconds: 60.9 });
    expect(body.model).toBe('models/gemini-2.5-flash');
    expect(body).not.toHaveProperty('tools');
    expect(body.ttl).toBe('60s');
    expect(toFunctionDeclarations([{ name: '' }, null, { name: 'ok' }])).toEqual([
      { name: 'ok', description: '', parameters: { type: 'object', properties: {}, required: [] } },
    ]);
  });
});

describe('cachedContents creation over HTTP', () => {
  it('posts to the native base with the key in a header and returns the resource name', async () => {
    const { impl, calls } = fetchDouble(200, { name: 'cachedContents/abc123', model: 'models/gemini-2.5-flash' });
    const handle = await createGeminiCachedContent({
      nativeBase: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'unit-test-key',
      model: 'gemini-2.5-flash', systemPrompt: 'invariant', tools: [TOOL], ttlSeconds: 3360, fetchImpl: impl,
    });
    expect(handle).toBe('cachedContents/abc123');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/cachedContents');
    expect(calls[0].url).not.toContain('unit-test-key');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('unit-test-key');
    expect(String(calls[0].init.body)).not.toContain('unit-test-key');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'models/gemini-2.5-flash', ttl: '3360s' });
  });

  it('throws with the status on a refusal and on an answer without a resource name', async () => {
    const refused = fetchDouble(400, { error: { message: 'Cached content is too small.' } });
    await expect(createGeminiCachedContent({
      nativeBase: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: 'gemini-2.5-flash',
      systemPrompt: 'short', tools: [], fetchImpl: refused.impl,
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('HTTP 400') });

    const nameless = fetchDouble(200, { model: 'models/gemini-2.5-flash' });
    await expect(createGeminiCachedContent({
      nativeBase: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k', model: 'gemini-2.5-flash',
      systemPrompt: 's', tools: [], fetchImpl: nameless.impl,
    })).rejects.toThrow('no resource name');
  });
});

describe('settings and the shared default cache', () => {
  it('reads the kill switch and the TTLs from the environment with bounded fallbacks', () => {
    expect(readInvariantPromptCacheSettings({})).toEqual({ enabled: true, ttlSeconds: 3300, negativeTtlSeconds: 300 });
    for (const off of ['off', 'false', '0', 'DISABLED']) {
      expect(readInvariantPromptCacheSettings({ OSHAL_INVARIANT_PROMPT_CACHE: off }).enabled).toBe(false);
    }
    expect(readInvariantPromptCacheSettings({
      OSHAL_INVARIANT_PROMPT_CACHE: 'on', OSHAL_INVARIANT_PROMPT_CACHE_TTL_SECONDS: '120',
      OSHAL_INVARIANT_PROMPT_CACHE_NEGATIVE_TTL_SECONDS: 'nope',
    })).toEqual({ enabled: true, ttlSeconds: 120, negativeTtlSeconds: 300 });
  });

  it('resolves ONE shared cache for the Gemini compat surface and none for other endpoints', () => {
    const first = resolveDefaultInvariantPromptCache(GEMINI_COMPAT);
    expect(first).toBeInstanceOf(InvariantPromptCache);
    expect(resolveDefaultInvariantPromptCache('http://127.0.0.1:4010/v1beta/openai')).toBe(first);
    expect(getSharedInvariantPromptCache()).toBe(first);
    expect(resolveDefaultInvariantPromptCache('https://openrouter.ai/api/v1')).toBeNull();
    expect(resolveDefaultInvariantPromptCache(null)).toBeNull();
  });

  it('honours the kill switch', () => {
    vi.stubEnv('OSHAL_INVARIANT_PROMPT_CACHE', 'off');
    expect(resolveDefaultInvariantPromptCache(GEMINI_COMPAT)).toBeNull();
  });

  it('the shared factory refuses (and negatively caches) an endpoint it cannot create against', async () => {
    const cache = getSharedInvariantPromptCache();
    const key = 'no-native-base';
    // A non-Gemini endpoint never reaches the network: the factory answers null, which is refused.
    expect(await cache.resolve({ key, endpoint: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', systemPrompt: 's', tools: [] }))
      .toEqual({ handle: null, state: 'refused' });
    // And a Gemini endpoint with no credential is refused before any request is built.
    expect(await cache.resolve({ key: 'no-key', endpoint: GEMINI_COMPAT, model: 'm', systemPrompt: 's', tools: [] }))
      .toEqual({ handle: null, state: 'refused' });
  });
});
