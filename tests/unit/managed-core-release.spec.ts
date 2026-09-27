/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 guard for scripts/managed-core-release.sh, the on-box release transaction. The shipped helper's functions are sourced into Git Bash and driven through its own dispatcher (the root/PATH entrypoint is exercised separately and must refuse a non-root caller). The release dir is a REAL clone of a REAL bare origin carrying the release tag, the env file is a real file the helper rewrites, and the launcher is a fixture committed at both commits that brings the "stack" to whatever the env file pins; docker (identities, the dump container, the api container), curl (/api/version) and stat (root ownership on a Windows filesystem) are stand-ins. Pins: success (dump taken and history written BEFORE the launcher runs, checkout + atomic repoint, live verification), every refusal leaves the box untouched, a failed up or failed verification restores and verifies the prior pin (exit 1), a failed restore is exit 3 and blocks the next promote until rollback finishes it, and rollback / status against the recorded history.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  REPO_ROOT, commitChange, git, makeRepo, msys, posix, readOr, runProgram, runScript, scratchDir, writeExec, type Run,
} from '../helpers/core-release-harness';

/** Each case spawns Git Bash and several git processes: slow on a loaded Windows host. */
const SHELL_CASE_TIMEOUT_MS = 120_000;
const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true }); });

const HELPER = path.join(REPO_ROOT, 'scripts/managed-core-release.sh');
const RELEASE = 'core-2026.09.28';
const ID1 = `sha256:${'1'.repeat(64)}`;
const ID2 = `sha256:${'2'.repeat(64)}`;
const SECRET = 'postgresql://doadmin:fixture-bootstrap-secret@db.oshal.example.com:25060/oshal';
const PG = `postgres:18-alpine@sha256:${'d'.repeat(64)}`;

/** The managed launcher stand-in, committed into the release repo: it brings the stack to the pin. */
const LAUNCHER = [
  '#!/usr/bin/env bash',
  'env_file="$1"; state="$SHIM_STATE"',
  'pin=$(sed -n "s/^OSHAL_BOT_IMAGE=//p" "$env_file")',
  'head=$(git -C "$(dirname "$0")/.." rev-parse HEAD)',
  'hist=$(cat "$SHIM_HISTORY" 2>/dev/null | wc -l | tr -d " ")',
  'printf "launcher %s pin=%s head=%s history=%s\\n" "$2" "$pin" "$head" "$hist" >>"$state/calls.log"',
  'case " ${SHIM_UP_FAIL_FOR:-} " in *" $pin "*) exit 1 ;; esac',
  'key=$(printf "%s" "$pin" | tr ":/" "__")',
  '[ -f "$state/img-$key" ] || exit 1',
  'IFS="|" read -r id commit rev release <"$state/img-$key"',
  'printf "%s\\n" "$id" >"$state/running-id"',
  '[ "$release" = "<no value>" ] && release=""',
  'printf "GIT_SHA=%s\\nOSHAL_RELEASE=%s\\n" "$commit" "${release:-unreleased}" >"$state/running-env"',
  'if [ -n "$release" ]; then rel="\\"$release\\""; else rel=null; fi',
  'printf "{\\"name\\":\\"oshal\\",\\"version\\":\\"2.1.0\\",\\"commit\\":\\"%s\\",\\"release\\":%s}\\n" "$commit" "$rel" >"$state/version.json"',
];

