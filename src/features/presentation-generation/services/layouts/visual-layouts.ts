/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the five visual/diagram layouts (timeline, process, quadrant, image-full, image-right). These are what stop a generated deck reading as an outline: the same parsed content the text layouts would set as bullets is composed as a track, a chain, a matrix, or a picture. Every one degrades to bullets rather than emitting an empty frame, because a diagram layout picked by the composer must never be able to lose the author's words.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Modern refresh: process chevrons replaced with numbered circle nodes on a single connector (the chevron chain is the most-dated glyph in office clip-art); timeline nodes grow and take the same shadow treatment as the panels.
 */

import type { LayoutDef, SlideSpec } from '../layout-types';
import type { Box, DeckCtx, Slide } from '../layout-kit';
import {
  GRID, MASTER, clip, columns, drawBullets, drawPanel, drawTitle,
  inkFor, paintWash, readableOn, rows, scaleFor, titleCase,
} from '../layout-kit';

/** Milestones/steps past this read as tick marks, not content, at 13.3in wide. */
const TRACK_CAP = 5;

/** Body lines for a slide, whatever shape the author used — layouts degrade, never blank out. */
function anyLines(spec: SlideSpec): string[] {
  const d = spec.data;
  if (d.bullets.length) return d.bullets;
  if (d.pairs.length) return d.pairs.map((p) => `${p.label} — ${p.value}`);
  if (d.series.length) return d.series.map((s) => `${s.label} — ${s.display}`);
  if (d.groups.length) return d.groups.flatMap((g) => [g.heading, ...g.items]);
  // Goes one step further than the text layouts' copy of this helper: these five are the
  // layouts the composer picks FOR the author, so a table- or quote-only slide can land here
  // by inference. It still has words, and an empty frame is never the right answer.
  if (d.table) return d.table.rows.map((r) => r.join(' · '));
  if (d.quote) return [d.quote.text];
  return [];
}

/** A milestone or step: a short key and the copy hanging off it. */
interface Keyed {
  /** The `when` / step name. */
  label: string;
  /** The `what` / step detail. */
  value: string;
  /** True when `label` was synthesized because the author gave one line, not a key and a value. */
  auto?: boolean;
}

/** Split a plain line into key + copy — "Q3 — beta ships" becomes {Q3, beta ships}. */
function splitKeyed(line: string, i: number): Keyed {
  const m = /^(.{1,20}?)\s*(?:—|–|--|-|:)\s+(.+)$/.exec(String(line).trim());
  if (m) return { label: m[1].trim(), value: m[2].trim() };
  return { label: String(i + 1).padStart(2, '0'), value: String(line).trim(), auto: true };
}

/**
 * Ordered key/copy items from whatever the author actually typed. `label :: value` pairs are
 * the authored form, but a track drawn from plain bullets beats a timeline that draws nothing —
 * so bullets are mined for their own key, and numbered when they haven't got one.
 */
function keyedItems(spec: SlideSpec): Keyed[] {
  const d = spec.data;
  if (d.pairs.length) return d.pairs.map((p) => ({ label: p.label, value: p.value }));
  if (d.series.length) return d.series.map((s) => ({ label: s.label, value: s.display }));
  if (d.groups.length) return d.groups.map((g) => ({ label: g.heading, value: g.items.join(' · ') }));
  return d.bullets.map(splitKeyed);
}

/**
 * A pptxgenjs image source, or null when there is nothing renderable.
 *
 * Inline `data` ONLY, deliberately. pptxgenjs fetches a `path` itself at write time, from the
 * api container — so accepting a URL here would turn an author's `#image:` line into a
 * server-side request to an arbitrary host, and would embed whatever came back (a 404 HTML
 * page included) as the picture. `image-source.resolveImage` already ran in the renderer: it
 * vetted the address, sniffed the bytes, and handed us a data URI or nothing. This stays
 * strict as the second half of that guarantee — a URL reaching this point is a bug upstream,
 * and drawing nothing is the correct response to it.
 */
function imageSource(raw?: string): { data: string } | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return /^data:image\/[\w.+-]+;base64,/i.test(s) ? { data: s } : null;
}

/** The author's caption line for the image layouts, wherever they put it. */
function captionOf(spec: SlideSpec): string | undefined {
  return spec.subtitle || spec.data.directives.caption || anyLines(spec)[0];
}

