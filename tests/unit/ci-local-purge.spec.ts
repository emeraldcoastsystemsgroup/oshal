/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run the nightly's export purge in Git Bash on a synthetic node_modules-shaped tree, prove its watchdog fails loud with an outcome line instead of hanging (the 2026-09-09 run sat nine hours in rm -rf and wrote nothing), and pin that ci-local.sh purges both of its exports through it rather than a bare rm -rf.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Cover the watchdog's abandon with a delete whose work is a NATIVE child that outlives its bash wrapper, the shape of robocopy.exe under `timeout`. The existing timeout case overrides the primitive with a bash `sleep`, so it proves the watchdog unblocks but cannot see an orphaned native process: against the old `kill "$pid"` the child was still running (and still deleting) after the FAIL line. The new case asserts the child is gone, and its heartbeat frozen, shortly after purge_tree returns.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Judge the abandon's three outcomes separately, because the one thing it could not do was tell them apart: found descendants, enumerated and genuinely none, and could not enumerate at all were two messages for three facts, and on this box - where Git Bash's ps rejects `-eo` - the third was printed as the second. The walk itself is driven over a fixture process table so the POSIX descendants-then-parent branch is exercised on any box (it kills real spawned processes, and its deepest-first order is asserted), while the real reader is judged against the platform it is actually running on. Reverting either could-not-look branch turns these cases red, which is the property that makes them a guard rather than a description.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Drive a real native GRANDCHILD under a `timeout` through the abandon, and judge the process-table reader by whether it ANSWERS. Entry 3 pinned the honest refusal, and on Windows that refusal was every abandon that fell past taskkill - nothing was ever killed by enumeration here, and the reader case asserted that refusal as the contract. The new case is the exact shape of the production primitive (`timeout` wrapping a native binary, which then spawns its own native child) and it goes red against either half of the reader alone: measured 2026-09-15, Windows' own table answers with an EMPTY descendant list for it because an MSYS exec leaves a dead parent pid on the `timeout` row, and Git Bash's `ps` cannot see the grandchild at all. The grandchild is spawned detached on purpose - libuv otherwise puts it in a job object that dies with its parent, which would let a walk that never reached it look like it had. The could-not-look cases are unchanged and still go red when their branch is collapsed.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Follow the prepare_head_src call site to its new shape. A purge FAIL no longer returns from the gate: the inherited export is moved aside and the run keeps going, so the text pinned here is the `if ! purge_tree` head rather than `|| return 1`. What that pin used to stand in for - what the run actually DOES with an export it cannot clear - is now run rather than read, in tests/unit/ci-local-inherited-export.spec.ts.
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

/**
 * A native process that spawns its OWN native child, outside the MSYS tree: the shape no MSYS
 * process table can see. Measured on this box 2026-09-15 - the grandchild is absent from Git Bash's
 * bare `ps` entirely, and `ps -W` lists it with ppid 0, no linkage to anything. `robocopy.exe`
 * under `timeout` is this shape one level down, which is why an enumerator built on `ps` alone
 * would have gone on reporting a checked absence it had not earned.
 */
const NATIVE_GRANDPARENT_SOURCE = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  'const [, , grandScript, pidFile, beatFile] = process.argv;',
  // detached, because libuv otherwise puts a spawned child in a job object that dies with its
  // parent - which would let a walk that never reached the grandchild still look like it had.
  "const grand = spawn(process.execPath, [grandScript, beatFile], { stdio: 'ignore', windowsHide: true, detached: true });",
  'grand.unref();',
  'fs.writeFileSync(pidFile, String(grand.pid));',
  'setTimeout(() => process.exit(0), 30000);',
  '',
].join('\n');