const DOCKER_SHIM = [
  '#!/usr/bin/env bash',
  'state="$SHIM_STATE"',
  'fmt=\'{{.Id}}|{{index .Config.Labels "oshal.git.commit"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "oshal.release"}}\'',
  'key() { printf \'%s\' "$1" | tr \':/\' \'__\'; }',
  'case "$1" in',
  '  info) exit 0 ;;',
  '  image) [ "$2 $3" = "inspect --format" ] && [ "$4" = "$fmt" ] || exit 97',
  '    [ -f "$state/img-$(key "$5")" ] || exit 1; cat "$state/img-$(key "$5")"; exit 0 ;;',
  '  run) envf=""; prev=""',
  '    for a in "$@"; do [ "$prev" = --env-file ] && envf="$a"; prev="$a"; done',
  '    sed "s/=.*//" "$envf" >"$state/dump-env-keys"',
  '    printf \'%s\\n\' "$*" >"$state/dump-args"',
  '    [ "${SHIM_DUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: connection refused" >&2; exit 1; }',
  '    printf \'PGDMP-fixture-archive\'; exit 0 ;;',
  '  ps) [ "$*" = "ps --filter label=com.docker.compose.project=crm-test --filter label=com.docker.compose.service=oshal-api --format {{.ID}}" ] || exit 97',
  '    [ -f "$state/running-id" ] && echo api1; exit 0 ;;',
  '  inspect) [ "$2" = --format ] && [ "$4" = api1 ] && [ -f "$state/running-id" ] || exit 1',
  '    case "$3" in',
  '      "{{.Image}}") cat "$state/running-id" ;;',
  '      "{{range .Config.Env}}{{println .}}{{end}}") cat "$state/running-env" ;;',
  '      *) exit 97 ;;',
  '    esac; exit 0 ;;',
  'esac',
  'exit 97',
];

const CURL_SHIM = [
  '#!/usr/bin/env bash',
  '[ -f "$SHIM_STATE/version.json" ] || exit 7',
  'body=$(cat "$SHIM_STATE/version.json")',
  'case "$body" in *"${SHIM_CURL_FAIL_FOR:-no-such-commit}"*) exit 22 ;; esac',
  'printf \'%s\' "$body"',
];

/** Root ownership cannot be real on a Windows checkout: every path reads as root's, directories 755. */
const STAT_SHIM = [
  '#!/usr/bin/env bash',
  'fmt="$2"; target="${@: -1}"',
  'case "$fmt" in',
  '  %u) echo 0 ;;',
  '  %a) if [ -d "$target" ]; then echo 755; else case "$target" in *.env) echo "${SHIM_ENV_MODE:-600}" ;; *) echo 644 ;; esac; fi ;;',
  '  *) exit 97 ;;',
  'esac',
];

interface Box { root: string; origin: string; work: string; rel: string; bin: string; state: string; stateRoot: string; env: string; c1: string; c2: string }

function image(b: Box, ref: string, id: string, commit: string, release = '<no value>'): void {
  fs.writeFileSync(path.join(b.state, `img-${ref.replace(/[:/]/g, '_')}`), `${id}|${commit}|${commit}|${release}\n`);
}

/** A managed box serving c1 (an unreleased hand build) with release c2 cut, tagged and loaded. */
function box(): Box {
  const root = scratchDir('oshal-mcr-', cleanup);
  const { origin, work } = makeRepo(root, {
    'scripts/managed-postgres-compose.sh': `${LAUNCHER.join('\n')}\n`,
    'scripts/lib/core-image-verify.sh': fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/core-image-verify.sh'), 'utf8'),
    'scripts/core-promote/core-drift-check.sh': fs.readFileSync(path.join(REPO_ROOT, 'scripts/core-promote/core-drift-check.sh'), 'utf8'),
    'docker-compose.managed-postgres.yml': `services:\n  oshal-db:\n    image: ${PG}\n`,
    'config-seed/do-postgres-ca.pem': '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
  });
  const c1 = git(work, 'rev-parse', 'HEAD');
  const c2 = commitChange(work, 'src/feature.ts', 'export const feature = 2;\n');
  git(work, 'tag', '-a', RELEASE, '-m', `oshal core release ${RELEASE}`, c2);
  git(work, 'push', '-q', 'origin', `refs/tags/${RELEASE}`);
  const rel = path.join(root, 'release');
  git(root, 'clone', '-q', posix(origin), rel);
  git(rel, 'checkout', '-q', '--detach', c1);
  const b: Box = { root, origin, work, rel, bin: path.join(root, 'bin'), state: path.join(root, 'state'),
    stateRoot: path.join(root, 'var-lib'), env: path.join(root, 'crm-production.env'), c1, c2 };
  fs.mkdirSync(b.state, { recursive: true });
  writeExec(path.join(b.bin, 'docker'), DOCKER_SHIM);
  writeExec(path.join(b.bin, 'curl'), CURL_SHIM);
  writeExec(path.join(b.bin, 'stat'), STAT_SHIM);
  fs.writeFileSync(b.env, ['OSHAL_MANAGED_DEPLOYMENT_ID=crm-test', `OSHAL_BOT_IMAGE=oshal-bot:sha-${c1}`,
    `BOOTSTRAP_DATABASE_URL=${SECRET}`, 'DATABASE_URL=postgresql://oshal_app:x@db.oshal.example.com:25060/oshal',
    'OSHAL_RELEASE_CHANNEL=production', ''].join('\n'));
  image(b, `oshal-bot:sha-${c1}`, ID1, c1);
  image(b, `oshal-bot:sha-${c2}`, ID2, c2, RELEASE);
  // The box is up on c1: run the launcher once so the running api and /api/version exist.
  runScript(path.join(rel, 'scripts/managed-postgres-compose.sh'), [posix(b.env), 'up'], b.bin, shimEnv(b));
  fs.rmSync(path.join(b.state, 'calls.log'));
  return b;
}