/** Nothing to diagram — set the words as bullets in the body box and keep the slide. */
function fallbackToBullets(slide: Slide, ctx: DeckCtx, spec: SlideSpec, box: Box): void {
  drawBullets(slide, ctx, anyLines(spec).slice(0, 9), box);
}

/** The `+N more` counter — extras are declared, not silently dropped. */
function drawOverflowNote(slide: Slide, ctx: DeckCtx, box: Box, extra: number, align: 'right' | 'center'): void {
  const { theme } = ctx;
  slide.addText(`+${extra} more`, {
    ...box, align, valign: 'middle',
    fontFace: theme.fonts.mono, fontSize: 9.5, color: inkFor(theme).soft, charSpacing: 0.8,
  });
}

/** One node on the track: its `when` above, the node itself, its `what` below. */
function drawMilestone(slide: Slide, ctx: DeckCtx, lane: Box, item: Keyed, axisY: number, size: number): void {
  const { pptx, theme } = ctx;
  const t = inkFor(theme);
  const d = 0.3;

  slide.addText(clip(item.label, 22).toUpperCase(), {
    x: lane.x, y: lane.y, w: lane.w, h: Math.max(0.3, axisY - lane.y - 0.24),
    align: 'center', valign: 'bottom', fontFace: theme.fonts.mono, fontSize: size - 2.5,
    bold: true, color: theme.colors.accent, charSpacing: 1.1,
  });
  // The node is ringed in the canvas color so it reads as sitting ON the rule rather than
  // being pierced by it.
  slide.addShape(pptx.ShapeType.ellipse, {
    x: lane.x + lane.w / 2 - d / 2, y: axisY - d / 2, w: d, h: d,
    fill: { color: theme.colors.accent }, line: { color: theme.colors.canvas, width: 2 },
    ...(theme.radius === 0 ? {} : {
      shadow: { type: 'outer' as const, color: '000000', blur: 6, offset: 1.5, angle: 90, opacity: theme.darkCanvas ? 0.45 : 0.16 },
    }),
  });
  slide.addText(clip(item.value, 90), {
    x: lane.x, y: axisY + 0.28, w: lane.w, h: Math.max(0.3, lane.y + lane.h - axisY - 0.28),
    align: 'center', valign: 'top', fontFace: theme.fonts.body, fontSize: size,
    color: t.ink, lineSpacingMultiple: 1.1,
  });
}

/** Timeline: when, and what happened. */
const timeline: LayoutDef = {
  id: 'timeline',
  name: 'Timeline',
  blurb: 'A horizontal milestone track — the when above the rule, the what below.',
  needs: '`Q3 2026 :: Beta ships` per milestone. Five fit; the rest are counted off.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const all = keyedItems(spec);
    if (!all.length) { fallbackToBullets(slide, ctx, spec, box); return; }

    const items = all.slice(0, TRACK_CAP);
    const extra = all.length - items.length;
    const tail = extra ? 1.0 : 0;
    const axisY = box.y + box.h * 0.44;

    slide.addShape(ctx.pptx.ShapeType.rect, {
      x: box.x, y: axisY, w: box.w, h: 0.022,
      fill: { color: theme.colors.line }, line: { type: 'none' },
    });
    // Lanes carry the grid's own gutter: it separates neighbouring captions without moving the
    // nodes, which stay evenly pitched across the rule either way.
    const size = scaleFor(items.length, 14, 11, 3);
    columns({ ...box, w: box.w - tail }, items.length)
      .forEach((lane, i) => drawMilestone(slide, ctx, lane, items[i], axisY, size));
    if (extra) drawOverflowNote(slide, ctx, { x: box.x + box.w - tail, y: axisY - 0.2, w: tail, h: 0.4 }, extra, 'right');
  },
};

