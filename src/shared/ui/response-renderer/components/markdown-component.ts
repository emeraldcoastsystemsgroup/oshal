/**
 * Response Renderer — the safe default `markdown` component.
 *
 * Renders a `markdown` prose block to sanitized HTML using the SAME minimal transform set the
 * chat surfaces already apply (escape first, then inline code / bold / italic / line breaks —
 * see features/chat message-renderer). Deliberately NOT a full markdown parser and deliberately
 * no new dependencies: parse-response owns the component boundary; this component keeps prose
 * readable and safe. Headings/lists/tables stay visible as plain text lines, exactly as the
 * surfaces render them today.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — DOM-free sanitized markdown prose component mirroring the surfaces' existing escape-then-transform renderer.
 *
 * @module shared/ui/response-renderer/components/markdown-component
 */

import type { MarkdownBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml } from './safe-html';

/**
 * @description Converts untrusted markdown prose to sanitized HTML: escape everything first,
 * then apply the surfaces' existing inline transforms (`` `code` ``, `**bold**`, `*italic*`,
 * newline → `<br>`). Every transform operates on already-escaped text, so no untrusted
 * character can open a tag or attribute.
 * @param text - Untrusted markdown prose.
 * @returns Sanitized HTML string ('' for empty input).
 */
export function renderMarkdownText(text: string): string {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

/**
 * @description The registered `markdown` component: wraps {@link renderMarkdownText} output in
 * the block container surfaces style (`rr-markdown`).
 */
export const markdownComponent: ResponseBlockComponent<MarkdownBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'markdown' && typeof block.text === 'string',
  render(block: MarkdownBlock): string {
    return `<div class="rr-block rr-markdown">${renderMarkdownText(block.text)}</div>`;
  },
};
