/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-103's return lane: parse an EXISTING .docx/.xlsx/.pptx back into the outline model the renderers draw from, so the AI guide can edit a file it did not author and regenerate it. Content-level fidelity on purpose (headings, text, lists, tables, numbers survive; exotic formatting is dropped) — byte fidelity would chain us to every producer's quirks, while the outline is the shape the whole AI Office pipeline already speaks.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Read chart PARTS on pptx import (adversarial live verify caught the gap): the renderer writes series into native chart XML, so a text walk of the slide loses every number — slide rels are now followed to charts/chartN.xml and the data re-emitted as `Label: value` lines (one series; re-renders as a chart) or a pipe table (several).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Zip-bomb fence (security review finding): the route caps the COMPRESSED body but every zip-entry read inflated unboundedly — a crafted ~25MB OOXML part (DEFLATE ~1000:1) could exhaust the shared api process's memory from one authenticated upload. All JSZip entry reads now stream through entryText() against a 128MB per-import decompression budget, and the exceljs path (own internal unzip) is pre-scanned by assertZipWithinBudget() so a bomb never reaches it. Budget blown → reject → the existing catch degrades to an empty outline.
 */

import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { createChildLogger } from '@/shared/logger';
import type { RenderableSlide } from '@/shared/types';

const logger = createChildLogger({ module: 'office-import' });

/** Output fences: a hostile or huge file degrades to a clipped outline, never a hung import. */
const CAP = { sections: 60, sectionChars: 8000, lineChars: 300, noteChars: 2000, tableRows: 30, tableCols: 8 };

/**
 * Input fence: total DECOMPRESSED bytes one import may inflate. The route caps the request
 * body (compressed size), but DEFLATE ratios reach ~1000:1 — a crafted ~25MB OOXML part can
 * inflate to multi-GB and take the whole shared api process down with one authenticated
 * upload. Far above any legitimate document.xml/slide/sheet, low enough to be harmless.
 */
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;

/** Mutable per-import decompression allowance — one budget object per import call, decremented
 *  by every entry read, so many small entries can't do what one big entry is fenced from. */
interface InflateBudget { left: number }

/** A fresh full allowance for one import call. */
function newInflateBudget(): InflateBudget { return { left: MAX_INFLATED_BYTES }; }

/**
 * @description Read a zip entry as UTF-8 text through the streaming decompressor, counting
 * inflated bytes against the per-import budget and aborting the moment it's exceeded — the
 * zip-bomb fence. `part.async('string')` inflates unboundedly; never call it directly here.
 * @param part - the zip entry to read.
 * @param budget - the import call's remaining decompression allowance (mutated).
 * @returns the entry's text; rejects when the budget is blown (caller's catch degrades to an
 * empty outline, which is the correct hostile-input behavior).
 */
function entryText(part: JSZip.JSZipObject, budget: InflateBudget): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let blown = false;
    const stream = part.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      if (blown) return;
      total += chunk.length;
      budget.left -= chunk.length;
      if (budget.left < 0) {
        blown = true;
        stream.pause();
        reject(new Error(`zip-bomb fence: '${part.name}' exceeded the per-import decompression budget`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err: Error) => reject(err));
    stream.on('end', () => { if (!blown) resolve(Buffer.concat(chunks, total).toString('utf8')); });
  });
}

/**
 * @description Prove every entry in a zip inflates within the budget WITHOUT keeping the
 * data — the pre-scan for the exceljs path, which does its own internal unzip that this
 * module can't meter. Rejecting here means exceljs never sees the hostile bytes.
 * @param zip - the loaded zip to drain-count.
 * @param budget - the import call's remaining decompression allowance (mutated).
 */
