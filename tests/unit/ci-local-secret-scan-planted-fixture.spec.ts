/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The planted-fixture fail-then-pass proof for the secret-scan gate, run against the REAL scanner. tests/unit/ci-local-secret-scan.spec.ts puts a stand-in `docker` first on PATH, so zricethezav/gitleaks has never actually run in a guard and nothing proved the gate goes RED on a credential-shaped value or GREEN once it is gone - the one clause the CI secret-scanner entry still owed. This runs the production `gate_secrets` body sliced out of scripts/ci-local.sh over four commits of a disposable repository that carries this repo's real .gitleaks.toml, with the real image: clean PASS, planted FAIL, the allowlisted AWS documentation dummy still PASS (so the FAIL is caused by the planted value and not by the shape), and PASS again after removal. The planted value is synthetic, assembled at runtime so this file never holds the token contiguously, and lives only in a temp directory that is deleted - no credential, real or fixture, enters this repository's history.
 */

/**
 * @description
 * Real-boundary proof for the `secret-scan` gate in `scripts/ci-local.sh`.
 *
 * The boundary this crosses is the scanner itself: `zricethezav/gitleaks:latest` running under the
 * exact production arguments (`--network none`, read-only export mount, `--no-git`, this repo's
 * `.gitleaks.toml`, `--redact`) over a `git archive` export, with `run_secret_scan` turning its
 * exit code into the gate's verdict. Four sequential commits of one disposable repository are
 * scanned, and only the planted file differs between the RED run and the GREEN runs either side of
 * it, which is what makes the failure attributable to the fixture rather than to the fixture tree.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireFixtureSlot, type FixtureSlot } from '../helpers/fixture-slots';

const ROOT = resolve(__dirname, '../..');
const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const PURGE_HELPER = join(ROOT, 'scripts', 'ci', 'ci-purge.sh').replaceAll('\\', '/');
const SCAN_HELPER = join(ROOT, 'scripts', 'ci', 'ci-secret-scan.sh').replaceAll('\\', '/');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-secret-scan-planted-'));

/**
 * A credential-SHAPED synthetic value: the `AKIA` prefix plus sixteen characters, which is what
 * gitleaks' `aws-access-token` rule matches. It is not a credential and no account has ever had it.
 * Assembled from parts so this source file never carries the contiguous token - the same runtime
 * assembly `tests/unit/secret-scanner.spec.ts` uses for its PEM header, and the reason this guard
 * needs no entry in the `.gitleaks.toml` fixture allowlist.
 */
const PLANTED_KEY_ID = ['AK', 'IA', 'Z7QW4TRPL2MN6BXD'].join('');

/** The AWS documentation dummy key, which `.gitleaks.toml` allowlists by exact value. */
const DOC_DUMMY_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';

/** One scanned commit: what the gate returned and everything it wrote. */
interface StageRun {
  status: number | null;
  output: string;
}

let slot: FixtureSlot;
const stages = new Map<string, StageRun>();

