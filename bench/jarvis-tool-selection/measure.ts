/**
 * Grading: recall, false matches, real input-token delta, and the binary regressions gate.
 *
 * THE GATE IS BINARY ON PURPOSE. A candidate that saves tokens on twenty turns and drops the
 * needed tool on one is REJECTED here, because the average is not what the user experiences — the
 * one broken turn is. `regressions` counts only items the baseline answered correctly and the
 * candidate did not, so a candidate is never punished for a fault it inherited.
 *
 * NO NUMBER IS EVER INVENTED. Bytes are counted off the real emitted block. Tokens are counted
 * only by a real tokenizer the caller supplies (JARVIS_BENCH_TOKENIZER, a module exporting
 * `encode(text): unknown[]`); with no tokenizer the token axis reports `not-run` and names the
 * reason rather than falling back to a bytes-divided-by-four estimate. A candidate that throws is
 * reported `not-run` with its error, not as a zero.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - per-candidate recall / false-match / token-delta grading with a binary regressions == 0 gate and not-run in place of any estimated number.
 *
 * @module bench/jarvis-tool-selection/measure
 */

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CorpusItem, Provenance } from './corpus';
import { buildBaseline, BASELINE_CANDIDATE, type Candidate, type Selection } from './selectors';

/** Counts tokens with a real encoder; `null` means no encoder was available, never an estimate. */
export interface Tokenizer { module: string; count(text: string): number }

/** Whether the token axis ran at all, and why not when it did not. */
export interface TokenizerStatus { status: 'measured' | 'not-run'; module?: string; reason?: string }

/** Everything measured for one candidate. Every numeric field is null when `status` is not-run. */
export interface CandidateReport {
  name: string;
  family: Candidate['family'];
  describe: string;
  status: 'measured' | 'not-run';
  reason?: string;
  graded: number | null;
  toolItems: number | null;
  recall: number | null;
  falseMatches: number | null;
  missedIntents: number | null;
  inputBytes: number | null;
  inputBytesDelta: number | null;
  inputTokens: number | null;
  inputTokensDelta: number | null;
  regressions: number | null;
  improvements: number | null;
  regressedItems: string[];
  gate: 'pass' | 'fail' | 'not-run';
  verdict: 'adopt' | 'reject' | 'neutral' | 'not-run';
}

/** The whole run. `corpus.provenance` is printed so synthetic recall is never read as production. */
export interface BenchReport {
  corpus: { items: number; provenance: Record<Provenance, number> };
  tokenizer: TokenizerStatus;
  candidates: CandidateReport[];
}

/**
 * @description Resolve a real tokenizer module, or say why there is none.
 * @param spec - Module id or absolute path; defaults to JARVIS_BENCH_TOKENIZER.
 * @returns The encoder plus its status, or a not-run status carrying the reason.
 */
export async function resolveTokenizer(spec = process.env.JARVIS_BENCH_TOKENIZER): Promise<{ tokenizer?: Tokenizer; status: TokenizerStatus }> {
  if (!spec) return { status: { status: 'not-run', reason: 'no tokenizer: set JARVIS_BENCH_TOKENIZER to a module exporting encode(text)' } };
  try {
    // A filesystem path has to become a file:// URL before import() will take it on Windows.
    const target = isAbsolute(spec) ? pathToFileURL(spec).href : spec;
    const loaded = await import(target) as Record<string, unknown>;
    const inner = (loaded.default ?? {}) as Record<string, unknown>;
    const encode = (typeof loaded.encode === 'function' ? loaded.encode : inner.encode) as ((text: string) => unknown[]) | undefined;
    if (typeof encode !== 'function') return { status: { status: 'not-run', reason: `tokenizer ${spec} exports no encode(text) function` } };
    return { tokenizer: { module: spec, count: (text) => encode(text).length }, status: { status: 'measured', module: spec } };
  } catch (error) {
    return { status: { status: 'not-run', reason: `tokenizer ${spec} failed to load: ${(error as Error).message}` } };
  }
}

/** Was this the right outcome for this item? Intent ground truth outranks tool ground truth. */
function correct(item: CorpusItem, selection: Selection): boolean {
  if (item.expectedIntent) return selection.intent === item.expectedIntent;
  if (selection.intent !== null) return false;
  return item.expectedTool === null || selection.tools.includes(item.expectedTool);
}

/** One candidate's selections over the corpus, or the error that stopped it. */
function run(candidate: Candidate, baselines: Array<{ item: CorpusItem; baseline: ReturnType<typeof buildBaseline> }>): { selections?: Selection[]; reason?: string } {
  const selections: Selection[] = [];
  for (const { item, baseline } of baselines) {
    try { selections.push(candidate.select(baseline, item)); } catch (error) {
      return { reason: `candidate threw on ${item.id}: ${(error as Error).message}` };
    }
  }
  return { selections };
}