/** The grandchild itself: a rising heartbeat, so "still working after the FAIL line" is measurable. */
const NATIVE_GRANDCHILD_SOURCE = [
  "const fs = require('node:fs');",
  'const [, , beatFile] = process.argv;',
  "fs.writeFileSync(beatFile, '0');",
  'let beats = 0;',
  'const timer = setInterval(() => fs.writeFileSync(beatFile, String(++beats)), 200);',
  'setTimeout(() => clearInterval(timer), 30000);',
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

/** @description Source the production helper in Git Bash and run an arbitrary probe body against it. */
function runShell(body: string, args: string[] = []): PurgeRun {
  const probe = join(SCRATCH, `probe-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(probe, `#!/usr/bin/env bash\nset -uo pipefail\nsource "$1"\n${body}\n`, { encoding: 'utf8' });
  const started = Date.now();
  const result = spawnSync(BASH, [posix(probe), HELPER, ...args], { encoding: 'utf8', timeout: 90_000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, elapsedMs: Date.now() - started };
}

/** @description Source the production helper in Git Bash and purge one path, optionally overriding the delete primitive first. */
function runPurge(target: string, limitSeconds: number, override = ''): PurgeRun {
  return runShell(`${override}\npurge_tree "$2" "$3"`, [posix(target), String(limitSeconds)]);
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

/**
 * The defect these cases exist for: the abandon printed one sentence - "no descendant processes
 * found" - for two unrelated facts, an enumeration that ran and found nothing and an enumeration
 * that could not run at all. On this box only the second is ever true, because Git Bash's ps
 * rejects `-eo` outright, so every Windows abandon that fell past taskkill claimed an absence it
 * had never checked. The three outcomes are judged one at a time below.
 */
describe('purge abandon: found, none, and could-not-look are three different answers', () => {
  // The process table is read through one overridable function, so the POSIX descendants-then-parent
  // walk above it can be driven from a fixture on a box whose own ps cannot produce one.
  const FIXTURE_TABLE = "purge_tree_process_table() { printf '100 1\\n200 100\\n300 200\\n400 100\\n500 7777\\n'; }";
  // Skipping the taskkill branch is how a Windows box is made to take the POSIX path: on Linux
  // there is no taskkill at all, and here there is no Windows pid to hand it.
  const NO_TASKKILL = 'purge_tree_winpid() { return 1; }';

  it('walks the fixture table deepest-first and excludes processes that are not descendants', () => {
    const run = runShell([
      FIXTURE_TABLE,
      'purge_tree_descendants 100',
      'echo "rc=$?"',
      `echo "list=[$(printf '%s' "$PURGE_DESCENDANTS" | tr '\\n' ',')]"`,
    ].join('\n'));
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('rc=0');
    // 300 is a grandchild and must be killed before its parent 200; 500 hangs off an unrelated pid.
    expect(run.output).toContain('list=[300,200,400]');
  }, 30_000);

  it('kills the descendants it names, and names how many - the "found" outcome', () => {
    const stuck = join(SCRATCH, 'found-descendants-export');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f.js'), 'x');
    const pidFile = posix(join(SCRATCH, 'found-descendants.pid'));
    // A real child of the delete wrapper, reported to the walk through the fixture reader. The
    // kill that follows is the production one, against a process that genuinely exists.
    const body = [
      NO_TASKKILL,
      `purge_tree_delete() { exec >/dev/null 2>&1; sleep 30 & printf '%s %s\\n' "$!" "$BASHPID" > "${pidFile}"; sleep 30; }`,
      `purge_tree_process_table() { [ -s "${pidFile}" ] || return 2; cat "${pidFile}"; }`,
      'purge_tree "$2" "$3"',
      'echo "purge_rc=$?"',
      `child="$(cut -d' ' -f1 "${pidFile}")"`,
      'echo "child=$child"',
      'if kill -0 "$child" 2>/dev/null; then echo CHILD_ALIVE; else echo CHILD_DEAD; fi',
    ].join('\n');
    const run = runShell(body, [posix(stuck), '2']);
    expect(run.output).toContain('purge_rc=1');
    expect(run.output, 'the enumerated descendant survived the abandon').toContain('CHILD_DEAD');
    expect(run.output).toMatch(/purge: FAIL .*found-descendants-export \(timeout after 2s; killed 1 descendant process\(es\) of pid \d+;/);
    expect(run.output).not.toContain('UNCHECKED');
  }, 60_000);

  it('says it enumerated and found nothing only when it actually enumerated - the "none" outcome', () => {
    const stuck = join(SCRATCH, 'no-descendants-export');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f.js'), 'x');
    const body = [
      NO_TASKKILL,
      // A readable table in which the delete wrapper has no children at all.
      "purge_tree_process_table() { printf '1 0\\n2 1\\n'; }",
      'purge_tree_delete() { exec >/dev/null 2>&1; sleep 20; }',
      'purge_tree "$2" "$3"',
      'echo "purge_rc=$?"',
    ].join('\n');
    const run = runShell(body, [posix(stuck), '2']);
    expect(run.output).toContain('purge_rc=1');
    expect(run.output).toMatch(/killed pid \d+ \(enumerated its descendants and found none\)/);
    expect(run.output).not.toContain('UNCHECKED');
  }, 60_000);

  it('reports UNCHECKED rather than a clean kill when the descendants cannot be enumerated at all', () => {
    const stuck = join(SCRATCH, 'unenumerable-export');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f.js'), 'x');
    const body = [
      NO_TASKKILL,
      // Exactly what Git Bash's own ps does here: refuse. Stated explicitly so the case means the
      // same thing on a Linux runner, where the real reader would have answered.
      'purge_tree_process_table() { return 2; }',
      'purge_tree_delete() { exec >/dev/null 2>&1; sleep 20; }',
      'purge_tree "$2" "$3"',
      'echo "purge_rc=$?"',
    ].join('\n');
    const run = runShell(body, [posix(stuck), '2']);
    expect(run.output).toContain('purge_rc=1');
    expect(run.output).toContain('UNCHECKED');
    expect(run.output).toContain('could not be enumerated');
    expect(run.output).toContain('a native delete may still be running');
    // The false-green this closes: an inability to look used to be printed as a checked absence.
    expect(run.output, 'an unenumerable abandon must never claim it looked').not.toContain('found none');
    expect(run.output).not.toContain('no descendant processes found');
    expect(existsSync(stuck), 'the abandoned tree must still be left for the operator').toBe(true);
  }, 60_000);

  it('reports a taskkill refused against a still-running delete as a failure to abandon, not a kill', () => {
    const stuck = join(SCRATCH, 'taskkill-refused-export');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f.js'), 'x');
    const body = [
      // `command -v` finds a function, so this stands in for a taskkill that refuses - the
      // permission edge case and the race, which are the two ways it fails in the field.
      'taskkill() { return 1; }',
      'purge_tree_winpid() { printf 4242; }',
      // The table stays unreadable, as it is on this box, so nothing else can answer instead.
      'purge_tree_process_table() { return 2; }',
      'purge_tree_delete() { exec >/dev/null 2>&1; sleep 20; }',
      'purge_tree "$2" "$3"',
      'echo "purge_rc=$?"',
    ].join('\n');
    const run = runShell(body, [posix(stuck), '2']);
    expect(run.output).toContain('purge_rc=1');
    expect(run.output).toContain('UNCHECKED');
    expect(run.output).toContain('taskkill /T was refused for live windows pid 4242');
    expect(run.output, 'a refused taskkill must not be printed as a successful tree kill').not.toContain('(taskkill /T)');
    expect(run.output).not.toContain('found none');
  }, 60_000);

  it('kills a native GRANDCHILD under a `timeout`, which neither process table can reach alone', () => {
    const stuck = join(SCRATCH, 'native-grandchild-export');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f.js'), 'x');
    const parentScript = join(SCRATCH, 'native-grandparent.js');
    const grandScript = join(SCRATCH, 'native-grandchild.js');
    const pidFile = join(SCRATCH, 'native-grandchild.pid');
    const beatFile = join(SCRATCH, 'native-grandchild.beat');
    writeFileSync(parentScript, NATIVE_GRANDPARENT_SOURCE);
    writeFileSync(grandScript, NATIVE_GRANDCHILD_SOURCE);
    const body = [
      // taskkill /T is stood down to a no-op because it is the branch that already works. What is
      // under test is the enumerator the abandon falls to when taskkill is absent or refused - the
      // path that, on Windows, used to report UNCHECKED and kill nothing at all.
      'taskkill() { return 0; }',
      // `timeout <native>` is the production primitive's exact shape, and it is what makes this case
      // need BOTH halves of the Windows reader: Windows' own table cannot link `timeout` back to the
      // wrapper (an MSYS exec hands off to a new Windows process and the one that exec'd exits, so
      // the parent on that row is dead), and the MSYS table cannot see the grandchild at all.
      `purge_tree_delete() { exec >/dev/null 2>&1; timeout 30 node "${posix(parentScript)}" "${posix(grandScript)}" "${posix(pidFile)}" "${posix(beatFile)}" & sleep 30; }`,
      'purge_tree "$2" "$3"',
      'echo "purge_rc=$?"',
    ].join('\n');
    const run = runShell(body, [posix(stuck), '4']);
    expect(run.output).toContain('purge_rc=1');
    expect(existsSync(pidFile), `the native grandchild never started: ${run.output}`).toBe(true);
    const grandPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandPid) && grandPid > 0, `unusable grandchild pid: ${run.output}`).toBe(true);
    const beatAtAbandon = readFileSync(beatFile, 'utf8').trim();
    const survived = outlivesAbandon(grandPid, 8_000);
    const beatAfterAbandon = readFileSync(beatFile, 'utf8').trim();
    if (survived) {
      try {
        process.kill(grandPid, 'SIGKILL');
      } catch {
        /* it exited between the poll and the cleanup */
      }
    }
    expect(survived, `the native grandchild outlived the abandon - it was never enumerated: ${run.output}`).toBe(false);
    expect(beatAfterAbandon, 'the abandoned grandchild was still working after purge_tree returned').toBe(beatAtAbandon);
    expect(run.output, 'the table can be read on this box, so UNCHECKED is not the honest answer').not.toContain('UNCHECKED');
    expect(run.output, 'the outcome line must name the descendants it killed').toMatch(/descendant process\(es\) of pid \d+/);
  }, 90_000);

  it('judges the real process-table reader on the platform it is running on, and it answers there', () => {
    const run = runShell([
      'purge_tree_process_table >/dev/null 2>&1',
      'echo "table_rc=$?"',
      'sleep 10 & child=$!',
      `childwin="$(purge_tree_winpid "$child" 2>/dev/null)" || childwin=''`,
      `purge_tree_descendants "$$" "$(purge_tree_winpid "$$" 2>/dev/null)"`,
      'echo "walk_rc=$?"',
      'echo "winpids=[$PURGE_DESCENDANTS_WINPIDS]"',
      `echo "child=$child childwin=$childwin list=[$(printf '%s' "$PURGE_DESCENDANTS" | tr '\\n' ',')]"`,
      'kill "$child" 2>/dev/null',
      'exit 0',
    ].join('\n'));
    expect(run.status, run.output).toBe(0);
    // Whatever the platform, the reader has to ANSWER: a permanent refusal here is the state this
    // box was in, where every abandon that fell past taskkill reported UNCHECKED and killed nothing.
    expect(run.output, `the process-table reader refused on this platform: ${run.output}`).toContain('table_rc=0');
    expect(/walk_rc=(\d+)/.exec(run.output)?.[1], run.output).toBe('0');
    // On Windows the rows are Windows pids and the walk is rooted at the shell's own Windows pid,
    // so the child is looked for under that identity; on a POSIX runner both are the same number.
    const expectedPid = process.platform === 'win32'
      ? /childwin=(\d+)/.exec(run.output)?.[1]
      : /child=(\d+)/.exec(run.output)?.[1];
    expect(run.output).toContain(process.platform === 'win32' ? 'winpids=[1]' : 'winpids=[]');
    expect(expectedPid, run.output).toBeTruthy();
    expect(run.output, 'the real walk missed a real child of this shell').toMatch(new RegExp(`list=\\[[^\\]]*\\b${expectedPid}\\b`));
  }, 60_000);
});

describe('ci-local.sh purges its exports through the bounded helper', () => {
  it('sources scripts/ci/ci-purge.sh before any gate runs', () => {
    expect(CI_SOURCE).toMatch(/^\. "\$REPO_DIR\/scripts\/ci\/ci-purge\.sh"$/m);
  });

  it('prepare_head_src purges the previous ci-src export with purge_tree, never a bare rm -rf', () => {
    const body = functionBody('prepare_head_src');
    expect(body).toContain('if ! purge_tree "$GATE_SRC"; then');
    expect(body).not.toMatch(/rm -rf "\$GATE_SRC"/);
  });

  it('gate_secrets purges ci-scan-src with purge_tree on every path, never a bare rm -rf', () => {
    const body = functionBody('gate_secrets');
    expect(body).toContain('purge_tree "$exp" || return 1');
    expect(body).not.toMatch(/rm -rf "\$exp"/);
  });
});