function shimEnv(b: Box, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SHIM_STATE: posix(b.state), SHIM_HISTORY: posix(path.join(b.stateRoot, 'crm-test', 'history.tsv')),
    OSHAL_RELEASE_STATE_DIR: msys(b.stateRoot), OSHAL_RELEASE_VERIFY_SECONDS: '0', ...extra,
  };
}

/** Drive the helper's own dispatcher with its functions sourced (the root entrypoint is not run). */
function helper(b: Box, args: string[], extra: Record<string, string> = {}): Run {
  const quoted = args.map((a) => `'${a}'`).join(' ');
  const program = [
    'umask 077',
    `source '${msys(HELPER)}'`,
    `MCR_SELF_DIR='${msys(b.rel)}/scripts'; MCR_REPO_ROOT='${msys(b.rel)}'`,
    'source "$MCR_SELF_DIR/lib/core-image-verify.sh"',
    `mcr_dispatch '${msys(b.env)}' ${quoted}`,
  ].join('\n');
  return runProgram(program, b.bin, shimEnv(b, extra));
}

const promote = (b: Box, extra: Record<string, string> = {}, id = ID2) =>
  helper(b, ['promote', b.c2, id, RELEASE, 'production'], extra);
const head = (b: Box) => git(b.rel, 'rev-parse', 'HEAD');
const pin = (b: Box) => (/^OSHAL_BOT_IMAGE=(.*)$/m.exec(fs.readFileSync(b.env, 'utf8')) ?? [])[1];
const history = (b: Box) => readOr(path.join(b.stateRoot, 'crm-test', 'history.tsv')).split('\n').filter(Boolean).map((l) => l.split('\t'));
const calls = (b: Box) => readOr(path.join(b.state, 'calls.log')).split('\n').filter(Boolean);
const dumps = (b: Box) => { const d = path.join(b.stateRoot, 'crm-test', 'dumps'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };

let b: Box;
beforeEach(() => { b = box(); }, SHELL_CASE_TIMEOUT_MS);

describe('managed-core-release.sh promote — capture, then move, then prove', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('dumps first, records history before the launcher runs, repoints atomically and verifies /api/version', () => {
    const envBefore = fs.readFileSync(b.env, 'utf8');
    const r = promote(b);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`PROMOTED ${RELEASE}`);
    expect(head(b)).toBe(b.c2);
    expect(pin(b)).toBe(`oshal-bot:sha-${b.c2}`);
    // Only the pin line changed; every other key (and the secret) is intact.
    expect(fs.readFileSync(b.env, 'utf8')).toBe(envBefore.replace(`oshal-bot:sha-${b.c1}`, `oshal-bot:sha-${b.c2}`));
    const h = history(b);
    expect(h.map((l) => `${l[2]}:${l[3]}`)).toEqual(['promote:begin', 'promote:ok']);
    expect(h[1].slice(4, 12)).toEqual([RELEASE, b.c2, `oshal-bot:sha-${b.c2}`, ID2, '-', b.c1, `oshal-bot:sha-${b.c1}`, ID1]);
    // The launcher ran exactly once, on the new checkout + pin, with the 'begin' line already written.
    expect(calls(b)).toEqual([`launcher up pin=oshal-bot:sha-${b.c2} head=${b.c2} history=1`]);
    const dump = path.join(b.stateRoot, 'crm-test', 'dumps', dumps(b)[0]);
    expect(fs.readFileSync(dump, 'utf8').startsWith('PGDMP')).toBe(true);
    expect(h[1][12]).toBe(msys(dump));
    // Only the bootstrap DSN reached the dump container, from a file that is gone; it is never printed.
    expect(readOr(path.join(b.state, 'dump-env-keys')).trim()).toBe('BOOTSTRAP_DATABASE_URL');
    expect(readOr(path.join(b.state, 'dump-args'))).toContain(PG);
    expect(fs.readdirSync(path.join(b.stateRoot, 'crm-test')).filter((f) => f.startsWith('dump-env'))).toEqual([]);
    expect(r.out).not.toContain('fixture-bootstrap-secret');
  });

  const untouched = (r: Run, message: string) => {
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain(message);
    expect(head(b)).toBe(b.c1);
    expect(pin(b)).toBe(`oshal-bot:sha-${b.c1}`);
    expect(calls(b)).toEqual([]);
    expect(history(b)).toEqual([]);
  };

  it('refuses an image that is not the release artifact, before any capture', () => {
    untouched(promote(b, {}, `sha256:${'3'.repeat(64)}`), 'not the release artifact');
    expect(dumps(b)).toEqual([]);
  });

  it('refuses the wrong box: a declared channel that differs, or none declared', () => {
    untouched(helper(b, ['promote', b.c2, ID2, RELEASE, 'staging']), 'this box is the production channel, not staging - wrong target');
    fs.writeFileSync(b.env, fs.readFileSync(b.env, 'utf8').replace('OSHAL_RELEASE_CHANNEL=production\n', ''));
    untouched(promote(b), 'declares no OSHAL_RELEASE_CHANNEL');
  });

  it('refuses an env file that is not 0600', () => {
    untouched(promote(b, { SHIM_ENV_MODE: '644' }), 'must have mode 0600');
  });

  it('refuses a dirty release dir and a release tag that is not published', () => {
    fs.appendFileSync(path.join(b.rel, 'docker-compose.managed-postgres.yml'), '# hand edit\n');
    untouched(promote(b), 'modified tracked files');
    git(b.rel, 'checkout', '--', 'docker-compose.managed-postgres.yml');
    git(b.work, 'push', '-q', 'origin', `:refs/tags/${RELEASE}`);
    untouched(promote(b), `is the tag published?`);
  });

  it('refuses when the pre-deploy dump fails and keeps no partial dump', () => {
    untouched(promote(b, { SHIM_DUMP_FAIL: '1' }), 'the pre-deploy database dump failed');
    expect(dumps(b).filter((f) => f.endsWith('.dump') || f.endsWith('.partial'))).toEqual([]);
  });

  it('refuses a box whose release dir and pinned image already disagree', () => {
    image(b, `oshal-bot:sha-${b.c1}`, ID1, b.c2);
    untouched(promote(b), 'disagree - run status');
  });
});

