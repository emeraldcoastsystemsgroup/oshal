/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the deck design system: one grid + one set of drawing primitives that every layout composes from. This is what keeps 20 layouts x 10 themes looking like one designed deck instead of 200 unrelated slides.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Modern refresh (operator: "templates feel like 1980"). Wider margins, taller title band, titles 27→30pt, eyebrow becomes a filled accent pill, rounded-theme panels float on a soft outer shadow (flat themes stay deliberately crisp — Swiss/paper/blueprint read WRONG with depth), looser bullet leading. Depth without gradients: pptxgenjs has no gradient fill, so modernity comes from scale, space, and shadow.
 */

import type pptxgen from 'pptxgenjs';
import type { DeckTheme } from './deck-themes';

/** A pptxgenjs slide handle. Aliased so layouts never import pptxgenjs directly. */
export type Slide = ReturnType<pptxgen['addSlide']>;

/** Everything a layout needs to draw: the deck handle + the resolved theme. */
export interface DeckCtx {
  pptx: pptxgen;
  theme: DeckTheme;
}

/** A rectangle in inches. */
export interface Box { x: number; y: number; w: number; h: number }

/**
 * @description The deck grid, in inches. 13.333 x 7.5 is PowerPoint's own 16:9 size — not
 * pptxgenjs's `LAYOUT_WIDE` (13.3), whose 0.033in shortfall leaves a hairline of empty deck
 * against a native 16:9 template when the user edits on the desktop.
 */
export const GRID = {
  /** Slide width. 13.3333333in, NOT 13.333 — pptxgenjs converts to EMU with
   *  `round(inches * 914400)`, so 13.333 lands on 12191695 while PowerPoint's real 16:9 is
   *  exactly 12192000. Those 305 EMU are invisible, but they make PowerPoint report the deck
   *  as a *Custom* slide size instead of the standard Widescreen preset — which is what
   *  rescales slides when the user pastes them into another 16:9 deck. */
  W: 13.3333333,
  /** Slide height. */
  H: 7.5,
  /** Left/right margin. Generous on purpose — cramped margins are the fastest way for a deck
   *  to read as dated; whitespace is the cheapest modernity there is. */
  MX: 0.72,
  /** Usable content width (W - 2*MX). */
  CW: 13.3333333 - 0.72 * 2,
  /** Eyebrow/kicker baseline — a fixed strip ABOVE the title band. Fixed (rather than
   *  shifting the title down when present) so the title placeholder's geometry is constant
   *  and can be declared on the slide master. */
  EYEBROW_Y: 0.28,
  /** Title band top. */
  TITLE_Y: 0.58,
  /** Title band height — sized for the 30pt title. */
  TITLE_H: 0.92,
  /** Body top (clears the title band + its decoration). */
  BODY_Y: 1.92,
  /** Body bottom — content must not cross this. */
  BODY_B: 6.82,
  /** Footer baseline. */
  FOOT_Y: 6.98,
  /** Gutter between columns/tiles. */
  GAP: 0.3,
} as const;

/** Usable body height. */
export const BODY_H = GRID.BODY_B - GRID.BODY_Y;

/**
 * @description Master names. These are the layouts the user sees in PowerPoint's
 * Home ▸ New Slide dropdown after they open the deck — so the set is modelled on what a real
 * template ships: a cover, a divider, title+content, title-only, a full-bleed feature, and a
 * closer. Layouts reference them by name; `slide-masters` defines them once per deck.
 */
export const MASTER = {
  /** Deck opener — deep surface, title + subtitle placeholders. */
  COVER: 'OSHAL_COVER',
  /** Section divider — deep surface, title placeholder. */
  SECTION: 'OSHAL_SECTION',
  /** Title + body placeholders — the workhorse. */
  CONTENT: 'OSHAL_CONTENT',
  /** Title only; the body is the layout's own canvas (charts, tiles, diagrams). */
  CANVAS: 'OSHAL_CANVAS',
  /** Full-bleed deep surface, no placeholders (statement / quote / image-full). */
  FEATURE: 'OSHAL_FEATURE',
  /** Closing — deep surface, title + body placeholders. */
  CLOSING: 'OSHAL_CLOSING',
} as const;