async function assertZipWithinBudget(zip: JSZip, budget: InflateBudget): Promise<void> {
  for (const name of Object.keys(zip.files)) {
    const part = zip.files[name];
    if (part.dir) continue;
    await new Promise<void>((resolve, reject) => {
      let blown = false;
      const stream = part.nodeStream('nodebuffer');
      stream.on('data', (chunk: Buffer) => {
        if (blown) return;
        budget.left -= chunk.length;
        if (budget.left < 0) {
          blown = true;
          stream.pause();
          reject(new Error(`zip-bomb fence: '${name}' exceeded the per-import decompression budget`));
        }
      });
      stream.on('error', (err: Error) => reject(err));
      stream.on('end', () => { if (!blown) resolve(); });
    });
  }
}

/**
 * @description An Office file parsed back into the outline model — the same
 * `{title, sections}` shape `renderPptx`/`renderDocx`/`renderXlsx` consume, so an import can
 * be edited as an outline and re-rendered (the CRUD loop the AI Office guide closes).
 */
export interface ImportedOutline {
  /** Document / deck / workbook title recovered from the file (may be ''). */
  title: string;
  /** One outline section per document section / slide / worksheet, content in the
   *  `slide-content-parser` micro-syntax (bullets, `## Heading`, `| a | b |`, `> quote`). */
  sections: RenderableSlide[];
  /** The format the bytes actually were — what the parser trusted, not what the name said. */
  format: 'docx' | 'xlsx' | 'pptx';
}

type OfficeFormat = ImportedOutline['format'];

/** A section being accumulated line by line before the caps are applied. */
interface Draft { title: string; lines: string[]; notes?: string }

/** One code point, or '' when the escape is out of range — never a throw mid-decode. */
function safeChar(code: number): string {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/** Decode the XML entities OOXML text nodes carry (named + numeric). `&amp;` last, so a
 *  double-encoded `&amp;lt;` comes out as the literal `&lt;` the author typed. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Clip one outline line to the cap — losing a tail is fine, losing the line is not. */
function clipLine(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, CAP.lineChars);
}

/** Append a non-empty clipped line to a draft section. */
function pushLine(d: Draft, raw: string): void {
  const s = clipLine(raw);
  if (s) d.lines.push(s);
}

/** Start a new draft section and make it current. */
function pushDraft(drafts: Draft[], title: string): Draft {
  const d: Draft = { title, lines: [] };
  drafts.push(d);
  return d;
}

/** A `| a | b |` micro-syntax row. `|` inside a cell is swapped for `¦` so it can't split. */
function pipeRow(cells: string[]): string {
  return `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '¦').replace(/\s+/g, ' ').trim()).join(' | ')} |`;
}

/** Apply the output caps and produce the final outline. */
function toOutline(title: string, drafts: Draft[], format: OfficeFormat): ImportedOutline {
  const sections = drafts.slice(0, CAP.sections).map((d) => {
    const s: RenderableSlide = { title: clipLine(d.title) };
    const content = d.lines.join('\n').slice(0, CAP.sectionChars);
    if (content) s.content = content;
    if (d.notes) s.notes = d.notes.slice(0, CAP.noteChars);
    return s;
  });
  return { title: clipLine(title), sections, format };
}

/** The never-throw floor: what every importer returns for unreadable input. */
function emptyOutline(format: OfficeFormat): ImportedOutline {
  return { title: '', sections: [], format };
}

// ---------------------------------------------------------------------------
// .docx — word/document.xml walked in order with light string parsing. No XML lib on
// purpose: the four node kinds we mine (w:p, w:tbl, w:pStyle, w:t) are stable across
// producers, and a DOM round-trip buys nothing but a dependency for a lossy read.
// ---------------------------------------------------------------------------

/** Visible text of one `<w:p>`: `<w:t>` runs concatenated in order, tab/br as a space. */
function wParaText(xml: string): string {
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab[^>]*\/>|<w:br[^>]*\/>/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += m[1] !== undefined ? decodeEntities(m[1]) : ' ';
  return out.replace(/\s+/g, ' ').trim();
}

/** A `<w:tbl>` as micro-syntax pipe rows (first row is the header by position). */
function wTableLines(tblXml: string): string[] {
  const rows: string[] = [];
  const rowRe = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(tblXml))) {
    const cells: string[] = [];
    const cellRe = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[0]))) cells.push(wParaText(c[0]));
    if (cells.length) rows.push(pipeRow(cells));
  }
  return rows;
}