describe('managed-core-release.sh promote — a failure restores the prior pin and proves it', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('restores after a failed launcher up (exit 1) and records it', () => {
    const r = promote(b, { SHIM_UP_FAIL_FOR: `oshal-bot:sha-${b.c2}` });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('the prior release was restored and verified serving');
    expect(head(b)).toBe(b.c1);
    expect(pin(b)).toBe(`oshal-bot:sha-${b.c1}`);
    expect(calls(b).map((c) => c.split(' ')[2])).toEqual([`pin=oshal-bot:sha-${b.c2}`, `pin=oshal-bot:sha-${b.c1}`]);
    expect(history(b).map((l) => l[3])).toEqual(['begin', 'restored']);
    expect(readOr(path.join(b.state, 'running-id')).trim()).toBe(ID1);
  });

  it('restores when the new stack comes up but /api/version does not say the release', () => {
    const r = promote(b, { SHIM_CURL_FAIL_FOR: b.c2 });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('live verification failed');
    expect(head(b)).toBe(b.c1);
    expect(history(b).map((l) => l[3])).toEqual(['begin', 'restored']);
  });

  it('exits 3 when the restore also fails, blocks the next promote, and rollback finishes it', () => {
    const both = `oshal-bot:sha-${b.c2} oshal-bot:sha-${b.c1}`;
    const r = promote(b, { SHIM_UP_FAIL_FOR: both });
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain('the box needs hands');
    expect(history(b).map((l) => l[3])).toEqual(['begin', 'degraded']);
    const blocked = promote(b);
    expect(blocked.status, blocked.out).toBe(2);
    expect(blocked.out).toContain('did not finish (promote degraded); run rollback first');
    const recovered = helper(b, ['rollback']);
    expect(recovered.status, recovered.out).toBe(0);
    expect(head(b)).toBe(b.c1);
    expect(pin(b)).toBe(`oshal-bot:sha-${b.c1}`);
    expect(history(b).slice(-1)[0].slice(2, 4)).toEqual(['rollback', 'ok']);
    const retry = promote(b);
    expect(retry.status, retry.out).toBe(0);
  });
});

