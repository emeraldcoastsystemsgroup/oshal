/**
 * Response Renderer — the `oshal:chart` typed-block component.
 *
 * Dependency-free inline SVG bar/line chart for the simple `{labels, series}` shape a bot emits
 * in a ```oshal:chart fenced block. Pure string composition (no DOM, no chart library, nothing
 * external), deterministic for a given input, and safe by construction: every label/title is
 * escaped, every coordinate is a number this module computed. A malformed body never throws —
 * `validate` rejects it and the registry hands the surface its plain-text fallback.
 *
 * Accepted JSON body:
 *   { "title"?: string, "type"?: "bar" | "line",
 *     "labels": string[],                       // 1..24 category labels
 *     "series": Array<{ "label"?: string, "values": number[] } | number[]> } // 1..6 series
 * Every series must carry exactly one finite number per label.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — dependency-free sanitized SVG bar/line renderer for oshal:chart typed blocks.
 *
 * @module shared/ui/response-renderer/components/chart-component
 */

import type { OshalBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml, round2, truncate } from './safe-html';

/** One normalized data series: a display label plus one finite value per category label. */
export interface ChartSeries { label: string; values: number[] }

/** The normalized chart spec every render helper consumes. */
export interface ChartSpec { title: string; type: 'bar' | 'line'; labels: string[]; series: ChartSeries[] }

const WIDTH = 640;
const HEIGHT = 320;
const MARGIN = { left: 46, right: 14, top: 28, bottom: 40 } as const;
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const PALETTE = ['#78effa', '#a78bfa', '#fbbf72', '#7be2a8', '#f78fb3', '#9bb0ff'] as const;
const FONT = 'Inter,Segoe UI,sans-serif';
const MAX_LABELS = 24;
const MAX_SERIES = 6;

/**
 * @description Validates + normalizes an untrusted `oshal:chart` JSON body into a {@link ChartSpec}.
 * Fail-closed: any shape/length/finiteness violation returns null (→ registry fallback).
 * @param data - Parsed JSON body of the typed block.
 * @returns Normalized spec, or null when the body is not a renderable chart.
 */
export function normalizeChartData(data: unknown): ChartSpec | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidate = data as { title?: unknown; type?: unknown; labels?: unknown; series?: unknown };
  const labels = candidate.labels;
  const rawSeries = candidate.series;
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_LABELS) return null;
  if (!labels.every((label) => typeof label === 'string')) return null;
  if (!Array.isArray(rawSeries) || rawSeries.length === 0 || rawSeries.length > MAX_SERIES) return null;

  const series: ChartSeries[] = [];
  for (let index = 0; index < rawSeries.length; index += 1) {
    const entry = rawSeries[index];
    const values = Array.isArray(entry) ? entry : (entry as { values?: unknown })?.values;
    const label = Array.isArray(entry) ? '' : String((entry as { label?: unknown })?.label ?? '');
    if (!Array.isArray(values) || values.length !== labels.length) return null;
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    series.push({ label, values: values as number[] });
  }

  const type = candidate.type === 'line' ? 'line' : 'bar';
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  return { title, type, labels: labels as string[], series };
}

/** Plot geometry shared by the bar/line/axis helpers. */
interface ChartGeometry { min: number; max: number; groupWidth: number; y(value: number): number }

/** Derive the value range + y-projection for a spec (always includes zero for honest bars). */
function chartGeometry(spec: ChartSpec): ChartGeometry {
  const all = spec.series.flatMap((entry) => entry.values);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const span = max - min || 1;
  return {
    min,
    max,
    groupWidth: PLOT_WIDTH / spec.labels.length,
    y: (value: number) => MARGIN.top + PLOT_HEIGHT - ((value - min) / span) * PLOT_HEIGHT,
  };
}

/** Render grouped bar rectangles (one group per label, one bar per series). */
function renderBars(spec: ChartSpec, geometry: ChartGeometry): string {
  const barWidth = (geometry.groupWidth * 0.7) / spec.series.length;
  const zeroY = geometry.y(0);
  const parts: string[] = [];
  spec.series.forEach((entry, seriesIndex) => {
    const color = PALETTE[seriesIndex % PALETTE.length];
    entry.values.forEach((value, labelIndex) => {
      const x = MARGIN.left + labelIndex * geometry.groupWidth
        + geometry.groupWidth * 0.15 + seriesIndex * barWidth;
      const valueY = geometry.y(value);
      const top = Math.min(valueY, zeroY);
      const height = Math.max(Math.abs(zeroY - valueY), 0.5);
      parts.push(`<rect x="${round2(x)}" y="${round2(top)}" width="${round2(barWidth)}" height="${round2(height)}" fill="${color}" fill-opacity=".85"/>`);
    });
  });
  return parts.join('');
}