/**
 * @description The title placeholder's box for a theme. Shared by `slide-masters` (which
 * declares the placeholder) and `drawTitle` (which fills it) so the two can never drift —
 * a mismatch would make PowerPoint's "Reset Slide" jump the title to a different spot.
 * @param theme - active theme.
 * @returns the title box in inches.
 */
export function titleBox(theme: DeckTheme): Box {
  const indent = theme.decor === 'sidebar' ? 0.28 : 0;
  const chip = theme.decor === 'chip' ? 0.36 : 0;
  return {
    x: GRID.MX + indent + chip,
    y: GRID.TITLE_Y,
    w: GRID.CW - indent - chip,
    h: GRID.TITLE_H,
  };
}

/**
 * @description The body placeholder's box for a theme — the region a content layout may
 * draw into, below the title band and above the footer.
 * @param theme - active theme.
 * @returns the body box in inches.
 */
export function bodyBox(theme: DeckTheme): Box {
  const indent = theme.decor === 'sidebar' ? 0.28 : 0;
  return { x: GRID.MX + indent, y: GRID.BODY_Y, w: GRID.CW - indent, h: GRID.BODY_B - GRID.BODY_Y };
}

/**
 * @description The horizontal band text occupies on a feature surface (cover / section /
 * statement / closing). `split` themes paint a panel over the left 4.5in, so their feature
 * text starts to its right. Shared by `slide-masters` and the feature layouts so a theme's
 * cover text and its cover placeholder can never disagree.
 * @param theme - active theme.
 * @returns the x offset and width for feature text.
 */
export function featureBand(theme: DeckTheme): { x: number; w: number } {
  const x = theme.cover === 'split' ? 5.0 : GRID.MX;
  const rightPad = theme.cover === 'split' ? GRID.MX : 1.2;
  return { x, w: GRID.W - x - rightPad };
}

/**
 * @description Ink colors for a surface. Layouts ask for these rather than reaching into the
 * palette, so a layout drawn on the deep surface can't accidentally use canvas ink.
 * @param theme - the active theme.
 * @param deep - true for the inverted feature surfaces (cover / section / statement).
 * @returns primary/secondary text colors and the surface background.
 */
export function inkFor(theme: DeckTheme, deep = false): { ink: string; soft: string; bg: string } {
  const c = theme.colors;
  return deep
    ? { ink: c.deepInk, soft: c.deepInkSoft, bg: c.deep }
    : { ink: c.ink, soft: c.inkSoft, bg: c.canvas };
}

/**
 * @description Relative luminance of a bare hex color (WCAG formula).
 * @param hex - 6-digit hex without '#'.
 * @returns luminance in 0..1.
 */
