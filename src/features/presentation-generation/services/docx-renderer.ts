/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the Word projection of the deck outline (ADR-103 AI Office). Same slides, same themes, but sections become document sections under real Heading styles rather than pages of bullets, so the .docx stays a document: the navigation pane works, a TOC can be inserted, and restyling means editing the style — not two hundred inline runs.
 */

import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, LevelFormat, Packer,
  PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TabStopPosition,
  TabStopType, TextRun, WidthType, type IBorderOptions, type INumberingOptions, type IStylesOptions,
} from 'docx';
import { createChildLogger } from '@/shared/logger';
import type { DeckRenderOptions, RenderableSlide, SlideData } from '@/shared/types';
import { docxTheme, type DocxTheme } from './office-themes';
import { parseSlideContent } from './slide-content-parser';

const logger = createChildLogger({ module: 'docx-renderer' });

/** A block-level document child. */
type Block = Paragraph | Table;

/** Named bullet-numbering reference (one level — a document outline, not a deck, nests via headings). */
const BULLETS = 'oshal-bullets';

/** US Letter in twips, with the 1in margins the sections use. */
const PAGE = { width: 12240, height: 15840, margin: 1440 };

/** Content width (~6in) in pixels at 96dpi — what an embedded image is fitted to. */
const IMG_MAX_W = 576;
/** Tallest an image may render (in px) before it is scaled down to stay on one page. */
const IMG_MAX_H = 672;

/** Hard caps so hostile volume degrades to a clipped document, never a hung render. */
const MAX = { slides: 200, items: 100, rows: 200, cols: 12, text: 600, title: 200 };

/** Clip a value to a printable string — the "never throw, always render" floor. */
function clip(v: unknown, max: number = MAX.text): string {
  const s = String(v ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @description Word's built-in style set, re-declared from the theme. Headings keep the real
 * `Heading1`/`Heading2` ids (that is what makes the navigation pane and a TOC work), and every
 * look decision lives here rather than in inline runs, so restyling the document in Word means
 * editing one style. Serif heading faces render regular weight — bolding Garamond reads as
 * shouting, while the sans themes need the weight to hold the page.
 * @param t - the docx-shaped theme.
 * @returns the document styles config.
 */
function buildStyles(t: DocxTheme): IStylesOptions {
  const heading = {
    font: t.headingFont, color: t.ink, bold: !t.serifHeadings, italics: false, allCaps: t.headingCaps,
  };
  return {
    // The built-in styles are overridden through `default` — declaring a paragraphStyle with a
    // built-in id would leave docx's own Heading1 in the sheet alongside ours.
    default: {
      document: { run: { font: t.bodyFont, size: t.bodySize, color: t.ink } },
      title: {
        run: { ...heading, size: t.titleSize },
        paragraph: { spacing: { before: 2400, after: 240 } },
      },
      heading1: {
        run: { ...heading, size: t.h1Size },
        paragraph: { spacing: { before: 400, after: 160 }, keepNext: true, outlineLevel: 0 },
      },
      heading2: {
        run: { ...heading, size: t.h2Size, color: t.accent },
        paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 },
      },
    },
    paragraphStyles: [
      { id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: t.serifHeadings ? t.headingFont : t.bodyFont, size: t.bodySize + 4, italics: true, color: t.ink },
        paragraph: { spacing: { before: 240, after: 80 } } },
      { id: 'Caption', name: 'Caption', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: t.monoFont, size: 18, color: t.inkSoft },
        paragraph: { spacing: { before: 40, after: 200 } } },
    ],
  };
}

/** The single bullet level. One level only — depth in a document comes from headings. */
function buildNumbering(): INumberingOptions {
  return {
    config: [{
      reference: BULLETS,
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }],
    }],
  };
}

/** One bulleted body line. */
function bullet(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun(clip(text))],
    numbering: { reference: BULLETS, level: 0 },
    spacing: { after: 60 },
  });
}

/** A plain body paragraph in a caption/soft voice (slide subtitles, image captions). */
function softLine(text: string): Paragraph {
  return new Paragraph({ style: 'Caption', children: [new TextRun(clip(text))] });
}

/** A hairline border spec from the theme's line color. */
function hairline(t: DocxTheme): IBorderOptions {
  return { style: BorderStyle.SINGLE, size: 4, color: t.line };
}

/** All-sides border set for a table (including inside rules). */
function tableBorders(b: IBorderOptions): Record<string, IBorderOptions> {
  return { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
}

/** A table cell holding one styled paragraph. */
function cell(text: string, opts: { bold?: boolean; color?: string; fill?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}): TableCell {
  return new TableCell({
    children: [new Paragraph({
      alignment: opts.align,
      children: [new TextRun({ text: clip(text, 300), bold: opts.bold, color: opts.color })],
    })],
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
  });
}

/**
 * @description The parsed markdown table as a real Word table — header row on the theme panel
 * in bold accent, hairline rules, auto widths so Word owns the column fit.
 * @param table - parsed head + rows.
 * @param t - the theme.
 * @returns the table block.
 */
function dataTable(table: NonNullable<SlideData['table']>, t: DocxTheme): Table {
  const head = table.head.slice(0, MAX.cols);
  const width = Math.max(head.length, 1);
  const rows = [
    new TableRow({
      tableHeader: true,
      children: head.map((h) => cell(h, { bold: true, color: t.accent, fill: t.panel })),
    }),
    ...table.rows.slice(0, MAX.rows).map((r) => new TableRow({
      children: Array.from({ length: width }, (_, i) => cell(r[i] ?? '')),
    })),
  ];
  return new Table({ rows, width: { size: 0, type: WidthType.AUTO }, borders: tableBorders(hairline(t)) });
}

/** Invisible border set — the layout tables (pairs/series) must not read as tables. */
const NO_BORDER: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: 'auto' };

