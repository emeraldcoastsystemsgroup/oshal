/**
 * Response Renderer — the `oshal:map` typed-block component.
 *
 * Dependency-free inline SVG world map for the simple `{markers}` shape a bot emits in a
 * ```oshal:map fenced block. There are NO external tiles (a CSP-locked surface cannot fetch
 * them and must not try): the map is a deterministic equirectangular graticule the module draws
 * itself, with every marker projected from its lat/lon to plot coordinates this module computed.
 * Pure string composition, safe by construction — every label is escaped, every coordinate is a
 * number. A malformed body never throws: `validate` rejects it and the registry hands the
 * surface its plain-text fallback.
 *
 * Accepted JSON body:
 *   { "title"?: string,
 *     "markers": Array<{ "lat": number, "lon": number, "label"?: string }> } // 1..50 markers
 * Every marker must carry a finite lat in [-90, 90] and lon in [-180, 180].
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — dependency-free sanitized equirectangular SVG map renderer for oshal:map typed blocks (no external tiles).
 *
 * @module shared/ui/response-renderer/components/map-component
 */

import type { OshalBlock, RenderableResponseBlock, ResponseBlockComponent } from '../types';
import { escapeHtml, round2, truncate } from './safe-html';

/** One normalized map marker: a geographic point plus an optional display label. */
export interface MapMarker { lat: number; lon: number; label: string }

/** The normalized map spec every render helper consumes. */
export interface MapSpec { title: string; markers: MapMarker[] }

const WIDTH = 640;
const HEIGHT = 320;
const PALETTE = ['#78effa', '#a78bfa', '#fbbf72', '#7be2a8', '#f78fb3', '#9bb0ff'] as const;
const FONT = 'Inter,Segoe UI,sans-serif';
const MAX_MARKERS = 50;

/** Project a longitude in [-180, 180] to an x coordinate on the equirectangular frame. */
function projectX(lon: number): number {
  return round2(((lon + 180) / 360) * WIDTH);
}

/** Project a latitude in [-90, 90] to a y coordinate on the equirectangular frame. */
function projectY(lat: number): number {
  return round2(((90 - lat) / 180) * HEIGHT);
}

/**
 * @description Validates + normalizes an untrusted `oshal:map` JSON body into a {@link MapSpec}.
 * Fail-closed: any shape/range/finiteness violation returns null (→ registry fallback).
 * @param data - Parsed JSON body of the typed block.
 * @returns Normalized spec, or null when the body is not a renderable map.
 */
export function normalizeMapData(data: unknown): MapSpec | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidate = data as { title?: unknown; markers?: unknown };
  const rawMarkers = candidate.markers;
  if (!Array.isArray(rawMarkers) || rawMarkers.length === 0 || rawMarkers.length > MAX_MARKERS) {
    return null;
  }
  const markers: MapMarker[] = [];
  for (const entry of rawMarkers) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { lat, lon, label } = entry as { lat?: unknown; lon?: unknown; label?: unknown };
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    markers.push({ lat, lon, label: typeof label === 'string' ? label : '' });
  }
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  return { title, markers };
}

/** Render the equirectangular graticule (meridians/parallels every 30°) as the map backdrop. */
function renderGraticule(): string {
  const parts = [
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="currentColor" `
      + 'fill-opacity=".05" stroke="currentColor" stroke-opacity=".3"/>',
  ];
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = projectX(lon);
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${HEIGHT}" stroke="currentColor" stroke-opacity=".12"/>`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = projectY(lat);
    const opacity = lat === 0 ? '.28' : '.12';
    parts.push(`<line x1="0" y1="${y}" x2="${WIDTH}" y2="${y}" stroke="currentColor" stroke-opacity="${opacity}"/>`);
  }
  return parts.join('');
}

/** Render one pin (circle + optional label) per marker, cycling the palette. */
function renderMarkers(spec: MapSpec): string {
  const parts: string[] = [];
  spec.markers.forEach((marker, index) => {
    const color = PALETTE[index % PALETTE.length];
    const x = projectX(marker.lon);
    const y = projectY(marker.lat);
    parts.push(`<circle cx="${x}" cy="${y}" r="4.5" fill="${color}" stroke="currentColor" stroke-opacity=".6" stroke-width="1"/>`);
    if (marker.label) {
      const anchor = x > WIDTH - 90 ? 'end' : 'start';
      const dx = anchor === 'end' ? -8 : 8;
      parts.push(`<text x="${round2(x + dx)}" y="${round2(y + 4)}" text-anchor="${anchor}" fill="currentColor" fill-opacity=".85" font-family="${FONT}" font-size="11">${escapeHtml(truncate(marker.label, 24))}</text>`);
    }
  });
  return parts.join('');
}

/** Render the optional title (top-left). */
function renderHeading(spec: MapSpec): string {
  if (!spec.title) return '';
  return `<text x="10" y="18" fill="currentColor" font-family="${FONT}" font-size="13" font-weight="650">${escapeHtml(truncate(spec.title, 48))}</text>`;
}

/**
 * @description Renders a normalized spec to a self-contained responsive SVG string. Uses
 * `currentColor` for the graticule/labels so the map follows the hosting surface's theme.
 * @param spec - Normalized map spec from {@link normalizeMapData}.
 * @returns Sanitized SVG markup.
 */
export function renderMapSvg(spec: MapSpec): string {
  const ariaLabel = escapeHtml(spec.title || `map with ${spec.markers.length} markers`);
  return `<svg class="rr-map-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${ariaLabel}" style="max-width:100%;height:auto;display:block">`
    + renderGraticule() + renderMarkers(spec) + renderHeading(spec) + '</svg>';
}

/**
 * @description The registered `oshal:map` component. `validate` runs the full normalization,
 * so `render` never sees a shape it cannot draw.
 */
export const mapComponent: ResponseBlockComponent<OshalBlock, void, string> = {
  validate: (block: RenderableResponseBlock): boolean =>
    block.type === 'oshal' && normalizeMapData(block.data) !== null,
  render(block: OshalBlock): string {
    const spec = normalizeMapData(block.data);
    if (!spec) throw new Error('oshal:map body failed normalization');
    return `<figure class="rr-block rr-map">${renderMapSvg(spec)}</figure>`;
  },
};
