/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the nine text/structure layouts (cover, section, agenda, bullets, two-column, comparison, quote, statement, closing). These set the deck's typographic voice; the data + visual layouts follow their conventions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Modern refresh: cover title 44→54 with tight leading, section divider gets an oversized ghost ordinal behind the heading, statement/closing scale up, quote grows, looser bullet leading — scale contrast is the visual signature of a current deck.
 */

import type { LayoutDef, SlideSpec } from '../layout-types';
import type { DeckCtx, Slide } from '../layout-kit';
import {
  GRID, MASTER, clip, columns, drawPanel, drawTitle, featureBand,
  inkFor, paintWash, readableOn, scaleFor, titleCase,
} from '../layout-kit';

/** Body lines for a slide, whatever shape the author used — layouts degrade, never blank out. */
function anyLines(spec: SlideSpec): string[] {
  const d = spec.data;
  if (d.bullets.length) return d.bullets;
  if (d.pairs.length) return d.pairs.map((p) => `${p.label} — ${p.value}`);
  if (d.series.length) return d.series.map((s) => `${s.label} — ${s.display}`);
  if (d.groups.length) return d.groups.flatMap((g) => [g.heading, ...g.items]);
  return [];
}

/** Columns for the grouped layouts — falls back to splitting bullets down the middle. */
function groupsOrSplit(spec: SlideSpec, max: number): Array<{ heading: string; items: string[] }> {
  const g = spec.data.groups;
  if (g.length) return g.slice(0, max);
  const b = spec.data.bullets;
  const half = Math.ceil(b.length / 2);
  return [{ heading: '', items: b.slice(0, half) }, { heading: '', items: b.slice(half) }];
}

/** Cover: the deck opener. */
const cover: LayoutDef = {
  id: 'cover',
  name: 'Cover',
  blurb: 'Deck opener — title, subtitle, byline on the feature surface.',
  needs: 'Deck title; first body line becomes the subtitle.',
  master: MASTER.COVER,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { pptx, theme } = ctx;
    const t = inkFor(theme, true);
    const band = featureBand(theme);
    paintWash(slide, ctx);

    // Themes whose cover style paints no mark near the title get a short accent rule, so the
    // title never floats unanchored.
    if (theme.cover === 'wash') {
      slide.addShape(pptx.ShapeType.rect, { x: band.x, y: 2.36, w: 1.6, h: 0.05, fill: { color: theme.colors.accent }, line: { type: 'none' } });
    }

    slide.addText(titleCase(theme, clip(spec.deckTitle || spec.title, 84)), {
      placeholder: 'title', x: band.x, y: 2.62, w: band.w, h: 1.5,
      fontFace: theme.fonts.heading, fontSize: 54, bold: theme.fonts.heading !== 'Garamond',
      color: t.ink, valign: 'top', lineSpacingMultiple: 1.0,
      charSpacing: theme.headingCase === 'upper' ? 1 : 0,
    });

    const sub = spec.subtitle || anyLines(spec)[0] || '';
    if (sub) {
      slide.addText(clip(sub, 150), {
        placeholder: 'body', x: band.x, y: 4.24, w: band.w, h: 0.9,
        fontFace: theme.fonts.body, fontSize: 17, color: t.soft, valign: 'top',
      });
    }

    const byline = spec.data.directives.byline;
    if (byline) {
      slide.addText(clip(byline, 90).toUpperCase(), {
        x: band.x, y: 6.42, w: band.w, h: 0.3,
        fontFace: theme.fonts.mono, fontSize: 10.5, color: theme.colors.accent, charSpacing: 1.4, bold: true,
      });
    }
  },
};