/**
 * @description `label :: value` pairs as a borderless two-column table — a definition list in
 * Word's vocabulary. Labels bold accent, values body ink.
 * @param pairs - the parsed pairs.
 * @param t - the theme.
 * @returns the table block.
 */
function pairsTable(pairs: SlideData['pairs'], t: DocxTheme): Table {
  const rows = pairs.slice(0, MAX.items).map((p) => new TableRow({
    children: [cell(p.label, { bold: true, color: t.accent }), cell(p.value, { color: t.ink })],
  }));
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorders(NO_BORDER) });
}

/**
 * @description Numeric series as a two-column table — label left, the AUTHORED display value
 * ("$1.2M", not 1200000) right-aligned, the way a financial column reads.
 * @param series - the parsed series.
 * @param t - the theme.
 * @returns the table block.
 */
function seriesTable(series: SlideData['series'], t: DocxTheme): Table {
  const rows = series.slice(0, MAX.items).map((s) => new TableRow({
    children: [
      cell(s.label, { color: t.ink }),
      cell(s.display, { bold: true, color: t.accent2, align: AlignmentType.RIGHT }),
    ],
  }));
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorders(NO_BORDER) });
}

/** A pull quote: indented, accent left border, plus its attribution as a caption line. */
function quoteBlock(quote: NonNullable<SlideData['quote']>, t: DocxTheme): Block[] {
  const out: Block[] = [new Paragraph({
    style: 'Quote',
    indent: { left: 720 },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: t.accent, space: 12 } },
    children: [new TextRun(`“${clip(quote.text)}”`)],
  })];
  if (quote.attribution) {
    out.push(new Paragraph({
      style: 'Caption', indent: { left: 720 },
      children: [new TextRun(`— ${clip(quote.attribution, MAX.title)}`)],
    }));
  }
  return out;
}

/** Intrinsic pixel size sniffed from image bytes (PNG/JPEG/GIF/BMP), or null. */
function imageDims(buf: Buffer, kind: string): { w: number; h: number } | null {
  try {
    if (kind === 'png' && buf.length >= 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (kind === 'gif' && buf.length >= 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (kind === 'bmp' && buf.length >= 26) return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
    if (kind === 'jpg') {
      for (let i = 2; i + 9 < buf.length && buf[i] === 0xff; i += 2 + buf.readUInt16BE(i + 2)) {
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
      }
    }
  } catch { /* fall through to the default box */ }
  return null;
}

/**
 * @description Embed a `data:image/...` URI, fitted to the content width. ONLY data URIs are
 * accepted: the deck pipeline resolves remote URLs upstream (SSRF-guarded, content-sniffed) and
 * hands this renderer inline data — a raw URL reaching this far is unresolved author input,
 * and the Word path must not fetch on an author's behalf. Anything else renders as nothing.
 * @param uri - the slide's image value.
 * @returns the image paragraph, or null when the image is refused.
 */
function imageBlock(uri: string): Paragraph | null {
  const m = /^data:image\/(png|jpe?g|gif|bmp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(uri ?? '').trim());
  if (!m) return null;
  try {
    const kind = m[1].toLowerCase().startsWith('jp') ? 'jpg' : (m[1].toLowerCase() as 'png' | 'gif' | 'bmp');
    const data = Buffer.from(m[2], 'base64');
    if (!data.length) return null;
    const nat = imageDims(data, kind);
    let w = nat && nat.w > 0 ? Math.min(nat.w, IMG_MAX_W) : IMG_MAX_W;
    let h = nat && nat.w > 0 && nat.h > 0 ? Math.round((nat.h / nat.w) * w) : Math.round(IMG_MAX_W * 0.66);
    if (h > IMG_MAX_H) { w = Math.round(w * (IMG_MAX_H / h)); h = IMG_MAX_H; }
    return new Paragraph({
      spacing: { before: 120, after: 120 },
      children: [new ImageRun({ type: kind, data, transformation: { width: w, height: h } })],
    });
  } catch (err) {
    logger.error({ err }, 'image embed failed — rendering the section without it');
    return null;
  }
}

/**
 * @description One authored slide as one document section: a Heading1, then its parsed content
 * mapped to document idioms. Speaker notes are deliberately omitted — they belong to the deck.
 * @param s - the authored slide.
 * @param t - the theme.
 * @returns the section's blocks.
 */
function slideBlocks(s: RenderableSlide, t: DocxTheme): Block[] {
  const data = parseSlideContent(s.content);
  if (s.image) data.image = s.image;
  const subtitle = s.subtitle ?? data.directives.subtitle;

  const out: Block[] = [new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun(clip(s.title, MAX.title) || 'Untitled section')],
  })];
  if (subtitle) out.push(softLine(subtitle));
  for (const b of data.bullets.slice(0, MAX.items)) out.push(bullet(b));
  for (const g of data.groups.slice(0, MAX.items)) {
    out.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun(clip(g.heading, MAX.title) || 'Untitled')],
    }));
    for (const item of g.items.slice(0, MAX.items)) out.push(bullet(item));
  }
  if (data.table) out.push(dataTable(data.table, t));
  if (data.pairs.length) out.push(pairsTable(data.pairs, t));
  if (data.series.length) out.push(seriesTable(data.series, t));
  if (data.quote) out.push(...quoteBlock(data.quote, t));
  if (data.image) {
    const img = imageBlock(data.image);
    if (img) out.push(img);
  }
  return out;
}