/** One step node — a numbered accent circle on the connector, its name and detail below. */
function drawStep(slide: Slide, ctx: DeckCtx, lane: Box, item: Keyed, i: number, nodeY: number): void {
  const { pptx, theme } = ctx;
  const accent = theme.colors.accent;
  const t = inkFor(theme);
  const d = 0.62;
  const cx = lane.x + lane.w / 2;
  const heading = item.auto ? item.value : item.label;
  const detail = item.auto ? '' : clip(item.value, 90);

  // Ringed in the canvas color so the node reads as sitting ON the connector, and shadowed on
  // rounded themes so the chain floats the way the panels do.
  slide.addShape(pptx.ShapeType.ellipse, {
    x: cx - d / 2, y: nodeY - d / 2, w: d, h: d,
    fill: { color: accent }, line: { color: theme.colors.canvas, width: 2.5 },
    ...(theme.radius === 0 ? {} : {
      shadow: { type: 'outer' as const, color: '000000', blur: 8, offset: 2, angle: 90, opacity: theme.darkCanvas ? 0.45 : 0.16 },
    }),
  });
  slide.addText(String(i + 1), {
    x: cx - d / 2, y: nodeY - d / 2, w: d, h: d, align: 'center', valign: 'middle',
    fontFace: theme.fonts.heading, fontSize: 17, bold: true, color: readableOn(accent),
  });
  slide.addText(clip(heading, 40), {
    x: lane.x, y: nodeY + d / 2 + 0.14, w: lane.w, h: 0.42, align: 'center', valign: 'top',
    fontFace: theme.fonts.heading, fontSize: 15, bold: theme.fonts.heading !== 'Garamond', color: t.ink,
  });
  if (detail) {
    slide.addText(detail, {
      x: lane.x + 0.08, y: nodeY + d / 2 + 0.58, w: lane.w - 0.16, h: 0.9, align: 'center', valign: 'top',
      fontFace: theme.fonts.body, fontSize: 11.5, color: t.soft, lineSpacingMultiple: 1.12,
    });
  }
}

/** Process: numbered circle nodes on one connector, left to right. */
const process: LayoutDef = {
  id: 'process',
  name: 'Process',
  blurb: 'Numbered nodes on a single track — the shape of a sequence, not five arrows.',
  needs: '`Discover :: Interview 12 users` per step, or one line per step. Five fit.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const all = keyedItems(spec);
    if (!all.length) { fallbackToBullets(slide, ctx, spec, box); return; }

    const items = all.slice(0, TRACK_CAP);
    const extra = all.length - items.length;
    const nodeY = box.y + box.h * 0.34;
    const lanes = columns({ ...box, w: box.w - (extra ? 0.9 : 0) }, items.length);

    // One connector under all the nodes — drawn first so every node sits on top of it. The
    // chevron chain this replaces is the single most-dated glyph in office clip-art.
    const first = lanes[0].x + lanes[0].w / 2;
    const last = lanes[lanes.length - 1].x + lanes[lanes.length - 1].w / 2;
    slide.addShape(ctx.pptx.ShapeType.rect, {
      x: first, y: nodeY - 0.014, w: Math.max(0.1, last - first), h: 0.028,
      fill: { color: theme.colors.line }, line: { type: 'none' },
    });

    items.forEach((item, i) => drawStep(slide, ctx, lanes[i], item, i, nodeY));
    if (extra) drawOverflowNote(slide, ctx, { x: box.x + box.w - 0.9, y: nodeY - 0.2, w: 0.9, h: 0.4 }, extra, 'right');
  },
};

/**
 * Cells for `n` groups. A quadrant given two groups is two full-height cells, never a 2x2 with
 * two holes punched in it — the grid follows the content, not the layout's name.
 */
function quadrantCells(box: Box, n: number): Box[] {
  if (n <= 1) return [box];
  if (n === 2) return columns(box, 2);
  const [top, bottom] = rows(box, 2);
  if (n === 3) return [...columns(top, 2), bottom];
  return [...columns(top, 2), ...columns(bottom, 2)];
}

/** Up to four headed cells from whatever the author typed. */
function quadrantGroups(spec: SlideSpec): Array<{ heading: string; items: string[] }> {
  const d = spec.data;
  if (d.groups.length) return d.groups.slice(0, 4);
  if (d.pairs.length) return d.pairs.slice(0, 4).map((p) => ({ heading: p.label, items: [p.value] }));
  const b = d.bullets;
  if (b.length < 2) return [];
  const n = Math.min(4, b.length);
  const per = Math.ceil(b.length / n);
  return Array.from({ length: n }, (_, i) => ({ heading: '', items: b.slice(i * per, (i + 1) * per) }))
    .filter((g) => g.items.length);
}

