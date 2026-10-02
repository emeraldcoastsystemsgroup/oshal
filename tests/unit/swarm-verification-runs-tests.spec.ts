/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for verification running a ticket's tests (swarm-verification-service.ts, workspace-test-run.ts). Drives the real SwarmVerificationService under signing over a real temp workspace with a real deliverable and a recording runner port: a green run passes with its counts in the findings; a red run fails the child with regression to build and names the failing tests; a run that could not happen (no toolchain, unreachable node, a runner that throws) fails as not run; documentation work never calls the runner; without a runner wired the structural result stands as before. The parser is driven with vitest's own summary and failure lines. The node-side runner is guarded by its own spec; the live proof is a review ticket on the box.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SwarmVerificationService } from '../../src/features/swarm-orchestration/services/swarm-verification-service';
import { parseTestOutput, workspaceTestVerdict, type WorkspaceTestRun, type WorkspaceTestRunRequest } from '../../src/features/swarm-orchestration/services/workspace-test-run';

const TICKET_ID = '55555555-6666-4777-8888-999999999999';
const EXECUTOR = 'a0000000-0000-0000-0000-000000000002';

let workspaceRoot: string;
let savedRoot: string | undefined;

const item = { externalId: TICKET_ID, provider: 'direct', title: 'Build the slugify module', body: 'Lower-case and hyphenate.', labels: [] } as never;
const codeUnits = [{
  unitId: `${TICKET_ID}-unit-1`, title: 'Build the slugify module', description: 'Write deliverables/src/slugify.ts.',
  acceptanceCriteria: ['slugify("Hello World") is "hello-world"'], labels: [], workType: 'implementation', parentUnitId: null, depth: 0,
}] as never;
const docsUnits = [{
  unitId: `${TICKET_ID}-unit-1`, title: 'Write the README', description: 'Document the module.',
  acceptanceCriteria: ['README names the export'], labels: [], workType: 'documentation', parentUnitId: null, depth: 0,
}] as never;
const output = { agentId: EXECUTOR, content: 'Built deliverables/src/slugify.ts and its vitest suite; both files are in the workspace.' };

function run(overrides: Partial<WorkspaceTestRun>): WorkspaceTestRun {
  return { ran: true, command: 'npm test', exitCode: 0, passed: 10, failed: 0, failedTests: [], outputTail: 'Tests  10 passed (10)', durationMs: 900, ...overrides };
}

function writeDeliverable(file = 'slugify.ts'): void {
  mkdirSync(join(workspaceRoot, TICKET_ID, 'deliverables', 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, TICKET_ID, 'deliverables', 'src', file), "export function slugify(text: string): string {\n  return text.toLowerCase().trim().split(/\\s+/).join('-');\n}\n");
}

function service(runner?: (request: WorkspaceTestRunRequest) => Promise<WorkspaceTestRun>) {
  return new SwarmVerificationService({ isDelegationEnforced: () => true, runWorkspaceTests: runner });
}