/**
 * @description The title page: deck title, subtitle, an accent rule, the byline in small-caps
 * mono at the bottom, then a page break so the body starts on its own page.
 * @param title - the deck title.
 * @param opts - render options (subtitle / byline).
 * @param t - the theme.
 * @returns the title-page blocks.
 */
function titlePage(title: string, opts: DeckRenderOptions, t: DocxTheme): Block[] {
  const out: Block[] = [new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun(clip(title, MAX.title) || 'Document')],
  })];
  if (opts.subtitle) {
    out.push(new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: clip(opts.subtitle), font: t.bodyFont, size: t.h2Size, color: t.inkSoft })],
    }));
  }
  out.push(new Paragraph({
    spacing: { after: 2400 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: t.accent, space: 4 } },
  }));
  if (opts.byline) {
    out.push(new Paragraph({
      children: [new TextRun({ text: clip(opts.byline, MAX.title), font: t.monoFont, size: 18, color: t.inkSoft, smallCaps: true })],
    }));
  }
  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

/** Running footer: deck title left, the CURRENT page-number FIELD right, in soft mono. */
function buildFooter(title: string, t: DocxTheme): Footer {
  const mono = { font: t.monoFont, size: 16, color: t.inkSoft };
  return new Footer({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [
        new TextRun({ ...mono, text: clip(title, MAX.title) }),
        new TextRun({ ...mono, children: ['\t', PageNumber.CURRENT] }),
      ],
    })],
  });
}

/**
 * @description Render the deck outline to a real Word (.docx) file.
 *
 * This is the WORD projection of the same outline `renderPptx` turns into a deck: one theme
 * vocabulary (`docxTheme` reshapes the deck theme; dark-canvas decks come out dark-ON-white,
 * because an inverted Word page is a novelty, not a document), the same content parser, but
 * document idioms — slides become Heading1 sections (navigation pane + TOC work), bullets are
 * a real list, tables are real Word tables, and the page number is a real field so it
 * renumbers. All look decisions live in the style sheet so the file stays restylable in Word.
 * Hostile or empty content degrades (clipped, skipped, per-section fallback) — it never throws.
 *
 * @param title - document title (title page, running footer, file metadata).
 * @param slides - ordered content slides; bodies may use the layout micro-syntax (see
 *   `slide-content-parser`). Speaker notes are not carried over.
 * @param options - theme + subtitle/byline. Omitted → the default theme.
 * @returns the .docx file as a Buffer.
 */
export async function renderDocx(
  title: string, slides: RenderableSlide[], options: DeckRenderOptions = {},
): Promise<Buffer> {
  const started = Date.now();
  const t = docxTheme(options.theme);
  const deckTitle = clip(title, MAX.title) || 'Document';
  const safe = (Array.isArray(slides) ? slides : [])
    .filter((s): s is RenderableSlide => !!s && typeof s === 'object')
    .slice(0, MAX.slides);

  const children: Block[] = titlePage(deckTitle, options, t);
  for (const s of safe) {
    try {
      children.push(...slideBlocks(s, t));
    } catch (err) {
      // One bad section must not cost the user the whole document — keep its heading, log it.
      logger.error({ err, slide: clip(s.title, 80) }, 'section render failed — heading-only fallback');
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun(clip(s.title, MAX.title) || 'Untitled section')],
      }));
    }
  }

  const doc = new Document({
    title: deckTitle, subject: deckTitle, creator: 'OSHAL', lastModifiedBy: 'OSHAL',
    styles: buildStyles(t),
    numbering: buildNumbering(),
    sections: [{
      properties: {
        page: {
          size: { width: PAGE.width, height: PAGE.height },
          margin: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
        },
      },
      footers: { default: buildFooter(deckTitle, t) },
      children,
    }],
  });

  const out = await Packer.toBuffer(doc);
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
  logger.info(
    { title: deckTitle, theme: t.id, sections: safe.length, bytes: buf.length, durationMs: Date.now() - started },
    'Rendered .docx',
  );
  return buf;
}