/** One matrix cell: an accent-tinted panel, its accent heading chip, its items. */
function drawCell(slide: Slide, ctx: DeckCtx, cell: Box, group: { heading: string; items: string[] }): void {
  const { theme } = ctx;
  const t = inkFor(theme);
  const accent = theme.colors.accent;
  const pad = 0.26;
  const inner = { x: cell.x + pad, y: cell.y + pad, w: cell.w - pad * 2, h: cell.h - pad * 2 };
  drawPanel(slide, ctx, cell, { accent });

  let y = inner.y;
  if (group.heading) {
    const head = clip(group.heading, 30);
    slide.addShape(theme.radius === 0 ? ctx.pptx.ShapeType.rect : ctx.pptx.ShapeType.roundRect, {
      x: inner.x, y: inner.y, w: Math.min(inner.w, 0.24 + head.length * 0.11), h: 0.38,
      fill: { color: accent }, line: { type: 'none' },
      ...(theme.radius === 0 ? {} : { rectRadius: 0.08 }),
    });
    slide.addText(head, {
      x: inner.x + 0.12, y: inner.y, w: inner.w - 0.24, h: 0.38,
      fontFace: theme.fonts.mono, fontSize: 11, bold: true, color: readableOn(accent), valign: 'middle',
    });
    y += 0.5;
  }
  const items = group.items.slice(0, 5);
  if (!items.length) return;
  const size = scaleFor(items.length, 13.5, 10.5, 4);
  slide.addText(
    items.map((b) => ({
      text: clip(b, 130),
      options: {
        bullet: { code: '2022', indent: 14 }, fontSize: size, color: t.ink,
        fontFace: theme.fonts.body, breakLine: true, paraSpaceAfter: size * 0.5, lineSpacingMultiple: 1.08,
      },
    })),
    { x: inner.x, y, w: inner.w, h: inner.h - (y - inner.y), valign: 'top' },
  );
}

/** Quadrant: a 2x2 matrix. */
const quadrant: LayoutDef = {
  id: 'quadrant',
  name: 'Quadrant',
  blurb: 'A 2x2 matrix of headed cells — the shape of a trade-off.',
  needs: '`## Heading` per cell, then its items. Four cells; fewer groups fill fewer cells.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const groups = quadrantGroups(spec);
    if (!groups.length) { fallbackToBullets(slide, ctx, spec, box); return; }
    const cells = quadrantCells(box, groups.length);
    groups.forEach((g, i) => drawCell(slide, ctx, cells[i], g));
  },
};

/**
 * The no-image path for `image-full`. An empty picture box is worse than no picture, so the
 * slide becomes the statement it would have been if the author had never asked for an image —
 * same surface, same weight, nothing missing-looking.
 */
function drawFeatureStatement(slide: Slide, ctx: DeckCtx, spec: SlideSpec): void {
  const { theme } = ctx;
  const t = inkFor(theme, true);
  paintWash(slide, ctx);
  const text = clip(spec.title, 130);
  const support = captionOf(spec);

  slide.addText(titleCase(theme, text), {
    x: 1.2, y: support ? 2.28 : 2.6, w: GRID.W - 2.4, h: 2.2,
    fontFace: theme.fonts.heading, fontSize: text.length > 60 ? 38 : 50,
    bold: theme.fonts.heading !== 'Garamond', color: t.ink,
    align: 'center', valign: 'middle', lineSpacingMultiple: 1.06,
    charSpacing: theme.headingCase === 'upper' ? 1 : 0,
  });
  if (support) {
    slide.addText(clip(support, 170), {
      x: 2.2, y: 4.66, w: GRID.W - 4.4, h: 0.8, align: 'center',
      fontFace: theme.fonts.body, fontSize: 16, color: t.soft,
    });
  }
}

