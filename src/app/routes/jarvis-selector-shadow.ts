/**
 * The shadow step for the Jarvis tool-block selector.
 *
 * WHY THIS EXISTS: `bench/jarvis-tool-selection` measured every narrower selector anyone proposed
 * and rejected all of them, on a 34-item corpus that is mostly hand-authored. Its own stated limit
 * is that synthetic recall is not production recall - so the verdict that matters can only come
 * from real traffic, and there is exactly one safe way to get it: compute the candidate beside the
 * shipped selector, record the difference, and send the shipped one anyway.
 *
 * That is what this module is. `buildToolsBlockWithShadow` builds the real block FIRST and returns
 * that same value on every path - the candidate's block is measured and discarded, never returned,
 * never merged, never consulted. A candidate that throws, a candidate spec that does not parse and
 * a candidate that would have dropped every tool are all the same to the caller: it gets the block
 * the route would have sent before this module existed.
 *
 * It is OFF unless `JARVIS_SELECTOR_SHADOW` names a candidate, and when it is off nothing beyond
 * the real `buildToolsBlock` call runs at all.
 *
 * NO INVENTED NUMBERS, same discipline as the harness: bytes are exact and counted off the real
 * block; a leg that cannot run records `status: 'not-run'` with the reason instead of a zero. Token
 * counts need a real tokenizer, which core does not carry, so the record measures bytes and says so
 * - the token axis stays in the harness, where `JARVIS_BENCH_TOKENIZER` supplies one.
 *
 * NO MESSAGE TEXT REACHES THE LOG. The record carries the message's LENGTH, the surface and the
 * per-turn correlation id, never the user's words.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - candidate selectors measured beside the shipped tool block and discarded, so real traffic can validate a cut the synthetic corpus rejected without production behaviour changing.
 *
 * @module app/routes/jarvis-selector-shadow
 */

import { createChildLogger } from '@/shared/logger';
import { buildToolsBlock } from './jarvis-tool-catalog';

const logger = createChildLogger({ module: 'jarvis-selector-shadow' });

/** The same tool line the harness parses, so a shadow number and a bench number are comparable. */
const TOOL_LINE = /-> node \/app\/scripts\/(oshal-[a-z0-9-]+\.js) \| Keywords: ([\s\S]*?)\. Use when: /;

/** Candidate specs are `<family>:<k>`; the families are the harness's two tool-cut shapes. */
const CANDIDATE_SPEC = /^(top-k|scored-floor):(\d{1,3})$/;

/** What `buildToolsBlock` advertised for one tool, as the real block emitted it. */
interface ToolLine {
  script: string;
  keywords: string[];
  line: string;
}

/**
 * One shadow measurement. `status: 'not-run'` means the candidate could not be computed and the
 * reason says why - it is never reported as a zero-byte saving.
 */
export interface SelectorShadowRecord {
  candidate: string;
  status: 'measured' | 'not-run';
  reason?: string;
  unit: 'bytes';
  baselineBytes: number;
  candidateBytes: number | null;
  deltaBytes: number | null;
  baselineTools: number;
  candidateTools: number | null;
  dropped: string[];
  surface: string | null;
  messageChars: number;
  correlation: string | null;
}

/** Context accepted by the shipped selector; passed straight through, never altered here. */
type ToolsBlockContext = Parameters<typeof buildToolsBlock>[0];

/** Split a real block into the tool lines it advertises, ignoring header and trailer prose. */
function parseToolLines(block: string): ToolLine[] {
  const tools: ToolLine[] = [];
  for (const line of block.split('\n')) {
    const match = line.match(TOOL_LINE);
    if (!match) continue;
    tools.push({ script: match[1], keywords: match[2].split(',').map((word) => word.trim()).filter(Boolean), line });
  }
  return tools;
}

/** How many of a tool's advertised keywords the turn's input contains - the shipped scorer's own score. */
function score(tool: ToolLine, input: string): number {
  return tool.keywords.filter((word) => input.includes(word.toLowerCase())).length;
}

/**
 * Apply the named candidate to the real block's own tool lines.
 * A candidate may only NARROW the advertised set; it never rewrites a line and never adds one.
 */
