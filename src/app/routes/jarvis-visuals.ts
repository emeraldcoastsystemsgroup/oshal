/**
 * Jarvis visual-spec builders + trusted provider-record summarization.
 *
 * Extracted from jarvis-routes.ts (2026-07-18, ADR-050 route decomposition). Two cohesive concerns:
 *  1. Server-owned visual-spec selection — turning a finalized answer (delayed completion, a plain
 *     Markdown table, a workspace image gallery, or an explicit "draw me a timeline/diagram") into a
 *     fact-locked VisualResponseSpec. Everything here copies text already present in the authoritative
 *     answer; nothing asks a model to invent visual fields.
 *  2. Trusted provider-record handling — accepting provider facts ONLY from the structured
 *     manifest-worker bot-node completion channel and rendering their deterministic text companion.
 * Behaviour unchanged from the in-file originals.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: visual-spec builders (outcome/table/gallery/direct-request) + trusted provider-record parsing & summarization (route decomposition, no behaviour change).
 *
 * @module jarvis-visuals
 */

import fs from 'node:fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { taskSubdirs } from '@/shared/workspace-task-dirs';
import {
  parseVisualResponseProviderRecord,
  parseVisualResponseSpec,
  type VisualResponseProviderRecord,
  type VisualResponseSpec,
} from '@/features/visual-response';
import { parseTrustedProviderIntent } from '../bot-node-provider-intent';
import type { JarvisDirectives } from './jarvis-directives';

/**
 * @description Selects a model-authored visual while reporting completed delayed work. Ordinary
 * direct conversational turns remain orb/text-only; the separately gated timeline/diagram path may
 * materialize only when the original user turn explicitly requests that exact structural visual.
 * A delayed response that also contains a handoff is still an acknowledgement and remains ineligible.
 */
export function visualSpecForOutcome(
  directives: JarvisDirectives,
  outcome: 'direct' | 'delayed-complete',
): VisualResponseSpec | undefined {
  if (outcome === 'direct') return undefined;
  return !directives.hadHandoffFence && directives.handoffs.length === 0 ? directives.visualSpec : undefined;
}

/** Explicit delayed-only wrapper used by the completed-task summarizer. */
export function visualSpecForDelayedCompletion(directives: JarvisDirectives): VisualResponseSpec | undefined {
  return visualSpecForOutcome(directives, 'delayed-complete');
}

type CompletedMarkdownTableVisualSpec = Extract<VisualResponseSpec, { kind: 'table' }>;
type CompletedMarkdownGalleryVisualSpec = Extract<VisualResponseSpec, { kind: 'gallery' }>;

interface CompletedWorkspaceGallery {
  visualSpec: CompletedMarkdownGalleryVisualSpec;
  localImages: Array<{ sourceRef: string; path: string }>;
  sources: Array<{ type: 'artifact'; id: string; label: string }>;
}

/**
 * Turns a worker-authored Markdown image gallery into a trusted visual input. The Markdown file
 * itself must be linked by the completed result and live in this ticket's deliverables folder;
 * image bytes are independently realpath-checked and transcoded by TrustedImageReceiptService.
 */
