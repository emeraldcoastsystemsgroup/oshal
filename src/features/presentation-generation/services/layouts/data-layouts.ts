/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the six data layouts (big-number, kpi-grid, table, bar-chart, line-chart, pie-chart). Charts and tables are NATIVE pptxgenjs objects, never drawn shapes or images: the whole point is that the deck arrives on the user's desktop with a chart they can double-click and edit in Excel. Drawn "charts" look identical in the thumbnail and are dead on arrival in the room.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Modern refresh: axis LINES hidden (the gridlines carry the read), fatter columns (gap 55→35), bolder data labels, doughnut hole widened to 70 — the minimal chart chrome of a current deck instead of Excel-97 defaults.
 */

import type { LayoutDef, SlideSpec } from '../layout-types';
import type { Box, DeckCtx, Slide } from '../layout-kit';
import {
  GRID, MASTER, clip, columns, drawBullets, drawPanel, drawTitle,
  inkFor, paintWash, readableOn, scaleFor, titleCase,
} from '../layout-kit';
import { looksMetric, parseMetric } from '../slide-content-parser';

/** Body lines for a slide, whatever shape the author used — layouts degrade, never blank out. */
function anyLines(spec: SlideSpec): string[] {
  const d = spec.data;
  if (d.bullets.length) return d.bullets;
  if (d.pairs.length) return d.pairs.map((p) => `${p.label} — ${p.value}`);
  if (d.series.length) return d.series.map((s) => `${s.label} — ${s.display}`);
  if (d.groups.length) return d.groups.flatMap((g) => [g.heading, ...g.items]);
  if (d.table) return d.table.rows.map((r) => r.join(' · '));
  return [];
}

/**
 * The escape hatch every data layout shares. A chart frame with no numbers in it is worse than
 * no chart — it reads as a rendering bug — so a layout that can't find data renders whatever
 * the author actually typed instead of its own empty skeleton.
 */
function degrade(slide: Slide, ctx: DeckCtx, box: Box, spec: SlideSpec): void {
  drawBullets(slide, ctx, anyLines(spec).slice(0, 8), box);
}

/** A figure + its caption, sourced from whichever shape the author reached for. */
interface Stat { figure: string; caption: string }

/**
 * Stat tiles from the author's content. `pairs` are the natural shape (`94% :: uptime` — the
 * metric is the LABEL and the caption is the value); `series` (`Revenue: $1.2M`) is the other
 * way round, and uses `.display` so the tile shows the authored "$1.2M", not "1200000".
 */
function statTiles(spec: SlideSpec): Stat[] {
  const d = spec.data;
  if (d.pairs.length) return d.pairs.map((p) => ({ figure: p.label, caption: p.value }));
  if (d.series.length) return d.series.map((s) => ({ figure: s.display, caption: s.label }));
  return [];
}

/**
 * The one metric a big-number slide is about. Prefers a pair whose label really is a number,
 * then a series point, then any pair at all — and finally digs a leading figure out of a plain
 * line ("94% of trials convert"), because that is how people actually type this slide.
 */
function heroStat(spec: SlideSpec): Stat | null {
  const d = spec.data;
  const pair = d.pairs.find((p) => looksMetric(p.label));
  if (pair) return { figure: pair.label, caption: pair.value };
  if (d.series.length) return { figure: d.series[0].display, caption: d.series[0].label };
  if (d.pairs.length) return { figure: d.pairs[0].label, caption: d.pairs[0].value };
  const m = /^(\S+)\s+(.+)$/.exec(anyLines(spec)[0] ?? '');
  return m && looksMetric(m[1]) ? { figure: m[1], caption: m[2] } : null;
}

/** A chart category and its number. */
interface Point { label: string; value: number }

/**
 * Plottable points. `series` is the intended shape, but an author who wrote `240 :: Q3` pairs
 * has given us the same data with the label and value swapped — parse those rather than
 * throwing away a perfectly good chart over syntax.
 */
function chartPoints(spec: SlideSpec): Point[] {
  const d = spec.data;
  if (d.series.length) return d.series.map((s) => ({ label: s.label, value: s.value }));
  return d.pairs
    .filter((p) => looksMetric(p.label))
    .map((p) => ({ label: p.value, value: parseMetric(p.label) as number }));
}

