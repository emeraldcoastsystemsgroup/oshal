/**
 * Deterministic body renderers for the newer visual kinds.
 *
 * Split out of visual-response-renderer.ts at the 800 code-line soft cap. The orchestrator keeps the
 * SVG frame, the renderBody/buildAlt switches, and the original eight kinds; these are the rest.
 * Every function here draws ONLY from its validated spec — it chooses no facts.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted map/gauge/checklist/
 *            | agenda/comparison/profile/image renderers to keep the orchestrator under the cap.
 * ---------------------------------------------------------------------------
 * @module visual-kind-renderers
 */

import type {
  AgendaVisualResponseSpec, ChecklistVisualResponseSpec, ComparisonVisualResponseSpec,
  GaugeVisualResponseSpec, ImageVisualResponseSpec, MapVisualResponseSpec, ProfileVisualResponseSpec,
} from '../types';
import type { TrustedImageReceipt } from './trusted-image-receipt-service';
import {
  FONT, escapeXml, labelValue, renderWrappedText, round, softPanel, truncate, formatNumber,
} from './visual-svg-primitives';

export /**
 * One to three verified pictures. Bytes come only from a receipt the server already transcoded;
 * a ref with no receipt renders an honest placeholder rather than a broken or remote image.
 */
function renderImage(
  spec: ImageVisualResponseSpec,
  trustedImages: ReadonlyMap<string, TrustedImageReceipt>,
): string {
  const items = spec.items.slice(0, 3);
  const gap = 16;
  const cardWidth = (1136 - gap * (items.length - 1)) / items.length;
  const top = 172;
  const cardHeight = 432;
  const imageHeight = cardHeight - 74;
  const cards = items.map((item, index) => {
    const x = 72 + index * (cardWidth + gap);
    const receipt = trustedImages.get(item.sourceRef);
    const chars = Math.max(16, Math.floor((cardWidth - 32) / 7.4));
    const body = receipt
      ? `<image x="${round(x + 12)}" y="${top + 12}" width="${round(cardWidth - 24)}" height="${imageHeight - 12}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${receipt.content.toString('base64')}"/>`
      : [
          `<rect x="${round(x + 12)}" y="${top + 12}" width="${round(cardWidth - 24)}" height="${imageHeight - 12}" rx="16" fill="#78effa" fill-opacity=".035"/>`,
          `<circle cx="${round(x + cardWidth / 2)}" cy="${top + imageHeight / 2}" r="30" fill="#78effa" fill-opacity=".08"/>`,
          `<text x="${round(x + cardWidth / 2)}" y="${top + imageHeight / 2 + 6}" text-anchor="middle" fill="#78effa" fill-opacity=".6" font-family="${FONT}" font-size="12" font-weight="700" letter-spacing="2">IMAGE</text>`,
        ].join('');
    return [
      softPanel(x, top, cardWidth, cardHeight, 20, index === 0 ? '.07' : '.05'),
      body,
      renderWrappedText(item.caption, x + 16, top + imageHeight + 26, chars, 2, 14, 19, '#dbe9f2', 560),
    ].join('');
  }).join('');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    cards,
  ].join('');
}

export /** A day/schedule: time gutter + rail + what is on and where. */
function renderAgenda(spec: AgendaVisualResponseSpec): string {
  const items = spec.items.slice(0, 7);
  const rowHeight = items.length > 5 ? 66 : 78;
  const startY = 186;
  const railX = 250;
  const rows = items.map((item, index) => {
    const y = startY + index * rowHeight;
    const cy = y + rowHeight / 2 - 8;
    const cancelled = item.status === 'cancelled';
    const color = cancelled ? '#70879b' : item.status === 'tentative' ? '#fbbf72' : '#78effa';
    const meta = [item.location, item.detail].filter(Boolean).join('  ·  ');
    return [
      softPanel(railX + 28, y, 1180 - (railX + 28), rowHeight - 12, 14, index % 2 ? '.05' : '.03'),
      `<text x="${railX - 22}" y="${round(cy + 2)}" text-anchor="end" fill="${cancelled ? '#70879b' : '#c5d8e6'}" font-family="${FONT}" font-size="16" font-weight="680">${escapeXml(truncate(item.time, 12))}</text>`,
      `<circle cx="${railX}" cy="${round(cy - 3)}" r="7" fill="#07111f" stroke="${color}" stroke-width="3"/>`,
      `<text x="${railX + 48}" y="${round(cy - (meta ? 3 : -4))}" fill="${cancelled ? '#8fa7ba' : '#f1f9ff'}" font-family="${FONT}" font-size="18" font-weight="650"${cancelled ? ' text-decoration="line-through"' : ''}>${escapeXml(truncate(item.title, 62))}</text>`,
      meta ? `<text x="${railX + 48}" y="${round(cy + 19)}" fill="#91a8bc" font-family="${FONT}" font-size="13">${escapeXml(truncate(meta, 78))}</text>` : '',
      item.status && item.status !== 'confirmed' ? `<text x="1186" y="${round(cy + 2)}" text-anchor="end" fill="${color}" font-family="${FONT}" font-size="11" font-weight="700" letter-spacing="1">${escapeXml(item.status.toUpperCase())}</text>` : '',
    ].join('');
  }).join('');
  const railTop = startY + 10;
  const railBottom = startY + (items.length - 1) * rowHeight + rowHeight / 2 - 11;
  return [
    `<text x="72" y="151" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption || spec.dateLabel || `${items.length} item${items.length === 1 ? '' : 's'}`, 120))}</text>`,
    items.length > 1 ? `<line x1="${railX}" y1="${round(railTop)}" x2="${railX}" y2="${round(railBottom)}" stroke="#78effa" stroke-width="3" stroke-opacity=".28"/>` : '',
    rows,
  ].join('');
}

