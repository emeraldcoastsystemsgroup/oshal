/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proof for scripts/api-storm-probe.sh, the gate that stops scripts/oshal-deploy.sh printing DEPLOYED over a mid-deploy api restart (BACKLOG "Deploy — the api process exits during the bot-recreate storm"). The boundary the probe reads is the Docker engine - `docker inspect` RestartCount and `docker logs --since` - so nothing there is doubled: each case runs the real script in a real Git Bash against a real disposable alpine container. One stays up (PASS), one Docker restarts inside the window (FAIL on RestartCount), one writes the termination line inside the window (FAIL on the log count), one does not exist (exit 2, never a PASS).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two cases the review found missing: a container whose LOGS cannot be read is exit 2 rather than a PASS (the count and the read were one pipeline, and `grep -c` exits 1 on zero matches, so a failed read looked exactly like a clean window), and the two failure shapes name themselves - FAIL(restarted) vs FAIL(terminated) - because the deploy text branches on that and a survived termination must not send anyone after a restart.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveHostBash } from '../helpers/deploy-verify-shell';
/**
 * Removing a Docker fixture is measured in tens of seconds on this box (20.2 s for the disposable
 * Postgres), and vitest's default hook budget is 10 s — so every case passed while the FILE exited
 * non-zero, which takes `npm run test:unit` red with it. The teardown gets its own budget.
 */
const TEARDOWN_TIMEOUT_MS = 120_000;


const PROBE = path.resolve('scripts/api-storm-probe.sh').replace(/\\/g, '/');
const BASH = resolveHostBash();
const TERMINATION_LINE = 'FATAL: terminating connection due to idle-in-transaction timeout';
const DOCKER_TIMEOUT_MS = 60_000;
const containers: string[] = [];

interface ProbeRun { status: number | null; output: string }

/**
 * @description Run one docker command and return its stdout.
 * @param args - Docker argv.
 * @returns Trimmed stdout.
 */
