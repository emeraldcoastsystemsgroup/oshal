/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — infers a slide layout from the SHAPE of its content, and breaks up runs of identical slides. This is what makes a plain outline render as a designed deck: without it, an author who never names a layout gets N consecutive bullet slides, which is exactly what the old renderer produced.
 */

import type { SlideData, SlideLayoutId } from '@/shared/types';
import { looksMetric, looksTemporal, isEmptyData } from './slide-content-parser';

/** Every layout id, for validating an authored `#layout:` directive. */
const LAYOUT_IDS: readonly SlideLayoutId[] = [
  'cover', 'section', 'agenda', 'bullets', 'two-column', 'comparison', 'quote', 'statement',
  'closing', 'big-number', 'kpi-grid', 'table', 'bar-chart', 'line-chart', 'pie-chart',
  'timeline', 'process', 'quadrant', 'image-full', 'image-right',
];

/**
 * @description Validate an authored layout name.
 * @param id - candidate layout id (from `#layout:` or a request field).
 * @returns true when it names a real layout.
 */
export function isLayoutId(id: unknown): id is SlideLayoutId {
  return typeof id === 'string' && (LAYOUT_IDS as readonly string[]).includes(id);
}

/** Titles that announce a contents slide. */
const AGENDA_RE = /^(agenda|contents|table of contents|overview|what we.?ll cover|roadmap for today|today)\b/i;
/** Titles that announce the end of a deck. */
const CLOSING_RE = /(thank you|thanks|questions|q ?& ?a|get in touch|contact|next steps|let.?s talk|appendix ends)/i;
/** Titles that frame a weighing of options. */
const VERSUS_RE = /\b(vs\.?|versus|or)\b|\bbuild .*buy\b/i;
/** Titles that frame a composition rather than a comparison of magnitudes. */
const SHARE_RE = /(share|mix|split|breakdown|composition|allocation|distribution|makeup|by segment)/i;

/** Fraction of items satisfying a predicate. */
function ratio<T>(items: T[], pred: (t: T) => boolean): number {
  return items.length ? items.filter(pred).length / items.length : 0;
}

/**
 * @description Pick the chart that fits the data, not the one that looks busiest.
 * @param title - slide title (a "share"/"mix" framing implies a composition).
 * @param series - the numeric points.
 * @returns the chart layout id.
 */
function pickChart(title: string, series: SlideData['series']): SlideLayoutId {
  if (series.length >= 3 && ratio(series, (s) => looksTemporal(s.label)) >= 0.6) return 'line-chart';
  const total = series.reduce((a, s) => a + s.value, 0);
  const isComposition = SHARE_RE.test(title) || Math.abs(total - 100) < 0.5;
  if (isComposition && series.length >= 2 && series.length <= 6 && series.every((s) => s.value >= 0)) return 'pie-chart';
  return 'bar-chart';
}

/**
 * @description Pick a layout for `label :: value` pairs. The same syntax carries KPIs,
 * milestones, and process steps, so the labels decide: numbers mean metrics, dates mean a
 * timeline, and anything else in a small ordered set reads as steps.
 * @param pairs - the parsed pairs.
 * @returns the layout id.
 */
function pickForPairs(pairs: SlideData['pairs']): SlideLayoutId {
  const metricish = ratio(pairs, (p) => looksMetric(p.label));
  if (pairs.length === 1 && metricish === 1) return 'big-number';
  if (pairs.length >= 2 && pairs.length <= 4 && metricish >= 0.6) return 'kpi-grid';
  if (pairs.length >= 3 && ratio(pairs, (p) => looksTemporal(p.label)) >= 0.6) return 'timeline';
  if (pairs.length >= 3 && pairs.length <= 5) return 'process';
  return 'bullets';
}

/** Context the composer knows about a slide's position in the deck. */
export interface SelectContext {
  /** 1-based position among the content slides. */
  index: number;
  /** Total content slides. */
  total: number;
  /** Coarse hint from the legacy `PresentationSection.type` field. */
  typeHint?: 'intro' | 'content' | 'summary' | 'divider';
}

/**
 * @description Choose the layout that best fits a slide's content.
 *
 * Order matters: an explicit `#layout:` always wins, then unambiguous structural signals
 * (a table is a table), then the ambiguous ones resolved by content shape. The fallback is
 * always `bullets`, which renders anything.
 *
 * @param title - the slide title.
 * @param data - the parsed slide content.
 * @param ctx - the slide's position + any legacy type hint.
 * @returns the chosen layout id.
 */
export function autoSelectLayout(title: string, data: SlideData, ctx: SelectContext): SlideLayoutId {
  const declared = data.directives.layout;
  if (isLayoutId(declared)) return declared;
  if (ctx.typeHint === 'divider') return 'section';

  // Unambiguous structure.
  if (data.table) return 'table';
  if (data.quote) return 'quote';
  if (data.series.length >= 2) return pickChart(title, data.series);
  if (data.groups.length === 4) return 'quadrant';
  if (data.groups.length >= 2) return VERSUS_RE.test(title) && data.groups.length === 2 ? 'comparison' : 'two-column';

  // Images: a picture with commentary is a split; a picture alone is full bleed.
  if (data.image) return data.bullets.length >= 2 ? 'image-right' : 'image-full';

  if (data.pairs.length) {
    const byPairs = pickForPairs(data.pairs);
    if (byPairs !== 'bullets') return byPairs;
  }

  // Position + title framing.
  if (AGENDA_RE.test(title) && data.bullets.length >= 2) return 'agenda';
  if (ctx.index === ctx.total && CLOSING_RE.test(title)) return 'closing';
  if (isEmptyData(data)) return title.length <= 90 ? 'statement' : 'section';
  if (data.bullets.length === 1 && title.length <= 60) return 'statement';

  return 'bullets';
}

/**
 * @description Break up monotony after the per-slide choice is made.
 *
 * Auto-selection is local — it can't see that it just produced six bullet slides in a row.
 * A long unbroken run is the single biggest tell of a generated deck, so a run of four or
 * more gets its later members re-cut as two-column, but ONLY where the slide has enough
 * bullets to split cleanly. Anything less certain is left alone: a wrong layout is worse
 * than a repeated one.
 *
 * @param picks - the per-slide layout choices, in deck order.
 * @param datas - the matching parsed content, same order.
 * @returns a new array of layout ids with long bullet runs varied.
 */
export function applyDeckRhythm(picks: SlideLayoutId[], datas: SlideData[]): SlideLayoutId[] {
  const out = [...picks];
  let runStart = 0;
  for (let i = 0; i <= out.length; i++) {
    if (i < out.length && out[i] === 'bullets') continue;
    const runLen = i - runStart;
    if (runLen >= 4) {
      // Re-cut every third slide of the run, skipping the first (the run's opener sets the
      // pattern; changing it makes the section look arbitrary).
      for (let j = runStart + 2; j < i; j += 3) {
        if (datas[j] && datas[j].bullets.length >= 4) out[j] = 'two-column';
      }
    }
    runStart = i + 1;
  }
  return out;
}
