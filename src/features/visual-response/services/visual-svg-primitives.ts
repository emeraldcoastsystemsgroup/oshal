/**
 * Shared SVG drawing primitives for the fact-locked visual renderer.
 *
 * Extracted from visual-response-renderer.ts once that file crossed the 800 code-line soft cap, so
 * the orchestrator, the original kind renderers, and the newer ones can share one vocabulary.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted shared primitives from
 *            | visual-response-renderer.ts to keep every module under the file-size cap.
 * ---------------------------------------------------------------------------
 * @module visual-svg-primitives
 */

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FONT = 'Inter,Segoe UI,sans-serif';
export const CHART_COLORS = ['#78effa', '#a78bfa', '#fbbf72'] as const;

export function softPanel(x: number, y: number, width: number, height: number, radius: number, opacity = '.05'): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${radius}" fill="#dffcff" fill-opacity="${opacity}" stroke="#78effa" stroke-opacity=".12"/>`;
}

export function labelValue(label: string, value: string, x: number, y: number): string {
  return `<text x="${x}" y="${y}" fill="#8da6ba" font-family="${FONT}" font-size="11" font-weight="700" letter-spacing="1.2">${escapeXml(label)}</text><text x="${x}" y="${y + 29}" fill="#edf9ff" font-family="${FONT}" font-size="19" font-weight="650">${escapeXml(truncate(value, 23))}</text>`;
}

export function renderWrappedText(
  value: string,
  x: number,
  y: number,
  maxChars: number,
  maxLines: number,
  size: number,
  lineGap: number,
  color: string,
  weight: number,
): string {
  return wrapText(value, maxChars, maxLines).map((line, index) =>
    `<text x="${round(x)}" y="${round(y + index * lineGap)}" fill="${color}" font-family="${FONT}" font-size="${size}" font-weight="${weight}">${escapeXml(line)}</text>`,
  ).join('');
}

export function formatCurrency(value: number, currency: 'USD'): string {
  if (currency === 'USD') return `$${value.toFixed(2)}`;
  return `${value.toFixed(2)} ${currency}`;
}

export function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = cleanText(value, 1_000).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1) || '';
    const next = current ? `${current} ${word}` : word;
    if (!current || next.length <= maxChars) {
      if (lines.length) lines[lines.length - 1] = next;
      else lines.push(next);
    } else if (lines.length < maxLines) lines.push(word);
    else break;
  }
  if (words.join(' ').length > lines.join(' ').length && lines.length) {
    lines[lines.length - 1] = truncate(lines[lines.length - 1], Math.max(2, maxChars));
  }
  return lines;
}

export function cleanText(value: string, maximum: number): string {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, maximum);
}

export function truncate(value: string, maximum: number): string {
  const clean = cleanText(value, 2_000);
  return clean.length <= maximum ? clean : `${clean.slice(0, Math.max(1, maximum - 1))}\u2026`;
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

export function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${formatNumber(value / 1_000_000)}M`;
  if (absolute >= 1_000) return `${formatNumber(value / 1_000)}k`;
  return formatNumber(value);
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function escapeXml(value: string): string {
  return cleanText(value, 10_000).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] || character);
}
