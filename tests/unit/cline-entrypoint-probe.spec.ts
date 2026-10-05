/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Cline fallback entrypoint probe (scripts/check-cline-entrypoint.mjs) and the two places it is wired: the Dockerfile layer that pins cline and asserts the launcher starts INSIDE the build, and the deploy script's image-verify step. The verdict cases drive the real classifier on reports captured VERBATIM from the box on 2026-09-17: the shipped image (ENOENT on an existing glibc executable, no loader) and a container hot-fixed with unconfined gcompat. The docker boundary itself is not doubled here - it is crossed by `bash scripts/oshal-deploy.sh` on every deploy and was crossed by hand against the broken image, a broken container and a confined throwaway container the day this landed (see the PR and docs/governance/real-boundary-regression-audit.md).
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove the confined ARM64-musl abort stays UNAVAILABLE rather than PASS, reject incomplete or different failure reports, and execute the actual deploy image-verification block with isolated probe results.
 */

import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = path.resolve('scripts/check-cline-entrypoint.mjs');
const DEPLOY = path.resolve('scripts/oshal-deploy.sh');
const DOCKERFILE = path.resolve('Dockerfile.oshal');

/** @description Verbatim probe report from `oshal-bot:latest` on 2026-09-17 (the broken artifact). */
const BROKEN_IMAGE_REPORT = [
  'CLINE_PROBE_RC=1',
  'CLINE_PROBE_OUT_BEGIN',
  '[cline] Node 20.20.2 cannot read the OS trust store (needs >= 22.15); corporate or self-signed CAs may fail TLS. Upgrade Node or set NODE_EXTRA_CA_CERTS.',
  'spawnSync /usr/local/lib/node_modules/cline/bin/.cline ENOENT',
  'CLINE_PROBE_OUT_END',
  'CLINE_PROBE_BIN=present',
  'CLINE_PROBE_LOADER=missing',
  'CLINE_PROBE_ALIASES=',
  'CLINE_PROBE_LIBC=/lib/ld-musl-x86_64.so.1',
  '',
].join('\n');

/** @description Verbatim report from oshal-local-general-bot after an operator `apk add gcompat` (unconfined). */
const HOTFIXED_CONTAINER_REPORT = [
  'CLINE_PROBE_RC=0',
  'CLINE_PROBE_OUT_BEGIN',
  '3.0.62',
  'CLINE_PROBE_OUT_END',
  'CLINE_PROBE_BIN=present',
  'CLINE_PROBE_LOADER=present',
  'CLINE_PROBE_ALIASES= /lib/libc.so.6 /lib/libm.so.6 /lib/libpthread.so.0',
  'CLINE_PROBE_LIBC=/lib/ld-musl-x86_64.so.1',
  '',
].join('\n');

/** @description The shape the new Dockerfile layer produces: loader present, no aliases. */
const CONFINED_REPORT = HOTFIXED_CONTAINER_REPORT.replace(/^CLINE_PROBE_ALIASES=.*$/m, 'CLINE_PROBE_ALIASES=');

/** @description Captured ARM64 abort status with the additional architecture and confinement facts required by the probe. */
const ARM64_REPORT = [
  'CLINE_PROBE_ARCH=aarch64', 'CLINE_PROBE_RC=134',
  'CLINE_PROBE_OUT_BEGIN', '', 'CLINE_PROBE_OUT_END',
  'CLINE_PROBE_BIN=present', 'CLINE_PROBE_LOADER=present',
  'CLINE_PROBE_LOADER_PATH=/lib/ld-linux-aarch64.so.1',
  'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_LIBC=/lib/ld-musl-aarch64.so.1', '',
].join('\n');

type Probe = typeof import('../../scripts/check-cline-entrypoint.mjs');

/** @description Loads the ESM probe module once per file. */
async function probe(): Promise<Probe> {
  return (await import(pathToFileURL(PROBE).href)) as Probe;
}