/** Strip the curly/straight quote marks a renderer wrapped around a Quote paragraph. */
function stripQuoteMarks(text: string): string {
  return text.replace(/^[“”"']+\s*/, '').replace(/\s*[“”"']+$/, '');
}

/** Walk the document body's paragraphs and tables in order into title + draft sections. */
function parseDocxBody(xml: string): ImportedOutline {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  const drafts: Draft[] = [];
  let title = '';
  let current: Draft | null = null;
  // Pre-Heading1 body text (other than the title) lands in an "Overview" section.
  const section = (): Draft => current ?? (current = pushDraft(drafts, 'Overview'));

  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body))) {
    const block = m[0];
    if (block.startsWith('<w:tbl')) {
      for (const line of wTableLines(block)) pushLine(section(), line);
      continue;
    }
    const text = wParaText(block);
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"\s*\/?>/.exec(block)?.[1] ?? '';
    if (style === 'Heading1' || style === '1') { current = pushDraft(drafts, text); continue; }
    if (style === 'Title') { if (!title) title = text; continue; }
    if (!title && !drafts.length) { title = text; continue; } // first non-empty pre-Heading1 paragraph
    if (style === 'Heading2' || style === '2') { pushLine(section(), `## ${text}`); continue; }
    if (/quote/i.test(style)) { pushLine(section(), `> ${stripQuoteMarks(text)}`); continue; }
    pushLine(section(), text); // list paragraphs and plain paragraphs both read back as bullets
  }
  return toOutline(title, drafts, 'docx');
}

/**
 * @description Parse a Word file back into the outline model. Heading1 starts a section,
 * Heading2 becomes a `## group`, tables become pipe rows, quote styles become `> lines` —
 * i.e. the exact micro-syntax `renderDocx` was fed, which is what makes the import
 * re-renderable. Never throws: unreadable input logs a warning and returns an empty outline.
 * @param buf - the .docx file bytes.
 * @returns the recovered outline (format 'docx').
 */
export async function importDocx(buf: Buffer): Promise<ImportedOutline> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const part = zip.file('word/document.xml');
    if (!part) {
      logger.warn({ bytes: buf?.length ?? 0 }, 'importDocx: zip has no word/document.xml — empty outline');
      return emptyOutline('docx');
    }
    return parseDocxBody(await entryText(part, newInflateBudget()));
  } catch (err) {
    logger.warn({ err, bytes: buf?.length ?? 0 }, 'importDocx: unreadable input — empty outline');
    return emptyOutline('docx');
  }
}

// ---------------------------------------------------------------------------
// .xlsx — read through exceljs (real cell types beat scraping sheet XML: numbers, dates,
// and cached formula results arrive already typed).
// ---------------------------------------------------------------------------

/** A cell reduced to what the outline needs: display text + is-it-a-number / a-formula. */
interface CellInfo { text: string; num: boolean; formula: boolean }

const EMPTY_CELL: CellInfo = { text: '', num: false, formula: false };

/** Resolve any exceljs cell value: numbers as-is, strings trimmed, dates → ISO date part,
 *  formulas → their cached result when present (that is the number the file displays). */
function resolveValue(v: ExcelJS.CellValue): CellInfo {
  if (v === null || v === undefined) return EMPTY_CELL;
  if (typeof v === 'number') return { text: String(v), num: Number.isFinite(v), formula: false };
  if (typeof v === 'string') return { text: v.trim(), num: false, formula: false };
  if (typeof v === 'boolean') return { text: String(v), num: false, formula: false };
  if (v instanceof Date) return { text: v.toISOString().slice(0, 10), num: false, formula: false };
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return { text: o.richText.map((r) => String((r as { text?: string })?.text ?? '')).join('').trim(), num: false, formula: false };
    }
    if ('formula' in o || 'sharedFormula' in o) {
      const cached = o.result === undefined || o.result === null ? EMPTY_CELL : resolveValue(o.result as ExcelJS.CellValue);
      return { ...cached, formula: true };
    }
    if ('text' in o) return { text: String(o.text ?? '').trim(), num: false, formula: false };
    if ('error' in o) return EMPTY_CELL;
  }
  return { text: String(v).trim(), num: false, formula: false };
}