export async function workspaceGalleryFromCompletedResult(
  result: string,
  title: string,
  ticketId: string,
  ticketSourceRef: string,
): Promise<CompletedWorkspaceGallery | undefined> {
  const dirs = taskSubdirs(resolveSharedWorkspaceRoot(), ticketId, 'deliverables');
  if (!dirs.length) return undefined;
  const linkedMarkdown = [...String(result).matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/gi)]
    .map((match) => path.basename(match[1].replace(/\\/g, '/')));

  for (const dir of dirs) {
    // A worker can return an "open folder" link even though it wrote a valid gallery Markdown file.
    // Search that ticket-owned deliverables directory deterministically after trying explicit links.
    let discoveredMarkdown: string[] = [];
    try {
      discoveredMarkdown = (await fs.readdir(dir))
        .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i.test(entry))
        .sort((a, b) => a.localeCompare(b));
    } catch { /* unreadable deliverables directory */ }
    const candidates = [...new Set([...linkedMarkdown, ...discoveredMarkdown])];
    for (const fileName of candidates) {
      const markdownPath = path.join(dir, fileName);
      let markdown: string;
      try { markdown = await fs.readFile(markdownPath, 'utf8'); } catch { continue; }
      const matches = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].slice(0, 4);
      const items: CompletedMarkdownGalleryVisualSpec['items'] = [];
      const localImages: CompletedWorkspaceGallery['localImages'] = [];
      const sources: CompletedWorkspaceGallery['sources'] = [];
      for (const match of matches) {
        const relative = match[2].trim().replace(/^<|>$/g, '');
        if (!relative || path.isAbsolute(relative) || /^https?:/i.test(relative)) continue;
        const imagePath = path.resolve(dir, relative);
        if (imagePath !== path.resolve(dir) && !imagePath.startsWith(`${path.resolve(dir)}${path.sep}`)) continue;
        const sourceRef = `workspace-image:${crypto.createHash('sha256').update(`${ticketId}:${relative}`).digest('hex').slice(0, 24)}`;
        const itemTitle = (match[1].trim() || path.basename(relative, path.extname(relative))).slice(0, 180);
        items.push({ sourceRef, title: itemTitle, currency: 'USD' });
        localImages.push({ sourceRef, path: imagePath });
        sources.push({ type: 'artifact', id: sourceRef, label: itemTitle });
      }
      if (!items.length) continue;
      const visualSpec = parseVisualResponseSpec({
        schemaVersion: 1,
        kind: 'gallery',
        title: String(title).replace(/\s+/g, ' ').trim().slice(0, 120),
        sourceRefs: [ticketSourceRef, ...items.map((item) => item.sourceRef)],
        items,
        caption: 'Images prepared from the completed ticket',
      });
      if (visualSpec?.kind === 'gallery') return { visualSpec, localImages, sources };
    }
  }
  return undefined;
}

const MARKDOWN_TABLE_DIVIDER = /^:?-{3,}:?$/;
const MARKDOWN_TABLE_INLINE_MARKUP = /(?:<[^>]*>|!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)|`|\*\*|__|~~|\\\|)/;
const MARKDOWN_TABLE_EXACT_HTTPS_LINK = /^\[([^\]\r\n]{1,120})\]\((https:\/\/[^\s()]{1,500})\)$/i;

/** Copy the visible label from one exact safe HTTPS link; reject every other inline construct. */
function completedMarkdownTableCellText(cell: string): string | undefined {
  const value = cell.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const exactCode = value.match(/^`([^`\r\n]{1,240})`$/);
  if (exactCode) return exactCode[1].trim() || undefined;
  const exactEmphasis = value.match(/^(?:\*\*|__)([^\r\n]{1,240})(?:\*\*|__)$/);
  if (exactEmphasis && !MARKDOWN_TABLE_INLINE_MARKUP.test(exactEmphasis[1])) {
    return exactEmphasis[1].trim() || undefined;
  }
  const exactLink = value.match(MARKDOWN_TABLE_EXACT_HTTPS_LINK);
  if (exactLink) {
    const label = exactLink[1].trim();
    if (!label || MARKDOWN_TABLE_INLINE_MARKUP.test(label)) return undefined;
    try {
      const url = new URL(exactLink[2]);
      if (url.protocol !== 'https:' || url.username || url.password) return undefined;
      return label;
    } catch {
      return undefined;
    }
  }
  return MARKDOWN_TABLE_INLINE_MARKUP.test(value) ? undefined : value;
}

/** Parse one pipe-bounded Markdown row without interpreting inline markup or escaped delimiters. */
function completedMarkdownTableCells(line: string): string[] | undefined {
  const row = line.trim();
  if (!row.startsWith('|') || !row.endsWith('|')) return undefined;
  const cells = row.slice(1, -1).split('|').map(completedMarkdownTableCellText);
  return cells.some((cell) => cell === undefined) ? undefined : cells as string[];
}

/**
 * @description Converts exactly one small, plain Markdown table in a finalized delayed result into
 * the existing fact-locked table visual contract. This is a server-owned presentation fallback: it
 * copies only text already present in the authoritative result, refuses partial/truncated tables,
 * and cites the exact completed ticket rather than asking a model to invent visual fields.
 */
