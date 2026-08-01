/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for scripts/check-unpushed-commits.sh — the third leg of the backlog "Seven agent-worktree branches" done-when. check-worktree-strays.sh covers linked worktrees only and skips the primary checkout by design, so the shapes that actually strand work here (a commit on the primary checkout's branch, a local branch ref left ahead of origin, a detached HEAD carrying a commit) were undetected. Every case runs against a throwaway bare-origin + clone pair in the OS temp dir — this repo's own branch state is never read, so the spec's verdict cannot drift with whatever refs the shared checkout happens to carry. Proves the check fires on ahead-of-origin work, stays green on a synced repo, does not cry wolf on squash-landed / patch-id-landed / unrelated-history / archive refs, and refuses to report clean when there is nothing on origin to compare against.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const GUARD = join(REPO_ROOT, 'scripts/check-unpushed-commits.sh');

/**
 * @description Resolve a POSIX bash to run the guard with.
 *
 * Mirrors the resolver in publish-gate.spec.ts, for the same reason: on Windows the `bash` on PATH
 * is the WSL launcher, a different filesystem namespace where the fixture paths would not resolve.
 * Git ships a real bash; derive it from `git --exec-path` rather than hardcoding an install path.
 * Throws instead of skipping — a guard that quietly skips is a guard that does not exist.
 *
 * @returns Absolute path to a usable bash, or the bare name on POSIX.
 * @throws If no non-WSL bash can be located.
 */
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
  throw new Error('no Git Bash found near `git --exec-path`; refusing to fall back to the WSL bash on PATH');
}

const BASH = resolveBash();

/**
 * Per-case timeout. Every fixture case spawns a bare origin, a clone, several commits and the guard
 * itself — a dozen git/bash processes. On a loaded shared workstation that exceeds Vitest's 5s
 * default in process startup alone (the same class publish-gate.spec.ts raised its own bound for),
 * and a timeout is a false red with no defect behind it.
 */
const CASE_TIMEOUT = 60_000;
const FIXTURE_ROOTS: string[] = [];

interface GuardResult {
  code: number;
  output: string;
}

/**
 * @description Run the real guard against a fixture checkout and capture its verdict.
 * @param cwd - Clone to judge. The guard cd's to that repo's toplevel itself.
 * @returns Exit code and combined stdout+stderr.
 */
function runGuard(cwd: string): GuardResult {
  try {
    const output = execFileSync(BASH, [GUARD], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * @description Run a git command in a fixture, with identity pinned so commits never depend on
 * the host's global git config (a CI box without user.email would otherwise fail the fixture, not
 * the assertion).
 * @param cwd - Directory to run in.
 * @param args - git arguments.
 * @returns Trimmed stdout.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.email=maintainer@emeraldcoastsystemsgroup.com',
    '-c', 'user.name=oshal fixture',
    '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always',
    ...args,
  ], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/**
 * @description Create a bare `origin` with one commit on `main`, plus a clone of it.
 *
 * The pair is the minimum shape the guard needs: remote-tracking refs to compare against and a
 * working clone whose local refs can be moved around per case.
 *
 * @returns The bare origin path and the clone path.
 */
function makeOriginAndClone(): { origin: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'oshal-unpushed-'));
  FIXTURE_ROOTS.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');

  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: 'pipe' });
  writeFileSync(join(seed, 'f.txt'), 'A\n', 'utf8');
  git(seed, 'add', 'f.txt');
  git(seed, 'commit', '-m', 'seed', '--', 'f.txt');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');

  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', origin, clone], { stdio: 'pipe' });
  return { origin, clone };
}

/** Write a file and commit it in one step, scoped to that path (never a bare `git commit`). */
function commitFile(cwd: string, name: string, body: string, message: string): void {
  writeFileSync(join(cwd, name), body, 'utf8');
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', message, '--', name);
}