/** Section: a divider that resets attention. */
const section: LayoutDef = {
  id: 'section',
  name: 'Section',
  blurb: 'Divider — an oversized number and heading that resets attention.',
  needs: 'Just a title. Any body lines render as a one-line summary.',
  master: MASTER.SECTION,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme, true);
    const band = featureBand(theme);
    paintWash(slide, ctx);

    // The ordinal is scenery, not data: an oversized ghost numeral behind the heading gives the
    // divider its scale without adding a single word. Drawn first so the title paints over it.
    slide.addText(String(spec.sectionOrdinal ?? spec.index).padStart(2, '0'), {
      x: band.x - 0.12, y: 1.28, w: 4.2, h: 2.6,
      fontFace: theme.fonts.mono, fontSize: 150, bold: true, color: theme.colors.accent, transparency: 86,
    });
    slide.addText(titleCase(theme, clip(spec.title, 70)), {
      placeholder: 'title', x: band.x, y: 3.02, w: band.w, h: 1.3,
      fontFace: theme.fonts.heading, fontSize: 42, bold: theme.fonts.heading !== 'Garamond',
      color: t.ink, valign: 'middle', charSpacing: theme.headingCase === 'upper' ? 0.8 : 0,
    });
    const lead = anyLines(spec)[0];
    if (lead) {
      slide.addText(clip(lead, 160), {
        x: band.x, y: 4.34, w: band.w, h: 0.6, fontFace: theme.fonts.body, fontSize: 15, color: t.soft,
      });
    }
  },
};

/** Agenda: a numbered contents list. */
const agenda: LayoutDef = {
  id: 'agenda',
  name: 'Agenda',
  blurb: 'Numbered contents — what the room is about to sit through.',
  needs: 'One line per agenda item.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme);
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const items = anyLines(spec).slice(0, 8);
    if (!items.length) return;

    const rowH = Math.min(0.72, box.h / items.length);
    const size = scaleFor(items.length, 17, 13, 6);
    items.forEach((item, i) => {
      const y = box.y + i * rowH;
      slide.addText(String(i + 1).padStart(2, '0'), {
        x: box.x, y, w: 0.6, h: rowH, fontFace: theme.fonts.mono, fontSize: size - 3,
        bold: true, color: theme.colors.accent, valign: 'middle',
      });
      slide.addText(clip(item, 110), {
        x: box.x + 0.72, y, w: box.w - 0.72, h: rowH,
        fontFace: theme.fonts.body, fontSize: size, color: t.ink, valign: 'middle',
      });
      slide.addShape(ctx.pptx.ShapeType.rect, {
        x: box.x, y: y + rowH - 0.02, w: box.w, h: 0.012,
        fill: { color: theme.colors.line }, line: { type: 'none' },
      });
    });
  },
};

/** Bullets: the workhorse. */
const bullets: LayoutDef = {
  id: 'bullets',
  name: 'Bullets',
  blurb: 'Title and bullets — the workhorse, sized to fit its box.',
  needs: 'One line per bullet.',
  master: MASTER.CONTENT,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const items = anyLines(spec).slice(0, 9);
    if (!items.length) return;
    slide.addText(
      items.map((b) => ({
        text: clip(b, 220),
        options: {
          bullet: { code: '2022', indent: 16 },
          fontSize: scaleFor(items.length, 18, 12.5, 5),
          color: inkFor(ctx.theme).ink, fontFace: ctx.theme.fonts.body, breakLine: true,
          paraSpaceAfter: Math.max(6, scaleFor(items.length, 18, 12.5, 5) * 0.7),
          lineSpacingMultiple: 1.18,
        },
      })),
      { placeholder: 'body', ...box, valign: 'top' },
    );
  },
};