export function visualSpecFromCompletedMarkdownTable(
  markdown: string,
  title: string,
  ticketSourceRef: string,
): CompletedMarkdownTableVisualSpec | undefined {
  const boundedTitle = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const sourceRef = String(ticketSourceRef || '');
  if (!boundedTitle || sourceRef !== sourceRef.trim() || !sourceRef || sourceRef.length > 180) return undefined;

  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const tables: Array<{ columns: string[]; rows: string[][] }> = [];
  let fenceMarker: '```' | '~~~' | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index].trim().match(/^(```|~~~)/)?.[1] as '```' | '~~~' | undefined;
    if (fence) {
      if (!fenceMarker) fenceMarker = fence;
      else if (fenceMarker === fence) fenceMarker = undefined;
      continue;
    }
    if (fenceMarker || index + 2 >= lines.length) continue;

    const columns = completedMarkdownTableCells(lines[index]);
    const dividers = completedMarkdownTableCells(lines[index + 1]);
    if (
      !columns
      || !dividers
      || columns.length < 2
      || columns.length > 6
      || dividers.length !== columns.length
      || columns.some((column) => column.length > 80)
      || !dividers.every((divider) => MARKDOWN_TABLE_DIVIDER.test(divider))
    ) continue;

    const rows: string[][] = [];
    let cursor = index + 2;
    let invalid = false;
    while (cursor < lines.length) {
      const rawRow = lines[cursor].trim();
      if (!rawRow.startsWith('|') || !rawRow.endsWith('|')) break;
      const row = completedMarkdownTableCells(lines[cursor]);
      if (!row || row.length !== columns.length || row.some((cell) => cell.length > 240)) invalid = true;
      if (row) rows.push(row);
      cursor += 1;
    }
    if (!invalid && rows.length >= 1) tables.push({ columns, rows });
    index = Math.max(index, cursor - 1);
  }

  if (!tables.length) return undefined;
  // The first table in the authoritative answer is deterministic. Keep the visual bounded while
  // stating exactly when the full inline result contains additional rows or tables.
  const selected = tables[0];
  const omittedRows = Math.max(0, selected.rows.length - 8);
  const caption = omittedRows || tables.length > 1
    ? `Showing the first table${omittedRows ? ` (first 8 of ${selected.rows.length} rows)` : ''}; full result remains below`
    : undefined;
  const candidate = parseVisualResponseSpec({
    schemaVersion: 1,
    kind: 'table',
    title: boundedTitle,
    sourceRefs: [sourceRef],
    columns: selected.columns,
    rows: selected.rows.slice(0, 8),
    ...(caption ? { caption } : {}),
  });
  return candidate?.kind === 'table' ? candidate : undefined;
}

type DirectStructuralVisualSpec = Extract<VisualResponseSpec, { kind: 'timeline' | 'diagram' }>;
type DirectStructuralVisualKind = DirectStructuralVisualSpec['kind'];

