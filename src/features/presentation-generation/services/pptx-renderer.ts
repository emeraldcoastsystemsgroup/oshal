/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — real .pptx rendering via pptxgenjs (the missing half of PresentationEngine, which only produced slide DATA). Replaces Presenton: structured slides -> a downloadable PowerPoint file.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Themed rendering. Was: one hardcoded navy cover + one bullet layout, no template selection anywhere (the `templateId` on the request was never read). Now: resolves one of ten themes, defines its real slide masters, parses each slide's content, and composes a layout per slide from the twenty available. Signature stays (title, slides) so existing callers are unaffected.
 */

import pptxgen from 'pptxgenjs';
import { createChildLogger } from '@/shared/logger';
import type { DeckRenderOptions, RenderableSlide, SlideData, SlideLayoutId } from '@/shared/types';
import { resolveTheme, type DeckTheme } from './deck-themes';
import { defineDeckMasters } from './slide-masters';
import { resolveSlideImages } from './image-source';
import { parseSlideContent } from './slide-content-parser';
import { autoSelectLayout, applyDeckRhythm, isLayoutId } from './layout-autoselect';
import { LAYOUTS, resolveLayout } from './layout-registry';
import { GRID, type DeckCtx } from './layout-kit';
import type { LayoutDef, SlideSpec } from './layout-types';

const logger = createChildLogger({ module: 'pptx-renderer' });

/** Custom 16:9 layout. pptxgenjs's own `LAYOUT_WIDE` is 13.3in — 0.033in short of PowerPoint's
 *  real 16:9, which leaves a hairline gap against a native template when the user edits. */
const LAYOUT_NAME = 'OSHAL_16x9';

export type { RenderableSlide } from '@/shared/types';

/** A slide resolved to its final layout + spec, ready to draw. */
interface Composed {
  spec: SlideSpec;
  layout: LayoutDef;
  notes?: string;
}

/** Merge the slide's explicit fields into its parsed data (explicit fields win). */
function dataFor(s: RenderableSlide): SlideData {
  const data = parseSlideContent(s.content);
  if (s.image) data.image = s.image;
  if (s.layout && isLayoutId(s.layout)) data.directives.layout = s.layout;
  return data;
}

/** Build the deck's cover from the deck title + render options. */
function coverSpec(title: string, opts: DeckRenderOptions, total: number): SlideSpec {
  const data = parseSlideContent('');
  if (opts.byline) data.directives.byline = opts.byline;
  return { title, subtitle: opts.subtitle, data, index: 1, total, deckTitle: title };
}

/**
 * @description Choose each slide's layout, then vary long bullet runs.
 * @param slides - the authored slides.
 * @param datas - their parsed content, same order.
 * @param autoLayout - false pins everything to its declared layout (or bullets).
 * @returns one layout id per slide.
 */
function pickLayouts(slides: RenderableSlide[], datas: SlideData[], autoLayout: boolean): SlideLayoutId[] {
  const picks = slides.map((s, i) => {
    const declared = datas[i].directives.layout;
    if (isLayoutId(declared)) return declared;
    if (!autoLayout) return 'bullets' as SlideLayoutId;
    return autoSelectLayout(s.title || '', datas[i], { index: i + 1, total: slides.length, typeHint: s.type });
  });
  return autoLayout ? applyDeckRhythm(picks, datas) : picks;
}

/**
 * @description Compose the deck: a cover, then every authored slide resolved to a layout,
 * with section context threaded through so content slides can print their section as an
 * eyebrow and dividers can number themselves.
 * @param title - deck title.
 * @param slides - authored slides.
 * @param opts - render options.
 * @returns the ordered, fully-resolved slides.
 */
