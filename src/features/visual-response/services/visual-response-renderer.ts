/**
 * Deterministic, transparent SVG renderer for validated fact-locked visual specifications.
 * It chooses no facts and performs no LLM work: callers must explicitly supply `visualSpec`.
 */

import { createHash } from 'node:crypto';
import { parseVisualResponseSpec } from '../visual-response-schema';
import {
  CHART_COLORS, FONT, HEIGHT, WIDTH, cleanText, compactNumber, escapeXml, formatCurrency,
  formatNumber, labelValue, renderWrappedText, round, softPanel, truncate,
} from './visual-svg-primitives';
import {
  renderAgenda, renderChecklist, renderComparison, renderGauge, renderImage, renderMap, renderProfile,
} from './visual-kind-renderers';
import type {
  AgendaVisualResponseSpec,
  ImageVisualResponseSpec,
  ChartVisualResponseSpec,
  ChecklistVisualResponseSpec,
  ComparisonVisualResponseSpec,
  DiagramVisualResponseSpec,
  FactLockedAnswerPacket,
  GalleryVisualResponseSpec,
  GaugeVisualResponseSpec,
  MapVisualResponseSpec,
  PriorityEmailVisualResponseSpec,
  ProfileVisualResponseSpec,
  RenderedVisualResponse,
  SummaryVisualResponseSpec,
  TableVisualResponseSpec,
  TimelineVisualResponseSpec,
  VisualResponseSpec,
  WeatherVisualResponseSpec,
} from '../types';
import type { TrustedImageReceipt } from './trusted-image-receipt-service';

const RENDERER = 'oshal-fact-locked-svg-v2';

/**
 * Render an explicit visual specification into immutable SVG bytes.
 * Missing or invalid specs are rejected so ordinary conversation never becomes a generic popup.
 */
export function renderVisualResponse(
  packet: FactLockedAnswerPacket,
  trustedImages: ReadonlyMap<string, TrustedImageReceipt> = new Map(),
): RenderedVisualResponse {
  const spec = parseVisualResponseSpec(packet.visualSpec);
  if (!spec) throw new Error('A valid visualSpec is required to render a visual response');

  const answerSha256 = sha256(packet.answer);
  // Both image-bearing kinds fold their receipts into the spec digest, so the provenance hash covers
  // the exact bytes that were embedded, not just the model-authored words.
  const galleryReceipts = spec.kind === 'gallery' || spec.kind === 'image'
    ? spec.items.map((item) => trustedImages.get(item.sourceRef)).filter(Boolean)
      .map((receipt) => ({ sourceRef: receipt!.sourceRef, contentSha256: receipt!.contentSha256 }))
    : [];
  const visualSpecSha256 = sha256(canonicalJson(
    galleryReceipts.length ? { spec, galleryReceipts } : spec,
  ));
  const alt = buildAlt(spec);
  const body = renderBody(spec, trustedImages);
  const sourceLine = renderSourceLine(packet, spec);
  const svg = buildSvg(spec, alt, body, sourceLine);
  return {
    content: Buffer.from(svg, 'utf8'),
    mimeType: 'image/svg+xml',
    alt,
    width: WIDTH,
    height: HEIGHT,
    answerSha256,
    visualSpecSha256,
    kind: spec.kind,
    renderer: RENDERER,
  };
}