export /** Options side by side, compared across shared attributes. */
function renderComparison(spec: ComparisonVisualResponseSpec): string {
  const options = spec.options.slice(0, 3);
  const attributes = spec.attributes.slice(0, 6);
  const labelWidth = 268;
  const gap = 12;
  const columnWidth = (1136 - labelWidth - gap * options.length) / options.length;
  const columnX = (index: number) => 72 + labelWidth + gap + index * (columnWidth + gap);
  const heads = options.map((option, index) => {
    const x = columnX(index);
    const color = option.recommended ? '#34d399' : '#78effa';
    return [
      softPanel(x, 176, columnWidth, 74, 16, option.recommended ? '.1' : '.05'),
      option.recommended ? `<rect x="${round(x)}" y="176" width="${round(columnWidth)}" height="74" rx="16" fill="none" stroke="${color}" stroke-opacity=".55" stroke-width="2"/>` : '',
      renderWrappedText(option.label, x + 14, 206, Math.max(10, Math.floor(columnWidth / 9)), 1, 17, 21, '#f1f9ff', 700),
      option.badge || option.recommended
        ? `<text x="${round(x + 14)}" y="234" fill="${color}" font-family="${FONT}" font-size="11" font-weight="750" letter-spacing="1">${escapeXml(truncate(option.badge || 'RECOMMENDED', 18).toUpperCase())}</text>`
        : '',
    ].join('');
  }).join('');
  const rows = attributes.map((attribute, rowIndex) => {
    const y = 266 + rowIndex * 62;
    const cells = attribute.values.slice(0, options.length).map((value, index) => {
      const x = columnX(index);
      return [
        `<rect x="${round(x)}" y="${y}" width="${round(columnWidth)}" height="52" rx="12" fill="#dffcff" fill-opacity="${options[index]?.recommended ? '.07' : rowIndex % 2 ? '.045' : '.025'}"/>`,
        renderWrappedText(value || '—', x + 14, y + 24, Math.max(10, Math.floor(columnWidth / 8.5)), 2, 14, 17, '#e0edf5', 550),
      ].join('');
    }).join('');
    return `<text x="72" y="${y + 31}" fill="#9eb6c9" font-family="${FONT}" font-size="14" font-weight="650">${escapeXml(truncate(attribute.label, 30))}</text>${cells}`;
  }).join('');
  return [
    spec.caption ? `<text x="72" y="151" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    heads,
    rows,
  ].join('');
}

export /** A person/entity card. */
function renderProfile(spec: ProfileVisualResponseSpec): string {
  const initials = (spec.initials || spec.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('') || '?').toUpperCase().slice(0, 3);
  const fields = (spec.fields || []).slice(0, 6);
  const bullets = (spec.bullets || []).slice(0, 4);
  const cards = fields.map((field, index) => {
    const x = 72 + (index % 3) * 382;
    const y = 356 + Math.floor(index / 3) * 92;
    return `${softPanel(x, y, 362, 76, 16)}${labelValue(field.label.toUpperCase(), field.value, x + 18, y + 26)}`;
  }).join('');
  const bulletStart = 356 + Math.ceil(fields.length / 3) * 92 + 22;
  const bulletRows = bullets.map((bullet, index) => {
    const y = bulletStart + index * 34;
    return `<circle cx="83" cy="${y - 5}" r="4" fill="#78effa"/><text x="102" y="${y}" fill="#c7d7e4" font-family="${FONT}" font-size="15">${escapeXml(truncate(bullet, 118))}</text>`;
  }).join('');
  return [
    spec.caption ? `<text x="72" y="151" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    `<circle cx="148" cy="252" r="66" fill="url(#accent)" fill-opacity=".22" stroke="#78effa" stroke-opacity=".45" stroke-width="2"/>`,
    `<text x="148" y="270" text-anchor="middle" fill="#bff7ff" font-family="${FONT}" font-size="42" font-weight="740" letter-spacing="1">${escapeXml(initials)}</text>`,
    renderWrappedText(spec.name, 244, 240, 34, 1, 34, 40, '#f5fbff', 730),
    spec.subtitle ? renderWrappedText(spec.subtitle, 244, 278, 52, 1, 17, 22, '#9eb6c9', 520) : '',
    cards,
    bulletRows,
  ].join('');
}