function composeDeck(title: string, slides: RenderableSlide[], opts: DeckRenderOptions): Composed[] {
  const datas = slides.map(dataFor);
  const picks = pickLayouts(slides, datas, opts.autoLayout !== false);
  const total = slides.length + 1;

  const out: Composed[] = [{ spec: coverSpec(title, opts, total), layout: LAYOUTS.cover }];
  let sectionName: string | undefined;
  let sectionOrdinal = 0;

  slides.forEach((s, i) => {
    const id = picks[i];
    const isDivider = id === 'section';
    if (isDivider) { sectionOrdinal += 1; sectionName = s.title; }
    out.push({
      spec: {
        title: s.title || '',
        subtitle: s.subtitle ?? datas[i].directives.subtitle,
        data: datas[i],
        index: i + 2,
        total,
        deckTitle: title,
        sectionName: isDivider ? undefined : sectionName,
        sectionOrdinal: isDivider ? sectionOrdinal : undefined,
        notes: s.notes,
      },
      layout: resolveLayout(id),
      notes: s.notes,
    });
  });
  return out;
}

/** Deck-level file metadata — what shows in PowerPoint's File ▸ Info pane. */
function applyMetadata(pptx: pptxgen, title: string, theme: DeckTheme): void {
  pptx.title = title || 'Presentation';
  pptx.subject = title || 'Presentation';
  pptx.author = 'OSHAL';
  pptx.company = 'OSHAL';
  pptx.theme = { headFontFace: theme.fonts.heading, bodyFontFace: theme.fonts.body };
}

/**
 * @description Render a deck to a real PowerPoint (.pptx) file.
 *
 * pptxgenjs emits valid OOXML (a PK-zip of XML) — what PowerPoint, Google Slides, and Keynote
 * open natively. The deck is built to stay EDITABLE on the desktop, which shapes the whole
 * design: the theme's chrome lives on real slide masters, titles fill real title placeholders
 * (so Outline view and Reset Slide work), slide numbers are real fields (so they renumber when
 * the user reorders slides), charts carry an embedded worksheet (so double-click edits the
 * data), and every font is one that ships with Office on Windows and macOS (so nothing
 * substitutes and reflows).
 *
 * @param title - deck title (cover slide, running footer, and file metadata).
 * @param slides - ordered content slides. Bodies may use the layout micro-syntax; see
 *   `slide-content-parser`. A slide with no `layout` is composed automatically from the shape
 *   of its content.
 * @param options - theme + deck-level options. Omitted → the default theme, auto-layout on.
 * @returns the .pptx file as a Buffer.
 */
export async function renderPptx(
  title: string, slides: RenderableSlide[], options: DeckRenderOptions = {},
): Promise<Buffer> {
  const started = Date.now();
  const theme = resolveTheme(options.theme);
  const deckTitle = title || 'Presentation';

  const pptx = new pptxgen();
  pptx.defineLayout({ name: LAYOUT_NAME, width: GRID.W, height: GRID.H });
  pptx.layout = LAYOUT_NAME;
  applyMetadata(pptx, deckTitle, theme);
  defineDeckMasters(pptx, theme, deckTitle, { slideNumbers: options.slideNumbers !== false });

  const ctx: DeckCtx = { pptx, theme };
  // Resolve images to inline data URIs BEFORE composing: layouts are synchronous draw
  // functions, and letting pptxgenjs fetch a `path` itself would mean the api container makes
  // a server-side request to an author-supplied host. See `image-source`.
  const safe = await resolveSlideImages(Array.isArray(slides) ? slides : []);
  const composed = composeDeck(deckTitle, safe, options);

  for (const c of composed) {
    const slide = pptx.addSlide({ masterName: c.layout.master });
    try {
      c.layout.render(slide, ctx, c.spec);
    } catch (err) {
      // One bad slide must not cost the user the whole deck — fall back to bullets, which
      // renders any content, and surface it in the logs.
      logger.error({ err, layout: c.layout.id, slide: c.spec.index }, 'layout render failed — falling back to bullets');
      LAYOUTS.bullets.render(slide, ctx, c.spec);
    }
    if (c.notes) slide.addNotes(String(c.notes));
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  logger.info(
    {
      title: deckTitle, theme: theme.id, slides: composed.length, bytes: buf.length,
      durationMs: Date.now() - started,
      layouts: composed.map((c) => c.layout.id).join(','),
    },
    'Rendered .pptx',
  );
  return buf;
}
