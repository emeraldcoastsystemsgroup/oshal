/**
 * Response Renderer — DOM-free safe-HTML primitives.
 *
 * Every concrete component in this directory renders UNTRUSTED bot output. The rule is
 * sanitized construction only: markup is composed exclusively from literal tags plus values
 * that passed through {@link escapeHtml}. No component may interpolate a raw string into
 * markup, and no surface should ever hand this module's output back through another parser.
 * Mirrors the escape-then-compose vocabulary the existing surfaces already use
 * (features/chat message-renderer, visual-response SVG primitives) without touching the DOM,
 * so the components stay unit-testable under vitest's node environment.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — escapeHtml/cleanText/truncate primitives for the concrete response-renderer components.
 *
 * @module shared/ui/response-renderer/components/safe-html
 */

/**
 * @description Strips control characters (except tab/newline) and caps length so hostile or
 * degenerate bot output cannot smuggle terminal-style control bytes or megabyte cells into a
 * bubble. Applied before every escape.
 * @param value - Untrusted text (coerced to string; null/undefined become '').
 * @param maximum - Hard cap on retained characters.
 * @returns Cleaned text no longer than `maximum`.
 */
export function cleanText(value: unknown, maximum: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maximum);
}

/**
 * @description Escapes the five HTML/XML significant characters. This is the ONLY path by which
 * untrusted text may enter component markup — attribute values and text content alike.
 * @param value - Untrusted text.
 * @param maximum - Length cap forwarded to {@link cleanText} (default 20k).
 * @returns HTML-safe text usable in both element content and double-quoted attributes.
 */
export function escapeHtml(value: unknown, maximum = 20_000): string {
  return cleanText(value, maximum).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] as string);
}

/**
 * @description Truncates with an ellipsis so axis labels / legends stay readable. Runs cleanText
 * first; callers still escape the result before interpolating it.
 * @param value - Untrusted text.
 * @param maximum - Maximum characters retained (ellipsis included).
 * @returns Truncated clean text.
 */
export function truncate(value: unknown, maximum: number): string {
  const clean = cleanText(value, 2_000);
  return clean.length <= maximum ? clean : `${clean.slice(0, Math.max(1, maximum - 1))}…`;
}

/**
 * @description Rounds to 2 decimals for stable, deterministic SVG coordinates.
 * @param value - Coordinate value.
 * @returns Rounded value.
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