/**
 * Chart options shared by all three chart layouts. Every color is set explicitly because
 * pptxgenjs defaults to a white chart area with black axis text — invisible on the four
 * dark-canvas themes (midnight / aurora / blueprint / neon). No annotation on the return type:
 * the inferred shape spreads cleanly into `addChart`'s options at each call site.
 */
function chartBase(ctx: DeckCtx) {
  const { theme } = ctx;
  const t = inkFor(theme);
  return {
    chartColors: theme.chartColors,
    // The slide already carries the title; a second one inside the frame just steals height.
    showTitle: false,
    chartArea: { fill: { color: theme.colors.canvas }, border: { type: 'none' as const, pt: 0 } },
    plotArea: { fill: { color: theme.colors.canvas }, border: { type: 'none' as const, pt: 0 } },
    dataLabelColor: t.ink,
    dataLabelFontFace: theme.fonts.mono,
    dataLabelFontSize: 10.5,
    dataLabelFontBold: true,
    legendColor: t.ink,
    legendFontFace: theme.fonts.body,
    legendFontSize: 11,
  };
}

/**
 * Axis + gridline styling for the two axis charts. Gridlines are drawn in the theme's hairline
 * color so they read as structure rather than as content; the category axis gets none at all.
 */
function axisOpts(ctx: DeckCtx) {
  const { theme } = ctx;
  const t = inkFor(theme);
  return {
    catAxisLabelColor: t.soft,
    catAxisLabelFontFace: theme.fonts.mono,
    catAxisLabelFontSize: 10.5,
    // No axis lines at all — modern chart chrome lets the faint gridlines carry the structure
    // and keeps every stroke that isn't data off the frame.
    catAxisLineShow: false,
    catGridLine: { style: 'none' as const },
    valAxisLabelColor: t.soft,
    valAxisLabelFontFace: theme.fonts.mono,
    valAxisLabelFontSize: 10.5,
    valAxisLineShow: false,
    valGridLine: { color: theme.colors.line, size: 0.5, style: 'solid' as const },
  };
}

/** One native series, the shape `addChart` wants. */
function oneSeries(name: string, pts: Point[]) {
  return [{ name: clip(name, 40) || 'Series 1', labels: pts.map((p) => clip(p.label, 22)), values: pts.map((p) => p.value) }];
}

/** Big number: one metric, one sentence, nothing else. */
const bigNumber: LayoutDef = {
  id: 'big-number',
  name: 'Big number',
  blurb: 'One hero metric at full height, with the sentence that explains it.',
  needs: '`94% :: of pilots renewed` — one metric and its caption.',
  master: MASTER.FEATURE,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme, true);
    paintWash(slide, ctx);
    const stat = heroStat(spec);

    // No number anywhere: the slide still has a point to make, so make it as a statement
    // rather than rendering a hero frame around nothing.
    if (!stat) {
      slide.addText(titleCase(theme, clip(spec.title, 90)), {
        x: 1.2, y: 2.6, w: GRID.W - 2.4, h: 2.2, fontFace: theme.fonts.heading, fontSize: 44,
        bold: theme.fonts.heading !== 'Garamond', color: t.ink, align: 'center', valign: 'middle',
      });
      return;
    }

    // The title demotes to a kicker — on this layout the numeral is the headline.
    slide.addText(clip(spec.sectionName || spec.title, 60).toUpperCase(), {
      x: 1.2, y: 1.86, w: GRID.W - 2.4, h: 0.3, align: 'center',
      fontFace: theme.fonts.mono, fontSize: 11, bold: true, color: theme.colors.accent, charSpacing: 1.6,
    });

    const figure = clip(stat.figure, 10);
    slide.addText(figure, {
      x: 0.9, y: 2.24, w: GRID.W - 1.8, h: 2.3,
      fontFace: theme.fonts.heading, fontSize: figure.length > 6 ? 84 : figure.length > 4 ? 100 : 120,
      bold: theme.fonts.heading !== 'Garamond', color: theme.colors.accent,
      align: 'center', valign: 'middle', lineSpacingMultiple: 1.0,
    });

    if (stat.caption) {
      slide.addText(clip(stat.caption, 150), {
        x: 2.0, y: 4.68, w: GRID.W - 4.0, h: 0.9, align: 'center',
        fontFace: theme.fonts.body, fontSize: 17, color: t.soft, valign: 'top',
      });
    }
  },
};

