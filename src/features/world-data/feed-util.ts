/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extract pure feed helpers (hash/slug/date/lexicon) from news-fetcher so they're unit-testable without the Claude provider import
 */

/**
 * Pure feed helpers — no network, no LLM, no @/ side-effect imports — so they unit-test in isolation
 * (news-fetcher itself instantiates the Claude provider at module load). See ADR-061.
 */
import { createHash } from 'crypto';

/** Minimal item shape for hashing (avoids importing FeedItem → news-fetcher → the Claude provider). */
export interface HashableItem { outlet: string; title: string; link: string; }

/**
 * Stable per-ENTITY content hash for dedup + archive identity. Scoped to the entity so the SAME article
 * relevant to two subjects gets a sentiment point for EACH (a global hash would suppress the second).
 */
export function itemHash(entityId: string, it: HashableItem): string {
  // Strip the query string + fragment before hashing the link: Bing (and others) append per-request
  // tracking params (?...), so the SAME article gets a different URL each pull and dedup misses it.
  const link = (it.link || '').replace(/[?#].*$/, '').toLowerCase();
  return createHash('sha1').update(`${entityId}|${it.outlet}|${it.title}|${link}`.toLowerCase()).digest('hex');
}

/** Stable slug for an extracted entity name (lowercase, alnum-hyphen, capped). '' if nothing usable. */
export function slugifyEntity(name: string): string {
  return ((name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)) || '';
}

/** Parse an RSS pubDate to ISO, or null if absent/unparseable. */
export function pubIso(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Lexicon fallback — ONLY used if the Claude call genuinely fails. Real sentiment comes from the swarm creds.
const POS = ['surge', 'soar', 'beat', 'growth', 'win', 'record', 'strong', 'gain', 'rally', 'breakthrough', 'success', 'approve', 'boost', 'rise', 'profit', 'optimis', 'upgrade'];
const NEG = ['plunge', 'fall', 'miss', 'loss', 'weak', 'decline', 'lawsuit', 'scandal', 'probe', 'crash', 'cut', 'layoff', 'fraud', 'warn', 'drop', 'slump', 'risk', 'fear', 'concern', 'antitrust', 'downgrade'];

/** Crude lexicon sentiment in [-1,1] — the fallback when the LLM classification call fails. */
export function lexicon(text: string): number {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of POS) if (t.includes(w)) s += 1;
  for (const w of NEG) if (t.includes(w)) s -= 1;
  return Math.max(-1, Math.min(1, s / 3));
}
