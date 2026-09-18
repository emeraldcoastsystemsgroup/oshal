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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cover the CALLER, which had no coverage at all: deleting the `--failed` forwarding from ci-local.sh left this file 8/8 green, so the refusal that matters most - a red run never reaching the publish script - rested on reading the code. The production publish block is now sliced out of the shipped ci-local.sh and driven with recording stand-ins, the way ci-local-inherited-export.spec.ts drives the gate sequence. Also pins both push-failure registry states rather than one wording, the logout on the failure path, and the dangling-flag refusal.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Every case is pinned to a nonexistent OSHAL_GHCR_ENV_FILE so no test can read the checkout's real .env; two cases cross the publisher boundary itself - the real script logs in with a credential read from a scratch .env, and refuses with no registry call when there is neither .env nor environment; three cases pin the scheduled source-posture refusal (unpinned HEAD refused, pinned origin/main allowed, interactive left to the operator).
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
  return runWith(args, process.env as Record<string, string>, env);
}

/**
 * @description Same as run(), but over an explicit base environment so a case can DELETE a name
 * rather than only override it.
 * @param args - Arguments for the publish script.
 * @param base - The complete base environment.
 * @param env - Overrides applied on top of the base.
 * @returns Exit status, combined output, and the docker argv the script produced.
 */
