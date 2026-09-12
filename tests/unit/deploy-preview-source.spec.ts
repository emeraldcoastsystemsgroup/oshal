/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise deployment source admission with real isolated Git remotes, pinned archives and preview image labels without invoking Docker or changing the working repository.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Execute the actual readiness function against synthetic log producers; heavy trailing logs must not hide a found marker and genuine log failures still refuse readiness.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const source = path.resolve('scripts/lib/deploy-source.sh');
const deploy = path.resolve('scripts/oshal-deploy.sh');
const scratchRoots: string[] = [];
let root: string, local: string, remote: string;

/** Resolve only the existing validated Git Bash boundary on Windows. */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const resolver = path.resolve('scripts/lib/windows-git-bash.ps1').replace(/'/g, "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${resolver}'; $selected = Resolve-OshalGitBash; if (-not $selected) { exit 2 }; [Console]::Out.Write($selected)`,
  ], { encoding: 'utf8', timeout: 30_000 });
  const candidate = result.stdout.trim();
  if (result.error || result.status !== 0 || !path.win32.isAbsolute(candidate)
    || /[\\/](?:system32|sysnative|syswow64)[\\/]|wsl\.exe$/i.test(candidate)) {
    throw new Error('A validated Git Bash executable is required for deployment source tests.');
  }
  return candidate;
}
const bash = resolveBash();

/** Git runs exclusively inside test-owned directories with signing/hooks disabled. */
function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=Deploy Fixture',
    '-c', 'user.email=deploy-fixture@example.invalid', '-C', directory, ...args],
  { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Create a real local origin with one published main and one published feature branch. */
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'deploy-preview-'));
  scratchRoots.push(root);
  local = path.join(root, 'local'); remote = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--initial-branch=main', local);
  writeFileSync(path.join(local, 'fixture.txt'), 'published main\n');
  git(local, 'add', 'fixture.txt'); git(local, 'commit', '-m', 'Synthetic main');
  git(local, 'remote', 'add', 'origin', remote); git(local, 'push', '-u', 'origin', 'main');
  git(local, 'switch', '-c', 'feat/preview');
  commit(local, 'published feature\n'); git(local, 'push', '-u', 'origin', 'feat/preview');
}, 30_000);

afterEach(() => {
  for (const candidate of scratchRoots.splice(0)) {
    expect(path.dirname(path.resolve(candidate))).toBe(path.resolve(tmpdir()));
    expect(path.basename(candidate)).toMatch(/^deploy-preview-/);
    rmSync(candidate, { recursive: true, force: true });
  }
});

/** Make a synthetic commit without touching repository application sources. */
function commit(directory: string, text: string): void {
  writeFileSync(path.join(directory, 'fixture.txt'), text);
  git(directory, 'add', 'fixture.txt'); git(directory, 'commit', '-m', 'Synthetic source update');
}

/** Run the production source helper with positional arguments, never shell-built paths. */
function check(preview = 1, allowUnpushed = 0, tail = '') {
  return spawnSync(bash, ['--noprofile', '--norc', '-c',
    'set -uo pipefail\nsource "$1"\noshal_deploy_source_preflight "$2" "$3" || { printf "%s\\n" "$DEPLOY_SOURCE_ERROR" >&2; exit 2; }\n'
      + (tail || 'printf "%s\\n" "$HEAD_SHA"'),
    'deploy-source-test', source.replace(/\\/g, '/'), String(preview), String(allowUnpushed)],
  { cwd: local, encoding: 'utf8', timeout: 15_000 });
}

it('accepts an exactly published feature tip and excludes mutable working-tree files', () => {
  const expected = git(local, 'rev-parse', 'HEAD');
  writeFileSync(path.join(local, 'fixture.txt'), 'uncommitted modification\n');
  writeFileSync(path.join(local, 'untracked.txt'), 'not deployment input\n');
  const result = check();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
});

it('refuses feature branches in the default release mode', () => {
  const result = check(0);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/not on main/);
});

it('refuses main in preview mode and rejects the emergency override combination', () => {
  expect(check(1, 1).stderr).toMatch(/cannot be combined/);
  expect(check(1, 1).status).toBe(2);
  git(local, 'switch', 'main');
  expect(check().stderr).toMatch(/requires a feature branch/);
  expect(check().status).toBe(2);
});

it('refuses an untracked feature even if a same-named origin branch exists', () => {
  git(local, 'branch', '--unset-upstream');
  const result = check();
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must track the same published branch/);
});

it('refuses an unpublished branch despite a manually configured upstream', () => {
  git(local, 'switch', '-c', 'feat/unpublished');
  git(local, 'config', 'branch.feat/unpublished.remote', 'origin');
  git(local, 'config', 'branch.feat/unpublished.merge', 'refs/heads/feat/unpublished');
  const result = check();
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/fresh origin branch tip is required/);
});

it('refuses local unpushed commits', () => {
  commit(local, 'unpublished change\n');
  const result = check();
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/differs from the fresh origin branch tip/);
});

it('fetches and rejects a remote-ahead tip rather than trusting its stale tracking ref', () => {
  const peer = path.join(root, 'peer');
  git(root, 'clone', '--branch', 'feat/preview', remote, peer);
  commit(peer, 'remote is ahead\n'); git(peer, 'push', 'origin', 'feat/preview');
  expect(git(local, 'rev-parse', 'origin/feat/preview')).toBe(git(local, 'rev-parse', 'HEAD'));
  const result = check();
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/differs from the fresh origin branch tip/);
  expect(git(local, 'rev-parse', 'origin/feat/preview')).toBe(git(peer, 'rev-parse', 'HEAD'));
});

it('refuses a deleted remote branch even when the cached origin ref still matches', () => {
  git(remote, 'update-ref', '-d', 'refs/heads/feat/preview');
  const result = check();
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/preview fetch failed/);
});

it('refuses failed refresh and detached HEAD without relying on cached equality', () => {
  git(local, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  expect(check().status).toBe(2);
  expect(check().stderr).toMatch(/preview fetch failed/);
  git(local, 'switch', '--detach');
  expect(check().status).toBe(2);
  expect(check().stderr).toMatch(/detached HEAD/);
});

it.each([
  ['branch.feat/preview.remote', 'another-remote'],
  ['branch.feat/preview.merge', 'refs/heads/main'],
])('refuses a mismatched tracking configuration: %s', (key, value) => {
  git(local, 'config', key, value);
  const result = check();
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/must track the same published branch/);
});

it('preserves normal main release admission and its existing emergency override', () => {
  git(local, 'switch', 'main');
  expect(check(0).status).toBe(0);
  commit(local, 'emergency main commit\n');
  expect(check(0).status).toBe(2);
  expect(check(0, 1).status).toBe(0);
});

it('preserves the existing main cached-tip fallback when its fetch fails', () => {
  git(local, 'switch', 'main');
  git(local, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  const result = check(0);
  expect(result.status).toBe(0);
  expect(result.stderr).toMatch(/last-known origin\/main/);
});

it('archives the captured SHA as LF bytes after HEAD changes', () => {
  git(local, 'config', 'core.autocrlf', 'true');
  const result = check(1, 0,
    'printf "later commit bytes\\n" > fixture.txt\ngit add -- fixture.txt\n'
    + 'git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false -c core.hooksPath= commit -m moved >/dev/null\n'
    + '[ "$(git rev-parse HEAD)" != "$HEAD_SHA" ] || exit 9\n'
    + 'printf "mutable bytes\\n" > fixture.txt\noshal_deploy_archive | tar -xOf - fixture.txt');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('published feature\n');
});

it('strictly checks preview image labels even when build is skipped, preserving default skip behavior', () => {
  const result = check(1, 0, [
    'oshal_deploy_image_label_matches 1 1 "$HEAD_SHA" || exit 10',
    'oshal_deploy_image_label_matches 1 1 wrong && exit 11',
    'oshal_deploy_image_label_matches 1 1 "" && exit 12',
    'oshal_deploy_image_label_matches 1 0 wrong && exit 13',
    'oshal_deploy_image_label_matches 0 0 wrong && exit 14',
    'oshal_deploy_image_label_matches 0 1 wrong || exit 15',
  ].join('\n'));
  expect(result.status, result.stderr).toBe(0);
});

it('wires the verified source, pinned archive and label gates into the actual deploy script', () => {
  const script = readFileSync(deploy, 'utf8');
  expect(script).toContain('--preview) PREVIEW=1');
  expect(script).toContain('oshal_deploy_source_preflight "$PREVIEW" "$ALLOW_UNPUSHED" || fail2');
  expect(script).toContain('if ! oshal_deploy_archive | timeout 3600 docker build');
  expect(script).not.toMatch(/git archive HEAD/);
  expect(script).toContain('if ! oshal_deploy_image_label_matches "$PREVIEW" "$SKIP_BUILD" "$LABEL"; then');
  for (const file of [source, deploy]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-n', file], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
  }
});

/** Exercise the real readiness function without Docker or repeated wall-clock polling. */
function readiness(logs: string) {
  const body = /^wait_api\(\) \{[\s\S]*?^\}/m.exec(readFileSync(deploy, 'utf8'))?.[0];
  if (!body) throw new Error('The actual wait_api function must exist.');
  const input = [
    'set -uo pipefail', 'API_CONTAINER=fixture',
    'log() { :; }', 'sleep() { :; }', 'seq() { printf 1; }',
    `docker() { if [ "$1" = inspect ]; then printf healthy; else ${logs}; fi; }`,
    body, 'wait_api',
  ].join('\n');
  return spawnSync(bash, ['--noprofile', '--norc', '-s'], { input, encoding: 'utf8', timeout: 10_000 });
}

it('recognizes actual startup readiness when a large log suffix follows the marker', () => {
  const result = readiness('printf "%s\\n" "Swarm app auto-load complete"; head -c 1048576 /dev/zero | tr "\\0" x');
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it('refuses actual startup readiness when the log marker is absent', () => {
  const result = readiness('printf "%s\\n" "ordinary startup output"');
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
});

it('refuses actual startup readiness when the log producer fails after emitting the marker', () => {
  const result = readiness('printf "%s\\n" "Swarm app auto-load complete"; return 17');
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
});
