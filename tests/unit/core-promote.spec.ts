/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 guard for scripts/core-promote/promote.sh, the dev-box driver. The shipped script runs in Git Bash with docker (the cut artifact and its save stream) and ssh (the box: its image store, docker load / pull, and the box helper's exit code) as recording stand-ins; gzip is real, so the streamed bytes are the ones the box side unpacks. Pins the promotion contract: the same image ID moves (stream or pull by digest) and is proved on the box before its helper runs; production refuses without a staging receipt for that image ID and a staging promote writes one only on a verified exit 0; a second build under the same tag, a lost local artifact, a failed or mismatched transfer, and an unreachable box each stop before the helper runs; and the helper's exit codes map 1 / 2 / 3 / 127 / 255 the way the header documents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, posix, readOr, runScript, scratchDir, writeExec, type Run } from '../helpers/core-release-harness';

/** Each case spawns Git Bash and a pipeline of stand-ins: slow on a loaded Windows host. */
const SHELL_CASE_TIMEOUT_MS = 120_000;
const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true }); });

const SCRIPT = path.join(REPO_ROOT, 'scripts/core-promote/promote.sh');
const RELEASE = 'core-2026.09.28';
const COMMIT = 'c'.repeat(40);
const ID = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const HELPER = `bash /opt/customer/oshal/scripts/managed-core-release.sh /opt/customer/crm.env`;

const LOCAL_DOCKER = [
  '#!/usr/bin/env bash',
  'state="$SHIM_STATE"',
  'fmt=\'{{.Id}}|{{index .Config.Labels "oshal.git.commit"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "oshal.release"}}\'',
  'case "$1" in',
  '  image) [ "$2 $3" = "inspect --format" ] || exit 97',
  '    [ -f "$state/local-image" ] || exit 1',
  '    if [ "$4" = "$fmt" ]; then cat "$state/local-image"; exit 0; fi',
  '    if [ "$4" = "{{range .RepoDigests}}{{println .}}{{end}}" ]; then cat "$state/local-digests" 2>/dev/null; exit 0; fi',
  '    exit 97 ;;',
  '  save) printf \'IMAGE-TAR %s\\n\' "$*"; exit "${SHIM_SAVE_RC:-0}" ;;',
  'esac',
  'exit 97',
];

/** The box: every remote command is logged, then answered from state. */
const SSH_SHIM = [
  '#!/usr/bin/env bash',
  'state="$SHIM_STATE"',
  'while [ $# -gt 0 ] && [ "$1" != -- ]; do printf \'%s\\n\' "$1" >>"$state/ssh-opts"; shift; done',
  'shift; dest="$1"; shift; cmd="$*"',
  'printf \'%s | %s\\n\' "$dest" "$cmd" >>"$state/ssh.log"',
  '[ "${SHIM_SSH_DOWN:-0}" = 1 ] && exit 255',
  'case "$cmd" in',
  '  "docker image inspect --format \'{{.Id}}\' oshal-bot:sha-"*)',
  '    [ -f "$state/remote-image" ] || exit 1; cat "$state/remote-image"; exit 0 ;;',
  '  "gzip -dc | docker load")',
  '    gzip -dc >"$state/loaded.tar" || exit 1',
  '    [ "${SHIM_LOAD_FAIL:-0}" = 1 ] && exit 1',
  '    printf \'%s\\n\' "${SHIM_LOADED_ID:-$SHIM_ARTIFACT_ID}" >"$state/remote-image"; exit 0 ;;',
  '  "docker pull "*)',
  '    printf \'%s\\n\' "${SHIM_LOADED_ID:-$SHIM_ARTIFACT_ID}" >"$state/remote-image"; exit 0 ;;',
  '  "bash /opt/customer/oshal/scripts/managed-core-release.sh /opt/customer/crm.env "*)',
  '    exit "${SHIM_HELPER_RC:-0}" ;;',
  'esac',
  'exit 97',
];

interface Env { home: string; bin: string; state: string }

function setup(): Env {
  const root = scratchDir('oshal-promote-', cleanup);
  const e: Env = { home: path.join(root, 'home'), bin: path.join(root, 'bin'), state: path.join(root, 'state') };
  fs.mkdirSync(path.join(e.home, 'records'), { recursive: true });
  fs.mkdirSync(path.join(e.home, 'targets'), { recursive: true });
  fs.mkdirSync(e.state, { recursive: true });
  writeExec(path.join(e.bin, 'docker'), LOCAL_DOCKER);
  writeExec(path.join(e.bin, 'ssh'), SSH_SHIM);
  fs.writeFileSync(path.join(e.state, 'local-image'), `${ID}|${COMMIT}|${COMMIT}|${RELEASE}\n`);
  fs.writeFileSync(path.join(e.home, 'records', `${RELEASE}.json`), [
    '{', `  "release": "${RELEASE}",`, `  "commit": "${COMMIT}",`, `  "imageId": "${ID}",`,
    `  "imageTag": "oshal-bot:sha-${COMMIT}",`, '  "createdAt": "2026-09-28T00:00:00Z"', '}', ''].join('\n'));
  for (const [name, channel, host] of [['staging', 'staging', '192.168.50.10'], ['production', 'production', '192.168.50.20']]) {
    fs.writeFileSync(path.join(e.home, 'targets', `${name}.conf`), [`SSH_DEST=root@${host}`, 'RELEASE_ROOT=/opt/customer/oshal',
      'ENV_FILE=/opt/customer/crm.env', `CHANNEL=${channel}`, 'SSH_KEY=/home/user/.ssh/deploy_ed25519', ''].join('\n'));
  }
  return e;
}