afterAll(() => {
  for (const dir of FIXTURE_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe('unpushed-commit guard — the script exists and is wired into the local CI gate set', () => {
  it('scripts/check-unpushed-commits.sh is present and executable by bash', () => {
    expect(existsSync(GUARD)).toBe(true);
  }, CASE_TIMEOUT);

  it('ci-local.sh registers it as a named gate, so a stranded commit reds the nightly', () => {
    // A guard nobody runs is not a guard. Pin both the function and the run_gate registration:
    // deleting either one silently removes the check from every scheduled run.
    const ciLocal = readFileSync(join(REPO_ROOT, 'scripts/ci-local.sh'), 'utf8');
    expect(ciLocal).toContain('gate_unpushed_commits()');
    expect(ciLocal).toContain('check-unpushed-commits.sh');
    expect(ciLocal).toMatch(/run_gate\s+unpushed-commits\s+gate_unpushed_commits/);
  }, CASE_TIMEOUT);
});

describe('unpushed-commit guard — fires on work that exists nowhere but this disk', () => {
  it('a fresh commit on the checked-out branch, unpushed, FAILS and names the branch', () => {
    const { clone } = makeOriginAndClone();
    commitFile(clone, 'g.txt', 'new work\n', 'feat: work that was never pushed');

    const result = runGuard(clone);
    expect(result.code).toBe(1);
    expect(result.output).toContain('STRANDED');
    expect(result.output).toContain('main');
    expect(result.output).toContain('feat: work that was never pushed');
  }, CASE_TIMEOUT);

  it('a never-pushed side branch FAILS even while the checked-out branch is synced', () => {
    const { clone } = makeOriginAndClone();
    git(clone, 'branch', 'feat/side');
    git(clone, 'switch', '-q', 'feat/side');
    commitFile(clone, 'h.txt', 'side work\n', 'feat: side branch work');
    git(clone, 'switch', '-q', 'main');

    const result = runGuard(clone);
    expect(result.code).toBe(1);
    expect(result.output).toContain('feat/side');
    expect(result.output).toContain('STRANDED');
  }, CASE_TIMEOUT);

  it('a DETACHED HEAD carrying a commit FAILS — the shape check-worktree-strays.sh cannot see', () => {
    // git worktree list --porcelain prints `detached` instead of `branch <ref>` here, which the
    // stray-worktree guard skips outright. This is the push-by-SHA recipe's failure mode: the
    // commit is real, no branch points at it, and nothing else in the repo will ever mention it.
    const { clone } = makeOriginAndClone();
    git(clone, 'switch', '-q', '--detach', 'HEAD');
    commitFile(clone, 'i.txt', 'detached work\n', 'feat: committed on a detached HEAD');

    const result = runGuard(clone);
    expect(result.code).toBe(1);
    expect(result.output).toContain('detached HEAD');
    expect(result.output).toContain('feat: committed on a detached HEAD');
  }, CASE_TIMEOUT);
});

describe('unpushed-commit guard — stays green when nothing is actually lost', () => {
  it('a fully synced clone reports clean, with no stale-ref noise', () => {
    const { clone } = makeOriginAndClone();
    const result = runGuard(clone);
    expect(result.code).toBe(0);
    expect(result.output).toContain('unpushed-commits: clean');
    expect(result.output).not.toContain('stale refs');
    expect(result.output).not.toContain('STRANDED');
  }, CASE_TIMEOUT);

  it('a SQUASH-landed branch is a stale ref, not stranded work (the merge-tree proof)', () => {
    // Every PR here squash-merges, so the branch's own commits are never ancestors of origin/main
    // and their patch-ids do not survive either. Only the no-op-merge test can clear this shape —
    // and it is the single most common ref on the box, so getting it wrong means a permanently
    // red gate that everyone learns to ignore.
    const { origin, clone } = makeOriginAndClone();
    git(clone, 'switch', '-qc', 'feat/two-commits');
    commitFile(clone, 'f.txt', 'A\nB\n', 'part one');
    commitFile(clone, 'f.txt', 'A\nB\nC\n', 'part two');
    const squashTree = git(clone, 'rev-parse', 'feat/two-commits^{tree}');
    const squash = git(clone, 'commit-tree', squashTree, '-p', 'origin/main', '-m', 'squashed both parts (#1)');
    git(clone, 'push', '-q', origin, `${squash}:refs/heads/main`);
    git(clone, 'fetch', '-q', 'origin');
    git(clone, 'switch', '-q', 'main');

    const result = runGuard(clone);
    expect(result.code).toBe(0);
    expect(result.output).toContain('stale refs');
    expect(result.output).toContain('feat/two-commits');
    expect(result.output).not.toContain('STRANDED');
  }, CASE_TIMEOUT);

  it('a patch-id-landed branch whose file main later edited is stale, not stranded (the cherry proof)', () => {
    // The chore/extract-coder-bot shape: the branch's patch landed, then main edited the same
    // region again, so merging the ref back now CONFLICTS and the no-op test cannot clear it.
    // `git cherry` still sees the patch-id upstream. Without this second proof the branch reads
    // as lost work forever.
    const { origin, clone } = makeOriginAndClone();
    git(clone, 'switch', '-qc', 'feat/landed-then-edited');
    commitFile(clone, 'f.txt', 'A\nB\n', 'add B');

    // Re-apply the identical change on the trunk under the squash-merge message. Patch-ids ignore
    // the commit message, so this is patch-equivalent while being a different commit object — a
    // literal `git cherry-pick` here reproduces the SAME sha (same tree, parent, author, message)
    // and the branch would then be trivially reachable from origin, testing nothing.
    git(clone, 'switch', '-q', 'main');
    commitFile(clone, 'f.txt', 'A\nB\n', 'add B (#7)');
    commitFile(clone, 'f.txt', 'A\nB-rewritten\n', 'rewrite B on the trunk');
    git(clone, 'push', '-q', origin, 'main:main');
    git(clone, 'fetch', '-q', 'origin');

    const result = runGuard(clone);
    expect(result.code).toBe(0);
    expect(result.output).toContain('stale refs');
    expect(result.output).toContain('feat/landed-then-edited');
    expect(result.output).not.toContain('STRANDED');
  }, CASE_TIMEOUT);

  it('a ref with NO common ancestor is reported as pre-scrub orphan history, not stranded', () => {
    // The trunk was deleted and recreated after the ADR-115 cutover (origin/main's first real
    // commit is dated 2026-07-29), so 35 local refs on
    // this box have no merge base with origin/main. They cannot be pushed as a PR at all — there
    // is no base to diff against — so failing on them would be a red gate with no possible fix.
    const { clone } = makeOriginAndClone();
    git(clone, 'switch', '-q', '--orphan', 'old/unrelated-history');
    commitFile(clone, 'ancient.txt', 'from the retired trunk\n', 'unrelated root commit');
    git(clone, 'switch', '-q', 'main');

    const result = runGuard(clone);
    expect(result.code).toBe(0);
    expect(result.output).toContain('pre-scrub orphans');
    expect(result.output).toContain('old/unrelated-history');
    expect(result.output).not.toContain('STRANDED');
  }, CASE_TIMEOUT);

  it('an archive/* ref holding genuinely unpushed content is EXEMPT, and still named', () => {
    // archive/pre-scrub-main is the retired trunk history. Pushing it would re-expose exactly what
    // the scrub removed, so the guard must never demand it — but it must also never hide it.
    const { clone } = makeOriginAndClone();
    git(clone, 'switch', '-qc', 'archive/pre-scrub-main');
    commitFile(clone, 'old.txt', 'retired trunk snapshot\n', 'archive snapshot');
    git(clone, 'switch', '-q', 'main');

    const result = runGuard(clone);
    expect(result.code).toBe(0);
    expect(result.output).toContain('archive refs');
    expect(result.output).toContain('archive/pre-scrub-main');
    expect(result.output).not.toContain('STRANDED');
  }, CASE_TIMEOUT);
});

describe('unpushed-commit guard — refuses to report clean when it cannot judge', () => {
  it('exits 2 (unavailable) rather than 0 when there are no origin remote-tracking refs', () => {
    // Every local commit trivially looks unpushed with no remote to compare against — and every
    // local commit trivially looks pushed if the script were to bail out quietly. Passing-by-
    // absence is the failure mode the hardening doctrine names explicitly.
    const root = mkdtempSync(join(tmpdir(), 'oshal-unpushed-noremote-'));
    FIXTURE_ROOTS.push(root);
    const solo = join(root, 'solo');
    execFileSync('git', ['init', '-b', 'main', solo], { stdio: 'pipe' });
    commitFile(solo, 'f.txt', 'A\n', 'seed');

    const result = runGuard(solo);
    expect(result.code).toBe(2);
    expect(result.output).toContain('STRANDED-CHECK UNAVAILABLE');
  }, CASE_TIMEOUT);

  it('exits 2 when origin exists but origin/main is missing — no trunk, no content proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'oshal-unpushed-nomain-'));
    FIXTURE_ROOTS.push(root);
    const origin = join(root, 'origin.git');
    const solo = join(root, 'solo');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', solo], { stdio: 'pipe' });
    commitFile(solo, 'f.txt', 'A\n', 'seed');
    git(solo, 'remote', 'add', 'origin', origin);
    git(solo, 'push', '-q', 'origin', 'main:refs/heads/not-main');
    git(solo, 'fetch', '-q', 'origin');

    const result = runGuard(solo);
    expect(result.code).toBe(2);
    expect(result.output).toContain('origin/main is missing');
  }, CASE_TIMEOUT);
});