/** KPI grid: the two-to-four numbers the room is meant to leave with. */
const kpiGrid: LayoutDef = {
  id: 'kpi-grid',
  name: 'KPI grid',
  blurb: 'Two to four stat tiles — the numbers the room is meant to leave with.',
  needs: '`$1.2M :: ARR` per tile (or `ARR: $1.2M`). Four tiles maximum.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme);
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const items = statTiles(spec).slice(0, 4);
    if (!items.length) { degrade(slide, ctx, box, spec); return; }

    // Tiles are a band, not full-height columns: a 5in-tall tile holding one number reads as a
    // mistake, so the band is centred in the body box instead of stretched to fill it.
    const h = Math.min(box.h, 2.6);
    const cols = columns({ x: box.x, y: box.y + (box.h - h) / 2, w: box.w, h }, items.length);
    const base = items.length >= 4 ? 40 : items.length === 3 ? 46 : 54;

    items.forEach((item, i) => {
      const accent = i % 2 ? theme.colors.accent2 : theme.colors.accent;
      const col = cols[i];
      drawPanel(slide, ctx, col, { accent });

      // `drawPanel`'s accent is an 84–90% transparent TINT, so the tile resolves to ~canvas —
      // this text sits on canvas, not on the accent, and takes canvas ink. `readableOn` here
      // would flip it to white on a near-white tile.
      const figure = clip(item.figure, 9);
      slide.addText(figure, {
        x: col.x + 0.24, y: col.y + 0.34, w: col.w - 0.48, h: 1.05,
        fontFace: theme.fonts.heading, fontSize: figure.length > 5 ? Math.round(base * 0.72) : base,
        bold: theme.fonts.heading !== 'Garamond', color: accent, align: 'center', valign: 'middle',
      });
      slide.addText(clip(item.caption, 80), {
        x: col.x + 0.24, y: col.y + 1.45, w: col.w - 0.48, h: 0.75,
        fontFace: theme.fonts.body, fontSize: scaleFor(items.length, 14, 11.5, 3),
        color: t.soft, align: 'center', valign: 'top',
      });
    });
  },
};

/** One table cell, in the single shape every row uses so the array types cleanly. */
function cell(text: string, color: string, fill: string, bold: boolean, fontFace: string) {
  return { text, options: { color, fill: { color: fill }, bold, fontFace } };
}

/** Table: a real PowerPoint table the user can edit in place. */
const table: LayoutDef = {
  id: 'table',
  name: 'Table',
  blurb: 'A native PowerPoint table — sortable, editable, themed.',
  needs: 'A markdown pipe table: `| Feature | Us | Them |`, header row first.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const t = inkFor(theme);
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const src = spec.data.table;
    if (!src || !src.rows.length) { degrade(slide, ctx, box, spec); return; }

    const cols = Math.max(src.head.length, ...src.rows.map((r) => r.length));
    // `autoPage: false` means the table CANNOT spill onto a second slide — so the row budget is
    // computed against the body box here rather than discovered as an overflow at render time.
    const maxRows = Math.max(1, Math.floor(box.h / 0.44) - 1);
    const body = src.rows.slice(0, maxRows);
    const rowH = Math.min(0.62, box.h / (body.length + 1));
    const budget = Math.max(12, Math.round(150 / cols));
    const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => clip(r[i] ?? '', budget));

    const head = pad(src.head).map((c) => cell(c, readableOn(theme.colors.accent), theme.colors.accent, true, theme.fonts.mono));
    const rows = body.map((r, i) => pad(r).map((c) => cell(c, t.ink, i % 2 ? theme.colors.canvasAlt : theme.colors.canvas, false, theme.fonts.body)));

    slide.addTable([head, ...rows], {
      x: box.x, y: box.y, w: box.w, colW: Array.from({ length: cols }, () => box.w / cols),
      rowH, autoPage: false, valign: 'middle', align: 'left',
      fontSize: scaleFor(body.length + 1, 13, 9.5, 7),
      border: { type: 'solid', color: theme.colors.line, pt: 0.5 },
    });
  },
};

