/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — real .xlsx rendering via exceljs (ADR-103 AI Office). The Excel projection of the same outline the deck renderer draws: table slides become live worksheets (typed Number cells, frozen headers, banded rows), series slides become Label/Value sheets with a live SUM total, metric pairs pool on a shared Metrics sheet, and everything else lands as notes under an Overview whose index hyperlinks into the data sheets. Themed through office-themes' xlsxTheme so "the executive look" means the same thing here as in the .pptx/.docx.
 */

import ExcelJS from 'exceljs';
import { createChildLogger } from '@/shared/logger';
import type { DeckRenderOptions, RenderableSlide, SlideData } from '@/shared/types';
import { xlsxTheme, type XlsxTheme } from './office-themes';
import { parseSlideContent } from './slide-content-parser';

const logger = createChildLogger({ module: 'xlsx-renderer' });

/** Body cell point size — Excel's default reading size, kept explicit so themes stay comparable. */
const BODY_PT = 11;

/** Only a BARE numeric string becomes a Number cell. "$1.2M", "94%", "3.4x" stay the display
 *  strings the author typed — turning them into numbers would destroy their formatting. */
const BARE_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** Column width fences: below `min` a header truncates; above `max` one long cell hijacks the sheet. */
const COL_MIN = 9;
const COL_MAX = 42;

/** How a parsed slide projects onto the workbook. */
type SheetKind = 'table' | 'series' | 'metrics' | 'notes';

/** Index-column label per projection — what the Overview's "Content" column prints. */
const KIND_LABEL: Record<SheetKind, string> = {
  table: 'Table', series: 'Data series', metrics: 'Metrics', notes: 'Notes',
};

/** A slide resolved to its projection: parsed data, kind, and (for sheet-backed kinds) its sheet name. */
interface Section {
  title: string;
  data: SlideData;
  kind: SheetKind;
  sheetName?: string;
}

/** Solid-pattern fill for one ARGB color. */
function fill(argb: string): ExcelJS.FillPattern {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** Hairline border on all four edges in the theme's line color. */
function hairline(theme: XlsxTheme): Partial<ExcelJS.Borders> {
  const edge: ExcelJS.Border = { style: 'thin', color: { argb: theme.line } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

/** Body font in the theme face; `over` layers bold/color/size tweaks on top. */
function bodyFont(theme: XlsxTheme, over: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: theme.font, size: BODY_PT, color: { argb: theme.ink }, ...over };
}

/**
 * @description Make a title Excel-legal as a sheet name: strip the characters Excel forbids,
 * cap at 31 chars, and de-collide with a ` (2)`-style suffix so two same-titled slides both
 * keep a sheet.
 * @param raw - the authored slide title.
 * @param used - lower-cased names already taken (mutated with the returned name).
 * @returns a unique, legal sheet name.
 */
function legalSheetName(raw: string, used: Set<string>): string {
  let base = String(raw ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^'+|'+$/g, '').trim() || 'Sheet';
  base = base.slice(0, 31).trim();
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length).trimEnd() + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Escape a sheet name for an internal `#'Name'!A1` hyperlink (apostrophes double). */
function sheetLink(name: string): string {
  return `#'${name.replace(/'/g, "''")}'!A1`;
}

/** Pick the slide's dominant shape. Precedence mirrors how definitive each shape is. */
function classify(d: SlideData): SheetKind {
  if (d.table && d.table.head.length) return 'table';
  if (d.series.length) return 'series';
  if (d.pairs.length) return 'metrics';
  return 'notes';
}

/** A table/series cell: bare numerics become real Number cells, everything else stays authored text. */
function cellValue(raw: string): string | number {
  const s = String(raw ?? '').trim();
  return BARE_NUMBER.test(s) ? Number(s) : s;
}

/** Flatten a notes-shaped slide (bullets, groups, quote) into Overview lines. */
function noteLines(d: SlideData): string[] {
  const out = [...d.bullets];
  for (const g of d.groups) out.push(g.heading, ...g.items);
  if (d.quote) out.push(`"${d.quote.text}"${d.quote.attribution ? ` — ${d.quote.attribution}` : ''}`);
  return out;
}

/**
 * @description Parse every slide and decide its projection up front, reserving sheet names
 * before anything is drawn — the Overview's index needs the final names to hyperlink them.
 * @param slides - the authored slides (already coerced to an array).
 * @param used - the sheet-name registry, pre-seeded with the fixed sheets.
 * @returns one section per slide, in order.
 */
function planSections(slides: RenderableSlide[], used: Set<string>): Section[] {
  return slides.map((s, i) => {
    let data: SlideData;
    try {
      data = parseSlideContent(s?.content);
    } catch (err) {
      logger.error({ err, slide: i + 1 }, 'slide parse failed — projecting as empty notes');
      data = parseSlideContent('');
    }
    const title = String(s?.title ?? '').trim() || `Section ${i + 1}`;
    const kind = classify(data);
    const sec: Section = { title, data, kind };
    if (kind === 'table' || kind === 'series') sec.sheetName = legalSheetName(title, used);
    if (kind === 'metrics') sec.sheetName = 'Metrics';
    return sec;
  });
}

/** Auto-fit columns from the widest cell per column, fenced to [COL_MIN, COL_MAX]. */
function fitColumns(ws: ExcelJS.Worksheet, rows: string[][]): void {
  const widths: number[] = [];
  for (const r of rows) r.forEach((v, i) => { widths[i] = Math.max(widths[i] ?? 0, String(v ?? '').length); });
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = Math.min(COL_MAX, Math.max(COL_MIN, w + 2)); });
}

