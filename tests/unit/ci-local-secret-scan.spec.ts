/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run the production gate_secrets body in Git Bash against a disposable git repository with a stand-in docker on PATH that replays the installed gitleaks image's exact unreadable-path wording and exit 0, and prove the gate fails with the unread count in its verdict line, still fails on findings, still passes a clean scan, and always purges its export.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const PURGE_HELPER = join(ROOT, 'scripts', 'ci', 'ci-purge.sh').replaceAll('\\', '/');
const SCAN_HELPER = join(ROOT, 'scripts', 'ci', 'ci-secret-scan.sh').replaceAll('\\', '/');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-secret-scan-'));

/** Exactly what zricethezav/gitleaks v8.30.1 writes to stderr (color included, tty or not), probed 2026-09-14. */
const ESC = '';
const WRN_SKIPPED_FILE = `${ESC}[90m11:06PM${ESC}[0m ${ESC}[33mWRN${ESC}[0m ${ESC}[1mskipping file: permission denied${ESC}[0m ${ESC}[36mpath=${ESC}[0m/scan/config-seed/hidden.json`;
const WRN_SKIPPED_DIR = `${ESC}[90m11:06PM${ESC}[0m ${ESC}[33mWRN${ESC}[0m ${ESC}[1mskipping directory${ESC}[0m ${ESC}[36merror=${ESC}[0m${ESC}[31m${ESC}[1m"permission denied"${ESC}[0m${ESC}[0m ${ESC}[36mpath=${ESC}[0m/scan/src/private`;
const INF_SCANNED = `${ESC}[90m11:06PM${ESC}[0m ${ESC}[32mINF${ESC}[0m ${ESC}[1mscanned ~6 bytes (6 bytes) in 1.52s${ESC}[0m`;
const INF_NO_LEAKS = `${ESC}[90m11:06PM${ESC}[0m ${ESC}[32mINF${ESC}[0m ${ESC}[1mno leaks found${ESC}[0m`;
/** The mid-read failure the 2026-09-10 nightly recorded (5 of 5077 files), which also exits 0. */
const ERR_COULD_NOT_READ = '12:01AM ERR could not read file path=/scan/src/big.ts error="read /scan/src/big.ts: cannot allocate memory"';

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