function notRun(candidate: Candidate, reason: string): CandidateReport {
  return {
    name: candidate.name, family: candidate.family, describe: candidate.describe, status: 'not-run', reason,
    graded: null, toolItems: null, recall: null, falseMatches: null, missedIntents: null,
    inputBytes: null, inputBytesDelta: null, inputTokens: null, inputTokensDelta: null,
    regressions: null, improvements: null, regressedItems: [], gate: 'not-run', verdict: 'not-run',
  };
}

/** Grade one candidate's selections against ground truth and the baseline's own outcomes. */
function grade(
  candidate: Candidate,
  items: CorpusItem[],
  selections: Selection[],
  control: { correct: boolean[]; bytes: number; tokens: number | null },
  tokenizer?: Tokenizer,
): CandidateReport {
  const hit = selections.map((selection, index) => correct(items[index], selection));
  const toolItems = items.map((item, index) => ({ item, index })).filter(({ item }) => item.expectedTool && !item.expectedIntent);
  const recalled = toolItems.filter(({ index }) => hit[index]).length;
  const falseMatches = selections.filter((selection, index) => selection.intent !== null && selection.intent !== items[index].expectedIntent).length;
  const missedIntents = items.filter((item, index) => item.expectedIntent !== null && selections[index].intent !== item.expectedIntent).length;
  const bytes = selections.reduce((total, selection) => total + Buffer.byteLength(selection.block, 'utf8'), 0);
  const tokens = tokenizer ? selections.reduce((total, selection) => total + tokenizer.count(selection.block), 0) : null;
  const regressed = items.filter((item, index) => control.correct[index] && !hit[index]).map((item) => item.id);
  const improvements = items.filter((item, index) => !control.correct[index] && hit[index]).length;
  const gate: 'pass' | 'fail' = regressed.length === 0 ? 'pass' : 'fail';
  const saves = bytes < control.bytes;
  return {
    name: candidate.name, family: candidate.family, describe: candidate.describe, status: 'measured',
    graded: items.length, toolItems: toolItems.length,
    recall: toolItems.length ? recalled / toolItems.length : null,
    falseMatches, missedIntents,
    inputBytes: bytes, inputBytesDelta: bytes - control.bytes,
    inputTokens: tokens, inputTokensDelta: tokens !== null && control.tokens !== null ? tokens - control.tokens : null,
    regressions: regressed.length, improvements, regressedItems: regressed,
    gate,
    verdict: gate === 'fail' ? 'reject' : (saves || improvements > 0) ? 'adopt' : 'neutral',
  };
}

/**
 * @description Race every candidate over the corpus against the real shipped selector.
 * @param items - The graded corpus; ground truth is the recorded outcome, never a model's guess.
 * @param list - The candidates to race. The first baseline-family entry is the control.
 * @param tokenizer - Optional real encoder; without one the token axis reports not-run.
 * @returns Per-candidate recall, false matches, byte/token deltas and the binary gate.
 */
export function measure(items: CorpusItem[], list: Candidate[], tokenizer?: Tokenizer): CandidateReport[] {
  const baselines = items.map((item) => ({ item, baseline: buildBaseline(item) }));
  const controlRun = run(BASELINE_CANDIDATE, baselines);
  if (!controlRun.selections) throw new Error(`baseline control could not run: ${controlRun.reason}`);
  const control = {
    correct: controlRun.selections.map((selection, index) => correct(items[index], selection)),
    bytes: controlRun.selections.reduce((total, selection) => total + Buffer.byteLength(selection.block, 'utf8'), 0),
    tokens: tokenizer ? controlRun.selections.reduce((total, selection) => total + tokenizer.count(selection.block), 0) : null,
  };
  return list.map((candidate) => {
    const result = run(candidate, baselines);
    return result.selections ? grade(candidate, items, result.selections, control, tokenizer) : notRun(candidate, result.reason!);
  });
}

/**
 * @description The whole report, including the corpus provenance mix and the tokenizer status.
 * @param items - The graded corpus.
 * @param list - The candidates to race.
 * @param tokenizer - Optional real encoder; without one the token axis reports not-run.
 * @param tokenizerStatus - The status to publish for that encoder.
 * @returns The report written to bench/jarvis-tool-selection/results/latest.json.
 */
export function report(items: CorpusItem[], list: Candidate[], tokenizer?: Tokenizer, tokenizerStatus?: TokenizerStatus): BenchReport {
  const provenance = { contract: 0, synthetic: 0, recorded: 0 } as Record<Provenance, number>;
  for (const item of items) provenance[item.provenance] += 1;
  return {
    corpus: { items: items.length, provenance },
    tokenizer: tokenizerStatus ?? { status: tokenizer ? 'measured' : 'not-run', module: tokenizer?.module, reason: tokenizer ? undefined : 'no tokenizer supplied' },
    candidates: measure(items, list, tokenizer),
  };
}