/** Bar chart: native, double-click-editable. */
const barChart: LayoutDef = {
  id: 'bar-chart',
  name: 'Bar chart',
  blurb: 'Native column chart — compare categories, editable in Excel.',
  needs: '`Q1: 240` per bar (or `240 :: Q1`).',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const pts = chartPoints(spec).slice(0, 12);
    if (!pts.length) { degrade(slide, ctx, box, spec); return; }

    slide.addChart(ctx.pptx.ChartType.bar, oneSeries(spec.data.directives.series ?? spec.title, pts), {
      x: box.x, y: box.y, w: box.w, h: box.h,
      ...chartBase(ctx), ...axisOpts(ctx),
      // 'col' = vertical columns. pptxgenjs's `bar` type draws horizontal bars by default,
      // which is not what anyone means when they ask for a bar chart.
      barDir: 'col', barGapWidthPct: 35,
      // Values sit outside the column, on the canvas — so they take canvas ink, not slice ink.
      showValue: pts.length <= 8, dataLabelPosition: 'outEnd',
      showLegend: false,
    });
  },
};

/** Line chart: native, double-click-editable. */
const lineChart: LayoutDef = {
  id: 'line-chart',
  name: 'Line chart',
  blurb: 'Native line chart — a trend over time, editable in Excel.',
  needs: '`Q1: 240` per point, in time order.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const pts = chartPoints(spec).slice(0, 24);
    // Two points is the floor for a LINE specifically — one point has no trend to draw, and a
    // lone marker in an empty axis frame is exactly the empty-frame failure this guards.
    if (pts.length < 2) { degrade(slide, ctx, box, spec); return; }

    slide.addChart(ctx.pptx.ChartType.line, oneSeries(spec.data.directives.series ?? spec.title, pts), {
      x: box.x, y: box.y, w: box.w, h: box.h,
      ...chartBase(ctx), ...axisOpts(ctx),
      lineSize: 2.5, lineSmooth: false,
      lineDataSymbol: pts.length <= 12 ? 'circle' : 'none', lineDataSymbolSize: 6,
      // Point labels stop being legible past a handful — past that the axis carries the read.
      showValue: pts.length <= 7, dataLabelPosition: 't',
      showLegend: false,
    });
  },
};

/** Breakdown: native doughnut — parts of a whole. */
const pieChart: LayoutDef = {
  id: 'pie-chart',
  name: 'Breakdown',
  blurb: 'Native doughnut — how a whole splits, editable in Excel.',
  needs: '`Enterprise: 45` per slice.',
  master: MASTER.CANVAS,
  render: (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => {
    const { theme } = ctx;
    const box = drawTitle(slide, ctx, spec.title, spec.sectionName);
    const pts = chartPoints(spec).slice(0, 8);
    if (!pts.length) { degrade(slide, ctx, box, spec); return; }

    slide.addChart(ctx.pptx.ChartType.doughnut, oneSeries(spec.data.directives.series ?? spec.title, pts), {
      x: box.x, y: box.y, w: box.w, h: box.h,
      ...chartBase(ctx),
      holeSize: 70,
      // The legend does the naming, so the ring only has to carry percentages.
      showLegend: true, legendPos: 'r',
      showPercent: true, showValue: false, showLabel: false,
      dataLabelPosition: 'ctr', dataLabelFontBold: true,
      // Slice labels sit ON the series colors, which differ per slice — one label color has to
      // serve all of them, so it is picked for series 1, the slice the eye lands on first.
      dataLabelColor: readableOn(theme.chartColors[0]),
    });
  },
};

/** The six data layouts — every one of them a native, editable PowerPoint object. */
export const DATA_LAYOUTS: LayoutDef[] = [
  bigNumber, kpiGrid, table, barChart, lineChart, pieChart,
];