/** Style `count` cells of a row as the themed header band: deep fill, header ink, bold. */
function styleHeaderCells(row: ExcelJS.Row, theme: XlsxTheme, count: number): void {
  for (let c = 1; c <= count; c += 1) {
    const cell = row.getCell(c);
    cell.fill = fill(theme.headerFill);
    cell.font = { name: theme.font, size: BODY_PT, bold: true, color: { argb: theme.headerInk } };
    cell.border = hairline(theme);
  }
}

/** A data worksheet: accent tab (so data sheets read as one family) + frozen header row. */
function addDataSheet(wb: ExcelJS.Workbook, theme: XlsxTheme, name: string): ExcelJS.Worksheet {
  return wb.addWorksheet(name, {
    properties: { tabColor: { argb: theme.accent } },
    views: [{ state: 'frozen', ySplit: 1 }],
  });
}

/**
 * @description Render a table slide as its own live worksheet — themed header, banded body,
 * hairline grid, and real Number cells wherever the author typed a bare numeric.
 * @param wb - the workbook.
 * @param theme - the resolved theme.
 * @param sec - a section classified `table`.
 */
function addTableSheet(wb: ExcelJS.Workbook, theme: XlsxTheme, sec: Section): void {
  const t = sec.data.table!;
  const ws = addDataSheet(wb, theme, sec.sheetName!);
  styleHeaderCells(ws.addRow(t.head), theme, t.head.length);
  t.rows.forEach((r, i) => {
    const row = ws.addRow(r.map(cellValue));
    const width = Math.max(t.head.length, r.length);
    for (let c = 1; c <= width; c += 1) {
      const cell = row.getCell(c);
      cell.font = bodyFont(theme);
      cell.border = hairline(theme);
      if (i % 2 === 1) cell.fill = fill(theme.bandFill);
    }
  });
  fitColumns(ws, [t.head, ...t.rows]);
}

/**
 * @description Render a series slide as a Label/Value worksheet with REAL numeric cells and a
 * live `SUM` total — open it in Excel and the total keeps computing when the user edits.
 * @param wb - the workbook.
 * @param theme - the resolved theme.
 * @param sec - a section classified `series`.
 */
function addSeriesSheet(wb: ExcelJS.Workbook, theme: XlsxTheme, sec: Section): void {
  const ws = addDataSheet(wb, theme, sec.sheetName!);
  styleHeaderCells(ws.addRow(['Label', 'Value']), theme, 2);
  sec.data.series.forEach((p, i) => {
    const row = ws.addRow([p.label, p.value]);
    for (let c = 1; c <= 2; c += 1) {
      const cell = row.getCell(c);
      cell.font = bodyFont(theme);
      cell.border = hairline(theme);
      if (i % 2 === 1) cell.fill = fill(theme.bandFill);
    }
    row.getCell(2).numFmt = '#,##0.##';
  });
  const last = sec.data.series.length + 1;
  const total = ws.addRow(['Total', { formula: `SUM(B2:B${last})` }]);
  total.getCell(1).font = bodyFont(theme, { bold: true });
  total.getCell(2).font = bodyFont(theme, { bold: true, color: { argb: theme.accent } });
  total.getCell(2).numFmt = '#,##0.##';
  for (let c = 1; c <= 2; c += 1) total.getCell(c).border = hairline(theme);
  fitColumns(ws, [['Label', 'Value'], ...sec.data.series.map((p) => [p.label, p.display]), ['Total', '']]);
}