/** A worksheet as a dense matrix of resolved cells — merged-title chrome and gaps come out
 *  as empty strings, all-empty rows are dropped, trailing empties trimmed. */
function sheetMatrix(ws: ExcelJS.Worksheet): CellInfo[][] {
  const rows: CellInfo[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= 400) return; // read fence — the emit caps clip far below this anyway
    const cells: CellInfo[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = resolveValue(cell.value); });
    for (let i = 0; i < cells.length; i += 1) cells[i] = cells[i] ?? EMPTY_CELL;
    // Trim trailing blanks — but keep a blank FORMULA cell (a SUM with no cached result):
    // dropping it would hide the marker the series total-row skip depends on.
    while (cells.length && !cells[cells.length - 1].text && !cells[cells.length - 1].formula) cells.pop();
    if (cells.some((c) => c.text)) rows.push(cells);
  });
  return rows;
}

/** `Label: value` series lines for a two-column mostly-numeric sheet (a chart sheet read
 *  back as chartable points), or null when the sheet isn't series-shaped. Skips a leading
 *  header row and any trailing total row whose value cell is a formula — a SUM is derived
 *  data, and importing it would double-count on re-render. */
function seriesLines(rows: CellInfo[][]): string[] | null {
  if (rows.length < 2 || rows.some((r) => r.length > 2)) return null;
  let data = rows;
  if (data[0][1] && !data[0][1].num) data = data.slice(1);
  while (data.length && data[data.length - 1][1]?.formula) data = data.slice(0, -1);
  if (!data.length) return null;
  const numeric = data.filter((r) => r[1]?.num).length;
  if (numeric < Math.ceil(data.length * 0.6)) return null;
  return data.map((r) => `${(r[0]?.text || 'Item').replace(/:/g, ' ').trim()}: ${r[1]?.text ?? ''}`);
}

/** Any other populated sheet as pipe rows (first row = header), clipped to the table caps
 *  with a `(+N more rows)` marker so the outline admits what it dropped. */
function xlsxTableLines(rows: CellInfo[][]): string[] {
  const width = Math.max(1, Math.min(CAP.tableCols, Math.max(...rows.map((r) => r.length))));
  const shown = rows.slice(0, CAP.tableRows + 1); // header + up to tableRows data rows
  const out = shown.map((r) => pipeRow(Array.from({ length: width }, (_, i) => r[i]?.text ?? '')));
  if (rows.length > shown.length) out.push(`(+${rows.length - shown.length} more rows)`);
  return out;
}

/**
 * @description Parse an Excel workbook back into the outline model: one section per
 * worksheet (title = sheet name). A two-column mostly-numeric sheet reads back as
 * `Label: value` series lines — the shape the chart layouts re-render — with header and
 * SUM-total rows dropped; anything else with rows reads back as a capped pipe table. Never
 * throws: unreadable input logs a warning and returns an empty outline.
 * @param buf - the .xlsx file bytes.
 * @returns the recovered outline (format 'xlsx').
 */
export async function importXlsx(buf: Buffer): Promise<ImportedOutline> {
  try {
    // exceljs unzips internally where this module can't meter it — prove the archive
    // inflates within budget first, so a zip bomb never reaches exceljs at all.
    await assertZipWithinBudget(await JSZip.loadAsync(buf), newInflateBudget());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const drafts: Draft[] = [];
    for (const ws of wb.worksheets.slice(0, CAP.sections)) {
      const rows = sheetMatrix(ws);
      const d = pushDraft(drafts, ws.name);
      for (const line of seriesLines(rows) ?? (rows.length ? xlsxTableLines(rows) : [])) pushLine(d, line);
    }
    const title = (typeof wb.title === 'string' && wb.title.trim()) || wb.worksheets[0]?.name || '';
    return toOutline(title, drafts, 'xlsx');
  } catch (err) {
    logger.warn({ err, bytes: buf?.length ?? 0 }, 'importXlsx: unreadable input — empty outline');
    return emptyOutline('xlsx');
  }
}

