/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The workspace test run: the contract between verification and the node that executes a ticket's tests (request, result), the parser that turns a test runner's output into counts and failing names, and the findings a run contributes to a verification result. A build ticket on 2026-10-02 reached customer_action with one failing test in its deliverables because verification under signing was structural: files existed, so it passed. Now a run's exit code decides, the counts are evidence, and a run that could not happen is a failure that names why.
 */

/** The work types whose deliverables are code and therefore must carry executed, green tests. */
export const TESTED_WORK_TYPES: ReadonlySet<string> = new Set(['implementation', 'testing']);

/** How many failing test names a result carries; the rest are counted, not listed. */
export const MAX_FAILING_TEST_NAMES = 10;

/** @description What verification asks the node to run. */
export interface WorkspaceTestRunRequest {
  /** The child ticket whose deliverables are tested. */
  ticketId: string;
  /** The root ticket's folder, shared by every child of the tree. */
  workspaceTaskId: string;
  /** The bot that produced the deliverables; its node runs the tests. */
  agentId: string;
}

/** @description What one test run reports back. `ran` false means no test process produced a verdict. */
export interface WorkspaceTestRun {
  ran: boolean;
  /** The command that ran, when one did. */
  command: string | null;
  exitCode: number | null;
  passed: number;
  failed: number;
  /** Failing test names, at most MAX_FAILING_TEST_NAMES. */
  failedTests: string[];
  /** Why no run happened (`no-tests-declared`, `no-toolchain: …`, `runner-unreachable: …`, `timeout`). */
  reason?: string;
  /** The last part of the runner's output, for the handover. */
  outputTail: string;
  durationMs: number;
}

/** @description Runs a ticket's tests where its deliverables live and reports the result. */
export type WorkspaceTestRunner = (request: WorkspaceTestRunRequest) => Promise<WorkspaceTestRun>;

/** @description What a run contributes to a verification result. */
export interface WorkspaceTestVerdict {
  status: 'passed' | 'failed';
  summary: string;
  findings: string[];
}

/** @description Counts and failing names read from a runner's output. */
export interface ParsedTestOutput {
  passed: number;
  failed: number;
  failedTests: string[];
  /** False when no summary line was found; the exit code is then the only verdict. */
  summaryParsed: boolean;
}

/** Terminal colour and cursor sequences a runner may print even when piped. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const SUMMARY_LINE = /^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/m;
const SUMMARY_PART = /(\d+)\s+(passed|failed|skipped|todo)/g;
/** vitest's file-qualified failure lines (`FAIL  file > suite > name`); the canonical names. */
const FAIL_LINE = /^\s*FAIL\s+(.+?)\s*$/gm;
/** Per-test marks (`× name 3ms`, jest's `✕ name`), used only when no FAIL line names the test. */
const MARK_LINE = /^\s*(?:×|✗|✕)\s+(.+?)\s*$/gm;
const TRAILING_DURATION = /\s+(?:\[\s*)?[\d.]+\s*m?s(?:\s*\])?\s*$/;

/**
 * @description Reads counts and failing test names from vitest-style output (the scaffold's runner);
 * a runner that prints no `Tests N passed` summary leaves the exit code as the only verdict.
 * @param output - The runner's stdout and stderr.
 * @returns Counts, failing names and whether a summary was found.
 */
export function parseTestOutput(rawOutput: string): ParsedTestOutput {
  const output = rawOutput.replace(ANSI, '');
  const summary = SUMMARY_LINE.exec(output);
  const counts = { passed: 0, failed: 0 };
  if (summary) {
    for (const part of (summary[1] as string).matchAll(SUMMARY_PART)) {
      if (part[2] === 'passed') counts.passed = Number(part[1]);
      if (part[2] === 'failed') counts.failed = Number(part[1]);
    }
  }
  const failedTests = collectNames(output, FAIL_LINE);
  return { ...counts, failedTests: failedTests.length ? failedTests : collectNames(output, MARK_LINE), summaryParsed: summary != null };
}

/**
 * @description The distinct test names one line pattern yields, durations stripped, capped.
 * @param output - The runner's output.
 * @param pattern - A global pattern whose first group is the name.
 * @returns At most MAX_FAILING_TEST_NAMES names; a bare file line (no ` > `) is not a test.
 */
function collectNames(output: string, pattern: RegExp): string[] {
  const names: string[] = [];
  for (const line of output.matchAll(pattern)) {
    const name = (line[1] as string).replace(TRAILING_DURATION, '').trim();
    if (name.includes(' > ') && !names.includes(name)) names.push(name);
    if (names.length >= MAX_FAILING_TEST_NAMES) break;
  }
  return names;
}

/**
 * @description The verdict a run contributes: the exit code decides, the counts are evidence, and a
 * run that did not happen fails with its reason. Findings follow the verifier's `name:value` form.
 * @param run - The run.
 * @returns Status, summary and findings.
 */
export function workspaceTestVerdict(run: WorkspaceTestRun): WorkspaceTestVerdict {
  if (!run.ran) {
    return {
      status: 'failed',
      summary: `Tests were not run: ${run.reason ?? 'unknown'}.`,
      findings: [`tests-not-run:${run.reason ?? 'unknown'}`],
    };
  }
  const findings = [`tests-executed:${run.command}`, `tests-passed:${run.passed}`, `tests-failed:${run.failed}`];
  const green = run.exitCode === 0 && run.failed === 0;
  if (green) {
    return { status: 'passed', summary: `${run.passed} test(s) passed (${run.command}).`, findings };
  }
  findings.push(...run.failedTests.map((name) => `failing-test:${name}`));
  if (run.exitCode !== 0) findings.push(`tests-exit-code:${run.exitCode}`);
  const named = run.failedTests.length ? `: ${run.failedTests.join('; ')}` : '';
  return {
    status: 'failed',
    summary: `${run.failed} failing test(s), exit ${run.exitCode} (${run.command})${named}.`,
    findings,
  };
}
