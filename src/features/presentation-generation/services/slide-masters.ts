/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — defines the active theme's six slide masters. This is what makes a generated deck a real PowerPoint TEMPLATE rather than drawn-on shapes: masters carry the theme chrome once, expose real title/body placeholders (so Outline view + Reset Slide work), and declare a slide-number FIELD that renumbers itself when the user reorders slides on their desktop.
 */

import type pptxgen from 'pptxgenjs';
import type { DeckTheme } from './deck-themes';
import { GRID, MASTER, titleBox, bodyBox, featureBand } from './layout-kit';

/** One entry in a master's `objects` array. Masters accept only rect/line/text/image/chart/placeholder. */
type MasterObject = NonNullable<pptxgen.SlideMasterProps['objects']>[number];

/** Slide-number field style — a real PowerPoint field, so it renumbers on reorder. */
function numberField(theme: DeckTheme, deep: boolean): pptxgen.SlideNumberProps {
  return {
    x: GRID.W - GRID.MX - 0.8, y: GRID.FOOT_Y, w: 0.8, h: 0.26, align: 'right',
    fontFace: theme.fonts.mono, fontSize: 9, bold: true,
    color: deep ? theme.colors.deepInkSoft : theme.colors.accent,
  };
}

/** The running footer text (the deck title), baked onto the master so it costs one shape per deck. */
function footerObject(theme: DeckTheme, deckTitle: string, deep: boolean): MasterObject {
  return {
    text: {
      text: deckTitle.length > 68 ? deckTitle.slice(0, 67) + '…' : deckTitle,
      options: {
        x: GRID.MX, y: GRID.FOOT_Y, w: GRID.CW - 1, h: 0.26,
        fontFace: theme.fonts.mono, fontSize: 9,
        color: deep ? theme.colors.deepInkSoft : theme.colors.inkSoft, transparency: 25,
      },
    },
  };
}

/**
 * @description A hairline grid — the blueprint voice. Drawn as ~41 ruled lines rather than a
 * field of dots: a dot grid at a readable pitch is 500+ shapes, which bloats every slide that
 * uses the master.
 */
function gridLines(theme: DeckTheme, deep: boolean): MasterObject[] {
  const color = deep ? theme.colors.accent : theme.colors.line;
  const out: MasterObject[] = [];
  const pitch = 0.5;
  for (let x = pitch; x < GRID.W; x += pitch) {
    out.push({ line: { x, y: 0, w: 0, h: GRID.H, line: { color, width: 0.5, transparency: deep ? 88 : 72 } } });
  }
  for (let y = pitch; y < GRID.H; y += pitch) {
    out.push({ line: { x: 0, y, w: GRID.W, h: 0, line: { color, width: 0.5, transparency: deep ? 88 : 72 } } });
  }
  return out;
}

/**
 * @description The theme's content-slide chrome: the spine / rule / bar / chip / grid that
 * makes each theme structurally recognisable at a glance.
 */
function contentDecor(theme: DeckTheme): MasterObject[] {
  const c = theme.colors;
  const tb = titleBox(theme);
  const underY = GRID.TITLE_Y + GRID.TITLE_H + 0.1;
  switch (theme.decor) {
    case 'sidebar':
      return [{ rect: { x: 0, y: 0, w: 0.22, h: GRID.H, fill: { color: c.accent }, line: { type: 'none' } } }];
    case 'bar':
      return [{ rect: { x: tb.x, y: underY, w: 1.1, h: 0.075, fill: { color: c.accent }, line: { type: 'none' } } }];
    case 'rule':
      return [{ rect: { x: GRID.MX, y: underY, w: GRID.CW, h: 0.02, fill: { color: c.line }, line: { type: 'none' } } }];
    case 'chip':
      return [{ rect: { x: GRID.MX, y: GRID.TITLE_Y + 0.16, w: 0.18, h: 0.6, fill: { color: c.accent }, line: { type: 'none' } } }];
    case 'grid':
      // Keyed off the canvas, not a literal: a light-canvas theme adopting `grid` decor would
      // otherwise get accent-on-white rules at deep-surface transparency.
      return gridLines(theme, theme.darkCanvas);
    case 'none':
    default:
      return [];
  }
}

/**
 * @description The theme's feature-surface chrome (cover / section / closing). `wash` themes
 * contribute nothing here — their blooms are ellipses, which masters can't hold, so
 * `paintWash` draws them per-slide.
 */
