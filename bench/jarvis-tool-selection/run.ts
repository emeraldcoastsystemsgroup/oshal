/**
 * Entrypoint: race the candidate selectors against the shipped one and print what was measured.
 *
 *   npx tsx bench/jarvis-tool-selection/run.ts [--json] [--corpus <file.jsonl>]
 *
 * Exit status is 1 only when the run itself could not happen (a missing recorded corpus, a broken
 * baseline). A rejected candidate is a RESULT, not a harness failure, so the run still exits 0 and
 * the table says `reject` — a red exit for an honest measurement is how a gate trains people to
 * ignore red.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - CLI that prints the per-candidate table and writes results/latest.json.
 *
 * @module bench/jarvis-tool-selection/run
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadCorpus } from './corpus';
import { candidates } from './selectors';
import { resolveTokenizer, report, type BenchReport, type CandidateReport } from './measure';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const corpusFlag = args.indexOf('--corpus');
const corpusPath = corpusFlag >= 0 ? args[corpusFlag + 1] : undefined;

/** A measured number, or the em dash that means "this did not run" — never a filled-in zero. */
function cell(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toFixed(digits);
}

function row(candidate: CandidateReport): string {
  if (candidate.status === 'not-run') return `${candidate.name.padEnd(20)} not-run  ${candidate.reason ?? ''}`;
  const recall = candidate.recall === null ? '—' : `${(candidate.recall * 100).toFixed(0)}%`;
  return [
    candidate.name.padEnd(20),
    recall.padStart(7),
    cell(candidate.falseMatches).padStart(7),
    cell(candidate.missedIntents).padStart(7),
    cell(candidate.inputBytesDelta).padStart(11),
    cell(candidate.inputTokensDelta).padStart(12),
    cell(candidate.regressions).padStart(6),
    candidate.gate.padStart(6),
    candidate.verdict.padStart(8),
  ].join(' ');
}

function print(result: BenchReport): void {
  const mix = Object.entries(result.corpus.provenance).filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`).join(', ');
  console.log(`\ncorpus: ${result.corpus.items} items (${mix})`);
  console.log(`tokens: ${result.tokenizer.status}${result.tokenizer.module ? ` via ${result.tokenizer.module}` : ''}${result.tokenizer.reason ? ` — ${result.tokenizer.reason}` : ''}\n`);
  console.log([
    'candidate'.padEnd(20), 'recall'.padStart(7), 'false'.padStart(7), 'missed'.padStart(7),
    'Δbytes'.padStart(11), 'Δtokens'.padStart(12), 'regr'.padStart(6), 'gate'.padStart(6), 'verdict'.padStart(8),
  ].join(' '));
  for (const candidate of result.candidates) console.log(row(candidate));
  const rejected = result.candidates.filter((candidate) => candidate.gate === 'fail');
  for (const candidate of rejected) console.log(`\n${candidate.name} regressed on: ${candidate.regressedItems.join(', ')}`);
  console.log('\nregressions == 0 is the gate. A candidate that saves on average and regresses once is rejected.\n');
}

async function main(): Promise<void> {
  const { tokenizer, status } = await resolveTokenizer();
  let result: BenchReport;
  try {
    result = report(loadCorpus(corpusPath), candidates(), tokenizer, status);
  } catch (error) {
    console.error(`bench not-run: ${(error as Error).message}`);
    process.exit(1);
    return;
  }
  if (asJson) console.log(JSON.stringify(result, null, 2)); else print(result);
  const out = resolve(__dirname, 'results/latest.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (!asJson) console.log(`wrote ${out}`);
}

void main();
