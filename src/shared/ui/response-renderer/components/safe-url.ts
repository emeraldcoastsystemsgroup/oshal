/**
 * Response Renderer — DOM-free safe-URL allowlist.
 *
 * The image/link components (`oshal:gallery`, `oshal:download`) put UNTRUSTED bot-supplied URLs
 * into `src`/`href` attributes. `escapeHtml` alone stops an attribute breakout but NOT a
 * `javascript:` / `vbscript:` scheme, which carries no HTML-significant character — so a scheme
 * allowlist is required before the value ever reaches markup. This module is that allowlist:
 * fail-closed, allow-list not deny-list, so a novel hostile scheme is rejected by default.
 * Composed alongside {@link escapeHtml} (validate the scheme here, escape the value there) — never
 * a substitute for it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — scheme-allowlist URL sanitizer for the gallery/download response-renderer components (https/http/root-relative/data:image only, fail-closed).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fix: the root-relative check only blocked a second `/`, so `/\host` slipped through — WHATWG special-scheme browsers normalize `\`→`/` in the authority, resolving `/\evil.com` to protocol-relative `//evil.com` (off-origin load / open redirect on bot-supplied gallery/download URLs). Now backslashes are normalized to `/` before the check AND a root-relative candidate is rejected when its second char is `/` or `\`.
 *
 * @module shared/ui/response-renderer/components/safe-url
 */

import { cleanText } from './safe-html';

const MAX_URL_CHARS = 4_096;

/**
 * @description Validates an untrusted URL against a strict scheme allowlist. Fail-closed: returns
 * null for anything not on the allowlist (including `javascript:`, `vbscript:`, `file:`, and
 * protocol-relative `//host`). All whitespace is stripped first so a `java\tscript:` style
 * obfuscation cannot slip a rejected scheme past the prefix check. The returned string is still
 * UNESCAPED — callers MUST pass it through {@link escapeHtml} before placing it in an attribute.
 * @param value - Untrusted URL text (coerced to string; null/undefined become '').
 * @returns The cleaned URL when it uses an allowed scheme, or null to trigger the block fallback.
 */
export function safeUrl(value: unknown): string | null {
  // Normalize backslashes to `/` FIRST: browsers treat `\` as `/` in a URL authority, so an
  // un-normalized `/\host` would read as protocol-relative `//host` (off-origin) in the DOM.
  const raw = cleanText(value, MAX_URL_CHARS).replace(/\s+/g, '').replace(/\\/g, '/');
  if (!raw) return null;
  // Root-relative only when the SECOND char is neither `/` nor (now-normalized) `\` — i.e. not
  // protocol-relative `//host`. `raw[1]` is undefined for a bare "/", which is a safe root path.
  if (raw.startsWith('/') && raw[1] !== '/') return raw;
  const lower = raw.toLowerCase();
  if (lower.startsWith('https://') || lower.startsWith('http://')) return raw;
  if (lower.startsWith('data:image/')) return raw;
  return null;
}
