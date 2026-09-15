/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run the nightly's export purge in Git Bash on a synthetic node_modules-shaped tree, prove its watchdog fails loud with an outcome line instead of hanging (the 2026-09-09 run sat nine hours in rm -rf and wrote nothing), and pin that ci-local.sh purges both of its exports through it rather than a bare rm -rf.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Cover the watchdog's abandon with a delete whose work is a NATIVE child that outlives its bash wrapper, the shape of robocopy.exe under `timeout`. The existing timeout case overrides the primitive with a bash `sleep`, so it proves the watchdog unblocks but cannot see an orphaned native process: against the old `kill "$pid"` the child was still running (and still deleting) after the FAIL line. The new case asserts the child is gone, and its heartbeat frozen, shortly after purge_tree returns.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const HELPER = join(ROOT, 'scripts', 'ci', 'ci-purge.sh').replaceAll('\\', '/');
const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-purge-'));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** @description Locate Git Bash without falling into Windows' WSL launcher. */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up++) {
    for (const rel of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Git Bash not found; refusing the WSL bash on PATH');
}

const BASH = resolveBash();

/** @description Build a deep, wide tree shaped like a package export: three files per directory, three subdirectories per level. */
function synthesizeTree(root: string, depth: number): void {
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(root, `f${i}.js`), 'x');
  if (depth === 0) return;
  for (const name of ['a', 'b', 'c']) synthesizeTree(join(root, name), depth - 1);
}

/**
 * The native half of the delete stand-in: a child process that keeps working after its bash parent
 * is signalled, the way robocopy.exe does. It records its own pid, then a rising heartbeat.
 */
const NATIVE_CHILD_SOURCE = [
  "const fs = require('node:fs');",
  'const [, , pidFile, beatFile] = process.argv;',
  "fs.writeFileSync(beatFile, '0');",
  'fs.writeFileSync(pidFile, String(process.pid));',
  'let beats = 0;',
  'const timer = setInterval(() => fs.writeFileSync(beatFile, String(++beats)), 200);',
  'setTimeout(() => clearInterval(timer), 25000);',
  '',
].join('\n');

/** @description Whether a process id is still running. Signal 0 only probes; it delivers nothing. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @description Poll until the pid is gone, and report whether it outlived the budget. Blocks without a timer so the check stays inside the synchronous test body. */
function outlivesAbandon(pid: number, budgetMs: number): boolean {
  const deadline = Date.now() + budgetMs;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return false;
    Atomics.wait(idle, 0, 0, 100);
  }
  return isAlive(pid);
}

/** @description Spell a Windows path the way the Git Bash probe needs it. */
function posix(path: string): string {
  return path.replaceAll('\\', '/');
}

interface PurgeRun {
  status: number | null;
  output: string;
  elapsedMs: number;
}

