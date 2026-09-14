/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the truncated-run verdict: a loud but passing suite keeps its pass, a loud failing suite still fails, and a run whose evidence the capture bound destroyed is published indeterminate rather than as either.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createOutputWindow, OUTPUT_CAPTURE_BYTES } from '@/features/swarm-apps/services/package-test-sandbox-process';
import type { PackageTestSandboxResult } from '@/features/swarm-apps/services/package-test-sandbox';
import { PackageTestSandbox } from '@/features/swarm-apps/services/package-test-sandbox';
import {
  OUTPUT_TRUNCATED_INDETERMINATE, packageTestOutcome, reportedTestCounts,
} from '@/features/swarm-apps/services/package-test-execution';

/** @description One sandbox outcome fixture; only the fields a verdict is allowed to read are set. */
const outcome = (over: Partial<PackageTestSandboxResult>): PackageTestSandboxResult => ({
  exitCode: 0, output: '', timedOut: false, cancelled: false, image: 'sha256:test', cleanupVerified: true,
  truncated: false, ...over,
});

const NODE_SUMMARY = '1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

describe('the bounded capture window', () => {
  it('keeps the same total budget but spends part of it on the end of the stream', () => {
    const window = createOutputWindow();
    window.add(Buffer.from('HEAD-MARKER\n'));
    for (let i = 0; i < 2000; i++) window.add(Buffer.from('x'.repeat(100) + '\n'));
    window.add(Buffer.from(NODE_SUMMARY));
    const text = window.text();
    expect(window.truncated()).toBe(true);
    expect(window.emitted()).toBeGreaterThan(OUTPUT_CAPTURE_BYTES);
    // The bound is not raised: what is kept still fits the budget plus the one line naming the gap.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(OUTPUT_CAPTURE_BYTES + 256);
    expect(text).toContain('HEAD-MARKER');
    expect(text).toContain('bytes of package test output omitted');
    expect(text).toContain('# pass 2');
    expect(reportedTestCounts(text, true)).toEqual({ tests: 2, pass: 2, fail: 0 });
  });

  it('reports nothing dropped and splices no gap line into a stream that fits', () => {
    const window = createOutputWindow();
    window.add(Buffer.from('ok 1 - only\n1..1\n'));
    expect(window.truncated()).toBe(false);
    expect(window.text()).toBe('ok 1 - only\n1..1\n');
  });
});

describe('the verdict of a truncated run', () => {
  it('publishes a pass when the run exited green and its own summary survived', () => {
    expect(packageTestOutcome(outcome({ truncated: true, output: `noise\n${NODE_SUMMARY}` })))
      .toEqual({ status: 'passed' });
  });

  it('REFUSAL: a truncated run that genuinely failed still fails', () => {
    expect(packageTestOutcome(outcome({ truncated: true, exitCode: 1, output: 'noise\nnot ok 1 - broken\n1..1\n' })))
      .toEqual({ status: 'failed', error: 'Package test assertions failed.' });
    // Even a zero exit cannot launder a reported failure.
    expect(packageTestOutcome(outcome({ truncated: true, output: '1..2\n# tests 2\n# pass 1\n# fail 1\n' })).status).toBe('failed');
  });

  it('REFUSAL: a truncated run with no recoverable summary is indeterminate, never a pass', () => {
    const verdict = packageTestOutcome(outcome({ truncated: true, output: 'x'.repeat(400) }));
    expect(verdict.status).toBe('pending');
    expect(verdict.error).toContain(OUTPUT_TRUNCATED_INDETERMINATE);
  });

  it('REFUSAL: a truncated run missing planned points is indeterminate, not a pass and not a failure', () => {
    const output = '1..400\n' + Array.from({ length: 12 }, (_, i) => `ok ${i + 1} - kept`).join('\n') + '\n';
    const verdict = packageTestOutcome(outcome({ truncated: true, output }));
    expect(verdict.status).toBe('pending');
    expect(verdict.error).toContain('388 of 400 planned test points were not captured.');
    expect(reportedTestCounts(output, true)).toEqual({ tests: 400, pass: 12, fail: 0, unknown: 388 });
  });
});

describe('the untruncated verdict is unchanged', () => {
  it('still fails a whole stream that lost points, and still refuses a suite that asserted nothing', () => {
    expect(reportedTestCounts('1..4\nok 1 - a\n')).toEqual({ tests: 4, pass: 1, fail: 3 });
    expect(packageTestOutcome(outcome({ output: '1..4\nok 1 - a\n' })).status).toBe('failed');
    expect(packageTestOutcome(outcome({ output: '' })))
      .toEqual({ status: 'failed', error: 'The runner reported no test summary; the suite exited before completing.' });
    expect(packageTestOutcome(outcome({ output: '1..0\n# tests 0\n# pass 0\n# fail 0\n' })).status).toBe('failed');
  });
});

/** The Docker VM, not the host, is what a sandbox container competes for; a saturated VM declines rather than lies. */
const dockerReady = (): string | null => {
  try {
    const load = Number(execFileSync('docker', ['exec', 'oshal-local-redis', 'cut', '-d', ' ', '-f1', '/proc/loadavg'],
      { encoding: 'utf8', timeout: 15000 }).trim());
    if (!Number.isFinite(load) || load > 6) return null;
    execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', 'oshal-bot:latest'], { encoding: 'utf8', timeout: 20000 });
    return 'oshal-bot:latest';
  } catch { return null; }
};

/** @description Build a suite that prints far past the capture bound before reaching its assertions. */
const loudSuite = (assertion: string): string =>
  `const {test}=require('node:test'),assert=require('node:assert/strict');\n`
  + `test('loud',()=>{ for(let i=0;i<2400;i++) console.log('x'.repeat(100)); ${assertion} });\n`
  + `test('second',()=>assert.equal(1,1));\n`;

/** @description Drive one real suite through the real container, capture window and verdict. */
const runLoud = async (assertion: string) => {
  const image = dockerReady();
  if (!image) return null;
  const result = await new PackageTestSandbox().run({
    files: [{ path: 'tests/loud.test.cjs', content: Buffer.from(loudSuite(assertion)) }],
    suiteFiles: ['tests/loud.test.cjs'], image, timeoutMs: 180000, maxMemoryMb: 512, executionId: randomUUID(),
  });
  return { result, verdict: packageTestOutcome(result) };
};

describe('a real over-threshold run through the real capture path', () => {
  it('keeps the pass of a suite that printed past the bound and exited green', async () => {
    const run = await runLoud('assert.equal(2+2,4);');
    if (!run) { console.warn('DECLINED: Docker VM unavailable or above load 6 - this is not a pass.'); return; }
    const { result, verdict } = run;
    expect(result.truncated, result.output.slice(-400)).toBe(true);
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(OUTPUT_CAPTURE_BYTES + 256);
    expect(result.exitCode, result.output.slice(-400)).toBe(0);
    expect(reportedTestCounts(result.output, result.truncated)).toMatchObject({ pass: 2, fail: 0 });
    expect(verdict, result.output.slice(-400)).toEqual({ status: 'passed' });
  }, 300000);

  it('REFUSAL: still fails a suite that printed past the bound and then asserted wrongly', async () => {
    const run = await runLoud('assert.equal(2+2,5);');
    if (!run) { console.warn('DECLINED: Docker VM unavailable or above load 6 - this is not a pass.'); return; }
    const { result, verdict } = run;
    expect(result.truncated).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(verdict.status, result.output.slice(-400)).toBe('failed');
  }, 300000);
});
