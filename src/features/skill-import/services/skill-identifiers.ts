/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic slug / agent-id / keyword derivation for skill import — stable across runs (no Date/random) so re-import is idempotent.
 */

import { createHash } from 'node:crypto';

/** UUID prefix reserved for imported bots — mirrors codex-packer's `b0000000-` convention so ids never collide with the standing registry. */
const IMPORTED_AGENT_PREFIX = 'b0000000-0000-0000-0000-';

/** Common English stopwords dropped when mining routing keywords from a description. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'when', 'use', 'used', 'using', 'your', 'you',
  'are', 'was', 'has', 'have', 'from', 'into', 'onto', 'a', 'an', 'of', 'to', 'in', 'on', 'or',
  'is', 'it', 'its', 'as', 'at', 'by', 'be', 'can', 'will', 'they', 'them', 'their', 'any', 'all',
]);

/**
 * @description Normalises an arbitrary name into a safe OSHAL slug: lowercase, non-alnum → hyphen,
 * collapsed and trimmed, capped at 64 chars. Deterministic.
 * @param name - the source skill name (or any string)
 * @returns a hyphen-case slug (may be empty if the input has no alnum chars)
 */
export function slugify(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * @description Derives a deterministic, collision-avoidant agent UUID from a slug via sha256,
 * using the reserved imported-bot prefix. Same slug → same id (idempotent re-import).
 * @param slug - the skill slug
 * @returns a UUID-shaped id `b0000000-0000-0000-0000-<12 hex>`
 */
export function deriveAgentId(slug: string): string {
  const hex = createHash('sha256').update(`skill-import:${slug}`).digest('hex').slice(0, 12);
  return `${IMPORTED_AGENT_PREFIX}${hex}`;
}

/**
 * @description Mines routing keywords from free text (name + description): lowercased tokens,
 * stopwords and <=2-char tokens dropped, de-duplicated, first-seen order, capped at `max`.
 * Deterministic — no frequency sort ties to break.
 * @param text - the source text to mine
 * @param max - maximum keywords to return (default 8)
 * @returns the mined keyword list
 */
export function mineKeywords(text: string, max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length <= 2 || STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @description Derives capability tags from the skill slug + description — the slug's hyphen
 * segments plus a couple of mined keywords, always including the `imported-skill` marker so
 * imported bots are auditable as a class. Capped at 5.
 * @param slug - the skill slug
 * @param description - the skill description
 * @returns 1-5 capability tags including `imported-skill`
 */
export function deriveCapabilities(slug: string, description: string): string[] {
  const fromSlug = slug.split('-').filter(s => s.length > 2);
  const fromDesc = mineKeywords(description, 3);
  const tags = new Set<string>(['imported-skill', ...fromSlug, ...fromDesc]);
  return [...tags].slice(0, 5);
}
