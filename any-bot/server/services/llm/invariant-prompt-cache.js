/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Content-keyed, expiry-aware provider cache contract for an invariant system/tool preamble. The cache never receives task messages, and a failed or unsupported provider cache falls back to a full prompt.
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
 * @description Small single-flight cache for provider-created handles. It is intentionally
 * provider-neutral: an adapter can create a provider cache handle, while an endpoint
 * without context caching returns null and keeps the ordinary full-send path. Expired handles are
 * never returned, and concurrent first requests share one creation promise.
 */
class InvariantPromptCache {
  /** @param {{apiKey?: string, createHandle?: (input: object) => Promise<string|null>|string|null, ttlMs?: number, now?: () => number}} [options] */
  constructor(options = {}) {
    this.apiKey = options.apiKey || null;
    this.createHandle = options.createHandle || null;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 55 * 60 * 1000;
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
  }

  /** @param {{key: string, systemPrompt: string, tools: unknown[], model: string, endpoint: string|null}} input @returns {Promise<string|null>} */
  async getHandle(input) {
    const existing = this.entries.get(input.key);
    if (existing?.handle && existing.expiresAt > this.now()) return existing.handle;
    if (existing?.pending) return existing.pending;
    if (!this.createHandle) return null;
    const pending = Promise.resolve(this.createHandle(input)).then((handle) => {
      this.entries.delete(input.key);
      if (typeof handle !== 'string' || handle.trim().length === 0) return null;
      this.entries.set(input.key, { handle, expiresAt: this.now() + this.ttlMs });
      return handle;
    }).catch(() => {
      this.entries.delete(input.key);
      return null;
    });
    this.entries.set(input.key, { pending });
    return pending;
  }

  /** @param {string} key */
  invalidate(key) { this.entries.delete(key); }
}

module.exports = { InvariantPromptCache, buildInvariantPromptCacheKey };
