/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard for scripts/ci/ci-run-durations.mjs, the automated measurement of BACKLOG "The nightly gate runs against a saturated box": a scheduled run is accepted only when it completed, carries no RESOURCE-EXHAUSTED gate, has no `cannot allocate memory` in its kept full log, and every gate is within an order of magnitude of an idle-box baseline. The fixtures are verbatim lines from %LOCALAPPDATA%\oshal\ci-local.log - the 2026-09-08 10:05 manual run the backlog entry cites as its idle reference, and the 2026-09-30 scheduled run taken with the swarm up - because the real format is the boundary a wrong parse would corrupt. One case drives the real CLI for its exit codes.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareDurations, judgeRun, parseRuns } from '../../scripts/ci/ci-run-durations.mjs';

const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-durations-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Verbatim from ci-local.log: the idle-box manual run the backlog names. */
const IDLE = [
  '[2026-09-08T10:05:19] === LOCAL CI start (scheduled=0 head=1 skip-e2e=0 skip-image=0) node-source=HEAD archive-ref=HEAD sha=c55e08aad08b posture=interactive-head ===',
  '[2026-09-08T10:06:38] GATE head-src: PASS (79s)',
  '[2026-09-08T10:14:56] GATE lint: FAIL (47s)',
  '[2026-09-08T10:15:00] GATE connectors: PASS (4s)',
  '[2026-09-08T10:15:11] GATE manifests: PASS (11s)',
  '[2026-09-08T10:36:00] GATE image-build: PASS (68s)',
  '[2026-09-08T10:46:22] === LOCAL CI: FAILED gates: unit lint secret-scan e2e-green trivy ===',
];
/** Verbatim from ci-local.log: the scheduled run of 2026-09-30, swarm up. */
const BUSY = [
  '[2026-09-30T23:30:05] === LOCAL CI start (scheduled=1 head=1 skip-e2e=0 skip-image=0) node-source=origin/main archive-ref=origin/main sha=a7cf1fc1d31f posture=scheduled-origin-main ===',
  '[2026-09-30T23:34:11] GATE head-src: PASS (246s)',
  '[2026-10-01T00:37:44] GATE lint: FAIL (871s)',
  '[2026-10-01T00:41:37] GATE connectors: PASS (232s)',
  '[2026-10-01T00:45:43] GATE manifests: PASS (246s)',
  '[2026-10-01T00:57:36] GATE image-build: PASS (20s)',
  '[2026-10-01T01:02:04] === LOCAL CI: FAILED gates: typecheck-tests store-compatibility unit lint security-policy worktree-strays argo-manifests secret-scan local-secret-hygiene unpushed-commits e2e-green trivy ===',
];
/** A scheduled run in the new format, within bounds of the idle run. */
const CALM = [
  '[2026-10-02T23:30:04] === LOCAL CI start (scheduled=1 head=1 skip-e2e=0 skip-image=0) node-source=origin/main archive-ref=origin/main sha=0123456789ab posture=scheduled-origin-main ===',
  '[2026-10-02T23:30:05] resource-check: floor 1024MB free, wait up to 120s, sample every 5s (host free now 6100MB)',
  '[2026-10-02T23:32:01] GATE head-src: PASS (116s)',
  '[2026-10-03T00:20:40] GATE lint: FAIL (60s)',
  '[2026-10-03T00:20:46] GATE connectors: PASS (6s)',
  '[2026-10-03T00:20:58] GATE manifests: PASS (12s)',
  '[2026-10-03T00:40:02] GATE image-build: PASS (80s)',
  '[2026-10-03T01:00:00] === LOCAL CI: FAILED gates: lint ===',
];

/** @description A ci-local state directory: the summary log plus one kept full log per given run. */
function stateDir(summary: string[], fullLogs: Record<string, string[]>): { log: string; runs: string } {
  const dir = mkdtempSync(join(SCRATCH, 'state-'));
  const runs = join(dir, 'ci-runs');
  for (const [name, lines] of Object.entries(fullLogs)) {
    mkdirSync(join(runs, name), { recursive: true });
    writeFileSync(join(runs, name, 'full.log'), `${lines.join('\n')}\n`);
  }
  const log = join(dir, 'ci-local.log');
  writeFileSync(log, `${summary.join('\n')}\n`);
  return { log, runs };
}