function docker(args: string[]): string {
  const run = spawnSync('docker', args, { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  if (run.status !== 0) throw new Error(`docker ${args[0]} failed: ${run.stderr}`);
  return (run.stdout || '').trim();
}

/**
 * @description Start a throwaway alpine container that this spec owns and removes.
 * @param command - The container's shell command.
 * @param restart - Optional Docker restart policy.
 * @returns The container name.
 */
function fixtureContainer(command: string, restart?: string): string {
  const name = `oshal-api-storm-probe-fixture-${randomUUID()}`;
  docker(['run', '--detach', '--name', name, '--label', 'oshal.test-fixture=api-storm-probe',
    '--memory', '32m', ...(restart ? ['--restart', restart] : []), 'alpine:3', 'sh', '-c', command]);
  containers.push(name);
  return name;
}

/**
 * @description Run the real probe script in a real shell.
 * @param args - The probe's argv.
 * @returns Exit status and combined output.
 */
function probe(...args: string[]): ProbeRun {
  const run = spawnSync(BASH, [PROBE, ...args], { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  return { status: run.status, output: `${run.stdout || ''}\n${run.stderr || ''}` };
}

/**
 * @description Parse the `begin` line into its two verify arguments.
 * @param line - What `begin` printed.
 * @returns The RestartCount and the RFC3339 window start.
 */
function snapshot(line: string): { restarts: string; since: string } {
  const match = /restarts=(\d+) since=(\S+)/.exec(line);
  expect(match, line).not.toBeNull();
  return { restarts: match![1], since: match![2] };
}

/**
 * @description Wait until Docker has restarted the container at least once.
 * @param name - Container name.
 * @returns Nothing; throws if it never restarts.
 */
async function waitForRestart(name: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (Number(docker(['inspect', '--format', '{{.RestartCount}}', name])) >= 1) return;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  throw new Error(`${name} never restarted`);
}

afterAll(() => {
  for (const name of containers) {
    spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  }
}, TEARDOWN_TIMEOUT_MS);

describe('scripts/api-storm-probe.sh', () => {
  it('PASS: RestartCount unchanged and no termination line inside the window', () => {
    const name = fixtureContainer('sleep 120');
    const begin = probe('begin', name);
    expect(begin.status, begin.output).toBe(0);
    const { restarts, since } = snapshot(begin.output);
    expect(restarts).toBe('0');
    const verify = probe('verify', restarts, since, name);
    expect(verify.status, verify.output).toBe(0);
    expect(verify.output).toContain('RestartCount 0 -> 0');
    expect(verify.output).toContain('PASS');
  }, 60_000);

  it('FAIL: Docker restarted the container inside the window', async () => {
    const name = fixtureContainer('sleep 1; exit 1', 'on-failure:5');
    const { restarts, since } = snapshot(probe('begin', name).output);
    await waitForRestart(name);
    const verify = probe('verify', restarts, since, name);
    expect(verify.status, verify.output).toBe(1);
    expect(verify.output).toMatch(/RestartCount 0 -> [1-9]/);
    expect(verify.output).toContain('FAIL');
  }, 60_000);

  it('FAIL: the log carries an idle-in-transaction termination inside the window', async () => {
    const name = fixtureContainer(`sleep 2; echo "${TERMINATION_LINE}"; sleep 120`);
    const { restarts, since } = snapshot(probe('begin', name).output);
    await new Promise((resolve) => { setTimeout(resolve, 4_000); });
    const verify = probe('verify', restarts, since, name);
    expect(verify.status, verify.output).toBe(1);
    expect(verify.output).toContain('RestartCount 0 -> 0');
    expect(verify.output).toMatch(/log lines since \S+: 1\b/);
    expect(verify.output).toContain('FAIL');
  }, 60_000);

  it('a container it cannot inspect is exit 2, never a PASS', () => {
    const missing = `oshal-api-storm-probe-missing-${randomUUID()}`;
    expect(probe('begin', missing).status).toBe(2);
    const verify = probe('verify', '0', '2026-01-01T00:00:00Z', missing);
    expect(verify.status).toBe(2);
    expect(verify.output).not.toContain('PASS');
    expect(probe().status).toBe(2);
  }, 60_000);

  it('a container whose LOGS it cannot read is exit 2 too, never a PASS', () => {
    // The count and the read used to be one pipeline, and `grep -c` exits 1 on zero matches -
    // so a read that FAILED was indistinguishable from a window with no terminations, and the
    // deploy went on to report that the api lived through the recreate. A log driver that
    // cannot be read is the same fact as a container that cannot be inspected.
    const dir = mkdtempSync(join(tmpdir(), 'storm-probe-stub-'));
    try {
      // `inspect` answers, `logs` fails - exactly what a non-readable logging driver does.
      writeFileSync(join(dir, 'docker'),
        '#!/usr/bin/env bash\n'
        + 'if [ "$1" = "inspect" ]; then echo 0; exit 0; fi\n'
        + 'if [ "$1" = "logs" ]; then echo "configured logging driver does not support reading" >&2; exit 1; fi\n'
        + 'exit 0\n', { mode: 0o755 });
      const run = spawnSync(BASH, [PROBE, 'verify', '0', '2026-01-01T00:00:00Z', 'stubbed'], {
        encoding: 'utf8',
        timeout: DOCKER_TIMEOUT_MS,
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
      });
      const output = `${run.stdout || ''}\n${run.stderr || ''}`;
      expect(output, 'a window nobody could read must never read as a pass').not.toContain('PASS');
      expect(run.status, 'an unreadable log window is a check that could not be taken, not a clean one').toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('names WHICH failure it saw, because a survived termination is not a restart', () => {
    // The deploy's operator-facing text branches on this: telling someone to read a restart
    // that never happened is the defect the UNVERIFIED arm exists to avoid, mirrored.
    const restarted = fixtureContainer('sleep 1; exit 1', 'on-failure:5');
    const begun = snapshot(probe('begin', restarted).output);
    const terminated = fixtureContainer(`sleep 2; echo "${TERMINATION_LINE}"; sleep 120`);
    const begunTerm = snapshot(probe('begin', terminated).output);
    return new Promise<void>((done) => setTimeout(done, 6000)).then(() => {
      const a = probe('verify', begun.restarts, begun.since, restarted);
      expect(a.status).toBe(1);
      expect(a.output).toContain('FAIL(restarted)');
      const b = probe('verify', begunTerm.restarts, begunTerm.since, terminated);
      expect(b.status).toBe(1);
      expect(b.output, 'a process that survived must not be reported as restarted').toContain('FAIL(terminated)');
      expect(b.output).not.toContain('FAIL(restarted)');
    });
  }, 90_000);
});