function promote(e: Env, args: string[], extra: Record<string, string> = {}): Run {
  return runScript(SCRIPT, args, e.bin, {
    OSHAL_CORE_RELEASE_HOME: posix(e.home), SHIM_STATE: posix(e.state), SHIM_ARTIFACT_ID: ID, ...extra,
  });
}

const sshLog = (e: Env) => readOr(path.join(e.state, 'ssh.log')).split('\n').filter(Boolean);
const helperCalls = (e: Env) => sshLog(e).filter((l) => l.includes('managed-core-release.sh'));
const receipt = (e: Env, channel: string) => path.join(e.home, 'records', `${RELEASE}.${channel}.json`);

let e: Env;
beforeEach(() => { e = setup(); }, SHELL_CASE_TIMEOUT_MS);

describe('promote.sh — the verified artifact moves, is proved on the box, then promoted', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('streams the image to staging, proves the ID, runs the box transaction and writes the staging receipt', () => {
    const r = promote(e, ['--target', 'staging', '--release', RELEASE]);
    expect(r.status, r.out).toBe(0);
    expect(sshLog(e)).toEqual([
      `root@192.168.50.10 | docker image inspect --format '{{.Id}}' oshal-bot:sha-${COMMIT}`,
      'root@192.168.50.10 | gzip -dc | docker load',
      `root@192.168.50.10 | docker image inspect --format '{{.Id}}' oshal-bot:sha-${COMMIT}`,
      `root@192.168.50.10 | ${HELPER} promote ${COMMIT} ${ID} ${RELEASE} staging`,
    ]);
    // The bytes the box unpacked are the save stream of both release tags (real gzip in between).
    expect(readOr(path.join(e.state, 'loaded.tar'))).toContain(`IMAGE-TAR save oshal-bot:sha-${COMMIT} oshal-bot:${RELEASE}`);
    expect(readOr(path.join(e.state, 'ssh-opts'))).toContain('/home/user/.ssh/deploy_ed25519');
    const staged = JSON.parse(fs.readFileSync(receipt(e, 'staging'), 'utf8'));
    expect(staged).toMatchObject({ release: RELEASE, commit: COMMIT, imageId: ID, channel: 'staging', target: 'staging' });
  });

  it('refuses production without a staging receipt, before contacting the box', () => {
    const r = promote(e, ['--target', 'production', '--release', RELEASE]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('has not been validated on staging');
    expect(sshLog(e)).toEqual([]);
  });

  it('promotes production once staging validated the same image ID, and refuses when it validated other bytes', () => {
    expect(promote(e, ['--target', 'staging', '--release', RELEASE]).status).toBe(0);
    fs.rmSync(path.join(e.state, 'remote-image'));
    fs.rmSync(path.join(e.state, 'ssh.log'));
    const r = promote(e, ['--target', 'production', '--release', RELEASE]);
    expect(r.status, r.out).toBe(0);
    expect(helperCalls(e)).toEqual([`root@192.168.50.20 | ${HELPER} promote ${COMMIT} ${ID} ${RELEASE} production`]);
    expect(fs.existsSync(receipt(e, 'production'))).toBe(true);
    fs.writeFileSync(receipt(e, 'staging'), fs.readFileSync(receipt(e, 'staging'), 'utf8').replace(ID, OTHER));
    const other = promote(e, ['--target', 'production', '--release', RELEASE]);
    expect(other.status, other.out).toBe(2);
    expect(other.out).toContain('staging validated other bytes');
  });

  it('skips the transfer when the box already holds the image, and refuses a second build under the tag', () => {
    fs.writeFileSync(path.join(e.state, 'remote-image'), `${ID}\n`);
    const same = promote(e, ['--target', 'staging', '--release', RELEASE]);
    expect(same.status, same.out).toBe(0);
    expect(sshLog(e).some((l) => l.includes('docker load'))).toBe(false);
    fs.writeFileSync(path.join(e.state, 'remote-image'), `${OTHER}\n`);
    fs.rmSync(path.join(e.state, 'ssh.log'));
    const other = promote(e, ['--target', 'staging', '--release', RELEASE]);
    expect(other.status, other.out).toBe(2);
    expect(other.out).toContain('a second build of different bytes');
    expect(helperCalls(e)).toEqual([]);
  });

  it('pulls by repo digest with --registry, and refuses when this image was never pushed there', () => {
    const none = promote(e, ['--target', 'staging', '--release', RELEASE, '--registry', 'ghcr.io/example/oshal-bot']);
    expect(none.status, none.out).toBe(2);
    expect(none.out).toContain('was never pushed to ghcr.io/example/oshal-bot');
    const digest = `ghcr.io/example/oshal-bot@sha256:${'e'.repeat(64)}`;
    fs.writeFileSync(path.join(e.state, 'local-digests'), `ghcr.io/other/oshal-bot@sha256:${'f'.repeat(64)}\n${digest}\n`);
    const r = promote(e, ['--target', 'staging', '--release', RELEASE, '--registry', 'ghcr.io/example/oshal-bot']);
    expect(r.status, r.out).toBe(0);
    expect(sshLog(e)).toContain(`root@192.168.50.10 | docker pull ${digest} && docker tag ${digest} oshal-bot:sha-${COMMIT} && docker tag ${digest} oshal-bot:${RELEASE}`);
  });
});

