/**
 * Response Renderer — the `code` fenced-block component.
 *
 * Renders a fenced code block as an escaped `<pre><code>` pair carrying the surfaces' existing
 * `code-block` class plus a `language-<lang>` hook, mirroring the markup features/chat
 * message-renderer already emits so existing chat CSS (and any highlighter a surface wires
 * later) applies unchanged. The language string is untrusted too: it is escaped AND whitelisted
 * down to `[a-z0-9+#._-]` before it becomes part of a class name.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — DOM-free sanitized fenced-code component reusing the surfaces' code-block markup contract.
 *
 * @module shared/ui/response-renderer/components/code-component
 */

import type { CodeBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { cleanText, escapeHtml } from './safe-html';

/**
 * @description Reduces an untrusted fence info string to a safe class-name token. Anything
 * outside the conservative charset is dropped, so a hostile "language" can never break out of
 * the class attribute or inject a selector-significant character.
 * @param lang - Untrusted fence info string (e.g. `python`, `oshal:chart`).
 * @returns Lowercase token matching `[a-z0-9+#._-]*` (max 32 chars).
 */
export function safeLanguageToken(lang: string): string {
  return cleanText(lang, 64).toLowerCase().replace(/[^a-z0-9+#._-]/g, '').slice(0, 32);
}

/**
 * @description The registered `code` component: escaped `<pre class="code-block rr-code">`
 * with a `language-*` class for highlighter hooks.
 */
export const codeComponent: ResponseBlockComponent<CodeBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'code' && typeof block.code === 'string' && typeof block.lang === 'string',
  render(block: CodeBlock): string {
    const token = safeLanguageToken(block.lang);
    const languageClass = token ? ` language-${token}` : '';
    return `<pre class="code-block rr-block rr-code"><code class="rr-code-body${languageClass}">${escapeHtml(block.code, 100_000)}</code></pre>`;
  },
};
