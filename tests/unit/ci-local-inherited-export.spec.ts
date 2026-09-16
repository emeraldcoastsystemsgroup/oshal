/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive ci-local.sh's real gate sequence, in Git Bash, over a state directory that already holds the previous run's ci-src export - the state the 2026-09-09 nightly wedged nine hours in and wrote no outcome line from. The purge spec next door runs purge_tree alone and pins the call sites by text search; nothing ever ran the sequence itself, so the last done-when of that entry ("a run that inherits a leftover export from a failed run reaches its gates and writes an outcome line") rested on reading the code. This runs it: the production prepare_head_src, run_gate and gate block are sliced out of ci-local.sh, the gates are recording stand-ins, and the leftover on disk is real. It covers the export that purges, the export that will not purge inside the watchdog (which used to skip twelve gates and leave $GATE_SRC naming a half-deleted tree that the image-tier gates then read), and the retry of a tree an earlier run had to abandon.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const PURGE_HELPER = join(ROOT, 'scripts', 'ci', 'ci-purge.sh').replaceAll('\\', '/');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-inherited-'));

/** A file only the PREVIOUS run's export carries, so a tree can be identified by generation. */
const LEFTOVER_MARK = 'LEFTOVER-FROM-THE-PREVIOUS-RUN.txt';
/** A file only THIS run's export carries; it is committed in the fixture repository. */
const FRESH_MARK = 'src/app.ts';

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
const toBash = (p: string): string => p.replaceAll('\\', '/');