/** @description Run Git against the disposable repository with prompts disabled. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/** @description A three-file committed tree the gate can git-archive, with the config path the scanner is pointed at. */
function createRepo(): { repo: string; sha: string } {
  const repo = join(SCRATCH, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'OSHAL Maintainer');
  git(repo, 'config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  writeFileSync(join(repo, '.gitleaks.toml'), 'title = "fixture"\n');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const ok = true;\n');
  git(repo, 'add', '--', '.gitleaks.toml', 'README.md', 'src/app.ts');
  git(repo, 'commit', '-q', '-m', 'fixture');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

/** @description The production gate text, sliced from ci-local.sh so the guard runs what the nightly runs. */
function gateSource(): string {
  const names = ['gitleaks_container_scan', 'gate_secrets'];
  return names.map((name) => {
    const start = CI_SOURCE.indexOf(`${name}() {`);
    if (start < 0) return '';
    return CI_SOURCE.slice(start, CI_SOURCE.indexOf('\n}\n', start) + 3);
  }).join('\n');
}

interface ScannerScript {
  stdout: string[];
  stderr: string[];
  exit: number;
}

interface GateRun {
  status: number | null;
  output: string;
  args: string;
  exportLeft: boolean;
}

/** @description Execute gate_secrets with a stand-in `docker` first on PATH that records its arguments and replays the scripted scanner output. */
function runGate(fixture: { repo: string; sha: string }, scanner: ScannerScript): GateRun {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stateDir = join(SCRATCH, `state-${id}`);
  const fakeBin = join(SCRATCH, `bin-${id}`);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  const say = (lines: string[], fd: string) => lines.map((line) => `printf '%s\\n' '${line}'${fd}`).join('\n');
  writeFileSync(join(fakeBin, 'docker'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"$(dirname "$0")/args.txt"\n${say(scanner.stdout, '')}\n${say(scanner.stderr, ' >&2')}\nexit ${scanner.exit}\n`);
  const probe = join(SCRATCH, `probe-${id}.sh`);
  writeFileSync(probe, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'REPO_DIR="$1"; SOURCE_SHA="$2"; STATE_DIR="$3"; FAKE_BIN="$4"',
    'chmod +x "$FAKE_BIN/docker"',
    // PATH entries must be POSIX-form under MSYS: a C:/... entry splits on its colon and the real docker wins.
    'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN="$(cygpath -u "$FAKE_BIN")"; fi',
    'export PATH="$FAKE_BIN:$PATH"',
    'command -v docker | grep -q "^$FAKE_BIN/docker$" || { echo "stand-in docker is not first on PATH: $(command -v docker)" >&2; exit 97; }',
    'log() { printf \'LOG:%s\\n\' "$*"; }',
    'if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi',
    '. "$5"', '. "$6"',
    gateSource(),
    'gate_secrets',
  ].join('\n') + '\n');
  const toBash = (p: string) => p.replaceAll('\\', '/');
  const result = spawnSync(BASH, [toBash(probe), toBash(fixture.repo), fixture.sha, toBash(stateDir), toBash(fakeBin), PURGE_HELPER, SCAN_HELPER], {
    encoding: 'utf8', timeout: 60_000,
  });
  const argsPath = join(fakeBin, 'args.txt');
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    args: existsSync(argsPath) ? readFileSync(argsPath, 'utf8') : '',
    exportLeft: existsSync(join(stateDir, 'ci-scan-src')),
  };
}

describe('secret-scan gate: a scan that skipped paths is not a PASS', () => {
  let fixture: { repo: string; sha: string };
  beforeAll(() => { fixture = createRepo(); });

  it('fails, with the unread count in its verdict line, when gitleaks reports skipped paths and exits 0', () => {
    const run = runGate(fixture, { stdout: [], stderr: [WRN_SKIPPED_FILE, WRN_SKIPPED_DIR, INF_SCANNED, INF_NO_LEAKS], exit: 0 });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('secret-scan: FAIL unread=2 of 3 exported files (scanner rc=0)');
    expect(run.exportLeft, 'ci-scan-src must be purged on the failure path too').toBe(false);
  }, 30_000);

  it('counts the mid-read failure wording the 2026-09-10 nightly recorded', () => {
    const run = runGate(fixture, { stdout: [], stderr: [ERR_COULD_NOT_READ, INF_SCANNED, INF_NO_LEAKS], exit: 0 });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('secret-scan: FAIL unread=1 of 3 exported files (scanner rc=0)');
  }, 30_000);

  it('still passes a clean scan, and says so with unread=0', () => {
    const run = runGate(fixture, { stdout: [], stderr: [INF_SCANNED, INF_NO_LEAKS], exit: 0 });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)');
    expect(run.output, 'the scanner stderr must still reach the run log').toContain('no leaks found');
    expect(run.exportLeft).toBe(false);
  }, 30_000);

  it('still fails on findings (scanner exit 1) and reports the scanner rc', () => {
    const run = runGate(fixture, { stdout: ['Finding:     token = REDACTED', 'File:        /scan/src/app.ts'], stderr: [`${ESC}[33mWRN${ESC}[0m leaks found: 1`], exit: 1 });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('secret-scan: FAIL scanner rc=1 unread=0 of 3 exported files');
    expect(run.exportLeft).toBe(false);
  }, 30_000);

  it('invokes the scanner exactly as production does: read-only export mount, no network, --no-git, the repo config, redaction', () => {
    const run = runGate(fixture, { stdout: [], stderr: [INF_NO_LEAKS], exit: 0 });
    expect(run.status, run.output).toBe(0);
    for (const fragment of ['run --rm --network none', ':/scan:ro', 'zricethezav/gitleaks:latest detect --source=/scan --no-git --config=/scan/.gitleaks.toml --redact']) {
      expect(run.args, run.args).toContain(fragment);
    }
  }, 30_000);
});
