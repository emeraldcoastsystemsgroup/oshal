/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 guard for scripts/core-promote/cut-release.sh: the shipped script runs in Git Bash against a real bare origin and clone, with docker and the two probe runners (npx, node) as recording stand-ins. Pins the success shape (one build from `git archive <commit>` stamped with GIT_SHA, OSHAL_RELEASE and the commit label; the dev-box deploy's probes run against it; the record carries the image ID; the annotated tag is created after it), the same-day `.N` naming, and every refusal: a dirty tree, an unpublished or already-released commit, a malformed or taken name, a red probe, a mislabelled image and a failed build all leave no record and no tag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_RELEASE_PATTERN } from '../../src/app/routes/update-check-cron';
import {
  REPO_ROOT, commitChange, git, makeRepo, posix, readOr, runProgram, runScript, scratchDir, writeExec,
  type FixtureRepo, type Run,
} from '../helpers/core-release-harness';

/** Each case spawns Git Bash and several git processes: slow on a loaded Windows host. */
const SHELL_CASE_TIMEOUT_MS = 120_000;
const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true }); });

const CUT = fs.readFileSync(path.join(REPO_ROOT, 'scripts/core-promote/cut-release.sh'), 'utf8');
const LIB = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/core-image-verify.sh'), 'utf8');
const TODAY = `core-${new Date().toISOString().slice(0, 10).replaceAll('-', '.')}`;

/** The docker stand-in: builds record their inputs and publish a deterministic image identity. */
const DOCKER_SHIM = [
  '#!/usr/bin/env bash',
  'state="$SHIM_STATE"',
  'fmt=\'{{.Id}}|{{index .Config.Labels "oshal.git.commit"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "oshal.release"}}\'',
  'printf \'%s\\n\' "$*" >>"$state/docker.log"',
  'key() { printf \'img-%s\' "$1" | tr \':/\' \'__\'; }',
  'case "$1" in',
  '  info) exit "${SHIM_DOCKER_INFO_RC:-0}" ;;',
  '  build)',
  '    shift; label=""; sha=""; release=""; tags=()',
  '    while [ $# -gt 0 ]; do',
  '      case "$1" in',
  '        --label) label="${2#oshal.git.commit=}"; shift 2 ;;',
  '        --build-arg) case "$2" in GIT_SHA=*) sha="${2#GIT_SHA=}" ;; OSHAL_RELEASE=*) release="${2#OSHAL_RELEASE=}" ;; esac; shift 2 ;;',
  '        -t) tags+=("$2"); shift 2 ;;',
  '        -f) shift 2 ;;',
  '        *) shift ;;',
  '      esac',
  '    done',
  '    cat >"$state/context.tar"',
  '    [ "${SHIM_BUILD_FAIL:-0}" = 1 ] && exit 1',
  '    [ "${SHIM_BAD_LABEL:-0}" = 1 ] && label=0000000000000000000000000000000000000000',
  '    id="sha256:$(printf \'%s|%s\' "$sha" "$release" | sha256sum | cut -c1-64)"',
  '    for t in "${tags[@]}"; do printf \'%s|%s|%s|%s\\n\' "$id" "$label" "$sha" "$release" >"$state/$(key "$t")"; done',
  '    exit 0 ;;',
  '  image)',
  '    [ "$2" = inspect ] && [ "$3" = --format ] && [ "$4" = "$fmt" ] || exit 97',
  '    [ -f "$state/$(key "$5")" ] || exit 1',
  '    cat "$state/$(key "$5")"; exit 0 ;;',
  'esac',
  'exit 97',
];

interface Fixture { repo: FixtureRepo; bin: string; state: string; home: string; script: string }

function fixture(): Fixture {
  const root = scratchDir('oshal-cut-release-', cleanup);
  const repo = makeRepo(root, {
    'scripts/core-promote/cut-release.sh': CUT,
    'scripts/lib/core-image-verify.sh': LIB,
    'scripts/check-kernel-skills.ts': '// fixture: the probe runner is a stand-in\n',
    'scripts/check-cline-entrypoint.mjs': '// fixture: the probe runner is a stand-in\n',
    'Dockerfile.oshal': 'FROM scratch\n',
  });
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  writeExec(path.join(bin, 'docker'), DOCKER_SHIM);
  writeExec(path.join(bin, 'npx'), ['#!/usr/bin/env bash', 'printf \'npx %s\\n\' "$*" >>"$SHIM_STATE/probes.log"', 'exit "${SHIM_KERNEL_RC:-0}"']);
  writeExec(path.join(bin, 'node'), ['#!/usr/bin/env bash', 'printf \'node %s\\n\' "$*" >>"$SHIM_STATE/probes.log"', 'exit "${SHIM_CLINE_RC:-0}"']);
  return { repo, bin, state, home: path.join(root, 'home'), script: path.join(repo.work, 'scripts/core-promote/cut-release.sh') };
}