function featureDecor(theme: DeckTheme): MasterObject[] {
  const c = theme.colors;
  switch (theme.cover) {
    case 'block':
      return [{ rect: { x: 0, y: 0, w: 0.46, h: GRID.H, fill: { color: c.accent }, line: { type: 'none' } } }];
    case 'rule':
      return [{ rect: { x: GRID.MX, y: 2.42, w: 2.1, h: 0.045, fill: { color: c.accent }, line: { type: 'none' } } }];
    case 'band':
      return [{ rect: { x: 0, y: 2.72, w: GRID.W, h: 0.09, fill: { color: c.accent }, line: { type: 'none' } } }];
    case 'split':
      return [
        { rect: { x: 0, y: 0, w: 4.5, h: GRID.H, fill: { color: c.accent, transparency: 84 }, line: { type: 'none' } } },
        { rect: { x: 4.5, y: 0, w: 0.035, h: GRID.H, fill: { color: c.accent }, line: { type: 'none' } } },
      ];
    case 'grid':
      return [
        ...gridLines(theme, true),
        { rect: { x: GRID.MX, y: 2.5, w: 1.5, h: 0.03, fill: { color: c.accent }, line: { type: 'none' } } },
      ];
    case 'wash':
    default:
      return [];
  }
}

/** A title placeholder matching the shared title geometry. */
function titlePlaceholder(theme: DeckTheme): MasterObject {
  return { placeholder: { options: { name: 'title', type: 'title', ...titleBox(theme) }, text: '' } };
}

/** A body placeholder matching the shared body geometry. */
function bodyPlaceholder(theme: DeckTheme): MasterObject {
  return { placeholder: { options: { name: 'body', type: 'body', ...bodyBox(theme) }, text: '' } };
}

/**
 * @description Define the active theme's six slide masters on a deck.
 *
 * These are the layouts the user sees under Home ▸ New Slide when they open the .pptx on
 * their desktop, so the set mirrors what a real template ships. The split between CONTENT
 * (title + body) and CANVAS (title only) is deliberate and load-bearing: pptxgenjs copies any
 * master placeholder a slide does NOT fill onto that slide as an empty "Click to add text"
 * prompt box, so a chart or KPI slide must not inherit a body placeholder it will never use.
 *
 * @param pptx - the deck being built.
 * @param theme - the resolved theme whose chrome and palette the masters carry.
 * @param deckTitle - baked into the running footer (one shape per deck, not per slide).
 * @param opts - `slideNumbers: false` omits the number field from every master.
 */
export function defineDeckMasters(
  pptx: pptxgen, theme: DeckTheme, deckTitle: string, opts: { slideNumbers?: boolean } = {},
): void {
  const c = theme.colors;
  const feature = featureDecor(theme);
  const band = featureBand(theme);
  const numbered = opts.slideNumbers !== false;
  /** Slide-number field, or nothing when the deck opted out. */
  const num = (deep: boolean) => (numbered ? { slideNumber: numberField(theme, deep) } : {});

  // Cover — deep surface, title + subtitle, no number (covers aren't numbered).
  pptx.defineSlideMaster({
    title: MASTER.COVER,
    background: { color: c.deep },
    objects: [
      ...feature,
      { placeholder: { options: { name: 'title', type: 'title', x: band.x, y: 2.62, w: band.w, h: 1.5 }, text: '' } },
      { placeholder: { options: { name: 'body', type: 'body', x: band.x, y: 4.24, w: band.w, h: 0.9 }, text: '' } },
    ],
  });

  // Section divider — deep surface, title only.
  pptx.defineSlideMaster({
    title: MASTER.SECTION,
    background: { color: c.deep },
    objects: [
      ...feature,
      { placeholder: { options: { name: 'title', type: 'title', x: band.x, y: 3.02, w: band.w, h: 1.3 }, text: '' } },
      footerObject(theme, deckTitle, true),
    ],
    ...num(true),
  });

  // Content — the workhorse: title + body placeholders.
  pptx.defineSlideMaster({
    title: MASTER.CONTENT,
    background: { color: c.canvas },
    objects: [...contentDecor(theme), titlePlaceholder(theme), bodyPlaceholder(theme), footerObject(theme, deckTitle, false)],
    ...num(false),
  });

  // Canvas — title only; the layout owns the body region (charts, tiles, diagrams).
  pptx.defineSlideMaster({
    title: MASTER.CANVAS,
    background: { color: c.canvas },
    objects: [...contentDecor(theme), titlePlaceholder(theme), footerObject(theme, deckTitle, false)],
    ...num(false),
  });

  // Feature — full-bleed deep surface, no placeholders (statement / quote / image-full).
  pptx.defineSlideMaster({
    title: MASTER.FEATURE,
    background: { color: c.deep },
    objects: [footerObject(theme, deckTitle, true)],
    ...num(true),
  });

  // Closing — deep surface, title + body, unnumbered.
  pptx.defineSlideMaster({
    title: MASTER.CLOSING,
    background: { color: c.deep },
    objects: [
      ...feature,
      { placeholder: { options: { name: 'title', type: 'title', x: band.x, y: 2.72, w: band.w, h: 1.3 }, text: '' } },
      { placeholder: { options: { name: 'body', type: 'body', x: band.x, y: 4.16, w: band.w, h: 1.6 }, text: '' } },
    ],
  });
}
