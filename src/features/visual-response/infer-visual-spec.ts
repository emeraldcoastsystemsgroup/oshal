/**
 * Deterministic, fact-locked DEFAULT visual picker.
 *
 * Most answers never carry an explicit `visualSpec`, so they used to land as text only. This module
 * infers a *shape* from a FINISHED answer — a markdown table becomes `table`, checked/status lines
 * become `checklist`, label:number lines become `chart`, structured metrics/bullets become `summary`
 * — so a fitting visual materializes without asking an LLM and without any new cost.
 *
 * Two rules make this safe:
 *  1. FACT-LOCKED: every string placed in the spec is a substring already present in the answer. This
 *     re-arranges words; it never adds, reinterprets, or computes a fact.
 *  2. CONSERVATIVE: absence of structure returns null. Ordinary conversational replies stay
 *     text/orb-only, preserving the deliberate "not every answer is a popup" behaviour.
 *
 * The inferred spec is re-validated through the same schema as any model-authored one, so it can
 * never bypass the renderer's bounds.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial deterministic default
 *            | visual picker (table / checklist / chart / summary) for answers with no visualSpec.
 * ---------------------------------------------------------------------------
 * @module infer-visual-spec
 */

import type { VisualResponseSpec } from './types';
import { parseVisualResponseSpec } from './visual-response-schema';

/** Inputs for the default picker. `answer` is authoritative; nothing else may add facts. */
export interface InferVisualSpecInput {
  answer: string;
  request?: string;
  title?: string;
  /** Optional provenance id; becomes `sourceRefs` when supplied. */
  sourceRef?: string;
}

const STATUS_WORDS: Record<string, 'done' | 'todo' | 'in-progress' | 'blocked'> = {
  done: 'done', complete: 'done', completed: 'done', finished: 'done',
  todo: 'todo', pending: 'todo', 'not started': 'todo',
  'in progress': 'in-progress', 'in-progress': 'in-progress', started: 'in-progress', wip: 'in-progress',
  blocked: 'blocked', stuck: 'blocked', failed: 'blocked',
};

/**
 * @description Infer a fitting visual spec from a finished answer, or null to stay text-only.
 * @param input - The finished answer plus optional request/title/source for framing.
 * @returns A schema-valid spec built only from words already present in the answer, or null.
 */
export function inferVisualSpec(input: InferVisualSpecInput): VisualResponseSpec | null {
  const answer = String(input.answer || '').trim();
  if (!answer) return null;
  const lines = answer.split('\n').map((line) => line.trim());
  const title = buildTitle(input, lines);
  const sourceRefs = input.sourceRef ? [String(input.sourceRef)] : [];
  const candidate = inferTable(lines, title, sourceRefs)
    || inferChecklist(lines, title, sourceRefs)
    || inferChart(lines, title, sourceRefs)
    || inferSummary(lines, title, sourceRefs);
  // An inferred spec is untrusted like any other: it must survive the real schema or become null.
  return candidate ? parseVisualResponseSpec(candidate) : null;
}

/** Title comes from the caller, else the request, else the answer's first prose line. */
function buildTitle(input: InferVisualSpecInput, lines: string[]): string {
  const explicit = clean(input.title);
  if (explicit) return cap(explicit, 120);
  const request = clean(input.request);
  if (request) return cap(request.replace(/[?.!]+$/, ''), 120);
  const prose = lines.find((line) => line && !isStructural(line));
  return cap(clean(prose) || 'Answer', 120);
}

function isStructural(line: string): boolean {
  return /^\|/.test(line) || /^[-*]\s/.test(line) || /^\d+[.)]\s/.test(line);
}

// ── table ────────────────────────────────────────────────────────────────────
/** A real markdown table: a header row, a |---| separator, then data rows. */
function inferTable(lines: string[], title: string, sourceRefs: string[]): VisualResponseSpec | null {
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!isPipeRow(lines[i]) || !isSeparator(lines[i + 1])) continue;
    const columns = splitPipes(lines[i]);
    if (columns.length < 2 || columns.length > 6) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && isPipeRow(lines[j]); j += 1) {
      const cells = splitPipes(lines[j]);
      if (cells.length !== columns.length) break;
      rows.push(cells.map((cell) => cap(cell, 240)));
      if (rows.length >= 8) break;
    }
    if (!rows.length) continue;
    return { schemaVersion: 1, kind: 'table', title, sourceRefs, columns: columns.map((c) => cap(c, 80)), rows } as VisualResponseSpec;
  }
  return null;
}