describe('managed-core-release.sh rollback and status — against the recorded history', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('rolls a verified promote back in one command, and refuses a second with nothing in effect', () => {
    expect(promote(b).status).toBe(0);
    const r = helper(b, ['rollback']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('The database is not rolled back');
    expect(head(b)).toBe(b.c1);
    expect(pin(b)).toBe(`oshal-bot:sha-${b.c1}`);
    expect(readOr(path.join(b.state, 'running-id')).trim()).toBe(ID1);
    const h = history(b);
    expect(h.slice(-1)[0][13]).toBe(h[1][1]); // the rollback names the promote it reverted
    const again = helper(b, ['rollback']);
    expect(again.status, again.out).toBe(2);
    expect(again.out).toContain('nothing to roll back');
  });

  it('refuses a rollback whose image was pruned from the engine', () => {
    expect(promote(b).status).toBe(0);
    fs.rmSync(path.join(b.state, `img-oshal-bot_sha-${b.c1}`));
    const r = helper(b, ['rollback']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('it may have been pruned');
    expect(head(b)).toBe(b.c2);
  });

  it('reports the release in effect and in sync, then names a hand edit of the pin as drift', () => {
    expect(promote(b).status).toBe(0);
    const ok = helper(b, ['status']);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain(`in effect: ${RELEASE}`);
    expect(ok.out).toContain('channel production');
    expect(ok.out).toContain('IN SYNC');
    fs.writeFileSync(b.env, fs.readFileSync(b.env, 'utf8').replace(`oshal-bot:sha-${b.c2}`, `oshal-bot:sha-${b.c1}`));
    const drift = helper(b, ['status']);
    expect(drift.status, drift.out).toBe(1);
    expect(drift.out).toContain('the env file pins image');
  });

  it('locates its release dir from the --bootstrap copy and loads the library beside it', () => {
    const dir = path.join(b.rel, '.release-bootstrap');
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.copyFileSync(HELPER, path.join(dir, 'managed-core-release.sh'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts/lib/core-image-verify.sh'), path.join(dir, 'lib', 'core-image-verify.sh'));
    const r = runProgram([
      `source '${msys(HELPER)}'`,
      `mcr_locate '${msys(path.join(dir, 'managed-core-release.sh'))}'`,
      'echo "root=$MCR_REPO_ROOT"',
      `oshal_core_release_name_ok ${RELEASE} && echo library-loaded`,
    ].join('\n'), b.bin, shimEnv(b));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`root=${msys(b.rel)}`);
    expect(r.out).toContain('library-loaded');
    // The staged copy is untracked, so the clean-release-dir rule still holds.
    expect(git(b.rel, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('refuses to run as a non-root user before reading anything (the real entrypoint)', () => {
    const r = runScript(HELPER, [posix(b.env), 'status'], b.bin, shimEnv(b));
    if (process.platform === 'win32' || process.getuid?.() !== 0) {
      expect(r.status, r.out).toBe(2);
      expect(r.out).toContain('must run as root');
    }
  });
});