// ---------------------------------------------------------------------------
// .pptx — ppt/slides/slideN.xml in numeric order, notes matched through the slide rels.
// ---------------------------------------------------------------------------

/** Placeholder types that are deck chrome, not content — their text (slide numbers, the
 *  notes-page thumbnail, footers, dates) must not leak into the outline. */
const PPTX_CHROME = new Set(['sldNum', 'sldImg', 'ftr', 'dt', 'hdr']);

/** The non-empty paragraph texts of one shape, in order. */
function aParaLines(shapeXml: string): string[] {
  const out: string[] = [];
  const paraRe = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g;
  let p: RegExpExecArray | null;
  while ((p = paraRe.exec(shapeXml))) {
    let text = '';
    const runRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
    let t: RegExpExecArray | null;
    while ((t = runRe.exec(p[0]))) text += decodeEntities(t[1]);
    text = text.replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

/** An `<a:tbl>` (inside a graphicFrame) as pipe rows. */
function aTableLines(frameXml: string): string[] {
  const rows: string[] = [];
  const rowRe = /<a:tr(?:\s[^>]*)?>[\s\S]*?<\/a:tr>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(frameXml))) {
    const cells: string[] = [];
    const cellRe = /<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[0]))) cells.push(aParaLines(c[0]).join(' '));
    if (cells.length) rows.push(pipeRow(cells));
  }
  return rows;
}

/** One slide's title + body lines, walking shapes in document order. Title = the
 *  title/ctrTitle placeholder's text; with no placeholder, the first non-empty line. */
function parsePptxSlide(xml: string): { title: string; lines: string[] } {
  let title = '';
  const lines: string[] = [];
  const shapeRe = /<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>|<p:graphicFrame(?:\s[^>]*)?>[\s\S]*?<\/p:graphicFrame>/g;
  let m: RegExpExecArray | null;
  while ((m = shapeRe.exec(xml))) {
    const shape = m[0];
    if (shape.startsWith('<p:graphicFrame')) { lines.push(...aTableLines(shape)); continue; }
    const phType = /<p:ph\b[^>]*?type="([^"]+)"/.exec(shape)?.[1] ?? '';
    if (PPTX_CHROME.has(phType)) continue;
    const paras = aParaLines(shape);
    if (!paras.length) continue;
    if ((phType === 'title' || phType === 'ctrTitle') && !title) { title = paras.join(' '); continue; }
    lines.push(...paras);
  }
  if (!title && lines.length) title = lines.shift() as string;
  return { title, lines };
}

/** One chart series: its name and ordered (category, value) points. */
interface ChartSeries { name: string; cats: string[]; vals: string[] }

/** Parse a chart part's series. pptxgenjs (and Office) store categories under `<c:cat>` and
 *  numbers under `<c:val>`, each as `<c:pt idx><c:v>…` — order restored by idx. */
function parseChartSeries(chartXml: string): ChartSeries[] {
  const out: ChartSeries[] = [];
  const serRe = /<c:ser(?:\s[^>]*)?>[\s\S]*?<\/c:ser>/g;
  const pts = (block: string): string[] => {
    const arr: Array<{ i: number; v: string }> = [];
    const ptRe = /<c:pt\s+idx="(\d+)"[^>]*>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/g;
    let p: RegExpExecArray | null;
    while ((p = ptRe.exec(block))) arr.push({ i: Number(p[1]), v: decodeEntities(p[2]).trim() });
    return arr.sort((a, b) => a.i - b.i).map((x) => x.v);
  };
  let m: RegExpExecArray | null;
  while ((m = serRe.exec(chartXml))) {
    const ser = m[0];
    const cat = /<c:cat>[\s\S]*?<\/c:cat>/.exec(ser)?.[0] ?? '';
    const val = /<c:val>[\s\S]*?<\/c:val>/.exec(ser)?.[0] ?? '';
    const name = /<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/.exec(ser)?.[1] ?? '';
    const s = { name: decodeEntities(name).trim(), cats: pts(cat), vals: pts(val) };
    if (s.cats.length && s.vals.length) out.push(s);
  }
  return out;
}

