/**
 * Response Renderer — the `oshal:gallery` typed-block component.
 *
 * A responsive image grid for the `{items}` shape a bot emits in a ```oshal:gallery fenced block.
 * Unlike the surface-owned `artifact:image` block (where URL/provenance validation is the
 * surface's job), this narrative gallery renders bot-supplied URLs directly — so it enforces the
 * scheme allowlist itself: every URL passes {@link safeUrl} (https/http/root-relative/data:image
 * only) AND {@link escapeHtml} before it reaches an attribute, and any item whose URL fails the
 * allowlist fails the WHOLE block closed to the plain-text fallback. Pure string composition, no
 * DOM, nothing external. A malformed body never throws.
 *
 * Accepted JSON body:
 *   { "title"?: string,
 *     "items": Array<{ "url": string, "alt"?: string, "caption"?: string }> } // 1..24 items
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — sanitized DOM-free responsive image-grid renderer for oshal:gallery typed blocks (scheme-allowlisted URLs, fail-closed).
 *
 * @module shared/ui/response-renderer/components/gallery-component
 */

import type { OshalBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml, truncate } from './safe-html';
import { safeUrl } from './safe-url';

/** One normalized gallery item: a scheme-checked URL plus optional alt/caption text. */
export interface GalleryItem { url: string; alt: string; caption: string }

/** The normalized gallery spec the render helper consumes. */
export interface GallerySpec { title: string; items: GalleryItem[] }

const MAX_ITEMS = 24;

/**
 * @description Validates + normalizes an untrusted `oshal:gallery` JSON body. Fail-closed: any
 * shape violation OR any URL that is not on the {@link safeUrl} allowlist rejects the whole block
 * (→ registry fallback), so a hostile `javascript:` src can never reach the grid.
 * @param data - Parsed JSON body of the typed block.
 * @returns Normalized spec, or null when the body is not a renderable gallery.
 */
export function normalizeGalleryData(data: unknown): GallerySpec | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidate = data as { title?: unknown; items?: unknown };
  const rawItems = candidate.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS) return null;
  const items: GalleryItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { url, alt, caption } = entry as { url?: unknown; alt?: unknown; caption?: unknown };
    const safe = safeUrl(url);
    if (!safe) return null;
    items.push({
      url: safe,
      alt: typeof alt === 'string' ? alt : '',
      caption: typeof caption === 'string' ? caption : '',
    });
  }
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  return { title, items };
}

/** Render one `<figure>` per item: a lazy-loaded escaped `<img>` with an optional caption. */
function renderItem(item: GalleryItem): string {
  const src = escapeHtml(item.url);
  const alt = escapeHtml(truncate(item.alt, 200));
  const caption = item.caption
    ? `<figcaption class="rr-gallery-caption">${escapeHtml(truncate(item.caption, 200))}</figcaption>`
    : '';
  return `<figure class="rr-gallery-item" style="margin:0"><img src="${src}" alt="${alt}" loading="lazy" style="width:100%;height:auto;display:block;border-radius:6px">${caption}</figure>`;
}

/**
 * @description Renders a normalized gallery spec to sanitized HTML — a responsive auto-fill grid
 * so any item count reflows without breaking the bubble layout.
 * @param spec - Normalized gallery spec from {@link normalizeGalleryData}.
 * @returns Sanitized HTML markup.
 */
export function renderGalleryHtml(spec: GallerySpec): string {
  const caption = spec.title
    ? `<figcaption class="rr-gallery-title" style="font-weight:650;margin-bottom:6px">${escapeHtml(truncate(spec.title, 120))}</figcaption>`
    : '';
  const grid = spec.items.map(renderItem).join('');
  return `<figure class="rr-block rr-gallery" style="margin:0">${caption}`
    + `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">${grid}</div></figure>`;
}

/**
 * @description The registered `oshal:gallery` component. `validate` runs the full normalization,
 * so `render` never sees a shape (or URL) it cannot safely draw.
 */
export const galleryComponent: ResponseBlockComponent<OshalBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'oshal' && normalizeGalleryData(block.data) !== null,
  render(block: OshalBlock): string {
    const spec = normalizeGalleryData(block.data);
    if (!spec) throw new Error('oshal:gallery body failed normalization');
    return renderGalleryHtml(spec);
  },
};
