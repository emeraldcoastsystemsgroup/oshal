/**
 * Response Renderer — standard component set + one-call HTML pipeline.
 *
 * `createStandardResponseRegistry()` wires the concrete components this slice ships (markdown,
 * code, mermaid, oshal:chart, oshal:table, oshal:map, oshal:gallery, oshal:download) into one
 * exact-key registry, and
 * `renderResponseHtml()` is the whole segment→dispatch→compose pipeline as a single call a
 * surface makes: parseResponse → renderBlocks → join, with a sanitized plain-text fallback for
 * every block that failed validation, has no component, or is capability-filtered. The result
 * is a sanitized-by-construction HTML string a surface may assign to a bubble.
 * (`artifact:image` is deliberately NOT registered here — types.ts makes URL/provenance
 * validation a surface responsibility, so image rendering stays surface-owned.)
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — standard registry (markdown/code/mermaid/oshal:chart/oshal:table) + renderResponseHtml pipeline with sanitized fallbacks.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Register the oshal:map / oshal:gallery / oshal:download typed-block components so the standard registry covers the operator north-star kinds beyond chart+table.
 *
 * @module shared/ui/response-renderer/components/standard-registry
 */

import { ResponseComponentRegistry, createResponseComponentRegistry } from '../component-registry';
import { hasRichBlocks, parseResponse } from '../parse-response';
import type { RenderableResponseBlock, ResponseRenderOptions } from '../types';
import { chartComponent } from './chart-component';
import { codeComponent } from './code-component';
import { downloadComponent } from './download-component';
import { galleryComponent } from './gallery-component';
import { mapComponent } from './map-component';
import { markdownComponent, renderMarkdownText } from './markdown-component';
import { mermaidComponent } from './mermaid-component';
import { escapeHtml } from './safe-html';
import { tableComponent } from './table-component';

/**
 * @description Builds the registry with every concrete component this slice ships. Surfaces
 * with extra typed components register them on the returned instance before rendering.
 * @returns A registry whose components emit sanitized HTML strings.
 */
export function createStandardResponseRegistry(): ResponseComponentRegistry<void, string> {
  return createResponseComponentRegistry<void, string>()
    .register('markdown', markdownComponent)
    .register('code', codeComponent)
    .register('mermaid', mermaidComponent)
    .register('oshal:chart', chartComponent)
    .register('oshal:table', tableComponent)
    .register('oshal:map', mapComponent)
    .register('oshal:gallery', galleryComponent)
    .register('oshal:download', downloadComponent);
}

/**
 * @description Sanitized plain-text fallback markup for a block whose component did not run
 * (unregistered kind, failed validation, capability-filtered, render failure, abort). The block
 * stays VISIBLE — degraded, never dropped, never raw.
 * @param block - The block that needs a fallback.
 * @returns Sanitized HTML rendering the block's source text.
 */
export function renderFallbackHtml(block: RenderableResponseBlock): string {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'markdown') {
    return `<div class="rr-block rr-markdown rr-fallback">${renderMarkdownText(String(block.text ?? ''))}</div>`;
  }
  if (block.type === 'code' || block.type === 'mermaid') {
    return `<pre class="code-block rr-block rr-fallback">${escapeHtml((block as { code?: unknown }).code, 100_000)}</pre>`;
  }
  if (block.type === 'oshal') {
    return `<pre class="code-block rr-block rr-fallback" data-oshal-kind="${escapeHtml(block.kind, 64)}">${escapeHtml(block.raw, 100_000)}</pre>`;
  }
  if (block.type === 'artifact' && block.kind === 'image') {
    return `<div class="rr-block rr-fallback">${escapeHtml(block.artifact?.alt, 500)}</div>`;
  }
  return '';
}

/** The composed result of one full response render. */
export interface ResponseHtmlResult {
  /** Sanitized HTML for the whole reply, blocks in source order. */
  html: string;
  /** True when the reply contained any non-prose block (code/mermaid/oshal). */
  rich: boolean;
}

const sharedRegistry = createStandardResponseRegistry();

/**
 * @description The one-call pipeline for surfaces: segment an untrusted bot reply, dispatch
 * each block through the standard registry, and compose sanitized HTML with per-block
 * fallbacks. Never throws for bad content — worst case is escaped plain text.
 * @param text - The bot's raw reply.
 * @param options - Optional capability filter / AbortSignal forwarded to renderBlocks.
 * @returns Sanitized HTML plus whether any rich block was present.
 */
export async function renderResponseHtml(
  text: string,
  options: ResponseRenderOptions = {},
): Promise<ResponseHtmlResult> {
  const blocks = parseResponse(text);
  if (blocks.length === 0) return { html: '', rich: false };
  const results = await sharedRegistry.renderBlocks(blocks, undefined, options);
  const html = results
    .map((result) => (result.status === 'rendered' ? result.value : renderFallbackHtml(result.block)))
    .join('');
  return { html, rich: hasRichBlocks(blocks) };
}