/** @description Source the production helper in Git Bash and purge one path, optionally overriding the delete primitive first. */
function runPurge(target: string, limitSeconds: number, override = ''): PurgeRun {
  const probe = join(SCRATCH, `probe-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(probe, `#!/usr/bin/env bash\nset -uo pipefail\nsource "$1"\n${override}\npurge_tree "$2" "$3"\n`);
  const started = Date.now();
  const result = spawnSync(BASH, [probe.replaceAll('\\', '/'), HELPER, target.replaceAll('\\', '/'), String(limitSeconds)], {
    encoding: 'utf8', timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, elapsedMs: Date.now() - started };
}

/** @description Extract one shell function body from ci-local.sh so the pin reads the production text, not a copy. */
function functionBody(name: string): string {
  const start = CI_SOURCE.indexOf(`${name}() {`);
  expect(start, `${name} is missing from ci-local.sh`).toBeGreaterThanOrEqual(0);
  const end = CI_SOURCE.indexOf('\n}\n', start);
  return CI_SOURCE.slice(start, end + 3);
}

describe('ci-local export purge (scripts/ci/ci-purge.sh)', () => {
  it('clears a synthetic node_modules-shaped tree and ends in one purge: OK line', () => {
    const exportDir = join(SCRATCH, 'ci-src');
    synthesizeTree(join(exportDir, 'node_modules'), 5); // 364 directories, 1092 files
    const run = runPurge(exportDir, 120);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/purge: OK .*ci-src \(\d+s\)/);
    expect(existsSync(exportDir)).toBe(false);
  }, 90_000);

  it('treats an absent export as already purged', () => {
    const run = runPurge(join(SCRATCH, 'never-created', 'ci-src'), 5);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('purge: OK');
    expect(run.output).toContain('(already absent)');
  });

  it('fails loud with a timeout outcome line when the delete never finishes, and returns within the limit', () => {
    const stuck = join(SCRATCH, 'stuck-export');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f.js'), 'x');
    // A delete that behaves like the 2026-09-09 rm -rf: alive, making no progress. Its output
    // handles are released so the probe's pipes close the moment the watchdog abandons it.
    const override = 'purge_tree_delete() { exec >/dev/null 2>&1; sleep 20; }';
    const run = runPurge(stuck, 1, override);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/purge: FAIL .*stuck-export \(timeout after 1s;/);
    expect(run.elapsedMs).toBeLessThan(15_000);
    expect(existsSync(stuck), 'the abandoned tree must be left for the operator, never reported gone').toBe(true);
  }, 30_000);

  it('kills the delete process tree on abandon, so a native child cannot keep deleting past the FAIL line', () => {
    const stuck = join(SCRATCH, 'native-child-export');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f.js'), 'x');
    const childScript = join(SCRATCH, 'native-child.js');
    const pidFile = join(SCRATCH, 'native-child.pid');
    const beatFile = join(SCRATCH, 'native-child.beat');
    writeFileSync(childScript, NATIVE_CHILD_SOURCE);
    // The real primitive is a bash wrapper whose work is native (robocopy.exe / rm.exe under
    // `timeout`), and signalling the wrapper does not reach it: measured on a 26,180-file
    // export, where Robocopy.exe was still in tasklist and the tree still shrinking (24,121
    // files at return, 23,058 eight seconds later) after the FAIL line.
    const override = `purge_tree_delete() { exec >/dev/null 2>&1; node "${posix(childScript)}" "${posix(pidFile)}" "${posix(beatFile)}" & sleep 25; }`;
    const run = runPurge(stuck, 3, override);
    expect(run.status, run.output).toBe(1);
    expect(existsSync(pidFile), `the native delete child never started: ${run.output}`).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(childPid) && childPid > 0, `unusable child pid: ${run.output}`).toBe(true);
    const beatAtAbandon = readFileSync(beatFile, 'utf8').trim();
    const survived = outlivesAbandon(childPid, 5_000);
    const beatAfterAbandon = readFileSync(beatFile, 'utf8').trim();
    if (survived) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        /* it exited between the poll and the cleanup */
      }
    }
    expect(survived, 'the native delete child outlived the abandon - the watchdog reached the bash wrapper only').toBe(false);
    expect(beatAfterAbandon, 'the abandoned delete was still working after purge_tree returned').toBe(beatAtAbandon);
    expect(run.output, 'the outcome line must name what the abandon killed').toMatch(/purge: FAIL .*native-child-export \(timeout after 3s; killed /);
  }, 60_000);

  it('reports a delete that returned but left the tree behind as FAIL', () => {
    const stubborn = join(SCRATCH, 'stubborn-export');
    mkdirSync(stubborn, { recursive: true });
    const run = runPurge(stubborn, 5, 'purge_tree_delete() { return 0; }');
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/purge: FAIL .*stubborn-export \(delete rc=0 after \d+s; the tree is still present\)/);
  });

  it('refuses paths a mirror-from-empty must never touch', () => {
    for (const target of ['/', '/c', process.env.HOME ?? process.env.USERPROFILE ?? '/home/nobody']) {
      const run = runPurge(target, 5);
      expect(run.status, `${target}: ${run.output}`).toBe(1);
      expect(run.output).toContain('purge: REFUSED');
    }
  });
});

describe('ci-local.sh purges its exports through the bounded helper', () => {
  it('sources scripts/ci/ci-purge.sh before any gate runs', () => {
    expect(CI_SOURCE).toMatch(/^\. "\$REPO_DIR\/scripts\/ci\/ci-purge\.sh"$/m);
  });

  it('prepare_head_src purges the previous ci-src export with purge_tree and fails the gate when it cannot', () => {
    const body = functionBody('prepare_head_src');
    expect(body).toContain('purge_tree "$GATE_SRC" || return 1');
    expect(body).not.toMatch(/rm -rf "\$GATE_SRC"/);
  });

  it('gate_secrets purges ci-scan-src with purge_tree on every path, never a bare rm -rf', () => {
    const body = functionBody('gate_secrets');
    expect(body).toContain('purge_tree "$exp" || return 1');
    expect(body).not.toMatch(/rm -rf "\$exp"/);
  });
});
