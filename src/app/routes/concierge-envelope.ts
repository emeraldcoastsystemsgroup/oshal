/**
 * Concierge envelope parsing — the shared, fragile bit every concierge surface depends on.
 *
 * The per-app concierges (Spotify, Movies, and the Eats/Rides pattern) ask their bot to reply
 * with ONLY a JSON object, then parse it out of whatever the model actually returned — which may
 * be fenced (```json … ```), wrapped in prose, or malformed. This module owns that extraction so
 * it lives in ONE place, is unit-tested, and degrades safely (a bad reply becomes a plain-text
 * "say", never a thrown error that drops the turn).
 *
 * Pure functions only — no imports, no I/O — so it's trivially testable and carries no module graph.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from spotify-routes.ts +
 *            | movies-routes.ts (identical inline logic) into one tested helper. Adds vitest cover.
 * ---------------------------------------------------------------------------
 * @module concierge-envelope
 */

/**
 * @description Pull the first balanced-ish JSON object out of an LLM reply. Tolerates a
 * ```json fenced block and surrounding prose; returns the parsed object, or null if there's no
 * usable object (caller then falls back to treating the whole text as a spoken reply).
 */
export function extractEnvelopeJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1));
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Coerce any value to a clean string[] (drops empties); non-arrays → []. */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.length > 0) : [];
}

/** The envelope's spoken reply, or the supplied fallback when absent/blank. */
export function sayOr(o: Record<string, unknown> | null, fallback: string): string {
  const say = o && typeof o.say === 'string' ? o.say : '';
  return say.trim() ? say : fallback;
}