/** Draw a headed column of text — shared by two-column and comparison. */
function drawColumn(
  slide: Slide, ctx: DeckCtx, box: { x: number; y: number; w: number; h: number },
  group: { heading: string; items: string[] }, accent: string,
): void {
  const { theme } = ctx;
  const t = inkFor(theme);
  let y = box.y;
  if (group.heading) {
    slide.addText(clip(group.heading, 44), {
      x: box.x, y, w: box.w, h: 0.42, fontFace: theme.fonts.heading, fontSize: 16,
      bold: true, color: accent, valign: 'middle',
    });
    y += 0.52;
  }
  const size = scaleFor(group.items.length, 15.5, 11.5, 5);
  if (group.items.length) {
    slide.addText(
      group.items.slice(0, 8).map((b) => ({
        text: clip(b, 170),
        options: {
          bullet: { code: '2022', indent: 14 }, fontSize: size, color: t.ink,
          fontFace: theme.fonts.body, breakLine: true, paraSpaceAfter: size * 0.55, lineSpacingMultiple: 1.1,
        },
      })),
      { x: box.x, y, w: box.w, h: box.h - (y - box.y), valign: 'top' },
    );
  }
}

/** Two-column: parallel text. */
const twoColumn: LayoutDef = {
  id: 'two-column',
  name: 'Two column',
  blurb: 'Two or three headed columns of parallel text.',
  needs: '`## Heading` per column, then its bullets.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const groups = groupsOrSplit(spec, 3).filter((g) => g.heading || g.items.length);
    if (!groups.length) return;
    const cols = columns(box, groups.length, 0.5);
    groups.forEach((g, i) => {
      drawColumn(slide, ctx, cols[i], g, ctx.theme.colors.accent);
      if (i > 0) {
        slide.addShape(ctx.pptx.ShapeType.rect, {
          x: cols[i].x - 0.26, y: box.y, w: 0.012, h: box.h,
          fill: { color: ctx.theme.colors.line }, line: { type: 'none' },
        });
      }
    });
  },
};

/** Comparison: A vs B, differentiated by accent. */
const comparison: LayoutDef = {
  id: 'comparison',
  name: 'Comparison',
  blurb: 'Two panels weighed against each other, each in its own accent.',
  needs: '`## Option A` / `## Option B`, then bullets under each.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const groups = groupsOrSplit(spec, 2);
    const cols = columns(box, 2, 0.44);
    const accents = [theme.colors.accent, theme.colors.accent2];

    groups.forEach((g, i) => {
      drawPanel(slide, ctx, cols[i], { accent: accents[i] });
      const pad = 0.32;
      const inner = { x: cols[i].x + pad, y: cols[i].y + pad, w: cols[i].w - pad * 2, h: cols[i].h - pad * 2 };
      if (g.heading) {
        slide.addShape(theme.radius === 0 ? ctx.pptx.ShapeType.rect : ctx.pptx.ShapeType.roundRect, {
          x: inner.x, y: inner.y, w: Math.min(inner.w, 0.24 + clip(g.heading, 30).length * 0.11), h: 0.4,
          fill: { color: accents[i] }, line: { type: 'none' },
          ...(theme.radius === 0 ? {} : { rectRadius: 0.08 }),
        });
        slide.addText(clip(g.heading, 30), {
          x: inner.x + 0.12, y: inner.y, w: inner.w - 0.24, h: 0.4,
          fontFace: theme.fonts.mono, fontSize: 11.5, bold: true,
          color: readableOn(accents[i]), valign: 'middle',
        });
      }
      drawColumn(slide, ctx, { ...inner, y: inner.y + (g.heading ? 0.58 : 0), h: inner.h - (g.heading ? 0.58 : 0) },
        { heading: '', items: g.items }, accents[i]);
    });
  },
};

