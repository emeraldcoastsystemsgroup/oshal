/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: pure ranking helpers — per-source score normalization, rank-interleaved merge with global cap + dedupe, ILIKE escaping, match-window snippets, and the ILIKE+recency fallback scorer. Pure functions on purpose: the isolation-critical adapters stay thin and THIS logic carries the unit tests.
 */

import type { SearchHit } from './search-source';

/** Recency half-life (days) for the ILIKE fallback scorer — a month-old hit scores half. */
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * @description Escape LIKE/ILIKE metacharacters (% _ \) in user query text so a query like
 * "100%" matches literally instead of becoming a wildcard. Adapters interpolate the RESULT into
 * a parameterized `ILIKE '%' || $n || '%'` pattern — this only neutralizes pattern semantics,
 * parameterization still handles injection.
 * @param raw - Raw user query text.
 * @returns The text with LIKE metacharacters backslash-escaped.
 */
export function escapeIlike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * @description Build a short excerpt centered on the first case-insensitive occurrence of the
 * query inside `text`, with ellipses marking truncation. Falls back to the head of the text when
 * the query doesn't literally occur (e.g. multi-word queries matched per-word by the store).
 * @param text - Full source text.
 * @param query - The user query to center on.
 * @param radius - Characters kept on each side of the match (default 80).
 * @returns A single-line snippet suitable for a result row.
 */
export function buildSnippet(text: string, query: string, radius = 80): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const idx = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx < 0) return flat.length <= radius * 2 ? flat : `${flat.slice(0, radius * 2)}…`;
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + query.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * @description The ILIKE+recency fallback scorer for stores with no native ranking: a base weight
 * for WHERE the match landed (title beats body) decayed by the record's age with a
 * {@link RECENCY_HALF_LIFE_DAYS}-day half-life, so a title hit from today outranks a body hit
 * from last quarter without either being pinned to 0 or 1.
 * @param matchedTitle - Whether the query matched the record's title (vs only its body).
 * @param ts - ISO timestamp of the record, or null when unknown (treated as old but not zero).
 * @param now - Clock override for tests (ms epoch).
 * @returns A score in (0, 1].
 */
export function ilikeRecencyScore(matchedTitle: boolean, ts: string | null, now = Date.now()): number {
  const base = matchedTitle ? 1.0 : 0.6;
  if (!ts) return base * 0.25;
  const ageMs = now - Date.parse(ts);
  if (!Number.isFinite(ageMs) || ageMs < 0) return base;
  const ageDays = ageMs / 86_400_000;
  return base * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * @description Normalize one source's hits to [0, 1] by dividing by the source's max score —
 * each store's native scale (RRF fusion values, cosine distances, our fallback scorer) is only
 * meaningful within itself, so cross-source comparison requires per-source normalization first.
 * @param hits - One source's hits.
 * @returns The same hits with scores scaled so the source's best hit is 1.
 */
export function normalizeScores(hits: SearchHit[]): SearchHit[] {
  const max = hits.reduce((m, h) => (h.score > m ? h.score : m), 0);
  if (max <= 0) return hits.map((h) => ({ ...h, score: 0 }));
  return hits.map((h) => ({ ...h, score: h.score / max }));
}

/**
 * @description Merge per-source result groups into one capped list: normalize each group,
 * sort each group best-first, then rank-interleave (round 0 takes every source's best, round 1
 * every source's second-best, ...) breaking ties within a round by normalized score. This keeps
 * one chatty source from monopolizing the cap while still ordering by relevance within ranks.
 * Duplicates (same source+id) are dropped, first occurrence wins.
 * @param groups - One hit array per source (any order, any native scale).
 * @param limit - Global cap on returned hits.
 * @returns The interleaved, deduped, capped result list.
 */
export function mergeRankedHits(groups: SearchHit[][], limit: number): SearchHit[] {
  const sorted = groups
    .map((g) => [...normalizeScores(g)].sort((a, b) => b.score - a.score))
    .filter((g) => g.length > 0);
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const deepest = sorted.reduce((m, g) => Math.max(m, g.length), 0);
  for (let rank = 0; rank < deepest && out.length < limit; rank++) {
    const round = sorted
      .map((g) => g[rank])
      .filter((h): h is SearchHit => Boolean(h))
      .sort((a, b) => b.score - a.score);
    for (const hit of round) {
      if (out.length >= limit) break;
      const key = `${hit.source}:${hit.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}
