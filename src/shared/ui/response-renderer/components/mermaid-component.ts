/**
 * Response Renderer — the `mermaid` diagram component.
 *
 * No local mermaid asset ships in this repo (the only existing usage — src/api/jarvis.html —
 * loads mermaid from a CDN at page runtime, which shared components must not depend on: no
 * CDN/external scripts here). So this component renders the SAFE FALLBACK CONTRACT: the diagram
 * source as an escaped fenced-code block that also carries the source in a `data-mermaid`
 * attribute. A surface that has a mermaid runtime available hydrates it client-side
 * (querySelectorAll('[data-mermaid]') → render → mark `data-rendered`); every other surface
 * still shows the readable diagram text. Nothing is lost, nothing external is loaded.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — data-mermaid fenced-code fallback (no CDN scripts); surfaces with a local mermaid runtime hydrate it.
 *
 * @module shared/ui/response-renderer/components/mermaid-component
 */

import type { MermaidBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml } from './safe-html';

/**
 * @description The registered `mermaid` component: escaped diagram source in a code-block
 * shell carrying `data-mermaid` for optional client-side hydration by the hosting surface.
 */
export const mermaidComponent: ResponseBlockComponent<MermaidBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'mermaid' && typeof block.code === 'string',
  render(block: MermaidBlock): string {
    const escaped = escapeHtml(block.code, 50_000);
    return `<pre class="code-block rr-block rr-mermaid" data-mermaid="${escaped}">${escaped}</pre>`;
  },
};