/** Render one polyline per series with small point markers. */
function renderLines(spec: ChartSpec, geometry: ChartGeometry): string {
  const parts: string[] = [];
  spec.series.forEach((entry, seriesIndex) => {
    const color = PALETTE[seriesIndex % PALETTE.length];
    const points = entry.values.map((value, labelIndex) => {
      const x = round2(MARGIN.left + (labelIndex + 0.5) * geometry.groupWidth);
      return `${x},${round2(geometry.y(value))}`;
    });
    parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5"/>`);
    points.forEach((point) => {
      const [x, y] = point.split(',');
      parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`);
    });
  });
  return parts.join('');
}

/** Render the baseline, min/max value labels, and (thinned) category labels. */
function renderAxes(spec: ChartSpec, geometry: ChartGeometry): string {
  const zeroY = round2(geometry.y(0));
  const parts = [
    `<line x1="${MARGIN.left}" y1="${zeroY}" x2="${MARGIN.left + PLOT_WIDTH}" y2="${zeroY}" stroke="currentColor" stroke-opacity=".35"/>`,
    `<text x="${MARGIN.left - 6}" y="${round2(geometry.y(geometry.max) + 4)}" text-anchor="end" fill="currentColor" fill-opacity=".7" font-family="${FONT}" font-size="11">${escapeHtml(formatValue(geometry.max))}</text>`,
  ];
  if (geometry.min < 0) {
    parts.push(`<text x="${MARGIN.left - 6}" y="${round2(geometry.y(geometry.min) + 4)}" text-anchor="end" fill="currentColor" fill-opacity=".7" font-family="${FONT}" font-size="11">${escapeHtml(formatValue(geometry.min))}</text>`);
  }
  const step = Math.ceil(spec.labels.length / 12);
  spec.labels.forEach((label, index) => {
    if (index % step !== 0) return;
    const x = round2(MARGIN.left + (index + 0.5) * geometry.groupWidth);
    parts.push(`<text x="${x}" y="${HEIGHT - MARGIN.bottom + 16}" text-anchor="middle" fill="currentColor" fill-opacity=".7" font-family="${FONT}" font-size="11">${escapeHtml(truncate(label, 12))}</text>`);
  });
  return parts.join('');
}

/** Render the title (top-left) and, when any series is labeled, a swatch legend (top-right). */
function renderHeading(spec: ChartSpec): string {
  const parts: string[] = [];
  if (spec.title) {
    parts.push(`<text x="${MARGIN.left}" y="18" fill="currentColor" font-family="${FONT}" font-size="13" font-weight="650">${escapeHtml(truncate(spec.title, 48))}</text>`);
  }
  if (spec.series.some((entry) => entry.label)) {
    let x = WIDTH - MARGIN.right;
    for (let index = spec.series.length - 1; index >= 0; index -= 1) {
      const label = truncate(spec.series[index].label || `Series ${index + 1}`, 14);
      x -= label.length * 6.4 + 26;
      parts.push(`<rect x="${round2(x)}" y="10" width="9" height="9" rx="2" fill="${PALETTE[index % PALETTE.length]}"/>`);
      parts.push(`<text x="${round2(x + 13)}" y="18" fill="currentColor" fill-opacity=".8" font-family="${FONT}" font-size="11">${escapeHtml(label)}</text>`);
    }
  }
  return parts.join('');
}

/** Compact deterministic value label (no locale dependence). */
function formatValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${round2(value / 1_000_000)}M`;
  if (absolute >= 1_000) return `${round2(value / 1_000)}k`;
  return String(round2(value));
}

/**
 * @description Renders a normalized spec to a self-contained responsive SVG string. Uses
 * `currentColor` for text/axis so the chart follows the hosting surface's theme.
 * @param spec - Normalized chart spec from {@link normalizeChartData}.
 * @returns Sanitized SVG markup.
 */
export function renderChartSvg(spec: ChartSpec): string {
  const geometry = chartGeometry(spec);
  const marks = spec.type === 'line' ? renderLines(spec, geometry) : renderBars(spec, geometry);
  const ariaLabel = escapeHtml(spec.title || `${spec.type} chart`);
  return `<svg class="rr-chart-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${ariaLabel}" style="max-width:100%;height:auto;display:block">`
    + renderHeading(spec) + renderAxes(spec, geometry) + marks + '</svg>';
}

/**
 * @description The registered `oshal:chart` component. `validate` runs the full normalization,
 * so `render` never sees a shape it cannot draw.
 */
export const chartComponent: ResponseBlockComponent<OshalBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'oshal' && normalizeChartData(block.data) !== null,
  render(block: OshalBlock): string {
    const spec = normalizeChartData(block.data);
    if (!spec) throw new Error('oshal:chart body failed normalization');
    return `<figure class="rr-block rr-chart">${renderChartSvg(spec)}</figure>`;
  },
};