export /** A schematic route/location map: places plotted in relative geographic space, no map tiles. */
function renderMap(spec: MapVisualResponseSpec): string {
  const places = spec.places.slice(0, 8);
  const plot = { x: 96, y: 176, width: 1088, height: 396 };
  const lats = places.map((p) => p.lat);
  const lngs = places.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1;
  const spanLng = maxLng - minLng || 1;
  const pad = 0.12;
  const project = (p: { lat: number; lng: number }) => ({
    x: plot.x + plot.width * (pad + (1 - 2 * pad) * (spanLng === 1 && minLng === maxLng ? 0.5 : (p.lng - minLng) / spanLng)),
    y: plot.y + plot.height * (pad + (1 - 2 * pad) * (spanLat === 1 && minLat === maxLat ? 0.5 : (maxLat - p.lat) / spanLat)),
  });
  const points = places.map(project);
  const grid = Array.from({ length: 4 }, (_, i) => {
    const gy = plot.y + (plot.height / 3) * i;
    const gx = plot.x + (plot.width / 3) * i;
    return `<line x1="${plot.x}" y1="${round(gy)}" x2="${plot.x + plot.width}" y2="${round(gy)}" stroke="#78effa" stroke-opacity=".07"/>`
      + `<line x1="${round(gx)}" y1="${plot.y}" x2="${round(gx)}" y2="${plot.y + plot.height}" stroke="#78effa" stroke-opacity=".07"/>`;
  }).join('');
  const routeLine = spec.route && points.length > 1
    ? `<path d="${points.map((pt, i) => `${i ? 'L' : 'M'} ${round(pt.x)} ${round(pt.y)}`).join(' ')}" fill="none" stroke="#78effa" stroke-width="3" stroke-opacity=".6" stroke-dasharray="2 8" stroke-linecap="round" marker-end="url(#arrow)"/>`
    : '';
  const pins = places.map((place, index) => {
    const pt = points[index];
    const isEnd = place.marker === 'destination' || (spec.route && index === places.length - 1);
    const isStart = place.marker === 'origin' || (spec.route && index === 0);
    const color = isEnd ? '#fbbf72' : isStart ? '#34d399' : '#78effa';
    const labelRight = pt.x > plot.x + plot.width * 0.72;
    const lx = labelRight ? pt.x - 14 : pt.x + 16;
    const anchor = labelRight ? 'end' : 'start';
    return [
      `<circle cx="${round(pt.x)}" cy="${round(pt.y)}" r="13" fill="${color}" fill-opacity=".16"/>`,
      `<circle cx="${round(pt.x)}" cy="${round(pt.y)}" r="6" fill="${color}" stroke="#07111f" stroke-width="2"/>`,
      `<text x="${round(lx)}" y="${round(pt.y - 2)}" text-anchor="${anchor}" fill="#f1f9ff" font-family="${FONT}" font-size="15" font-weight="680">${escapeXml(truncate(place.label, 26))}</text>`,
      place.detail ? `<text x="${round(lx)}" y="${round(pt.y + 17)}" text-anchor="${anchor}" fill="#9eb4c5" font-family="${FONT}" font-size="12">${escapeXml(truncate(place.detail, 30))}</text>` : '',
    ].join('');
  }).join('');
  const footer = [spec.distance, spec.duration].filter(Boolean).join('  ·  ');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    softPanel(plot.x - 8, plot.y - 8, plot.width + 16, plot.height + 16, 22, '.03'),
    grid, routeLine, pins,
    footer ? `<text x="72" y="628" fill="#78effa" font-family="${FONT}" font-size="18" font-weight="680">${escapeXml(footer)}</text>` : '',
  ].join('');
}