function cut(f: Fixture, args: string[] = [], env: Record<string, string> = {}): Run {
  return runScript(f.script, args, f.bin, { SHIM_STATE: posix(f.state), OSHAL_CORE_RELEASE_HOME: posix(f.home), ...env });
}

const record = (f: Fixture, name: string) => path.join(f.home, 'records', `${name}.json`);
const tags = (f: Fixture) => git(f.repo.work, 'tag', '--list', 'core-*').split('\n').filter(Boolean);
const builds = (f: Fixture) => readOr(path.join(f.state, 'docker.log')).split('\n').filter((l) => l.startsWith('build'));

let f: Fixture;
beforeEach(() => { f = fixture(); }, SHELL_CASE_TIMEOUT_MS);

describe('cut-release.sh — one build, proved, recorded, tagged', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('builds the published main tip once, runs the deploy probes, records the image ID and tags the commit', () => {
    const sha = git(f.repo.work, 'rev-parse', 'HEAD');
    const r = cut(f);
    expect(r.status, r.out).toBe(0);
    const rec = JSON.parse(fs.readFileSync(record(f, TODAY), 'utf8'));
    const imageLine = fs.readFileSync(path.join(f.state, `img-oshal-bot_sha-${sha}`), 'utf8').trim();
    expect(rec).toMatchObject({ release: TODAY, commit: sha, imageId: imageLine.split('|')[0], imageTag: `oshal-bot:sha-${sha}`, gitTag: TODAY });
    const build = builds(f);
    expect(build).toHaveLength(1);
    expect(build[0]).toContain(`--label oshal.git.commit=${sha}`);
    expect(build[0]).toContain(`--build-arg GIT_SHA=${sha}`);
    expect(build[0]).toContain(`--build-arg OSHAL_RELEASE=${TODAY}`);
    expect(build[0]).toContain(`-t oshal-bot:${TODAY}`);
    expect(build[0]).not.toContain('latest'); // the dev stack's image is never touched
    expect(fs.readFileSync(path.join(f.state, 'context.tar')).includes('Dockerfile.oshal')).toBe(true);
    const probes = readOr(path.join(f.state, 'probes.log'));
    expect(probes).toContain(`npx tsx scripts/check-kernel-skills.ts --image oshal-bot:sha-${sha} --quiet`);
    expect(probes).toContain(`node scripts/check-cline-entrypoint.mjs --image oshal-bot:sha-${sha} --quiet`);
    expect(tags(f)).toEqual([TODAY]);
    expect(git(f.repo.work, 'cat-file', '-t', TODAY)).toBe('tag');
    expect(git(f.repo.work, 'rev-parse', `${TODAY}^{commit}`)).toBe(sha);
    expect(git(f.repo.work, 'tag', '-n9', '--list', TODAY)).toContain(rec.imageId);
    expect(git(f.repo.origin, 'tag', '--list')).toBe(''); // not published without --push-tag
  });

  it('publishes the tag with --push-tag and names a later cut the same day .2', () => {
    const r1 = cut(f, ['--push-tag']);
    expect(r1.status, r1.out).toBe(0);
    expect(git(f.repo.origin, 'tag', '--list')).toBe(TODAY);
    const again = cut(f);
    expect(again.status).toBe(2);
    expect(again.out).toContain(`is already released as ${TODAY}`);
    commitChange(f.repo.work, 'src/next.ts', 'export const next = 1;\n');
    const r2 = cut(f);
    expect(r2.status, r2.out).toBe(0);
    expect(fs.existsSync(record(f, `${TODAY}.2`))).toBe(true);
    expect(tags(f).sort()).toEqual([TODAY, `${TODAY}.2`]);
  });

  it('prints the plan on --dry-run and builds, records and tags nothing', () => {
    const r = cut(f, ['--dry-run']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('DRY RUN');
    expect(builds(f)).toHaveLength(0);
    expect(fs.existsSync(record(f, TODAY))).toBe(false);
    expect(tags(f)).toEqual([]);
  });
});