const DIRECT_VISUAL_NEGATION = /\b(?:do not|don't|dont|never|no need to|without)\b[\s\S]{0,36}\b(?:draw|render|visuali[sz]e|diagram|flowchart|timeline|map out)\b/i;
const DIRECT_VISUAL_CAPABILITY_QUESTION = /\b(?:can|could|would|do|does|are|is)\s+(?:you|jarvis|the\s+assistant|this\s+assistant|it)\b[\s\S]{0,42}\b(?:draw|render|visuali[sz]e|make|create|diagram|flowchart|timeline)\b/i;
const DIRECT_VISUAL_PRODUCT_WORK = /\b(?:build|change|debug|fix|implement|style|test|update)\b[\s\S]{0,55}\b(?:diagram|flowchart|timeline)\b[\s\S]{0,35}\b(?:api|app|code|component|css|feature|html|renderer|widget)\b/i;
const DIRECT_TIMELINE_INTENT = /(?:\b(?:create|draw|give|make|present|render|show)\b[\s\S]{0,70}\b(?:timeline|chronology)\b|\b(?:as|into)\s+(?:an?\s+)?(?:timeline|chronology)\b)/i;
const DIRECT_DIAGRAM_INTENT = /(?:\b(?:create|draw|give|make|present|render|show|visuali[sz]e)\b[\s\S]{0,70}\b(?:diagram|flowchart|hierarchy|relationship map)\b|\bmap\s+out\b|\b(?:as|into)\s+(?:an?\s+)?(?:diagram|flowchart|hierarchy)\b)/i;

/** Remove quoted/code examples before intent matching so a user discussing an instruction does not
 * accidentally activate the visual plane. The original request remains unchanged everywhere else. */
function directVisualIntentText(request: string): string {
  return String(request || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministically recognizes one explicit structural presentation request. */
export function detectExplicitDirectVisualKind(request: string): DirectStructuralVisualKind | undefined {
  const text = directVisualIntentText(request);
  if (!text || DIRECT_VISUAL_NEGATION.test(text) || DIRECT_VISUAL_CAPABILITY_QUESTION.test(text) || DIRECT_VISUAL_PRODUCT_WORK.test(text)) {
    return undefined;
  }
  const kinds: DirectStructuralVisualKind[] = [];
  if (DIRECT_TIMELINE_INTENT.test(text)) kinds.push('timeline');
  if (DIRECT_DIAGRAM_INTENT.test(text)) kinds.push('diagram');
  return kinds.length === 1 ? kinds[0] : undefined;
}

function normalizeDirectVisualFact(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function directStructuralVisualMatchesAnswer(spec: DirectStructuralVisualSpec, answer: string): boolean {
  const normalizedAnswer = normalizeDirectVisualFact(answer);
  if (!normalizedAnswer) return false;
  const common = [spec.title, spec.asOf, spec.caption].filter((value): value is string => Boolean(value));
  if (common.some((value) => !normalizedAnswer.includes(normalizeDirectVisualFact(value)))) return false;
  if (spec.kind === 'timeline') {
    return spec.items.every((item) => [item.label, item.title, item.detail]
      .filter((value): value is string => Boolean(value))
      .every((value) => normalizedAnswer.includes(normalizeDirectVisualFact(value))));
  }
  const nodes = new Map(spec.nodes.map((node) => [node.id, node]));
  const nodesMatch = spec.nodes.every((node) => [node.label, node.detail]
    .filter((value): value is string => Boolean(value))
    .every((value) => normalizedAnswer.includes(normalizeDirectVisualFact(value))));
  if (!nodesMatch) return false;
  return spec.edges.every((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return false;
    const relationship = normalizeDirectVisualFact(`${from.label} ${edge.label} ${to.label}`);
    return Boolean(relationship) && normalizedAnswer.includes(relationship);
  });
}

/**
 * Server-owned exception to the delayed-only rule: a direct answer may become a deterministic
 * timeline/diagram only when the user explicitly requested that exact kind, no handoff was attempted,
 * the model supplied no source claims, and every displayed fact is already in the authoritative text.
 */
export function visualSpecForDirectRequest(
  directives: JarvisDirectives,
  originalRequest: string,
  answerSourceRef: string,
): DirectStructuralVisualSpec | undefined {
  const requestedKind = detectExplicitDirectVisualKind(originalRequest);
  const candidate = directives.visualSpec;
  if (
    !requestedKind
    || directives.hadHandoffFence
    || directives.handoffs.length
    || !candidate
    || (candidate.kind !== 'timeline' && candidate.kind !== 'diagram')
    || candidate.kind !== requestedKind
    || candidate.sourceRefs.length !== 0
    || !directStructuralVisualMatchesAnswer(candidate, directives.cleanAnswer)
  ) return undefined;
  return { ...candidate, sourceRefs: [answerSourceRef] };
}

// ── Trusted provider records ─────────────────────────────────────────────────

/** Accept provider records only from the structured manifest-worker bot-node completion channel. */
export function trustedProviderRecordsFromJarvisWorkMessage(message: {
  metadata?: Record<string, unknown>;
} | undefined): VisualResponseProviderRecord[] {
  const metadata = message?.metadata;
  if (metadata?.source !== 'manifest-worker-bot-node' || metadata.manifestWorkerResult !== true) return [];
  const raw = Array.isArray(metadata.providerRecords) ? metadata.providerRecords.slice(0, 8) : [];
  const records = raw.map(parseVisualResponseProviderRecord).filter((record): record is VisualResponseProviderRecord => record !== null);
  return [...new Map(records.map((record) => [record.sourceRef, record])).values()];
}

/**
 * Automatic provider summaries and visuals require the matching server-authored intent persisted by
 * the controller. A command-captured record can still inform the ordinary work-product summarizer,
 * but it cannot replace a mixed/action result or cause a provider-only stage on its own.
 */
export function providerRecordsMatchingTrustedIntent(message: {
  metadata?: Record<string, unknown>;
} | undefined): VisualResponseProviderRecord[] {
  const records = trustedProviderRecordsFromJarvisWorkMessage(message);
  const intent = parseTrustedProviderIntent(message?.metadata?.providerIntent);
  if (!intent) return [];
  return records.filter((record) => (
    (intent.kind === 'weather' && record.kind === 'nws-weather')
    || (intent.kind === 'priority-email' && record.kind === 'gmail-summary')
    || (intent.kind === 'walmart-catalog' && record.kind === 'walmart-catalog')
  ));
}

/**
 * Produce the authoritative text companion for a trusted provider visual without asking a model
 * to restate facts. Every included value has already passed the provider-record schema.
 */
export function summarizeProviderBoundRecords(
  records: VisualResponseProviderRecord[] | undefined,
): string | undefined {
  const weather = records?.find((record) => record.kind === 'nws-weather');
  if (weather?.kind === 'nws-weather') {
    const current = weather.record.current;
    const details = [
      current.humidityPercent !== undefined ? `Humidity ${current.humidityPercent}%` : undefined,
      current.precipitationPercent !== undefined
        ? `precipitation chance ${current.precipitationPercent}%` : undefined,
      current.windSpeedMph !== undefined
        ? `wind ${current.windDirection ? `${current.windDirection} ` : ''}${current.windSpeedMph} mph`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    const next = weather.record.periods.slice(0, 2)
      .map((period) => `${period.label}: ${period.tempF}°F, ${period.condition}`)
      .join('; ');
    return [
      `In ${weather.record.location}, it is ${current.tempF}°F (${current.tempC}°C) with ${current.condition}.`,
      details.length ? `${details.join(', ')}.` : '',
      next ? `Next: ${next}.` : '',
      `Source: National Weather Service, updated ${current.validFrom || weather.record.timestamp}.`,
    ].filter(Boolean).join(' ');
  }

  const gmail = records?.find((record) => record.kind === 'gmail-summary');
  if (gmail?.kind === 'gmail-summary') {
    const priority = gmail.messages.filter((message) => message.important || message.starred);
    if (!priority.length) {
      return `I checked ${gmail.mailbox}. In the latest 24-hour, 25-message snapshot, Gmail did not flag any messages as important or starred.`;
    }
    const preview = priority.slice(0, 3)
      .map((message) => `“${message.subject}” from ${message.sender}`)
      .join('; ');
    return `I checked ${gmail.mailbox}. Gmail flagged ${priority.length} priority ${priority.length === 1 ? 'message' : 'messages'} in the latest snapshot: ${preview}.`;
  }

  const walmart = records?.find((record) => record.kind === 'walmart-catalog');
  if (walmart?.kind === 'walmart-catalog') {
    const items = walmart.items.slice(0, 6);
    const rows = items.map((item) => {
      const title = markdownTableCell(item.title);
      const price = item.price === undefined ? 'Unavailable' : `$${item.price.toFixed(2)}`;
      return `| [${title}](${markdownLinkTarget(item.productUrl)}) | ${price} |`;
    });
    return [
      `I found ${items.length} live Walmart ${items.length === 1 ? 'result' : 'results'} for “${markdownTableCell(walmart.query)}.” This was a read-only search; nothing was added to a cart or ordered.`,
      '',
      '| Product | Current price |',
      '|---|---:|',
      ...rows,
      '',
      `Source: Walmart catalog, retrieved ${markdownTableCell(walmart.retrievedAt)}.`,
    ].join('\n');
  }
  return undefined;
}

function markdownTableCell(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    // Jarvis's deliberately small Markdown parser does not understand backslash-escaped table
    // delimiters or nested brackets. Use inert visible equivalents so provider text cannot split a
    // row or terminate its generated link label.
    .replace(/\\/g, '＼')
    .replace(/\|/g, '¦')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')');
}

function markdownLinkTarget(value: string): string {
  return String(value || '').replace(/[|()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
