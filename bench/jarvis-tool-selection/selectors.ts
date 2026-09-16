/**
 * The baseline view of what Jarvis actually sends, and the candidate selectors raced against it.
 *
 * THE BASELINE IS THE REAL THING, READ-ONLY. `buildBaseline` calls the exported
 * `buildToolsBlock` and `detectProviderBoundHandoff` from src/ — the same functions the /ask route
 * calls — so every byte counted here is a byte the route would really have sent, off the real
 * jarvis-tools.yaml and the real mounted scripts directory. Nothing in this file is imported by
 * core, and core imports nothing from here: the candidates live ENTIRELY in the harness, so racing
 * them costs zero core delta and cannot change production behaviour.
 *
 * The two candidate families fail in OPPOSITE directions and are reported separately:
 *   - a TOOL CUT drops a tool the model needed, so it is judged on recall;
 *   - a WIDENED FAST LANE fires the wrong deterministic handler with the model bypassed entirely,
 *     so it is judged on false matches — and that failure is worse than the status quo.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - read-only baseline over the real selector plus harness-local tool-cut and fast-lane candidates.
 *
 * @module bench/jarvis-tool-selection/selectors
 */

import { buildToolsBlock } from '../../src/app/routes/jarvis-tool-catalog';
import { detectProviderBoundHandoff } from '../../src/app/routes/jarvis-provider-intent-detect';
import type { CorpusItem } from './corpus';

/** One advertised tool, as the real block emitted it. */
export interface ToolLine {
  script: string;
  keywords: string[];
  line: string;
}

/** What the real /ask path would have done with this message, parsed but not altered. */
export interface Baseline {
  block: string;
  header: string[];
  tools: ToolLine[];
  trailer: string[];
  intent: string | null;
}

/** What a candidate would have done instead. */
export interface Selection {
  block: string;
  tools: string[];
  intent: string | null;
}

/** A named candidate. `select` sees the real baseline and may only narrow or bypass it. */
export interface Candidate {
  name: string;
  family: 'baseline' | 'tool-cut' | 'fast-lane';
  describe: string;
  select(baseline: Baseline, item: CorpusItem): Selection;
}

const TOOL_LINE = /-> node \/app\/scripts\/(oshal-[a-z0-9-]+\.js) \| Keywords: ([\s\S]*?)\. Use when: /;

/**
 * @description Build the read-only baseline for one corpus item from the real selector.
 * @param item - The graded message (and surface, when the corpus records one).
 * @returns The real block, split into header / advertised tools / trailer, plus the real
 * deterministic intent the current fast lane produces for this message.
 */
export function buildBaseline(item: CorpusItem): Baseline {
  const block = buildToolsBlock({ message: item.message, surface: item.surface });
  const header: string[] = [];
  const tools: ToolLine[] = [];
  const trailer: string[] = [];
  for (const line of block.split('\n')) {
    const match = line.match(TOOL_LINE);
    if (match) { tools.push({ script: match[1], keywords: match[2].split(',').map((word) => word.trim()).filter(Boolean), line }); continue; }
    (tools.length ? trailer : header).push(line);
  }
  return { block, header, tools, trailer, intent: detectProviderBoundHandoff(item.message)?.kind ?? null };
}

/** Rebuild a block from the baseline's own lines, keeping the header and trailer intact. */
function rebuild(baseline: Baseline, kept: ToolLine[]): Selection {
  return {
    block: [...baseline.header, ...kept.map((tool) => tool.line), ...baseline.trailer].join('\n'),
    tools: kept.map((tool) => tool.script),
    intent: baseline.intent,
  };
}

/** How many of a tool's advertised keywords the message contains — the real selector's own score. */
function score(tool: ToolLine, item: CorpusItem): number {
  const input = `${item.message ?? ''} ${item.surface ?? ''}`.toLowerCase();
  return tool.keywords.filter((word) => input.includes(word.toLowerCase())).length;
}

/** Keep the first `k` tools of the real ranking; the rest never reach the model. */
function topK(k: number): Candidate {
  return {
    name: `top-${k}`,
    family: 'tool-cut',
    describe: `keep the ${k} highest-ranked tools of the real ordering, drop the rest`,
    select: (baseline) => rebuild(baseline, baseline.tools.slice(0, k)),
  };
}

/** Keep every tool that scores, topped up to a floor so a zero-score turn is not left toolless. */
function scoredWithFloor(floor: number): Candidate {
  return {
    name: `scored-floor-${floor}`,
    family: 'tool-cut',
    describe: `keep every tool with at least one keyword hit, topped up to ${floor} by the real ranking`,
    select: (baseline, item) => {
      const hits = baseline.tools.filter((tool) => score(tool, item) > 0);
      const rest = baseline.tools.filter((tool) => !hits.includes(tool));
      return rebuild(baseline, [...hits, ...rest].slice(0, Math.max(floor, hits.length)));
    },
  };
}

/**
 * A deliberately widened fast lane: any message mentioning a calendar is answered deterministically.
 * It exists to exercise the precision axis — the corpus records `What is on my calendar tomorrow?`
 * as model-owned, so this candidate must be reported as a false match, never as a saving.
 */
const WIDENED_CALENDAR_FAST_LANE: Candidate = {
  name: 'fast-lane-calendar',
  family: 'fast-lane',
  describe: 'widen the deterministic shortcut to any message mentioning a calendar',
  select: (baseline, item) => (/\bcalendar\b/i.test(item.message)
    ? { block: '', tools: [], intent: 'calendar' }
    : rebuild(baseline, baseline.tools)),
};

/** The unchanged control: exactly what the /ask route sends today. */
export const BASELINE_CANDIDATE: Candidate = {
  name: 'baseline',
  family: 'baseline',
  describe: 'the shipped selector, unchanged - every accessible mounted tool, really ranked',
  select: (baseline) => rebuild(baseline, baseline.tools),
};

/**
 * @description The candidates raced against the baseline.
 * @returns One entry per candidate selector, all implemented here rather than in core.
 */
export function candidates(): Candidate[] {
  return [BASELINE_CANDIDATE, topK(3), topK(6), scoredWithFloor(3), WIDENED_CALENDAR_FAST_LANE];
}
