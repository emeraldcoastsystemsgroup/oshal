/**
 * Response Renderer — the `oshal:download` typed-block component.
 *
 * A list of downloadable file links for the `{files}` shape a bot emits in a ```oshal:download
 * fenced block (a report the bot generated, an export, an attachment). Every href is bot-supplied
 * and therefore scheme-allowlisted through {@link safeUrl} (https/http/root-relative/data:image
 * only) AND {@link escapeHtml} before it reaches the attribute; any file whose URL fails the
 * allowlist fails the WHOLE block closed to the plain-text fallback. Pure string composition, no
 * DOM, nothing external. A malformed body never throws.
 *
 * Accepted JSON body:
 *   { "title"?: string,
 *     "files": Array<{ "url": string, "name": string, "size"?: number, "mime"?: string }> } // 1..20
 * `size` is a byte count; a non-finite/negative size is dropped rather than rejecting the file.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — sanitized DOM-free download-link-list renderer for oshal:download typed blocks (scheme-allowlisted hrefs, fail-closed).
 *
 * @module shared/ui/response-renderer/components/download-component
 */

import type { OshalBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml, round2, truncate } from './safe-html';
import { safeUrl } from './safe-url';

/** One normalized download entry: a scheme-checked URL, a name, and optional size/mime metadata. */
export interface DownloadFile { url: string; name: string; size: number | null; mime: string }

/** The normalized download spec the render helper consumes. */
export interface DownloadSpec { title: string; files: DownloadFile[] }

const MAX_FILES = 20;

/** Deterministic human-readable byte size (no locale dependence). */
function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${round2(bytes / 1_024)} KB`;
  if (bytes < 1_073_741_824) return `${round2(bytes / 1_048_576)} MB`;
  return `${round2(bytes / 1_073_741_824)} GB`;
}

/**
 * @description Validates + normalizes an untrusted `oshal:download` JSON body. Fail-closed: any
 * shape violation OR any URL that is not on the {@link safeUrl} allowlist rejects the whole block
 * (→ registry fallback). A missing/invalid `size` is normalized to null, not a rejection.
 * @param data - Parsed JSON body of the typed block.
 * @returns Normalized spec, or null when the body is not a renderable download list.
 */
export function normalizeDownloadData(data: unknown): DownloadSpec | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidate = data as { title?: unknown; files?: unknown };
  const rawFiles = candidate.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_FILES) return null;
  const files: DownloadFile[] = [];
  for (const entry of rawFiles) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { url, name, size, mime } = entry as {
      url?: unknown; name?: unknown; size?: unknown; mime?: unknown;
    };
    const safe = safeUrl(url);
    if (!safe || typeof name !== 'string' || name.length === 0) return null;
    const validSize = typeof size === 'number' && Number.isFinite(size) && size >= 0;
    files.push({
      url: safe,
      name,
      size: validSize ? size : null,
      mime: typeof mime === 'string' ? mime : '',
    });
  }
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  return { title, files };
}

/** Render one download row: an escaped `download` anchor plus an escaped size/mime meta line. */
function renderFile(file: DownloadFile): string {
  const href = escapeHtml(file.url);
  const name = escapeHtml(truncate(file.name, 160));
  const meta = [file.size === null ? '' : formatSize(file.size), truncate(file.mime, 60)]
    .filter(Boolean)
    .join(' · ');
  const metaHtml = meta
    ? `<span class="rr-download-meta" style="opacity:.7;font-size:.85em"> — ${escapeHtml(meta)}</span>`
    : '';
  return `<li class="rr-download-item" style="margin:2px 0"><a href="${href}" download="${name}" rel="noopener noreferrer">${name}</a>${metaHtml}</li>`;
}

/**
 * @description Renders a normalized download spec to sanitized HTML — an unordered list of
 * download anchors.
 * @param spec - Normalized download spec from {@link normalizeDownloadData}.
 * @returns Sanitized HTML markup.
 */
export function renderDownloadHtml(spec: DownloadSpec): string {
  const heading = spec.title
    ? `<div class="rr-download-title" style="font-weight:650;margin-bottom:4px">${escapeHtml(truncate(spec.title, 120))}</div>`
    : '';
  const items = spec.files.map(renderFile).join('');
  return `<div class="rr-block rr-download">${heading}<ul style="list-style:none;padding:0;margin:0">${items}</ul></div>`;
}

/**
 * @description The registered `oshal:download` component. `validate` runs the full normalization,
 * so `render` never sees a shape (or URL) it cannot safely draw.
 */
export const downloadComponent: ResponseBlockComponent<OshalBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'oshal' && normalizeDownloadData(block.data) !== null,
  render(block: OshalBlock): string {
    const spec = normalizeDownloadData(block.data);
    if (!spec) throw new Error('oshal:download body failed normalization');
    return renderDownloadHtml(spec);
  },
};
