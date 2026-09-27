/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Gemini context-cache adapter for the invariant prompt cache seam. Creates a `cachedContents` resource over the system instruction and the declared function declarations only (never a user or assistant turn) against the native API base derived from the OpenAI-compatible base URL, with a bounded TTL and the API key in a request header. Exports one process-shared InvariantPromptCache so every OpenAIProvider built for a Gemini compat endpoint reuses the same handle, keyed by preamble content plus a credential fingerprint. An env kill switch turns the default off; any non-Gemini endpoint resolves to no cache at all.
 */

const logger = require('../../utils/logger');
const { InvariantPromptCache } = require('./invariant-prompt-cache');

/** The path suffix Google publishes for its OpenAI-compatible surface. */
const GEMINI_COMPAT_PATH = /\/v1beta\/openai\/?$/i;
/** The trailing segment that turns the compat path into the native `/v1beta` base. */
const COMPAT_SEGMENT = /\/openai\/?$/i;

/** Seconds the provider is asked to keep a cache. Defaults just above the local positive TTL. */
const DEFAULT_TTL_SECONDS = 55 * 60;
/** Seconds a refused or failed creation is remembered before another attempt. */
const DEFAULT_NEGATIVE_TTL_SECONDS = 5 * 60;
/** Seconds added to the provider TTL so the local entry always expires first. */
const PROVIDER_TTL_MARGIN_SECONDS = 60;

/**
 * @description The native Gemini API base behind an OpenAI-compatible base URL, or null when the
 * URL is not the Gemini compat surface. `https://host/v1beta/openai` becomes `https://host/v1beta`;
 * the same shape on any host (a loopback fixture, a mirror) is treated identically because the
 * path is what identifies the surface.
 * @param {string|null|undefined} baseUrl - The provider's OpenAI-compatible base URL.
 * @returns {string|null} The native base without a trailing slash.
 */
function resolveGeminiNativeBase(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  try {
    const url = new URL(baseUrl);
    if (!GEMINI_COMPAT_PATH.test(url.pathname)) return null;
    const nativePath = url.pathname.replace(COMPAT_SEGMENT, '');
    return `${url.origin}${nativePath}`;
  } catch {
    return null;
  }
}

/**
 * @description Translate the harness tool definitions into Gemini function declarations. The
 * same name/description/inputSchema triple the chat request would have declared, so the cached
 * tool set is exactly the boundary's declared set.
 * @param {Array<{name: string, description?: string, inputSchema?: object}>} tools - Declared tools.
 * @returns {Array<{name: string, description: string, parameters: object}>} Function declarations.
 */
function toFunctionDeclarations(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name.length > 0)
    .map((tool) => ({
      name: tool.name,
      description: String(tool.description || ''),
      parameters: tool.inputSchema || { type: 'object', properties: {}, required: [] },
    }));
}

/** @param {string} model @returns {string} The `models/<id>` resource name Gemini expects. */
function toModelResource(model) {
  const id = String(model || '').trim();
  return id.startsWith('models/') ? id : `models/${id}`;
}

/**
 * @description The exact `cachedContents` create body for one invariant preamble. Only the system
 * instruction and function declarations enter it; task messages never do.
 * @param {{model: string, systemPrompt: string, tools?: unknown[], ttlSeconds: number}} input
 * @returns {object} The JSON body.
 */
function buildCachedContentBody(input) {
  const functionDeclarations = toFunctionDeclarations(input.tools);
  return {
    model: toModelResource(input.model),
    systemInstruction: { parts: [{ text: String(input.systemPrompt) }] },
    ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
    ttl: `${Math.max(1, Math.floor(input.ttlSeconds))}s`,
  };
}

/**
 * @description Create a Gemini cached-content resource and return its handle. The API key travels
 * in the `x-goog-api-key` header and never in the URL or body, so it is absent from any URL log.
 * @param {{nativeBase: string, apiKey: string, model: string, systemPrompt: string, tools?: unknown[], ttlSeconds?: number, fetchImpl?: typeof fetch}} input
 * @returns {Promise<string>} The `cachedContents/{id}` resource name.
 * @throws {Error} With `status` set when the endpoint refuses the creation.
 */