/** @description Locate Git Bash without falling into Windows' WSL launcher. */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up += 1) {
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
const REPO = join(SCRATCH, 'repo');
const toBash = (p: string): string => p.replaceAll('\\', '/');

/** @description Run Git against the disposable repository with prompts and inherited hooks disabled. */
function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/** @description Commit the named paths and return the resulting commit SHA. */
function commit(message: string, paths: string[]): string {
  git('add', '--all', '--', ...paths);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/**
 * @description Create the disposable repository the gate scans, carrying this repo's REAL
 * `.gitleaks.toml` so the production allowlist is the one under test.
 * @returns Nothing; the repository is left at its first (clean) commit.
 */
function createRepo(): void {
  mkdirSync(join(REPO, 'src'), { recursive: true });
  mkdirSync(join(SCRATCH, 'no-hooks'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  git('config', 'user.name', 'OSHAL Maintainer');
  git('config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  git('config', 'core.hooksPath', toBash(join(SCRATCH, 'no-hooks')));
  copyFileSync(join(ROOT, '.gitleaks.toml'), join(REPO, '.gitleaks.toml'));
  writeFileSync(join(REPO, 'README.md'), '# secret-scan fixture\n');
  writeFileSync(join(REPO, 'src', 'app.ts'), 'export const ok = true;\n');
}

/**
 * @description The production gate text, sliced out of `scripts/ci-local.sh` so this guard runs
 * exactly what the nightly runs rather than a paraphrase of it.
 * @returns The `gitleaks_container_scan` and `gate_secrets` function bodies, concatenated.
 */
function gateSource(): string {
  return ['gitleaks_container_scan', 'gate_secrets'].map((name) => {
    const start = CI_SOURCE.indexOf(`${name}() {`);
    if (start < 0) throw new Error(`${name} is no longer in scripts/ci-local.sh`);
    return CI_SOURCE.slice(start, CI_SOURCE.indexOf('\n}\n', start) + 3);
  }).join('\n');
}

/**
 * @description Run the production `gate_secrets` over one commit, with the REAL docker on PATH.
 * @param sha - The commit to `git archive` and scan.
 * @param label - Stage name, used to give each run its own state directory.
 * @returns The gate's exit status and its combined stdout/stderr.
 */
function runGate(sha: string, label: string): StageRun {
  const stateDir = join(SCRATCH, `state-${label}`);
  mkdirSync(stateDir, { recursive: true });
  const probe = join(SCRATCH, `probe-${label}.sh`);
  writeFileSync(probe, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'REPO_DIR="$1"; SOURCE_SHA="$2"; STATE_DIR="$3"',
    'log() { printf \'LOG:%s\\n\' "$*"; }',
    'if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi',
    '. "$4"', '. "$5"',
    gateSource(),
    'gate_secrets',
  ].join('\n') + '\n');
  const result = spawnSync(
    BASH,
    [toBash(probe), toBash(REPO), sha, toBash(stateDir), PURGE_HELPER, SCAN_HELPER],
    { encoding: 'utf8', timeout: 600_000 },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** @description Read one stage's run, failing loudly rather than returning undefined. */
function stage(label: string): StageRun {
  const run = stages.get(label);
  if (!run) throw new Error(`stage ${label} did not run`);
  return run;
}

beforeAll(async () => {
  // One slot for the whole file: the scans run one at a time inside it, so this file contributes
  // at most one container to the machine-wide ceiling however the suite schedules it.
  slot = await acquireFixtureSlot('ci-local secret-scan planted-fixture proof');
  createRepo();
  stages.set('clean', runGate(commit('clean tree', ['.gitleaks.toml', 'README.md', 'src/app.ts']), 'clean'));

  writeFileSync(join(REPO, 'src', 'planted.ts'), `const deployKey = "${PLANTED_KEY_ID}";\n`);
  stages.set('planted', runGate(commit('plant the synthetic fixture', ['src/planted.ts']), 'planted'));

  rmSync(join(REPO, 'src', 'planted.ts'));
  writeFileSync(join(REPO, 'src', 'docs-key.ts'), `const documented = "${DOC_DUMMY_KEY_ID}";\n`);
  stages.set('allowlisted', runGate(commit('swap in the documentation dummy', ['src/planted.ts', 'src/docs-key.ts']), 'allowlisted'));

  rmSync(join(REPO, 'src', 'docs-key.ts'));
  stages.set('removed', runGate(commit('remove the fixture', ['src/docs-key.ts']), 'removed'));
}, 900_000);

afterAll(() => {
  slot?.release();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('secret-scan gate against the real gitleaks image: planted fixture, fail then pass', () => {
  it('passes the clean tree, and the verdict says the whole export was read', () => {
    const run = stage('clean');
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)');
  });

  it('goes RED on the planted credential-shaped fixture, with the scanner\'s own rc in the verdict', () => {
    const run = stage('planted');
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('secret-scan: FAIL scanner rc=1 unread=0 of 4 exported files');
    expect(run.output, 'the real image must report the finding it made').toContain('leaks found: 1');
  });

  it('stays GREEN on the AWS documentation dummy, so the RED above is the planted value and not the shape', () => {
    const run = stage('allowlisted');
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)');
  });

  it('returns to GREEN once the fixture is removed', () => {
    const run = stage('removed');
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)');
  });

  it('never prints the scanned value: the gate runs the scanner with --redact', () => {
    for (const label of ['clean', 'planted', 'allowlisted', 'removed']) {
      expect(stage(label).output, `${label} leaked the fixture value into the run log`)
        .not.toContain(PLANTED_KEY_ID);
    }
  });

  it('ran the real scanner, not a stand-in: every stage carries the image\'s own scan line', () => {
    for (const label of ['clean', 'planted', 'allowlisted', 'removed']) {
      expect(stage(label).output, `${label} has no gitleaks scan line`).toMatch(/scanned ~\d+ bytes/);
    }
  });
});