/**
 * @description Pool every metrics slide onto ONE shared "Metrics" sheet — a KPI here and a KPI
 * there don't each deserve a tab, but together they make the workbook's scoreboard. Labels
 * carry the accent (they are the figures), captions sit beside them in body ink.
 * @param wb - the workbook.
 * @param theme - the resolved theme.
 * @param sections - the sections classified `metrics`, in slide order.
 */
function addMetricsSheet(wb: ExcelJS.Workbook, theme: XlsxTheme, sections: Section[]): void {
  const ws = addDataSheet(wb, theme, 'Metrics');
  styleHeaderCells(ws.addRow(['Metric', 'Value']), theme, 2);
  for (const sec of sections) {
    const head = ws.addRow([sec.title]);
    head.getCell(1).font = bodyFont(theme, { bold: true, color: { argb: theme.inkSoft } });
    for (const p of sec.data.pairs) {
      const row = ws.addRow([p.label, p.value]);
      row.getCell(1).font = bodyFont(theme, { bold: true, color: { argb: theme.accent } });
      row.getCell(2).font = bodyFont(theme);
    }
  }
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 52;
}

/**
 * @description Draw the Overview's title block: a merged themed band (the workbook's "cover"),
 * then subtitle/byline lines in soft ink.
 * @param ws - the Overview sheet.
 * @param theme - the resolved theme.
 * @param title - workbook title.
 * @param opts - deck options (subtitle/byline).
 * @returns the next free row number.
 */
function buildTitleBlock(ws: ExcelJS.Worksheet, theme: XlsxTheme, title: string, opts: DeckRenderOptions): number {
  ws.mergeCells('A1:F2');
  const t = ws.getCell('A1');
  t.value = title;
  t.fill = fill(theme.headerFill);
  t.font = { name: theme.font, size: 20, bold: true, color: { argb: theme.headerInk } };
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  let r = 3;
  for (const line of [opts.subtitle, opts.byline]) {
    if (!line) continue;
    const cell = ws.getCell(r, 1);
    cell.value = line;
    cell.font = bodyFont(theme, { color: { argb: theme.inkSoft } });
    r += 1;
  }
  return r + 1;
}

/**
 * @description Draw the Overview's index table: one row per section with its name, content
 * kind, and — where the section became a sheet — an internal hyperlink into it.
 * @param ws - the Overview sheet.
 * @param theme - the resolved theme.
 * @param sections - all sections, in slide order.
 * @param startRow - first row to draw on.
 * @returns the next free row number.
 */
function buildIndex(ws: ExcelJS.Worksheet, theme: XlsxTheme, sections: Section[], startRow: number): number {
  const head = ws.getRow(startRow);
  ['Section', 'Content', 'Sheet'].forEach((v, i) => { head.getCell(i + 1).value = v; });
  styleHeaderCells(head, theme, 3);
  sections.forEach((sec, i) => {
    const row = ws.getRow(startRow + 1 + i);
    row.getCell(1).value = sec.title;
    row.getCell(1).font = bodyFont(theme);
    row.getCell(2).value = KIND_LABEL[sec.kind];
    row.getCell(2).font = bodyFont(theme, { color: { argb: theme.inkSoft } });
    if (sec.sheetName) {
      const cell = row.getCell(3);
      cell.value = { text: sec.sheetName, hyperlink: sheetLink(sec.sheetName) };
      cell.font = bodyFont(theme, { underline: true, color: { argb: theme.accent } });
    }
    for (let c = 1; c <= 3; c += 1) {
      row.getCell(c).border = hairline(theme);
      if (i % 2 === 1) row.getCell(c).fill = fill(theme.bandFill);
    }
  });
  return startRow + sections.length + 2;
}

/**
 * @description Append every notes-shaped section to the Overview: bold section heading, then
 * its lines indented in soft ink — the prose that has no data sheet still ships in the file.
 * @param ws - the Overview sheet.
 * @param theme - the resolved theme.
 * @param sections - all sections (non-notes are skipped here).
 * @param startRow - first row to draw on.
 */
