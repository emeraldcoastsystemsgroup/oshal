/**
 * Guard for the image publish step.
 *
 * The defect this exists to prevent is not "the push fails" — it is "something gets published
 * that should not have been". Three shapes of that: a red run publishing anyway, a push tagged
 * with something other than the commit the image was built from, and the credential leaking into
 * a log or a process table. Each case below drives the REAL script through a real bash with a
 * stand-in `docker` on PATH that records its argv, so the assertions are about what was actually
 * asked of the registry, not about the script's text.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — covers the four refusals (red run, unpinned sha, missing credential, missing arguments), the success path's tag/push ORDER (the immutable sha- tag is pushed before `latest`, so a run that dies between the two never leaves `latest` pointing at something the registry has no record of), a failing push, and the secret discipline: the token reaches docker only on stdin and appears in neither the script's output nor any command line.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.resolve(process.cwd(), 'scripts/ci/publish-image.sh');
const BASH_RESOLVER = path.resolve(process.cwd(), 'scripts/lib/windows-git-bash.ps1');
const RESOLVE_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 60_000;
/** A value that would be catastrophic to print; every case asserts it never appears. */
const TOKEN = 'ghp_TESTONLY_not_a_real_credential_0123456789';
const REMOTE = 'ghcr.io/example-org/oshal-bot';
const SHA = 'abc1234def56';

/** Quote one value as a literal PowerShell single-quoted string. */
function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Reject every Windows shell path that could enter WSL or depend on PATH ambiguity. */
function requireSafeWindowsBash(candidate: string): string {
  const subsystemBash = /[\\/](?:system32|sysnative|syswow64)[\\/]bash\.exe$/i;
  const wslLauncher = /(?:^|[\\/])wsl\.exe$/i;
  if (!path.win32.isAbsolute(candidate) || subsystemBash.test(candidate) || wslLauncher.test(candidate)) {
    throw new Error(`refusing unsafe Windows Bash candidate: ${candidate || '<empty>'}`);
  }
  return candidate;
}

/**
 * @description Resolves Bash through the production identity probe on Windows so the guard cannot
 * silently cross into another filesystem namespace, and fails closed on any probe error.
 * @returns An absolute path to a validated bash, or 'bash' off Windows.
 */
function resolveHostBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const command = `. ${quotePowerShellLiteral(BASH_RESOLVER)}; $selected = Resolve-OshalGitBash; `
    + 'if (-not $selected) { Write-Error "No validated Git Bash found"; exit 2 }; '
    + '[Console]::Out.Write($selected)';
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', timeout: RESOLVE_TIMEOUT_MS });
  if (probe.status !== 0) throw new Error(`Git Bash probe failed: ${probe.stderr || probe.status}`);
  return requireSafeWindowsBash((probe.stdout || '').trim());
}

let BASH = '';
beforeAll(() => { BASH = resolveHostBash(); });

interface Run {
  status: number | null;
  out: string;
  /** One line per `docker` invocation, in the order the script made them. */
  calls: string[];
}

/**
 * @description Runs the real publish script with a recording stand-in for `docker` first on PATH.
 * @param args - Arguments for publish-image.sh.
 * @param env - Extra environment (the credential pair, and DOCKER_FAIL_ON to make a call fail).
 * @returns Exit status, combined output, and the docker argv the script produced.
 */
function run(args: string[], env: Record<string, string> = {}): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-image-'));
  const log = path.join(dir, 'docker-calls.log');
  // `login` consumes the credential from stdin and throws it away: the stand-in must never
  // record it, because the point of --password-stdin is that the secret has exactly one path.
  fs.writeFileSync(path.join(dir, 'docker'),
    '#!/usr/bin/env bash\n'
    + 'if [ "${1:-}" = "login" ]; then cat >/dev/null; fi\n'
    + `printf '%s\\n' "$*" >> '${log.replace(/\\/g, '/')}'\n`
    + 'if [ -n "${DOCKER_FAIL_ON:-}" ] && printf %s "$*" | grep -q -- "$DOCKER_FAIL_ON"; then exit 1; fi\n'
    + 'exit 0\n', { mode: 0o755 });
  const r = spawnSync(BASH, [SCRIPT.replace(/\\/g, '/'), ...args], {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, ...env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '')
    : [];
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls };
}

const CREDS = { OSHAL_GHCR_TOKEN: TOKEN, OSHAL_GHCR_USER: 'example-org' };
const OK_ARGS = ['--sha', SHA, '--local', 'oshal-ci:latest', '--remote', REMOTE];

describe('publish-image.sh refuses before it reaches the registry', () => {
  it('publishes nothing when the run is red', () => {
    const r = run([...OK_ARGS, '--failed', 'unit trivy'], CREDS);
    expect(r.status).toBe(2);
    expect(r.calls, 'a red run reached docker').toEqual([]);
    expect(r.out).toContain('the run is red');
  });

  it('publishes nothing without a credential', () => {
    const r = run([...OK_ARGS], { OSHAL_GHCR_TOKEN: '', OSHAL_GHCR_USER: '' });
    expect(r.status).toBe(3);
    expect(r.calls, 'an unauthenticated run reached docker').toEqual([]);
  });

  it('refuses a tag that is not the pinned commit', () => {
    const r = run(['--sha', 'not-a-sha', '--local', 'oshal-ci:latest', '--remote', REMOTE], CREDS);
    expect(r.status).toBe(4);
    expect(r.calls).toEqual([]);
  });

  it('refuses when the local tag or the remote is missing', () => {
    expect(run(['--sha', SHA, '--remote', REMOTE], CREDS).status).toBe(64);
    expect(run(['--sha', SHA, '--local', 'oshal-ci:latest'], CREDS).status).toBe(64);
  });
});

describe('publish-image.sh on an all-green run', () => {
  it('pushes the immutable sha tag BEFORE latest', () => {
    const r = run([...OK_ARGS, '--failed', ''], CREDS);
    expect(r.status, r.out).toBe(0);
    const pushes = r.calls.filter((c) => c.startsWith('push '));
    // If the run dies between the two, the registry must already hold a record of WHAT was
    // published rather than a `latest` pointing at an untagged image.
    expect(pushes).toEqual([`push ${REMOTE}:sha-${SHA}`, `push ${REMOTE}:latest`]);
    expect(r.calls.some((c) => c === `tag oshal-ci:latest ${REMOTE}:sha-${SHA}`)).toBe(true);
    expect(r.calls.some((c) => c === `tag oshal-ci:latest ${REMOTE}:latest`)).toBe(true);
  });

  it('authenticates on stdin and logs out again', () => {
    const r = run([...OK_ARGS], CREDS);
    expect(r.calls[0]).toBe('login ghcr.io --username example-org --password-stdin');
    expect(r.calls.some((c) => c === 'logout ghcr.io')).toBe(true);
  });

  it('never puts the credential on a command line or in its output', () => {
    const r = run([...OK_ARGS], CREDS);
    expect(r.calls.join('\n'), 'the token reached a docker command line').not.toContain(TOKEN);
    expect(r.out, 'the token reached the script output').not.toContain(TOKEN);
    // Length is the only thing about a secret this project will ever report.
    expect(r.out).not.toContain(TOKEN.slice(0, 12));
  });

  it('fails the run when a push fails, and says latest may be behind', () => {
    const r = run([...OK_ARGS], { ...CREDS, DOCKER_FAIL_ON: 'push' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('the push did not complete');
  });
});