function runWith(args: string[], base: Record<string, string>, env: Record<string, string>): Run {
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
    // Every case is pinned to a nonexistent env file unless it says otherwise, so no test can
    // ever read the checkout's real .env (the operator trunk holds a live token).
    env: {
      ...base,
      OSHAL_GHCR_ENV_FILE: path.join(dir, 'no-such.env'),
      ...env,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
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

  it('reads the credential from .env when the environment does not carry it - the publisher, not just the library', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-image-env-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, `OSHAL_GHCR_TOKEN="${TOKEN}"\r\nOSHAL_GHCR_USER='scratch-org'\r\n`);
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.OSHAL_GHCR_TOKEN;
    delete env.OSHAL_GHCR_USER;
    const r = runWith([...OK_ARGS], env, { OSHAL_GHCR_ENV_FILE: envFile });
    expect(r.calls[0], 'the publisher did not log in with the .env credential').toBe(`login ghcr.io --username scratch-org --password-stdin`);
    expect(r.out, 'the token reached the output').not.toContain(TOKEN);
  });

  it('an explicit EMPTY value refuses even when .env holds a credential - blanking isolates a process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-image-blank-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, `OSHAL_GHCR_TOKEN=${TOKEN}
OSHAL_GHCR_USER=scratch-org
`);
    const r = run([...OK_ARGS], { OSHAL_GHCR_TOKEN: '', OSHAL_GHCR_USER: '', OSHAL_GHCR_ENV_FILE: envFile });
    expect(r.status, 'a blanked credential was back-filled from .env').toBe(3);
    expect(r.calls).toEqual([]);
  });

  it('still refuses, reaching no registry, when there is no .env and no environment credential', () => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.OSHAL_GHCR_TOKEN;
    delete env.OSHAL_GHCR_USER;
    const r = runWith([...OK_ARGS], env, {});
    expect(r.status).toBe(3);
    expect(r.calls).toEqual([]);
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

  it('fails the run and says what the registry is actually left holding', () => {
    // One message for three different states was wrong in two of them. The sha- push failing
    // means NOTHING was published; only a failing `latest` push leaves a half-published registry,
    // and that is the one case where someone has to go look.
    const early = run([...OK_ARGS], { ...CREDS, DOCKER_FAIL_ON: `push ${REMOTE}:sha-` });
    expect(early.status).not.toBe(0);
    expect(early.out).toContain(`FAILED at 'push sha-${SHA}'`);
    expect(early.out).toContain('nothing reached ghcr.io');

    const late = run([...OK_ARGS], { ...CREDS, DOCKER_FAIL_ON: `push ${REMOTE}:latest` });
    expect(late.status).not.toBe(0);
    expect(late.out).toContain("FAILED at 'push latest'");
    expect(late.out).toContain('latest still names the PREVIOUS image');
  });

  it('clears the credential even when the push fails', () => {
    // The logout is a trap, not a line the happy path walks past: a kill between the login and
    // the push used to leave the token in ~/.docker/config.json.
    const r = run([...OK_ARGS], { ...CREDS, DOCKER_FAIL_ON: 'push' });
    expect(r.calls.some((c) => c === 'logout ghcr.io'), 'no logout on the failure path').toBe(true);
  });

  it('refuses a flag with no value instead of spinning on it', () => {
    // `shift 2` with one positional left returns 1 WITHOUT shifting, and there is no `set -e`.
    const r = run(['--sha'], CREDS);
    expect(r.status).toBe(64);
    expect(r.out).toContain('--sha needs a value');
    expect(r.calls).toEqual([]);
  });
});

describe('ci-local.sh refuses before it ever reaches the publish script', () => {
  // The review's fourth mutation: deleting the caller's `--failed` forwarding left this file 8/8
  // green, because nothing here touched ci-local.sh. The caller's own refusal was defended by
  // reading the code. This drives the production block, sliced by its real markers.
  const CI_SOURCE = fs.readFileSync(path.resolve(process.cwd(), 'scripts/ci-local.sh'), 'utf8');

  /**
   * @description Slices the publish decision out of the shipped ci-local.sh.
   * @returns The production block, from the flag test to its closing fi.
   */
  function publishBlock(): string {
    const start = CI_SOURCE.indexOf('if [ "$PUBLISH_IMAGE" = "1" ]; then');
    expect(start, 'the publish block is no longer in ci-local.sh').toBeGreaterThanOrEqual(0);
    const end = CI_SOURCE.indexOf('\nfi\n', start);
    expect(end, 'the publish block is unterminated').toBeGreaterThan(start);
    return CI_SOURCE.slice(start, end + 4);
  }

  interface CallerRun { out: string; ran: boolean; forwarded: string }

  /**
   * @description Runs the real publish block with recording stand-ins for run_gate and the script.
   * @param vars - Shell assignments for the block's inputs (PUBLISH_IMAGE, SKIP_IMAGE, SKIP_E2E, FAILED_GATES).
   * @returns Whether the publish gate ran, and what it would have forwarded.
   */
  function runCaller(vars: string): CallerRun {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-local-publish-'));
    const marker = path.join(dir, 'ran.txt').replace(/\\/g, '/');
    const harness = [
      'set -uo pipefail',
      'log() { printf "%s\\n" "$*"; }',
      // Stand in for run_gate and for the gate body: record that the publish was reached at all.
      `run_gate() { printf 'RAN %s\\n' "$1" >> '${marker}'; gate_publish_image; }`,
      `gate_publish_image() { printf 'FORWARDED [%s]\\n' "\${FAILED_GATES[*]-}" >> '${marker}'; }`,
      vars,
      publishBlock(),
      'printf "FINAL_FAILED [%s]\\n" "${FAILED_GATES[*]-}"',
    ].join('\n');
    const script = path.join(dir, 'harness.sh');
    fs.writeFileSync(script, `${harness}\n`);
    const r = spawnSync(BASH, [script.replace(/\\/g, '/')], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
    const recorded = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    return {
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      ran: recorded.includes('RAN publish-image'),
      forwarded: recorded,
    };
  }

  it('does not reach the publish script when the run is red', () => {
    const r = runCaller('PUBLISH_IMAGE=1; SKIP_IMAGE=0; SKIP_E2E=0; FAILED_GATES=(trivy)');
    expect(r.ran, 'a red run reached the publish script').toBe(false);
    expect(r.out).toContain('the run is red');
  });

  it('does not reach it on a scheduled run that fell back to local HEAD', () => {
    const r = runCaller('PUBLISH_IMAGE=1; SKIP_IMAGE=0; SKIP_E2E=0; SCHEDULED=1; SOURCE_POSTURE=DEGRADED_FETCH_FAILED_HEAD_FALLBACK; FAILED_GATES=()');
    expect(r.ran, 'an unpinned scheduled run reached the publish script').toBe(false);
    expect(r.out).toContain('not pinned to origin/main');
    expect(r.out).toContain('FINAL_FAILED [publish-image-refused-unpinned-source]');
  });

  it('reaches it on a scheduled run pinned to origin/main', () => {
    const r = runCaller('PUBLISH_IMAGE=1; SKIP_IMAGE=0; SKIP_E2E=0; SCHEDULED=1; SOURCE_POSTURE=scheduled-origin-main; FAILED_GATES=()');
    expect(r.ran).toBe(true);
  });

  it('leaves an interactive run to the operator', () => {
    const r = runCaller('PUBLISH_IMAGE=1; SKIP_IMAGE=0; SKIP_E2E=0; SCHEDULED=0; SOURCE_POSTURE=interactive-head; FAILED_GATES=()');
    expect(r.ran).toBe(true);
  });

  it('does not reach it when the image was never built', () => {
    const r = runCaller('PUBLISH_IMAGE=1; SKIP_IMAGE=1; SKIP_E2E=0; FAILED_GATES=()');
    expect(r.ran).toBe(false);
    expect(r.out).toContain('--skip-image was set');
    expect(r.out).toContain('publish-image-refused-no-image');
  });

  it('does not reach it when the e2e gate never ran', () => {
    const r = runCaller('PUBLISH_IMAGE=1; SKIP_IMAGE=0; SKIP_E2E=1; FAILED_GATES=()');
    expect(r.ran).toBe(false);
    expect(r.out).toContain('--skip-e2e was set');
  });

  it('does nothing at all without the flag', () => {
    const r = runCaller('PUBLISH_IMAGE=0; SKIP_IMAGE=0; SKIP_E2E=0; FAILED_GATES=()');
    expect(r.ran).toBe(false);
    expect(r.out).not.toContain('refused');
  });

  it('forwards the real failed list to the script that holds the credential', () => {
    // Defence in depth, tested on its own terms. The caller refuses a red run before this point,
    // so no test THROUGH the caller can observe a non-empty --failed — which is why deleting the
    // forwarding was invisible. This drives the gate function directly with a list the caller
    // would never pass, because the day the caller check is removed, this is the layer left.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-local-forward-'));
    const record = path.join(dir, 'argv.txt').replace(/\\/g, '/');
    fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'ci', 'publish-image.sh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${record}'\nexit 2\n`);

    const start = CI_SOURCE.indexOf('gate_publish_image() {');
    expect(start, 'gate_publish_image is no longer in ci-local.sh').toBeGreaterThanOrEqual(0);
    const body = CI_SOURCE.slice(start, CI_SOURCE.indexOf('\n}\n', start) + 3);

    const script = path.join(dir, 'harness.sh');
    fs.writeFileSync(script, [
      'set -uo pipefail',
      'log() { printf "%s\\n" "$*"; }',
      `REPO_DIR='${dir.replace(/\\/g, '/')}'`,
      `SOURCE_SHORT_SHA='${SHA}'`,
      `OSHAL_CI_GHCR_IMAGE='${REMOTE}'`,
      'FAILED_GATES=(trivy image-smoke)',
      body,
      'gate_publish_image',
    ].join('\n') + '\n');

    const r = spawnSync(BASH, [script.replace(/\\/g, '/')], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
    const argv = fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '';
    expect(argv, 'the gate never invoked publish-image.sh').not.toBe('');
    expect(argv, 'the failed list was not forwarded — the second layer is gone')
      .toContain('--failed trivy image-smoke');
    expect(argv).toContain(`--sha ${SHA}`);
    expect(r.status, 'a refusing publish script must fail the gate').not.toBe(0);
  });

  it('reaches it on an all-green run, and forwards the empty failed list', () => {
    const r = runCaller('PUBLISH_IMAGE=1; SKIP_IMAGE=0; SKIP_E2E=0; FAILED_GATES=()');
    expect(r.ran, 'a green run did not reach the publish script').toBe(true);
    // Deleting the forwarding was the mutation this file used to miss entirely.
    expect(r.forwarded).toContain('FORWARDED []');
  });
});