function addNotes(ws: ExcelJS.Worksheet, theme: XlsxTheme, sections: Section[], startRow: number): void {
  let r = startRow;
  for (const sec of sections) {
    if (sec.kind !== 'notes') continue;
    const head = ws.getCell(r, 1);
    head.value = sec.title;
    head.font = bodyFont(theme, { bold: true });
    r += 1;
    for (const line of noteLines(sec.data)) {
      const cell = ws.getCell(r, 1);
      cell.value = line;
      cell.font = bodyFont(theme, { color: { argb: theme.inkSoft } });
      cell.alignment = { indent: 1 };
      r += 1;
    }
    r += 1;
  }
}

/** Workbook file metadata — what shows in Excel's File ▸ Info pane. */
function applyMetadata(wb: ExcelJS.Workbook, title: string): void {
  wb.creator = 'OSHAL';
  wb.lastModifiedBy = 'OSHAL';
  wb.title = title;
  wb.subject = title;
  wb.created = new Date();
  wb.modified = new Date();
}

/**
 * @description Render an outline to a real Excel (.xlsx) workbook.
 *
 * This is the EXCEL projection of the same deck outline `renderPptx` draws — the data becomes
 * LIVE worksheets, not screenshots of tables. Table slides get their own sheet (typed Number
 * cells, frozen themed header, banded rows); series slides get a Label/Value sheet whose Total
 * is a real `SUM` formula that keeps computing when the user edits; metric pairs pool on one
 * shared Metrics sheet; bullets and quotes land under the Overview, whose index hyperlinks
 * into every data sheet. The theme is the deck's own, projected through `xlsxTheme`, so the
 * .xlsx visibly belongs to the same document family as the .pptx.
 *
 * @param title - workbook title (Overview title band and file metadata).
 * @param slides - ordered content slides. Bodies may use the layout micro-syntax; see
 *   `slide-content-parser`. Each slide's parsed shape decides its projection.
 * @param options - theme + subtitle/byline. Omitted → the default theme. Deck-only options
 *   (`slideNumbers`, `autoLayout`) have no Excel meaning and are ignored.
 * @returns the .xlsx file as a Buffer. Never throws on hostile input — worst case is a valid
 *   workbook containing only the Overview.
 */
export async function renderXlsx(
  title: string, slides: RenderableSlide[], options: DeckRenderOptions = {},
): Promise<Buffer> {
  const started = Date.now();
  const theme = xlsxTheme(options.theme);
  const bookTitle = String(title ?? '').trim() || 'Workbook';

  const wb = new ExcelJS.Workbook();
  applyMetadata(wb, bookTitle);
  const used = new Set(['overview', 'metrics', 'history']); // fixed sheets + Excel's reserved name
  const sections = planSections(Array.isArray(slides) ? slides : [], used);

  const overview = wb.addWorksheet('Overview');
  let next = buildTitleBlock(overview, theme, bookTitle, options);
  if (sections.length) next = buildIndex(overview, theme, sections, next);
  [26, 14, 32].forEach((w, i) => { overview.getColumn(i + 1).width = w; });

  for (const sec of sections) {
    try {
      if (sec.kind === 'table') addTableSheet(wb, theme, sec);
      else if (sec.kind === 'series') addSeriesSheet(wb, theme, sec);
    } catch (err) {
      // One bad section must not cost the user the workbook — its sheet is dropped, the
      // Overview (and its index row) still ship, and the failure is in the logs.
      logger.error({ err, section: sec.title, kind: sec.kind }, 'sheet render failed — skipping section sheet');
    }
  }
  const metricSections = sections.filter((s) => s.kind === 'metrics');
  if (metricSections.length) {
    try {
      addMetricsSheet(wb, theme, metricSections);
    } catch (err) {
      logger.error({ err }, 'metrics sheet render failed — skipping Metrics');
    }
  }
  addNotes(overview, theme, sections, next);

  const out = await wb.xlsx.writeBuffer();
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  logger.info(
    {
      title: bookTitle, theme: theme.id, sections: sections.length,
      sheets: wb.worksheets.length, bytes: buf.length, durationMs: Date.now() - started,
    },
    'Rendered .xlsx',
  );
  return buf;
}
