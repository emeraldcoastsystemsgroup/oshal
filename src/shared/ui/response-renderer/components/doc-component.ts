/**
 * Response Renderer — the `oshal:doc` typed-block component.
 *
 * A small, safe document viewer for bounded narrative sections. The body contains display text
 * only: there are no URLs, HTML, actions, forms, or executable fields. Every retained value is
 * control-character cleaned, length-bounded, and escaped at composition time. A malformed body
 * fails closed to the registry's visible plain-text fallback.
 *
 * Accepted JSON body:
 *   { "title"?: string,
 *     "sections": Array<{ "heading"?: string, "paragraphs": string[] }> } // 1..24 sections
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — bounded escaped document viewer for oshal:doc typed blocks.
 *
 * @module shared/ui/response-renderer/components/doc-component
 */

import type { OshalBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml, truncate } from './safe-html';

/** Normalized document section containing display-only text. */
export interface DocSection { heading: string; paragraphs: string[] }

/** Normalized document spec consumed by the renderer. */
export interface DocSpec { title: string; sections: DocSection[] }

const MAX_SECTIONS = 24;
const MAX_PARAGRAPHS = 24;
const MAX_HEADING_CHARS = 160;
const MAX_PARAGRAPH_CHARS = 2_000;

/**
 * @description Validates and normalizes an untrusted `oshal:doc` body. The schema is deliberately
 * display-only: each section must contain at least one string paragraph, and all retained text is
 * bounded before the component can render it.
 * @param data - Parsed JSON body of the typed block.
 * @returns Normalized spec, or null when the body is not a renderable document.
 */
export function normalizeDocData(data: unknown): DocSpec | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidate = data as { title?: unknown; sections?: unknown };
  if (candidate.title !== undefined && typeof candidate.title !== 'string') return null;
  if (!Array.isArray(candidate.sections) || candidate.sections.length === 0
    || candidate.sections.length > MAX_SECTIONS) return null;

  const sections: DocSection[] = [];
  for (const section of candidate.sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
    const candidateSection = section as { heading?: unknown; paragraphs?: unknown };
    if (candidateSection.heading !== undefined && typeof candidateSection.heading !== 'string') return null;
    if (!Array.isArray(candidateSection.paragraphs) || candidateSection.paragraphs.length === 0
      || candidateSection.paragraphs.length > MAX_PARAGRAPHS
      || !candidateSection.paragraphs.every((paragraph) => typeof paragraph === 'string')) return null;
    sections.push({
      heading: truncate(candidateSection.heading ?? '', MAX_HEADING_CHARS),
      paragraphs: candidateSection.paragraphs.map((paragraph) => truncate(paragraph, MAX_PARAGRAPH_CHARS)),
    });
  }

  return {
    title: truncate(candidate.title ?? '', MAX_HEADING_CHARS),
    sections,
  };
}

/**
 * @description Renders a normalized document to escaped HTML. Only literal structural markup is
 * composed here; document text never becomes an attribute, URL, tag, handler or action.
 * @param spec - Normalized document spec from {@link normalizeDocData}.
 * @returns Sanitized HTML markup.
 */
export function renderDocHtml(spec: DocSpec): string {
  const title = spec.title
    ? `<h3 class="rr-doc-title">${escapeHtml(spec.title)}</h3>`
    : '';
  const sections = spec.sections.map((section) => {
    const heading = section.heading ? `<h4>${escapeHtml(section.heading)}</h4>` : '';
    const paragraphs = section.paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join('');
    return `<section class="rr-doc-section">${heading}${paragraphs}</section>`;
  }).join('');
  return `<article class="rr-block rr-doc">${title}${sections}</article>`;
}

/**
 * @description The registered `oshal:doc` component. Validation performs the complete
 * normalization so render never sees a shape it cannot safely draw.
 */
export const docComponent: ResponseBlockComponent<OshalBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'oshal' && normalizeDocData(block.data) !== null,
  render(block: OshalBlock): string {
    const spec = normalizeDocData(block.data);
    if (!spec) throw new Error('oshal:doc body failed normalization');
    return renderDocHtml(spec);
  },
};