beforeEach(() => {
  savedRoot = process.env.OSHAL_WORKSPACE_ROOT;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'verification-runs-tests-'));
  process.env.OSHAL_WORKSPACE_ROOT = workspaceRoot;
  mkdirSync(join(workspaceRoot, TICKET_ID, 'deliverables', 'docs'), { recursive: true });
  writeFileSync(join(workspaceRoot, TICKET_ID, 'deliverables', 'docs', 'README.md'), '# slugify\n\nExports slugify(text): lower-cases and hyphenates. Usage and three examples follow below.\n');
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.OSHAL_WORKSPACE_ROOT; else process.env.OSHAL_WORKSPACE_ROOT = savedRoot;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('verification runs the tests of code work', () => {
  it('a green run passes and its counts are findings', async () => {
    writeDeliverable();
    const requests: WorkspaceTestRunRequest[] = [];
    const result = await service(async (request) => { requests.push(request); return run({ passed: 10 }); }).verify(item, codeUnits, EXECUTOR, output, TICKET_ID);
    expect(result.status).toBe('passed');
    expect(result.findings).toEqual(expect.arrayContaining(['structural-checks-passed', 'tests-executed:npm test', 'tests-passed:10', 'tests-failed:0']));
    expect(requests).toEqual([{ ticketId: TICKET_ID, workspaceTaskId: TICKET_ID, agentId: EXECUTOR }]);
  });

  it('a red run fails the child with regression to build and names the failing tests', async () => {
    writeDeliverable();
    const result = await service(async () => run({ exitCode: 1, passed: 11, failed: 1, failedTests: ['deliverables/tests/slugify.test.ts > slugify > handles underscores'] })).verify(item, codeUnits, EXECUTOR, output, TICKET_ID);
    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings).toEqual(expect.arrayContaining(['tests-failed:1', 'failing-test:deliverables/tests/slugify.test.ts > slugify > handles underscores', 'tests-exit-code:1']));
    expect(result.summary).toContain('1 failing test(s)');
  });

  it('a run that could not happen fails as not run, naming why', async () => {
    writeDeliverable();
    const result = await service(async () => run({ ran: false, command: null, exitCode: null, passed: 0, failed: 0, reason: 'no-toolchain: npm install exited 1' })).verify(item, codeUnits, EXECUTOR, output, TICKET_ID);
    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings).toContain('tests-not-run:no-toolchain: npm install exited 1');
  });

  it('a runner that throws fails the child as unreachable, never as passed', async () => {
    writeDeliverable();
    const result = await service(async () => { throw new Error('node refused the token'); }).verify(item, codeUnits, EXECUTOR, output, TICKET_ID);
    expect(result.status).toBe('failed');
    expect(result.findings).toContain('tests-not-run:runner-unreachable: node refused the token');
  });

  it('documentation work never calls the runner', async () => {
    let calls = 0;
    const result = await service(async () => { calls += 1; return run({}); }).verify(item, docsUnits, EXECUTOR, { agentId: EXECUTOR, content: 'Wrote deliverables/docs/README.md with usage, the export and three worked examples.' }, TICKET_ID);
    expect(calls).toBe(0);
    expect(result.status).toBe('passed');
    expect(result.findings.some((f) => f.startsWith('tests-'))).toBe(false);
  });

  it('without a runner wired the structural result stands, as before', async () => {
    writeDeliverable();
    const result = await service(undefined).verify(item, codeUnits, EXECUTOR, output, TICKET_ID);
    expect(result.status).toBe('passed');
    expect(result.findings.some((f) => f.startsWith('tests-'))).toBe(false);
  });

  it('a structural failure is returned before any run', async () => {
    let calls = 0;
    const result = await service(async () => { calls += 1; return run({}); }).verify(item, codeUnits, EXECUTOR, output, TICKET_ID);
    expect(result.status).toBe('failed');
    expect(calls).toBe(0);
  });
});

describe('the runner output parser', () => {
  it('reads vitest counts and failing names', () => {
    const parsed = parseTestOutput([
      ' ❯ deliverables/tests/slugify.test.ts (5 tests | 1 failed) 12ms',
      '   × slugify > handles strings already containing hyphens or underscores 3ms',
      ' ✓ deliverables/src/slugify.test.ts (5 tests) 8ms',
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      ' FAIL  deliverables/tests/slugify.test.ts > slugify > handles strings already containing hyphens or underscores',
      'AssertionError: expected ... // Object.is equality',
      ' Test Files  1 failed | 1 passed (2)',
      '      Tests  1 failed | 11 passed (12)',
    ].join('\n'));
    expect(parsed).toEqual({ passed: 11, failed: 1, summaryParsed: true, failedTests: ['deliverables/tests/slugify.test.ts > slugify > handles strings already containing hyphens or underscores'] });
  });

  it('reads a coloured summary and failure line', () => {
    const coloured = '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m deliverables/src/slugify.test.ts\u001b[2m > \u001b[22mslugify\u001b[2m > \u001b[22mhyphenates\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m\u001b[90m (2)\u001b[39m\n';
    expect(parseTestOutput(coloured)).toEqual({ passed: 1, failed: 1, summaryParsed: true, failedTests: ['deliverables/src/slugify.test.ts > slugify > hyphenates'] });
  });

  it('reads an all-green summary', () => {
    expect(parseTestOutput(' Test Files  2 passed (2)\n      Tests  10 passed (10)\n')).toEqual({ passed: 10, failed: 0, failedTests: [], summaryParsed: true });
  });

  it('a run without a summary leaves the exit code as the verdict', () => {
    expect(parseTestOutput('npm ERR! missing script: test').summaryParsed).toBe(false);
    const verdict = workspaceTestVerdict(run({ exitCode: 2, passed: 0, failed: 0, outputTail: 'boom' }));
    expect(verdict.status).toBe('failed');
    expect(verdict.findings).toContain('tests-exit-code:2');
  });
});