function buildSvg(spec: VisualResponseSpec, alt: string, body: string, sourceLine: string): string {
  const eyebrow = spec.kind.replace('-', ' ').toUpperCase();
  const subtitle = [spec.asOf, sourceLine].filter(Boolean).join('  \u00B7  ');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escapeXml(alt)}</title>`,
    `<desc id="desc">${escapeXml(`${spec.kind.replace('-', ' ')} visual summary. The full answer is retained in Discussion.`)}</desc>`,
    '<defs>',
    '<linearGradient id="accent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#78effa"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>',
    '<radialGradient id="aura"><stop offset="0" stop-color="#78effa" stop-opacity=".18"/><stop offset="1" stop-color="#78effa" stop-opacity="0"/></radialGradient>',
    '<filter id="soft"><feGaussianBlur stdDeviation="18"/></filter>',
    '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#78effa" fill-opacity=".75"/></marker>',
    '</defs>',
    // The SVG is intentionally transparent. These small atmospheric forms belong to the content;
    // there is no full-canvas rectangle or opaque popup background.
    '<circle cx="1050" cy="106" r="210" fill="url(#aura)"/>',
    '<circle cx="104" cy="616" r="92" fill="#a78bfa" fill-opacity=".06" filter="url(#soft)"/>',
    `<text x="72" y="62" fill="#78effa" font-family="${FONT}" font-size="14" font-weight="700" letter-spacing="3">${escapeXml(eyebrow)}</text>`,
    // Keep the header a stable single line. The complete title remains in accessible alt text; a
    // bounded on-canvas title prevents a schema-valid 120-character value from colliding with the
    // caption and content plane below it.
    renderWrappedText(truncate(spec.title, 62), 72, 111, 62, 1, 31, 38, '#f5fbff', 700),
    body,
    `<text x="72" y="685" fill="#91a8bc" font-family="${FONT}" font-size="13">${escapeXml(subtitle || 'Saved with completed answer')}</text>`,
    '<circle cx="1172" cy="680" r="4" fill="#78effa"/><circle cx="1187" cy="680" r="4" fill="#78effa" fill-opacity=".52"/><circle cx="1202" cy="680" r="4" fill="#78effa" fill-opacity=".24"/>',
    '</svg>',
  ].join('');
}

function renderBody(
  spec: VisualResponseSpec,
  trustedImages: ReadonlyMap<string, TrustedImageReceipt>,
): string {
  switch (spec.kind) {
    case 'weather': return renderWeather(spec);
    case 'priority-email': return renderPriorityEmail(spec);
    case 'table': return renderTable(spec);
    case 'chart': return renderChart(spec);
    case 'summary': return renderSummary(spec);
    case 'timeline': return renderTimeline(spec);
    case 'diagram': return renderDiagram(spec);
    case 'gallery': return renderGallery(spec, trustedImages);
    case 'map': return renderMap(spec);
    case 'gauge': return renderGauge(spec);
    case 'checklist': return renderChecklist(spec);
    case 'agenda': return renderAgenda(spec);
    case 'comparison': return renderComparison(spec);
    case 'profile': return renderProfile(spec);
    case 'image': return renderImage(spec, trustedImages);
  }
}









function renderGallery(
  spec: GalleryVisualResponseSpec,
  trustedImages: ReadonlyMap<string, TrustedImageReceipt>,
): string {
  const items = spec.items.slice(0, 4);
  const gap = 14;
  const availableWidth = 1136;
  const cardWidth = (availableWidth - gap * Math.max(0, items.length - 1)) / items.length;
  const cards = items.map((item, index) => {
    const x = 72 + index * (cardWidth + gap);
    const image = trustedImages.get(item.sourceRef);
    const imageX = x + 14;
    const imageY = 178;
    const imageWidth = cardWidth - 28;
    const imageHeight = 254;
    const price = item.price === undefined ? '' : formatCurrency(item.price, item.currency);
    const imageMarkup = image
      ? `<image x="${round(imageX)}" y="${imageY}" width="${round(imageWidth)}" height="${imageHeight}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${image.content.toString('base64')}"/>`
      : [
          `<rect x="${round(imageX)}" y="${imageY}" width="${round(imageWidth)}" height="${imageHeight}" rx="17" fill="#78effa" fill-opacity=".035"/>`,
          `<circle cx="${round(x + cardWidth / 2)}" cy="${imageY + 118}" r="34" fill="#78effa" fill-opacity=".08"/>`,
          `<text x="${round(x + cardWidth / 2)}" y="${imageY + 126}" text-anchor="middle" fill="#78effa" fill-opacity=".6" font-family="${FONT}" font-size="13" font-weight="700" letter-spacing="2">IMAGE</text>`,
        ].join('');
    const chars = Math.max(14, Math.floor((cardWidth - 32) / 8));
    return [
      softPanel(x, 164, cardWidth, 464, 22, index === 0 ? '.075' : '.052'),
      imageMarkup,
      renderWrappedText(item.title, x + 17, 468, chars, 3, 17, 22, '#f1f9ff', 690),
      item.brand ? `<text x="${round(x + 17)}" y="552" fill="#91a9bc" font-family="${FONT}" font-size="12">${escapeXml(truncate(item.brand, chars + 6))}</text>` : '',
      price ? `<text x="${round(x + 17)}" y="600" fill="#78effa" font-family="${FONT}" font-size="25" font-weight="740">${escapeXml(price)}</text>` : '',
    ].join('');
  }).join('');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    cards,
  ].join('');
}

function renderWeather(spec: WeatherVisualResponseSpec): string {
  const degreeUnit = spec.units === 'imperial' ? 'F' : 'C';
  const temperature = `${formatNumber(spec.current.temperature)}\u00B0${degreeUnit}`;
  const detailItems = [
    spec.current.high === undefined && spec.current.low === undefined ? null : [
      'HIGH / LOW',
      `${spec.current.high === undefined ? '\u2014' : `${formatNumber(spec.current.high)}\u00B0`} / ${spec.current.low === undefined ? '\u2014' : `${formatNumber(spec.current.low)}\u00B0`}`,
    ],
    spec.current.feelsLike === undefined ? null : ['FEELS LIKE', `${formatNumber(spec.current.feelsLike)}\u00B0${degreeUnit}`],
    spec.current.humidityPercent === undefined ? null : ['HUMIDITY', `${formatNumber(spec.current.humidityPercent)}%`],
    spec.current.precipitationPercent === undefined ? null : ['PRECIPITATION', `${formatNumber(spec.current.precipitationPercent)}%`],
    spec.current.wind ? ['WIND', spec.current.wind] : null,
  ].filter((item): item is string[] => Boolean(item));

  const details = detailItems.slice(0, 6).map((item, index) => {
    const x = 468 + (index % 3) * 246;
    const y = 218 + Math.floor(index / 3) * 88;
    return `${softPanel(x, y, 226, 72, 18)}${labelValue(item[0], item[1], x + 18, y + 24)}`;
  }).join('');

  const periods = (spec.periods || []).slice(0, 6);
  const periodWidth = periods.length ? Math.min(176, Math.floor(1118 / periods.length) - 10) : 0;
  const periodCards = periods.map((period, index) => {
    const x = 72 + index * (periodWidth + 10);
    const y = 468;
    return [
      softPanel(x, y, periodWidth, 142, 19),
      `<text x="${x + 16}" y="${y + 29}" fill="#a9bfd2" font-family="${FONT}" font-size="13" font-weight="650">${escapeXml(truncate(period.label, 20))}</text>`,
      `<text x="${x + 16}" y="${y + 68}" fill="#f4fbff" font-family="${FONT}" font-size="28" font-weight="720">${escapeXml(`${formatNumber(period.temperature)}\u00B0`)}</text>`,
      renderWrappedText(period.condition, x + 16, y + 94, Math.max(12, Math.floor(periodWidth / 8)), 2, 13, 18, '#c7d7e4', 450),
      period.precipitationPercent === undefined ? '' : `<text x="${x + periodWidth - 16}" y="${y + 29}" text-anchor="end" fill="#78effa" font-family="${FONT}" font-size="12">${escapeXml(`${formatNumber(period.precipitationPercent)}%`)}</text>`,
    ].join('');
  }).join('');

  return [
    `<text x="72" y="198" fill="#9eb6c9" font-family="${FONT}" font-size="17">${escapeXml(spec.location)}</text>`,
    `<text x="72" y="316" fill="url(#accent)" font-family="${FONT}" font-size="104" font-weight="760" letter-spacing="-5">${escapeXml(temperature)}</text>`,
    renderWeatherGlyph(spec.current.condition),
    renderWrappedText(spec.current.condition, 78, 365, 40, 2, 24, 31, '#e1edf5', 520),
    details,
    periodCards,
  ].join('');
}

function renderPriorityEmail(spec: PriorityEmailVisualResponseSpec): string {
  const items = spec.items.slice(0, 6);
  const mailbox = spec.mailbox ? `Mailbox: ${spec.mailbox}` : 'Priority inbox';
  const count = spec.totalCount === undefined ? `${items.length} shown` : `${items.length} of ${spec.totalCount} shown`;
  const rows = items.map((item, index) => {
    const y = 184 + index * 75;
    const sender = truncate(item.sender, 30);
    const subject = truncate(item.subject, 70);
    const meta = [
      item.receivedAt,
      item.reason,
      item.suggestedAction ? `Suggested: ${item.suggestedAction}` : undefined,
    ].filter(Boolean).join('  \u00B7  ');
    const accent = item.importance === 'important'
      ? '#fbbf72'
      : item.importance === 'starred' ? '#a78bfa' : item.unread || item.importance === 'suggested' ? '#78effa' : '#70879b';
    return [
      softPanel(72, y, 1136, 63, 16, index % 2 ? '.052' : '.035'),
      `<circle cx="94" cy="${y + 31}" r="5" fill="${accent}"/>`,
      `<text x="112" y="${y + 26}" fill="#c5d8e6" font-family="${FONT}" font-size="14" font-weight="650">${escapeXml(sender)}</text>`,
      `<text x="340" y="${y + 27}" fill="#f4fbff" font-family="${FONT}" font-size="17" font-weight="${item.unread ? 700 : 500}">${escapeXml(subject)}</text>`,
      meta ? `<text x="340" y="${y + 49}" fill="#8fa7ba" font-family="${FONT}" font-size="12">${escapeXml(truncate(meta, 112))}</text>` : '',
      item.importance ? `<text x="1186" y="${y + 28}" text-anchor="end" fill="${accent}" font-family="${FONT}" font-size="11" font-weight="700" letter-spacing="1.2">${escapeXml(item.importance.toUpperCase())}</text>` : '',
    ].join('');
  }).join('');
  return [
    `<text x="72" y="151" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(mailbox)}</text>`,
    `<text x="1208" y="151" text-anchor="end" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(count)}</text>`,
    rows,
  ].join('');
}

function renderTable(spec: TableVisualResponseSpec): string {
  const columns = spec.columns;
  const rows = spec.rows.slice(0, 8);
  const startX = 72;
  const startY = 177;
  const availableWidth = 1136;
  const columnWidth = availableWidth / columns.length;
  const header = columns.map((column, index) => {
    const x = startX + index * columnWidth;
    return [
      `<rect x="${round(x)}" y="${startY}" width="${round(columnWidth - 7)}" height="44" rx="12" fill="#78effa" fill-opacity=".12"/>`,
      `<text x="${round(x + 14)}" y="${startY + 28}" fill="#bff7ff" font-family="${FONT}" font-size="14" font-weight="700">${escapeXml(truncate(column, Math.max(8, Math.floor(columnWidth / 9))))}</text>`,
    ].join('');
  }).join('');
  const body = rows.map((row, rowIndex) => row.map((cell, columnIndex) => {
    const x = startX + columnIndex * columnWidth;
    const y = startY + 51 + rowIndex * 50;
    return [
      `<rect x="${round(x)}" y="${y}" width="${round(columnWidth - 7)}" height="43" rx="11" fill="#dffcff" fill-opacity="${rowIndex % 2 ? '.05' : '.028'}"/>`,
      `<text x="${round(x + 14)}" y="${y + 27}" fill="#e0edf5" font-family="${FONT}" font-size="14">${escapeXml(truncate(cell, Math.max(8, Math.floor(columnWidth / 8.5))))}</text>`,
    ].join('');
  }).join('')).join('');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    header,
    body,
  ].join('');
}

function renderChart(spec: ChartVisualResponseSpec): string {
  const plot = { x: 104, y: 184, width: 1068, height: 376 };
  const values = spec.series.flatMap((series) => series.values);
  let minimum = Math.min(0, ...values);
  let maximum = Math.max(0, ...values);
  if (minimum === maximum) { minimum -= 1; maximum += 1; }
  const yFor = (value: number) => plot.y + ((maximum - value) / (maximum - minimum)) * plot.height;
  const zeroY = yFor(0);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = plot.y + ratio * plot.height;
    const value = maximum - ratio * (maximum - minimum);
    return [
      `<line x1="${plot.x}" y1="${round(y)}" x2="${plot.x + plot.width}" y2="${round(y)}" stroke="#b8f7ff" stroke-opacity=".11"/>`,
      `<text x="${plot.x - 14}" y="${round(y + 4)}" text-anchor="end" fill="#8299ad" font-family="${FONT}" font-size="11">${escapeXml(compactNumber(value))}</text>`,
    ].join('');
  }).join('');
  const categoryWidth = plot.width / spec.categories.length;
  const labels = spec.categories.map((category, index) => {
    const x = plot.x + categoryWidth * (index + 0.5);
    return `<text x="${round(x)}" y="${plot.y + plot.height + 29}" text-anchor="middle" fill="#9eb3c4" font-family="${FONT}" font-size="11">${escapeXml(truncate(category, Math.max(6, Math.floor(categoryWidth / 8))))}</text>`;
  }).join('');
  const marks = spec.chartType === 'bar'
    ? renderBars(spec, plot, zeroY, yFor)
    : renderLines(spec, plot, yFor);
  const legend = spec.series.map((series, index) => {
    const x = 104 + index * 250;
    return `<circle cx="${x}" cy="628" r="5" fill="${CHART_COLORS[index]}"/><text x="${x + 13}" y="633" fill="#b7cad8" font-family="${FONT}" font-size="13">${escapeXml(truncate(series.name + (series.unit ? ` (${series.unit})` : ''), 30))}</text>`;
  }).join('');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    grid,
    `<line x1="${plot.x}" y1="${round(zeroY)}" x2="${plot.x + plot.width}" y2="${round(zeroY)}" stroke="#dffcff" stroke-opacity=".28"/>`,
    marks,
    labels,
    legend,
  ].join('');
}

function renderBars(
  spec: ChartVisualResponseSpec,
  plot: { x: number; y: number; width: number; height: number },
  zeroY: number,
  yFor: (value: number) => number,
): string {
  const categoryWidth = plot.width / spec.categories.length;
  const groupWidth = categoryWidth * 0.72;
  const barWidth = Math.max(3, groupWidth / spec.series.length - 3);
  return spec.series.map((series, seriesIndex) => series.values.map((value, valueIndex) => {
    const x = plot.x + valueIndex * categoryWidth + (categoryWidth - groupWidth) / 2 + seriesIndex * (barWidth + 3);
    const valueY = yFor(value);
    const y = Math.min(valueY, zeroY);
    const height = Math.max(1, Math.abs(zeroY - valueY));
    return `<rect x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(height)}" rx="4" fill="${CHART_COLORS[seriesIndex]}" fill-opacity=".86"/>`;
  }).join('')).join('');
}