/** @description Capture the real CLI verdict with only its Docker command boundary replaced. */
async function cliVerdict(report: string, quiet = false) {
  const { main } = await probe(), lines: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => { lines.push(String(value)); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(value => { lines.push(String(value)); return true; });
  try { return { status: main(['--image', 'fixture:arm64', ...(quiet ? ['--quiet'] : [])], () => report), text: lines.join('') }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

/** @description Resolve the existing bounded Git Bash identity on Windows; Linux uses its native shell. */
function hostBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const resolver = path.resolve('scripts/lib/windows-git-bash.ps1').replace(/'/g, "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${resolver}'; $selected = Resolve-OshalGitBash; if (-not $selected) { exit 2 }; [Console]::Out.Write($selected)`],
  { encoding: 'utf8', timeout: 30_000 });
  const candidate = result.stdout.trim();
  if (result.error || result.status !== 0 || !path.win32.isAbsolute(candidate)
      || /[\\/](?:system32|sysnative|syswow64)[\\/]|wsl\.exe$/i.test(candidate)) throw new Error('Validated Git Bash is required.');
  return candidate;
}

/** @description Execute the shipped image-verification block; only the probe process and log sink are stand-ins. */
function deployProbeVerdict(status: number) {
  const source = readFileSync(DEPLOY, 'utf8'), start = source.indexOf('if [ -f scripts/check-cline-entrypoint.mjs ]; then');
  const end = source.indexOf('\nfi\n', start);
  if (start < 0 || end < start) throw new Error('Cline deployment gate is missing.');
  return spawnSync(hostBash(), ['--noprofile', '--norc', '-c',
    'set -uo pipefail\nIMAGE=fixture:arm64\nRUN_LOG=/dev/null\n'
    + 'log() { printf "%s\\n" "$*"; }\nnode() { return "$CLINE_FIXTURE_RC"; }\ntimeout() { shift; "$@"; }\n'
    + source.slice(start, end + 4) + '\nprintf "CLASSIFICATION_REACHED\\n"'],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000, env: { ...process.env, CLINE_FIXTURE_RC: String(status) } });
}

describe('scripts/check-cline-entrypoint.mjs - the verdict on real reports', () => {
  it('names the ENOENT-on-an-existing-glibc-executable shape from the shipped image', async () => {
    const { parseProbeReport, classifyProbe } = await probe();
    const verdict = classifyProbe(parseProbeReport(BROKEN_IMAGE_REPORT));
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('glibc-binary-no-loader');
    expect(verdict.message).toContain('/usr/local/lib/node_modules/cline/bin/.cline');
    expect(verdict.message).toContain('/lib64/ld-linux-x86-64.so.2');
    expect(verdict.message).toContain('musl');
  });

  it('passes a running container that was hot-fixed with unconfined gcompat', async () => {
    const { parseProbeReport, classifyProbe } = await probe();
    const verdict = classifyProbe(parseProbeReport(HOTFIXED_CONTAINER_REPORT), { requireConfined: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('3.0.62');
    expect(verdict.message).toContain('unconfined');
  });

  it('refuses an IMAGE that starts cline by leaving glibc aliases in musl\'s search path', async () => {
    const { parseProbeReport, classifyProbe } = await probe();
    const verdict = classifyProbe(parseProbeReport(HOTFIXED_CONTAINER_REPORT), { requireConfined: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('unconfined-glibc-aliases');
    expect(verdict.message).toContain('/lib/libc.so.6');
  });

  it('passes the confined shape Dockerfile.oshal produces, under the image contract', async () => {
    const { parseProbeReport, classifyProbe } = await probe();
    const verdict = classifyProbe(parseProbeReport(CONFINED_REPORT), { requireConfined: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('confined gcompat loader');
  });

  it('distinguishes "no report" from "broken"', async () => {
    const { parseProbeReport, classifyProbe } = await probe();
    expect(classifyProbe(parseProbeReport('')).code).toBe('probe-did-not-run');
    const missingBin = BROKEN_IMAGE_REPORT.replace('CLINE_PROBE_BIN=present', 'CLINE_PROBE_BIN=missing');
    expect(classifyProbe(parseProbeReport(missingBin)).code).toBe('binary-missing');
    const reloc = BROKEN_IMAGE_REPORT
      .replace('spawnSync /usr/local/lib/node_modules/cline/bin/.cline ENOENT', 'Error relocating /usr/local/lib/node_modules/cline/bin/.cline: backtrace: symbol not found')
      .replace('CLINE_PROBE_LOADER=missing', 'CLINE_PROBE_LOADER=present');
    expect(classifyProbe(parseProbeReport(reloc)).code).toBe('glibc-symbols-unresolved');
  });

  it('never trusts exit 0 without a version line', async () => {
    const { parseProbeReport, classifyProbe } = await probe();
    const silent = CONFINED_REPORT.replace('3.0.62', 'something else entirely');
    expect(classifyProbe(parseProbeReport(silent)).ok).toBe(false);
  });

  it('reports the proved confined aarch64-musl abort as unavailable, never a working entrypoint', async () => {
    const { parseProbeReport, classifyProbe } = await probe();
    const verdict = classifyProbe(parseProbeReport(ARM64_REPORT));
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('arm64-musl-unavailable');
    expect(verdict.message).toContain('fallback unavailable');
    const cli = await cliVerdict(ARM64_REPORT, true);
    expect(cli.status).toBe(3);
    expect(cli.text).toContain('UNAVAILABLE');
    expect(cli.text).not.toMatch(/\bPASS\b|entrypoint starts/);
  });

  it.each([
    ['x86 abort', 'CLINE_PROBE_ARCH=aarch64', 'CLINE_PROBE_ARCH=x86_64'],
    ['missing architecture', 'CLINE_PROBE_ARCH=aarch64\n', ''],
    ['non-musl', '/lib/ld-musl-aarch64.so.1', '/lib/ld-linux-aarch64.so.1'],
    ['wrong musl architecture', '/lib/ld-musl-aarch64.so.1', '/lib/ld-musl-x86_64.so.1'],
    ['missing executable', 'CLINE_PROBE_BIN=present', 'CLINE_PROBE_BIN=missing'],
    ['missing executable check', 'CLINE_PROBE_BIN=present\n', ''],
    ['missing loader', 'CLINE_PROBE_LOADER=present', 'CLINE_PROBE_LOADER=missing'],
    ['wrong interpreter', 'CLINE_PROBE_LOADER_PATH=/lib/ld-linux-aarch64.so.1', 'CLINE_PROBE_LOADER_PATH=/lib64/ld-linux-x86-64.so.2'],
    ['missing interpreter path', 'CLINE_PROBE_LOADER_PATH=/lib/ld-linux-aarch64.so.1\n', ''],
    ['global glibc alias', 'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_ALIASES=/lib/libc.so.6'],
    ['global math alias', 'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_ALIASES=/lib/libm.so.6'],
    ['global pthread alias', 'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_ALIASES=/lib/libpthread.so.0'],
    ['global resolver alias', 'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_ALIASES=/lib/libresolv.so.2'],
    ['global realtime alias', 'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_ALIASES=/lib/librt.so.1'],
    ['global utility alias', 'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_ALIASES=/lib/libutil.so.1'],
    ['global crypt alias', 'CLINE_PROBE_ALIASES=', 'CLINE_PROBE_ALIASES=/lib/libcrypt.so.1'],
    ['missing confinement check', 'CLINE_PROBE_ALIASES=\n', ''],
    ['ordinary error', 'CLINE_PROBE_RC=134', 'CLINE_PROBE_RC=1'],
    ['killed process', 'CLINE_PROBE_RC=134', 'CLINE_PROBE_RC=137'],
    ['segmentation fault', 'CLINE_PROBE_RC=134', 'CLINE_PROBE_RC=139'],
    ['silent successful exit', 'CLINE_PROBE_RC=134', 'CLINE_PROBE_RC=0'],
    ['missing dependency', 'CLINE_PROBE_OUT_BEGIN\n', 'CLINE_PROBE_OUT_BEGIN\nspawnSync ENOENT\n'],
    ['unresolved symbols', 'CLINE_PROBE_OUT_BEGIN\n', 'CLINE_PROBE_OUT_BEGIN\nError relocating: symbol not found\n'],
  ])('does not accept %s as the supported ARM64 limitation', async (_name, before, after) => {
    const report = ARM64_REPORT.replace(before, after);
    const { parseProbeReport, classifyProbe } = await probe();
    const verdict = classifyProbe(parseProbeReport(report));
    expect(verdict.ok).toBe(false);
    expect(verdict.code).not.toBe('arm64-musl-unavailable');
    expect((await cliVerdict(report)).status).toBe(1);
  });

  it('still reports a genuinely working confined ARM64 launcher as PASS', async () => {
    const report = ARM64_REPORT.replace('CLINE_PROBE_RC=134', 'CLINE_PROBE_RC=0')
      .replace('CLINE_PROBE_OUT_BEGIN\n', 'CLINE_PROBE_OUT_BEGIN\n3.0.62\n');
    expect((await cliVerdict(report)).status).toBe(0);
    expect((await cliVerdict(report)).text).toContain('PASS');
  });
});

describe('scripts/check-cline-entrypoint.mjs - what it hands docker', () => {
  it('runs the real launcher through `sh -c` as ONE flat line: no heredoc, no here-string', async () => {
    const { buildProbeScript } = await probe();
    const script = buildProbeScript();
    expect(script).not.toContain('\n');
    expect(script).not.toContain('<<');
    expect(script).toContain('cline --version');
    expect(script).toContain('uname -m');
    expect(script).toContain('/lib/ld-linux-aarch64.so.1');
    expect(script).toContain('-x "/usr/local/lib/node_modules/cline/bin/.cline"');
  });

  it('probes an image with a throwaway container and a running container in place', async () => {
    const { runProbe } = await probe();
    const calls: string[][] = [];
    const runner = (file: string, args: string[]) => { calls.push([file, ...args]); return ''; };
    runProbe({ image: 'oshal-bot:latest', runner });
    runProbe({ container: 'oshal-local-general-bot', runner });
    expect(calls[0].slice(0, 3)).toEqual(['docker', 'run', '--rm']);
    expect(calls[0]).toContain('--entrypoint');
    expect(calls[0]).toContain('oshal-bot:latest');
    expect(calls[1].slice(0, 3)).toEqual(['docker', 'exec', 'oshal-local-general-bot']);
    expect(calls[1].slice(3, 5)).toEqual(['sh', '-c']);
  });

  it('exits 2 on a usage error, so a misspelled flag can never read as a green probe', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [PROBE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});

describe('where the probe is wired', () => {
  const deploySource = readFileSync(DEPLOY, 'utf8');
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');

  it('the deploy script refuses the image before any container is classified', () => {
    const call = deploySource.indexOf('node scripts/check-cline-entrypoint.mjs --image "$IMAGE"');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(deploySource.indexOf('check-kernel-skills.ts --image'));
    expect(call).toBeLessThan(deploySource.indexOf('Classify services by their compose-declared image'));
    const block = deploySource.slice(call, deploySource.indexOf('\n', deploySource.indexOf('IMAGE VERIFY FAILED: cline', call)));
    expect(block).toMatch(/exit 1/);
  });

  it.each([0, 3])('the deploy gate accepts probe exit %s with its exact honest verdict', status => {
    const result = deployProbeVerdict(status);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CLASSIFICATION_REACHED');
    expect(result.stdout).toContain(status === 0 ? 'entrypoint starts' : 'Cline fallback UNAVAILABLE');
    if (status === 3) expect(result.stdout).not.toMatch(/entrypoint starts|\bPASS\b/);
  });

  it.each([1, 2, 124, 137])('the deploy gate refuses probe exit %s before any recreation', status => {
    const result = deployProbeVerdict(status);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('IMAGE VERIFY FAILED');
    expect(result.stdout).not.toContain('CLASSIFICATION_REACHED');
  });

  it('the Dockerfile pins cline instead of floating @latest across a packaging change', () => {
    expect(dockerfile).toMatch(/^ARG CLINE_VERSION=\d+\.\d+\.\d+/m);
    expect(dockerfile).toContain('npm install -g "cline@${CLINE_VERSION}"');
    expect(dockerfile).not.toMatch(/npm install -g[^\n]*cline@latest/);
  });

  it('the Dockerfile asserts INSIDE the layer that the launcher starts and the loader is confined', () => {
    const start = dockerfile.indexOf('RUN apk add --no-cache gcompat');
    expect(start).toBeGreaterThan(0);
    const layer = dockerfile.slice(start, dockerfile.indexOf('\n\n', start));
    expect(layer).toContain('cline --version');
    expect(layer).toContain('"${CLINE_VERSION}"');
    expect(layer).toContain('mv /lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2');
    for (const alias of ['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libresolv.so.2', 'librt.so.1', 'libutil.so.1', 'libcrypt.so.1']) expect(layer).toContain(alias);
    expect(layer).toContain('exit 1');
    // A heredoc silently no-ops on the classic builder - the layer must not use one.
    expect(layer).not.toContain('<<');
  });
});