/**
 * @description The slide's chart data as outline lines. The renderer writes series into a
 * NATIVE chart part (that is the whole double-click-editable point), so a text walk of the
 * slide sees only the title — without this, numbers silently vanish on round-trip, which the
 * adversarial verify caught live. One series → `Label: value` lines (re-renders as a chart);
 * several → a pipe table (faithful, still editable).
 * @param zip - the open .pptx zip.
 * @param slideNo - slide number (for its rels part).
 * @returns micro-syntax lines recovering the chart's data, [] when the slide has no chart.
 */
async function readSlideChartLines(zip: JSZip, slideNo: string, budget: InflateBudget): Promise<string[]> {
  const rels = zip.file(`ppt/slides/_rels/slide${slideNo}.xml.rels`);
  if (!rels) return [];
  const relXml = await entryText(rels, budget);
  const lines: string[] = [];
  const relRe = /Target="([^"]*charts\/chart\d+\.xml)"/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relXml))) {
    const part = zip.file(m[1].replace(/^(\.\.\/)+/, 'ppt/').replace(/^\//, ''));
    if (!part) continue;
    const series = parseChartSeries(await entryText(part, budget));
    if (series.length === 1) {
      const s = series[0];
      s.cats.forEach((c, i) => { if (s.vals[i] !== undefined) lines.push(`${c}: ${s.vals[i]}`); });
    } else if (series.length > 1) {
      lines.push(pipeRow(['', ...series.map((s, i) => s.name || `Series ${i + 1}`)]));
      series[0].cats.forEach((c, i) => lines.push(pipeRow([c, ...series.map((s) => s.vals[i] ?? '')])));
    }
  }
  return lines;
}

/** The slide's notes text via its rels (falling back to the same-index notes part),
 *  excluding the slide-number and slide-image placeholder chrome. */
async function readPptxNotes(zip: JSZip, slideNo: string, budget: InflateBudget): Promise<string | undefined> {
  let target = `ppt/notesSlides/notesSlide${slideNo}.xml`;
  const rels = zip.file(`ppt/slides/_rels/slide${slideNo}.xml.rels`);
  if (rels) {
    const rel = /<Relationship\b[^>]*notesSlide[^>]*>/.exec(await entryText(rels, budget))?.[0] ?? '';
    const t = /Target="([^"]+)"/.exec(rel)?.[1];
    if (t) target = t.replace(/^(\.\.\/)+/, 'ppt/').replace(/^\//, '');
  }
  const part = zip.file(target);
  if (!part) return undefined;
  const noteLines: string[] = [];
  const shapeRe = /<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g;
  let m: RegExpExecArray | null;
  const xml = await entryText(part, budget);
  while ((m = shapeRe.exec(xml))) {
    const phType = /<p:ph\b[^>]*?type="([^"]+)"/.exec(m[0])?.[1] ?? '';
    if (PPTX_CHROME.has(phType)) continue;
    noteLines.push(...aParaLines(m[0]));
  }
  const text = noteLines.join('\n').trim();
  return text || undefined;
}

/**
 * @description Parse a PowerPoint deck back into the outline model: one section per slide
 * (title from the real title placeholder, body shapes as bullets, tables as pipe rows,
 * speaker notes carried minus the slide-number chrome). The deck title is slide 1's title,
 * and a cover slide that just restates it is skipped — re-rendering adds its own cover, so
 * keeping it would double the cover on every round trip. Never throws: unreadable input
 * logs a warning and returns an empty outline.
 * @param buf - the .pptx file bytes.
 * @returns the recovered outline (format 'pptx').
 */