const isPipeRow = (line: string): boolean => /^\|.*\|$/.test(line);
const isSeparator = (line: string): boolean => /^\|[\s:|-]+\|$/.test(line) && line.includes('-');
const splitPipes = (line: string): string[] =>
  line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());

// ── checklist ────────────────────────────────────────────────────────────────
/** Checkbox lines, or list lines whose trailing words name a status. */
function inferChecklist(lines: string[], title: string, sourceRefs: string[]): VisualResponseSpec | null {
  const items: Array<{ label: string; status: 'done' | 'todo' | 'in-progress' | 'blocked' }> = [];
  for (const line of lines) {
    const box = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (box) {
      items.push({ label: cap(box[2], 120), status: box[1].toLowerCase() === 'x' ? 'done' : 'todo' });
      continue;
    }
    const listed = line.match(/^(?:[-*]|\d+[.)])\s+(.*\S)\s*[—–\-:(]\s*([A-Za-z][A-Za-z\s-]{1,14})\)?$/);
    if (!listed) continue;
    const status = STATUS_WORDS[listed[2].trim().toLowerCase()];
    if (status) items.push({ label: cap(listed[1], 120), status });
  }
  if (items.length < 2) return null;
  return { schemaVersion: 1, kind: 'checklist', title, sourceRefs, items: items.slice(0, 8) } as VisualResponseSpec;
}

// ── chart ────────────────────────────────────────────────────────────────────
/** Three or more `Label: <number>` lines — a single comparable series. */
function inferChart(lines: string[], title: string, sourceRefs: string[]): VisualResponseSpec | null {
  const points: Array<{ label: string; value: number; unit: string }> = [];
  for (const line of lines) {
    const match = line.replace(/^(?:[-*]|\d+[.)])\s+/, '')
      .match(/^([^:]{1,60}?)\s*[:=]\s*\$?(-?[\d,]+(?:\.\d+)?)\s*([%A-Za-z$/]{0,12})\s*$/);
    if (!match) continue;
    const value = Number(match[2].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    points.push({ label: cap(match[1], 60), value, unit: match[3].trim().slice(0, 12) });
  }
  if (points.length < 3 || points.length > 12) return null;
  const unit = points.find((point) => point.unit)?.unit || '';
  return {
    schemaVersion: 1, kind: 'chart', title, sourceRefs, chartType: 'bar',
    categories: points.map((point) => point.label),
    series: [{ name: 'Value', values: points.map((point) => point.value), ...(unit ? { unit } : {}) }],
  } as VisualResponseSpec;
}

// ── summary ──────────────────────────────────────────────────────────────────
/** Structured metrics and/or bullets. The floor: needs real structure, never plain prose. */
function inferSummary(lines: string[], title: string, sourceRefs: string[]): VisualResponseSpec | null {
  const metrics: Array<{ label: string; value: string }> = [];
  const bullets: string[] = [];
  for (const line of lines) {
    const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      const inner = bullet[1];
      const pair = inner.match(/^([^:]{1,40}?)\s*:\s*(.{1,80})$/);
      if (pair && metrics.length < 4) metrics.push({ label: cap(pair[1], 60), value: cap(pair[2], 80) });
      else bullets.push(cap(inner, 240));
      continue;
    }
    const pair = line.match(/^([^:]{1,40}?)\s*:\s*(.{1,80})$/);
    // A BARE "Label: value" line is ambiguous with ordinary prose ("Note: remember to call him"),
    // so it only counts as a metric when the value is data-like. Bullet-prefixed pairs above are
    // explicit structure and need no such guard.
    if (pair && /\d/.test(pair[2]) && metrics.length < 4) {
      metrics.push({ label: cap(pair[1], 60), value: cap(pair[2], 80) });
    }
  }
  const trimmedBullets = bullets.slice(0, 6);
  // Prose with no structure stays text-only; that absence is deliberate.
  if (metrics.length < 2 && trimmedBullets.length < 3) return null;
  return {
    schemaVersion: 1, kind: 'summary', title, sourceRefs,
    ...(metrics.length ? { metrics } : {}),
    ...(trimmedBullets.length ? { bullets: trimmedBullets } : {}),
  } as VisualResponseSpec;
}

function clean(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cap(value: string, maximum: number): string {
  const text = clean(value);
  return text.length > maximum ? text.slice(0, maximum - 1).trimEnd() : text;
}