export function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const s = parseInt(v.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/**
 * @description Pick readable text for an arbitrary background — used where a layout paints a
 * theme accent behind text (chips, KPI tiles, chevrons) and the accent's lightness varies by
 * theme. Guessing wrong here is how generated decks end up with unreadable dark-on-dark chips.
 * @param bg - bare hex background the text sits on.
 * @returns near-black or near-white, whichever has more contrast.
 */
export function readableOn(bg: string): string {
  return luminance(bg) > 0.45 ? '111111' : 'FFFFFF';
}

/**
 * @description Apply the theme's title casing rule.
 * @param theme - active theme.
 * @param text - raw title.
 * @returns the title as the theme wants it set.
 */
export function titleCase(theme: DeckTheme, text: string): string {
  return theme.headingCase === 'upper' ? String(text || '').toUpperCase() : String(text || '');
}

/**
 * @description Choose a font size that fits the content volume. Deterministic on purpose:
 * PowerPoint's own autofit reflows when the user edits, which would silently undo the
 * layout's spacing, so the renderer sizes text itself and leaves autofit off.
 * @param count - number of items (bullets, tiles, rows).
 * @param base - size used at the comfortable count.
 * @param min - floor the size never drops below.
 * @param comfortable - item count that still renders at `base`.
 * @returns a point size in [min, base].
 */
export function scaleFor(count: number, base: number, min: number, comfortable = 5): number {
  if (count <= comfortable) return base;
  const step = (base - min) / Math.max(1, comfortable);
  return Math.max(min, Math.round((base - (count - comfortable) * step) * 2) / 2);
}

/**
 * @description Truncate to a hard character budget on a word boundary, with an ellipsis.
 * Layouts have fixed geometry; text that overflows its box silently overlaps the next
 * element in PowerPoint, so anything unbounded gets clipped here instead.
 * @param text - source string.
 * @param max - maximum characters.
 * @returns the clipped string.
 */
export function clip(text: string, max: number): string {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/**
 * @description Paint a slide's base surface. Every layout starts here.
 * @param slide - target slide.
 * @param ctx - deck context.
 * @param deep - true for the inverted feature surface.
 */
export function paintSurface(slide: Slide, ctx: DeckCtx, deep = false): void {
  slide.background = { color: inkFor(ctx.theme, deep).bg };
}

/**
 * @description The theme's signature wash — two oversized translucent blooms behind a
 * feature surface. Drawn per-slide rather than on the master because pptxgenjs masters only
 * accept rect/line/text/image objects, not ellipses. Built from native shapes (not a
 * background image) so it survives editing and can be recolored on the desktop.
 * @param slide - target slide.
 * @param ctx - deck context.
 */
export function paintWash(slide: Slide, ctx: DeckCtx): void {
  const { pptx, theme } = ctx;
  if (theme.cover !== 'wash') return;
  const c = theme.colors;
  slide.addShape(pptx.ShapeType.ellipse, { x: -2.2, y: -2.6, w: 9.6, h: 8.2, fill: { color: c.accent, transparency: 76 }, line: { type: 'none' } });
  slide.addShape(pptx.ShapeType.ellipse, { x: 6.4, y: 2.4, w: 9.4, h: 8.0, fill: { color: c.accent2, transparency: 82 }, line: { type: 'none' } });
}

/**
 * @description Fill the slide's title placeholder, plus an optional eyebrow. The theme's
 * chrome (sidebar spine, accent bar, hairline rule, chip, grid, footer) lives on the master —
 * this only sets text, which is why every content slide's title band lines up exactly.
 * @param slide - target slide (must use the CONTENT or CANVAS master).
 * @param ctx - deck context.
 * @param text - the title.
 * @param eyebrowText - optional kicker above the title (section name, slide role).
 * @returns the body box the layout may draw into.
 */
export function drawTitle(slide: Slide, ctx: DeckCtx, text: string, eyebrowText?: string): Box {
  const { pptx, theme } = ctx;
  const t = inkFor(theme, false);
  const tb = titleBox(theme);

  if (eyebrowText) {
    // A filled pill, not bare mono text — the small piece of chrome that most separates a
    // current deck from a 2005 one. Flat themes keep sharp corners; everyone else gets a pill.
    const label = clip(eyebrowText, 42).toUpperCase();
    const x = GRID.MX + (theme.decor === 'sidebar' ? 0.28 : 0);
    const w = Math.min(GRID.CW * 0.6, 0.34 + label.length * 0.082);
    const flat = theme.radius === 0;
    slide.addShape(flat ? pptx.ShapeType.rect : pptx.ShapeType.roundRect, {
      x, y: GRID.EYEBROW_Y, w, h: 0.3, fill: { color: theme.colors.accent }, line: { type: 'none' },
      ...(flat ? {} : { rectRadius: 0.15 }),
    });
    slide.addText(label, {
      x, y: GRID.EYEBROW_Y, w, h: 0.3, align: 'center', valign: 'middle',
      fontFace: theme.fonts.mono, fontSize: 9.5, color: readableOn(theme.colors.accent),
      charSpacing: 1.4, bold: true,
    });
  }

  slide.addText(titleCase(theme, clip(text, 90)), {
    placeholder: 'title', ...tb, fontFace: theme.fonts.heading,
    fontSize: 30, bold: theme.fonts.heading !== 'Garamond', color: t.ink, valign: 'middle',
    charSpacing: theme.headingCase === 'upper' ? 0.6 : 0,
  });

  return bodyBox(theme);
}

/**
 * @description Body bullets with the theme's body face and rhythm. Sizes down as the count
 * grows so a 9-bullet slide still fits its box.
 * @param slide - target slide.
 * @param ctx - deck context.
 * @param items - bullet lines.
 * @param box - the box to fill.
 * @param deep - true when drawn on the deep surface.
 */
export function drawBullets(slide: Slide, ctx: DeckCtx, items: string[], box: Box, deep = false): void {
  const { theme } = ctx;
  const t = inkFor(theme, deep);
  if (!items.length) return;
  const size = scaleFor(items.length, 18, 12.5, 5);
  slide.addText(
    items.map((b) => ({
      text: clip(b, 220),
      options: {
        bullet: { code: '2022', indent: 16 }, fontSize: size, color: t.ink,
        fontFace: theme.fonts.body, breakLine: true,
        paraSpaceAfter: Math.max(6, size * 0.7), lineSpacingMultiple: 1.18,
      },
    })),
    { x: box.x, y: box.y, w: box.w, h: box.h, valign: 'top' },
  );
}

/**
 * @description A surface panel — the tile every grid layout is built from. Honors the
 * theme's corner radius, and uses a hairline instead of a fill on the flat themes
 * (monochrome/paper/blueprint) where a filled tile would read as a mistake.
 * @param slide - target slide.
 * @param ctx - deck context.
 * @param box - panel geometry.
 * @param opts - `accent` tints the panel with the theme accent; `border` forces a hairline.
 */
export function drawPanel(slide: Slide, ctx: DeckCtx, box: Box, opts: { accent?: string; border?: boolean } = {}): void {
  const { pptx, theme } = ctx;
  const flat = theme.radius === 0;
  const shape = flat ? pptx.ShapeType.rect : pptx.ShapeType.roundRect;
  slide.addShape(shape, {
    ...box,
    fill: opts.accent
      ? { color: opts.accent, transparency: theme.darkCanvas ? 84 : 90 }
      : { color: theme.colors.canvasAlt },
    line: opts.border || flat ? { color: opts.accent ?? theme.colors.line, width: 1 } : { type: 'none' },
    ...(flat ? {} : { rectRadius: theme.radius }),
    // The float. Rounded themes get a soft drop so tiles sit ABOVE the canvas instead of being
    // flat rectangles printed on it. Flat themes (monochrome/paper/blueprint) get none — their
    // whole voice is crisp print, and a shadow there reads as a mistake, not depth.
    ...(flat ? {} : {
      shadow: {
        type: 'outer' as const, color: '000000', blur: 9, offset: 2, angle: 90,
        opacity: theme.darkCanvas ? 0.45 : 0.14,
      },
    }),
  });
}

/**
 * @description Split a box into `n` equal columns separated by the grid gutter.
 * @param box - the box to divide.
 * @param n - column count.
 * @param gap - gutter width; defaults to the grid gutter.
 * @returns `n` boxes, left to right.
 */
export function columns(box: Box, n: number, gap: number = GRID.GAP): Box[] {
  const w = (box.w - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: box.x + i * (w + gap), y: box.y, w, h: box.h }));
}

/**
 * @description Split a box into `n` equal rows separated by the grid gutter.
 * @param box - the box to divide.
 * @param n - row count.
 * @param gap - gutter height; defaults to the grid gutter.
 * @returns `n` boxes, top to bottom.
 */
export function rows(box: Box, n: number, gap: number = GRID.GAP): Box[] {
  const h = (box.h - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: box.x, y: box.y + i * (h + gap), w: box.w, h }));
}
