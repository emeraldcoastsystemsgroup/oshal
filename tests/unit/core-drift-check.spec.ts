/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 guard for scripts/core-promote/core-drift-check.sh. The shipped script runs in Git Bash against a real release-dir clone of a real bare origin (so the release-dir HEAD, origin/main and the commits-behind count come from git itself), with docker as a stand-in serving image identities and the running api container. Pins the exit contract - 0 in sync, 1 drift, 2 unverifiable - for each drift leg (release dir vs running commit, env pin vs running image, pinned image's commit vs release dir, recorded image vs running image), for each unreadable leg, and that proven drift outranks an unreadable leg.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  REPO_ROOT, commitChange, git, makeRepo, posix, runScript, scratchDir, writeExec, type Run,
} from '../helpers/core-release-harness';

const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true }); });

const SCRIPT = path.join(REPO_ROOT, 'scripts/core-promote/core-drift-check.sh');
const ID1 = `sha256:${'1'.repeat(64)}`;
const ID2 = `sha256:${'2'.repeat(64)}`;

/** docker stand-in: images by ref, one api container, compose lookup by the two labels. */
const DOCKER_SHIM = [
  '#!/usr/bin/env bash',
  'state="$SHIM_STATE"',
  'fmt=\'{{.Id}}|{{index .Config.Labels "oshal.git.commit"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "oshal.release"}}\'',
  'key() { printf \'%s\' "$1" | tr \':/\' \'__\'; }',
  'case "$1" in',
  '  info) exit "${SHIM_DOCKER_INFO_RC:-0}" ;;',
  '  image) [ "$2 $3" = "inspect --format" ] && [ "$4" = "$fmt" ] || exit 97',
  '    [ -f "$state/img-$(key "$5")" ] || exit 1; cat "$state/img-$(key "$5")"; exit 0 ;;',
  '  ps) [ "$*" = "ps --filter label=com.docker.compose.project=$SHIM_PROJECT --filter label=com.docker.compose.service=oshal-api --format {{.ID}}" ] || exit 97',
  '    cat "$state/ps" 2>/dev/null; exit 0 ;;',
  '  inspect) [ "$2" = --format ] || exit 97',
  '    [ -f "$state/ctr-$4-image" ] || exit 1',
  '    case "$3" in',
  '      "{{.Image}}") cat "$state/ctr-$4-image" ;;',
  '      "{{range .Config.Env}}{{println .}}{{end}}") cat "$state/ctr-$4-env" ;;',
  '      *) exit 97 ;;',
  '    esac; exit 0 ;;',
  'esac',
  'exit 97',
];

interface Box { rel: string; bin: string; state: string; env: string; c1: string; c2: string }

function image(b: Box, ref: string, id: string, commit: string, release = '<no value>'): void {
  fs.writeFileSync(path.join(b.state, `img-${ref.replace(/[:/]/g, '_')}`), `${id}|${commit}|${commit}|${release}\n`);
}

function api(b: Box, name: string, id: string, env: string[]): void {
  fs.writeFileSync(path.join(b.state, `ctr-${name}-image`), `${id}\n`);
  fs.writeFileSync(path.join(b.state, `ctr-${name}-env`), `${['PATH=/usr/bin', ...env].join('\n')}\n`);
}

/** A box in sync: release dir, pin and running api all on c1 (core-2026.09.27); main is two commits ahead. */
function box(): Box {
  const root = scratchDir('oshal-drift-', cleanup);
  const repo = makeRepo(root, { 'README.md': 'fixture\n' });
  const c1 = git(repo.work, 'rev-parse', 'HEAD');
  const c2 = commitChange(repo.work, 'src/a.ts', 'export const a = 1;\n');
  commitChange(repo.work, 'src/b.ts', 'export const b = 1;\n');
  const rel = path.join(root, 'release');
  git(root, 'clone', '-q', posix(repo.origin), rel);
  git(rel, 'checkout', '-q', '--detach', c1);
  const b: Box = { rel, bin: path.join(root, 'bin'), state: path.join(root, 'state'), env: path.join(root, 'crm.env'), c1, c2 };
  fs.mkdirSync(b.state, { recursive: true });
  writeExec(path.join(b.bin, 'docker'), DOCKER_SHIM);
  fs.writeFileSync(b.env, `OSHAL_MANAGED_DEPLOYMENT_ID=crm-test\nOSHAL_BOT_IMAGE=oshal-bot:sha-${c1}\n`);
  image(b, `oshal-bot:sha-${c1}`, ID1, c1, 'core-2026.09.27');
  image(b, `oshal-bot:sha-${c2}`, ID2, c2);
  api(b, 'oshal-local-api', ID1, [`GIT_SHA=${c1}`, 'OSHAL_RELEASE=core-2026.09.27']);
  return b;
}

