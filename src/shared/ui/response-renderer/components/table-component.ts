/**
 * Response Renderer — the `oshal:table` typed-block component.
 *
 * parse-response deliberately does NOT split markdown tables out of prose (they pass through
 * inside `markdown` blocks, rendered as plain text lines — same as the surfaces today). A bot
 * that wants a first-class table emits the typed form instead, and this component renders it
 * as a real `<table>` with every cell escaped. Fail-closed like the chart: a body that is not
 * exactly `{columns, rows}` is rejected by `validate` and falls back to plain text.
 *
 * Accepted JSON body:
 *   { "title"?: string, "columns": string[], "rows": Array<Array<string | number | boolean | null>> }
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — sanitized DOM-free table renderer for oshal:table typed blocks.
 *
 * @module shared/ui/response-renderer/components/table-component
 */

import type { OshalBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml, truncate } from './safe-html';

/** Normalized table spec: header labels plus stringified body cells. */
export interface TableSpec { title: string; columns: string[]; rows: string[][] }

const MAX_COLUMNS = 12;
const MAX_ROWS = 100;
const MAX_CELL_CHARS = 400;

/** True for the scalar cell types the table accepts as-is. */
function isScalarCell(cell: unknown): boolean {
  return cell === null || ['string', 'number', 'boolean'].includes(typeof cell);
}

/**
 * @description Validates + normalizes an untrusted `oshal:table` JSON body. Fail-closed: shape
 * violations return null; oversized cells are truncated rather than rejected.
 * @param data - Parsed JSON body of the typed block.
 * @returns Normalized spec, or null when the body is not a renderable table.
 */
export function normalizeTableData(data: unknown): TableSpec | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidate = data as { title?: unknown; columns?: unknown; rows?: unknown };
  const columns = candidate.columns;
  const rows = candidate.rows;
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) return null;
  if (!columns.every((column) => typeof column === 'string')) return null;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return null;
  const normalizedRows: string[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length || !row.every(isScalarCell)) return null;
    normalizedRows.push(row.map((cell) => truncate(cell === null ? '' : String(cell), MAX_CELL_CHARS)));
  }
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  return { title, columns: columns as string[], rows: normalizedRows };
}

/**
 * @description Renders a normalized table spec to sanitized HTML — a horizontally scrollable
 * wrapper so wide tables never break the bubble layout.
 * @param spec - Normalized table spec from {@link normalizeTableData}.
 * @returns Sanitized HTML markup.
 */
export function renderTableHtml(spec: TableSpec): string {
  const caption = spec.title ? `<caption>${escapeHtml(truncate(spec.title, 120))}</caption>` : '';
  const head = spec.columns.map((column) => `<th>${escapeHtml(truncate(column, 80))}</th>`).join('');
  const body = spec.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="rr-block rr-table" style="overflow-x:auto"><table>${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * @description The registered `oshal:table` component. `validate` runs the full normalization,
 * so `render` never sees a shape it cannot draw.
 */
export const tableComponent: ResponseBlockComponent<OshalBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'oshal' && normalizeTableData(block.data) !== null,
  render(block: OshalBlock): string {
    const spec = normalizeTableData(block.data);
    if (!spec) throw new Error('oshal:table body failed normalization');
    return renderTableHtml(spec);
  },
};
