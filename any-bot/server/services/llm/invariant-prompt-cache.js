/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Content-keyed, expiry-aware provider cache contract for an invariant system/tool preamble. The cache never receives task messages, and a failed or unsupported provider cache falls back to a full prompt.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Negative caching, hit/created state and the Gemini wire shape. A refused or failed creation used to delete the entry, so an endpoint that refuses caching paid a create round-trip on EVERY turn; it is now remembered for a bounded negative TTL. resolve() reports whether the handle was reused or freshly created so the call log can say which. invalidate(key, 'rejected') records the same negative marker when the chat request itself refused the handle, so one bad handle does not become create-then-fail on every following turn. buildCachedPreambleExtraBody emits the documented Gemini OpenAI-compatible shape, `extra_body.google.cached_content`, in one place.
 */

const crypto = require('crypto');

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

/**
 * @description Build a non-secret cache key from the exact provider/prompt/tool contract. The
 * credential is hashed only to keep a provider cache handle from crossing API-key boundaries.
 * @param {{endpoint?: string|null, model: string, apiKey?: string, systemPrompt: string, tools?: unknown}} input
 * @returns {string} Stable content key safe to log and persist.
 */
function buildInvariantPromptCacheKey(input) {
  const credential = input.apiKey
    ? crypto.createHash('sha256').update(input.apiKey).digest('hex')
    : 'no-credential';
  const material = canonicalize({
    endpoint: input.endpoint || null,
    model: input.model,
    credential,
    systemPrompt: input.systemPrompt,
    tools: input.tools || [],
  });
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/**
 * @description The request field that carries a provider-side cache handle on Gemini's
 * OpenAI-compatible surface. Google documents the nesting as `extra_body.google.cached_content`
 * (ai.google.dev/gemini-api/docs/openai); the Node SDK sends `extra_body` through verbatim, so
 * this is exactly what reaches the wire.
 * @param {string} handle - A `cachedContents/{id}` resource name.
 * @returns {{google: {cached_content: string}}} The extra_body value.
 */
function buildCachedPreambleExtraBody(handle) {
  return { google: { cached_content: handle } };
}

/** Default lifetime of a positive entry; kept under Gemini's default one-hour cache TTL. */
const DEFAULT_TTL_MS = 55 * 60 * 1000;
/** Default lifetime of a negative (refused / failed creation) marker. */
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60 * 1000;

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * @description Small single-flight cache for provider-created handles. It is intentionally
 * provider-neutral: an adapter can create a provider cache handle, while an endpoint
 * without context caching returns null and keeps the ordinary full-send path. Expired handles are
 * never returned, concurrent first requests share one creation promise, and a refused or failed
 * creation is remembered for a bounded negative TTL so the refusal is not re-paid on every turn.
 */
class InvariantPromptCache {
  /** @param {{apiKey?: string, createHandle?: (input: object) => Promise<string|null>|string|null, ttlMs?: number, negativeTtlMs?: number, now?: () => number}} [options] */
  constructor(options = {}) {
    this.apiKey = options.apiKey || null;
    this.createHandle = options.createHandle || null;
    this.ttlMs = positiveMs(options.ttlMs, DEFAULT_TTL_MS);
    this.negativeTtlMs = positiveMs(options.negativeTtlMs, DEFAULT_NEGATIVE_TTL_MS);
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
  }

  /**
   * @description The live handle for a key, or null. Never creates and never returns an expired
   * or negatively cached entry.
   * @param {string} key - The content key.
   * @returns {string|null} The handle when one is current.
   */
  peek(key) {
    const existing = this.entries.get(key);
    return existing?.handle && existing.expiresAt > this.now() ? existing.handle : null;
  }

  /**
   * @description Resolve a handle and say how it was obtained, so a caller can log a hit apart
   * from a creation. `refused` means a recent creation was refused or failed and the negative
   * marker is still live; `none` means no factory or a null creation.
   * @param {{key: string, systemPrompt: string, tools: unknown[], model: string, endpoint: string|null, apiKey?: string}} input
   * @returns {Promise<{handle: string|null, state: 'hit'|'created'|'refused'|'none'}>}
   */
  async resolve(input) {
    const live = this.peek(input.key);
    if (live) return { handle: live, state: 'hit' };
    const existing = this.entries.get(input.key);
    if (existing?.refusedUntil && existing.refusedUntil > this.now()) return { handle: null, state: 'refused' };
    if (existing?.pending) return existing.pending;
    if (!this.createHandle) return { handle: null, state: 'none' };
    const pending = Promise.resolve()
      .then(() => this.createHandle(input))
      .then((handle) => this.remember(input.key, handle))
      .catch(() => this.refuse(input.key));
    this.entries.set(input.key, { pending });
    return pending;
  }

  /**
   * @param {{key: string, systemPrompt: string, tools: unknown[], model: string, endpoint: string|null, apiKey?: string}} input
   * @returns {Promise<string|null>} The handle, or null when the ordinary full send applies.
   */
  async getHandle(input) {
    return (await this.resolve(input)).handle;
  }

  /**
   * @description Store a freshly created handle for the positive TTL. A blank or non-string
   * answer is treated as a refusal, so a factory that quietly returns nothing is not re-run
   * on every turn either.
   * @param {string} key - The content key.
   * @param {unknown} handle - What the factory returned.
   * @returns {{handle: string|null, state: string}} The resolution to hand back.
   */
  remember(key, handle) {
    if (typeof handle !== 'string' || handle.trim().length === 0) return this.refuse(key);
    this.entries.set(key, { handle, expiresAt: this.now() + this.ttlMs });
    return { handle, state: 'created' };
  }

  /**
   * @description Remember a refused or failed creation for the negative TTL, so the next turns
   * in that window take the full-send path without paying another create round-trip.
   * @param {string} key - The content key.
   * @returns {{handle: null, state: 'refused'}} The resolution to hand back.
   */
  refuse(key) {
    this.entries.set(key, { refusedUntil: this.now() + this.negativeTtlMs });
    return { handle: null, state: 'refused' };
  }

  /**
   * @description Drop a key. With reason `'rejected'` (the provider refused the handle inside a
   * chat request) the key is also negatively cached, so the next turns take the full-send path
   * instead of creating and failing again.
   * @param {string} key - The content key.
   * @param {'rejected'} [reason] - Why the entry is being dropped.
   */
  invalidate(key, reason) {
    this.entries.delete(key);
    if (reason === 'rejected') this.refuse(key);
  }
}

module.exports = {
  InvariantPromptCache,
  buildCachedPreambleExtraBody,
  buildInvariantPromptCacheKey,
};