export async function importPptx(buf: Buffer): Promise<ImportedOutline> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files)
      .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .slice(0, CAP.sections + 1); // +1: the cover may be dropped below
    if (!slides.length) {
      logger.warn({ bytes: buf?.length ?? 0 }, 'importPptx: zip has no ppt/slides parts — empty outline');
      return emptyOutline('pptx');
    }
    const budget = newInflateBudget();
    const drafts: Draft[] = [];
    for (const s of slides) {
      const parsed = parsePptxSlide(await entryText(zip.files[s[0]], budget));
      const d = pushDraft(drafts, parsed.title);
      for (const line of parsed.lines) pushLine(d, line);
      for (const line of await readSlideChartLines(zip, s[1], budget)) pushLine(d, line);
      const notes = await readPptxNotes(zip, s[1], budget);
      if (notes) d.notes = notes;
    }
    const deckTitle = drafts[0]?.title || 'Presentation';
    if (drafts.length > 1 && drafts[0].title === deckTitle) drafts.shift();
    return toOutline(deckTitle, drafts, 'pptx');
  } catch (err) {
    logger.warn({ err, bytes: buf?.length ?? 0 }, 'importPptx: unreadable input — empty outline');
    return emptyOutline('pptx');
  }
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

/** Best-guess format from a filename hint — the fallback identity when the bytes say nothing. */
function formatFromHint(hint?: string): OfficeFormat {
  const m = /\.(docx|xlsx|pptx)\s*$/i.exec(String(hint ?? '').trim());
  return m ? (m[1].toLowerCase() as OfficeFormat) : 'docx';
}

/** The formats whose signature parts are present in the zip; [Content_Types].xml as backup
 *  for repackaged files whose parts live at nonstandard paths. */
async function sniffFormats(zip: JSZip): Promise<OfficeFormat[]> {
  const found: OfficeFormat[] = [];
  if (zip.file('word/document.xml')) found.push('docx');
  if (zip.file('xl/workbook.xml')) found.push('xlsx');
  if (zip.file('ppt/presentation.xml')) found.push('pptx');
  if (found.length) return found;
  const types = zip.file('[Content_Types].xml');
  const ct = types ? await entryText(types, newInflateBudget()) : '';
  if (ct.includes('wordprocessingml')) found.push('docx');
  if (ct.includes('spreadsheetml')) found.push('xlsx');
  if (ct.includes('presentationml')) found.push('pptx');
  return found;
}

/**
 * @description Import any Office file: sniff the real format from the zip's part names
 * (word/document.xml vs xl/workbook.xml vs ppt/presentation.xml) and dispatch to the
 * matching parser. The bytes always win over the name — files get renamed, uploads lie —
 * so the `hint` filename only breaks a tie when the bytes are ambiguous, and supplies the
 * best-guess `format` label when the input isn't a readable Office file at all. Never
 * throws: corrupt zips, empty buffers, and part-less archives log a warning and return an
 * empty outline.
 * @param buf - the file bytes.
 * @param hint - optional filename, used only as a tiebreaker / fallback label.
 * @returns the recovered outline with the format the bytes proved.
 */
export async function importOffice(buf: Buffer, hint?: string): Promise<ImportedOutline> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const found = await sniffFormats(zip);
    const hinted = formatFromHint(hint);
    const format = found.length === 1 ? found[0] : found.includes(hinted) ? hinted : found[0];
    if (!format) {
      logger.warn({ hint, bytes: buf?.length ?? 0 }, 'importOffice: zip has no recognizable Office parts — empty outline');
      return emptyOutline(hinted);
    }
    if (format === 'docx') return importDocx(buf);
    if (format === 'xlsx') return importXlsx(buf);
    return importPptx(buf);
  } catch (err) {
    logger.warn({ err, hint, bytes: buf?.length ?? 0 }, 'importOffice: unreadable input — empty outline');
    return emptyOutline(formatFromHint(hint));
  }
}