/** @description Run Git against the disposable repository with prompts disabled. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/** @description The committed tree prepare_head_src exports, small enough that the archive is not the thing under test. */
function createRepo(): { repo: string; sha: string } {
  const repo = join(SCRATCH, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'OSHAL Maintainer');
  git(repo, 'config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, '.trivyignore'), '# fixture, this generation\n');
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const ok = true;\n');
  git(repo, 'add', '--', '.trivyignore', 'src/app.ts');
  git(repo, 'commit', '-q', '-m', 'fixture');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

const FIXTURE = createRepo();

/** @description A previous run's export: a node_modules-shaped tree carrying the previous generation's marks. */
function seedExport(path: string): void {
  mkdirSync(join(path, 'node_modules', 'a', 'b'), { recursive: true });
  for (const name of ['x.js', 'y.js', 'z.js']) {
    writeFileSync(join(path, 'node_modules', 'a', 'b', name), 'x');
  }
  writeFileSync(join(path, LEFTOVER_MARK), 'previous generation');
  writeFileSync(join(path, '.trivyignore'), '# fixture, the PREVIOUS generation\n');
}

/**
 * @description Slice one shell function out of ci-local.sh so the probe runs the production text.
 * @param name the function to slice
 * @param optional when true a missing function yields an empty string instead of throwing, so the
 * guard stays runnable against a ci-local.sh that predates the function
 * @returns the function's source, terminated
 */
function functionBody(name: string, optional = false): string {
  const start = CI_SOURCE.indexOf(`${name}() {`);
  if (start < 0) {
    if (optional) return '';
    throw new Error(`${name} is missing from ci-local.sh`);
  }
  return CI_SOURCE.slice(start, CI_SOURCE.indexOf('\n}\n', start) + 3);
}

/**
 * @description Slice the gate block - every run_gate call and the outcome line - out of ci-local.sh.
 * @returns the production sequence, from NODE_GATES_OK through the failed-gates outcome line
 */
function gateSequence(): string {
  const start = CI_SOURCE.indexOf('\nNODE_GATES_OK=1\n');
  expect(start, 'the gate block no longer starts at NODE_GATES_OK=1').toBeGreaterThanOrEqual(0);
  const endMark = 'log "=== LOCAL CI: FAILED gates: ${FAILED_GATES[*]} ==="';
  const end = CI_SOURCE.indexOf(endMark, start);
  expect(end, 'the failed-gates outcome line is no longer in ci-local.sh').toBeGreaterThan(start);
  return `${CI_SOURCE.slice(start + 1, end + endMark.length)}\n`;
}

/** Every gate the block dispatches. Stand-ins: this guard judges the sequence, not the gates. */
const GATES = [
  'typecheck', 'store_compatibility', 'unit', 'lint', 'connectors', 'manifests', 'kernel_skills',
  'workflow_triggers', 'security_policy', 'repo_separation', 'spec_database_default',
  'worktree_strays', 'secrets', 'local_secret_hygiene', 'unpushed_commits', 'e2e', 'image',
  'kernel_skills_image', 'smoke', 'trivy', 'alert_residue',
];

interface ProbeRun {
  status: number | null;
  output: string;
  /** Every gate that actually ran, with the $GATE_SRC it was handed. */
  gates: { name: string; gateSrc: string }[];
  stateDir: string;
}

/**
 * @description Run the production gate sequence against a state directory seeded by the caller.
 * @param seed what is already on disk under the state directory before the run starts
 * @param stall when true the delete primitive never finishes, so the inherited export cannot be
 * purged inside the watchdog - the shape of the 2026-09-09 wedge, bounded to seconds
 * @returns the run's log, the gates it reached, and the state directory it used
 */
function runProbe(seed: { leftover?: boolean; abandoned?: boolean }, stall = false): ProbeRun {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stateDir = join(SCRATCH, `state-${id}`);
  const fakeBin = join(SCRATCH, `bin-${id}`);
  const record = join(SCRATCH, `gates-${id}.tsv`);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  if (seed.leftover) seedExport(join(stateDir, 'ci-src'));
  if (seed.abandoned) seedExport(join(stateDir, 'ci-src.abandoned.20260909000000-1'));
  // npm ci and the transformers self-heal are outside the boundary under test; the sequence is not.
  writeFileSync(join(fakeBin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(fakeBin, 'node'), '#!/usr/bin/env bash\nexit 1\n');

  const stubs = GATES.map(
    (g) => `gate_${g}() { printf '%s\\t%s\\n' '${g}' "$GATE_SRC" >>"$GATE_RECORD"; return 0; }`,
  );
  const probe = join(SCRATCH, `probe-${id}.sh`);
  writeFileSync(probe, `${[
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'REPO_DIR="$1"; SOURCE_SHA="$2"; STATE_DIR="$3"; FAKE_BIN="$4"; GATE_RECORD="$5"; PURGE_HELPER="$6"',
    'chmod +x "$FAKE_BIN"/npm "$FAKE_BIN"/node',
    // PATH entries must be POSIX-form under MSYS: a C:/... entry splits on its colon and the real npm wins.
    'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN="$(cygpath -u "$FAKE_BIN")"; fi',
    'export PATH="$FAKE_BIN:$PATH"',
    'command -v npm | grep -q "^$FAKE_BIN/npm$" || { echo "stand-in npm is not first on PATH: $(command -v npm)" >&2; exit 97; }',
    `log() { printf '[log] %s\\n' "$*"; }`,
    'if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi',
    '. "$PURGE_HELPER"',
    stall ? 'purge_tree_delete() { exec >/dev/null 2>&1; sleep 25; }' : '',
    functionBody('sweep_abandoned_exports', true),
    functionBody('prepare_head_src'),
    functionBody('run_gate'),
    ...stubs,
    'prune_scoped() { :; }',
    'REPO_WIN="$REPO_DIR"',
    'SOURCE_REF=HEAD; SOURCE_SHORT_SHA="${SOURCE_SHA:0:12}"; SOURCE_POSTURE=probe',
    'HEAD_MODE=1; DO_INSTALL=0; SKIP_E2E=0; SKIP_IMAGE=0',
    'FAILED_GATES=()',
    gateSequence(),
  ].join('\n')}\n`);

  const result = spawnSync(
    BASH,
    [toBash(probe), toBash(FIXTURE.repo), FIXTURE.sha, toBash(stateDir), toBash(fakeBin), toBash(record), PURGE_HELPER],
    { encoding: 'utf8', timeout: 240_000, env: { ...process.env, CI_PURGE_TIMEOUT_SECONDS: '4' } },
  );
  const gates = (existsSync(record) ? readFileSync(record, 'utf8') : '')
    .split('\n').filter(Boolean)
    .map((line) => {
      const [name, gateSrc] = line.split('\t');
      return { name, gateSrc };
    });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, gates, stateDir };
}

/** @description Which generation of export a gate was pointed at, judged by what is inside the tree. */
function generationOf(gateSrc: string): 'previous' | 'this-run' | 'absent' {
  if (existsSync(join(gateSrc, LEFTOVER_MARK))) return 'previous';
  if (existsSync(join(gateSrc, FRESH_MARK))) return 'this-run';
  return 'absent';
}

describe('a nightly that inherits the previous run export (scripts/ci-local.sh)', () => {
  it('purges the inherited export, reaches every gate, and writes an outcome line', () => {
    const run = runProbe({ leftover: true });

    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/purge: OK .*ci-src \(\d+s\)/);
    expect(run.output).toContain('=== LOCAL CI: ALL GATES GREEN ===');
    // Reached its gates: the node tier, the unconditional tier, and the image tier.
    expect(run.gates.map((g) => g.name)).toEqual(expect.arrayContaining(GATES));
    // Every gate judged THIS run's export, and the previous generation is gone from disk.
    expect(run.gates.map((g) => generationOf(g.gateSrc))).toEqual(run.gates.map(() => 'this-run'));
    expect(existsSync(join(run.stateDir, 'ci-src', LEFTOVER_MARK))).toBe(false);
  }, 240_000);

  it('still reaches every gate and writes an outcome line when the inherited export will not purge', () => {
    const run = runProbe({ leftover: true }, true);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/purge: FAIL .*ci-src \(timeout after 4s/);
    // Red, and it says which fact it is, rather than passing quietly on a logged warning.
    expect(run.output).toContain('=== LOCAL CI: FAILED gates: head-src-inherited-export-abandoned ===');
    expect(run.output).toMatch(/moved aside to .*ci-src\.abandoned\./);
    // The half of the done-when that reading the code could not deliver: on a purge FAIL the old
    // prepare_head_src returned, NODE_GATES_OK went to 0, and twelve gates never ran at all.
    expect(run.gates.map((g) => g.name)).toEqual(expect.arrayContaining(GATES));
    // And no gate - least of all the image tier, which runs outside the node-gate block - was
    // handed the half-deleted tree from the previous commit.
    expect(run.gates.map((g) => generationOf(g.gateSrc))).toEqual(run.gates.map(() => 'this-run'));

    const abandoned = readdirSync(run.stateDir).filter((n) => n.startsWith('ci-src.abandoned.'));
    expect(abandoned).toHaveLength(1);
    expect(existsSync(join(run.stateDir, abandoned[0], LEFTOVER_MARK))).toBe(true);
  }, 240_000);

  it('gives a tree an earlier run had to abandon one more bounded attempt, so it cannot accumulate', () => {
    const run = runProbe({ abandoned: true });

    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/purge: OK .*ci-src\.abandoned\.20260909000000-1/);
    expect(readdirSync(run.stateDir).filter((n) => n.startsWith('ci-src.abandoned.'))).toHaveLength(0);
    expect(run.output).toContain('=== LOCAL CI: ALL GATES GREEN ===');
  }, 240_000);
});