async function createGeminiCachedContent(input) {
  const doFetch = input.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('fetch is not available for cachedContents creation');
  const body = buildCachedContentBody({
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    ttlSeconds: input.ttlSeconds || DEFAULT_TTL_SECONDS + PROVIDER_TTL_MARGIN_SECONDS,
  });
  const response = await doFetch(`${input.nativeBase}/cachedContents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': input.apiKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`cachedContents creation refused with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const json = await response.json();
  if (!json || typeof json.name !== 'string' || !json.name.startsWith('cachedContents/')) {
    throw new Error('cachedContents creation returned no resource name');
  }
  return json.name;
}

/** @param {string|undefined} raw @param {number} fallback @returns {number} */
function parseSeconds(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @description Read the cache settings from the environment. `OSHAL_INVARIANT_PROMPT_CACHE`
 * set to `off`, `false` or `0` is the kill switch; the two TTLs are seconds.
 * @param {NodeJS.ProcessEnv} [env] - The environment to read; defaults to process.env.
 * @returns {{enabled: boolean, ttlSeconds: number, negativeTtlSeconds: number}} The settings.
 */
function readInvariantPromptCacheSettings(env = process.env) {
  const flag = String(env.OSHAL_INVARIANT_PROMPT_CACHE || '').trim().toLowerCase();
  return {
    enabled: !['off', 'false', '0', 'disabled'].includes(flag),
    ttlSeconds: parseSeconds(env.OSHAL_INVARIANT_PROMPT_CACHE_TTL_SECONDS, DEFAULT_TTL_SECONDS),
    negativeTtlSeconds: parseSeconds(
      env.OSHAL_INVARIANT_PROMPT_CACHE_NEGATIVE_TTL_SECONDS, DEFAULT_NEGATIVE_TTL_SECONDS,
    ),
  };
}

/**
 * @description The handle factory the shared cache runs. It needs the provider's own credential
 * on the input (never the cache's), so one process-wide cache serves many BYO keys, each keyed to
 * its own credential fingerprint by buildInvariantPromptCacheKey.
 * @param {{ttlSeconds: number}} settings - The active settings.
 * @returns {(input: {endpoint: string|null, apiKey?: string, model: string, systemPrompt: string, tools: unknown[]}) => Promise<string|null>}
 */
function buildGeminiHandleFactory(settings) {
  return async (input) => {
    const nativeBase = resolveGeminiNativeBase(input.endpoint);
    if (!nativeBase || !input.apiKey) return null;
    try {
      const handle = await createGeminiCachedContent({
        nativeBase,
        apiKey: input.apiKey,
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        ttlSeconds: settings.ttlSeconds + PROVIDER_TTL_MARGIN_SECONDS,
      });
      logger.info(`Invariant prompt cache created for ${input.model} (${(input.tools || []).length} tool(s) held provider-side)`);
      return handle;
    } catch (error) {
      logger.warn(`Invariant prompt cache creation refused for ${input.model}: ${error.message}`, {
        model: input.model, status: error.status || null,
      });
      throw error;
    }
  };
}

let shared = null;

/**
 * @description The one process-shared cache. Built lazily from the environment on first use so a
 * test can reset it and a deployment can change the TTLs without a code change.
 * @returns {InvariantPromptCache} The shared cache.
 */
function getSharedInvariantPromptCache() {
  if (!shared) {
    const settings = readInvariantPromptCacheSettings();
    shared = new InvariantPromptCache({
      createHandle: buildGeminiHandleFactory(settings),
      ttlMs: settings.ttlSeconds * 1000,
      negativeTtlMs: settings.negativeTtlSeconds * 1000,
    });
  }
  return shared;
}

/**
 * @description Forget the shared cache and its handles. Tests use it between cases; nothing in
 * the runtime calls it.
 * @returns {void}
 */
function resetSharedInvariantPromptCache() {
  shared = null;
}

/**
 * @description The cache an OpenAIProvider should use by default for a base URL: the shared
 * Gemini cache when the URL is the Gemini compat surface and the kill switch is not set,
 * otherwise null (ordinary full send).
 * @param {string|null|undefined} baseUrl - The provider's OpenAI-compatible base URL.
 * @returns {InvariantPromptCache|null} The cache, or null.
 */
function resolveDefaultInvariantPromptCache(baseUrl) {
  if (!resolveGeminiNativeBase(baseUrl)) return null;
  if (!readInvariantPromptCacheSettings().enabled) return null;
  return getSharedInvariantPromptCache();
}

module.exports = {
  buildCachedContentBody,
  createGeminiCachedContent,
  getSharedInvariantPromptCache,
  readInvariantPromptCacheSettings,
  resetSharedInvariantPromptCache,
  resolveDefaultInvariantPromptCache,
  resolveGeminiNativeBase,
  toFunctionDeclarations,
};
