/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — parses a slide body into structured SlideData. Previously the body was only ever split on newlines into bullets, so every slide could only ever BE bullets. Recognising tables/metrics/quotes/groups is what lets the composer pick a real layout without the author having to ask for one.
 */

import type { SlideData } from '@/shared/types';

/** Magnitude suffixes accepted in metric values ("1.2M" → 1_200_000). */
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * @description Parse an authored metric string into a number. Accepts the shapes people
 * actually type — `1,240`, `$1.2M`, `94%`, `3.4x`, `-12`.
 * @param raw - the authored value.
 * @returns the number, or null when the string isn't a metric.
 */
export function parseMetric(raw: string): number | null {
  const s = String(raw ?? '').trim().replace(/[,$\s]/g, '');
  const m = /^(-?\d+(?:\.\d+)?)([kmbt])?[%x]?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * SUFFIX[m[2].toLowerCase()] : n;
}

/**
 * @description True when a label reads as a point in time — the signal that separates a
 * timeline from a process or a KPI grid.
 * @param label - the pair label.
 * @returns true for quarters, years, months, phases, and week/day markers.
 */
export function looksTemporal(label: string): boolean {
  const s = String(label ?? '').trim();
  return /^(q[1-4]\b|fy\s?\d|20\d{2}|19\d{2}|h[12]\b|phase\s?\d|step\s?\d|week\s?\d|day\s?\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|now|today|later)/i.test(s);
}

/**
 * @description True when a label reads as a metric value ("94%", "$1.2M", "3.4x").
 * @param label - the pair label.
 * @returns true when the label is a formatted number.
 */
export function looksMetric(label: string): boolean {
  return parseMetric(label) !== null && /\d/.test(label);
}

/** An empty SlideData — the shape every layout can safely render from. */
function emptyData(): SlideData {
  return { bullets: [], groups: [], pairs: [], series: [], table: null, quote: null, directives: {} };
}

/** Split a markdown-style table row into trimmed cells. */
function tableCells(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/** True for a `| --- | --- |` alignment separator. */
function isTableRule(line: string): boolean {
  return /^\|[\s:|-]+\|?$/.test(line) && line.includes('-');
}

/** Accumulator threaded through the line loop. */
interface ParseState {
  data: SlideData;
  group: { heading: string; items: string[] } | null;
  quoteLines: string[];
  tableRows: string[][];
}

/** Handle the `#key: value` directive form. Returns true when the line was consumed. */
function takeDirective(line: string, st: ParseState): boolean {
  const m = /^#(?!#)\s*([a-z][\w-]*)\s*:\s*(.+)$/i.exec(line);
  if (!m) return false;
  st.data.directives[m[1].toLowerCase()] = m[2].trim();
  return true;
}

/** Handle `## Heading` group starts. Returns true when the line was consumed. */
function takeGroup(line: string, st: ParseState): boolean {
  const m = /^##\s+(.+)$/.exec(line);
  if (!m) return false;
  st.group = { heading: m[1].trim(), items: [] };
  st.data.groups.push(st.group);
  return true;
}

/** Handle `| a | b |` table rows. Returns true when the line was consumed. */
function takeTableRow(line: string, st: ParseState): boolean {
  if (!line.startsWith('|')) return false;
  if (!isTableRule(line)) st.tableRows.push(tableCells(line));
  return true;
}

/** Handle `> quote` and its `— attribution`. Returns true when the line was consumed. */
function takeQuote(line: string, st: ParseState): boolean {
  const q = /^>\s?(.*)$/.exec(line);
  if (q) { st.quoteLines.push(q[1].trim()); return true; }
  const attr = /^(?:—|--|–)\s*(.+)$/.exec(line);
  if (attr && st.quoteLines.length) {
    st.data.quote = { text: st.quoteLines.join(' ').trim(), attribution: attr[1].trim() };
    st.quoteLines = [];
    return true;
  }
  return false;
}

/** Handle `label :: value` pairs. Returns true when the line was consumed. */
function takePair(line: string, st: ParseState): boolean {
  const i = line.indexOf('::');
  if (i < 0) return false;
  const label = line.slice(0, i).trim();
  const value = line.slice(i + 2).trim();
  if (!label) return false;
  st.data.pairs.push({ label, value });
  return true;
}

/** Handle `Label: 42` numeric series points. Returns true when the line was consumed. */
function takeSeriesPoint(line: string, st: ParseState): boolean {
  const m = /^(.{1,60}?)\s*:\s*(.+)$/.exec(line);
  if (!m) return false;
  const n = parseMetric(m[2]);
  if (n === null) return false;
  st.data.series.push({ label: m[1].trim(), value: n, display: m[2].trim() });
  return true;
}

/**
 * @description Parse a slide body into structured content.
 *
 * The micro-syntax is additive — a body of plain lines still parses to plain bullets, which
 * is what keeps every existing caller working. Everything else is opt-in:
 *
 * ```
 * #layout: kpi-grid        directive — force a layout, set an image/subtitle
 * ## Build                 group heading (two-column / comparison / quadrant)
 * | Feature | Us | Them |  markdown table row
 * > It changed everything  pull quote
 * — Jane Roe, CFO          quote attribution
 * 94% :: uptime            label :: value pair (kpi / timeline / process)
 * Q3: 240                  numeric point (charts)
 * plain text               bullet
 * ```
 *
 * @param content - the authored slide body.
 * @returns structured content; never throws, and never returns null fields.
 */
export function parseSlideContent(content?: string): SlideData {
  const st: ParseState = { data: emptyData(), group: null, quoteLines: [], tableRows: [] };
  const lines = String(content ?? '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (takeDirective(line, st)) continue;
    if (takeGroup(line, st)) continue;
    if (takeTableRow(line, st)) continue;
    if (takeQuote(line, st)) continue;

    // Inside a `## group`, everything else is that group's item — a pair or metric there is
    // column copy, not deck-level data.
    if (st.group) { st.group.items.push(line.replace(/^[-*•]\s*/, '')); continue; }

    const clean = line.replace(/^[-*•]\s*/, '');
    if (takePair(clean, st)) continue;
    if (takeSeriesPoint(clean, st)) continue;
    st.data.bullets.push(clean);
  }

  // A quote with no attribution line still stands on its own.
  if (st.quoteLines.length) st.data.quote = { text: st.quoteLines.join(' ').trim() };

  if (st.tableRows.length >= 2) {
    st.data.table = { head: st.tableRows[0], rows: st.tableRows.slice(1) };
  } else if (st.tableRows.length === 1) {
    st.data.bullets.push(st.tableRows[0].join(' · '));
  }

  const img = st.data.directives.image;
  if (img) st.data.image = img;
  return st.data;
}

/**
 * @description True when a slide carries nothing a layout could render — the composer uses
 * this to fall back to a statement/section treatment rather than emitting an empty body box.
 * @param d - parsed slide data.
 * @returns true when there is no renderable content.
 */
export function isEmptyData(d: SlideData): boolean {
  return !d.bullets.length && !d.groups.length && !d.pairs.length
    && !d.series.length && !d.table && !d.quote && !d.image;
}