describe('promote.sh — nothing reaches the box helper unless the artifact is proved', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('refuses when this machine no longer holds the cut artifact', () => {
    fs.writeFileSync(path.join(e.state, 'local-image'), `${OTHER}|${COMMIT}|${COMMIT}|${RELEASE}\n`);
    const r = promote(e, ['--target', 'staging', '--release', RELEASE]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('not the cut artifact');
    expect(sshLog(e)).toEqual([]);
  });

  it.each([
    ['a failed load (exit 4)', { SHIM_LOAD_FAIL: '1' }, 4, 'TRANSFER FAILED'],
    ['a load that yields other bytes (exit 2)', { SHIM_LOADED_ID: OTHER }, 2, 'nothing promoted'],
    ['an unreachable box (exit 4)', { SHIM_SSH_DOWN: '1' }, 4, 'cannot reach root@192.168.50.10'],
  ])('stops at %s', (_label, env, status, message) => {
    const r = promote(e, ['--target', 'staging', '--release', RELEASE], env);
    expect(r.status, r.out).toBe(status);
    expect(r.out).toContain(message);
    expect(helperCalls(e)).toEqual([]);
    expect(fs.existsSync(receipt(e, 'staging'))).toBe(false);
  });

  it('refuses a target file value that could reach a remote shell', () => {
    fs.writeFileSync(path.join(e.home, 'targets', 'staging.conf'), fs.readFileSync(path.join(e.home, 'targets', 'staging.conf'), 'utf8')
      .replace('ENV_FILE=/opt/customer/crm.env', 'ENV_FILE=/opt/customer/crm.env;reboot'));
    const r = promote(e, ['--target', 'staging', '--release', RELEASE]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('ENV_FILE is not a safe value');
    expect(sshLog(e)).toEqual([]);
  });

  it('prints the plan on --dry-run and sends nothing', () => {
    const r = promote(e, ['--target', 'staging', '--release', RELEASE, '--dry-run']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('Nothing was sent');
    expect(sshLog(e)).toEqual([]);
  });
});

describe('promote.sh — the box helper\'s outcome decides the exit code', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it.each([
    ['1', 1, 'restored its prior release'],
    ['2', 2, 'the box refused the promote'],
    ['3', 3, 'it needs hands'],
    ['255', 3, 'the connection dropped during the box transaction'],
    ['127', 2, 'bootstrap it'],
  ])('helper exit %s -> promote exit %i, no staging receipt', (helperRc, status, message) => {
    const r = promote(e, ['--target', 'staging', '--release', RELEASE], { SHIM_HELPER_RC: helperRc });
    expect(r.status, r.out).toBe(status);
    expect(r.out).toContain(message);
    expect(fs.existsSync(receipt(e, 'staging'))).toBe(false);
  });

  it('drives the box rollback and status in one command each', () => {
    const rb = promote(e, ['--target', 'production', '--rollback'], { SHIM_HELPER_RC: '0' });
    expect(rb.status, rb.out).toBe(0);
    const st = promote(e, ['--target', 'production', '--status'], { SHIM_HELPER_RC: '1' });
    expect(st.status, st.out).toBe(1);
    expect(helperCalls(e)).toEqual([`root@192.168.50.20 | ${HELPER} rollback`, `root@192.168.50.20 | ${HELPER} status`]);
    expect(promote(e, ['--target', 'production', '--rollback'], { SHIM_HELPER_RC: '255' }).status).toBe(3);
    expect(promote(e, ['--target', 'production', '--status'], { SHIM_HELPER_RC: '255' }).status).toBe(4);
  });
});
