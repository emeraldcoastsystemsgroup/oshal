/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com    | Exercise the real host parity script against transient, persistent and genuine image-ID differences.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';

const script = resolve(__dirname, '..', '..', 'scripts', 'deploy-parity-check.sh');
const scratch = mkdtempSync(join(tmpdir(), 'oshal-parity-inspect-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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
  throw new Error('Git Bash not found; refusing a different shell namespace');
}

const bash = resolveBash();
const imageA = `sha256:${'a'.repeat(64)}`;
const imageB = `sha256:${'b'.repeat(64)}`;

function run(mode: 'transient' | 'missing' | 'mismatch') {
  const bin = join(scratch, `${mode}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'count.txt'), '0');
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    'here="$(dirname "$0")"',
    'case "$1" in',
    '  info) exit 0 ;;',
    '  ps) printf "api\\nmovies\\n"; exit 0 ;;',
    '  inspect)',
    '    if [ "$4" = "{{range .Config.Env}}{{println .}}{{end}}" ]; then',
    '      if [ "$2" = api ]; then echo BOT_RUNTIME=swarm; else echo BOT_RUNTIME=bot-node; fi',
    '      exit 0',
    '    fi',
    '    if [ "$4" = "{{.Created}}" ]; then echo 2026-09-26T00:00:00Z; exit 0; fi',
    '    if [ "$4" = "{{.Image}}" ]; then',
    `      if [ "$2" = api ]; then echo '${imageA}'; exit 0; fi`,
    '      n=$(cat "$here/count.txt"); n=$((n + 1)); printf %s "$n" >"$here/count.txt"',
    '      if [ "$PARITY_MODE" = transient ] && [ "$n" -eq 1 ]; then exit 1; fi',
    '      if [ "$PARITY_MODE" = missing ]; then exit 1; fi',
    `      if [ "$PARITY_MODE" = mismatch ]; then echo '${imageB}'; else echo '${imageA}'; fi`,
    '      exit 0',
    '    fi ;;',
    'esac',
    'exit 97',
  ].join('\n') + '\n');
  const probe = join(bin, 'probe.sh');
  writeFileSync(probe, [
    '#!/usr/bin/env bash',
    'bin="$1"; target="$2"',
    'if command -v cygpath >/dev/null 2>&1; then bin="$(cygpath -u "$bin")"; target="$(cygpath -u "$target")"; fi',
    'chmod +x "$bin/docker"',
    'export PATH="$bin:$PATH"',
    'command -v docker | grep -q "^$bin/docker$" || exit 98',
    'bash "$target" --quiet',
  ].join('\n') + '\n');
  const result = spawnSync(bash, [probe.replaceAll('\\', '/'), bin.replaceAll('\\', '/'), script.replaceAll('\\', '/')], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, PARITY_MODE: mode },
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    reads: Number(readFileSync(join(bin, 'count.txt'), 'utf8')) };
}

describe('deploy parity image reads', () => {
  it('retries a transient unreadable bot image and accepts matching verified IDs', () => {
    const result = run('transient');
    expect(result.status, result.output).toBe(0);
    expect(result.reads).toBe(2);
    expect(result.output).not.toContain('DEPLOY DRIFT');
  });

  it('classifies a persistently unreadable image as unverified, not drift', () => {
    const result = run('missing');
    expect(result.status, result.output).toBe(2);
    expect(result.reads).toBe(3);
    expect(result.output).toContain('parity UNVERIFIED');
    expect(result.output).not.toContain('DEPLOY DRIFT');
  });

  it('still refuses a genuine, fully read image mismatch', () => {
    const result = run('mismatch');
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('DEPLOY DRIFT');
    expect(result.output).toContain(imageB.slice(7, 19));
  });
});
