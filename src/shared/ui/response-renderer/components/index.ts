/**
 * Response Renderer — concrete components barrel.
 *
 * The shipped component set (markdown / code / mermaid / oshal:chart / oshal:table / oshal:map /
 * oshal:gallery / oshal:download), the standard registry factory, and the renderResponseHtml
 * one-call pipeline. Import through `@/shared/ui/response-renderer` — never deep.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel for the concrete response-renderer components.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the oshal:map / oshal:gallery / oshal:download components and their normalize/render helpers + safeUrl allowlist.
 *
 * @module shared/ui/response-renderer/components
 */

export { escapeHtml, cleanText, truncate } from './safe-html';
export { safeUrl } from './safe-url';
export { markdownComponent, renderMarkdownText } from './markdown-component';
export { codeComponent, safeLanguageToken } from './code-component';
export { mermaidComponent } from './mermaid-component';
export { chartComponent, normalizeChartData, renderChartSvg } from './chart-component';
export type { ChartSeries, ChartSpec } from './chart-component';
export { tableComponent, normalizeTableData, renderTableHtml } from './table-component';
export type { TableSpec } from './table-component';
export { mapComponent, normalizeMapData, renderMapSvg } from './map-component';
export type { MapMarker, MapSpec } from './map-component';
export { galleryComponent, normalizeGalleryData, renderGalleryHtml } from './gallery-component';
export type { GalleryItem, GallerySpec } from './gallery-component';
export { downloadComponent, normalizeDownloadData, renderDownloadHtml } from './download-component';
export type { DownloadFile, DownloadSpec } from './download-component';
export {
  createStandardResponseRegistry,
  renderFallbackHtml,
  renderResponseHtml,
} from './standard-registry';
export type { ResponseHtmlResult } from './standard-registry';