describe('the nightly saturation measurement (scripts/ci/ci-run-durations.mjs)', () => {
  it('reads runs, gate timings and outcomes from the real log format, RESOURCE-EXHAUSTED included', () => {
    const runs = parseRuns([...IDLE, ...BUSY, '[2026-10-04T23:30:00] === LOCAL CI start (scheduled=1 x) ===',
      '[2026-10-04T23:32:00] GATE head-src: RESOURCE-EXHAUSTED (120s; not started: host free 300MB stayed below the 1024MB floor for 120s)',
      '[2026-10-04T23:40:00] === LOCAL CI: RESOURCE-EXHAUSTED gates: head-src node-gates-skipped ==='].join('\n'));
    expect(runs.map((r) => [r.start, r.scheduled])).toEqual([['2026-09-08T10:05:19', false], ['2026-09-30T23:30:05', true], ['2026-10-04T23:30:00', true]]);
    expect(runs[1].gates.get('connectors')).toEqual({ result: 'PASS', seconds: 232 });
    expect(runs[2].gates.get('head-src')).toEqual({ result: 'RESOURCE-EXHAUSTED', seconds: 120 });
    expect(runs[2].outcome).toBe('RESOURCE-EXHAUSTED gates: head-src node-gates-skipped');
  });

  it('flags every gate more than an order of magnitude slower than the idle run (the real 2026-09-30 night)', () => {
    const { rows } = compareDurations(parseRuns(BUSY.join('\n'))[0], parseRuns(IDLE.join('\n'))[0], 10);
    expect(rows.filter((r) => !r.within).map((r) => r.gate)).toEqual(['lint', 'connectors', 'manifests']);
    expect(rows.find((r) => r.gate === 'connectors')).toMatchObject({ baseline: 4, run: 232, ratio: 58 });
    const { runs } = stateDir([...IDLE, ...BUSY], { '20261001T043003Z-busy': BUSY });
    const verdict = judgeRun({ logText: [...IDLE, ...BUSY].join('\n'), runsDir: runs, baselineStart: '2026-09-08T10:05:19', ratio: 10 });
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContain('connectors took 232s against 4s on the baseline (x58 > x10)');
  });

  it('accepts a completed scheduled run within bounds whose full log is free of allocation failures', () => {
    const { runs } = stateDir([...IDLE, ...CALM], { '20261003T043004Z-calm': CALM });
    const verdict = judgeRun({ logText: [...IDLE, ...CALM].join('\n'), runsDir: runs, baselineStart: '2026-09-08T10:05:19', ratio: 10 });
    expect(verdict.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('refuses a run whose kept full log says "cannot allocate memory", or that has no kept log at all', () => {
    const starved = [...CALM.slice(0, 4), 'WRN skipping file: open /scan/src/a.ts: cannot allocate memory', ...CALM.slice(4)];
    const { runs } = stateDir([...IDLE, ...CALM], { '20261003T043004Z-calm': starved });
    const verdict = judgeRun({ logText: [...IDLE, ...CALM].join('\n'), runsDir: runs, baselineStart: '2026-09-08T10:05:19', ratio: 10 });
    expect(verdict.findings.join('\n')).toMatch(/1 "cannot allocate memory" line\(s\) in .*full\.log, first at line\(s\) 5/);
    const none = judgeRun({ logText: [...IDLE, ...CALM].join('\n'), runsDir: join(SCRATCH, 'absent'), baselineStart: '2026-09-08T10:05:19', ratio: 10 });
    expect(none.findings.join('\n')).toContain('no kept full log carries run 2026-10-02T23:30:04');
  });

  it('refuses a manual run, an incomplete run, and a run with resource-exhausted gates', () => {
    const manual = judgeRun({ logText: [...IDLE, ...CALM].join('\n'), runsDir: SCRATCH, baselineStart: '2026-09-08T10:05:19', runStart: '2026-09-08T10:05:19', ratio: 10 });
    expect(manual.findings).toContain('run 2026-09-08T10:05:19 is not a scheduled run');
    const unfinished = judgeRun({ logText: [...IDLE, ...CALM.slice(0, -1)].join('\n'), runsDir: SCRATCH, baselineStart: '2026-09-08T10:05:19', ratio: 10 });
    expect(unfinished.findings).toContain('run 2026-10-02T23:30:04 never wrote an outcome line (did not complete)');
    const starvedOutcome = [...CALM.slice(0, -1), '[2026-10-03T01:00:00] === LOCAL CI: FAILED gates: lint; RESOURCE-EXHAUSTED gates: unit ==='];
    const exhausted = judgeRun({ logText: [...IDLE, ...starvedOutcome].join('\n'), runsDir: SCRATCH, baselineStart: '2026-09-08T10:05:19', ratio: 10 });
    expect(exhausted.findings.join('\n')).toContain('has resource-exhausted gates: FAILED gates: lint; RESOURCE-EXHAUSTED gates: unit');
  });

  it('answers through the real CLI with exit 0 when met, 1 when not, and 2 on bad usage', () => {
    const cli = resolve(__dirname, '../../scripts/ci/ci-run-durations.mjs');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000 });
    const calm = stateDir([...IDLE, ...CALM], { '20261003T043004Z-calm': CALM });
    expect(run('--baseline', '2026-09-08T10:05:19', '--log', calm.log).status).toBe(0);
    const busy = stateDir([...IDLE, ...BUSY], { '20261001T043003Z-busy': BUSY });
    const red = run('--baseline', '2026-09-08T10:05:19', '--log', busy.log);
    expect(red.status).toBe(1);
    expect(red.stdout).toContain('SLOW connectors');
    expect(run('--log', busy.log).status).toBe(2);
  });
});