function renderLines(
  spec: ChartVisualResponseSpec,
  plot: { x: number; y: number; width: number; height: number },
  yFor: (value: number) => number,
): string {
  const categoryWidth = plot.width / spec.categories.length;
  return spec.series.map((series, seriesIndex) => {
    const points = series.values.map((value, index) => ({
      x: plot.x + categoryWidth * (index + 0.5),
      y: yFor(value),
    }));
    const path = points.map((point, index) => `${index ? 'L' : 'M'} ${round(point.x)} ${round(point.y)}`).join(' ');
    const dots = points.map((point) => `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="5" fill="${CHART_COLORS[seriesIndex]}" stroke="#07111f" stroke-width="2"/>`).join('');
    return `<path d="${path}" fill="none" stroke="${CHART_COLORS[seriesIndex]}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
}

function renderSummary(spec: SummaryVisualResponseSpec): string {
  const metrics = (spec.metrics || []).slice(0, 4);
  const bullets = (spec.bullets || []).slice(0, 6);
  const metricWidth = metrics.length ? Math.min(270, Math.floor((1136 - (metrics.length - 1) * 14) / metrics.length)) : 0;
  const metricCards = metrics.map((metric, index) => {
    const x = 72 + index * (metricWidth + 14);
    return [
      softPanel(x, 181, metricWidth, 126, 21, '.065'),
      `<text x="${x + 20}" y="213" fill="#91a9bc" font-family="${FONT}" font-size="12" font-weight="700" letter-spacing="1.3">${escapeXml(truncate(metric.label.toUpperCase(), 28))}</text>`,
      `<text x="${x + 20}" y="260" fill="#f3fbff" font-family="${FONT}" font-size="31" font-weight="730">${escapeXml(truncate(metric.value, 18))}</text>`,
      metric.detail ? `<text x="${x + 20}" y="289" fill="#a9bdcc" font-family="${FONT}" font-size="12">${escapeXml(truncate(metric.detail, 35))}</text>` : '',
    ].join('');
  }).join('');
  const bulletStart = metrics.length ? 360 : 196;
  const bulletRows = bullets.map((bullet, index) => {
    const y = bulletStart + index * 48;
    return `<circle cx="83" cy="${y - 5}" r="4" fill="#78effa"/><text x="102" y="${y}" fill="#dbe9f2" font-family="${FONT}" font-size="19">${escapeXml(truncate(bullet, 105))}</text>`;
  }).join('');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    metricCards,
    bulletRows,
  ].join('');
}

function renderTimeline(spec: TimelineVisualResponseSpec): string {
  const items = spec.items.slice(0, 6);
  const gap = 12;
  const availableWidth = 1136;
  const cardWidth = (availableWidth - gap * (items.length - 1)) / items.length;
  const railY = 579;
  const cards = items.map((item, index) => {
    const x = 72 + index * (cardWidth + gap);
    const centerX = x + cardWidth / 2;
    const labelChars = Math.max(8, Math.floor(cardWidth / 9));
    return [
      softPanel(x, 183, cardWidth, 355, 20, index === 0 ? '.075' : '.05'),
      `<text x="${round(x + 17)}" y="219" fill="#78effa" font-family="${FONT}" font-size="11" font-weight="750" letter-spacing="1.1">${escapeXml(truncate(item.label.toUpperCase(), labelChars))}</text>`,
      renderWrappedText(item.title, x + 17, 264, labelChars, 3, 19, 25, '#f1f9ff', 690),
      item.detail ? renderWrappedText(item.detail, x + 17, 358, labelChars + 2, 5, 13, 20, '#a9bdcc', 450) : '',
      `<circle cx="${round(centerX)}" cy="${railY}" r="12" fill="#07111f" stroke="#78effa" stroke-width="4"/>`,
      `<text x="${round(centerX)}" y="${railY + 39}" text-anchor="middle" fill="#91a8bc" font-family="${FONT}" font-size="11">${index + 1}</text>`,
    ].join('');
  }).join('');
  const railStart = 72 + cardWidth / 2;
  const railEnd = 72 + (items.length - 1) * (cardWidth + gap) + cardWidth / 2;
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    `<line x1="${round(railStart)}" y1="${railY}" x2="${round(railEnd)}" y2="${railY}" stroke="#78effa" stroke-width="4" stroke-opacity=".42"/>`,
    cards,
  ].join('');
}

interface DiagramNodePosition {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function renderDiagram(spec: DiagramVisualResponseSpec): string {
  const positions = positionDiagramNodes(spec);
  const byId = new Map(positions.map((position) => [position.id, position]));
  const renderedEdges = spec.edges.map((edge) => {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const endpoints = diagramEdgeEndpoints(from, to);
    const midX = (endpoints.x1 + endpoints.x2) / 2;
    const midY = (endpoints.y1 + endpoints.y2) / 2;
    const labelWidth = Math.min(150, Math.max(52, edge.label.length * 7.4 + 18));
    const labelPosition = diagramEdgeLabelPosition(from, to, midX, midY);
    return {
      path: `<path d="M ${round(endpoints.x1)} ${round(endpoints.y1)} L ${round(endpoints.x2)} ${round(endpoints.y2)}" fill="none" stroke="#78effa" stroke-width="3" stroke-opacity=".58" marker-end="url(#arrow)"/>`,
      label: [
        `<rect x="${round(labelPosition.x - labelWidth / 2)}" y="${round(labelPosition.y - 16)}" width="${round(labelWidth)}" height="25" rx="10" fill="#07111f" fill-opacity=".96" stroke="#78effa" stroke-opacity=".24"/>`,
        `<text x="${round(labelPosition.x)}" y="${round(labelPosition.y + 1)}" text-anchor="middle" fill="#c6dce9" font-family="${FONT}" font-size="11" font-weight="650">${escapeXml(truncate(edge.label, 20))}</text>`,
      ].join(''),
    };
  });
  const edgePaths = renderedEdges.map((edge) => edge.path).join('');
  const edgeLabels = renderedEdges.map((edge) => edge.label).join('');
  const nodes = spec.nodes.map((node, index) => {
    const position = byId.get(node.id)!;
    const left = position.x - position.width / 2;
    const top = position.y - position.height / 2;
    const maxChars = Math.max(12, Math.floor(position.width / 9));
    const compact = position.height < 90;
    const color = CHART_COLORS[index % CHART_COLORS.length];
    return [
      `<rect x="${round(left)}" y="${round(top)}" width="${round(position.width)}" height="${round(position.height)}" rx="20" fill="#0d1a29" fill-opacity=".96" stroke="${color}" stroke-width="2" stroke-opacity=".72"/>`,
      `<circle cx="${round(left + 18)}" cy="${round(top + (compact ? 14 : 19))}" r="4" fill="${color}"/>`,
      renderWrappedText(node.label, left + 18, top + (compact ? 34 : 43), maxChars, compact ? 1 : 2, compact ? 14 : 16, compact ? 18 : 21, '#f1f9ff', 700),
      node.detail && !compact ? renderWrappedText(node.detail, left + 18, top + 87, maxChars + 4, 2, 11, 16, '#9eb4c5', 450) : '',
    ].join('');
  }).join('');
  return [
    spec.caption ? `<text x="72" y="148" fill="#9eb6c9" font-family="${FONT}" font-size="14">${escapeXml(truncate(spec.caption, 150))}</text>` : '',
    `<g data-diagram-layout="${spec.layout}">${edgePaths}${nodes}${edgeLabels}</g>`,
  ].join('');
}

function diagramEdgeLabelPosition(
  from: DiagramNodePosition,
  to: DiagramNodePosition,
  midX: number,
  midY: number,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dy) < 4 && Math.abs(dx) >= Math.abs(dy)) {
    // A chain can have six to eight narrow columns. Keep relationship labels in the open lane above
    // the nodes rather than squeezing them into the short arrow segment between adjacent cards.
    return {
      x: midX,
      y: Math.min(from.y - from.height / 2, to.y - to.height / 2) - 18,
    };
  }
  const length = Math.max(1, Math.hypot(dx, dy));
  let normalX = -dy / length;
  let normalY = dx / length;
  if (normalY > 0) { normalX *= -1; normalY *= -1; }
  return { x: midX + normalX * 24, y: midY + normalY * 24 };
}

function positionDiagramNodes(spec: DiagramVisualResponseSpec): DiagramNodePosition[] {
  const plot = { x: 88, y: 176, width: 1104, height: 430 };
  const depths = new Map(spec.nodes.map((node) => [node.id, 0]));
  for (let iteration = 0; iteration < spec.nodes.length; iteration += 1) {
    for (const edge of spec.edges) {
      depths.set(edge.to, Math.max(depths.get(edge.to) || 0, (depths.get(edge.from) || 0) + 1));
    }
  }
  const levelValues = [...new Set(spec.nodes.map((node) => depths.get(node.id) || 0))].sort((a, b) => a - b);
  const membersByLevel = levelValues.map((level) => spec.nodes.filter((node) => depths.get(node.id) === level));
  const maxMembers = Math.max(...membersByLevel.map((members) => members.length));
  const verticalGap = maxMembers > 4 ? 12 : 20;
  const nodeHeight = Math.min(122, (plot.height - Math.max(0, maxMembers - 1) * verticalGap) / maxMembers);
  const horizontalGap = levelValues.length <= 6 ? 72 : levelValues.length === 7 ? 56 : 44;
  const nodeWidth = Math.min(216, (plot.width - Math.max(0, levelValues.length - 1) * horizontalGap) / levelValues.length);
  return membersByLevel.flatMap((members, levelIndex) => {
    const x = levelValues.length === 1
      ? plot.x + plot.width / 2
      : plot.x + nodeWidth / 2 + levelIndex * ((plot.width - nodeWidth) / (levelValues.length - 1));
    const occupiedHeight = members.length * nodeHeight + Math.max(0, members.length - 1) * verticalGap;
    const firstY = plot.y + (plot.height - occupiedHeight) / 2 + nodeHeight / 2;
    return members.map((node, memberIndex) => ({
      id: node.id,
      x,
      y: firstY + memberIndex * (nodeHeight + verticalGap),
      width: nodeWidth,
      height: nodeHeight,
    }));
  });
}

function diagramEdgeEndpoints(from: DiagramNodePosition, to: DiagramNodePosition): { x1: number; y1: number; x2: number; y2: number } {
  const direction = to.x >= from.x ? 1 : -1;
  return {
    x1: from.x + direction * from.width / 2,
    y1: from.y,
    x2: to.x - direction * to.width / 2 - direction * 8,
    y2: to.y,
  };
}




function buildAlt(spec: VisualResponseSpec): string {
  switch (spec.kind) {
    case 'weather': {
      const unit = spec.units === 'imperial' ? 'F' : 'C';
      return cleanText(`${spec.title}: ${formatNumber(spec.current.temperature)} degrees ${unit}, ${spec.current.condition}, ${spec.location}`, 420);
    }
    case 'priority-email': {
      const preview = spec.items.slice(0, 2)
        .map((item) => `${cleanText(item.sender, 80)}: ${cleanText(item.subject, 120)}`)
        .join('; ');
      return cleanText(`${spec.title}: ${spec.items.length} priority email${spec.items.length === 1 ? '' : 's'}${preview ? `. ${preview}` : ''}`, 420);
    }
    case 'table': {
      const rows = spec.rows.slice(0, 3).map((row) => row.map((cell, index) => `${spec.columns[index]}: ${cell}`).join(', '));
      return cleanText(`${spec.title}. ${rows.join('; ')}`, 420);
    }
    case 'chart': {
      const series = spec.series.map((item) => {
        const values = item.values.map((value, index) => `${spec.categories[index]} ${formatNumber(value)}${item.unit || ''}`);
        return `${item.name}: ${values.join(', ')}`;
      });
      return cleanText(`${spec.title}, ${spec.chartType} chart. ${series.join('; ')}`, 420);
    }
    case 'summary': {
      const metrics = (spec.metrics || []).map((metric) => `${metric.label}: ${metric.value}${metric.detail ? `, ${metric.detail}` : ''}`);
      return cleanText(`${spec.title}. ${[...metrics, ...(spec.bullets || [])].join('; ')}`, 420);
    }
    case 'timeline': {
      const items = spec.items.map((item) => `${item.label}: ${item.title}${item.detail ? `, ${item.detail}` : ''}`);
      return cleanText(`${spec.title}. Timeline: ${items.join('; ')}`, 420);
    }
    case 'diagram': {
      const labels = new Map(spec.nodes.map((node) => [node.id, node.label]));
      const relationships = spec.edges.map((edge) => `${labels.get(edge.from)} ${edge.label} ${labels.get(edge.to)}`);
      return cleanText(`${spec.title}. Diagram: ${relationships.join('; ')}`, 420);
    }
    case 'gallery': {
      const items = spec.items.map((item) => {
        const price = item.price === undefined ? '' : `, ${formatCurrency(item.price, item.currency)}`;
        return `${item.title}${item.brand ? ` by ${item.brand}` : ''}${price}`;
      });
      return cleanText(`${spec.title}. Product gallery: ${items.join('; ')}`, 420);
    }
    case 'map': {
      const route = spec.route ? spec.places.map((place) => place.label).join(' to ') : spec.places.map((place) => place.label).join(', ');
      const facts = [spec.distance, spec.duration].filter(Boolean).join(', ');
      return cleanText(`${spec.title}. Map: ${route}${facts ? `. ${facts}` : ''}`, 420);
    }
    case 'gauge': {
      const gauges = spec.gauges.map((gauge) => `${gauge.label}: ${gauge.value || `${formatNumber(gauge.percent)}%`}${gauge.detail ? ` (${gauge.detail})` : ''}`);
      return cleanText(`${spec.title}. ${gauges.join('; ')}`, 420);
    }
    case 'checklist': {
      const items = spec.items.map((item) => `${item.label}: ${item.status}`);
      return cleanText(`${spec.title}. Checklist: ${items.join('; ')}`, 420);
    }
    case 'agenda': {
      const items = spec.items.map((item) => `${item.time} ${item.title}${item.location ? ` at ${item.location}` : ''}${item.status && item.status !== 'confirmed' ? ` (${item.status})` : ''}`);
      return cleanText(`${spec.title}${spec.dateLabel ? `, ${spec.dateLabel}` : ''}. Agenda: ${items.join('; ')}`, 420);
    }
    case 'comparison': {
      const heads = spec.options.map((option) => `${option.label}${option.recommended ? ' (recommended)' : ''}`).join(' vs ');
      const rows = spec.attributes.map((attribute) => `${attribute.label}: ${attribute.values.join(' / ')}`);
      return cleanText(`${spec.title}. Comparison of ${heads}. ${rows.join('; ')}`, 420);
    }
    case 'profile': {
      const fields = (spec.fields || []).map((field) => `${field.label}: ${field.value}`);
      return cleanText(`${spec.title}. ${spec.name}${spec.subtitle ? `, ${spec.subtitle}` : ''}. ${[...fields, ...(spec.bullets || [])].join('; ')}`, 420);
    }
    case 'image': {
      // Each item's caption IS its accessible description, so the alt is simply their sequence.
      const captions = spec.items.map((item) => item.caption);
      return cleanText(`${spec.title}. ${spec.items.length === 1 ? 'Image' : `${spec.items.length} images`}: ${captions.join('; ')}`, 420);
    }
  }
}


function renderSourceLine(packet: FactLockedAnswerPacket, spec: VisualResponseSpec): string {
  const requested = new Set(spec.sourceRefs);
  const candidates = (packet.sources || []).filter((source) => !requested.size || requested.has(source.id));
  const labels = candidates.map((source) => cleanText(source.label || source.id, 80)).filter(Boolean).slice(0, 3);
  return labels.length ? `Sources \u00B7 ${labels.join(', ')}` : 'Saved with completed answer';
}

/** Map only the provider's condition words to a fixed SVG glyph; unknown conditions stay unadorned. */
function renderWeatherGlyph(condition: string): string {
  const normalized = condition.toLowerCase();
  const cloud = '<path d="M365 276c0-17 14-31 31-31 13 0 24 8 29 19 3-2 8-3 12-3 15 0 27 12 27 27s-12 27-27 27h-69c-14 0-25-11-25-25 0-12 9-23 22-24z" fill="#dffcff" fill-opacity=".82"/>';
  if (/thunder|lightning|storm/.test(normalized)) {
    return `<g data-weather-glyph="storm">${cloud}<path d="M404 316l-13 28h17l-8 28 30-39h-18l12-17z" fill="#fbbf72"/></g>`;
  }
  if (/snow|flurr|sleet|ice/.test(normalized)) {
    return `<g data-weather-glyph="snow">${cloud}<circle cx="379" cy="337" r="4" fill="#78effa"/><circle cx="405" cy="348" r="4" fill="#78effa"/><circle cx="432" cy="337" r="4" fill="#78effa"/><circle cx="453" cy="350" r="4" fill="#78effa"/></g>`;
  }
  if (/rain|shower|drizzle/.test(normalized)) {
    return `<g data-weather-glyph="rain">${cloud}<path d="M380 329l-7 16M407 329l-7 16M434 329l-7 16M457 329l-7 16" stroke="#78effa" stroke-width="5" stroke-linecap="round"/></g>`;
  }
  if (/fog|mist|haze/.test(normalized)) {
    return '<g data-weather-glyph="fog"><path d="M350 270h106M365 291h108M344 312h104M370 333h96" stroke="#c9dbe7" stroke-opacity=".78" stroke-width="7" stroke-linecap="round"/></g>';
  }
  if (/partly|mostly sunny|mostly clear/.test(normalized)) {
    return `<g data-weather-glyph="partly-cloudy"><circle cx="391" cy="272" r="31" fill="#fbbf72" fill-opacity=".9"/><path d="M391 225v-13M391 332v-13M344 272h-13M451 272h-13M358 239l-10-10M434 315l-10-10M424 239l10-10M348 315l10-10" stroke="#fbbf72" stroke-width="5" stroke-linecap="round"/>${cloud}</g>`;
  }
  if (/cloud|overcast/.test(normalized)) return `<g data-weather-glyph="cloud">${cloud}</g>`;
  if (/sun|clear/.test(normalized)) {
    return '<g data-weather-glyph="sun"><circle cx="404" cy="285" r="38" fill="#fbbf72" fill-opacity=".92"/><path d="M404 225v-17M404 362v-17M344 285h-17M481 285h-17M361 242l-12-12M459 340l-12-12M447 242l12-12M349 340l12-12" stroke="#fbbf72" stroke-width="6" stroke-linecap="round"/></g>';
  }
  return '';
}







function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