/** Image-full: a picture that IS the slide. */
const imageFull: LayoutDef = {
  id: 'image-full',
  name: 'Full image',
  blurb: 'A full-bleed image with the title and caption over a scrim.',
  needs: '`#image: <url|data-uri>`. The title and one line become the caption.',
  master: MASTER.FEATURE,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme, true);
    const src = imageSource(spec.data.image);
    if (!src) { drawFeatureStatement(slide, ctx, spec); return; }

    // `cover` crops the overflow; without it a portrait photo is stretched to 16:9 and the deck
    // ships with a distorted image nobody can un-distort on the desktop.
    slide.addImage({
      ...src, x: 0, y: 0, w: GRID.W, h: GRID.H,
      sizing: { type: 'cover', w: GRID.W, h: GRID.H }, altText: clip(spec.title, 90),
    });
    // The photo is unknown at design time, so the caption never sits on it bare: a scrim of the
    // theme's OWN deep surface makes the lower third the surface `deepInk` is defined against —
    // which is why this reads as theme ink, not a guess. It covers the master's footer too.
    slide.addShape(ctx.pptx.ShapeType.rect, {
      x: 0, y: GRID.H * 0.62, w: GRID.W, h: GRID.H * 0.38,
      fill: { color: theme.colors.deep, transparency: 30 }, line: { type: 'none' },
    });

    const caption = spec.subtitle || spec.data.directives.caption || anyLines(spec)[0];
    slide.addText(titleCase(theme, clip(spec.title, 80)), {
      x: GRID.MX, y: caption ? 5.36 : 5.72, w: GRID.CW - 1, h: 0.8,
      fontFace: theme.fonts.heading, fontSize: 30, bold: theme.fonts.heading !== 'Garamond',
      color: t.ink, valign: 'middle', charSpacing: theme.headingCase === 'upper' ? 0.8 : 0,
    });
    if (caption) {
      slide.addText(clip(caption, 150), {
        x: GRID.MX, y: 6.16, w: GRID.CW - 1, h: 0.56,
        fontFace: theme.fonts.body, fontSize: 14, color: t.soft, valign: 'top',
      });
    }
  },
};

/**
 * An image on a themed mat. pptxgenjs cannot mask an image to a rounded rect, so the theme's
 * radius is carried by a panel the picture sits inside with a hairline reveal — rounded themes
 * read rounded, sharp themes stay sharp, and neither gets a photo with corners poking out of
 * its frame. `cover` crops to the slot rather than squashing the aspect.
 */
function drawFramedImage(slide: Slide, ctx: DeckCtx, frame: Box, src: { data: string } | { path: string }, alt: string): void {
  const pad = 0.07;
  const w = frame.w - pad * 2;
  const h = frame.h - pad * 2;
  drawPanel(slide, ctx, frame);
  slide.addImage({
    ...src, x: frame.x + pad, y: frame.y + pad, w, h,
    sizing: { type: 'cover', w, h }, altText: clip(alt, 90),
  });
}

/** Image-right: text left, picture right. */
const imageRight: LayoutDef = {
  id: 'image-right',
  name: 'Image + text',
  blurb: 'Text on the left, a picture holding the right of the body.',
  needs: 'Bullets plus `#image: <url|data-uri>`. Either half alone still works.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const src = imageSource(spec.data.image);
    const lead = spec.subtitle || spec.data.directives.caption;
    const lines = anyLines(spec).slice(0, 7);

    // Picture but no words: it takes the body. Words but no picture: they take the body. Only a
    // slide with both gets split, so neither half is ever a placeholder for the other.
    if (src && !lines.length && !lead) { drawFramedImage(slide, ctx, box, src, spec.title); return; }
    const gap = GRID.GAP + 0.14;
    const textW = src ? (box.w - gap) * 0.55 : box.w;

    let y = box.y;
    if (lead) {
      slide.addText(clip(lead, 150), {
        x: box.x, y, w: textW, h: 0.5, fontFace: theme.fonts.body, fontSize: 15,
        color: inkFor(theme).soft, valign: 'top',
      });
      y += 0.62;
    }
    drawBullets(slide, ctx, lines, { x: box.x, y, w: textW, h: box.h - (y - box.y) });
    if (src) {
      drawFramedImage(slide, ctx, { x: box.x + textW + gap, y: box.y, w: box.w - textW - gap, h: box.h }, src, spec.title);
    }
  },
};

/**
 * @description The five visual/diagram layouts, in the registry's order. Exported as one array
 * so the layout registry composes the deck's catalog from module-level slates rather than
 * importing each layout by name — adding a sixth visual layout touches this file only.
 */
export const VISUAL_LAYOUTS: LayoutDef[] = [timeline, process, quadrant, imageFull, imageRight];