function applyCandidate(family: string, k: number, tools: ToolLine[], input: string): ToolLine[] {
  if (family === 'top-k') return tools.slice(0, k);
  const hits = tools.filter((tool) => score(tool, input) > 0);
  const rest = tools.filter((tool) => !hits.includes(tool));
  return [...hits, ...rest].slice(0, Math.max(k, hits.length));
}

/**
 * @description Measure one candidate selector against the block the route is really sending.
 * Pure: it reads the baseline block and returns the measurement, touching nothing the turn uses.
 * @param spec - The candidate name, `top-k:<k>` or `scored-floor:<k>`.
 * @param block - The real block `buildToolsBlock` just produced for this turn.
 * @param context - The same context the real selector saw; only message/surface are read.
 * @param correlation - Per-turn id so a record can be joined to what the model then did.
 * @returns The measurement, or a `not-run` record naming why the candidate could not be computed.
 */
export function measureSelectorShadow(
  spec: string,
  block: string,
  context: ToolsBlockContext = {},
  correlation: string | null = null,
): SelectorShadowRecord {
  const tools = parseToolLines(block);
  const base: SelectorShadowRecord = {
    candidate: spec,
    status: 'not-run',
    unit: 'bytes',
    baselineBytes: Buffer.byteLength(block, 'utf8'),
    candidateBytes: null,
    deltaBytes: null,
    baselineTools: tools.length,
    candidateTools: null,
    dropped: [],
    surface: context.surface ?? null,
    messageChars: (context.message ?? '').length,
    correlation,
  };
  const parsed = spec.match(CANDIDATE_SPEC);
  if (!parsed) return { ...base, reason: `unknown candidate spec "${spec}"; expected top-k:<k> or scored-floor:<k>` };
  if (!tools.length) return { ...base, reason: 'the real block advertised no tool lines, so there is nothing to cut' };

  const input = `${context.message ?? ''} ${context.surface ?? ''}`.toLowerCase();
  const kept = applyCandidate(parsed[1], Number(parsed[2]), tools, input);
  const keptLines = new Set(kept.map((tool) => tool.line));
  const candidateBlock = block.split('\n').filter((line) => !line.match(TOOL_LINE) || keptLines.has(line)).join('\n');
  const candidateBytes = Buffer.byteLength(candidateBlock, 'utf8');
  return {
    ...base,
    status: 'measured',
    candidateBytes,
    deltaBytes: candidateBytes - base.baselineBytes,
    candidateTools: kept.length,
    dropped: tools.filter((tool) => !keptLines.has(tool.line)).map((tool) => tool.script),
  };
}

/**
 * @description Build the turn's tool block, optionally measuring a candidate selector beside it.
 *
 * THE RETURN VALUE IS ALWAYS THE REAL BLOCK. The candidate is measured for the log and discarded,
 * so enabling the shadow cannot change what the model receives - which is the whole point: a cut
 * the synthetic corpus rejected gets validated against real traffic before it decides anything.
 * @param context - Passed unchanged to the shipped `buildToolsBlock`.
 * @param options - `spec` names the candidate (default: the `JARVIS_SELECTOR_SHADOW` env var; empty
 * disables the step entirely); `correlation` is the per-turn id recorded with the measurement.
 * @returns Exactly what `buildToolsBlock` returned for this context.
 */
export function buildToolsBlockWithShadow(
  context: ToolsBlockContext = {},
  options: { spec?: string; correlation?: string } = {},
): string {
  const block = buildToolsBlock(context);
  const spec = (options.spec ?? process.env.JARVIS_SELECTOR_SHADOW ?? '').trim();
  if (!spec) return block;
  try {
    const record = measureSelectorShadow(spec, block, context, options.correlation ?? null);
    if (record.status === 'measured') logger.info(record, 'jarvis: selector shadow measured a candidate; the baseline was sent');
    else logger.warn(record, 'jarvis: selector shadow not-run; the baseline was sent');
  } catch (err) {
    logger.warn({ err, candidate: spec, status: 'not-run', correlation: options.correlation ?? null },
      'jarvis: selector shadow threw; the baseline was sent');
  }
  return block;
}