describe('cut-release.sh — refusals leave no build, no record, no tag', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  const refusedBeforeBuild = (r: Run, message: string) => {
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain(message);
    expect(builds(f)).toHaveLength(0);
    expect(tags(f)).toEqual([]);
    expect(fs.existsSync(path.join(f.home, 'records')) ? fs.readdirSync(path.join(f.home, 'records')) : []).toEqual([]);
  };

  it('refuses a dirty tracked file (the probes run from this tree)', () => {
    fs.writeFileSync(path.join(f.repo.work, 'Dockerfile.oshal'), 'FROM scratch\nRUN edited\n');
    refusedBeforeBuild(cut(f), 'tracked files are modified');
  });

  it('refuses a commit that is not on origin/main', () => {
    const local = commitChange(f.repo.work, 'src/unpublished.ts', 'export {};\n', false);
    refusedBeforeBuild(cut(f, ['--sha', local]), 'is not on origin/main');
  });

  it('refuses a malformed release name and a name already taken on origin', () => {
    refusedBeforeBuild(cut(f, ['--name', 'v2.1.0']), 'is not a core-YYYY.MM.DD[.N] release name');
    // The name belongs to an OLDER commit and exists only on origin: a name is never reused.
    const older = git(f.repo.work, 'rev-parse', 'HEAD');
    commitChange(f.repo.work, 'src/newer.ts', 'export {};\n');
    git(f.repo.work, 'tag', '-a', 'core-2026.01.02', '-m', 'cut elsewhere', older);
    git(f.repo.work, 'push', '-q', 'origin', 'refs/tags/core-2026.01.02');
    git(f.repo.work, 'tag', '-d', 'core-2026.01.02');
    const r = cut(f, ['--name', 'core-2026.01.02']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('release name core-2026.01.02 is already taken');
    expect(builds(f)).toHaveLength(0);
  });

  it.each([
    ['kernel-skills', { SHIM_KERNEL_RC: '1' }],
    ['cline-entrypoint', { SHIM_CLINE_RC: '1' }],
    ['commit-label', { SHIM_BAD_LABEL: '1' }],
  ])('stops at a red %s probe: exit 1, no record, no tag', (probe, env) => {
    const r = cut(f, [], env);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`IMAGE VERIFY FAILED at probe '${probe}'`);
    expect(fs.existsSync(record(f, TODAY))).toBe(false);
    expect(tags(f)).toEqual([]);
  });

  it('refuses when a probe script is missing instead of skipping it', () => {
    fs.rmSync(path.join(f.repo.work, 'scripts/check-cline-entrypoint.mjs'));
    git(f.repo.work, 'add', '-A');
    git(f.repo.work, 'commit', '-q', '-m', 'drop probe');
    git(f.repo.work, 'push', '-q', 'origin', 'HEAD:main');
    const r = cut(f);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("probe 'cline-entrypoint-probe-missing'");
    expect(tags(f)).toEqual([]);
  });

  it('stops at a failed build: exit 1, no record, no tag', () => {
    const r = cut(f, [], { SHIM_BUILD_FAIL: '1' });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('BUILD FAILED');
    expect(fs.existsSync(record(f, TODAY))).toBe(false);
    expect(tags(f)).toEqual([]);
  });
});

describe('release-name scheme — the shell rule and the /api/version rule are one rule', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('classifies every sample identically in scripts/lib/core-image-verify.sh and CORE_RELEASE_PATTERN', () => {
    const samples = ['core-2026.09.27', 'core-2026.09.27.2', 'core-2026.09.27.12', 'core-2026.09.27.0',
      'core-2026.9.27', 'v2.1.0-beta.1', 'core-2026.09.27-rc1', 'unreleased', '', 'core-2026.09.27.2.3'];
    const lib = posix(path.join(REPO_ROOT, 'scripts/lib/core-image-verify.sh'));
    const program = [`source '${lib}'`, ...samples.map((s) => `oshal_core_release_name_ok '${s}' && echo "Y:${s}" || echo "N:${s}"`)].join('\n');
    const r = runProgram(program, f.bin);
    expect(r.status, r.out).toBe(0);
    for (const s of samples) {
      expect(r.out.split('\n'), s).toContain(`${CORE_RELEASE_PATTERN.test(s) ? 'Y' : 'N'}:${s}`);
    }
  });
});