/** Quote: an oversized pull quote. */
const quote: LayoutDef = {
  id: 'quote',
  name: 'Quote',
  blurb: 'An oversized pull quote with attribution, full bleed.',
  needs: '`> the quote` then `— Attribution`.',
  master: MASTER.FEATURE,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme, true);
    paintWash(slide, ctx);
    const q = spec.data.quote ?? { text: anyLines(spec)[0] || spec.title, attribution: undefined };
    const text = clip(q.text, 260);

    slide.addText('“', {
      x: 0.9, y: 1.06, w: 1.6, h: 1.4, fontFace: theme.fonts.heading, fontSize: 96,
      bold: true, color: theme.colors.accent, transparency: 45,
    });
    slide.addText(text, {
      x: 1.5, y: 2.16, w: GRID.W - 3.0, h: 3.0,
      fontFace: theme.fonts.heading, fontSize: text.length > 150 ? 28 : 36,
      color: t.ink, italic: theme.fonts.heading === 'Garamond' || theme.fonts.heading === 'Georgia',
      valign: 'middle', align: 'center', lineSpacingMultiple: 1.22,
    });
    if (q.attribution) {
      slide.addShape(ctx.pptx.ShapeType.rect, {
        x: GRID.W / 2 - 0.4, y: 5.42, w: 0.8, h: 0.035,
        fill: { color: theme.colors.accent }, line: { type: 'none' },
      });
      slide.addText(clip(q.attribution, 90).toUpperCase(), {
        x: 1.5, y: 5.6, w: GRID.W - 3.0, h: 0.4, align: 'center',
        fontFace: theme.fonts.mono, fontSize: 11, color: t.soft, charSpacing: 1.4,
      });
    }
  },
};

/** Statement: one idea, full bleed. */
const statement: LayoutDef = {
  id: 'statement',
  name: 'Statement',
  blurb: 'One bold idea, full bleed. The slide people remember.',
  needs: 'A short title. One body line becomes the supporting note.',
  master: MASTER.FEATURE,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme, true);
    paintWash(slide, ctx);
    const text = clip(spec.title, 130);
    const support = spec.subtitle || anyLines(spec)[0];

    slide.addText(titleCase(theme, text), {
      x: 1.2, y: support ? 2.28 : 2.6, w: GRID.W - 2.4, h: 2.2,
      fontFace: theme.fonts.heading, fontSize: text.length > 60 ? 42 : 56,
      bold: theme.fonts.heading !== 'Garamond', color: t.ink,
      align: 'center', valign: 'middle', lineSpacingMultiple: 1.04,
      charSpacing: theme.headingCase === 'upper' ? 1 : 0,
    });
    if (support) {
      slide.addText(clip(support, 170), {
        x: 2.2, y: 4.66, w: GRID.W - 4.4, h: 0.8, align: 'center',
        fontFace: theme.fonts.body, fontSize: 16, color: t.soft,
      });
    }
  },
};

/** Closing: thank you / what happens next. */
const closing: LayoutDef = {
  id: 'closing',
  name: 'Closing',
  blurb: 'Thank-you, the ask, and how to reach you.',
  needs: 'A title; body lines become next steps or contact details.',
  master: MASTER.CLOSING,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme, true);
    const band = featureBand(theme);
    paintWash(slide, ctx);

    slide.addText(titleCase(theme, clip(spec.title, 70)), {
      placeholder: 'title', x: band.x, y: 2.72, w: band.w, h: 1.3,
      fontFace: theme.fonts.heading, fontSize: 44, bold: theme.fonts.heading !== 'Garamond',
      color: t.ink, valign: 'middle', charSpacing: theme.headingCase === 'upper' ? 1 : 0,
    });
    const items = anyLines(spec).slice(0, 4);
    if (items.length) {
      slide.addText(
        items.map((b) => ({
          text: clip(b, 120),
          options: {
            bullet: { code: '2022', indent: 14 }, fontSize: 15, color: t.soft,
            fontFace: theme.fonts.body, breakLine: true, paraSpaceAfter: 9,
          },
        })),
        { placeholder: 'body', x: band.x, y: 4.16, w: band.w, h: 1.6, valign: 'top' },
      );
    }
  },
};

/** The nine text/structure layouts. */
export const TEXT_LAYOUTS: LayoutDef[] = [
  cover, section, agenda, bullets, twoColumn, comparison, quote, statement, closing,
];
