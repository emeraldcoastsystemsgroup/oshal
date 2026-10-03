#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | New. The measurement half of BACKLOG "The nightly gate runs against a saturated box", as a check instead of a reading: one SCHEDULED run must complete with no `cannot allocate memory` in its full log, no RESOURCE-EXHAUSTED gate, and every gate within an order of magnitude of the same gate in a baseline run on an idle box. It reads the logs ci-local.sh already writes (the summary ci-local.log and the per-run full.log, found by the run's own start line, so no clock arithmetic is involved) and exits non-zero naming each clause that is not met.
 *
 * Usage:
 *   node scripts/ci/ci-run-durations.mjs --baseline <start time of an idle-box run> [--run <start time>]
 *        [--log <ci-local.log>] [--runs <ci-runs dir>] [--ratio 10]
 * Start times are the bracketed timestamp of a run's `=== LOCAL CI start` line, e.g. 2026-09-29T23:30:03.
 * --run defaults to the latest scheduled run. Exit 0 = every clause met, 1 = a clause not met, 2 = usage.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START_LINE = /^\[([^\]]+)\] === LOCAL CI start \(scheduled=(\d)/;
const GATE_LINE = /^\[[^\]]+\] GATE (\S+): (PASS|FAIL|RESOURCE-EXHAUSTED) \((\d+)s[;)]/;
const OUTCOME_LINE = /^\[[^\]]+\] === LOCAL CI: (ALL GATES GREEN|(?:FAILED|RESOURCE-EXHAUSTED) gates:.*?) ===$/;
const STARVED_WORDS = /cannot allocate memory/i;

/**
 * @description Split the summary log into runs, each from its start line to the next.
 * @param {string} text - contents of ci-local.log.
 * @returns {Array<{ start: string, scheduled: boolean, startLine: string, gates: Map<string, { result: string, seconds: number }>, outcome: string | null }>} runs, oldest first.
 */
export function parseRuns(text) {
  const runs = [];
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const start = START_LINE.exec(line);
    if (start) {
      current = { start: start[1], scheduled: start[2] === '1', startLine: line, gates: new Map(), outcome: null };
      runs.push(current);
      continue;
    }
    if (!current) continue;
    const gate = GATE_LINE.exec(line);
    if (gate) current.gates.set(gate[1], { result: gate[2], seconds: Number(gate[3]) });
    const outcome = OUTCOME_LINE.exec(line);
    if (outcome && current.outcome === null) current.outcome = outcome[1];
  }
  return runs;
}

/**
 * @description Compare every gate both runs timed. A gate is out of bounds when it took more than
 * `ratio` times its baseline duration (baseline floored at one second, so a 0 s gate is not a divide).
 * @param {ReturnType<typeof parseRuns>[number]} run - the run under test.
 * @param {ReturnType<typeof parseRuns>[number]} baseline - the idle-box run.
 * @param {number} ratio - the order-of-magnitude bound.
 * @returns {{ rows: Array<{ gate: string, baseline: number, run: number, ratio: number, within: boolean }>, unmatched: string[] }} the comparison.
 */
export function compareDurations(run, baseline, ratio) {
  const rows = [];
  const unmatched = [];
  for (const [gate, timing] of run.gates) {
    const base = baseline.gates.get(gate);
    if (!base) { unmatched.push(gate); continue; }
    const factor = timing.seconds / Math.max(base.seconds, 1);
    rows.push({ gate, baseline: base.seconds, run: timing.seconds, ratio: Number(factor.toFixed(1)), within: factor <= ratio });
  }
  return { rows, unmatched };
}

/**
 * @description Find the full output of one run: the per-run full.log that contains its start line.
 * @param {string} runsDir - the ci-runs directory beside ci-local.log.
 * @param {string} startLine - the run's exact start line.
 * @returns {string | null} the path, or null when no kept log carries it.
 */
export function findFullLog(runsDir, startLine) {
  if (!existsSync(runsDir)) return null;
  for (const entry of readdirSync(runsDir)) {
    const candidate = join(runsDir, entry, 'full.log');
    if (existsSync(candidate) && readFileSync(candidate, 'utf8').includes(startLine)) return candidate;
  }
  return null;
}