export /** One to four ratio/progress ring gauges. */
function renderGauge(spec: GaugeVisualResponseSpec): string {
  const gauges = spec.gauges.slice(0, 4);
  const tones = { accent: '#78effa', good: '#34d399', warn: '#fbbf72', bad: '#f87171' } as const;
  const cellWidth = 1136 / gauges.length;
  const r = 92;
  const cy = 356;
  const cells = gauges.map((gauge, index) => {
    const cx = 72 + cellWidth * (index + 0.5);
    const color = tones[gauge.tone || 'accent'];
    const pct = Math.max(0, Math.min(100, gauge.percent));
    const display = gauge.value || `${formatNumber(pct)}%`;
    return [
      `<circle cx="${round(cx)}" cy="${cy}" r="${r}" fill="none" stroke="#dffcff" stroke-opacity=".08" stroke-width="16"/>`,
      ringArc(cx, cy, r, pct, color),
      `<text x="${round(cx)}" y="${cy + 6}" text-anchor="middle" fill="#f3fbff" font-family="${FONT}" font-size="34" font-weight="740">${escapeXml(truncate(display, 8))}</text>`,
      `<text x="${round(cx)}" y="${cy + 128}" text-anchor="middle" fill="#c5d8e6" font-family="${FONT}" font-size="16" font-weight="650">${escapeXml(truncate(gauge.label, Math.max(10, Math.floor(cellWidth / 10)))) }</text>`,
      gauge.detail ? `<text x="${round(cx)}" y="${cy + 152}" text-anchor="middle" fill="#91a8bc" font-family="${FONT}" font-size="12">${escapeXml(truncate(gauge.detail, Math.max(12, Math.floor(cellWidth / 8))))}</text>` : '',
    ].join('');
  }).join('');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    cells,
  ].join('');
}

/** A progress ring arc from 12 o'clock clockwise by `percent`. */
function ringArc(cx: number, cy: number, r: number, percent: number, color: string): string {
  if (percent <= 0) return '';
  if (percent >= 100) {
    return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${r}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"/>`;
  }
  const theta = (-90 + percent * 3.6) * (Math.PI / 180);
  const endX = cx + r * Math.cos(theta);
  const endY = cy + r * Math.sin(theta);
  const largeArc = percent > 50 ? 1 : 0;
  return `<path d="M ${round(cx)} ${round(cy - r)} A ${r} ${r} 0 ${largeArc} 1 ${round(endX)} ${round(endY)}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"/>`;
}

export /** A status checklist: each item carries a done / todo / in-progress / blocked glyph. */
function renderChecklist(spec: ChecklistVisualResponseSpec): string {
  const items = spec.items.slice(0, 8);
  const doneCount = items.filter((item) => item.status === 'done').length;
  const rowHeight = items.length > 6 ? 58 : 66;
  const startY = 182;
  const glyphs = {
    done: (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="14" fill="#34d399" fill-opacity=".18"/><path d="M ${x - 6} ${y} L ${x - 1} ${y + 6} L ${x + 7} ${y - 6}" fill="none" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    'in-progress': (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="14" fill="none" stroke="#78effa" stroke-opacity=".3" stroke-width="3"/><path d="M ${x} ${y - 14} A 14 14 0 0 1 ${x} ${y + 14} Z" fill="#78effa" fill-opacity=".8"/>`,
    todo: (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="#70879b" stroke-width="3"/>`,
    blocked: (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="14" fill="#f87171" fill-opacity=".16"/><path d="M ${x - 6} ${y - 6} L ${x + 6} ${y + 6} M ${x + 6} ${y - 6} L ${x - 6} ${y + 6}" stroke="#f87171" stroke-width="3" stroke-linecap="round"/>`,
  } as const;
  const rows = items.map((item, index) => {
    const y = startY + index * rowHeight;
    const cy = y + rowHeight / 2 - 6;
    const dim = item.status === 'done' ? '.72' : '1';
    return [
      softPanel(72, y, 1136, rowHeight - 10, 14, index % 2 ? '.05' : '.03'),
      glyphs[item.status](104, cy),
      `<text x="140" y="${round(cy - (item.detail ? 4 : -5))}" fill="#f1f9ff" fill-opacity="${dim}" font-family="${FONT}" font-size="18" font-weight="620"${item.status === 'done' ? ' text-decoration="line-through"' : ''}>${escapeXml(truncate(item.label, 92))}</text>`,
      item.detail ? `<text x="140" y="${round(cy + 18)}" fill="#91a8bc" font-family="${FONT}" font-size="13">${escapeXml(truncate(item.detail, 108))}</text>` : '',
      `<text x="1186" y="${round(cy + 5)}" text-anchor="end" fill="#8fa7ba" font-family="${FONT}" font-size="11" font-weight="700" letter-spacing="1">${escapeXml(item.status.toUpperCase())}</text>`,
    ].join('');
  }).join('');
  return [
    `<text x="72" y="151" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(spec.caption ? truncate(spec.caption, 120) : `${doneCount} of ${items.length} done`)}</text>`,
    rows,
  ].join('');
}