function check(b: Box, args: string[] = [], env: Record<string, string> = {}): Run {
  return runScript(SCRIPT, ['--release-dir', posix(b.rel), ...args], b.bin, { SHIM_STATE: posix(b.state), SHIM_PROJECT: 'crm-test', ...env });
}

let b: Box;
beforeEach(() => { b = box(); });

describe('core-drift-check.sh — the four legs and the verdict', () => {
  it('reports in sync (exit 0) and how far the running commit is behind main, which is not drift', () => {
    const r = check(b, ['--env-file', posix(b.env), '--expect-image-id', ID1, '--expect-release', 'core-2026.09.27']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('IN SYNC');
    expect(r.out).toContain('the running commit is 2 commit(s) behind main');
    expect(r.out).toContain(`GIT_SHA ${b.c1.slice(0, 12)}, release core-2026.09.27`);
    expect(r.out).toContain(`oshal-bot:sha-${b.c1} -> image ${'1'.repeat(12)}`);
  });

  it('names a release dir that moved without a deploy (exit 1)', () => {
    git(b.rel, 'checkout', '-q', '--detach', b.c2);
    const r = check(b);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`drift: the release dir is at ${b.c2.slice(0, 12)} but the running api was built from ${b.c1.slice(0, 12)}`);
  });

  it('names an env pin the running api is not on (exit 1)', () => {
    fs.writeFileSync(b.env, `OSHAL_BOT_IMAGE=oshal-bot:sha-${b.c2}\n`);
    const r = check(b, ['--env-file', posix(b.env)]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`the env file pins image ${'2'.repeat(12)} but the api runs ${'1'.repeat(12)}`);
    expect(r.out).toContain(`the pinned image was built from ${b.c2.slice(0, 12)} but the release dir is at ${b.c1.slice(0, 12)}`);
  });

  it('names a running image the release history did not record (a hand retag) (exit 1)', () => {
    const r = check(b, ['--expect-image-id', ID2]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`the release history records image ${'2'.repeat(12)} but the api runs ${'1'.repeat(12)}`);
  });

  it('finds the api by compose project and service label on a managed box', () => {
    api(b, 'abc123', ID1, [`GIT_SHA=${b.c1}`]);
    fs.writeFileSync(path.join(b.state, 'ps'), 'abc123\n');
    const r = check(b, ['--compose-project', 'crm-test', '--no-fetch']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('abc123 image');
  });

  it('keeps comparing against the last-known main when the fetch fails, and says so', () => {
    git(b.rel, 'remote', 'set-url', 'origin', posix(path.join(b.state, 'no-such-origin.git')));
    const r = check(b);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('(fetch failed - last-known origin/main)');
  });
});

describe('core-drift-check.sh — an unreadable leg is unverified, never "in sync"', () => {
  it.each([
    ['docker unreachable', () => ({ SHIM_DOCKER_INFO_RC: '1' }), 'docker is not reachable'],
    ['no api container', () => { fs.rmSync(path.join(b.state, 'ctr-oshal-local-api-image')); return {}; }, 'is not running or unreadable'],
    ['image built outside the pipeline', () => { api(b, 'oshal-local-api', ID1, ['GIT_SHA=unknown']); return {}; }, 'carries no GIT_SHA'],
    ['compose project with no api', () => ({}), 'no single running api container'],
  ])('%s -> exit 2', (label, arrange, message) => {
    const env = arrange();
    const args = label === 'compose project with no api' ? ['--compose-project', 'crm-test'] : [];
    const r = check(b, args, env as Record<string, string>);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('UNVERIFIED');
    expect(r.out).toContain(message);
    expect(r.out).not.toContain('IN SYNC');
  });

  it('reports a pinned image that is not on the engine as unverified', () => {
    fs.writeFileSync(b.env, `OSHAL_BOT_IMAGE=oshal-bot:sha-${'f'.repeat(40)}\n`);
    const r = check(b, ['--env-file', posix(b.env)]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('is not present on this engine');
  });

  it('lets proven drift outrank an unreadable leg (exit 1, both named)', () => {
    git(b.rel, 'checkout', '-q', '--detach', b.c2);
    fs.writeFileSync(b.env, `OSHAL_BOT_IMAGE=oshal-bot:sha-${'f'.repeat(40)}\n`);
    const r = check(b, ['--env-file', posix(b.env)]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('drift: the release dir is at');
    expect(r.out).toContain('unverified: pinned image');
  });
});