/**
 * @description Judge one run against a baseline on every clause of the done-when.
 * @param {{ logText: string, runsDir: string, baselineStart: string, runStart?: string, ratio: number }} input - what to judge.
 * @returns {{ ok: boolean, findings: string[], report: string[] }} the verdict, each unmet clause, and a table.
 */
export function judgeRun({ logText, runsDir, baselineStart, runStart, ratio }) {
  const runs = parseRuns(logText);
  const baseline = runs.find((r) => r.start === baselineStart);
  const run = runStart ? runs.find((r) => r.start === runStart) : [...runs].reverse().find((r) => r.scheduled);
  const findings = [];
  if (!baseline) return { ok: false, findings: [`no run started at ${baselineStart} in the log (baseline)`], report: [] };
  if (!run) return { ok: false, findings: [`no ${runStart ? `run started at ${runStart}` : 'scheduled run'} in the log`], report: [] };
  if (!run.scheduled) findings.push(`run ${run.start} is not a scheduled run`);
  if (run.outcome === null) findings.push(`run ${run.start} never wrote an outcome line (did not complete)`);
  if (run.outcome?.includes('RESOURCE-EXHAUSTED')) findings.push(`run ${run.start} has resource-exhausted gates: ${run.outcome}`);
  const full = findFullLog(runsDir, run.startLine);
  if (!full) findings.push(`no kept full log carries run ${run.start}; cannot check for "cannot allocate memory"`);
  else {
    const hits = readFileSync(full, 'utf8').split(/\r?\n/).map((line, i) => ({ line, n: i + 1 })).filter((x) => STARVED_WORDS.test(x.line));
    if (hits.length) findings.push(`${hits.length} "cannot allocate memory" line(s) in ${full}, first at line(s) ${hits.slice(0, 3).map((h) => h.n).join(', ')}`);
  }
  const { rows, unmatched } = compareDurations(run, baseline, ratio);
  for (const row of rows.filter((r) => !r.within)) findings.push(`${row.gate} took ${row.run}s against ${row.baseline}s on the baseline (x${row.ratio} > x${ratio})`);
  const report = [`run ${run.start} (scheduled=${run.scheduled ? 1 : 0}) against baseline ${baseline.start}; bound x${ratio}`,
    ...rows.map((r) => `  ${r.within ? 'ok  ' : 'SLOW'} ${r.gate.padEnd(26)} ${String(r.baseline).padStart(6)}s -> ${String(r.run).padStart(6)}s  x${r.ratio}`),
    ...(unmatched.length ? [`  not in the baseline, not compared: ${unmatched.join(' ')}`] : [])];
  return { ok: findings.length === 0, findings, report };
}

/**
 * @description CLI entry: parse flags, judge, print, and exit with the verdict.
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {number} the exit code.
 */
export function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i]] = argv[i + 1];
  const stateDir = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '.', 'AppData', 'Local'), 'oshal');
  const logPath = flags['--log'] ?? join(stateDir, 'ci-local.log');
  if (!flags['--baseline'] || !existsSync(logPath)) {
    process.stderr.write(`usage: ci-run-durations.mjs --baseline <run start time> [--run <start>] [--log <ci-local.log>] [--runs <dir>] [--ratio 10]\n(log: ${logPath})\n`);
    return 2;
  }
  const verdict = judgeRun({
    logText: readFileSync(logPath, 'utf8'), runsDir: flags['--runs'] ?? join(resolve(logPath, '..'), 'ci-runs'),
    baselineStart: flags['--baseline'], runStart: flags['--run'], ratio: Number(flags['--ratio'] ?? 10),
  });
  process.stdout.write(`${[...verdict.report, verdict.ok ? 'MET: every clause of the done-when holds for this run' : 'NOT MET:', ...verdict.findings.map((f) => `  - ${f}`)].join('\n')}\n`);
  return verdict.ok ? 0 : 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
